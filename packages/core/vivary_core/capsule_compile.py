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

from vivary_core.canonical import (
    _utf16_sort_key,
    deterministic_id,
    fingerprint,
    is_canonical_body_value,
    is_within_allowlist,
)
from vivary_core.capsule_select import select_claims
from vivary_core.collation import CollationDomainError, locale_sort_key

CAPSULE_SCHEMA = "vivary.task-capsule/v0"


def is_task_capsule_shape(capsule) -> bool:
    """Return whether a value has the complete policy-facing Task Capsule shape."""

    if not (
        isinstance(capsule, dict)
        and capsule.get("schema") == CAPSULE_SCHEMA
        and isinstance(capsule.get("capsule_id"), str)
        and bool(capsule["capsule_id"])
        and isinstance(capsule.get("fingerprint"), str)
        and bool(capsule["fingerprint"])
        and isinstance(capsule.get("workspace"), dict)
        and isinstance(capsule["workspace"].get("fingerprint"), str)
        and bool(capsule["workspace"]["fingerprint"])
        and isinstance(capsule.get("claims"), list)
        and isinstance(capsule.get("conflicts"), list)
        and isinstance(capsule.get("unknowns"), list)
        and isinstance(capsule.get("omissions"), list)
        and isinstance(capsule.get("required_checks"), list)
        and isinstance(capsule.get("budget"), dict)
        and set(capsule["budget"]) == {"max_claims"}
        and type(capsule["budget"]["max_claims"]) is int
        and capsule["budget"]["max_claims"] >= 0
    ):
        return False

    return (
        all(
            isinstance(claim, dict)
            and isinstance(claim.get("id"), str)
            and bool(claim["id"])
            for claim in capsule["claims"]
        )
        and all(
            isinstance(conflict, dict)
            and isinstance(conflict.get("id"), str)
            and bool(conflict["id"])
            and isinstance(conflict.get("decision"), str)
            and bool(conflict["decision"])
            for conflict in capsule["conflicts"]
        )
        and all(isinstance(unknown, dict) for unknown in capsule["unknowns"])
        and all(
            isinstance(omission, dict)
            and isinstance(omission.get("kind"), str)
            and bool(omission["kind"])
            for omission in capsule["omissions"]
        )
        and all(
            isinstance(required_check, dict)
            and isinstance(required_check.get("name"), str)
            and bool(required_check["name"])
            and isinstance(required_check.get("command"), str)
            and bool(required_check["command"])
            for required_check in capsule["required_checks"]
        )
    )


def verify_task_capsule_integrity(capsule) -> bool:
    """Verify a complete Task Capsule against its claimed body fingerprint."""

    if not is_task_capsule_shape(capsule):
        return False
    body = {
        key: value
        for key, value in capsule.items()
        if key not in {"capsule_id", "fingerprint"}
    }
    if not is_canonical_body_value(body):
        return False
    try:
        return capsule["fingerprint"] == fingerprint(body)
    except TypeError:
        return False

# Checks were hardcoded for every workspace, so a Python-only project was told to
# run `npm test` and had no way to say otherwise. They are now derived from what was
# actually observed, and a check nobody can evidence is reported as an unknown rather
# than invented — a wrong check that passes *trivially* (a test runner collecting
# nothing and exiting 0) would launder a broken workspace into a green receipt, which
# is worse than having no check at all.
#
# `entire status --json` was also a default here. It is not a Vivary command; the
# `entire_checkpoint` provenance the receipt model carries is a deliberate, separate
# integration and is untouched. A check for it must be derived from evidence that the
# workspace actually uses Entire, never assumed.

# Markers that indicate a test system exists but do not identify the command to run.
# Python alone spans pytest, tox, nox and make; picking one would be a guess.
_AMBIGUOUS_TEST_MARKERS = ("pyproject.toml", "tox.ini", "noxfile.py", "Cargo.toml", "go.mod", "Makefile")
# Keep aligned with create-vivary's REPAIR_WORKSPACE_MARKERS. Core cannot import
# the scaffolder package, so this boundary contract is intentionally repeated here.
_CREATE_VIVARY_WORKSPACE_MARKERS = frozenset(
    ("tropo.toml", "AGENTS.md", "STRATO.md")
)


def _fact_value(node, name):
    fact = (node.get("facts") or {}).get(name)
    if fact is None or fact.get("status") != "known":
        return None
    return fact.get("value")


