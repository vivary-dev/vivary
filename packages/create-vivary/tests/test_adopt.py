"""Public-seam tests for thin-v0.3 brownfield adoption."""

import contextlib
import hashlib
import io
import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"

sys.path.insert(0, str(PKG))

import create_vivary  # noqa: E402


def temp_dir() -> Path:
    path = ROOT / "sandboxes" / f"test-adopt-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


def run_cli(argv: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        rc = create_vivary.main(argv)
    return rc, output.getvalue()


class ThinAdoptPlanTests(unittest.TestCase):
    def test_default_dry_run_has_the_exact_thin_footprint_for_host_file_matrix(self):
        cases = {
            "all-host-files": {
                "host_files": ("AGENTS.md", ".gitignore", "STATE.md"),
                "creates": (".vivary/context.md", ".vivary/workspace.toml"),
                "patches": (".gitignore", "AGENTS.md"),
            },
            "state-missing": {
                "host_files": ("AGENTS.md", ".gitignore"),
                "creates": (".vivary/context.md", ".vivary/workspace.toml", "STATE.md"),
                "patches": (".gitignore", "AGENTS.md"),
            },
            "agents-missing": {
                "host_files": (".gitignore",),
                "creates": (
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                ),
                "patches": (".gitignore",),
            },
            "startup-and-privacy-missing": {
                "host_files": (),
                "creates": (
                    ".gitignore",
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                ),
                "patches": (),
            },
        }
        prohibited_roots = {
            ".agents",
            ".claude",
            "changes",
            "decisions",
            "gates",
            "heartbeat-reports",
            "memory",
            "modules",
            "templates",
            "verification",
        }
        prohibited_files = {
            "MEMORY.md",
            "SOUL.md",
            "STRATO.md",
            "USER.md",
            "bug-risk-playbook.md",
            "tropo.toml",
        }

        for name, case in cases.items():
            with self.subTest(name=name):
                target = temp_dir()
                try:
                    for host_file in case["host_files"]:
                        write(target / host_file, f"existing {host_file}\n")
                    before = snapshot(target)

                    rc, out = run_cli(
                        [
                            "adopt",
                            str(target),
                            "--preset",
                            "coding",
                            "--repo-root",
                            str(ROOT),
                            "--json",
                        ]
                    )

                    self.assertEqual(rc, 0)
                    self.assertEqual(snapshot(target), before, "dry-run must be read-only")
                    payload = json.loads(out)
                    self.assertEqual(payload["contract"], "thin-v0.3")
                    self.assertEqual(tuple(payload["creates"]), case["creates"])
                    self.assertEqual(
                        tuple(patch["path"] for patch in payload["patches"]),
                        case["patches"],
                    )
                    self.assertRegex(payload["plan_hash"], r"^sha256:[0-9a-f]{64}$")

                    planned_paths = set(payload["creates"]) | {
                        patch["path"] for patch in payload["patches"]
                    }
                    self.assertTrue(prohibited_files.isdisjoint(planned_paths))
                    self.assertTrue(
                        prohibited_roots.isdisjoint(
                            {path.split("/", 1)[0] for path in planned_paths}
                        )
                    )
                finally:
                    shutil.rmtree(target)

    def test_optional_adapters_are_closed_bounded_projections_not_default_payload(self):
        target = temp_dir()
        try:
            before = snapshot(target)

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--preset",
                    "coding",
                    "--adapter",
                    "agents",
                    "--adapter",
                    "claude",
                    "--repo-root",
                    str(ROOT),
                    "--json",
                ]
            )

            self.assertEqual(rc, 0)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertEqual(
                [item["path"] for item in payload["optional_projections"]],
                [".agents/skills/vivary/SKILL.md", ".claude/skills/vivary/SKILL.md"],
            )
            self.assertNotIn(".agents/skills/vivary/SKILL.md", payload["creates"])
            self.assertNotIn(".claude/skills/vivary/SKILL.md", payload["creates"])
            for projection in payload["optional_projections"]:
                self.assertLessEqual(projection["bytes"], 1200)
                self.assertRegex(projection["source_hash"], r"^sha256:[0-9a-f]{64}$")
                self.assertRegex(projection["content_hash"], r"^sha256:[0-9a-f]{64}$")
        finally:
            shutil.rmtree(target)

    def test_nested_gitignore_negation_is_a_read_only_privacy_conflict(self):
        target = temp_dir()
        try:
            write(target / ".gitignore", "node_modules/\n")
            write(
                target / ".vivary" / ".gitignore",
                "!private/\n!private/secret.md\n",
            )
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertEqual(payload["privacy"]["status"], "conflict")
            self.assertIn(
                ".vivary/.gitignore",
                [conflict["path"] for conflict in payload["conflicts"]],
            )
            self.assertTrue(
                any(
                    "private/runtime" in conflict["reason"]
                    for conflict in payload["conflicts"]
                )
            )
        finally:
            shutil.rmtree(target)


