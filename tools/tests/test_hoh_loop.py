"""Behavior tests for the deterministic headless-loop preparation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
TEST_BOOT_ID = "00000000-0000-4000-8000-000000000001"

from hoh.protocol import (  # noqa: E402
    BudgetError,
    ClockError,
    DeadlineError,
    IterationDeadline,
    ProtocolError,
    UsageLedger,
    validate_role_request,
    validate_role_result,
    validate_evidence_record,
    validate_transition_record,
    validate_usage_record,
)
from hoh.claude import (  # noqa: E402
    ClaudeAdapter,
    ClaudePreflightError,
    normalize_claude_usage,
)
from hoh_loop import (  # noqa: E402
    EXPECTED_ORACLE_TEST_IDS,
    HeadlessLoop,
    HarnessError,
    ReceiptStore,
    RoleView,
    RunFault,
    canonical_json_bytes,
    hash_tree,
    run_owned_process,
    run_product_tests,
    sha256_bytes,
    verify_expected_red,
)


def preserved_test_dir(prefix: str) -> Path:
    root = Path("/tmp/hoh-test-artifacts")
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=root))


class ProtocolTests(unittest.TestCase):
    def test_role_request_accepts_only_the_versioned_runtime_neutral_shape(self) -> None:
        request = {
            "schema": "vivary.hoh-role-request/v1",
            "run_id": "run-001",
            "iteration": 1,
            "role": "planner",
            "prompt_bytes": 128,
            "prompt_sha256": "sha256:" + "a" * 64,
            "baseline_sha256": "sha256:" + "b" * 64,
            "candidate_sha256": "sha256:" + "c" * 64,
            "receipt_chain_head": None,
            "deadline_unix_ns": 2_000_000_000,
            "read_roots": ["specification", "public-evidence"],
            "write_root": None,
        }

        parsed = validate_role_request(request)

        self.assertEqual(parsed["role"], "planner")
        for mutation in (
            {**request, "vendor": "claude"},
            {**request, "iteration": True},
            {**request, "role": "reviewer"},
            {**request, "prompt_sha256": "not-a-hash"},
        ):
            with self.subTest(mutation=mutation):
                with self.assertRaises(ProtocolError):
                    validate_role_request(mutation)

    def test_result_evidence_and_transition_reject_stale_or_cross_run_fields(self) -> None:
        request = {
            "schema": "vivary.hoh-role-request/v1",
            "run_id": "run-001",
            "iteration": 1,
            "role": "qa",
            "prompt_bytes": 10,
            "prompt_sha256": "sha256:" + "a" * 64,
            "baseline_sha256": "sha256:" + "b" * 64,
            "candidate_sha256": "sha256:" + "c" * 64,
            "receipt_chain_head": None,
            "deadline_unix_ns": 2_000_000_000,
            "read_roots": ["candidate"],
            "write_root": None,
        }
        output = "# Evidence\n"
        usage = {
            "schema": "vivary.hoh-usage/v1",
            "vendor_usage_raw": {"source": "test-double"},
            "aggregate_input_tokens": 1,
            "aggregate_output_tokens": 1,
            "cache_read_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "budget_counted_tokens": 2,
            "claude_agentic_turns": 1,
            "codex_top_level_turns": None,
            "complete": True,
        }
        result = {
            "schema": "vivary.hoh-role-result/v1",
            "run_id": "run-001",
            "iteration": 1,
            "role": "qa",
            "request_sha256": sha256_bytes(canonical_json_bytes(request)),
            "output_kind": "evidence_report",
            "output_text": output,
            "output_sha256": sha256_bytes(output.encode()),
            "usage": usage,
            "complete": True,
        }
        self.assertEqual(validate_role_result(result, request=request)["role"], "qa")
        with self.assertRaises(ProtocolError):
            validate_role_result({**result, "run_id": "run-002"}, request=request)
        with self.assertRaises(ProtocolError):
            validate_role_result({**result, "unexpected": True}, request=request)

        evidence = {
            "schema": "vivary.hoh-evidence/v1",
            "run_id": "run-001",
            "iteration": 1,
            "candidate_sha256": request["candidate_sha256"],
            "command": ["python3", "-m", "unittest"],
            "returncode": 0,
            "output_sha256": "sha256:" + "d" * 64,
            "observations": [],
            "complete": True,
        }
        validate_evidence_record(evidence, run_id="run-001", iteration=1)
        with self.assertRaises(ProtocolError):
            validate_evidence_record(evidence, candidate_sha256="sha256:" + "e" * 64)

        transition = {
            "schema": "vivary.hoh-transition/v1",
            "run_id": "run-001",
            "iteration": 1,
            "from_stage": "planner",
            "to_stage": "developer",
            "candidate_before_sha256": "sha256:" + "a" * 64,
            "candidate_after_sha256": "sha256:" + "b" * 64,
            "prior_receipt_sha256": None,
        }
        validate_transition_record(transition)
        with self.assertRaises(ProtocolError):
            validate_transition_record({**transition, "to_stage": "qa"})

    def test_usage_ledger_refuses_unknown_or_exhausting_maxima_without_reset(self) -> None:
        ledger_path = preserved_test_dir("usage-refusal-") / "usage.json"
        ledger = UsageLedger(ledger_path, packet_budget=100)

        with self.assertRaises(BudgetError):
            ledger.reserve("unknown", None)
        first = ledger.reserve("call-1", 60)
        self.assertEqual(first["remaining"], 40)

        probe = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                "import json,sys; from hoh.protocol import UsageLedger; "
                "print(json.dumps(UsageLedger(sys.argv[1], 100).snapshot()))",
                str(ledger_path),
            ],
            env={**os.environ, "PYTHONPATH": str(ROOT / "tools")},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(json.loads(probe.stdout)["remaining"], 40)

        reopened = UsageLedger(ledger_path, packet_budget=100)
        self.assertEqual(reopened.snapshot()["remaining"], 40)
        with self.assertRaises(BudgetError):
            reopened.reserve("call-2", 41)
        self.assertNotIn("call-2", reopened.snapshot()["reservations"])

    def test_usage_settlement_counts_cache_once_and_retains_incomplete_reservation(self) -> None:
        ledger_path = preserved_test_dir("usage-settle-") / "usage.json"
        ledger = UsageLedger(ledger_path, packet_budget=100)
        ledger.reserve("complete", 40)
        complete = validate_usage_record(
            {
                "schema": "vivary.hoh-usage/v1",
                "vendor_usage_raw": {"source": "test-double"},
                "aggregate_input_tokens": 15,
                "aggregate_output_tokens": 5,
                "cache_read_input_tokens": 2,
                "cache_write_input_tokens": 3,
                "budget_counted_tokens": 20,
                "claude_agentic_turns": None,
                "codex_top_level_turns": None,
                "complete": True,
            }
        )
        ledger.settle("complete", complete)
        self.assertEqual(ledger.snapshot()["remaining"], 80)

        ledger.reserve("incomplete", 50)
        incomplete = {
            **complete,
            "aggregate_input_tokens": None,
            "aggregate_output_tokens": None,
            "budget_counted_tokens": None,
            "complete": False,
        }
        ledger.settle("incomplete", incomplete)
        snapshot = UsageLedger(ledger_path, packet_budget=100).snapshot()
        self.assertEqual(snapshot["remaining"], 30)
        self.assertEqual(snapshot["reservations"]["incomplete"]["charged"], 50)
        self.assertEqual(snapshot["reservations"]["incomplete"]["status"], "incomplete")

    def test_usage_ledger_rejects_malformed_persisted_reservations(self) -> None:
        root = preserved_test_dir("usage-corrupt-")
        valid_usage = {
            "schema": "vivary.hoh-usage/v1",
            "vendor_usage_raw": {"source": "test-double"},
            "aggregate_input_tokens": 5,
            "aggregate_output_tokens": 4,
            "cache_read_input_tokens": None,
            "cache_write_input_tokens": None,
            "budget_counted_tokens": 9,
            "claude_agentic_turns": None,
            "codex_top_level_turns": None,
            "complete": True,
        }
        invalid_reservations = {
            "negative charged": {"maximum": 10, "charged": -1, "status": "reserved", "usage": None},
            "boolean maximum": {"maximum": True, "charged": 1, "status": "reserved", "usage": None},
            "unknown field": {
                "maximum": 10,
                "charged": 10,
                "status": "reserved",
                "usage": None,
                "release": 10,
            },
            "unknown status": {"maximum": 10, "charged": 10, "status": "lost", "usage": None},
            "settled mismatch": {
                "maximum": 10,
                "charged": 8,
                "status": "settled",
                "usage": valid_usage,
            },
            "incomplete released": {
                "maximum": 10,
                "charged": 1,
                "status": "incomplete",
                "usage": {**valid_usage, "complete": False, "budget_counted_tokens": 9},
            },
        }
        for index, (label, reservation) in enumerate(invalid_reservations.items()):
            with self.subTest(label=label):
                path = root / f"usage-{index}.json"
                path.write_text(
                    json.dumps(
                        {
                            "schema": "vivary.hoh-ledger/v1",
                            "packet_budget": 100,
                            "reservations": {"call-1": reservation},
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaises(BudgetError):
                    UsageLedger(path, packet_budget=100).snapshot()

        path = root / "malformed-settlement.json"
        ledger = UsageLedger(path, packet_budget=100)
        ledger.reserve("call-1", 50)
        with self.assertRaises(ProtocolError):
            ledger.settle("call-1", {**valid_usage, "budget_counted_tokens": 8})
        self.assertEqual(ledger.snapshot()["remaining"], 50)

    def test_iteration_deadline_persists_expiry_and_refuses_clock_reversal(self) -> None:
        path = preserved_test_dir("deadline-state-") / "deadline.json"
        deadline = IterationDeadline.create(
            path,
            run_id="run-001",
            iteration=2,
            duration_seconds=3600,
            now_unix_ns=1_000_000_000,
            now_monotonic_ns=10_000_000_000,
            boot_id=TEST_BOOT_ID,
        )
        self.assertEqual(
            deadline.remaining(
                now_unix_ns=2_000_000_000,
                now_monotonic_ns=11_000_000_000,
                boot_id=TEST_BOOT_ID,
            ),
            3599.0,
        )

        resumed = IterationDeadline.resume(
            path, run_id="run-001", iteration=2, boot_id=TEST_BOOT_ID
        )
        self.assertEqual(resumed.expires_unix_ns, 3_601_000_000_000)
        with self.assertRaises(ClockError):
            resumed.remaining(
                now_unix_ns=1_999_999_999,
                now_monotonic_ns=12_000_000_000,
                boot_id=TEST_BOOT_ID,
            )
        with self.assertRaises(DeadlineError):
            IterationDeadline.create(
                path,
                run_id="run-001",
                iteration=2,
                duration_seconds=3600,
                now_unix_ns=2_000_000_000,
                now_monotonic_ns=12_000_000_000,
                boot_id=TEST_BOOT_ID,
            )

    def test_iteration_deadline_detects_masked_wall_rollback_and_boot_change(self) -> None:
        root = preserved_test_dir("deadline-clock-continuity-")
        path = root / "deadline.json"
        deadline = IterationDeadline.create(
            path,
            run_id="clock-001",
            iteration=1,
            duration_seconds=3600,
            now_unix_ns=3_600_000_000_000,
            now_monotonic_ns=10_000_000_000,
            boot_id=TEST_BOOT_ID,
        )
        with self.assertRaisesRegex(ClockError, "elapsed less time"):
            deadline.remaining(
                now_unix_ns=4_500_000_000_000,
                now_monotonic_ns=2_710_000_000_000,
                boot_id=TEST_BOOT_ID,
            )

        changed_boot = "00000000-0000-4000-8000-000000000002"
        with self.assertRaisesRegex(ClockError, "system boot"):
            IterationDeadline.resume(
                path, run_id="clock-001", iteration=1, boot_id=changed_boot
            )

    @unittest.skipIf(os.name == "nt", "process-group evidence runs in Habitat Linux")
    def test_deadline_stops_stalled_process_group_after_five_second_grace(self) -> None:
        root = preserved_test_dir("deadline-process-")
        script = root / "stall.py"
        pids = root / "pids.json"
        script.write_text(
            """\
