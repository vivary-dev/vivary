"""Public-seam tests for thin-v0.3 greenfield init."""

import contextlib
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
import uuid
import warnings
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


VIVARY_METADATA_HEADER = '[workspace.vivary]\nversion = 1\n'
DEFAULT_ROLES = {
    "law": ["AGENTS.md", ".vivary/context.md"],
    "map": [".vivary/context.md"],
    "record": [],
    "memory": [],
    "boundary": [".gitignore", ".vivary/private", ".vivary/runtime"],
}


def replace_role_metadata(config: str, metadata: str) -> str:
    """Replace the generated Vivary metadata tables. An empty string removes them."""
    before, remaining = config.split("\n# Optional Vivary metadata.", 1)
    _generated, after = remaining.split("\n[base]\n", 1)
    return before + "\n" + metadata + "\n[base]\n" + after


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

    def test_two_built_in_patterns_extend_the_reviewed_plan(self):
        target = temp_target()
        choices = (
            {"id": "capture", "name": "Capture", "path": "inbox/README.md"},
            {"id": "source-reference", "name": "Sources", "path": "sources/index.md"},
        )
        try:
            plan = create_vivary.plan_thin_workspace(
                target, preset="second-brain", pattern_choices=choices)
            self.assertFalse(target.exists())
            self.assertEqual({row["path"] for row in plan["files"]},
                {".gitignore", ".vivary/context.md", ".vivary/workspace.toml",
                 "AGENTS.md", "STATE.md", "inbox/README.md", "sources/index.md"})
            self.assertIn("inbox/README.md",
                next(row["content"] for row in plan["files"]
                     if row["path"] == ".vivary/context.md"))
            self.assertEqual(create_vivary.apply_thin_workspace(
                target, plan["plan_sha256"], preset="second-brain",
                pattern_choices=choices, repo_root=ROOT)["code"], "created")
            self.assertTrue((target / "inbox/README.md").is_file())
            self.assertTrue((target / "sources/index.md").is_file())
            self.assertEqual(create_vivary.apply_thin_workspace(
                target, plan["plan_sha256"], preset="second-brain",
                pattern_choices=choices, repo_root=ROOT)["code"], "already-created")
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

    def test_reviewed_cli_shares_exact_plan_apply_and_no_write_retry(self):
        target = temp_target()
        other = temp_target()
        try:
            preview_args = [
                "init", str(target), "--reviewed", "--dry-run", "--json",
                "--preset", "writing",
            ]
            rc, out = run_cli(preview_args)
            self.assertEqual(rc, 0, out)
            plan = json.loads(out)["plan"]
            self.assertEqual(plan, create_vivary.plan_thin_workspace(
                target, preset="writing"
            ))
            self.assertFalse(target.exists())

            for changed in (
                ["--preset", "coding"],
                ["--storage", "embedded"],
                ["--memory", "local"],
                ["--auto"],
            ):
                rc, out = run_cli(preview_args + changed)
                if changed == ["--preset", "coding"]:
                    self.assertEqual(rc, 0, out)
                    self.assertNotEqual(json.loads(out)["plan"]["plan_sha256"],
                                        plan["plan_sha256"])
                else:
                    self.assertEqual(rc, 1, out)
                self.assertFalse(target.exists())

            apply_args = [
                "init", str(target), "--reviewed", "--yes", "--json",
                "--preset", "writing", "--plan", plan["plan_sha256"],
                "--repo-root", str(ROOT),
            ]
            for extra in (["--storage", "embedded"], ["--memory", "local"],
                          ["--provider", "qdrant"], ["--auto"]):
                rc, out = run_cli(apply_args + extra)
                self.assertEqual(rc, 1, out)
                self.assertFalse(target.exists())
            rc, out = run_cli([
                "init", str(target), "--yes", "--json",
                "--plan", plan["plan_sha256"],
            ])
            self.assertEqual(rc, 1, out)
            self.assertFalse(target.exists())
            rc, out = run_cli([
                "init", str(other), *apply_args[2:]
            ])
            self.assertEqual(rc, 1, out)
            self.assertFalse(other.exists())
            rc, out = run_cli(apply_args)
            self.assertEqual(rc, 0, out)
            self.assertEqual(json.loads(out)["code"], "created")
            for row in plan["files"]:
                self.assertEqual((target/row["path"]).read_bytes(),
                                 row["content"].encode("utf-8"))
            before = (target/"AGENTS.md").stat().st_mtime_ns
            rc, out = run_cli(apply_args)
            self.assertEqual(rc, 0, out)
            self.assertEqual(json.loads(out)["code"], "already-created")
            self.assertEqual((target/"AGENTS.md").stat().st_mtime_ns, before)
        finally:
            for path in (target, other):
                if path.exists():
                    shutil.rmtree(path)

    def test_reviewed_receipts_mark_mode_without_paths_or_plan_hash(self):
        with tempfile.TemporaryDirectory(prefix="vivary-reviewed-receipt-") as temporary:
            target = Path(temporary)/"project"
            receipt = Path(temporary)/"runs.jsonl"
            rc, out = run_cli([
                "init", str(target), "--reviewed", "--dry-run", "--json",
                "--receipt", str(receipt),
            ])
            self.assertEqual(rc, 0, out)
            accepted = json.loads(out)["plan"]["plan_sha256"]
            rc, out = run_cli([
                "init", str(target), "--reviewed", "--yes", "--json",
                "--plan", accepted, "--repo-root", str(ROOT),
                "--receipt", str(receipt),
            ])
            self.assertEqual(rc, 0, out)
            records = [json.loads(line) for line in
                       receipt.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(records), 2)
            for record in records:
                self.assertIn("--reviewed", record["flags"])
                self.assertNotIn("--receipt", record["flags"])
                serialized = json.dumps(record)
                self.assertNotIn(str(target), serialized)
                self.assertNotIn(str(receipt), serialized)
                self.assertNotIn(accepted, serialized)

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
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertTrue(report["ok"], report["errors"])
                    expected_roles = {"patterns": ["thin-context"], "roles": DEFAULT_ROLES}
                    self.assertEqual(report["workspace_roles"], expected_roles)
                    config = target / ".vivary" / "workspace.toml"
                    # The public one-argument call must match Doctor's metadata.
                    tropo = create_vivary._load_tropo(ROOT)
                    workspace_table = tomllib.loads(config.read_text())["workspace"]
                    self.assertEqual(
                        tropo.resolve_workspace_roles({})["roles"]["boundary"], [".gitignore"]
                    )
                    self.assertEqual(
                        tropo.resolve_workspace_roles(workspace_table), expected_roles
                    )
                    state_before = (target / "STATE.md").read_bytes()
                    config.write_text(replace_role_metadata(config.read_text(), ""))
                    legacy = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertTrue(legacy["ok"], legacy["errors"])
                    self.assertEqual(legacy["workspace_roles"], expected_roles)
                    self.assertEqual((target / "STATE.md").read_bytes(), state_before)
                finally:
                    if target.exists():
                        shutil.rmtree(target)

    def test_workspaces_without_vivary_metadata_keep_ignoring_unrelated_workspace_values(self):
        # Before [workspace.vivary] existed, thin-v0.3 ignored these extension keys.
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            original = config.read_text()
            tropo = create_vivary._load_tropo(ROOT)
            expected = {"patterns": ["thin-context"], "roles": DEFAULT_ROLES}
            unrecognized = {
                "unknown pattern and role": (
                    'patterns = ["custom"]\n[workspace.roles]\nstate = "STATE.md"\n'
                ),
                "unknown pattern without roles": 'patterns = ["custom"]\n',
                "unknown role without patterns": '[workspace.roles]\nstate = "STATE.md"\n',
                "patterns type": 'patterns = "thin-context"\n[workspace.roles]\nlaw = []\n',
                "roles type": 'patterns = []\nroles = []\n',
                "path list": 'patterns = []\n[workspace.roles]\nlaw = "handbook.md"\n',
                "escape": 'patterns = []\n[workspace.roles]\nmemory = ["../outside.md"]\n',
                "glob": 'patterns = []\n[workspace.roles]\nmemory = ["notes/*.md"]\n',
            }
            for name, values in unrecognized.items():
                with self.subTest(name=name):
                    written = replace_role_metadata(original, values)
                    config.write_text(written)
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertTrue(report["ok"], report["errors"])
                    self.assertEqual(report["workspace_roles"], expected)
                    resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
                    self.assertEqual(resolver.base.workspace_roles, expected)
                    self.assertEqual(config.read_text(), written)
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_legacy_workspace_roles_without_vivary_metadata_are_retained_not_migrated(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            original = config.read_text()
            tropo = create_vivary._load_tropo(ROOT)
            empty_roles = {role: [] for role in DEFAULT_ROLES}
            cases = [
                (
                    'patterns = []\n[workspace.roles]\nlaw = ["handbook.md"]\n',
                    {"patterns": [], "roles": {**empty_roles, "law": ["handbook.md"]}},
                ),
                (
                    'patterns = ["thin-context"]\n[workspace.roles]\nmemory = ["notes/log.md"]\n',
                    {"patterns": ["thin-context"], "roles": {**DEFAULT_ROLES, "memory": ["notes/log.md"]}},
                ),
                ('patterns = []\n', {"patterns": [], "roles": empty_roles}),
                (
                    '[workspace.roles]\nlaw = ["handbook.md"]\n',
                    {"patterns": ["thin-context"], "roles": {**DEFAULT_ROLES, "law": ["handbook.md"]}},
                ),
            ]
            for metadata, expected in cases:
                with self.subTest(metadata=metadata):
                    legacy = replace_role_metadata(original, metadata).encode("utf-8")
                    config.write_bytes(legacy)
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertTrue(report["ok"], report["errors"])
                    self.assertEqual(report["workspace_roles"], expected)
                    resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
                    self.assertEqual(resolver.base.workspace_roles, expected)
                    self.assertEqual(config.read_bytes(), legacy)
                    self.assertFalse((target / "handbook.md").exists())

            config.write_text(config.read_text().replace(
                'exclude = [".git", ".agents", ".vivary/private", ".vivary/runtime"]',
                'exclude = [".git", ".agents", ".vivary/runtime"]',
            ))
            with self.assertRaisesRegex(tropo.ConfigError, "exclude must protect"):
                tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_doctor_reports_roles_and_metadata_errors_alongside_unrelated_failures(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            original = config.read_text()
            (target / "STATE.md").unlink()
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(report["ok"])
            self.assertIn("missing required file: STATE.md", report["errors"])
            self.assertEqual(
                report["workspace_roles"], {"patterns": ["thin-context"], "roles": DEFAULT_ROLES}
            )
            self.assertEqual(report["graph"], {"nodes": 0, "edges": 0, "broken": 0})

            config.write_text(replace_role_metadata(original, (
                VIVARY_METADATA_HEADER + '[workspace.vivary.roles]\nlaw = "AGENTS.md"\n'
            )))
            invalid = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertIsNone(invalid["workspace_roles"])
            self.assertIn("missing required file: STATE.md", invalid["errors"])
            self.assertTrue(
                any(
                    "workspace.vivary.roles.law must be a list" in error
                    for error in invalid["errors"]
                ),
                invalid["errors"],
            )
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_roles_remain_visible_while_adoption_recovery_is_required(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            journal = target / ".vivary" / "runtime" / "adopt-journal.json"
            journal.parent.mkdir(parents=True)
            journal.write_text("{}")
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(report["ok"])
            self.assertTrue(any("unfinished adoption journal" in error for error in report["errors"]))
            self.assertEqual(report["workspace_roles"]["roles"], DEFAULT_ROLES)
            self.assertEqual(report["graph"], {"nodes": 0, "edges": 0, "broken": 0})
            self.assertEqual(journal.read_text(), "{}")

            journal.unlink()
            gitignore = target / ".gitignore"
            before = gitignore.read_text() + "# vivary-adopt-prejournal invalid\n"
            gitignore.write_text(before)
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(report["ok"])
            self.assertIn("malformed pre-journal adoption marker exists in .gitignore", report["errors"])
            self.assertEqual(report["workspace_roles"]["roles"], DEFAULT_ROLES)
            self.assertEqual(gitignore.read_text(), before)
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_adoption_preserves_custom_roles_unknown_config_and_authored_state(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="writing", repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            custom = replace_role_metadata(config.read_text(), (
                VIVARY_METADATA_HEADER + 'patterns = ["thin-context"]\n'
                '[workspace.vivary.roles]\n'
                'law = ["handbook.md"]\n'
                'map = []\n'
                'memory = ["notes/[Q3] review.md"]\n'
            )) + '\n[user_options]\nkeep = "unchanged"\n'
            config.write_text(custom)
            state = target / "STATE.md"
            state.write_bytes(b"# My state\n\nNext: keep the user's plan.\n")
            state_before = state.read_bytes()
            plan = create_vivary.adopt_workspace(target, preset="writing", repo_root=ROOT)
            self.assertEqual(plan["conflicts"], [])
            applied = create_vivary.adopt_workspace(
                target, preset="writing", repo_root=ROOT,
                yes=True, plan_hash=plan["plan_hash"],
            )
            self.assertTrue(applied["applied"])
            report = applied["doctor"]
            self.assertTrue(report["ok"], report["errors"])
            self.assertEqual(report["workspace_roles"]["roles"]["law"], ["handbook.md"])
            self.assertEqual(report["workspace_roles"]["roles"]["map"], [])
            self.assertEqual(report["workspace_roles"]["roles"]["memory"], ["notes/[Q3] review.md"])
            self.assertEqual(report["workspace_roles"]["roles"]["record"], [])
            self.assertEqual(config.read_text(), custom)
            self.assertEqual(state.read_bytes(), state_before)
            self.assertFalse((target / "handbook.md").exists())
            self.assertFalse((target / "notes").exists())
            self.assertFalse((target / ".vivary" / "records").exists())
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_role_metadata_is_validated_by_the_existing_config_reader(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            original = config.read_text()
            tropo = create_vivary._load_tropo(ROOT)
            invalid = {
                "metadata type": 'vivary = []\n',
                "missing version": '[workspace.vivary]\npatterns = ["thin-context"]\n',
                "wrong version": '[workspace.vivary]\nversion = 2\n',
                "bool version": '[workspace.vivary]\nversion = true\n',
                "patterns type": 'patterns = "thin-context"\n',
                "unsupported pattern": 'patterns = ["memory-maintenance"]\n',
                "repeated pattern": 'patterns = ["thin-context", "thin-context"]\n',
                "roles type": 'roles = []\n',
                "unknown role": '[workspace.vivary.roles]\nstate = []\n',
                "path list": '[workspace.vivary.roles]\nlaw = "AGENTS.md"\n',
                "escape": '[workspace.vivary.roles]\nmemory = ["../outside.md"]\n',
                "absolute": '[workspace.vivary.roles]\nmemory = ["/outside.md"]\n',
                "drive": "[workspace.vivary.roles]\nmemory = ['C:\\outside.md']\n",
                "glob": '[workspace.vivary.roles]\nmemory = ["notes/*.md"]\n',
                "duplicate": '[workspace.vivary.roles]\nlaw = ["AGENTS.md", "AGENTS.md"]\n',
            }
            for name, metadata in invalid.items():
                with self.subTest(name=name):
                    if "version" not in name and name != "metadata type":
                        metadata = VIVARY_METADATA_HEADER + metadata
                    config.write_text(replace_role_metadata(original, metadata))
                    with self.assertRaises(tropo.ConfigError):
                        tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
        finally:
            if target.exists():
                shutil.rmtree(target)

    def test_empty_assignments_never_disable_privacy_or_required_thin_files(self):
        target = temp_target()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            empty = replace_role_metadata(config.read_text(), (
                VIVARY_METADATA_HEADER + 'patterns = []\n[workspace.vivary.roles]\nboundary = []\n'
            ))
            config.write_text(empty)
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report["errors"])
            self.assertEqual(report["workspace_roles"], {
                "patterns": [], "roles": {role: [] for role in ("law", "map", "record", "memory", "boundary")},
            })
            tropo = create_vivary._load_tropo(ROOT)
            config.write_text(empty.replace(
                'exclude = [".git", ".agents", ".vivary/private", ".vivary/runtime"]',
                'exclude = [".git", ".agents", ".vivary/runtime"]',
            ))
            with self.assertRaisesRegex(tropo.ConfigError, "exclude must protect"):
                tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
            config.write_text(empty)
            (target / "STATE.md").unlink()
            self.assertFalse(create_vivary.doctor_workspace(target, repo_root=ROOT)["ok"])
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
            healthy = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(healthy["ok"], healthy["errors"])
            expected_boundary = [
                ".gitignore", ".vivary/private", ".vivary/runtime", ".cocoindex_code",
            ]
            self.assertEqual(healthy["workspace_roles"]["roles"]["boundary"], expected_boundary)
            config = target / ".vivary" / "workspace.toml"
            tropo = create_vivary._load_tropo(ROOT)
            workspace_table = tomllib.loads(config.read_text())["workspace"]
            self.assertEqual(
                tropo.resolve_workspace_roles(workspace_table), healthy["workspace_roles"]
            )
            duplicate_capabilities = ["cocoindex-code", "cocoindex-code"]
            with self.assertRaisesRegex(tropo.ConfigError, "capabilities may contain"):
                tropo.resolve_workspace_roles({
                    **workspace_table, "capabilities": duplicate_capabilities,
                })
            generated_config = config.read_text()
            config.write_text(generated_config.replace(
                'capabilities = ["cocoindex-code"]',
                'capabilities = ["cocoindex-code", "cocoindex-code"]',
            ))
            invalid = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(invalid["ok"])
            self.assertTrue(any("capabilities may contain" in error for error in invalid["errors"]))
            config.write_text(replace_role_metadata(generated_config, ""))
            legacy = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(legacy["ok"], legacy["errors"])
            self.assertEqual(legacy["workspace_roles"]["roles"]["boundary"], expected_boundary)

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
            self.assertEqual(report["workspace_roles"]["roles"]["boundary"], expected_boundary)

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

        def attempt_windows_parent_swap(file_handle, name, **kwargs):
            if not attack["attempted"] and name == "context.md":
                swap_destination_parent()
            return real_windows_rename(file_handle, name, **kwargs)

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


class WorkspaceContextTests(unittest.TestCase):
    """The read the Workbench bridge serves before each agent message."""

    def scaffold(self) -> Path:
        target = temp_target()
        self.addCleanup(lambda: shutil.rmtree(target, ignore_errors=True))
        rc, out = run_cli(["init", str(target), "--preset", "coding", "--no-wizard",
                           "--repo-root", str(ROOT), "--json"])
        self.assertEqual(rc, 0, out)
        return target

    def test_workspace_context_reads_config_only(self):
        target = self.scaffold()
        tropo = create_vivary._load_tropo(ROOT)
        with mock.patch.object(create_vivary, "_load_tropo", return_value=tropo), \
                mock.patch.object(tropo, "analyze", side_effect=AssertionError("notes were read")):
            context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context, {
            "status": "thin",
            "roles": DEFAULT_ROLES,
            "state": "STATE.md",
            "memory": [".vivary/knowledge"],
            "memory_assigned": False,
            "protected": [".vivary/private", ".vivary/runtime"],
            "privacy_policy": "gitignore",
            "private": [],
            "private_files": [],
            "ignore_files": [".gitignore", ".vivary/.gitignore", ".vivary/knowledge/.gitignore"],
            "private_candidates": [],
            "checked_files": [],
            "privacy_limited": False,
        })

    def test_plain_folder_gets_the_default_location(self):
        target = temp_target()
        target.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(target, ignore_errors=True))
        self.assertEqual(create_vivary.workspace_context(target, repo_root=ROOT), {
            "status": "plain", "roles": None, "state": None,
            "memory": [".vivary/knowledge"], "memory_assigned": False, "protected": [],
            "privacy_policy": "none", "private": [], "private_files": [],
            "ignore_files": [".gitignore", ".vivary/.gitignore", ".vivary/knowledge/.gitignore"], "private_candidates": [],
            "checked_files": [], "privacy_limited": False,
        })

    def test_many_distinct_rules_stay_quick(self):
        for count, limited in ((600, False), (5_000, True)):
            with self.subTest(count=count):
                target = self.scaffold()
                with (target / ".gitignore").open("a", encoding="utf-8") as handle:
                    handle.write("".join(f"zz{index}*.log\n" for index in range(count)))
                knowledge = target / ".vivary" / "knowledge"
                knowledge.mkdir()
                for index in range(300):
                    (knowledge / f"fact-{index:03d}.md").write_text("# Fact\n", encoding="utf-8")
                started = time.perf_counter()
                context = create_vivary.workspace_context(target, repo_root=ROOT)
                elapsed = time.perf_counter() - started
                print(f"memory privacy with {count} rules and 300 files: {elapsed:.2f} s", file=sys.stderr)
                self.assertLess(elapsed, 10)
                self.assertEqual(context["privacy_limited"], limited)
                self.assertEqual(len(context["checked_files"]), 200)
                if limited:
                    self.assertEqual(context["private"], [".vivary/knowledge"])
                else:
                    self.assertEqual(context["private_files"], [])

    def test_costly_rules_spend_the_budget_and_fail_closed(self):
        target = self.scaffold()
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("".join(f"{'a*' * 100}b{index}\n" for index in range(40)))
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        for index in range(200):
            (knowledge / f"{'a' * 150}{index:03d}.md").write_text("# Fact\n", encoding="utf-8")
        started = time.perf_counter()
        context = create_vivary.workspace_context(target, repo_root=ROOT, candidates=[".vivary/knowledge/new.md"])
        self.assertLess(time.perf_counter() - started, 10)
        self.assertTrue(context["privacy_limited"])
        # The files decided after the budget ran out are private.
        self.assertIn(context["checked_files"][-1], context["private_files"])
        self.assertEqual(context["private_candidates"], [".vivary/knowledge/new.md"])

    def test_memory_privacy_fails_closed_on_case_and_brackets(self):
        for rule in (".vivary/Knowledge/\n", ".vivary/[Kk]nowledge/\n", "KNOWLEDGE/\n"):
            with self.subTest(rule=rule):
                target = self.scaffold()
                with (target / ".gitignore").open("a", encoding="utf-8") as handle:
                    handle.write(rule)
                context = create_vivary.workspace_context(target, repo_root=ROOT)
                self.assertEqual(context["private"], [".vivary/knowledge"])
        # Doctor keeps its own rule: it never counts an uncertain rule as protection.
        self.assertFalse(create_vivary._probe_is_ignored(target, ".vivary/knowledge/fact.md"))
        target = self.scaffold()
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write(".vivary/knowledge/\n!.vivary/Knowledge/\n")
        context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context["private"], [".vivary/knowledge"], "a different-case negation does not re-include")

    def test_memory_privacy_reads_a_bom_and_unreadable_brackets_fail_closed(self):
        target = self.scaffold()
        gitignore = target / ".gitignore"
        gitignore.write_bytes(b"\xef\xbb\xbf.vivary/knowledge/\n" + gitignore.read_bytes())
        self.assertEqual(create_vivary.workspace_context(target, repo_root=ROOT)["private"], [".vivary/knowledge"])
        for rule in ("[[:alpha:]]nowledge/\n", ".vivary/[[:lower:]]*/\n", "know[ledge/\n"):
            with self.subTest(rule=rule):
                target = self.scaffold()
                with (target / ".gitignore").open("a", encoding="utf-8") as handle:
                    handle.write(rule)
                self.assertEqual(create_vivary.workspace_context(target, repo_root=ROOT)["private"],
                                 [".vivary/knowledge"])
                self.assertFalse(create_vivary._probe_is_ignored(target, ".vivary/knowledge/fact.md"),
                                 "Doctor keeps its own matching")

    def test_a_nested_open_bracket_prints_no_warning(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            self.assertFalse(create_vivary._bracket_rule_is_uncertain("[[]x.md"))
            self.assertTrue(create_vivary._memory_rule_matches("", "[[]x.md", "[x.md"))

    def test_ordinary_bracket_sets_and_escapes_match_as_git_does(self):
        ordinary = ("[._]*.s[a-v][a-z]", "[._]*.sw[a-p]", "[.]env", "*[.]log", "build[:]out", "*.[=]x",
                    "foo\\[bar")
        for rule in ordinary:
            with self.subTest(rule=rule):
                self.assertFalse(create_vivary._bracket_rule_is_uncertain(rule))
        for rule in ("[[:alpha:]]*.md", "[[=a=]]x", "[[.a.]]x", "know[ledge", "a[b"):
            with self.subTest(rule=rule):
                self.assertTrue(create_vivary._bracket_rule_is_uncertain(rule))
        # Git reads these differently from Python's re, so memory treats them as matching.
        git_only = {"[\\][:alpha:]]*.md": "x.md", "[!][:alpha:]]*.md": "1x.md", "[^][:alpha:]]*.md": "1x.md",
                    "[\\d]raft.md": "draft.md", "[\\s]pace.md": "space.md", "[\\b]ack.md": "back.md",
                    "[\\W]ord.md": "Word.md"}
        for rule, path in git_only.items():
            with self.subTest(rule=rule):
                self.assertTrue(create_vivary._bracket_rule_is_uncertain(rule))
                scoped = self.scaffold()
                (scoped / ".gitignore").write_text(f"{rule}\n", encoding="utf-8")
                self.assertTrue(create_vivary._memory_probe_is_ignored(scoped, path))
        target = self.scaffold()
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("".join(f"{rule}\n" for rule in ordinary))
        context = create_vivary.workspace_context(target, repo_root=ROOT, candidates=[".vivary/knowledge/fact.md"])
        self.assertEqual(context["private"], [])
        self.assertEqual(context["private_candidates"], [])
        self.assertNotIn("STATE.md", context["private_files"])
        # Each rule still ignores what Git would ignore with it.
        for path in (".env", "x.log", "build:out", "a.=x", "foo[bar", ".x.swp", ".x.sva"):
            with self.subTest(path=path):
                self.assertTrue(create_vivary._memory_probe_is_ignored(target, path))
        for path in ("fooxbar", "buildout", "env", ".vivary/knowledge/fact.md"):
            with self.subTest(path=path):
                self.assertFalse(create_vivary._memory_probe_is_ignored(target, path))

    def test_checked_files_leave_out_names_the_workbench_cannot_carry(self):
        target = self.scaffold()
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        (knowledge / "fact.md").write_text("# Fact\n", encoding="utf-8")
        names = ["fact.md"]
        if os.name != "nt":
            (knowledge / "a\\b.md").write_text("# Odd\n", encoding="utf-8")
        for name in (".md", "my-secret.md", "Credentials.md", ".env.local.md"):
            (knowledge / name).write_text("# Hidden\n", encoding="utf-8")
        context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context["checked_files"], [f".vivary/knowledge/{name}" for name in names])
        self.assertTrue(create_vivary._workbench_can_carry(".vivary/knowledge/" + "x" * 490 + ".md"))
        self.assertFalse(create_vivary._workbench_can_carry(".vivary/knowledge/" + "x" * 500 + ".md"))

    def test_checked_files_skip_links_in_the_workbench_order(self):
        if os.name == "nt":
            self.skipTest("file links need extra rights on Windows")
        target = self.scaffold()
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        for index in range(201):
            (knowledge / f"fact-{index:03d}.md").write_text("# Fact\n", encoding="utf-8")
        (knowledge / "a-link.md").symlink_to(knowledge / "fact-000.md")
        checked = create_vivary.workspace_context(target, repo_root=ROOT)["checked_files"]
        # The link takes the first place in the listing, so the listing ends at fact-198.
        self.assertEqual(checked, [f".vivary/knowledge/fact-{index:03d}.md" for index in range(199)])

    def test_checked_files_stay_within_the_total_bound(self):
        self.assertLessEqual(create_vivary._CONTEXT_CHECKED_JSON_BYTES, 128 * 1024)
        target = self.scaffold()
        folders = []
        for folder_index in range(16):
            folder = target / "notes" / f"f{folder_index:02d}"
            folder.mkdir(parents=True)
            folders.append(f"notes/f{folder_index:02d}")
            for index in range(200):
                (folder / f"fact-{index:03d}.md").write_text("# Fact\n", encoding="utf-8")
        checked = create_vivary._checked_fact_paths(target, folders)
        self.assertEqual(len(checked), create_vivary._CONTEXT_CHECKED_TOTAL)
        self.assertLessEqual(len(json.dumps(checked)), create_vivary._CONTEXT_CHECKED_JSON_BYTES)

    def test_checked_files_follow_the_workbench_listing_bounds(self):
        target = self.scaffold()
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        for index in range(250):
            (knowledge / f"fact-{index:03d}.md").write_text("# Fact\n", encoding="utf-8")
        checked = create_vivary.workspace_context(target, repo_root=ROOT)["checked_files"]
        self.assertEqual(checked, [f".vivary/knowledge/fact-{index:03d}.md" for index in range(200)])

    def test_candidate_files_are_checked_against_every_rule(self):
        target = self.scaffold()
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        (knowledge / ".gitignore").write_text("draft.md\n", encoding="utf-8")
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("draft-*\n")
        context = create_vivary.workspace_context(target, repo_root=ROOT, candidates=[
            ".vivary/knowledge/draft.md", ".vivary/knowledge/draft-plan.md", ".vivary/knowledge/relay.md"])
        self.assertEqual(context["private"], [])
        self.assertEqual(context["private_candidates"],
                         [".vivary/knowledge/draft.md", ".vivary/knowledge/draft-plan.md"])
        for bad in (["../x.md"], ["/abs.md"], [".vivary\\x.md"], ["x"] * 17):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                create_vivary.workspace_context(target, repo_root=ROOT, candidates=bad)

    def test_nested_rules_and_private_files_are_reported(self):
        target = self.scaffold()
        knowledge = target / ".vivary" / "knowledge"
        knowledge.mkdir()
        (knowledge / "shared.md").write_text("# Shared\n", encoding="utf-8")
        (knowledge / "draft.md").write_text("# Draft\n", encoding="utf-8")
        (knowledge / ".gitignore").write_text("draft.md\n", encoding="utf-8")
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("STATE.md\n")
        context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context["private"], [])
        self.assertEqual(context["private_files"], [".vivary/knowledge/draft.md", "STATE.md"])
        self.assertIn(".vivary/knowledge/.gitignore", context["ignore_files"])

    def test_host_path_scrub_covers_unc_and_extended_paths(self):
        message = ("see \\\\server\\share\\notes and \\\\?\\C:\\Users\\owner\\x, "
                   "then \\\\?\\UNC\\server\\share")
        self.assertEqual(create_vivary._without_host_paths(message, Path("/work/project")),
                         "see <a folder outside the project> and <a folder outside the project>, "
                         "then <a folder outside the project>")

    def test_malformed_thin_marker_is_invalid_with_a_fixed_message(self):
        for kind in ("folder", "dangling link"):
            with self.subTest(kind=kind):
                target = self.scaffold()
                marker = target / ".vivary" / "workspace.toml"
                marker.unlink()
                if kind == "folder":
                    marker.mkdir()
                else:
                    try:
                        marker.symlink_to(target / "missing.toml")
                    except OSError:
                        self.skipTest("links need extra rights here")
                context = create_vivary.workspace_context(target, repo_root=ROOT)
                self.assertEqual(context, {"status": "invalid",
                                           "message": create_vivary._MALFORMED_MARKER_MESSAGE})

    def test_a_rule_naming_one_fact_does_not_make_the_folder_private(self):
        target = self.scaffold()
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("fact.md\n")
        context = create_vivary.workspace_context(target, repo_root=ROOT, candidates=[".vivary/knowledge/fact.md"])
        self.assertEqual(context["private"], [])
        self.assertEqual(context["private_candidates"], [".vivary/knowledge/fact.md"])
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("*.md\n")
        self.assertEqual(create_vivary.workspace_context(target, repo_root=ROOT)["private"], [".vivary/knowledge"])

    def test_too_many_ignore_files_fail_closed(self):
        target = self.scaffold()
        folders = [f"f{index}/" + "/".join(["a"] * 249) for index in range(20)]
        budget = create_vivary._MemoryMatchBudget()
        privacy = create_vivary._context_privacy(target, {"memory": folders, "roles": {"law": []}, "state": None},
                                                 budget)
        self.assertTrue(budget.spent)
        self.assertEqual(len(privacy["ignore_files"]), create_vivary._CONTEXT_IGNORE_FILES)
        self.assertEqual(privacy["private"], folders)

    def test_host_path_scrub_keeps_urls_and_relative_paths(self):
        # Tropo names files with the platform's separators, so the message does too.
        target = Path("/work/project")
        settings = target / ".vivary" / "workspace.toml"
        relative = str(settings).replace(str(target), ".", 1)
        message = (f"see https://example.test/docs, {settings}, "
                   ".vivary/private, /home/owner/other, and C:\\Users\\owner\\x")
        self.assertEqual(
            create_vivary._without_host_paths(message, target),
            f"see https://example.test/docs, {relative}, .vivary/private, "
            "<a folder outside the project>, and <a folder outside the project>",
        )

    def test_competing_root_message_names_no_host_path(self):
        outer = self.scaffold()
        inner = outer / "inner"
        (inner / ".vivary").mkdir(parents=True)
        shutil.copyfile(outer / ".vivary" / "workspace.toml", inner / ".vivary" / "workspace.toml")
        context = create_vivary.workspace_context(inner, repo_root=ROOT)
        self.assertEqual(context["status"], "invalid")
        self.assertIn("competing", context["message"])
        self.assertNotIn(str(outer), context["message"])
        self.assertNotIn(str(ROOT), context["message"])

    def test_ignored_memory_folder_is_reported_private(self):
        target = self.scaffold()
        config = target / ".vivary" / "workspace.toml"
        config.write_text(config.read_text(encoding="utf-8").replace(
            "memory = []", 'memory = ["notes/facts", ".vivary/private/facts"]'), encoding="utf-8")
        with (target / ".gitignore").open("a", encoding="utf-8") as handle:
            handle.write("notes/\n")
        context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context["memory"], ["notes/facts", ".vivary/private/facts"])
        self.assertEqual(context["private"], ["notes/facts", ".vivary/private/facts"])

    def test_workspace_context_invalid_config_is_data(self):
        target = self.scaffold()
        config = target / ".vivary" / "workspace.toml"
        original = config.read_text(encoding="utf-8")
        config.write_text(original.replace('contract = "thin-v0.3"', 'contract = "other"'),
                          encoding="utf-8")
        context = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(context["status"], "invalid")
        self.assertNotIn(str(target.resolve()), context["message"])
        self.assertIn("workspace.contract", context["message"])

        real = target / "workspace-real.toml"
        real.write_text(original, encoding="utf-8")
        config.unlink()
        try:
            config.symlink_to(real)
        except OSError as error:
            self.skipTest(str(error))
        linked = create_vivary.workspace_context(target, repo_root=ROOT)
        self.assertEqual(linked["status"], "invalid")
        self.assertNotIn(str(target.resolve()), linked["message"])

    @unittest.skipUnless(shutil.which("git"), "Git is not installed")
    def test_thin_gitignore_keeps_authored_memory_versionable(self):
        target = self.scaffold()
        subprocess.run(["git", "-c", "init.templateDir=", "init", "-q", str(target)],
                       check=True, capture_output=True)
        ignored = subprocess.run(
            ["git", "-C", str(target), "check-ignore", "--no-index",
             ".vivary/knowledge/x.md", ".vivary/private/x.md"],
            capture_output=True, text=True,
        )
        self.assertEqual(ignored.stdout.split(), [".vivary/private/x.md"])


