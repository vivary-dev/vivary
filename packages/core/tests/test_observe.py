"""Pytest translation of tests/observe.test.mjs (slice 2, ticket #84/#88,
decision 0008).

Builds real temp git repositories under a disposable per-test fixture
directory, with pinned git identity/dates and isolated global/system config,
mirroring tests/helpers/fixtures.mjs's buildFixtures/hashTree exactly - just
re-expressed as a local pytest fixture/helpers in this one owned file, the
same pattern python/tests/test_evidence.py uses for its own fixtures.
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
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from vivary_core.workspace_observe import OBSERVATION_SCHEMA, observe_checkouts  # noqa: E402

FIXTURE_BASE = os.path.join(HERE, ".fixtures", "observe")


def NOW():
    return "2026-07-20T15:00:00.000Z"


FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP = datetime(2026, 7, 2, 0, 0, 0, tzinfo=timezone.utc)


# --- fixture plumbing (mirrors tests/helpers/fixtures.mjs) -------------------


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


def build_fixtures(base_dir):
    """Port of tests/helpers/fixtures.mjs's buildFixtures."""
    _rmtree_force(base_dir)
    os.makedirs(base_dir, exist_ok=True)
    with open(os.path.join(base_dir, "empty-gitconfig"), "w", encoding="utf-8") as handle:
        handle.write("")

    paths = {
        "base": base_dir,
        "origin": os.path.join(base_dir, "origin.git"),
        "canonical": os.path.join(base_dir, "canonical"),
        "stale_neighbor": os.path.join(base_dir, "stale-neighbor"),
        "dirty": os.path.join(base_dir, "dirty"),
        "detached": os.path.join(base_dir, "detached"),
        "no_origin": os.path.join(base_dir, "no-origin"),
        "spaced": os.path.join(base_dir, "path with spaces", "spaced repo"),
        "disallowed": os.path.join(base_dir, "outside", "disallowed"),
    }

    # Shared origin with two checkouts: canonical at commit B, the stale
    # neighbor cloned while origin was still at commit A. Both are clean; they
    # simply disagree about where main is. That ambiguity is the fixture.
    _git(base_dir, base_dir, ["init", "-q", "--bare", "-b", "main", paths["origin"]])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["canonical"]])
    commit_a = _commit_file(base_dir, paths["canonical"], "README.md", "# canonical\n", "commit A")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["stale_neighbor"]])
    commit_b = _commit_file(base_dir, paths["canonical"], "NOTES.md", "commit B content\n", "commit B")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])

    # Give canonical a deterministic FETCH_HEAD so last_fetch has a known
    # value; the stale neighbor keeps none, so its freshness stays an
    # explicit unknown.
    canonical_fetch_head = os.path.join(paths["canonical"], ".git", "FETCH_HEAD")
    with open(canonical_fetch_head, "w", encoding="utf-8", newline="") as handle:
        handle.write(f"{commit_b}\t\tbranch 'main' of {paths['origin']}\n")
    stamp = FETCH_STAMP.timestamp()
    os.utime(canonical_fetch_head, (stamp, stamp))
    stale_fetch_head = os.path.join(paths["stale_neighbor"], ".git", "FETCH_HEAD")
    if os.path.exists(stale_fetch_head):
        os.remove(stale_fetch_head)

    # Dirty worktree with a modified file, an untracked file, and a
    # git-ignored private path that must never leak into any packet.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["dirty"]])
    with open(os.path.join(paths["dirty"], ".gitignore"), "w", encoding="utf-8", newline="") as handle:
        handle.write("secrets/\n")
    _git(base_dir, paths["dirty"], ["add", ".gitignore"])
    _commit_file(base_dir, paths["dirty"], "tracked.md", "original\n", "dirty base")
    with open(os.path.join(paths["dirty"], "tracked.md"), "w", encoding="utf-8", newline="") as handle:
        handle.write("modified\n")
    with open(os.path.join(paths["dirty"], "untracked.md"), "w", encoding="utf-8", newline="") as handle:
        handle.write("untracked\n")
    os.makedirs(os.path.join(paths["dirty"], "secrets"), exist_ok=True)
    with open(
        os.path.join(paths["dirty"], "secrets", "private-note.md"), "w", encoding="utf-8", newline=""
    ) as handle:
        handle.write("PRIVATE_FIXTURE_MARKER\n")

    # Detached HEAD at the first of two commits.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["detached"]])
    detached_first = _commit_file(base_dir, paths["detached"], "one.md", "one\n", "first")
    _commit_file(base_dir, paths["detached"], "two.md", "two\n", "second")
    _git(base_dir, paths["detached"], ["checkout", "-q", detached_first])

    # No remotes configured at all.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["no_origin"]])
    _commit_file(base_dir, paths["no_origin"], "solo.md", "solo\n", "solo")

    # Windows path containing spaces.
    os.makedirs(paths["spaced"], exist_ok=True)
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["spaced"]])
    _commit_file(base_dir, paths["spaced"], "spaced.md", "spaced\n", "spaced")

    # A perfectly valid repository that sits outside the allowlist.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["disallowed"]])
    _commit_file(base_dir, paths["disallowed"], "nope.md", "nope\n", "disallowed")

    return {"paths": paths, "shas": {"commit_a": commit_a, "commit_b": commit_b, "detached_first": detached_first}}


