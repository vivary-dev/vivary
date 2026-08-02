"""Pytest translation of tests/topology.test.mjs (slice 2, ticket #84/#88,
decision 0008) - the hostile git topology suite (#62/#67).

The observation layer promises: observe read-only, refuse cleanly,
structured unknowns, never throw, never crawl, never write. This file
throws bare repos, submodules, nested worktrees, symlinks, unborn branches,
and unicode refs at observe.mjs's/content.mjs's/model.mjs's Python ports and
pins exactly what holds.

workspace_content.py (observeContent) and workspace_model.py
(projectWorkspaceGraph) now both live in python/vivary_core/, so every Node
test that calls observeContent/projectWorkspaceGraph is wired for real below.
Two of the MAX_EXCERPT_LENGTH surrogate-repair tests remain skipped: see
CONTENT_TOWELLFORMED_GAP below for the genuine module-behavior divergence
they exposed (workspace_content.py's `_js_utf16_slice_wellformed` only
repairs a surrogate straddling the cut boundary, not every lone surrogate in
the retained string the way JS's `String#toWellFormed` does) - reported, not
fixed here, since content.mjs/workspace_content.py's byte-level behavior is
outside this packet's five owned test files.

Fixture builder mirrors tests/helpers/fixtures.mjs's buildTopologyFixtures
exactly (same pinned identity/dates/config isolation, same best-effort
symlink/junction construction with a capabilities map), re-expressed as a
local module-scoped pytest fixture per the same pattern
python/tests/test_evidence.py and python/tests/test_observe.py use.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from test_support import content_git_runner  # noqa: E402

from vivary_core.canonical import normalize_path  # noqa: E402
import vivary_core.workspace_observe as workspace_observe_module  # noqa: E402
from vivary_core.workspace_content import MAX_EXCERPT_LENGTH, observe_content  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402
from vivary_core.workspace_observe import (  # noqa: E402
    AMBIENT_GIT_ENV_KEYS,
    observe_checkouts,
)



def NOW():
    return "2026-07-22T00:00:00.000Z"


FIXED_DATE = "2026-07-01T12:00:00Z"

# The toWellFormed divergence once documented here (content.mjs repairs
# EVERY lone surrogate in the retained excerpt, not just a cut-straddling
# pair) was fixed in workspace_content.py (_to_well_formed) during Fable
# review; the two surrogate tests below now run against the fixed module.


# --- fixture plumbing (mirrors tests/helpers/fixtures.mjs's hostile-topology
# section) ---------------------------------------------------------------


def _rmtree_force(path):
    # On Windows, git object files are read-only and a plain rmtree fails on
    # them (ignore_errors=True would silently LEAK the temp repo instead) -
    # clear the read-only bit and retry, then fail loudly if still stuck.
    def _on_error(func, target, exc_info):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if os.path.isdir(path):
        shutil.rmtree(path, onerror=_on_error)


def _git_env(base_dir):
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": "Lattice Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@lattice.local",
            "GIT_COMMITTER_NAME": "Lattice Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@lattice.local",
            "GIT_AUTHOR_DATE": FIXED_DATE,
            "GIT_COMMITTER_DATE": FIXED_DATE,
            "GIT_CONFIG_GLOBAL": os.path.join(base_dir, "empty-gitconfig"),
            "GIT_CONFIG_SYSTEM": os.path.join(base_dir, "empty-gitconfig"),
        }
    )
    return env


def _git(base_dir, cwd, args):
    proc = subprocess.run(
        ["git", *args], cwd=cwd, env=_git_env(base_dir), capture_output=True, text=True, check=True
    )
    return proc.stdout.strip()


def _commit_file(base_dir, repo, file_name, content, message):
    with open(os.path.join(repo, file_name), "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    _git(base_dir, repo, ["add", file_name])
    _git(base_dir, repo, ["commit", "-q", "-m", message])
    return _git(base_dir, repo, ["rev-parse", "HEAD"])


def _try_link_directory(target, link_path):
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", link_path, target],
                capture_output=True,
                check=True,
            )
        else:
            os.symlink(target, link_path, target_is_directory=True)
        return True
    except Exception:
        return False


def _try_link_file(target, link_path):
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["cmd", "/c", "mklink", link_path, target],
                capture_output=True,
                check=True,
            )
        else:
            os.symlink(target, link_path)
        return True
    except Exception:
        return False


def build_topology_fixtures(base_dir):
    """Port of tests/helpers/fixtures.mjs's buildTopologyFixtures."""
    with open(os.path.join(base_dir, "empty-gitconfig"), "w", encoding="utf-8") as handle:
        handle.write("")

    paths = {
        "base": base_dir,
        "bare_source": os.path.join(base_dir, "bare-source"),
        "bare": os.path.join(base_dir, "bare.git"),
        "submodule_child": os.path.join(base_dir, "submodule-child"),
        "submodule_parent": os.path.join(base_dir, "submodule-parent"),
        "submodule_uninitialized_clone": os.path.join(base_dir, "submodule-uninitialized-clone"),
        "worktree_main": os.path.join(base_dir, "worktree-main"),
        "worktree_linked": os.path.join(base_dir, "worktree-linked"),
        "unborn": os.path.join(base_dir, "unborn"),
        "unicode_repo": os.path.join(base_dir, "unicode-repo"),
        "crlf_repo": os.path.join(base_dir, "crlf-repo"),
        "symlink_target": os.path.join(base_dir, "symlink-target-repo"),
        "symlink_root": os.path.join(base_dir, "symlink-root"),
        "allowed_root": os.path.join(base_dir, "allowed-root"),
        "secret_elsewhere": os.path.join(base_dir, "secret-elsewhere"),
        "secret_link_under_allowed": os.path.join(base_dir, "allowed-root", "secret-link"),
        "symlink_inside_repo": os.path.join(base_dir, "symlink-inside-repo"),
        "outside_secret_file": os.path.join(base_dir, "outside-secret.txt"),
        "symlink_inside_link": os.path.join(base_dir, "symlink-inside-repo", "link-to-outside.txt"),
        # A guaranteed-empty, guaranteed-not-a-git-repository directory - used
        # to reproduce the ambient GIT_DIR hazard without depending on any
        # platform-specific "known non-repo" path.
        "plain_non_repo_dir": os.path.join(base_dir, "plain-non-repo-dir"),
    }

    # Bare repo: a real clone with real history, never a working tree.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["bare_source"]])
    bare_sha = _commit_file(base_dir, paths["bare_source"], "seed.md", "seed\n", "seed")
    _git(base_dir, base_dir, ["clone", "-q", "--bare", paths["bare_source"], paths["bare"]])
    os.makedirs(paths["plain_non_repo_dir"], exist_ok=True)

    # Submodule: an initialized child (own gitdir-file worktree under the
    # parent's .git/modules/) plus a fresh clone of the same parent that was
    # never told to recurse, leaving its submodule directory an empty,
    # tracked-but-uninitialized placeholder.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["submodule_child"]])
    submodule_child_sha = _commit_file(base_dir, paths["submodule_child"], "child.md", "child\n", "child init")
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["submodule_parent"]])
    _commit_file(base_dir, paths["submodule_parent"], "parent.md", "parent\n", "parent init")
    _git(
        base_dir,
        paths["submodule_parent"],
        ["-c", "protocol.file.allow=always", "submodule", "-q", "add", paths["submodule_child"], "child"],
    )
    _git(base_dir, paths["submodule_parent"], ["commit", "-q", "-m", "add submodule"])
    _git(
        base_dir,
        base_dir,
        [
            "-c",
            "protocol.file.allow=always",
            "clone",
            "-q",
            paths["submodule_parent"],
            paths["submodule_uninitialized_clone"],
        ],
    )

    # A git-worktree checkout of another fixture repo: main plus one linked
    # worktree whose .git is a file pointing back at the main gitdir.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["worktree_main"]])
    worktree_sha = _commit_file(base_dir, paths["worktree_main"], "wt.md", "wt\n", "wt init")
    _git(base_dir, paths["worktree_main"], ["remote", "add", "origin", "https://example.invalid/worktree.git"])
    _git(base_dir, paths["worktree_main"], ["worktree", "add", "-q", "-b", "wt-feature", paths["worktree_linked"]])

    # Unborn branch: a fresh init with zero commits.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["unborn"]])

    # Unicode branch name + unicode remote name.
    _git(base_dir, base_dir, ["init", "-q", "-b", "función-Ω", paths["unicode_repo"]])
    unicode_sha = _commit_file(base_dir, paths["unicode_repo"], "u.md", "u\n", "unicode init")
    _git(base_dir, paths["unicode_repo"], ["remote", "add", "börse-源", "https://example.invalid/unicode.git"])

    # A tracked file whose line endings are CRLF, committed byte-for-byte
    # (core.autocrlf=false) so a content match lands on a genuine CRLF line.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["crlf_repo"]])
    with open(os.path.join(paths["crlf_repo"], "crlf.md"), "w", encoding="utf-8", newline="") as handle:
        handle.write("before\r\nneedle-crlf here\r\nafter\r\n")
    _git(base_dir, paths["crlf_repo"], ["add", "crlf.md"])
    _git(base_dir, paths["crlf_repo"], ["-c", "core.autocrlf=false", "commit", "-q", "-m", "crlf"])
    crlf_sha = _git(base_dir, paths["crlf_repo"], ["rev-parse", "HEAD"])

    # Symlinked root: the checkout path itself is a symlink/junction pointing
    # at a real repository elsewhere. Best-effort; capability flag records
    # whether the link actually got built on this platform.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["symlink_target"]])
    symlink_target_sha = _commit_file(base_dir, paths["symlink_target"], "s.md", "s\n", "symlink target init")
    symlink_root_built = _try_link_directory(paths["symlink_target"], paths["symlink_root"])

    # Allowlist-escape trap: an allowlisted directory containing a symlink to
    # a repository that was never allowlisted.
    os.makedirs(paths["allowed_root"], exist_ok=True)
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["secret_elsewhere"]])
    secret_elsewhere_sha = _commit_file(
        base_dir, paths["secret_elsewhere"], "secret.md", "SECRET_REPO_CONTENT\n", "secret init"
    )
    secret_link_built = _try_link_directory(paths["secret_elsewhere"], paths["secret_link_under_allowed"])

    # Symlink inside the tree: a tracked symlink (git blob mode 120000)
    # pointing at a file outside the repo. `git grep` must never dereference
    # it - the blob content is the target path string, not the target's bytes.
    with open(paths["outside_secret_file"], "w", encoding="utf-8", newline="") as handle:
        handle.write("OUTSIDE_SECRET_MARKER needle\n")
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["symlink_inside_repo"]])
    _git(base_dir, paths["symlink_inside_repo"], ["config", "core.symlinks", "true"])
    with open(os.path.join(paths["symlink_inside_repo"], "normal.md"), "w", encoding="utf-8", newline="") as handle:
        handle.write("normal\n")
    symlink_inside_built = _try_link_file(paths["outside_secret_file"], paths["symlink_inside_link"])
    _git(base_dir, paths["symlink_inside_repo"], ["add", "-A"])
    _git(base_dir, paths["symlink_inside_repo"], ["commit", "-q", "-m", "symlink inside tree"])

    return {
        "paths": paths,
        "shas": {
            "bare_sha": bare_sha,
            "submodule_child_sha": submodule_child_sha,
            "worktree_sha": worktree_sha,
            "unicode_sha": unicode_sha,
            "symlink_target_sha": symlink_target_sha,
            "secret_elsewhere_sha": secret_elsewhere_sha,
            "crlf_sha": crlf_sha,
        },
        "capabilities": {
            "symlink_root_built": symlink_root_built,
            "secret_link_built": secret_link_built,
            "symlink_inside_built": symlink_inside_built,
        },
    }


