"""Pinned outcome vocabulary for Strato's policy layer (ticket #9).

Reference-guided Python port of src/policy/reason-codes.mjs (graduation
slice 3, decision 0008). Every decision and reason code any
vivary_core.policy_* module can emit is named here, once, so conformance
tests assert against one source of truth instead of scattered string
literals. Nothing here performs I/O; this module holds no state and defines
no persisted format - see docs/PRD.md's ownership table ("Strato: loop
state, policies, budgets, gates, learn routing / must not own: a second
durable memory database"). If a caller wants any of this remembered across
turns, that goes through src/evidence/ (ticket #20), not here.

JS `Object.freeze(...)` maps to Python's `types.MappingProxyType`, which
raises on any attempted mutation exactly as the frozen JS object would.
"""

from __future__ import annotations

from types import MappingProxyType

BUDGET_DECISION = MappingProxyType(
    {
        "WITHIN_BUDGET": "within_budget",
        "EXHAUSTED": "budget_exhausted",
        "REFUSED": "refused",
    }
)

BUDGET_REASON = MappingProxyType(
    {
        "TURN_BUDGET_EXCEEDED": "turn_budget_exceeded",
        "ACTION_BUDGET_EXCEEDED": "action_budget_exceeded",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
    }
)

GATE_DECISION = MappingProxyType(
    {
        "CLEAR": "clear",
        "GATE_REQUIRED": "gate_required",
        "BLOCKED": "blocked",
    }
)

GATE_REASON = MappingProxyType(
    {
        "UNRESOLVED_CONFLICT": "unresolved_conflict",
        "UNRESOLVED_UNKNOWN": "unresolved_unknown",
        "CLAIM_MISSING_EVIDENCE": "claim_missing_evidence",
        "CAPSULE_OVER_BUDGET": "capsule_over_budget",
        "REQUIRED_CHECK_MISSING": "required_check_missing",
        "REQUIRED_CHECK_FAILED": "required_check_failed",
        "RECEIPT_CAPSULE_MISMATCH": "receipt_capsule_mismatch",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
        "UNKNOWN_RECEIPT_SHAPE": "unknown_receipt_shape",
    }
)

LOOP_DECISION = MappingProxyType(
    {
        "ACT": "act",
        "REQUEST_GATE": "request_gate",
        "STOP": "stop",
        "BLOCKED": "blocked",
    }
)

LOOP_REASON = MappingProxyType(
    {
        "BUDGET_EXHAUSTED": "budget_exhausted",
        "GATE_REQUIRED": "gate_required",
        "BLOCKED_BY_GATE": "blocked_by_gate",
        "ALL_CHECKS_CLEAR": "all_checks_clear",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
    }
)