# Rules and files for the memory privacy differential test, one case per line:
# (name, root .gitignore text or {".gitignore path": text}, files to check).
# For every file Git ignores with core.ignorecase false or true, memory must
# ignore it too. Memory may ignore more.
MEMORY_PRIVACY_DIFFERENTIAL_CASES: tuple[tuple[str, str | dict[str, str], tuple[str, ...]], ...] = (
    ("whitelist idiom", "*\n!*/\n", ("knowledge/fact.md", "a.md")),
    ("negated folder", "*.md\n!knowledge/\n", ("knowledge/x.md", "x.md")),
    ("anchored negation", "README.md\n!/README.md\n", ("README.md", "docs/README.md")),
    ("negated folder-only rule on a file", "*.md\n!keep.md/\n", ("keep.md",)),
    ("negated double star", "*.md\n!k**z.md\n", ("kaz.md", "k/z.md", "ka/bz.md")),
    ("negated non-ASCII bracket", "*.md\n![é]x.md\n", ("éx.md",)),
    ("negated negative bracket", "*.md\n!notes[!_]x.md\n", ("notesax.md",)),
    ("nested negation", {".gitignore": "*.md\n", "sub/.gitignore": "!*.md\n"}, ("sub/a.md", "a.md")),
    ("nested negated folder", {"knowledge/.gitignore": "*\n!sub\n"}, ("knowledge/sub/x.md", "knowledge/y.md")),
    ("negative range against case", "[!a-z]*.md\n", ("Bob.md", "bob.md", "1.md")),
    ("unbounded double star before a slash", "mem**/*.md\n", ("mem/x.md", "memory/x.md", "me/x.md")),
    ("trailing unbounded double star", "a**\n", ("a/b/c.md", "ab.md")),
    ("double star inside a name", "k**.md\n", ("k/x.md", "kx.md")),
    ("question marks over bytes", "?????.md\n", ("café.md", "cafés.md")),
    ("question marks over one accent", "caf??.md\n", ("café.md",)),
    ("non-ASCII bracket over bytes", "[é]*.md\n", ("ìx.md", "éx.md")),
    ("lone carriage return", "a\rb.md\n", ("a\rb.md", "a", "b.md")),
    ("form feed", "c\x0cd.md\n", ("c\x0cd.md", "d.md")),
    ("next line", "e\x85f.md\n", ("e\x85f.md", "f.md")),
    ("line separator", "g\u2028h.md\n", ("g\u2028h.md", "h.md")),
    ("paragraph separator", "i\u2029j.md\n", ("i\u2029j.md", "j.md")),
    ("CRLF line ends", "k.md\r\nl.md\r\n", ("k.md", "l.md")),
    ("byte order mark", "\ufeffm.md\n", ("m.md",)),
    ("Vim swap template", "[._]*.s[a-v][a-z]\n[._]*.sw[a-p]\n", (".x.swp", ".x.sva", "fact.md")),
    ("bracket sets", "[.]env\n*[.]log\nbuild[:]out\n*.[=]x\n", (".env", "x.log", "build:out", "a.=x", "env")),
    ("escape outside a bracket", "foo\\[bar\n", ("foo[bar", "fooxbar")),
    ("escape inside a bracket", "[\\d]raft.md\n[\\][:alpha:]]*.md\n", ("draft.md", "x.md", "]x.md")),
    ("leading bracket member", "[!][:alpha:]]*.md\n[^][:alpha:]]*.md\n", ("1x.md", "ax.md")),
    ("POSIX class", "[[:alpha:]]nowledge/\n", ("knowledge/x.md",)),
    ("trailing slash", "build/\n", ("build/x.md", "build.md")),
    ("anchoring", "/top.md\nsub/deep.md\n", ("top.md", "sub/top.md", "sub/deep.md", "x/sub/deep.md")),
    ("upper-case rules", "*.MD\nNotes/\n", ("x.md", "notes/y.md")),
    ("non-ASCII literals", "é.md\nnaïve/\n", ("é.md", "naïve/x.md")),
    ("nested rules", {"a/.gitignore": "b.md\n/c.md\n"}, ("a/b.md", "a/x/b.md", "a/c.md", "a/x/c.md", "b.md")),
    ("star runs", "***/foo\n****/bar\na/***/b\n", ("foo", "x/foo", "bar", "y/bar", "a/b", "a/x/b")),
    ("negated capital brackets", "[!B]x.md\n[!U]SER.md\n[!K]nowledge/\n",
     ("Bx.md", "bx.md", "USER.md", "user.md", "Knowledge/fact.md", "knowledge/fact.md")),
    ("NUL ends an entry", "secret.md\x00junk\nknowledge/\x00\n", ("secret.md", "knowledge/fact.md")),
    ("uncased range ends spanning letters", "[@-_]*\n", (".vivary/knowledge/fact.md", "1.md", ".x")),
    ("uncased range extension", "*.[@-_][@-_]\n", ("notes.md", "notes.12")),
)

