"""Tests for the create-vivary workspace scaffold."""

import sys
import shutil
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"
TROPO = ROOT / "packages" / "tropo"

sys.path.insert(0, str(PKG))
sys.path.insert(0, str(TROPO))

import create_vivary  # noqa: E402
import tropo  # noqa: E402


@contextmanager
def temp_workspace():
    path = ROOT / "sandboxes" / f"test-create-vivary-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    try:
        yield path
    finally:
        shutil.rmtree(path)


class CreateVivaryTests(unittest.TestCase):
    def test_init_writes_full_agent_workspace_scaffold(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"

            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )

            expected = [
                "README.md",
                "AGENTS.md",
                "SOUL.md",
                "STRATO.md",
                "STATE.md",
                "USER.md",
                "MEMORY.md",
                "bug-risk-playbook.md",
                "tropo.toml",
                ".gitignore",
                "memory/.gitkeep",
                "heartbeat-reports/.gitkeep",
                "templates/AGENTS.md",
                ".claude/skills/strato/SKILL.md",
                ".claude/skills/loops/SKILL.md",
                ".agents/skills/strato/SKILL.md",
                ".agents/skills/loops/SKILL.md",
                "modules/index.md",
                "modules/agent-workspace/index.md",
                "changes/scaffold-init.md",
                "decisions/0001-vivary-baseline.md",
                "verification/scaffold-smoke.md",
                "gates/human-gates.md",
                "modules/codebase/index.md",
                "changes/local-ci-baseline.md",
                "verification/local-checks.md",
            ]
            missing = [p for p in expected if not (target / p).exists()]
            self.assertEqual(missing, [])
            self.assertFalse((target / "modules" / "codebase.md").exists())

            agents = (target / "AGENTS.md").read_text(encoding="utf-8")
            self.assertIn("progressive disclosure", agents)
            self.assertIn("modules/index.md", agents)
            module_index = (
                target / "modules" / "codebase" / "index.md"
            ).read_text(encoding="utf-8")
            self.assertIn("Keep canonical details in the linked files", module_index)

            gitignore = (target / ".gitignore").read_text(encoding="utf-8")
            self.assertIn("USER.md", gitignore)
            self.assertIn("MEMORY.md", gitignore)
            self.assertIn("memory/*", gitignore)
            self.assertIn("heartbeat-reports/*", gitignore)

            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            docs = tropo.analyze(str(target), [], resolver)
            findings = [f.render() for d in docs for f in d.findings]
            self.assertEqual(findings, [])

            nodes, edges = tropo.build_graph(docs)
            for node in [
                "modules",
                "agent-workspace",
                "codebase",
                "scaffold-init",
                "local-ci-baseline",
                "0001-vivary-baseline",
                "scaffold-smoke",
                "local-checks",
                "human-gates",
            ]:
                self.assertIn(node, nodes)

            edge_pairs = {(e["from"], e["to"]) for e in edges}
            self.assertIn(("scaffold-init", "agent-workspace"), edge_pairs)
            self.assertIn(("scaffold-smoke", "scaffold-init"), edge_pairs)
            self.assertTrue(all(not e["broken"] for e in edges))

    def test_obsidian_flag_is_opt_in(self):
        import json
        with temp_workspace() as td:
            plain = Path(td) / "plain"
            create_vivary.scaffold_workspace(plain, preset="coding", repo_root=ROOT)
            self.assertFalse((plain / ".obsidian").exists())  # default: no Obsidian

            vault = Path(td) / "vault"
            create_vivary.scaffold_workspace(
                vault, preset="coding", obsidian=True, repo_root=ROOT)
            self.assertTrue((vault / ".obsidian" / "app.json").exists())
            graph = json.loads((vault / ".obsidian" / "graph.json").read_text(encoding="utf-8"))
            queries = {g["query"] for g in graph["colorGroups"]}
            self.assertIn("path:modules/", queries)
            self.assertIn("path:gates/", queries)
            self.assertTrue((vault / "AGENTS.md").exists())  # still a real workspace

    def test_cocoindex_active_context_is_opt_in(self):
        with temp_workspace() as td:
            plain = Path(td) / "plain"
            create_vivary.scaffold_workspace(plain, preset="coding", repo_root=ROOT)
            self.assertFalse((plain / ".agents" / "skills" / "active-context").exists())
            self.assertNotIn(
                ".cocoindex_code/",
                (plain / ".gitignore").read_text(encoding="utf-8"),
            )

            active = Path(td) / "active"
            create_vivary.scaffold_workspace(
                active,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )

            expected = [
                "docs/active-context.md",
                "modules/active-context/index.md",
                "decisions/0002-cocoindex-code-sidecar.md",
                "verification/active-context-smoke.md",
                ".claude/skills/active-context/SKILL.md",
                ".agents/skills/active-context/SKILL.md",
            ]
            missing = [p for p in expected if not (active / p).exists()]
            self.assertEqual(missing, [])

            skill = (
                active / ".agents" / "skills" / "active-context" / "SKILL.md"
            ).read_text(encoding="utf-8")
            self.assertIn("Ask before installing, initializing, indexing", skill)
            self.assertIn("ccc init -f", skill)
            self.assertIn("ccc search", skill)
            self.assertIn("tropo graph", skill)

            gitignore = (active / ".gitignore").read_text(encoding="utf-8")
            self.assertIn(".cocoindex_code/", gitignore)

            resolver = tropo.ConfigResolver(str(active), str(TROPO))
            docs = tropo.analyze(str(active), [], resolver)
            findings = [f.render() for d in docs for f in d.findings]
            self.assertEqual(findings, [])

            nodes, edges = tropo.build_graph(docs)
            for node in [
                "active-context",
                "0002-cocoindex-code-sidecar",
                "active-context-smoke",
            ]:
                self.assertIn(node, nodes)
            self.assertTrue(all(not e["broken"] for e in edges))

    def test_cocoindex_active_context_requires_coding_preset(self):
        with temp_workspace() as td:
            target = Path(td) / "writing-workspace"

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "coding preset"):
                create_vivary.scaffold_workspace(
                    target,
                    preset="writing",
                    active_context="cocoindex-code",
                    repo_root=ROOT,
                )

    def test_presets_write_distinct_starter_graphs(self):
        cases = {
            "coding": {
                "module": "codebase",
                "change": "local-ci-baseline",
                "verification": "local-checks",
            },
            "second-brain": {
                "module": "knowledge-base",
                "change": "capture-routine",
                "verification": "retrieval-smoke",
            },
            "writing": {
                "module": "manuscript-system",
                "change": "draft-review-loop",
                "verification": "editorial-review",
            },
        }

        for preset, expected in cases.items():
            with self.subTest(preset=preset), temp_workspace() as td:
                target = Path(td) / f"{preset}-workspace"
                create_vivary.scaffold_workspace(
                    target, preset=preset, force=False, repo_root=ROOT
                )

                resolver = tropo.ConfigResolver(str(target), str(TROPO))
                docs = tropo.analyze(str(target), [], resolver)
                findings = [f.render() for d in docs for f in d.findings]
                self.assertEqual(findings, [])

                nodes, edges = tropo.build_graph(docs)
                for node in expected.values():
                    self.assertIn(node, nodes)
                self.assertIn("agent-workspace", nodes)
                self.assertTrue(all(not e["broken"] for e in edges))

    def test_refuses_to_overwrite_without_force(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            target.mkdir()
            (target / "AGENTS.md").write_text("keep me\n", encoding="utf-8")

            with self.assertRaises(create_vivary.ScaffoldError):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=False, repo_root=ROOT
                )

            self.assertEqual((target / "AGENTS.md").read_text(encoding="utf-8"), "keep me\n")

    def test_force_allows_overwrite(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            target.mkdir()
            (target / "AGENTS.md").write_text("replace me\n", encoding="utf-8")

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, repo_root=ROOT
            )

            self.assertIn(
                "workspace contract",
                (target / "AGENTS.md").read_text(encoding="utf-8"),
            )

    def test_force_removes_legacy_module_files_for_generated_modules(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            (target / "modules").mkdir(parents=True)
            (target / "modules" / "agent-workspace.md").write_text(
                "---\nproject: old\nstatus: active\nmodule_area: old\n---\n",
                encoding="utf-8",
            )
            (target / "modules" / "codebase.md").write_text(
                "---\nproject: old\nstatus: active\nmodule_area: old\n---\n",
                encoding="utf-8",
            )

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, repo_root=ROOT
            )

            self.assertFalse((target / "modules" / "agent-workspace.md").exists())
            self.assertFalse((target / "modules" / "codebase.md").exists())
            self.assertTrue((target / "modules" / "agent-workspace" / "index.md").exists())
            self.assertTrue((target / "modules" / "codebase" / "index.md").exists())

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report)

    def test_force_plain_prunes_active_context_artifacts_but_keeps_existing_index_ignored(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )
            index_dir = target / ".cocoindex_code"
            index_dir.mkdir()
            (index_dir / "target_sqlite.db").write_text("local index\n", encoding="utf-8")

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, repo_root=ROOT
            )

            stale_paths = [
                "docs/active-context.md",
                "modules/active-context/index.md",
                "decisions/0002-cocoindex-code-sidecar.md",
                "verification/active-context-smoke.md",
                ".claude/skills/active-context/SKILL.md",
                ".agents/skills/active-context/SKILL.md",
            ]
            self.assertEqual([p for p in stale_paths if (target / p).exists()], [])
            self.assertTrue((index_dir / "target_sqlite.db").exists())
            self.assertIn(
                ".cocoindex_code/",
                (target / ".gitignore").read_text(encoding="utf-8"),
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report)

    def test_init_refuses_file_ancestor_before_writing_partial_scaffold(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            (target / "modules").mkdir(parents=True)
            (target / "modules" / "agent-workspace").write_text(
                "blocks nested module index\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "parent path"):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=False, repo_root=ROOT
                )

            self.assertFalse((target / "README.md").exists())
            self.assertFalse((target / "tropo.toml").exists())
            self.assertEqual(
                (target / "modules" / "agent-workspace").read_text(encoding="utf-8"),
                "blocks nested module index\n",
            )

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_init_refuses_symlinked_destination_parent(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            outside = Path(td) / "outside"
            outside.mkdir()
            target.mkdir()
            (target / "modules").symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked|outside"):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=False, repo_root=ROOT
                )

            self.assertFalse((outside / "agent-workspace" / "index.md").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_force_refuses_symlinked_destination_leaf(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            outside = Path(td) / "outside"
            outside.mkdir()
            target.mkdir()
            victim = outside / "victim.txt"
            victim.write_text("keep me\n", encoding="utf-8")
            (target / "README.md").symlink_to(victim)

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked|outside"):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=True, repo_root=ROOT
                )

            self.assertEqual(victim.read_text(encoding="utf-8"), "keep me\n")

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_init_refuses_symlinked_workspace_root(self):
        with temp_workspace() as td:
            outside = Path(td) / "outside"
            outside.mkdir()
            target = Path(td) / "agent-workspace"
            try:
                target.symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked target"):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=True, repo_root=ROOT
                )

            self.assertFalse((outside / "README.md").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_storage_safety_is_checked_before_scaffold_writes(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            outside = Path(td) / "outside"
            target.mkdir()
            outside.mkdir()
            try:
                (target / ".vivary").symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked|outside"):
                create_vivary.scaffold_workspace(
                    target,
                    preset="coding",
                    storage="embedded",
                    provider="lancedb",
                    repo_root=ROOT,
                )

            self.assertFalse((target / "README.md").exists())
            self.assertFalse((outside / "storage.toml").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_force_refuses_symlinked_stale_cleanup_parent_before_writes(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            outside = Path(td) / "outside"
            target.mkdir()
            outside.mkdir()
            (outside / "active-context.md").write_text("keep me\n", encoding="utf-8")
            try:
                (target / "docs").symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "stale scaffold"):
                create_vivary.scaffold_workspace(
                    target, preset="coding", force=True, repo_root=ROOT
                )

            self.assertEqual((outside / "active-context.md").read_text(encoding="utf-8"), "keep me\n")
            self.assertFalse((target / "README.md").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_force_cleanup_unlinks_stale_leaf_symlink_only(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            outside = Path(td) / "outside-active-context"
            outside.mkdir()
            skill_parent = target / ".claude" / "skills"
            skill_parent.mkdir(parents=True)
            stale = skill_parent / "active-context"
            try:
                stale.symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, repo_root=ROOT
            )

            self.assertFalse(stale.exists() or stale.is_symlink())
            self.assertTrue(outside.exists())
            self.assertTrue((skill_parent / "strato").exists())

    def test_force_dry_run_does_not_cleanup_stale_state(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            stale_parent = target / "modules"
            stale_parent.mkdir(parents=True)
            stale = stale_parent / "codebase.md"
            stale.write_text("keep me\n", encoding="utf-8")

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, dry_run=True, repo_root=ROOT
            )

            self.assertEqual(stale.read_text(encoding="utf-8"), "keep me\n")

    def test_cli_init(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            rc = create_vivary.main(
                ["init", str(target), "--preset", "coding", "--repo-root", str(ROOT)]
            )

            self.assertEqual(rc, 0)
            self.assertTrue((target / "AGENTS.md").exists())

    def test_with_default_command_injects_init(self):
        # Bare target -> init (parity with the npm launcher's mapArgs).
        self.assertEqual(create_vivary.with_default_command(["ws"]), ["init", "ws"])
        self.assertEqual(
            create_vivary.with_default_command(["ws", "--preset", "coding"]),
            ["init", "ws", "--preset", "coding"],
        )
        # Explicit subcommands and leading flags pass through unchanged.
        self.assertEqual(create_vivary.with_default_command(["init", "ws"]), ["init", "ws"])
        self.assertEqual(create_vivary.with_default_command(["doctor", "ws"]), ["doctor", "ws"])
        self.assertEqual(create_vivary.with_default_command(["-h"]), ["-h"])
        self.assertEqual(create_vivary.with_default_command([]), [])

    def test_cli_bare_target_defaults_to_init(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            # No "init" subcommand — a bare target must still scaffold.
            rc = create_vivary.main(
                [str(target), "--preset", "coding", "--repo-root", str(ROOT)]
            )

            self.assertEqual(rc, 0)
            self.assertTrue((target / "AGENTS.md").exists())

    def test_cli_active_context_flag(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            rc = create_vivary.main(
                [
                    "init",
                    str(target),
                    "--preset",
                    "coding",
                    "--active-context",
                    "cocoindex-code",
                    "--repo-root",
                    str(ROOT),
                ]
            )

            self.assertEqual(rc, 0)
            self.assertTrue((target / "docs" / "active-context.md").exists())
            self.assertTrue(
                (target / ".agents" / "skills" / "active-context" / "SKILL.md").exists()
            )

    def test_doctor_accepts_generated_workspace(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["graph"]["broken"], 0)
            self.assertGreaterEqual(report["graph"]["nodes"], 9)

    def test_doctor_reports_missing_module_index(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "modules" / "codebase" / "index.md").unlink()

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn(
                "module directory missing index.md: modules/codebase",
                report["errors"],
            )

    def test_doctor_reports_legacy_module_file_duplicate(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "modules" / "codebase.md").write_text(
                "---\nproject: old\nstatus: active\nmodule_area: old\n---\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn(
                "legacy module file coexists with module index: modules/codebase.md",
                report["errors"],
            )

    def test_doctor_reports_missing_contract_file(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "STATE.md").unlink()

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("missing required file: STATE.md", report["errors"])

    def test_cli_doctor_exit_codes(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="second-brain", force=False, repo_root=ROOT
            )

            self.assertEqual(
                create_vivary.main(["doctor", str(target), "--repo-root", str(ROOT)]),
                0,
            )
            (target / "AGENTS.md").unlink()
            self.assertEqual(
                create_vivary.main(["doctor", str(target), "--repo-root", str(ROOT)]),
                1,
            )


class TestAgentFlags(unittest.TestCase):
    """Tests for --json, --auto, --dry-run, --storage and the wizard subcommand."""

    def test_init_json_flag_returns_valid_json(self):
        with temp_workspace() as td:
            target = Path(td) / "json-demo"
            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "init", str(target),
                    "--preset", "coding",
                    "--no-wizard",
                    "--json",
                    "--repo-root", str(ROOT),
                ])
            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertTrue(out["ok"])
            self.assertEqual(out["preset"], "coding")
            self.assertIn("files", out)
            self.assertGreater(out["files"], 0)
            self.assertFalse(out["dry_run"])

    def test_init_storage_file_does_not_write_vivary_dir(self):
        with temp_workspace() as td:
            target = Path(td) / "file-storage"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )
            self.assertFalse((target / ".vivary").exists())

    def test_init_storage_embedded_writes_vivary_storage_toml(self):
        with temp_workspace() as td:
            target = Path(td) / "embedded-demo"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="embedded", provider="lancedb",
                repo_root=ROOT,
            )
            cfg = target / ".vivary" / "storage.toml"
            self.assertTrue(cfg.exists(), ".vivary/storage.toml should be created")
            text = cfg.read_text(encoding="utf-8")
            self.assertIn("embedded", text)
            self.assertIn("lancedb", text)

    def test_init_dry_run_writes_nothing(self):
        with temp_workspace() as td:
            target = Path(td) / "dry-run-demo"
            self.assertFalse(target.exists())
            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "init", str(target),
                    "--no-wizard",
                    "--dry-run",
                    "--json",
                    "--repo-root", str(ROOT),
                ])
            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertTrue(out["dry_run"])
            self.assertFalse(target.exists(), "dry-run must not create any files")

    def test_init_dry_run_does_not_install_embedded_backend(self):
        with temp_workspace() as td:
            target = Path(td) / "dry-run-embedded"
            import io, contextlib, json
            buf = io.StringIO()

            with mock.patch.object(create_vivary, "_ensure_backend_installed") as ensure:
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "init", str(target),
                        "--preset", "coding",
                        "--no-wizard",
                        "--storage", "embedded",
                        "--dry-run",
                        "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 0)
            ensure.assert_not_called()
            out = json.loads(buf.getvalue())
            self.assertEqual(out["storage"], "embedded")
            self.assertEqual(out["installed"], [])
            self.assertTrue(out["dry_run"])
            self.assertFalse(target.exists(), "dry-run must not create any files")

    def test_init_auto_flag_skips_prompts(self):
        with temp_workspace() as td:
            target = Path(td) / "auto-demo"
            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "init", str(target),
                    "--auto",
                    "--size", "small",
                    "--json",
                    "--repo-root", str(ROOT),
                ])
            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertTrue(out["ok"])
            # size=small → file backend → no .vivary/ dir
            self.assertEqual(out["storage"], "file")
            self.assertFalse((target / ".vivary").exists())

    def test_init_auto_cloud_config_does_not_install_backend(self):
        with temp_workspace() as td:
            target = Path(td) / "auto-cloud-demo"
            import io, contextlib, json
            buf = io.StringIO()

            with mock.patch.object(create_vivary, "_ensure_backend_installed") as ensure:
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "init", str(target),
                        "--auto",
                        "--privacy", "cloud",
                        "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 0)
            ensure.assert_not_called()
            out = json.loads(buf.getvalue())
            self.assertEqual(out["storage"], "cloud")
            self.assertEqual(out["provider"], "qdrant")
            self.assertEqual(out["installed"], [])
            self.assertTrue((target / ".vivary" / "storage.toml").exists())

    def test_wizard_subcommand_writes_storage_toml(self):
        with temp_workspace() as td:
            target = Path(td) / "wizard-demo"
            # First scaffold a bare workspace
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )
            # Now run wizard to reconfigure to embedded
            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "wizard", str(target),
                    "--auto",
                    "--storage", "embedded",
                    "--provider", "lancedb",
                    "--json",
                    "--repo-root", str(ROOT),
                ])
            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertTrue(out["ok"])
            self.assertEqual(out["storage"], "embedded")
            cfg = target / ".vivary" / "storage.toml"
            self.assertTrue(cfg.exists())

    def test_wizard_cloud_config_does_not_install_backend(self):
        with temp_workspace() as td:
            target = Path(td) / "wizard-cloud-demo"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )

            import io, contextlib, json
            buf = io.StringIO()
            with mock.patch.object(create_vivary, "_ensure_backend_installed") as ensure:
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "wizard", str(target),
                        "--auto",
                        "--storage", "cloud",
                        "--provider", "qdrant",
                        "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 0)
            ensure.assert_not_called()
            out = json.loads(buf.getvalue())
            self.assertEqual(out["storage"], "cloud")
            self.assertEqual(out["provider"], "qdrant")
            self.assertEqual(out["installed"], [])

    def test_wizard_dry_run_does_not_install_backend(self):
        with temp_workspace() as td:
            target = Path(td) / "wizard-dry-run"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )

            import io, contextlib, json
            buf = io.StringIO()
            with mock.patch.object(create_vivary, "_ensure_backend_installed") as ensure:
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "wizard", str(target),
                        "--auto",
                        "--storage", "embedded",
                        "--dry-run",
                        "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 0)
            ensure.assert_not_called()
            out = json.loads(buf.getvalue())
            self.assertEqual(out["storage"], "embedded")
            self.assertEqual(out["installed"], [])
            self.assertTrue(out["dry_run"])
            self.assertFalse((target / ".vivary" / "storage.toml").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_wizard_json_reports_storage_safety_error(self):
        with temp_workspace() as td:
            target = Path(td) / "wizard-symlink"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )
            outside = Path(td) / "outside"
            outside.mkdir()
            try:
                (target / ".vivary").symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "wizard", str(target),
                    "--auto",
                    "--storage", "embedded",
                    "--json",
                    "--repo-root", str(ROOT),
                ])

            self.assertEqual(rc, 1)
            out = json.loads(buf.getvalue())
            self.assertFalse(out["ok"])
            self.assertRegex(out["error"], "symlinked|outside")
            self.assertFalse((outside / "storage.toml").exists())

    def test_doctor_reports_backend_field(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-backend"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="embedded", provider="lancedb",
                repo_root=ROOT,
            )
            import io, contextlib, json
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--json", "--repo-root", str(ROOT)
                ])
            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertIn("backend", out)
            self.assertEqual(out["backend"], "embedded")

    def test_vivary_dir_data_in_gitignore(self):
        with temp_workspace() as td:
            target = Path(td) / "gitignore-check"
            create_vivary.scaffold_workspace(
                target, preset="coding", storage="file", repo_root=ROOT
            )
            gitignore = (target / ".gitignore").read_text(encoding="utf-8")
            self.assertIn(".vivary/data/", gitignore)


if __name__ == "__main__":
    unittest.main()
