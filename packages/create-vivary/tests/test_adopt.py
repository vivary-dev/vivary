"""Tests for `create-vivary adopt` (brownfield adopt, P1.2 first slice)."""

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
TROPO = ROOT / "packages" / "tropo"

sys.path.insert(0, str(PKG))
sys.path.insert(0, str(TROPO))

import create_vivary  # noqa: E402
import tropo  # noqa: E402


def temp_dir():
    path = ROOT / "sandboxes" / f"test-adopt-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def make_brownfield_fixture(root: Path) -> None:
    """A repo with an existing README.md, CLAUDE.md, a docs/ tree with 6 markdown
    files (a candidate module), and a couple of source files (so the tree is not
    markdown-only)."""
    write(root / "README.md", "# My existing project\n")
    write(root / "CLAUDE.md", "# Claude guidance for this repo\n")
    for i in range(6):
        write(root / "docs" / f"topic-{i}.md", f"# Topic {i}\n")
    write(root / "src" / "main.py", "print('hello')\n")
    write(root / "src" / "util.py", "def helper():\n    return 1\n")


def snapshot(root: Path) -> dict[str, str]:
    """path -> sha256 for every file under root (relative, posix-normalized)."""
    out = {}
    for path in root.rglob("*"):
        if path.is_file():
            out[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def run_cli(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = create_vivary.main(argv)
    return rc, buf.getvalue()


class AdoptDryRunTests(unittest.TestCase):
    def test_dry_run_writes_nothing(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            before = snapshot(target)

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=False)

            after = snapshot(target)
            self.assertEqual(before, after, "dry-run must not create, edit, or remove any file")
            self.assertFalse(result["applied"])
            self.assertIsNone(result["doctor"])
            self.assertGreater(len(result["would_create"]), 0)
        finally:
            shutil.rmtree(target)

    def test_dry_run_is_the_default_cli_mode(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            before = snapshot(target)

            rc, out = run_cli(["adopt", str(target), "--repo-root", str(ROOT), "--json"])

            after = snapshot(target)
            self.assertEqual(rc, 0)
            self.assertEqual(before, after)
            payload = json.loads(out)
            self.assertEqual(payload["mode"], "dry-run")
        finally:
            shutil.rmtree(target)

    def test_plan_is_deterministic_and_lists_docs_module_router(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)

            first = create_vivary.plan_adopt(target, repo_root=ROOT)
            second = create_vivary.plan_adopt(target, repo_root=ROOT)

            first_rel = sorted(p.relative_to(target).as_posix() for p in first["would_create"])
            second_rel = sorted(p.relative_to(target).as_posix() for p in second["would_create"])
            self.assertEqual(first_rel, second_rel)

            self.assertIn("modules/docs/index.md", first_rel)
            router_write = next(
                text for dst, text in first["writes"]
                if dst == target / "modules" / "docs" / "index.md"
            )
            self.assertIn("docs/", router_write)
        finally:
            shutil.rmtree(target)

    def test_existing_readme_is_kept_not_overwritten(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            original = (target / "README.md").read_text(encoding="utf-8")

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            kept_rel = {p.relative_to(target).as_posix() for p in result["kept"]}
            self.assertIn("README.md", kept_rel)
            self.assertEqual((target / "README.md").read_text(encoding="utf-8"), original)
        finally:
            shutil.rmtree(target)

    def test_existing_agents_md_is_kept_and_reported(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            write(target / "AGENTS.md", "existing contract, do not touch\n")

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            kept_rel = {p.relative_to(target).as_posix() for p in result["kept"]}
            would_create_rel = {p.relative_to(target).as_posix() for p in result["would_create"]}
            self.assertIn("AGENTS.md", kept_rel)
            self.assertNotIn("AGENTS.md", would_create_rel)
            self.assertEqual(
                (target / "AGENTS.md").read_text(encoding="utf-8"),
                "existing contract, do not touch\n",
            )
        finally:
            shutil.rmtree(target)

    def test_preset_defaults_to_second_brain_for_markdown_majority_tree(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)  # 6 markdown vs 2 code files

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            self.assertEqual(result["preset"], "second-brain")
            self.assertIn("markdown", result["preset_reason"])
        finally:
            shutil.rmtree(target)

    def test_preset_defaults_to_coding_for_code_majority_tree(self):
        target = temp_dir()
        try:
            write(target / "README.md", "# Code project\n")
            for i in range(10):
                write(target / "src" / f"mod{i}.py", "x = 1\n")
            write(target / "docs" / "notes.md", "# just one note\n")

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            self.assertEqual(result["preset"], "coding")
            self.assertIn("code", result["preset_reason"])
        finally:
            shutil.rmtree(target)

    def test_explicit_preset_flag_overrides_heuristic(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)  # would default to second-brain

            result = create_vivary.plan_adopt(target, preset="writing", repo_root=ROOT)

            self.assertEqual(result["preset"], "writing")
            self.assertIn("explicit", result["preset_reason"])
        finally:
            shutil.rmtree(target)

    def test_gitignore_present_is_untouched_and_followups_listed(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            write(target / ".gitignore", "node_modules/\n")

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            kept_rel = {p.relative_to(target).as_posix() for p in result["kept"]}
            self.assertIn(".gitignore", kept_rel)
            self.assertEqual((target / ".gitignore").read_text(encoding="utf-8"), "node_modules/\n")
            self.assertTrue(result["followups"], "missing privacy lines should be reported")
            joined = "\n".join(result["followups"])
            self.assertIn("USER.md", joined)
            self.assertIn("MEMORY.md", joined)
            self.assertIn("memory/*", joined)
            self.assertIn("heartbeat-reports/*", joined)
        finally:
            shutil.rmtree(target)

    def test_no_gitignore_means_no_followups(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            self.assertFalse((target / ".gitignore").exists())

            result = create_vivary.plan_adopt(target, repo_root=ROOT)

            self.assertEqual(result["followups"], [])
        finally:
            shutil.rmtree(target)

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_refuses_symlinked_target(self):
        parent = temp_dir()
        try:
            outside = parent / "outside"
            outside.mkdir()
            target = parent / "adopt-me"
            try:
                target.symlink_to(outside, target_is_directory=True)
            except OSError:
                return

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked target"):
                create_vivary.plan_adopt(target, repo_root=ROOT)

            self.assertFalse((outside / "AGENTS.md").exists())
        finally:
            shutil.rmtree(parent)

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_existing_symlinked_destination_is_kept_not_written_through(self):
        """A destination that already exists (even as a symlink) is planned as
        'exists, kept' and never opened for writing — adopt's only-add rule
        already keeps this safe without needing a dedicated refusal path."""
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            outside = target.parent / f"{target.name}-outside"
            outside.mkdir()
            victim = outside / "victim.txt"
            victim.write_text("keep me\n", encoding="utf-8")
            (target / "SOUL.md").symlink_to(victim)

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertEqual(victim.read_text(encoding="utf-8"), "keep me\n")
            kept_rel = {p.relative_to(target).as_posix() for p in result["kept"]}
            self.assertIn("SOUL.md", kept_rel)
        finally:
            shutil.rmtree(target)
            if outside.exists():
                shutil.rmtree(outside)

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks unavailable")
    def test_yes_refuses_symlinked_destination_ancestor(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            outside = target.parent / f"{target.name}-outside"
            outside.mkdir()
            (target / "modules").symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "symlinked|outside"):
                create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertFalse((outside / "index.md").exists())
        finally:
            shutil.rmtree(target)
            if outside.exists():
                shutil.rmtree(outside)


class AdoptApplyTests(unittest.TestCase):
    def test_yes_creates_planned_files_and_keeps_existing_bytes_identical(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            before_existing = {
                "README.md": (target / "README.md").read_bytes(),
                "CLAUDE.md": (target / "CLAUDE.md").read_bytes(),
                "src/main.py": (target / "src" / "main.py").read_bytes(),
                "src/util.py": (target / "src" / "util.py").read_bytes(),
            }
            for i in range(6):
                before_existing[f"docs/topic-{i}.md"] = (target / "docs" / f"topic-{i}.md").read_bytes()

            plan = create_vivary.plan_adopt(target, repo_root=ROOT)
            planned_rel = sorted(p.relative_to(target).as_posix() for p in plan["would_create"])

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertTrue(result["applied"])
            for rel, data in before_existing.items():
                self.assertEqual((target / rel).read_bytes(), data, f"{rel} must be byte-identical")

            for rel in planned_rel:
                self.assertTrue((target / rel).exists(), f"planned file not created: {rel}")

            self.assertTrue((target / "AGENTS.md").exists())
            self.assertTrue((target / "tropo.toml").exists())
            self.assertTrue((target / "modules" / "docs" / "index.md").exists())
        finally:
            shutil.rmtree(target)

    def test_yes_reports_ok_doctor(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertIsNotNone(result["doctor"])
            self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
        finally:
            shutil.rmtree(target)

    def test_yes_passes_tropo_check_including_candidate_module_router(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)

            create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            docs = tropo.analyze(str(target), [], resolver)
            findings = [f.render() for d in docs for f in d.findings]
            self.assertEqual(findings, [])

            nodes, edges = tropo.build_graph(docs)
            self.assertIn("docs", nodes, "the docs/ candidate module router must be a real graph node")
            self.assertTrue(all(not e["broken"] for e in edges))
        finally:
            shutil.rmtree(target)

    def test_yes_depth_two_candidate_module_flattens_and_is_a_graph_node(self):
        target = temp_dir()
        try:
            write(target / "README.md", "# repo\n")
            for i in range(6):
                write(target / "docs" / "guides" / f"g{i}.md", f"# guide {i}\n")
            write(target / "src" / "main.py", "print(1)\n")

            create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            docs = tropo.analyze(str(target), [], resolver)
            self.assertEqual([f.render() for d in docs for f in d.findings], [])
            nodes, edges = tropo.build_graph(docs)
            self.assertIn("docs-guides", nodes)
            self.assertTrue(all(not e["broken"] for e in edges))
            self.assertTrue((target / "modules" / "docs-guides" / "index.md").exists())
        finally:
            shutil.rmtree(target)

    def test_yes_does_not_overwrite_existing_agents_md(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            write(target / "AGENTS.md", "pre-existing contract\n")

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertEqual((target / "AGENTS.md").read_text(encoding="utf-8"), "pre-existing contract\n")
            kept_rel = {p.relative_to(target).as_posix() for p in result["kept"]}
            self.assertIn("AGENTS.md", kept_rel)
        finally:
            shutil.rmtree(target)

    def test_yes_leaves_existing_gitignore_untouched_with_followups(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            write(target / ".gitignore", "node_modules/\n")

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            self.assertEqual((target / ".gitignore").read_text(encoding="utf-8"), "node_modules/\n")
            self.assertTrue(result["followups"])
            # doctor legitimately fails here: the human hasn't added the privacy
            # lines yet. That's the point of surfacing followups instead of
            # silently editing the file.
            self.assertFalse(result["doctor"]["ok"])
            self.assertTrue(
                any("privacy ignore missing" in e for e in result["doctor"]["errors"])
            )
        finally:
            shutil.rmtree(target)

    def test_cli_yes_mode_json(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)

            rc, out = run_cli(["adopt", str(target), "--repo-root", str(ROOT), "--yes", "--json"])

            self.assertEqual(rc, 0)
            payload = json.loads(out)
            self.assertEqual(payload["mode"], "applied")
            self.assertTrue(payload["ok"])
            self.assertIn("doctor", payload)
            self.assertTrue(payload["doctor"]["ok"])
            self.assertIn("modules/docs/index.md", payload["would_create"])
        finally:
            shutil.rmtree(target)

    def test_cli_dry_run_json_shape(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)

            rc, out = run_cli(["adopt", str(target), "--repo-root", str(ROOT), "--json"])

            self.assertEqual(rc, 0)
            payload = json.loads(out)
            self.assertEqual(payload["mode"], "dry-run")
            self.assertNotIn("doctor", payload)
            for key in (
                "would_create", "kept", "followups", "preset", "preset_reason",
                "skipped_module_collisions",
            ):
                self.assertIn(key, payload)
        finally:
            shutil.rmtree(target)

    def test_candidate_module_colliding_with_scaffold_module_name_is_skipped(self):
        """A brownfield top-level dir named after a preset's own starter module
        (e.g. `codebase/` under the `coding` preset) must not get a router that
        clobbers the scaffold's typed starter module doc for that same path."""
        target = temp_dir()
        try:
            write(target / "README.md", "# repo\n")
            for i in range(6):
                write(target / "codebase" / f"c{i}.md", f"# c{i}\n")
            write(target / "src" / "main.py", "print(1)\n")

            plan = create_vivary.plan_adopt(target, preset="coding", repo_root=ROOT)
            self.assertIn("codebase", plan["skipped_module_collisions"])

            result = create_vivary.adopt_workspace(target, preset="coding", repo_root=ROOT, yes=True)

            self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
            module_doc = (target / "modules" / "codebase" / "index.md").read_text(encoding="utf-8")
            self.assertIn("Code, docs, tests, and release gates", module_doc)
            self.assertNotIn("Router for the existing", module_doc)

            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            docs = tropo.analyze(str(target), [], resolver)
            self.assertEqual([f.render() for d in docs for f in d.findings], [])
            nodes, edges = tropo.build_graph(docs)
            self.assertIn("local-ci-baseline", nodes)
            related = {e["to"] for e in edges if e["from"] == "codebase"}
            self.assertIn("local-ci-baseline", related)
        finally:
            shutil.rmtree(target)

    def test_two_candidates_flattening_to_same_module_id_do_not_clobber_each_other(self):
        """A top-level `docs-guides/` and a nested `docs/guides/` both flatten to
        module id `docs-guides`. Only the first router write should land; the
        second must be reported as skipped, not silently overwrite the first."""
        target = temp_dir()
        try:
            write(target / "README.md", "# repo\n")
            for i in range(6):
                write(target / "docs" / "guides" / f"g{i}.md", f"# guide {i}\n")
                write(target / "docs-guides" / f"h{i}.md", f"# h{i}\n")
            write(target / "src" / "main.py", "print(1)\n")

            plan = create_vivary.plan_adopt(target, repo_root=ROOT)
            router_writes = [
                dst for dst, _ in plan["writes"]
                if dst == target / "modules" / "docs-guides" / "index.md"
            ]
            self.assertEqual(len(router_writes), 1, "only one router write should be planned")
            self.assertEqual(len(plan["skipped_module_collisions"]), 1)

            result = create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)
            self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
        finally:
            shutil.rmtree(target)

    def test_second_adopt_run_reports_everything_kept(self):
        target = temp_dir()
        try:
            make_brownfield_fixture(target)
            create_vivary.adopt_workspace(target, repo_root=ROOT, yes=True)

            second = create_vivary.plan_adopt(target, repo_root=ROOT)

            self.assertEqual(second["would_create"], [])
        finally:
            shutil.rmtree(target)


if __name__ == "__main__":
    unittest.main()
