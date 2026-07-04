"""Verifiability checks for the strato layer as consumed at scaffold time.

Covers P1.7 "strato as a verifiable agent OS": every preset must scaffold to a
workspace that doctors clean and tropo-checks clean, every relative Markdown
cross-reference in generated content must resolve, the canonical strato
surface must be present per preset, and the .claude/.agents skill runtimes
must stay structurally in lockstep (file-name parity, not content — the
loops skill content is intentionally out of scope here, see SKIP_LIST notes).
"""

import re
import shutil
import sys
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

PRESETS = ("coding", "second-brain", "knowledge-work", "writing")

# Known-intentional dead links, reported (not silently skipped) by
# test_markdown_cross_references_resolve. Format: "relative/path.md -> target".
# Empty: no known-intentional dead links have been found in generated content
# as of this writing (see report for the probe that established this).
KNOWN_DEAD_LINKS: set[str] = set()

LINK_PATTERN = re.compile(r"\]\(([^)]+)\)")


@contextmanager
def temp_workspace():
    path = ROOT / "sandboxes" / f"test-strato-integrity-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _extract_link_targets(text: str) -> list[str]:
    """Pull relative Markdown link targets out of `text`, skipping fenced
    code blocks (doc examples aren't real links) and non-relative targets."""
    # Strip fenced code blocks (``` ... ```) so example syntax isn't checked.
    without_fences = re.sub(r"```.*?```", "", text, flags=re.DOTALL)

    targets = []
    for match in LINK_PATTERN.finditer(without_fences):
        target = match.group(1).strip()
        if not target:
            continue
        # Strip an optional "title" suffix: ](path "title")
        if " " in target:
            target = target.split(" ", 1)[0]
        if target.startswith("#"):
            continue  # in-page anchor only
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        # Strip a trailing #fragment from a same-file/relative link.
        target = target.split("#", 1)[0]
        if not target:
            continue
        targets.append(target)
    return targets


def _scaffold(preset: str, target: Path) -> None:
    create_vivary.scaffold_workspace(
        target,
        preset=preset,
        force=False,
        storage="file",  # avoid any real backend install during smoke tests
        repo_root=ROOT,
    )


class ScaffoldSmokeTests(unittest.TestCase):
    """1a: every preset scaffolds to a workspace that doctors and tropo-checks clean."""

    def test_every_preset_scaffolds_clean(self):
        for preset in PRESETS:
            with self.subTest(preset=preset), temp_workspace() as td:
                target = Path(td) / f"{preset}-workspace"

                rc = create_vivary.main(
                    [
                        "init",
                        str(target),
                        "--preset",
                        preset,
                        "--auto",
                        "--yes",
                        "--storage",
                        "file",
                        "--repo-root",
                        str(ROOT),
                    ]
                )
                self.assertEqual(rc, 0, f"init failed for preset={preset}")

                report = create_vivary.doctor_workspace(target, repo_root=ROOT)
                self.assertTrue(report["ok"], f"doctor not ok for preset={preset}: {report}")
                self.assertEqual(
                    report["errors"], [], f"doctor errors for preset={preset}: {report['errors']}"
                )

                # tropo check is strict by default (warnings fail too, see
                # cmd_check in tropo.py) — mirror that here rather than only
                # filtering to level == "error", so this assertion is a real,
                # independent gate rather than one doctor_workspace already covers.
                resolver = tropo.ConfigResolver(str(target), str(TROPO))
                docs = tropo.analyze(str(target), [], resolver)
                findings = [f.render() for d in docs for f in d.findings]
                self.assertEqual(
                    findings, [], f"tropo check found findings for preset={preset}: {findings}"
                )


