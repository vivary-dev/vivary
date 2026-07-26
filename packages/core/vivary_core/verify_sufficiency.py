"""Evidence sufficiency for a named gate (#10, Ozone) - "does the capsule plus
receipt carry enough proof to satisfy this gate", never "make it pass".
Ozone verifies; it does not waive or apply a gate (docs/ARCHITECTURE.md).

Strato's gate policy (#9) is a parallel, file-disjoint slice not landed in
the Node worktree at the time src/verify/sufficiency.mjs was written. Rather
than depend on unbuilt work, that module defines its own minimal GATE_SPEC
shape and documents the seam explicitly so #9 can adopt, extend, or replace
it once it exists:

  GATE_SPEC = {
    name: str,
    required_checks: Optional[list[str]],        # receipt check `name`s that
                                                   # must appear with outcome
                                                   # "passed"
    require_claims_verified: Optional[bool],      # every capsule claim must
                                                   # be covered by
                                                   # receipt.claims_verified
    max_unresolved_conflicts: Optional[int|float],  # capsule.conflicts
                                                     # length ceiling
    max_unresolved_unknowns: Optional[int|float],   # capsule.unknowns
                                                     # length ceiling
  }

A receipt that fails its own integrity/binding check (verify_receipt.py) is
treated as no usable receipt evidence at all, even if its self-reported
checks look fine - a receipt that cannot prove it is itself proves nothing
about the capsule it claims to cover.

Reference-guided Python port of src/verify/sufficiency.mjs (graduation
slice 4, Ozone; decision 0008). The Node module is the frozen executable
oracle: every function here must reproduce it exactly.

ADAPTATION - verified claim coverage: the Python seam fails closed unless
``receipt.claims_verified`` names every capsule claim. The frozen Node oracle
only compares list lengths, which lets duplicate or unrelated IDs satisfy a
gate; preserving that behavior would violate Ozone's evidence contract.

ADAPTATION - malformed gate constraints: the Python seam refuses a present
constraint unless it has the declared type and finite numeric range. The
frozen Node oracle silently ignores malformed constraints, which can make
insufficient evidence appear sufficient.
"""

from __future__ import annotations

import math

from vivary_core.capsule_compile import CAPSULE_SCHEMA
from vivary_core.canonical import fingerprint as compute_fingerprint
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES
from vivary_core.verify_receipt import verify_receipt_integrity

GATE_VERDICT_SCHEMA = "vivary.gate-verdict/v0"

# Sentinel distinguishing "no receipt argument was passed at all" (JS
# `receipt !== undefined`) from "receipt was explicitly passed as None" -
# both collapse to Python's single `None` otherwise, but the Node reference
# treats the latter as "a receipt argument was given" (and lets it fail
# verify_receipt_integrity's own shape check).
_NO_RECEIPT_PASSED = object()


def _verdict(**fields):
    body = {"schema": GATE_VERDICT_SCHEMA, **fields}
    return {**body, "fingerprint": compute_fingerprint(body)}


def _is_plain_object(value):
    return isinstance(value, dict)


def _string_or_none(value):
    return value if isinstance(value, str) else None


def _capsule_binding(capsule):
    return {
        "id": _string_or_none(capsule.get("capsule_id")) if _is_plain_object(capsule) else None,
        "fingerprint": _string_or_none(capsule.get("fingerprint")) if _is_plain_object(capsule) else None,
    }


def _receipt_id_binding(receipt):
    if receipt is _NO_RECEIPT_PASSED:
        return None
    return verify_receipt_integrity(receipt=receipt).get("receipt_id")


def _is_valid_capsule(capsule):
    return (
        _is_plain_object(capsule)
        and isinstance(capsule.get("claims"), list)
        and isinstance(capsule.get("conflicts"), list)
        and isinstance(capsule.get("unknowns"), list)
    )


def _is_finite_number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _has_malformed_constraints(gate):
    required_checks = gate.get("required_checks")
    if required_checks is not None and (
        not isinstance(required_checks, list) or not all(isinstance(name, str) for name in required_checks)
    ):
        return True
    for key in ("max_unresolved_conflicts", "max_unresolved_unknowns"):
        if gate.get(key) is not None and not _is_finite_number(gate.get(key)):
            return True
    return False