def _derive_required_checks(checkouts):
    """The checks this workspace can actually be verified with, plus what is unknown.

    Returns `(checks, unknowns)`. Every derived check carries the evidence that
    justified it, so a consumer can see *why* it was asked to run something.
    """
    checks = []
    unknowns = []
    seen = set()

    def add(name, command, evidence, cwd):
        key = (cwd, command)
        if key in seen:
            return
        seen.add(key)
        checks.append(
            {"name": name, "command": command, "cwd": cwd, "evidence": evidence}
        )

    for node in checkouts:
        facts = node.get("facts") or {}
        markers = _fact_value(node, "workspace_markers") or []
        marker_evidence = (facts.get("workspace_markers") or {}).get("evidence")
        cwd = _fact_value(node, "worktree_root") or node.get("path")
        suffix = f"@{node.get('id')}"

        # A standalone Tropo graph can run its graph check. Doctor validates the
        # broader create-vivary scaffold, so require that scaffold's identity markers.
        if _CREATE_VIVARY_WORKSPACE_MARKERS.issubset(markers):
            add(
                f"vivary-graph-doctor{suffix}",
                "create-vivary doctor . --json",
                marker_evidence,
                cwd,
            )
        if "tropo.toml" in markers:
            add(
                f"vivary-graph-check{suffix}",
                "tropo check --root . --json",
                marker_evidence,
                cwd,
            )

        npm_test_fact = facts.get("npm_test_script") or {}
        npm_test = (
            npm_test_fact.get("value")
            if npm_test_fact.get("status") == "known"
            else None
        )
        if npm_test:
            add(
                f"project-tests{suffix}",
                "npm test",
                npm_test_fact.get("evidence"),
                cwd,
            )
        if any(marker in markers for marker in _AMBIGUOUS_TEST_MARKERS):
            unknowns.append(
                {
                    "kind": "required_check_undetermined",
                    "subject": node.get("id"),
                    "subject_path": node.get("path"),
                    "reason": "a test system is present but the command it is run with cannot be determined from observation",
                    "observed_markers": [m for m in markers if m in _AMBIGUOUS_TEST_MARKERS],
                    "resolution": "pass task.required_checks to state the command explicitly",
                    "evidence": [marker_evidence] if marker_evidence else [],
                }
            )
    return checks, unknowns

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
# Observation removes paths covered by repository ignore policy before graph
# projection. If that privacy check cannot be proved, dirty entries stay unknown
# and this compiler emits no path claim.
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
def _observed_head(node):
    fact = (node.get("facts") or {}).get("head_revision")
    if fact is None or fact.get("status") != "known":
        return None
    return fact.get("value")


def _content_is_bound_to(node, checkout_content):
    """Whether this content was observed at the revision the graph describes.

    Matching by path alone accepted a result from an earlier scan as evidence for a
    later snapshot, so a capsule could present an excerpt of a file as it used to be
    as evidence about the checkout as it is now — a unified governed context that
    never existed at any single moment. Unbindable content (either side missing a
    revision) is treated as stale rather than quietly trusted: this is an integrity
    check, and the whole point is not to accept evidence that cannot be placed.
    """
    observed = _observed_head(node)
    searched = checkout_content.get("head_revision")
    return bool(observed) and bool(searched) and observed == searched


def _content_match_candidates(content, checkouts_by_path):
    if not content or not isinstance(content.get("checkouts"), list):
        return []
    candidates = []
    for checkout_content in content["checkouts"]:
        node = checkouts_by_path.get(checkout_content.get("path"))
        if node is None:
            continue
        if not _content_is_bound_to(node, checkout_content):
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



def _candidate_sort_key(candidate):
    """Preserve frozen locale ordering without feeding it unpinned raw content.

    Graph-derived candidates remain byte-identical to the reference port. Content
    candidates are a later adaptation; when a raw path or excerpt falls outside the
    pinned locale domain, place it in a separate deterministic UTF-16 bucket rather
    than guessing an ICU weight or crashing the governed adapter.
    """
    value = (
        f"{candidate.get('subject')}:{candidate.get('fact')}:"
        f"{candidate.get('claim')}"
    )
    try:
        return (0, locale_sort_key(value))
    except CollationDomainError:
        if candidate.get("fact") != "content_match":
            raise
        return (1, _utf16_sort_key(value))


def _sort_candidates(candidates):
    keyed = []
    omissions = []
    for candidate in candidates:
        try:
            sort_key = _candidate_sort_key(candidate)
        except CollationDomainError as error:
            omissions.append(
                {
                    "kind": "collation_domain_excluded",
                    "subject": candidate.get("subject"),
                    "fact": candidate.get("fact"),
                    "reason": str(error),
                }
            )
        else:
            keyed.append((sort_key, candidate))
    keyed.sort(key=lambda entry: entry[0])
    return [candidate for _, candidate in keyed], omissions


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
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    if not isinstance(nodes, list):
        raise ValueError("workspace graph must contain a node list")

    checkouts = []
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("workspace graph contains an invalid node")
        facts = node.get("facts")
        if facts is None:
            facts = {}
        if not isinstance(facts, dict) or any(
            fact is not None and not isinstance(fact, dict) for fact in facts.values()
        ):
            raise ValueError("workspace graph contains an invalid fact")
        repository_fact = facts.get("is_git_repository")
        if (
            node.get("kind") == "checkout"
            and isinstance(repository_fact, dict)
            and repository_fact.get("value") is True
        ):
            checkouts.append(node)
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
    candidates, collation_omissions = _sort_candidates(candidates)
    truncation_omissions.extend(collation_omissions)

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
    # An explicit task-level list always wins: derivation is a convenience, not a
    # ceiling, and a caller who knows the command should never be argued with.
    declared_checks = task.get("required_checks")
    if declared_checks is not None:
        required_checks = list(declared_checks)
        check_unknowns: list[dict] = []
    else:
        required_checks, check_unknowns = _derive_required_checks(checkouts)

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
        # Content that could not be bound to this snapshot is dropped from evidence
        # above; saying so is the other half of the fix. A silent drop would leave a
        # capsule that looks like a clean search with no matches.
        if (
            node is not None
            and checkout_content.get("matches")
            and not _content_is_bound_to(node, checkout_content)
        ):
            content_unknowns.append(
                {
                    "kind": "content_snapshot_stale",
                    "subject": node.get("id"),
                    "subject_path": checkout_content.get("path"),
                    "reason": "content was observed at a different revision than the graph describes",
                    "observed_revision": _observed_head(node),
                    "searched_revision": checkout_content.get("head_revision"),
                    "evidence": [],
                }
            )
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
            *[u for u in check_unknowns if _entry_in_scope(u)],
        ],
        "omissions": omissions,
        "required_checks": required_checks,
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