import json, os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([
    sys.executable, "-c",
    "import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "open(os.environ['GRANDCHILD_PID'], 'w').write(str(os.getpid())); time.sleep(60)",
], env={**os.environ, "GRANDCHILD_PID": sys.argv[2]})
open(sys.argv[1], "w").write(json.dumps({"parent": os.getpid(), "child": child.pid}))
time.sleep(60)
""",
            encoding="utf-8",
        )
        grandchild_pid = root / "grandchild.pid"
        deadline = IterationDeadline.create(
            root / "deadline.json",
            run_id="stall-001",
            iteration=1,
            duration_seconds=0.2,
        )
        started = time.monotonic()

        result = run_owned_process(
            [sys.executable, str(script), str(pids), str(grandchild_pid)],
            cwd=root,
            deadline=deadline,
        )

        elapsed = time.monotonic() - started
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["forced_after_grace"])
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 6.0)
        recorded = json.loads(pids.read_text(encoding="utf-8"))
        recorded["grandchild"] = int(grandchild_pid.read_text(encoding="utf-8"))
        for pid in recorded.values():
            self.assertFalse(Path(f"/proc/{pid}").exists(), f"pid {pid} was not reaped")

    @unittest.skipIf(os.name == "nt", "process-group evidence runs in Habitat Linux")
    def test_closed_pipe_descendant_is_detected_killed_and_reaped(self) -> None:
        root = preserved_test_dir("closed-pipe-descendant-")
        script = root / "spawn-and-exit.py"
        child_pid = root / "child.pid"
        child_ready = root / "child.ready"
        script.write_text(
            """\
import os, subprocess, sys, time
child = subprocess.Popen(
    [sys.executable, "-c", "import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').write('ready'); time.sleep(60)", sys.argv[2]],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
)
stop = time.monotonic() + 2
while not os.path.exists(sys.argv[2]) and time.monotonic() < stop:
    time.sleep(0.01)
if not os.path.exists(sys.argv[2]):
    raise RuntimeError("child did not become ready")
open(sys.argv[1], "w").write(str(child.pid))
""",
            encoding="utf-8",
        )
        deadline = IterationDeadline.create(
            root / "deadline.json",
            run_id="closed-pipe-001",
            iteration=1,
            duration_seconds=30,
        )
        started = time.monotonic()

        result = run_owned_process(
            [sys.executable, str(script), str(child_pid), str(child_ready)],
            cwd=root,
            deadline=deadline,
        )

        elapsed = time.monotonic() - started
        pid = int(child_pid.read_text(encoding="utf-8"))
        self.assertFalse(result["timed_out"])
        self.assertTrue(result["orphaned_descendants"])
        self.assertTrue(result["forced_after_grace"])
        self.assertFalse(result["accepted"])
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 5.5)
        self.assertFalse(Path(f"/proc/{pid}").exists())


class FixtureContractTests(unittest.TestCase):
    EXPECTED_RED = {
        "test_links.LinkCheckTests.test_reports_missing_relative_target":
            "observation=missing-target-was-not-reported",
        "test_links.LinkCheckTests.test_rejects_parent_escape":
            "observation=parent-escape-was-accepted",
        "test_links.LinkCheckTests.test_ignores_anchor_only_target":
            "observation=anchor-only-target-was-read",
    }

    def test_starter_is_exactly_red_and_completed_copy_is_green(self) -> None:
        fixture = ROOT / "docs/product/multi-project/fixtures/hoh-loop"
        artifacts = preserved_test_dir("fixture-contract-")
        starter = artifacts / "starter"

        red = verify_expected_red(fixture, starter, self.EXPECTED_RED, timeout_seconds=10)

        self.assertEqual(set(red["failed_test_ids"]), set(self.EXPECTED_RED))
        self.assertTrue(starter.exists())
        completed = artifacts / "completed"
        completed_source = """\