def evaluate_gate_sufficiency(*, gate=None, capsule=None, receipt=_NO_RECEIPT_PASSED):
    """Evaluate whether a capsule's evidence (and, when required, a bound
    receipt's execution evidence) is sufficient for a gate. Never raises: a
    missing capsule is a typed refusal and malformed constraints are a typed
    insufficiency, never an exception.

    gate     {"name": str, "required_checks": [str]?, "require_claims_verified": bool?,
              "max_unresolved_conflicts": number?, "max_unresolved_unknowns": number?}
    capsule  compiled Task Capsule
    receipt  Execution Receipt claimed to cover the capsule
    """
    capsule_binding = _capsule_binding(capsule)
    if not _is_valid_capsule(capsule):
        return _verdict(
            gate=_string_or_none(gate.get("name")) if isinstance(gate, dict) else None,
            capsule=capsule_binding,
            receipt_id=_receipt_id_binding(receipt),
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["MISSING_CAPSULE"]],
        )
    if capsule.get("schema") != CAPSULE_SCHEMA:
        return _verdict(
            gate=_string_or_none(gate.get("name")) if isinstance(gate, dict) else None,
            capsule=capsule_binding,
            receipt_id=_receipt_id_binding(receipt),
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["UNSUPPORTED_SCHEMA"]],
        )
    if not _is_plain_object(gate) or not isinstance(gate.get("name"), str) or len(gate.get("name")) == 0:
        return _verdict(
            gate=None,
            capsule=capsule_binding,
            receipt_id=_receipt_id_binding(receipt),
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["MISSING_GATE"]],
        )
    if _has_malformed_constraints(gate):
        return _verdict(
            gate=gate["name"],
            capsule=capsule_binding,
            receipt_id=_receipt_id_binding(receipt),
            outcome=OUTCOMES["INSUFFICIENT"],
            reason_codes=[REASON_CODES["MALFORMED_GATE"]],
        )

    reason_codes = []

    def add_reason(code):
        if code not in reason_codes:
            reason_codes.append(code)

    failing_checks = []

    unresolved_conflicts = len(capsule["conflicts"])
    max_unresolved_conflicts = gate.get("max_unresolved_conflicts")
    if max_unresolved_conflicts is not None and not (unresolved_conflicts <= max_unresolved_conflicts):
        add_reason(REASON_CODES["UNRESOLVED_CONFLICTS_EXCEED_LIMIT"])
    unresolved_unknowns = len(capsule["unknowns"])
    max_unresolved_unknowns = gate.get("max_unresolved_unknowns")
    if max_unresolved_unknowns is not None and not (unresolved_unknowns <= max_unresolved_unknowns):
        add_reason(REASON_CODES["UNRESOLVED_UNKNOWNS_EXCEED_LIMIT"])

    # A receipt only counts as usable evidence once it proves it is itself
    # intact and actually bound to this capsule.
    receipt_verdict = None
    effective_receipt = None
    if receipt is not _NO_RECEIPT_PASSED:
        receipt_verdict = verify_receipt_integrity(receipt=receipt, capsule=capsule)
        if receipt_verdict["outcome"] == OUTCOMES["VERIFIED"]:
            effective_receipt = receipt
        else:
            add_reason(REASON_CODES["RECEIPT_INVALID"])

    required_checks = gate.get("required_checks") or []
    if len(required_checks) > 0:
        if effective_receipt is None:
            add_reason(REASON_CODES["RECEIPT_MISSING_FOR_REQUIRED_CHECKS"])
        else:
            checks = effective_receipt.get("checks")
            outcome_by_name = {}
            for check in checks if isinstance(checks, list) else []:
                if isinstance(check, dict) and isinstance(check.get("name"), str):
                    check_outcome = check.get("outcome")
                    outcome_by_name[check["name"]] = (
                        check_outcome if check_outcome in ("passed", "failed", "skipped") else "failed"
                    )
            for name in required_checks:
                if name not in outcome_by_name:
                    failing_checks.append({"name": name, "expected": "passed", "actual": "missing"})
                    add_reason(REASON_CODES["REQUIRED_CHECK_MISSING"])
                elif outcome_by_name[name] != "passed":
                    failing_checks.append({"name": name, "expected": "passed", "actual": outcome_by_name[name]})
                    add_reason(REASON_CODES["REQUIRED_CHECK_FAILED"])

    claims_verified_count = None
    if gate.get("require_claims_verified"):
        if effective_receipt is None:
            add_reason(REASON_CODES["RECEIPT_MISSING_FOR_CLAIMS_VERIFICATION"])
        else:
            claims_verified = effective_receipt.get("claims_verified")
            if not isinstance(claims_verified, list):
                claims_verified = []
            claims_verified_count = sum(
                isinstance(claim, dict)
                and isinstance(claim.get("id"), str)
                and claim["id"] in claims_verified
                for claim in capsule["claims"]
            )
            if claims_verified_count < len(capsule["claims"]):
                add_reason(REASON_CODES["CLAIMS_NOT_FULLY_VERIFIED"])

    outcome = OUTCOMES["SUFFICIENT"] if len(reason_codes) == 0 else OUTCOMES["INSUFFICIENT"]

    return _verdict(
        gate=gate["name"],
        capsule=capsule_binding,
        receipt_id=receipt_verdict["receipt_id"] if receipt_verdict is not None else None,
        outcome=outcome,
        reason_codes=reason_codes,
        failing_checks=failing_checks,
        unresolved_conflicts=unresolved_conflicts,
        unresolved_unknowns=unresolved_unknowns,
        claims_total=len(capsule["claims"]),
        claims_verified=claims_verified_count,
        receipt_outcome=receipt_verdict["outcome"] if receipt_verdict is not None else None,
    )
