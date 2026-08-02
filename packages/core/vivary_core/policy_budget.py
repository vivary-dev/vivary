"""Pure turn/action budget policy for Strato's operating loop.

Reference-guided Python port of src/policy/budget.mjs (graduation slice 3,
decision 0008). The Node module is the frozen executable oracle: this
module answers exactly one question - given how much of the loop has
already been spent, may it spend one more turn or action? It does not know
about capsule claim budgets (vivary_core.capsule_compile /
vivary_core.capsule_select already own and explain that cut;
vivary_core.policy_gates turns an over-budget capsule into a gate reason) -
conflating the two would duplicate a decision that is already made and
explained elsewhere.

No I/O, no persistence: `state` is a plain dict the caller owns and passes
in every turn (turns/actions spent so far). This module never stores it and
never grows a second durable memory store; if a caller wants spend history
kept across process runs, that goes through src/evidence/ (ticket #20), not
here.

Language mapping:
- JS `state.turns_used ?? 0` / `state.actions_used ?? 0` -> explicit
  ``.get(name)`` followed by an ``is None`` check, never a falsy check (0
  itself must survive unchanged - it already means "no spend yet", but the
  point is the coercion path, not the value).
- JS `typeof limits.max_turns === "number"` normally maps to
  ``isinstance(..., (int, float)) and not isinstance(..., bool)`` because
  Python bool is an int subclass and JS has no such overlap.

ADAPTATION - malformed budget scalars: unlike the frozen JS oracle, Python
fails closed when a present limit or its counter is non-numeric or
non-finite. Unbounded dimensions are expressed by omitting the limit, as the
public contract below requires; ``NaN`` and ``Infinity`` never silently
disable a configured budget.
"""

from __future__ import annotations

import math

from vivary_core.capsule_compile import is_task_capsule_shape
from vivary_core.policy_reason_codes import BUDGET_DECISION, BUDGET_REASON

__all__ = ["BUDGET_DECISION", "BUDGET_REASON", "evaluate_budget"]


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)

def _is_finite_number(value) -> bool:
    return _is_number(value) and (not isinstance(value, float) or math.isfinite(value))




def evaluate_budget(*, capsule, state=None, limits=None):
    """Evaluate the loop's turn/action budget for one more step.

    Fails closed: a capsule that does not look like a Task Capsule produces
    a typed refusal rather than a silent "within budget".

    capsule  compiled Task Capsule (used only to prove there is a real
             capsule behind this spend; never mutated, never read for its
             claims)
    state    {"turns_used": int, "actions_used": int} (optional) - caller-
             owned loop state so far; Strato never persists this itself.
    limits   {"max_turns": int, "max_actions": int} (optional) - omit a
             limit to leave that dimension unbounded.

    Returns {"decision": str, "reason_codes": [str], "details": dict}.
    """
    if not is_task_capsule_shape(capsule):
        return {
            "decision": BUDGET_DECISION["REFUSED"],
            "reason_codes": [BUDGET_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "details": {},
        }

    state = state if state is not None else {}
    limits = limits if limits is not None else {}

    reason_codes = []
    details = {}

    turns_used = state.get("turns_used")
    if turns_used is None:
        turns_used = 0
    max_turns = limits.get("max_turns")
    if "max_turns" in limits and (
        not _is_finite_number(max_turns)
        or not _is_finite_number(turns_used)
        or turns_used >= max_turns
    ):
        reason_codes.append(BUDGET_REASON["TURN_BUDGET_EXCEEDED"])
        details["turns"] = {
            "used": turns_used if _is_finite_number(turns_used) else None,
            "max": max_turns if _is_finite_number(max_turns) else None,
        }

    actions_used = state.get("actions_used")
    if actions_used is None:
        actions_used = 0
    max_actions = limits.get("max_actions")
    if "max_actions" in limits and (
        not _is_finite_number(max_actions)
        or not _is_finite_number(actions_used)
        or actions_used >= max_actions
    ):
        reason_codes.append(BUDGET_REASON["ACTION_BUDGET_EXCEEDED"])
        details["actions"] = {
            "used": actions_used if _is_finite_number(actions_used) else None,
            "max": max_actions if _is_finite_number(max_actions) else None,
        }

    return {
        "decision": BUDGET_DECISION["WITHIN_BUDGET"] if len(reason_codes) == 0 else BUDGET_DECISION["EXHAUSTED"],
        "reason_codes": reason_codes,
        "details": details,
    }
