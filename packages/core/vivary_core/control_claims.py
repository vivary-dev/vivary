"""Pure claim-ledger transitions for governed control.

The caller owns every ledger.  ``request_claim`` is the sole authority writer;
release and expiry return new projections and never alter their inputs.
"""

from __future__ import annotations

import math
import unicodedata
from datetime import datetime

from vivary_core.canonical import deterministic_id
from vivary_core.control_actors import AUTHORITY_CLASS, _actors_match, _copy_actor, can_hold_authority
from vivary_core.control_reason_codes import CLAIM_DECISION, CLAIM_REASON, LEASE_REASON
from vivary_core.control_scope import (
    _is_valid_scope,
    _scope_conflict_indices,
    _scopes_are_pairwise_disjoint,
    normalize_scope,
)

__all__ = [
    "CLAIM_DECISION",
    "CLAIM_REASON",
    "LEASE_REASON",
    "request_claim",
    "release_claim",
    "expire_leases",
]

_CLAIM_FIELDS = frozenset(
    {"claim_id", "scope", "actor", "authority_class", "lease", "status", "created_at"}
)
_REQUEST_REQUIRED_FIELDS = frozenset({"scope", "actor", "now"})
_REQUEST_OPTIONAL_FIELDS = frozenset({"authority_class", "lease"})
_LEASE_FIELDS = frozenset({"granted_at", "expires_at"})
_MAX_ACTIVE_CLAIMS = 10_000
_MAX_TOTAL_SCOPE_PATHS = 10_000
_MAX_SCOPE_PATHS_PER_CLAIM = 1_000
_MAX_ID_UTF8_BYTES = 256
_MAX_PROJECT_UTF8_BYTES = 256
_MAX_PATH_UTF8_BYTES = 4_096
_MAX_PATH_SEGMENTS = 256


def _is_bounded_text(value, max_utf8_bytes):
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character)[0] == "C" for character in value)
    ):
        return False
    try:
        return len(value.encode("utf-8")) <= max_utf8_bytes
    except UnicodeEncodeError:
        return False


def _parse_instant_ms(instant):
    """Return a finite UTC-comparable timestamp, or ``NaN`` for invalid input."""
    if (
        not _is_bounded_text(instant, 64)
        or "T" not in instant
    ):
        return math.nan
    text = instant[:-1] + "+00:00" if instant.endswith("Z") else instant
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return math.nan
        timestamp = parsed.timestamp() * 1000
    except (TypeError, ValueError, OverflowError, OSError):
        return math.nan
    return timestamp if math.isfinite(timestamp) else math.nan


def _is_valid_instant(instant):
    return math.isfinite(_parse_instant_ms(instant))


def _is_valid_lease(lease):
    """Validate the exact optional lease record without applying a clock."""
    if lease is None:
        return True
    if type(lease) is not dict or set(lease) != _LEASE_FIELDS:
        return False
    granted_at_ms = _parse_instant_ms(lease["granted_at"])
    expires_at_ms = _parse_instant_ms(lease["expires_at"])
    return math.isfinite(granted_at_ms) and math.isfinite(expires_at_ms) and expires_at_ms >= granted_at_ms

def _is_valid_claim_scope(scope):
    return (
        type(scope) is dict
        and set(scope) == {"project", "paths"}
        and _is_valid_scope(scope)
        and _is_bounded_text(scope["project"], _MAX_PROJECT_UTF8_BYTES)
        and type(scope["paths"]) is list
        and 0 < len(scope["paths"]) <= _MAX_SCOPE_PATHS_PER_CLAIM
        and all(
            _is_bounded_text(path, _MAX_PATH_UTF8_BYTES)
            and path.count("/") + path.count("\\") <= _MAX_PATH_SEGMENTS
            for path in scope["paths"]
        )
    )



def _lease_is_expired_at(lease, now_ms):
    return lease is not None and _parse_instant_ms(lease["expires_at"]) <= now_ms


def _lease_is_live_at(lease, now_ms):
    """A lease is live exactly when ``granted_at <= now < expires_at``."""
    if lease is None:
        return True
    return _parse_instant_ms(lease["granted_at"]) <= now_ms < _parse_instant_ms(lease["expires_at"])


def _copy_lease(lease):
    if lease is None:
        return None
    return {"granted_at": lease["granted_at"], "expires_at": lease["expires_at"]}


