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
from vivary_core.workspace_model import (  # noqa: E402
    project_workspace_graph,
    repair_graph_is_canonical,
    workspace_facts_are_valid,
    workspace_fingerprint_from_graph,
)

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
    base_dir = os.path.realpath(tempfile.mkdtemp(prefix="vivary-model-fixtures-"))
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

def _known_workspace_facts():
    return {
        "is_git_repository": {"status": "known", "value": True},
        "worktree_root": {"status": "known", "value": "/repo"},
        "git_common_dir": {"status": "known", "value": "/repo/.git"},
        "head_revision": {"status": "known", "value": "a" * 40},
        "head_ref": {
            "status": "known",
            "value": {"kind": "branch", "name": "main"},
        },
        "dirty_entries": {
            "status": "known",
            "value": [{"path": "README.md", "state": " M"}],
        },
        "is_dirty": {"status": "known", "value": True},
        "remotes": {
            "status": "known",
            "value": [
                {
                    "name": "origin",
                    "fetch_url": "https://example.test/repo.git",
                }
            ],
        },
        "upstream": {"status": "known", "value": "origin/main"},
        "last_fetch": {"status": "known", "value": "2026-07-02T00:00:00.000Z"},
        "workspace_markers": {"status": "known", "value": ["package.json"]},
        "npm_test_script": {"status": "known", "value": "pytest -q"},
    }


def _workspace_observation(facts):
    return {
        "observed_at": NOW(),
        "allowlist": ["/repo"],
        "refusals": [],
        "checkouts": [{"path": "/repo", "facts": facts}],
    }


def test_projection_is_deterministic_same_observation_byte_identical_graph(observation):
    a = project_workspace_graph(observation)
    b = project_workspace_graph(observation)
    assert a == b
    assert json.dumps(a) == json.dumps(b)

def test_projection_rejects_duplicate_checkout_identities(observation):
    duplicated = json.loads(json.dumps(observation))
    duplicated["checkouts"].append(
        json.loads(json.dumps(duplicated["checkouts"][0]))
    )

    with pytest.raises(
        ValueError, match="duplicate checkout identities"
    ):
        project_workspace_graph(duplicated)


def test_workspace_fingerprint_commits_to_worktree_root(observation):
    honest = project_workspace_graph(observation)
    forged_observation = json.loads(json.dumps(observation))
    checkout = next(
        item
        for item in forged_observation["checkouts"]
        if (item["facts"].get("worktree_root") or {}).get("status") == "known"
    )
    checkout["facts"]["worktree_root"]["value"] = "/forged/worktree"
    forged = project_workspace_graph(forged_observation)

    assert forged["workspace_fingerprint"] != honest["workspace_fingerprint"]

    retained_fingerprint = json.loads(json.dumps(honest))
    graph_checkout = next(
        node
        for node in retained_fingerprint["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("worktree_root") or {}).get("status") == "known"
    )
    graph_checkout["facts"]["worktree_root"]["value"] = "/forged/worktree"
    assert (
        workspace_fingerprint_from_graph(retained_fingerprint)
        != retained_fingerprint["workspace_fingerprint"]
    )
    assert not repair_graph_is_canonical(retained_fingerprint)


@pytest.mark.parametrize(
    "fact_name",
    [
        "is_git_repository",
        "git_common_dir",
        "workspace_markers",
        "npm_test_script",
    ],
)
def test_workspace_fingerprint_commits_gate_driving_fact_records(fact_name):
    graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": ["/repo"],
            "refusals": [],
            "checkouts": [
                {
                    "path": "/repo",
                    "facts": {
                        "is_git_repository": {
                            "status": "known",
                            "value": True,
                            "evidence": [],
                        },
                        "git_common_dir": {
                            "status": "known",
                            "value": "/repo/.git",
                            "evidence": [],
                        },
                        "workspace_markers": {
                            "status": "known",
                            "value": ["tropo.toml"],
                            "evidence": [],
                        },
                        "npm_test_script": {
                            "status": "known",
                            "value": "vitest run",
                            "evidence": [],
                        },
                    },
                }
            ],
        }
    )
    forged = json.loads(json.dumps(graph))
    checkout = next(
        node for node in forged["nodes"] if node["kind"] == "checkout"
    )
    checkout["facts"][fact_name] = {
        "status": "unknown",
        "reason": "forged",
        "evidence": [],
    }

    assert (
        workspace_fingerprint_from_graph(forged)
        != graph["workspace_fingerprint"]
    )


