"""Tests for the create-vivary workspace scaffold."""

import argparse
import io
import importlib
import json
import os
import sys
import shutil
import stat
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


def run_doctor_json(target: Path, *args: str) -> tuple[int, dict]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = create_vivary.main([
            "doctor",
            str(target),
            *args,
            "--json",
            "--repo-root",
            str(ROOT),
        ])
    return rc, json.loads(buf.getvalue())


class CreateVivaryTests(unittest.TestCase):
    def test_symlink_or_junction_uses_windows_reparse_fallback(self):
        class FakeStat:
            st_file_attributes = getattr(
                create_vivary.stat,
                "FILE_ATTRIBUTE_REPARSE_POINT",
                0x400,
            )

        with mock.patch.object(Path, "is_symlink", return_value=False), \
             mock.patch.object(create_vivary.os, "stat", return_value=FakeStat()):
            self.assertTrue(create_vivary._is_symlink_or_junction(Path("linked-dir")))

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
            self.assertIn(".strato/private/", gitignore)
            self.assertIn("*.vivary-tmp", gitignore)

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
            with mock.patch.object(create_vivary, "_safe_cognee_adapter_available", return_value=False):
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

            with mock.patch.object(create_vivary, "_safe_cognee_adapter_available", return_value=True):
                report = create_vivary.doctor_workspace(target, repo_root=ROOT)

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "configured")
        self.assertIn("vivary-memory-cognee", report["memory"]["detail"])

    def test_semantic_memory_cognee_ignores_workspace_local_adapter_spoof(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-cognee"
            create_vivary.scaffold_workspace(
                target,
                preset="second-brain",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )
            (target / "vivary_cognee.py").write_text("raise RuntimeError('do not import')\n", encoding="utf-8")
            importlib.invalidate_caches()
            old_path = list(sys.path)
            sys.path.insert(0, str(target))
            try:
                with mock.patch.object(
                    create_vivary.importlib_metadata,
                    "version",
                    return_value="0.1.1",
                ):
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            finally:
                sys.path[:] = old_path
                importlib.invalidate_caches()

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "unavailable")

    def test_semantic_memory_cognee_requires_adapter_capability_markers(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-cognee"
            create_vivary.scaffold_workspace(
                target,
                preset="second-brain",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )
            fake_site = Path(td) / "fake-site"
            fake_site.mkdir()
            (fake_site / "vivary_cognee.py").write_text('__version__ = "0.1.1"\n', encoding="utf-8")
            importlib.invalidate_caches()
            old_path = list(sys.path)
            old_module = sys.modules.pop("vivary_cognee", None)
            sys.path.insert(0, str(fake_site))
            try:
                with mock.patch.object(
                    create_vivary.importlib_metadata,
                    "version",
                    return_value="0.1.1",
                ):
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            finally:
                sys.path[:] = old_path
                if old_module is not None:
                    sys.modules["vivary_cognee"] = old_module
                else:
                    sys.modules.pop("vivary_cognee", None)
                importlib.invalidate_caches()

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "unavailable")

    def test_semantic_memory_cognee_requires_callable_adapter(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-cognee"
            create_vivary.scaffold_workspace(
                target,
                preset="second-brain",
                memory="cognee",
                force=False,
                repo_root=ROOT,
            )
            fake_site = Path(td) / "fake-site"
            fake_site.mkdir()
            (fake_site / "vivary_cognee.py").write_text(
                '__version__ = "0.1.1"\n'
                "TROPO_SEMANTIC_ADAPTER_API = 1\n"
                "REQUIRES_EXPLICIT_PROVIDER_GATES = True\n"
                "CogneeMemoryAdapter = None\n",
                encoding="utf-8",
            )
            importlib.invalidate_caches()
            old_path = list(sys.path)
            old_module = sys.modules.pop("vivary_cognee", None)
            sys.path.insert(0, str(fake_site))
            try:
                with mock.patch.object(
                    create_vivary.importlib_metadata,
                    "version",
                    return_value="0.1.1",
                ):
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
            finally:
                sys.path[:] = old_path
                if old_module is not None:
                    sys.modules["vivary_cognee"] = old_module
                else:
                    sys.modules.pop("vivary_cognee", None)
                importlib.invalidate_caches()

        self.assertEqual(report["memory"]["provider"], "cognee")
        self.assertEqual(report["memory"]["status"], "unavailable")

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

    def _block_removal(self, victim: Path):
        """Make `victim` unremovable, returning a restore callable — or skip.

        Windows refuses to delete a read-only file; POSIX refuses to unlink from a
        directory without write permission. Neither holds for root, and DrvFs ignores
        both, so the guard is probed with a throwaway sibling before the test relies
        on it. The caller MUST call the returned restore in a `finally`, or
        `temp_workspace`'s bare `rmtree` fails and the error reads as a harness bug.
        """
        parent = victim.parent
        probe = parent / "vivary-removal-probe.tmp"
        probe.write_text("probe\n", encoding="utf-8")
        if os.name == "nt":
            os.chmod(probe, stat.S_IREAD)
            os.chmod(victim, stat.S_IREAD)

            def restore():
                for path in (victim, probe):
                    if path.exists():
                        os.chmod(path, stat.S_IWRITE)
                        path.unlink()
        else:
            original = stat.S_IMODE(parent.lstat().st_mode)
            os.chmod(parent, 0o500)

            def restore():
                os.chmod(parent, original)
                if probe.exists():
                    probe.unlink()

        try:
            probe.unlink()
        except OSError:
            return restore
        restore()
        self.skipTest("filesystem does not enforce removal permissions here")

    def test_remove_path_raises_scaffold_error_when_file_cannot_be_removed(self):
        with temp_workspace() as td:
            target = Path(td) / "unremovable-file"
            target.mkdir()
            stale_parent = target / "modules"
            stale_parent.mkdir()
            stale = stale_parent / "codebase.md"
            stale.write_text("legacy\n", encoding="utf-8")

            restore = self._block_removal(stale)
            try:
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary._remove_path(target, stale)
            finally:
                restore()

    def test_remove_path_raises_scaffold_error_when_directory_cannot_be_removed(self):
        with temp_workspace() as td:
            target = Path(td) / "unremovable-dir"
            target.mkdir()
            stale_parent = target / "modules"
            stale_parent.mkdir()
            stale = stale_parent / "active-context"
            stale.mkdir()
            trapped = stale / "index.md"
            trapped.write_text("legacy\n", encoding="utf-8")

            restore = self._block_removal(trapped)
            try:
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary._remove_path(target, stale)
            finally:
                restore()

    def test_force_cleanup_failure_still_emits_json(self):
        """The user-visible harm behind this finding: a raw OSError from cleanup
        escapes `main`, so `--json` prints a traceback and no JSON at all."""
        with temp_workspace() as td:
            target = Path(td) / "cleanup-json"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            stale = target / "modules" / "codebase.md"
            stale.write_text("legacy\n", encoding="utf-8")

            restore = self._block_removal(stale)
            try:
                buf = io.StringIO()
                with redirect_stdout(buf), redirect_stderr(io.StringIO()):
                    rc = create_vivary.main([
                        "init",
                        str(target),
                        "--preset",
                        "coding",
                        "--force",
                        "--no-wizard",
                        "--json",
                        "--repo-root",
                        str(ROOT),
                    ])
            finally:
                restore()

            self.assertEqual(rc, 1)
            payload = json.loads(buf.getvalue())
            self.assertFalse(payload["ok"])
            self.assertIn("stale scaffold path", payload["error"])

    @unittest.skipIf(os.name != "nt", "junctions are Windows-only")
    def test_force_cleanup_removes_stale_junction_without_touching_its_target(self):
        """Regression guard for the reparse-point branch of `_remove_path`.

        Green before and after the rewrite — it pins the behaviour the rewrite must
        not break, namely that the junction goes and the directory it points at stays.
        """
        with temp_workspace() as td:
            target = Path(td) / "cleanup-junction"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            outside = Path(td) / "outside-active-context"
            outside.mkdir()
            (outside / "keep.md").write_text("keep me\n", encoding="utf-8")
            link = target / "modules" / "active-context"
            try:
                result = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(link), str(outside)],
                    capture_output=True,
                    timeout=15,
                )
            except (OSError, subprocess.SubprocessError):
                self.skipTest("mklink unavailable")
            if result.returncode != 0:
                self.skipTest("junction creation failed")

            create_vivary.scaffold_workspace(
                target, preset="coding", force=True, repo_root=ROOT
            )

            self.assertFalse(link.exists() or create_vivary._is_symlink_or_junction(link))
            self.assertEqual((outside / "keep.md").read_text(encoding="utf-8"), "keep me\n")

    @unittest.skipIf(os.name == "nt", "Windows chmod only toggles the read-only bit")
    def test_doctor_repair_preserves_existing_file_mode(self):
        """`mkstemp` creates at 0600, so replacing an existing 0644 file through it
        silently makes the file owner-only. Uses the `gitignore` action deliberately:
        placeholder repairs create new files and are 0600 either way, so a
        placeholder-based version of this test would pass before the fix.
        """
        with temp_workspace() as td:
            target = Path(td) / "repair-mode"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            gitignore.write_text("node_modules/\n", encoding="utf-8")
            os.chmod(gitignore, 0o644)
            if stat.S_IMODE(gitignore.lstat().st_mode) != 0o644:
                self.skipTest("filesystem does not honour POSIX modes")

            _, out = run_doctor_json(target, "--repair", "--yes")

            applied = [
                a for a in out["repair"]["actions"]
                if a["kind"] == "gitignore" and a["applied"]
            ]
            self.assertTrue(applied, out)
            self.assertEqual(
                stat.S_IMODE(gitignore.lstat().st_mode),
                0o644,
                "repair must preserve the existing mode, not drop it to mkstemp's 0600",
            )

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

    def test_public_subcommands_match_parser(self):
        parser = create_vivary.build_parser()
        subparsers = next(
            action
            for action in parser._actions
            if isinstance(action, argparse._SubParsersAction)
        )
        self.assertEqual(set(subparsers.choices), set(create_vivary.SUBCOMMANDS))

    @unittest.skipIf(shutil.which("node") is None, "node unavailable")
    def test_npm_launcher_subcommands_match_python(self):
        npm_launcher = subprocess.run(
            [
                "node",
                "-e",
                "process.stdout.write(JSON.stringify([...require(process.argv[1]).SUBCOMMANDS]))",
                str(PKG / "npm" / "index.js"),
            ],
            capture_output=True,
            check=True,
            text=True,
        )
        self.assertEqual(set(json.loads(npm_launcher.stdout)), set(create_vivary.SUBCOMMANDS))

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
            self.assertIn("privacy ignore missing: .strato/private/", report["errors"])

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
                "!heartbeat-reports/.gitkeep\n"
                ".strato/private/\n"
                "*.vivary-tmp\n",
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
                ".strato/private/\n"
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
                " heartbeat-reports/*\n"
                " .strato/private/\n",
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
                "!heartbeat-reports/.gitkeep\n"
                ".strato/private/\n",
                encoding="utf-8",
            )
            (target / "memory" / ".gitignore").write_text("!secret.md\n", encoding="utf-8")

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("privacy ignore missing: memory/*", report["errors"])

    def test_doctor_accepts_inert_nested_strato_private_negation(self):
        """A negation inside an already-excluded directory is inert, so doctor passes.

        This test previously asserted the opposite. That assertion encoded the
        order-insensitive matcher's behaviour as if it were intent; Git disagrees.
        Verified directly:

            $ printf '.strato/private/\\n' > .gitignore
            $ printf '!private/secret.md\\n' > .strato/.gitignore
            $ git check-ignore -v .strato/private/secret.md
            .gitignore:1:.strato/private/    .strato/private/secret.md

        `git status --untracked-files=all` does not list the file either. Git never
        descends into an excluded directory and documents that a file cannot be
        re-included if a parent directory is excluded, so the nested rule can never
        fire. Reporting it made the workspace permanently red and prescribed a manual
        edit that would change nothing.
        """
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".strato").mkdir()
            (target / ".strato" / ".gitignore").write_text(
                "!private/secret.md\n", encoding="utf-8"
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertNotIn(
                "privacy ignore missing: .strato/private/", report["errors"]
            )

    def test_doctor_ignores_unrelated_gitignore_negation(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8") + "!README.md\n",
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)

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

    def test_doctor_repair_dry_run_reports_safe_and_manual_actions_without_writing(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-dry-run"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "USER.md").unlink()
            (target / "MEMORY.md").unlink()
            (target / "memory" / ".gitkeep").unlink()
            (target / ".gitignore").write_text("node_modules/\n", encoding="utf-8")

            module = target / "modules" / "codebase" / "index.md"
            module.write_text(
                module.read_text(encoding="utf-8").replace(
                    "project: repair-dry-run\n",
                    "title: Codebase\nproject: repair-dry-run\n",
                    1,
                ).replace(
                    "related_modules: [agent-workspace]\n",
                    "related_modules: [agent-workspace, missing-module]\n",
                    1,
                ),
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 1)
            actions = out["repair"]["actions"]
            self.assertEqual(out["repair"]["mode"], "dry-run")
            self.assertTrue(any(a["kind"] == "placeholder" and a["path"] == "USER.md" for a in actions))
            self.assertTrue(any(a["kind"] == "gitignore" and a["status"] == "safe" for a in actions))
            self.assertTrue(any(a["kind"] == "tropo-w210" and a["status"] == "safe" for a in actions))
            w220 = [a for a in actions if a["kind"] == "tropo-w220"]
            self.assertEqual(len(w220), 1)
            self.assertEqual(w220[0]["status"], "manual")
            self.assertIn("related_modules", w220[0]["summary"])
            self.assertIn("missing-module", w220[0]["summary"])
            self.assertFalse((target / "USER.md").exists())
            self.assertNotIn("USER.md", (target / ".gitignore").read_text(encoding="utf-8"))
            self.assertIn("title: Codebase", module.read_text(encoding="utf-8"))

    def test_doctor_repair_yes_applies_safe_repairs_and_reruns_doctor(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-apply"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "USER.md").write_text("existing private note\n", encoding="utf-8")
            (target / "MEMORY.md").unlink()
            (target / "memory" / ".gitkeep").unlink()
            (target / "heartbeat-reports" / ".gitkeep").unlink()
            (target / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
            module = target / "modules" / "codebase" / "index.md"
            module.write_text(
                module.read_text(encoding="utf-8").replace(
                    "project: repair-apply\n",
                    "title: Codebase\nproject: repair-apply\n",
                    1,
                ),
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair", "--yes", "--trend")

            self.assertEqual(rc, 0, out)
            self.assertTrue(out["ok"], out)
            actions = out["repair"]["actions"]
            self.assertEqual(out["repair"]["mode"], "applied")
            self.assertTrue(any(a["kind"] == "placeholder" and a["path"] == "MEMORY.md" and a["applied"] for a in actions))
            self.assertTrue(any(a["kind"] == "placeholder" and a["path"] == "memory/.gitkeep" and a["applied"] for a in actions))
            self.assertTrue(any(a["kind"] == "tropo-w210" and a["applied"] for a in actions))
            self.assertEqual((target / "USER.md").read_text(encoding="utf-8"), "existing private note\n")
            self.assertTrue((target / "MEMORY.md").exists())
            self.assertTrue((target / "memory" / ".gitkeep").exists())
            gitignore = (target / ".gitignore").read_text(encoding="utf-8")
            for pattern in (
                "USER.md",
                "MEMORY.md",
                "memory/*",
                "heartbeat-reports/*",
                ".strato/private/",
                "*.vivary-tmp",
            ):
                self.assertIn(pattern, gitignore)
            self.assertNotIn("title: Codebase", module.read_text(encoding="utf-8"))

    def test_doctor_repair_yes_does_not_mutate_non_vivary_directory(self):
        with temp_workspace() as td:
            target = Path(td) / "empty-directory"
            target.mkdir()

            rc, out = run_doctor_json(target, "--repair", "--yes", "--trend")

            self.assertEqual(rc, 1)
            actions = out["repair"]["actions"]
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0]["kind"], "workspace")
            self.assertEqual(actions[0]["status"], "manual")
            self.assertIsNone(out["trend"])
            self.assertFalse((target / ".gitignore").exists())
            self.assertFalse((target / "USER.md").exists())
            self.assertFalse((target / ".vivary" / "doctor-state.json").exists())

    def test_doctor_repair_reports_nested_gitignore_negation_as_manual(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-nested-gitignore"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "memory" / ".gitignore").write_text("!secret.md\n", encoding="utf-8")

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            root_repairs = [
                a for a in out["repair"]["actions"]
                if a["kind"] == "gitignore" and a["path"] == ".gitignore" and a["applied"]
            ]
            nested_manual = [
                a for a in out["repair"]["actions"]
                if a["kind"] == "gitignore" and a["status"] == "manual"
            ]
            self.assertEqual(root_repairs, [])
            self.assertEqual(len(nested_manual), 1)
            self.assertIn("memory/*", nested_manual[0]["details"]["missing"])

    def test_doctor_repair_reports_nested_negation_when_root_rule_also_missing(self):
        """A nested negation must be reported even when the root rule is absent too.

        Regression for the case where `missing_with_nested` and `missing_root_only` both
        contain the pattern, so the set subtraction dropped it from `nested_only`:
        repair appended the root rule, reported success with no manual action, and the
        nested negation still unignored the private file. Doctor must not look repaired
        while the workspace still leaks.
        """
        with temp_workspace() as td:
            target = Path(td) / "repair-nested-and-root-missing"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            kept = [
                line
                for line in gitignore.read_text(encoding="utf-8").splitlines()
                if line.strip() not in {"memory/*", "!memory/.gitkeep"}
            ]
            gitignore.write_text("\n".join(kept) + "\n", encoding="utf-8")
            (target / "memory" / ".gitignore").write_text("!secret.md\n", encoding="utf-8")

            rc, out = run_doctor_json(target, "--repair", "--yes")

            nested_manual = [
                a for a in out["repair"]["actions"]
                if a["kind"] == "gitignore" and a["status"] == "manual"
            ]
            self.assertEqual(
                len(nested_manual),
                1,
                "nested negation must still be reported as manual when the root rule "
                "was missing as well",
            )
            self.assertIn("memory/*", nested_manual[0]["details"]["missing"])
            self.assertEqual(
                rc, 1, "doctor must not pass while the nested negation still unignores"
            )

    def test_doctor_repair_restores_private_files_from_canonical_templates(self):
        """Repair must regenerate USER.md/MEMORY.md as scaffold would, not as stubs.

        Regression for `PRIVATE_PLACEHOLDER_TEXT` carrying a second, hardcoded definition
        of these files: doctor passed on a workspace stripped of its identity, privacy,
        decision and open-loop prompts, and template changes never reached the copy.
        """
        with temp_workspace() as td:
            target = Path(td) / "repair-private-templates"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            expected = {
                name: (target / name).read_text(encoding="utf-8")
                for name in ("USER.md", "MEMORY.md")
            }
            for name in expected:
                (target / name).unlink()

            run_doctor_json(target, "--repair", "--yes")

            for name, original in expected.items():
                self.assertEqual(
                    (target / name).read_text(encoding="utf-8"),
                    original,
                    f"{name} must be restored from its canonical template, not a stub",
                )

    # --- privacy matcher correctness cluster (see drafts/plans/2026-07-25-slice-01-
    # orchestrated-plan.md Step 2). These six are one indivisible fix: the wildmatch
    # rewrite and the order-aware unsafe-exception check are bidirectionally
    # load-bearing, and fixing either alone widens the other.

    def _scaffold_with_gitignore_suffix(self, td, name, suffix):
        target = Path(td) / name
        create_vivary.scaffold_workspace(
            target, preset="coding", force=False, repo_root=ROOT
        )
        gitignore = target / ".gitignore"
        gitignore.write_text(
            gitignore.read_text(encoding="utf-8") + suffix, encoding="utf-8"
        )
        return target

    def test_doctor_rejects_globstar_negation_of_private_file(self):
        """`!**/USER.md` unignores USER.md in Git; doctor must not report ok.

        The matcher used `fnmatchcase`, whose translation of `**/USER.md` requires a
        literal `/`, so the rule was invisible and doctor reported a green workspace
        while `git check-ignore` said USER.md was committable.
        """
        with temp_workspace() as td:
            target = self._scaffold_with_gitignore_suffix(
                td, "privacy-globstar", "\n!**/USER.md\n"
            )
            self.assertIn("USER.md", create_vivary._missing_privacy_ignores(target))

    def test_doctor_rejects_case_variant_negation_of_private_file(self):
        """`!user.md` unignores USER.md wherever core.ignorecase is on.

        Fails closed on every platform deliberately: the check stays pure (no git
        config read), which also keeps it usable from `adopt` on a directory that is
        not a repository yet.
        """
        with temp_workspace() as td:
            target = self._scaffold_with_gitignore_suffix(
                td, "privacy-case", "\n!user.md\n"
            )
            self.assertIn("USER.md", create_vivary._missing_privacy_ignores(target))

    def test_doctor_rejects_escaped_trailing_space_as_covering(self):
        """`USER.md\\ ` names the file "USER.md " — with the space — not `USER.md`.

        Found by the #218 adversarial pass, differential-tested against
        `git check-ignore --no-index`, which reports USER.md as NOT ignored:

            $ printf 'USER.md\\\\ \\n' > .gitignore
            $ git check-ignore --no-index -q -- USER.md ; echo $?
            1

        Git strips trailing whitespace from a pattern *unless* it is backslash-escaped.
        The parser stripped unconditionally and then rewrote `\\` to `/`, so this line
        was credited with protecting USER.md while Git left the file committable —
        and `--repair --yes` then reported the workspace ok. Platform-independent:
        unlike the case-variant rule, this does not depend on `core.ignorecase`.
        """
        with temp_workspace() as td:
            target = Path(td) / "privacy-escaped-space"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8").replace(
                    "USER.md\n", "USER.md\\ \n", 1
                ),
                encoding="utf-8",
            )

            self.assertIn("USER.md", create_vivary._missing_privacy_ignores(target))

    def test_doctor_does_not_credit_a_lettered_bracket_expression(self):
        """`[U]SER.md` protects USER.md only where `core.ignorecase` is off.

        Found by the #218 adversarial pass. Verified against git 2.54 both ways:

            core.ignorecase=true   [U]SER.md -> NOT ignored,  [A-Z]SER.md -> ignored
            core.ignorecase=false  [U]SER.md -> ignored,      [A-Z]SER.md -> ignored

        Git case-folds the probe path but not the literal characters inside a bracket
        set, so such a rule silently stops protecting anything on the *default*
        Windows and macOS configuration. Crediting it would let doctor report a
        workspace clean while Git would commit the file.

        Fails closed on every platform, exactly as the case-variant rule above does,
        and for the same reason: the predicate stays pure — no `git config` read — so
        `adopt` can still use it on a directory that is not a repository yet. The cost
        is a false red for a rule spelled this way, which the user clears by adding a
        plain rule.
        """
        with temp_workspace() as td:
            target = Path(td) / "privacy-bracket"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8").replace(
                    "USER.md\n", "[U]SER.md\n", 1
                ),
                encoding="utf-8",
            )

            self.assertIn("USER.md", create_vivary._missing_privacy_ignores(target))

    def test_bracket_expression_without_letters_still_counts(self):
        """The fail-closed rule is scoped to what case folding can actually break."""
        self.assertTrue(create_vivary._has_case_sensitive_bracket("[U]SER.md"))
        self.assertTrue(create_vivary._has_case_sensitive_bracket("[A-Z]SER.md"))
        self.assertFalse(create_vivary._has_case_sensitive_bracket("report[0-9].md"))
        self.assertFalse(create_vivary._has_case_sensitive_bracket("USER.md"))
        # An escaped bracket is a literal, not a bracket expression.
        self.assertFalse(create_vivary._has_case_sensitive_bracket("\\[U]SER.md"))

    def test_backslash_escapes_the_next_character_rather_than_separating_paths(self):
        """A backslash in a gitignore pattern is an escape, not a path separator."""
        matches = create_vivary._ignore_rule_matches

        # An escaped space is part of the name, so the unspaced file does not match.
        self.assertFalse(matches("", "USER.md\\ ", "USER.md"))
        self.assertTrue(matches("", "USER.md\\ ", "USER.md "))

        # Escaping strips a metacharacter of its special meaning.
        self.assertTrue(matches("", "USER\\*.md", "USER*.md"))
        self.assertFalse(matches("", "USER\\*.md", "USERx.md"))

        # Unescaped patterns keep behaving exactly as before.
        self.assertTrue(matches("", "USER.md", "USER.md"))
        self.assertTrue(matches("", "memory/*", "memory/private.md"))

    def test_doctor_does_not_treat_wildcard_as_crossing_directories(self):
        """`*` must not cross `/`. `.strato/*se*` matches nothing Git would match."""
        with temp_workspace() as td:
            target = self._scaffold_with_gitignore_suffix(
                td, "privacy-overmatch", "\n.strato/*se*\n"
            )
            gitignore = target / ".gitignore"
            kept = [
                line
                for line in gitignore.read_text(encoding="utf-8").splitlines()
                if line.strip() != ".strato/private/"
            ]
            gitignore.write_text("\n".join(kept) + "\n", encoding="utf-8")
            self.assertIn(
                ".strato/private/", create_vivary._missing_privacy_ignores(target)
            )

    def test_doctor_repair_converges_and_does_not_grow_gitignore(self):
        """`--repair --yes` must terminate, not append a fresh block on every run.

        The unsafe-exception check was order-insensitive while repair fixes by
        appending, so a negation Git had already overridden kept the pattern
        permanently missing and each run appended another identical block.
        """
        with temp_workspace() as td:
            target = self._scaffold_with_gitignore_suffix(
                td, "privacy-converge", "\n!memory/*.md\nmemory/*\n"
            )
            gitignore = target / ".gitignore"

            run_doctor_json(target, "--repair", "--yes")
            after_first = gitignore.read_text(encoding="utf-8")
            run_doctor_json(target, "--repair", "--yes")
            after_second = gitignore.read_text(encoding="utf-8")

            self.assertEqual(
                after_first,
                after_second,
                "repair must converge; a second run may not rewrite .gitignore",
            )

    def test_doctor_accepts_nested_negation_under_excluded_directory(self):
        """Git never descends into an excluded directory, so a nested negation there
        is inert. Reporting it as a manual blocker makes the workspace permanently red
        and prescribes an edit that changes nothing."""
        with temp_workspace() as td:
            target = Path(td) / "privacy-inert-nested"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            gitignore = target / ".gitignore"
            kept = [
                line
                for line in gitignore.read_text(encoding="utf-8").splitlines()
                if line.strip() not in {"memory/*", "!memory/.gitkeep"}
            ]
            gitignore.write_text("\n".join(kept + ["memory/"]) + "\n", encoding="utf-8")
            (target / "memory" / ".gitignore").write_text(
                "!private.md\n", encoding="utf-8"
            )

            self.assertNotIn("memory/*", create_vivary._missing_privacy_ignores(target))

    def test_doctor_repair_offers_an_action_for_nested_only_negation(self):
        """A nested-only negation must still produce guidance.

        Regression introduced alongside the nested-blocker rewrite: with the negation
        present only in a nested file, no root append was emitted and the blocker check
        found every probe ignored, so doctor declared the workspace broken and offered
        zero actions.
        """
        with temp_workspace() as td:
            target = Path(td) / "privacy-nested-only"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "memory" / ".gitignore").write_text(
                "!*.md\n*.md\n", encoding="utf-8"
            )

            rc, out = run_doctor_json(target, "--repair", "--yes")

            if rc != 0:
                self.assertTrue(
                    out["repair"]["actions"],
                    "doctor reported the workspace broken but offered no action",
                )

    def test_doctor_repair_refuses_hardlinked_gitignore_without_cloning_content(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-hardlink-gitignore"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            victim = Path(td) / "outside-ignore"
            victim.write_text("private outside ignore\n", encoding="utf-8")
            (target / ".gitignore").unlink()
            try:
                os.link(victim, target / ".gitignore")
            except OSError:
                return

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            refused = [
                a for a in out["repair"]["actions"]
                if a["path"] == ".gitignore" and a["status"] == "refused"
            ]
            self.assertEqual(len(refused), 1)
            self.assertEqual(victim.read_text(encoding="utf-8"), "private outside ignore\n")
            self.assertEqual(
                (target / ".gitignore").read_text(encoding="utf-8"),
                "private outside ignore\n",
            )

    def test_doctor_repair_yes_never_autofixes_broken_refs(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-broken-ref"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            module = target / "modules" / "codebase" / "index.md"
            module.write_text(
                module.read_text(encoding="utf-8").replace(
                    "related_modules: [agent-workspace]\n",
                    "related_modules: [agent-workspace, missing-module]\n",
                    1,
                ),
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            self.assertFalse(out["ok"])
            w220 = [a for a in out["repair"]["actions"] if a["kind"] == "tropo-w220"]
            self.assertEqual(len(w220), 1)
            self.assertFalse(w220[0]["applied"])
            self.assertIn("missing-module", module.read_text(encoding="utf-8"))

    def test_doctor_repair_reports_exo_conflicts_without_mutating(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-exo-conflict"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            first = target / "changes" / "local-ci-baseline.md"
            first.write_text(
                first.read_text(encoding="utf-8").replace(
                    "status: planned\n", "status: active\n", 1
                ),
                encoding="utf-8",
            )
            second = target / "changes" / "parallel-codebase-slice.md"
            second.write_text(
                "---\n"
                "project: repair-exo-conflict\n"
                "status: active\n"
                "slice: parallel codebase touch\n"
                "related_modules: [codebase]\n"
                "---\n"
                "# Parallel Codebase Slice\n",
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 0, out)
            conflicts = [a for a in out["repair"]["actions"] if a["kind"] == "exo-conflict"]
            self.assertEqual(len(conflicts), 1)
            self.assertEqual(conflicts[0]["status"], "manual")
            self.assertFalse(conflicts[0]["applied"])
            self.assertIn("claim", conflicts[0]["summary"])
            self.assertIn("defer", conflicts[0]["summary"])
            self.assertIn("split", conflicts[0]["summary"])
            pack = [a for a in out["repair"]["actions"] if a["kind"] == "exo-coordination-pack"]
            self.assertEqual(len(pack), 1)
            self.assertFalse(pack[0]["applied"])
            self.assertNotIn("assignee", first.read_text(encoding="utf-8"))

    def test_doctor_repair_reports_shared_gate_exo_edges(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-exo-gate-only"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            first = target / "changes" / "local-ci-baseline.md"
            first.write_text(
                first.read_text(encoding="utf-8").replace(
                    "status: planned\n", "status: active\n", 1
                ),
                encoding="utf-8",
            )
            second = target / "changes" / "parallel-gate-only.md"
            second.write_text(
                "---\n"
                "project: repair-exo-gate-only\n"
                "status: active\n"
                "slice: parallel gate reference\n"
                "gates: [human-gates]\n"
                "---\n"
                "# Parallel Gate Only\n",
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 0, out)
            conflicts = [a for a in out["repair"]["actions"] if a["kind"] == "exo-conflict"]
            self.assertEqual(len(conflicts), 1)
            self.assertEqual(conflicts[0]["details"]["shared"], ["human-gates"])

    def test_doctor_repair_reports_shared_related_change_exo_edges(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-exo-related-change-only"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            first = target / "changes" / "local-ci-baseline.md"
            first.write_text(
                first.read_text(encoding="utf-8").replace(
                    "status: planned\n", "status: active\n", 1
                ),
                encoding="utf-8",
            )
            second = target / "changes" / "parallel-bookkeeping-ref.md"
            second.write_text(
                "---\n"
                "project: repair-exo-related-change-only\n"
                "status: active\n"
                "slice: parallel bookkeeping reference\n"
                "related_changes: [scaffold-init]\n"
                "---\n"
                "# Parallel Bookkeeping Ref\n",
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 0, out)
            conflicts = [a for a in out["repair"]["actions"] if a["kind"] == "exo-conflict"]
            self.assertEqual(len(conflicts), 1)
            self.assertEqual(conflicts[0]["details"]["shared"], ["scaffold-init"])

    def test_doctor_repair_excludes_strato_private_from_graph_and_actions(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-private-exclude"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            private_dir = target / ".strato" / "private"
            private_dir.mkdir(parents=True)
            (private_dir / "session.md").write_text(
                "---\n"
                "title: Session\n"
                "related_modules: [missing-private-module]\n"
                "---\n"
                "# Session\n\nprivate scratch\n",
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 0, out)
            rendered = json.dumps(out)
            self.assertNotIn(".strato/private", rendered)
            self.assertEqual(out["graph"]["broken"], 0)

    def test_doctor_repair_keeps_complex_w210_manual(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-complex-w210"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            module = target / "modules" / "codebase" / "index.md"
            module.write_text(
                module.read_text(encoding="utf-8").replace(
                    "project: repair-complex-w210\n",
                    "title: >\n  Codebase\nproject: repair-complex-w210\n",
                    1,
                ),
                encoding="utf-8",
            )

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            actions = [a for a in out["repair"]["actions"] if a["kind"] == "tropo-w210"]
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0]["status"], "manual")
            self.assertFalse(actions[0]["applied"])
            self.assertIn("title: >", module.read_text(encoding="utf-8"))

    def test_doctor_repair_keeps_non_utf8_w210_manual(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-non-utf8-w210"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            module = target / "modules" / "codebase" / "index.md"
            text = module.read_text(encoding="utf-8").replace(
                "project: repair-non-utf8-w210\n",
                "title: Codebase\nproject: repair-non-utf8-w210\n",
                1,
            )
            module.write_bytes(text.encode("utf-8") + b"\xff")

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            actions = [a for a in out["repair"]["actions"] if a["kind"] == "tropo-w210"]
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0]["status"], "manual")
            self.assertFalse(actions[0]["applied"])
            self.assertTrue(module.read_bytes().endswith(b"\xff"))
            self.assertIn("UTF-8", actions[0]["summary"])
            self.assertNotIn("complex YAML", actions[0]["summary"])

    def test_doctor_repair_names_hardlink_as_the_w210_manual_cause(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-hardlinked-w210"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            module = target / "modules" / "codebase" / "index.md"
            module.write_text(
                module.read_text(encoding="utf-8").replace(
                    "project: repair-hardlinked-w210\n",
                    "title: Codebase\nproject: repair-hardlinked-w210\n",
                    1,
                ),
                encoding="utf-8",
            )
            twin = Path(td) / "twin.md"
            try:
                os.link(module, twin)
            except (OSError, AttributeError, NotImplementedError):
                self.skipTest("hard links unavailable")

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            actions = [a for a in out["repair"]["actions"] if a["kind"] == "tropo-w210"]
            self.assertEqual(len(actions), 1)
            self.assertEqual(actions[0]["status"], "manual")
            self.assertIn("hard link", actions[0]["summary"])
            self.assertNotIn("complex YAML", actions[0]["summary"])
            self.assertIn("title: Codebase", module.read_text(encoding="utf-8"))

    def test_w210_manual_summary_names_each_cause(self):
        summary = create_vivary._w210_manual_summary

        self.assertEqual(
            summary([{"reason_code": "complex"}]),
            create_vivary.W210_COMPLEX_SUMMARY,
            "the all-complex wording is the pre-existing contract and must not drift",
        )

        stale = summary([{"reason_code": "stale"}])
        self.assertIn("no longer matches", stale)
        self.assertNotIn("complex YAML", stale)

        mixed = summary([{"reason_code": "non-utf8"}, {"reason_code": "complex"}])
        self.assertIn("UTF-8", mixed)
        self.assertIn("scalar", mixed)

        unknown = summary([{"reason_code": "something-new"}])
        self.assertIn("manual", unknown.lower())

        self.assertIn("read", summary([{"reason_code": "unreadable"}]))

    def test_read_repair_text_refusals_carry_a_reason_code(self):
        with temp_workspace() as td:
            non_utf8 = Path(td) / "non-utf8.md"
            non_utf8.write_bytes(b"# doc\n\xff")
            with self.assertRaises(create_vivary.RepairRefusal) as caught:
                create_vivary._read_repair_text(non_utf8)
            self.assertEqual(caught.exception.reason_code, "non-utf8")
            self.assertIn("non-UTF-8", str(caught.exception))

            original = Path(td) / "linked.md"
            original.write_text("# doc\n", encoding="utf-8")
            twin = Path(td) / "linked-twin.md"
            try:
                os.link(original, twin)
            except (OSError, AttributeError, NotImplementedError):
                return
            with self.assertRaises(create_vivary.RepairRefusal) as caught:
                create_vivary._read_repair_text(original)
            self.assertEqual(caught.exception.reason_code, "hardlinked")
            self.assertIn("multi-linked", str(caught.exception))

    def test_repair_refusal_is_a_scaffold_error(self):
        """Existing `except ScaffoldError` handlers must keep catching refusals."""
        self.assertTrue(issubclass(create_vivary.RepairRefusal, create_vivary.ScaffoldError))

    def test_private_placeholder_text_refuses_undecodable_template(self):
        """`read_text` raises UnicodeDecodeError, which is a ValueError — so it slips
        past the `except OSError` here and past the apply loop's
        `except (OSError, ScaffoldError)`, crashing the run instead of refusing.
        """
        with temp_workspace() as td:
            fake_root = Path(td) / "fake-repo"
            templates = fake_root / "packages" / "strato" / "templates"
            templates.mkdir(parents=True)
            (fake_root / "packages" / "strato" / "STRATO.md").write_text(
                "# Strato\n", encoding="utf-8"
            )
            (templates / "USER.template.md").write_bytes(b"# User\n\xff")

            with self.assertRaises(create_vivary.ScaffoldError):
                create_vivary._private_placeholder_text(fake_root, "USER.md")

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_doctor_repair_refuses_symlinked_repair_targets(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-symlink"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            outside = Path(td) / "outside"
            outside.mkdir()
            shutil.rmtree(target / "memory")
            try:
                (target / "memory").symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            refused = [
                a for a in out["repair"]["actions"]
                if a["path"] == "memory/.gitkeep" and a["status"] == "refused"
            ]
            self.assertEqual(len(refused), 1)
            self.assertFalse(refused[0]["applied"])
            self.assertFalse((outside / ".gitkeep").exists())

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_doctor_repair_dry_run_refuses_symlinked_private_placeholder(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-private-link"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            outside = Path(td) / "outside-user.md"
            outside.write_text("private elsewhere\n", encoding="utf-8")
            (target / "USER.md").unlink()
            try:
                (target / "USER.md").symlink_to(outside)
            except OSError:
                return

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 1)
            refused = [
                a for a in out["repair"]["actions"]
                if a["path"] == "USER.md" and a["status"] == "refused"
            ]
            self.assertEqual(len(refused), 1)
            self.assertFalse(refused[0]["applied"])
            self.assertEqual(outside.read_text(encoding="utf-8"), "private elsewhere\n")

    def test_doctor_repair_refuses_non_file_gitignore_without_traceback(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-gitignore-directory"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / ".gitignore").unlink()
            (target / ".gitignore").mkdir()

            rc, out = run_doctor_json(target, "--repair", "--yes")

            self.assertEqual(rc, 1)
            refused = [
                a for a in out["repair"]["actions"]
                if a["path"] == ".gitignore" and a["status"] == "refused"
            ]
            self.assertEqual(len(refused), 1)
            self.assertIn("privacy ignore missing: USER.md", out["errors"])
            self.assertTrue((target / ".gitignore").is_dir())

    def test_doctor_repair_refuses_symlinked_workspace_root(self):
        with temp_workspace() as td:
            real = Path(td) / "real-workspace"
            create_vivary.scaffold_workspace(
                real, preset="coding", force=False, repo_root=ROOT
            )
            (real / "MEMORY.md").unlink()
            link = Path(td) / "workspace-link"
            link_created = False
            try:
                try:
                    link.symlink_to(real, target_is_directory=True)
                    link_created = True
                except OSError:
                    if os.name != "nt":
                        return
                    result = subprocess.run(
                        ["cmd", "/c", "mklink", "/J", str(link), str(real)],
                        capture_output=True,
                        text=True,
                    )
                    if result.returncode != 0:
                        return
                    link_created = True

                rc, out = run_doctor_json(link, "--repair", "--yes", "--trend")

                self.assertEqual(rc, 1)
                self.assertRegex(" ".join(out["errors"]), "symlinked|junction")
                self.assertIsNone(out["trend"])
                self.assertFalse((real / "MEMORY.md").exists())
                self.assertFalse((real / ".vivary" / "doctor-state.json").exists())
            finally:
                if link_created and (link.exists() or link.is_symlink()):
                    if os.name == "nt":
                        subprocess.run(["cmd", "/c", "rmdir", str(link)], capture_output=True)
                    else:
                        link.unlink()

    def test_doctor_repair_trend_dry_run_writes_no_state_file(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-trend-dry-run"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )

            rc, out = run_doctor_json(target, "--repair", "--trend")

            self.assertEqual(rc, 0, out)
            self.assertIsNone(out["trend"])
            self.assertIn("repair dry-run", " ".join(out["warnings"]))
            self.assertFalse((target / ".vivary" / "doctor-state.json").exists())


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

    def test_init_dry_run_json_with_explicit_flags_skips_prompts_in_tty(self):
        with temp_workspace() as td:
            target = Path(td) / "dry-run-agent-proof"
            buf = io.StringIO()

            with mock.patch.object(create_vivary.sys.stdin, "isatty", return_value=True), \
                 mock.patch.object(
                     create_vivary.sys.stdin,
                     "readline",
                     side_effect=AssertionError("init prompted during agent JSON proof"),
                 ), \
                 redirect_stdout(buf):
                rc = create_vivary.main([
                    "init",
                    str(target),
                    "--dry-run",
                    "--json",
                    "--storage",
                    "file",
                    "--privacy",
                    "local",
                    "--size",
                    "small",
                    "--repo-root",
                    str(ROOT),
                ])

            self.assertEqual(rc, 0)
            out = json.loads(buf.getvalue())
            self.assertTrue(out["dry_run"])
            self.assertEqual(out["storage"], "file")
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

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_doctor_trend_refuses_symlinked_workspace_root(self):
        with temp_workspace() as td:
            real = Path(td) / "real-trend-root"
            create_vivary.scaffold_workspace(
                real, preset="coding", repo_root=ROOT
            )
            link = Path(td) / "linked-trend-root"
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError:
                return

            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = create_vivary.main([
                    "doctor", str(link), "--trend", "--json", "--repo-root", str(ROOT)
                ])

            self.assertEqual(rc, 1)
            out = json.loads(buf.getvalue())
            self.assertFalse(out["ok"])
            self.assertRegex(" ".join(out["errors"]), "symlinked target")
            self.assertIsNone(out["trend"])
            self.assertFalse((real / ".vivary" / "doctor-state.json").exists())

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


class GovernedContextCapabilityTests(unittest.TestCase):
    """#207 slice: the install must be able to report the governed-context seam.

    `vivary-core` is merged but nothing outside `packages/core/` references it, so a
    user has no way to find out whether the seam is present. A capability nobody can
    observe is indistinguishable from one that does not exist.
    """

    def test_core_is_reported_as_a_capability(self):
        report = create_vivary.capability_report("coding")
        core = next(
            (c for c in report["available_capabilities"] if c["id"] == "governed-context:core"),
            None,
        )
        self.assertIsNotNone(core, "governed-context:core must appear in the capability report")
        self.assertEqual(core["requires_install"], ["vivary-core"])
        self.assertFalse(core["requires_approval"], "reading local context needs no approval")
        self.assertFalse(core["network"], "the seam is local-only and must say so")
        self.assertFalse(core["default"], "core is not yet part of the default install")

    def test_every_capability_reports_whether_it_is_installed(self):
        """Install truth, not just declared intent — that is what makes the report
        actionable rather than a restatement of the docs."""
        report = create_vivary.capability_report("coding")
        for capability in report["available_capabilities"]:
            self.assertIn(
                "installed", capability, f"{capability['id']} does not report install state"
            )
            self.assertIsInstance(capability["installed"], bool)

        base = next(c for c in report["available_capabilities"] if c["id"] == "storage:file")
        self.assertTrue(base["installed"], "a zero-dependency capability is always present")

    def test_install_truth_is_derived_from_each_capability_s_requirements(self):
        """`installed` must follow `requires_install`, not a second hand-kept list.

        The first version of this kept a parallel capability-id -> module map, and it
        disagreed with the declarations it was meant to describe: `memory:cognee`
        needs `vivary-memory-cognee` and was reported installed, while `memory:local`
        needs nothing and was reported absent. Exactly backwards, and exactly the
        class of "reports something it cannot evidence" this report exists to remove.
        """
        report = create_vivary.capability_report("coding")
        by_id = {c["id"]: c for c in report["available_capabilities"]}

        # Anything requiring nothing is present by definition.
        for capability in report["available_capabilities"]:
            if not capability["requires_install"]:
                self.assertTrue(
                    capability["installed"],
                    f"{capability['id']} requires nothing and must report installed",
                )

        # A capability naming a package that is genuinely absent must say so.
        self.assertFalse(by_id["memory:cognee"]["installed"])
        self.assertFalse(by_id["governed-context:core"]["installed"])

        # And the probe must agree with a direct import check, requirement by
        # requirement — no capability may claim more than its packages support.
        for capability in report["available_capabilities"]:
            expected = all(
                create_vivary._requirement_importable(r)
                for r in capability["requires_install"]
            )
            self.assertEqual(
                capability["installed"], expected, f"{capability['id']} misreports"
            )

    def test_absent_optional_capability_is_not_an_error(self):
        """Doctor must never call an *optional* absent package broken."""
        with temp_workspace() as td:
            target = Path(td) / "capability-probe"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)
            joined = json.dumps(report["errors"])
            self.assertNotIn("vivary-core", joined)
            self.assertNotIn("vivary_core", joined)


if __name__ == "__main__":
    unittest.main()