def _is_valid_claim_id(value):
    return _is_bounded_text(value, _MAX_ID_UTF8_BYTES)


def _claim_identity(*, scope, actor, authority_class, lease, created_at):
    return deterministic_id(
        "claim",
        {
            "scope": scope,
            "actor": actor,
            "authority_class": authority_class,
            "lease": lease,
            "created_at": created_at,
        },
    )


def _is_valid_active_claim(claim):
    if (
        type(claim) is not dict
        or set(claim) != _CLAIM_FIELDS
        or not _is_valid_claim_id(claim["claim_id"])
        or not _is_valid_claim_scope(claim["scope"])
        or claim["scope"] != normalize_scope(claim["scope"])
        or claim["status"] != "active"
        or not _is_valid_lease(claim["lease"])
        or not _is_valid_instant(claim["created_at"])
        or not can_hold_authority(
            claim["actor"],
            claim["authority_class"],
        )["allowed"]
    ):
        return False
    created_at_ms = _parse_instant_ms(claim["created_at"])
    return (
        _lease_is_live_at(claim["lease"], created_at_ms)
        and claim["claim_id"] == _claim_identity(
            scope=claim["scope"],
            actor=claim["actor"],
            authority_class=claim["authority_class"],
            lease=claim["lease"],
            created_at=claim["created_at"],
        )
    )


def _active_claim_ledger_reason(active_claims):
    if type(active_claims) is not list or len(active_claims) > _MAX_ACTIVE_CLAIMS:
        return CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]

    total_scope_paths = 0
    claim_ids = set()
    for claim in active_claims:
        if not _is_valid_active_claim(claim):
            return CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]
        total_scope_paths += len(claim["scope"]["paths"])
        if total_scope_paths > _MAX_TOTAL_SCOPE_PATHS:
            return CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]
        if claim["claim_id"] in claim_ids:
            return CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]
        claim_ids.add(claim["claim_id"])

    if not _scopes_are_pairwise_disjoint(
        [claim["scope"] for claim in active_claims]
    ):
        return CLAIM_REASON["LEDGER_SCOPE_CONFLICT"]
    return None


def _has_valid_active_claim_ledger(active_claims):
    return _active_claim_ledger_reason(active_claims) is None


def _claim_result(decision, reason_codes, claims, claim=None, conflicts=None):
    return {
        "decision": decision,
        "reason_codes": reason_codes,
        "claim": claim,
        "claims": claims,
        "conflicts": [] if conflicts is None else conflicts,
    }