def hash_tree(root):
    files = []

    def walk(dir_, rel):
        for entry in sorted(os.scandir(dir_), key=lambda e: e.name):
            abs_path = os.path.join(dir_, entry.name)
            rel_path = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir():
                walk(abs_path, rel_path)
            else:
                with open(abs_path, "rb") as handle:
                    files.append((rel_path, handle.read()))

    walk(root, "")
    digest = hashlib.sha256()
    for rel_path, content in files:
        digest.update(rel_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    return digest.hexdigest()


@pytest.fixture(scope="module")
def fx():
    fixture_base = os.path.realpath(tempfile.mkdtemp(prefix="vivary-topology-fixtures-"))
    try:
        yield build_topology_fixtures(fixture_base)
    finally:
        _rmtree_force(fixture_base)


# --- Read-only proof across every shape -------------------------------------


def test_observing_every_hostile_shape_at_once_never_throws_git_trees_byte_identical(fx):
    p = fx["paths"]
    git_targets = [
        fx["paths"]["bare"],  # bare repo IS its own git-dir
        os.path.join(p["submodule_parent"], ".git"),
        os.path.join(p["worktree_main"], ".git"),
        os.path.join(p["unborn"], ".git"),
        os.path.join(p["unicode_repo"], ".git"),
        os.path.join(p["crlf_repo"], ".git"),
    ]
    before = [hash_tree(t) for t in git_targets]

    allowlist = [
        p["bare"],
        p["submodule_parent"],
        os.path.join(p["submodule_parent"], "child"),
        p["submodule_uninitialized_clone"],
        p["worktree_main"],
        p["worktree_linked"],
        p["unborn"],
        p["unicode_repo"],
        p["crlf_repo"],
        p["symlink_inside_repo"],
    ]
    result = observe_checkouts(
        [
            p["bare"],
            p["submodule_parent"],
            os.path.join(p["submodule_parent"], "child"),
            os.path.join(p["submodule_uninitialized_clone"], "child"),
            p["worktree_main"],
            p["worktree_linked"],
            p["unborn"],
            p["unicode_repo"],
            p["crlf_repo"],
            p["symlink_inside_repo"],
        ],
        allowlist=allowlist,
        now=NOW,
    )
    assert len(result["checkouts"]) == 10, "no shape refused, none threw"

    after = [hash_tree(t) for t in git_targets]
    assert after == before, ".git trees must be byte-identical before and after observation"


# --- Bare repository ---------------------------------------------------------


def test_bare_repository_honestly_reported_not_conflated_with_not_a_repository(fx):
    result = observe_checkouts([fx["paths"]["bare"]], allowlist=[fx["paths"]["bare"]], now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["status"] == "known"
    assert f["is_git_repository"]["value"] is True
    assert f["worktree_root"]["status"] == "unknown"
    assert f["worktree_root"]["reason"] == "bare_repository_has_no_worktree"
    assert f["head_revision"]["status"] == "known"
    assert f["head_revision"]["value"] == fx["shas"]["bare_sha"]
    assert f["dirty_entries"]["status"] == "unknown"
    assert f["dirty_entries"]["reason"] == "status_unavailable"


def test_model_mjs_bare_repository_projects_as_full_graph(fx):
    observation = observe_checkouts([fx["paths"]["bare"]], allowlist=[fx["paths"]["bare"]], now=NOW)
    graph = project_workspace_graph(observation)
    assert sorted(n["kind"] for n in graph["nodes"]) == ["branch", "checkout", "remote", "repository", "revision"]
    worktree_unknown = next((u for u in graph["unknowns"] if u["fact"] == "worktree_root"), None)
    assert worktree_unknown is not None, "worktree_root must survive projection as an explicit unknown"
    assert worktree_unknown["reason"] == "bare_repository_has_no_worktree"


def test_content_mjs_content_search_in_a_bare_repository_is_structured_unknown(fx):
    result = observe_content([fx["paths"]["bare"]], allowlist=[fx["paths"]["bare"]], terms=["seed"], now=NOW)
    checkout = result["checkouts"][0]
    assert checkout["status"] == "unknown"
    assert checkout["reason"] == "ignore_policy_unavailable"
    assert checkout["matches"] == []


# --- Ambient GIT_DIR must not misclassify a non-repository as bare -----------


def test_git_dir_guard_mocked_seam_not_misclassified_as_bare_when_absolute_git_dir_resolves_elsewhere(fx):
    somewhere_else = "C:/some/other/bare/repo.git"

    def run_git(path, args):
        if args[1] == "--show-toplevel":
            return {"ok": False, "stdout": "", "stderr": "fatal: not a work tree", "command": f"git {' '.join(args)}"}
        if args[1] == "--is-bare-repository":
            # Ambient GIT_DIR answers "true" - but for the WRONG repository.
            return {"ok": True, "stdout": "true\n", "command": f"git {' '.join(args)}"}
        if args[1] == "--absolute-git-dir":
            return {"ok": True, "stdout": f"{somewhere_else}\n", "command": f"git {' '.join(args)}"}
        return {"ok": False, "stdout": "", "stderr": "unexpected", "command": f"git {' '.join(args)}"}

    result = observe_checkouts(
        ["C:/probed/path"], allowlist=["C:/probed/path"], now=NOW, run_git=run_git
    )
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["status"] == "unknown"
    assert f["is_git_repository"]["reason"] == "not_a_git_repository_or_git_failed"


def test_git_dir_guard_mocked_seam_genuine_bare_repo_still_correctly_classified(fx):
    def run_git(path, args):
        if args[1] == "--show-toplevel":
            return {"ok": False, "stdout": "", "stderr": "fatal: not a work tree", "command": f"git {' '.join(args)}"}
        if args[1] == "--is-bare-repository":
            return {"ok": True, "stdout": "true\n", "command": f"git {' '.join(args)}"}
        if args[1] == "--absolute-git-dir":
            return {"ok": True, "stdout": f"{path}\n", "command": f"git {' '.join(args)}"}
        return {"ok": True, "stdout": "", "command": f"git {' '.join(args)}"}

    result = observe_checkouts(
        ["C:/genuine/bare.git"], allowlist=["C:/genuine/bare.git"], now=NOW, run_git=run_git
    )
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["status"] == "known"
    assert f["is_git_repository"]["value"] is True
    assert f["worktree_root"]["status"] == "unknown"
    assert f["worktree_root"]["reason"] == "bare_repository_has_no_worktree"


def test_git_dir_guard_real_git_real_ambient_env_var_plain_non_repo_dir_not_misclassified(fx):
    # Exact repro reported: with GIT_DIR pointing at some other real bare
    # repo, `git -C <plain-non-repo-dir> rev-parse --is-bare-repository`
    # answers "true" even though the observed path is not that repo at all.
    # Deliberately UN-scrubbed (unlike the default run_git): this tests the
    # classification dance itself, not the env-scrubbing fix.
    def hostile_run_git(checkout_path, args):
        full_args = ["--no-optional-locks", "-C", checkout_path, *args]
        env = dict(os.environ)
        env["GIT_DIR"] = fx["paths"]["bare"]
        proc = subprocess.run(["git", *full_args], capture_output=True, env=env)
        command = f"git {' '.join(full_args)}"
        if proc.returncode == 0:
            stdout = (proc.stdout or b"").decode("utf-8", errors="replace").replace("\r\n", "\n")
            return {"ok": True, "stdout": stdout, "command": command}
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
        return {"ok": False, "stdout": "", "stderr": stderr, "command": command}

    result = observe_checkouts(
        [fx["paths"]["plain_non_repo_dir"]],
        allowlist=[fx["paths"]["plain_non_repo_dir"]],
        now=NOW,
        run_git=hostile_run_git,
    )
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["status"] == "unknown"
    assert f["is_git_repository"]["reason"] == "not_a_git_repository_or_git_failed"


# --- PRIMARY-path GIT_DIR hazard: the --show-toplevel branch, not just the
# bare-repo fallback ----------------------------------------------------------


def test_primary_path_git_dir_guard_injectable_seam_real_git_non_repo_not_misattributed(fx):
    non_repo_dir = os.path.realpath(tempfile.mkdtemp(prefix="lattice-non-repo-"))
    try:
        # Mirrors _default_run_git's own env-sanitization so the seam
        # exercises the identical technique against real git, independent of
        # workspace_observe.py's internal implementation.
        def scrubbed_run_git(checkout_path, args):
            full_args = ["--no-optional-locks", "-C", checkout_path, *args]
            # Ambient hazard, injected on purpose: the git DIRECTORY (not the
            # worktree root) of a real, different, non-bare repo.
            env = dict(os.environ)
            env["GIT_DIR"] = os.path.join(fx["paths"]["crlf_repo"], ".git")
            for key in AMBIENT_GIT_ENV_KEYS:
                env.pop(key, None)
            proc = subprocess.run(["git", *full_args], capture_output=True, env=env)
            command = f"git {' '.join(full_args)}"
            if proc.returncode == 0:
                stdout = (proc.stdout or b"").decode("utf-8", errors="replace").replace("\r\n", "\n")
                return {"ok": True, "stdout": stdout, "command": command}
            stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
            return {"ok": False, "stdout": "", "stderr": stderr, "command": command}

        result = observe_checkouts(
            [non_repo_dir], allowlist=[non_repo_dir], now=NOW, run_git=scrubbed_run_git
        )
        f = result["checkouts"][0]["facts"]
        assert f["is_git_repository"]["status"] == "unknown"
        assert f["is_git_repository"]["reason"] == "not_a_git_repository_or_git_failed"
    finally:
        _rmtree_force(non_repo_dir)


# Split into two independent tests deliberately: a combined test would let
# the first assertion's failure mask whether the second ever ran red at
# all. Each test below gets its own genuine, independently-verified
# red-green (mirrors the Node file's own comment/split).


def test_primary_path_git_dir_guard_real_default_run_git_real_ambient_env_non_repo_not_misattributed(fx):
    # The authoritative end-to-end proof: no run_git override at all - this
    # exercises the real, shipped _default_run_git inside workspace_observe.
    # Sets GIT_DIR on THIS test process's own env, exactly the scenario
    # reported ("the calling process happens to have GIT_DIR set"), and
    # restores it unconditionally so no later test in this module is
    # affected.
    non_repo_dir = os.path.realpath(tempfile.mkdtemp(prefix="lattice-non-repo-"))
    previous_git_dir = os.environ.get("GIT_DIR")
    os.environ["GIT_DIR"] = os.path.join(fx["paths"]["crlf_repo"], ".git")
    try:
        result = observe_checkouts([non_repo_dir], allowlist=[non_repo_dir], now=NOW)
        f = result["checkouts"][0]["facts"]
        assert f["is_git_repository"]["status"] == "unknown"
        assert f["is_git_repository"]["reason"] == "not_a_git_repository_or_git_failed"
    finally:
        if previous_git_dir is None:
            os.environ.pop("GIT_DIR", None)
        else:
            os.environ["GIT_DIR"] = previous_git_dir
        _rmtree_force(non_repo_dir)


def test_primary_path_git_dir_guard_real_default_run_git_real_ambient_env_head_not_cross_contaminated(fx):
    # Unpatched, GIT_DIR forces the git-dir to crlfRepo while `-C
    # worktreeMain` supplies the worktree, so --show-toplevel succeeds with
    # worktreeMain's own path (looking locally correct) while HEAD silently
    # resolves to crlfRepo's commit instead. Proven by exact SHA
    # equality/inequality, not merely "did not throw".
    previous_git_dir = os.environ.get("GIT_DIR")
    os.environ["GIT_DIR"] = os.path.join(fx["paths"]["crlf_repo"], ".git")
    try:
        result = observe_checkouts(
            [fx["paths"]["worktree_main"]], allowlist=[fx["paths"]["worktree_main"]], now=NOW
        )
        f = result["checkouts"][0]["facts"]
        assert f["head_revision"]["value"] == fx["shas"]["worktree_sha"]
        assert f["head_revision"]["value"] != fx["shas"]["crlf_sha"]
        assert f["worktree_root"]["value"] == normalize_path(fx["paths"]["worktree_main"])
    finally:
        if previous_git_dir is None:
            os.environ.pop("GIT_DIR", None)
        else:
            os.environ["GIT_DIR"] = previous_git_dir


# --- Submodules ---------------------------------------------------------------


def test_an_initialized_submodule_observes_as_its_own_independent_checkout(fx):
    child_path = os.path.join(fx["paths"]["submodule_parent"], "child")
    result = observe_checkouts(
        [fx["paths"]["submodule_parent"], child_path],
        allowlist=[fx["paths"]["submodule_parent"], child_path],
        now=NOW,
    )
    parent, child = result["checkouts"]
    assert parent["facts"]["is_git_repository"]["value"] is True
    assert child["facts"]["is_git_repository"]["value"] is True
    assert child["facts"]["worktree_root"]["value"] == normalize_path(child_path)
    assert child["facts"]["head_revision"]["value"] == fx["shas"]["submodule_child_sha"]
    assert parent["facts"]["head_revision"]["value"] != child["facts"]["head_revision"]["value"]


def test_an_uninitialized_submodule_directory_git_resolves_up_to_the_enclosing_parent(fx):
    placeholder_path = os.path.join(fx["paths"]["submodule_uninitialized_clone"], "child")
    result = observe_checkouts(
        [placeholder_path], allowlist=[fx["paths"]["submodule_uninitialized_clone"]], now=NOW
    )
    checkout = result["checkouts"][0]
    assert checkout["status"] == "observed"
    assert checkout["facts"]["is_git_repository"]["value"] is True
    # The empty placeholder directory has no .git of its own: git's own
    # upward directory search resolves toplevel to the *parent* clone, not
    # the child path we asked about. Never a throw, never a crawl beyond the
    # filesystem's own directory structure - but a caller must compare
    # raw_path against worktree_root to notice this, since nothing else
    # flags it.
    assert normalize_path(checkout["path"]) != checkout["facts"]["worktree_root"]["value"]
    assert checkout["facts"]["worktree_root"]["value"] == normalize_path(
        fx["paths"]["submodule_uninitialized_clone"]
    )


def test_model_mjs_uninitialized_submodule_placeholder_dedupes_onto_parent(fx):
    placeholder_path = os.path.join(fx["paths"]["submodule_uninitialized_clone"], "child")
    observation = observe_checkouts(
        [fx["paths"]["submodule_uninitialized_clone"], placeholder_path],
        allowlist=[fx["paths"]["submodule_uninitialized_clone"]],
        now=NOW,
    )
    graph = project_workspace_graph(observation)
    repositories = [n for n in graph["nodes"] if n["kind"] == "repository"]
    assert len(repositories) == 1, "both paths resolve to the same underlying repository"
    assert len(graph["conflicts"]) == 0, "identical HEADs of the same repo are not a conflict"
    assert len([e for e in graph["edges"] if e["kind"] == "neighbor_of"]) == 1


# --- git worktree (linked worktree; .git is a gitdir-pointer file) -----------


def test_a_linked_git_worktree_checkout_observes_independently(fx):
    # The distinct shape named in the packet: the linked worktree's .git is
    # not a directory at all, but a plain file containing a "gitdir:" pointer
    # back into the main checkout's .git/worktrees/<name>.
    git_entry_path = os.path.join(fx["paths"]["worktree_linked"], ".git")
    assert os.path.isfile(git_entry_path), "linked worktree's .git must be a file, not a directory"
    with open(git_entry_path, "r", encoding="utf-8") as handle:
        git_file_content = handle.read()
    import re

    assert re.match(r"^gitdir: .*\.git[\\/]worktrees[\\/]", git_file_content)

    allowlist = [fx["paths"]["worktree_main"], fx["paths"]["worktree_linked"]]
    result = observe_checkouts(
        [fx["paths"]["worktree_main"], fx["paths"]["worktree_linked"]], allowlist=allowlist, now=NOW
    )
    main, linked = result["checkouts"]
    assert main["facts"]["head_ref"]["value"]["name"] == "main"
    assert linked["facts"]["head_ref"]["value"]["name"] == "wt-feature"
    assert linked["facts"]["worktree_root"]["value"] == normalize_path(fx["paths"]["worktree_linked"])
    assert main["facts"]["remotes"]["value"][0]["fetch_url"] == linked["facts"]["remotes"]["value"][0]["fetch_url"]
    # Both worktrees are freshly branched from the same commit.
    assert main["facts"]["head_revision"]["value"] == linked["facts"]["head_revision"]["value"]


def test_model_mjs_main_and_linked_worktree_share_one_repository_identity(fx):
    allowlist = [fx["paths"]["worktree_main"], fx["paths"]["worktree_linked"]]
    observation = observe_checkouts(
        [fx["paths"]["worktree_main"], fx["paths"]["worktree_linked"]], allowlist=allowlist, now=NOW
    )
    graph = project_workspace_graph(observation)
    repositories = [n for n in graph["nodes"] if n["kind"] == "repository"]
    assert len(repositories) == 1
    assert len(graph["conflicts"]) == 0
    assert len([e for e in graph["edges"] if e["kind"] == "neighbor_of"]) == 1


# --- Unborn branch -------------------------------------------------------------


def test_unborn_branch_fresh_init_zero_commits(fx):
    result = observe_checkouts([fx["paths"]["unborn"]], allowlist=[fx["paths"]["unborn"]], now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["value"] is True
    assert f["head_revision"]["status"] == "unknown"
    assert f["head_revision"]["reason"] == "head_unresolvable_possibly_unborn_branch"
    assert f["head_ref"]["value"] == {"kind": "branch", "name": "main"}
    assert f["is_dirty"]["value"] is False
    assert f["dirty_entries"]["value"] == []


def test_unsafe_git_legal_dirty_paths_become_nondisclosing_unknowns(fx):
    checkout = fx["paths"]["unicode_repo"]

    def run_git(path, args):
        if args == ["status", "--porcelain=v1", "-z"]:
            return {
                "ok": True,
                "stdout": " M C:note.md\0",
                "stderr": "",
                "command": "git status --porcelain=v1 -z",
                "code": 0,
            }
        return workspace_observe_module._default_run_git(
            path, args, worktree_config={}
        )

    observation = observe_checkouts(
        [checkout],
        allowlist=[checkout],
        run_git=run_git,
        now=NOW,
    )
    facts = observation["checkouts"][0]["facts"]
    assert facts["dirty_entries"]["status"] == "unknown"
    assert facts["dirty_entries"]["reason"] == "unsafe_dirty_entries_excluded"
    assert facts["is_dirty"]["status"] == "unknown"
    assert "C:note.md" not in json.dumps(observation)


def test_content_mjs_content_search_on_an_unborn_branch(fx):
    result = observe_content([fx["paths"]["unborn"]], allowlist=[fx["paths"]["unborn"]], terms=["anything"], now=NOW)
    checkout = result["checkouts"][0]
    assert checkout["status"] == "unknown"
    assert checkout["reason"] == "grep_unavailable"
    assert checkout["matches"] == []


def test_model_mjs_unborn_branch_produces_a_branch_node(fx):
    observation = observe_checkouts([fx["paths"]["unborn"]], allowlist=[fx["paths"]["unborn"]], now=NOW)
    graph = project_workspace_graph(observation)
    assert any(n["kind"] == "branch" and n["name"] == "main" for n in graph["nodes"])
    head_unknown = next((u for u in graph["unknowns"] if u["fact"] == "head_revision"), None)
    assert head_unknown is not None
    assert head_unknown["reason"] == "head_unresolvable_possibly_unborn_branch"


# --- Unicode branch + remote names ---------------------------------------------


def test_unicode_branch_name_and_unicode_remote_name_round_trip_byte_for_byte(fx):
    result = observe_checkouts(
        [fx["paths"]["unicode_repo"]], allowlist=[fx["paths"]["unicode_repo"]], now=NOW
    )
    f = result["checkouts"][0]["facts"]
    assert f["head_ref"]["value"] == {"kind": "branch", "name": "función-Ω"}
    assert len(f["remotes"]["value"]) == 1
    assert f["remotes"]["value"][0]["name"] == "börse-源"
    assert f["remotes"]["value"][0]["fetch_url"] == "https://example.invalid/unicode.git"


def test_model_mjs_unicode_branch_remote_names_survive_projection(fx):
    observation = observe_checkouts(
        [fx["paths"]["unicode_repo"]], allowlist=[fx["paths"]["unicode_repo"]], now=NOW
    )
    graph = project_workspace_graph(observation)
    branch = next(n for n in graph["nodes"] if n["kind"] == "branch")
    remote = next(n for n in graph["nodes"] if n["kind"] == "remote")
    assert branch["name"] == "función-Ω"
    assert remote["name"] == "börse-源"


# --- Symlinked root (checkout path itself is a symlink/junction) --------------


def test_equivalent_windows_case_preserves_exact_allowlist_root_trust(monkeypatch):
    observed_paths = []
    def fake_observe_one(raw_path, run_git):
        observed_paths.append(raw_path)
        return {
            "raw_path": raw_path,
            "path": normalize_path(raw_path),
            "status": "observed",
            "facts": {
                "worktree_root": {
                    "status": "known",
                    "value": "d:/outside-target",
                    "evidence": [],
                }
            },
        }

    monkeypatch.setattr(
        workspace_observe_module,
        "_observe_one",
        fake_observe_one,
    )
    result = workspace_observe_module.observe_checkouts(
        ["C:/Allowlisted-Link", "c:/allowlisted-link"],
        allowlist=["c:/allowlisted-link"],
        now=NOW,
        run_git=lambda path, args: {},
    )
    assert len(result["checkouts"]) == 1
    assert result["refusals"] == []
    assert observed_paths == ["C:/Allowlisted-Link"]

    duplicate_observation = json.loads(json.dumps(result))
    duplicate = json.loads(json.dumps(result["checkouts"][0]))
    duplicate["raw_path"] = "c:/allowlisted-link"
    duplicate["path"] = "c:/allowlisted-link"
    duplicate_observation["checkouts"].append(duplicate)
    with pytest.raises(ValueError, match="duplicate checkout identities"):
        project_workspace_graph(duplicate_observation)

    traversal_observation = json.loads(json.dumps(result))
    traversal_observation["allowlist"] = ["//server/share/safe"]
    traversal_checkout = traversal_observation["checkouts"][0]
    traversal_checkout["raw_path"] = "//server/share/safe/../outside"
    traversal_checkout["path"] = "//server/share/safe/../outside"
    with pytest.raises(ValueError, match="invalid fact status"):
        project_workspace_graph(traversal_observation)

    worktree_traversal = json.loads(json.dumps(result))
    worktree_traversal["checkouts"][0]["facts"]["worktree_root"][
        "value"
    ] = "//server/share/safe/../outside"
    with pytest.raises(ValueError, match="invalid fact status"):
        project_workspace_graph(worktree_traversal)


def test_relative_observation_root_projects_as_structured_refusal(fx):
    observation = observe_checkouts(
        ["relative/repo"],
        allowlist=[fx["paths"]["unicode_repo"]],
        now=NOW,
    )
    graph = project_workspace_graph(observation)
    assert graph["nodes"] == []
    assert graph["refusals"] == [
        {
            "path": "relative/repo",
            "status": "refused",
            "reason": "outside_allowlist",
        }
    ]


def test_an_allowlisted_symlinked_junctioned_root_resolves_through_to_its_real_target(fx):
    if not fx["capabilities"]["symlink_root_built"]:
        pytest.skip("symlink/junction creation unavailable on this platform/privilege level")
    result = observe_checkouts(
        [fx["paths"]["symlink_root"]], allowlist=[fx["paths"]["symlink_root"]], now=NOW
    )
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["value"] is True
    # The one platform-stable proof that observation actually reached the
    # real target repo (not merely "something worked"): the target's own
    # commit SHA, deterministic and identical on every OS, regardless of
    # whether that OS's git resolves --show-toplevel through the link to a
    # real path string or reports the link path itself.
    assert f["head_revision"]["value"] == fx["shas"]["symlink_target_sha"]


# --- SECURITY FINDING, FIXED: post-resolution allowlist re-check -----------


def test_fixed_symlink_junction_inside_allowlisted_directory_no_longer_exposes_repo(fx):
    if not fx["capabilities"]["secret_link_built"]:
        pytest.skip("symlink/junction creation unavailable on this platform/privilege level")
    result = observe_checkouts(
        [fx["paths"]["secret_link_under_allowed"]], allowlist=[fx["paths"]["allowed_root"]], now=NOW
    )
    assert len(result["checkouts"]) == 0, "the escaped resolution must never be returned as a checkout"
    assert len(result["refusals"]) == 1
    assert result["refusals"][0]["reason"] == "resolved_outside_allowlist"
    # Leak-safety: the refusal must never surface the never-allowlisted
    # repository's real path or content - only the caller-supplied raw path
    # (not a leak, the caller already knows it) and a reason code.
    import json as _json

    serialized = _json.dumps(result)
    assert "SECRET_REPO_CONTENT" not in serialized
    assert normalize_path(fx["paths"]["secret_elsewhere"]) not in serialized


def test_by_contrast_an_allowlist_entry_that_is_itself_the_symlinked_path_is_trusted_exactly_as_before(fx):
    if not fx["capabilities"]["symlink_root_built"]:
        pytest.skip("symlink/junction creation unavailable on this platform/privilege level")
    # Same mechanism as the "an allowlisted symlinked/junctioned root
    # resolves through to its real target" test above - restated here,
    # directly beside the fix, as an explicit non-regression pin: an exact
    # allowlist-entry match must remain exempt from the post-resolution
    # re-check, or this legitimate case would start being wrongly refused.
    result = observe_checkouts(
        [fx["paths"]["symlink_root"]], allowlist=[fx["paths"]["symlink_root"]], now=NOW
    )
    assert len(result["refusals"]) == 0
    assert len(result["checkouts"]) == 1
    assert result["checkouts"][0]["facts"]["head_revision"]["value"] == fx["shas"]["symlink_target_sha"]


def test_content_mjs_content_search_through_symlink_junction_is_refused(fx):
    if not fx["capabilities"]["secret_link_built"]:
        pytest.skip("symlink/junction creation unavailable on this platform/privilege level")
    result = observe_content(
        [fx["paths"]["secret_link_under_allowed"]],
        allowlist=[fx["paths"]["allowed_root"]],
        terms=["SECRET_REPO_CONTENT"],
        now=NOW,
    )
    assert len(result["checkouts"]) == 0, "the escaped descendant is dropped, not searched"
    refusal = next((r for r in result["refusals"] if r["reason"] == "resolved_outside_allowlist"), None)
    assert refusal is not None, "refused with resolved_outside_allowlist"
    # No grep ran, so no matched line/file from the foreign repo appears.
    # (The `terms` field echoes the query "SECRET_REPO_CONTENT" verbatim -
    # that is the request, not a leak - so we assert on match artifacts that
    # only a real grep could have produced: the matched filename and any
    # match objects.)
    assert all(len(c.get("matches") or []) == 0 for c in result["checkouts"]), "no matches from the foreign repo"
    assert "secret.md" not in json.dumps(result["refusals"]), "no foreign filename leaks via the refusal"
    assert "secret content" not in json.dumps(result), "no foreign file body leaks"


def test_by_contrast_asking_for_the_outside_repository_real_path_directly_is_refused_no_git_run(fx):
    invoked = []

    def spy_run_git(path, args):
        invoked.append(path)
        return {"ok": False, "stdout": "", "stderr": "spy", "command": f"git {' '.join(args)}"}

    result = observe_checkouts(
        [fx["paths"]["secret_elsewhere"]],
        allowlist=[fx["paths"]["allowed_root"]],
        now=NOW,
        run_git=spy_run_git,
    )
    assert len(result["checkouts"]) == 0
    assert len(result["refusals"]) == 1
    assert result["refusals"][0]["reason"] == "outside_allowlist"
    assert invoked == [], "the escape is specific to the symlink structure, not a general allowlist failure"


# --- Symlink inside the tree, tracked, pointing outside the repo -------------


def test_content_mjs_tracked_symlink_invisible_to_git_grep(fx):
    if not fx["capabilities"]["symlink_inside_built"]:
        pytest.skip("symlink creation unavailable on this platform/privilege level")
    result = observe_content(
        [fx["paths"]["symlink_inside_repo"]],
        allowlist=[fx["paths"]["symlink_inside_repo"]],
        terms=["OUTSIDE_SECRET_MARKER", "needle"],
        now=NOW,
    )
    checkout = result["checkouts"][0]
    assert checkout["status"] == "observed"
    assert checkout["matches"] == []
    assert checkout["omissions"] == []
    # `result.terms` legitimately echoes the caller's own search terms back
    # (that is not a leak); the leak we are guarding against is the
    # *checkout*'s own matches/omissions surfacing the outside file's
    # content, which the two assertions above already rule out.
    assert "OUTSIDE_SECRET_MARKER" not in json.dumps(checkout)


# --- Workspace unicode edges (content.mjs-owned excerpt/grep-line handling) --


def _assert_well_formed_excerpt(excerpt):
    # JS UTF-16 code-unit length cap (plus the trailing ellipsis when
    # truncated) - mirrors _js_utf16_length's counting rule without
    # importing the module's private helper.
    utf16_length = sum(2 if ord(ch) > 0xFFFF else 1 for ch in excerpt)
    assert utf16_length <= MAX_EXCERPT_LENGTH + 1, "excerpt must respect the length cap (plus ellipsis)"
    # "well-formed" (no lone surrogate) <=> round-trips losslessly through
    # UTF-8 - a lone surrogate cannot be UTF-8 encoded at all, which is
    # exactly the failure mode a straddled/unrepaired surrogate produces.
    try:
        excerpt.encode("utf-8")
    except UnicodeEncodeError as exc:  # pragma: no cover - failure path
        raise AssertionError(f"excerpt must be well-formed UTF-16 (no lone surrogate): {exc}") from exc


def _excerpt_for(raw_line):
    result = observe_content(
        ["C:/fake"],
        allowlist=["C:/fake"],
        terms=["needle"],
        run_git=content_git_runner(
            f"file.md\0" + "1\0" + raw_line + "\n"
        ),
        now=NOW,
    )
    return result["checkouts"][0]["matches"][0]["excerpt"]


def test_content_mjs_max_excerpt_length_never_splits_a_surrogate_pair(fx):
    prefix = "x" * (MAX_EXCERPT_LENGTH - 1)
    excerpt = _excerpt_for(f"{prefix}\U0001F600needle")  # grinning-face emoji straddles the cut
    _assert_well_formed_excerpt(excerpt)


def test_content_mjs_max_excerpt_length_repairs_lone_low_surrogate_at_boundary(fx):
    # The unit at the retained boundary is a low surrogate with nothing
    # valid before it to pair with - already invalid independent of where
    # the cut lands, and must not survive into the excerpt as-is.
    excerpt = _excerpt_for("x" * 199 + "\udc00needle")
    _assert_well_formed_excerpt(excerpt)


def test_content_mjs_max_excerpt_length_repairs_content_of_unpaired_high_surrogates(fx):
    # A single-unit boundary backoff cannot fix this: every retained unit is
    # an unpaired high surrogate, not just the last one.
    excerpt = _excerpt_for("\ud800" * 205 + "needle")
    _assert_well_formed_excerpt(excerpt)


def test_content_mjs_max_excerpt_length_valid_surrogate_pair_well_before_boundary_untouched(fx):
    excerpt = _excerpt_for("hello \U0001F600 needle")
    assert excerpt == "hello \U0001F600 needle"
    _assert_well_formed_excerpt(excerpt)


def test_content_mjs_nul_framing_preserves_colons_in_content(fx):
    run_git = content_git_runner(
        "log.md\0" + "5\0" + "at 10:30:00 done\n"
    )

    result = observe_content(
        ["C:/fake"],
        allowlist=["C:/fake"],
        terms=["done"],
        run_git=run_git,
        now=NOW,
    )
    match = result["checkouts"][0]["matches"][0]
    assert match["path"] == "log.md"
    assert match["line"] == 5
    assert match["excerpt"] == "at 10:30:00 done"


def test_content_mjs_nul_framing_preserves_colons_in_filename(fx):
    run_git = content_git_runner(
        "notes:1:draft.md\0" + "5\0" + "some content\n"
    )

    result = observe_content(
        ["C:/fake"],
        allowlist=["C:/fake"],
        terms=["content"],
        run_git=run_git,
        now=NOW,
    )
    match = result["checkouts"][0]["matches"][0]
    assert match["path"] == "notes:1:draft.md"
    assert match["line"] == 5
    assert match["excerpt"] == "some content"


def test_content_mjs_match_on_genuine_crlf_terminated_line(fx):
    result = observe_content(
        [fx["paths"]["crlf_repo"]], allowlist=[fx["paths"]["crlf_repo"]], terms=["needle-crlf"], now=NOW
    )
    match = result["checkouts"][0]["matches"][0]
    assert match["path"] == "crlf.md"
    assert match["line"] == 2
    assert "\r" not in match["excerpt"]
    assert match["excerpt"] == "needle-crlf here"


def test_content_mjs_observation_and_content_search_deterministic_under_injected_clock(fx):
    p = fx["paths"]
    allowlist = [p["bare"], p["unborn"], p["unicode_repo"], p["crlf_repo"]]
    paths = [p["bare"], p["unborn"], p["unicode_repo"], p["crlf_repo"]]
    a = observe_checkouts(paths, allowlist=allowlist, now=NOW)
    b = observe_checkouts(paths, allowlist=allowlist, now=NOW)
    assert a == b

    ca = observe_content([p["crlf_repo"]], allowlist=[p["crlf_repo"]], terms=["needle-crlf"], now=NOW)
    cb = observe_content([p["crlf_repo"]], allowlist=[p["crlf_repo"]], terms=["needle-crlf"], now=NOW)
    assert ca == cb
