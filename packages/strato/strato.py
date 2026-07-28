"""Strato's opt-in governed loop-decision facade."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
from typing import Any

from vivary_core.canonical import is_absolute_root, is_within_allowlist
from vivary_core.control_actors import ACTOR_KIND, AUTHORITY_CLASS, can_hold_authority

from vivary_core.policy_loop import next_loop_step

__version__ = "0.1.0"

REQUEST_SCHEMA = "vivary.strato-decision-request/v0"
DECISION_SCHEMA = "vivary.strato-decision/v0"
REFUSAL_SCHEMA = "vivary.strato-decision-refusal/v0"
POLICY_VERSION = "vivary.strato-policy/v0"
MAX_EVIDENCE_AGE_SECONDS = 300

__all__ = [
    "ACTOR_KIND",
    "AUTHORITY_CLASS",
    "DECISION_SCHEMA",
    "MAX_EVIDENCE_AGE_SECONDS",
    "POLICY_VERSION",
    "REFUSAL_SCHEMA",
    "REQUEST_SCHEMA",
    "decide_governed",
    "main",
]

_ALLOWED_FIELDS = frozenset(
    {
        "schema",
        "policy_version",
        "actor",
        "authority_class",
        "workspace",
        "scope",
        "requested_at",
        "decision_at",
        "capsule",
        "receipt",
        "verdict",
        "state",
        "limits",
    }
)


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _parse_instant(value: Any) -> datetime | None:
    if not _nonempty_string(value):
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        instant = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return instant if instant.tzinfo is not None else None


def _is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_budget_fields(value: Any, names: frozenset[str]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) <= names
        and all(_is_nonnegative_int(field) for field in value.values())
    )


def _same_scope_roots(left: Any, right: Any) -> bool:
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != len(right):
        return False

    unmatched = list(right)
    for left_root in left:
        for index, right_root in enumerate(unmatched):
            if is_within_allowlist(left_root, right_root) and is_within_allowlist(
                right_root, left_root
            ):
                unmatched.pop(index)
                break
        else:
            return False
    return True


def _validate_request(request: Any) -> list[str]:
    if not isinstance(request, dict):
        return ["unknown_request_shape"]

    errors: list[str] = []
    unknown_fields = sorted(set(request) - _ALLOWED_FIELDS)
    errors.extend(f"unknown_field:{field}" for field in unknown_fields)

    if request.get("schema") != REQUEST_SCHEMA:
        errors.append("invalid_schema")
    if request.get("policy_version") != POLICY_VERSION:
        errors.append("invalid_policy_version")

    actor = request.get("actor")
    actor_has_identity = (
        isinstance(actor, dict)
        and set(actor) == {"kind", "id"}
        and _nonempty_string(actor.get("id"))
    )
    if not actor_has_identity:
        errors.append("invalid_actor")
    else:
        authority = can_hold_authority(actor, request.get("authority_class"))
        errors.extend(authority["reason_codes"])

    workspace = request.get("workspace")
    workspace_fingerprint = workspace.get("fingerprint") if isinstance(workspace, dict) else None
    if not (
        isinstance(workspace, dict)
        and set(workspace) == {"fingerprint"}
        and _nonempty_string(workspace_fingerprint)
    ):
        errors.append("invalid_workspace")

    scope = request.get("scope")
    scope_is_valid = (
        isinstance(scope, dict)
        and set(scope) == {"project", "paths"}
        and _nonempty_string(scope.get("project"))
        and isinstance(scope.get("paths"), list)
        and bool(scope["paths"])
        and all(_nonempty_string(path) and is_absolute_root(path) for path in scope["paths"])
    )
    if not scope_is_valid:
        errors.append("invalid_scope")

    requested_at = _parse_instant(request.get("requested_at"))
    decision_at = _parse_instant(request.get("decision_at"))
    if requested_at is None:
        errors.append("invalid_requested_at")
    if decision_at is None:
        errors.append("invalid_decision_at")
    if requested_at is not None and decision_at is not None:
        if requested_at > decision_at:
            errors.append("request_from_future")
        elif decision_at - requested_at > timedelta(seconds=MAX_EVIDENCE_AGE_SECONDS):
            errors.append("stale_request")

    capsule = request.get("capsule")
    capsule_workspace = capsule.get("workspace") if isinstance(capsule, dict) else None
    capsule_fingerprint = capsule_workspace.get("fingerprint") if isinstance(capsule_workspace, dict) else None
    observed_at = _parse_instant(
        capsule_workspace.get("observed_at") if isinstance(capsule_workspace, dict) else None
    )
    if not isinstance(capsule, dict):
        errors.append("invalid_capsule")
    elif _nonempty_string(workspace_fingerprint) and workspace_fingerprint != capsule_fingerprint:
        errors.append("workspace_mismatch")
    if scope_is_valid and isinstance(capsule, dict):
        capsule_task = capsule.get("task")
        capsule_scope = capsule_task.get("scope") if isinstance(capsule_task, dict) else None
        if not _same_scope_roots(scope["paths"], capsule_scope):
            errors.append("scope_mismatch")
    if observed_at is None:
        errors.append("invalid_capsule_observed_at")
    elif requested_at is not None and observed_at > requested_at:
        errors.append("capsule_observed_after_request")
    elif decision_at is not None and decision_at - observed_at > timedelta(seconds=MAX_EVIDENCE_AGE_SECONDS):
        errors.append("stale_capsule")

    if "verdict" in request and "receipt" not in request:
        errors.append("verdict_requires_receipt")

    receipt = request.get("receipt")
    if isinstance(receipt, dict) and "created_at" in receipt:
        receipt_at = _parse_instant(receipt.get("created_at"))
        if receipt_at is None:
            errors.append("invalid_receipt_created_at")
        elif observed_at is not None and receipt_at < observed_at:
            errors.append("receipt_precedes_capsule")
        elif decision_at is not None and receipt_at > decision_at:
            errors.append("receipt_from_future")
        elif decision_at is not None and decision_at - receipt_at > timedelta(
            seconds=MAX_EVIDENCE_AGE_SECONDS
        ):
            errors.append("stale_receipt")

    if "state" in request and not _valid_budget_fields(
        request["state"], frozenset({"turns_used", "actions_used"})
    ):
        errors.append("invalid_state")
    if "limits" in request and not _valid_budget_fields(
        request["limits"], frozenset({"max_turns", "max_actions"})
    ):
        errors.append("invalid_limits")

    return errors


def _blocked_request(errors: list[str]) -> dict[str, Any]:
    return {
        "schema": REFUSAL_SCHEMA,
        "policy_version": POLICY_VERSION,
        "decision": "blocked",
        "reason_codes": errors,
        "budget": None,
        "gate": None,
    }


def _decide_valid_request(request: dict[str, Any]) -> dict[str, Any]:
    policy_args: dict[str, Any] = {
        "capsule": request["capsule"],
        "state": request.get("state"),
        "limits": request.get("limits"),
    }
    if "receipt" in request:
        policy_args["receipt"] = request["receipt"]
    if "verdict" in request:
        policy_args["verdict"] = request["verdict"]

    outcome = next_loop_step(**policy_args)
    return {
        "schema": DECISION_SCHEMA,
        "policy_version": request["policy_version"],
        "actor": request["actor"],
        "authority_class": request["authority_class"],
        "workspace": request["workspace"],
        "scope": request["scope"],
        "requested_at": request["requested_at"],
        "decision_at": request["decision_at"],
        **outcome,
    }


def decide_governed(request: Any) -> dict[str, Any]:
    """Validate a Strato request and return one deterministic core policy decision."""

    try:
        errors = _validate_request(request)
        return _blocked_request(errors) if errors else _decide_valid_request(request)
    except RecursionError:
        return _blocked_request(["request_too_deeply_nested"])


def _blocked_input(reason: str) -> dict[str, Any]:
    return _blocked_request([reason])


def _load_request(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    with Path(path).open(encoding="utf-8") as source:
        return json.load(source)


def _emit(result: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return
    print(f"strato decide: {result['decision']}")
    if result["reason_codes"]:
        print("reasons: " + ", ".join(result["reason_codes"]))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="strato", description="Vivary governed loop policy")
    parser.add_argument("--version", action="version", version=f"strato {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    decide = commands.add_parser("decide", help="evaluate the next governed loop step")
    decide.add_argument(
        "--governed",
        action="store_true",
        required=True,
        help="explicitly opt in to the experimental governed policy contract",
    )
    decide.add_argument("--json", action="store_true", help="emit the decision as JSON")
    decide.add_argument(
        "--strict",
        action="store_true",
        help="exit 1 when a valid policy evaluation blocks or requests a gate",
    )
    decide.add_argument("request", help="decision-request JSON file, or - for stdin")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        request = _load_request(args.request)
    except RecursionError as error:
        result = _blocked_input("request_too_deeply_nested")
        _emit(result, json_output=args.json)
        print(f"strato: {error}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        result = _blocked_input("invalid_request_document")
        _emit(result, json_output=args.json)
        print(f"strato: {error}", file=sys.stderr)
        return 2

    result = decide_governed(request)
    _emit(result, json_output=args.json)
    if result["schema"] == REFUSAL_SCHEMA:
        return 2
    return 1 if args.strict and result["decision"] in {"blocked", "request_gate"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
