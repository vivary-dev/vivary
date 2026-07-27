"""The claim ledger: claim stays the one narrow writer (ticket #8 law).

Reference-guided Python port of src/control/claims.mjs (graduation slice 5,
decision 0008). This module mirrors vivary_core.policy_*'s purity -
`active_claims` is a plain list the CALLER owns and threads through every
call; nothing here stores state between calls or defines a persisted format
(persistence, if a caller wants it, is vivary_core.evidence_*'s job, not
this one).

Exactly one active claim may exist per scope at a time. request_claim
detects an overlapping-scope claim as a conflict BEFORE any edit can
collide (PRD user story 6) and fails closed with a reason code - the
ledger is left unchanged on refusal, so a rejected request can never
leave a partial write behind. Leases carry a caller-supplied bounded
validity; this module never reads the wall clock (see expire_leases) -
`now` is always an input.

ADAPTATION - fail-closed lease validation: caller-supplied lease timestamps
and `now` must parse as timezone-aware ISO instants. A lease cannot expire
before it is granted. The frozen Node behavior accepts unparseable, local, or
inverted timestamps, whose values can create invalid or non-deterministic
claims.
"""

from __future__ import annotations

import math
from datetime import datetime

from vivary_core.canonical import deterministic_id
from vivary_core.control_actors import AUTHORITY_CLASS, can_hold_authority
from vivary_core.control_reason_codes import CLAIM_DECISION, CLAIM_REASON, LEASE_REASON
from vivary_core.control_scope import _is_valid_scope, normalize_scope, scopes_overlap

__all__ = [
    "CLAIM_DECISION",
    "CLAIM_REASON",
    "LEASE_REASON",
    "request_claim",
    "release_claim",
    "expire_leases",
]




def _is_valid_actor(actor):
    return (
        bool(actor)
        and isinstance(actor, dict)
        and isinstance(actor.get("kind"), str)
        and isinstance(actor.get("id"), str)
    )


def _is_valid_lease(lease):
    if lease is None:
        return True
    if not isinstance(lease, dict):
        return False
    granted_at = lease.get("granted_at")
    expires_at = lease.get("expires_at")
    granted_at_ms = _parse_instant_ms(granted_at)
    expires_at_ms = _parse_instant_ms(expires_at)
    return (
        isinstance(granted_at, str)
        and isinstance(expires_at, str)
        and math.isfinite(granted_at_ms)
        and math.isfinite(expires_at_ms)
        and expires_at_ms >= granted_at_ms
    )


def _is_valid_active_claim(claim):
    return (
        isinstance(claim, dict)
        and isinstance(claim.get("claim_id"), str)
        and len(claim["claim_id"]) > 0
        and _is_valid_scope(claim.get("scope"))
        and _is_valid_actor(claim.get("actor"))
        and isinstance(claim.get("authority_class"), str)
        and claim.get("status") == "active"
    )


def request_claim(*, active_claims, request):
    """Request a claim over a scope. Refuses (leaving `active_claims`
    unchanged) when the request is malformed, when the requested authority
    class exceeds what the actor's kind may ever hold (workers/agents
    cannot request owner-class authority), or when the scope overlaps any
    existing active claim - regardless of whether the overlapping claim
    belongs to the same or a different actor, so exactly one active claim
    ever covers a given scope.

    @param active_claims  caller-owned claim ledger
    @param request  {scope, actor, authority_class?, lease?}
    @returns {decision, reason_codes, claim, claims, conflicts}
    """
    request = request if isinstance(request, dict) else {}
    if not isinstance(active_claims, list):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            "claim": None,
            "claims": [],
            "conflicts": [],
        }

    scope = request.get("scope")
    actor = request.get("actor")
    authority_class = request.get("authority_class")
    if authority_class is None:
        authority_class = AUTHORITY_CLASS["CONTRIBUTOR"]
    lease = request.get("lease")

    if not _is_valid_scope(scope) or not _is_valid_actor(actor) or not _is_valid_lease(lease):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]],
            "claim": None,
            "claims": list(active_claims),
            "conflicts": [],
        }

    if not isinstance(active_claims, list) or not all(
        _is_valid_active_claim(claim) and _is_valid_lease(claim.get("lease")) for claim in active_claims
    ):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            "claim": None,
            "claims": list(active_claims) if isinstance(active_claims, list) else [],
            "conflicts": [],
        }

    authority = can_hold_authority(actor, authority_class)
    if not authority["allowed"]:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": authority["reason_codes"],
            "claim": None,
            "claims": list(active_claims),
            "conflicts": [],
        }

    normalized = normalize_scope(scope)
    conflicts = [existing for existing in active_claims if scopes_overlap(existing["scope"], normalized)]
    if len(conflicts) > 0:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["SCOPE_CONFLICT"]],
            "claim": None,
            "claims": list(active_claims),
            "conflicts": [
                {"claim_id": c["claim_id"], "actor": c["actor"], "scope": c["scope"]} for c in conflicts
            ],
        }

    claim = {
        "claim_id": deterministic_id(
            "claim",
            {"scope": normalized, "actor": actor, "authority_class": authority_class, "count": len(active_claims)},
        ),
        "scope": normalized,
        "actor": actor,
        "authority_class": authority_class,
        "lease": lease,
        "status": "active",
    }

    return {
        "decision": CLAIM_DECISION["GRANTED"],
        "reason_codes": [],
        "claim": claim,
        "claims": [*active_claims, claim],
        "conflicts": [],
    }


