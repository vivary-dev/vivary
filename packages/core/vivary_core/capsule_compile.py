"""Pure compilation: workspace graph + task -> bounded Task Capsule.

Reference-guided Python port of src/capsule/compile.mjs (slice 2, decision
0008). The Node module is the frozen executable oracle: every function here
is translated function-for-function. The capsule is read-only context for an
agent: every included claim carries a selection reason and evidence
reference; conflicts and unknowns survive compilation verbatim; anything
dropped is recorded as an omission.

Pure and I/O-free: no fs, no subprocess, no network, no non-determinism, no
wall-clock (a fixture-level test proves this - see test_capsule.py's
purity check).

Language mapping notes (decision 0008 / documented rules for this slice):
- JS `undefined` <-> absent dict key; `a?.b` chains become careful `.get()`
  chains; `x ?? y` becomes an explicit "is None" check (never a falsy check
  - 0 and "" must pass through unchanged, e.g. `budget.max_claims ?? 24`).
- compile.mjs's candidate sort calls `.localeCompare(...)` explicitly, so it
  is ordered here via `collation.locale_sort_key` (ICU-equivalent
  collation) - NOT `canonical._utf16_sort_key`, which is reserved for sites
  using plain JS relational operators (see capsule_select.py's own sort).
- JS object-spread-then-override (`{...obj, key: value}`) keeps a
  pre-existing key in its ORIGINAL insertion position while updating its
  value, and appends a new key at the end; Python dict assignment on an
  existing key already has this exact behavior, so `d = dict(obj);
  d[key] = value` reproduces it byte-for-byte regardless of whether `key`
  was already present.
"""

from __future__ import annotations

from vivary_core.canonical import deterministic_id, fingerprint, is_within_allowlist
from vivary_core.capsule_select import select_claims
from vivary_core.collation import locale_sort_key

CAPSULE_SCHEMA = "vivary.task-capsule/v0"

