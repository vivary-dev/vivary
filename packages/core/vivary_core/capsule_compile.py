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

import re

from vivary_core.canonical import (
    MAX_LOSSLESS_INTEGER,
    _utf16_sort_key,
    deterministic_id,
    fingerprint,
    is_canonical_body_value,
    is_within_allowlist,
)
from vivary_core.capsule_select import (
    TIER_NAMES,
    _filter_field_value,
    _match_filter,
    _question_match_value,
    question_terms,
    word_match,
    select_claims,
    subject_profiles,
    validate_filters,
)
from vivary_core.collation import CollationDomainError, locale_sort_key

CAPSULE_SCHEMA = "vivary.task-capsule/v0"


def _nonempty_string(value) -> bool:
    return isinstance(value, str) and bool(value)


def _nonblank_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())

def _content_question_terms(question) -> set[str]:
    text = "" if question is None else str(question)
    return set(re.findall(r"[^\W_]+", text.lower(), flags=re.UNICODE))


def repair_topology_fingerprint(graph) -> str:
    """Commit the graph relationships that can drive context-repair proposals."""

    if not isinstance(graph, dict):
        raise ValueError("workspace graph must be a mapping")
    graph_nodes = graph.get("nodes", [])
    graph_edges = graph.get("edges", [])
    if not isinstance(graph_nodes, list) or not isinstance(graph_edges, list):
        raise ValueError("workspace graph topology must use node and edge lists")

    repositories = []
    for node in graph_nodes:
        if not isinstance(node, dict):
            raise ValueError("workspace graph contains an invalid node")
        if node.get("kind") != "repository":
            continue
        if not _nonempty_string(node.get("id")):
            raise ValueError("repository topology nodes require non-empty string IDs")
        repositories.append(
            {
                "id": node["id"],
                "identity": node.get("identity"),
                "identity_status": node.get("identity_status"),
            }
        )
    repositories.sort(key=lambda node: _utf16_sort_key(node["id"]))

    checkout_of = []
    for edge in graph_edges:
        if not isinstance(edge, dict):
            raise ValueError("workspace graph contains an invalid edge")
        if edge.get("kind") != "checkout_of":
            continue
        if not _nonempty_string(edge.get("from")) or not _nonempty_string(
            edge.get("to")
        ):
            raise ValueError(
                "checkout_of topology edges require non-empty string endpoints"
            )
        checkout_of.append(
            {
                "checkout": edge["from"],
                "repository": edge["to"],
            }
        )
    checkout_of.sort(
        key=lambda relationship: (
            _utf16_sort_key(relationship["checkout"]),
            _utf16_sort_key(relationship["repository"]),
        )
    )
    return fingerprint(
        {
            "schema": "vivary.repair-topology/v0",
            "repositories": repositories,
            "checkout_of": checkout_of,
        }
    )


def _task_capsule_id(task, workspace_fingerprint) -> str:
    """Derive the capsule identifier from the compiler's pinned identity fields."""

    return deterministic_id(
        "capsule",
        {
            "task": task.get("question"),
            # JS `task.filters ?? null`: absent/None both collapse to None.
            "filters": task.get("filters"),
            "workspace": workspace_fingerprint,
        },
    )


def _is_required_checks_shape(value) -> bool:
    return isinstance(value, list) and all(
        isinstance(required_check, dict)
        and isinstance(required_check.get("name"), str)
        and bool(required_check["name"])
        and isinstance(required_check.get("command"), str)
        and bool(required_check["command"])
        for required_check in value
    )


def _is_task_shape(task) -> bool:
    if not (
        isinstance(task, dict)
        and _nonblank_string(task.get("question"))
        and set(task) <= {"question", "scope", "filters"}
    ):
        return False
    if "scope" in task and not (
        isinstance(task["scope"], list)
        and bool(task["scope"])
        and all(_nonempty_string(root) for root in task["scope"])
    ):
        return False
    if "filters" in task:
        if task["filters"] is None:
            return False
        try:
            validate_filters(task["filters"])
        except TypeError:
            return False
    return True


