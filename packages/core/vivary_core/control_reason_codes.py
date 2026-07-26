"""Pinned outcome vocabulary for Exo's control-graph layer (ticket #8).

Reference-guided Python port of src/control/reason-codes.mjs (graduation
slice 5, decision 0008), mirroring vivary_core.policy_reason_codes's pattern:
every decision and reason code any vivary_core.control_* module can emit is
named here, once, so conformance tests assert against one source of truth
instead of scattered string literals. Nothing here performs I/O; this module
holds no state and defines no persisted format - control-graph state is
always caller-owned and passed in/out of the pure functions in this family
(see control_claims.py, control_tasks.py).

JS `Object.freeze(...)` maps to Python's `types.MappingProxyType`, which
raises on any attempted mutation exactly as the frozen JS object would.
"""

from __future__ import annotations

from types import MappingProxyType

AUTHORITY_CLASS = MappingProxyType(
    {
        "CONTRIBUTOR": "contributor",
        "OWNER": "owner",
    }
)

AUTHORITY_REASON = MappingProxyType(
    {
        "WORKERS_CANNOT_OWN": "workers_cannot_own",
        "UNKNOWN_ACTOR_KIND": "unknown_actor_kind",
        "UNKNOWN_AUTHORITY_CLASS": "unknown_authority_class",
    }
)

CLAIM_DECISION = MappingProxyType(
    {
        "GRANTED": "granted",
        "REFUSED": "refused",
        "RELEASED": "released",
    }
)

CLAIM_REASON = MappingProxyType(
    {
        "SCOPE_CONFLICT": "scope_conflict",
        "WORKERS_CANNOT_OWN": AUTHORITY_REASON["WORKERS_CANNOT_OWN"],
        "UNKNOWN_ACTOR_KIND": AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"],
        "UNKNOWN_AUTHORITY_CLASS": AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"],
        "UNKNOWN_REQUEST_SHAPE": "unknown_request_shape",
        "CLAIM_NOT_FOUND": "claim_not_found",
        "NOT_CLAIM_HOLDER": "not_claim_holder",
    }
)

LEASE_REASON = MappingProxyType(
    {
        "LEASE_EXPIRED": "lease_expired",
    }
)

DEPENDENCY_DECISION = MappingProxyType(
    {
        "READY": "ready",
        "BLOCKED": "blocked",
    }
)

DEPENDENCY_REASON = MappingProxyType(
    {
        "DEPENDENCY_NOT_SATISFIED": "dependency_not_satisfied",
        "UNKNOWN_TASK": "unknown_task",
        "DEPENDENCY_CYCLE": "dependency_cycle",
    }
)

HANDOFF_DECISION = MappingProxyType(
    {
        "BOUND": "bound",
        "REFUSED": "refused",
    }
)

HANDOFF_REASON = MappingProxyType(
    {
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
        "UNKNOWN_RECEIPT_SHAPE": "unknown_receipt_shape",
        "UNKNOWN_CLAIM_SHAPE": "unknown_claim_shape",
        "RECEIPT_CAPSULE_MISMATCH": "receipt_capsule_mismatch",
        "WORKSPACE_REVISION_MISMATCH": "workspace_revision_mismatch",
        "NOT_CLAIM_HOLDER": CLAIM_REASON["NOT_CLAIM_HOLDER"],
        "WORKERS_CANNOT_OWN": AUTHORITY_REASON["WORKERS_CANNOT_OWN"],
        "UNKNOWN_AUTHORITY_CLASS": AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"],
    }
)

EXECUTION_REASON = MappingProxyType(
    {
        "UNKNOWN_RECEIPT_SHAPE": "unknown_receipt_shape",
    }
)

GATE_REFERENCE_REASON = MappingProxyType(
    {
        "UNKNOWN_GATE_SHAPE": "unknown_gate_shape",
    }
)
