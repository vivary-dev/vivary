#!/usr/bin/env python3
"""Regression tests for key.py: stale origin/dev and evidence-path confinement."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY_PY = HERE / "key.py"
KEY_PATH = ".claude/skills/verify/acceptance.md"
FEATURES_README_PATH = ".claude/skills/verify/features/README.md"
FEATURE_FILE_PATH = ".claude/skills/verify/features/demo-feature.md"


def run(cmd, cwd, env=None, check=True):
    result = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError(f"{cmd} failed in {cwd}: {result.stdout}\n{result.stderr}")
    return result


def git(args, cwd):
    return run(["git", *args], cwd=cwd)


def init_origin_with_key(origin_dir, content):
    origin_dir.mkdir(parents=True)
    git(["init", "--quiet", "-b", "dev"], origin_dir)
    git(["config", "user.email", "test@example.com"], origin_dir)
    git(["config", "user.name", "Test"], origin_dir)
    key_file = origin_dir / KEY_PATH
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_text(content)
    readme_file = origin_dir / FEATURES_README_PATH
    readme_file.parent.mkdir(parents=True, exist_ok=True)
    readme_file.write_text(
        "# Workbench feature map\n\n"
        "| Feature | Journey |\n"
        "| --- | --- |\n"
        "| [Demo feature](demo-feature.md) | A single synthetic journey |\n"
    )
    feature_file = origin_dir / FEATURE_FILE_PATH
    feature_file.write_text("# Demo feature\n\nSynthetic journey for key.py tests.\n")
    git(["add", "-A"], origin_dir)
    git(["commit", "--quiet", "-m", "key"], origin_dir)


def set_key_and_commit(repo_dir, content):
    key_file = repo_dir / KEY_PATH
    key_file.write_text(content)
    git(["add", "-A"], repo_dir)
    git(["commit", "--quiet", "-m", "update key"], repo_dir)


class KeyPyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="key-py-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.origin = self.tmp / "origin"
        init_origin_with_key(self.origin, "v1 content\n")

    def make_candidate(self, narrow_refspec=True):
        candidate = self.tmp / "candidate"
        candidate.mkdir()
        git(["init", "--quiet"], candidate)
        git(["config", "user.email", "test@example.com"], candidate)
        git(["config", "user.name", "Test"], candidate)
        git(["remote", "add", "origin", str(self.origin)], candidate)
        if narrow_refspec:
            # Mirrors a typical CI checkout action: only the candidate's own
            # ref is mapped, so a later `git fetch origin dev` never touches
            # refs/remotes/origin/dev.
            git(["config", "remote.origin.fetch",
                 "+refs/heads/candidate:refs/remotes/origin/candidate"], candidate)
        git(["fetch", "--quiet", "origin", "dev"], candidate)
        git(["checkout", "--quiet", "-b", "candidate", "FETCH_HEAD"], candidate)
        return candidate

    def run_key_py(self, candidate, evidence, env_overrides=None):
        env = dict(os.environ)
        if env_overrides:
            env.update(env_overrides)
        return run([sys.executable, str(KEY_PY), str(evidence)], cwd=candidate,
                    env=env, check=False)

    def test_stale_origin_dev_ref_no_longer_silently_admitted(self):
        """QA finding / discussion_r4503593102: a stale refs/remotes/origin/dev
        must not be trusted once dev has moved. candidate keeps v1; a narrow
        refspec means `git fetch origin dev` never updates origin/dev, only
        FETCH_HEAD. Admission must follow FETCH_HEAD, so it must now FAIL
        (candidate's v1 no longer matches real dev's v2), not silently pass
        against a cached v1 origin/dev ref that this fetch never refreshed."""
        candidate = self.make_candidate(narrow_refspec=True)
        # Establish a stale origin/dev tracking ref, as an earlier full fetch
        # or a previous job's checkout might have left behind.
        git(["update-ref", "refs/remotes/origin/dev", "FETCH_HEAD"], candidate)
        self.assertEqual(
            git(["rev-parse", "origin/dev"], candidate).stdout.strip(),
            git(["rev-parse", "FETCH_HEAD"], candidate).stdout.strip(),
        )
        # Real dev moves to v2; candidate's own commit stays at v1.
        set_key_and_commit(self.origin, "v2 content\n")
        stale_sha = git(["rev-parse", "origin/dev"], candidate).stdout.strip()
        real_dev_sha = git(["rev-parse", "dev"], self.origin).stdout.strip()
        self.assertNotEqual(stale_sha, real_dev_sha)

        evidence = self.tmp_evidence_dir()
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(self.tmp)})
        self.assertNotEqual(
            result.returncode, 0,
            "key.py admitted the candidate: it is trusting a stale origin/dev "
            "ref instead of the commit git fetch actually wrote",
        )
        # Confirm origin/dev itself is still the same stale value: the fetch
        # inside key.py, under this narrow refspec, never refreshes it either.
        self.assertEqual(
            git(["rev-parse", "origin/dev"], candidate).stdout.strip(), stale_sha,
        )

    def test_matching_key_still_admits_under_narrow_refspec(self):
        """Control case: when the candidate's committed key genuinely matches
        the real current dev, admission must still succeed under the same
        narrow-refspec checkout (the fix must not just make everything fail)."""
        candidate = self.make_candidate(narrow_refspec=True)
        evidence = self.tmp_evidence_dir()
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(self.tmp)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((evidence / "key-receipt.json").exists())

    def test_evidence_outside_temp_dir_is_refused(self):
        """New confinement check: an evidence directory outside the system
        temp directory (as scoped by TMPDIR) must be refused, even if it is
        also outside the checkout."""
        candidate = self.make_candidate(narrow_refspec=False)
        allowed_temp = self.tmp / "allowed-temp"
        allowed_temp.mkdir()
        not_temp = self.tmp / "not-temp-sibling" / "evidence"
        result = self.run_key_py(candidate, not_temp, env_overrides={"TMPDIR": str(allowed_temp)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("temp", (result.stdout + result.stderr).lower())
        self.assertFalse(not_temp.exists())

    def test_evidence_under_temp_dir_is_accepted(self):
        candidate = self.make_candidate(narrow_refspec=False)
        allowed_temp = self.tmp / "allowed-temp2"
        allowed_temp.mkdir()
        evidence = allowed_temp / "vivary-proof-case"
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(allowed_temp)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_feature_file_missing_from_map_is_refused(self):
        """discussion_r4503940604: a global .claude/ ignore rule can hide a
        new verify feature file from git status, so it never gets tracked.
        key.py must fail closed if features/README.md maps a file that the
        candidate does not actually have tracked, not silently admit it."""
        candidate = self.make_candidate(narrow_refspec=False)
        git(["rm", "--quiet", FEATURE_FILE_PATH], candidate)
        git(["commit", "--quiet", "-m", "drop the feature file, keep the map"], candidate)
        evidence = self.tmp_evidence_dir()
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(self.tmp)})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("demo-feature.md", (result.stdout + result.stderr))

    def test_feature_file_present_and_tracked_is_accepted(self):
        candidate = self.make_candidate(narrow_refspec=False)
        evidence = self.tmp_evidence_dir()
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(self.tmp)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_empty_mapped_feature_is_refused(self):
        """discussion_r4504017314: a tracked but empty (or
        whitespace-only) mapped feature file must not admit, even though
        it is correctly tracked and mapped. An empty feature file carries
        no reviewed expectations for the browser driver to follow."""
        candidate = self.make_candidate(narrow_refspec=False)
        feature = candidate / FEATURE_FILE_PATH
        feature.write_text("   \n\t\n")
        git(["add", "-A"], candidate)
        git(["commit", "--quiet", "-m", "empty the tracked mapped feature"], candidate)
        evidence = self.tmp_evidence_dir()
        result = self.run_key_py(candidate, evidence, env_overrides={"TMPDIR": str(self.tmp)})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("empty", (result.stdout + result.stderr).lower())
        self.assertFalse((evidence / "key-receipt.json").exists())

    def tmp_evidence_dir(self):
        return self.tmp / f"evidence-{len(list(self.tmp.iterdir()))}"


GITIGNORE_PATH = HERE.parents[2] / ".gitignore"


class GitignoreTests(unittest.TestCase):
    """discussion_r4504017192: the verify re-inclusion must stay
    anchored and narrow, so a global `.claude/` ignore rule is overridden
    only for this skill's own tracked files, not for generated bytecode
    or unrelated local settings anywhere else under .claude/."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="verify-gitignore-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(["init", "--quiet"], self.repo)
        (self.repo / ".gitignore").write_bytes(GITIGNORE_PATH.read_bytes())
        self.global_ignore = self.tmp / "global-ignore"
        self.global_ignore.write_text(".claude/\n")
        git(["config", "core.excludesFile", str(self.global_ignore)], self.repo)

    def is_ignored(self, rel_path):
        full = self.repo / rel_path
        full.parent.mkdir(parents=True, exist_ok=True)
        if not full.exists():
            full.write_text("x\n")
        result = run(["git", "check-ignore", "--quiet", rel_path], cwd=self.repo, check=False)
        return result.returncode == 0

    def test_new_feature_file_stays_visible(self):
        self.assertFalse(self.is_ignored(".claude/skills/verify/features/new-feature.md"))

    def test_known_tracked_file_stays_visible(self):
        self.assertFalse(self.is_ignored(".claude/skills/verify/key.py"))

    def test_generated_bytecode_stays_ignored(self):
        self.assertTrue(self.is_ignored(".claude/skills/verify/__pycache__/test_key.cpython-314.pyc"))

    def test_local_settings_under_claude_stay_ignored(self):
        self.assertTrue(self.is_ignored(".claude/settings.local.json"))

    def test_unrelated_nested_claude_dir_stays_ignored(self):
        """The fix must be anchored to the repo root, not match .claude/
        at any depth, so an unrelated nested checkout (for example
        packages/probe/.claude/) keeps its own local settings hidden."""
        self.assertTrue(self.is_ignored("packages/probe/.claude/settings.local.json"))


if __name__ == "__main__":
    unittest.main()