def release_claim(*, active_claims, claim_id, actor):
    """Release a claim. Only the actor that holds the claim may release it -
    this is what keeps the claim a narrow writer end to end; nobody else can
    free someone else's scope out from under them.

    @param active_claims
    @param claim_id
    @param actor  {kind, id}
    @returns {decision, reason_codes, claims}
    """
    if not isinstance(active_claims, list):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            "claims": [],
        }

    if not _is_valid_actor(actor):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]],
            "claims": list(active_claims),
        }

    if not isinstance(active_claims, list) or not all(
        _is_valid_active_claim(claim) and _is_valid_lease(claim.get("lease")) for claim in active_claims
    ):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
            "claims": list(active_claims) if isinstance(active_claims, list) else [],
        }

    found = next((c for c in active_claims if c["claim_id"] == claim_id), None)
    if found is None:
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["CLAIM_NOT_FOUND"]],
            "claims": list(active_claims),
        }
    claim_actor = found.get("actor")
    if (
        not _is_valid_actor(claim_actor)
        or claim_actor["kind"] != actor["kind"]
        or claim_actor["id"] != actor["id"]
    ):
        return {
            "decision": CLAIM_DECISION["REFUSED"],
            "reason_codes": [CLAIM_REASON["NOT_CLAIM_HOLDER"]],
            "claims": list(active_claims),
        }
    return {
        "decision": CLAIM_DECISION["RELEASED"],
        "reason_codes": [],
        "claims": [c for c in active_claims if c["claim_id"] != claim_id],
    }


def expire_leases(*, active_claims, now):
    """Deterministically release every claim whose lease has expired as of
    `now`. `now` is always caller-supplied - this module never reads the
    wall clock, so the same `active_claims` and `now` always produce the
    same result.

    @param active_claims
    @param now  ISO instant supplied by the caller
    @returns {claims, expired}
    """
    if not isinstance(active_claims, list):
        return {
            "claims": [],
            "expired": [],
            "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]],
        }

    now_ms = _parse_instant_ms(now)
    if not math.isfinite(now_ms):
        return {
            "claims": list(active_claims),
            "expired": [],
            "reason_codes": [LEASE_REASON["UNKNOWN_NOW_SHAPE"]],
        }

    claims = []
    expired = []
    for claim in active_claims:
        if not _is_valid_active_claim(claim):
            expired.append({"claim": claim, "reason_codes": [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]]})
            continue
        lease = claim.get("lease")
        if lease is not None and not _is_valid_lease(lease):
            expired.append({"claim": claim, "reason_codes": [LEASE_REASON["UNKNOWN_LEASE_SHAPE"]]})
            continue
        is_expired = lease is not None and _parse_instant_ms(lease["expires_at"]) <= now_ms
        if is_expired:
            expired.append({"claim": claim, "reason_codes": [LEASE_REASON["LEASE_EXPIRED"]]})
        else:
            claims.append(claim)
    return {"claims": claims, "expired": expired, "reason_codes": []}


def _parse_instant_ms(instant):
    # The frozen Node behavior accepts unparseable strings as `NaN` and
    # timezone-naive values in the host's local zone. Scope leases must be
    # deterministic, so both forms fail closed here.
    text = instant[:-1] + "+00:00" if isinstance(instant, str) and instant.endswith("Z") else instant
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return math.nan
        return parsed.timestamp() * 1000
    except (TypeError, ValueError, OverflowError, OSError):
        return math.nan
