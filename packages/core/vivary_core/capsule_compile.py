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
  collation) - NOT `canonical.utf16_sort_key`, which is reserved for sites
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
from datetime import datetime

from vivary_core.canonical import (
    MAX_LOSSLESS_INTEGER,
    utf16_sort_key,
    canonicalize,
    deterministic_id,
    fingerprint,
    is_canonical_absolute_path,
    is_canonical_body_value,
    is_safe_checkout_relative_path,
    path_identity_key,
    normalize_path,
    is_within_allowlist,
)
from vivary_core.capsule_select import (
    CapsuleRankingWorkLimitError,
    OMITTED_LIST_CAP,
    FILTER_FIELDS,
    TIER_NAMES,
    _question_match_value,
    question_terms,
    select_claims,
    validate_filters,
)
from vivary_core.collation import CollationDomainError, locale_sort_key
from vivary_core.workspace_content import CONTENT_SCHEMA
from vivary_core.workspace_model import workspace_facts_are_valid

CAPSULE_SCHEMA = "vivary.task-capsule/v0"
TASK_CAPSULE_FIELDS = frozenset(
    {
        "capsule_id",
        "schema",
        "task",
        "workspace",
        "claims",
        "conflicts",
        "unknowns",
        "omissions",
        "required_checks",
        "budget",
        "fingerprint",
    }
)

MAX_GRAPH_CONTEXT_CHECKOUTS = 300
MAX_CAPSULE_CANDIDATE_WORK = 10_000
MAX_CONTENT_VALIDATION_WORK = 1_000_000
MAX_TASK_SCOPE_ROOTS = 1_000

_OMISSION_EXACT_KEYS = {
    "filtered_out": frozenset(
        {"kind", "reason", "omitted_count", "filters"}
    ),
    "refused_root": frozenset({"kind", "reason", "path"}),
    "dirty_paths_truncated": frozenset(
        {"kind", "subject", "subject_path", "omitted_count", "reason"}
    ),
    "content_matches_outside_task": frozenset(
        {"kind", "omitted_count", "reason"}
    ),
    "collation_domain_excluded": frozenset(
        {"kind", "subject", "fact", "reason"}
    ),
    "conflict_outside_scope": frozenset(
        {"kind", "conflict", "subject", "subject_path", "reason"}
    ),
    "ignored_paths_excluded": frozenset({"kind", "reason"}),
    "neighbor_of_pairs_capped": frozenset(
        {"kind", "repository", "reason", "omitted_count"}
    ),
    "content_lines_truncated": frozenset(
        {
            "kind",
            "subject",
            "subject_path",
            "path",
            "omitted_count",
            "reason",
        }
    ),
    "content_files_truncated": frozenset(
        {
            "kind",
            "subject",
            "subject_path",
            "omitted_count",
            "total_files_matched",
            "reason",
        }
    ),
    "privacy_matches_excluded": frozenset(
        {
            "kind",
            "subject",
            "subject_path",
            "omitted_count",
            "reason",
            "evidence",
        }
    ),
    "content_root_refused": frozenset({"kind", "reason", "path"}),
}

_CONTENT_SOURCE_FIELDS = frozenset(
    {"schema", "observed_at", "terms", "allowlist", "checkouts", "refusals"}
)
_CONTENT_CAPSULE_OMISSION_KINDS = frozenset(
    {
        "content_matches_outside_task",
        "content_lines_truncated",
        "content_files_truncated",
        "privacy_matches_excluded",
        "content_root_refused",
    }
)


def _nonempty_string(value) -> bool:
    return isinstance(value, str) and bool(value)


def _nonblank_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())

def _content_question_terms(question) -> set[str]:
    text = "" if question is None else str(question)
    return set(re.findall(r"[^\W_]+", text.lower(), flags=re.UNICODE))

class CapsuleContentWorkLimitError(ValueError):
    """Complete content validation would exceed its deterministic work ceiling."""



def _content_source_is_empty(content) -> bool:
    """Keep the three legacy semantic-empty forms outside content attestation."""
    return content is None or (
        type(content) is dict
        and (
            not content
            or (
                set(content) == {"checkouts"}
                and type(content["checkouts"]) is list
                and not content["checkouts"]
            )
        )
    )


def _is_timezone_aware_instant(value) -> bool:
    if not _nonblank_string(value):
        return False
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return instant.tzinfo is not None and instant.utcoffset() is not None


def _is_normalized_content_path(value) -> bool:
    return is_canonical_absolute_path(value)


def _is_content_evidence(value) -> bool:
    return (
        type(value) is dict
        and set(value) == {"command"}
        and _nonempty_string(value.get("command"))
    )


def _is_content_match_record(match, terms) -> bool:
    return (
        type(match) is dict
        and set(match) == {"path", "line", "excerpt", "term", "evidence"}
        and is_safe_checkout_relative_path(match["path"])
        and type(match["line"]) is int
        and match["line"] > 0
        and isinstance(match["excerpt"], str)
        and _nonempty_string(match["term"])
        and match["term"] in terms
        and _is_content_evidence(match["evidence"])
    )


