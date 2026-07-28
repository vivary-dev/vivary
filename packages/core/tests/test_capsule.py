"""Translation of tests/capsule.test.mjs (slice 2, decision 0008) for the
Python port (python/vivary_core/capsule_compile.py, capsule_select.py).

Node's capsule.test.mjs builds its `graph` fixture (and, for the
content-match tests, its `content` fixture) via a `before()` hook that calls
observeCheckouts (src/workspace/observe.mjs) and projectWorkspaceGraph
(src/workspace/model.mjs) over real disposable git repositories built by
tests/helpers/fixtures.mjs. Those Python ports (workspace_observe.py /
workspace_model.py) now live in python/vivary_core/, so this file builds the
same real git fixtures - pinned identity/date, isolated global/system config
- as a module-scoped pytest fixture and runs the pipeline for real, mirroring
python/tests/test_model.py's/test_content.py's precedent of self-contained
per-file fixture plumbing rather than a shared fixtures module.

Two tests need no such pipeline and are translated directly:
  - the dirty-path-truncation test, which builds its workspace graph inline
    as a plain dict (mirroring the Node test's inline `bigDirtyGraph`);
  - the purity check, translated to its Python-idiomatic equivalent: no
    filesystem or subprocess access from the pure compiler modules.

The fixture tree is built under the OS temp directory (tempfile.mkdtemp,
with no `dir=` pointing back into this repo) rather than a fixed path under
python/tests/ - a fixed path nested inside this repo's own working tree
means that if a fixture checkout's .git is ever momentarily unreadable
(e.g. a transient lock), git's directory-discovery walk climbs past it and
lands on this repo's OWN .git instead of failing, silently substituting the
real vivary-lattice-lab repository's identity for the fixture's. Building
outside any enclosing git repository makes that escape structurally
impossible rather than merely unlikely (see python/tests/test_model.py's
identical rationale).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

from vivary_core.canonical import normalize_path  # noqa: E402
from vivary_core.capsule_compile import compile_task_capsule  # noqa: E402
from vivary_core.workspace_content import observe_content  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402
from vivary_core.workspace_observe import observe_checkouts  # noqa: E402

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP_EPOCH = 1782000000.0  # 2026-07-02T00:00:00Z


def NOW():
    return "2026-07-20T15:00:00.000Z"


TASK = {"question": "Which local checkout of the shared origin reflects current repository truth?"}


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
    os.utime(canonical_fetch_head, (FETCH_STAMP_EPOCH, FETCH_STAMP_EPOCH))
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
    base_dir = tempfile.mkdtemp(prefix="vivary-capsule-fixtures-")
    try:
        yield build_fixtures(base_dir)
    finally:
        _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def graph(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"], p["disallowed"]],
        allowlist=allowlist,
        now=NOW,
    )
    return project_workspace_graph(observation)


# -- tests over the real observe/model pipeline ------------------------------


def test_every_included_claim_carries_a_selection_reason_and_evidence(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert len(capsule["claims"]) > 0
    for claim in capsule["claims"]:
        assert claim.get("selection_reason"), f"claim {claim['id']} lacks selection_reason"
        assert isinstance(claim.get("evidence"), list) and len(claim["evidence"]) > 0, (
            f"claim {claim['id']} lacks evidence"
        )
        assert claim["status"] in ("known", "inferred")


def test_selection_is_bounded_by_budget_and_the_overflow_is_recorded_as_an_omission(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 5})
    assert len(capsule["claims"]) == 5
    overflow = next((o for o in capsule["omissions"] if o["kind"] == "claims_over_budget"), None)
    assert overflow is not None
    assert overflow["omitted_count"] > 0


def test_conflicts_survive_compilation_with_both_sides_and_review_required(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert len(capsule["conflicts"]) == 1
    conflict = capsule["conflicts"][0]
    assert conflict["decision"] == "review_required"
    assert len(conflict["sides"]) == 2
    assert conflict["status"] == "unresolved"


def test_unknowns_pass_through_unreduced(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert capsule["unknowns"] == graph["unknowns"]
    assert len(capsule["unknowns"]) > 0


def test_refused_roots_and_ignored_path_policy_are_visible_omissions_no_private_path_leaks(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert any(o["kind"] == "refused_root" and o["reason"] == "outside_allowlist" for o in capsule["omissions"])
    assert any(o["kind"] == "ignored_paths_excluded" for o in capsule["omissions"])
    serialized = json.dumps(capsule)
    assert "private-note" not in serialized
    assert "secrets/" not in serialized


def test_capsule_fingerprint_is_deterministic_and_sensitive_to_content(graph):
    a = compile_task_capsule(task=TASK, graph=graph)
    b = compile_task_capsule(task=TASK, graph=graph)
    assert a["fingerprint"] == b["fingerprint"]
    assert a["capsule_id"] == b["capsule_id"]
    smaller = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 3})
    assert a["fingerprint"] != smaller["fingerprint"]


def test_capsule_binds_the_workspace_fingerprint_it_was_compiled_against(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert capsule["workspace"]["fingerprint"] == graph["workspace_fingerprint"]
    # Checks are derived from what was observed, so a plain git fixture with no
    # tropo.toml and no package.json yields none rather than three invented ones.
    assert capsule["required_checks"] == []


# -- dirty_entries claims (#44 gap 1) ---------------------------------------
# Observation carries individual dirty paths as `dirty_entries` (an array of
# {state, path}); compilation previously emitted only the `is_dirty` boolean.
# The observation boundary now removes paths covered by repository ignore policy
# and makes the fact unknown when that policy cannot be proved, so compilation may
# safely project only known dirty entries.


def test_a_dirty_checkout_gets_a_bounded_dirty_entries_claim_naming_its_paths_and_exact_count(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    dirty_claim = next((c for c in capsule["claims"] if c["fact"] == "dirty_entries"), None)
    assert dirty_claim is not None, "expected a dirty_entries claim for the dirty fixture checkout"
    assert dirty_claim["subject_path"].endswith("dirty")
    assert re.search(r"tracked\.md", dirty_claim["claim"])
    assert re.search(r"untracked\.md", dirty_claim["claim"])
    assert re.search(r"\b2\b", dirty_claim["claim"]), "exact total dirty-entry count must appear in the claim text"
    assert isinstance(dirty_claim["evidence"], list) and len(dirty_claim["evidence"]) > 0


def test_clean_checkouts_never_get_a_dirty_entries_claim(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 100})
    dirty_subjects = {c["subject_path"] for c in capsule["claims"] if c["fact"] == "dirty_entries"}
    assert len(dirty_subjects) == 1
    for path in dirty_subjects:
        assert path.endswith("dirty")


def test_git_ignored_paths_never_appear_in_a_dirty_entries_claim(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 100})
    serialized = json.dumps(capsule)
    assert "private-note" not in serialized
    assert "secrets/" not in serialized


# -- optional content input (#44 gap 2) --------------------------------------
# compile_task_capsule(task=..., graph=..., content=...) accepts the
# (optional) output of observe_content (workspace_content.py). Absent content
# must be byte-identical to today's behavior; present content contributes
# bounded content_match candidate claims, intrinsically question-matched.


def test_absent_content_is_byte_identical_to_today(graph):
    omitted = compile_task_capsule(task=TASK, graph=graph)
    explicit_none = compile_task_capsule(task=TASK, graph=graph, content=None)
    assert omitted["fingerprint"] == explicit_none["fingerprint"]
    empty_content = compile_task_capsule(task=TASK, graph=graph, content={"checkouts": []})
    assert omitted["fingerprint"] == empty_content["fingerprint"]


def test_content_matches_become_bounded_content_match_candidate_claims_intrinsically_question_matched(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]], allowlist=allowlist, now=NOW
    )
    content_graph = project_workspace_graph(observation)
    # "modified" only appears in the dirty checkout's tracked.md working-tree
    # edit; the dirty checkout is not a conflict side (only canonical/
    # stale-neighbor share an origin), so this isolates the intrinsic
    # content_term_match signal from conflict_side's higher-priority tier.
    content = observe_content(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]],
        allowlist=allowlist,
        terms=["modified"],
        now=NOW,
    )

    task = {"question": "What modified files exist?"}
    without_content = compile_task_capsule(task=task, graph=content_graph)
    with_content = compile_task_capsule(task=task, graph=content_graph, content=content)

    assert with_content["fingerprint"] != without_content["fingerprint"]
    content_claim = next((c for c in with_content["claims"] if c["fact"] == "content_match"), None)
    assert content_claim is not None, "expected a content_match claim once content is supplied"
    assert re.search(r"tracked\.md", content_claim["claim"])
    assert re.search(r"modified", content_claim["claim"], re.IGNORECASE)
    assert content_claim["subject_path"].endswith("dirty")
    assert content_claim["selection"]["tier"] == "question_match"
    signal = next(s for s in content_claim["selection"]["signals"] if s["signal"] == "content_term_match")
    assert signal is not None, "expected an intrinsic content_term_match signal"
    assert signal["term"] == "modified"
    assert isinstance(content_claim["evidence"], list) and len(content_claim["evidence"]) > 0
    # The intrinsic ranking hint never leaks into the public claim shape.
    assert "intrinsic_signals" not in content_claim


def test_a_content_match_on_a_conflict_side_checkout_still_ranks_conflict_side(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"]]
    observation = observe_checkouts([p["canonical"], p["staleNeighbor"]], allowlist=allowlist, now=NOW)
    conflict_graph = project_workspace_graph(observation)
    content = observe_content([p["canonical"], p["staleNeighbor"]], allowlist=allowlist, terms=["content"], now=NOW)
    capsule = compile_task_capsule(
        task={"question": "What is the content of the note file?"}, graph=conflict_graph, content=content
    )
    content_claim = next((c for c in capsule["claims"] if c["fact"] == "content_match"), None)
    assert content_claim is not None
    assert content_claim["selection"]["tier"] == "conflict_side"
    signal = next((s for s in content_claim["selection"]["signals"] if s["signal"] == "content_term_match"), None)
    assert signal is not None, "the intrinsic signal is still recorded even when conflict_side determines the tier"


def test_content_match_candidates_outside_the_graphs_checkouts_are_ignored_never_guessed_at(graph):
    content = {
        "checkouts": [
            {
                "path": "not/a/graph/checkout",
                "matches": [
                    {"path": "x.md", "line": 1, "excerpt": "x", "term": "x", "evidence": {"command": "git grep"}}
                ],
                "omissions": [],
            },
        ]
    }
    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)
    assert not any(c["fact"] == "content_match" for c in capsule["claims"])


def test_content_omissions_surface_into_capsule_omissions(graph):
    dirty_node = next(n for n in graph["nodes"] if n["kind"] == "checkout" and n["path"].endswith("dirty"))
    content = {
        "checkouts": [
            {
                "path": dirty_node["path"],
                "matches": [],
                "omissions": [{"kind": "content_files_truncated", "omitted_count": 2, "total_files_matched": 10}],
            },
        ]
    }
    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)
    surfaced = next(o for o in capsule["omissions"] if o["kind"] == "content_files_truncated")
    assert surfaced["omitted_count"] == 2
    assert surfaced["total_files_matched"] == 10
    assert surfaced["subject"] == dirty_node["id"]


# -- dirty_entries claims (#44 gap 1), continued -----------------------------
# observe.mjs already carries the individual dirty paths as `dirty_entries`
# (a list of {state, path}); this is compile.mjs's own bounded-listing
# behavior over an inline synthetic graph, independent of the fixture
# pipeline - mirrors tests/capsule.test.mjs's inline `bigDirtyGraph` exactly.

def _big_dirty_graph():
    return {
        "schema": "vivary.workspace-graph/v0",
        "observed_at": NOW(),
        "allowlist": ["synthetic://big-dirty"],
        "workspace_fingerprint": "sha256:test-big-dirty",
        "nodes": [
            {
                "id": "checkout_bigdirty",
                "kind": "checkout",
                "label": "big-dirty",
                "path": "synthetic://big-dirty",
                "facts": {
                    "is_git_repository": {
                        "status": "known",
                        "value": True,
                        "evidence": {"command": "git rev-parse --show-toplevel"},
                    },
                    "head_revision": {
                        "status": "known",
                        "value": "0" * 40,
                        "evidence": {"command": "git rev-parse HEAD"},
                    },
                    "head_ref": {
                        "status": "known",
                        "value": {"kind": "branch", "name": "main"},
                        "evidence": {"command": "git symbolic-ref --short -q HEAD"},
                    },
                    "is_dirty": {
                        "status": "known",
                        "value": True,
                        "evidence": {"command": "git status --porcelain"},
                    },
                    "dirty_entries": {
                        "status": "known",
                        "value": [
                            {"state": "M", "path": f"file-{i:02d}.md"} for i in range(15)
                        ],
                        "evidence": {"command": "git status --porcelain"},
                    },
                    "remotes": {
                        "status": "known",
                        "value": [],
                        "evidence": {"command": "git remote -v"},
                    },
                    "last_fetch": {
                        "status": "unknown",
                        "reason": "no_fetch_recorded",
                        "evidence": {"command": "fs.stat FETCH_HEAD"},
                    },
                },
            }
        ],
        "edges": [],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
    }


def test_dirty_path_listing_is_capped_overflow_is_recorded_as_a_dirty_paths_truncated_omission_with_the_exact_count():
    big_dirty_graph = _big_dirty_graph()
    capsule = compile_task_capsule(task={"question": "which files are dirty?"}, graph=big_dirty_graph)
    dirty_claim = next((c for c in capsule["claims"] if c["fact"] == "dirty_entries"), None)
    assert dirty_claim is not None
    assert re.search(r"\b15\b", dirty_claim["claim"]), "exact total count always appears, even when the listing is capped"
    truncated = next((o for o in capsule["omissions"] if o["kind"] == "dirty_paths_truncated"), None)
    assert truncated is not None, "expected a dirty_paths_truncated omission when the cap is exceeded"
    assert truncated["omitted_count"] == 5


# -- compile_task_capsule stays pure ------------------------------------------
# Node's version asserts src/capsule/*.mjs never imports node:fs or
# node:child_process. The Python-idiomatic equivalent: the pure compiler
# modules never reference filesystem or subprocess access.

def test_capsule_compile_modules_never_import_filesystem_or_subprocess_access():
    module_dir = os.path.join(PY_ROOT, "vivary_core")
    files = ["capsule_compile.py", "capsule_select.py"]
    assert len(files) > 0
    for name in files:
        with open(os.path.join(module_dir, name), encoding="utf-8") as fh:
            source = fh.read()
        assert not re.search(r"^\s*(import|from)\s+subprocess\b", source, re.MULTILINE), (
            f"{name} must not import subprocess"
        )
        assert "os.open(" not in source and "open(" not in source, f"{name} must not open files"


# -- additional inline-graph coverage (not a Node test translation) ---------
# The skipped fixture-pipeline tests above are the only Node coverage for the
# question_match/content_match tiers and the whole `content=` code path
# (_content_match_candidates, intrinsic_signals stripping, content-omission
# surfacing). Rather than leave that logic completely unexercised while the
# pipeline is unavailable, this hand-built graph (same category as the
# dirty-path-truncation test above and the selection module's synthetic
# `describe` block: no observe/model dependency) restores coverage for it.

def _tiered_graph():
    return {
        "nodes": [
            # No conflicts, no label/branch term match -> exercises the
            # content_term_match branch of rank_claim (tier "question_match"
            # via intrinsic signal only, not the subject's own profile).
            {
                "id": "checkout_gadget",
                "kind": "checkout",
                "label": "gadget",
                "path": "/w/gadget",
                "facts": {
                    "is_git_repository": {"status": "known", "value": True},
                    "head_revision": {
                        "status": "known",
                        "value": "a" * 40,
                        "evidence": {"command": "git rev-parse HEAD"},
                    },
                },
            },
            # Label matches a question term directly -> exercises the
            # question_term_match branch of rank_claim.
            {
                "id": "checkout_labelmatch",
                "kind": "checkout",
                "label": "modified",
                "path": "/w/labelmatch",
                "facts": {
                    "is_git_repository": {"status": "known", "value": True},
                    "head_revision": {
                        "status": "known",
                        "value": "b" * 40,
                        "evidence": {"command": "git rev-parse HEAD"},
                    },
                },
            },
            # No conflict, no term match anywhere -> baseline "allowlisted" tier.
            {
                "id": "checkout_baseline",
                "kind": "checkout",
                "label": "quiet",
                "path": "/w/baseline",
                "facts": {
                    "is_git_repository": {"status": "known", "value": True},
                    "head_revision": {
                        "status": "known",
                        "value": "c" * 40,
                        "evidence": {"command": "git rev-parse HEAD"},
                    },
                },
            },
        ],
        "edges": [],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
        "allowlist": ["/w/gadget", "/w/labelmatch", "/w/baseline"],
        "workspace_fingerprint": "sha256:tiered-test",
        "observed_at": NOW(),
    }


TIERED_TASK = {"question": "What contains modified content?"}


def test_question_term_match_tier_ranks_via_label_and_names_term_and_field():
    graph = _tiered_graph()
    capsule = compile_task_capsule(task=TIERED_TASK, graph=graph)
    label_claim = next(c for c in capsule["claims"] if c["subject"] == "checkout_labelmatch")
    assert label_claim["selection"]["tier"] == "question_match"
    signal = next(s for s in label_claim["selection"]["signals"] if s["signal"] == "question_term_match")
    assert signal["term"] == "modified"
    assert signal["field"] == "label"
    assert "'modified'" in label_claim["selection_reason"]


def test_allowlisted_tier_is_the_baseline_with_no_task_specific_signal():
    graph = _tiered_graph()
    capsule = compile_task_capsule(task=TIERED_TASK, graph=graph)
    baseline_claim = next(c for c in capsule["claims"] if c["subject"] == "checkout_baseline")
    assert baseline_claim["selection"]["tier"] == "allowlisted"
    assert baseline_claim["selection"]["signals"] == [{"signal": "allowlisted"}]


def test_content_match_candidate_is_bounded_intrinsically_question_matched_and_surfaces_omissions():
    graph = _tiered_graph()
    content = {
        "checkouts": [
            {
                "path": "/w/gadget",
                # Bound to the revision the graph reports for this checkout;
                # content that cannot be placed in the snapshot is not evidence.
                "head_revision": "a" * 40,
                "matches": [
                    {
                        "path": "notes.md",
                        "line": 3,
                        "term": "modified",
                        "excerpt": "the widget assembly was modified",
                        "evidence": {"command": "git grep modified"},
                    }
                ],
                "omissions": [
                    {"kind": "content_files_truncated", "omitted_count": 2, "total_files_matched": 10}
                ],
            },
            # A match against a checkout outside the graph is ignored, never
            # guessed at.
            {
                "path": "/not/a/graph/checkout",
                "matches": [
                    {
                        "path": "x.md",
                        "line": 1,
                        "term": "modified",
                        "excerpt": "x",
                        "evidence": {"command": "git grep"},
                    }
                ],
                "omissions": [],
            },
        ]
    }

    without_content = compile_task_capsule(task=TIERED_TASK, graph=graph)
    with_content = compile_task_capsule(task=TIERED_TASK, graph=graph, content=content)
    assert without_content["fingerprint"] != with_content["fingerprint"]

    content_claims = [c for c in with_content["claims"] if c["fact"] == "content_match"]
    assert len(content_claims) == 1
    content_claim = content_claims[0]
    assert content_claim["subject"] == "checkout_gadget"
    assert content_claim["subject_path"] == "/w/gadget"
    assert 'notes.md' in content_claim["claim"] and "modified" in content_claim["claim"]
    assert content_claim["selection"]["tier"] == "question_match"
    signal = next(s for s in content_claim["selection"]["signals"] if s["signal"] == "content_term_match")
    assert signal["term"] == "modified"
    assert signal["path"] == "notes.md"
    assert "content match: term 'modified' was found in notes.md" == content_claim["selection_reason"]
    # The intrinsic ranking hint never leaks into the public claim shape.
    assert "intrinsic_signals" not in content_claim

    # No candidate at all for the out-of-graph checkout.
    assert not any(c["subject_path"] == "/not/a/graph/checkout" for c in with_content["claims"])

    surfaced = next(o for o in with_content["omissions"] if o["kind"] == "content_files_truncated")
    assert surfaced["omitted_count"] == 2
    assert surfaced["total_files_matched"] == 10
    assert surfaced["subject"] == "checkout_gadget"
    assert surfaced["subject_path"] == "/w/gadget"


def test_absent_content_is_byte_identical_to_explicit_none_and_empty_checkouts():
    graph = _tiered_graph()
    omitted = compile_task_capsule(task=TIERED_TASK, graph=graph)
    explicit_none = compile_task_capsule(task=TIERED_TASK, graph=graph, content=None)
    assert omitted["fingerprint"] == explicit_none["fingerprint"]
    empty_content = compile_task_capsule(task=TIERED_TASK, graph=graph, content={"checkouts": []})
    assert omitted["fingerprint"] == empty_content["fingerprint"]


def test_scope_narrower_than_the_graph_excludes_out_of_scope_checkouts(graph, fx):
    """A capsule must not carry claims about checkouts its own scope excludes.

    The scope was only copied into the output, never applied to selection, so a
    capsule could declare scope ['/a'] while including claims from '/b' — and a
    downstream agent may act on context the capsule itself says is out of scope.
    """
    in_scope = fx["paths"]["canonical"]

    capsule = compile_task_capsule(
        task={**TASK, "scope": [in_scope]}, graph=graph
    )

    assert capsule["claims"], "scoping must not empty the capsule"
    out_of_scope = [
        claim for claim in capsule["claims"]
        if not claim.get("subject_path", "").lower().startswith(in_scope.replace("\\", "/").lower())
    ]
    assert out_of_scope == [], (
        f"claims outside the declared scope leaked into the capsule: "
        f"{[c['subject_path'] for c in out_of_scope]}"
    )

    # The finding names conflicts, unknowns and omissions too, not just claims.
    # A capsule that declares scope ['/a'] must not narrate /b anywhere.
    # Exclude ancestors of the in-scope path: the fixture set includes the
    # shared base directory, whose string is a substring of every path under it,
    # so a substring probe would flag it whenever an in-scope path is named.
    others = [
        p for p in fx["paths"].values()
        if p != in_scope and not in_scope.startswith(p)
    ]
    rest = json.dumps({
        "conflicts": capsule["conflicts"],
        "unknowns": capsule["unknowns"],
        "omissions": capsule["omissions"],
    }).lower()
    leaked = [p for p in others if p.replace("\\", "/").lower() in rest]
    assert leaked == [], (
        f"out-of-scope paths named in conflicts/unknowns/omissions: {leaked}"
    )


def test_negative_claim_budget_is_rejected_rather_than_inverted(graph):
    """Negative slicing quietly includes almost everything.

    `max_claims=-1` selected all claims but the last and emitted the contradictory
    reason 'claim budget -1 reached', so a malformed budget silently *expanded* the
    context instead of failing closed.
    """
    with pytest.raises(ValueError, match="max_claims"):
        compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": -1})


@pytest.mark.parametrize(
    ("nodes", "message"),
    [
        ("not a node list", "node list"),
        (["not a node mapping"], "invalid node"),
    ],
    ids=["nodes-container", "node-entry"],
)
def test_compile_task_capsule_rejects_malformed_graph_node_shapes(nodes, message):
    graph = {
        "nodes": nodes,
        "workspace_fingerprint": "sha256:workspace-fp",
        "observed_at": "2026-07-20T15:00:00.000Z",
        "allowlist": ["/workspace"],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
    }

    with pytest.raises(ValueError, match=message):
        compile_task_capsule(task={"question": "What facts were observed?"}, graph=graph)


@pytest.mark.parametrize(
    "facts",
    [
        "not a facts mapping",
        {"is_git_repository": "not a fact mapping"},
    ],
    ids=["facts-container", "nested-fact"],
)
def test_compile_task_capsule_rejects_truthy_non_dict_facts_as_invalid_graph_shape(facts):
    """Malformed observed facts must become a typed input error, never AttributeError."""
    graph = {
        "nodes": [
            {
                "id": "checkout_bad_facts",
                "kind": "checkout",
                "path": "/workspace",
                "facts": facts,
            }
        ],
        "workspace_fingerprint": "sha256:workspace-fp",
        "observed_at": "2026-07-20T15:00:00.000Z",
        "allowlist": ["/workspace"],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
    }

    with pytest.raises(ValueError, match="invalid fact"):
        compile_task_capsule(task={"question": "What facts were observed?"}, graph=graph)


def test_content_search_failure_becomes_a_capsule_unknown(graph, fx):
    """A failed search must not be indistinguishable from a search with no matches.

    Compilation read only per-checkout `omissions`, so a checkout reporting
    `grep_unavailable`, or a root refused outright by `observe_content`, vanished
    from the capsule entirely.
    """
    path = fx["paths"]["canonical"]
    content = {
        "checkouts": [
            {"path": path, "status": "unknown", "reason": "grep_unavailable",
             "matches": [], "omissions": []}
        ],
        "refusals": [{"path": fx["paths"]["disallowed"], "reason": "outside_allowlist"}],
    }

    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)

    recorded = json.dumps(capsule["unknowns"]) + json.dumps(capsule["omissions"])
    assert "grep_unavailable" in recorded, (
        "a failed content search left no trace in the capsule"
    )
    assert "outside_allowlist" in recorded, (
        "a refused content root left no trace in the capsule"
    )


def test_content_from_a_different_revision_is_not_used_as_evidence(fx):
    """Content must be bound to the snapshot the graph describes, not just to a path.

    Matching solely by path accepted a content result from an earlier scan as
    evidence for the graph's *current* workspace fingerprint. The receipt then
    claims a unified governed context that never existed: an excerpt from a file as
    it used to be, presented as evidence about the checkout as it is now.

    Staleness is simulated by rewriting the recorded revision rather than by
    advancing the fixture repo, because `fx` is module-scoped and other tests
    assert against its exact commit shas.
    """
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    targets = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    graph_now = project_workspace_graph(
        observe_checkouts(targets, allowlist=allowlist, now=NOW)
    )
    content = observe_content(targets, allowlist=allowlist, terms=["modified"], now=NOW)
    task = {"question": "What modified files exist?"}

    # Positive control: bound to the same revision, content is still evidence.
    fresh = compile_task_capsule(task=task, graph=graph_now, content=content)
    assert any(c["fact"] == "content_match" for c in fresh["claims"]), (
        "binding must not discard content that genuinely matches the snapshot"
    )
    for checkout in content["checkouts"]:
        assert checkout.get("head_revision"), (
            "content must record the revision it searched, or it cannot be bound"
        )

    # Now the same content, recorded against a revision the graph does not describe.
    stale = json.loads(json.dumps(content))
    for checkout in stale["checkouts"]:
        checkout["head_revision"] = "0" * 40

    capsule = compile_task_capsule(task=task, graph=graph_now, content=stale)

    assert not [c for c in capsule["claims"] if c["fact"] == "content_match"], (
        "an excerpt observed at a different revision became evidence about this one"
    )
    assert any(u.get("kind") == "content_snapshot_stale" for u in capsule["unknowns"]), (
        "dropping stale content silently is its own dishonesty; it must be reported"
    )


def test_required_checks_are_derived_from_the_observed_workspace(fx):
    """Checks must fit the workspace, and an undeterminable one must not be invented.

    Hardcoded defaults told every workspace to run `npm test`, `npx create-vivary
    doctor` and `entire status`, with no override — so a Python-only project got
    three commands, at least one of which cannot work. Worse than useless: a wrong
    check that passes trivially would launder a broken workspace into a green
    receipt.
    """
    p = fx["paths"]
    repo = p["canonical"]
    base = os.path.dirname(repo)
    allowlist = [repo]

    def compile_for(task=None):
        graph = project_workspace_graph(
            observe_checkouts([repo], allowlist=allowlist, now=NOW)
        )
        return compile_task_capsule(task=task or TASK, graph=graph)

    # 1. A standalone Tropo graph derives only the check it can satisfy.
    _write(os.path.join(repo, "tropo.toml"), "[base]\nallow_untyped = true\n")
    try:
        commands = [c["command"] for c in compile_for()["required_checks"]]
        assert not any("doctor" in c for c in commands), commands
        assert any("tropo check" in c for c in commands), commands
        _write(os.path.join(repo, "AGENTS.md"), "# Runtime\n")
        _write(os.path.join(repo, "STRATO.md"), "# Agent OS\n")
        commands = [c["command"] for c in compile_for()["required_checks"]]
        assert any("doctor" in c for c in commands), commands
        assert any("tropo check" in c for c in commands), commands
        assert not any("npm test" in c for c in commands), (
            "npm test must not be asserted for a workspace with no npm test script"
        )
        assert all(c.get("evidence") for c in compile_for()["required_checks"]), (
            "every derived check must carry the evidence that justified it"
        )
        assert all(
            c.get("cwd") == normalize_path(repo) for c in compile_for()["required_checks"]
        ), "every derived check must bind the workspace where it must run"

        # 2. An ambiguous test system is reported, never guessed.
        _write(os.path.join(repo, "pyproject.toml"), "[project]\nname = 'x'\n")
        capsule = compile_for()
        commands = [c["command"] for c in capsule["required_checks"]]
        assert not any("pytest" in c or "tox" in c for c in commands), (
            f"a test command was guessed for an ambiguous ecosystem: {commands}"
        )
        undetermined = [
            u for u in capsule["unknowns"] if u.get("kind") == "required_check_undetermined"
        ]
        assert undetermined, "an undeterminable test command must be reported, not dropped"
        assert "pyproject.toml" in undetermined[0]["observed_markers"]

        # 3. npm's scaffolded placeholder is a known non-check, not a command.
        _write(
            os.path.join(repo, "package.json"),
            '{"scripts": {"test": "echo \\"Error: no test specified\\" && exit 1"}}\n',
        )
        commands = [c["command"] for c in compile_for()["required_checks"]]
        assert "npm test" not in commands, (
            "npm's placeholder test script must not become a required check"
        )

        # 4. A real test script is derived.
        _write(os.path.join(repo, "package.json"), '{"scripts": {"test": "vitest run"}}\n')
        checks = compile_for()["required_checks"]
        project_test = next(c for c in checks if c["command"] == "npm test")
        assert project_test["evidence"] == {
            "command": "fs.read package.json scripts.test"
        }
        assert any(
            u.get("kind") == "required_check_undetermined"
            and "pyproject.toml" in u.get("observed_markers", [])
            for u in compile_for()["unknowns"]
        ), "an npm test command must not hide an undetermined Python check"

        # 5. An explicit task list always wins.
        explicit = compile_for(
            task={
                **TASK,
                "required_checks": [{"name": "mine", "command": "make check"}],
            }
        )
        assert explicit["required_checks"] == [
            {"name": "mine", "command": "make check"}
        ]
    finally:
        for name in ("tropo.toml", "AGENTS.md", "STRATO.md", "pyproject.toml", "package.json"):
            path = os.path.join(repo, name)
            if os.path.exists(path):
                os.remove(path)



def test_required_checks_disambiguate_multiple_checkout_execution_roots(fx):
    roots = [fx["paths"]["canonical"], fx["paths"]["staleNeighbor"]]
    for root in roots:
        _write(os.path.join(root, "tropo.toml"), "[base]\nallow_untyped = true\n")
        _write(os.path.join(root, "AGENTS.md"), "# Runtime\n")
        _write(os.path.join(root, "STRATO.md"), "# Agent OS\n")

    try:
        graph = project_workspace_graph(
            observe_checkouts(roots, allowlist=roots, now=NOW)
        )
        capsule = compile_task_capsule(task=TASK, graph=graph)
        checks = capsule["required_checks"]

        assert len(checks) == 4
        assert len({check["name"] for check in checks}) == len(checks)
        assert {check["cwd"] for check in checks} == {
            normalize_path(root) for root in roots
        }
        assert all("@" in check["name"] for check in checks)
    finally:
        for root in roots:
            for name in ("tropo.toml", "AGENTS.md", "STRATO.md"):
                marker = os.path.join(root, name)
                if os.path.exists(marker):
                    os.remove(marker)




def test_entire_status_is_not_a_default_check(fx):
    """`entire status` is not a Vivary command and must not be asserted by default.

    The `entire_checkpoint` provenance in the receipt model is a deliberate,
    separate integration and stays; only the blanket default goes.
    """
    graph = project_workspace_graph(
        observe_checkouts([fx["paths"]["canonical"]], allowlist=[fx["paths"]["canonical"]], now=NOW)
    )
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert not any("entire" in c["command"] for c in capsule["required_checks"])
