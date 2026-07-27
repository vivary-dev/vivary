"""Pinned, machine-readable outcomes and reason codes for Ozone's verification
surface (#10, "Ozone verifies receipts and proposes repairs without applying
them"). Every verdict in verify_receipt.py / verify_sufficiency.py reports
one of the OUTCOMES below plus zero or more of these REASON_CODES - never a
free-text explanation as the thing a caller branches on.

Reference-guided Python port of src/verify/reasons.mjs (graduation slice 4,
Ozone; decision 0008). Exported as module-level dicts (not inlined string
literals) so callers and tests assert identity, not string spelling;
changing a value here is a contract change, not a typo fix.

Fail-closed vocabulary:
  "refused"      - not enough recognizable shape to evaluate at all
                    (missing artifact, unsupported schema).
  "insufficient" - shape was recognized but a required property did not
                    hold (tampered, unbound, checks missing/failed,
                    coverage incomplete, limits exceeded).
  "verified" / "sufficient" - the only passing outcomes; never the default.
"""

from __future__ import annotations

OUTCOMES = {
    "VERIFIED": "verified",
    "SUFFICIENT": "sufficient",
    "INSUFFICIENT": "insufficient",
    "REFUSED": "refused",
}

REASON_CODES = {
    # Shape / presence failures (fail closed to "refused").
    "MISSING_RECEIPT": "missing_receipt",
    "MISSING_CAPSULE": "missing_capsule",
    "MISSING_GATE": "missing_gate",
    "UNSUPPORTED_SCHEMA": "unsupported_schema",
    "MISSING_FINGERPRINT": "missing_fingerprint",
    "MISSING_ID": "missing_id",
    # Integrity failures (fail closed to "insufficient").
    "FINGERPRINT_MISMATCH": "fingerprint_mismatch",
    "RECEIPT_ID_MISMATCH": "receipt_id_mismatch",
    "CAPSULE_BINDING_MISMATCH": "capsule_binding_mismatch",
    "RECEIPT_INVALID": "receipt_invalid",
    # Evidence-sufficiency failures (fail closed to "insufficient").
    "MALFORMED_GATE": "malformed_gate",
    "RECEIPT_MISSING_FOR_REQUIRED_CHECKS": "receipt_missing_for_required_checks",
    "RECEIPT_MISSING_FOR_CLAIMS_VERIFICATION": "receipt_missing_for_claims_verification",
    "REQUIRED_CHECK_MISSING": "required_check_missing",
    "REQUIRED_CHECK_FAILED": "required_check_failed",
    "CLAIMS_NOT_FULLY_VERIFIED": "claims_not_fully_verified",
    "UNRESOLVED_CONFLICTS_EXCEED_LIMIT": "unresolved_conflicts_exceed_limit",
    "UNRESOLVED_UNKNOWNS_EXCEED_LIMIT": "unresolved_unknowns_exceed_limit",
}