def hash_tree(root):
    """Content hash of an entire directory tree (paths + bytes), used to
    prove the scanner mutated nothing inside .git."""
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
    base_dir = FIXTURE_BASE
    result = build_fixtures(base_dir)
    yield result
    _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def allowlist(fx):
    p = fx["paths"]
    return [p["canonical"], p["stale_neighbor"], p["dirty"], p["detached"], p["no_origin"], p["spaced"]]


# --- tests --------------------------------------------------------------------


def test_observation_is_strictly_read_only_git_trees_byte_identical(fx, allowlist):
    targets = [fx["paths"]["canonical"], fx["paths"]["dirty"], fx["paths"]["detached"]]
    before = [hash_tree(os.path.join(t, ".git")) for t in targets]
    observe_checkouts(targets, allowlist=allowlist, now=NOW)
    after = [hash_tree(os.path.join(t, ".git")) for t in targets]
    assert after == before


def test_clean_canonical_checkout_every_core_fact_is_known(fx, allowlist):
    result = observe_checkouts([fx["paths"]["canonical"]], allowlist=allowlist, now=NOW)
    checkout = result["checkouts"][0]
    f = checkout["facts"]
    assert f["head_revision"]["status"] == "known"
    assert f["head_revision"]["value"] == fx["shas"]["commit_b"]
    assert f["head_ref"]["value"] == {"kind": "branch", "name": "main"}
    assert f["is_dirty"]["value"] is False
    assert len(f["remotes"]["value"]) == 1
    assert f["remotes"]["value"][0]["name"] == "origin"
    assert f["last_fetch"]["status"] == "known"
    assert f["last_fetch"]["value"] == "2026-07-02T00:00:00.000Z"


