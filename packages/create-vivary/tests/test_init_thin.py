"""Public-seam tests for thin-v0.3 greenfield init."""

import contextlib
import io
import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"
sys.path.insert(0, str(PKG))

import create_vivary  # noqa: E402


def temp_target() -> Path:
    return ROOT / "sandboxes" / f"test-init-thin-{uuid.uuid4().hex}"


def run_cli(argv: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        rc = create_vivary.main(argv)
    return rc, output.getvalue()


class ThinInitTests(unittest.TestCase):
    def test_public_init_help_does_not_advertise_legacy_obsidian_scaffolding(self):
        parser = create_vivary.build_parser()
        init = parser._subparsers._group_actions[0].choices["init"]

        self.assertNotIn("--obsidian", init.format_help())

    def test_dry_run_is_read_only_and_default_plan_is_exactly_five_files(self):
        target = temp_target()
        try:
            planned = create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
                dry_run=True,
            )

            self.assertFalse(target.exists())
            self.assertEqual(
                [path.relative_to(target).as_posix() for path in planned],
                [
                    ".gitignore",
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                ],
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_cli_init_creates_only_thin_contract_and_is_immediately_healthy(self):
        target = temp_target()
        try:
            rc, out = run_cli(
                [
                    "init",
                    str(target),
                    "--preset",
                    "coding",
                    "--no-wizard",
                    "--repo-root",
                    str(ROOT),
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, out)
            payload = json.loads(out)
            self.assertEqual(payload["contract"], "thin-v0.3")
            self.assertEqual(payload["files"], 5)
            files = {
                path.relative_to(target).as_posix()
                for path in target.rglob("*")
                if path.is_file()
            }
            self.assertEqual(
                files,
                {
                    ".gitignore",
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                },
            )
            self.assertFalse((target / ".vivary" / "records").exists())
            self.assertFalse((target / "templates").exists())
            self.assertFalse((target / "tropo.toml").exists())
            doctor = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(doctor["ok"], doctor["errors"])
            self.assertEqual(
                doctor["compatibility"]["workspace_contract"],
                "thin-v0.3",
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_interactive_defaults_create_five_file_seed_without_provider_install(self):
        target = temp_target()
        try:
            with mock.patch.object(
                create_vivary.sys.stdin, "isatty", return_value=True
            ), mock.patch.object(
                create_vivary.sys.stdin,
                "readline",
                side_effect=["\n", "\n", "\n"],
            ), mock.patch.object(
                create_vivary, "_ensure_backend_installed", return_value=[]
            ) as installer:
                rc, out = run_cli(
                    [
                        "init",
                        str(target),
                        "--preset",
                        "coding",
                        "--repo-root",
                        str(ROOT),
                        "--json",
                    ]
                )

            self.assertEqual(rc, 0, out)
            installer.assert_not_called()
            payload = json.loads(out)
            self.assertEqual(payload["storage"], "file")
            self.assertEqual(payload["files"], 5)
            self.assertEqual(
                {
                    path.relative_to(target).as_posix()
                    for path in target.rglob("*")
                    if path.is_file()
                },
                {
                    ".gitignore",
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                },
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_auto_defaults_create_five_file_seed_without_provider_install(self):
        target = temp_target()
        try:
            with mock.patch.object(
                create_vivary, "_ensure_backend_installed", return_value=[]
            ) as installer:
                rc, out = run_cli(
                    [
                        "init",
                        str(target),
                        "--preset",
                        "coding",
                        "--auto",
                        "--repo-root",
                        str(ROOT),
                        "--json",
                    ]
                )

            self.assertEqual(rc, 0, out)
            installer.assert_not_called()
            payload = json.loads(out)
            self.assertEqual(payload["storage"], "file")
            self.assertEqual(payload["files"], 5)
            self.assertFalse((target / ".vivary" / "storage.toml").exists())
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_every_core_preset_is_the_same_five_file_seed_with_lazy_modes_and_runtime_routes(self):
        for preset in create_vivary.PRESETS:
            with self.subTest(preset=preset):
                target = temp_target()
                try:
                    paths = create_vivary.scaffold_thin_workspace(
                        target,
                        preset=preset,
                        repo_root=ROOT,
                    )
                    self.assertEqual(len(paths), 5)
                    self.assertFalse((target / ".vivary" / "records").exists())
                    self.assertFalse((target / "templates").exists())
                    self.assertFalse((target / ".agents").exists())
                    context = (target / ".vivary" / "context.md").read_text(
                        encoding="utf-8"
                    )
                    self.assertIn("vivary-mcp --workspace project .", context)
                    self.assertIn("create-vivary record", context)
                    self.assertIn("separately installed", context)
                    self.assertTrue(
                        create_vivary.doctor_workspace(target, repo_root=ROOT)["ok"]
                    )
                finally:
                    if target.exists():
                        shutil.rmtree(target)

    def test_selected_adapter_is_one_bounded_declared_projection(self):
        target = temp_target()
        try:
            paths = create_vivary.scaffold_thin_workspace(
                target,
                preset="writing",
                adapters=("agents",),
                repo_root=ROOT,
            )

            self.assertEqual(len(paths), 6)
            adapter = target / ".agents" / "skills" / "vivary" / "SKILL.md"
            self.assertTrue(adapter.is_file())
            self.assertLessEqual(len(adapter.read_bytes()), 1200)
            workspace = (target / ".vivary" / "workspace.toml").read_text(
                encoding="utf-8"
            )
            self.assertIn('adapters = ["agents"]', workspace)
            self.assertTrue(
                create_vivary.doctor_workspace(target, repo_root=ROOT)["ok"]
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_active_context_adds_two_files_and_keeps_index_state_out_of_scope(self):
        target = temp_target()
        try:
            paths = create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )

            self.assertEqual(len(paths), 7)
            self.assertTrue((target / "docs" / "active-context.md").is_file())
            skill = target / ".agents" / "skills" / "active-context" / "SKILL.md"
            self.assertTrue(skill.is_file())
            self.assertLessEqual(len(skill.read_bytes()), 1200)
            self.assertIn(
                ".cocoindex_code/",
                (target / ".gitignore").read_text(encoding="utf-8"),
            )
            self.assertIn(
                '".cocoindex_code"',
                (target / ".vivary" / "workspace.toml").read_text(encoding="utf-8"),
            )
            self.assertTrue(
                create_vivary.doctor_workspace(target, repo_root=ROOT)["ok"]
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_nonempty_target_is_redirected_to_governed_adopt(self):
        target = temp_target()
        try:
            target.mkdir(parents=True)
            (target / "README.md").write_text("# Existing\n", encoding="utf-8")
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "use create-vivary adopt"):
                create_vivary.scaffold_thin_workspace(
                    target,
                    preset="coding",
                    repo_root=ROOT,
                )
            self.assertEqual(
                (target / "README.md").read_text(encoding="utf-8"),
                "# Existing\n",
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_cli_rejects_brownfield_before_wizard_or_backend_install(self):
        target = temp_target()
        try:
            target.mkdir(parents=True)
            (target / "README.md").write_text("# Existing\n", encoding="utf-8")

            with mock.patch.object(create_vivary, "_run_wizard") as wizard, mock.patch.object(
                create_vivary, "_ensure_backend_installed"
            ) as installer:
                rc, out = run_cli(
                    [
                        "init",
                        str(target),
                        "--storage",
                        "embedded",
                        "--yes",
                        "--repo-root",
                        str(ROOT),
                        "--json",
                    ]
                )

            self.assertEqual(rc, 1, out)
            wizard.assert_not_called()
            installer.assert_not_called()
            self.assertEqual(
                (target / "README.md").read_text(encoding="utf-8"),
                "# Existing\n",
            )
        finally:
            if target.exists():
                shutil.rmtree(target)


if __name__ == "__main__":
    unittest.main()