from __future__ import annotations
import re
from pathlib import Path
from urllib.parse import unquote
LINK = re.compile(r"\\[[^\\]]*\\]\\(([^)]+)\\)")
def check_tree(root: Path) -> list[dict[str, str]]:
    findings = []
    root = root.resolve()
    for source in sorted(root.rglob("*.md")):
        for raw_target in LINK.findall(source.read_text(encoding="utf-8")):
            target = unquote(raw_target.strip())
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            file_target = target.split("#", 1)[0]
            if not file_target:
                continue
            resolved = (source.parent / file_target).resolve()
            record = {"source": source.relative_to(root).as_posix(), "target": target}
            if not resolved.is_relative_to(root):
                findings.append({**record, "code": "path_escape"})
            elif not resolved.is_file():
                findings.append({**record, "code": "missing_target"})
    return sorted(findings, key=lambda item: (item["source"], item["target"]))
"""
        verify_expected_red(fixture, completed, self.EXPECTED_RED, timeout_seconds=10)
        (completed / "linkcheck.py").write_text(completed_source, encoding="utf-8")

        green = run_product_tests(completed, timeout_seconds=10)

        self.assertEqual(green["returncode"], 0, green["output"])
        self.assertTrue(green["oracle_accepted"])
        self.assertTrue(completed.exists())

    def test_exit_zero_without_declared_test_ids_is_not_oracle_green(self) -> None:
        fixture = ROOT / "docs/product/multi-project/fixtures/hoh-loop"
        project = preserved_test_dir("fixture-exit-zero-") / "project"
        shutil.copytree(fixture, project)
        for path in project.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        project.chmod(0o755)
        forged = "\n".join(
            f"forged ({test_id}) ... ok" for test_id in sorted(EXPECTED_ORACLE_TEST_IDS)
        )
        (project / "linkcheck.py").write_text(
            f"import os\nprint({forged!r}, flush=True)\nos._exit(0)\n", encoding="utf-8"
        )

        result = run_product_tests(project, timeout_seconds=10)

        self.assertNotEqual(result["returncode"], 0)
        self.assertEqual(set(result["executed_test_ids"]), EXPECTED_ORACLE_TEST_IDS)
        self.assertTrue(
            result["oracle_complete"],
            {key: result.get(key) for key in ("returncode", "executed_test_ids", "timed_out", "deadline_error", "deadline_state")},
        )
        self.assertFalse(result["oracle_accepted"])

    def test_candidate_unittest_shadow_cannot_replace_trusted_parent(self) -> None:
        fixture = ROOT / "docs/product/multi-project/fixtures/hoh-loop"
        project = preserved_test_dir("fixture-unittest-shadow-") / "project"
        shutil.copytree(fixture, project)
        for path in project.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        project.chmod(0o755)
        (project / "linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        forged = "\n".join(
            f"forged ({test_id}) ... ok" for test_id in sorted(EXPECTED_ORACLE_TEST_IDS)
        )
        (project / "unittest.py").write_text(
            f"import os\nprint({forged!r}, flush=True)\nos._exit(0)\n", encoding="utf-8"
        )

        result = run_product_tests(project, timeout_seconds=10)

        self.assertEqual(result["returncode"], 0, result["output"])
        self.assertEqual(set(result["executed_test_ids"]), EXPECTED_ORACLE_TEST_IDS)
        self.assertTrue(result["oracle_accepted"])

    @unittest.skipIf(os.name == "nt", "process-group evidence runs in Habitat Linux")
    def test_timeout_mode_reaps_a_stalled_candidate_child(self) -> None:
        fixture = ROOT / "docs/product/multi-project/fixtures/hoh-loop"
        project = preserved_test_dir("fixture-stalled-child-") / "project"
        shutil.copytree(fixture, project)
        for path in project.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        candidate_pid = project.parent / "candidate.pid"
        (project / "linkcheck.py").write_text(
            """\
