"""Pure gate policy over Task Capsules and Execution Receipts.

Reference-guided Python port of src/policy/gates.mjs (graduation slice 3,
decision 0008). The Node module is the frozen executable oracle.

Boundary with Ozone (docs/PRD.md ownership table: Strato owns "gates";
Ozone owns "checks, findings, gate evaluation, receipt verification"):
this module never runs a check and never decides whether a check's result
is trustworthy - it only reads the outcome fields a receipt already
carries (receipt["checks"][*]["outcome"]) and classifies whether that
recorded state should hold up progress. "Did the check pass" is Ozone's
verdict, already on the receipt by the time this module sees it; "given
that verdict, does the loop need a human before it goes further" is
Strato's call, which is what evaluate_capsule_gate/evaluate_receipt_gate
answer. This module also never persists that call - if a caller wants gate
history kept, that goes through src/evidence/ (ticket #20), not here.

Fail closed: an unrecognized capsule or receipt shape is always a "blocked"
refusal, never a silent "clear".

Language mapping (documented, per python/README.md):
- JS `conflict.id ?? null` / `claim.id ?? null` -> ``dict.get("id")``, which
  already collapses an absent key or an explicit ``None`` to ``None`` -
  matching the JS rule "undefined/null both fall back", while any other
  present value (including ``0`` or ``""``) still passes through unchanged.
- `[...new Set(codes)]` (order-preserving de-duplication) -> ``dict.fromkeys``.
"""

from __future__ import annotations

from vivary_core.capsule_compile import CAPSULE_SCHEMA
from vivary_core.policy_reason_codes import GATE_DECISION, GATE_REASON
from vivary_core.receipt import RECEIPT_SCHEMA

__all__ = [
    "GATE_DECISION",
    "GATE_REASON",
    "evaluate_capsule_gate",
    "evaluate_receipt_gate",
]


def _is_capsule_shape(capsule) -> bool:
    return (
        isinstance(capsule, dict)
        and capsule.get("schema") == CAPSULE_SCHEMA
        and isinstance(capsule.get("claims"), list)
        and isinstance(capsule.get("conflicts"), list)
        and isinstance(capsule.get("unknowns"), list)
        and isinstance(capsule.get("omissions"), list)
        and isinstance(capsule.get("required_checks"), list)
        and isinstance(capsule.get("fingerprint"), str)
    )


def _is_receipt_shape(receipt) -> bool:
    return (
        isinstance(receipt, dict)
        and receipt.get("schema") == RECEIPT_SCHEMA
        and isinstance(receipt.get("checks"), list)
        and isinstance(receipt.get("unresolved_conflicts"), list)
        and isinstance(receipt.get("unresolved_unknowns"), list)
        and isinstance(receipt.get("capsule"), dict)
        and isinstance(receipt["capsule"].get("fingerprint"), str)
    )


def _dedupe(codes):
    return list(dict.fromkeys(codes))


def evaluate_capsule_gate(*, capsule):
    """Decide whether a capsule may be acted on without a human gate.

    capsule  compiled Task Capsule

    Returns {"decision": str, "reason_codes": [str], "gate_requests": [dict]}.
    """
    if not _is_capsule_shape(capsule):
        return {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "gate_requests": [],
        }

    reason_codes = []
    gate_requests = []

    for conflict in capsule["conflicts"]:
        if conflict.get("decision") == "review_required":
            reason_codes.append(GATE_REASON["UNRESOLVED_CONFLICT"])
            gate_requests.append({"reason_code": GATE_REASON["UNRESOLVED_CONFLICT"], "target": conflict.get("id")})

    if len(capsule["unknowns"]) > 0:
        reason_codes.append(GATE_REASON["UNRESOLVED_UNKNOWN"])
        gate_requests.append({"reason_code": GATE_REASON["UNRESOLVED_UNKNOWN"], "count": len(capsule["unknowns"])})

    for claim in capsule["claims"]:
        evidence = claim.get("evidence")
        if not isinstance(evidence, list) or len(evidence) == 0:
            reason_codes.append(GATE_REASON["CLAIM_MISSING_EVIDENCE"])
            gate_requests.append({"reason_code": GATE_REASON["CLAIM_MISSING_EVIDENCE"], "target": claim.get("id")})

    over_budget = next((o for o in capsule["omissions"] if o.get("kind") == "claims_over_budget"), None)
    if over_budget is not None:
        reason_codes.append(GATE_REASON["CAPSULE_OVER_BUDGET"])
        gate_requests.append(
            {
                "reason_code": GATE_REASON["CAPSULE_OVER_BUDGET"],
                "omitted_count": over_budget.get("omitted_count"),
            }
        )

    codes = _dedupe(reason_codes)
    return {
        "decision": GATE_DECISION["CLEAR"] if len(codes) == 0 else GATE_DECISION["GATE_REQUIRED"],
        "reason_codes": codes,
        "gate_requests": gate_requests,
    }


