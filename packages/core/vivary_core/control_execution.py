"""The Exo execution graph (ticket #8, docs/ARCHITECTURE.md "Exo execution
graph"): what happened, derived from Execution Receipts (vivary_core.receipt,
read-only - this module never re-implements a receipt, only consumes the
shape it already carries).

Reference-guided Python port of src/control/execution.mjs (graduation
slice 5, decision 0008). Execution edges are evidence, not a success
declaration, and the log they accumulate into is append-only:
append_execution_edges only ever unions edges into a new list by edge id: no
function in this module can remove or overwrite one once appended, which is
what keeps control (control_tasks.py) and execution distinguishable - a
task's control status can change, but the execution evidence behind it
cannot.
"""

from __future__ import annotations

from vivary_core.canonical import deterministic_id
from vivary_core.control_reason_codes import EXECUTION_REASON
from vivary_core.receipt import RECEIPT_SCHEMA

__all__ = [
    "EXECUTION_REASON",
    "derive_execution_edges",
    "append_execution_edges",
]


def _is_receipt_shape(receipt):
    return (
        bool(receipt)
        and isinstance(receipt, dict)
        and receipt.get("schema") == RECEIPT_SCHEMA
        and isinstance(receipt.get("checks"), list)
        and bool(receipt.get("capsule"))
        and isinstance((receipt.get("capsule") or {}).get("id"), str)
        and isinstance(receipt.get("fingerprint"), str)
        and isinstance(receipt.get("receipt_id"), str)
    )


def derive_execution_edges(*, receipt):
    """Derive execution edges from one Execution Receipt: one edge per
    recorded check, carrying the receipt's identity so the edge can never be
    mistaken for a fresher or different run. Fails closed on any receipt
    that does not match the frozen Execution Receipt shape.

    @param receipt  an Execution Receipt (vivary_core.receipt)
    @returns {edges, reason_codes}
    """
    if not _is_receipt_shape(receipt):
        return {"edges": [], "reason_codes": [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]}

    edges = [
        {
            "edge_id": deterministic_id("exec-edge", {"receipt": receipt["fingerprint"], "check": check["name"]}),
            "kind": "check",
            "receipt_id": receipt["receipt_id"],
            "receipt_fingerprint": receipt["fingerprint"],
            "capsule_id": receipt["capsule"]["id"],
            "capsule_fingerprint": receipt["capsule"].get("fingerprint"),
            "name": check["name"],
            "outcome": check["outcome"],
            "detail": check.get("detail"),
        }
        for check in receipt["checks"]
    ]

    return {"edges": edges, "reason_codes": []}


def append_execution_edges(*, log, edges):
    """Append edges to an execution log. Pure and additive only: the
    returned list is a new list; the `log` passed in is never mutated.
    Appending the same derived edges more than once is idempotent
    (deduplicated by `edge_id`) rather than growing the log with repeats,
    but no existing entry is ever dropped, changed, or reordered.

    @param log
    @param edges
    @returns the new, appended-to log
    """
    seen = {e["edge_id"] for e in log}
    additions = [e for e in edges if e["edge_id"] not in seen]
    return [*log, *additions]
