"""Task control state for Exo (ticket #8). Deliberately thin: control and
execution stay distinguishable (docs/ARCHITECTURE.md, "Exo execution
graph"), so mark_task_done only ever changes a task's own control-status
field and takes no execution log parameter at all - completion is
architecturally unable to touch execution evidence, not merely policy-
forbidden from it. task_integrity_view is the read side that recombines the
two: it always reports execution evidence for a task's capsule regardless
of the task's control status, so a task marked done can never erase or
mask a failed verification edge (the ticket's central law).

with_gate_reference lets a task carry a read-only pointer to a gate decision
(vivary_core.policy_reason_codes's GATE_DECISION output shape) without this
module ever evaluating a gate itself - Strato/Ozone own that decision
(docs/PRD.md's ownership table: "Exo: control graph, execution graph,
claims, dependencies, handoffs / must not own: authored semantic truth";
gate evaluation belongs to Strato/Ozone, not Exo). This is the
"gates-as-references" concept in the control graph.

Reference-guided Python port of src/control/tasks.mjs (graduation slice 5,
decision 0008).
"""

from __future__ import annotations

from vivary_core.control_reason_codes import GATE_REFERENCE_REASON

__all__ = [
    "GATE_REFERENCE_REASON",
    "mark_task_done",
    "task_integrity_view",
    "with_gate_reference",
]


def mark_task_done(*, task):
    """@param task  {task_id, status}
    @returns a new task dict with status "done"; every other field passes
        through unchanged
    """
    return {**task, "status": "done"}


def task_integrity_view(*, task, execution_log):
    """Combine a task's control status with the execution evidence recorded
    against its capsule. Failed edges are always surfaced here, independent
    of `task["status"]` - there is no code path in this module that filters
    a failed edge out because the task says done.

    @param task  {task_id, capsule_id, status}
    @param execution_log  append-only log from vivary_core.control_execution
    @returns {task_id, status, execution_edges, has_failed_verification, failed_edges}
    """
    edges = [edge for edge in execution_log if edge["capsule_id"] == task["capsule_id"]]
    failed_edges = [edge for edge in edges if edge["outcome"] == "failed"]
    return {
        "task_id": task["task_id"],
        "status": task["status"],
        "execution_edges": edges,
        "has_failed_verification": len(failed_edges) > 0,
        "failed_edges": failed_edges,
    }


def _is_gate_shape(gate_result):
    return (
        bool(gate_result)
        and isinstance(gate_result, dict)
        and isinstance(gate_result.get("decision"), str)
        and isinstance(gate_result.get("reason_codes"), list)
    )


def with_gate_reference(*, task, gate_result):
    """Attach a gate decision to a task as a read-only reference. Never
    re-evaluates the gate - it only verifies the shape looks like one of
    vivary_core.policy_*'s gate outcomes before recording it.

    @param task
    @param gate_result  {decision, reason_codes}
    @returns {task, reason_codes}
    """
    if not _is_gate_shape(gate_result):
        return {"task": task, "reason_codes": [GATE_REFERENCE_REASON["UNKNOWN_GATE_SHAPE"]]}
    return {"task": {**task, "gate_ref": gate_result}, "reason_codes": []}
