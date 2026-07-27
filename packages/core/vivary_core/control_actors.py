"""Actor authority classification for Exo (ticket #8).

Reference-guided Python port of src/control/actors.mjs (graduation slice 5,
decision 0008). Pins the law "workers never become product owners":
authority is split into two classes - contributor (may claim scope, do
work, hand off) and owner (may make product-ownership-level decisions a
claim or handoff can carry) - and only a human actor may ever hold
owner-class authority, regardless of what a request or handoff asks for.
This module never grants anything itself; it only answers "could this actor
kind ever hold this authority class," which control_claims.py and
control_handoffs.py consult before granting or binding. Pure, no I/O, no
persistence.

ADAPTATION - closed authority vocabulary: reject authority classes outside
``AUTHORITY_CLASS`` instead of letting arbitrary privileged-looking values
enter claims and handoffs through the permissive translated fallthrough.
"""

from __future__ import annotations

from types import MappingProxyType

from vivary_core.control_reason_codes import AUTHORITY_CLASS, AUTHORITY_REASON

__all__ = [
    "AUTHORITY_CLASS",
    "AUTHORITY_REASON",
    "ACTOR_KIND",
    "can_hold_authority",
]

# Vocabulary mirrors docs/ARCHITECTURE.md's ContextIntegrityEvent example
# actor.kind ("agent") plus the ticket's explicit "worker/agent" pairing and
# the human actor pattern already recognized in
# src/migration/relay-task-record.mjs (HUMAN_ACTOR_PATTERN).
ACTOR_KIND = MappingProxyType(
    {
        "HUMAN": "human",
        "AGENT": "agent",
        "WORKER": "worker",
    }
)

# Only a human actor may ever hold owner-class authority. Agents and workers
# are both execution-side actors - the ticket's "worker/agent" pairing - and
# neither may acquire ownership-class authority through any control-graph
# surface (claim or handoff), no matter what a request asks for.
_OWNERSHIP_CAPABLE_KINDS = {ACTOR_KIND["HUMAN"]}
_KNOWN_KINDS = set(ACTOR_KIND.values())
_KNOWN_AUTHORITY_CLASSES = set(AUTHORITY_CLASS.values())


def can_hold_authority(actor, authority_class):
    """@param actor {kind, id}
    @param authority_class  one of AUTHORITY_CLASS
    @returns {allowed, reason_codes}
    """
    kind = actor.get("kind") if isinstance(actor, dict) else None
    if not isinstance(kind, str) or kind not in _KNOWN_KINDS:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"]]}
    if not isinstance(authority_class, str) or authority_class not in _KNOWN_AUTHORITY_CLASSES:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"]]}
    if authority_class == AUTHORITY_CLASS["OWNER"] and kind not in _OWNERSHIP_CAPABLE_KINDS:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["WORKERS_CANNOT_OWN"]]}
    return {"allowed": True, "reason_codes": []}
