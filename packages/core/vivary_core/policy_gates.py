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

ADAPTATION - capsule binding: gate and budget shape checks require a capsule
ID, capsule fingerprint, and workspace fingerprint. A partial capsule cannot
reach the loop's `act` decision.

ADAPTATION - receipt integrity: a receipt must verify its fingerprint,
deterministic identifier, and complete capsule/workspace bindings before this
policy can emit `clear`.

ADAPTATION - bound Ozone verdicts: unlike the frozen Node oracle, a supplied
verdict must prove its fingerprint, capsule and receipt bindings, typed result
fields, and outcome-to-evidence consistency. Strato independently derives
required-check outcomes from the receipt and unions valid Ozone evidence, so a
verdict can add gate evidence but can never waive it.

Language mapping (documented, per python/README.md):
- JS `conflict.id ?? null` / `claim.id ?? null` -> ``dict.get("id")``, which
  already collapses an absent key or an explicit ``None`` to ``None`` -
  matching the JS rule "undefined/null both fall back", while any other
  present value (including ``0`` or ``""``) still passes through unchanged.
- `[...new Set(codes)]` (order-preserving de-duplication) -> ``dict.fromkeys``.
"""

from __future__ import annotations

from vivary_core.capsule_compile import is_task_capsule_shape
from vivary_core.canonical import fingerprint
from vivary_core.policy_reason_codes import GATE_DECISION, GATE_REASON
from vivary_core.receipt import RECEIPT_SCHEMA
from vivary_core.verify_receipt import verify_receipt_integrity

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
        and verify_receipt_integrity(receipt=receipt)["outcome"] == "verified"
    )


def _dedupe(codes):
    return list(dict.fromkeys(codes))


def _dedupe_requests(requests):
    deduped = []
    for request in requests:
        if request not in deduped:
            deduped.append(request)
    return deduped


def _has_valid_verdict_integrity(verdict) -> bool:
    if not isinstance(verdict, dict) or verdict.get("schema") != "vivary.gate-verdict/v0":
        return False
    claimed = verdict.get("fingerprint")
    if not isinstance(claimed, str) or not claimed.startswith("sha256:"):
        return False
    body = {key: value for key, value in verdict.items() if key != "fingerprint"}
    try:
        return fingerprint(body) == claimed
    except Exception:
        return False


def _is_nonnegative_int(value) -> bool:
    return type(value) is int and value >= 0


def _has_valid_verdict_contract(verdict) -> bool:
    outcome = verdict.get("outcome")
    if outcome not in ("sufficient", "insufficient", "refused"):
        return False

    gate = verdict.get("gate")
    if not _is_non_empty_string(gate) and not (outcome == "refused" and gate is None):
        return False

    reason_codes = verdict.get("reason_codes")
    if not isinstance(reason_codes, list) or not all(_is_non_empty_string(code) for code in reason_codes):
        return False
    if len(reason_codes) != len(set(reason_codes)):
        return False

    failing_checks = verdict.get("failing_checks", [])
    if not isinstance(failing_checks, list):
        return False
    for failing in failing_checks:
        if not (
            isinstance(failing, dict)
            and _is_non_empty_string(failing.get("name"))
            and failing.get("expected") == "passed"
            and failing.get("actual") in ("failed", "skipped", "missing")
        ):
            return False

    counts = {}
    for field in ("unresolved_conflicts", "unresolved_unknowns", "claims_total"):
        value = verdict.get(field)
        if value is not None and not _is_nonnegative_int(value):
            return False
        counts[field] = value

    claims_verified = verdict.get("claims_verified")
    if claims_verified is not None and (
        not _is_nonnegative_int(claims_verified)
        or counts["claims_total"] is None
        or claims_verified > counts["claims_total"]
    ):
        return False

    receipt_outcome = verdict.get("receipt_outcome")
    if receipt_outcome is not None and receipt_outcome not in ("verified", "insufficient", "refused"):
        return False

    if outcome == "sufficient":
        return (
            "failing_checks" in verdict
            and not reason_codes
            and not failing_checks
            and all(count is not None for count in counts.values())
            and receipt_outcome == "verified"
        )
    return len(reason_codes) > 0

def _has_matching_sufficient_verdict_projection(*, verdict, capsule, receipt) -> bool:
    # A caller can recompute the public verdict fingerprint, so a sufficient
    # projection must agree with the independently bound capsule and receipt.
    if verdict.get("outcome") != "sufficient":
        return True

    if verdict.get("claims_total") != len(capsule["claims"]):
        return False

    claims_verified = verdict.get("claims_verified")
    if claims_verified is None:
        # Ozone only projects coverage when the gate requested it.
        return True

    verified_claim_ids = receipt.get("claims_verified")
    if not isinstance(verified_claim_ids, list):
        verified_claim_ids = []
    receipt_claims_verified = sum(
        isinstance(claim, dict)
        and isinstance(claim.get("id"), str)
        and claim["id"] in verified_claim_ids
        for claim in capsule["claims"]
    )
    return claims_verified == len(capsule["claims"]) and claims_verified == receipt_claims_verified




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
    if not is_task_capsule_shape(capsule):
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

    The receipt must first pass ``verify_receipt_integrity``. A supplied Ozone
    verdict is usable only when its own fingerprint is valid and it binds the
    exact capsule (ID and fingerprint) and receipt ID. Strato always
    independently derives each capsule-required check from the receipt, then
    unions that result with any bound verdict failure. Ozone's non-check
    insufficiency reasons remain attached to the returned gate request even
    when check failures also exist.

    ADAPTATION - independent required checks: the frozen Node oracle allowed a
    supplied verdict to replace receipt-derived checks. This policy keeps the
    receipt as an independent fail-closed source and accepts Ozone only as
    additional, bound evidence.

    capsule  the Task Capsule the receipt claims to run against
    receipt  the Execution Receipt to evaluate
    verdict  optional fingerprinted ``vivary.gate-verdict/v0`` result from
             ``verify_sufficiency.evaluate_gate_sufficiency`` covering the same
             pair. Refused or insufficient early results may omit projections
             the producer did not evaluate; a sufficient result must carry its
             complete counts, failing-check list, and a verified receipt outcome.

    Returns {"decision": str, "reason_codes": [str], "gate_requests": [dict]}.
    """
    if not is_task_capsule_shape(capsule):
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

    receipt_matches_capsule = (
        receipt["capsule"]["id"] == capsule["capsule_id"]
        and receipt["capsule"]["fingerprint"] == capsule["fingerprint"]
        and receipt["workspace"]["fingerprint"]
        == capsule["workspace"]["fingerprint"]
    )
    if not receipt_matches_capsule:
        reason_codes.append(GATE_REASON["RECEIPT_CAPSULE_MISMATCH"])
        gate_requests.append({"reason_code": GATE_REASON["RECEIPT_CAPSULE_MISMATCH"]})
    elif (
        verify_receipt_integrity(receipt=receipt, capsule=capsule)["outcome"]
        != "verified"
    ):
        return {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_RECEIPT_SHAPE"]],
            "gate_requests": [],
        }

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
        if not _has_valid_verdict_integrity(verdict) or not _has_valid_verdict_contract(verdict):
            reason_codes.append(GATE_REASON["VERDICT_INTEGRITY_MISMATCH"])
            gate_requests.append({"reason_code": GATE_REASON["VERDICT_INTEGRITY_MISMATCH"]})
        elif not _has_matching_verdict_bindings(verdict=verdict, capsule=capsule, receipt=receipt):
            reason_codes.append(GATE_REASON["VERDICT_BINDING_MISMATCH"])
            gate_requests.append({"reason_code": GATE_REASON["VERDICT_BINDING_MISMATCH"]})
        elif not _has_matching_sufficient_verdict_projection(
            verdict=verdict, capsule=capsule, receipt=receipt
        ):
            reason_codes.append(GATE_REASON["VERDICT_INTEGRITY_MISMATCH"])
            gate_requests.append({"reason_code": GATE_REASON["VERDICT_INTEGRITY_MISMATCH"]})
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
