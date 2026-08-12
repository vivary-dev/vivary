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

    def test_active_context_is_config_only_and_keeps_the_five_file_seed(self):
        target = temp_target()
        try:
            paths = create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )

            self.assertEqual(len(paths), 5)
            self.assertFalse((target / "docs" / "active-context.md").exists())
            self.assertFalse((target / ".agents").exists())
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

            gitignore = target / ".gitignore"
            generated_gitignore = gitignore.read_text(encoding="utf-8")
            gitignore.write_text(
                generated_gitignore.replace(
                    ".cocoindex_code/\n",
                    "",
                ),
                encoding="utf-8",
            )
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(report["ok"])
            self.assertIn(
                "privacy ignore missing: .cocoindex_code/",
                report["errors"],
            )

            gitignore.write_text(
                generated_gitignore + "!.cocoindex_code/\n",
                encoding="utf-8",
            )
            negated = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(negated["ok"])
            self.assertIn(
                "privacy ignore missing: .cocoindex_code/",
                negated["errors"],
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

    def test_force_does_not_replace_user_edits_in_an_existing_thin_workspace(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
            )
            agents = target / "AGENTS.md"
            state = target / "STATE.md"
            agents.write_text(
                agents.read_text(encoding="utf-8") + "\nUser-owned rule.\n",
                encoding="utf-8",
            )
            state.write_text(
                state.read_text(encoding="utf-8") + "\nUser-owned state.\n",
                encoding="utf-8",
            )
            before = {
                path.relative_to(target).as_posix(): path.read_bytes()
                for path in target.rglob("*")
                if path.is_file()
            }

            with self.assertRaisesRegex(
                create_vivary.ScaffoldError,
                "use create-vivary adopt",
            ):
                create_vivary.scaffold_thin_workspace(
                    target,
                    preset="coding",
                    force=True,
                    repo_root=ROOT,
                )

            self.assertEqual(
                {
                    path.relative_to(target).as_posix(): path.read_bytes()
                    for path in target.rglob("*")
                    if path.is_file()
                },
                before,
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_force_cannot_replace_a_file_created_after_the_empty_target_check(self):
        target = temp_target()
        real_write = create_vivary._write_bytes_no_follow
        injected = {"done": False}

        def create_competing_file(target_root, destination, data, **kwargs):
            if not injected["done"]:
                injected["done"] = True
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("user-created during init\n", encoding="utf-8")
            return real_write(target_root, destination, data, **kwargs)

        try:
            with mock.patch.object(
                create_vivary,
                "_write_bytes_no_follow",
                side_effect=create_competing_file,
            ):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.scaffold_thin_workspace(
                        target,
                        preset="coding",
                        force=True,
                        repo_root=ROOT,
                    )

            self.assertTrue(injected["done"])
            self.assertEqual(
                (target / ".gitignore").read_text(encoding="utf-8"),
                "user-created during init\n",
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_parent_swap_cannot_redirect_a_seed_write_outside_the_workspace(self):
        target = temp_target()
        outside = target.with_name(target.name + "-outside")
        moved = target.with_name(target.name + "-moved-workspace")
        (outside / ".vivary").mkdir(parents=True)
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("outside stays unchanged\n", encoding="utf-8")
        real_replace = create_vivary.os.replace
        real_link = create_vivary.os.link
        real_windows_rename = getattr(create_vivary, "_windows_rename_open_file", None)
        attack = {"attempted": False, "blocked": False}

        def swap_destination_parent():
            attack["attempted"] = True
            try:
                real_replace(target, moved)
                target.symlink_to(
                    outside,
                    target_is_directory=True,
                )
            except OSError:
                attack["blocked"] = True

        def attempt_posix_parent_swap(src, dst, *args, **kwargs):
            if not attack["attempted"] and Path(dst).name == "context.md":
                swap_destination_parent()
            return real_link(src, dst, *args, **kwargs)

        def attempt_windows_parent_swap(file_handle, parent_handle, name, **kwargs):
            if not attack["attempted"] and name == "context.md":
                swap_destination_parent()
            return real_windows_rename(file_handle, parent_handle, name, **kwargs)

        failed_closed = False
        try:
            patcher = (
                mock.patch.object(
                    create_vivary,
                    "_windows_rename_open_file",
                    side_effect=attempt_windows_parent_swap,
                )
                if create_vivary.os.name == "nt"
                else mock.patch.object(
                    create_vivary.os,
                    "link",
                    side_effect=attempt_posix_parent_swap,
                )
            )
            with patcher:
                try:
                    create_vivary.scaffold_thin_workspace(
                        target,
                        preset="coding",
                        repo_root=ROOT,
                    )
                except create_vivary.ScaffoldError:
                    failed_closed = True

            self.assertTrue(attack["attempted"])
            self.assertTrue(attack["blocked"] or failed_closed)
            if not attack["blocked"]:
                self.assertTrue(failed_closed)
            self.assertEqual(
                sentinel.read_text(encoding="utf-8"),
                "outside stays unchanged\n",
            )
            self.assertFalse((outside / ".vivary" / "context.md").exists())
        finally:
            for path in (target, moved, outside):
                if path.exists() or path.is_symlink():
                    if path.is_symlink():
                        path.unlink()
                    else:
                        shutil.rmtree(path)

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
