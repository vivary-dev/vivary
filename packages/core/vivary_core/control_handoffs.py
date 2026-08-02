"""Pure, record-only claim handoffs for governed control.

A handoff snapshots a validated active claim and its authorized evidence.  It
never changes the caller-owned claim ledger and never transfers a claim.
"""

from __future__ import annotations

from vivary_core.canonical import deterministic_id
from vivary_core.capsule_compile import is_task_capsule_shape, verify_task_capsule_integrity
from vivary_core.control_actors import AUTHORITY_CLASS, _actors_match, _copy_actor, can_hold_authority
from vivary_core.control_claims import (
    _active_claim_ledger_reason,
    _copy_lease,
    _is_valid_instant,
    _lease_is_expired_at,
    _lease_is_live_at,
    _parse_instant_ms,
)
from vivary_core.control_reason_codes import HANDOFF_DECISION, HANDOFF_REASON
from vivary_core.control_scope import normalize_scope
from vivary_core.verify_receipt import verify_receipt_integrity
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES

__all__ = [
    "HANDOFF_DECISION",
    "HANDOFF_REASON",
    "create_handoff",
]


def _refusal(reason_code):
    return {
        "decision": HANDOFF_DECISION["REFUSED"],
        "reason_codes": [reason_code],
        "handoff": None,
    }


def _is_workspace_revision(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


def create_handoff(
    active_claims,
    claim_id,
    receipt,
    capsule,
    from_actor,
    to_actor,
    workspace_revision,
    created_at,
    to_authority_class=None,
):
    """Record an evidence-bound handoff without changing ``active_claims``.

    The record binds the active holder, normalized scope, optional lease,
    exact capsule and receipt identities, caller-supplied workspace revision,
    and both handoff and receipt timestamps.
    """
    if not _is_valid_instant(created_at):
        return _refusal(HANDOFF_REASON["UNKNOWN_CREATED_AT_SHAPE"])
    ledger_reason = _active_claim_ledger_reason(active_claims)
    if ledger_reason is not None:
        return _refusal(ledger_reason)

    claim = next((candidate for candidate in active_claims if candidate["claim_id"] == claim_id), None)
    if claim is None:
        return _refusal(HANDOFF_REASON["CLAIM_NOT_FOUND"])

    from_authority = can_hold_authority(from_actor, AUTHORITY_CLASS["CONTRIBUTOR"])
    if not from_authority["allowed"]:
        return _refusal(from_authority["reason_codes"][0])
    if not _actors_match(claim["actor"], from_actor):
        return _refusal(HANDOFF_REASON["NOT_CLAIM_HOLDER"])

    created_at_ms = _parse_instant_ms(created_at)
    if _parse_instant_ms(claim["created_at"]) > created_at_ms:
        return _refusal(HANDOFF_REASON["LEASE_NOT_LIVE"])
    if _lease_is_expired_at(claim["lease"], created_at_ms):
        return _refusal(HANDOFF_REASON["LEASE_EXPIRED"])
    if not _lease_is_live_at(claim["lease"], created_at_ms):
        return _refusal(HANDOFF_REASON["LEASE_NOT_LIVE"])

    if not (is_task_capsule_shape(capsule) and verify_task_capsule_integrity(capsule)):
        return _refusal(HANDOFF_REASON["UNKNOWN_CAPSULE_SHAPE"])

    receipt_verdict = verify_receipt_integrity(receipt=receipt, capsule=capsule)
    if receipt_verdict["outcome"] != OUTCOMES["VERIFIED"]:
        if REASON_CODES["CAPSULE_BINDING_MISMATCH"] in receipt_verdict["reason_codes"]:
            return _refusal(HANDOFF_REASON["RECEIPT_CAPSULE_MISMATCH"])
        return _refusal(HANDOFF_REASON["UNKNOWN_RECEIPT_SHAPE"])
    if not _is_valid_instant(receipt["created_at"]):
        return _refusal(HANDOFF_REASON["UNKNOWN_RECEIPT_SHAPE"])
    receipt_created_at_ms = _parse_instant_ms(receipt["created_at"])
    if receipt_created_at_ms > created_at_ms:
        return _refusal(HANDOFF_REASON["RECEIPT_CREATED_AFTER_HANDOFF"])
    authority_started_at_ms = _parse_instant_ms(claim["created_at"])
    if claim["lease"] is not None:
        authority_started_at_ms = max(
            authority_started_at_ms,
            _parse_instant_ms(claim["lease"]["granted_at"]),
        )
    if receipt_created_at_ms < authority_started_at_ms:
        return _refusal(HANDOFF_REASON["RECEIPT_PREDATES_CLAIM"])
    if receipt["runtime"]["actor"] != claim["actor"]["id"]:
        return _refusal(HANDOFF_REASON["RECEIPT_ACTOR_MISMATCH"])

    if (
        not _is_workspace_revision(workspace_revision)
        or workspace_revision != capsule["workspace"]["fingerprint"]
    ):
        return _refusal(HANDOFF_REASON["WORKSPACE_REVISION_MISMATCH"])

    authority_class = claim["authority_class"] if to_authority_class is None else to_authority_class
    recipient_authority = can_hold_authority(to_actor, authority_class)
    if not recipient_authority["allowed"]:
        return _refusal(recipient_authority["reason_codes"][0])

    scope = normalize_scope(claim["scope"])
    holder = _copy_actor(claim["actor"])
    lease = _copy_lease(claim["lease"])
    recipient = _copy_actor(to_actor)
    sender = _copy_actor(from_actor)
    capsule_binding = {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]}
    receipt_binding = {
        "id": receipt["receipt_id"],
        "fingerprint": receipt["fingerprint"],
        "created_at": receipt["created_at"],
    }
    handoff = {
        "handoff_id": deterministic_id(
            "handoff",
            {
                "claim": claim["claim_id"],
                "scope": scope,
                "holder": holder,
                "lease": lease,
                "claim_created_at": claim["created_at"],
                "from": sender,
                "to": recipient,
                "to_authority_class": authority_class,
                "capsule": capsule_binding,
                "receipt": receipt_binding,
                "workspace_revision": workspace_revision,
                "created_at": created_at,
            },
        ),
        "claim_id": claim["claim_id"],
        "scope": scope,
        "holder": holder,
        "lease": lease,
        "claim_created_at": claim["created_at"],
        "from_actor": sender,
        "to_actor": recipient,
        "to_authority_class": authority_class,
        "capsule": capsule_binding,
        "receipt": receipt_binding,
        "workspace_revision": workspace_revision,
        "created_at": created_at,
    }
    return {"decision": HANDOFF_DECISION["BOUND"], "reason_codes": [], "handoff": handoff}
