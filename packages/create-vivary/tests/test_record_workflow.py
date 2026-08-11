"""Public-seam tests for one earned, capsule-bound thin-workspace record."""

import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"
CORE = ROOT / "packages" / "core"
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(CORE))

import create_vivary  # noqa: E402
from vivary_core import (  # noqa: E402
    compile_task_capsule,
    normalize_path,
    observe_checkouts,
    project_public_task_capsule,
    project_workspace_graph,
)


def temp_root() -> Path:
    return Path(tempfile.mkdtemp(prefix=f"test-record-{uuid.uuid4().hex}-"))


def snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


def change_record(title: str = "First governed change") -> str:
    return f"""---
project: context
status: done
slice: first governed record
---
# {title}

This record exists because real work earned it.
"""


def run_cli(argv: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        rc = create_vivary.main(argv)
    return rc, output.getvalue()


class GovernedRecordWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = temp_root()
        self.workspace = self.root / "workspace"
        self.source = self.root / "record.md"
        create_vivary.scaffold_thin_workspace(
            self.workspace,
            preset="coding",
            repo_root=ROOT,
        )
        self.source.write_text(change_record(), encoding="utf-8", newline="\n")
        self.capsule_source = self.root / "capsule.json"
        self.refresh_capsule()

    def tearDown(self) -> None:
        if self.root.exists():
            shutil.rmtree(self.root)

    def refresh_capsule(self):
        workspace = normalize_path(os.path.realpath(os.path.abspath(self.workspace)))
        graph = project_workspace_graph(
            observe_checkouts([workspace], allowlist=[workspace])
        )
        self.full_capsule = compile_task_capsule(
            task={
                "question": "Record the verified governed work",
                "scope": [workspace],
            },
            graph=graph,
        )
        self.public_capsule = project_public_task_capsule(
            self.full_capsule,
            checkout_path=workspace,
        )
        self.capsule_source.write_text(
            json.dumps(self.full_capsule),
            encoding="utf-8",
            newline="\n",
        )

    def plan(self, **overrides):
        values = {
            "target": self.workspace,
            "record": "changes/first-governed-change.md",
            "source": self.source,
            "capsule": self.capsule_source,
            "repo_root": ROOT,
        }
        values.update(overrides)
        return create_vivary.plan_record(**values)

    def apply(self, plan: dict, **overrides):
        values = {
            "target": self.workspace,
            "record": "changes/first-governed-change.md",
            "source": self.source,
            "capsule": self.capsule_source,
            "repo_root": ROOT,
            "yes": True,
            "plan_hash": plan["plan_hash"],
        }
        values.update(overrides)
        return create_vivary.record_workspace(**values)

    def test_plan_is_read_only_capsule_bound_and_preserves_the_five_file_seed(self):
        before = snapshot(self.workspace)

        plan = self.plan()

        self.assertEqual(snapshot(self.workspace), before)
        self.assertEqual(len(before), 5)
        self.assertEqual(plan["contract"], "thin-v0.3")
        self.assertEqual(plan["action"], "create")
        self.assertEqual(plan["path"], ".vivary/records/changes/first-governed-change.md")
        self.assertEqual(
            plan["capsule"],
            {
                "id": self.public_capsule["capsule_id"],
                "fingerprint": self.full_capsule["fingerprint"],
                "workspace_fingerprint": self.public_capsule["workspace"]["fingerprint"],
            },
        )
        self.assertIsNone(plan["before_hash"])
        self.assertRegex(plan["after_hash"], r"^sha256:[0-9a-f]{64}$")
        self.assertRegex(plan["plan_hash"], r"^sha256:[0-9a-f]{64}$")
        self.assertFalse((self.workspace / ".vivary" / "records").exists())

    def test_apply_requires_the_exact_approved_plan_and_creates_only_one_earned_record(self):
        plan = self.plan()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, "requires --plan"):
            create_vivary.record_workspace(
                self.workspace,
                "changes/first-governed-change.md",
                source=self.source,
                capsule=self.capsule_source,
                repo_root=ROOT,
                yes=True,
            )
        with self.assertRaisesRegex(create_vivary.ScaffoldError, "plan hash mismatch"):
            self.apply(plan, plan_hash="sha256:" + "b" * 64)

        result = self.apply(plan)

        record = self.workspace / ".vivary" / "records" / "changes" / "first-governed-change.md"
        self.assertTrue(result["applied"])
        self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
        self.assertEqual(record.read_text(encoding="utf-8"), change_record())
        files = snapshot(self.workspace)
        self.assertEqual(len(files), 6)
        self.assertEqual(
            {path for path in files if path.startswith(".vivary/records/")},
            {".vivary/records/changes/first-governed-change.md"},
        )
        self.assertFalse((self.workspace / "templates").exists())
        self.assertFalse((self.workspace / "modules").exists())

    def test_changed_source_invalidates_the_approved_plan_before_writes(self):
        plan = self.plan()
        self.source.write_text(change_record("Changed after approval"), encoding="utf-8")

        with self.assertRaisesRegex(create_vivary.ScaffoldError, "plan hash mismatch"):
            self.apply(plan)

        self.assertFalse((self.workspace / ".vivary" / "records").exists())

    def test_update_is_a_new_exact_plan_and_does_not_materialize_other_records(self):
        created = self.plan()
        self.apply(created)
        self.source.write_text(change_record("Verified update"), encoding="utf-8")
        self.refresh_capsule()

        update = self.plan()
        result = self.apply(update)

        self.assertEqual(update["action"], "update")
        self.assertRegex(update["before_hash"], r"^sha256:[0-9a-f]{64}$")
        self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
        record_files = {
            path.relative_to(self.workspace).as_posix()
            for path in (self.workspace / ".vivary" / "records").rglob("*")
            if path.is_file()
        }
        self.assertEqual(
            record_files,
            {".vivary/records/changes/first-governed-change.md"},
        )

    def test_update_refuses_a_hardlinked_destination_before_reading_or_writing(self):
        self.apply(self.plan())
        record = (
            self.workspace
            / ".vivary"
            / "records"
            / "changes"
            / "first-governed-change.md"
        )
        os.link(record, self.root / "linked-copy.md")
        self.source.write_text(change_record("Unsafe linked update"), encoding="utf-8")

        with self.assertRaisesRegex(create_vivary.ScaffoldError, "single-link"):
            self.plan()

        self.assertEqual(record.read_text(encoding="utf-8"), change_record())

    def test_invalid_record_rolls_back_without_leaving_a_record_tree(self):
        self.source.write_text("# Missing typed frontmatter\n", encoding="utf-8")

        with self.assertRaisesRegex(create_vivary.ScaffoldError, "typed record"):
            self.plan()

        self.assertFalse((self.workspace / ".vivary" / "records").exists())

    def test_post_write_doctor_failure_restores_the_exact_prewrite_tree(self):
        plan = self.plan()
        before = snapshot(self.workspace)
        real_doctor = create_vivary.doctor_workspace
        calls = 0

        def doctor_then_fail(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 3:
                return {
                    "ok": False,
                    "errors": ["injected post-write failure"],
                    "compatibility": {"workspace_contract": "thin-v0.3"},
                }
            return real_doctor(*args, **kwargs)

        with mock.patch.object(create_vivary, "doctor_workspace", side_effect=doctor_then_fail):
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "Doctor failed after record apply"):
                self.apply(plan)

        self.assertEqual(snapshot(self.workspace), before)
        self.assertFalse((self.workspace / ".vivary" / "records").exists())

    def test_record_path_is_bounded_to_one_known_lazy_record_folder(self):
        for unsafe in (
            "../STATE.md",
            ".vivary/context.md",
            "projects/second-brain.md",
            "changes/nested/too-deep.md",
            "unknown/item.md",
        ):
            with self.subTest(record=unsafe), self.assertRaisesRegex(
                create_vivary.ScaffoldError, "record path"
            ):
                self.plan(record=unsafe)

    def test_plan_refuses_a_typed_pair_instead_of_a_complete_capsule(self):
        self.capsule_source.write_text(
            json.dumps(
                {
                    "capsule_id": self.public_capsule["capsule_id"],
                    "fingerprint": self.full_capsule["fingerprint"],
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(create_vivary.ScaffoldError, "integrity"):
            self.plan()

    def test_plan_refuses_a_tampered_or_wrong_workspace_capsule(self):
        tampered = json.loads(json.dumps(self.full_capsule))
        tampered["capsule_id"] = "capsule_0000000000000000"
        self.capsule_source.write_text(json.dumps(tampered), encoding="utf-8")
        with self.assertRaisesRegex(create_vivary.ScaffoldError, "integrity"):
            self.plan()

        other = self.root / "other-workspace"
        create_vivary.scaffold_thin_workspace(other, preset="coding", repo_root=ROOT)
        other_path = normalize_path(os.path.realpath(os.path.abspath(other)))
        other_graph = project_workspace_graph(
            observe_checkouts([other_path], allowlist=[other_path])
        )
        other_capsule = project_public_task_capsule(
            compile_task_capsule(
                task={"question": "Wrong workspace", "scope": [other_path]},
                graph=other_graph,
            ),
            checkout_path=other_path,
        )
        self.capsule_source.write_text(json.dumps(other_capsule), encoding="utf-8")
        with self.assertRaisesRegex(create_vivary.ScaffoldError, "different workspace"):
            self.plan()

    def test_each_lazy_record_folder_uses_the_thin_workspace_type_policy(self):
        candidates = {
            "modules/runtime.md": """---
project: context
status: active
module_area: runtime
---
# Runtime
""",
            "changes/runtime.md": change_record(),
            "decisions/runtime.md": """---
project: context
status: accepted
date: 2026-08-10
---
# Runtime decision
""",
            "verification/runtime.md": """---
project: context
status: passed
target: greenfield runtime
---
# Runtime verification
""",
            "gates/runtime.md": """---
project: context
status: approved
gate: human approval
---
# Runtime gate
""",
        }

        for record, content in candidates.items():
            with self.subTest(record=record):
                self.source.write_text(content, encoding="utf-8", newline="\n")
                plan = self.plan(record=record)
                self.assertEqual(plan["path"], f".vivary/records/{record}")
                self.assertEqual(plan["action"], "create")

        self.assertFalse((self.workspace / ".vivary" / "records").exists())

    def test_cli_apply_emits_a_privacy_preserving_run_receipt_in_ignored_runtime(self):
        receipt = self.workspace / ".vivary" / "runtime" / "receipts.jsonl"
        dry_rc, dry_output = run_cli(
            [
                "record",
                str(self.workspace),
                "changes/first-governed-change.md",
                "--from",
                str(self.source),
                "--capsule",
                str(self.capsule_source),
                "--repo-root",
                str(ROOT),
                "--json",
            ]
        )
        self.assertEqual(dry_rc, 0, dry_output)
        dry_run = json.loads(dry_output)

        apply_rc, apply_output = run_cli(
            [
                "record",
                str(self.workspace),
                "changes/first-governed-change.md",
                "--from",
                str(self.source),
                "--capsule",
                str(self.capsule_source),
                "--plan",
                dry_run["plan_hash"],
                "--yes",
                "--repo-root",
                str(ROOT),
                "--receipt",
                str(receipt),
                "--json",
            ]
        )

        self.assertEqual(apply_rc, 0, apply_output)
        self.assertTrue(json.loads(apply_output)["applied"])
        run_receipt = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(run_receipt["schema"], "vivary.run_receipt.v1")
        self.assertEqual(run_receipt["command"], "record")
        self.assertTrue(run_receipt["ok"])
        serialized = receipt.read_text(encoding="utf-8")
        self.assertNotIn(str(self.workspace), serialized)
        self.assertNotIn(str(self.source), serialized)
        self.assertNotIn(self.public_capsule["capsule_id"], serialized)
        self.assertIn(".vivary/runtime/", (self.workspace / ".gitignore").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
