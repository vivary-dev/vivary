"""Relevance-ranked claim selection with structured filters and explains.

Reference-guided Python port of src/capsule/select.mjs (slice 2, decision
0008). The Node module is the frozen executable oracle: every function here
is translated function-for-function, and every constant (tier names, fact
weights, caps) keeps its exact value.

Pure: same task, graph, and candidates always yield the same selection.

Ranking replaces the old lexicographic budget cut. Tiers, strongest first:
  conflict_side   - the subject checkout is a side of an unresolved conflict;
                     the capsule exists to make that discrepancy legible.
  question_match  - a task-question term matches the subject's label,
                     proven repository identity, or branch name. Raw paths
                     and unproven (local:) identities are never match
                     surfaces, so a question can not rank by machine path.
  allowlisted     - inside the task allowlist with no task-specific signal.
Within a tier, facts rank by evidence strength: identity-bearing facts
first, last_fetch last (the dogfood run proved fetch recency misleads).
Cuts come off the bottom and are listed in the over-budget omission.

Language mapping notes (decision 0008 / documented rules for this slice):
- JS `undefined` <-> absent dict key; `a?.b` chains become careful
  `.get()` chains; `x ?? y` becomes an explicit "is None" check (never a
  falsy check - 0 and "" must pass through unchanged).
- `select.mjs`'s two sort sites are NOT the same kind of sort:
  - `surviving.sort((a, b) => ...)` compares `sortKey` entries with the
    plain JS relational operators `<`/`>`. For strings, plain `<`/`>` is
    UTF-16 code-unit order (NOT ICU/localeCompare collation) - so the
    tie-break string in `sortKey[1]` is ordered here via
    `vivary_core.canonical._utf16_sort_key`, not `collation.locale_sort_key`.
    (compile.mjs's own candidate sort, by contrast, calls
    `.localeCompare(...)` explicitly and so uses `locale_sort_key` - see
    capsule_compile.py.)
"""

from __future__ import annotations

import re

from vivary_core.canonical import _utf16_sort_key

TIER_NAMES = ["conflict_side", "question_match", "allowlisted"]

FACT_WEIGHTS = {
    "head_revision": 0,
    "head_ref": 1,
    "is_dirty": 2,
    # Dirty file paths are the detail behind is_dirty - ranked immediately
    # after it, ahead of remotes/last_fetch.
    "dirty_entries": 2.5,
    "remotes": 3,
    "last_fetch": 4,
    # Content matches are the weakest-evidence fact: useful, question-matched
    # supplementary detail, but never as strong as an identity fact computed
    # straight from git plumbing.
    "content_match": 5,
}
UNKNOWN_FACT_WEIGHT = 9

# --- Fact-family budget ranking (#59) ---------------------------------------
# See src/capsule/select.mjs for the full dogfood-autopsy narrative this
# ranking fixes: a conflict-side subject's content_match facts used to
# inherit the subject's whole conflict_side tier for budget purposes, so a
# flood of generic grep hits from one checkout could crowd out a completely
# different subject's baseline identity facts. Folding tier and within-tier
# weight into one budget-rank number (tier * TIER_BAND + weight) lets a large
# enough weight cross a tier boundary downward, which a plain lexicographic
# [tier, weight] sort never could.
TIER_BAND = 100
CONTENT_BASE_WEIGHT = FACT_WEIGHTS["content_match"]
CONTENT_GROWTH_STEP = TIER_BAND / 4

FILTER_FIELDS = ["fact", "label", "path", "repository", "branch"]

# Words too generic to rank anything in a workspace question.
STOPWORDS = frozenset(
    [
        "the", "and", "for", "are", "was", "were", "has", "have", "does", "with",
        "this", "that", "its", "any", "not", "which", "what", "who", "how", "why",
        "should", "would", "could", "can", "will", "into", "from", "about",
        "local", "current", "currently", "reflects", "truth", "shared",
        "checkout", "checkouts", "repository", "repositories", "repo", "repos",
        "branch", "branches", "remote", "remotes", "worktree", "worktrees",
        "commit", "commits", "dev", "git",
    ]
)

# How many cut claims the over-budget omission may list; the exact count is
# always reported, the listing itself stays bounded.
OMITTED_LIST_CAP = 16

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_REGEXP_SPECIAL = re.compile(r"[.*+?^${}()|\[\]\\]")


def escape_regexp(text: str) -> str:
    return _REGEXP_SPECIAL.sub(lambda m: "\\" + m.group(0), text)


