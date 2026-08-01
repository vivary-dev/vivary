"""Pytest translation of tests/content.test.mjs (slice 2, ticket #84,
decision 0008).

Builds the same real git fixtures as tests/helpers/fixtures.mjs's
buildFixtures/hashTree (pinned identity/date, isolated global/system
config), re-expressed as local helpers for this one owned file - mirroring
python/tests/test_evidence.py's precedent of self-contained per-file fixture
plumbing rather than a shared fixtures module.

Node's content.test.mjs builds one shared fixture tree in a single
suite-level `before()` and reuses it for every test in the file; this
translation keeps that shape (a module-scoped pytest fixture) rather than
per-test isolation, since several assertions (byte-identical .git trees,
shared canonical checkout) depend on the same on-disk fixtures every other
test in this file also touches.

The fixture tree is built under the OS temp directory (tempfile.mkdtemp,
with no `dir=` pointing back into this repo) rather than a fixed path under
python/tests/ - a fixed path nested inside this repo's own working tree
means that if a fixture checkout's .git is ever momentarily unreadable
(e.g. a transient lock), git's directory-discovery walk climbs past it and
lands on this repo's OWN .git instead of failing, silently substituting the
real vivary-lattice-lab repository's identity for the fixture's. Building
outside any enclosing git repository makes that escape structurally
impossible rather than merely unlikely (observed once during this port's
own verification: see PR discussion).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from test_support import content_git_runner  # noqa: E402

from vivary_core.workspace_content import (  # noqa: E402
    CONTENT_SCHEMA,
    MAX_EXCERPT_LENGTH,
    MAX_FILES_PER_CHECKOUT,
    MAX_MATCHES_PER_FILE,
    _parse_grep_lines,
    observe_content,
)

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP = datetime(2026, 7, 2, 0, 0, 0, tzinfo=timezone.utc)


def NOW():
    return "2026-07-21T00:00:00.000Z"


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


def _write(path, content):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def _commit_file(base_dir, repo, file_name, content, message):
    _write(os.path.join(repo, file_name), content)
    _git(base_dir, repo, ["add", file_name])
    _git(base_dir, repo, ["commit", "-q", "-m", message])
    return _git(base_dir, repo, ["rev-parse", "HEAD"])


def build_fixtures(base_dir):
    _rmtree_force(base_dir)
    os.makedirs(base_dir, exist_ok=True)
    _write(os.path.join(base_dir, "empty-gitconfig"), "")

    paths = {
        "base": base_dir,
        "origin": os.path.join(base_dir, "origin.git"),
        "canonical": os.path.join(base_dir, "canonical"),
        "staleNeighbor": os.path.join(base_dir, "stale-neighbor"),
        "dirty": os.path.join(base_dir, "dirty"),
        "detached": os.path.join(base_dir, "detached"),
        "noOrigin": os.path.join(base_dir, "no-origin"),
        "spaced": os.path.join(base_dir, "path with spaces", "spaced repo"),
        "disallowed": os.path.join(base_dir, "outside", "disallowed"),
    }

    # Shared origin with two checkouts: canonical at commit B, the stale
    # neighbor cloned while origin was still at commit A. Both are clean;
    # they simply disagree about where main is. That ambiguity is the
    # fixture.
    _git(base_dir, base_dir, ["init", "-q", "--bare", "-b", "main", paths["origin"]])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["canonical"]])
    commit_a = _commit_file(base_dir, paths["canonical"], "README.md", "# canonical\n", "commit A")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["staleNeighbor"]])
    commit_b = _commit_file(base_dir, paths["canonical"], "NOTES.md", "commit B content\n", "commit B")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])

    # Give canonical a deterministic FETCH_HEAD so last_fetch has a known
    # value; the stale neighbor keeps none, so its freshness stays an
    # explicit unknown.
    canonical_fetch_head = os.path.join(paths["canonical"], ".git", "FETCH_HEAD")
    _write(canonical_fetch_head, f"{commit_b}\t\tbranch 'main' of {paths['origin']}\n")
    fetch_epoch = FETCH_STAMP.timestamp()
    os.utime(canonical_fetch_head, (fetch_epoch, fetch_epoch))
    stale_fetch_head = os.path.join(paths["staleNeighbor"], ".git", "FETCH_HEAD")
    if os.path.exists(stale_fetch_head):
        os.remove(stale_fetch_head)

    # Dirty worktree with a modified file, an untracked file, and a
    # git-ignored private path that must never leak into any packet.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["dirty"]])
    _write(os.path.join(paths["dirty"], ".gitignore"), "secrets/\n")
    _git(base_dir, paths["dirty"], ["add", ".gitignore"])
    _commit_file(base_dir, paths["dirty"], "tracked.md", "original\n", "dirty base")
    _write(os.path.join(paths["dirty"], "tracked.md"), "modified\n")
    _write(os.path.join(paths["dirty"], "untracked.md"), "untracked\n")
    os.makedirs(os.path.join(paths["dirty"], "secrets"), exist_ok=True)
    _write(os.path.join(paths["dirty"], "secrets", "private-note.md"), "PRIVATE_FIXTURE_MARKER\n")

    # Detached HEAD at the first of two commits.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["detached"]])
    detached_first = _commit_file(base_dir, paths["detached"], "one.md", "one\n", "first")
    _commit_file(base_dir, paths["detached"], "two.md", "two\n", "second")
    _git(base_dir, paths["detached"], ["checkout", "-q", detached_first])

    # No remotes configured at all.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["noOrigin"]])
    _commit_file(base_dir, paths["noOrigin"], "solo.md", "solo\n", "solo")

    # Windows path containing spaces.
    os.makedirs(paths["spaced"], exist_ok=True)
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["spaced"]])
    _commit_file(base_dir, paths["spaced"], "spaced.md", "spaced\n", "spaced")

    # A perfectly valid repository that sits outside the allowlist.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["disallowed"]])
    _commit_file(base_dir, paths["disallowed"], "nope.md", "nope\n", "disallowed")

    return {"paths": paths, "shas": {"commitA": commit_a, "commitB": commit_b, "detachedFirst": detached_first}}


def hash_tree(root):
    # Content hash of an entire directory tree (paths + bytes), used to
    # prove the scanner mutated nothing inside .git.
    files = []

    def walk(dir_, rel):
        with os.scandir(dir_) as entries:
            entry_list = sorted(entries, key=lambda e: e.name)
        for entry in entry_list:
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
    base_dir = os.path.realpath(tempfile.mkdtemp(prefix="vivary-content-fixtures-"))
    data = build_fixtures(base_dir)
    yield data
    _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def allowlist(fx):
    p = fx["paths"]
    return [p["canonical"], p["staleNeighbor"], p["dirty"], p["detached"], p["noOrigin"]]


# --- tests --------------------------------------------------------------------


def test_real_fixture_tracked_content_match_reports_file_line_excerpt_term_and_evidence_command(fx, allowlist):
    result = observe_content([fx["paths"]["canonical"]], allowlist=allowlist, terms=["content"], now=NOW)
    assert result["schema"] == CONTENT_SCHEMA
    checkout = result["checkouts"][0]
    assert checkout["status"] == "observed"
    assert len(checkout["matches"]) == 1
    match = checkout["matches"][0]
    assert match["path"] == "NOTES.md"
    assert match["line"] == 1
    assert match["term"] == "content"
    assert re.search(r"commit b content", match["excerpt"], re.IGNORECASE)
    assert re.match(r"^git .*grep .*-e content", match["evidence"]["command"])

def test_nul_framing_preserves_colon_number_filename_segments():
    parsed = _parse_grep_lines(
        "foo:12:bar.md\0" "7\0" "needle:still-content\n",
        ["needle"],
    )

    assert parsed == {
        "foo:12:bar.md": [
            {
                "path": "foo:12:bar.md",
                "line": 7,
                "rawContent": "needle:still-content",
                "term": "needle",
            }
        ]
    }




def test_tracked_files_only_git_ignored_and_untracked_content_never_appears_in_a_match(fx, allowlist):
    result = observe_content(
        [fx["paths"]["dirty"]], allowlist=allowlist, terms=["untracked", "private", "marker"], now=NOW
    )
    checkout = result["checkouts"][0]
    assert checkout["matches"] == []
    serialized = json.dumps(result)
    assert "private-note" not in serialized
    assert "private_fixture_marker" not in serialized.lower()

def test_tracked_path_added_to_ignore_policy_never_enters_content(fx, allowlist):
    repo = fx["paths"]["dirty"]
    gitignore = os.path.join(repo, ".gitignore")
    original = open(gitignore, encoding="utf-8").read()
    _write(gitignore, original + "tracked.md\n")
    try:
        result = observe_content(
            [repo],
            allowlist=allowlist,
            terms=["modified"],
            now=NOW,
        )
    finally:
        _write(gitignore, original)

    assert result["checkouts"][0]["matches"] == []
    serialized = json.dumps(result)
    assert "tracked.md" not in serialized
    assert any(
        omission.get("kind") == "privacy_matches_excluded"
        for omission in result["checkouts"][0]["omissions"]
    )




def test_ignore_filter_literalizes_git_pathspec_magic():
    magic_path = ":(top)secret.md"

    def run_git(_path, args):
        command = "git " + " ".join(args)
        if "rev-parse" in args:
            return {
                "ok": True,
                "stdout": "a" * 40 + "\n",
                "code": 0,
                "command": command,
            }
        if "check-ignore" in args:
            assert args[-1] == f"./{magic_path}"
            return {
                "ok": True,
                "stdout": f"./{magic_path}\n",
                "code": 0,
                "command": command,
            }
        return {
            "ok": True,
            "stdout": f"{magic_path}\0" + "1\0" + "private marker\n",
            "code": 0,
            "command": command,
        }

    result = observe_content(
        ["C:/fake"],
        allowlist=["C:/fake"],
        terms=["private"],
        run_git=run_git,
        now=NOW,
    )

    checkout = result["checkouts"][0]
    assert checkout["matches"] == []
    assert any(
        omission.get("kind") == "privacy_matches_excluded"
        for omission in checkout["omissions"]
    )


def test_real_git_ignored_pathspec_magic_never_enters_content(tmp_path):
    if os.name == "nt":
        return

    base = str(tmp_path)
    repo = str(tmp_path / "repo")
    magic_path = ":(top)secret.md"
    os.makedirs(repo)
    _write(os.path.join(base, "empty-gitconfig"), "")
    _git(base, repo, ["init", "-q", "-b", "main"])
    _write(os.path.join(repo, magic_path), "private marker\n")
    _git(base, repo, ["add", "--", f"./{magic_path}"])
    _git(base, repo, ["commit", "-q", "-m", "track private fixture"])
    _write(os.path.join(repo, ".gitignore"), f"{magic_path}\n")

    result = observe_content(
        [repo],
        allowlist=[repo],
        terms=["private"],
        now=NOW,
    )

    checkout = result["checkouts"][0]
    assert checkout["matches"] == []
    assert magic_path not in json.dumps(result)
    assert any(
        omission.get("kind") == "privacy_matches_excluded"
        for omission in checkout["omissions"]
    )


@pytest.mark.parametrize(
    "ignore_result",
    [
        {"ok": True, "stdout": "outside.md\n", "code": 0},
        {"ok": False, "stdout": "", "stderr": "unavailable"},
    ],
)
def test_ignore_filter_fails_closed_on_untrusted_output_or_missing_exit_code(
    ignore_result,
):
    def run_git(_path, args):
        command = "git " + " ".join(args)
        if "check-ignore" in args:
            return {**ignore_result, "command": command}
        if "rev-parse" in args:
            return {
                "ok": True,
                "stdout": "a" * 40 + "\n",
                "code": 0,
                "command": command,
            }
        return {
            "ok": True,
            "stdout": "tracked.md\0" + "1\0" + "needle\n",
            "code": 0,
            "command": command,
        }

    result = observe_content(
        ["C:/fake"],
        allowlist=["C:/fake"],
        terms=["needle"],
        run_git=run_git,
        now=NOW,
    )

    checkout = result["checkouts"][0]
    assert checkout["status"] == "unknown"
    assert checkout["reason"] == "ignore_policy_unavailable"
    assert checkout["matches"] == []


def test_capped_runner_returns_when_inherited_stderr_handle_stays_open(
    monkeypatch,
):
    from vivary_core import workspace_observe

    class EofPipe:
        def __init__(self):
            self.closed = False

        def read(self, _size):
            return b""

        def close(self):
            self.closed = True

    class HeldPipe(EofPipe):
        def __init__(self):
            super().__init__()
            self.release = threading.Event()

        def read(self, _size):
            self.release.wait()
            return b""

    class InheritedHandlePopen:
        def __init__(self, *_args, **_kwargs):
            self.stdout = EofPipe()
            self.stderr = HeldPipe()
            self.returncode = 0

        def kill(self):
            self.returncode = -9

        def wait(self, timeout=None):
            return self.returncode

    child = InheritedHandlePopen()
    monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: child)
    monkeypatch.setattr(workspace_observe, "_SUBPROCESS_CLEANUP_TIMEOUT", 0.05)

    outcome = workspace_observe._capped_run(["fake-producer"], {}, limit=64)

    assert outcome["error"] == "stderr drain timed out"
    assert child.stdout.closed is True
    assert child.stderr.closed is False
    child.stderr.release.set()


def test_tracked_uncommitted_working_tree_edit_is_still_searched(fx, allowlist):
    result = observe_content([fx["paths"]["dirty"]], allowlist=allowlist, terms=["modified"], now=NOW)
    checkout = result["checkouts"][0]
    assert len(checkout["matches"]) == 1
    assert checkout["matches"][0]["path"] == "tracked.md"


def test_no_question_terms_configured_no_git_command_runs_every_checkout_reports_no_question_terms(fx, allowlist):
    invoked = []

    def spy_run_git(path, args):
        invoked.append({"path": path, "args": args})
        return {"ok": True, "stdout": "", "command": "git " + " ".join(args)}

    result = observe_content(
        [fx["paths"]["canonical"]], allowlist=allowlist, terms=[], now=NOW, run_git=spy_run_git
    )
    assert invoked == []
    assert result["checkouts"][0]["status"] == "observed"
    assert result["checkouts"][0]["reason"] == "no_question_terms"
    assert result["checkouts"][0]["matches"] == []


def test_a_root_outside_the_allowlist_is_refused_and_no_git_command_runs_against_it(fx, allowlist):
    invoked = []

    def spy_run_git(path, args):
        invoked.append(path)
        return {"ok": True, "stdout": "", "command": "git " + " ".join(args)}

    result = observe_content(
        [fx["paths"]["disallowed"]], allowlist=allowlist, terms=["nope"], now=NOW, run_git=spy_run_git
    )
    assert result["checkouts"] == []
    assert len(result["refusals"]) == 1
    assert result["refusals"][0]["reason"] == "outside_allowlist"
    assert invoked == []


def test_an_explicit_allowlist_is_mandatory(fx):
    with pytest.raises(ValueError, match="allowlist"):
        observe_content([fx["paths"]["canonical"]], terms=["x"])


# --- #71: bad allowlist ENTRIES are rejected at construction, not silently
# treated as a wildcard (mirrors observe.test.mjs's identical guard) ---------


def test_an_empty_string_allowlist_entry_is_refused_outright_not_silently_admitted_as_a_wildcard_71(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_content([fx["paths"]["canonical"]], allowlist=[""], terms=["content"], now=NOW)


def test_a_relative_allowlist_entry_is_refused_outright(fx):
    with pytest.raises(ValueError, match="non-empty absolute path"):
        observe_content([fx["paths"]["canonical"]], allowlist=["relative/path"], terms=["content"], now=NOW)


def test_a_normal_absolute_allowlist_is_unaffected_by_the_71_validation(fx):
    result = observe_content(
        [fx["paths"]["canonical"]], allowlist=[fx["paths"]["canonical"]], terms=["content"], now=NOW
    )
    assert len(result["checkouts"]) == 1
    assert len(result["refusals"]) == 0


def test_git_grep_failure_not_merely_no_matches_is_reported_as_structured_unknown_never_thrown(fx, allowlist):
    def fail_run_git(path, args):
        return {"ok": False, "stdout": "", "stderr": "fatal: not a git repository", "command": "git " + " ".join(args)}

    result = observe_content(
        [fx["paths"]["canonical"]], allowlist=allowlist, terms=["content"], now=NOW, run_git=fail_run_git
    )
    checkout = result["checkouts"][0]
    assert checkout["status"] == "unknown"
    assert checkout["reason"] == "grep_unavailable"
    assert checkout["matches"] == []


def test_bounded_matched_files_per_checkout_matched_lines_per_file_and_excerpt_length_are_all_capped_with_omissions(
    fx, allowlist
):
    file_count = MAX_FILES_PER_CHECKOUT + 3
    lines_per_file = MAX_MATCHES_PER_FILE + 2
    long_line = "x" * (MAX_EXCERPT_LENGTH + 50) + " needle"
    records = []
    for f in range(file_count):
        name = f"file-{f:02d}.md"
        for line_number in range(1, lines_per_file + 1):
            records.append(
                f"{name}\0{line_number}\0{long_line}\n"
            )
    big_stdout = "".join(records)

    big_run_git = content_git_runner(big_stdout)

    result = observe_content(
        [fx["paths"]["canonical"]], allowlist=allowlist, terms=["needle"], now=NOW, run_git=big_run_git
    )
    checkout = result["checkouts"][0]

    paths_seen = {m["path"] for m in checkout["matches"]}
    assert len(paths_seen) == MAX_FILES_PER_CHECKOUT
    for path in paths_seen:
        count = sum(1 for m in checkout["matches"] if m["path"] == path)
        assert count == MAX_MATCHES_PER_FILE
    for match in checkout["matches"]:
        assert len(match["excerpt"]) <= MAX_EXCERPT_LENGTH + 1, "excerpt must respect the length cap (plus ellipsis)"

    files_truncated = next(o for o in checkout["omissions"] if o["kind"] == "content_files_truncated")
    assert files_truncated is not None
    assert files_truncated["omitted_count"] == 3
    assert files_truncated["total_files_matched"] == file_count

    lines_truncated = [o for o in checkout["omissions"] if o["kind"] == "content_lines_truncated"]
    assert len(lines_truncated) == MAX_FILES_PER_CHECKOUT
    for omission in lines_truncated:
        assert omission["omitted_count"] == 2
        assert omission["path"]


def test_observation_is_strictly_read_only_git_trees_are_byte_identical_before_and_after(fx, allowlist):
    target = fx["paths"]["canonical"]
    before_hash = hash_tree(os.path.join(target, ".git"))
    observe_content([target], allowlist=allowlist, terms=["content"], now=NOW)
    after_hash = hash_tree(os.path.join(target, ".git"))
    assert after_hash == before_hash


def test_real_fixture_real_git_grep_a_term_with_no_matches_anywhere_is_a_clean_empty_result_not_an_error(
    fx, allowlist
):
    result = observe_content([fx["paths"]["canonical"]], allowlist=allowlist, terms=["nonexistentzzz"], now=NOW)
    checkout = result["checkouts"][0]
    assert checkout["status"] == "observed"
    assert checkout["matches"] == []
    assert checkout["omissions"] == []


def test_observation_is_deterministic_under_an_injected_clock(fx, allowlist):
    a = observe_content(
        [fx["paths"]["canonical"], fx["paths"]["dirty"]], allowlist=allowlist, terms=["content"], now=NOW
    )
    b = observe_content(
        [fx["paths"]["canonical"], fx["paths"]["dirty"]], allowlist=allowlist, terms=["content"], now=NOW
    )
    assert a == b


def test_question_terms_are_searched_as_fixed_strings(fx, allowlist):
    """`git grep` defaults to basic regular expressions (`-G`).

    A term containing regex syntax therefore matched things it does not name — `.`
    matches any character, so `foo.bar` matches `fooXbar` — and a term such as `.*`
    could make nearly every tracked line look relevant to the question. Evidence
    selection is downstream of this, so a regex term silently widens what a capsule
    claims is relevant.
    """
    repo = fx["paths"]["canonical"]
    base_dir = os.path.dirname(repo)
    _commit_file(base_dir, repo, "regex-probe.md", "fooXbar should not match\n", "probe")

    result = observe_content([repo], allowlist=allowlist, terms=["foo.bar"], now=NOW)

    serialized = json.dumps(result)
    assert "fooXbar" not in serialized, (
        "the term 'foo.bar' was interpreted as a regex and matched 'fooXbar'"
    )


def test_output_cap_terminates_a_runaway_producer():
    """The 4 MiB bound must limit memory, not merely report afterwards.

    `capture_output=True` buffers the whole of stdout before any length check runs,
    so the advertised bound never limited anything: a broad term in a large
    repository could exhaust the worker before the check was reached. This drives an
    unbounded producer, which under the old post-hoc pattern would never return.
    """
    from vivary_core.workspace_content import _capped_run

    producer = [
        sys.executable,
        "-c",
        "import sys\nwhile True: sys.stdout.write('x' * 4096)",
    ]

    outcome = _capped_run(producer, dict(os.environ), limit=64 * 1024)

    assert outcome["exceeded"] is True
    assert len(outcome["stdout"]) <= 64 * 1024 + 4096, "output was buffered past the cap"


def test_capped_runner_survives_a_stderr_flood_from_a_real_child(monkeypatch):
    from vivary_core.workspace_content import _capped_run

    real_popen = subprocess.Popen
    children = []

    def tracking_popen(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", tracking_popen)
    producer = [
        sys.executable,
        "-c",
        "import sys; sys.stderr.write('e' * (4 << 20)); sys.stderr.flush(); "
        "sys.stdout.write('done'); sys.stdout.flush()",
    ]
    box = {}
    runner = threading.Thread(
        target=lambda: box.update(
            result=_capped_run(producer, dict(os.environ), limit=1 << 20)
        ),
        daemon=True,
    )

    runner.start()
    runner.join(5)
    deadlocked = runner.is_alive()
    if deadlocked:
        children[0].kill()
        runner.join(5)

    assert not deadlocked, "_capped_run deadlocked on a full stderr pipe"
    assert box["result"]["stdout"] == b"done"
    assert children
    assert all(child.stdout.closed and child.stderr.closed for child in children)


def test_capped_runner_drains_stdout_and_stderr_concurrently(monkeypatch):
    """A child that fills stderr before stdout must not deadlock the runner."""
    from vivary_core.workspace_content import _capped_run

    class CoordinatedPipe:
        def __init__(self, payload):
            self.payload = payload
            self.started = threading.Event()
            self.peer = None
            self.sent = False

        def read(self, _size):
            self.started.set()
            assert self.peer.started.wait(0.5), "the peer pipe was not drained concurrently"
            if self.sent:
                return b""
            self.sent = True
            return self.payload

        def close(self):
            self.closed = True

    class FullDuplexPopen:
        def __init__(self, *_args, **_kwargs):
            self.stdout = CoordinatedPipe(b"stdout")
            self.stderr = CoordinatedPipe(b"stderr")
            self.stdout.peer = self.stderr
            self.stderr.peer = self.stdout
            self.returncode = 0

        def kill(self):
            self.returncode = -9

        def wait(self, timeout=None):
            return self.returncode

        def communicate(self):
            return b"", b""

    monkeypatch.setattr(subprocess, "Popen", FullDuplexPopen)

    outcome = _capped_run(["fake-producer"], {}, limit=64)

    assert outcome == {
        "error": None,
        "stdout": b"stdout",
        "stderr": b"stderr",
        "code": 0,
        "exceeded": False,
    }