def test_projection_rejects_invalid_fact_status():
    with pytest.raises(ValueError, match="fact status"):
        project_workspace_graph(
            {
                "observed_at": NOW(),
                "allowlist": ["/repo"],
                "refusals": [],
                "checkouts": [
                    {
                        "path": "/repo",
                        "facts": {
                            "is_git_repository": {
                                "status": "bogus",
                                "value": True,
                                "evidence": [],
                            }
                        },
                    }
                ],
            }
        )

@pytest.mark.parametrize(
    "fact_name",
    (
        "is_git_repository",
        "worktree_root",
        "git_common_dir",
        "head_revision",
        "head_ref",
        "dirty_entries",
        "is_dirty",
        "remotes",
        "upstream",
        "last_fetch",
        "workspace_markers",
        "npm_test_script",
    ),
)
def test_workspace_facts_reject_known_gate_facts_without_value(fact_name):
    facts = _known_workspace_facts()
    facts[fact_name] = {"status": "known"}

    assert not workspace_facts_are_valid(facts)


@pytest.mark.parametrize(
    ("fact_name", "invalid_value"),
    (
        pytest.param(
            "is_git_repository",
            "yes",
            id="is_git_repository-requires-bool",
        ),
        pytest.param("is_dirty", "yes", id="is_dirty-requires-bool"),
        pytest.param("worktree_root", 1, id="worktree_root-requires-string"),
        pytest.param(
            "npm_test_script",
            "",
            id="npm_test_script-requires-nonblank-string",
        ),
        pytest.param(
            "workspace_markers",
            [1],
            id="workspace_markers-requires-list-of-strings",
        ),
        pytest.param(
            "head_ref",
            {"kind": "branch"},
            id="head_ref-requires-complete-ref-shape",
        ),
        pytest.param("head_ref", "main", id="head_ref-requires-mapping"),
        pytest.param(
            "dirty_entries",
            [{"path": "README.md", "state": 1}],
            id="dirty_entries-requires-string-state",
        ),
        pytest.param(
            "dirty_entries",
            "M README.md",
            id="dirty_entries-requires-list",
        ),
        pytest.param(
            "remotes",
            [{"name": "origin", "fetch_url": 1}],
            id="remotes-requires-string-urls",
        ),
    ),
)
def test_workspace_facts_reject_wrong_semantic_values_for_gate_categories(
    fact_name, invalid_value
):
    facts = _known_workspace_facts()
    facts[fact_name]["value"] = invalid_value

    assert not workspace_facts_are_valid(facts)


@pytest.mark.parametrize(
    "path",
    (
        "/outside/private.txt",
        "../secret",
        "c:secret",
        "c:/outside/private.txt",
        "",
        r"dir\secret",
        "dir/secret/",
        " secret",
    ),
)
def test_workspace_facts_reject_unsafe_dirty_entry_paths(path):
    facts = _known_workspace_facts()
    facts["dirty_entries"]["value"] = [{"path": path, "state": "M"}]

    assert not workspace_facts_are_valid(facts)
    with pytest.raises(ValueError, match="invalid fact"):
        project_workspace_graph(_workspace_observation(facts))


@pytest.mark.parametrize("path", ("tracked.md", "dir/tracked.md"))
def test_workspace_facts_accept_safe_checkout_relative_dirty_entry_paths(path):
    facts = _known_workspace_facts()
    facts["dirty_entries"]["value"] = [{"path": path, "state": "M"}]

    assert workspace_facts_are_valid(facts)


def test_projection_rejects_known_is_dirty_without_value():
    facts = _known_workspace_facts()
    facts["is_dirty"] = {"status": "known"}

    with pytest.raises(ValueError, match="invalid fact"):
        project_workspace_graph(_workspace_observation(facts))