def _is_conflict_side_shape(side) -> bool:
    if not (
        isinstance(side, dict)
        and {
            "checkout",
            "path",
            "head_revision",
            "head_ref",
            "last_fetch",
            "evidence",
        }
        <= set(side)
        and _nonempty_string(side.get("checkout"))
        and _nonempty_string(side.get("path"))
    ):
        return False
    head_revision = side["head_revision"]
    head_ref = side["head_ref"]
    last_fetch = side["last_fetch"]
    evidence = side["evidence"]
    return (
        (head_revision is None or _nonempty_string(head_revision))
        and (
            head_ref is None
            or (
                isinstance(head_ref, dict)
                and _nonempty_string(head_ref.get("kind"))
                and (
                    head_ref["kind"] != "branch"
                    or _nonempty_string(head_ref.get("name"))
                )
            )
        )
        and (last_fetch is None or isinstance(last_fetch, str))
        and (
            evidence is None
            or isinstance(evidence, dict)
            or (
                isinstance(evidence, list)
                and all(isinstance(item, dict) for item in evidence)
            )
        )
    )


def _is_claim_shape(claim) -> bool:
    if not isinstance(claim, dict) or not all(
        _nonempty_string(claim.get(field))
        for field in (
            "id",
            "subject",
            "subject_path",
            "fact",
            "claim",
            "status",
            "selection_reason",
        )
    ):
        return False
    evidence = claim.get("evidence")
    selection = claim.get("selection")
    if (
        not isinstance(evidence, list)
        or not all(isinstance(item, dict) for item in evidence)
        or not isinstance(selection, dict)
        or not _nonempty_string(selection.get("tier"))
        or not isinstance(selection.get("signals"), list)
        or not all(isinstance(signal, dict) for signal in selection["signals"])
    ):
        return False
    matched_filters = selection.get("matched_filters")
    return matched_filters is None or (
        isinstance(matched_filters, list)
        and all(isinstance(item, dict) for item in matched_filters)
    )


def _is_unknown_shape(unknown) -> bool:
    if not isinstance(unknown, dict):
        return False

    def evidence_is_valid(value) -> bool:
        return isinstance(value, list) and all(
            isinstance(item, dict) for item in value
        )

    kind = unknown.get("kind")
    if kind is None:
        return (
            set(unknown) == {"checkout", "path", "fact", "reason"}
            and all(
                _nonempty_string(unknown.get(field))
                for field in ("checkout", "path", "fact")
            )
            and (
                unknown["reason"] is None
                or _nonempty_string(unknown["reason"])
            )
        )
    if kind == "required_check_undetermined":
        return (
            set(unknown)
            == {
                "kind",
                "subject",
                "subject_path",
                "reason",
                "observed_markers",
                "resolution",
                "evidence",
            }
            and all(
                _nonempty_string(unknown.get(field))
                for field in ("subject", "subject_path", "reason", "resolution")
            )
            and isinstance(unknown["observed_markers"], list)
            and bool(unknown["observed_markers"])
            and all(
                _nonempty_string(marker)
                for marker in unknown["observed_markers"]
            )
            and evidence_is_valid(unknown["evidence"])
        )
    if kind == "content_snapshot_stale":
        return (
            set(unknown)
            == {
                "kind",
                "subject",
                "subject_path",
                "reason",
                "observed_revision",
                "searched_revision",
                "evidence",
            }
            and all(
                _nonempty_string(unknown.get(field))
                for field in ("subject", "subject_path", "reason")
            )
            and all(
                revision is None or _nonempty_string(revision)
                for revision in (
                    unknown["observed_revision"],
                    unknown["searched_revision"],
                )
            )
            and evidence_is_valid(unknown["evidence"])
        )
    if kind == "content_search_incomplete":
        return (
            set(unknown)
            == {
                "kind",
                "subject",
                "subject_path",
                "status",
                "reason",
                "evidence",
            }
            and all(
                unknown.get(field) is None
                or _nonempty_string(unknown.get(field))
                for field in ("subject", "subject_path")
            )
            and all(
                _nonempty_string(unknown.get(field))
                for field in ("status", "reason")
            )
            and evidence_is_valid(unknown["evidence"])
        )
    return False


