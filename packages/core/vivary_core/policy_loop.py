"""Pure loop policy: the Strato step of "ask, act, check, learn, stop"
(docs/ARCHITECTURE.md). Composes policy_budget.py and policy_gates.py into
one next-step decision for a turn; it does not re-implement either check.

Reference-guided Python port of src/policy/loop.mjs (graduation slice 3,
decision 0008). The Node module is the frozen executable oracle.

Strato owns loop state, but only as a value the caller passes in and gets
back out - this module never stores it between calls and defines no
persisted format. If a caller wants loop history kept, that goes through
src/evidence/ (ticket #20), not here.

ADAPTATION - completed-work ordering: when a receipt is present, evaluate
its gate before returning for budget exhaustion. The decision still carries
``budget_exhausted`` and never permits another action, but failed evidence
cannot be hidden behind the boundary stop.
"""

from __future__ import annotations

from vivary_core.policy_budget import BUDGET_DECISION, evaluate_budget
from vivary_core.policy_gates import GATE_DECISION, evaluate_capsule_gate, evaluate_receipt_gate
from vivary_core.policy_reason_codes import LOOP_DECISION, LOOP_REASON

# Sentinel distinguishing "no receipt argument passed at all" (JS `receipt
# === undefined`) from "receipt explicitly passed as None/null" - the latter
# must still take the receipt-evaluation branch (and then fail closed inside
# evaluate_receipt_gate's shape check), exactly as Node's `receipt !==
# undefined` does for a caller-supplied `null`.
_UNSET = object()

__all__ = ["LOOP_DECISION", "LOOP_REASON", "next_loop_step"]


def next_loop_step(*, capsule, receipt=_UNSET, verdict=None, state=None, limits=None):
    """Decide the next loop step for a capsule.

    With no receipt yet: check the capsule is well-formed, check the turn/
    action budget, then check whether the capsule itself already demands a
    gate (unresolved conflicts/unknowns, missing evidence, over-budget
    claims) before allowing "act".

    With a receipt: the turn already ran: check the receipt against the
    capsule's required checks and unresolved state instead of the capsule
    alone, then stop (clear) or request a gate.

    capsule  compiled Task Capsule
    receipt  Execution Receipt for the turn just run, if any (optional)
    verdict  optional Ozone gate-verdict; passed through unchanged to
             evaluate_receipt_gate (#13)
    state    {"turns_used": int, "actions_used": int} (optional)
    limits   {"max_turns": int, "max_actions": int} (optional)

    Returns {"decision": str, "reason_codes": [str], "budget": dict|None,
    "gate": dict}.
    """
    state = state if state is not None else {}
    limits = limits if limits is not None else {}

    capsule_gate = evaluate_capsule_gate(capsule=capsule)
    if capsule_gate["decision"] == GATE_DECISION["BLOCKED"]:
        return {
            "decision": LOOP_DECISION["BLOCKED"],
            "reason_codes": [LOOP_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "budget": None,
            "gate": capsule_gate,
        }

    budget = evaluate_budget(capsule=capsule, state=state, limits=limits)
    budget_exhausted = budget["decision"] == BUDGET_DECISION["EXHAUSTED"]
    budget_reason_codes = [LOOP_REASON["BUDGET_EXHAUSTED"]] if budget_exhausted else []

    if receipt is not _UNSET:
        receipt_gate = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
        if receipt_gate["decision"] == GATE_DECISION["BLOCKED"]:
            return {
                "decision": LOOP_DECISION["BLOCKED"],
                "reason_codes": [LOOP_REASON["BLOCKED_BY_GATE"], *budget_reason_codes],
                "budget": budget,
                "gate": receipt_gate,
            }
        if receipt_gate["decision"] == GATE_DECISION["GATE_REQUIRED"]:
            return {
                "decision": LOOP_DECISION["REQUEST_GATE"],
                "reason_codes": [LOOP_REASON["GATE_REQUIRED"], *budget_reason_codes],
                "budget": budget,
                "gate": receipt_gate,
            }
        return {
            "decision": LOOP_DECISION["STOP"],
            "reason_codes": [LOOP_REASON["ALL_CHECKS_CLEAR"], *budget_reason_codes],
            "budget": budget,
            "gate": receipt_gate,
        }

    if budget_exhausted:
        return {
            "decision": LOOP_DECISION["STOP"],
            "reason_codes": [LOOP_REASON["BUDGET_EXHAUSTED"]],
            "budget": budget,
            "gate": capsule_gate,
        }

    if capsule_gate["decision"] == GATE_DECISION["GATE_REQUIRED"]:
        return {
            "decision": LOOP_DECISION["REQUEST_GATE"],
            "reason_codes": [LOOP_REASON["GATE_REQUIRED"]],
            "budget": budget,
            "gate": capsule_gate,
        }

    return {"decision": LOOP_DECISION["ACT"], "reason_codes": [], "budget": budget, "gate": capsule_gate}
