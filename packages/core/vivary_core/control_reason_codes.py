"""Pinned outcome vocabulary for Core governed-control decisions.

Control state is caller-owned.  This module only centralizes the closed,
machine-readable values emitted by the pure control modules.
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
        "UNKNOWN_ACTOR_SHAPE": "unknown_actor_shape",
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
        "LEDGER_SCOPE_CONFLICT": "claim_ledger_scope_conflict",
        "WORKERS_CANNOT_OWN": AUTHORITY_REASON["WORKERS_CANNOT_OWN"],
        "UNKNOWN_ACTOR_KIND": AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"],
        "UNKNOWN_ACTOR_SHAPE": AUTHORITY_REASON["UNKNOWN_ACTOR_SHAPE"],
        "UNKNOWN_AUTHORITY_CLASS": AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"],
        "UNKNOWN_REQUEST_SHAPE": "unknown_request_shape",
        "UNKNOWN_CLAIM_SHAPE": "unknown_claim_shape",
        "WORK_UNBOUNDED": "claim_work_unbounded",
        "CLAIM_NOT_FOUND": "claim_not_found",
        "NOT_CLAIM_HOLDER": "not_claim_holder",
    }
)

LEASE_REASON = MappingProxyType(
    {
        "LEASE_EXPIRED": "lease_expired",
        "LEASE_NOT_LIVE": "lease_not_live",
        "UNKNOWN_NOW_SHAPE": "unknown_now_shape",
        "UNKNOWN_LEASE_SHAPE": "unknown_lease_shape",
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
        "WORK_UNBOUNDED": "dependency_work_unbounded",
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
        "UNKNOWN_CLAIM_SHAPE": CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"],
        "LEDGER_SCOPE_CONFLICT": CLAIM_REASON["LEDGER_SCOPE_CONFLICT"],
        "CLAIM_NOT_FOUND": CLAIM_REASON["CLAIM_NOT_FOUND"],
        "RECEIPT_CAPSULE_MISMATCH": "receipt_capsule_mismatch",
        "WORKSPACE_REVISION_MISMATCH": "workspace_revision_mismatch",
        "UNKNOWN_CREATED_AT_SHAPE": "unknown_handoff_created_at_shape",
        "RECEIPT_CREATED_AFTER_HANDOFF": "receipt_created_after_handoff",
        "RECEIPT_PREDATES_CLAIM": "receipt_predates_claim",
        "RECEIPT_ACTOR_MISMATCH": "receipt_actor_mismatch",
        "LEASE_EXPIRED": LEASE_REASON["LEASE_EXPIRED"],
        "LEASE_NOT_LIVE": LEASE_REASON["LEASE_NOT_LIVE"],
        "NOT_CLAIM_HOLDER": CLAIM_REASON["NOT_CLAIM_HOLDER"],
        "WORKERS_CANNOT_OWN": AUTHORITY_REASON["WORKERS_CANNOT_OWN"],
        "UNKNOWN_ACTOR_KIND": AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"],
        "UNKNOWN_ACTOR_SHAPE": AUTHORITY_REASON["UNKNOWN_ACTOR_SHAPE"],
        "UNKNOWN_AUTHORITY_CLASS": AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"],
    }
)

EXECUTION_REASON = MappingProxyType(
    {
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
        "UNKNOWN_RECEIPT_SHAPE": "unknown_receipt_shape",
        "UNKNOWN_EXECUTION_LOG_SHAPE": "unknown_execution_log_shape",
        "UNKNOWN_EXECUTION_EDGE_SHAPE": "unknown_execution_edge_shape",
        "WORK_UNBOUNDED": "execution_work_unbounded",
        "EDGE_IDENTITY_CONFLICT": "execution_edge_identity_conflict",
    }
)

TASK_REASON = MappingProxyType(
    {
        "UNKNOWN_TASK_SHAPE": "unknown_task_shape",
        "UNKNOWN_EXECUTION_LOG_SHAPE": EXECUTION_REASON["UNKNOWN_EXECUTION_LOG_SHAPE"],
    }
)


GATE_REFERENCE_REASON = MappingProxyType(
    {
        "UNKNOWN_GATE_SHAPE": "unknown_gate_shape",
    }
)
