"""Behavioral tests for Strato's opt-in governed decision facade."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tomllib
import sys

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = PACKAGE_ROOT.parent / "core"
sys.path.insert(0, str(CORE_ROOT))
sys.path.insert(0, str(PACKAGE_ROOT))
CLI_ENV = {
    **os.environ,
    "PYTHONPATH": os.pathsep.join((str(CORE_ROOT), str(PACKAGE_ROOT))),
}

import strato  # noqa: E402
from vivary_core.canonical import deterministic_id, fingerprint  # noqa: E402
from vivary_core.capsule_compile import CAPSULE_SCHEMA, compile_task_capsule  # noqa: E402
from vivary_core.policy_reason_codes import LOOP_DECISION, LOOP_REASON  # noqa: E402
from vivary_core.receipt import create_integrity_receipt  # noqa: E402

NOW = "2026-07-26T12:00:00Z"

def test_runtime_version_matches_the_package_manifest():
    project = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert strato.__version__ == project["version"]
    assert "vivary-core>=0.2.1" in project["dependencies"]


def capsule(**overrides):
    value = {
        "schema": CAPSULE_SCHEMA,
        "capsule_id": None,
        "task": {
            "question": "What is the next safe loop step?",
            "scope": ["/repo/packages/strato"],
        },
        "workspace": {"fingerprint": "sha256:test-workspace", "observed_at": NOW},
        "claims": [],
        "conflicts": [],
        "unknowns": [],
        "omissions": [],
        "required_checks": [{"name": "unit", "command": "python -m pytest"}],
        "budget": {"max_claims": 24},
    }
    value.update(overrides)
    if "capsule_id" not in overrides:
        value["capsule_id"] = deterministic_id(
            "capsule",
            {
                "task": value["task"].get("question"),
                "filters": value["task"].get("filters"),
                "workspace": value["workspace"]["fingerprint"],
            },
        )
    if "fingerprint" not in overrides:
        value["fingerprint"] = fingerprint(
            {
                key: item
                for key, item in value.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
    return value


def request(**overrides):
    value = {
        "schema": strato.REQUEST_SCHEMA,
        "policy_version": strato.POLICY_VERSION,
        "actor": {"kind": "agent", "id": "agent:test"},
        "authority_class": "contributor",
        "workspace": {"fingerprint": "sha256:test-workspace"},
        "scope": {"project": "vivary", "paths": ["/repo/packages/strato"]},
        "requested_at": NOW,
        "decision_at": NOW,
        "capsule": capsule(),
        "state": {"turns_used": 0, "actions_used": 0},
        "limits": {"max_turns": 3, "max_actions": 3},
    }
    value.update(overrides)
    return value


def receipt(*, outcome="passed", created_at=NOW):
    governed_capsule = capsule()
    return create_integrity_receipt(
        capsule=governed_capsule,
        runtime={"harness": "test", "actor": "agent:test"},
        checks=[{"name": "unit", "command": "python -m pytest", "outcome": outcome}],
        now=lambda: created_at,
    )


def test_governed_facade_returns_the_core_next_loop_decision():
    result = strato.decide_governed(request())

    assert result["schema"] == strato.DECISION_SCHEMA
    assert result["policy_version"] == strato.POLICY_VERSION
    assert result["decision"] == LOOP_DECISION["ACT"]
    assert result["reason_codes"] == []
    assert result["actor"] == {"kind": "agent", "id": "agent:test"}
    assert result["scope"] == {"project": "vivary", "paths": ["/repo/packages/strato"]}


def test_governed_facade_accepts_a_freshly_compiled_capsule():
    compiled_capsule = compile_task_capsule(
        task={
            "question": "What is the next safe loop step?",
            "scope": ["/repo/packages/strato"],
        },
        graph={
            "schema": "vivary.workspace-graph/v0",
            "observed_at": NOW,
            "allowlist": ["/repo/packages/strato"],
            "workspace_fingerprint": "sha256:test-workspace",
            "nodes": [],
            "edges": [],
            "conflicts": [],
            "unknowns": [],
            "omissions": [],
        },
    )

    result = strato.decide_governed(request(capsule=compiled_capsule))

    assert result["schema"] == strato.DECISION_SCHEMA
    assert result["decision"] == LOOP_DECISION["ACT"]


def test_governed_facade_preserves_the_core_budget_stop():
    governed = request(state={"turns_used": 3, "actions_used": 1})

    result = strato.decide_governed(governed)

    assert result["decision"] == LOOP_DECISION["STOP"]
    assert result["reason_codes"] == [LOOP_REASON["BUDGET_EXHAUSTED"]]
    assert result["budget"]["decision"] == "budget_exhausted"


def test_governed_facade_preserves_intact_and_insufficient_receipt_evidence():
    intact = strato.decide_governed(request(receipt=receipt()))
    insufficient = strato.decide_governed(request(receipt=receipt(outcome="failed")))

    assert intact["decision"] == LOOP_DECISION["STOP"]
    assert intact["reason_codes"] == [LOOP_REASON["ALL_CHECKS_CLEAR"]]
    assert insufficient["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert insufficient["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]
    assert "required_check_failed" in insufficient["gate"]["reason_codes"]


def test_governed_facade_preserves_receipt_evidence_at_the_budget_boundary():
    result = strato.decide_governed(
        request(
            receipt=receipt(outcome="failed"),
            state={"turns_used": 3, "actions_used": 1},
        )
    )

    assert result["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert result["reason_codes"] == [
        LOOP_REASON["GATE_REQUIRED"],
        LOOP_REASON["BUDGET_EXHAUSTED"],
    ]


def test_governed_facade_blocks_tampered_receipt_evidence():
    tampered = receipt()
    tampered["fingerprint"] = "sha256:tampered"

    result = strato.decide_governed(request(receipt=tampered))

    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert result["reason_codes"] == [LOOP_REASON["BLOCKED_BY_GATE"]]

def test_governed_facade_does_not_let_an_unverified_ozone_verdict_clear_a_gate():
    result = strato.decide_governed(
        request(
            receipt=receipt(),
            verdict={"outcome": "sufficient", "status": "approved"},
        )
    )

    assert result["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert result["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]
    assert result["gate"]["reason_codes"] == ["verdict_integrity_mismatch"]




def test_governed_facade_rejects_a_verdict_without_its_receipt():
    result = strato.decide_governed(request(verdict={"outcome": "sufficient"}))

    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert result["reason_codes"] == ["verdict_requires_receipt"]


@pytest.mark.parametrize(
    ("decision_at", "reason"),
    [
        ("2026-07-26T11:59:59Z", "request_from_future"),
        ("2026-07-26T12:05:01Z", "stale_request"),
    ],
)
def test_governed_facade_rejects_future_and_stale_evidence(decision_at, reason):
    result = strato.decide_governed(request(decision_at=decision_at))

    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert reason in result["reason_codes"]


@pytest.mark.parametrize(
    ("created_at", "decision_at", "reason"),
    [
        ("not-a-timestamp", NOW, "invalid_receipt_created_at"),
        ("2026-07-26T11:59:59Z", NOW, "receipt_precedes_capsule"),
        ("2026-07-26T12:00:01Z", NOW, "receipt_from_future"),
        (NOW, "2026-07-26T12:05:01Z", "stale_receipt"),
    ],
)
def test_governed_facade_rejects_invalid_or_stale_receipt_evidence(
    created_at, decision_at, reason
):
    result = strato.decide_governed(
        request(
            requested_at=decision_at,
            decision_at=decision_at,
            receipt=receipt(created_at=created_at),
        )
    )

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert reason in result["reason_codes"]


@pytest.mark.parametrize(
    ("patch", "reason"),
    [
        ({"schema": "future"}, "invalid_schema"),
        ({"policy_version": "future"}, "invalid_policy_version"),
        ({"actor": {"kind": "ghost", "id": "x"}}, "unknown_actor_kind"),
        ({"actor": {"kind": "agent", "id": "x"}, "authority_class": "owner"}, "workers_cannot_own"),
        ({"workspace": {"fingerprint": "sha256:other"}}, "workspace_mismatch"),
        ({"scope": {"project": "vivary", "paths": []}}, "invalid_scope"),
        ({"scope": {"project": "vivary", "paths": ["/other"]}}, "scope_mismatch"),
        ({"requested_at": "yesterday"}, "invalid_requested_at"),
        ({"decision_at": "yesterday"}, "invalid_decision_at"),
        ({"state": {"turns_used": -1}}, "invalid_state"),
        ({"limits": {"max_actions": True}}, "invalid_limits"),
    ],
)
def test_governed_facade_fails_closed_on_invalid_identity_and_policy_fields(patch, reason):
    result = strato.decide_governed(request(**patch))

    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert reason in result["reason_codes"]
    assert result["budget"] is None
    assert result["gate"] is None
    assert result["schema"] == strato.REFUSAL_SCHEMA


def test_status_text_cannot_satisfy_a_human_gate():
    governed = request()
    governed["status"] = "approved by human"

    result = strato.decide_governed(governed)

    assert result["decision"] == LOOP_DECISION["BLOCKED"]
    assert result["reason_codes"] == ["unknown_field:status"]


def test_governed_facade_rejects_non_string_request_keys_without_raising():
    governed = request()
    governed[1] = "not a field name"

    result = strato.decide_governed(governed)

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_field_name"]


def test_governed_facade_refuses_non_string_capsule_keys_without_raising():
    governed_capsule = capsule()
    governed_capsule["unknowns"] = [{1: "not a canonical object key"}]

    result = strato.decide_governed(request(capsule=governed_capsule))

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["capsule_fingerprint_mismatch"]


def test_governed_facade_refuses_a_self_fingerprinted_capsule_missing_its_budget():
    incomplete_capsule = capsule()
    incomplete_capsule.pop("budget")
    incomplete_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in incomplete_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    result = strato.decide_governed(request(capsule=incomplete_capsule))

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["invalid_capsule"]


@pytest.mark.parametrize(
    "lossy_value",
    [
        pytest.param(float("nan"), id="not-a-number"),
        pytest.param(float("inf"), id="infinity"),
        pytest.param(2**53, id="unsafe-integer"),
    ],
)
def test_governed_facade_refuses_lossy_capsule_values(lossy_value):
    lossy_capsule = capsule(unknowns=[{"value": lossy_value}])

    result = strato.decide_governed(request(capsule=lossy_capsule))

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["capsule_fingerprint_mismatch"]


def test_governed_facade_rejects_a_capsule_modified_after_compilation():
    governed_capsule = capsule(
        conflicts=[{"id": "conflict:review", "decision": "review_required"}]
    )
    governed_capsule["conflicts"] = []

    result = strato.decide_governed(request(capsule=governed_capsule))

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["capsule_fingerprint_mismatch"]


def test_governed_facade_rejects_a_fabricated_capsule_identifier():
    result = strato.decide_governed(
        request(capsule=capsule(capsule_id="capsule_forged"))
    )

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["capsule_fingerprint_mismatch"]


def test_human_owner_authority_alone_cannot_clear_a_capsule_gate():
    gated_capsule = capsule(
        conflicts=[{"id": "conflict:review", "decision": "review_required"}]
    )

    result = strato.decide_governed(
        request(
            actor={"kind": "human", "id": "human:owner"},
            authority_class="owner",
            capsule=gated_capsule,
        )
    )

    assert result["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert result["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]
    assert result["gate"]["reason_codes"] == ["unresolved_conflict"]


def test_scope_binding_uses_core_path_equivalence_and_rejects_an_unscoped_capsule():
    equivalent = strato.decide_governed(
        request(
            scope={
                "project": "vivary",
                "paths": [r"\repo\packages\strato"],
            }
        )
    )
    unscoped = strato.decide_governed(
        request(capsule=capsule(task={"question": "Unscoped", "scope": None}))
    )

    assert equivalent["decision"] == LOOP_DECISION["ACT"]
    assert unscoped["schema"] == strato.REFUSAL_SCHEMA
    assert unscoped["reason_codes"] == ["scope_mismatch"]


def test_same_request_returns_the_same_machine_readable_decision():
    governed = request()

    assert strato.decide_governed(governed) == strato.decide_governed(governed)


def test_cli_requires_explicit_governed_opt_in():
    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "request.json"],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 2
    assert "--governed" in result.stderr


def test_cli_reads_a_request_and_emits_one_json_decision(tmp_path):
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request()), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "--governed", "--json", str(request_path)],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout)["decision"] == LOOP_DECISION["ACT"]


@pytest.mark.parametrize(
    ("document", "reason"),
    [
        pytest.param("{", "invalid_request_document", id="truncated"),
        pytest.param(
            "[" * 100_000 + "]" * 100_000,
            "request_too_deeply_nested",
            id="deeply-nested",
        ),
    ],
)
def test_cli_reports_malformed_json_without_a_traceback(tmp_path, document, reason):
    request_path = tmp_path / "bad.json"
    request_path.write_text(document, encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "--governed", "--json", str(request_path)],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["reason_codes"] == [reason]
    assert "Traceback" not in result.stderr


def test_python_facade_rejects_recursive_evidence():
    nested = []
    for _ in range(sys.getrecursionlimit() * 2):
        nested = [nested]
    governed = request(receipt=receipt())
    governed["receipt"]["untrusted"] = nested

    result = strato.decide_governed(governed)

    assert result["schema"] == strato.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["request_too_deeply_nested"]


def test_cli_rejects_recursive_evidence_without_a_traceback(tmp_path):
    nested = []
    for _ in range(600):
        nested = [nested]
    governed = request(receipt=receipt())
    governed["receipt"]["untrusted"] = nested
    request_path = tmp_path / "recursive-receipt.json"
    request_path.write_text(json.dumps(governed), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "--governed", "--json", str(request_path)],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["reason_codes"] == ["request_too_deeply_nested"]
    assert "Traceback" not in result.stderr


def test_cli_returns_usage_failure_for_a_rejected_authority_envelope(tmp_path):
    governed = request(actor={"kind": "agent", "id": "agent:test"}, authority_class="owner")
    request_path = tmp_path / "forged-owner.json"
    request_path.write_text(json.dumps(governed), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "--governed", "--json", str(request_path)],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["reason_codes"] == ["workers_cannot_own"]
    assert json.loads(result.stdout)["schema"] == strato.REFUSAL_SCHEMA


@pytest.mark.parametrize("strict_args", [[], ["--strict"]])
def test_cli_refuses_a_malformed_capsule_envelope(tmp_path, strict_args):
    governed = request(
        capsule={
            "task": {
                "question": "Malformed capsule",
                "scope": ["/repo/packages/strato"],
            },
            "workspace": {
                "fingerprint": "sha256:test-workspace",
                "observed_at": NOW,
            },
        }
    )
    request_path = tmp_path / "malformed-capsule.json"
    request_path.write_text(json.dumps(governed), encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(PACKAGE_ROOT / "strato.py"),
            "decide",
            "--governed",
            "--json",
            *strict_args,
            str(request_path),
        ],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    outcome = json.loads(result.stdout)
    assert result.returncode == 2
    assert outcome["schema"] == strato.REFUSAL_SCHEMA
    assert outcome["reason_codes"] == ["invalid_capsule"]


def test_cli_default_output_is_a_plain_decision_summary(tmp_path):
    governed = request(actor={"kind": "agent", "id": "agent:test"}, authority_class="owner")
    request_path = tmp_path / "plain-owner-rejection.json"
    request_path.write_text(json.dumps(governed), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(PACKAGE_ROOT / "strato.py"), "decide", "--governed", str(request_path)],
        capture_output=True,
        text=True,
        check=False,
        env=CLI_ENV,
    )

    assert result.returncode == 2
    assert result.stdout == "strato decide: blocked\nreasons: workers_cannot_own\n"
    with pytest.raises(json.JSONDecodeError):
        json.loads(result.stdout)