DEFAULT_REQUIRED_CHECKS = [
    {"name": "unit-and-contract-tests", "command": "npm test"},
    {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json"},
    {"name": "entire-status", "command": "entire status --json"},
]

# How many dirty paths a dirty_entries claim may list by name; the exact
# total count is always reported in the claim text regardless of the cap, so
# a caller never has to guess whether the listing is complete.
DIRTY_PATHS_CAP = 10


def _fact_claim(node, fact_name, describe):
    facts = node.get("facts") or {}
    fact = facts.get(fact_name)
    if fact is None or fact.get("status") == "unknown":
        return None
    evidence = fact.get("evidence")
    return {
        "subject": node.get("id"),
        "subject_path": node.get("path"),
        "claim": describe(fact.get("value")),
        "fact": fact_name,
        "status": fact.get("status"),
        "evidence": [evidence] if evidence else [],
    }


def _describe_ref(ref):
    if isinstance(ref, dict) and ref.get("kind") == "branch":
        return f"HEAD is on branch '{ref.get('name')}'"
    return "HEAD is detached"


# Bounded dirty-file-path claim: only for checkouts observe.mjs marked dirty
# (clean checkouts get no such claim). Lists up to DIRTY_PATHS_CAP paths with
# their porcelain state; the exact total is always in the claim text, and any
# truncation is recorded as an omission via `truncation_omissions`.
# git-ignored paths never appear here: `git status --porcelain` (the source
# of dirty_entries) never lists an ignored path, so there is no leak risk to
# guard against - see test_capsule.py.
def _dirty_entries_claim(node, truncation_omissions):
    facts = node.get("facts") or {}
    is_dirty = facts.get("is_dirty")
    dirty = facts.get("dirty_entries")
    if not is_dirty or is_dirty.get("value") is not True:
        return None
    if (
        not dirty
        or dirty.get("status") == "unknown"
        or not isinstance(dirty.get("value"), list)
        or len(dirty["value"]) == 0
    ):
        return None

    entries = dirty["value"]
    shown = entries[:DIRTY_PATHS_CAP]
    listing = ", ".join(f"{e.get('state')} {e.get('path')}" for e in shown)
    truncated = len(entries) > DIRTY_PATHS_CAP
    plural = "entry" if len(entries) == 1 else "entries"
    claim = f"worktree has {len(entries)} dirty {plural}: {listing}" + (", …" if truncated else "")

    if truncated:
        truncation_omissions.append(
            {
                "kind": "dirty_paths_truncated",
                "subject": node.get("id"),
                "subject_path": node.get("path"),
                "omitted_count": len(entries) - DIRTY_PATHS_CAP,
                "reason": (
                    f"dirty-path listing capped at {DIRTY_PATHS_CAP}; "
                    f"the exact total ({len(entries)}) is always reported in the claim text"
                ),
            }
        )

    evidence = dirty.get("evidence")
    return {
        "subject": node.get("id"),
        "subject_path": node.get("path"),
        "claim": claim,
        "fact": "dirty_entries",
        "status": dirty.get("status"),
        "evidence": [evidence] if evidence else [],
    }


# Bounded content-match candidate claims from an (optional) observeContent
# output. Matches are mapped to the graph checkout node sharing their exact
# path - the caller is responsible for redacting both the observation and
# the content result through the same token map before either reaches this
# pure module, so a match's `path` always lines up with a node's `path`. A
# match against a checkout outside the current graph is silently ignored,
# never guessed at. Each candidate carries an intrinsic
# `content_term_match` signal: a content match is on-topic by construction
# (the term was found in the checkout's own tracked-file content), even when
# nothing about the checkout's label/branch/repository identity matches.
def _content_match_candidates(content, checkouts_by_path):
    if not content or not isinstance(content.get("checkouts"), list):
        return []
    candidates = []
    for checkout_content in content["checkouts"]:
        node = checkouts_by_path.get(checkout_content.get("path"))
        if node is None:
            continue
        for match in checkout_content.get("matches") or []:
            evidence = match.get("evidence")
            candidates.append(
                {
                    "subject": node.get("id"),
                    "subject_path": node.get("path"),
                    "claim": f"{match.get('path')}:{match.get('line')} matches '{match.get('term')}': \"{match.get('excerpt')}\"",
                    "fact": "content_match",
                    "status": "known",
                    "evidence": [evidence] if evidence else [],
                    "intrinsic_signals": [
                        {"signal": "content_term_match", "term": match.get("term"), "path": match.get("path")}
                    ],
                }
            )
    return candidates


def compile_task_capsule(*, task, graph, budget=None, content=None):
    """Compile a bounded Task Capsule.

    task: {"question": str, "scope": [str] (optional), "filters": [dict] (optional)}
    graph: output of project_workspace_graph (workspace_model.py)
    budget: {"max_claims": int} (optional)
    content: optional output of observe_content (workspace_content.py),
        redacted through the same token map as `graph`. Absent -> byte-
        identical behavior to a capsule compiled with no content argument at
        all.
    """
    budget = budget or {}
    max_claims = budget.get("max_claims")
    if max_claims is None:
        max_claims = 24
    # Python's negative slicing would quietly include almost every candidate: -1
    # selects all but the last claim and then reports "claim budget -1 reached".
    # A malformed budget must fail closed, not expand the context.
    if isinstance(max_claims, bool) or not isinstance(max_claims, int) or max_claims < 0:
        raise ValueError(
            f"budget.max_claims must be a non-negative integer (got {max_claims!r})"
        )
    checkouts = [
        n
        for n in graph.get("nodes", [])
        if n.get("kind") == "checkout" and ((n.get("facts") or {}).get("is_git_repository") or {}).get("value") is True
    ]
    # A declared scope narrower than the graph's allowlist must actually bound what
    # the capsule carries. Copying it into the output alone let a capsule declare
    # scope ['/a'] while including claims from '/b', so a downstream agent could act
    # on context the capsule itself says is out of scope.
    declared_scope = task.get("scope")
    def _in_scope(path) -> bool:
        if not declared_scope:
            return True
        if not path:
            # A scoped capsule may still narrate something with no path of its own;
            # only entries that positively name an out-of-scope path are dropped.
            return True
        return any(is_within_allowlist(root, path) for root in declared_scope)

    def _entry_in_scope(entry) -> bool:
        """Scope applies to everything a capsule narrates, not only its claims.

        A conflict, unknown or refusal naming an out-of-scope checkout is still
        context about a place the capsule says it is not looking.
        """
        if not declared_scope or not isinstance(entry, dict):
            return True
        for key in ("path", "subject_path"):
            if entry.get(key) and not _in_scope(entry[key]):
                return False
        for side in entry.get("sides") or []:
            if isinstance(side, dict) and side.get("path") and not _in_scope(side["path"]):
                return False
        return True

    if declared_scope:
        checkouts = [n for n in checkouts if _in_scope(n.get("path"))]
    checkouts_by_path = {n.get("path"): n for n in checkouts}

    truncation_omissions: list[dict] = []
    candidates: list[dict] = []
    for checkout in checkouts:
        claims = [
            _fact_claim(checkout, "head_revision", lambda sha: f"HEAD revision is {sha}"),
            _fact_claim(checkout, "head_ref", _describe_ref),
            _fact_claim(
                checkout,
                "is_dirty",
                lambda dirty: "worktree has uncommitted changes" if dirty else "worktree is clean",
            ),
            _dirty_entries_claim(checkout, truncation_omissions),
            _fact_claim(
                checkout,
                "remotes",
                lambda remotes: (
                    "no remotes are configured"
                    if len(remotes) == 0
                    else "remotes: " + ", ".join(f"{r.get('name')} -> {r.get('fetch_url') if r.get('fetch_url') is not None else '?'}" for r in remotes)
                ),
            ),
            _fact_claim(checkout, "last_fetch", lambda at: f"last recorded fetch at {at}"),
        ]
        candidates.extend(c for c in claims if c is not None)
    candidates.extend(_content_match_candidates(content, checkouts_by_path))
    candidates.sort(key=lambda c: locale_sort_key(f"{c.get('subject')}:{c.get('fact')}:{c.get('claim')}"))

    # Filters restrict, ranking orders, the budget cuts - each step explained.
    selection = select_claims(task=task, graph=graph, candidates=candidates, max_claims=max_claims)
    selected, filtered_out, over_budget = (
        selection["included"],
        selection["filtered_out"],
        selection["over_budget"],
    )
    included = []
    for claim in selected:
        entry = {
            "id": deterministic_id(
                "claim", {"subject": claim.get("subject"), "fact": claim.get("fact"), "claim": claim.get("claim")}
            )
        }
        entry.update(claim)
        included.append(entry)

    omissions = [
        {
            "kind": "ignored_paths_excluded",
            "reason": "git-ignored paths are excluded from observation by policy and never enter a capsule",
        },
        *truncation_omissions,
    ]
    if filtered_out is not None:
        omissions.append({"kind": "filtered_out", "reason": "structured task filters excluded candidate claims", **filtered_out})
    if over_budget is not None:
        omissions.append(
            {
                "kind": "claims_over_budget",
                "reason": f"claim budget {max_claims} reached; cuts ranked by relevance tier, weakest evidence first",
                **over_budget,
            }
        )
    for refusal in graph.get("refusals") or []:
        if not _in_scope(refusal.get("path")):
            continue
        omissions.append({"kind": "refused_root", "reason": refusal.get("reason"), "path": refusal.get("path")})
    content_unknowns: list[dict] = []
    for checkout_content in (content.get("checkouts") if content else None) or []:
        node = checkouts_by_path.get(checkout_content.get("path"))
        for content_omission in checkout_content.get("omissions") or []:
            entry = dict(content_omission)
            entry["subject"] = node.get("id") if node is not None else None
            entry["subject_path"] = checkout_content.get("path")
            omissions.append(entry)
        # A search that could not run is not a search that found nothing. Reading
        # only `omissions` made `grep_unavailable` — and a root `observe_content`
        # refused outright — vanish from the capsule, so a failed search was
        # indistinguishable from a clean miss.
        if checkout_content.get("status") not in (None, "observed"):
            content_unknowns.append(
                {
                    "kind": "content_search_incomplete",
                    "subject": node.get("id") if node is not None else None,
                    "subject_path": checkout_content.get("path"),
                    "status": checkout_content.get("status"),
                    "reason": checkout_content.get("reason") or "content_search_unavailable",
                    "evidence": [checkout_content["evidence"]] if checkout_content.get("evidence") else [],
                }
            )
    for refusal in (content.get("refusals") if content else None) or []:
        omissions.append(
            {
                "kind": "content_root_refused",
                "reason": refusal.get("reason"),
                "path": refusal.get("path"),
            }
        )

    # Conflicts and unknowns pass through unreduced: a capsule may narrate them,
    # never resolve them. Every conflict is handed to review, not to confidence.
    conflicts = []
    for conflict in graph["conflicts"]:
        if not _entry_in_scope(conflict):
            continue
        entry = dict(conflict)
        entry["decision"] = "review_required"
        conflicts.append(entry)

    task_out = {"question": task.get("question")}
    scope = task.get("scope")
    task_out["scope"] = scope if scope is not None else graph.get("allowlist")
    if "filters" in task and task.get("filters") is not None:
        task_out["filters"] = task["filters"]

    body = {
        "schema": CAPSULE_SCHEMA,
        "task": task_out,
        "workspace": {
            "fingerprint": graph.get("workspace_fingerprint"),
            "observed_at": graph.get("observed_at"),
        },
        "claims": included,
        "conflicts": conflicts,
        "unknowns": [
            *[u for u in graph["unknowns"] if _entry_in_scope(u)],
            *[u for u in content_unknowns if _entry_in_scope(u)],
        ],
        "omissions": omissions,
        "required_checks": DEFAULT_REQUIRED_CHECKS,
        "budget": {"max_claims": max_claims},
    }

    capsule_fingerprint = fingerprint(body)
    result = {
        "capsule_id": deterministic_id(
            "capsule",
            {
                # JS `task.filters ?? null`: absent/None both collapse to None.
                "task": task.get("question"),
                "filters": task.get("filters"),
                "workspace": graph.get("workspace_fingerprint"),
            },
        )
    }
    result.update(body)
    result["fingerprint"] = capsule_fingerprint
    return result