def _is_conflict_shape(conflict) -> bool:
    if not (
        isinstance(conflict, dict)
        and conflict.get("kind") == "divergent_checkouts"
        and conflict.get("status") == "unresolved"
        and conflict.get("decision") == "review_required"
        and all(
            _nonempty_string(conflict.get(field))
            for field in ("id", "repository", "question")
        )
    ):
        return False
    sides = conflict.get("sides")
    reason_codes = conflict.get("reason_codes")
    return (
        isinstance(sides, list)
        and len(sides) >= 2
        and all(_is_conflict_side_shape(side) for side in sides)
        and len({side["checkout"] for side in sides}) == len(sides)
        and isinstance(reason_codes, list)
        and bool(reason_codes)
        and all(_nonempty_string(reason_code) for reason_code in reason_codes)
    )


def _selection_signal_is_valid(signal, terms, content_terms, claim) -> bool:
    signal_kind = signal.get("signal")
    if signal_kind == "conflict_side":
        return set(signal) == {"signal", "conflict"} and _nonempty_string(
            signal.get("conflict")
        )
    if signal_kind == "question_term_match":
        return (
            set(signal) == {"signal", "term", "field"}
            and signal.get("term") in terms
            and signal.get("field") in {"label", "repository", "branch"}
        )
    if signal_kind == "content_term_match":
        term = signal.get("term")
        path = signal.get("path")
        return (
            set(signal) == {"signal", "term", "path"}
            and term in content_terms
            and _nonempty_string(path)
            and claim.get("fact") == "content_match"
            and claim.get("status") == "known"
            and claim.get("claim", "").startswith(f"{path}:")
            and f" matches '{term}': \"" in claim["claim"]
        )
    return signal == {"signal": "allowlisted"}


def _selection_signals_are_valid(signals, terms, content_terms, claim) -> bool:
    identities = set()
    for signal in signals:
        if not _selection_signal_is_valid(signal, terms, content_terms, claim):
            return False
        identity = tuple(sorted(signal.items()))
        if identity in identities:
            return False
        identities.add(identity)
    return True


def _claim_matches_task_filters(task, claim) -> bool:
    expected_filters = validate_filters(task.get("filters"))
    selection = claim["selection"]
    if not expected_filters:
        return "matched_filters" not in selection
    if selection.get("matched_filters") != expected_filters:
        return False
    for task_filter in expected_filters:
        if task_filter["field"] == "fact":
            observed = claim["fact"]
        elif task_filter["field"] == "path":
            observed = claim["subject_path"]
        else:
            # Label, repository, and branch are graph-profile fields that do not
            # enter the claim. Their compiler-owned normalized match record is the
            # capsule's portable proof when no graph accompanies verification.
            continue
        if task_filter["operator"] == "equals":
            if observed != task_filter["value"]:
                return False
        elif task_filter["value"].lower() not in observed.lower():
            return False
    return True


def capsule_claims_match_graph(capsule, graph) -> bool:
    """Bind every claim and graph-derived selection signal to the supplied graph."""

    profile_filters = [
        task_filter
        for task_filter in validate_filters(capsule["task"].get("filters"))
        if task_filter["field"] in {"label", "repository", "branch"}
    ]
    profiles = subject_profiles(graph)
    for claim in capsule["claims"]:
        profile = profiles.get(claim["subject"])
        if (
            profile is None
            or claim["subject_path"] != profile.get("path")
            or any(
                not _match_filter(
                    task_filter,
                    _filter_field_value(profile, claim, task_filter["field"]),
                )
                for task_filter in profile_filters
            )
        ):
            return False
        for signal in claim["selection"]["signals"]:
            if (
                signal["signal"] == "question_term_match"
                and not word_match(
                    signal["term"],
                    _question_match_value(profile, signal["field"]),
                )
            ):
                return False
    return True