import os
import signal
import time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(os.environ["HOH_STALL_PID"]).write_text(str(os.getpid()), encoding="utf-8")
time.sleep(60)
""",
            encoding="utf-8",
        )
        prior = os.environ.get("HOH_STALL_PID")
        os.environ["HOH_STALL_PID"] = str(candidate_pid)
        started = time.monotonic()
        try:
            result = run_product_tests(project, timeout_seconds=1.0)
        finally:
            if prior is None:
                os.environ.pop("HOH_STALL_PID", None)
            else:
                os.environ["HOH_STALL_PID"] = prior

        elapsed = time.monotonic() - started
        pid = int(candidate_pid.read_text(encoding="utf-8"))
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["cleanup_confirmed"])
        self.assertTrue(result["forced_after_grace"])
        self.assertFalse(result["oracle_accepted"])
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 6.0)
        self.assertFalse(Path(f"/proc/{pid}").exists())


class RoleViewAndReceiptTests(unittest.TestCase):
    def test_role_views_refuse_undeclared_paths_links_processes_shell_and_writes(self) -> None:
        root = preserved_test_dir("role-view-")
        public = root / "public"
        public.mkdir()
        (public / "spec.md").write_text("# Public\n", encoding="utf-8")
        candidate = root / "candidate.py"
        candidate.write_text("VALUE = 1\n", encoding="utf-8")
        canary = root / "credential-canary"
        canary.write_text("never-visible\n", encoding="utf-8")

        planner = RoleView.materialize(
            root / "planner",
            role="planner",
            sources={"specification": public},
            writable_root=None,
        )
        self.assertEqual(planner.read_text("specification/spec.md"), "# Public\n")
        for operation in (
            lambda: planner.read_text("candidate/candidate.py"),
            lambda: planner.read_text("../credential-canary"),
            lambda: planner.write_text("specification/spec.md", "changed"),
            lambda: planner.environment("SECRET"),
            lambda: planner.process_file("self/environ"),
            lambda: planner.shell("cat /proc/self/environ"),
        ):
            with self.subTest(operation=operation):
                with self.assertRaises((PermissionError, FileNotFoundError)):
                    operation()

        qa = RoleView.materialize(
            root / "qa",
            role="qa",
            sources={"candidate": candidate},
            writable_root=None,
        )
        with self.assertRaises(PermissionError):
            qa.write_text("candidate/candidate.py", "VALUE = 2\n")

        linked = root / "linked"
        linked.mkdir()
        try:
            (linked / "canary-link").symlink_to(canary)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        with self.assertRaises(HarnessError):
            RoleView.materialize(
                root / "linked-view",
                role="planner",
                sources={"specification": linked},
                writable_root=None,
            )

    def test_receipts_are_immutable_hash_chained_and_reopenable(self) -> None:
        root = preserved_test_dir("receipt-chain-")
        bindings = {
            "baseline_sha256": "sha256:" + "a" * 64,
            "baseline_commit": "a" * 40,
            "baseline_tree": "b" * 40,
            "specification_sha256": "sha256:" + "b" * 64,
            "oracle_sha256": "sha256:" + "c" * 64,
            "prompt_sha256": {
                "planner": "sha256:" + "d" * 64,
                "developer": "sha256:" + "e" * 64,
                "qa": "sha256:" + "f" * 64,
            },
            "iteration": 1,
            "candidate_sha256": "sha256:" + "1" * 64,
            "prior_receipt_sha256": None,
        }
        store = ReceiptStore(root, "run-001")
        first = store.append(
            {
                "run_id": "run-001",
                "iteration": 1,
                "stage": "planner",
                "status": "complete",
                "bindings": bindings,
                "details": {"observation": "planned"},
            }
        )
        second = store.append(
            {
                "run_id": "run-001",
                "iteration": 1,
                "stage": "developer",
                "status": "complete",
                "bindings": {**bindings, "prior_receipt_sha256": first["sha256"]},
                "details": {"observation": "changed"},
            }
        )
        self.assertEqual(second["record"]["prior_receipt_sha256"], first["sha256"])
        self.assertIn(second["sha256"], (root / "index.md").read_text(encoding="utf-8"))
        self.assertEqual(ReceiptStore(root, "run-001").head, second["sha256"])

        first["path"].chmod(0o644)
        first["path"].write_text("{}\n", encoding="utf-8")
        with self.assertRaises(HarnessError):
            ReceiptStore(root, "run-001")

    def test_interrupted_receipt_write_keeps_last_committed_head(self) -> None:
        root = preserved_test_dir("receipt-interrupted-")
        bindings = {
            "baseline_sha256": "sha256:" + "a" * 64,
            "baseline_commit": "a" * 40,
            "baseline_tree": "b" * 40,
            "specification_sha256": "sha256:" + "b" * 64,
            "oracle_sha256": "sha256:" + "c" * 64,
            "prompt_sha256": {
                "planner": "sha256:" + "d" * 64,
                "developer": "sha256:" + "e" * 64,
                "qa": "sha256:" + "f" * 64,
            },
            "iteration": 1,
            "candidate_sha256": "sha256:" + "1" * 64,
            "prior_receipt_sha256": None,
        }
        store = ReceiptStore(root, "run-001")
        first = store.append(
            {
                "run_id": "run-001",
                "iteration": 1,
                "stage": "planner",
                "status": "complete",
                "bindings": bindings,
                "details": {"observation": "planned"},
            }
        )

        def interrupted(path: Path, raw: bytes) -> None:
            path.write_bytes(raw[:9])
            raise OSError("simulated interrupted write")

        store._write_receipt_temporary = interrupted
        with self.assertRaisesRegex(OSError, "simulated interrupted write"):
            store.append(
                {
                    "run_id": "run-001",
                    "iteration": 1,
                    "stage": "developer",
                    "status": "complete",
                    "bindings": {**bindings, "prior_receipt_sha256": first["sha256"]},
                    "details": {"observation": "changed"},
                }
            )
        unrelated = root / "details/.receipt-unrelated.tmp"
        unrelated.write_text("unrelated", encoding="utf-8")

        reopened = ReceiptStore(root, "run-001")

        self.assertEqual(reopened.head, first["sha256"])
        self.assertEqual(len(list((root / "details").glob("*.json"))), 1)
        self.assertTrue(unrelated.is_file())

    def test_interrupted_index_write_is_rebuilt_from_committed_receipts(self) -> None:
        root = preserved_test_dir("index-interrupted-")
        bindings = {
            "baseline_sha256": "sha256:" + "a" * 64,
            "baseline_commit": "a" * 40,
            "baseline_tree": "b" * 40,
            "specification_sha256": "sha256:" + "b" * 64,
            "oracle_sha256": "sha256:" + "c" * 64,
            "prompt_sha256": {
                "planner": "sha256:" + "d" * 64,
                "developer": "sha256:" + "e" * 64,
                "qa": "sha256:" + "f" * 64,
            },
            "iteration": 1,
            "candidate_sha256": "sha256:" + "1" * 64,
            "prior_receipt_sha256": None,
        }
        store = ReceiptStore(root, "run-001")
        first = store.append(
            {
                "run_id": "run-001",
                "iteration": 1,
                "stage": "planner",
                "status": "complete",
                "bindings": bindings,
                "details": {"observation": "planned"},
            }
        )

        def interrupted(path: Path, raw: bytes) -> None:
            path.write_bytes(raw[:9])
            raise OSError("simulated interrupted index write")

        store._write_index_temporary = interrupted
        with self.assertRaisesRegex(OSError, "simulated interrupted index write"):
            store.append(
                {
                    "run_id": "run-001",
                    "iteration": 1,
                    "stage": "developer",
                    "status": "complete",
                    "bindings": {**bindings, "prior_receipt_sha256": first["sha256"]},
                    "details": {"observation": "changed"},
                }
            )
        unrelated = root / ".index.md-unrelated.tmp"
        unrelated.write_text("unrelated", encoding="utf-8")
        committed = sorted((root / "details").glob("*.json"))[-1]
        committed_head = sha256_bytes(committed.read_bytes())

        reopened = ReceiptStore(root, "run-001")

        self.assertEqual(reopened.head, committed_head)
        self.assertIn(committed_head, (root / "index.md").read_text(encoding="utf-8"))
        self.assertTrue(unrelated.is_file())


class DeterministicRoleAdapter:
    def __init__(self, *, completed_developer: bool = False):
        self.calls: list[tuple[int, str]] = []
        self.completed_developer = completed_developer

    def maximum_charge(self, _role: str) -> int:
        return 10

    def invoke(self, request, _prompt, view, _deadline):
        role = request["role"]
        iteration = request["iteration"]
        self.calls.append((iteration, role))
        if role == "planner":
            with self._must_refuse():
                view.read_text("candidate/linkcheck.py")
            output = f"## Project Planner Priorities\nIteration {iteration}\n"
        elif role == "developer":
            current = view.read_text("candidate/linkcheck.py")
            if self.completed_developer:
                output_source = current + f"\n# verified iteration {iteration}\n"
            else:
                output_source = self._source_for_iteration(iteration)
            view.write_text("candidate/linkcheck.py", output_source)
            output = f"Developer changed fixture behavior for iteration {iteration}.\n"
        else:
            with self._must_refuse():
                view.write_text("candidate/linkcheck.py", "changed")
            output = f"# Evidence report\nIteration {iteration} assessed from deterministic output.\n"
        usage = {
            "schema": "vivary.hoh-usage/v1",
            "vendor_usage_raw": {"source": "deterministic-role-double"},
            "aggregate_input_tokens": 1,
            "aggregate_output_tokens": 1,
            "cache_read_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "budget_counted_tokens": 2,
            "claude_agentic_turns": None,
            "codex_top_level_turns": None,
            "complete": True,
        }
        return {
            "schema": "vivary.hoh-role-result/v1",
            "run_id": request["run_id"],
            "iteration": iteration,
            "role": role,
            "request_sha256": sha256_bytes(canonical_json_bytes(request)),
            "output_kind": {
                "planner": "development_document",
                "developer": "developer_report",
                "qa": "evidence_report",
            }[role],
            "output_text": output,
            "output_sha256": sha256_bytes(output.encode()),
            "usage": usage,
            "complete": True,
        }

    class _must_refuse:
        def __enter__(self):
            return self

        def __exit__(self, error_type, _error, _traceback):
            if error_type is None or not issubclass(error_type, (PermissionError, FileNotFoundError)):
                raise AssertionError("role view unexpectedly allowed forbidden operation")
            return True

    @staticmethod
    def _source_for_iteration(iteration: int) -> str:
        common = """\
from __future__ import annotations
import re
from pathlib import Path
from urllib.parse import unquote
LINK = re.compile(r"\\[[^\\]]*\\]\\(([^)]+)\\)")
def check_tree(root: Path) -> list[dict[str, str]]:
    findings = []
    root = root.resolve()
    for source in sorted(root.rglob("*.md")):
        for raw_target in LINK.findall(source.read_text(encoding="utf-8")):
            target = unquote(raw_target.strip())
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            file_target = target.split("#", 1)[0]
"""
        anchor = "" if iteration >= 3 else """\
            if not file_target:
                findings.append({"source": source.relative_to(root).as_posix(), "target": target, "code": "missing_target"})
                continue