# Rows whose rules sit in the repository's root .gitignore, where a rule's
# folder is the root itself. The same shape as the table above.
MEMORY_PRIVACY_ROOT_CASES: tuple[tuple[str, str | dict[str, str], tuple[str, ...]], ...] = (
    ("root anchored and inner slash", "/top.md\nsub/deep.md\n", ("top.md", "sub/top.md", "sub/deep.md", "x/sub/deep.md")),
    ("root with a nested file", {".gitignore": "*.log\n/a/b.md\n", "a/.gitignore": "/c.md\nd/\n"},
     ("x.log", "a/x.log", "a/b.md", "b.md", "a/c.md", "a/e/c.md", "a/d/f.md", "d/f.md")),
    ("root star runs", "***/foo\na/***/b\n", ("foo", "x/foo", "a/b", "a/x/b", "b")),
    ("root negated capital bracket", "[!B]x.md\n", ("Bx.md", "bx.md", "x.txt")),
    ("root negation", "*.md\n!keep.md\n", ("keep.md", "x.md", "x.txt")),
    ("root NUL", "secret.md\x00junk\n", ("secret.md", "other.md")),
    ("root uncased range folder", "[@-_]/\n", ("a/f.md", "1/f.md")),
    ("root uncased range star", "[`-{]*\n", ("AGENTS.md", "STATE.md", "1.md")),
    ("root uncased range extension", "*.[@-_][@-_]\n", ("notes.md", "notes.12")),
)