def _claim_selections_are_valid(capsule) -> bool:
    conflict_ids_by_checkout = {}
    for conflict in capsule["conflicts"]:
        for side in conflict["sides"]:
            conflict_ids_by_checkout.setdefault(side["checkout"], set()).add(
                conflict["id"]
            )
    terms = set(question_terms(capsule["task"]["question"]))
    content_terms = _content_question_terms(capsule["task"]["question"])
    for claim in capsule["claims"]:
        selection = claim["selection"]
        tier = selection["tier"]
        signals = selection["signals"]
        if (
            tier not in TIER_NAMES
            or not signals
            or not _selection_signals_are_valid(
                signals, terms, content_terms, claim
            )
            or not _claim_matches_task_filters(capsule["task"], claim)
        ):
            return False

        expected_conflicts = conflict_ids_by_checkout.get(claim["subject"], set())
        observed_conflicts = {
            signal["conflict"]
            for signal in signals
            if signal["signal"] == "conflict_side"
        }
        has_question_match = any(
            signal["signal"] in {"question_term_match", "content_term_match"}
            for signal in signals
        )
        has_allowlisted = any(
            signal["signal"] == "allowlisted"
            for signal in signals
        )
        if expected_conflicts:
            if (
                tier != "conflict_side"
                or observed_conflicts != expected_conflicts
                or has_allowlisted
            ):
                return False
        elif observed_conflicts:
            return False
        elif has_question_match:
            if tier != "question_match" or has_allowlisted:
                return False
        elif tier != "allowlisted" or signals != [{"signal": "allowlisted"}]:
            return False
    return True


