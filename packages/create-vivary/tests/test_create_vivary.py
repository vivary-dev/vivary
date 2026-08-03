"""Tests for the create-vivary workspace scaffold."""

import io
import hashlib
import importlib
import json
import os
import sys
import re
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


def snapshot_workspace(root: Path) -> dict[str, tuple]:
    """Capture every file's bytes and every entry's modification time."""
    snapshot = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        stat_result = path.stat()
        if path.is_dir():
            snapshot[rel] = ("dir", stat_result.st_mtime_ns)
        elif path.is_file():
            snapshot[rel] = (
                "file",
                stat_result.st_mtime_ns,
                hashlib.sha256(path.read_bytes()).hexdigest(),
            )
    return snapshot

def flatten_v01_modules(target: Path) -> None:
    """Turn current generated module routers into the flat published v0.1 layout."""
    modules = target / "modules"
    for module_dir in sorted(path for path in modules.iterdir() if path.is_dir()):
        (modules / f"{module_dir.name}.md").write_bytes(
            (module_dir / "index.md").read_bytes()
        )
        shutil.rmtree(module_dir)
    (modules / "index.md").unlink()


PUBLISHED_PRIVACY_IGNORE_RULES = {
    "v0.1.0": (
        "USER.md",
        "MEMORY.md",
        "memory/*",
        "!memory/.gitkeep",
        ".strato/private/",
    ),
    "v0.2.0": (
        "USER.md",
        "MEMORY.md",
        "memory/*",
        "!memory/.gitkeep",
        ".strato/private/",
    ),
    "v0.2.8": (
        "USER.md",
        "MEMORY.md",
        "memory/*",
        "!memory/.gitkeep",
        "heartbeat-reports/*",
        "!heartbeat-reports/.gitkeep",
        ".strato/private/",
    ),
    "v0.3.1": (
        "USER.md",
        "MEMORY.md",
        "memory/*",
        "!memory/.gitkeep",
        "heartbeat-reports/*",
        "!heartbeat-reports/.gitkeep",
        ".strato/private/",
    ),
}

PUBLISHED_V031_MEMORY_TEMPLATES = {
    "local": """\
[memory]
enabled = true
mode = "semantic-provider"
provider = "vivary-local"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.local]
state_path = ".vivary/memory/local"
allow_network = false
require_explicit_index = true
""",
    "cognee": """\
[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
allow_network = false
require_explicit_index = true
api_key_env = ""
""",
}


