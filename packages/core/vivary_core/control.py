"""Public barrel for Exo's control-graph slice (ticket #8).

Reference-guided Python port of src/control/index.mjs (graduation slice 5,
decision 0008). Re-exports every module's public surface so a caller can
import the whole control graph from one seam, the same shape
vivary_core.policy_*'s modules present individually (there is no equivalent
barrel there; this one exists because control.py callers - Strato's loop, a
future Exo surface - need tasks, claims, actors, dependencies, handoffs, and
execution together). No new logic lives here.
"""

from __future__ import annotations

from vivary_core.control_actors import (  # noqa: F401
    ACTOR_KIND,
    AUTHORITY_CLASS,
    AUTHORITY_REASON,
    can_hold_authority,
)
from vivary_core.control_scope import normalize_scope, scopes_overlap  # noqa: F401
from vivary_core.control_claims import (  # noqa: F401
    CLAIM_DECISION,
    CLAIM_REASON,
    LEASE_REASON,
    expire_leases,
    release_claim,
    request_claim,
)
from vivary_core.control_dependencies import (  # noqa: F401
    DEPENDENCY_DECISION,
    DEPENDENCY_REASON,
    detect_dependency_cycle,
    evaluate_dependencies,
)
from vivary_core.control_handoffs import (  # noqa: F401
    HANDOFF_DECISION,
    HANDOFF_REASON,
    create_handoff,
)
from vivary_core.control_execution import (  # noqa: F401
    EXECUTION_REASON,
    append_execution_edges,
    derive_execution_edges,
)
from vivary_core.control_tasks import (  # noqa: F401
    GATE_REFERENCE_REASON,
    mark_task_done,
    task_integrity_view,
    with_gate_reference,
)

__all__ = [
    "ACTOR_KIND",
    "AUTHORITY_CLASS",
    "AUTHORITY_REASON",
    "can_hold_authority",
    "normalize_scope",
    "scopes_overlap",
    "CLAIM_DECISION",
    "CLAIM_REASON",
    "LEASE_REASON",
    "expire_leases",
    "release_claim",
    "request_claim",
    "DEPENDENCY_DECISION",
    "DEPENDENCY_REASON",
    "detect_dependency_cycle",
    "evaluate_dependencies",
    "HANDOFF_DECISION",
    "HANDOFF_REASON",
    "create_handoff",
    "EXECUTION_REASON",
    "append_execution_edges",
    "derive_execution_edges",
    "GATE_REFERENCE_REASON",
    "mark_task_done",
    "task_integrity_view",
    "with_gate_reference",
]