def _is_content_omission_record(omission) -> bool:
    if type(omission) is not dict:
        return False
    kind = omission.get("kind")
    if kind == "content_lines_truncated":
        return (
            set(omission) == {"kind", "path", "omitted_count", "reason"}
            and is_safe_checkout_relative_path(omission["path"])
            and type(omission["omitted_count"]) is int
            and omission["omitted_count"] > 0
            and _nonblank_string(omission["reason"])
        )
    if kind == "content_files_truncated":
        return (
            set(omission)
            == {"kind", "omitted_count", "total_files_matched", "reason"}
            and type(omission["omitted_count"]) is int
            and omission["omitted_count"] > 0
            and type(omission["total_files_matched"]) is int
            and omission["total_files_matched"] >= omission["omitted_count"]
            and _nonblank_string(omission["reason"])
        )
    if kind == "privacy_matches_excluded":
        return (
            set(omission)
            == {"kind", "omitted_count", "reason", "evidence"}
            and type(omission["omitted_count"]) is int
            and omission["omitted_count"] > 0
            and _nonblank_string(omission["reason"])
            and _is_content_evidence(omission["evidence"])
        )
    return False


def _is_content_checkout_record(checkout, terms) -> bool:
    if (
        type(checkout) is not dict
        or not _nonempty_string(checkout.get("raw_path"))
        or not _is_normalized_content_path(checkout.get("path"))
        or normalize_path(checkout["raw_path"]) != checkout["path"]
    ):
        return False
    status = checkout.get("status")
    if status == "observed":
        base_fields = {
            "raw_path",
            "path",
            "status",
            "head_revision",
            "matches",
            "omissions",
        }
        fields = set(checkout)
        if fields not in (
            base_fields | {"privacy_fingerprint"},
            base_fields | {"reason"},
        ):
            return False
        if (
            (
                checkout["head_revision"] is not None
                and not _nonempty_string(checkout["head_revision"])
            )
            or type(checkout["matches"]) is not list
            or type(checkout["omissions"]) is not list
            or not all(
                _is_content_match_record(match, terms)
                for match in checkout["matches"]
            )
            or not all(
                _is_content_omission_record(omission)
                for omission in checkout["omissions"]
            )
        ):
            return False
        return (
            fields == base_fields | {"privacy_fingerprint"}
            and bool(terms)
            and _nonempty_string(checkout["head_revision"])
            and _nonempty_string(checkout["privacy_fingerprint"])
        ) or (
            fields == base_fields | {"reason"}
            and checkout.get("reason") == "no_question_terms"
            and not terms
            and checkout["head_revision"] is None
            and not checkout["matches"]
            and not checkout["omissions"]
        )
    if status == "unknown":
        return (
            set(checkout)
            == {
                "raw_path",
                "path",
                "status",
                "reason",
                "matches",
                "omissions",
                "evidence",
            }
            and _nonblank_string(checkout["reason"])
            and checkout["matches"] == []
            and checkout["omissions"] == []
            and _is_content_evidence(checkout["evidence"])
        )
    return False


def _is_normalized_source_path(value) -> bool:
    return _nonempty_string(value) and normalize_path(value) == value


def _is_content_refusal_record(refusal, allowlist) -> bool:
    if not (
        type(refusal) is dict
        and set(refusal) == {"raw_path", "path", "status", "reason"}
        and _nonempty_string(refusal.get("raw_path"))
        and _is_normalized_source_path(refusal.get("path"))
        and normalize_path(refusal["raw_path"]) == refusal["path"]
        and refusal["status"] == "refused"
    ):
        return False
    within_allowlist = any(
        is_within_allowlist(root, refusal["path"]) for root in allowlist
    )
    if refusal["reason"] == "outside_allowlist":
        return (
            not is_canonical_absolute_path(refusal["path"])
            or not within_allowlist
        )
    return (
        refusal["reason"] == "resolved_outside_allowlist"
        and is_canonical_absolute_path(refusal["path"])
        and within_allowlist
    )


def _content_records_are_unique(content) -> bool:
    source_paths = set()
    for record in [*content["checkouts"], *content["refusals"]]:
        source_key = path_identity_key(record["path"])
        if source_key in source_paths:
            return False
        source_paths.add(source_key)
    for checkout in content["checkouts"]:
        match_keys = set()
        for match in checkout["matches"]:
            match_key = (
                path_identity_key(
                    f"{checkout['path'].rstrip('/')}/{match['path']}"
                ),
                match["line"],
                match["term"],
            )
            if match_key in match_keys:
                return False
            match_keys.add(match_key)
    return True