# The generated cross product: bracket bodies with and without a negation,
# in both letter cases, and star runs of one to four, each placed plain,
# anchored, directory-only, and in a nested .gitignore, against a seeded
# sample of a fixed name set.
_GENERATED_BRACKETS = tuple(f"[{negation}{members}]" for negation in ("", "!", "^")
                            for members in ("a-z", "A-Z", "b", "B", "K", "._", "é", "k-m"))
_GENERATED_RULES = (
    *(template.format(bracket) for bracket in _GENERATED_BRACKETS
      for template in ("{}x.md", "{}SER.md", "{}nowledge/")),
    *(template.format("*" * run) for run in range(1, 5)
      for template in ("{}/foo", "a/{}/b", "k{}.md", "{}x", "mem{}/*.md")),
)
_GENERATED_PLACEMENTS = ("plain", "anchored", "directory-only", "nested")
_GENERATED_NAMES = ("x.md", "Bx.md", "bx.md", "USER.md", "user.md", "Knowledge/fact.md", "knowledge/fact.md",
                    "foo", "x/foo", "a/b", "a/x/b", "kx.md", "k/x.md", "K.md", "ax", "a/bx", "mem/x.md",
                    "memory/y.md", "éx.md", "_x.md")


# Letter-free rules built from bracket ranges whose ends are not letters but
# which span letters. Git folds the path letter before it tests the range.
_GENERATED_RANGES = ("@-_", "`-{", "@-[", "`-~", "!-@", "#-@")
_GENERATED_RANGE_RULES = tuple(template.replace("{}", members) for members in _GENERATED_RANGES
                               for template in ("[{}]*", "[!{}]*.md", "*.[{}][{}]", "[{}]/", "x[{}]"))