def request_claim(active_claims, request):
    """Request the only authority-writing transition for a caller ledger.

    ``request`` is exactly ``{scope, actor, now, authority_class?, lease?}``.
    Every active lease in the supplied ledger must first have been removed by
    ``expire_leases`` when it is expired at the supplied ``now``.
    """
    if type(active_claims) is not list:
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            [],
        )
    ledger_reason = _active_claim_ledger_reason(active_claims)
    if ledger_reason is not None:
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [ledger_reason],
            list(active_claims),
        )
    if (
        type(request) is not dict
        or not _REQUEST_REQUIRED_FIELDS <= set(request)
        or not set(request) <= _REQUEST_REQUIRED_FIELDS | _REQUEST_OPTIONAL_FIELDS
    ):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]],
            list(active_claims),
        )

    now = request["now"]
    if not _is_valid_instant(now):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [LEASE_REASON["UNKNOWN_NOW_SHAPE"]],
            list(active_claims),
        )

    scope = request["scope"]
    lease = request.get("lease")
    if not _is_valid_claim_scope(scope):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]],
            list(active_claims),
        )
    if not _is_valid_lease(lease):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [LEASE_REASON["UNKNOWN_LEASE_SHAPE"]],
            list(active_claims),
        )

    authority_class = request.get("authority_class", AUTHORITY_CLASS["CONTRIBUTOR"])
    authority = can_hold_authority(request["actor"], authority_class)
    if not authority["allowed"]:
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            authority["reason_codes"],
            list(active_claims),
        )

    now_ms = _parse_instant_ms(now)
    if lease is not None and not _lease_is_live_at(lease, now_ms):
        reason = (
            LEASE_REASON["LEASE_EXPIRED"]
            if _lease_is_expired_at(lease, now_ms)
            else LEASE_REASON["LEASE_NOT_LIVE"]
        )
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [reason],
            list(active_claims),
        )
    if any(_lease_is_expired_at(claim["lease"], now_ms) for claim in active_claims):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [LEASE_REASON["LEASE_EXPIRED"]],
            list(active_claims),
        )
    if any(
        not _lease_is_live_at(claim["lease"], now_ms)
        or _parse_instant_ms(claim["created_at"]) > now_ms
        for claim in active_claims
    ):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [LEASE_REASON["LEASE_NOT_LIVE"]],
            list(active_claims),
        )

    normalized_scope = normalize_scope(scope)
    projected_scope_paths = sum(
        len(claim["scope"]["paths"]) for claim in active_claims
    ) + len(normalized_scope["paths"])
    if (
        len(active_claims) >= _MAX_ACTIVE_CLAIMS
        or projected_scope_paths > _MAX_TOTAL_SCOPE_PATHS
    ):
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [CLAIM_REASON["WORK_UNBOUNDED"]],
            list(active_claims),
        )
    conflict_indices = _scope_conflict_indices(
        [normalized_scope, *(claim["scope"] for claim in active_claims)],
        0,
    )
    conflicts = [
        active_claims[index - 1]
        for index in sorted(conflict_indices)
    ]
    if conflicts:
        return _claim_result(
            CLAIM_DECISION["REFUSED"],
            [CLAIM_REASON["SCOPE_CONFLICT"]],
            list(active_claims),
            conflicts=[
                {
                    "claim_id": claim["claim_id"],
                    "actor": _copy_actor(claim["actor"]),
                    "scope": normalize_scope(claim["scope"]),
                }
                for claim in conflicts
            ],
        )

    actor = _copy_actor(request["actor"])
    copied_lease = _copy_lease(lease)
    claim = {
        "claim_id": _claim_identity(
            scope=normalized_scope,
            actor=actor,
            authority_class=authority_class,
            lease=copied_lease,
            created_at=now,
        ),
        "scope": normalized_scope,
        "actor": actor,
        "authority_class": authority_class,
        "lease": copied_lease,
        "status": "active",
        "created_at": now,
    }
    return _claim_result(
        CLAIM_DECISION["GRANTED"],
        [],
        [*active_claims, claim],
        claim=claim,
    )


def release_claim(active_claims, claim_id, actor):
    """Release one active claim only when its exact holder requests it."""
    if type(active_claims) is not list:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            "claims": [],
        }
    ledger_reason = _active_claim_ledger_reason(active_claims)
    if ledger_reason is not None:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [ledger_reason],
            "claims": list(active_claims),
        }
    if not _is_valid_claim_id(claim_id):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]],
            "claims": list(active_claims),
        }

    actor_authority = can_hold_authority(actor, AUTHORITY_CLASS["CONTRIBUTOR"])
    if not actor_authority["allowed"]:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": actor_authority["reason_codes"],
            "claims": list(active_claims),
        }

    claim = next((candidate for candidate in active_claims if candidate["claim_id"] == claim_id), None)
    if claim is None:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["CLAIM_NOT_FOUND"]],
            "claims": list(active_claims),
        }
    if not _actors_match(claim["actor"], actor):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["NOT_CLAIM_HOLDER"]],
            "claims": list(active_claims),
        }
    return {
        "decision": CLAIM_DECISION["RELEASED"],
        "reason_codes": [],
        "claims": [candidate for candidate in active_claims if candidate["claim_id"] != claim_id],
    }


def expire_leases(active_claims, now):
    """Return a ledger projection with only leases expired at ``now`` removed."""
    if type(active_claims) is not list:
        return {
            "claims": [],
            "expired": [],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
        }
    ledger_reason = _active_claim_ledger_reason(active_claims)
    if ledger_reason is not None:
        return {
            "claims": list(active_claims),
            "expired": [],
            "reason_codes": [ledger_reason],
        }
    if not _is_valid_instant(now):
        return {
            "claims": list(active_claims),
            "expired": [],
            "reason_codes": [LEASE_REASON["UNKNOWN_NOW_SHAPE"]],
        }

    now_ms = _parse_instant_ms(now)
    claims = []
    expired = []
    for claim in active_claims:
        if _lease_is_expired_at(claim["lease"], now_ms):
            expired.append({"claim": claim, "reason_codes": [LEASE_REASON["LEASE_EXPIRED"]]})
        else:
            claims.append(claim)
    return {"claims": claims, "expired": expired, "reason_codes": []}
