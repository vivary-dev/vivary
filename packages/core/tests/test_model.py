"""Pytest translation of tests/model.test.mjs (slice 2, ticket #84, decision
0008).

Builds the same real git fixtures as tests/helpers/fixtures.mjs's
buildFixtures (pinned identity/date, isolated global/system config),
re-expressed as local helpers for this one owned file - mirroring
python/tests/test_evidence.py's and python/tests/test_content.py's
precedent of self-contained per-file fixture plumbing rather than a shared
fixtures module.

This suite needs a real observation to project, which means calling
observe_checkouts - a PARALLEL port of src/workspace/observe.mjs into
vivary_core.workspace_observe, landing separately in this same slice. If
that module isn't present yet, the whole file is skipped at collection time
(mirrors python/tests/test_evidence.py's identical
try/except-ImportError-then-skip pattern for its own parallel-port
dependencies) rather than stubbing observe_checkouts here.

The fixture tree is built under the OS temp directory (tempfile.mkdtemp,
with no `dir=` pointing back into this repo) rather than a fixed path under
python/tests/ - a fixed path nested inside this repo's own working tree
means that if a fixture checkout's .git is ever momentarily unreadable
(e.g. a transient lock), git's directory-discovery walk climbs past it and
lands on this repo's OWN .git instead of failing, silently substituting the
real vivary-lattice-lab repository's identity for the fixture's (observed
once during this port's own verification). Building outside any enclosing
git repository makes that escape structurally impossible rather than
merely unlikely.
"""

from __future__ import annotations

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

from vivary_core.canonical import deterministic_id, normalize_path  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402

try:
    from vivary_core.workspace_observe import observe_checkouts
except ImportError as exc:  # pragma: no cover - only until the parallel port lands
    pytest.skip(
        "blocked on vivary_core.workspace_observe (parallel port of src/workspace/observe.mjs "
        f"not landed yet): {exc}",
        allow_module_level=True,
    )

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP = datetime(2026, 7, 2, 0, 0, 0, tzinfo=timezone.utc)


def NOW():
    return "2026-07-20T15:00:00.000Z"


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


@pytest.fixture(scope="module")
def fx():
    base_dir = tempfile.mkdtemp(prefix="vivary-model-fixtures-")
    try:
        yield build_fixtures(base_dir)
    finally:
        _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def observation(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["detached"], p["noOrigin"], p["spaced"]]
    return observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["detached"], p["noOrigin"], p["spaced"]],
        allowlist=allowlist,
        now=NOW,
    )


# --- tests --------------------------------------------------------------------


def test_projection_is_deterministic_same_observation_byte_identical_graph(observation):
    a = project_workspace_graph(observation)
    b = project_workspace_graph(observation)
    assert a == b
    assert json.dumps(a) == json.dumps(b)


def test_node_ids_derive_only_from_stable_identity_not_observation_order(fx, observation):
    graph = project_workspace_graph(observation)
    canonical_id = deterministic_id("checkout", {"path": normalize_path(fx["paths"]["canonical"])})
    assert any(n["id"] == canonical_id for n in graph["nodes"])

    reordered_observation = dict(observation)
    reordered_observation["checkouts"] = list(reversed(observation["checkouts"]))
    reordered = project_workspace_graph(reordered_observation)

    assert sorted(n["id"] for n in graph["nodes"]) == sorted(n["id"] for n in reordered["nodes"])
    assert graph["workspace_fingerprint"] == reordered["workspace_fingerprint"]