_GENERATED_RANGE_NAMES = ("AGENTS.md", "STATE.md", "notes.md", "NOTES.MD", "a/f.md", "A/f.md", "1/f.md",
                          "knowledge/fact.md", "x.md", "xA", "xa", "x_", "_x.md", "1.md")


def _generated_memory_privacy_cases(seed: int = 21):
    """(name, {".gitignore path": text}, files) for each rule and placement."""
    rng = random.Random(seed)
    for rules, names in ((_GENERATED_RULES, _GENERATED_NAMES), (_GENERATED_RANGE_RULES, _GENERATED_RANGE_NAMES)):
        for rule in rules:
            for placement in _GENERATED_PLACEMENTS:
                text = {"anchored": f"/{rule}", "directory-only": f"{rule.rstrip('/')}/"}.get(placement, rule)
                folder = "sub/" if placement == "nested" else ""
                yield (f"{placement} {rule}", {f"{folder}.gitignore": f"{text}\n"},
                       tuple(f"{folder}{name}" for name in rng.sample(names, 8)))


@unittest.skipUnless(shutil.which("git"), "needs git on PATH")
class MemoryPrivacyDifferentialTests(unittest.TestCase):
    """Memory's matcher against `git check-ignore`: it may over-ignore, never under-ignore."""

    def setUp(self):
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        self.env = {**os.environ, "HOME": home, "XDG_CONFIG_HOME": home, "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_CONFIG_GLOBAL": os.devnull}
        self.version = subprocess.run(["git", "--version"], env=self.env, capture_output=True, text=True,
                                      check=True).stdout.strip()

    def git_ignored(self, repo: Path, paths: list[str], ignorecase: str) -> set[str]:
        result = subprocess.run(
            ["git", "-c", f"core.ignorecase={ignorecase}", "check-ignore", "--no-index", "-z", "--stdin"],
            cwd=repo, env=self.env, input=b"\0".join(path.encode("utf-8", "surrogateescape") for path in paths),
            capture_output=True, check=False)
        self.assertIn(result.returncode, (0, 1), result.stderr.decode("utf-8", "replace"))
        return {item.decode("utf-8", "surrogateescape") for item in result.stdout.split(b"\0") if item}

    def compare(self, label: str, cases, *, make_files: bool, at_root: bool = False) -> None:
        """Assert the fail-closed property for `cases`.

        By default all cases share one repository, each under its own folder.
        With `at_root` each case gets its own repository, with its rules in
        the root `.gitignore`.
        """
        checked = over = loaded = 0
        missed: list[str] = []
        numbered = list(enumerate(cases))
        for group in ([[item] for item in numbered] if at_root else [numbered]):
            with tempfile.TemporaryDirectory() as folder:
                repo = Path(folder)
                subprocess.run(["git", "init", "-q"], cwd=repo, env=self.env, check=True)
                names: dict[str, str] = {}
                for number, (name, rules, files) in group:
                    root = "" if at_root else f"c{number}/"
                    for location, text in (rules.items() if isinstance(rules, dict) else [(".gitignore", rules)]):
                        (repo / f"{root}{location}").parent.mkdir(parents=True, exist_ok=True)
                        (repo / f"{root}{location}").write_bytes(text.encode("utf-8"))
                    for relative in files:
                        if make_files:
                            try:
                                (repo / f"{root}{relative}").parent.mkdir(parents=True, exist_ok=True)
                                (repo / f"{root}{relative}").write_text("x\n", encoding="utf-8")
                            except OSError:
                                continue  # This file system cannot hold the name.
                        names[f"{root}{relative}"] = name
                paths = list(names)
                git = self.git_ignored(repo, paths, "false") | self.git_ignored(repo, paths, "true")
                for path in paths:
                    memory = create_vivary._memory_probe_is_ignored(repo, path)
                    checked += 1
                    if path in git and not memory:
                        missed.append(f"{names[path]}: {path!r}")
                    elif memory and path not in git:
                        over += 1
                    elif not memory:
                        loaded += 1
        print(f"memory privacy {label}: {self.version}, {len(cases)} cases, {checked} files, "
              f"{len(missed)} missed, {over} over-ignored", file=sys.stderr)
        self.assertGreater(checked, 0)
        self.assertGreater(loaded, 0, "memory must still load files Git does not ignore")
        self.assertEqual(missed, [], "memory loaded a file Git ignores")

    def test_memory_ignores_everything_git_ignores(self):
        self.compare("table", MEMORY_PRIVACY_DIFFERENTIAL_CASES, make_files=True)

    def test_generated_rules_never_under_ignore(self):
        self.compare("generated", list(_generated_memory_privacy_cases()), make_files=False)

    def test_root_gitignore_rows(self):
        self.compare("root", MEMORY_PRIVACY_ROOT_CASES, make_files=True, at_root=True)


class MemoryMatcherSpeedTests(unittest.TestCase):
    def test_star_heavy_rules_finish_quickly(self):
        path = "a" * 81
        for rule in ("a**" * 8 + "b", "a**" * 10 + "b", "*" * 20 + "x", "a*" * 6 + "b", "a*" * 40 + "b",
                     "*/" * 30 + "x", "[a-z]*" * 20 + "q"):
            with self.subTest(rule=rule):
                started = time.perf_counter()
                create_vivary._memory_rule_matches("", rule, path)
                create_vivary._memory_rule_matches("", rule, "/".join([path] * 6))
                self.assertLess(time.perf_counter() - started, 0.2)


if __name__ == "__main__":
    unittest.main()