def apply_published_workspace_fixture(target: Path, version: str) -> None:
    """Apply the module and privacy profile emitted by a published release."""
    rules = PUBLISHED_PRIVACY_IGNORE_RULES[version]
    (target / ".gitignore").write_text("\n".join((*rules, "")), encoding="utf-8")
    if version != "v0.1.0":
        return

    modules = target / "modules"
    for module_dir in sorted(path for path in modules.iterdir() if path.is_dir()):
        legacy_module = modules / f"{module_dir.name}.md"
        legacy_module.write_bytes((module_dir / "index.md").read_bytes())
        shutil.rmtree(module_dir)
    (modules / "index.md").unlink()


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

    def test_declared_config_schema_matches_selected_generated_template_fields(self):
        import tomllib

        storage_cases = (
            ("embedded", "embedded", None),
            ("cloud-qdrant", "cloud", "qdrant"),
            ("cloud-astra", "cloud", "astra"),
        )
        for template_name, backend, provider in storage_cases:
            with self.subTest(storage_template=template_name):
                storage = tomllib.loads(
                    create_vivary._STORAGE_TOML_TEMPLATES[template_name]
                )["storage"]
                section = storage[backend]
                schema = create_vivary._DECLARED_CONFIG_SCHEMAS["storage"][backend]
                if provider is not None:
                    schema = schema[provider]
                self.assertEqual(set(section), set(schema))
                self.assertEqual(
                    {key for key, value in storage.items() if isinstance(value, dict)},
                    {backend},
                )

        for template_name, provider in (("local", "vivary-local"), ("cognee", "cognee")):
            with self.subTest(memory_template=template_name):
                memory = tomllib.loads(
                    create_vivary._MEMORY_TOML_TEMPLATES[template_name]
                )["memory"]
                schemas = create_vivary._DECLARED_CONFIG_SCHEMAS["memory"]
                section_name, provider_schema, optional_schema = schemas["providers"][
                    provider
                ]
                self.assertEqual(
                    {key for key, value in memory.items() if not isinstance(value, dict)},
                    set(schemas["root"]),
                )
                self.assertEqual(
                    {key for key, value in memory.items() if isinstance(value, dict)},
                    {"privacy", section_name},
                )
                self.assertEqual(set(memory["privacy"]), set(schemas["privacy"]))
                self.assertEqual(
                    set(memory[section_name]),
                    set(provider_schema) | set(optional_schema),
                )

    def test_doctor_accepts_published_v031_memory_profiles_without_writing(self):
        for memory_mode, published_config in PUBLISHED_V031_MEMORY_TEMPLATES.items():
            with self.subTest(memory=memory_mode):
                with temp_workspace() as td:
                    target = Path(td) / f"published-v031-{memory_mode}"
                    create_vivary.scaffold_workspace(
                        target,
                        preset="writing",
                        memory=memory_mode,
                        force=False,
                        repo_root=ROOT,
                    )
                    apply_published_workspace_fixture(target, "v0.3.1")
                    (target / ".vivary" / "memory.toml").write_text(
                        published_config, encoding="utf-8"
                    )
                    before = snapshot_workspace(target)

                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)

                    self.assertTrue(report["ok"], report)
                    self.assertNotEqual(
                        report["memory"]["status"], "privacy-failed"
                    )
                    self.assertIn(
                        "recommended privacy ignore missing: *.vivary-tmp; "
                        "add it to .gitignore",
                        report["warnings"],
                    )
                    self.assertNotIn(
                        "privacy ignore missing: *.vivary-tmp", report["errors"]
                    )
                    self.assertEqual(
                        report["compatibility"]["declared_capability_problems"], []
                    )
                    self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_rejects_missing_or_weakened_memory_privacy_fields(self):
        privacy_fields = create_vivary._DECLARED_CONFIG_SCHEMAS["memory"]["privacy"]
        for memory_mode in ("local", "cognee"):
            with temp_workspace() as td:
                target = Path(td) / f"{memory_mode}-privacy"
                create_vivary.scaffold_workspace(
                    target,
                    preset="writing",
                    memory=memory_mode,
                    force=False,
                    repo_root=ROOT,
                )
                config = target / ".vivary" / "memory.toml"
                original = config.read_text(encoding="utf-8")

                with self.subTest(memory=memory_mode, case="missing-fields"):
                    stripped = original
                    for field in privacy_fields:
                        stripped = re.sub(
                            rf"(?m)^{re.escape(field)} = .*\n", "", stripped
                        )
                    config.write_text(stripped, encoding="utf-8")
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertFalse(report["ok"], report)
                    for field in privacy_fields:
                        self.assertIn(
                            "declared capability memory missing required "
                            f"memory.privacy.{field}",
                            report["compatibility"]["declared_capability_problems"],
                        )

                with self.subTest(memory=memory_mode, case="respect_gitignore=false"):
                    config.write_text(
                        original.replace(
                            "respect_gitignore = true", "respect_gitignore = false"
                        ),
                        encoding="utf-8",
                    )
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    expected = (
                        "declared capability memory requires "
                        "memory.privacy.respect_gitignore = true"
                    )
                    self.assertFalse(report["ok"], report)
                    self.assertIn(
                        expected,
                        report["compatibility"]["declared_capability_problems"],
                    )

                with self.subTest(memory=memory_mode, case="private_paths=[]"):
                    config.write_text(
                        re.sub(
                            r"(?m)^private_paths = .*$",
                            "private_paths = []",
                            original,
                        ),
                        encoding="utf-8",
                    )
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    expected = (
                        "declared capability memory requires "
                        "memory.privacy.private_paths to include: "
                        + ", ".join(create_vivary._MEMORY_PUBLISHED_PRIVATE_PATHS)
                    )
                    self.assertFalse(report["ok"], report)
                    self.assertIn(
                        expected,
                        report["compatibility"]["declared_capability_problems"],
                    )

                with self.subTest(memory=memory_mode, case="private_paths=non-strings"):
                    config.write_text(
                        re.sub(
                            r"(?m)^private_paths = .*$",
                            'private_paths = [["USER.md"]]',
                            original,
                        ),
                        encoding="utf-8",
                    )
                    gitignore = target / ".gitignore"
                    gitignore.write_text(
                        gitignore.read_text(encoding="utf-8").replace(
                            "*.vivary-tmp\n", ""
                        ),
                        encoding="utf-8",
                    )
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertFalse(report["ok"], report)
                    self.assertIn(
                        "declared capability memory requires "
                        "memory.privacy.private_paths to contain only strings",
                        report["compatibility"]["declared_capability_problems"],
                    )
                    self.assertIn(
                        "privacy ignore missing: *.vivary-tmp", report["errors"]
                    )

    def test_declared_memory_keeps_all_gitignore_privacy_rules_strict(self):
        with temp_workspace() as td:
            target = Path(td) / "memory-privacy-rules"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                memory="local",
                force=False,
                repo_root=ROOT,
            )
            memory_config = target / ".vivary" / "memory.toml"
            memory_config.write_text(
                memory_config.read_text(encoding="utf-8").replace(
                    '".strato/private/**"', r"'.strato\private\**'"
                ),
                encoding="utf-8",
            )
            gitignore = target / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8")
                .replace("heartbeat-reports/*\n", "")
                .replace("*.vivary-tmp\n", ""),
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"], report)
            self.assertEqual(report["memory"]["status"], "privacy-failed")
            self.assertIn(
                "privacy ignore missing: heartbeat-reports/*", report["errors"]
            )
            self.assertIn("privacy ignore missing: *.vivary-tmp", report["errors"])

    def test_doctor_reports_every_missing_selected_template_field(self):
        cases = (
            ("storage", "embedded", "lancedb", "path"),
            ("storage", "embedded", "lancedb", "provider"),
            ("storage", "cloud", "qdrant", "provider"),
            ("storage", "cloud", "qdrant", "url"),
            ("storage", "cloud", "qdrant", "api_key"),
            ("storage", "cloud", "qdrant", "collection"),
            ("storage", "cloud", "astra", "provider"),
            ("storage", "cloud", "astra", "endpoint"),
            ("storage", "cloud", "astra", "api_key"),
            ("storage", "cloud", "astra", "collection"),
            ("memory", "local", None, "state_path"),
            ("memory", "local", None, "allow_network"),
            ("memory", "local", None, "require_explicit_index"),
            ("memory", "cognee", None, "state_path"),
            ("memory", "cognee", None, "allow_network"),
            ("memory", "cognee", None, "require_explicit_index"),
            ("memory", "cognee", None, "api_key_env"),
            ("memory", "cognee", None, "allow_without_api_key"),
            ("memory", "cognee", None, "allow_telemetry"),
        )
        for capability, mode, provider, field in cases:
            with self.subTest(capability=capability, mode=mode, provider=provider, field=field):
                with temp_workspace() as td:
                    target = Path(td) / f"{capability}-{mode}-{provider or 'default'}-{field}"
                    if capability == "storage":
                        create_vivary.scaffold_workspace(
                            target,
                            preset="writing",
                            storage=mode,
                            provider=provider or "lancedb",
                            force=False,
                            repo_root=ROOT,
                        )
                        config = target / ".vivary" / "storage.toml"
                        expected = (
                            f"declared capability storage:{mode} missing required "
                            f"storage.{mode}.{field}"
                        )
                    else:
                        create_vivary.scaffold_workspace(
                            target,
                            preset="writing",
                            memory=mode,
                            force=False,
                            repo_root=ROOT,
                        )
                        config = target / ".vivary" / "memory.toml"
                        memory_capability = "local" if mode == "local" else "cognee"
                        expected = (
                            f"declared capability memory:{memory_capability} missing required "
                            f"memory.{mode}.{field}"
                        )

                    healthy = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertEqual(
                        healthy["compatibility"]["declared_capability_problems"], []
                    )
                    text = config.read_text(encoding="utf-8")
                    stripped = re.sub(
                        rf"(?m)^{re.escape(field)} = .*\n", "", text
                    )
                    self.assertNotEqual(stripped, text)
                    config.write_text(stripped, encoding="utf-8")

                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertFalse(report["ok"], report)
                    self.assertIn(expected, report["compatibility"]["declared_capability_problems"])
                    self.assertIn(expected, report["errors"])

    def test_doctor_rejects_empty_declared_embedded_fields(self):
        for field in ("path", "provider"):
            with self.subTest(field=field):
                with temp_workspace() as td:
                    target = Path(td) / f"empty-embedded-{field}"
                    create_vivary.scaffold_workspace(
                        target,
                        preset="writing",
                        storage="embedded",
                        provider="lancedb",
                        force=False,
                        repo_root=ROOT,
                    )
                    config = target / ".vivary" / "storage.toml"
                    text = config.read_text(encoding="utf-8")
                    text = re.sub(
                        rf'(?m)^{re.escape(field)} = ".*"$',
                        f'{field} = ""',
                        text,
                    )
                    config.write_text(text, encoding="utf-8")

                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)

                    problem = (
                        "declared capability storage:embedded missing required "
                        f"storage.embedded.{field}"
                    )
                    self.assertFalse(report["ok"], report)
                    self.assertIn(
                        problem,
                        report["compatibility"]["declared_capability_problems"],
                    )
                    self.assertIn(problem, report["errors"])

    def test_doctor_rejects_unknown_declared_cloud_provider(self):
        with temp_workspace() as td:
            target = Path(td) / "unknown-cloud-provider"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                storage="cloud",
                provider="qdrant",
                force=False,
                repo_root=ROOT,
            )
            config = target / ".vivary" / "storage.toml"
            config.write_text(
                config.read_text(encoding="utf-8").replace(
                    'provider = "qdrant"', 'provider = "unknown"', 1
                ),
                encoding="utf-8",
            )

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            problem = "declared capability storage:cloud has unknown provider: 'unknown'"
            self.assertFalse(report["ok"], report)
            self.assertIn(problem, report["compatibility"]["declared_capability_problems"])
            self.assertIn(problem, report["errors"])

    def test_doctor_reports_enabled_none_memory_after_graph_observation(self):
        with temp_workspace() as td:
            target = Path(td) / "none-memory"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )
            vivary_dir = target / ".vivary"
            vivary_dir.mkdir(exist_ok=True)
            (vivary_dir / "memory.toml").write_text(
                "[memory]\n"
                "enabled = true\n"
                'mode = "semantic-provider"\n'
                'provider = "none"\n',
                encoding="utf-8",
            )
            before = snapshot_workspace(target)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"], report)
            self.assertEqual(report["memory"]["status"], "misconfigured")
            self.assertIn(
                "semantic memory misconfigured: memory.provider is required when "
                "memory.enabled is true",
                report["errors"],
            )
            self.assertGreater(report["graph"]["nodes"], 0)
            self.assertGreater(report["graph"]["edges"], 0)
            self.assertEqual(snapshot_workspace(target), before)

            output = io.StringIO()
            with redirect_stdout(output):
                rc = create_vivary.main(
                    [
                        "doctor",
                        str(target),
                        "--trend",
                        "--json",
                        "--repo-root",
                        str(ROOT),
                    ]
                )
            trend_report = json.loads(output.getvalue())
            state = json.loads(
                (target / ".vivary" / "doctor-state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(rc, 1)
            self.assertGreater(trend_report["graph"]["nodes"], 0)
            self.assertEqual(
                state["metrics"]["graph_nodes"], trend_report["graph"]["nodes"]
            )

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
        self.assertEqual(create_vivary.with_default_command(["ws"]), ["init", "ws"])
        self.assertEqual(
            create_vivary.with_default_command(["ws", "--preset", "coding"]),
            ["init", "ws", "--preset", "coding"],
        )
        for command in create_vivary.SUBCOMMANDS:
            with self.subTest(command=command):
                self.assertEqual(
                    create_vivary.with_default_command([command, "ws"]),
                    [command, "ws"],
                )
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

            before = snapshot_workspace(target)
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["graph"]["broken"], 0)
            self.assertGreaterEqual(report["graph"]["nodes"], 9)
            self.assertEqual(
                report["compatibility"],
                {
                    "schema_version": 1,
                    "workspace_contract": "indexed-v0.2+",
                    "baseline_missing": [],
                    "contract_missing": [],
                    "declared_capability_problems": [],
                    "recommended_missing": [],
                    "recommended_upgrade": None,
                },
            )
            self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_baseline_is_the_literal_v01_common_contract(self):
        expected = (
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
            "templates/AGENTS.md",
            ".claude/skills/strato/SKILL.md",
            ".claude/skills/loops/SKILL.md",
            ".agents/skills/strato/SKILL.md",
            ".agents/skills/loops/SKILL.md",
        )
        self.assertEqual(create_vivary.BASELINE_WORKSPACE_FILES, expected)
        self.assertEqual(create_vivary.REQUIRED_WORKSPACE_FILES, expected)
        self.assertEqual(len(create_vivary.BASELINE_WORKSPACE_FILES), 15)
        self.assertTrue(
            set(create_vivary.INDEXED_WORKSPACE_FILES)
            <= set(create_vivary.REPAIR_MODULE_CONTRACT_MARKERS)
        )
        self.assertNotIn("modules/index.md", create_vivary.BASELINE_WORKSPACE_FILES)

    def test_doctor_keeps_every_v01_common_path_strict(self):
        with temp_workspace() as td:
            target = Path(td) / "common-contract"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )
            for rel in create_vivary.BASELINE_WORKSPACE_FILES:
                with self.subTest(path=rel):
                    path = target / rel
                    original = path.read_bytes()
                    path.unlink()
                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                    self.assertFalse(report["ok"], report)
                    self.assertIn(rel, report["compatibility"]["baseline_missing"])
                    self.assertIn(f"missing required file: {rel}", report["errors"])
                    path.write_bytes(original)

    def test_doctor_accepts_published_v01_workspace_without_writing(self):
        with temp_workspace() as td:
            target = Path(td) / "legacy-workspace"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )
            apply_published_workspace_fixture(target, "v0.1.0")
            before = snapshot_workspace(target)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            recommendations = [
                "modules/index.md",
                "modules/agent-workspace/index.md",
            ]
            guidance = (
                "run create-vivary adopt <workspace> --preset writing "
                "(dry-run: omit --yes) to review the indexed v0.2+ module contract"
            )
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["compatibility"]["schema_version"], 1)
            self.assertEqual(report["compatibility"]["workspace_contract"], "legacy-v0.1")
            self.assertEqual(report["compatibility"]["baseline_missing"], [])
            self.assertEqual(report["compatibility"]["contract_missing"], [])
            self.assertEqual(report["compatibility"]["declared_capability_problems"], [])
            self.assertEqual(report["compatibility"]["recommended_missing"], recommendations)
            self.assertEqual(report["compatibility"]["recommended_upgrade"], guidance)
            self.assertGreater(report["graph"]["nodes"], 0)
            self.assertGreater(report["graph"]["edges"], 0)
            self.assertEqual(report["graph"]["broken"], 0)
            for rel in recommendations:
                self.assertIn(f"recommended workspace file missing: {rel}", report["warnings"])
            self.assertIn(guidance, report["warnings"])
            for pattern in ("heartbeat-reports/*", "*.vivary-tmp"):
                self.assertIn(
                    f"recommended privacy ignore missing: {pattern}; "
                    "add it to .gitignore",
                    report["warnings"],
                )

            json_rc, json_report = run_doctor_json(target)
            self.assertEqual(json_rc, 0)
            self.assertEqual(json_report["ok"], report["ok"])
            self.assertEqual(json_report["errors"], report["errors"])
            self.assertEqual(json_report["warnings"], report["warnings"])
            self.assertEqual(json_report["compatibility"], report["compatibility"])

            human = io.StringIO()
            with redirect_stdout(human):
                human_rc = create_vivary.main(
                    ["doctor", str(target), "--repo-root", str(ROOT)]
                )
            self.assertEqual(human_rc, json_rc)
            self.assertIn("warning: recommended workspace file missing: modules/index.md", human.getvalue())
            self.assertIn(f"warning: {guidance}", human.getvalue())
            self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_accepts_other_published_privacy_profiles_without_writing(self):
        cases = (
            ("v0.2.0", ("heartbeat-reports/*", "*.vivary-tmp")),
            ("v0.2.8", ("*.vivary-tmp",)),
            ("v0.3.1", ("*.vivary-tmp",)),
        )
        for version, privacy_recommendations in cases:
            with self.subTest(version=version):
                with temp_workspace() as td:
                    target = Path(td) / f"published-{version}"
                    create_vivary.scaffold_workspace(
                        target, preset="writing", force=False, repo_root=ROOT
                    )
                    apply_published_workspace_fixture(target, version)
                    before = snapshot_workspace(target)

                    report = create_vivary.doctor_workspace(target, repo_root=ROOT)

                    self.assertTrue(report["ok"], report)
                    self.assertEqual(report["errors"], [])
                    self.assertEqual(
                        report["compatibility"]["workspace_contract"],
                        "indexed-v0.2+",
                    )
                    for pattern in privacy_recommendations:
                        self.assertIn(
                            f"recommended privacy ignore missing: {pattern}; "
                            "add it to .gitignore",
                            report["warnings"],
                        )

                    json_rc, json_report = run_doctor_json(target)
                    self.assertEqual(json_rc, 0)
                    self.assertEqual(json_report["ok"], report["ok"])
                    self.assertEqual(json_report["errors"], report["errors"])
                    self.assertEqual(json_report["warnings"], report["warnings"])

                    human = io.StringIO()
                    with redirect_stdout(human):
                        human_rc = create_vivary.main(
                            ["doctor", str(target), "--repo-root", str(ROOT)]
                        )
                    self.assertEqual(human_rc, json_rc)
                    for pattern in privacy_recommendations:
                        self.assertIn(
                            f"warning: recommended privacy ignore missing: {pattern}; "
                            "add it to .gitignore",
                            human.getvalue(),
                        )
                    self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_repair_recognizes_legacy_v01_module_contract(self):
        with temp_workspace() as td:
            target = Path(td) / "legacy-repair"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )
            apply_published_workspace_fixture(target, "v0.1.0")
            gitignore = target / ".gitignore"
            gitignore.write_text(
                gitignore.read_text(encoding="utf-8").replace("USER.md\n", ""),
                encoding="utf-8",
            )

            report = create_vivary.doctor_repair_workspace(
                target, repo_root=ROOT, yes=False
            )

            actions = report["repair"]["actions"]
            self.assertFalse(any(action["kind"] == "workspace" for action in actions))
            self.assertTrue(
                any(
                    action["kind"] == "gitignore"
                    and action["status"] == "safe"
                    and action["path"] == ".gitignore"
                    for action in actions
                ),
                actions,
            )

    def test_doctor_rejects_partial_indexed_workspace_contract(self):
        with temp_workspace() as td:
            target = Path(td) / "partial-indexed-workspace"
            create_vivary.scaffold_workspace(
                target, preset="writing", force=False, repo_root=ROOT
            )
            (target / "modules" / "index.md").unlink()
            before = snapshot_workspace(target)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"], report)
            self.assertEqual(report["compatibility"]["workspace_contract"], "indexed-v0.2+")
            self.assertEqual(
                report["compatibility"]["contract_missing"], ["modules/index.md"]
            )
            self.assertIn(
                "missing required indexed contract file: modules/index.md",
                report["errors"],
            )
            self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_accepts_adopted_brownfield_workspace_without_writing(self):
        with temp_workspace() as td:
            target = Path(td) / "brownfield-workspace"
            target.mkdir()
            (target / "README.md").write_text("# Existing project\n", encoding="utf-8")
            (target / "CLAUDE.md").write_text("# Existing guidance\n", encoding="utf-8")
            for index in range(6):
                docs_path = target / "docs" / f"topic-{index}.md"
                docs_path.parent.mkdir(exist_ok=True)
                docs_path.write_text(f"# Topic {index}\n", encoding="utf-8")
            (target / "src").mkdir()
            (target / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")
            (target / "src" / "util.py").write_text(
                "def helper():\n    return 1\n", encoding="utf-8"
            )
            adopted = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)
            self.assertTrue(adopted["doctor"]["ok"], adopted["doctor"])
            before = snapshot_workspace(target)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)
            self.assertEqual(report["compatibility"]["schema_version"], 1)
            self.assertEqual(report["compatibility"]["workspace_contract"], "indexed-v0.2+")
            self.assertEqual(report["compatibility"]["baseline_missing"], [])
            self.assertEqual(report["compatibility"]["contract_missing"], [])
            self.assertEqual(report["compatibility"]["declared_capability_problems"], [])
            self.assertEqual(report["compatibility"]["recommended_missing"], [])
            self.assertEqual(snapshot_workspace(target), before)

    def test_doctor_rejects_corrupt_baseline_and_declared_storage(self):
        with temp_workspace() as td:
            target = Path(td) / "corrupt-workspace"
            create_vivary.scaffold_workspace(
                target,
                preset="writing",
                force=False,
                storage="embedded",
                provider="lancedb",
                repo_root=ROOT,
            )
            (target / "AGENTS.md").unlink()
            (target / ".vivary" / "storage.toml").write_text(
                "[storage]\nbackend = \"embedded\"\n", encoding="utf-8"
            )
            before = snapshot_workspace(target)

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            problem = (
                "declared capability storage:embedded missing required "
                "[storage.embedded] configuration"
            )
            self.assertFalse(report["ok"])
            self.assertIn("AGENTS.md", report["compatibility"]["baseline_missing"])
            self.assertIn(problem, report["compatibility"]["declared_capability_problems"])
            self.assertIn("missing required file: AGENTS.md", report["errors"])
            self.assertIn(problem, report["errors"])

            json_rc, json_report = run_doctor_json(target)
            self.assertEqual(json_rc, 1)
            self.assertEqual(json_report["ok"], report["ok"])
            self.assertEqual(json_report["errors"], report["errors"])
            self.assertEqual(json_report["warnings"], report["warnings"])

            human = io.StringIO()
            with redirect_stdout(human):
                human_rc = create_vivary.main(
                    ["doctor", str(target), "--repo-root", str(ROOT)]
                )
            self.assertEqual(human_rc, json_rc)
            for error in report["errors"]:
                self.assertIn(f"error: {error}", human.getvalue())
            self.assertEqual(snapshot_workspace(target), before)

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
            self.assertIn("recommended privacy ignore missing: heartbeat-reports/*; add it to .gitignore", report["warnings"])
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
            self.assertIn("recommended privacy ignore missing: heartbeat-reports/*; add it to .gitignore", report["warnings"])

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
            self.assertIn("recommended privacy ignore missing: heartbeat-reports/*; add it to .gitignore", report["warnings"])

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

    def test_doctor_reports_missing_baseline_contract_file(self):
        with temp_workspace() as td:
            target = Path(td) / "agent-workspace"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "STRATO.md").unlink()

            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertFalse(report["ok"])
            self.assertIn("missing required file: STRATO.md", report["errors"])

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
            self.assertEqual(
                actions[0]["details"]["required_markers"],
                list(create_vivary.REPAIR_WORKSPACE_MARKERS),
            )
            self.assertEqual(
                actions[0]["details"]["module_contract_any_of"],
                list(create_vivary.REPAIR_MODULE_CONTRACT_MARKERS),
            )
            self.assertIsNone(out["trend"])
            self.assertFalse((target / ".gitignore").exists())
            self.assertFalse((target / "USER.md").exists())
            self.assertFalse((target / ".vivary" / "doctor-state.json").exists())

    def test_doctor_repair_recognizes_surviving_nested_module_index(self):
        with temp_workspace() as td:
            target = Path(td) / "repair-partial-index"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            (target / "modules" / "index.md").unlink()
            (target / "USER.md").unlink()

            rc, out = run_doctor_json(target, "--repair")

            self.assertEqual(rc, 1)
            self.assertEqual(out["repair"]["mode"], "dry-run")
            actions = out["repair"]["actions"]
            self.assertFalse(any(action["kind"] == "workspace" for action in actions))
            self.assertTrue(
                any(
                    action["kind"] == "placeholder"
                    and action["path"] == "USER.md"
                    and action["status"] == "safe"
                    for action in actions
                )
            )
            self.assertFalse((target / "USER.md").exists())
            self.assertFalse((target / "modules" / "index.md").exists())

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

    def test_governed_install_hints_match_role_manifests(self):
        import tomllib

        expected = {
            "governed-context:tropo": (
                "tropo",
                ["vivary-tropo", "vivary-core"],
                ("vivary-core>=0.2.1",),
            ),
            "governed-policy:strato": (
                "strato",
                ["vivary-strato", "vivary-core"],
                ("vivary-core>=0.2.4",),
            ),
            "governed-verification:ozone": (
                "ozone",
                ["vivary-ozone", "vivary-tropo", "vivary-core"],
                ("vivary-core>=0.2.4", "vivary-tropo>=0.3.0"),
            ),
            "governed-control:exo": (
                "exo",
                ["vivary-exo", "vivary-tropo", "vivary-core"],
                ("vivary-core>=0.2.5", "vivary-tropo>=0.2.3"),
            ),
        }
        by_id = {
            capability["id"]: capability
            for capability in create_vivary._capability_declarations("coding")
        }
        for capability_id, (package_dir, hints, dependencies) in expected.items():
            manifest = tomllib.loads(
                (ROOT / "packages" / package_dir / "pyproject.toml").read_text(
                    encoding="utf-8"
                )
            )["project"]
            self.assertEqual(manifest["requires-python"], ">=3.11")
            for dependency in dependencies:
                self.assertIn(dependency, manifest["dependencies"])
            self.assertEqual(by_id[capability_id]["requires_install"], hints)
            declaration = create_vivary._CAPABILITY_DECLARATIONS[capability_id]
            role_requirement = next(
                requirement
                for requirement in declaration["requirements"]
                if requirement["hint"] == hints[0]
            )
            self.assertEqual(
                manifest["scripts"][role_requirement["script"]],
                f"{role_requirement['module']}:{role_requirement['callable']}",
            )

    def test_package_release_status_links_survive_registry_rendering(self):
        import tomllib

        manifest = tomllib.loads(
            (ROOT / "packages/create-vivary/pyproject.toml").read_text(
                encoding="utf-8"
            )
        )["project"]
        self.assertEqual(manifest["readme"], "README.md")

        release_status_url = (
            "https://github.com/vivary-dev/vivary/blob/dev/"
            "README.md#release-status"
        )
        for relative_path in (
            "packages/create-vivary/README.md",
            "packages/create-vivary/npm/README.md",
        ):
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            self.assertIn(release_status_url, content, relative_path)
            self.assertNotIn("](../../README.md#release-status)", content)
            self.assertNotIn("](../../../README.md#release-status)", content)


