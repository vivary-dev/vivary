"""Pure execution-evidence derivation and append-only projections.

Only a complete Task Capsule plus an authorized, integrity-verified receipt may
produce edges.  Edge IDs are immutable evidence identities: conflicting
payloads are refused rather than stored beside or over the original evidence.
"""

from __future__ import annotations

from vivary_core.canonical import canonicalize, deterministic_id, is_canonical_body_value
from vivary_core.capsule_compile import is_task_capsule_shape, verify_task_capsule_integrity
from vivary_core.control_reason_codes import EXECUTION_REASON
from vivary_core.verify_receipt import verify_receipt_integrity
from vivary_core.verify_reasons import OUTCOMES

__all__ = [
    "EXECUTION_REASON",
    "derive_execution_edges",
    "record_execution",
]

_CHECK_OUTCOMES = frozenset({"passed", "failed", "skipped"})
_CHECK_REQUIRED_FIELDS = frozenset({"name", "command", "outcome"})
_CHECK_OPTIONAL_FIELDS = frozenset({"detail"})
_MAX_EXECUTION_EDGES = 10_000
_EDGE_FIELDS = frozenset(
    {
        "edge_id",
        "kind",
        "receipt_id",
        "receipt_fingerprint",
        "capsule_id",
        "capsule_fingerprint",
        "position",
        "name",
        "command",
        "outcome",
        "detail",
    }
)


def _is_nonblank_string(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


def _is_check_shape(check):
    return (
        type(check) is dict
        and _CHECK_REQUIRED_FIELDS <= set(check) <= _CHECK_REQUIRED_FIELDS | _CHECK_OPTIONAL_FIELDS
        and _is_nonblank_string(check["name"])
        and _is_nonblank_string(check["command"])
        and isinstance(check["outcome"], str)
        and check["outcome"] in _CHECK_OUTCOMES
        and ("detail" not in check or is_canonical_body_value(check["detail"]))
    )


def _edge_id(receipt_fingerprint, check_name, position):
    return deterministic_id(
        "exec-edge",
        {
            "receipt": receipt_fingerprint,
            "check": check_name,
            "position": position,
        },
    )


def _is_edge_shape(edge):
    if not (
        type(edge) is dict
        and set(edge) == _EDGE_FIELDS
        and _is_nonblank_string(edge["edge_id"])
        and edge["kind"] == "check"
        and _is_nonblank_string(edge["receipt_id"])
        and _is_nonblank_string(edge["receipt_fingerprint"])
        and _is_nonblank_string(edge["capsule_id"])
        and _is_nonblank_string(edge["capsule_fingerprint"])
        and type(edge["position"]) is int
        and edge["position"] >= 0
        and _is_nonblank_string(edge["name"])
        and _is_nonblank_string(edge["command"])
        and isinstance(edge["outcome"], str)
        and edge["outcome"] in _CHECK_OUTCOMES
        and is_canonical_body_value(edge["detail"])
    ):
        return False
    return edge["edge_id"] == _edge_id(edge["receipt_fingerprint"], edge["name"], edge["position"])


def _projection(edges, added, reason_codes):
    return {"edges": edges, "added": added, "reason_codes": reason_codes}

def _edges_match(left, right):
    return canonicalize(left) == canonicalize(right)


def derive_execution_edges(receipt, capsule):
    """Derive one exact evidence edge for each authorized receipt check."""
    if not (is_task_capsule_shape(capsule) and verify_task_capsule_integrity(capsule)):
        return {"edges": [], "reason_codes": [EXECUTION_REASON["UNKNOWN_CAPSULE_SHAPE"]]}
    if (
        type(receipt) is dict
        and type(receipt.get("checks")) is list
        and len(receipt["checks"]) > _MAX_EXECUTION_EDGES
    ):
        return {"edges": [], "reason_codes": [EXECUTION_REASON["WORK_UNBOUNDED"]]}
    receipt_verdict = verify_receipt_integrity(receipt=receipt, capsule=capsule)
    if receipt_verdict["outcome"] != OUTCOMES["VERIFIED"]:
        return {"edges": [], "reason_codes": [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]}
    if not all(_is_check_shape(check) for check in receipt["checks"]):
        return {"edges": [], "reason_codes": [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]}

    edges = []
    for position, check in enumerate(receipt["checks"]):
        edges.append(
            {
                "edge_id": _edge_id(receipt["fingerprint"], check["name"], position),
                "kind": "check",
                "receipt_id": receipt["receipt_id"],
                "receipt_fingerprint": receipt["fingerprint"],
                "capsule_id": capsule["capsule_id"],
                "capsule_fingerprint": capsule["fingerprint"],
                "position": position,
                "name": check["name"],
                "command": check["command"],
                "outcome": check["outcome"],
                "detail": check.get("detail"),
            }
        )
    return {"edges": edges, "reason_codes": []}


def _validated_identity_map(edges, malformed_reason, *, allow_exact_duplicates=False):
    """Return an ID map or its deterministic refusal reason."""
    if type(edges) is not list:
        return None, malformed_reason
    if len(edges) > _MAX_EXECUTION_EDGES:
        return None, EXECUTION_REASON["WORK_UNBOUNDED"]
    by_id = {}
    for edge in edges:
        if not _is_edge_shape(edge):
            return None, malformed_reason
        previous = by_id.get(edge["edge_id"])
        if previous is not None:
            if not _edges_match(previous, edge):
                return None, EXECUTION_REASON["EDGE_IDENTITY_CONFLICT"]
            if not allow_exact_duplicates:
                return None, malformed_reason
            continue
        by_id[edge["edge_id"]] = edge
    return by_id, None


def _append_execution_edges(log, edges):
    """Return an internal append-only execution-log projection.

    Exact replays add nothing.  Any same-ID edge with different evidence
    refuses atomically, preserving the prior log and adding no duplicate.
    """
    existing_by_id, log_error = _validated_identity_map(
        log,
        EXECUTION_REASON["UNKNOWN_EXECUTION_LOG_SHAPE"],
    )
    if log_error is not None:
        return _projection(
            list(log) if type(log) is list else [],
            [],
            [log_error],
        )

    incoming_by_id, edges_error = _validated_identity_map(
        edges,
        EXECUTION_REASON["UNKNOWN_EXECUTION_EDGE_SHAPE"],
        allow_exact_duplicates=True,
    )
    if edges_error is not None:
        return _projection(list(log), [], [edges_error])

    additions = []
    for edge in edges:
        existing = existing_by_id.get(edge["edge_id"])
        if existing is None:
            additions.append(edge)
            existing_by_id[edge["edge_id"]] = edge
        elif not _edges_match(existing, edge):
            return _projection(
                list(log),
                [],
                [EXECUTION_REASON["EDGE_IDENTITY_CONFLICT"]],
            )
    if len(log) + len(additions) > _MAX_EXECUTION_EDGES:
        return _projection(
            list(log),
            [],
            [EXECUTION_REASON["WORK_UNBOUNDED"]],
        )
    return _projection([*log, *additions], additions, [])


def record_execution(log, receipt, capsule):
    """Validate a caller log and record only exact Core-derived receipt evidence."""
    current = _append_execution_edges(log, [])
    if current["reason_codes"]:
        return current

    derivation = derive_execution_edges(receipt, capsule)
    if derivation["reason_codes"]:
        return _projection(
            current["edges"],
            [],
            derivation["reason_codes"],
        )
    return _append_execution_edges(current["edges"], derivation["edges"])
