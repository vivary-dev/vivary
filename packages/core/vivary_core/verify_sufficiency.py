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
"""

from __future__ import annotations

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


def _is_valid_capsule(capsule):
    return (
        _is_plain_object(capsule)
        and isinstance(capsule.get("claims"), list)
        and isinstance(capsule.get("conflicts"), list)
        and isinstance(capsule.get("unknowns"), list)
    )


def _is_number(value):
    # JS `typeof x === "number"`; Python bool is an int subclass and must be
    # excluded (JS `typeof true === "boolean"`, never "number").
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def evaluate_gate_sufficiency(*, gate=None, capsule=None, receipt=_NO_RECEIPT_PASSED):
    """Evaluate whether a capsule's evidence (and, when required, a bound
    receipt's execution evidence) is sufficient for a gate. Never raises: a
    missing capsule or malformed gate is a typed refusal, not an exception.

    gate     {"name": str, "required_checks": [str]?, "require_claims_verified": bool?,
              "max_unresolved_conflicts": number?, "max_unresolved_unknowns": number?}
    capsule  compiled Task Capsule
    receipt  Execution Receipt claimed to cover the capsule
    """
    if not _is_valid_capsule(capsule):
        return _verdict(
            gate=gate.get("name") if isinstance(gate, dict) else None,
            outcome=OUTCOMES["REFUSED"],
            reason_codes=[REASON_CODES["MISSING_CAPSULE"]],
        )
    if not _is_plain_object(gate) or not isinstance(gate.get("name"), str) or len(gate.get("name")) == 0:
        return _verdict(gate=None, outcome=OUTCOMES["REFUSED"], reason_codes=[REASON_CODES["MISSING_GATE"]])

    reason_codes = []

    def add_reason(code):
        if code not in reason_codes:
            reason_codes.append(code)

    failing_checks = []

    unresolved_conflicts = len(capsule["conflicts"])
    max_unresolved_conflicts = gate.get("max_unresolved_conflicts")
    if _is_number(max_unresolved_conflicts) and unresolved_conflicts > max_unresolved_conflicts:
        add_reason(REASON_CODES["UNRESOLVED_CONFLICTS_EXCEED_LIMIT"])
    unresolved_unknowns = len(capsule["unknowns"])
    max_unresolved_unknowns = gate.get("max_unresolved_unknowns")
    if _is_number(max_unresolved_unknowns) and unresolved_unknowns > max_unresolved_unknowns:
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

    required_checks = gate.get("required_checks")
    if not isinstance(required_checks, list):
        required_checks = []
    if len(required_checks) > 0:
        if effective_receipt is None:
            add_reason(REASON_CODES["RECEIPT_MISSING_FOR_REQUIRED_CHECKS"])
        else:
            checks = effective_receipt.get("checks")
            outcome_by_name = {}
            for check in checks if isinstance(checks, list) else []:
                if isinstance(check, dict):
                    outcome_by_name[check.get("name")] = check.get("outcome")
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
            claims_verified_count = len(claims_verified) if claims_verified is not None else 0
            if claims_verified_count < len(capsule["claims"]):
                add_reason(REASON_CODES["CLAIMS_NOT_FULLY_VERIFIED"])

    outcome = OUTCOMES["SUFFICIENT"] if len(reason_codes) == 0 else OUTCOMES["INSUFFICIENT"]

    return _verdict(
        gate=gate["name"],
        outcome=outcome,
        reason_codes=reason_codes,
        failing_checks=failing_checks,
        unresolved_conflicts=unresolved_conflicts,
        unresolved_unknowns=unresolved_unknowns,
        claims_total=len(capsule["claims"]),
        claims_verified=claims_verified_count,
        receipt_outcome=receipt_verdict["outcome"] if receipt_verdict is not None else None,
    )
