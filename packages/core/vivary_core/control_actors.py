"""Actor authority classification for governed control.

Actor identity is a small, exact value object.  Authority decisions are pure:
this module neither grants authority nor reads process state.
"""

from __future__ import annotations

import unicodedata
from types import MappingProxyType

from vivary_core.control_reason_codes import AUTHORITY_CLASS, AUTHORITY_REASON

__all__ = [
    "AUTHORITY_CLASS",
    "AUTHORITY_REASON",
    "ACTOR_KIND",
    "can_hold_authority",
]

ACTOR_KIND = MappingProxyType(
    {
        "HUMAN": "human",
        "AGENT": "agent",
        "WORKER": "worker",
    }
)

_MAX_ACTOR_ID_UTF8_BYTES = 256
_OWNERSHIP_CAPABLE_KINDS = frozenset({ACTOR_KIND["HUMAN"]})
_KNOWN_KINDS = frozenset(ACTOR_KIND.values())
_KNOWN_AUTHORITY_CLASSES = frozenset(AUTHORITY_CLASS.values())


def _is_canonical_actor_id(value):
    """Whether ``value`` is a bounded, already-canonical actor identifier."""
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        len(encoded) <= _MAX_ACTOR_ID_UTF8_BYTES
        and unicodedata.normalize("NFC", value) == value
        and all(unicodedata.category(character)[0] != "C" for character in value)
    )


def _is_exact_actor(actor):
    """Validate the actor value object without authorizing its class."""
    return (
        type(actor) is dict
        and set(actor) == {"kind", "id"}
        and isinstance(actor["kind"], str)
        and _is_canonical_actor_id(actor["id"])
    )


def _actors_match(left, right):
    """Compare two validated actor identities without accepting partial forms."""
    return (
        _is_exact_actor(left)
        and _is_exact_actor(right)
        and left["kind"] == right["kind"]
        and left["id"] == right["id"]
    )


def _copy_actor(actor):
    """Snapshot an already-validated actor without retaining caller mappings."""
    return {"kind": actor["kind"], "id": actor["id"]}


def can_hold_authority(actor, authority_class):
    """Return whether an exact actor identity may hold an authority class.

    The actor must be exactly ``{kind, id}``: no aliases, metadata, blank IDs,
    non-canonical Unicode, or oversized identifiers are accepted.
    """
    if not _is_exact_actor(actor):
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["UNKNOWN_ACTOR_SHAPE"]]}
    if actor["kind"] not in _KNOWN_KINDS:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"]]}
    if not isinstance(authority_class, str) or authority_class not in _KNOWN_AUTHORITY_CLASSES:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"]]}
    if authority_class == AUTHORITY_CLASS["OWNER"] and actor["kind"] not in _OWNERSHIP_CAPABLE_KINDS:
        return {"allowed": False, "reason_codes": [AUTHORITY_REASON["WORKERS_CANNOT_OWN"]]}
    return {"allowed": True, "reason_codes": []}