def content_context_work_is_bounded(content) -> bool:
    if not isinstance(content, dict):
        return True
    checkouts = content.get("checkouts")
    refusals = content.get("refusals")
    allowlist = content.get("allowlist")
    if not all(
        isinstance(records, list)
        for records in (checkouts, refusals, allowlist)
    ):
        return True
    source_records = len(checkouts) + len(refusals)
    if (
        source_records > MAX_CAPSULE_CANDIDATE_WORK
        or source_records * len(allowlist) > MAX_CONTENT_VALIDATION_WORK
    ):
        return False
    root_units = sum(
        len(root) for root in allowlist if isinstance(root, str)
    )
    source_path_units = sum(
        len(record.get("path"))
        for record in [*checkouts, *refusals]
        if isinstance(record, dict) and isinstance(record.get("path"), str)
    )
    if (
        source_records * root_units
        + len(allowlist) * source_path_units
        > MAX_CONTENT_VALIDATION_WORK
    ):
        return False
    work = source_records
    prefix_work = 0
    for checkout in checkouts:
        matches = checkout.get("matches") if isinstance(checkout, dict) else None
        omissions = checkout.get("omissions") if isinstance(checkout, dict) else None
        if isinstance(matches, list) and isinstance(omissions, list):
            projected_records = len(matches) + len(omissions)
            work += projected_records
            checkout_path = checkout.get("path")
            if isinstance(checkout_path, str):
                prefix_work += len(checkout_path) * projected_records
                if prefix_work > MAX_CONTENT_VALIDATION_WORK:
                    return False
            if work > MAX_CAPSULE_CANDIDATE_WORK:
                return False
    return True


def _content_scope_work_is_bounded(content, scope) -> bool:
    if scope is None or _content_source_is_empty(content):
        return True
    if not isinstance(content, dict):
        return True
    checkouts = content.get("checkouts")
    refusals = content.get("refusals")
    if (
        not isinstance(scope, list)
        or not isinstance(checkouts, list)
        or not isinstance(refusals, list)
    ):
        return False

    occurrences = 0
    path_units = 0
    for checkout in checkouts:
        if not isinstance(checkout, dict):
            return False
        matches = checkout.get("matches")
        omissions = checkout.get("omissions")
        path = checkout.get("path")
        if (
            not isinstance(matches, list)
            or not isinstance(omissions, list)
            or not isinstance(path, str)
        ):
            return False
        checkout_occurrences = len(matches) + len(omissions) + 1
        occurrences += checkout_occurrences
        path_units += len(path) * checkout_occurrences
        path_units += sum(
            len(match.get("path"))
            for match in matches
            if isinstance(match, dict) and isinstance(match.get("path"), str)
        )

    for refusal in refusals:
        if not isinstance(refusal, dict) or not isinstance(refusal.get("path"), str):
            return False
        occurrences += 1
        path_units += len(refusal["path"])

    scope_units = sum(len(root) for root in scope if isinstance(root, str))
    scalar_work = (
        occurrences * len(scope)
        + occurrences * scope_units
        + path_units * len(scope)
    )
    return scalar_work <= MAX_CONTENT_VALIDATION_WORK

def content_context_is_valid(content) -> bool:
    """Validate a complete workspace-content/v0 source artifact."""
    if _content_source_is_empty(content):
        return True
    if (
        type(content) is not dict
        or not is_canonical_body_value(content)
        or set(content) != _CONTENT_SOURCE_FIELDS
        or content.get("schema") != CONTENT_SCHEMA
        or not _is_timezone_aware_instant(content.get("observed_at"))
        or type(content.get("terms")) is not list
        or not all(_nonempty_string(term) for term in content["terms"])
        or type(content.get("allowlist")) is not list
        or not content["allowlist"]
        or not all(
            _is_normalized_content_path(path)
            for path in content["allowlist"]
        )
        or not content_context_work_is_bounded(content)
        or type(content.get("checkouts")) is not list
        or type(content.get("refusals")) is not list
    ):
        return False
    terms = frozenset(content["terms"])
    return (
        all(
            _is_content_checkout_record(checkout, terms)
            and any(
                is_within_allowlist(root, checkout["path"])
                for root in content["allowlist"]
            )
            for checkout in content["checkouts"]
        )
        and all(
            _is_content_refusal_record(refusal, content["allowlist"])
            for refusal in content["refusals"]
        )
        and _content_records_are_unique(content)
    )


def content_context_is_present(content) -> bool:
    if _content_source_is_empty(content):
        return False
    return not (
        content_context_is_valid(content)
        and content["checkouts"] == []
        and content["refusals"] == []
    )


def _capsule_has_content_derived_artifacts(capsule) -> bool:
    claims = capsule.get("claims") if isinstance(capsule, dict) else None
    if isinstance(claims, list) and any(
        isinstance(claim, dict) and claim.get("fact") == "content_match"
        for claim in claims
    ):
        return True
    for field in ("unknowns", "omissions"):
        records = capsule.get(field) if isinstance(capsule, dict) else None
        if isinstance(records, list) and any(
            isinstance(record, dict)
            and (
                (
                    isinstance(record.get("kind"), str)
                    and record["kind"].startswith("content_")
                )
                or record.get("kind") in _CONTENT_CAPSULE_OMISSION_KINDS
            )
            for record in records
        ):
            return True
    return False


