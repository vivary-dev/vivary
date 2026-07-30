#!/usr/bin/env python3
"""ozone - the review layer.

Where `tropo` answers "is each document valid?", `ozone` reviews the *whole graph*:
the relationship-level gaps a per-document check cannot see (a change with nothing
verifying it), and the **blast radius** of a node (everything that depends on it).
It reads tropo's typed graph in-process — never a second copy of the graph code —
so a review is graph-aware by construction.

This is the deterministic core: topology-derived findings only, zero dependencies,
no LLM. Semantic ("organize by meaning") review is graphify's job, layered on top of
tropo's clean graph — not here.

Usage:
  ozone [review] [--root DIR] [--pack NAME] [--json] [--strict]
                                                        # findings over the graph
  ozone impact <id> [--root DIR] [--json]            # what depends on <id>
  ozone packs [--json]                               # list rule packs
  ozone verify <request.json> --governed [--json] [--strict]
                                                        # receipt/gate verification

Exit codes: 0 clean or advisory · 1 when --strict finds warnings or insufficient
evidence · 2 for a refused governed request or invalid request document.
"""
import argparse
import datetime
import importlib.util
import json
import math
import os
import platform
import sys
import time

__version__ = "0.3.0"
RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
RECEIPT_SCHEMA = "vivary.run_receipt.v1"
REQUEST_SCHEMA = "vivary.ozone-verification-request/v0"
VERIFICATION_SCHEMA = "vivary.ozone-verification/v0"
REFUSAL_SCHEMA = "vivary.ozone-verification-refusal/v0"
MAX_EVIDENCE_AGE_SECONDS = 300
MAX_REPAIR_IDENTIFIER_JSON_BYTES = 128
CAPSULE_FIELDS = frozenset(
    {
        "schema",
        "capsule_id",
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
RECEIPT_FIELDS = frozenset(
    {
        "schema",
        "receipt_id",
        "capsule",
        "workspace",
        "runtime",
        "checks",
        "claims_in_scope",
        "claims_verified",
        "claims_unverified",
        "unresolved_conflicts",
        "unresolved_unknowns",
        "provenance",
        "created_at",
        "fingerprint",
    }
)
COMMANDS = ("review", "impact", "packs", "verify")
RECEIPT_VALUE_FLAGS = {"--pack", "--receipt", "--root"}
RECEIPT_KNOWN_FLAGS = RECEIPT_VALUE_FLAGS | {
    "--governed", "--help", "--json", "--strict", "--version", "-h",
}
RECEIPT_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# Review role = the workspace folder a node lives in (folder-as-type), independent of
# the resolved type *name* (e.g. a change may resolve to type `implementation_slice`,
# but it lives under changes/). Keyed on the top-level path segment.
ROLE_FOLDERS = {
    "modules": "module",
    "changes": "change",
    "decisions": "decision",
    "verification": "verification",
    "gates": "gate",
}
EDITORIAL_ROLE_FOLDERS = {
    "drafts": "draft",
    "manuscripts": "manuscript",
    "reviews": "review",
    "editorial-reviews": "review",
    "edits": "edit",
    "revisions": "edit",
    "outlines": "structure",
    "structures": "structure",
    "beats": "structure",
}
EDITORIAL_REVIEW_FIELDS = {
    "review", "reviews", "editorial_review", "editorial_reviews", "critique", "critiques",
}
EDITORIAL_EDIT_FIELDS = {
    "edit", "edits", "revision", "revisions", "copyedit", "copyedits",
}
EDITORIAL_STRUCTURE_FIELDS = {
    "outline", "outlines", "structure", "structures", "beat_sheet", "beats", "brief", "briefs",
}
EDITORIAL_SUBJECT_FIELDS = {
    "draft", "drafts", "manuscript", "manuscripts", "work", "target", "targets",
}

ROOT_SURFACE_THRESHOLDS = {
    "AGENTS.md": (160, 10000),
    "CLAUDE.md": (160, 10000),
    "STRATO.md": (160, 10000),
    "SOUL.md": (160, 10000),
    "STATE.md": (80, 4000),
    "README.md": (250, 15000),
}
MODULE_INDEX_THRESHOLD = (120, 8000)
BULK_LOAD_VERBS = ("read", "load", "scan", "open")
BULK_LOAD_TARGETS = (
    "whole repo", "entire repo", "full repo", "whole repository", "entire repository",
    "entire docs", "whole docs", "full docs", "docs tree", "docs folder",
    "whole folder", "entire folder", "all files", "everything",
)
BULK_LOAD_NEGATIONS = ("do not", "don't", "dont", "never", "avoid")


def _load_core_verification():
    """Load the governed core only when the opt-in verify surface is used."""
    package_root = os.path.dirname(os.path.abspath(__file__))
    sibling_core = os.path.join(os.path.dirname(package_root), "core")
    if (
        os.path.isdir(os.path.join(sibling_core, "vivary_core"))
        and sibling_core not in sys.path
    ):
        sys.path.insert(0, sibling_core)
    from vivary_core.capsule_compile import (
        is_task_capsule_shape,
        repair_topology_fingerprint,
        verify_task_capsule_integrity,
    )
    from vivary_core.capsule_select import OMITTED_LIST_CAP
    from vivary_core.canonical import (
        MAX_LOSSLESS_INTEGER,
        _utf16_sort_key,
        is_canonical_body_value,
        is_within_allowlist,
    )
    from vivary_core.collation import CollationDomainError, locale_sort_key
    from vivary_core.verify_receipt import verify_receipt_integrity
    from vivary_core.receipt import RECEIPT_SCHEMA as EXECUTION_RECEIPT_SCHEMA
    from vivary_core.verify_repair import (
        AVG_OMITTED_CLAIM_TOKENS,
        MAX_DEDUPE_CHECKOUTS,
        propose_context_repairs,
    )
    from vivary_core.verify_sufficiency import evaluate_gate_sufficiency

    return {
        "is_task_capsule_shape": is_task_capsule_shape,
        "verify_task_capsule_integrity": verify_task_capsule_integrity,
        "OMITTED_LIST_CAP": OMITTED_LIST_CAP,
        "verify_receipt_integrity": verify_receipt_integrity,
        "EXECUTION_RECEIPT_SCHEMA": EXECUTION_RECEIPT_SCHEMA,
        "propose_context_repairs": propose_context_repairs,
        "evaluate_gate_sufficiency": evaluate_gate_sufficiency,
        "CollationDomainError": CollationDomainError,
        "_utf16_sort_key": _utf16_sort_key,
        "is_canonical_body_value": is_canonical_body_value,
        "is_within_allowlist": is_within_allowlist,
        "repair_topology_fingerprint": repair_topology_fingerprint,
        "MAX_DEDUPE_CHECKOUTS": MAX_DEDUPE_CHECKOUTS,
        "AVG_OMITTED_CLAIM_TOKENS": AVG_OMITTED_CLAIM_TOKENS,
        "MAX_LOSSLESS_INTEGER": MAX_LOSSLESS_INTEGER,
        "locale_sort_key": locale_sort_key,
    }


def _nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def _bounded_repair_identifier(value):
    if not _nonempty_string(value):
        return False
    encoded_length = 2
    for character in value:
        codepoint = ord(character)
        if character in {'"', "\\"}:
            encoded_length += 2
        elif codepoint < 0x20:
            encoded_length += 6
        elif codepoint <= 0x7F:
            encoded_length += 1
        elif codepoint <= 0xFFFF:
            encoded_length += 6
        else:
            encoded_length += 12
        if encoded_length > MAX_REPAIR_IDENTIFIER_JSON_BYTES:
            return False
    return True


def _is_finite_number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _gate_constraints_are_valid(gate):
    required_checks = gate.get("required_checks")
    if required_checks is not None and (
        not isinstance(required_checks, list)
        or not all(isinstance(name, str) for name in required_checks)
    ):
        return False
    if gate.get("require_claims_verified") is not None and not isinstance(
        gate["require_claims_verified"], bool
    ):
        return False
    return all(
        gate.get(field) is None or _is_finite_number(gate[field])
        for field in ("max_unresolved_conflicts", "max_unresolved_unknowns")
    )


def _parse_instant(value):
    if not _nonempty_string(value):
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        instant = datetime.datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return instant if instant.tzinfo is not None else None


def _receipt_shape_is_valid(receipt, capsule, expected_schema):
    if (
        not isinstance(receipt, dict)
        or not RECEIPT_FIELDS <= set(receipt)
        or receipt.get("schema") != expected_schema
        or not _nonempty_string(receipt.get("receipt_id"))
        or not _nonempty_string(receipt.get("fingerprint"))
    ):
        return False

    receipt_capsule = receipt.get("capsule")
    receipt_workspace = receipt.get("workspace")
    runtime = receipt.get("runtime")
    checks = receipt.get("checks")
    claim_lists = [
        receipt.get("claims_in_scope"),
        receipt.get("claims_verified"),
        receipt.get("claims_unverified"),
    ]
    if not (
        isinstance(receipt_capsule, dict)
        and set(receipt_capsule) == {"id", "fingerprint"}
        and all(_nonempty_string(value) for value in receipt_capsule.values())
        and isinstance(receipt_workspace, dict)
        and set(receipt_workspace) == {"fingerprint", "observed_at"}
        and _nonempty_string(receipt_workspace.get("fingerprint"))
        and _parse_instant(receipt_workspace.get("observed_at")) is not None
        and isinstance(runtime, dict)
        and _nonempty_string(runtime.get("actor"))
        and all(
            field not in runtime or _nonempty_string(runtime[field])
            for field in ("harness", "model")
        )
        and isinstance(checks, list)
        and all(
            isinstance(check, dict)
            and isinstance(check.get("outcome"), str)
            and check["outcome"] in {"passed", "failed", "skipped"}
            and _nonempty_string(check.get("name"))
            and _nonempty_string(check.get("command"))
            and (
                "detail" not in check or _nonempty_string(check["detail"])
            )
            for check in checks
        )
        and all(
            isinstance(values, list)
            and all(_nonempty_string(value) for value in values)
            and len(set(values)) == len(values)
            for values in claim_lists
        )
    ):
        return False

    claims_in_scope, claims_verified, claims_unverified = claim_lists
    if (
        set(claims_verified) & set(claims_unverified)
        or set(claims_verified) | set(claims_unverified) != set(claims_in_scope)
    ):
        return False

    unresolved_conflicts = receipt.get("unresolved_conflicts")
    unresolved_unknowns = receipt.get("unresolved_unknowns")
    provenance = receipt.get("provenance")
    if not (
        isinstance(unresolved_conflicts, list)
        and all(
            isinstance(conflict, dict)
            and set(conflict) == {"id", "decision"}
            and _nonempty_string(conflict.get("id"))
            and _nonempty_string(conflict.get("decision"))
            for conflict in unresolved_conflicts
        )
        and len({conflict["id"] for conflict in unresolved_conflicts})
        == len(unresolved_conflicts)
        and isinstance(unresolved_unknowns, list)
        and all(isinstance(unknown, dict) for unknown in unresolved_unknowns)
        and isinstance(provenance, list)
        and all(
            isinstance(entry, dict)
            and all(
                _nonempty_string(entry.get(field))
                for field in ("kind", "ref", "note")
            )
            for entry in provenance
        )
    ):
        return False

    if not isinstance(capsule, dict):
        return True
    required_commands = {}
    for required_check in capsule.get("required_checks", []):
        name = required_check["name"]
        command = required_check["command"]
        if name in required_commands and required_commands[name] != command:
            return False
        required_commands[name] = command
    if any(
        check["name"] in required_commands
        and check.get("command") != required_commands[check["name"]]
        for check in checks
    ):
        return False
    capsule_claim_ids = [claim["id"] for claim in capsule.get("claims", [])]
    capsule_conflicts = [
        {"id": conflict["id"], "decision": conflict["decision"]}
        for conflict in capsule.get("conflicts", [])
    ]
    return (
        receipt_capsule.get("id") == capsule.get("capsule_id")
        and receipt_capsule.get("fingerprint") == capsule.get("fingerprint")
        and receipt_workspace.get("fingerprint")
        == capsule.get("workspace", {}).get("fingerprint")
        and receipt_workspace.get("observed_at")
        == capsule.get("workspace", {}).get("observed_at")
        and claims_in_scope == capsule_claim_ids
        and unresolved_conflicts == capsule_conflicts
        and unresolved_unknowns == capsule.get("unknowns")
    )




def _repair_capsule_is_safe(capsule, core):
    task = capsule.get("task")
    declared_scope = task.get("scope") if isinstance(task, dict) else None
    if declared_scope is not None and (
        not isinstance(declared_scope, list)
        or not all(_nonempty_string(root) for root in declared_scope)
    ):
        return False
    workspace = capsule.get("workspace")
    if not (
        isinstance(workspace, dict)
        and _bounded_repair_identifier(
            workspace.get("repair_topology_fingerprint")
        )
    ):
        return False

    claims = capsule.get("claims")
    if not isinstance(claims, list):
        return False
    claim_semantics = set()
    for claim in claims:
        if not isinstance(claim, dict):
            return False
        if not _bounded_repair_identifier(
            claim.get("id")
        ) or not _bounded_repair_identifier(claim.get("fact")):
            return False
        if claim.get("subject") is not None and not isinstance(
            claim.get("subject"), str
        ):
            return False
        if claim.get("claim") is not None and not isinstance(
            claim.get("claim"), str
        ):
            return False
        selection = claim.get("selection")
        if selection is not None and not isinstance(selection, dict):
            return False
        if (
            isinstance(selection, dict)
            and selection.get("tier") is not None
            and not isinstance(selection.get("tier"), str)
        ):
            return False
        evidence = claim.get("evidence")
        if evidence is not None and not isinstance(evidence, list):
            return False
        semantics = (
            claim.get("subject"),
            claim.get("fact"),
            claim.get("claim"),
        )
        if semantics in claim_semantics:
            return False
        claim_semantics.add(semantics)

    omissions = capsule.get("omissions")
    if not isinstance(omissions, list):
        return False
    for omission in omissions:
        if not isinstance(omission, dict):
            return False
        if omission.get("kind") != "claims_over_budget":
            continue
        omitted_count = omission.get("omitted_count")
        if (
            not isinstance(omitted_count, int)
            or isinstance(omitted_count, bool)
            or omitted_count < 0
        ):
            return False
        omitted = omission.get("omitted")
        if not isinstance(omitted, list):
            return False
        if len(omitted) != min(omitted_count, core["OMITTED_LIST_CAP"]):
            return False
        if not all(
            isinstance(entry, dict)
            and _nonempty_string(entry.get("subject_path"))
            and _nonempty_string(entry.get("fact"))
            and _nonempty_string(entry.get("tier"))
            for entry in omitted
        ):
            return False
    return True


def _repair_graph_matches_capsule_conflicts(capsule, graph, core):
    capsule_conflicts = capsule.get("conflicts")
    if not isinstance(capsule_conflicts, list):
        return False

    expected = {}
    for conflict in capsule_conflicts:
        if not (
            isinstance(conflict, dict)
            and conflict.get("decision") == "review_required"
            and _bounded_repair_identifier(conflict.get("id"))
            and conflict["id"] not in expected
        ):
            return False
        graph_conflict = dict(conflict)
        del graph_conflict["decision"]
        expected[conflict["id"]] = graph_conflict

    declared_scope = capsule.get("task", {}).get("scope") or []
    checkout_paths = {
        node["id"]: node["path"]
        for node in graph["nodes"]
        if node["kind"] == "checkout"
    }

    def conflict_is_in_scope(conflict):
        if not declared_scope:
            return True
        return all(
            any(
                core["is_within_allowlist"](
                    root, checkout_paths.get(side.get("checkout"))
                )
                for root in declared_scope
            )
            for side in conflict.get("sides") or []
        )

    actual = {conflict["id"]: conflict for conflict in graph["conflicts"]}
    return all(
        actual.get(conflict_id) == conflict
        for conflict_id, conflict in expected.items()
    ) and all(
        conflict["id"] in expected or not conflict_is_in_scope(conflict)
        for conflict in graph["conflicts"]
    )


def _repair_graph_is_safe(graph, core):
    if not (
        isinstance(graph, dict)
        and graph.get("schema") == "vivary.workspace-graph/v0"
        and _nonempty_string(graph.get("workspace_fingerprint"))
        and isinstance(graph.get("nodes"), list)
        and isinstance(graph.get("edges"), list)
        and isinstance(graph.get("conflicts"), list)
    ):
        return False

    node_kinds = {}
    checkout_paths = {}
    for node in graph["nodes"]:
        if not (
            isinstance(node, dict)
            and _bounded_repair_identifier(node.get("id"))
            and _nonempty_string(node.get("kind"))
            and node["id"] not in node_kinds
        ):
            return False
        node_kinds[node["id"]] = node["kind"]
        if node["kind"] == "checkout":
            if not _nonempty_string(node.get("path")):
                return False
            checkout_paths[node["id"]] = node["path"]

    checkout_repositories = {}
    checkout_relations = set()
    repository_checkouts = {}
    for edge in graph["edges"]:
        if not isinstance(edge, dict):
            return False
        if edge.get("kind") == "checkout_of":
            checkout_id = edge.get("from")
            repository_id = edge.get("to")
            if not (
                _nonempty_string(checkout_id)
                and _nonempty_string(repository_id)
                and node_kinds.get(checkout_id) == "checkout"
                and node_kinds.get(repository_id) == "repository"
            ):
                return False
            try:
                core["locale_sort_key"](checkout_id)
                core["locale_sort_key"](repository_id)
            except core["CollationDomainError"]:
                return False
            if checkout_id in checkout_repositories:
                return False
            checkout_repositories[checkout_id] = repository_id
            repository_checkouts.setdefault(repository_id, set()).add(checkout_id)
            relation = (checkout_id, repository_id)
            if relation in checkout_relations:
                return False
            checkout_relations.add(relation)

    conflict_pair_count = 0
    conflict_ids = set()
    for conflict in graph["conflicts"]:
        if not isinstance(conflict, dict):
            return False
        repository_id = conflict.get("repository")
        sides = conflict.get("sides")
        if not (
            _bounded_repair_identifier(conflict.get("id"))
            and conflict["id"] not in conflict_ids
            and conflict.get("kind") == "divergent_checkouts"
            and _nonempty_string(repository_id)
            and node_kinds.get(repository_id) == "repository"
            and isinstance(sides, list)
            and all(
                isinstance(side, dict)
                and _nonempty_string(side.get("checkout"))
                and node_kinds.get(side["checkout"]) == "checkout"
                and _nonempty_string(side.get("path"))
                and side["path"] == checkout_paths.get(side["checkout"])
                and (side["checkout"], repository_id) in checkout_relations
                for side in sides
            )
        ):
            return False
        conflict_ids.add(conflict["id"])
        checkout_ids = [side["checkout"] for side in sides]
        checkout_id_set = set(checkout_ids)
        if (
            len(checkout_id_set) != len(checkout_ids)
            or len(checkout_ids) < 2
            or checkout_id_set != repository_checkouts.get(repository_id, set())
        ):
            return False
        conflict_pair_count += len(checkout_ids) * (len(checkout_ids) - 1) // 2
        max_checkouts = core["MAX_DEDUPE_CHECKOUTS"]
        if conflict_pair_count > max_checkouts * (max_checkouts - 1) // 2:
            return False
    return True


def _repair_graph_topology_is_bound(capsule, graph, core):
    return (
        capsule["workspace"]["repair_topology_fingerprint"]
        == core["repair_topology_fingerprint"](graph)
    )


def _repair_estimates_are_canonical(capsule, core):
    max_omitted_count = (
        core["MAX_LOSSLESS_INTEGER"] // core["AVG_OMITTED_CLAIM_TOKENS"]
    )
    return all(
        omission.get("kind") != "claims_over_budget"
        or omission["omitted_count"] <= max_omitted_count
        for omission in capsule["omissions"]
    )


def _repair_work_is_bounded(capsule, graph, core):
    max_checkouts = core["MAX_DEDUPE_CHECKOUTS"]
    proposal_limit = max_checkouts * (max_checkouts - 1) // 2
    claims = capsule["claims"]
    proposal_upper_bound = sum(
        claim.get("selection", {}).get("tier") == "allowlisted"
        and len(claim.get("evidence") or []) == 0
        for claim in claims
        if isinstance(claim.get("selection"), dict)
    )
    over_budget = next(
        (
            omission
            for omission in capsule["omissions"]
            if omission.get("kind") == "claims_over_budget"
        ),
        None,
    )
    if over_budget is not None:
        proposal_upper_bound += 1
    if proposal_upper_bound > proposal_limit:
        return False

    claims_by_subject = {}
    for claim in claims:
        subject = claim.get("subject")
        claims_by_subject[subject] = claims_by_subject.get(subject, 0) + 1

    checkouts_by_repository = {}
    for edge in graph["edges"]:
        if edge.get("kind") != "checkout_of":
            continue
        checkouts_by_repository.setdefault(edge["to"], []).append(edge["from"])

    pair_scan_count = 0
    for checkouts in checkouts_by_repository.values():
        considered = sorted(checkouts, key=core["_utf16_sort_key"])[:max_checkouts]
        pair_scan_count += len(considered) * (len(considered) - 1) // 2
        if pair_scan_count > proposal_limit:
            return False
        claim_counts = sorted(
            claims_by_subject.get(checkout, 0) for checkout in considered
        )
        proposal_upper_bound += sum(
            claim_count * index
            for index, claim_count in enumerate(claim_counts)
        )
        if over_budget is not None and sum(
            claims_by_subject.get(checkout, 0) for checkout in checkouts
        ) >= 3:
            if len(checkouts) > max_checkouts:
                return False
            proposal_upper_bound += 1
        if proposal_upper_bound > proposal_limit:
            return False
    return True


def _validate_governed_request(request, core):
    if not core["is_canonical_body_value"](request):
        return ["invalid_json_value"]
    if not isinstance(request, dict):
        return ["unknown_request_shape"]

    errors = []
    allowed_fields = {
        "schema",
        "workspace",
        "verified_at",
        "capsule",
        "receipt",
        "gate",
        "graph",
    }
    unknown_fields = sorted(field for field in request if field not in allowed_fields)
    errors.extend(f"unknown_field:{field}" for field in unknown_fields)
    if request.get("schema") != REQUEST_SCHEMA:
        errors.append("invalid_schema")

    workspace = request.get("workspace")
    workspace_fingerprint = (
        workspace.get("fingerprint") if isinstance(workspace, dict) else None
    )
    if not (
        isinstance(workspace, dict)
        and set(workspace) == {"fingerprint"}
        and _nonempty_string(workspace_fingerprint)
    ):
        errors.append("invalid_workspace")

    verified_at = _parse_instant(request.get("verified_at"))
    if verified_at is None:
        errors.append("invalid_verified_at")

    unknown_capsule_fields = []
    capsule = request.get("capsule")
    if isinstance(capsule, dict):
        unknown_capsule_fields = sorted(set(capsule) - CAPSULE_FIELDS)
        errors.extend(
            f"unknown_capsule_field:{field}" for field in unknown_capsule_fields
        )
    capsule_is_valid_for_receipt = False
    capsule_shape_is_valid = core["is_task_capsule_shape"](capsule)
    if not capsule_shape_is_valid:
        errors.append("invalid_capsule")
    elif len({claim["id"] for claim in capsule["claims"]}) != len(
        capsule["claims"]
    ):
        errors.append("duplicate_claim_id")
    elif len(capsule["claims"]) > capsule["budget"]["max_claims"]:
        errors.append("capsule_claim_budget_exceeded")
    elif not core["verify_task_capsule_integrity"](capsule):
        errors.append("capsule_fingerprint_mismatch")
    elif _nonempty_string(workspace_fingerprint) and (
        capsule["workspace"]["fingerprint"] != workspace_fingerprint
    ):
        errors.append("workspace_mismatch")
    else:
        capsule_is_valid_for_receipt = not unknown_capsule_fields

    observed_at = _parse_instant(
        capsule.get("workspace", {}).get("observed_at")
        if isinstance(capsule, dict)
        and isinstance(capsule.get("workspace"), dict)
        else None
    )
    if observed_at is None:
        errors.append("invalid_capsule_observed_at")
    elif verified_at is not None:
        if observed_at > verified_at:
            errors.append("capsule_observed_after_verification")
        elif verified_at - observed_at > datetime.timedelta(
            seconds=MAX_EVIDENCE_AGE_SECONDS
        ):
            errors.append("stale_capsule")

    gate = request.get("gate")
    if not isinstance(gate, dict) or not _nonempty_string(gate.get("name")):
        errors.append("invalid_gate")
    else:
        allowed_gate_fields = {
            "name",
            "required_checks",
            "require_claims_verified",
            "max_unresolved_conflicts",
            "max_unresolved_unknowns",
        }
        unknown_gate_fields = sorted(
            field for field in gate if field not in allowed_gate_fields
        )
        errors.extend(
            f"unknown_gate_field:{field}" for field in unknown_gate_fields
        )
        if not _gate_constraints_are_valid(gate):
            errors.append("invalid_gate")

    receipt = request.get("receipt")
    if isinstance(receipt, dict):
        unknown_receipt_fields = sorted(set(receipt) - RECEIPT_FIELDS)
        errors.extend(
            f"unknown_receipt_field:{field}" for field in unknown_receipt_fields
        )
    if (
        "receipt" in request
        and capsule_is_valid_for_receipt
        and not _receipt_shape_is_valid(
            receipt, capsule, core["EXECUTION_RECEIPT_SCHEMA"]
        )
    ):
        errors.append("invalid_receipt")
    if isinstance(receipt, dict) and "created_at" in receipt:
        receipt_at = _parse_instant(receipt.get("created_at"))
        if receipt_at is None:
            errors.append("invalid_receipt_created_at")
        elif observed_at is not None and receipt_at < observed_at:
            errors.append("receipt_precedes_capsule")
        elif verified_at is not None and receipt_at > verified_at:
            errors.append("receipt_from_future")
        elif verified_at is not None and verified_at - receipt_at > datetime.timedelta(
            seconds=MAX_EVIDENCE_AGE_SECONDS
        ):
            errors.append("stale_receipt")

    if "graph" in request:
        repair_capsule_is_safe = capsule_shape_is_valid and _repair_capsule_is_safe(
            capsule, core
        )
        if not repair_capsule_is_safe:
            errors.append("invalid_repair_capsule")
        graph_is_safe = _repair_graph_is_safe(request["graph"], core)
        if not graph_is_safe:
            errors.append("invalid_repair_graph")
        elif request["graph"]["workspace_fingerprint"] != workspace_fingerprint:
            errors.append("repair_graph_workspace_mismatch")
        elif repair_capsule_is_safe and not _repair_graph_matches_capsule_conflicts(
            capsule, request["graph"], core
        ):
            errors.append("repair_graph_conflicts_mismatch")
        elif repair_capsule_is_safe and not _repair_estimates_are_canonical(
            capsule, core
        ):
            errors.append("repair_estimate_unbounded")
        elif repair_capsule_is_safe and not _repair_work_is_bounded(
            capsule, request["graph"], core
        ):
            errors.append("repair_work_unbounded")
        elif repair_capsule_is_safe and not _repair_graph_topology_is_bound(
            capsule, request["graph"], core
        ):
            errors.append("repair_graph_topology_unbound")

    return errors


def _verification_refusal(reason_codes):
    return {
        "schema": REFUSAL_SCHEMA,
        "outcome": "refused",
        "reason_codes": reason_codes,
        "receipt_verdict": None,
        "gate_verdict": None,
        "repair_proposal": None,
    }


def verify_governed(request):
    """Verify one governed capsule, receipt, and gate without performing writes."""
    try:
        core = _load_core_verification()
        errors = _validate_governed_request(request, core)
        if errors:
            return _verification_refusal(errors)

        capsule = request["capsule"]
        if "receipt" in request:
            receipt_verdict = core["verify_receipt_integrity"](
                receipt=request["receipt"], capsule=capsule
            )
            gate_verdict = core["evaluate_gate_sufficiency"](
                gate=request["gate"],
                capsule=capsule,
                receipt=request["receipt"],
            )
        else:
            receipt_verdict = core["verify_receipt_integrity"](capsule=capsule)
            gate_verdict = core["evaluate_gate_sufficiency"](
                gate=request["gate"], capsule=capsule
            )

        repair_proposal = (
            core["propose_context_repairs"](
                capsule=capsule,
                graph=request["graph"],
            )
            if "graph" in request
            else None
        )
        reason_codes = list(
            dict.fromkeys(
                [
                    *receipt_verdict.get("reason_codes", []),
                    *gate_verdict.get("reason_codes", []),
                ]
            )
        )
        if gate_verdict["outcome"] == "refused":
            outcome = "refused"
        elif receipt_verdict["outcome"] != "verified":
            outcome = "insufficient"
        else:
            outcome = gate_verdict["outcome"]
        return {
            "schema": VERIFICATION_SCHEMA,
            "workspace": request["workspace"],
            "verified_at": request["verified_at"],
            "outcome": outcome,
            "reason_codes": reason_codes,
            "receipt_verdict": receipt_verdict,
            "gate_verdict": gate_verdict,
            "repair_proposal": repair_proposal,
        }
    except RecursionError:
        return _verification_refusal(["request_too_deeply_nested"])


class OzoneError(Exception):
    pass


def _load_tropo():
    """Load the tropo engine in-process. Returns (module, tropo_dir).

    Prefers the in-repo sibling `../tropo/tropo.py` (so repo work uses the repo
    engine); when installed, falls back to the `vivary-tropo` dependency (`import
    tropo`)."""
    here = os.path.dirname(os.path.abspath(__file__))
    sibling = os.path.join(os.path.dirname(here), "tropo", "tropo.py")
    if os.path.isfile(sibling):
        spec = importlib.util.spec_from_file_location("ozone_tropo", sibling)
        if spec is None or spec.loader is None:
            raise OzoneError(f"could not load tropo engine: {sibling}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, os.path.dirname(sibling)
    try:
        import tropo as module
    except ImportError as e:
        raise OzoneError(f"tropo engine not found (install vivary-tropo): {e}")
    return module, os.path.dirname(os.path.abspath(module.__file__))


def build_workspace_graph(root):
    """Resolve the tropo graph for a workspace root. Returns (tropo, root, nodes, edges)."""
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise OzoneError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    nodes, edges = tropo.build_graph(docs)
    return tropo, resolver.root, nodes, edges


def role_of(node):
    parts = node["path"].split("/")
    return ROLE_FOLDERS.get(parts[0]) if len(parts) > 1 else None


def editorial_role_of(node):
    parts = node["path"].split("/")
    folder = parts[0] if len(parts) > 1 else ""
    return EDITORIAL_ROLE_FOLDERS.get(folder)


def structure_pack(nodes, edges):
    """The built-in deterministic review pack: completeness + topology findings over
    the Vivary graph vocabulary. Returns a list of finding dicts, sorted stably."""
    outfields, degree = {}, {}
    for e in edges:
        outfields.setdefault(e["from"], set()).add(e["field"])
        degree[e["from"]] = degree.get(e["from"], 0) + 1
        degree[e["to"]] = degree.get(e["to"], 0) + 1

    findings = []

    def add(sev, rule, nid, msg):
        n = nodes[nid]
        findings.append({"severity": sev, "rule": rule, "id": nid,
                         "type": n["type"], "path": n["path"], "message": msg})

    for nid in sorted(nodes):
        role = role_of(nodes[nid])
        fields = outfields.get(nid, set())
        if role == "change":
            if "verification" not in fields:
                add("warn", "change-unverified", nid,
                    f"change '{nid}' has no verification linked")
            if "gates" not in fields:
                add("info", "change-ungated", nid,
                    f"change '{nid}' has no gate linked")
        elif role == "module":
            if "verification" not in fields:
                add("info", "module-unverified", nid,
                    f"module '{nid}' has no verification linked")
        if degree.get(nid, 0) == 0:
            add("info", "orphan", nid,
                f"{role or 'node'} '{nid}' is disconnected (no edges in or out)")

    # Broken edges are surfaced here for the reviewer, but tropo `check` is the
    # enforcing authority (it fails on the same W220 condition) — no double-enforcement.
    for e in sorted(edges, key=lambda x: (x["from"], x["field"], x["to"])):
        if e.get("broken"):
            n = nodes.get(e["from"])
            findings.append({
                "severity": "warn", "rule": "broken-edge", "id": e["from"],
                "type": n["type"] if n else None, "path": n["path"] if n else None,
                "message": f"edge {e['from']} --{e['field']}--> {e['to']} is broken "
                           f"(target missing); tropo check enforces this"})
    return findings


def workspace_rel(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def estimate_tokens(text):
    return (len(text) + 3) // 4


def read_public_text(path):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def public_routing_surfaces(root):
    surfaces = []
    for name in sorted(ROOT_SURFACE_THRESHOLDS):
        path = os.path.join(root, name)
        if os.path.isfile(path):
            text = read_public_text(path)
            if text is not None:
                surfaces.append({
                    "path": name,
                    "text": text,
                    "threshold": ROOT_SURFACE_THRESHOLDS[name],
                    "kind": "root",
                })

    modules_dir = os.path.join(root, "modules")
    index_path = os.path.join(modules_dir, "index.md")
    if os.path.isfile(index_path):
        text = read_public_text(index_path)
        if text is not None:
            surfaces.append({
                "path": "modules/index.md",
                "text": text,
                "threshold": MODULE_INDEX_THRESHOLD,
                "kind": "module-index",
            })
    if os.path.isdir(modules_dir):
        for name in sorted(os.listdir(modules_dir)):
            index_path = os.path.join(modules_dir, name, "index.md")
            if os.path.isfile(index_path):
                text = read_public_text(index_path)
                if text is not None:
                    surfaces.append({
                        "path": workspace_rel(root, index_path),
                        "text": text,
                        "threshold": MODULE_INDEX_THRESHOLD,
                        "kind": "module-index",
                    })
    return surfaces


def bulk_load_cue(line):
    text = " ".join(line.lower().replace("-", " ").split())
    if any(neg in text for neg in BULK_LOAD_NEGATIONS):
        return False
    return any(verb in text for verb in BULK_LOAD_VERBS) and any(
        target in text for target in BULK_LOAD_TARGETS)


def normalized_routing_blocks(text):
    blocks = []
    for raw in text.split("\n\n"):
        normalized = " ".join(raw.split()).strip().lower()
        if len(normalized) > 100:
            blocks.append(normalized)
    return blocks


def context_budget_pack(root, nodes, edges):
    findings = []
    modules_dir = os.path.join(root, "modules")
    if os.path.isdir(modules_dir):
        for name in sorted(os.listdir(modules_dir)):
            child = os.path.join(modules_dir, name)
            if not os.path.isdir(child):
                continue
            index_path = os.path.join(child, "index.md")
            if not os.path.isfile(index_path):
                rel_child = workspace_rel(root, child)
                findings.append({
                    "severity": "warn",
                    "rule": "module-index-missing",
                    "path": workspace_rel(root, index_path),
                    "message": f"module directory '{rel_child}' is missing index.md",
                })
        for name in sorted(os.listdir(modules_dir)):
            child = os.path.join(modules_dir, name)
            if not os.path.isfile(child) or not name.endswith(".md") or name == "index.md":
                continue
            stem = name[:-3]
            index_path = os.path.join(modules_dir, stem, "index.md")
            if os.path.isfile(index_path):
                findings.append({
                    "severity": "warn",
                    "rule": "legacy-module-file",
                    "path": workspace_rel(root, child),
                    "message": f"legacy module file duplicates '{workspace_rel(root, index_path)}'",
                })
    surfaces = public_routing_surfaces(root)
    duplicate_blocks = {}
    for surface in surfaces:
        for block in normalized_routing_blocks(surface["text"]):
            duplicate_blocks.setdefault(block, [])
            if surface["path"] not in duplicate_blocks[block]:
                duplicate_blocks[block].append(surface["path"])

    for surface in surfaces:
        line_count = len(surface["text"].splitlines())
        char_count = len(surface["text"])
        max_lines, max_chars = surface["threshold"]
        if line_count > max_lines or char_count > max_chars:
            if surface["kind"] == "module-index":
                rule = "module-index-large"
            else:
                rule = "always-on-large"
            findings.append({
                "severity": "info",
                "rule": rule,
                "path": surface["path"],
                "estimated_tokens": estimate_tokens(surface["text"]),
                "message": f"{surface['path']} is {line_count} line(s), {char_count} char(s); "
                           f"keep routing surfaces under {max_lines} line(s) or "
                           f"{max_chars} char(s)",
            })
        for line_no, line in enumerate(surface["text"].splitlines(), start=1):
            if not bulk_load_cue(line):
                continue
            findings.append({
                "severity": "info",
                "rule": "bulk-load-cue",
                "path": surface["path"],
                "message": f"{surface['path']}:{line_no} encourages bulk-loading context; "
                           "route agents through targeted indexes instead",
            })
    for block in sorted(duplicate_blocks):
        paths = duplicate_blocks[block]
        if len(paths) < 2:
            continue
        findings.append({
            "severity": "info",
            "rule": "duplicate-routing-block",
            "path": paths[0],
            "message": f"routing block is repeated across {', '.join(paths)}; "
                       "keep durable truth in one owner and link to it",
        })
    return findings


def editorial_pack(nodes, edges):
    """Medium-specific review for writing workspaces.

    The pack stays graph-native and deterministic: it looks for review/edit/structure
    coverage between writing folders and stays silent for non-writing workspaces.
    """
    findings = []
    roles = {nid: editorial_role_of(node) for nid, node in nodes.items()}
    out_edges, in_edges = {}, {}
    for edge in edges:
        if edge.get("broken"):
            continue
        out_edges.setdefault(edge["from"], []).append(edge)
        in_edges.setdefault(edge["to"], []).append(edge)

    def add(sev, rule, nid, msg):
        node = nodes[nid]
        findings.append({
            "severity": sev,
            "rule": rule,
            "id": nid,
            "type": node["type"],
            "path": node["path"],
            "message": msg,
        })

    def outgoing_to_role(nid, fields, target_roles):
        return any(edge["field"] in fields and roles.get(edge["to"]) in target_roles
                   for edge in out_edges.get(nid, []))

    def incoming_from_role(nid, fields, source_roles):
        return any(edge["field"] in fields and roles.get(edge["from"]) in source_roles
                   for edge in in_edges.get(nid, []))

    for nid in sorted(nodes):
        role = roles.get(nid)
        if role in {"draft", "manuscript"}:
            label = f"{role} '{nid}'"
            has_review = (
                outgoing_to_role(nid, EDITORIAL_REVIEW_FIELDS, {"review"}) or
                incoming_from_role(nid, EDITORIAL_SUBJECT_FIELDS, {"review"})
            )
            has_edit = (
                outgoing_to_role(nid, EDITORIAL_EDIT_FIELDS, {"edit"}) or
                incoming_from_role(nid, EDITORIAL_SUBJECT_FIELDS, {"edit"})
            )
            has_structure = (
                outgoing_to_role(nid, EDITORIAL_STRUCTURE_FIELDS, {"structure"}) or
                incoming_from_role(nid, EDITORIAL_SUBJECT_FIELDS, {"structure"})
            )
            if not has_review:
                add("warn", "draft-unreviewed", nid, f"{label} has no review linked")
            if not has_edit:
                add("info", "draft-unedited", nid, f"{label} has no edit or revision linked")
            if not has_structure:
                add("info", "draft-structure-missing", nid,
                    f"{label} has no outline, beat sheet, or structure note linked")
        elif role == "review":
            linked_to_work = (
                outgoing_to_role(nid, EDITORIAL_SUBJECT_FIELDS, {"draft", "manuscript"}) or
                incoming_from_role(nid, EDITORIAL_REVIEW_FIELDS, {"draft", "manuscript"})
            )
            if not linked_to_work:
                add("warn", "review-unlinked", nid,
                    f"review '{nid}' is not linked to a draft or manuscript")
        elif role == "edit":
            linked_to_work = (
                outgoing_to_role(nid, EDITORIAL_SUBJECT_FIELDS | EDITORIAL_REVIEW_FIELDS,
                                 {"draft", "manuscript", "review"}) or
                incoming_from_role(nid, EDITORIAL_EDIT_FIELDS, {"draft", "manuscript", "review"})
            )
            if not linked_to_work:
                add("warn", "edit-unlinked", nid,
                    f"edit '{nid}' is not linked to a draft, manuscript, or review")
    return findings


PACKS = [
    {"name": "structure",
     "description": "deterministic completeness + topology review over the Vivary graph"},
    {"name": "context-budget",
     "description": "deterministic context-bloat review over public routing surfaces"},
    {"name": "editorial",
     "description": "deterministic editorial coverage review for writing workspaces"},
]


def selected_packs(name):
    if name == "all":
        return [p["name"] for p in PACKS]
    known = {p["name"] for p in PACKS}
    if name not in known:
        raise OzoneError(f"unknown review pack {name!r}")
    return [name]


def cmd_review(args):
    try:
        _tropo, root, nodes, edges = build_workspace_graph(args.root)
        packs = selected_packs(args.pack)
    except OzoneError as e:
        sys.exit(f"ozone: {e}")
    findings = []
    if "structure" in packs:
        findings.extend(structure_pack(nodes, edges))
    if "context-budget" in packs:
        findings.extend(context_budget_pack(root, nodes, edges))
    if "editorial" in packs:
        findings.extend(editorial_pack(nodes, edges))
    warns = [f for f in findings if f["severity"] == "warn"]
    notes = [f for f in findings if f["severity"] != "warn"]
    if args.json:
        print(json.dumps({"reviewed": len(nodes), "packs": packs, "warnings": len(warns),
                          "notes": len(notes), "findings": findings}, indent=2))
    else:
        for f in findings:
            loc = f["path"] or f["id"]
            print(f"{loc}: {f['severity']} {f['rule']}: {f['message']}")
        print(f"\nozone: reviewed {len(nodes)} node(s), "
              f"{len(warns)} warning(s), {len(notes)} note(s)")
    if getattr(args, "strict", False) and warns:
        return 1
    return 0


def cmd_impact(args):
    if not args.id:
        sys.exit("ozone: impact requires a node id (ozone impact <id>)")
    try:
        tropo, _root, nodes, edges = build_workspace_graph(args.root)
    except OzoneError as e:
        sys.exit(f"ozone: {e}")
    if args.id not in nodes:
        sys.exit(f"ozone: no node with id {args.id!r} (run `ozone review` or `tropo graph`)")
    impacted = tropo.blast_radius(edges, args.id)
    items = sorted(impacted.items(), key=lambda kv: (kv[1]["distance"], kv[0]))
    if args.json:
        print(json.dumps({
            "target": args.id, "impacted": len(items),
            "nodes": [{"id": nid, "distance": d["distance"], "via": d["via"],
                       "type": nodes.get(nid, {}).get("type")} for nid, d in items],
        }, indent=2))
    elif not items:
        print(f"ozone: nothing depends on '{args.id}' (no inbound edges)")
    else:
        print(f"ozone: impact of '{args.id}' — {len(items)} node(s) depend on it")
        for nid, d in items:
            t = nodes.get(nid, {}).get("type", "?")
            print(f"  {d['distance']}  {nid}  ({t}, via {d['via']})")
    return 0


def cmd_packs(args):
    if args.json:
        print(json.dumps({"packs": PACKS}, indent=2))
    else:
        for p in PACKS:
            print(f"{p['name']:12} {p['description']}")
    return 0


def _load_verification_request(path):
    if path == "-":
        return json.load(sys.stdin)
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def _emit_verification(result, json_output):
    if json_output:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return
    print(f"ozone verify: {result['outcome']}")
    if result["reason_codes"]:
        print(
            "reasons: "
            + ", ".join(
                json.dumps(reason, ensure_ascii=True)[1:-1]
                for reason in result["reason_codes"]
            )
        )


def cmd_verify(args):
    try:
        request = _load_verification_request(args.id)
    except RecursionError:
        result = _verification_refusal(["request_too_deeply_nested"])
        _emit_verification(result, args.json)
        print("ozone: request document is too deeply nested", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, ValueError):
        result = _verification_refusal(["invalid_request_document"])
        _emit_verification(result, args.json)
        print("ozone: invalid request document", file=sys.stderr)
        return 2

    result = verify_governed(request)
    _emit_verification(result, args.json)
    if result["schema"] == REFUSAL_SCHEMA:
        return 2
    return 1 if args.strict and result["outcome"] != "sufficient" else 0


def _extract_receipt_path(argv):
    for index, token in enumerate(argv):
        if token == "--":
            break
        if token == "--receipt":
            if index + 1 < len(argv) and not argv[index + 1].startswith("-"):
                return argv[index + 1], "flag"
            return None, None
        if token.startswith("--receipt="):
            path = token.split("=", 1)[1]
            return (path, "flag") if path else (None, None)
    env_path = os.environ.get(RECEIPT_ENV)
    if env_path:
        return env_path, "env"
    return None, None


def _receipt_flags(argv):
    flags = set()
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_KNOWN_FLAGS and name != "--receipt":
                flags.add(name)
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
        elif token in RECEIPT_KNOWN_FLAGS:
            flags.add(token)
    return sorted(flags)


def _receipt_command(argv):
    if "--version" in argv:
        return "version"
    if any(token in ("-h", "--help") for token in argv):
        return "help"
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
            continue
        if token in COMMANDS:
            return token
    return "review"


def _exit_code_value(code):
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    return 1


def _receipt_is_reserved_windows_path(path):
    if os.name != "nt":
        return False
    stem = os.path.basename(os.path.normpath(path)).split(".", 1)[0].rstrip(" .").upper()
    return stem in RECEIPT_RESERVED_WINDOWS_NAMES


def _receipt_has_symlink_ancestor(path):
    target = os.path.abspath(os.path.expanduser(path))
    current = os.path.dirname(target) or os.getcwd()
    while True:
        if os.path.lexists(current) and (
            os.path.islink(current)
            or (
                hasattr(os.path, "isjunction")
                and os.path.isjunction(current)
            )
        ):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _receipt_error_message(exc):
    message = str(exc)
    safe_messages = {
        "receipt path must not be a Windows device name",
        "receipt path must not be a symlink",
        "receipt path must be a regular file",
        "receipt path must not contain a symlink or junction directory",
    }
    if message in safe_messages:
        return message
    return "could not write receipt; check that the receipt path is a writable regular file"


def _append_run_receipt(
    *,
    tool,
    version,
    argv,
    started_at,
    exit_code,
    receipt_path,
    receipt_source,
    error_type=None,
):
    if not receipt_path:
        return True

    target = os.path.expanduser(receipt_path)
    parent = os.path.dirname(os.path.abspath(target)) or os.getcwd()
    try:
        if _receipt_is_reserved_windows_path(target):
            raise OSError("receipt path must not be a Windows device name")
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")
        if os.path.lexists(target):
            if os.path.islink(target):
                raise OSError("receipt path must not be a symlink")
            if not os.path.isfile(target):
                raise OSError("receipt path must be a regular file")
        os.makedirs(parent, exist_ok=True)
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")

        record = {
            "schema": RECEIPT_SCHEMA,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "tool": tool,
            "version": version,
            "command": _receipt_command(argv),
            "flags": _receipt_flags(argv),
            "arg_count": len(argv),
            "exit_code": exit_code,
            "ok": exit_code == 0,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "python": platform.python_version(),
            "platform": platform.system(),
            "receipt_source": receipt_source,
        }
        if error_type:
            record["error_type"] = error_type
        with open(target, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            fh.write("\n")
    except OSError as e:
        print(f"{tool}: receipt: {_receipt_error_message(e)}", file=sys.stderr)
        return False
    return True


def _main(argv=None):
    p = argparse.ArgumentParser(
        prog="ozone",
        description="Vivary review, impact, and governed evidence verification.",
    )
    p.add_argument("--version", action="version", version=f"ozone {__version__}")
    p.add_argument("command", nargs="?", default="review",
                   choices=COMMANDS)
    p.add_argument("id", nargs="?", help="impact node id or verify request document")
    p.add_argument("--governed", action="store_true",
                   help="explicitly opt in to governed receipt and gate verification")
    p.add_argument("--root", default=None,
                   help="workspace root (default: walk up for tropo.toml)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--strict", action="store_true",
                   help="review/verify: exit non-zero on warnings or insufficient evidence")
    p.add_argument("--pack", default="structure",
                   choices=["structure", "context-budget", "editorial", "all"],
                   help="review: rule pack to run (default: structure)")
    p.add_argument("--receipt", default=None, metavar="PATH",
                   help=f"append a local privacy-preserving JSONL run receipt (or set {RECEIPT_ENV})")
    args = p.parse_args(argv)
    if args.governed and args.command != "verify":
        p.error("--governed is only valid with verify")
    if args.command == "verify":
        if not args.governed:
            p.error("verify requires --governed")
        if not args.id:
            p.error("verify requires a request JSON file or - for stdin")
    return {
        "review": cmd_review,
        "impact": cmd_impact,
        "packs": cmd_packs,
        "verify": cmd_verify,
    }[args.command](args)


def main(argv=None):
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    started_at = time.monotonic()
    receipt_path, receipt_source = _extract_receipt_path(raw_argv)
    try:
        rc = _main(raw_argv)
    except SystemExit as e:
        code = _exit_code_value(e.code)
        receipt_ok = _append_run_receipt(
            tool="ozone",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=code,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type="SystemExit" if code else None,
        )
        if not receipt_ok and code == 0:
            raise SystemExit(1) from e
        raise
    except Exception as e:
        _append_run_receipt(
            tool="ozone",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=1,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type=type(e).__name__,
        )
        raise
    receipt_ok = _append_run_receipt(
        tool="ozone",
        version=__version__,
        argv=raw_argv,
        started_at=started_at,
        exit_code=_exit_code_value(rc),
        receipt_path=receipt_path,
        receipt_source=receipt_source,
    )
    if not receipt_ok and _exit_code_value(rc) == 0:
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
