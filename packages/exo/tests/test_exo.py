"""Tests for the exo coordination layer. Run: python tests/test_exo.py (or pytest)."""
import contextlib
import copy
import io
import json
import math
import os
import argparse
import shutil
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import exo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))
CORE_ROOT = os.path.abspath(os.path.join(ROOT, "..", "core"))
if CORE_ROOT not in sys.path:
    sys.path.insert(0, CORE_ROOT)

from vivary_core.canonical import normalize_path  # noqa: E402
from vivary_core.capsule_compile import (  # noqa: E402
    compile_task_capsule,
    verify_task_capsule_integrity,
)
from vivary_core.receipt import create_integrity_receipt  # noqa: E402
from vivary_core.verify_receipt import verify_receipt_integrity  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-exo-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        shutil.rmtree(path)


def _vault(td):
    """Three active changes (a touches core; b touches core+api; c touches api) and
    one planned change d (touches core). a<->b share core; b<->c share api; a<->c
    share nothing; d is excluded from conflicts (not active)."""
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.change]\nfolder = "changes"\n'
        '[types.change.optional]\nstatus = "enum:active|done|planned"\n'
        'related_modules = "ref-list"\n')
    Path(td, "modules").mkdir()
    Path(td, "changes").mkdir()
    Path(td, "modules", "core.md").write_text("# Core\n")
    Path(td, "modules", "api.md").write_text("# Api\n")
    Path(td, "changes", "change-a.md").write_text(
        "---\nstatus: active\nrelated_modules: [core]\n---\n# A\n")
    Path(td, "changes", "change-b.md").write_text(
        "---\nstatus: active\nrelated_modules: [core, api]\n---\n# B\n")
    Path(td, "changes", "change-c.md").write_text(
        "---\nstatus: active\nrelated_modules: [api]\n---\n# C\n")
    Path(td, "changes", "change-d.md").write_text(
        "---\nstatus: planned\nrelated_modules: [core]\n---\n# D\n")


def _claim_vault(td, coordination=True):
    packs = 'packs = ["coordination"]\n' if coordination else ""
    Path(td, "tropo.toml").write_text(
        packs +
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.change]\nfolder = "changes"\n'
        '[types.change.optional]\nstatus = "enum:active|done|planned"\n'
        'related_modules = "ref-list"\n')
    Path(td, "modules").mkdir()
    Path(td, "changes").mkdir()
    Path(td, "modules", "core.md").write_text("# Core\n")
    Path(td, "changes", "empty.md").write_text("# Empty\n")
    Path(td, "changes", "claimed.md").write_text(
        "---\nstatus: active\nassignee: ada\nrelated_modules: [core]\n---\n# Claimed\n")
    Path(td, "changes", "status-only.md").write_text(
        "---\nstatus: active\nrelated_modules: [core]\n---\n# Status Only\n")
    Path(td, "changes", "bad.md").write_text(
        "---\nstatus: active\n# Bad\n")


def _run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = exo.main(argv)
    return rc, buf.getvalue()


def _run_json(argv):
    rc, out = _run(argv)
    return rc, json.loads(out)