def question_terms(question) -> list[str]:
    text = "" if question is None else str(question)
    tokens = _TOKEN_RE.findall(text.lower())
    terms: list[str] = []
    seen = set()
    for token in tokens:
        if len(token) < 3 or token in STOPWORDS or token in seen:
            continue
        terms.append(token)
        seen.add(token)
    return terms


def word_match(term: str, value) -> bool:
    if not isinstance(value, str) or len(value) == 0:
        return False
    pattern = f"(^|[^a-z0-9])" + escape_regexp(term) + "([^a-z0-9]|$)"
    return re.search(pattern, value.lower()) is not None


# Per-checkout view of the graph: the fields filters and ranking see.
def subject_profiles(graph):
    profiles = {}
    repositories = {
        n["id"]: n for n in graph.get("nodes", []) if n.get("kind") == "repository"
    }
    for node in graph.get("nodes", []):
        if node.get("kind") != "checkout":
            continue
        facts = node.get("facts") or {}
        ref = facts.get("head_ref")
        branch = None
        if isinstance(ref, dict) and ref.get("status") == "known":
            ref_value = ref.get("value")
            if isinstance(ref_value, dict) and ref_value.get("kind") == "branch":
                branch = ref_value.get("name")
        profiles[node["id"]] = {
            "label": node.get("label"),
            "path": node.get("path"),
            "branch": branch,
            "repository": None,
            "conflicts": [],
        }
    for edge in graph.get("edges") or []:
        if edge.get("kind") != "checkout_of":
            continue
        profile = profiles.get(edge.get("from"))
        repository = repositories.get(edge.get("to"))
        if profile is not None and repository is not None:
            profile["repository"] = repository
    for conflict in graph.get("conflicts") or []:
        for side in conflict.get("sides") or []:
            profile = profiles.get(side.get("checkout"))
            if profile is not None:
                profile["conflicts"].append(conflict)
    return profiles


def _filter_field_value(profile, claim, field):
    if field == "fact":
        return claim.get("fact")
    if field == "label":
        return profile.get("label") if profile is not None else None
    if field == "path":
        return profile.get("path") if profile is not None else None
    if field == "repository":
        if profile is None:
            return None
        repository = profile.get("repository")
        return repository.get("identity") if isinstance(repository, dict) else None
    if field == "branch":
        return profile.get("branch") if profile is not None else None
    return None


def validate_filters(filters):
    if filters is None:
        return []
    if not isinstance(filters, list):
        raise TypeError("task.filters must be an array of {field, equals|includes}")
    result = []
    for filt in filters:
        if not isinstance(filt, dict):
            raise TypeError(
                "each filter must be an object with field and exactly one of equals|includes"
            )
        if filt.get("field") not in FILTER_FIELDS:
            raise TypeError(
                f"unknown filter field '{filt.get('field')}'; known fields: {', '.join(FILTER_FIELDS)}"
            )
        has_equals = "equals" in filt
        has_includes = "includes" in filt
        if has_equals == has_includes:
            raise TypeError(
                f"filter on '{filt.get('field')}' must carry exactly one of equals|includes"
            )
        operator = "equals" if has_equals else "includes"
        if not isinstance(filt.get(operator), str):
            raise TypeError(
                f"filter {operator} value on '{filt.get('field')}' must be a string"
            )
        result.append({"field": filt["field"], "operator": operator, "value": filt[operator]})
    return result


def _match_filter(filt, value) -> bool:
    if value is None:
        return False
    if filt["operator"] == "equals":
        return value == filt["value"]
    return filt["value"].lower() in str(value).lower()


# Rank one claim: tier, machine-readable signals, and a human reason.
# Signals name the question term and the field kind that matched - never the
# subject's own value, so unproven identities can not leak through explains.
#
# `intrinsic_signals` lets a candidate itself assert relevance rather than
# relying only on the subject's checkout-wide profile - e.g. a content_match
# candidate is on-topic by construction (its term was found in the
# checkout's own tracked-file content), even when nothing about the
# checkout's label/branch/repository identity happens to match the question.
# Conflict-side still outranks every such signal: the capsule exists to make
# an unresolved discrepancy legible above all else.
def rank_claim(profile, terms, intrinsic_signals=None):
    if intrinsic_signals is None:
        intrinsic_signals = []
    signals = []
    for conflict in (profile.get("conflicts") if profile else None) or []:
        signals.append({"signal": "conflict_side", "conflict": conflict.get("id")})
    repository = profile.get("repository") if profile else None
    repository_identity = None
    if isinstance(repository, dict) and repository.get("identity_status") == "known":
        repository_identity = repository.get("identity")
    match_surfaces = [
        ("label", profile.get("label") if profile else None),
        ("repository", repository_identity),
        ("branch", profile.get("branch") if profile else None),
    ]
    for term in terms:
        for field, value in match_surfaces:
            if word_match(term, value):
                signals.append({"signal": "question_term_match", "term": term, "field": field})
    signals.extend(intrinsic_signals)

    if any(s.get("signal") == "conflict_side" for s in signals):
        conflict = profile["conflicts"][0]
        return {
            "tier": 0,
            "signals": signals,
            "reason": (
                f"subject is a side of an unresolved {conflict.get('kind')} conflict; "
                "the task question turns on which side is current"
            ),
        }

    term_match = next((s for s in signals if s.get("signal") == "question_term_match"), None)
    if term_match is not None:
        return {
            "tier": 1,
            "signals": signals,
            "reason": f"task question term '{term_match['term']}' matches the subject {term_match['field']}",
        }

    content_match = next((s for s in signals if s.get("signal") == "content_term_match"), None)
    if content_match is not None:
        return {
            "tier": 1,
            "signals": signals,
            "reason": f"content match: term '{content_match['term']}' was found in {content_match['path']}",
        }

    return {
        "tier": 2,
        "signals": [{"signal": "allowlisted"}],
        "reason": "inside the task allowlist; no task-specific relevance signal",
    }