"""
        missing = """\
            if not file_target:
                continue
            resolved = (source.parent / file_target).resolve()
            record = {"source": source.relative_to(root).as_posix(), "target": target}
"""
        escape = (
            """\
            if not resolved.is_relative_to(root):
                findings.append({**record, "code": "path_escape"})
            elif not resolved.is_file():
                findings.append({**record, "code": "missing_target"})
"""
            if iteration >= 2
            else """\
            if resolved.is_relative_to(root) and not resolved.is_file():
                findings.append({**record, "code": "missing_target"})
"""
        )
        return common + anchor + missing + escape + "    return sorted(findings, key=lambda item: (item['source'], item['target']))\n"


class RetryOnceAdapter(DeterministicRoleAdapter):
    def __init__(self, *, completed_developer: bool = False):
        super().__init__(completed_developer=completed_developer)
        self.retried = False

    def invoke(self, request, prompt, view, deadline):
        result = super().invoke(request, prompt, view, deadline)
        if request["role"] == "planner" and not self.retried:
            self.retried = True
            return {**result, "unknown": "schema violation"}
        return result


class StaleResultAdapter(DeterministicRoleAdapter):
    def invoke(self, request, prompt, view, deadline):
        result = super().invoke(request, prompt, view, deadline)
        if request["role"] == "planner":
            return {**result, "run_id": "stale-run"}
        return result


class InvalidMutatingDeveloperAdapter(DeterministicRoleAdapter):
    def invoke(self, request, prompt, view, deadline):
        result = super().invoke(request, prompt, view, deadline)
        if request["role"] == "developer":
            return {**result, "unexpected": "invalid after mutation"}
        return result


class UnknownMaximumAdapter:
    def __init__(self):
        self.invoked = False

    def maximum_charge(self, _role):
        return None

    def invoke(self, *_args):
        self.invoked = True
        raise AssertionError("unknown maximum must refuse before adapter invocation")


class StallingPlannerAdapter(DeterministicRoleAdapter):
    def __init__(self):
        super().__init__()
        self.recorded_pids: list[int] = []

    def invoke(self, request, _prompt, view, deadline):
        self.calls.append((request["iteration"], request["role"]))
        if request["role"] != "planner":
            raise AssertionError("deadline failure must prevent the next role")
        root = preserved_test_dir("sequencer-stall-child-")
        script = root / "stall.py"
        pids = root / "pids.json"
        grandchild = root / "grandchild.pid"
        script.write_text(
            """\
