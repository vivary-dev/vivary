"""Handoffs bind a claim and its Execution Receipt to the Task Capsule
fingerprint and workspace revision they actually ran against (PRD user
story 5: "As an agent handing off work, I want Exo to bind claims and
receipts to a Task Capsule and workspace fingerprint so the next agent
knows what actually happened").

Reference-guided Python port of src/control/handoffs.mjs (graduation
slice 5, decision 0008). Consumes capsule/receipt shapes read-only
(vivary_core.capsule_compile, vivary_core.receipt) - it never re-implements
or mutates either. Fails closed on any mismatch between the receipt and the
capsule/revision the handoff claims to describe, and on any attempt to hand
ownership-class authority to a worker or agent actor (the "workers never
become product owners" law also applies at handoff time, not only at claim
time).

ADAPTATION - holder-bound initiation: a handoff is refused unless
``from_actor`` matches both the kind and ID recorded on the claim. The
translated path validated only the recipient and let any actor transfer
another actor's claim.

ADAPTATION - complete receipt binding: a receipt must pass its fingerprint,
identifier integrity, and non-empty capsule/workspace binding checks. Handoffs compare both capsule ID and fingerprint, and require the receipt,
capsule, and requested workspace revisions to agree. The translated path checked
only capsule fingerprint and the receipt-to-requested workspace pair.
"""

from __future__ import annotations

from vivary_core.canonical import deterministic_id
from vivary_core.capsule_compile import CAPSULE_SCHEMA, TASK_CAPSULE_FIELDS
from vivary_core.control_actors import AUTHORITY_CLASS, can_hold_authority
from vivary_core.control_reason_codes import HANDOFF_DECISION, HANDOFF_REASON
from vivary_core.receipt import EXECUTION_RECEIPT_FIELDS, RECEIPT_SCHEMA
from vivary_core.verify_receipt import verify_receipt_integrity

__all__ = [
    "HANDOFF_DECISION",
    "HANDOFF_REASON",
    "create_handoff",
]


def _is_capsule_shape(capsule):
    return (
        bool(capsule)
        and isinstance(capsule, dict)
        and set(capsule) <= TASK_CAPSULE_FIELDS
        and capsule.get("schema") == CAPSULE_SCHEMA
        and isinstance(capsule.get("capsule_id"), str)
        and len(capsule["capsule_id"]) > 0
        and isinstance(capsule.get("fingerprint"), str)
        and len(capsule["fingerprint"]) > 0
        and isinstance(capsule.get("workspace"), dict)
        and isinstance(capsule["workspace"].get("fingerprint"), str)
        and len(capsule["workspace"]["fingerprint"]) > 0
    )


def _is_receipt_shape(receipt):
    return (
        bool(receipt)
        and isinstance(receipt, dict)
        and set(receipt) <= EXECUTION_RECEIPT_FIELDS
        and receipt.get("schema") == RECEIPT_SCHEMA
        and isinstance(receipt.get("receipt_id"), str)
        and isinstance(receipt.get("fingerprint"), str)
        and isinstance(receipt.get("capsule"), dict)
        and isinstance(receipt["capsule"].get("fingerprint"), str)
        and isinstance(receipt.get("workspace"), dict)
        and isinstance(receipt["workspace"].get("fingerprint"), str)
        and verify_receipt_integrity(receipt=receipt)["outcome"] == "verified"
    )


def _is_claim_shape(claim):
    return bool(claim) and isinstance(claim, dict) and isinstance(claim.get("claim_id"), str)


def create_handoff(
    *,
    claim,
    receipt,
    capsule,
    from_actor,
    to_actor,
    workspace_revision,
    created_at,
    to_authority_class=None,
):
    """Bind a claim and an Execution Receipt to the capsule and workspace
    revision the handoff asserts they ran against.

    @param claim               the claim being handed off
    @param receipt             the Execution Receipt evidencing the work
    @param capsule             the Task Capsule the receipt should match
    @param from_actor          {kind, id}
    @param to_actor            {kind, id}
    @param to_authority_class  authority class being handed to `to_actor`;
                                defaults to the claim's own authority class
    @param workspace_revision  the workspace fingerprint this handoff claims
                                is current
    @param created_at          caller-supplied instant; this module reads no clock
    @returns {decision, reason_codes, handoff}
    """
    if not _is_capsule_shape(capsule):
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": [HANDOFF_REASON["UNKNOWN_CAPSULE_SHAPE"]], "handoff": None}
    if not _is_receipt_shape(receipt):
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": [HANDOFF_REASON["UNKNOWN_RECEIPT_SHAPE"]], "handoff": None}
    if not _is_claim_shape(claim):
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": [HANDOFF_REASON["UNKNOWN_CLAIM_SHAPE"]], "handoff": None}

    claim_actor = claim.get("actor")
    holder_matches = (
        isinstance(claim_actor, dict)
        and isinstance(from_actor, dict)
        and claim_actor.get("kind") == from_actor.get("kind")
        and claim_actor.get("id") == from_actor.get("id")
    )
    if not holder_matches:
        return {
            "decision": HANDOFF_DECISION["REFUSED"],
            "reason_codes": [HANDOFF_REASON["NOT_CLAIM_HOLDER"]],
            "handoff": None,
        }

    receipt_capsule = receipt["capsule"]
    if (
        receipt_capsule.get("id") != capsule["capsule_id"]
        or receipt_capsule["fingerprint"] != capsule["fingerprint"]
    ):
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": [HANDOFF_REASON["RECEIPT_CAPSULE_MISMATCH"]], "handoff": None}
    receipt_workspace_revision = receipt["workspace"]["fingerprint"]
    capsule_workspace_revision = capsule["workspace"]["fingerprint"]
    if (
        receipt_workspace_revision != workspace_revision
        or receipt_workspace_revision != capsule_workspace_revision
    ):
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": [HANDOFF_REASON["WORKSPACE_REVISION_MISMATCH"]], "handoff": None}

    authority_class = to_authority_class
    if authority_class is None:
        authority_class = claim.get("authority_class")
    if authority_class is None:
        authority_class = AUTHORITY_CLASS["CONTRIBUTOR"]

    authority = can_hold_authority(to_actor, authority_class)
    if not authority["allowed"]:
        return {"decision": HANDOFF_DECISION["REFUSED"], "reason_codes": authority["reason_codes"], "handoff": None}

    handoff = {
        "handoff_id": deterministic_id(
            "handoff",
            {"claim": claim["claim_id"], "receipt": receipt["fingerprint"], "to": to_actor, "created_at": created_at},
        ),
        "claim_id": claim["claim_id"],
        "from_actor": from_actor,
        "to_actor": to_actor,
        "to_authority_class": authority_class,
        "capsule": {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]},
        "receipt": {"id": receipt["receipt_id"], "fingerprint": receipt["fingerprint"]},
        "workspace_revision": workspace_revision,
        "created_at": created_at,
    }

    return {"decision": HANDOFF_DECISION["BOUND"], "reason_codes": [], "handoff": handoff}