def _run_exit(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            rc = exo.main(argv)
        except SystemExit as e:
            return e.code, buf.getvalue()
    return rc, buf.getvalue()


def _run_cli(argv, *, stdin_text=None):
    stdout = io.StringIO()
    stderr = io.StringIO()
    original_stdin = sys.stdin
    if stdin_text is not None:
        sys.stdin = io.StringIO(stdin_text)
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                rc = exo.main(argv)
            except SystemExit as error:
                rc = error.code
    finally:
        sys.stdin = original_stdin
    return rc, stdout.getvalue(), stderr.getvalue()


def _run_control_json(argv, *, stdin_text=None):
    rc, output, error = _run_cli(argv, stdin_text=stdin_text)
    return rc, json.loads(output), output, error


def _write_control_request(path, request):
    path.write_text(
        json.dumps(request, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _control_request(operation, state, input_value):
    return {
        "schema": exo.CONTROL_REQUEST_SCHEMA,
        "operation": operation,
        "state": state,
        "input": input_value,
    }


def _assert_control_result(value, operation):
    assert value == {
        "schema": exo.CONTROL_RESULT_SCHEMA,
        "operation": operation,
        "result": value["result"],
    }
    assert isinstance(value["result"], dict)


def _assert_control_refusal(value, reason_codes):
    assert value == {
        "schema": exo.CONTROL_REFUSAL_SCHEMA,
        "reason_codes": reason_codes,
    }


def _control_actor(identifier="ada"):
    return {"kind": "human", "id": identifier}


def _control_scope():
    return {"project": "vivary", "paths": ["src/exo"]}


def _control_smoke_requests():
    actor = _control_actor()
    task = {
        "task_id": "control-task",
        "capsule_id": "capsule-control",
        "status": "open",
    }
    return {
        "claim": _control_request(
            "claim",
            {"claims": []},
            {
                "scope": _control_scope(),
                "actor": actor,
                "now": "2026-01-01T00:00:00.000Z",
            },
        ),
        "release": _control_request(
            "release",
            {"claims": []},
            {"claim_id": "claim-missing", "actor": actor},
        ),
        "expire_leases": _control_request(
            "expire_leases",
            {"claims": []},
            {"now": "2026-01-01T00:00:00.000Z"},
        ),
        "dependencies": _control_request(
            "dependencies",
            {"tasks": [{"id": "control-task", "status": "open", "depends_on": []}]},
            {"task_id": "control-task"},
        ),
        "handoff": _control_request(
            "handoff",
            {"claims": []},
            {
                "claim_id": "claim-missing",
                "receipt": None,
                "capsule": None,
                "from_actor": actor,
                "to_actor": _control_actor("bea"),
                "workspace_revision": "sha256:control",
                "created_at": "2026-01-01T00:00:00.000Z",
            },
        ),
        "record_execution": _control_request(
            "record_execution",
            {"execution_log": []},
            {"receipt": None, "capsule": None},
        ),
        "complete": _control_request(
            "complete",
            {"task": task, "execution_log": []},
            {},
        ),
        "task_view": _control_request(
            "task_view",
            {"task": task, "execution_log": []},
            {},
        ),
    }


def _known_control_fact(value, command):
    return {"status": "known", "value": value, "evidence": {"command": command}}


def _compiled_control_capsule_and_receipt():
    root = "/synthetic-exo-control/repo"
    checkout = {
        "raw_path": root,
        "path": root,
        "status": "observed",
        "facts": {
            "is_git_repository": _known_control_fact(True, "git rev-parse --show-toplevel"),
            "worktree_root": _known_control_fact(root, "git rev-parse --show-toplevel"),
            "head_revision": _known_control_fact("0" * 40, "git rev-parse HEAD"),
            "head_ref": _known_control_fact({"kind": "branch", "name": "main"}, "git symbolic-ref --short -q HEAD"),
            "dirty_entries": _known_control_fact([], "git status --porcelain"),
            "is_dirty": _known_control_fact(False, "git status --porcelain"),
            "remotes": _known_control_fact([{"name": "origin", "fetch_url": "https://example.test/exo.git"}], "git remote -v"),
            "upstream": _known_control_fact("origin/main", "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"),
            "last_fetch": _known_control_fact("2026-01-01T00:00:00Z", "fs.stat FETCH_HEAD"),
            "workspace_markers": _known_control_fact(["tropo.toml", "AGENTS.md"], "fs.stat workspace markers"),
        },
    }
    observation = {
        "schema": "vivary.workspace-observation/v0",
        "observed_at": "2026-01-02T12:00:00Z",
        "allowlist": [root],
        "checkouts": [checkout],
        "refusals": [],
    }
    capsule = compile_task_capsule(
        task={"question": "Does governed Exo retain failed execution evidence?"},
        graph=project_workspace_graph(observation),
    )
    assert verify_task_capsule_integrity(capsule)
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "exo-contract-test", "actor": "ada"},
        checks=[
            {
                "name": check["name"],
                "command": check["command"],
                "outcome": "failed" if index == 0 else "passed",
            }
            for index, check in enumerate(capsule["required_checks"])
        ],
        now=lambda: "2026-01-02T12:10:00Z",
    )
    assert verify_receipt_integrity(receipt=receipt, capsule=capsule)["outcome"] == "verified"
    return capsule, receipt


def test_runtime_version_matches_package_manifest():
    import tomllib

    project = tomllib.loads(
        (Path(ROOT) / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]
    assert exo.__version__ == project["version"]
    assert "vivary-core>=0.2.5" in project["dependencies"]


def test_governed_control_dispatches_all_eight_exact_operations():
    for operation, request in _control_smoke_requests().items():
        before = copy.deepcopy(request)
        result = exo.governed_control(request)
        _assert_control_result(result, operation)
        assert request == before


def test_governed_control_rejects_missing_unknown_and_operation_fields_exactly():
    missing = {
        "schema": exo.CONTROL_REQUEST_SCHEMA,
        "operation": "claim",
        "state": {"claims": []},
    }
    _assert_control_refusal(
        exo.governed_control(missing),
        ["missing_field:input"],
    )

    unknown = {
        **_control_smoke_requests()["claim"],
        "authority": "smuggled",
    }
    _assert_control_refusal(
        exo.governed_control(unknown),
        ["unknown_field:authority"],
    )

    bad_operation = _control_request("schedule", {}, {})
    _assert_control_refusal(
        exo.governed_control(bad_operation),
        ["invalid_operation"],
    )


def test_governed_control_rejects_operation_specific_unknown_fields():
    request = _control_smoke_requests()["claim"]
    request["state"]["execution_log"] = []
    request["input"]["priority"] = "high"
    _assert_control_refusal(
        exo.governed_control(request),
        [
            "unknown_state_field:execution_log",
            "unknown_input_field:priority",
        ],
    )


def test_governed_control_preflight_is_cycle_safe_and_charges_aliases_per_occurrence():
    cyclic = []
    cyclic.append(cyclic)
    _assert_control_refusal(
        exo.governed_control(cyclic),
        [exo.CONTROL_REASON_UNBOUNDED],
    )

    shared = {"nested": []}
    aliased = {
        "schema": exo.CONTROL_REQUEST_SCHEMA,
        "operation": "complete",
        "state": shared,
        "input": shared,
    }
    aliased_result = exo.governed_control(aliased)
    assert aliased_result["schema"] == exo.CONTROL_REFUSAL_SCHEMA
    assert exo.CONTROL_REASON_UNBOUNDED not in aliased_result["reason_codes"]


def test_governed_control_preflight_bounds_depth_collections_strings_and_aggregate_work():
    nested = []
    for _ in range(exo.CONTROL_MAX_DEPTH + 1):
        nested = [nested]
    _assert_control_refusal(
        exo.governed_control(nested),
        [exo.CONTROL_REASON_TOO_DEEP],
    )
    _assert_control_refusal(
        exo.governed_control([None] * (exo.CONTROL_MAX_COLLECTION_LENGTH + 1)),
        [exo.CONTROL_REASON_UNBOUNDED],
    )
    _assert_control_refusal(
        exo.governed_control("x" * (exo.CONTROL_MAX_STRING_BYTES + 1)),
        [exo.CONTROL_REASON_UNBOUNDED],
    )
    aggregate = [[None] * exo.CONTROL_MAX_COLLECTION_LENGTH for _ in range(11)]
    _assert_control_refusal(
        exo.governed_control(aggregate),
        [exo.CONTROL_REASON_UNBOUNDED],
    )


def test_governed_control_rejects_noncanonical_direct_values():
    _assert_control_refusal(
        exo.governed_control(math.nan),
        [exo.CONTROL_REASON_INVALID_VALUE],
    )
    _assert_control_refusal(
        exo.governed_control(b"not-json"),
        [exo.CONTROL_REASON_INVALID_VALUE],
    )


def test_governed_lifecycle_expiry_dependencies_handoff_execution_and_completion():
    capsule, receipt = _compiled_control_capsule_and_receipt()
    actor = _control_actor()
    recipient = _control_actor("bea")

    old_claim = exo.governed_control(
        _control_request(
            "claim",
            {"claims": []},
            {
                "scope": _control_scope(),
                "actor": actor,
                "now": "2026-01-02T10:00:00Z",
                "lease": {
                    "granted_at": "2026-01-02T10:00:00Z",
                    "expires_at": "2026-01-02T11:00:00Z",
                },
            },
        )
    )["result"]
    stale = exo.governed_control(
        _control_request(
            "claim",
            {"claims": old_claim["claims"]},
            {
                "scope": {"project": "vivary", "paths": ["src/core"]},
                "actor": recipient,
                "now": "2026-01-02T12:00:00Z",
            },
        )
    )["result"]
    assert stale["reason_codes"] == ["lease_expired"]

    expired = exo.governed_control(
        _control_request(
            "expire_leases",
            {"claims": old_claim["claims"]},
            {"now": "2026-01-02T12:00:00Z"},
        )
    )["result"]
    assert expired["claims"] == []
    assert len(expired["expired"]) == 1

    fresh = exo.governed_control(
        _control_request(
            "claim",
            {"claims": expired["claims"]},
            {
                "scope": _control_scope(),
                "actor": actor,
                "now": "2026-01-02T12:00:00Z",
                "lease": {
                    "granted_at": "2026-01-02T12:00:00Z",
                    "expires_at": "2026-01-02T13:00:00Z",
                },
            },
        )
    )["result"]
    assert fresh["decision"] == "granted"

    blocked_tasks = [
        {"id": "a", "status": "open"},
        {"id": "b", "status": "open", "depends_on": ["a"]},
    ]
    blocked = exo.governed_control(
        _control_request("dependencies", {"tasks": blocked_tasks}, {"task_id": "b"})
    )["result"]
    assert blocked["decision"] == "blocked"
    ready_tasks = [{**blocked_tasks[0], "status": "done"}, blocked_tasks[1]]
    ready = exo.governed_control(
        _control_request("dependencies", {"tasks": ready_tasks}, {"task_id": "b"})
    )["result"]
    assert ready["decision"] == "ready"
    cycle = exo.governed_control(
        _control_request(
            "dependencies",
            {
                "tasks": [
                    {"id": "a", "status": "open", "depends_on": ["b"]},
                    {"id": "b", "status": "open", "depends_on": ["a"]},
                ]
            },
            {"task_id": "a"},
        )
    )["result"]
    assert cycle["reason_codes"] == ["dependency_cycle"]

    claims_before_handoff = copy.deepcopy(fresh["claims"])
    handoff = exo.governed_control(
        _control_request(
            "handoff",
            {"claims": fresh["claims"]},
            {
                "claim_id": fresh["claim"]["claim_id"],
                "receipt": receipt,
                "capsule": capsule,
                "from_actor": actor,
                "to_actor": recipient,
                "workspace_revision": capsule["workspace"]["fingerprint"],
                "created_at": "2026-01-02T12:15:00Z",
            },
        )
    )["result"]
    assert handoff["decision"] == "bound"
    assert fresh["claims"] == claims_before_handoff

    recorded = exo.governed_control(
        _control_request(
            "record_execution",
            {"execution_log": []},
            {"receipt": receipt, "capsule": capsule},
        )
    )["result"]
    assert recorded["added"]
    replay = exo.governed_control(
        _control_request(
            "record_execution",
            {"execution_log": recorded["edges"]},
            {"receipt": receipt, "capsule": capsule},
        )
    )["result"]
    assert replay["added"] == []

    conflicting = {
        **recorded["edges"][0],
        "outcome": (
            "passed"
            if recorded["edges"][0]["outcome"] == "failed"
            else "failed"
        ),
    }
    conflict = exo.governed_control(
        _control_request(
            "record_execution",
            {"execution_log": [conflicting]},
            {"receipt": receipt, "capsule": capsule},
        )
    )["result"]
    assert conflict["reason_codes"] == ["execution_edge_identity_conflict"]
    assert conflict["edges"] == [conflicting]

    completed = exo.governed_control(
        _control_request(
            "complete",
            {
                "task": {
                    "task_id": "task-204",
                    "capsule_id": capsule["capsule_id"],
                    "status": "in_progress",
                },
                "execution_log": recorded["edges"],
            },
            {},
        )
    )["result"]
    assert completed["task"]["status"] == "done"
    assert completed["view"]["has_failed_verification"] is True
    assert completed["view"]["failed_edges"]


def test_governed_complete_and_task_view_fail_closed_without_exceptions():
    malformed = _control_request(
        "complete",
        {"task": {}, "execution_log": []},
        {},
    )
    result = exo.governed_control(malformed)
    _assert_control_result(result, "complete")
    assert result["result"]["reason_codes"] == ["unknown_task_shape"]

    bad_log = _control_request(
        "task_view",
        {
            "task": {
                "task_id": "task-204",
                "capsule_id": "capsule",
                "status": "open",
            },
            "execution_log": [{}],
        },
        {},
    )
    view = exo.governed_control(bad_log)
    assert view["result"]["reason_codes"] == ["unknown_execution_log_shape"]


def test_control_cli_requires_governed_and_supports_file_stdin_json_and_strict():
    request = _control_smoke_requests()["claim"]
    with temp_workspace() as td:
        request_path = td / "request.json"
        _write_control_request(request_path, request)

        missing_gate_rc, _out, missing_gate_err = _run_cli(
            ["control", str(request_path), "--json"]
        )
        assert missing_gate_rc == 2
        assert "control requires --governed" in missing_gate_err

        rc, result, raw, error = _run_control_json(
            ["control", str(request_path), "--governed", "--json"]
        )
        assert rc == 0
        assert error == ""
        _assert_control_result(result, "claim")
        assert raw == json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"

        stdin_text = json.dumps(request, sort_keys=True, separators=(",", ":"))
        stdin_rc, stdin_result, _raw, stdin_error = _run_control_json(
            ["control", "-", "--governed", "--json"],
            stdin_text=stdin_text,
        )
        assert stdin_rc == 0
        assert stdin_error == ""
        assert stdin_result == result

        refused_path = td / "refused.json"
        _write_control_request(
            refused_path,
            _control_request(
                "release",
                {"claims": []},
                {"claim_id": "claim_missing", "actor": _control_actor()},
            ),
        )
        strict_rc, strict_result, _raw, _error = _run_control_json(
            [
                "control",
                str(refused_path),
                "--governed",
                "--json",
                "--strict",
            ]
        )
        assert strict_rc == 1
        assert strict_result["result"]["decision"] == "refused"


def test_control_cli_rejects_duplicate_keys_invalid_numbers_and_oversized_documents():
    with temp_workspace() as td:
        duplicate = td / "duplicate.json"
        duplicate.write_text(
            '{"schema":"vivary.exo-control-request/v0","schema":"vivary.exo-control-request/v0","operation":"claim","state":{"claims":[]},"input":{}}',
            encoding="utf-8",
        )
        rc, result, _raw, _error = _run_control_json(
            ["control", str(duplicate), "--governed", "--json", "--strict"]
        )
        assert rc == 1
        _assert_control_refusal(result, [exo.CONTROL_REASON_INVALID_DOCUMENT])

        invalid_number = td / "invalid-number.json"
        invalid_number.write_text("NaN", encoding="utf-8")
        rc, result, _raw, _error = _run_control_json(
            [
                "control",
                str(invalid_number),
                "--governed",
                "--json",
                "--strict",
            ]
        )
        assert rc == 1
        _assert_control_refusal(result, [exo.CONTROL_REASON_INVALID_DOCUMENT])

        oversized = td / "oversized.json"
        oversized.write_text(
            '"' + ("x" * exo.CONTROL_MAX_REQUEST_BYTES) + '"',
            encoding="utf-8",
        )
        rc, result, _raw, _error = _run_control_json(
            ["control", str(oversized), "--governed", "--json", "--strict"]
        )
        assert rc == 1
        _assert_control_refusal(result, [exo.CONTROL_REASON_TOO_LARGE])


def test_control_cli_run_receipt_is_telemetry_not_execution_evidence():
    with temp_workspace() as td:
        request_path = td / "request.json"
        _write_control_request(request_path, _control_smoke_requests()["claim"])
        telemetry = td / "runs.jsonl"
        rc, result, _raw, error = _run_control_json(
            [
                "control",
                str(request_path),
                "--governed",
                "--json",
                "--receipt",
                str(telemetry),
            ]
        )
        assert rc == 0
        assert error == ""
        _assert_control_result(result, "claim")
        record = json.loads(telemetry.read_text(encoding="utf-8").strip())
        assert record["schema"] == "vivary.run_receipt.v1"
        assert record["command"] == "control"
        assert "capsule" not in record
        assert "checks" not in record
        assert str(request_path) not in json.dumps(record, sort_keys=True)


def test_control_cli_refuses_receipts_that_could_overwrite_the_request():
    request = _control_smoke_requests()["claim"]
    with temp_workspace() as td:
        request_path = td / "request.json"
        _write_control_request(request_path, request)
        original = request_path.read_bytes()
        alias = td / "request-alias.json"
        try:
            os.link(request_path, alias)
        except (AttributeError, NotImplementedError, OSError):
            alias = None

        targets = [request_path]
        if alias is not None:
            targets.append(alias)
        for target in targets:
            rc, output, error = _run_cli(
                [
                    "control",
                    str(request_path),
                    "--governed",
                    "--json",
                    "--receipt",
                    str(target),
                ]
            )
            assert rc == 2
            assert output == ""
            assert "receipt path must not identify" in error
            assert request_path.read_bytes() == original

        missing = td / "missing-request.json"
        rc, output, error = _run_cli(
            [
                "control",
                str(missing),
                "--governed",
                "--json",
                "--receipt",
                str(missing),
            ]
        )
        assert rc == 2
        assert output == ""
        assert "receipt path must not identify" in error
        assert not missing.exists()

        real_directory = td / "real"
        alias_directory = td / "alias"
        real_directory.mkdir()
        try:
            alias_directory.symlink_to(real_directory, target_is_directory=True)
        except (AttributeError, NotImplementedError, OSError):
            alias_directory = None
        if alias_directory is not None:
            linked_request = alias_directory / "linked-request.json"
            real_receipt = real_directory / "linked-request.json"
            rc, output, error = _run_cli(
                [
                    "control",
                    str(linked_request),
                    "--governed",
                    "--json",
                    "--receipt",
                    str(real_receipt),
                ]
            )
            assert rc == 2
            assert output == ""
            assert "receipt path must not identify" in error
            assert not real_receipt.exists()

        stdin_receipt = td / "stdin-runs.jsonl"
        rc, output, error = _run_cli(
            [
                "control",
                "-",
                "--governed",
                "--json",
                "--receipt",
                str(stdin_receipt),
            ],
            stdin_text=json.dumps(request),
        )
        assert rc == 2
        assert output == ""
        assert "receipt path must not identify" in error
        assert not stdin_receipt.exists()


def _tropo_check_ok(root):
    tropo, tropo_dir = exo._load_tropo()
    resolver = tropo.ConfigResolver(str(root), tropo_dir)
    args = argparse.Namespace(paths=[], strict=False, lenient=True,
                              json=False, quiet=False)
    with contextlib.redirect_stdout(io.StringIO()):
        return tropo.cmd_check(args, resolver) == 0


def test_run_receipt_appends_jsonl_without_polluting_stdout():
    with temp_workspace() as td:
        receipt = td / "receipts" / "runs.jsonl"
        rc, data = _run_json(["roles", "--json", "--receipt", str(receipt)])

        assert rc == 0
        assert "roles" in data
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        assert record["schema"] == "vivary.run_receipt.v1"
        assert record["tool"] == "exo"
        assert record["command"] == "roles"
        assert record["exit_code"] == 0
        assert record["ok"] is True
        assert "--json" in record["flags"]
        assert "--receipt" not in record["flags"]
        assert str(td) not in json.dumps(record, sort_keys=True)


def test_malformed_receipt_flag_does_not_create_option_named_file():
    with temp_workspace() as td:
        old_cwd = os.getcwd()
        err = io.StringIO()
        try:
            os.chdir(td)
            with contextlib.redirect_stderr(err):
                code, _out = _run_exit(["roles", "--receipt", "--json"])
        finally:
            os.chdir(old_cwd)

        assert code == 2
        assert not (td / "--json").exists()
        assert "expected one argument" in err.getvalue()


def test_claim_receipt_does_not_record_agent_or_target():
    with temp_workspace() as td:
        _claim_vault(td)
        receipt = td / "runs.jsonl"
        secret_agent = "private-agent"
        secret_target = "empty"

        rc, data = _run_json([
            "claim",
            secret_target,
            "--agent",
            secret_agent,
            "--root",
            str(td),
            "--json",
            "--receipt",
            str(receipt),
        ])

        assert rc == 0
        assert data["assignee"] == secret_agent
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        serialized = json.dumps(record, sort_keys=True)
        assert record["command"] == "claim"
        assert "--agent" in record["flags"]
        assert secret_agent not in serialized
        assert secret_target not in serialized
        assert str(td) not in serialized


def test_roles_lists_seven():
    rc, data = _run_json(["roles", "--json"])
    assert rc == 0
    names = {r["role"] for r in data["roles"]}
    assert {"Orchestrator", "Builder", "Verifier", "Reviewer"} <= names
    assert len(data["roles"]) == 7


def test_board_groups_work_items_by_status():
    with temp_workspace() as td:
        _vault(td)
        _, data = _run_json(["board", "--root", str(td), "--json"])
        by_id = {i["id"]: i["status"] for i in data["items"]}
        assert by_id["change-a"] == "active"
        assert by_id["change-d"] == "planned"
        assert len(data["items"]) == 4


def test_conflicts_flags_shared_active_changes():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["conflicts", "--root", str(td), "--json"])
        assert rc == 0
        pairs = {(c["a"], c["b"]): c["shared"] for c in data["conflicts"]}
        assert pairs[("change-a", "change-b")] == ["core"]
        assert pairs[("change-b", "change-c")] == ["api"]
        assert ("change-a", "change-c") not in pairs   # disjoint targets
        assert all("change-d" not in (c["a"], c["b"]) for c in data["conflicts"])  # not active


def test_conflicts_empty_when_no_overlap():
    with temp_workspace() as td:
        # two active changes touching different modules -> no conflict
        Path(td, "tropo.toml").write_text(
            '[base]\nallow_untyped = true\n[types.change]\nfolder = "changes"\n'
            '[types.change.optional]\nstatus = "enum:active|done"\n'
            'related_modules = "string-list"\n')
        Path(td, "changes").mkdir()
        Path(td, "changes", "x.md").write_text("---\nstatus: active\n---\n# X\n")
        Path(td, "changes", "y.md").write_text("---\nstatus: active\n---\n# Y\n")
        rc, data = _run_json(["conflicts", "--root", str(td), "--json"])
        assert rc == 0
        assert data["conflicts"] == []
        assert set(data["active"]) == {"x", "y"}


def test_claim_creates_frontmatter_and_board_shows_assignee():
    with temp_workspace() as td:
        _claim_vault(td)
        rc, data = _run_json(["claim", "empty", "--agent", "@connie", "--root", str(td), "--json"])
        assert rc == 0
        assert data == {
            "id": "empty",
            "path": "changes/empty.md",
            "assignee": "connie",
            "previous_assignee": None,
            "changed": True,
        }
        text = Path(td, "changes", "empty.md").read_text()
        assert text.startswith("---\nassignee: connie\n---\n# Empty\n")
        _, board = _run_json(["board", "--root", str(td), "--json"])
        by_id = {i["id"]: i for i in board["items"]}
        assert by_id["empty"]["assignee"] == "connie"
        assert _tropo_check_ok(td)


def test_claim_updates_existing_assignee():
    with temp_workspace() as td:
        _claim_vault(td)
        rc, data = _run_json(["claim", "claimed", "--agent", "bea", "--root", str(td), "--json"])
        assert rc == 0
        assert data["previous_assignee"] == "ada"
        assert data["assignee"] == "bea"
        assert data["changed"] is True
        text = Path(td, "changes", "claimed.md").read_text()
        assert "assignee: bea\n" in text
        assert "assignee: ada\n" not in text


def test_claim_appends_to_existing_frontmatter():
    with temp_workspace() as td:
        _claim_vault(td)
        rc, data = _run_json(["claim", "status-only", "--agent", "bea", "--root", str(td), "--json"])
        assert rc == 0
        assert data["previous_assignee"] is None
        assert data["changed"] is True
        text = Path(td, "changes", "status-only.md").read_text()
        assert text.startswith("---\nstatus: active\nrelated_modules: [core]\nassignee: bea\n---\n")
        assert _tropo_check_ok(td)


def test_claim_updates_bom_prefixed_frontmatter():
    with temp_workspace() as td:
        _claim_vault(td)
        path = Path(td, "changes", "status-bom.md")
        path.write_text("\ufeff---\nstatus: active\nrelated_modules: [core]\n---\n# Status BOM\n", encoding="utf-8")
        rc, data = _run_json(["claim", "status-bom", "--agent", "connie", "--root", str(td), "--json"])
        assert rc == 0
        assert data["previous_assignee"] is None
        assert data["changed"] is True
        text = path.read_text(encoding="utf-8")
        assert text.startswith("---\nstatus: active\nrelated_modules: [core]\nassignee: connie\n---\n")
        assert text.count("---") == 2
        assert "\ufeff" not in text
        assert _tropo_check_ok(td)


def test_claim_same_assignee_is_noop():
    with temp_workspace() as td:
        _claim_vault(td)
        before = Path(td, "changes", "claimed.md").read_text()
        rc, data = _run_json(["claim", "claimed", "--agent", "ada", "--root", str(td), "--json"])
        assert rc == 0
        assert data["previous_assignee"] == "ada"
        assert data["changed"] is False
        assert Path(td, "changes", "claimed.md").read_text() == before


def test_claim_rejects_missing_non_change_invalid_and_unconfigured():
    with temp_workspace() as td:
        _claim_vault(td)
        missing, _ = _run_exit(["claim", "missing", "--agent", "connie", "--root", str(td)])
        assert "no work item with id 'missing'" in str(missing)
        non_change, _ = _run_exit(["claim", "core", "--agent", "connie", "--root", str(td)])
        assert "is not a work item under changes/" in str(non_change)
        invalid, _ = _run_exit(["claim", "empty", "--agent", "bad name", "--root", str(td)])
        assert "invalid agent handle" in str(invalid)

    with temp_workspace() as td:
        _claim_vault(td, coordination=False)
        unconfigured, _ = _run_exit(["claim", "empty", "--agent", "connie", "--root", str(td)])
        assert 'add packs = ["coordination"]' in str(unconfigured)


def test_claim_rejects_symlinked_work_item_outside_workspace():
    with temp_workspace() as td:
        _claim_vault(td)
        outside = Path(td).parent / f"outside-{uuid.uuid4().hex}.md"
        outside.write_text("# Outside\n", encoding="utf-8")
        link = Path(td, "changes", "evil.md")
        try:
            link.symlink_to(outside)
        except (AttributeError, NotImplementedError, OSError):
            outside.unlink(missing_ok=True)
            return
        try:
            blocked, _ = _run_exit(["claim", "evil", "--agent", "connie", "--root", str(td)])
            assert "refusing to claim symlinked or out-of-workspace file" in str(blocked)
            assert outside.read_text(encoding="utf-8") == "# Outside\n"
        finally:
            outside.unlink(missing_ok=True)


def test_claim_replaces_hard_link_without_mutating_outside_file():
    with temp_workspace() as td:
        _claim_vault(td)
        outside = Path(td).parent / f"outside-{uuid.uuid4().hex}.md"
        outside_text = "---\nstatus: active\nrelated_modules: [core]\n---\n# Outside\n"
        outside.write_text(outside_text, encoding="utf-8")
        linked = Path(td, "changes", "hard-link.md")
        try:
            os.link(outside, linked)
        except (AttributeError, NotImplementedError, OSError):
            outside.unlink(missing_ok=True)
            return

        try:
            rc, data = _run_json(["claim", "hard-link", "--agent", "connie", "--root", str(td), "--json"])
            assert rc == 0
            assert data["changed"] is True
            assert outside.read_text(encoding="utf-8") == outside_text
            assert "assignee: connie\n" in linked.read_text(encoding="utf-8")
        finally:
            linked.unlink(missing_ok=True)
            outside.unlink(missing_ok=True)


def test_claim_rejects_malformed_frontmatter():
    with temp_workspace() as td:
        _claim_vault(td)
        before = Path(td, "changes", "bad.md").read_text()
        malformed, _ = _run_exit(["claim", "bad", "--agent", "connie", "--root", str(td)])
        assert "malformed frontmatter" in str(malformed)
        assert Path(td, "changes", "bad.md").read_text() == before


def test_claim_rejects_bom_prefixed_malformed_frontmatter():
    with temp_workspace() as td:
        _claim_vault(td)
        path = Path(td, "changes", "bad-bom.md")
        path.write_text("\ufeff---\nstatus: active\n# Bad BOM\n", encoding="utf-8")
        before = path.read_text(encoding="utf-8")
        malformed, _ = _run_exit(["claim", "bad-bom", "--agent", "connie", "--root", str(td)])
        assert "malformed frontmatter" in str(malformed)
        assert path.read_text(encoding="utf-8") == before


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