def is_task_capsule_shape(capsule) -> bool:
    """Return whether a value has the complete policy-facing Task Capsule shape."""

    if not (
        isinstance(capsule, dict)
        and capsule.get("schema") == CAPSULE_SCHEMA
        and _is_task_shape(capsule.get("task"))
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
        and _is_required_checks_shape(capsule.get("required_checks"))
        and isinstance(capsule.get("budget"), dict)
        and set(capsule["budget"]) == {"max_claims"}
        and type(capsule["budget"]["max_claims"]) is int
        and 0 <= capsule["budget"]["max_claims"] <= MAX_LOSSLESS_INTEGER
    ):
        return False

    return (
        all(_is_claim_shape(claim) for claim in capsule["claims"])
        and all(
            _is_conflict_shape(conflict)
            for conflict in capsule["conflicts"]
        )
        and all(_is_unknown_shape(unknown) for unknown in capsule["unknowns"])
        and all(
            isinstance(omission, dict)
            and isinstance(omission.get("kind"), str)
            and bool(omission["kind"])
            for omission in capsule["omissions"]
        )
        and _claim_selections_are_valid(capsule)
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
        return (
            capsule["capsule_id"]
            == _task_capsule_id(
                capsule["task"],
                capsule["workspace"]["fingerprint"],
            )
            and capsule["fingerprint"] == fingerprint(body)
        )
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


def _content_match_candidates(content, checkouts_by_path, task_terms):
    if not content or not isinstance(content.get("checkouts"), list):
        return [], []
    candidates = []
    excluded_count = 0
    for checkout_content in content["checkouts"]:
        node = checkouts_by_path.get(checkout_content.get("path"))
        if node is None:
            continue
        if not _content_is_bound_to(node, checkout_content):
            continue
        for match in checkout_content.get("matches") or []:
            if match.get("term") not in task_terms:
                excluded_count += 1
                continue
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
    omissions = []
    if excluded_count:
        omissions.append(
            {
                "kind": "content_matches_outside_task",
                "omitted_count": excluded_count,
                "reason": "content match terms must be normalized task question terms",
            }
        )
    return candidates, omissions



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

    task: {"question": str, "scope": [str], "filters": [dict], "required_checks": [dict]}
        (`question` is required; the remaining fields are optional)
    graph: output of project_workspace_graph (workspace_model.py)
    budget: {"max_claims": int} (optional)
    content: optional output of observe_content (workspace_content.py),
        redacted through the same token map as `graph`. Absent -> byte-
        identical behavior to a capsule compiled with no content argument at
        all.
    """
    if not isinstance(task, dict):
        raise ValueError("task must be a mapping")
    if not _nonblank_string(task.get("question")):
        raise ValueError("task.question must be a non-blank string")
    declared_scope = task.get("scope")
    if (
        declared_scope is not None
        and (
            not isinstance(declared_scope, list)
            or not declared_scope
            or any(
                not isinstance(root, str) or not root
                for root in declared_scope
            )
        )
    ):
        raise ValueError("task.scope must be a non-empty list of non-empty strings")
    declared_checks = task.get("required_checks")
    if declared_checks is not None and not _is_required_checks_shape(declared_checks):
        raise ValueError(
            "task.required_checks must be a list of {name, command} non-empty strings"
        )
    budget = budget or {}
    max_claims = budget.get("max_claims")
    if max_claims is None:
        max_claims = 24
    # Python's negative slicing would quietly include almost every candidate: -1
    # selects all but the last claim and then reports "claim budget -1 reached".
    # A malformed budget must fail closed, not expand the context.
    if (
        isinstance(max_claims, bool)
        or not isinstance(max_claims, int)
        or not 0 <= max_claims <= MAX_LOSSLESS_INTEGER
    ):
        raise ValueError(
            "budget.max_claims must be an integer from 0 through "
            f"{MAX_LOSSLESS_INTEGER} (got {max_claims!r})"
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

    scoped_conflicts = []
    scope_conflict_omissions = []
    for conflict in graph["conflicts"]:
        if _entry_in_scope(conflict):
            scoped_conflicts.append(conflict)
            continue
        for side in conflict.get("sides") or []:
            if (
                not isinstance(side, dict)
                or not side.get("path")
                or not _in_scope(side["path"])
            ):
                continue
            scope_conflict_omissions.append(
                {
                    "kind": "conflict_outside_scope",
                    "conflict": conflict.get("id"),
                    "subject": side.get("checkout"),
                    "subject_path": side["path"],
                    "reason": "one or more conflict sides are outside the declared scope",
                }
            )

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
    content_candidates, content_candidate_omissions = _content_match_candidates(
        content, checkouts_by_path, _content_question_terms(task["question"])
    )
    candidates.extend(content_candidates)
    truncation_omissions.extend(content_candidate_omissions)
    candidates, collation_omissions = _sort_candidates(candidates)
    truncation_omissions.extend(collation_omissions)

    # Filters restrict, ranking orders, the budget cuts - each step explained.
    selection = select_claims(
        task=task,
        graph={**graph, "conflicts": scoped_conflicts},
        candidates=candidates,
        max_claims=max_claims,
    )
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
        *scope_conflict_omissions,
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
    # `declared_checks` was shape-validated at the task boundary.
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
    for conflict in scoped_conflicts:
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
            "repair_topology_fingerprint": repair_topology_fingerprint(graph),
        },
        "claims": included,
        "conflicts": conflicts,
        "unknowns": [
            *[u for u in graph["unknowns"] if _entry_in_scope(u)],
            *[u for u in content_unknowns if _entry_in_scope(u)],
            *[u for u in check_unknowns if _entry_in_scope(u)],
        ],
        "omissions": [
            omission
            for omission in omissions
            if _entry_in_scope(omission)
        ],
        "required_checks": required_checks,
        "budget": {"max_claims": max_claims},
    }

    capsule_fingerprint = fingerprint(body)
    result = {
        "capsule_id": _task_capsule_id(
            task,
            graph.get("workspace_fingerprint"),
        )
    }
    result.update(body)
    result["fingerprint"] = capsule_fingerprint
    return result