def select_claims(*, task, graph, candidates, max_claims):
    """Select claims for a capsule: apply structured filters, rank what
    survives, cut at the budget, and explain all of it.

    Returns {"included": [...], "filtered_out": {...} | None,
    "over_budget": {...} | None} - the snake_case equivalent of select.mjs's
    {included, filteredOut, overBudget}.
    """
    filters = validate_filters(task.get("filters"))
    profiles = subject_profiles(graph)
    terms = question_terms(task.get("question"))

    surviving = []
    filtered_count = 0
    # Per-subject count of content_match candidates seen so far (survived
    # filters only - a filtered-out candidate never entered ranking, so it
    # never costs the subject's next real content_match a step of growth).
    content_match_seen = {}
    for candidate in candidates:
        profile = profiles.get(candidate.get("subject"))
        matched = [
            {"filter": filt, "matched": _match_filter(filt, _filter_field_value(profile, candidate, filt["field"]))}
            for filt in filters
        ]
        if any(not m["matched"] for m in matched):
            filtered_count += 1
            continue

        public_candidate = {k: v for k, v in candidate.items() if k != "intrinsic_signals"}
        intrinsic_signals = candidate.get("intrinsic_signals")
        rank = rank_claim(profile, terms, intrinsic_signals)
        selection = {"tier": TIER_NAMES[rank["tier"]], "signals": rank["signals"]}
        if len(filters) > 0:
            selection["matched_filters"] = [dict(m["filter"]) for m in matched]

        weight = FACT_WEIGHTS.get(candidate.get("fact"), UNKNOWN_FACT_WEIGHT)
        if candidate.get("fact") == "content_match":
            occurrence = content_match_seen.get(candidate.get("subject"), 0)
            content_match_seen[candidate.get("subject")] = occurrence + 1
            weight = CONTENT_BASE_WEIGHT + occurrence * CONTENT_GROWTH_STEP
        budget_rank = rank["tier"] * TIER_BAND + weight

        claim = dict(public_candidate)
        claim["selection_reason"] = rank["reason"]
        claim["selection"] = selection
        tiebreak = f"{candidate.get('subject')}:{candidate.get('fact')}:{candidate.get('claim')}"
        surviving.append({"claim": claim, "sort_key": (budget_rank, _utf16_sort_key(tiebreak))})

    # select.mjs compares sortKey entries with plain `<`/`>`: numeric compare
    # for budget_rank, UTF-16-code-unit compare for the tiebreak string (NOT
    # localeCompare) - see module docstring.
    surviving.sort(key=lambda s: s["sort_key"])

    included = [s["claim"] for s in surviving[:max_claims]]
    cut = surviving[max_claims:]

    over_budget = None
    if len(cut) > 0:
        over_budget = {
            "omitted_count": len(cut),
            "omitted": [
                {
                    "subject_path": s["claim"].get("subject_path"),
                    "fact": s["claim"].get("fact"),
                    "tier": s["claim"]["selection"]["tier"],
                }
                for s in cut[:OMITTED_LIST_CAP]
            ],
        }
        if len(cut) > OMITTED_LIST_CAP:
            over_budget["truncated"] = True

    filtered_out = None
    if filtered_count > 0:
        filtered_out = {
            "omitted_count": filtered_count,
            "filters": [{"field": f["field"], f["operator"]: f["value"]} for f in filters],
        }

    return {"included": included, "filtered_out": filtered_out, "over_budget": over_budget}