def evaluate_receipt_gate(*, capsule, receipt, verdict=None):
    """Decide whether an Execution Receipt clears its capsule's required
    checks and unresolved state well enough to proceed without a human gate.

    Gate-seam harmonization (#13): Ozone's evaluateGateSufficiency
    (src/verify/sufficiency.mjs) already owns the judgment of which required
    checks are missing or failed, behind its GATE_SPEC seam. When a caller
    passes that verdict in, this function consumes its `failing_checks`
    instead of re-deriving the same comparison from
    capsule["required_checks"] vs receipt["checks"] - Strato decides policy
    FROM verdicts; only Ozone evaluates sufficiency and recomputes
    fingerprints; neither runs checks. `verdict` is optional and duck-typed
    (only `failing_checks` is read) so this module stays decoupled from
    src/verify/'s schema constant; omitting it keeps the original
    self-contained re-derivation, unchanged, for backward compatibility.

    capsule  the Task Capsule the receipt claims to run against
    receipt  the Execution Receipt to evaluate
    verdict  {"failing_checks": [{"name": str, "expected": str, "actual": str}]}
             (optional) - an Ozone gate-verdict (evaluateGateSufficiency's
             return value) covering the same capsule/receipt pair.

    Returns {"decision": str, "reason_codes": [str], "gate_requests": [dict]}.
    """
    if not _is_capsule_shape(capsule):
        return {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "gate_requests": [],
        }
    if not _is_receipt_shape(receipt):
        return {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_RECEIPT_SHAPE"]],
            "gate_requests": [],
        }

    reason_codes = []
    gate_requests = []

    if receipt["capsule"]["fingerprint"] != capsule["fingerprint"]:
        reason_codes.append(GATE_REASON["RECEIPT_CAPSULE_MISMATCH"])
        gate_requests.append({"reason_code": GATE_REASON["RECEIPT_CAPSULE_MISMATCH"]})

    failing_checks = verdict.get("failing_checks") if isinstance(verdict, dict) else None
    if isinstance(failing_checks, list):
        for failing in failing_checks:
            if failing.get("actual") == "missing":
                reason_codes.append(GATE_REASON["REQUIRED_CHECK_MISSING"])
                gate_requests.append({"reason_code": GATE_REASON["REQUIRED_CHECK_MISSING"], "check": failing.get("name")})
            else:
                reason_codes.append(GATE_REASON["REQUIRED_CHECK_FAILED"])
                gate_requests.append(
                    {
                        "reason_code": GATE_REASON["REQUIRED_CHECK_FAILED"],
                        "check": failing.get("name"),
                        "outcome": failing.get("actual"),
                    }
                )
    else:
        check_by_name = {c["name"]: c for c in receipt["checks"]}
        for required in capsule["required_checks"]:
            found = check_by_name.get(required["name"])
            if found is None:
                reason_codes.append(GATE_REASON["REQUIRED_CHECK_MISSING"])
                gate_requests.append({"reason_code": GATE_REASON["REQUIRED_CHECK_MISSING"], "check": required["name"]})
            elif found.get("outcome") != "passed":
                reason_codes.append(GATE_REASON["REQUIRED_CHECK_FAILED"])
                gate_requests.append(
                    {
                        "reason_code": GATE_REASON["REQUIRED_CHECK_FAILED"],
                        "check": required["name"],
                        "outcome": found.get("outcome"),
                    }
                )

    if len(receipt["unresolved_conflicts"]) > 0:
        reason_codes.append(GATE_REASON["UNRESOLVED_CONFLICT"])
        gate_requests.append(
            {"reason_code": GATE_REASON["UNRESOLVED_CONFLICT"], "count": len(receipt["unresolved_conflicts"])}
        )
    if len(receipt["unresolved_unknowns"]) > 0:
        reason_codes.append(GATE_REASON["UNRESOLVED_UNKNOWN"])
        gate_requests.append(
            {"reason_code": GATE_REASON["UNRESOLVED_UNKNOWN"], "count": len(receipt["unresolved_unknowns"])}
        )

    codes = _dedupe(reason_codes)
    return {
        "decision": GATE_DECISION["CLEAR"] if len(codes) == 0 else GATE_DECISION["GATE_REQUIRED"],
        "reason_codes": codes,
        "gate_requests": gate_requests,
    }