class CrossReferenceIntegrityTests(unittest.TestCase):
    """1b: every relative Markdown link in generated content must resolve."""

    def test_markdown_cross_references_resolve(self):
        broken: list[str] = []
        reported_known: list[str] = []

        for preset in PRESETS:
            with temp_workspace() as td:
                target = Path(td) / f"{preset}-workspace"
                _scaffold(preset, target)

                for md_file in sorted(target.rglob("*.md")):
                    rel = md_file.relative_to(target).as_posix()
                    text = md_file.read_text(encoding="utf-8", errors="replace")
                    for link_target in _extract_link_targets(text):
                        # Directory-style links (trailing slash) check dir existence.
                        candidate = (md_file.parent / link_target).resolve()
                        exists = candidate.exists()
                        if not exists:
                            key = f"{rel} -> {link_target}"
                            if key in KNOWN_DEAD_LINKS or f"{preset}:{key}" in KNOWN_DEAD_LINKS:
                                reported_known.append(f"[{preset}] {key}")
                                continue
                            broken.append(f"[{preset}] {key}")

        if reported_known:
            print(
                "\nknown-intentional dead links (skip-listed):\n  "
                + "\n  ".join(sorted(set(reported_known)))
            )

        self.assertEqual(
            broken,
            [],
            "broken relative Markdown links found in generated content:\n  "
            + "\n  ".join(sorted(set(broken))),
        )


class StratoSurfaceCompletenessTests(unittest.TestCase):
    """1c: canonical strato files/dirs exist for every preset."""

    CANONICAL_FILES = (
        "AGENTS.md",
        "STATE.md",
        "SOUL.md",
        "USER.md",
        "MEMORY.md",
        "STRATO.md",
        ".gitignore",
        "tropo.toml",
        "modules/index.md",
    )
    CANONICAL_DIRS = (
        ".claude/skills/strato",
        ".agents/skills/strato",
    )

    def test_canonical_strato_surface_exists_per_preset(self):
        for preset in PRESETS:
            with self.subTest(preset=preset), temp_workspace() as td:
                target = Path(td) / f"{preset}-workspace"
                _scaffold(preset, target)

                missing_files = [
                    rel for rel in self.CANONICAL_FILES if not (target / rel).is_file()
                ]
                self.assertEqual(
                    missing_files, [], f"preset={preset} missing files: {missing_files}"
                )

                missing_dirs = [
                    rel for rel in self.CANONICAL_DIRS if not (target / rel).is_dir()
                ]
                self.assertEqual(
                    missing_dirs, [], f"preset={preset} missing dirs: {missing_dirs}"
                )

                gitignore = (target / ".gitignore").read_text(encoding="utf-8")
                for pattern in ("USER.md", "MEMORY.md", "memory/*", "heartbeat-reports/*"):
                    self.assertIn(
                        pattern,
                        gitignore,
                        f"preset={preset} .gitignore missing coverage for {pattern}",
                    )


class RuntimeParityTests(unittest.TestCase):
    """1d: .claude/skills and .agents/skills stay structurally in lockstep.

    Structural only (directory names + file names within each directory) —
    NOT content equality. The loops skill content is being edited in a
    parallel session; asserting exact byte/content parity there would
    conflict with that in-flight fix.
    """

    def test_claude_and_agents_skills_have_matching_structure(self):
        for preset in PRESETS:
            with self.subTest(preset=preset), temp_workspace() as td:
                target = Path(td) / f"{preset}-workspace"
                _scaffold(preset, target)

                claude_skills = target / ".claude" / "skills"
                agents_skills = target / ".agents" / "skills"
                self.assertTrue(claude_skills.is_dir(), f"preset={preset} missing .claude/skills")
                self.assertTrue(agents_skills.is_dir(), f"preset={preset} missing .agents/skills")

                claude_names = {p.name for p in claude_skills.iterdir() if p.is_dir()}
                agents_names = {p.name for p in agents_skills.iterdir() if p.is_dir()}
                self.assertEqual(
                    claude_names,
                    agents_names,
                    f"preset={preset} skill directory sets differ: "
                    f"claude-only={claude_names - agents_names}, "
                    f"agents-only={agents_names - claude_names}",
                )

                for skill_name in sorted(claude_names):
                    claude_dir = claude_skills / skill_name
                    agents_dir = agents_skills / skill_name
                    claude_files = {
                        p.relative_to(claude_dir).as_posix()
                        for p in claude_dir.rglob("*") if p.is_file()
                    }
                    agents_files = {
                        p.relative_to(agents_dir).as_posix()
                        for p in agents_dir.rglob("*") if p.is_file()
                    }
                    self.assertEqual(
                        claude_files,
                        agents_files,
                        f"preset={preset} skill={skill_name} file-name sets differ: "
                        f"claude-only={claude_files - agents_files}, "
                        f"agents-only={agents_files - claude_files}",
                    )


if __name__ == "__main__":
    unittest.main()