def test_workspace_fact_validation_and_projection_preserve_valid_unknowns():
    facts = _known_workspace_facts()
    facts["is_dirty"] = {
        "status": "unknown",
        "reason": "status_unavailable",
    }

    assert workspace_facts_are_valid(facts)
    graph = project_workspace_graph(_workspace_observation(facts))
    assert graph["unknowns"] == [
        {
            "checkout": deterministic_id("checkout", {"path": "/repo"}),
            "path": "/repo",
            "fact": "is_dirty",
            "reason": "status_unavailable",
        }
    ]
    assert repair_graph_is_canonical(graph)


def test_repair_graph_canonicality_requires_allowlist_field():
    graph = project_workspace_graph(_workspace_observation(_known_workspace_facts()))
    del graph["allowlist"]

    assert not repair_graph_is_canonical(graph)


def test_workspace_fingerprint_and_canonicality_preserve_refusals():
    graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": ["/repo"],
            "refusals": [
                {
                    "path": "/outside",
                    "status": "refused",
                    "reason": "outside_allowlist",
                }
            ],
            "checkouts": [],
        }
    )
    assert repair_graph_is_canonical(graph)

    removed = json.loads(json.dumps(graph))
    removed["refusals"] = []
    assert (
        workspace_fingerprint_from_graph(removed)
        != graph["workspace_fingerprint"]
    )
    assert not repair_graph_is_canonical(removed)


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
def test_windows_common_dir_identity_groups_remote_less_worktrees():
    def checkout(path, common_dir, head):
        return {
            "path": path,
            "facts": {
                "is_git_repository": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "git_common_dir": {
                    "status": "known",
                    "value": common_dir,
                    "evidence": [],
                },
                "head_revision": {
                    "status": "known",
                    "value": head,
                    "evidence": [],
                },
                "remotes": {
                    "status": "known",
                    "value": [],
                    "evidence": [],
                },
            },
        }

    graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [
                checkout("c:/Worktree-A", "c:/Repo/.git", "a" * 40),
                checkout("c:/Worktree-B", "c:/repo/.git", "b" * 40),
            ],
        }
    )

    repositories = [
        node for node in graph["nodes"] if node["kind"] == "repository"
    ]
    assert len(repositories) == 1
    assert repositories[0]["identity"] == "local:c:/repo/.git"
    assert len(graph["conflicts"]) == 1



def test_unknowns_survive_projection_as_first_class_entries(fx, observation):
    graph = project_workspace_graph(observation)
    no_origin_path = normalize_path(fx["paths"]["noOrigin"])
    facts = [u["fact"] for u in graph["unknowns"] if u["path"] == no_origin_path]
    assert "upstream" in facts
    assert "last_fetch" in facts


def test_repair_graph_canonicality_binds_recomputable_derived_content():
    graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [
                {
                    "path": "/repo/checkout",
                    "facts": {
                        "is_git_repository": {
                            "status": "known",
                            "value": True,
                            "evidence": [],
                        },
                        "git_common_dir": {
                            "status": "known",
                            "value": "/repo/shared/.git",
                            "evidence": ["common-dir"],
                        },
                        "last_fetch": {
                            "status": "unknown",
                            "reason": "not_observed",
                            "evidence": [],
                        },
                    },
                }
            ],
        }
    )
    assert repair_graph_is_canonical(graph)
    forged_field = json.loads(json.dumps(graph))
    forged_field["forged"] = True
    assert not repair_graph_is_canonical(forged_field)

    unnormalized_allowlist = json.loads(json.dumps(graph))
    unnormalized_allowlist["allowlist"] = ["/repo/"]
    assert not repair_graph_is_canonical(unnormalized_allowlist)

    missing_unknown = json.loads(json.dumps(graph))
    missing_unknown["unknowns"] = []
    assert not repair_graph_is_canonical(missing_unknown)

    forged_unknown = json.loads(json.dumps(graph))
    checkout = next(
        node for node in forged_unknown["nodes"] if node["kind"] == "checkout"
    )
    forged_unknown["unknowns"].append(
        {
            "checkout": checkout["id"],
            "path": checkout["path"],
            "fact": "totally_made_up",
            "reason": "forged",
        }
    )
    assert not repair_graph_is_canonical(forged_unknown)

    forged_status = json.loads(json.dumps(graph))
    repository = next(
        node for node in forged_status["nodes"] if node["kind"] == "repository"
    )
    repository["identity_status"] = "known"
    assert not repair_graph_is_canonical(forged_status)

    forged_label = json.loads(json.dumps(graph))
    checkout = next(
        node for node in forged_label["nodes"] if node["kind"] == "checkout"
    )
    checkout["label"] = "forged"
    assert not repair_graph_is_canonical(forged_label)

    forged_evidence = json.loads(json.dumps(graph))
    checkout_of = next(
        edge for edge in forged_evidence["edges"] if edge["kind"] == "checkout_of"
    )
    checkout_of["evidence"] = ["forged"]
    assert not repair_graph_is_canonical(forged_evidence)


