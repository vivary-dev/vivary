"""Tests for the create-vivary workspace scaffold."""

import io
import json
import os
import sys
import shutil
import subprocess
import unittest
import uuid
from contextlib import contextmanager, redirect_stderr, redirect_stdout
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
    def test_receipt_flag_appends_privacy_preserving_jsonl_without_polluting_stdout(self):
        with temp_workspace() as td:
            receipt = td / "receipts" / "runs.jsonl"
            buf = io.StringIO()

            with redirect_stdout(buf):
                rc = create_vivary.main([
                    "capabilities",
                    "--preset",
                    "coding",
                    "--json",
                    "--receipt",
                    str(receipt),
                ])

            self.assertEqual(rc, 0)
            self.assertTrue(json.loads(buf.getvalue())["ok"])
            records = [json.loads(line) for line in receipt.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(records), 1)
            record = records[0]
            self.assertEqual(record["schema"], "vivary.run_receipt.v1")
            self.assertEqual(record["tool"], "create-vivary")
            self.assertEqual(record["command"], "capabilities")
            self.assertEqual(record["exit_code"], 0)
            self.assertTrue(record["ok"])
            self.assertIn("--json", record["flags"])
            self.assertIn("--preset", record["flags"])
            self.assertNotIn("--receipt", record["flags"])

            serialized = json.dumps(record, sort_keys=True)
            self.assertNotIn(str(td), serialized)
            self.assertNotIn("coding", serialized)

    def test_receipt_env_appends_jsonl(self):
        with temp_workspace() as td:
            receipt = td / "runs.jsonl"
            buf = io.StringIO()

            with mock.patch.dict(os.environ, {"VIVARY_RECEIPT_LOG": str(receipt)}):
                with redirect_stdout(buf):
                    rc = create_vivary.main(["capabilities", "--json"])

            self.assertEqual(rc, 0)
            self.assertTrue(json.loads(buf.getvalue())["ok"])
            record = json.loads(receipt.read_text(encoding="utf-8").strip())
            self.assertEqual(record["receipt_source"], "env")
            self.assertEqual(record["command"], "capabilities")

    def test_global_receipt_preserves_bare_target_init_shorthand(self):
        with temp_workspace() as td:
            target = td / "agent-workspace"
            receipt = td / "runs.jsonl"
            buf = io.StringIO()

            with redirect_stdout(buf):
                rc = create_vivary.main([
                    "--receipt",
                    str(receipt),
                    str(target),
                    "--preset",
                    "coding",
                    "--auto",
                    "--dry-run",
                    "--json",
                ])

            self.assertEqual(rc, 0)
            result = json.loads(buf.getvalue())
            self.assertTrue(result["ok"])
            self.assertTrue(result["dry_run"])
            record = json.loads(receipt.read_text(encoding="utf-8").strip())
            self.assertEqual(record["command"], "init")

    def test_malformed_receipt_flag_does_not_create_option_named_file(self):
        with temp_workspace() as td:
            old_cwd = Path.cwd()
            err = io.StringIO()
            try:
                os.chdir(td)
                with redirect_stderr(err):
                    with self.assertRaises(SystemExit):
                        create_vivary.main(["capabilities", "--receipt", "--json"])
            finally:
                os.chdir(old_cwd)

            self.assertFalse((td / "--json").exists())
            self.assertIn("expected one argument", err.getvalue())

    def test_receipt_scanner_stops_at_argument_separator(self):
        with temp_workspace() as td:
            receipt = td / "should-not-exist.jsonl"
            self.assertEqual(
                create_vivary._extract_receipt_path([
                    "capabilities",
                    "--",
                    "--receipt",
                    str(receipt),
                ]),
                (None, None),
            )
            self.assertEqual(
                create_vivary._receipt_flags([
                    "capabilities",
                    "--json",
                    "--",
                    "--receipt",
                    str(receipt),
                ]),
                ["--json"],
            )

    def test_receipt_rejects_junction_ancestors_when_platform_reports_them(self):
        with temp_workspace() as td:
            (td / "junction").mkdir()
            target = td / "junction" / "receipts" / "runs.jsonl"

            with mock.patch.object(
                create_vivary.os.path,
                "isjunction",
                create=True,
                side_effect=lambda p: Path(p).name == "junction",
            ):
                self.assertTrue(create_vivary._receipt_has_symlink_ancestor(target))

    def test_receipt_refuses_directory_target(self):
        with temp_workspace() as td:
            bad_receipt = td / "not-a-file"
            bad_receipt.mkdir()
            out = io.StringIO()
            err = io.StringIO()

            with redirect_stdout(out), redirect_stderr(err):
                rc = create_vivary.main([
                    "capabilities",
                    "--json",
                    "--receipt",
                    str(bad_receipt),
                ])

            self.assertEqual(rc, 1)
            self.assertTrue(json.loads(out.getvalue())["ok"])
            self.assertIn("receipt path must be a regular file", err.getvalue())

    def test_receipt_refuses_windows_device_names(self):
        if os.name != "nt":
            self.skipTest("Windows device names are platform-specific")
        out = io.StringIO()
        err = io.StringIO()

        with redirect_stdout(out), redirect_stderr(err):
            rc = create_vivary.main(["capabilities", "--json", "--receipt", "NUL"])

        self.assertEqual(rc, 1)
        self.assertTrue(json.loads(out.getvalue())["ok"])
        self.assertIn("Windows device name", err.getvalue())

    def test_doctor_trend_is_recorded_as_receipt_flag(self):
        self.assertIn("--trend", create_vivary._receipt_flags(["doctor", "x", "--trend"]))

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
            "knowledge-work": {
                "module": "workbench",
                "change": "workbench-first-artifact",
                "verification": "workbench-proof",
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

    def test_knowledge_work_preset_adds_workbench_source_router(self):
        with temp_workspace() as td:
            target = Path(td) / "knowledge-workspace"
            create_vivary.scaffold_workspace(
                target, preset="knowledge-work", force=False, repo_root=ROOT
            )

            expected = [
                "modules/workbench/index.md",
                "modules/sources/index.md",
                "changes/workbench-first-artifact.md",
                "verification/workbench-proof.md",
            ]
            self.assertEqual([p for p in expected if not (target / p).exists()], [])

            module_index = (target / "modules" / "index.md").read_text(encoding="utf-8")
            self.assertIn("modules/sources/index.md", module_index)
            sources = (target / "modules" / "sources" / "index.md").read_text(encoding="utf-8")
            self.assertIn("source_files: []", sources)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report)
            self.assertIn("sources", tropo.build_graph(tropo.analyze(str(target), [], tropo.ConfigResolver(str(target), str(TROPO))))[0])

    def test_default_scaffold_has_no_semantic_memory_config(self):
        with temp_workspace() as td:
            target = Path(td) / "plain"
            create_vivary.scaffold_workspace(
                target, preset="second-brain", force=False, repo_root=ROOT
            )

            self.assertFalse((target / ".vivary" / "memory.toml").exists())
            self.assertFalse((target / "docs" / "semantic-memory.md").exists())
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertEqual(report["memory"]["status"], "disabled")

    def test_semantic_memory_local_writes_policy_and_doctors_healthy(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-local"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                memory="local",
                force=False,
                repo_root=ROOT,
            )

            cfg = (target / ".vivary" / "memory.toml").read_text(encoding="utf-8")
            self.assertIn('provider = "vivary-local"', cfg)
            self.assertTrue((target / "modules" / "semantic-memory" / "index.md").exists())
            self.assertTrue((target / "verification" / "semantic-memory-smoke.md").exists())

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["memory"]["provider"], "vivary-local")
            self.assertEqual(report["memory"]["status"], "healthy")

    def test_semantic_memory_cognee_reports_unavailable_without_dependency(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-cognee"
            create_vivary.scaffold_workspace(
                target,
                preset="second-brain",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )

            cfg = (target / ".vivary" / "memory.toml").read_text(encoding="utf-8")
            self.assertIn('provider = "cognee"', cfg)
            self.assertIn('allow_network = false', cfg)
            self.assertIn('allow_without_api_key = false', cfg)
            self.assertIn('allow_telemetry = false', cfg)
            doc = (target / "docs" / "semantic-memory.md").read_text(encoding="utf-8")
            self.assertIn("vivary-cognee index --root . --dry-run --json", doc)
            self.assertIn("known graph node ids", doc)
            with mock.patch.object(create_vivary, "_is_importable", return_value=False):
                report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["memory"]["provider"], "cognee")
            self.assertEqual(report["memory"]["status"], "unavailable")

    def test_semantic_memory_cognee_reports_configured_when_adapter_installed(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-cognee"
            create_vivary.scaffold_workspace(
                target,
                preset="second-brain",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )

            def fake_importable(name):
                return name == "vivary_cognee"

            with mock.patch.object(create_vivary, "_is_importable", side_effect=fake_importable):
                report = create_vivary.doctor_workspace(target, repo_root=ROOT)

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "configured")
        self.assertIn("vivary-memory-cognee", report["memory"]["detail"])

    def test_doctor_reports_invalid_memory_config_schema(self):
        with temp_workspace() as td:
            target = Path(td) / "bad-memory"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )
            (target / ".vivary" / "memory.toml").write_text(
                '[memory]\nenabled = "false"\nprovider = "cognee"\n',
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

        self.assertEqual(report["memory"]["status"], "misconfigured")
        self.assertIn("memory.enabled", report["memory"]["detail"])

    def test_doctor_accepts_bom_prefixed_memory_config(self):
        with temp_workspace() as td:
            target = Path(td) / "bom-memory"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )
            (target / ".vivary" / "memory.toml").write_text(
                '[memory]\nenabled = true\nmode = "semantic-provider"\nprovider = "cognee"\n',
                encoding="utf-8-sig",
            )
            with mock.patch.object(create_vivary, "_is_importable", return_value=False):
                report = create_vivary.doctor_workspace(target, repo_root=ROOT)

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "unavailable")

    def test_capability_report_lists_memory_and_preset_specific_active_context(self):
        report = create_vivary.capability_report("knowledge-work")
        ids = {cap["id"] for cap in report["available_capabilities"]}
        self.assertIn("storage:embedded", ids)
        self.assertIn("memory:local", ids)
        self.assertIn("memory:cognee", ids)
        self.assertNotIn("active-context:cocoindex-code", ids)

        coding = create_vivary.capability_report("coding")
        coding_ids = {cap["id"] for cap in coding["available_capabilities"]}
        self.assertIn("active-context:cocoindex-code", coding_ids)

    def test_cli_capabilities_json(self):
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            rc = create_vivary.main(["capabilities", "--preset", "knowledge-work", "--json"])

        self.assertEqual(rc, 0)
        data = json.loads(buf.getvalue())
        ids = {cap["id"] for cap in data["available_capabilities"]}
        self.assertIn("memory:cognee", ids)
        self.assertEqual(data["preset"], "knowledge-work")

    def test_cli_memory_cognee_dry_run_reports_required_install_without_writing(self):
        with temp_workspace() as td:
            target = Path(td) / "dry-memory"
            buf = io.StringIO()
            with mock.patch("sys.stdout", buf):
                rc = create_vivary.main(
                    [
                        "init",
                        str(target),
                        "--preset",
                        "writing",
                        "--memory",
                        "cognee",
                        "--dry-run",
                        "--json",
                        "--repo-root",
                        str(ROOT),
                    ]
                )

            self.assertEqual(rc, 0)
            data = json.loads(buf.getvalue())
            self.assertEqual(data["memory"], "cognee")
            self.assertIn("vivary-memory-cognee", data["memory_capability"]["requires_install"])
            self.assertTrue(data["memory_capability"]["requires_explicit_index"])
            self.assertEqual(data["memory_capability"]["adapter_status"], "optional-package")
            self.assertFalse((target / ".vivary" / "memory.toml").exists())

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

    def test_cli_version(self):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", stdout):
            with self.assertRaises(SystemExit) as exc:
                create_vivary.main(["--version"])

        self.assertEqual(exc.exception.code, 0)
        self.assertEqual(stdout.getvalue().strip(), f"create-vivary {create_vivary.__version__}")

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

    def test_doctor_rejects_commented_or_negated_privacy_ignores(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").write_text(
                "# misleading privacy comments only\n"
                "# USER.md\n"
                "!MEMORY.md\n"
                "not-USER.md-backup\n"
                "docs/memory/*-example\n"
                "# heartbeat-reports/*\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("privacy ignore missing: USER.md", report["errors"])
            self.assertIn("privacy ignore missing: MEMORY.md", report["errors"])
            self.assertIn("privacy ignore missing: memory/*", report["errors"])
            self.assertIn("privacy ignore missing: heartbeat-reports/*", report["errors"])

    def test_doctor_accepts_root_privacy_ignores_with_gitkeep_exception(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").write_text(
                "# Strato private context\n"
                "/USER.md\n"
                "/MEMORY.md\n"
                "/memory/*\n"
                "!memory/.gitkeep\n"
                "/heartbeat-reports/*\n"
                "!heartbeat-reports/.gitkeep\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)

    def test_doctor_rejects_broad_privacy_negations(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").write_text(
                "/USER.md\n"
                "/MEMORY.md\n"
                "/memory/*\n"
                "!memory/.gitkeep\n"
                "/heartbeat-reports/*\n"
                "!heartbeat-reports/.gitkeep\n"
                "!*.md\n"
                "!memory/*.md\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("privacy ignore missing: USER.md", report["errors"])
            self.assertIn("privacy ignore missing: MEMORY.md", report["errors"])
            self.assertIn("privacy ignore missing: memory/*", report["errors"])
            self.assertIn("privacy ignore missing: heartbeat-reports/*", report["errors"])

    def test_doctor_rejects_indented_privacy_ignores(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").write_text(
                " USER.md\n"
                " MEMORY.md\n"
                " memory/*\n"
                " heartbeat-reports/*\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("privacy ignore missing: USER.md", report["errors"])
            self.assertIn("privacy ignore missing: MEMORY.md", report["errors"])
            self.assertIn("privacy ignore missing: memory/*", report["errors"])
            self.assertIn("privacy ignore missing: heartbeat-reports/*", report["errors"])

    def test_doctor_rejects_nested_memory_gitignore_negation(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").write_text(
                "/USER.md\n"
                "/MEMORY.md\n"
                "/memory/*\n"
                "!memory/.gitkeep\n"
                "/heartbeat-reports/*\n"
                "!heartbeat-reports/.gitkeep\n",
                encoding="utf-8",
            )
            (target / "memory" / ".gitignore").write_text("!secret.md\n", encoding="utf-8")

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("privacy ignore missing: memory/*", report["errors"])

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

    def test_no_wizard_defaults_to_file_storage(self):
        with temp_workspace() as td:
            target = Path(td) / "no-wizard-default"
            import io, contextlib, json
            buf = io.StringIO()

            with mock.patch.object(create_vivary, "_ensure_backend_installed") as ensure:
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "init", str(target),
                        "--preset", "coding",
                        "--no-wizard",
                        "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 0)
            ensure.assert_not_called()
            out = json.loads(buf.getvalue())
            self.assertEqual(out["storage"], "file")
            self.assertFalse((target / ".vivary").exists())

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

    def test_embedded_backend_install_falls_back_to_uv_when_pip_is_unavailable(self):
        pip_error = subprocess.CalledProcessError(1, ["python", "-m", "pip"])

        with mock.patch.object(create_vivary, "_is_importable", return_value=False), \
             mock.patch.object(create_vivary.shutil, "which", return_value="uv"), \
             mock.patch.object(create_vivary.subprocess, "check_call") as check_call:
            check_call.side_effect = [pip_error, None]

            installed = create_vivary._ensure_backend_installed("lancedb", yes=True)

        self.assertEqual(installed, ["lancedb"])
        self.assertEqual(len(check_call.call_args_list), 2)
        self.assertEqual(
            check_call.call_args_list[1].args[0],
            ["uv", "pip", "install", "--python", sys.executable, "vivary-tropo[embedded]"],
        )

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

    def test_doctor_default_writes_no_state_file(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-default"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )

            rc = create_vivary.main(["doctor", str(target), "--repo-root", str(ROOT)])

            self.assertEqual(rc, 0)
            self.assertFalse((target / ".vivary" / "doctor-state.json").exists())
            self.assertFalse((target / ".vivary").exists())

    def test_doctor_trend_first_run_is_graceful_and_writes_state(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-first"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            self.assertIn("trend: first recorded run", buf.getvalue())

            state_path = target / ".vivary" / "doctor-state.json"
            self.assertTrue(state_path.exists())
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], 1)
            metrics = state["metrics"]
            for key in (
                "date", "graph_nodes", "graph_edges", "graph_broken",
                "error_count", "warning_count", "module_index_count",
                "total_files",
            ):
                self.assertIn(key, metrics)
            self.assertEqual(metrics["graph_broken"], 0)
            self.assertEqual(metrics["error_count"], 0)

    def test_doctor_trend_json_first_run_reports_null_prior(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-first-json"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--json", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertIn("trend", out)
            self.assertIsNone(out["trend"]["prior"])
            self.assertIsNone(out["trend"]["deltas"])
            self.assertIn("current", out["trend"])
            self.assertNotIn("trend_warning", out)

    def test_doctor_trend_second_run_reports_deltas_after_workspace_change(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-second"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )

            self.assertEqual(
                create_vivary.main([
                    "doctor", str(target), "--trend", "--repo-root", str(ROOT)
                ]),
                0,
            )

            (target / "modules" / "extra-module").mkdir()
            (target / "modules" / "extra-module" / "index.md").write_text(
                "---\n"
                "project: doctor-trend-second\n"
                "status: active\n"
                "module_area: extra\n"
                "---\n"
                "# Extra module\n",
                encoding="utf-8",
            )

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--json", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            deltas = out["trend"]["deltas"]
            self.assertEqual(deltas["module_index_count"], 1)
            self.assertEqual(deltas["total_files"], 1)
            self.assertGreaterEqual(deltas["graph_nodes"], 1)
            self.assertEqual(deltas["graph_broken"], 0)
            self.assertEqual(out["trend"]["prior"]["module_index_count"], 2)
            self.assertEqual(out["trend"]["current"]["module_index_count"], 3)

    def test_doctor_trend_corrupt_state_file_treated_as_first_run(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-corrupt"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )
            (target / ".vivary").mkdir()
            (target / ".vivary" / "doctor-state.json").write_text(
                "not valid json {{{", encoding="utf-8"
            )

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            output = buf.getvalue()
            self.assertIn("warning:", output)
            self.assertIn("treating as first recorded run", output)
            self.assertIn("trend: first recorded run", output)

            # doctor recovered and wrote a fresh, valid state file
            state = json.loads(
                (target / ".vivary" / "doctor-state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(state["schema_version"], 1)

            # in --json mode a corrupt state file is distinguishable from a
            # real first run via trend_warning (still not in warnings/count)
            (target / ".vivary" / "doctor-state.json").write_text(
                "not valid json {{{", encoding="utf-8"
            )
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--json", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertIn("trend_warning", out)
            self.assertIn("treating as first recorded run", out["trend_warning"])
            self.assertIsNone(out["trend"]["prior"])
            self.assertEqual(out["warnings"], [])

    def test_doctor_trend_partial_metrics_state_treated_as_first_run(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-partial"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )
            (target / ".vivary").mkdir()
            (target / ".vivary" / "doctor-state.json").write_text(
                json.dumps({"schema_version": 1, "metrics": {"graph_nodes": 9}}),
                encoding="utf-8",
            )

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 0)
            output = buf.getvalue()
            self.assertIn("warning:", output)
            self.assertIn("treating as first recorded run", output)
            self.assertIn("trend: first recorded run", output)

            state = json.loads(
                (target / ".vivary" / "doctor-state.json").read_text(encoding="utf-8")
            )
            for key in (
                "date", "graph_nodes", "graph_edges", "graph_broken",
                "error_count", "warning_count", "module_index_count",
                "total_files",
            ):
                self.assertIn(key, state["metrics"])

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_doctor_trend_refuses_symlinked_state_file(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-symlink"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )
            outside = Path(td) / "outside"
            outside.mkdir()
            victim = outside / "victim.json"
            victim.write_text("{}", encoding="utf-8")

            state_path = target / ".vivary" / "doctor-state.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                state_path.symlink_to(victim)
            except OSError:
                return

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(target), "--trend", "--json", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 1)
            out = json.loads(buf.getvalue())
            self.assertFalse(out["ok"])
            self.assertRegex(" ".join(out["errors"]), "symlinked|outside")
            self.assertEqual(victim.read_text(encoding="utf-8"), "{}")

    def test_doctor_trend_reports_state_write_oserror_cleanly(self):
        with temp_workspace() as td:
            target = Path(td) / "doctor-trend-readonly"
            create_vivary.scaffold_workspace(
                target, preset="coding", repo_root=ROOT
            )

            import io, contextlib
            buf = io.StringIO()
            with mock.patch.object(
                create_vivary,
                "_write_doctor_state",
                side_effect=PermissionError("simulated read-only .vivary"),
            ):
                with contextlib.redirect_stdout(buf):
                    rc = create_vivary.main([
                        "doctor", str(target), "--trend", "--json",
                        "--repo-root", str(ROOT),
                    ])

            self.assertEqual(rc, 1)
            out = json.loads(buf.getvalue())
            self.assertFalse(out["ok"])
            self.assertIn(
                "doctor --trend: simulated read-only .vivary", out["errors"]
            )
            self.assertIsNone(out["trend"])
            self.assertFalse((target / ".vivary" / "doctor-state.json").exists())


class VersionParityTests(unittest.TestCase):
    def test_version_constant_matches_pyproject_and_npm(self):
        import tomllib
        root = Path(__file__).resolve().parents[1]
        declared = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
        self.assertEqual(
            create_vivary.__version__, declared,
            "create_vivary.__version__ and pyproject version must be bumped together",
        )
        npm = json.loads((root / "npm" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(npm["version"], declared, "npm package.json must stay in lockstep")


if __name__ == "__main__":
    unittest.main()