class GovernedContextCapabilityTests(unittest.TestCase):
    """#207: report governed package surfaces without importing them."""

    def setUp(self):
        self._real_capability_scripts_path = (
            create_vivary._capability_scripts_path
        )
        scripts_patcher = mock.patch.object(
            create_vivary,
            "_capability_scripts_path",
            side_effect=lambda root: root / ".scripts",
        )
        scripts_patcher.start()
        self.addCleanup(scripts_patcher.stop)

    @staticmethod
    def _write_distribution(
        root: Path,
        name: str,
        version: str,
        module: str,
        *,
        requirements: tuple[str, ...] = (),
        requires_python: str = ">=3.11",
        extras: tuple[str, ...] = (),
        script: str | None = None,
        package: bool = False,
    ) -> None:
        normalized = re.sub(r"[-_.]+", "_", name)
        dist_info = root / f"{normalized}-{version}.dist-info"
        dist_info.mkdir(parents=True)
        metadata = [
            "Metadata-Version: 2.3",
            f"Name: {name}",
            f"Version: {version}",
            f"Requires-Python: {requires_python}",
        ]
        metadata.extend(f"Requires-Dist: {requirement}" for requirement in requirements)
        metadata.extend(f"Provides-Extra: {extra}" for extra in extras)
        (dist_info / "METADATA").write_text(
            "\n".join(metadata) + "\n", encoding="utf-8"
        )

        artifact = (
            Path(*module.split(".")) / "__init__.py"
            if package
            else Path(f"{module}.py")
        )
        artifact_path = root / artifact
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text("", encoding="utf-8")

        records = [artifact.as_posix(), f"{dist_info.name}/METADATA"]
        if script is not None:
            (dist_info / "entry_points.txt").write_text(
                f"[console_scripts]\n{script} = {module}:main\n",
                encoding="utf-8",
            )
            records.append(f"{dist_info.name}/entry_points.txt")
            launcher_name = f"{script}.exe" if os.name == "nt" else script
            launcher = root / ".scripts" / launcher_name
            launcher.parent.mkdir(exist_ok=True)
            launcher.write_text("", encoding="utf-8")
            launcher.chmod(0o755)
            records.append(launcher.relative_to(root).as_posix())
        (dist_info / "RECORD").write_text(
            "".join(f"{record},,\n" for record in records),
            encoding="utf-8",
        )

    def _write_governed_install(self, root: Path) -> None:
        self._write_distribution(
            root, "vivary-core", "0.2.6", "vivary_core", package=True
        )
        self._write_distribution(
            root,
            "vivary-tropo",
            "0.5.0",
            "tropo",
            requirements=(
                "vivary-core>=0.2.1",
                'lancedb>=0.14.0; extra == "embedded"',
            ),
            script="tropo",
        )
        self._write_distribution(
            root,
            "vivary-strato",
            "0.1.2",
            "strato",
            requirements=("vivary-core>=0.2.4",),
            script="strato",
        )
        self._write_distribution(
            root,
            "vivary-ozone",
            "0.3.1",
            "ozone",
            requirements=("vivary-tropo>=0.3.0", "vivary-core>=0.2.4"),
            script="ozone",
        )
        self._write_distribution(
            root,
            "vivary-exo",
            "0.3.0",
            "exo",
            requirements=("vivary-tropo>=0.2.3", "vivary-core>=0.2.5"),
            script="exo",
        )

    def _write_cocoindex_full_install(
        self,
        root: Path,
        *,
        include_leaf: bool = True,
    ) -> None:
        self._write_distribution(
            root,
            "cocoindex-code",
            "0.2.39",
            "cocoindex_code",
            requirements=(
                'cocoindex[sentence-transformers]<1.1.0,>=1.0.13; '
                'extra == "full"',
            ),
            extras=("full",),
            package=True,
        )
        cocoindex_extras = ("sentence-transformers",) + tuple(
            f"optional-{index}" for index in range(21)
        )
        cocoindex_requirements = tuple(
            f'optional-dependency-{index}; extra == "optional-{index % 21}"'
            for index in range(64)
        ) + (
            'sentence-transformers>=3.3.1; '
            'extra == "sentence-transformers"',
        )
        self._write_distribution(
            root,
            "cocoindex",
            "1.0.14",
            "cocoindex",
            requirements=cocoindex_requirements,
            extras=cocoindex_extras,
            package=True,
        )
        if include_leaf:
            self._write_distribution(
                root,
                "sentence-transformers",
                "5.2.0",
                "sentence_transformers",
                package=True,
            )

    def test_governed_capabilities_report_exact_public_truth(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        by_id = {item["id"]: item for item in report["available_capabilities"]}
        expected = {
            "governed-context:core": (None, "library-only"),
            "governed-context:tropo": (
                "tropo find --governed",
                "read-only-context",
            ),
            "governed-policy:strato": (
                "strato decide --governed",
                "decision-only",
            ),
            "governed-verification:ozone": (
                "ozone verify --governed",
                "verification-and-proposal-only",
            ),
            "governed-control:exo": (
                "exo control --governed",
                "projection-only",
            ),
        }
        for capability_id, (command, authority) in expected.items():
            capability = by_id[capability_id]
            self.assertEqual(capability["command"], command)
            self.assertEqual(capability["authority"], authority)
            self.assertFalse(capability["default"])
            self.assertFalse(capability["requires_approval"])
            self.assertFalse(capability["network"])
            self.assertTrue(capability["installed"])
            self.assertEqual(capability["install_status"], "installed")
            self.assertEqual(capability["reason_codes"], [])
            self.assertEqual(capability["missing_install"], [])

        for capability in report["available_capabilities"]:
            self.assertIs(
                capability["installed"],
                capability["install_status"] == "installed",
            )
        self.assertTrue(by_id["storage:file"]["installed"])

    def test_command_capability_requires_recorded_launcher(self):
        for mutation in ("missing", "unrecorded"):
            with self.subTest(mutation=mutation), temp_workspace() as root:
                self._write_governed_install(root)
                launcher_name = "tropo.exe" if os.name == "nt" else "tropo"
                launcher = root / ".scripts" / launcher_name
                launcher_record = launcher.relative_to(root).as_posix()
                if mutation == "missing":
                    launcher.unlink()
                else:
                    record = root / "vivary_tropo-0.5.0.dist-info" / "RECORD"
                    record.write_text(
                        "".join(
                            line
                            for line in record.read_text(encoding="utf-8").splitlines(
                                keepends=True
                            )
                            if line.partition(",")[0] != launcher_record
                        ),
                        encoding="utf-8",
                    )
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                tropo = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "governed-context:tropo"
                )
                self.assertFalse(tropo["installed"])
                self.assertEqual(tropo["install_status"], "incompatible")
                self.assertEqual(
                    tropo["reason_codes"],
                    ["capability_contract_incompatible"],
                )
                self.assertEqual(tropo["missing_install"], [])

    @unittest.skipIf(os.name == "nt", "POSIX RECORD path semantics")
    def test_posix_launcher_record_does_not_treat_backslash_as_separator(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            record = root / "vivary_tropo-0.5.0.dist-info" / "RECORD"
            record.write_text(
                record.read_text(encoding="utf-8").replace(
                    ".scripts/tropo,",
                    ".scripts\\tropo,",
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        tropo = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(tropo["install_status"], "incompatible")
        self.assertEqual(
            tropo["reason_codes"],
            ["capability_contract_incompatible"],
        )

    def test_malformed_record_rows_fail_probe_closed(self):
        for mutation in ("one-column", "vertical-tab"):
            with self.subTest(mutation=mutation), temp_workspace() as root:
                self._write_governed_install(root)
                record = root / "vivary_tropo-0.5.0.dist-info" / "RECORD"
                content = record.read_text(encoding="utf-8")
                if mutation == "one-column":
                    first, *remaining = content.splitlines()
                    content = "\n".join(
                        (first.partition(",")[0], *remaining)
                    ) + "\n"
                else:
                    content = content.replace("\n", "\v", 1)
                record.write_text(content, encoding="utf-8")
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                tropo = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "governed-context:tropo"
                )
                self.assertEqual(tropo["install_status"], "probe-failed")
                self.assertEqual(
                    tropo["reason_codes"],
                    ["capability_probe_failed"],
                )

    @unittest.skipIf(os.name == "nt", "POSIX RECORD path semantics")
    def test_posix_dependency_record_does_not_normalize_backslashes(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root)
            record = (
                root / "sentence_transformers-5.2.0.dist-info" / "RECORD"
            )
            record.write_text(
                record.read_text(encoding="utf-8").replace(
                    "sentence_transformers-5.2.0.dist-info/METADATA,",
                    "sentence_transformers-5.2.0.dist-info\\METADATA,",
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "incompatible")

    def test_missing_and_incompatible_governed_installs_are_distinct(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "vivary-tropo",
                "0.5.0",
                "tropo",
                requirements=("vivary-core>=0.2.1",),
                script="tropo",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                missing = create_vivary.capability_report("coding")

            self._write_distribution(
                root, "vivary-core", "0.2.6", "vivary_core", package=True
            )
            tropo_metadata = next(root.glob("vivary_tropo-*.dist-info/METADATA"))
            tropo_metadata.write_text(
                "Metadata-Version: 2.3\n"
                "Name: vivary-tropo\n"
                "Version: 0.5.0\n"
                "Requires-Python: >=3.11\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                incompatible = create_vivary.capability_report("coding")

        missing_tropo = next(
            item
            for item in missing["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(missing_tropo["install_status"], "not-installed")
        self.assertEqual(
            missing_tropo["reason_codes"], ["capability_dependency_missing"]
        )
        self.assertEqual(missing_tropo["missing_install"], ["vivary-core"])

        incompatible_tropo = next(
            item
            for item in incompatible["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(incompatible_tropo["install_status"], "incompatible")
        self.assertEqual(
            incompatible_tropo["reason_codes"],
            ["capability_contract_incompatible"],
        )
        self.assertEqual(incompatible_tropo["missing_install"], [])

    def test_optional_metadata_version_must_match_dist_info(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            self._write_distribution(
                root,
                "lancedb",
                "9.9.9",
                "lancedb",
                package=True,
            )
            metadata = root / "lancedb-9.9.9.dist-info" / "METADATA"
            metadata.write_text(
                metadata.read_text(encoding="utf-8").replace(
                    "Version: 9.9.9\n",
                    "Version: 0.0.1\n",
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertFalse(embedded["installed"])
        self.assertEqual(embedded["install_status"], "incompatible")
        self.assertEqual(
            embedded["reason_codes"],
            ["capability_contract_incompatible"],
        )

    def test_optional_provider_version_uses_owner_extra_floor(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            tropo_metadata = next(root.glob("vivary_tropo-*.dist-info/METADATA"))
            tropo_metadata.write_text(
                tropo_metadata.read_text(encoding="utf-8").replace(
                    "lancedb>=0.14.0",
                    "lancedb>=0.40.0",
                ),
                encoding="utf-8",
            )
            self._write_distribution(
                root,
                "lancedb",
                "0.36.0",
                "lancedb",
                package=True,
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertFalse(embedded["installed"])
        self.assertEqual(embedded["install_status"], "incompatible")
        self.assertEqual(
            embedded["reason_codes"],
            ["capability_contract_incompatible"],
        )

    def test_optional_provider_uses_metadata_from_pre_governed_owner(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "vivary-tropo",
                "0.4.1",
                "tropo",
                requirements=('lancedb>=0.14.0; extra == "embedded"',),
                script="tropo",
            )
            self._write_distribution(
                root,
                "lancedb",
                "0.36.0",
                "lancedb",
                package=True,
            )
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        by_id = {
            item["id"]: item for item in report["available_capabilities"]
        }
        self.assertEqual(
            by_id["governed-context:tropo"]["install_status"],
            "incompatible",
        )
        embedded = by_id["storage:embedded"]
        self.assertTrue(embedded["installed"])
        self.assertEqual(embedded["install_status"], "installed")
        self.assertEqual(embedded["reason_codes"], [])
        self.assertEqual(embedded["missing_install"], [])

    def test_optional_provider_accepts_supported_pep440_versions(self):
        for version in ("0.14.0.post1", "0.14.0+vendor.1"):
            with self.subTest(version=version):
                with temp_workspace() as root:
                    self._write_governed_install(root)
                    self._write_distribution(
                        root,
                        "lancedb",
                        version,
                        "lancedb",
                        package=True,
                    )
                    with mock.patch.object(
                        create_vivary,
                        "_capability_install_roots",
                        return_value=(root,),
                    ):
                        report = create_vivary.capability_report("coding")

                embedded = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "storage:embedded"
                )
                self.assertTrue(embedded["installed"])
                self.assertEqual(embedded["install_status"], "installed")
                self.assertEqual(embedded["reason_codes"], [])
                self.assertEqual(embedded["missing_install"], [])

    def test_optional_provider_rejects_ambiguous_owner_extra_floor(self):
        conflicts = (
            'lancedb~=999.0.0; extra == "embedded"',
            'lancedb>=999.0.0; extra == "EMBEDDED"',
        )
        for conflict in conflicts:
            with self.subTest(conflict=conflict):
                with temp_workspace() as root:
                    self._write_governed_install(root)
                    tropo_metadata = next(
                        root.glob("vivary_tropo-*.dist-info/METADATA")
                    )
                    tropo_metadata.write_text(
                        tropo_metadata.read_text(encoding="utf-8")
                        + f"Requires-Dist: {conflict}\n",
                        encoding="utf-8",
                    )
                    self._write_distribution(
                        root,
                        "lancedb",
                        "0.36.0",
                        "lancedb",
                        package=True,
                    )
                    with mock.patch.object(
                        create_vivary,
                        "_capability_install_roots",
                        return_value=(root,),
                    ):
                        report = create_vivary.capability_report("coding")

                embedded = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "storage:embedded"
                )
                self.assertFalse(embedded["installed"])
                self.assertEqual(embedded["install_status"], "incompatible")
                self.assertEqual(
                    embedded["reason_codes"],
                    ["capability_contract_incompatible"],
                )

    def test_missing_optional_provider_keeps_install_hint(self):
        with temp_workspace() as root:
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertFalse(embedded["installed"])
        self.assertEqual(embedded["install_status"], "not-installed")
        self.assertEqual(
            embedded["reason_codes"],
            ["capability_dependency_missing"],
        )
        self.assertEqual(
            embedded["missing_install"],
            ["vivary-tropo[embedded]"],
        )

    def test_missing_optional_provider_rejects_invalid_installed_owner_floor(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            tropo_metadata = next(root.glob("vivary_tropo-*.dist-info/METADATA"))
            tropo_metadata.write_text(
                tropo_metadata.read_text(encoding="utf-8").replace(
                    'Requires-Dist: lancedb>=0.14.0; extra == "embedded"\n',
                    "",
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertFalse(embedded["installed"])
        self.assertEqual(embedded["install_status"], "incompatible")
        self.assertEqual(
            embedded["reason_codes"],
            ["capability_contract_incompatible"],
        )
        self.assertEqual(embedded["missing_install"], [])

    def test_same_distribution_extra_requires_complete_selected_closure(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root)
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertTrue(active_context["installed"])
        self.assertEqual(active_context["install_status"], "installed")
        self.assertEqual(active_context["reason_codes"], [])

    def test_same_distribution_extra_ignores_extra_named_base_dependency(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root)
            metadata = next(root.glob("cocoindex-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8")
                + "Requires-Dist: extra-package>=1\n"
                + 'Requires-Dist: unrelated; platform_system == "extra"\n'
                + 'Requires-Dist: unrelated-leaf; python_version < "4" '
                'and extra == "optional-0"\n'
                + 'Requires-Dist: reversed-leaf; "optional-0" == extra\n'
                + 'Requires-Dist: excluded-leaf; '
                'extra != "sentence-transformers"\n',
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "installed")

    def test_same_distribution_extra_rejects_boolean_or_marker(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root)
            metadata = next(root.glob("cocoindex-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8")
                + 'Requires-Dist: missing-leaf; python_version < "4" '
                'or extra == "optional-0"\n',
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "incompatible")

    def test_same_distribution_extra_merges_distinct_child_extra_rows(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "cocoindex-code",
                "0.2.39",
                "cocoindex_code",
                requirements=(
                    'cocoindex[first]>=1.0; extra == "full"',
                    'cocoindex[second]<2.0; extra == "full"',
                ),
                extras=("full",),
                package=True,
            )
            self._write_distribution(
                root,
                "cocoindex",
                "1.0.14",
                "cocoindex",
                requirements=(
                    'first-leaf; extra == "first"',
                    'second-leaf; extra == "second"',
                ),
                extras=("first", "second"),
                package=True,
            )
            self._write_distribution(
                root, "first-leaf", "1.0.0", "first_leaf", package=True
            )
            self._write_distribution(
                root, "second-leaf", "1.0.0", "second_leaf", package=True
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "installed")

    def test_missing_selected_leaf_does_not_mask_incompatible_sibling(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "cocoindex-code",
                "0.2.39",
                "cocoindex_code",
                requirements=(
                    'missing-leaf; extra == "full"',
                    'nested[bad]; extra == "full"',
                ),
                extras=("full",),
                package=True,
            )
            self._write_distribution(
                root,
                "nested",
                "1.0.0",
                "nested",
                requirements=('incompatible-leaf>=2; extra == "bad"',),
                extras=("bad",),
                package=True,
            )
            self._write_distribution(
                root,
                "incompatible-leaf",
                "1.0.0",
                "incompatible_leaf",
                package=True,
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "incompatible")

    def test_incompatible_selected_leaf_does_not_mask_probe_failed_sibling(self):
        for requirements in (
            ("old-child>=2", "broken-child"),
            ("broken-child", "old-child>=2"),
        ):
            with self.subTest(requirements=requirements), temp_workspace() as root:
                self._write_distribution(
                    root,
                    "cocoindex-code",
                    "0.2.39",
                    "cocoindex_code",
                    requirements=tuple(
                        f'{requirement}; extra == "full"'
                        for requirement in requirements
                    ),
                    extras=("full",),
                    package=True,
                )
                self._write_distribution(
                    root,
                    "old-child",
                    "1.0.0",
                    "old_child",
                    package=True,
                )
                self._write_distribution(
                    root,
                    "broken-child",
                    "1.0.0",
                    "broken_child",
                    package=True,
                )
                broken_metadata = (
                    root / "broken_child-1.0.0.dist-info" / "METADATA"
                )
                broken_metadata.write_bytes(b"\xff")
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                active_context = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "active-context:cocoindex-code"
                )
                self.assertEqual(active_context["install_status"], "probe-failed")
                self.assertEqual(
                    active_context["reason_codes"],
                    ["capability_probe_failed"],
                )

    def test_same_distribution_extra_missing_leaf_is_not_installed(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root, include_leaf=False)
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertFalse(active_context["installed"])
        self.assertEqual(active_context["install_status"], "not-installed")
        self.assertEqual(
            active_context["missing_install"],
            ["cocoindex-code[full]"],
        )

    def test_same_distribution_extra_rejects_bare_owner_metadata(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "cocoindex-code",
                "0.2.39",
                "cocoindex_code",
                requirements=(
                    'cocoindex[sentence-transformers]<1.1.0,>=1.0.13; '
                    'extra == "full"',
                ),
                package=True,
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "incompatible")
        self.assertEqual(
            active_context["reason_codes"],
            ["capability_contract_incompatible"],
        )

    def test_same_distribution_extra_depth_is_requirement_order_independent(self):
        root_rows = (
            ("shallow[branch]>=1", "deep-one[branch]>=1"),
            ("deep-one[branch]>=1", "shallow[branch]>=1"),
        )
        nodes = (
            ("shallow", "branch", "pivot[pivot]>=1"),
            ("deep-one", "branch", "deep-two[branch]>=1"),
            ("deep-two", "branch", "deep-three[branch]>=1"),
            ("deep-three", "branch", "pivot[pivot]>=1"),
            ("pivot", "pivot", "leaf[leaf]>=1"),
            ("leaf", "leaf", None),
        )
        for requirements in root_rows:
            with self.subTest(requirements=requirements), temp_workspace() as root:
                self._write_distribution(
                    root,
                    "cocoindex-code",
                    "0.2.39",
                    "cocoindex_code",
                    requirements=tuple(
                        f'{requirement}; extra == "full"'
                        for requirement in requirements
                    ),
                    extras=("full",),
                    package=True,
                )
                for name, selected_extra, dependency in nodes:
                    self._write_distribution(
                        root,
                        name,
                        "1.0.0",
                        name.replace("-", "_"),
                        requirements=(
                            ()
                            if dependency is None
                            else (f'{dependency}; extra == "{selected_extra}"',)
                        ),
                        extras=(selected_extra,),
                        package=True,
                    )
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                active_context = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "active-context:cocoindex-code"
                )
                self.assertEqual(active_context["install_status"], "installed")

    def test_same_distribution_extra_cycle_terminates(self):
        with temp_workspace() as root:
            self._write_distribution(
                root,
                "cocoindex-code",
                "0.2.39",
                "cocoindex_code",
                requirements=(
                    'cocoindex[local]>=1.0.13; extra == "full"',
                ),
                extras=("full",),
                package=True,
            )
            self._write_distribution(
                root,
                "cocoindex",
                "1.0.14",
                "cocoindex",
                requirements=(
                    'cocoindex-code[full]>=0.2.0; extra == "local"',
                ),
                extras=("local",),
                package=True,
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "installed")

    def test_same_distribution_extra_work_limit_fails_closed(self):
        with temp_workspace() as root:
            self._write_cocoindex_full_install(root)
            with (
                mock.patch.object(
                    create_vivary, "_capability_install_roots", return_value=(root,)
                ),
                mock.patch.object(create_vivary, "_CAPABILITY_EXTRA_EDGE_LIMIT", 0),
            ):
                report = create_vivary.capability_report("coding")

        active_context = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "active-context:cocoindex-code"
        )
        self.assertEqual(active_context["install_status"], "probe-failed")
        self.assertEqual(
            active_context["reason_codes"],
            ["capability_probe_failed"],
        )

    def test_third_party_requires_python_is_enforced(self):
        cases = (
            (">=3.10,<4,!=99.*,~=3.0", "installed"),
            (">=99", "incompatible"),
            (">=3.11; os_name == 'nt'", "incompatible"),
        )
        for requires_python, expected_status in cases:
            with self.subTest(requires_python=requires_python):
                with temp_workspace() as root:
                    self._write_governed_install(root)
                    self._write_distribution(
                        root,
                        "lancedb",
                        "0.36.0",
                        "lancedb",
                        requires_python=requires_python,
                        package=True,
                    )
                    with mock.patch.object(
                        create_vivary,
                        "_capability_install_roots",
                        return_value=(root,),
                    ):
                        report = create_vivary.capability_report("coding")

                embedded = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "storage:embedded"
                )
                self.assertEqual(embedded["install_status"], expected_status)

    def test_prerelease_interpreter_fails_python_constraint_closed(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            self._write_distribution(
                root,
                "lancedb",
                "0.36.0",
                "lancedb",
                requires_python=">=3.14",
                package=True,
            )
            candidate_version = mock.MagicMock()
            candidate_version.__getitem__.return_value = (3, 14, 0)
            candidate_version.releaselevel = "candidate"
            with (
                mock.patch.object(
                    create_vivary, "_capability_install_roots", return_value=(root,)
                ),
                mock.patch.object(
                    create_vivary.sys, "version_info", candidate_version
                ),
            ):
                report = create_vivary.capability_report("coding")

        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertEqual(embedded["install_status"], "incompatible")

    def test_role_dependency_and_console_contracts_are_required(self):
        cases = (
            ("vivary-ozone", "governed-verification:ozone", "vivary-tropo>=0.3.0"),
            ("vivary-exo", "governed-control:exo", "vivary-tropo>=0.2.3"),
        )
        for distribution, capability_id, dependency in cases:
            with self.subTest(distribution=distribution, failure="dependency"):
                with temp_workspace() as root:
                    self._write_governed_install(root)
                    metadata = next(
                        root.glob(
                            f"{re.sub(r'[-_.]+', '_', distribution)}-*.dist-info/METADATA"
                        )
                    )
                    metadata.write_text(
                        metadata.read_text(encoding="utf-8").replace(
                            f"Requires-Dist: {dependency}\n", ""
                        ),
                        encoding="utf-8",
                    )
                    with mock.patch.object(
                        create_vivary, "_capability_install_roots", return_value=(root,)
                    ):
                        report = create_vivary.capability_report("coding")

                capability = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == capability_id
                )
                self.assertEqual(capability["install_status"], "incompatible")

        with temp_workspace() as root:
            self._write_governed_install(root)
            entrypoints = next(
                root.glob("vivary_ozone-*.dist-info/entry_points.txt")
            )
            entrypoints.write_text(
                "[console_scripts]\nozone = ozone_shadow:main\n", encoding="utf-8"
            )
            (root / "ozone_shadow.py").write_text("", encoding="utf-8")
            record = next(root.glob("vivary_ozone-*.dist-info/RECORD"))
            record.write_text(
                record.read_text(encoding="utf-8") + "ozone_shadow.py,,\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        ozone = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-verification:ozone"
        )
        self.assertEqual(ozone["install_status"], "incompatible")

        with temp_workspace() as root:
            self._write_governed_install(root)
            record = next(root.glob("vivary_strato-*.dist-info/RECORD"))
            record.write_text(
                "".join(
                    line
                    for line in record.read_text(encoding="utf-8").splitlines(
                        keepends=True
                    )
                    if "/entry_points.txt," not in line
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        strato = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-policy:strato"
        )
        self.assertEqual(strato["install_status"], "incompatible")

        with temp_workspace() as root:
            self._write_governed_install(root)
            record = next(root.glob("vivary_core-*.dist-info/RECORD"))
            record.write_text(
                "".join(
                    line
                    for line in record.read_text(encoding="utf-8").splitlines(
                        keepends=True
                    )
                    if "/METADATA," not in line
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "incompatible")

    def test_broken_console_callable_and_conflicting_floor_are_incompatible(self):
        for target in ("tropo", "tropo:not_main"):
            with self.subTest(target=target), temp_workspace() as root:
                self._write_governed_install(root)
                entrypoints = next(
                    root.glob("vivary_tropo-*.dist-info/entry_points.txt")
                )
                entrypoints.write_text(
                    f"[console_scripts]\ntropo = {target}\n",
                    encoding="utf-8",
                )
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                tropo = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "governed-context:tropo"
                )
                self.assertEqual(tropo["install_status"], "incompatible")

        with temp_workspace() as root:
            self._write_governed_install(root)
            metadata = next(root.glob("vivary_tropo-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8")
                + "Requires-Dist: vivary-core<0.1.0\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        tropo = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(tropo["install_status"], "incompatible")

    def test_malformed_metadata_fails_the_probe(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            metadata = next(root.glob("vivary_core-*.dist-info/METADATA"))
            metadata.write_bytes(
                b"Metadata-Version: 2.3\n"
                b"Name: vivary-core\n"
                b"Version: 0.2.6\n"
                b"Requires-Python: >=3.11\n"
                b"broken metadata header\n"
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")

    def test_irrelevant_metadata_fields_do_not_hide_valid_install(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            metadata = next(root.glob("vivary_core-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8")
                + ("Classifier: bounded-probe\n" * 128),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "installed")

    def test_excessive_dependency_metadata_fields_fail_the_probe(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            metadata = next(root.glob("vivary_core-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8")
                + (
                    "Requires-Dist: unrelated>=1.0.0\n"
                    * (create_vivary._CAPABILITY_REQUIREMENT_LIMIT + 1)
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")

    def test_passive_probe_ignores_ambient_import_hooks_and_workspace_metadata(self):
        class ExplodingFinder:
            def find_spec(self, fullname, path=None, target=None):
                raise AssertionError(f"ambient finder called for {fullname}")

            def find_distributions(self, context=None):
                raise AssertionError("ambient distribution finder called")

        with temp_workspace() as canonical_root, temp_workspace() as workspace_root:
            self._write_governed_install(canonical_root)
            self._write_distribution(
                workspace_root,
                "vivary-core",
                "99.0.0",
                "vivary_core",
                package=True,
            )
            shadow = workspace_root / "tropo.py"
            shadow.write_text("raise RuntimeError('shadow imported')\n", encoding="utf-8")

            with (
                mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(canonical_root,),
                ),
                mock.patch.object(sys, "meta_path", [ExplodingFinder(), *sys.meta_path]),
                mock.patch.object(sys, "path", [str(workspace_root), *sys.path]),
            ):
                report = create_vivary.capability_report("coding")

        governed = [
            item
            for item in report["available_capabilities"]
            if item["id"].startswith("governed-")
        ]
        self.assertTrue(governed)
        self.assertTrue(all(item["installed"] for item in governed))

    def test_earlier_canonical_root_shadow_is_incompatible(self):
        with temp_workspace() as earlier, temp_workspace() as installed:
            (earlier / "tropo.py").write_text(
                "raise RuntimeError('shadow imported')\n",
                encoding="utf-8",
            )
            self._write_governed_install(installed)
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(earlier, installed),
            ):
                report = create_vivary.capability_report("coding")

        tropo = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(tropo["install_status"], "incompatible")
        self.assertEqual(
            tropo["reason_codes"],
            ["capability_contract_incompatible"],
        )

    def test_dist_info_names_accept_standard_separator_normalization(self):
        for separator in ("-", "."):
            with self.subTest(separator=separator), temp_workspace() as root:
                self._write_governed_install(root)
                original = next(root.glob("vivary_core-*.dist-info"))
                renamed = root / original.name.replace(
                    "vivary_core",
                    f"Vivary{separator}Core",
                )
                original.rename(renamed)
                record = renamed / "RECORD"

                record.write_text(
                    record.read_text(encoding="utf-8").replace(
                        original.name,
                        renamed.name,
                    ),
                    encoding="utf-8",
                )
                with mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(root,),
                ):
                    report = create_vivary.capability_report("coding")

                core = next(
                    item
                    for item in report["available_capabilities"]
                    if item["id"] == "governed-context:core"
                )
                self.assertEqual(core["install_status"], "installed")

    def test_dist_info_version_must_match_metadata(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            original = next(root.glob("vivary_core-*.dist-info"))
            renamed = root / original.name.replace("0.2.6", "9.9.9")
            original.rename(renamed)
            record = renamed / "RECORD"
            record.write_text(
                record.read_text(encoding="utf-8").replace(
                    original.name,
                    renamed.name,
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "incompatible")

    def test_dist_info_link_alias_is_incompatible(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            alias = next(root.glob("vivary_core-*.dist-info"))
            target = root / alias.name.replace("vivary_core", "other")
            alias.rename(target)
            record = target / "RECORD"
            record.write_text(
                record.read_text(encoding="utf-8").replace(
                    alias.name,
                    target.name,
                ),
                encoding="utf-8",
            )
            try:
                alias.symlink_to(target, target_is_directory=True)
            except OSError:
                self.skipTest("symlink creation is unavailable")
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "incompatible")

    def test_same_root_competing_module_artifact_is_incompatible(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            shadow = root / "tropo" / "__init__.py"
            shadow.parent.mkdir()
            shadow.write_text("raise RuntimeError('shadow imported')\n", encoding="utf-8")
            with mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        tropo = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(tropo["install_status"], "incompatible")

    def test_metadata_and_entrypoint_share_one_byte_budget(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            dist_info = next(root.glob("vivary_tropo-*.dist-info"))
            limit = max(
                len((dist_info / "METADATA").read_bytes()),
                len((dist_info / "entry_points.txt").read_bytes()),
            )
            with mock.patch.object(
                create_vivary,
                "_CAPABILITY_METADATA_BYTE_LIMIT",
                limit,
            ), mock.patch.object(
                create_vivary,
                "_capability_install_roots",
                return_value=(root,),
            ):
                report = create_vivary.capability_report("coding")

        tropo = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:tropo"
        )
        self.assertEqual(tropo["install_status"], "probe-failed")

    def test_probe_limits_fail_closed_without_path_details(self):
        with temp_workspace() as root:
            (root / "one").mkdir()
            (root / "two").mkdir()
            with (
                mock.patch.object(
                    create_vivary, "_capability_install_roots", return_value=(root,)
                ),
                mock.patch.object(create_vivary, "_CAPABILITY_ROOT_ENTRY_LIMIT", 1),
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")
        self.assertEqual(core["reason_codes"], ["capability_probe_failed"])
        self.assertEqual(core["missing_install"], [])
        self.assertNotIn(str(root), json.dumps(report))

    def test_probe_entry_limit_applies_across_canonical_roots(self):
        with temp_workspace() as first, temp_workspace() as second:
            (first / "one").mkdir()
            (second / "two").mkdir()
            with (
                mock.patch.object(
                    create_vivary,
                    "_capability_install_roots",
                    return_value=(first, second),
                ),
                mock.patch.object(
                    create_vivary,
                    "_CAPABILITY_ROOT_ENTRY_LIMIT",
                    1,
                ),
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")
        self.assertEqual(core["reason_codes"], ["capability_probe_failed"])

    def test_sys_path_limit_fails_closed(self):
        with mock.patch.object(
            sys,
            "path",
            [""] * (create_vivary._CAPABILITY_SYS_PATH_ENTRY_LIMIT + 1),
        ):
            report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")
        self.assertEqual(core["reason_codes"], ["capability_probe_failed"])

    def test_user_site_root_uses_user_scheme_scripts_directory(self):
        with (
            temp_workspace() as default_site,
            temp_workspace() as default_scripts,
            temp_workspace() as user_site,
            temp_workspace() as user_scripts,
        ):
            default_paths = {
                "purelib": str(default_site),
                "platlib": str(default_site),
                "scripts": str(default_scripts),
            }
            user_paths = {
                "purelib": str(user_site),
                "platlib": str(user_site),
                "scripts": str(user_scripts),
            }

            def scheme_paths(*, scheme=None, vars=None):
                if scheme == "test-user":
                    return user_paths
                return default_paths

            with (
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_preferred_scheme",
                    return_value="test-user",
                ),
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_paths",
                    side_effect=scheme_paths,
                ),
            ):
                scripts = self._real_capability_scripts_path(user_site.resolve())

        self.assertEqual(scripts, user_scripts.resolve())

    def test_scripts_mapping_does_not_resolve_unmatched_scheme_roots(self):
        with (
            temp_workspace() as selected_site,
            temp_workspace() as selected_scripts,
            temp_workspace() as unrelated_site,
            temp_workspace() as unrelated_scripts,
        ):
            selected_root = selected_site.resolve()
            unrelated_library = unrelated_site / "must-not-resolve"
            default_paths = {
                "purelib": str(selected_site),
                "platlib": str(selected_site),
                "scripts": str(selected_scripts),
            }
            user_paths = {
                "purelib": str(unrelated_library),
                "platlib": str(unrelated_library),
                "scripts": str(unrelated_scripts),
            }

            def scheme_paths(*, scheme=None, vars=None):
                if scheme == "test-user":
                    return user_paths
                return default_paths

            path_type = type(selected_site)
            real_resolve = path_type.resolve

            def guarded_resolve(path, *args, **kwargs):
                if path == unrelated_library:
                    raise AssertionError("resolved unmatched scheme root")
                return real_resolve(path, *args, **kwargs)

            with (
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_preferred_scheme",
                    return_value="test-user",
                ),
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_paths",
                    side_effect=scheme_paths,
                ),
                mock.patch.object(
                    path_type,
                    "resolve",
                    autospec=True,
                    side_effect=guarded_resolve,
                ),
            ):
                scripts = self._real_capability_scripts_path(selected_root)

        self.assertEqual(scripts, selected_scripts.resolve())


    def test_install_roots_intersect_active_sys_path_in_order(self):
        with (
            temp_workspace() as purelib,
            temp_workspace() as platlib,
            temp_workspace() as system_site,
            temp_workspace() as user_site,
        ):
            self._write_governed_install(system_site)
            self._write_distribution(
                system_site,
                "lancedb",
                "0.36.0",
                "lancedb",
                package=True,
            )
            with (
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_paths",
                    return_value={
                        "purelib": str(purelib),
                        "platlib": str(platlib),
                    },
                ),
                mock.patch.object(
                    create_vivary.site,
                    "getsitepackages",
                    return_value=[str(purelib), str(system_site)],
                ),
                mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", True),
                mock.patch.object(
                    create_vivary,
                    "_CAPABILITY_ROOT_LIMIT",
                    3,
                ),
                mock.patch.object(
                    create_vivary.site,
                    "getusersitepackages",
                    return_value=str(user_site),
                ),
                mock.patch.object(
                    create_vivary.sys,
                    "path",
                    [
                        7,
                        str(system_site),
                        str(user_site),
                        str(purelib),
                        str(platlib),
                    ],
                ),
            ):
                roots = create_vivary._capability_install_roots()
                report = create_vivary.capability_report("coding")

        self.assertEqual(
            roots,
            (
                system_site.resolve(),
                user_site.resolve(),
                purelib.resolve(),
            ),
        )
        embedded = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "storage:embedded"
        )
        self.assertEqual(embedded["install_status"], "installed")

    def test_site_root_provider_failures_are_contained_without_details(self):
        class ExplodingSites(list):
            def __len__(self):
                raise LookupError("sensitive provider detail")

        class LyingSites(list):
            def __len__(self):
                return 0

            def __iter__(self):
                return iter(("sensitive provider detail",) * 9)

        class ExplodingSysPath(list):
            def __len__(self):
                raise LookupError("sensitive provider detail")

        reports = []
        with (
            mock.patch.object(
                create_vivary.site,
                "getsitepackages",
                return_value=ExplodingSites(),
            ),
            mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", False),
        ):
            reports.append(create_vivary.capability_report("coding"))

        with (
            mock.patch.object(
                create_vivary.site,
                "getsitepackages",
                return_value=LyingSites(),
            ),
            mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", False),
        ):
            reports.append(create_vivary.capability_report("coding"))

        with (
            mock.patch.object(
                create_vivary.site,
                "getsitepackages",
                return_value=[],
            ),
            mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", True),
            mock.patch.object(
                create_vivary.site,
                "getusersitepackages",
                side_effect=LookupError("sensitive provider detail"),
            ),
        ):
            reports.append(create_vivary.capability_report("coding"))

        with (
            mock.patch.object(
                create_vivary.site,
                "getsitepackages",
                return_value=[],
            ),
            mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", False),
            mock.patch.object(
                create_vivary.sys,
                "path",
                ExplodingSysPath(),
            ),
        ):
            reports.append(create_vivary.capability_report("coding"))

        for report in reports:
            core = next(
                item
                for item in report["available_capabilities"]
                if item["id"] == "governed-context:core"
            )
            self.assertEqual(core["install_status"], "probe-failed")
            self.assertEqual(core["reason_codes"], ["capability_probe_failed"])
            self.assertNotIn("sensitive provider detail", json.dumps(report))

    def test_incomplete_metadata_and_out_of_root_dist_info_are_not_credited(self):
        with temp_workspace() as root:
            self._write_governed_install(root)
            metadata = next(root.glob("vivary_core-*.dist-info/METADATA"))
            metadata.write_text(
                metadata.read_text(encoding="utf-8").replace(
                    "Metadata-Version: 2.3\n", ""
                ),
                encoding="utf-8",
            )
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "probe-failed")
        with self.assertRaises(create_vivary._CapabilityProbeFailure):
            create_vivary._parse_capability_metadata(
                b"Metadata-Version: \n"
                b"Name: vivary-core\n"
                b"Version: 0.2.6\n"
                b"Requires-Python: >=3.11\n"
            )

        with temp_workspace() as root, temp_workspace() as outside:
            self._write_distribution(
                outside, "vivary-core", "0.2.6", "vivary_core", package=True
            )
            external = next(outside.glob("vivary_core-*.dist-info"))
            try:
                (root / external.name).symlink_to(external, target_is_directory=True)
            except OSError:
                self.skipTest("symlink creation is unavailable")
            with mock.patch.object(
                create_vivary, "_capability_install_roots", return_value=(root,)
            ):
                report = create_vivary.capability_report("coding")

        core = next(
            item
            for item in report["available_capabilities"]
            if item["id"] == "governed-context:core"
        )
        self.assertEqual(core["install_status"], "incompatible")

    def test_canonical_root_resolution_failure_is_not_skipped(self):
        with temp_workspace() as root:
            original_resolve = Path.resolve

            def inaccessible_resolve(path, *args, **kwargs):
                if path == root:
                    raise PermissionError("unavailable")
                return original_resolve(path, *args, **kwargs)

            with (
                mock.patch.object(
                    create_vivary.sysconfig,
                    "get_paths",
                    return_value={"purelib": str(root), "platlib": str(root)},
                ),
                mock.patch.object(create_vivary.site, "ENABLE_USER_SITE", False),
                mock.patch.object(Path, "resolve", new=inaccessible_resolve),
            ):
                with self.assertRaises(create_vivary._CapabilityProbeFailure):
                    create_vivary._capability_install_roots()

    def test_doctor_embeds_same_capability_envelope_and_optional_absence_is_nonfatal(self):
        with temp_workspace() as td:
            target = Path(td) / "capability-probe"
            create_vivary.scaffold_workspace(
                target, preset="coding", force=False, repo_root=ROOT
            )
            report = create_vivary.doctor_workspace(target, repo_root=ROOT)

            self.assertTrue(report["ok"], report)
            self.assertEqual(report["capabilities"], create_vivary.capability_report("coding"))
            self.assertNotIn("vivary-core", json.dumps(report["errors"]))

            readme = target / "README.md"
            original = readme.read_text(encoding="utf-8")
            readme.write_text(
                original.replace("Preset: coding", "Preset: knowledge-work"),
                encoding="utf-8",
            )
            knowledge_work = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertEqual(knowledge_work["capabilities"]["preset"], "knowledge-work")
            self.assertFalse(
                any(
                    item["id"].startswith("active-context:")
                    for item in knowledge_work["capabilities"]["available_capabilities"]
                )
            )

            readme.write_text(
                original.replace("Preset: coding", "Preset: unsupported"),
                encoding="utf-8",
            )
            unknown = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertIsNone(unknown["capabilities"]["preset"])
            self.assertFalse(
                any(
                    item["id"].startswith("active-context:")
                    for item in unknown["capabilities"]["available_capabilities"]
                )
            )

            readme.write_text(
                original.replace("Preset: coding\n", ""), encoding="utf-8"
            )
            missing = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertIsNone(missing["capabilities"]["preset"])

        with mock.patch.object(
            create_vivary,
            "_resolve_doctor_repair_target",
            side_effect=create_vivary.ScaffoldError("simulated refusal"),
        ):
            refused = create_vivary.doctor_repair_workspace(
                "ignored", repo_root=ROOT, yes=False
            )
        self.assertFalse(refused["ok"])
        self.assertIsNone(refused["capabilities"]["preset"])
        self.assertTrue(
            any(
                item["id"] == "governed-context:core"
                for item in refused["capabilities"]["available_capabilities"]
            )
        )

    def test_workspace_declared_preset_refuses_oversized_readme(self):
        with temp_workspace() as target:
            readme = target / "README.md"
            readme.write_bytes(
                b"Preset: coding\n"
                + b"x" * create_vivary._WORKSPACE_PRESET_BYTE_LIMIT
            )

            self.assertEqual(
                create_vivary._workspace_declared_preset(target), "<preset>"
            )



if __name__ == "__main__":
    unittest.main()