def test_canonical_and_stale_neighbor_share_one_repository_node_and_a_preserved_conflict(fx, observation):
    graph = project_workspace_graph(observation)
    repositories = [n for n in graph["nodes"] if n["kind"] == "repository" and n["identity_status"] == "known"]
    assert len(repositories) == 1, "both clones must resolve to one known repository identity"

    assert len(graph["conflicts"]) == 1
    conflict = graph["conflicts"][0]
    assert conflict["kind"] == "divergent_checkouts"
    assert conflict["status"] == "unresolved"
    assert len(conflict["sides"]) == 2
    heads = sorted(s["head_revision"] for s in conflict["sides"])
    assert heads == sorted([fx["shas"]["commitA"], fx["shas"]["commitB"]])
    assert "value_conflict" in conflict["reason_codes"]
    assert "winner" not in conflict, "a conflict must never elect a winner"
    for side in conflict["sides"]:
        assert side["evidence"], "each side carries its evidence"


def test_unknowns_survive_projection_as_first_class_entries(fx, observation):
    graph = project_workspace_graph(observation)
    no_origin_path = normalize_path(fx["paths"]["noOrigin"])
    facts = [u["fact"] for u in graph["unknowns"] if u["path"] == no_origin_path]
    assert "upstream" in facts
    assert "last_fetch" in facts


def test_detached_checkout_produces_no_branch_node_dirty_artifacts_become_nodes(fx, observation):
    graph = project_workspace_graph(observation)
    detached_id = deterministic_id("checkout", {"path": normalize_path(fx["paths"]["detached"])})
    assert not any(e["kind"] == "at_branch" and e["from"] == detached_id for e in graph["edges"])

    dirty_id = deterministic_id("checkout", {"path": normalize_path(fx["paths"]["dirty"])})
    artifacts = [e for e in graph["edges"] if e["kind"] == "dirty_artifact" and e["from"] == dirty_id]
    assert len(artifacts) == 2


def test_refusals_pass_through_and_ignored_private_paths_never_appear_in_the_graph(fx, observation):
    with_refusal = observe_checkouts(
        [fx["paths"]["canonical"], fx["paths"]["disallowed"]],
        allowlist=[fx["paths"]["canonical"]],
        now=NOW,
    )
    graph = project_workspace_graph(with_refusal)
    assert len(graph["refusals"]) == 1
    assert graph["refusals"][0]["reason"] == "outside_allowlist"
    assert "private-note" not in json.dumps(project_workspace_graph(observation))


def test_linked_worktrees_of_a_no_remote_repo_share_one_repository_and_conflict(fx):
    """A repository without a remote must surface divergence exactly like one with.

    Identity fell back to `local:<path>`, so each linked worktree of the same
    repository became its own repository node — and the divergent-checkout conflict,
    the precise ambiguity this graph exists to surface, never fired. A local-only
    repo is not a second-class repo; it just has no remote to name it.
    """
    from vivary_core.workspace_observe import observe_checkouts

    base = tempfile.mkdtemp(prefix="vivary-worktree-")
    try:
        main_wt = os.path.join(base, "main-wt")
        os.makedirs(main_wt)
        _git(base, main_wt, ["init", "-q", "-b", "main", "."])
        _write(os.path.join(main_wt, "a.txt"), "one\n")
        _git(base, main_wt, ["add", "a.txt"])
        _git(base, main_wt, ["commit", "-q", "-m", "one"])

        linked = os.path.join(base, "linked-wt")
        _git(base, main_wt, ["worktree", "add", "-q", "-b", "side", linked])
        _write(os.path.join(linked, "b.txt"), "two\n")
        _git(base, linked, ["add", "b.txt"])
        _git(base, linked, ["commit", "-q", "-m", "two"])

        observation = observe_checkouts([main_wt, linked], allowlist=[base], now=NOW)
        graph = project_workspace_graph(observation)

        repositories = [n for n in graph["nodes"] if n["kind"] == "repository"]
        assert len(repositories) == 1, (
            "linked worktrees of one repository must resolve to a single repository "
            f"node, got {[r['identity'] for r in repositories]}"
        )

        divergent = [c for c in graph["conflicts"] if c["kind"] == "divergent_checkouts"]
        assert len(divergent) == 1, (
            "two worktrees at different revisions must surface as a divergence"
        )
        assert len(divergent[0]["sides"]) == 2
    finally:
        _rmtree_force(base)
