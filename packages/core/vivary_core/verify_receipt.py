"""Receipt integrity verification (#10, Ozone). Verifies - never repairs - an
Execution Receipt: is it a recognizable receipt, untampered since it was
fingerprinted, and actually bound to the capsule/workspace it claims to be
evidence for? Fails closed by construction: anything short of a full match
is "insufficient" or "refused", never a silent pass.

No I/O: pure recomputation over vivary_core.canonical's ``fingerprint``
primitive - the same seam src/mcp/tools.mjs's verifyFingerprintedArtifact
already uses in the Node reference, reusing the canonicalization/hashing
contract rather than inventing a new one. This module imports no filesystem
or process-spawning APIs.

Reference-guided Python port of src/verify/receipt.mjs (graduation slice 4,
Ozone; decision 0008). The Node module is the frozen executable oracle:
every function here must reproduce it exactly.

ADAPTATION - receipt identifier integrity: the Python seam recomputes the
deterministic receipt ID from its capsule fingerprint, creation time, and
runtime actor. The frozen Node oracle accepts arbitrary replacement IDs
because the receipt fingerprint deliberately excludes ``receipt_id``.
"""

from __future__ import annotations

from vivary_core.canonical import deterministic_id, fingerprint as compute_fingerprint
from vivary_core.receipt import RECEIPT_SCHEMA
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES

RECEIPT_VERDICT_SCHEMA = "vivary.receipt-verdict/v0"


def _verdict(**fields):
    body = {"schema": RECEIPT_VERDICT_SCHEMA, **fields}
    return {**body, "fingerprint": compute_fingerprint(body)}


def _is_plain_object(value):
    # JS `typeof value === "object" && value !== null && !Array.isArray(value)`.
    return isinstance(value, dict)


def _optional(mapping, key):
    # `mapping?.[key]`: an absent/non-dict `mapping` yields None, the same
    # way optional chaining yields `undefined` off a nullish base.
    return mapping.get(key) if isinstance(mapping, dict) else None


def verify_receipt_integrity(*, receipt=None, capsule=None):
    """Verify a receipt's own integrity and, when a capsule is supplied, its
    binding to that exact capsule and workspace. Never raises: a malformed
    or absent receipt is a typed refusal, not an exception.

    receipt  an Execution Receipt (vivary.execution-receipt/v0)
    capsule  compiled Task Capsule to check binding against
    """
    if not _is_plain_object(receipt):
        return _verdict(
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["MISSING_RECEIPT"]],
            receipt_id=None,
        )
    if receipt.get("schema") != RECEIPT_SCHEMA:
        return _verdict(
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["UNSUPPORTED_SCHEMA"]],
            receipt_id=None,
        )

    shape_reasons = []
    receipt_fingerprint = receipt.get("fingerprint")
    if not isinstance(receipt_fingerprint, str) or not receipt_fingerprint.startswith("sha256:"):
        shape_reasons.append(REASON_CODES["MISSING_FINGERPRINT"])
    receipt_id_candidate = receipt.get("receipt_id")
    if not isinstance(receipt_id_candidate, str) or len(receipt_id_candidate) == 0:
        shape_reasons.append(REASON_CODES["MISSING_ID"])
    if shape_reasons:
        # `receipt.receipt_id ?? null`: dict.get already collapses an absent
        # key and an explicit None the same way JS `??` collapses undefined
        # and null.
        return _verdict(
            outcome=OUTCOMES["INSUFFICIENT"],
            reason_codes=shape_reasons,
            receipt_id=receipt.get("receipt_id"),
        )

    # Recompute exactly as receipt.py's own module derived it: strip id and
    # fingerprint, fingerprint what remains, compare.
    receipt_id = receipt["receipt_id"]
    claimed_fingerprint = receipt["fingerprint"]
    body = {k: v for k, v in receipt.items() if k not in ("receipt_id", "fingerprint")}
    recomputed = compute_fingerprint(body)
    if recomputed != claimed_fingerprint:
        return _verdict(
            outcome=OUTCOMES["INSUFFICIENT"],
            reason_codes=[REASON_CODES["FINGERPRINT_MISMATCH"]],
            receipt_id=receipt_id,
        )

    expected_receipt_id_inputs = (
        _optional(receipt.get("capsule"), "fingerprint"),
        receipt.get("created_at"),
        _optional(receipt.get("runtime"), "actor"),
    )
    if not all(isinstance(value, str) and len(value) > 0 for value in expected_receipt_id_inputs):
        return _verdict(
            outcome=OUTCOMES["INSUFFICIENT"],
            reason_codes=[REASON_CODES["RECEIPT_ID_MISMATCH"]],
            receipt_id=receipt_id,
        )
    expected_receipt_id = deterministic_id(
        "receipt",
        {
            "capsule": expected_receipt_id_inputs[0],
            "created_at": expected_receipt_id_inputs[1],
            "actor": expected_receipt_id_inputs[2],
        },
    )
    if receipt_id != expected_receipt_id:
        return _verdict(
            outcome=OUTCOMES["INSUFFICIENT"],
            reason_codes=[REASON_CODES["RECEIPT_ID_MISMATCH"]],
            receipt_id=receipt_id,
        )

    # JS `if (capsule)`: null/undefined are falsy but an EMPTY OBJECT is
    # truthy - `is not None` is the exact Python equivalent ({} is falsy in
    # Python, which would silently skip the binding check JS performs).
    if capsule is not None:
        receipt_capsule = receipt.get("capsule")
        receipt_workspace = receipt.get("workspace")
        capsule_workspace = _optional(capsule, "workspace")
        bound = (
            _optional(receipt_capsule, "id") == capsule.get("capsule_id")
            and _optional(receipt_capsule, "fingerprint") == capsule.get("fingerprint")
            and _optional(receipt_workspace, "fingerprint") == _optional(capsule_workspace, "fingerprint")
        )
        if not bound:
            return _verdict(
                outcome=OUTCOMES["INSUFFICIENT"],
                reason_codes=[REASON_CODES["CAPSULE_BINDING_MISMATCH"]],
                receipt_id=receipt_id,
            )

    return _verdict(outcome=OUTCOMES["VERIFIED"], reason_codes=[], receipt_id=receipt_id)