def capsule_compiler_omissions_require_graph(capsule) -> bool:
    """Whether graphless verification cannot disambiguate omission provenance."""
    omissions = capsule.get("omissions") if isinstance(capsule, dict) else None
    return isinstance(omissions, list) and any(
        isinstance(omission, dict)
        and omission.get("kind")
        in {
            "filtered_out",
            "claims_over_budget",
            "collation_domain_excluded",
        }
        for omission in omissions
    )


def _path_is_in_scope(path, scope) -> bool:
    if not scope or not path:
        return True
    return any(is_within_allowlist(root, path) for root in scope)

def declared_check_cwds_are_within_task_scope(task) -> bool:
    """Return whether declared checks are authorized by task scope alone."""
    return _is_task_shape(task) and all(
        _path_is_in_scope(required_check["cwd"], task.get("scope"))
        for required_check in task.get("required_checks", [])
    )


def _entry_is_in_scope(entry, scope) -> bool:
    if not scope or not isinstance(entry, dict):
        return True
    scoped_keys = (
        ("subject_path",)
        if entry.get("kind") == "content_lines_truncated"
        else ("path", "subject_path")
    )
    for key in scoped_keys:
        if entry.get(key) and not _path_is_in_scope(entry[key], scope):
            return False
    for side in entry.get("sides") or []:
        if (
            isinstance(side, dict)
            and side.get("path")
            and not _path_is_in_scope(side["path"], scope)
        ):
            return False
    return True


def _scope_conflicts(conflicts, scope):
    scoped = []
    omissions = []
    for conflict in conflicts:
        if _entry_is_in_scope(conflict, scope):
            scoped.append(conflict)
            continue
        for side in conflict.get("sides") or []:
            if (
                not isinstance(side, dict)
                or not side.get("path")
                or not _path_is_in_scope(side["path"], scope)
            ):
                continue
            omissions.append(
                {
                    "kind": "conflict_outside_scope",
                    "conflict": conflict.get("id"),
                    "subject": side.get("checkout"),
                    "subject_path": side["path"],
                    "reason": "one or more conflict sides are outside the declared scope",
                }
            )
    return scoped, omissions


