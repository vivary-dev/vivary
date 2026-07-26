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

ADAPTATION - capsule identity: gate and budget shape checks both require
``capsule_id`` so the loop cannot accept a capsule that its budget policy
refuses.

ADAPTATION - bound Ozone verdicts: unlike the frozen Node oracle, a supplied
verdict must bind its capsule identity and receipt ID. Strato independently
derives required-check outcomes from the receipt and unions bound Ozone evidence,
so a verdict can add gate evidence but can never waive it.

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


def _is_non_empty_string(value) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_collection_of_dicts(collection) -> bool:
    return all(isinstance(entry, dict) for entry in collection)


def _is_capsule_shape(capsule) -> bool:
    if not (
        isinstance(capsule, dict)
        and capsule.get("schema") == CAPSULE_SCHEMA
        and _is_non_empty_string(capsule.get("capsule_id"))
        and _is_non_empty_string(capsule.get("fingerprint"))
        and isinstance(capsule.get("claims"), list)
        and isinstance(capsule.get("conflicts"), list)
        and isinstance(capsule.get("unknowns"), list)
        and isinstance(capsule.get("omissions"), list)
        and isinstance(capsule.get("required_checks"), list)
    ):
        return False

    return (
        _is_collection_of_dicts(capsule["claims"])
        and all(_is_non_empty_string(claim.get("id")) for claim in capsule["claims"])
        and _is_collection_of_dicts(capsule["conflicts"])
        and all(
            _is_non_empty_string(conflict.get("id")) and _is_non_empty_string(conflict.get("decision"))
            for conflict in capsule["conflicts"]
        )
        and _is_collection_of_dicts(capsule["unknowns"])
        and _is_collection_of_dicts(capsule["omissions"])
        and all(_is_non_empty_string(omission.get("kind")) for omission in capsule["omissions"])
        and _is_collection_of_dicts(capsule["required_checks"])
        and all(
            _is_non_empty_string(required_check.get("name"))
            and _is_non_empty_string(required_check.get("command"))
            for required_check in capsule["required_checks"]
        )
    )


def _is_receipt_shape(receipt) -> bool:
    if not (
        isinstance(receipt, dict)
        and receipt.get("schema") == RECEIPT_SCHEMA
        and _is_non_empty_string(receipt.get("receipt_id"))
        and _is_non_empty_string(receipt.get("fingerprint"))
        and isinstance(receipt.get("checks"), list)
        and isinstance(receipt.get("unresolved_conflicts"), list)
        and isinstance(receipt.get("unresolved_unknowns"), list)
        and isinstance(receipt.get("capsule"), dict)
        and _is_non_empty_string(receipt["capsule"].get("id"))
        and _is_non_empty_string(receipt["capsule"].get("fingerprint"))
    ):
        return False

    return (
        _is_collection_of_dicts(receipt["checks"])
        and all(
            _is_non_empty_string(check.get("name"))
            and _is_non_empty_string(check.get("command"))
            and _is_non_empty_string(check.get("outcome"))
            for check in receipt["checks"]
        )
        and _is_collection_of_dicts(receipt["unresolved_conflicts"])
        and _is_collection_of_dicts(receipt["unresolved_unknowns"])
    )


def _dedupe(codes):
    return list(dict.fromkeys(codes))


def _dedupe_requests(requests):
    deduped = []
    for request in requests:
        if request not in deduped:
            deduped.append(request)
    return deduped


def _has_matching_verdict_bindings(*, verdict, capsule, receipt) -> bool:
    return (
        isinstance(verdict, dict)
        and isinstance(verdict.get("capsule"), dict)
        and verdict["capsule"].get("id") == capsule["capsule_id"]
        and verdict["capsule"].get("fingerprint") == capsule["fingerprint"]
        and verdict.get("receipt_id") == receipt["receipt_id"]
    )


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
        "gate_requests": _dedupe_requests(gate_requests),
    }