def test_stale_neighbor_older_head_freshness_is_explicit_unknown(fx, allowlist):
    result = observe_checkouts([fx["paths"]["stale_neighbor"]], allowlist=allowlist, now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["head_revision"]["value"] == fx["shas"]["commit_a"]
    assert f["last_fetch"]["status"] == "unknown"
    assert f["last_fetch"]["reason"] == "no_fetch_recorded"


def test_dirty_worktree_modified_and_untracked_reported_gitignored_never_observed(fx, allowlist):
    result = observe_checkouts([fx["paths"]["dirty"]], allowlist=allowlist, now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["is_dirty"]["value"] is True
    paths = [e["path"] for e in f["dirty_entries"]["value"]]
    assert "tracked.md" in paths
    assert "untracked.md" in paths
    import json as _json

    serialized = _json.dumps(result)
    assert "private-note" not in serialized
    assert "secrets/" not in serialized

def test_tracked_ignored_dirty_path_is_never_disclosed(fx, allowlist):
    repo = fx["paths"]["dirty"]
    gitignore = os.path.join(repo, ".gitignore")
    with open(gitignore, encoding="utf-8") as handle:
        original = handle.read()
    with open(gitignore, "w", encoding="utf-8", newline="") as handle:
        handle.write(original + "tracked.md\n")
    try:
        result = observe_checkouts([repo], allowlist=allowlist, now=NOW)
    finally:
        with open(gitignore, "w", encoding="utf-8", newline="") as handle:
            handle.write(original)

    facts = result["checkouts"][0]["facts"]
    assert facts["dirty_entries"]["status"] == "unknown"
    assert facts["dirty_entries"]["reason"] == "ignored_dirty_entries_excluded"
    assert facts["is_dirty"]["status"] == "unknown"
    serialized = json.dumps(result)
    assert "tracked.md" not in serialized
    assert "privacy_command" in serialized

def test_non_ascii_dirty_filename_is_reported_without_quoting(tmp_path):
    base = str(tmp_path)
    repo = str(tmp_path / "repo")
    _git(base, base, ["init", "-q", "-b", "main", repo])
    _commit_file(base, repo, "README.md", "base\n", "base")
    unicode_name = "身份验证.md"
    unicode_path = os.path.join(repo, unicode_name)
    with open(unicode_path, "w", encoding="utf-8", newline="") as handle:
        handle.write("dirty\n")

    result = observe_checkouts([repo], allowlist=[repo], now=NOW)

    facts = result["checkouts"][0]["facts"]
    assert facts["dirty_entries"]["status"] == "known"
    assert unicode_name in {
        entry["path"] for entry in facts["dirty_entries"]["value"]
    }


def test_ignored_rename_destination_is_never_disclosed(tmp_path):
    base = str(tmp_path)
    repo = str(tmp_path / "repo")
    _git(base, base, ["init", "-q", "-b", "main", repo])
    _commit_file(base, repo, "README.md", "base\n", "base")
    _commit_file(
        base,
        repo,
        ".gitignore",
        "private.md\n",
        "privacy policy",
    )
    _git(base, repo, ["mv", "README.md", "private.md"])

    result = observe_checkouts([repo], allowlist=[repo], now=NOW)

    facts = result["checkouts"][0]["facts"]
    assert facts["dirty_entries"]["status"] == "unknown"
    assert facts["dirty_entries"]["reason"] == "ignored_dirty_entries_excluded"
    assert "private.md" not in json.dumps(result)


def test_ignore_filter_batches_more_than_256_dirty_paths(tmp_path):
    base = str(tmp_path)
    repo = str(tmp_path / "repo")
    _git(base, base, ["init", "-q", "-b", "main", repo])
    _commit_file(base, repo, "README.md", "base\n", "base")
    for index in range(300):
        with open(
            os.path.join(repo, f"bulk-{index:03}.md"),
            "w",
            encoding="utf-8",
            newline="",
        ) as handle:
            handle.write("dirty\n")

    result = observe_checkouts([repo], allowlist=[repo], now=NOW)

    facts = result["checkouts"][0]["facts"]
    assert facts["dirty_entries"]["status"] == "known"
    paths = {entry["path"] for entry in facts["dirty_entries"]["value"]}
    assert "bulk-000.md" in paths
    assert "bulk-299.md" in paths





def test_detached_head_is_reported_as_detached_not_flattened_into_a_branch(fx, allowlist):
    result = observe_checkouts([fx["paths"]["detached"]], allowlist=allowlist, now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["head_ref"]["value"] == {"kind": "detached"}
    assert f["head_revision"]["value"] == fx["shas"]["detached_first"]


def test_missing_origin_remotes_known_empty_upstream_and_freshness_unknown(fx, allowlist):
    result = observe_checkouts([fx["paths"]["no_origin"]], allowlist=allowlist, now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["remotes"]["status"] == "known"
    assert f["remotes"]["value"] == []
    assert f["upstream"]["status"] == "unknown"
    assert f["upstream"]["reason"] == "no_upstream_configured"
    assert f["last_fetch"]["status"] == "unknown"


def test_path_with_spaces_observes_cleanly(fx, allowlist):
    result = observe_checkouts([fx["paths"]["spaced"]], allowlist=allowlist, now=NOW)
    f = result["checkouts"][0]["facts"]
    assert f["is_git_repository"]["value"] is True
    assert f["head_ref"]["value"]["name"] == "main"


def test_a_root_outside_the_allowlist_is_refused_and_no_git_command_runs(fx, allowlist):
    invoked = []

    def spy_run_git(path, args):
        invoked.append(path)
        return {"ok": False, "stdout": "", "stderr": "spy", "command": f"git {' '.join(args)}"}

    result = observe_checkouts(
        [fx["paths"]["disallowed"]], allowlist=allowlist, now=NOW, run_git=spy_run_git
    )
    assert len(result["checkouts"]) == 0
    assert len(result["refusals"]) == 1
    assert result["refusals"][0]["reason"] == "outside_allowlist"
    assert invoked == []


def test_an_explicit_allowlist_is_mandatory_the_scanner_never_crawls_by_default(fx):
    with pytest.raises(ValueError, match="allowlist"):
        observe_checkouts([fx["paths"]["canonical"]])


# --- #71: bad allowlist ENTRIES are rejected at construction, not silently
# treated as a wildcard --------------------------------------------------


def test_an_empty_string_allowlist_entry_is_refused_outright_71(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_checkouts([fx["paths"]["canonical"]], allowlist=[""], now=NOW)


def test_a_whitespace_only_allowlist_entry_is_refused_outright(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_checkouts([fx["paths"]["canonical"]], allowlist=["   "], now=NOW)


def test_a_relative_allowlist_entry_is_refused_outright(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_checkouts([fx["paths"]["canonical"]], allowlist=["relative/path"], now=NOW)


def test_one_bad_entry_among_otherwise_valid_entries_still_refuses_the_whole_call(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_checkouts(
            [fx["paths"]["canonical"]], allowlist=[fx["paths"]["canonical"], ""], now=NOW
        )


def test_a_normal_absolute_allowlist_is_unaffected_by_the_71_validation(fx):
    result = observe_checkouts(
        [fx["paths"]["canonical"]], allowlist=[fx["paths"]["canonical"]], now=NOW
    )
    assert len(result["checkouts"]) == 1
    assert len(result["refusals"]) == 0


def test_observation_is_deterministic_under_an_injected_clock(fx, allowlist):
    a = observe_checkouts(
        [fx["paths"]["canonical"], fx["paths"]["no_origin"]], allowlist=allowlist, now=NOW
    )
    b = observe_checkouts(
        [fx["paths"]["canonical"], fx["paths"]["no_origin"]], allowlist=allowlist, now=NOW
    )
    assert a == b


def test_observation_schema_constant():
    assert OBSERVATION_SCHEMA == "vivary.workspace-observation/v0"


def test_ambient_git_config_env_cannot_forge_a_remote(fx, allowlist, monkeypatch):
    """`GIT_CONFIG_*` must not be able to invent an origin for a remote-less repo.

    The denylist covered four keys, so command-scope config injection still passed
    through. Setting these before `observe_checkouts` makes a repository with no
    remotes observe as having an attacker-supplied origin — and that false URL then
    becomes the repository identity used for graph grouping, conflicts and
    fingerprints, so a forged value propagates into every downstream claim.
    """
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "remote.origin.url")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "https://evil.example/attacker.git")

    result = observe_checkouts([fx["paths"]["no_origin"]], allowlist=allowlist, now=NOW)

    facts = result["checkouts"][0]["facts"]
    assert facts["remotes"]["status"] == "known"
    assert facts["remotes"]["value"] == [], (
        "ambient GIT_CONFIG_* injected a remote into a repository that has none"
    )
    assert "attacker" not in json.dumps(result)


def test_ambient_git_object_env_is_scrubbed():
    """Every Git variable that can redirect repository, config or object resolution
    is removed, not just the four originally named."""
    from vivary_core.workspace_observe import _sanitized_git_env

    hostile = {
        "GIT_DIR": "/tmp/evil.git",
        "GIT_WORK_TREE": "/tmp/evil",
        "GIT_INDEX_FILE": "/tmp/evil-index",
        "GIT_COMMON_DIR": "/tmp/evil-common",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "remote.origin.url",
        "GIT_CONFIG_VALUE_0": "https://evil.example/x.git",
        "GIT_CONFIG_GLOBAL": "/tmp/evil-config",
        "GIT_CONFIG_SYSTEM": "/tmp/evil-system",
        "GIT_OBJECT_DIRECTORY": "/tmp/evil-objects",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/tmp/evil-alt",
        "GIT_CEILING_DIRECTORIES": "/tmp",
        "GIT_NAMESPACE": "evil",
    }
    saved = {k: os.environ.get(k) for k in hostile}
    os.environ.update(hostile)
    try:
        env = _sanitized_git_env()
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # No attacker-supplied value may survive. Two keys remain *present* on purpose:
    # the sanitizer pins config discovery to os.devnull rather than deleting it, so
    # the run reads the repository's own config and nothing ambient.
    leaked = sorted(key for key, value in hostile.items() if env.get(key) == value)
    assert leaked == [], f"these Git overrides survived sanitization: {leaked}"
    assert env["GIT_CONFIG_GLOBAL"] == os.devnull
    assert env["GIT_CONFIG_SYSTEM"] == os.devnull
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert "GIT_CONFIG_COUNT" not in env and "GIT_DIR" not in env


def test_corrupt_symbolic_head_is_unknown_not_detached():
    """`symbolic-ref -q` exits 1 for a genuinely detached HEAD and 128 for a broken
    one. Treating every failure as detachment reports corruption as a known fact."""
    from vivary_core.workspace_observe import _observe_one

    def run_git(path, args):
        command = f"git {' '.join(args)}"
        if args[0] == "symbolic-ref":
            return {"ok": False, "stdout": "", "stderr": "fatal: bad ref", "code": 128,
                    "command": command}
        if args[0] == "rev-parse" and "--show-toplevel" in args:
            return {"ok": True, "stdout": path + "\n", "command": command, "code": 0}
        return {"ok": True, "stdout": "\n", "command": command, "code": 0}

    facts = _observe_one(os.path.abspath("repo"), run_git)["facts"]
    assert facts["head_ref"]["status"] == "unknown", (
        "a corrupt symbolic HEAD must not be reported as a known detached HEAD"
    )


def test_genuinely_detached_head_still_reads_as_detached():
    """Exit 1 is the documented 'not a symbolic ref' result and stays detached."""
    from vivary_core.workspace_observe import _observe_one

    def run_git(path, args):
        command = f"git {' '.join(args)}"
        if args[0] == "symbolic-ref":
            return {"ok": False, "stdout": "", "stderr": "", "code": 1, "command": command}
        if args[0] == "rev-parse" and "--show-toplevel" in args:
            return {"ok": True, "stdout": path + "\n", "command": command, "code": 0}
        return {"ok": True, "stdout": "\n", "command": command, "code": 0}

    facts = _observe_one(os.path.abspath("repo"), run_git)["facts"]
    assert facts["head_ref"]["status"] == "known"
    assert facts["head_ref"]["value"] == {"kind": "detached"}


@pytest.mark.skipif(os.name != "nt", reason="Windows path casing")
def test_allowlist_admits_a_windows_path_differing_only_in_case(fx):
    """On Windows `C:/Repo` and `c:/repo` are the same directory.

    Normalization lowercased only the drive letter, so a caller whose allowlist
    casing differs from the path they pass — or from the canonical casing Git
    reports back — had legitimate checkouts refused.
    """
    canonical = fx["paths"]["canonical"]
    shouted = canonical.upper()

    result = observe_checkouts([canonical], allowlist=[shouted], now=NOW)

    assert result["refusals"] == [], (
        f"case-only difference refused a legitimate checkout: {result['refusals']}"
    )
    assert len(result["checkouts"]) == 1


def test_remote_url_credentials_are_redacted(fx, allowlist):
    """A configured HTTPS remote embedding credentials must not be stored verbatim.

    `git remote -v` returns userinfo as written, and the parser stored the complete
    URL as both a fact and the repository identity, which capsule compilation later
    repeats in a human-readable claim — so serialized observations, graphs, capsules
    and fingerprints could all disclose a long-lived token.
    """
    repo = fx["paths"]["no_origin"]
    secret = "secret-token-do-not-leak"
    _git(FIXTURE_BASE, repo, ["remote", "add", "leaky",
                              f"https://user:{secret}@example.com/repo.git"])
    try:
        result = observe_checkouts([repo], allowlist=allowlist, now=NOW)
    finally:
        _git(FIXTURE_BASE, repo, ["remote", "remove", "leaky"])

    serialized = json.dumps(result)
    assert secret not in serialized, "remote credentials leaked into the observation"
    assert "example.com/repo.git" in serialized, "the canonical remote identity was lost"
