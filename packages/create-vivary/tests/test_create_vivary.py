"""Tests for the create-vivary workspace scaffold."""

import sys
import shutil
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