class ThinAdoptApplyTests(unittest.TestCase):
    def test_apply_requires_the_exact_approved_plan_hash_before_any_write(self):
        target = temp_dir()
        try:
            write(target / "README.md", "# Existing project\n")
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--yes", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertIn("--plan", payload["error"])
        finally:
            shutil.rmtree(target)

    def test_apply_uses_the_approved_creates_and_bounded_host_patches(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\n")
            write(target / ".gitignore", "node_modules/\n")
            write(target / "STATE.md", "# User state\n")
            original = {
                path: (target / path).read_bytes()
                for path in ("AGENTS.md", ".gitignore", "STATE.md")
            }
            dry_rc, dry_out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )
            self.assertEqual(dry_rc, 0)
            dry = json.loads(dry_out)

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--preset",
                    "coding",
                    "--yes",
                    "--plan",
                    dry["plan_hash"],
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, out)
            payload = json.loads(out)
            self.assertTrue(payload["doctor"]["ok"], payload["doctor"]["errors"])
            self.assertEqual((target / "STATE.md").read_bytes(), original["STATE.md"])
            self.assertIn(
                ".vivary/context.md",
                (target / "AGENTS.md").read_text(encoding="utf-8"),
            )
            for patch in dry["patches"]:
                path = target / patch["path"]
                self.assertEqual(path.read_bytes(), original[patch["path"]] + patch["inserted_text"].encode())
            self.assertTrue((target / ".vivary" / "context.md").is_file())
            self.assertTrue((target / ".vivary" / "workspace.toml").is_file())
            self.assertFalse((target / ".vivary" / "runtime" / "adopt-journal.json").exists())
            self.assertFalse((target / "tropo.toml").exists())
            self.assertFalse((target / "templates").exists())
            self.assertFalse((target / "modules").exists())
            self.assertFalse((target / ".vivary" / "records").exists())

            applied_snapshot = snapshot(target)
            second_plan = create_vivary.plan_adopt(target, preset="coding")
            self.assertFalse(second_plan["creates"])
            self.assertFalse(second_plan["patches"])
            self.assertFalse(second_plan["conflicts"])
            second = create_vivary.adopt_workspace(
                target,
                preset="coding",
                yes=True,
                plan_hash=second_plan["plan_hash"],
            )
            self.assertTrue(second["doctor"]["ok"])
            self.assertEqual(snapshot(target), applied_snapshot)
        finally:
            shutil.rmtree(target)

    def test_ordinary_failure_rolls_back_exact_bytes_and_created_files(self):
        probe = temp_dir()
        try:
            write(probe / "AGENTS.md", "# Existing agent rules\r\n")
            write(probe / ".gitignore", "node_modules/\r\n")
            write(probe / "STATE.md", "# Existing state\r\n")
            boundaries = len(
                create_vivary._adopt_actions(
                    create_vivary.plan_adopt(probe, preset="coding")
                )
            )
        finally:
            shutil.rmtree(probe)

        for boundary in range(1, boundaries + 1):
            with self.subTest(boundary=boundary):
                target = temp_dir()
                try:
                    write(target / "AGENTS.md", "# Existing agent rules\r\n")
                    write(target / ".gitignore", "node_modules/\r\n")
                    write(target / "STATE.md", "# Existing state\r\n")
                    before = snapshot(target)
                    plan = create_vivary.plan_adopt(target, preset="coding")

                    with self.assertRaisesRegex(
                        create_vivary.ScaffoldError, "injected failure"
                    ):
                        create_vivary.adopt_workspace(
                            target,
                            preset="coding",
                            yes=True,
                            plan_hash=plan["plan_hash"],
                            _fault_after=boundary,
                        )

                    self.assertEqual(snapshot(target), before)
                    self.assertFalse(
                        (target / ".vivary" / "runtime" / "adopt-journal.json").exists()
                    )
                finally:
                    shutil.rmtree(target)

    def test_process_crash_requires_explicit_plan_bound_recovery(self):
        probe = temp_dir()
        try:
            write(probe / "AGENTS.md", "# Existing agent rules\n")
            write(probe / ".gitignore", "node_modules/\n")
            write(probe / "STATE.md", "# Existing state\n")
            boundaries = len(
                create_vivary._adopt_actions(
                    create_vivary.plan_adopt(probe, preset="coding")
                )
            )
        finally:
            shutil.rmtree(probe)

        for boundary in range(1, boundaries + 1):
            with self.subTest(boundary=boundary):
                target = temp_dir()
                try:
                    write(target / "AGENTS.md", "# Existing agent rules\n")
                    write(target / ".gitignore", "node_modules/\n")
                    write(target / "STATE.md", "# Existing state\n")
                    before = snapshot(target)
                    plan = create_vivary.plan_adopt(target, preset="coding")

                    with self.assertRaises(KeyboardInterrupt):
                        create_vivary.adopt_workspace(
                            target,
                            preset="coding",
                            yes=True,
                            plan_hash=plan["plan_hash"],
                            _crash_after=boundary,
                        )

                    journal = target / ".vivary" / "runtime" / "adopt-journal.json"
                    self.assertTrue(journal.is_file())
                    interrupted_doctor = create_vivary.doctor_workspace(
                        target, repo_root=ROOT
                    )
                    self.assertFalse(interrupted_doctor["ok"])
                    self.assertTrue(
                        any(
                            "adoption journal" in error
                            for error in interrupted_doctor["errors"]
                        )
                    )

                    rc, out = run_cli(
                        [
                            "adopt",
                            str(target),
                            "--recover",
                            plan["plan_hash"],
                            "--json",
                        ]
                    )

                    self.assertEqual(rc, 0, out)
                    self.assertEqual(snapshot(target), before)
                    payload = json.loads(out)
                    self.assertEqual(payload["mode"], "recovered")
                    self.assertTrue(payload["recovered"])
                finally:
                    shutil.rmtree(target)

    def test_crash_after_privacy_before_journal_has_exact_plan_bound_recovery(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\r\n")
            write(target / ".gitignore", "node_modules/\r\n")
            write(target / "STATE.md", "# Existing state\r\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="coding")

            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _crash_before_journal=True,
                )

            journal = target / ".vivary" / "runtime" / "adopt-journal.json"
            self.assertFalse(journal.exists())
            self.assertIn(
                "vivary-adopt-prejournal",
                (target / ".gitignore").read_text(encoding="utf-8"),
            )
            interrupted_doctor = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(interrupted_doctor["ok"])
            self.assertTrue(
                any("pre-journal" in error for error in interrupted_doctor["errors"])
            )

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, out)
            self.assertEqual(snapshot(target), before)
            self.assertTrue(json.loads(out)["recovered"])
        finally:
            shutil.rmtree(target)

    def test_stale_known_generated_adapter_replacement_is_in_the_approved_plan(self):
        target = temp_dir()
        try:
            current, _, _ = create_vivary._thin_adapter_doc("agents")
            stale = current.replace(
                f"create-vivary {create_vivary.__version__}",
                "create-vivary 0.3.3",
                1,
            )
            adapter = target / ".agents" / "skills" / "vivary" / "SKILL.md"
            write(adapter, stale)

            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                adapters=("agents",),
            )

            self.assertFalse(plan["conflicts"])
            self.assertEqual(plan["optional_projections"][0]["status"], "replace")
            self.assertEqual(
                [item["path"] for item in plan["adapter_replacements"]],
                [adapter],
            )
            create_vivary.adopt_workspace(
                target,
                preset="coding",
                adapters=("agents",),
                yes=True,
                plan_hash=plan["plan_hash"],
            )
            self.assertEqual(adapter.read_text(encoding="utf-8"), current)

            future = current.replace(
                f"create-vivary {create_vivary.__version__}",
                "create-vivary 999.0.0",
                1,
            )
            write(adapter, future)
            future_plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                adapters=("agents",),
            )
            self.assertEqual(future_plan["optional_projections"][0]["status"], "conflict")
            self.assertEqual(
                [item["path"] for item in future_plan["conflicts"]],
                [adapter],
            )
        finally:
            shutil.rmtree(target)

    def test_host_mutation_after_approval_is_revalidated_before_vivary_writes(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\n")
            write(target / ".gitignore", "node_modules/\n")
            write(target / "STATE.md", "# Existing state\n")
            plan = create_vivary.plan_adopt(target, preset="coding")
            agents_before = (target / "AGENTS.md").read_bytes()
            gitignore_before = (target / ".gitignore").read_bytes()

            def mutate_kept_input() -> None:
                write(target / "STATE.md", "# Externally changed state\n")

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "input changed"):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _before_apply=mutate_kept_input,
                )

            self.assertEqual((target / "AGENTS.md").read_bytes(), agents_before)
            self.assertEqual((target / ".gitignore").read_bytes(), gitignore_before)
            self.assertEqual(
                (target / "STATE.md").read_text(encoding="utf-8"),
                "# Externally changed state\n",
            )
            self.assertFalse((target / ".vivary" / "context.md").exists())
            self.assertFalse(
                (target / ".vivary" / "runtime" / "adopt-journal.json").exists()
            )
        finally:
            shutil.rmtree(target)

    def test_existing_noncontract_capsule_is_a_read_only_conflict(self):
        target = temp_dir()
        try:
            write(target / ".vivary" / "context.md", "# user-owned context\n")
            write(target / "STATE.md", "# Existing state\n")
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertFalse(payload["ok"])
            self.assertEqual(
                [conflict["path"] for conflict in payload["conflicts"]],
                [".vivary/context.md"],
            )
            self.assertIn("STATE.md", payload["kept"])
        finally:
            shutil.rmtree(target)

    def test_valid_user_extended_v03_capsule_and_config_are_kept_byte_for_byte(self):
        target = temp_dir()
        try:
            initial = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )
            create_vivary.adopt_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
                yes=True,
                plan_hash=initial["plan_hash"],
            )
            context = target / ".vivary" / "context.md"
            workspace = target / ".vivary" / "workspace.toml"
            context.write_text(
                context.read_text(encoding="utf-8")
                + "\n## Project-specific route\n\nRead `docs/architecture.md` when structure matters.\n",
                encoding="utf-8",
            )
            workspace.write_text(
                workspace.read_text(encoding="utf-8")
                + '\n[types.note]\nfolder = "notes"\noptional = { source = "string" }\n',
                encoding="utf-8",
            )
            before = snapshot(target)

            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )

            self.assertFalse(plan["conflicts"])
            self.assertFalse(plan["creates"])
            self.assertFalse(plan["patches"])
            self.assertIn(context, plan["kept"])
            self.assertIn(workspace, plan["kept"])
            applied = create_vivary.adopt_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
                yes=True,
                plan_hash=plan["plan_hash"],
            )
            self.assertTrue(applied["doctor"]["ok"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)


if __name__ == "__main__":
    unittest.main()