def repair_topology_fingerprint(graph) -> str:
    """Commit the graph relationships that can drive context-repair proposals."""

    if not isinstance(graph, dict):
        raise ValueError("workspace graph must be a mapping")
    graph_nodes = graph.get("nodes", [])
    graph_edges = graph.get("edges", [])
    if not isinstance(graph_nodes, list) or not isinstance(graph_edges, list):
        raise ValueError("workspace graph topology must use node and edge lists")

    checkouts = []
    for node in graph_nodes:
        if not isinstance(node, dict):
            raise ValueError("workspace graph contains an invalid node")
        if node.get("kind") != "checkout":
            continue
        if not _nonempty_string(node.get("id")) or not _nonempty_string(
            node.get("path")
        ):
            raise ValueError(
                "checkout topology nodes require non-empty string IDs and paths"
            )
        checkouts.append({"id": node["id"], "path": node["path"]})
    checkouts.sort(key=lambda node: utf16_sort_key(node["id"]))

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
    repositories.sort(key=lambda node: utf16_sort_key(node["id"]))

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
            utf16_sort_key(relationship["checkout"]),
            utf16_sort_key(relationship["repository"]),
        )
    )
    return fingerprint(
        {
            "schema": "vivary.repair-topology/v0",
            "checkouts": checkouts,
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
        and _nonblank_string(required_check.get("name"))
        and _nonblank_string(required_check.get("command"))
        for required_check in value
    )

def _is_canonical_check_cwd(value) -> bool:
    return is_canonical_absolute_path(value)



def _is_declared_required_checks_shape(value) -> bool:
    if not (
        _is_required_checks_shape(value)
        and all(
            set(required_check) == {"name", "command", "cwd"}
            and _is_canonical_check_cwd(required_check["cwd"])
            for required_check in value
        )
    ):
        return False
    names = [required_check["name"] for required_check in value]
    return len(names) == len(set(names))


def is_git_checkout(node) -> bool:
    if not isinstance(node, dict) or node.get("kind") != "checkout":
        return False
    facts = node.get("facts")
    if not workspace_facts_are_valid(facts):
        return False
    repository_fact = facts.get("is_git_repository")
    return (
        isinstance(repository_fact, dict)
        and repository_fact.get("status") == "known"
        and repository_fact.get("value") is True
    )


def _is_task_shape(task) -> bool:
    if not (
        isinstance(task, dict)
        and _nonblank_string(task.get("question"))
        and set(task) <= {"question", "scope", "filters", "required_checks"}
    ):
        return False
    if "scope" in task and not (
        isinstance(task["scope"], list)
        and bool(task["scope"])
        and len(task["scope"]) <= MAX_TASK_SCOPE_ROOTS
        and all(
            is_canonical_absolute_path(root)
            for root in task["scope"]
        )
    ):
        return False
    if "filters" in task:
        if task["filters"] is None:
            return False
        try:
            validate_filters(task["filters"])
        except TypeError:
            return False
    if (
        "required_checks" in task
        and (
            not task["required_checks"]
            or not _is_declared_required_checks_shape(task["required_checks"])
        )
    ):
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


def _claim_id(claim) -> str:
    return deterministic_id(
        "claim",
        {
            "subject": claim.get("subject"),
            "fact": claim.get("fact"),
            "claim": claim.get("claim"),
        },
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
    if claim.get("status") != "known":
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
    if claim["id"] != _claim_id(claim):
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


def _is_omission_shape(omission) -> bool:
    if not isinstance(omission, dict):
        return False
    kind = omission.get("kind")
    if not _nonblank_string(kind) or not _nonblank_string(
        omission.get("reason")
    ):
        return False
    if kind == "claims_over_budget":
        required_keys = {"kind", "reason", "omitted_count", "omitted"}
        allowed_keys = required_keys | {"truncated"}
        if set(omission) not in (required_keys, allowed_keys):
            return False
        omitted = omission["omitted"]
        omitted_count = omission["omitted_count"]
        return (
            type(omitted_count) is int
            and omitted_count > 0
            and isinstance(omitted, list)
            and len(omitted) <= OMITTED_LIST_CAP
            and len(omitted) == min(omitted_count, OMITTED_LIST_CAP)
            and all(
                set(entry) == {"subject_path", "fact", "tier"}
                and all(
                    _nonempty_string(entry.get(field))
                    for field in ("subject_path", "fact", "tier")
                )
                and entry["tier"] in TIER_NAMES
                for entry in omitted
            )
            and (
                omission.get("truncated") is True
                if omitted_count > OMITTED_LIST_CAP
                else "truncated" not in omission
            )
        )
    expected_keys = _OMISSION_EXACT_KEYS.get(kind)
    if expected_keys is None or set(omission) != expected_keys:
        return False
    if "omitted_count" in omission and (
        type(omission["omitted_count"]) is not int
        or omission["omitted_count"] <= 0
    ):
        return False
    if kind == "filtered_out":
        filters = omission["filters"]
        if not (
            isinstance(filters, list)
            and bool(filters)
            and all(
                isinstance(task_filter, dict)
                and task_filter.get("field") in FILTER_FIELDS
                and len(task_filter) == 2
                and sum(
                    operator in task_filter
                    for operator in ("equals", "includes")
                )
                == 1
                and _nonempty_string(
                    task_filter.get("equals", task_filter.get("includes"))
                )
                for task_filter in filters
            )
        ):
            return False
    if kind == "content_files_truncated" and (
        type(omission["total_files_matched"]) is not int
        or omission["total_files_matched"] < omission["omitted_count"]
    ):
        return False
    if kind == "privacy_matches_excluded" and not isinstance(
        omission["evidence"], dict
    ):
        return False
    for field in (
        "path",
        "subject",
        "subject_path",
        "fact",
        "conflict",
        "repository",
    ):
        if field in omission and not _nonempty_string(omission[field]):
            return False
    return True


def _selection_signal_is_valid(signal, terms, content_terms, claim) -> bool:
    signal_kind = signal.get("signal")
    if signal_kind == "conflict_side":
        return set(signal) == {"signal", "conflict"} and _nonempty_string(
            signal.get("conflict")
        )
    if signal_kind == "question_term_match":
        term = signal.get("term")
        field = signal.get("field")
        return (
            set(signal) == {"signal", "term", "field"}
            and isinstance(term, str)
            and term in terms
            and isinstance(field, str)
            and field in {"label", "repository", "branch"}
        )
    if signal_kind == "content_term_match":
        term = signal.get("term")
        path = signal.get("path")
        return (
            set(signal) == {"signal", "term", "path"}
            and isinstance(term, str)
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


def _selection_omissions(selection, max_claims):
    omissions = []
    filtered_out = selection["filtered_out"]
    if filtered_out is not None:
        omissions.append(
            {
                "kind": "filtered_out",
                "reason": "structured task filters excluded candidate claims",
                **filtered_out,
            }
        )
    over_budget = selection["over_budget"]
    if over_budget is not None:
        omissions.append(
            {
                "kind": "claims_over_budget",
                "reason": (
                    f"claim budget {max_claims} reached; cuts ranked by relevance "
                    "tier, weakest evidence first"
                ),
                **over_budget,
            }
        )
    return omissions


def _refusal_omissions(graph, task_scope):
    omissions = []
    for refusal in graph.get("refusals") or []:
        path = refusal.get("path")
        if task_scope and not any(
            is_within_allowlist(root, path) for root in task_scope
        ):
            continue
        omissions.append(
            {
                "kind": "refused_root",
                "reason": refusal.get("reason"),
                "path": path,
            }
        )
    return omissions


def capsule_context_matches_graph(capsule, graph, content=None) -> bool:
    """Bind compiler-owned capsule context to verifier-supplied source artifacts."""

    workspace = capsule.get("workspace")
    if not isinstance(workspace, dict):
        return False
    if content_context_is_present(content) and not content_context_is_valid(
        content
    ):
        return False
    claimed_content_fingerprint = workspace.get("content_fingerprint")
    if claimed_content_fingerprint is not None:
        if not content_context_is_present(content):
            return False
        try:
            if fingerprint(content) != claimed_content_fingerprint:
                return False
            expected = compile_task_capsule(
                task=capsule["task"],
                graph=graph,
                budget=capsule["budget"],
                content=content,
            )
            return canonicalize(capsule) == canonicalize(expected)
        except (CapsuleRankingWorkLimitError, CapsuleContentWorkLimitError):
            raise
        except (AttributeError, KeyError, TypeError, ValueError):
            return False
    if _capsule_has_content_derived_artifacts(capsule):
        return False
    if content_context_is_present(content):
        return False

    try:
        expected = compile_task_capsule(
            task=capsule["task"],
            graph=graph,
            budget=capsule["budget"],
        )
        return canonicalize(capsule) == canonicalize(expected)
    except (CapsuleRankingWorkLimitError, CapsuleContentWorkLimitError):
        raise
    except (AttributeError, KeyError, TypeError, ValueError):
        return False




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


def _is_capsule_workspace_shape(workspace) -> bool:
    return (
        isinstance(workspace, dict)
        and _nonempty_string(workspace.get("fingerprint"))
        and (
            "content_fingerprint" not in workspace
            or _nonempty_string(workspace["content_fingerprint"])
        )
    )


def is_task_capsule_shape(capsule) -> bool:
    """Return whether a value has the complete policy-facing Task Capsule shape."""

    if not (
        isinstance(capsule, dict)
        and set(capsule) == TASK_CAPSULE_FIELDS
        and capsule.get("schema") == CAPSULE_SCHEMA
        and _is_task_shape(capsule.get("task"))
        and isinstance(capsule.get("capsule_id"), str)
        and bool(capsule["capsule_id"])
        and isinstance(capsule.get("fingerprint"), str)
        and bool(capsule["fingerprint"])
        and _is_capsule_workspace_shape(capsule.get("workspace"))
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

    declared_checks = capsule["task"].get("required_checks")
    if declared_checks is not None and any(
        not any(
            all(
                required_check.get(field) == declared_check[field]
                for field in ("name", "command", "cwd")
            )
            for required_check in capsule["required_checks"]
        )
        for declared_check in declared_checks
    ):
        return False

    if (
        "content_fingerprint" not in capsule["workspace"]
        and _capsule_has_content_derived_artifacts(capsule)
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
            _is_omission_shape(omission)
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
        key = (path_identity_key(cwd), command)
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
                    "resolution": "pass task.required_checks with this checkout's cwd to state the command explicitly",
                    "evidence": [marker_evidence] if marker_evidence else [],
                }
            )
    return checks, unknowns


def _declared_check_cwds_match_checkouts(declared_checks, checkouts, scope):
    observed_roots = []
    for node in checkouts:
        node_path = node.get("path")
        execution_root = _fact_value(node, "worktree_root") or node_path
        if _nonempty_string(node_path) and _nonempty_string(execution_root):
            observed_roots.append((node_path, execution_root))
    execution_roots = {
        path_identity_key(execution_root)
        for node_path, execution_root in observed_roots
        if not scope
        or any(
            is_within_allowlist(scope_root, node_path)
            for scope_root in scope
        )
    }
    if scope:
        for scope_root in scope:
            nearest_root = None
            for _, execution_root in observed_roots:
                if (
                    is_within_allowlist(execution_root, scope_root)
                    and (
                        nearest_root is None
                        or len(execution_root) > len(nearest_root)
                    )
                ):
                    nearest_root = execution_root
            if nearest_root is not None:
                execution_roots.add(path_identity_key(nearest_root))
    return all(
        path_identity_key(check["cwd"]) in execution_roots
        for check in declared_checks
    )



def _merge_declared_required_checks(derived_checks, declared_checks):
    """Add explicit checks without allowing them to rewrite observed commands."""
    merged = list(derived_checks)
    by_name = {check["name"]: check for check in derived_checks}
    resolving_cwds = set()
    for declared in declared_checks:
        existing = by_name.get(declared["name"])
        if existing is not None:
            if (
                existing["command"] != declared["command"]
                or path_identity_key(existing.get("cwd"))
                != path_identity_key(declared["cwd"])
            ):
                return None
            continue
        explicit = dict(declared)
        merged.append(explicit)
        by_name[explicit["name"]] = explicit
        resolving_cwds.add(path_identity_key(explicit["cwd"]))
    return merged, resolving_cwds


def _unresolved_check_unknowns(unknowns, checkouts, resolving_cwds):
    if not resolving_cwds:
        return list(unknowns)
    resolved_subjects = {
        node.get("id")
        for node in checkouts
        if path_identity_key(
            _fact_value(node, "worktree_root") or node.get("path")
        )
        in resolving_cwds
    }
    return [
        unknown for unknown in unknowns
        if unknown.get("subject") not in resolved_subjects
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


def _graph_claim_candidates(checkouts, truncation_omissions):
    candidates = []
    for checkout in checkouts:
        claims = [
            _fact_claim(checkout, "head_revision", lambda sha: f"HEAD revision is {sha}"),
            _fact_claim(checkout, "head_ref", _describe_ref),
            _fact_claim(
                checkout,
                "is_dirty",
                lambda dirty: (
                    "worktree has uncommitted changes"
                    if dirty
                    else "worktree is clean"
                ),
            ),
            _dirty_entries_claim(checkout, truncation_omissions),
            _fact_claim(
                checkout,
                "remotes",
                lambda remotes: (
                    "no remotes are configured"
                    if len(remotes) == 0
                    else "remotes: "
                    + ", ".join(
                        f"{remote.get('name')} -> "
                        f"{remote.get('fetch_url') if remote.get('fetch_url') is not None else '?'}"
                        for remote in remotes
                    )
                ),
            ),
            _fact_claim(
                checkout,
                "last_fetch",
                lambda at: f"last recorded fetch at {at}",
            ),
        ]
        candidates.extend(claim for claim in claims if claim is not None)
    return candidates


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


def _observed_content_privacy_fingerprint(node):
    fact = (node.get("facts") or {}).get(
        "content_privacy_fingerprint"
    )
    if fact is None or fact.get("status") != "known":
        return None
    return fact.get("value")


def _content_is_bound_to(node, checkout_content):
    """Whether content and its privacy policy match the graph snapshot."""
    observed = _observed_head(node)
    searched = checkout_content.get("head_revision")
    observed_privacy = _observed_content_privacy_fingerprint(node)
    searched_privacy = checkout_content.get("privacy_fingerprint")
    return (
        bool(observed)
        and bool(searched)
        and observed == searched
        and bool(observed_privacy)
        and observed_privacy == searched_privacy
    )


def _is_safe_content_match_path(path) -> bool:
    return is_safe_checkout_relative_path(path)


def _content_match_candidates(
    content, checkouts_by_path, task_terms, work_limit
):
    if not content or not isinstance(content.get("checkouts"), list):
        return [], []
    candidates = []
    excluded_count = 0
    work = 0
    for checkout_content in content["checkouts"]:
        work += 1
        if work > work_limit:
            raise CapsuleContentWorkLimitError(
                "content candidate work exceeds the compiler limit"
            )
        node = checkouts_by_path.get(path_identity_key(checkout_content.get("path")))
        if node is None:
            continue
        if not _content_is_bound_to(node, checkout_content):
            continue
        for match in sorted(
            checkout_content.get("matches") or [],
            key=lambda item: (
                utf16_sort_key(item["path"]),
                item["line"],
                utf16_sort_key(item["term"]),
            ),
        ):
            work += 1
            if work > work_limit:
                raise CapsuleContentWorkLimitError(
                    "content candidate work exceeds the compiler limit"
                )
            if not _is_safe_content_match_path(match.get("path")):
                excluded_count += 1
                continue
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
        return (1, utf16_sort_key(value))


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
            or len(declared_scope) > MAX_TASK_SCOPE_ROOTS
            or any(
                not is_canonical_absolute_path(root)
                for root in declared_scope
            )
        )
    ):
        raise ValueError(
            "task.scope must be a non-empty list of absolute roots"
        )
    if "filters" in task:
        try:
            validate_filters(task["filters"])
        except TypeError as error:
            raise ValueError(f"task.filters is invalid: {error}") from None
    declared_checks = task.get("required_checks")
    if declared_checks is not None and (
        not declared_checks or not _is_declared_required_checks_shape(declared_checks)
    ):
        raise ValueError(
            "task.required_checks must be a nonempty list of normalized {name, command, cwd} records"
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
    if not content_context_work_is_bounded(content):
        raise CapsuleContentWorkLimitError(
            "content candidate work exceeds the compiler limit"
        )
    if not content_context_is_valid(content):
        raise ValueError(
            "content must be a complete vivary.workspace-content/v0 artifact"
        )
    if not _content_scope_work_is_bounded(content, declared_scope):
        raise CapsuleContentWorkLimitError(
            "content scope work exceeds the compiler limit"
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
        if not workspace_facts_are_valid(facts):
            raise ValueError("workspace graph contains an invalid fact status")
        if is_git_checkout(node):
            checkouts.append(node)
    scoped_conflicts, scope_conflict_omissions = _scope_conflicts(
        graph["conflicts"], declared_scope
    )
    all_checkouts = list(checkouts)
    if declared_scope:
        checkouts = [
            node
            for node in checkouts
            if _path_is_in_scope(node.get("path"), declared_scope)
        ]
    if len(checkouts) > MAX_GRAPH_CONTEXT_CHECKOUTS:
        raise ValueError(
            "workspace graph contains too many Git checkouts in task scope"
        )
    checkouts_by_path = {
        path_identity_key(node.get("path")): node for node in checkouts
    }

    truncation_omissions: list[dict] = []
    candidates = _graph_claim_candidates(checkouts, truncation_omissions)
    if len(candidates) > MAX_CAPSULE_CANDIDATE_WORK:
        raise ValueError("graph candidate work exceeds the compiler limit")
    content_candidates, content_candidate_omissions = _content_match_candidates(
        content,
        checkouts_by_path,
        _content_question_terms(task["question"]),
        MAX_CAPSULE_CANDIDATE_WORK - len(candidates),
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
    selected = selection["included"]
    included = []
    for claim in selected:
        entry = {"id": _claim_id(claim)}
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
    omissions.extend(_selection_omissions(selection, max_claims))
    omissions.extend(_refusal_omissions(graph, declared_scope))
    scoped_checkouts = [
        checkout
        for checkout in checkouts
        if _path_is_in_scope(checkout.get("path"), declared_scope)
    ]
    required_checks, check_unknowns = _derive_required_checks(scoped_checkouts)
    if declared_checks is not None:
        if not _declared_check_cwds_match_checkouts(
            declared_checks, all_checkouts, declared_scope
        ):
            raise ValueError(
                "task.required_checks cwd must name a Git checkout execution root related to task.scope"
            )
        merged = _merge_declared_required_checks(required_checks, declared_checks)
        if merged is None:
            raise ValueError(
                "task.required_checks cannot rewrite an observed check command or cwd"
            )
        required_checks, resolving_cwds = merged
        check_unknowns = _unresolved_check_unknowns(
            check_unknowns, scoped_checkouts, resolving_cwds
        )

    content_unknowns: list[dict] = []
    for checkout_content in (content.get("checkouts") if content else None) or []:
        node = checkouts_by_path.get(path_identity_key(checkout_content.get("path")))
        if node is not None and _content_is_bound_to(node, checkout_content):
            for content_omission in checkout_content.get("omissions") or []:
                try:
                    entry = dict(content_omission)
                except (TypeError, ValueError):
                    raise ValueError(
                        "content contains a malformed omission"
                    ) from None
                entry["subject"] = node.get("id")
                entry["subject_path"] = checkout_content.get("path")
                if not _is_omission_shape(entry):
                    raise ValueError("content contains a malformed omission")
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
            and checkout_content.get("status") == "observed"
            and content.get("terms")
            and not _content_is_bound_to(node, checkout_content)
        ):
            content_unknowns.append(
                {
                    "kind": "content_snapshot_stale",
                    "subject": node.get("id"),
                    "subject_path": checkout_content.get("path"),
                    "reason": (
                        "content was observed at a different revision or under a "
                        "different effective privacy policy than the graph describes"
                    ),
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
    if declared_scope is not None:
        task_out["scope"] = list(declared_scope)
    if "filters" in task and task.get("filters") is not None:
        task_out["filters"] = task["filters"]
    if declared_checks is not None:
        task_out["required_checks"] = list(declared_checks)

    scoped_omissions = [
        omission
        for omission in omissions
        if _entry_is_in_scope(omission, declared_scope)
    ]
    if not all(
        _is_omission_shape(omission)
        for omission in scoped_omissions
    ):
        raise ValueError("compiled capsule omission is malformed")

    workspace = {
        "fingerprint": graph.get("workspace_fingerprint"),
        "observed_at": graph.get("observed_at"),
        "repair_topology_fingerprint": repair_topology_fingerprint(graph),
    }
    if content_context_is_present(content):
        workspace["content_fingerprint"] = fingerprint(content)

    body = {
        "schema": CAPSULE_SCHEMA,
        "task": task_out,
        "workspace": workspace,
        "claims": included,
        "conflicts": conflicts,
        "unknowns": [
            *[
                unknown
                for unknown in graph["unknowns"]
                if _entry_is_in_scope(unknown, declared_scope)
            ],
            *[
                unknown
                for unknown in content_unknowns
                if _entry_is_in_scope(unknown, declared_scope)
            ],
            *[
                unknown
                for unknown in check_unknowns
                if _entry_is_in_scope(unknown, declared_scope)
            ],
        ],
        "omissions": scoped_omissions,
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