def evaluate_receipt_gate(*, capsule, receipt, verdict=None):
    """Decide whether an Execution Receipt clears its capsule's required
    checks and unresolved state well enough to proceed without a human gate.

    A supplied Ozone verdict is usable only when it binds the exact capsule
    (ID and fingerprint) and receipt ID. Strato always independently derives
    each capsule-required check from the receipt, then unions that result with
    any bound verdict failure. Ozone's non-check insufficiency reasons remain
    attached to the returned gate request even when check failures also exist.

    ADAPTATION - independent required checks: the frozen Node oracle allowed a
    supplied verdict to replace receipt-derived checks. This policy keeps the
    receipt as an independent fail-closed source and accepts Ozone only as
    additional, bound evidence.

    capsule  the Task Capsule the receipt claims to run against
    receipt  the Execution Receipt to evaluate
    verdict  {"capsule": {"id": str, "fingerprint": str}, "receipt_id": str,
              "outcome": str, "reason_codes": [str],
              "failing_checks": [{"name": str, "expected": str, "actual": str}]}
             (optional) - an Ozone gate-verdict covering the same pair.

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

    if (
        receipt["capsule"]["id"] != capsule["capsule_id"]
        or receipt["capsule"]["fingerprint"] != capsule["fingerprint"]
    ):
        reason_codes.append(GATE_REASON["RECEIPT_CAPSULE_MISMATCH"])
        gate_requests.append({"reason_code": GATE_REASON["RECEIPT_CAPSULE_MISMATCH"]})

    # The receipt remains an independent source of required-check evidence.
    # A matching name is not enough: every matching name-and-command entry
    # must have passed, so duplicate entries cannot mask a failure.
    for required in capsule["required_checks"]:
        found_matching_check = False
        for check in receipt["checks"]:
            if check["name"] != required["name"] or check["command"] != required["command"]:
                continue
            found_matching_check = True
            if check["outcome"] != "passed":
                reason_codes.append(GATE_REASON["REQUIRED_CHECK_FAILED"])
                gate_requests.append(
                    {
                        "reason_code": GATE_REASON["REQUIRED_CHECK_FAILED"],
                        "check": required["name"],
                        "outcome": check["outcome"],
                    }
                )
        if not found_matching_check:
            reason_codes.append(GATE_REASON["REQUIRED_CHECK_MISSING"])
            gate_requests.append({"reason_code": GATE_REASON["REQUIRED_CHECK_MISSING"], "check": required["name"]})

    if verdict is not None:
        if not _has_matching_verdict_bindings(verdict=verdict, capsule=capsule, receipt=receipt):
            reason_codes.append(GATE_REASON["VERDICT_BINDING_MISMATCH"])
            gate_requests.append({"reason_code": GATE_REASON["VERDICT_BINDING_MISMATCH"]})
        else:
            failing_checks = verdict.get("failing_checks")
            if isinstance(failing_checks, list):
                for failing in failing_checks:
                    if not isinstance(failing, dict):
                        continue
                    if failing.get("actual") == "missing":
                        reason_codes.append(GATE_REASON["REQUIRED_CHECK_MISSING"])
                        gate_requests.append(
                            {"reason_code": GATE_REASON["REQUIRED_CHECK_MISSING"], "check": failing.get("name")}
                        )
                    else:
                        reason_codes.append(GATE_REASON["REQUIRED_CHECK_FAILED"])
                        gate_requests.append(
                            {
                                "reason_code": GATE_REASON["REQUIRED_CHECK_FAILED"],
                                "check": failing.get("name"),
                                "outcome": failing.get("actual"),
                            }
                        )

            if verdict.get("outcome") != "sufficient":
                verdict_reason_codes = verdict.get("reason_codes")
                if not isinstance(verdict_reason_codes, list):
                    verdict_reason_codes = []
                reason_codes.append(GATE_REASON["VERDICT_INSUFFICIENT"])
                gate_requests.append(
                    {
                        "reason_code": GATE_REASON["VERDICT_INSUFFICIENT"],
                        "verdict_outcome": verdict.get("outcome"),
                        "verdict_reason_codes": verdict_reason_codes,
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
        "gate_requests": _dedupe_requests(gate_requests),
    }