def test_repair_graph_canonicality_binds_non_git_unknown_projection():
    graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [
                {
                    "path": "/repo/not-git",
                    "facts": {
                        "is_git_repository": {
                            "status": "unknown",
                            "reason": "not_a_git_repository_or_git_failed",
                            "evidence": [],
                        },
                    },
                }
            ],
        }
    )

    assert graph["unknowns"] == [
        {
            "checkout": deterministic_id(
                "checkout", {"path": "/repo/not-git"}
            ),
            "path": "/repo/not-git",
            "fact": "is_git_repository",
            "reason": "not_a_git_repository_or_git_failed",
        }
    ]
    assert repair_graph_is_canonical(graph)
    discarded_unknown_graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [
                {
                    "path": "/repo/known-not-git",
                    "facts": {
                        "is_git_repository": {
                            "status": "known",
                            "value": False,
                            "evidence": [],
                        },
                        "head_revision": {
                            "status": "unknown",
                            "reason": "not_observed",
                            "evidence": [],
                        },
                    },
                }
            ],
        }
    )
    assert discarded_unknown_graph["unknowns"] == []
    assert repair_graph_is_canonical(discarded_unknown_graph)

    empty_facts_graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [{"path": "/repo/no-facts", "facts": {}}],
        }
    )
    assert repair_graph_is_canonical(empty_facts_graph)

    forged_unknown = json.loads(json.dumps(graph))
    forged_unknown["unknowns"].append(
        {
            "checkout": deterministic_id(
                "checkout", {"path": "/repo/not-git"}
            ),
            "path": "/repo/not-git",
            "fact": "last_fetch",
            "reason": "forged",
        }
    )
    assert not repair_graph_is_canonical(forged_unknown)


def test_repair_graph_canonicality_normalizes_neighbors_and_binds_omissions():
    def checkout(index):
        return {
            "path": f"/repo/checkout-{index}",
            "facts": {
                "is_git_repository": {
                    "status": "known",
                    "value": True,
                    "evidence": [],
                },
                "git_common_dir": {
                    "status": "known",
                    "value": "/repo/shared/.git",
                    "evidence": [],
                },
            },
        }

    neighbor_graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [checkout(0), checkout(1)],
        }
    )
    neighbor = next(
        edge
        for edge in neighbor_graph["edges"]
        if edge["kind"] == "neighbor_of"
    )
    neighbor["from"], neighbor["to"] = neighbor["to"], neighbor["from"]
    neighbor["id"] = deterministic_id(
        "edge",
        {
            "kind": neighbor["kind"],
            "from": neighbor["from"],
            "to": neighbor["to"],
        },
    )
    assert repair_graph_is_canonical(neighbor_graph)
    neighbor["id"] = "edge:forged"
    assert not repair_graph_is_canonical(neighbor_graph)

    capped_graph = project_workspace_graph(
        {
            "observed_at": NOW(),
            "allowlist": [],
            "refusals": [],
            "checkouts": [checkout(index) for index in range(301)],
        }
    )
    assert capped_graph["omissions"]
    assert repair_graph_is_canonical(capped_graph)

    omission = capped_graph["omissions"].pop()
    assert not repair_graph_is_canonical(capped_graph)
    capped_graph["omissions"].append(omission)
    omission["reason"] = "forged"
    assert not repair_graph_is_canonical(capped_graph)


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

    base = os.path.realpath(tempfile.mkdtemp(prefix="vivary-worktree-"))
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