import json, os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([
    sys.executable, "-c",
    "import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "open(os.environ['GRANDCHILD_PID'], 'w').write(str(os.getpid())); time.sleep(60)",
], env={**os.environ, "GRANDCHILD_PID": sys.argv[2]})
open(sys.argv[1], "w").write(json.dumps({"parent": os.getpid(), "child": child.pid}))
time.sleep(60)
""",
            encoding="utf-8",
        )
        process = run_owned_process(
            [sys.executable, str(script), str(pids), str(grandchild)],
            cwd=view.root,
            deadline=deadline,
        )
        recorded = json.loads(pids.read_text(encoding="utf-8"))
        self.recorded_pids = [*recorded.values(), int(grandchild.read_text(encoding="utf-8"))]
        output = "late planner output"
        usage = {
            "schema": "vivary.hoh-usage/v1",
            "vendor_usage_raw": {"source": "stalled-double", "process": process},
            "aggregate_input_tokens": None,
            "aggregate_output_tokens": None,
            "cache_read_input_tokens": None,
            "cache_write_input_tokens": None,
            "budget_counted_tokens": None,
            "claude_agentic_turns": None,
            "codex_top_level_turns": None,
            "complete": False,
        }
        return {
            "schema": "vivary.hoh-role-result/v1",
            "run_id": request["run_id"],
            "iteration": request["iteration"],
            "role": request["role"],
            "request_sha256": sha256_bytes(canonical_json_bytes(request)),
            "output_kind": "development_document",
            "output_text": output,
            "output_sha256": sha256_bytes(output.encode()),
            "usage": usage,
            "complete": False,
        }


class OverrunAdapter(DeterministicRoleAdapter):
    def invoke(self, request, prompt, view, deadline):
        result = super().invoke(request, prompt, view, deadline)
        result["usage"] = {
            **result["usage"],
            "aggregate_input_tokens": 6,
            "aggregate_output_tokens": 5,
            "budget_counted_tokens": 11,
        }
        return result


class OrdinaryRegressionAdapter(DeterministicRoleAdapter):
    def __init__(self):
        super().__init__(completed_developer=True)

    def invoke(self, request, prompt, view, deadline):
        if request["role"] == "developer" and request["iteration"] == 2:
            self.completed_developer = False
            result = super().invoke(request, prompt, view, deadline)
            self.completed_developer = True
            return result
        return super().invoke(request, prompt, view, deadline)


class FixedInputMutationAdapter(DeterministicRoleAdapter):
    def __init__(self, specification: Path):
        super().__init__()
        self.specification = specification

    def invoke(self, request, prompt, view, deadline):
        result = super().invoke(request, prompt, view, deadline)
        if request["role"] == "planner":
            self.specification.write_text("# Mutated specification\n", encoding="utf-8")
        return result


class NoProgressAdapter(DeterministicRoleAdapter):
    def __init__(self):
        super().__init__(completed_developer=True)

    def invoke(self, request, prompt, view, deadline):
        if request["role"] != "developer":
            return super().invoke(request, prompt, view, deadline)
        original = view.read_text("candidate/linkcheck.py")
        result = super().invoke(request, prompt, view, deadline)
        view.write_text("candidate/linkcheck.py", original)
        return result


class SequencerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = preserved_test_dir("sequencer-")
        self.fixture = ROOT / "docs/product/multi-project/fixtures/hoh-loop"
        self.prompts = ROOT / "tools/hoh/prompts"

    def _project(self, name: str) -> Path:
        destination = self.root / name
        shutil.copytree(self.fixture, destination)
        for path in destination.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        destination.chmod(0o755)
        return destination

    def _loop(self, name: str, project: Path, adapter: DeterministicRoleAdapter, iterations: int = 1) -> HeadlessLoop:
        return HeadlessLoop(
            project=project,
            receipt_dir=self.root / f"{name}-receipts",
            prompt_dir=self.prompts,
            run_id=name,
            iterations=iterations,
            iteration_timeout_seconds=60,
            reported_token_budget=1000,
            usage_ledger=self.root / f"{name}-usage.json",
            adapter=adapter,
        )

    def _interrupted_after_developer(self, name: str) -> tuple[Path, Path, Path]:
        project = self._project(f"{name}-project")
        project.joinpath("linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        adapter = DeterministicRoleAdapter(completed_developer=True)
        loop = self._loop(name, project, adapter)
        result = loop.run(RunFault(interrupt_after_developer=True))
        self.assertEqual(result["status"], "interrupted")
        return project, self.root / f"{name}-receipts", self.root / f"{name}-usage.json"

    def test_three_iterations_preserve_order_bindings_and_reach_green(self) -> None:
        project = self._project("healthy-project")
        adapter = DeterministicRoleAdapter()
        loop = self._loop("healthy", project, adapter, iterations=3)

        result = loop.run()

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            adapter.calls,
            [(1, "planner"), (1, "developer"), (1, "qa"),
             (2, "planner"), (2, "developer"), (2, "qa"),
             (3, "planner"), (3, "developer"), (3, "qa")],
        )
        self.assertEqual(run_product_tests(project, timeout_seconds=10)["returncode"], 0)
        details = sorted((self.root / "healthy-receipts/details").glob("*.json"))
        self.assertGreaterEqual(len(details), 12)
        for path in details:
            payload = json.loads(path.read_text(encoding="utf-8"))["payload"]
            self.assertEqual(payload["bindings"]["baseline_sha256"], loop.baseline_sha256)
            self.assertEqual(payload["bindings"]["baseline_commit"], loop.baseline_commit)
            self.assertEqual(payload["bindings"]["baseline_tree"], loop.baseline_tree)
            self.assertEqual(payload["bindings"]["specification_sha256"], loop.common["specification_sha256"])
            self.assertEqual(payload["bindings"]["oracle_sha256"], loop.common["oracle_sha256"])
            if payload["stage"] in {"planner", "developer", "qa"} and payload["status"] == "complete":
                request = payload["details"]["role_request"]
                self.assertGreater(request["prompt_bytes"], 0)
                self.assertTrue(request["prompt_sha256"].startswith("sha256:"))
                opened = payload["details"]["opened_receipt_files"]
                self.assertIn("receipts/index.md", opened)
                self.assertTrue(any(name.startswith("receipts/details/") for name in opened))

    def test_new_baseline_refuses_dirty_staged_untracked_and_ignored_files(self) -> None:
        for kind in ("dirty", "staged", "untracked", "ignored"):
            with self.subTest(kind=kind):
                project = self._project(f"baseline-{kind}-project")
                if kind == "ignored":
                    project.joinpath(".gitignore").write_text("ignored.tmp\n", encoding="utf-8")
                subprocess.run(["git", "init", "-q"], cwd=project, check=True)
                subprocess.run(["git", "add", "-A"], cwd=project, check=True)
                subprocess.run(
                    [
                        "git",
                        "-c",
                        "user.name=baseline-test",
                        "-c",
                        "user.email=baseline@example.invalid",
                        "commit",
                        "-q",
                        "-m",
                        "baseline",
                    ],
                    cwd=project,
                    check=True,
                )
                if kind in {"dirty", "staged"}:
                    project.joinpath("linkcheck.py").write_text("changed\n", encoding="utf-8")
                    if kind == "staged":
                        subprocess.run(["git", "add", "linkcheck.py"], cwd=project, check=True)
                elif kind == "untracked":
                    project.joinpath("untracked.txt").write_text("untracked\n", encoding="utf-8")
                else:
                    project.joinpath("ignored.tmp").write_text("ignored\n", encoding="utf-8")
                adapter = DeterministicRoleAdapter()
                loop = self._loop(f"baseline-{kind}", project, adapter)

                with self.assertRaisesRegex(HarnessError, "clean Git worktree"):
                    loop.run()

                self.assertEqual(adapter.calls, [])
                self.assertFalse(loop.baseline_path.exists())

    def test_one_schema_retry_is_allowed_and_a_maximum_is_required_before_invocation(self) -> None:
        retry_project = self._project("retry-project")
        (retry_project / "linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        retry = RetryOnceAdapter(completed_developer=True)
        result = self._loop("retry", retry_project, retry).run()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(retry.calls[:2], [(1, "planner"), (1, "planner")])
        self.assertEqual(len(retry.calls), 4)

        refusal_project = self._project("refusal-project")
        refusal = UnknownMaximumAdapter()
        with self.assertRaises(BudgetError):
            self._loop("refusal", refusal_project, refusal).run()
        self.assertFalse(refusal.invoked)
        self.assertEqual(
            UsageLedger(self.root / "refusal-usage.json", packet_budget=1000).snapshot()["charged"],
            0,
        )

    def test_stale_result_cannot_release_reserved_budget_before_retry(self) -> None:
        project = self._project("stale-result-project")
        adapter = StaleResultAdapter()
        ledger_path = self.root / "stale-result-usage.json"
        loop = HeadlessLoop(
            project=project,
            receipt_dir=self.root / "stale-result-receipts",
            prompt_dir=self.prompts,
            run_id="stale-result",
            iterations=1,
            iteration_timeout_seconds=60,
            reported_token_budget=10,
            usage_ledger=ledger_path,
            adapter=adapter,
        )

        with self.assertRaisesRegex(BudgetError, "maximum exceeds"):
            loop.run()

        self.assertEqual(adapter.calls, [(1, "planner")])
        reservation = UsageLedger(ledger_path, packet_budget=10).snapshot()["reservations"][
            "stale-result-1-planner-1"
        ]
        self.assertEqual(reservation["status"], "incomplete")
        self.assertEqual(reservation["charged"], reservation["maximum"])

    def test_invalid_mutating_developer_attempt_is_not_retried_or_exported(self) -> None:
        project = self._project("invalid-developer-project")
        original = project.joinpath("linkcheck.py").read_bytes()
        adapter = InvalidMutatingDeveloperAdapter()
        ledger_path = self.root / "invalid-developer-usage.json"

        with self.assertRaisesRegex(HarnessError, "mutated its writable projection"):
            self._loop("invalid-developer", project, adapter).run()

        self.assertEqual(adapter.calls, [(1, "planner"), (1, "developer")])
        self.assertEqual(project.joinpath("linkcheck.py").read_bytes(), original)
        reservation = UsageLedger(ledger_path, packet_budget=1000).snapshot()["reservations"][
            "invalid-developer-1-developer-1"
        ]
        self.assertEqual(reservation["status"], "incomplete")
        self.assertEqual(reservation["charged"], reservation["maximum"])

    def test_overrun_stops_before_next_role_and_final_red_stays_failed_after_reopen(self) -> None:
        overrun_project = self._project("overrun-project")
        overrun = OverrunAdapter()
        with self.assertRaisesRegex(HarnessError, "exceeded or corrupted"):
            self._loop("overrun", overrun_project, overrun).run()
        self.assertEqual(overrun.calls, [(1, "planner")])
        reservation = UsageLedger(
            self.root / "overrun-usage.json", packet_budget=1000
        ).snapshot()["reservations"]["overrun-1-planner-1"]
        self.assertEqual(reservation["status"], "overrun")
        self.assertEqual(reservation["charged"], 11)

        red_project = self._project("final-red-project")
        red_adapter = DeterministicRoleAdapter()
        with self.assertRaisesRegex(HarnessError, "final candidate"):
            self._loop("final-red", red_project, red_adapter).run()
        first_calls = list(red_adapter.calls)
        self.assertEqual(first_calls, [(1, "planner"), (1, "developer"), (1, "qa")])
        reopened = DeterministicRoleAdapter()
        with self.assertRaisesRegex(HarnessError, "terminal failed run"):
            self._loop("final-red", red_project, reopened).run()
        self.assertEqual(reopened.calls, [])

    def test_ordinary_loss_of_previously_passing_behavior_stops_as_regression(self) -> None:
        project = self._project("ordinary-regression-project")
        (project / "linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        adapter = OrdinaryRegressionAdapter()

        result = self._loop("ordinary-regression", project, adapter, iterations=2).run()

        self.assertEqual(result["status"], "regressed")
        self.assertIn(
            "test_links.LinkCheckTests.test_ignores_anchor_only_target",
            result["lost_passing_test_ids"],
        )
        self.assertEqual(adapter.calls[-1], (2, "qa"))

    def test_fixed_inputs_are_rechecked_after_each_role_before_settlement(self) -> None:
        project = self._project("fixed-input-project")
        adapter = FixedInputMutationAdapter(project / "spec.md")

        with self.assertRaisesRegex(HarnessError, "specification, oracle, or role prompt"):
            self._loop("fixed-input", project, adapter).run()

        self.assertEqual(adapter.calls, [(1, "planner")])
        ledger = UsageLedger(self.root / "fixed-input-usage.json", packet_budget=1000).snapshot()
        reservation = ledger["reservations"]["fixed-input-1-planner-1"]
        self.assertEqual(reservation["status"], "incomplete")
        self.assertEqual(reservation["charged"], reservation["maximum"])

    def test_two_consecutive_iterations_without_candidate_progress_stop(self) -> None:
        project = self._project("no-progress-project")
        (project / "linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        adapter = NoProgressAdapter()

        with self.assertRaisesRegex(HarnessError, "two consecutive iterations"):
            self._loop("no-progress", project, adapter, iterations=3).run()

        self.assertEqual(adapter.calls[-1], (3, "qa"))

    @unittest.skipIf(os.name == "nt", "process-group evidence runs in Habitat Linux")
    def test_stalled_role_retains_reservation_writes_incomplete_receipt_and_deadline_on_restart(self) -> None:
        project = self._project("stalled-project")
        adapter = StallingPlannerAdapter()
        loop = HeadlessLoop(
            project=project,
            receipt_dir=self.root / "stalled-receipts",
            prompt_dir=self.prompts,
            run_id="stalled",
            iterations=1,
            iteration_timeout_seconds=1.5,
            reported_token_budget=100,
            usage_ledger=self.root / "stalled-usage.json",
            adapter=adapter,
        )
        with self.assertRaisesRegex(HarnessError, "after the iteration deadline"):
            loop.run()
        self.assertEqual(adapter.calls, [(1, "planner")])
        self.assertEqual(len(adapter.recorded_pids), 3)
        for pid in adapter.recorded_pids:
            self.assertFalse(Path(f"/proc/{pid}").exists(), f"pid {pid} was not reaped")
        ledger = UsageLedger(self.root / "stalled-usage.json", packet_budget=100).snapshot()
        self.assertEqual(ledger["charged"], 10)
        reservation = ledger["reservations"]["stalled-1-planner-1"]
        self.assertEqual(reservation["status"], "incomplete")
        self.assertEqual(reservation["charged"], reservation["maximum"])
        receipts = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((self.root / "stalled-receipts/details").glob("*.json"))]
        self.assertEqual(receipts[-1]["payload"]["status"], "incomplete")
        deadline_path = self.root / "stalled-receipts/iteration-1-deadline.json"
        original_expiry = json.loads(deadline_path.read_text(encoding="utf-8"))["expires_unix_ns"]

        restarted = StallingPlannerAdapter()
        with self.assertRaises(DeadlineError):
            HeadlessLoop(
                project=project,
                receipt_dir=self.root / "stalled-receipts",
                prompt_dir=self.prompts,
                run_id="stalled",
                iterations=1,
                iteration_timeout_seconds=1.5,
                reported_token_budget=100,
                usage_ledger=self.root / "stalled-usage.json",
                adapter=restarted,
            ).run()
        self.assertEqual(restarted.calls, [])
        self.assertEqual(json.loads(deadline_path.read_text(encoding="utf-8"))["expires_unix_ns"], original_expiry)

    def test_resume_after_developer_checkpoint_does_not_rerun_developer(self) -> None:
        project = self._project("resume-project")
        (project / "linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        first_adapter = DeterministicRoleAdapter(completed_developer=True)
        first = self._loop("resume", project, first_adapter)
        interrupted = first.run(RunFault(interrupt_after_developer=True))
        self.assertEqual(interrupted["status"], "interrupted")
        self.assertEqual(first_adapter.calls, [(1, "planner"), (1, "developer")])
        original_expiry = json.loads(
            (self.root / "resume-receipts/iteration-1-deadline.json").read_text(encoding="utf-8")
        )["expires_unix_ns"]

        resumed_adapter = DeterministicRoleAdapter(completed_developer=True)
        resumed = self._loop("resume", project, resumed_adapter).run()

        self.assertEqual(resumed["status"], "complete")
        self.assertEqual(resumed_adapter.calls, [(1, "qa")])
        self.assertEqual(
            json.loads((self.root / "resume-receipts/iteration-1-deadline.json").read_text(encoding="utf-8"))["expires_unix_ns"],
            original_expiry,
        )

    def test_resume_refuses_changed_or_missing_developer_artifacts(self) -> None:
        cases = (
            ("changed-development", "iteration-1-development.md", "change"),
            ("missing-development", "iteration-1-development.md", "remove"),
            ("changed-report", "iteration-1-developer.md", "change"),
            ("missing-report", "iteration-1-developer.md", "remove"),
        )
        for suffix, name, operation in cases:
            with self.subTest(artifact=suffix):
                run_id = f"resume-artifact-{suffix}"
                project, receipts, _ledger = self._interrupted_after_developer(run_id)
                artifact = receipts / "documents" / name
                if operation == "change":
                    artifact.write_text("altered after checkpoint\n", encoding="utf-8")
                else:
                    artifact.unlink()
                adapter = DeterministicRoleAdapter(completed_developer=True)

                with self.assertRaisesRegex(HarnessError, "development document|developer report"):
                    self._loop(run_id, project, adapter).run()

                self.assertEqual(adapter.calls, [])

    def test_regressed_state_is_terminal_even_without_derived_role_views(self) -> None:
        project = self._project("terminal-regression-project")
        project.joinpath("linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )

        def inject(candidate: Path) -> None:
            source = candidate / "linkcheck.py"
            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "elif not resolved.is_file():", "elif False and not resolved.is_file():"
                ),
                encoding="utf-8",
            )

        first_adapter = DeterministicRoleAdapter(completed_developer=True)
        result = self._loop("terminal-regression", project, first_adapter).run(
            RunFault(regress_before_qa=inject)
        )
        self.assertEqual(result["status"], "regressed")
        receipts = self.root / "terminal-regression-receipts"
        for derived in (receipts / "role-views", receipts / "role-receipt-projections"):
            derived.rename(receipts / f"retained-{derived.name}")

        reopened_adapter = DeterministicRoleAdapter(completed_developer=True)
        with self.assertRaisesRegex(HarnessError, "terminal regressed run"):
            self._loop("terminal-regression", project, reopened_adapter).run()
        self.assertEqual(reopened_adapter.calls, [])

    def test_resume_refuses_changed_or_missing_ledger_and_changed_policy(self) -> None:
        project, receipts, ledger = self._interrupted_after_developer("resume-ledger-missing")
        ledger.unlink()
        adapter = DeterministicRoleAdapter(completed_developer=True)
        with self.assertRaisesRegex(HarnessError, "ledger"):
            self._loop("resume-ledger-missing", project, adapter).run()
        self.assertEqual(adapter.calls, [])

        project, receipts, ledger = self._interrupted_after_developer("resume-ledger-path")
        adapter = DeterministicRoleAdapter(completed_developer=True)
        changed_path = self.root / "other-usage.json"
        changed = HeadlessLoop(
            project=project,
            receipt_dir=receipts,
            prompt_dir=self.prompts,
            run_id="resume-ledger-path",
            iterations=1,
            iteration_timeout_seconds=60,
            reported_token_budget=1000,
            usage_ledger=changed_path,
            adapter=adapter,
        )
        with self.assertRaisesRegex(HarnessError, "baseline binding"):
            changed.run()
        self.assertEqual(adapter.calls, [])

        project, receipts, ledger = self._interrupted_after_developer("resume-policy")
        adapter = DeterministicRoleAdapter(completed_developer=True)
        changed = HeadlessLoop(
            project=project,
            receipt_dir=receipts,
            prompt_dir=self.prompts,
            run_id="resume-policy",
            iterations=1,
            iteration_timeout_seconds=59,
            reported_token_budget=1000,
            usage_ledger=ledger,
            adapter=adapter,
        )
        with self.assertRaisesRegex(HarnessError, "baseline binding"):
            changed.run()
        self.assertEqual(adapter.calls, [])

    def test_resume_refuses_changed_checkpoint_receipt_head_stage_and_deadline_path(self) -> None:
        for suffix, mutate in (
            ("head", lambda state: state.update(receipt_chain_head="sha256:" + "0" * 64)),
            ("stage", lambda state: state.update(stage="iteration_complete")),
            ("deadline", lambda state: state.update(deadline_path="/tmp/other-deadline.json")),
        ):
            with self.subTest(binding=suffix):
                name = f"resume-{suffix}"
                project, receipts, _ledger = self._interrupted_after_developer(name)
                state_path = receipts / "state.json"
                state = json.loads(state_path.read_text(encoding="utf-8"))
                mutate(state)
                state_path.write_text(json.dumps(state), encoding="utf-8")
                adapter = DeterministicRoleAdapter(completed_developer=True)
                with self.assertRaises(HarnessError):
                    self._loop(name, project, adapter).run()
                self.assertEqual(adapter.calls, [])

        project, _receipts, _ledger = self._interrupted_after_developer("resume-git")
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=resume-test",
                "-c",
                "user.email=resume@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "unexpected checkpoint",
            ],
            cwd=project,
            check=True,
        )
        adapter = DeterministicRoleAdapter(completed_developer=True)
        with self.assertRaisesRegex(HarnessError, "Git checkpoint"):
            self._loop("resume-git", project, adapter).run()
        self.assertEqual(adapter.calls, [])

    def test_resume_refuses_a_rebound_baseline_commit_and_tree(self) -> None:
        project, receipts, _ledger = self._interrupted_after_developer("resume-baseline")
        baseline_path = receipts / "baseline.json"
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        baseline["baseline_commit"] = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        baseline["baseline_tree"] = subprocess.run(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
        adapter = DeterministicRoleAdapter(completed_developer=True)

        with self.assertRaisesRegex(HarnessError, "receipt baseline binding differs"):
            self._loop("resume-baseline", project, adapter).run()

        self.assertEqual(adapter.calls, [])

    def test_no_progress_count_survives_restart(self) -> None:
        project = self._project("no-progress-resume-project")
        project.joinpath("linkcheck.py").write_text(
            DeterministicRoleAdapter._source_for_iteration(3), encoding="utf-8"
        )
        first_adapter = NoProgressAdapter()
        first = self._loop("no-progress-resume", project, first_adapter, iterations=3)

        interrupted = first.run(RunFault(interrupt_after_iteration=2))

        self.assertEqual(interrupted["status"], "interrupted")
        state = json.loads(
            (self.root / "no-progress-resume-receipts/state.json").read_text(encoding="utf-8")
        )
        self.assertEqual(state["no_progress_count"], 1)
        resumed_adapter = NoProgressAdapter()
        with self.assertRaisesRegex(HarnessError, "two consecutive iterations"):
            self._loop(
                "no-progress-resume", project, resumed_adapter, iterations=3
            ).run()
        self.assertEqual(resumed_adapter.calls, [(3, "planner"), (3, "developer"), (3, "qa")])

    def test_regression_stops_acceptance_and_preserves_healthy_binding(self) -> None:
        project = self._project("regression-project")
        completed = DeterministicRoleAdapter._source_for_iteration(3)
        (project / "linkcheck.py").write_text(completed, encoding="utf-8")
        spec_before = (project / "spec.md").read_bytes()
        oracle_before = hash_tree(project / "tests")
        prompts_before = hash_tree(self.prompts)

        def inject(candidate: Path) -> None:
            source = candidate / "linkcheck.py"
            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "elif not resolved.is_file():", "elif False and not resolved.is_file():"
                ),
                encoding="utf-8",
            )

        adapter = DeterministicRoleAdapter(completed_developer=True)
        result = self._loop("regression", project, adapter).run(RunFault(regress_before_qa=inject))

        self.assertEqual(result["status"], "regressed")
        self.assertIn("test_links.LinkCheckTests.test_reports_missing_relative_target", result["observations"])
        self.assertNotEqual(result["healthy_candidate_sha256"], result["injected_candidate_sha256"])
        self.assertEqual((project / "spec.md").read_bytes(), spec_before)
        self.assertEqual(hash_tree(project / "tests"), oracle_before)
        self.assertEqual(hash_tree(self.prompts), prompts_before)

    def test_self_mutating_candidate_stops_before_test_receipt_acceptance_and_qa(self) -> None:
        project = self._project("self-mutating-project")
        source = DeterministicRoleAdapter._source_for_iteration(3).replace(
            "    findings = []\n",
            """\
    self_path = Path(__file__)
    self_path.chmod(0o644)
    with self_path.open("a", encoding="utf-8") as handle:
        handle.write("# mutated during oracle\\n")
    findings = []
""",
        )
        project.joinpath("linkcheck.py").write_text(source, encoding="utf-8")
        adapter = DeterministicRoleAdapter(completed_developer=True)

        with self.assertRaisesRegex(HarnessError, "changed during oracle execution"):
            self._loop("self-mutating", project, adapter).run()

        self.assertEqual(adapter.calls, [(1, "planner"), (1, "developer")])
        receipts = [
            json.loads(path.read_text(encoding="utf-8"))["payload"]
            for path in sorted(
                (self.root / "self-mutating-receipts/details").glob("*.json")
            )
        ]
        refusal = receipts[-1]
        self.assertEqual((refusal["stage"], refusal["status"]), ("test", "incomplete"))
        self.assertNotEqual(
            refusal["bindings"]["frozen_candidate_before_sha256"],
            refusal["bindings"]["frozen_candidate_after_sha256"],
        )
        self.assertFalse(any(payload["stage"] == "qa" for payload in receipts))


class ClaudeAdapterTests(unittest.TestCase):
    def test_usage_mapping_counts_separate_cache_subsets_once_and_preserves_nulls(self) -> None:
        complete = normalize_claude_usage(
            {
                "input_tokens": 10,
                "output_tokens": 4,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": 2,
                "num_turns": 1,
            },
            command_complete=True,
        )
        self.assertEqual(complete["aggregate_input_tokens"], 15)
        self.assertEqual(complete["budget_counted_tokens"], 19)
        self.assertEqual(complete["claude_agentic_turns"], 1)
        incomplete = normalize_claude_usage({"input_tokens": 10}, command_complete=True)
        self.assertFalse(incomplete["complete"])
        self.assertIsNone(incomplete["aggregate_output_tokens"])
        self.assertIsNone(incomplete["cache_read_input_tokens"])

    def test_preflight_refuses_version_flags_isolation_usage_and_unknown_bound_without_runner(self) -> None:
        root = preserved_test_dir("claude-preflight-")
        executable = root / "claude"
        executable.write_text("native seam placeholder\n", encoding="utf-8")
        calls = []

        def runner(*args, **kwargs):
            calls.append((args, kwargs))
            raise AssertionError("runner must not be invoked during failed preflight")

        valid = {
            "version": "2.1.241",
            "native_cli": True,
            "verified_flags": ["--print", "--output-format", "--tools"],
            "isolation": {
                "authenticated_host": True,
                "scoped_role_view": True,
                "builtin_tools_disabled": True,
                "credential_free_worker": True,
            },
            "usage_fields": [
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ],
            "whole_invocation_maximum_tokens": 100,
        }
        mutations = (
            {**valid, "version": "2.1.999"},
            {**valid, "verified_flags": ["--print"]},
            {**valid, "isolation": {**valid["isolation"], "credential_free_worker": False}},
            {**valid, "usage_fields": ["input_tokens", "output_tokens"]},
            {**valid, "whole_invocation_maximum_tokens": None},
            valid,
        )
        for evidence in mutations:
            with self.subTest(evidence=evidence):
                with self.assertRaises(ClaudePreflightError):
                    ClaudeAdapter(executable=executable, capability_evidence=evidence, runner=runner)
        self.assertEqual(calls, [])


class EntrypointTests(unittest.TestCase):
    def test_production_and_tests_only_entrypoints_parse_without_a_runtime_call(self) -> None:
        for script in (ROOT / "tools/hoh_loop.py", ROOT / "tools/tests/hoh_fault_probe.py"):
            with self.subTest(script=script.name):
                completed = subprocess.run(
                    [sys.executable, "-B", str(script), "--help"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("usage:", completed.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
