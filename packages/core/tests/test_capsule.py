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

from vivary_core.canonical import (  # noqa: E402
    MAX_LOSSLESS_INTEGER,
    deterministic_id,
    fingerprint,
    normalize_path,
)
from vivary_core.capsule_compile import (  # noqa: E402
    CapsuleContentWorkLimitError,
    capsule_context_matches_graph,
    content_context_is_valid,
    compile_task_capsule,
    project_public_task_capsule,
    public_task_capsule_json_schema,
    MAX_TASK_SCOPE_ROOTS,
    MAX_CAPSULE_CANDIDATE_WORK,
    MAX_GRAPH_CONTEXT_CHECKOUTS,
    repair_topology_fingerprint,
    is_task_capsule_shape,
    verify_public_task_capsule_integrity,
    verify_task_capsule_integrity,
)
from vivary_core.workspace_content import CONTENT_SCHEMA, observe_content  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402
from vivary_core.workspace_observe import observe_checkouts  # noqa: E402

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP_EPOCH = 1782000000.0  # 2026-07-02T00:00:00Z


def NOW():
    return "2026-07-20T15:00:00.000Z"


def _content_artifact(*, checkouts, refusals=None, terms=None, allowlist=None):
    checkouts = list(checkouts)
    refusals = [] if refusals is None else list(refusals)
    if terms is None:
        terms = [
            match["term"]
            for checkout in checkouts
            for match in checkout["matches"]
        ] or ["content"]
    if allowlist is None:
        allowlist = [checkout["path"] for checkout in checkouts]
    return {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW(),
        "terms": terms,
        "allowlist": allowlist,
        "checkouts": checkouts,
        "refusals": refusals,
    }


def _observed_content_checkout(
    path,
    *,
    head_revision="a" * 40,
    privacy_fingerprint=None,
    matches=None,
    omissions=None,
    reason=None,
):
    checkout = {
        "raw_path": path,
        "path": normalize_path(path),
        "status": "observed",
        "head_revision": head_revision,
        "privacy_fingerprint": privacy_fingerprint
        or fingerprint(
            {
                "revision": head_revision,
                "ignored_tracked_paths": [],
            }
        ),
        "matches": [] if matches is None else matches,
        "omissions": [] if omissions is None else omissions,
    }
    if reason is not None:
        checkout.pop("privacy_fingerprint")
        checkout["reason"] = reason
    return checkout


def _unknown_content_checkout(path, *, reason, evidence):
    return {
        "raw_path": path,
        "path": normalize_path(path),
        "status": "unknown",
        "reason": reason,
        "matches": [],
        "omissions": [],
        "evidence": evidence,
    }


def _content_refusal(path, *, reason):
    return {
        "raw_path": path,
        "path": normalize_path(path),
        "status": "refused",
        "reason": reason,
    }

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
    base_dir = os.path.realpath(tempfile.mkdtemp(prefix="vivary-capsule-fixtures-"))
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
        assert claim["status"] == "known"


def test_selection_is_bounded_by_budget_and_the_overflow_is_recorded_as_an_omission(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 5})
    assert len(capsule["claims"]) == 5
    overflow = next((o for o in capsule["omissions"] if o["kind"] == "claims_over_budget"), None)
    assert overflow is not None
    assert overflow["omitted_count"] > 0


def test_graph_matcher_preserves_compiler_selection_omissions(graph):
    capsule = compile_task_capsule(
        task=TASK,
        graph=graph,
        budget={"max_claims": 1},
    )
    assert any(
        omission["kind"] == "claims_over_budget"
        for omission in capsule["omissions"]
    )
    stripped = json.loads(json.dumps(capsule))
    stripped["omissions"] = [
        omission
        for omission in stripped["omissions"]
        if omission["kind"] != "claims_over_budget"
    ]

    assert not capsule_context_matches_graph(stripped, graph)


@pytest.mark.parametrize("artifact_kind", ["claim", "unknown", "omission"])
def test_graph_matcher_rejects_refingerprinted_content_downgrades(
    graph, artifact_kind
):
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("head_revision") or {}).get("status")
        == "known"
    )
    task = {
        "question": "What modified content exists?",
        "scope": [checkout["path"]],
    }
    if artifact_kind == "claim":
        task["filters"] = [{"field": "fact", "equals": "content_match"}]
        content = _content_artifact(
            checkouts=[
                _observed_content_checkout(
                    checkout["path"],
                    head_revision=checkout["facts"]["head_revision"]["value"],
                    matches=[
                        {
                            "path": "notes.md",
                            "line": 1,
                            "term": "modified",
                            "excerpt": "modified content",
                            "evidence": {"command": "git grep modified"},
                        }
                    ],
                )
            ]
        )
    elif artifact_kind == "unknown":
        content = _content_artifact(
            checkouts=[
                _unknown_content_checkout(
                    checkout["path"],
                    reason="grep_unavailable",
                    evidence={"command": "git grep modified"},
                )
            ]
        )
    else:
        content = _content_artifact(
            checkouts=[
                _observed_content_checkout(
                    checkout["path"],
                    head_revision=checkout["facts"]["head_revision"]["value"],
                    omissions=[
                        {
                            "kind": "content_files_truncated",
                            "omitted_count": 2,
                            "total_files_matched": 10,
                            "reason": "matched-file listing capped at 8 files per checkout",
                        }
                    ],
                )
            ]
        )

    capsule = compile_task_capsule(task=task, graph=graph, content=content)
    assert capsule_context_matches_graph(capsule, graph, content)
    assert "content_fingerprint" in capsule["workspace"]

    downgraded = json.loads(json.dumps(capsule))
    del downgraded["workspace"]["content_fingerprint"]
    downgraded["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in downgraded.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    assert not is_task_capsule_shape(downgraded)
    assert not verify_task_capsule_integrity(downgraded)
    assert not capsule_context_matches_graph(downgraded, graph)




def test_graph_matcher_rejects_stripped_content_selection_omissions(graph):
    conflict_checkout_ids = {
        side["checkout"]
        for conflict in graph["conflicts"]
        for side in conflict["sides"]
    }
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("id") in conflict_checkout_ids
        and (node.get("facts", {}).get("head_revision") or {}).get("status")
        == "known"
    )
    match_term = re.findall(r"[^\W_]+", checkout["label"].lower())[0]
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                checkout["path"],
                head_revision=checkout["facts"]["head_revision"]["value"],
                matches=[
                    {
                        "path": "notes.md",
                        "line": 1,
                        "term": match_term,
                        "excerpt": f"{match_term} content",
                        "evidence": {"command": f"git grep {match_term}"},
                    }
                ],
            )
        ]
    )
    cases = [
        (
            "filtered_out",
            {
                "question": f"Which {match_term} revision is current?",
                "scope": [checkout["path"]],
                "filters": [{"field": "fact", "equals": "head_revision"}],
            },
            {"max_claims": 100},
            content,
        ),
        (
            "claims_over_budget",
            {
                "question": f"Which {match_term} revision is current?",
                "scope": [checkout["path"]],
                "filters": [{"field": "path", "includes": checkout["path"]}],
            },
            {"max_claims": 1},
            content,
        ),
    ]

    for omission_kind, task, budget, source in cases:
        capsule = compile_task_capsule(
            task=task, graph=graph, budget=budget, content=source
        )
        graph_only = compile_task_capsule(
            task=task, graph=graph, budget=budget
        )
        if omission_kind in {"filtered_out", "claims_over_budget"}:
            assert next(
                record
                for record in capsule["omissions"]
                if record["kind"] == omission_kind
            ) != next(
                record
                for record in graph_only["omissions"]
                if record["kind"] == omission_kind
            )
        assert not any(
            record.get("kind") == "content_snapshot_stale"
            for record in capsule["unknowns"]
        ), (
            checkout["facts"]["head_revision"]["value"],
            source["checkouts"][0]["head_revision"],
        )
        assert any(
            omission["kind"] == omission_kind
            for omission in capsule["omissions"]
        ), omission_kind
        assert not any(
            claim["fact"] == "content_match" for claim in capsule["claims"]
        ), omission_kind

        downgraded = json.loads(json.dumps(capsule))
        del downgraded["workspace"]["content_fingerprint"]
        downgraded["unknowns"] = [
            record
            for record in downgraded["unknowns"]
            if not str(record.get("kind", "")).startswith("content_")
        ]
        downgraded["omissions"] = [
            record
            for record in downgraded["omissions"]
            if not record["kind"].startswith("content_")
        ]
        downgraded["fingerprint"] = fingerprint(
            {
                key: value
                for key, value in downgraded.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )

        assert is_task_capsule_shape(downgraded), omission_kind
        assert not capsule_context_matches_graph(
            downgraded, graph
        ), omission_kind

    forged_collation = compile_task_capsule(
        task={"question": "Which revision is current?", "scope": [checkout["path"]]},
        graph=graph,
    )
    forged_collation["omissions"].append(
        {
            "kind": "collation_domain_excluded",
            "subject": checkout["id"],
            "fact": "content_match",
            "reason": "forged content collation omission",
        }
    )
    forged_collation["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in forged_collation.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    assert is_task_capsule_shape(forged_collation)
    assert not capsule_context_matches_graph(forged_collation, graph)


@pytest.mark.parametrize(
    "forged_omission",
    [
        {"kind": "anything_i_want", "reason": "unbound narrative"},
        {
            "kind": "ignored_paths_excluded",
            "reason": "unbound narrative",
            "omitted_count": 99,
        },
    ],
)
def test_capsule_shape_rejects_unrecognized_or_reshaped_omissions(
    graph, forged_omission
):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    capsule["omissions"].append(forged_omission)

    assert not is_task_capsule_shape(capsule)


def test_conflicts_survive_compilation_with_both_sides_and_review_required(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert len(capsule["conflicts"]) == 1
    conflict = capsule["conflicts"][0]
    assert conflict["decision"] == "review_required"
    assert len(conflict["sides"]) == 2
    assert conflict["status"] == "unresolved"

    no_claims = compile_task_capsule(
        task=TASK, graph=graph, budget={"max_claims": 0}
    )
    assert no_claims["claims"] == []
    forged = json.loads(json.dumps(no_claims))
    forged["conflicts"] = []
    forged["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    assert is_task_capsule_shape(forged)
    assert not capsule_context_matches_graph(forged, graph)

    for field, value in (
        ("workspace_fingerprint", "sha256:different-workspace"),
        ("observed_at", "2026-07-20T16:00:00.000Z"),
    ):
        altered_graph = json.loads(json.dumps(graph))
        altered_graph[field] = value
        assert not capsule_context_matches_graph(no_claims, altered_graph)


def test_unknowns_pass_through_unreduced(graph):
    graph["unknowns"][0]["reason"] = None
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert capsule["unknowns"] == graph["unknowns"]
    assert len(capsule["unknowns"]) > 0
    assert verify_task_capsule_integrity(capsule)


def test_refused_roots_and_ignored_path_policy_are_visible_omissions_no_private_path_leaks(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert any(o["kind"] == "refused_root" and o["reason"] == "outside_allowlist" for o in capsule["omissions"])
    assert any(o["kind"] == "ignored_paths_excluded" for o in capsule["omissions"])
    serialized = json.dumps(capsule)
    assert "private-note" not in serialized
    assert "secrets/" not in serialized


def test_graph_matcher_preserves_refused_root_omissions(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert capsule_context_matches_graph(capsule, graph)
    assert any(
        omission["kind"] == "refused_root"
        for omission in capsule["omissions"]
    )
    stripped = json.loads(json.dumps(capsule))
    stripped["omissions"] = [
        omission
        for omission in stripped["omissions"]
        if omission["kind"] != "refused_root"
    ]

    assert not capsule_context_matches_graph(stripped, graph)


def test_graph_matcher_rejects_missing_conflict_outside_scope_omission(graph, fx):
    capsule = compile_task_capsule(
        task={**TASK, "scope": [normalize_path(fx["paths"]["canonical"])]},
        graph=graph,
    )
    assert capsule_context_matches_graph(capsule, graph)
    assert any(
        omission["kind"] == "conflict_outside_scope"
        for omission in capsule["omissions"]
    )

    stripped = json.loads(json.dumps(capsule))
    stripped["omissions"] = [
        omission
        for omission in stripped["omissions"]
        if omission["kind"] != "conflict_outside_scope"
    ]

    assert not capsule_context_matches_graph(stripped, graph)


def test_capsule_fingerprint_is_deterministic_and_sensitive_to_content(graph):
    a = compile_task_capsule(task=TASK, graph=graph)
    b = compile_task_capsule(task=TASK, graph=graph)
    assert a["fingerprint"] == b["fingerprint"]
    assert a["capsule_id"] == b["capsule_id"]
    smaller = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 3})
    assert a["fingerprint"] != smaller["fingerprint"]


def test_capsule_integrity_binds_its_deterministic_identifier(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert verify_task_capsule_integrity(capsule)

    capsule["capsule_id"] = "capsule_forged"

    assert not verify_task_capsule_integrity(capsule)


@pytest.mark.parametrize(
    "field",
    [
        "subject",
        "subject_path",
        "fact",
        "claim",
        "status",
        "evidence",
        "selection_reason",
        "selection",
    ],
)
def test_capsule_integrity_rejects_incomplete_claims(graph, field):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    capsule["claims"][0].pop(field)
    capsule["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    assert not verify_task_capsule_integrity(capsule)


@pytest.mark.parametrize(
    "malformed_graph",
    [
        {"nodes": [{"kind": "repository"}], "edges": []},
        {"nodes": [{"kind": "repository", "id": 123}], "edges": []},
        {"nodes": [{"kind": "checkout", "id": "checkout:a"}], "edges": []},
        {
            "nodes": [],
            "edges": [{"kind": "checkout_of", "from": None, "to": "repository:a"}],
        },
    ],
)
def test_repair_topology_fingerprint_rejects_malformed_identifiers(
    malformed_graph,
):
    with pytest.raises(ValueError, match="topology"):
        repair_topology_fingerprint(malformed_graph)


def test_capsule_binds_the_workspace_fingerprint_it_was_compiled_against(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    assert capsule["workspace"]["fingerprint"] == graph["workspace_fingerprint"]
    assert (
        capsule["workspace"]["repair_topology_fingerprint"]
        == repair_topology_fingerprint(graph)
    )
    changed_topology = json.loads(json.dumps(graph))
    checkout_edge = next(
        edge for edge in changed_topology["edges"]
        if edge["kind"] == "checkout_of"
    )
    checkout_edge["to"] = "repository_forged"
    assert (
        capsule["workspace"]["repair_topology_fingerprint"]
        != repair_topology_fingerprint(changed_topology)
    )
    moved_checkout = json.loads(json.dumps(graph))
    checkout_node = next(
        node for node in moved_checkout["nodes"] if node["kind"] == "checkout"
    )
    checkout_node["path"] = f"{checkout_node['path']}-moved"
    assert (
        capsule["workspace"]["repair_topology_fingerprint"]
        != repair_topology_fingerprint(moved_checkout)
    )
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
    empty_mapping = compile_task_capsule(task=TASK, graph=graph, content={})
    empty_content = compile_task_capsule(
        task=TASK,
        graph=graph,
        content={"checkouts": []},
    )
    full_empty_content = observe_content(
        [],
        allowlist=[
            next(
                node["path"]
                for node in graph["nodes"]
                if node.get("kind") == "checkout"
            )
        ],
        now=NOW,
    )
    assert (
        omitted
        == explicit_none
        == empty_mapping
        == empty_content
        == compile_task_capsule(
            task=TASK, graph=graph, content=full_empty_content
        )
    )
    checkout_path = next(
        node["path"]
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
    )
    scoped_task = {**TASK, "scope": [checkout_path]}
    assert compile_task_capsule(
        task=scoped_task, graph=graph
    ) == compile_task_capsule(
        task=scoped_task, graph=graph, content={"checkouts": []}
    )


def test_scoped_compilation_rejects_non_mapping_content_without_attribute_error(graph):
    checkout_path = next(
        node["path"]
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
    )

    with pytest.raises(ValueError, match="workspace-content"):
        compile_task_capsule(
            task={**TASK, "scope": [checkout_path]},
            graph=graph,
            content=1,
        )


def test_content_matches_become_bounded_content_match_candidate_claims_intrinsically_question_matched(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]], allowlist=allowlist, now=NOW
    )
    content_graph = project_workspace_graph(observation)
    # "tracked" appears in the dirty checkout's committed tracked.md. The dirty
    # checkout is not a conflict side (only canonical/stale-neighbor share an
    # origin), so this isolates the intrinsic content_term_match signal from
    # conflict_side's higher-priority tier.
    content = observe_content(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]],
        allowlist=allowlist,
        terms=["original"],
        now=NOW,
    )

    task = {"question": "What original files exist?"}
    without_content = compile_task_capsule(task=task, graph=content_graph)
    with_content = compile_task_capsule(task=task, graph=content_graph, content=content)

    assert with_content["fingerprint"] != without_content["fingerprint"]
    content_claim = next((c for c in with_content["claims"] if c["fact"] == "content_match"), None)
    assert content_claim is not None, "expected a content_match claim once content is supplied"
    assert re.search(r"tracked\.md", content_claim["claim"])
    assert re.search(r"original", content_claim["claim"], re.IGNORECASE)
    assert content_claim["subject_path"].endswith("dirty")
    assert content_claim["selection"]["tier"] == "question_match"
    signal = next(s for s in content_claim["selection"]["signals"] if s["signal"] == "content_term_match")
    assert signal is not None, "expected an intrinsic content_term_match signal"
    assert signal["term"] == "original"
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
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                "/not/a/graph/checkout",
                matches=[
                    {
                        "path": "x.md",
                        "line": 1,
                        "excerpt": "x",
                        "term": "x",
                        "evidence": {"command": "git grep"},
                    }
                ],
            )
        ]
    )
    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)
    assert not any(c["fact"] == "content_match" for c in capsule["claims"])


def test_content_omissions_surface_into_capsule_omissions(graph):
    dirty_node = next(n for n in graph["nodes"] if n["kind"] == "checkout" and n["path"].endswith("dirty"))
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                dirty_node["path"],
                head_revision=dirty_node["facts"]["head_revision"]["value"],
                privacy_fingerprint=dirty_node["facts"][
                    "content_privacy_fingerprint"
                ]["value"],
                omissions=[
                    {
                        "kind": "content_lines_truncated",
                        "path": "tracked.md",
                        "omitted_count": 2,
                        "reason": "matched-line listing capped at 20 per file",
                    }
                ],
            )
        ]
    )
    capsule = compile_task_capsule(
        task={**TASK, "scope": [dirty_node["path"]]},
        graph=graph,
        content=content,
    )
    surfaced = next(
        omission
        for omission in capsule["omissions"]
        if omission["kind"] == "content_lines_truncated"
    )
    assert surfaced["omitted_count"] == 2
    assert surfaced["subject"] == dirty_node["id"]

    malformed = json.loads(json.dumps(content))
    del malformed["checkouts"][0]["omissions"][0]["reason"]
    with pytest.raises(ValueError, match="workspace-content"):
        compile_task_capsule(task=TASK, graph=graph, content=malformed)


def test_content_source_rejects_malformed_and_field_smuggled_records(graph):
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("head_revision") or {}).get("status")
        == "known"
    )
    task = {
        "question": "What modified content exists?",
        "scope": [checkout["path"]],
        "filters": [{"field": "fact", "equals": "content_match"}],
    }
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                checkout["path"],
                head_revision=checkout["facts"]["head_revision"]["value"],
                matches=[
                    {
                        "path": "notes.md",
                        "line": 1,
                        "term": "modified",
                        "excerpt": "modified content",
                        "evidence": {"command": "git grep modified"},
                    }
                ],
            )
        ]
    )
    capsule = compile_task_capsule(task=task, graph=graph, content=content)

    malformed_sources = []
    for path, value in (
        (("smuggled",), True),
        (("checkouts", 0, "smuggled"), True),
        (("checkouts", 0, "matches"), {"not": "a list"}),
        (("observed_at",), "not-a-date"),
        (("allowlist",), ["relative/root"]),
        (("checkouts", 0, "path"), "/outside/content/allowlist"),
    ):
        malformed = json.loads(json.dumps(content))
        target = malformed
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        malformed_sources.append(malformed)
    duplicate_checkout = json.loads(json.dumps(content))
    duplicate_checkout["checkouts"].append(
        json.loads(json.dumps(duplicate_checkout["checkouts"][0]))
    )
    malformed_sources.append(duplicate_checkout)

    duplicate_match = json.loads(json.dumps(content))
    conflicting_match = json.loads(
        json.dumps(duplicate_match["checkouts"][0]["matches"][0])
    )
    conflicting_match["excerpt"] = "different content at the same source location"
    duplicate_match["checkouts"][0]["matches"].append(conflicting_match)
    missing_revision = json.loads(json.dumps(content))
    missing_revision["checkouts"][0]["head_revision"] = None
    malformed_sources.append(missing_revision)
    malformed_sources.append(duplicate_match)

    windows_case_duplicate = json.loads(json.dumps(content))
    windows_case_duplicate["allowlist"] = ["c:/Repo"]
    windows_checkout = windows_case_duplicate["checkouts"][0]
    windows_checkout["raw_path"] = "C:/Repo"
    windows_checkout["path"] = "c:/Repo"
    windows_checkout["matches"][0]["path"] = "NOTES.md"
    windows_conflict = json.loads(
        json.dumps(windows_checkout["matches"][0])
    )
    windows_conflict["path"] = "notes.md"
    windows_conflict["excerpt"] = "conflicting Windows-case record"
    windows_checkout["matches"].append(windows_conflict)
    malformed_sources.append(windows_case_duplicate)

    unc_traversal = json.loads(json.dumps(content))
    unc_traversal["allowlist"] = ["//server/share/safe"]
    unc_checkout = unc_traversal["checkouts"][0]
    unc_checkout["raw_path"] = "//server/share/safe/../outside"
    unc_checkout["path"] = "//server/share/safe/../outside"
    malformed_sources.append(unc_traversal)

    posix_root_distinct = json.loads(json.dumps(content))
    posix_root_distinct["allowlist"] = ["/"]
    posix_checkout = posix_root_distinct["checkouts"][0]
    posix_checkout["raw_path"] = "/"
    posix_checkout["path"] = "/"
    posix_checkout["matches"][0]["path"] = "Foo.txt"
    posix_lower = json.loads(json.dumps(posix_checkout["matches"][0]))
    posix_lower["path"] = "foo.txt"
    posix_checkout["matches"].append(posix_lower)
    assert content_context_is_valid(posix_root_distinct)

    for malformed in malformed_sources:
        with pytest.raises(ValueError, match="workspace-content"):
            compile_task_capsule(task=task, graph=graph, content=malformed)
        assert not capsule_context_matches_graph(capsule, graph, malformed)


# -- dirty_entries claims (#44 gap 1), continued -----------------------------
def test_outside_allowlist_relative_content_refusal_remains_valid_source(graph):
    content = {
        "schema": CONTENT_SCHEMA,
        "observed_at": NOW(),
        "terms": ["needle"],
        "allowlist": ["/repo"],
        "checkouts": [],
        "refusals": [
            {
                "raw_path": "relative/repo",
                "path": "relative/repo",
                "status": "refused",
                "reason": "outside_allowlist",
            },
            {
                "raw_path": "/repo/sub/../other",
                "path": "/repo/sub/../other",
                "status": "refused",
                "reason": "outside_allowlist",
            },
        ],
    }

    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)
    assert {
        omission["path"]
        for omission in capsule["omissions"]
        if omission["kind"] == "content_root_refused"
    } >= {"relative/repo", "/repo/sub/../other"}


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

    for omission_kind in ("dirty_paths_truncated", "ignored_paths_excluded"):
        stripped = json.loads(json.dumps(capsule))
        stripped["omissions"] = [
            omission
            for omission in stripped["omissions"]
            if omission["kind"] != omission_kind
        ]
        stripped["fingerprint"] = fingerprint(
            {
                key: value
                for key, value in stripped.items()
                if key not in {"capsule_id", "fingerprint"}
            }
        )
        assert is_task_capsule_shape(stripped)
        assert not capsule_context_matches_graph(stripped, big_dirty_graph)


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
                    "content_privacy_fingerprint": {
                        "status": "known",
                        "value": fingerprint(
                            {
                                "revision": "a" * 40,
                                "ignored_tracked_paths": [],
                            }
                        ),
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
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                "/w/gadget",
                head_revision="a" * 40,
                matches=[
                    {
                        "path": "notes.md",
                        "line": 3,
                        "term": "modified",
                        "excerpt": "the widget assembly was modified",
                        "evidence": {"command": "git grep modified"},
                    },
                    {
                        "path": "other.md",
                        "line": 4,
                        "term": "UNRELATED",
                        "excerpt": "not part of the task question",
                        "evidence": {"command": "git grep unrelated"},
                    },
                ],
                omissions=[
                    {
                        "kind": "content_files_truncated",
                        "omitted_count": 2,
                        "total_files_matched": 10,
                        "reason": "matched-file listing capped at 8 files per checkout",
                    }
                ],
            ),
            _observed_content_checkout(
                "/not/a/graph/checkout",
                matches=[
                    {
                        "path": "x.md",
                        "line": 1,
                        "term": "modified",
                        "excerpt": "x",
                        "evidence": {"command": "git grep"},
                    }
                ],
            ),
        ]
    )

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
    assert verify_task_capsule_integrity(with_content)
    excluded = next(
        omission
        for omission in with_content["omissions"]
        if omission["kind"] == "content_matches_outside_task"
    )
    assert excluded["omitted_count"] == 1

    # No candidate at all for the out-of-graph checkout.
    assert not any(c["subject_path"] == "/not/a/graph/checkout" for c in with_content["claims"])

    surfaced = next(o for o in with_content["omissions"] if o["kind"] == "content_files_truncated")
    assert surfaced["omitted_count"] == 2
    assert surfaced["total_files_matched"] == 10
    assert surfaced["subject"] == "checkout_gadget"
    assert surfaced["subject_path"] == "/w/gadget"


@pytest.mark.parametrize(
    "unsafe_path",
    ["/private/secret.md", "../private/secret.md", "c:private/secret.md"],
    ids=["absolute", "traversal", "drive-relative"],
)
def test_unsafe_content_match_paths_never_become_claims(unsafe_path):
    graph = _tiered_graph()

    content = _content_artifact(
        checkouts=[
            _observed_content_checkout(
                "/w/gadget",
                head_revision="a" * 40,
                matches=[
                    {
                        "path": unsafe_path,
                        "line": 1,
                        "term": "modified",
                        "excerpt": "modified private content",
                        "evidence": {"command": "git grep modified"},
                    }
                ],
            )
        ]
    )

    with pytest.raises(ValueError, match="workspace-content"):
        compile_task_capsule(
            task=TIERED_TASK,
            graph=graph,
            content=content,
            budget={"max_claims": 100},
        )


def test_content_match_occurrence_ranking_uses_canonical_source_order():
    graph = _tiered_graph()
    matches = [
        {
            "path": path,
            "line": 1,
            "term": "needle",
            "excerpt": f"needle in {path}",
            "evidence": {"command": "git grep needle"},
        }
        for path in ("b.txt", "a.txt")
    ]

    def compile_with(source_matches):
        return compile_task_capsule(
            task={
                "question": "Find needle.",
                "filters": [{"field": "fact", "equals": "content_match"}],
            },
            graph=graph,
            content=_content_artifact(
                terms=["needle"],
                checkouts=[
                    _observed_content_checkout(
                        "/w/gadget",
                        head_revision="a" * 40,
                        matches=source_matches,
                    )
                ],
            ),
            budget={"max_claims": 1},
        )

    forward = compile_with(matches)
    reversed_source = compile_with(list(reversed(matches)))

    assert forward["claims"][0]["claim"] == reversed_source["claims"][0]["claim"]
    assert forward["claims"][0]["claim"].startswith("a.txt:")

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
    in_scope = normalize_path(fx["paths"]["canonical"])
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
    others = [
        normalize_path(path)
        for path in fx["paths"].values()
        if normalize_path(path) != in_scope
        and not in_scope.startswith(normalize_path(path))
    ]
    rest = json.dumps({
        "conflicts": capsule["conflicts"],
        "unknowns": capsule["unknowns"],
        "omissions": capsule["omissions"],
    }).lower()
    leaked = [path for path in others if path.lower() in rest]
    assert leaked == [], (
        f"out-of-scope paths named in conflicts/unknowns/omissions: {leaked}"
    )

    outside_scope = fx["paths"]["dirty"]
    capsule_with_content_omissions = compile_task_capsule(
        task={**TASK, "scope": [in_scope]},
        graph=graph,
        content=_content_artifact(
            checkouts=[
                _observed_content_checkout(
                    outside_scope,
                    omissions=[
                        {
                            "kind": "content_lines_truncated",
                            "path": "tracked.md",
                            "omitted_count": 1,
                            "reason": "matched-line listing capped at 20 per file",
                        }
                    ],
                )
            ],
            refusals=[
                _content_refusal(
                    fx["paths"]["disallowed"],
                    reason="outside_allowlist",
                )
            ],
        ),
    )
    scoped_content = json.dumps(
        capsule_with_content_omissions["omissions"]
    ).replace("\\", "/").lower()
    assert outside_scope.replace("\\", "/").lower() not in scoped_content
    conflict_scope_omissions = [
        omission
        for omission in capsule["omissions"]
        if omission.get("kind") == "conflict_outside_scope"
    ]
    assert conflict_scope_omissions
    assert all(
        omission.get("conflict")
        and "outside the declared scope" in omission["reason"]
        for omission in conflict_scope_omissions
    )
    assert len(
        {
            (omission["conflict"], omission["subject_path"])
            for omission in conflict_scope_omissions
        }
    ) == len(conflict_scope_omissions)


def test_explicit_graph_allowlist_scope_preserves_only_in_scope_refusals(graph):
    scoped_graph = json.loads(json.dumps(graph))
    in_scope_path = scoped_graph["allowlist"][0]
    scoped_graph["refusals"] = [
        {"path": in_scope_path, "reason": "in_scope_refusal"},
        {"path": f"{in_scope_path}-outside", "reason": "outside_scope_refusal"},
    ]

    capsule = compile_task_capsule(
        task={**TASK, "scope": list(scoped_graph["allowlist"])},
        graph=scoped_graph,
    )

    assert [
        omission["path"]
        for omission in capsule["omissions"]
        if omission["kind"] == "refused_root"
    ] == [in_scope_path]
    assert capsule_context_matches_graph(capsule, scoped_graph)


def test_negative_claim_budget_is_rejected_rather_than_inverted(graph):
    """Negative slicing quietly includes almost everything.

    `max_claims=-1` selected all claims but the last and emitted the contradictory
    reason 'claim budget -1 reached', so a malformed budget silently *expanded* the
    context instead of failing closed.
    """
    with pytest.raises(ValueError, match="max_claims"):
        compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": -1})


def test_claim_budget_cannot_exceed_the_lossless_contract_range(graph):
    capsule = compile_task_capsule(
        task=TASK,
        graph=graph,
        budget={"max_claims": MAX_LOSSLESS_INTEGER},
    )
    assert verify_task_capsule_integrity(capsule)

    with pytest.raises(ValueError, match="max_claims"):
        compile_task_capsule(
            task=TASK,
            graph=graph,
            budget={"max_claims": MAX_LOSSLESS_INTEGER + 1},
        )


@pytest.mark.parametrize(
    ("task", "message"),
    [
        ("not a task mapping", "task must be a mapping"),
        ({}, "task.question"),
        ({"question": None}, "task.question"),
        ({"question": []}, "task.question"),
        ({"question": ""}, "task.question"),
        ({"question": "   "}, "non-blank string"),
        ({"question": "What changed?", "scope": "/workspace"}, "task.scope"),
        ({"question": "What changed?", "scope": []}, "task.scope"),
        ({"question": "What changed?", "scope": [1]}, "task.scope"),
        ({"question": "What changed?", "scope": [" /workspace "]}, "task.scope"),
        ({"question": "What changed?", "scope": ["/workspace/"]}, "task.scope"),
        ({"question": "What changed?", "scope": [r"C:\Repo"]}, "task.scope"),
        ({"question": "What changed?", "required_checks": []}, "task.required_checks"),
        ({"question": "What changed?", "required_checks": "npm test"}, "task.required_checks"),
        ({"question": "What changed?", "required_checks": 5}, "task.required_checks"),
        ({"question": "What changed?", "required_checks": [{}]}, "task.required_checks"),
        (
            {
                "question": "What changed?",
                "required_checks": [{"name": "unit", "command": "python -m pytest"}],
            },
            "task.required_checks",
        ),
        (
            {
                "question": "What changed?",
                "required_checks": [{"name": "unit", "command": ""}],
            },
            "task.required_checks",
        ),
    ],
    ids=[
        "task-container",
        "question-missing",
        "question-null",
        "question-container",
        "question-empty",
        "question-blank",
        "scope-container",
        "scope-empty",
        "scope-entry",
        "scope-whitespace",
        "scope-trailing-slash",
        "scope-backslash",
        "checks-empty",
        "checks-container-string",
        "checks-container-number",
        "checks-entry-fields",
        "checks-entry-cwd-missing",
        "checks-entry-empty",
    ],
)
def test_compile_task_capsule_rejects_malformed_task_inputs(task, message, graph):
    with pytest.raises(ValueError, match=message):
        compile_task_capsule(task=task, graph=graph)


@pytest.mark.parametrize(
    "filter_rule",
    [
        {"field": "fact", "equals": ""},
        {"field": "path", "includes": ""},
    ],
    ids=["equals", "includes"],
)
def test_empty_filter_values_are_rejected_at_task_boundary(graph, filter_rule):
    with pytest.raises(ValueError, match=r"task\.filters"):
        compile_task_capsule(
            task={**TASK, "filters": [filter_rule]},
            graph=graph,
        )


@pytest.mark.parametrize(
    "scope_root",
    ["   ", ".", "packages/core", "c:relative", "//server/share/safe/../outside"],
    ids=["whitespace", "dot", "relative", "drive-relative", "unc-traversal"],
)
def test_non_absolute_scope_roots_are_rejected(graph, scope_root):
    with pytest.raises(ValueError, match=r"task\.scope"):
        compile_task_capsule(
            task={**TASK, "scope": [scope_root]},
            graph=graph,
        )


def test_task_scope_root_count_is_bounded_before_context_matching(graph):
    with pytest.raises(ValueError, match=r"task\.scope"):
        compile_task_capsule(
            task={
                **TASK,
                "scope": [
                    f"/scope/{index}"
                    for index in range(MAX_TASK_SCOPE_ROOTS + 1)
                ],
            },
            graph=graph,
        )


@pytest.mark.parametrize(
    "scope",
    [
        ["packages/core"],
        ["//server/share/safe/../outside"],
        [" /workspace "],
        ["/workspace/"],
        [r"C:\Repo"],
        [f"/scope/{index}" for index in range(MAX_TASK_SCOPE_ROOTS + 1)],
    ],
    ids=[
        "relative",
        "unc-traversal",
        "whitespace",
        "trailing-slash",
        "backslash",
        "too-many-roots",
    ],
)
def test_capsule_shape_rejects_self_fingerprinted_unsafe_scope(scope, graph):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    capsule["task"]["scope"] = scope
    body = {
        key: value
        for key, value in capsule.items()
        if key not in {"capsule_id", "fingerprint"}
    }
    capsule["fingerprint"] = fingerprint(body)

    assert capsule["fingerprint"] == fingerprint(body)
    assert not is_task_capsule_shape(capsule)




def test_direct_compilation_bounds_checkout_and_content_candidate_work(graph):
    checkout = next(
        node for node in graph["nodes"] if node.get("kind") == "checkout"
    )
    oversized_graph = json.loads(json.dumps(graph))
    oversized_graph["nodes"] = [
        json.loads(json.dumps(checkout))
        for _ in range(MAX_GRAPH_CONTEXT_CHECKOUTS + 1)
    ]
    with pytest.raises(ValueError, match="too many Git checkouts"):
        compile_task_capsule(task=TASK, graph=oversized_graph)

    oversized_content = _content_artifact(
        checkouts=[
            _observed_content_checkout(f"/not/a/checkout-{index}")
            for index in range(MAX_CAPSULE_CANDIDATE_WORK + 1)
        ]
    )
    with pytest.raises(ValueError, match="candidate work"):
        compile_task_capsule(
            task=TASK,
            graph=graph,
            content=oversized_content,
        )


def test_direct_compilation_types_combined_graph_content_candidate_work(graph):
    irrelevant_root = normalize_path(tempfile.gettempdir())
    content = _content_artifact(
        allowlist=[irrelevant_root],
        checkouts=[
            _observed_content_checkout(
                f"{irrelevant_root}/irrelevant-{index}"
            )
            for index in range(MAX_CAPSULE_CANDIDATE_WORK)
        ],
    )

    with pytest.raises(
        CapsuleContentWorkLimitError,
        match="content candidate work exceeds the compiler limit",
    ):
        compile_task_capsule(task=TASK, graph=graph, content=content)


def test_direct_compilation_counts_only_scoped_context_checkouts(graph):
    checkout = next(
        node for node in graph["nodes"] if node.get("kind") == "checkout"
    )
    scoped_graph = json.loads(json.dumps(graph))
    scoped_graph["conflicts"] = []
    scoped_graph["unknowns"] = []
    outside = []
    for index in range(MAX_GRAPH_CONTEXT_CHECKOUTS):
        node = json.loads(json.dumps(checkout))
        node["id"] = f"checkout_outside_{index}"
        node["path"] = f"/outside/{index}"
        outside.append(node)
    scoped_graph["nodes"] = [json.loads(json.dumps(checkout)), *outside]

    capsule = compile_task_capsule(
        task={**TASK, "scope": [checkout["path"]]},
        graph=scoped_graph,
    )

    assert all(
        claim.get("subject_path") == checkout["path"]
        for claim in capsule["claims"]
    )


def test_direct_compilation_bounds_checkout_prefix_match_work(graph):
    matches = [
        {
            "path": "match.txt",
            "line": index,
            "term": "needle",
            "excerpt": "needle",
            "evidence": {"command": "git grep needle"},
        }
        for index in range(1, 1_001)
    ]
    content = _content_artifact(
        allowlist=["/"],
        terms=["needle"],
        checkouts=[
            _observed_content_checkout(
                "/" + "a" * 997 + str(index),
                matches=matches,
            )
            for index in range(2)
        ],
    )

    with pytest.raises(
        ValueError, match="content candidate work exceeds the compiler limit"
    ):
        compile_task_capsule(task=TASK, graph=graph, content=content)


def test_direct_compilation_bounds_checkout_prefix_omission_work(graph):
    omissions = [
        {
            "kind": "content_lines_truncated",
            "path": f"match-{index}.txt",
            "omitted_count": 1,
            "reason": "matched-line listing capped at 20 per file",
        }
        for index in range(6)
    ]
    content = _content_artifact(
        allowlist=["/"],
        checkouts=[
            _observed_content_checkout(
                "/" + "a" * 200_000,
                omissions=omissions,
            )
        ],
    )

    with pytest.raises(
        ValueError, match="content candidate work exceeds the compiler limit"
    ):
        compile_task_capsule(task=TASK, graph=graph, content=content)


def test_direct_compilation_bounds_content_scope_projection_work(graph):
    omissions = [
        {
            "kind": "content_lines_truncated",
            "path": f"match-{index}.txt",
            "omitted_count": 1,
            "reason": "matched-line listing capped at 20 per file",
        }
        for index in range(1_000)
    ]
    content = _content_artifact(
        checkouts=[
            _observed_content_checkout("/w/gadget", omissions=omissions)
        ],
    )

    with pytest.raises(
        ValueError,
        match="content scope work exceeds the compiler limit",
    ):
        compile_task_capsule(
            task={
                "question": "Summarize content.",
                "scope": [f"/scope/{index}" for index in range(1_000)],
            },
            graph=graph,
            content=content,
        )


def test_capsule_shape_binds_graphless_declared_checks(graph):
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("is_git_repository") or {}).get("value")
        is True
    )
    cwd = (
        (checkout["facts"].get("worktree_root") or {}).get("value")
        or checkout["path"]
    )
    declared = {
        "name": "declared-unit",
        "command": "python -m pytest",
        "cwd": cwd,
    }
    capsule = compile_task_capsule(
        task={
            **TASK,
            "scope": [checkout["path"]],
            "required_checks": [declared],
        },
        graph=graph,
    )
    assert is_task_capsule_shape(capsule)

    replaced = json.loads(json.dumps(capsule))
    replaced["required_checks"] = [
        {"name": "declared-unit", "command": "true", "cwd": cwd}
    ]
    assert not is_task_capsule_shape(replaced)


def test_graph_backed_package_scope_allows_enclosing_observed_checkout_cwd(graph):
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("is_git_repository") or {}).get("value")
        is True
    )
    cwd = (
        (checkout["facts"].get("worktree_root") or {}).get("value")
        or checkout["path"]
    )
    declared = {
        "name": "package-unit",
        "command": "python -m pytest",
        "cwd": cwd,
    }
    capsule = compile_task_capsule(
        task={
            **TASK,
            "scope": [f"{cwd}/pkg"],
            "required_checks": [declared],
        },
        graph=graph,
    )

    assert is_task_capsule_shape(capsule)
    assert verify_task_capsule_integrity(capsule)
    assert capsule_context_matches_graph(capsule, graph)


@pytest.mark.parametrize(
    ("scope", "cwd"),
    [
        ("/repo/pkg", "/repo/pkg/."),
        ("/repo/pkg", "/repo/pkg/../outside"),
        ("//server/share/pkg", "//server/share/pkg/../outside"),
    ],
    ids=["dot", "parent", "unc-parent"],
)
def test_compile_rejects_declared_check_cwd_dot_segments_before_graph_authorization(
    graph, scope, cwd
):
    with pytest.raises(ValueError, match="normalized"):
        compile_task_capsule(
            task={
                **TASK,
                "scope": [scope],
                "required_checks": [
                    {
                        "name": "unit",
                        "command": "python -m pytest",
                        "cwd": cwd,
                    }
                ],
            },
            graph=graph,
        )


@pytest.mark.parametrize(
    "declarations",
    [
        [{"name": "   ", "command": "python -m pytest"}],
        [{"name": "unit", "command": "   "}],
        [
            {"name": "unit", "command": "python -m pytest"},
            {"name": "unit", "command": "python -m pytest"},
        ],
    ],
    ids=["blank-name", "blank-command", "duplicate-name"],
)
def test_compile_rejects_ambiguous_declared_checks(graph, declarations):
    checkout = next(
        node
        for node in graph["nodes"]
        if node.get("kind") == "checkout"
        and (node.get("facts", {}).get("is_git_repository") or {}).get("value")
        is True
    )
    cwd = (
        (checkout["facts"].get("worktree_root") or {}).get("value")
        or checkout["path"]
    )
    checks = [{**declaration, "cwd": cwd} for declaration in declarations]

    with pytest.raises(ValueError, match="task.required_checks"):
        compile_task_capsule(
            task={
                **TASK,
                "scope": [checkout["path"]],
                "required_checks": checks,
            },
            graph=graph,
        )


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
    content = _content_artifact(
        checkouts=[
            _unknown_content_checkout(
                path,
                reason="grep_unavailable",
                evidence={"command": "git grep modified"},
            ),
            _unknown_content_checkout(
                "/not/a/graph/checkout",
                reason="unbound_content_search",
                evidence={"command": "git grep modified"},
            ),
        ],
        refusals=[
            _content_refusal(
                fx["paths"]["disallowed"],
                reason="outside_allowlist",
            )
        ],
    )

    capsule = compile_task_capsule(task=TASK, graph=graph, content=content)

    recorded = json.dumps(capsule["unknowns"]) + json.dumps(capsule["omissions"])
    assert "grep_unavailable" in recorded, (
        "a failed content search left no trace in the capsule"
    )
    assert "outside_allowlist" in recorded, (
        "a refused content root left no trace in the capsule"
    )
    assert "unbound_content_search" in recorded
    assert verify_task_capsule_integrity(capsule)


def test_direct_compilation_bounds_question_ranking_work(graph):
    question = " ".join(f"term{index}" for index in range(100_000))

    with pytest.raises(ValueError, match="question ranking work exceeds compiler limit"):
        compile_task_capsule(task={"question": question}, graph=graph)

def test_direct_compilation_bounds_filter_ranking_work(graph):
    filters = [
        {"field": "fact", "equals": f"fact-{index}"}
        for index in range(100_000)
    ]

    with pytest.raises(ValueError, match="filter ranking work exceeds compiler limit"):
        compile_task_capsule(
            task={"question": "status", "filters": filters},
            graph=graph,
        )



def test_direct_compilation_bounds_scalar_ranking_work(graph):
    huge_value = "x" * 500_000

    with pytest.raises(ValueError, match="scalar ranking work exceeds compiler limit"):
        compile_task_capsule(
            task={
                "question": huge_value,
                "filters": [{"field": "fact", "includes": huge_value}],
            },
            graph=graph,
        )
    large_surface_graph = json.loads(json.dumps(graph))
    next(
        node
        for node in large_surface_graph["nodes"]
        if node["kind"] == "checkout"
    )["label"] = huge_value
    with pytest.raises(
        ValueError, match="scalar ranking work exceeds compiler limit"
    ):
        compile_task_capsule(
            task={"question": "alpha beta gamma"},
            graph=large_surface_graph,
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
    content = observe_content(targets, allowlist=allowlist, terms=["content"], now=NOW)
    task = {"question": "What content exists?"}

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
    assert verify_task_capsule_integrity(capsule)


def test_zero_match_content_from_a_different_revision_is_reported_stale(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    targets = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    graph_now = project_workspace_graph(
        observe_checkouts(targets, allowlist=allowlist, now=NOW)
    )
    content = observe_content(
        targets,
        allowlist=allowlist,
        terms=["term-that-does-not-exist"],
        now=NOW,
    )
    for checkout in content["checkouts"]:
        assert checkout["matches"] == []
        checkout["head_revision"] = "0" * 40

    capsule = compile_task_capsule(
        task={"question": "Where is term-that-does-not-exist?"},
        graph=graph_now,
        content=content,
    )
    assert any(
        unknown.get("kind") == "content_snapshot_stale"
        for unknown in capsule["unknowns"]
    )
def test_content_binding_commits_effective_ignore_policy(fx):
    repo = fx["paths"]["canonical"]
    gitignore = os.path.join(repo, ".gitignore")
    assert not os.path.exists(gitignore)
    try:
        _write(gitignore, "# governed\n")
        before_observation = observe_checkouts(
            [repo], allowlist=[repo], now=NOW
        )
        before_graph = project_workspace_graph(before_observation)
        content = observe_content(
            [repo],
            allowlist=[repo],
            terms=["canonical"],
            now=NOW,
        )
        assert content["checkouts"][0]["matches"]
        content["checkouts"][0]["omissions"] = [
            {
                "kind": "content_lines_truncated",
                "path": "README.md",
                "omitted_count": 1,
                "reason": "matched-line listing capped at 20 per file",
            }
        ]
        capsule = compile_task_capsule(
            task={"question": "What canonical content exists?"},
            graph=before_graph,
            content=content,
        )

        _write(gitignore, "README.md\n")
        after_observation = observe_checkouts(
            [repo], allowlist=[repo], now=NOW
        )
        after_graph = project_workspace_graph(after_observation)

        before_checkout = next(
            node for node in before_graph["nodes"] if node["kind"] == "checkout"
        )
        after_checkout = next(
            node for node in after_graph["nodes"] if node["kind"] == "checkout"
        )
        assert (
            before_checkout["facts"]["head_revision"]
            == after_checkout["facts"]["head_revision"]
        )
        assert (
            before_checkout["facts"]["dirty_entries"]["value"]
            == after_checkout["facts"]["dirty_entries"]["value"]
        )
        assert (
            before_checkout["facts"]["content_privacy_fingerprint"]["value"]
            != after_checkout["facts"]["content_privacy_fingerprint"]["value"]
        )
        assert not capsule_context_matches_graph(
            capsule, after_graph, content
        )
        stale_capsule = compile_task_capsule(
            task={"question": "What canonical content exists?"},
            graph=after_graph,
            content=content,
        )
        stale_unknown = next(
            unknown
            for unknown in stale_capsule["unknowns"]
            if unknown.get("kind") == "content_snapshot_stale"
        )
        assert "effective privacy policy" in stale_unknown["reason"]
        assert not any(
            omission.get("kind") == "content_lines_truncated"
            for omission in stale_capsule["omissions"]
        )
    finally:
        if os.path.exists(gitignore):
            os.remove(gitignore)




def test_graph_context_rejects_deleted_content_snapshot_unknown(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    targets = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    graph_now = project_workspace_graph(
        observe_checkouts(targets, allowlist=allowlist, now=NOW)
    )
    content = observe_content(targets, allowlist=allowlist, terms=["modified"], now=NOW)
    for checkout in content["checkouts"]:
        checkout["head_revision"] = "0" * 40
    capsule = compile_task_capsule(
        task={"question": "What modified files exist?"},
        graph=graph_now,
        content=content,
    )
    forged = json.loads(json.dumps(capsule))
    forged["unknowns"] = [
        unknown
        for unknown in forged["unknowns"]
        if unknown.get("kind") != "content_snapshot_stale"
    ]
    forged["fingerprint"] = fingerprint(
        {
            key: value
            for key, value in forged.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )

    assert verify_task_capsule_integrity(forged)
    assert capsule_context_matches_graph(capsule, graph_now, content)
    assert not capsule_context_matches_graph(forged, graph_now, content)
    assert not capsule_context_matches_graph(capsule, graph_now)


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
        assert verify_task_capsule_integrity(capsule)

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

        # 5. An explicit task list adds a checkout-bound command without
        # replacing evidence-backed derived checks.
        explicit_check = {
            "name": "mine",
            "command": "make check",
            "cwd": normalize_path(repo),
        }
        explicit = compile_for(
            task={
                **TASK,
                "required_checks": [explicit_check],
            }
        )
        assert project_test in explicit["required_checks"]
        assert explicit_check in explicit["required_checks"]
        assert not any(
            unknown.get("kind") == "required_check_undetermined"
            for unknown in explicit["unknowns"]
        )

        with pytest.raises(ValueError, match="cannot rewrite"):
            compile_for(
                task={
                    **TASK,
                    "required_checks": [
                        {
                            "name": project_test["name"],
                            "command": "true",
                            "cwd": normalize_path(repo),
                        }
                    ],
                }
            )
    finally:
        for name in ("tropo.toml", "AGENTS.md", "STRATO.md", "pyproject.toml", "package.json"):
            path = os.path.join(repo, name)
            if os.path.exists(path):
                os.remove(path)



def test_declared_required_check_resolves_only_its_checkout(fx):
    roots = [fx["paths"]["canonical"], fx["paths"]["staleNeighbor"]]
    normalized_roots = [normalize_path(root) for root in roots]
    for root in roots:
        _write(os.path.join(root, "pyproject.toml"), "[project]\nname = 'x'\n")

    try:
        observation = observe_checkouts(roots, allowlist=roots, now=NOW)
        graph = project_workspace_graph(observation)
        explicit = {
            "name": "python-tests",
            "command": "python -m pytest",
            "cwd": normalized_roots[0],
        }
        capsule = compile_task_capsule(
            task={
                **TASK,
                "scope": normalized_roots,
                "required_checks": [explicit],
            },
            graph=graph,
        )
        unresolved_paths = {
            unknown["subject_path"]
            for unknown in capsule["unknowns"]
            if unknown.get("kind") == "required_check_undetermined"
        }
        assert unresolved_paths == {normalized_roots[1]}

        ancestor_scope = normalize_path(
            os.path.join(normalized_roots[0], "package")
        )
        ancestor = compile_task_capsule(
            task={
                **TASK,
                "scope": [ancestor_scope],
                "required_checks": [explicit],
            },
            graph=graph,
        )
        assert ancestor["required_checks"] == [explicit]
        assert not any(
            unknown.get("kind") == "required_check_undetermined"
            for unknown in ancestor["unknowns"]
        )

        relocated_graph = json.loads(json.dumps(graph))
        relocated_checkout = next(
            node
            for node in relocated_graph["nodes"]
            if node.get("kind") == "checkout"
            and node.get("path") == normalized_roots[0]
        )
        relocated_checkout["facts"]["worktree_root"]["value"] = normalized_roots[1]
        relocated_in_scope = compile_task_capsule(
            task={
                **TASK,
                "scope": [normalized_roots[0]],
                "required_checks": [
                    {
                        **explicit,
                        "cwd": normalized_roots[1],
                    }
                ],
            },
            graph=relocated_graph,
        )
        assert relocated_in_scope["required_checks"] == [
            {
                **explicit,
                "cwd": normalized_roots[1],
            }
        ]
        assert not any(
            unknown.get("kind") == "required_check_undetermined"
            for unknown in relocated_in_scope["unknowns"]
        )
        with pytest.raises(ValueError, match="related to task.scope"):
            compile_task_capsule(
                task={
                    **TASK,
                    "scope": [ancestor_scope],
                    "required_checks": [
                        {
                            **explicit,
                            "cwd": normalized_roots[1],
                        }
                    ],
                },
                graph=relocated_graph,
            )

        nested_observation = json.loads(json.dumps(observation))
        nested_root = normalize_path(
            os.path.join(normalized_roots[0], "nested-checkout")
        )
        inner_observation = next(
            checkout
            for checkout in nested_observation["checkouts"]
            if checkout.get("path") == normalized_roots[1]
        )
        inner_observation["path"] = nested_root
        inner_observation["facts"]["worktree_root"]["value"] = nested_root
        nested_graph = project_workspace_graph(nested_observation)
        inner_check = {**explicit, "cwd": nested_root}
        inner_capsule = compile_task_capsule(
            task={
                **TASK,
                "scope": [nested_root],
                "required_checks": [inner_check],
            },
            graph=nested_graph,
        )
        assert inner_capsule["required_checks"] == [inner_check]
        with pytest.raises(ValueError, match="related to task.scope"):
            compile_task_capsule(
                task={
                    **TASK,
                    "scope": [nested_root],
                    "required_checks": [explicit],
                },
                graph=nested_graph,
            )
        nested_base = compile_task_capsule(
            task={**TASK, "scope": [nested_root]},
            graph=nested_graph,
        )
        assert capsule_context_matches_graph(nested_base, nested_graph)
        forged_outer_check = json.loads(json.dumps(nested_base))
        forged_outer_check["task"]["required_checks"] = [explicit]
        forged_outer_check["required_checks"] = [explicit]
        assert not capsule_context_matches_graph(
            forged_outer_check, nested_graph
        )

        with pytest.raises(ValueError, match="related to task.scope"):
            compile_task_capsule(
                task={
                    **TASK,
                    "scope": [normalized_roots[0]],
                    "required_checks": [
                        {
                            **explicit,
                            "cwd": normalized_roots[1],
                        }
                    ],
                },
                graph=graph,
            )
    finally:
        for root in roots:
            os.remove(os.path.join(root, "pyproject.toml"))


def test_required_checks_run_at_the_observed_worktree_root(fx):
    repo = fx["paths"]["canonical"]
    nested = os.path.join(repo, "nested")
    os.makedirs(nested, exist_ok=True)
    for name in ("tropo.toml", "AGENTS.md", "STRATO.md"):
        _write(os.path.join(repo, name), f"# {name}\n")

    try:
        graph = project_workspace_graph(
            observe_checkouts([nested], allowlist=[repo], now=NOW)
        )
        explicit = {
            "name": "manual-tests",
            "command": "python -m pytest",
            "cwd": normalize_path(repo),
        }
        capsule = compile_task_capsule(
            task={
                **TASK,
                "scope": [normalize_path(nested)],
                "required_checks": [explicit],
            },
            graph=graph,
        )
        assert capsule["required_checks"]
        assert all(
            check["cwd"] == normalize_path(repo)
            for check in capsule["required_checks"]
        )
        assert explicit in capsule["required_checks"]
        assert capsule_context_matches_graph(capsule, graph)
    finally:
        for name in ("tropo.toml", "AGENTS.md", "STRATO.md"):
            marker = os.path.join(repo, name)
            if os.path.exists(marker):
                os.remove(marker)
        os.rmdir(nested)


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


def _rehash_capsule(capsule):
    body = {
        key: value
        for key, value in capsule.items()
        if key not in {"capsule_id", "fingerprint"}
    }
    for claim in capsule["claims"]:
        claim["id"] = deterministic_id(
            "claim",
            {
                "subject": claim.get("subject"),
                "fact": claim.get("fact"),
                "claim": claim.get("claim"),
            },
        )
    capsule["fingerprint"] = fingerprint(body)


def _nested_keys(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            yield key
            yield from _nested_keys(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _nested_keys(nested)


def test_public_capsule_projection_is_deterministic_bounded_and_private(graph, fx):
    root = normalize_path(fx["paths"]["canonical"])
    capsule = compile_task_capsule(
        task={**TASK, "scope": [root]},
        graph=graph,
    )

    first = project_public_task_capsule(capsule, checkout_path=root)
    second = project_public_task_capsule(capsule, checkout_path=root)

    assert first == second
    assert verify_public_task_capsule_integrity(first, checkout_path=root)
    assert first["fingerprint"] == fingerprint(
        {key: value for key, value in first.items() if key != "fingerprint"}
    )
    assert len(first["claims"]) <= 24
    assert all(len(first[field]) <= 64 for field in ("unknowns", "omissions", "required_checks"))
    serialized = json.dumps(first, sort_keys=True)
    assert root not in serialized
    assert root.replace("/", "\\\\") not in serialized
    assert not {
        "command",
        "cwd",
        "evidence",
        "observed_at",
        "scope",
        "subject_path",
        "task",
    }.intersection(_nested_keys(first))
    assert first["complete"] is False
    assert first["projection_omissions"]

    tampered = json.loads(json.dumps(first))
    tampered["capsule_id"] = "capsule_0000000000000000"
    assert not verify_public_task_capsule_integrity(tampered, checkout_path=root)


@pytest.mark.parametrize(
    "unsafe_text",
    [
        "password=do-not-disclose",
        "Authorization: Bearer-do-not-disclose",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "https://user:credential@example.invalid/repository",
        "password\u200b=do-not-disclose",
        "ｐａｓｓｗｏｒｄ=do-not-disclose",
        "/home/private/repository",
        "/usr/local/private/repository",
        "/data/private/repository",
        r"\\server\share\repository",
        "see `/usr/local/private/repository`",
        "source:/data/private/repository",
        "AKIA0123456789ABCDEF",
        "ghp_0123456789abcdefghijkl",
    ],
)
def test_public_capsule_projection_omits_credential_and_machine_material(
    graph, fx, unsafe_text
):
    root = normalize_path(fx["paths"]["canonical"])
    capsule = compile_task_capsule(
        task={**TASK, "scope": [root]},
        graph=graph,
    )
    capsule["claims"][0]["claim"] = unsafe_text
    _rehash_capsule(capsule)
    assert verify_task_capsule_integrity(capsule)

    projected = project_public_task_capsule(
        capsule,
        checkout_path=normalize_path(fx["paths"]["canonical"]),
    )

    assert unsafe_text not in json.dumps(projected, ensure_ascii=False)
    assert any(
        row["kind"] == "claim" and row["reason"] == "unsafe_for_public_projection"
        for row in projected["projection_omissions"]
    )
    assert projected["complete"] is False


def test_public_capsule_projection_never_exposes_content_excerpts(fx):
    paths = fx["paths"]
    roots = [
        paths["canonical"],
        paths["staleNeighbor"],
        paths["dirty"],
        paths["noOrigin"],
    ]
    allowlist = list(roots)
    content_graph = project_workspace_graph(
        observe_checkouts(roots, allowlist=allowlist, now=NOW)
    )
    content = observe_content(
        roots,
        allowlist=allowlist,
        terms=["original"],
        now=NOW,
    )
    unscoped = compile_task_capsule(
        task={"question": "What original files exist?"},
        graph=content_graph,
        content=content,
    )
    root = next(
        claim["subject_path"]
        for claim in unscoped["claims"]
        if claim["fact"] == "content_match"
    )
    capsule = compile_task_capsule(
        task={"question": "What original files exist?", "scope": [root]},
        graph=content_graph,
        content=content,
    )
    content_claim = next(
        claim for claim in capsule["claims"] if claim["fact"] == "content_match"
    )

    projected = project_public_task_capsule(
        capsule,
        checkout_path=root,
    )

    assert content_claim["claim"] not in json.dumps(projected)
    assert not any(claim["fact"] == "content_match" for claim in projected["claims"])


def test_public_capsule_projection_refuses_unverified_or_noncanonical_input(graph, fx):
    root = normalize_path(fx["paths"]["canonical"])
    capsule = compile_task_capsule(
        task={**TASK, "scope": [root]},
        graph=graph,
    )
    capsule["claims"][0]["claim"] = "forged without updating integrity"

    with pytest.raises(ValueError, match="projection refused"):
        project_public_task_capsule(
            capsule,
            checkout_path=root,
        )
    with pytest.raises(ValueError, match="projection refused"):
        project_public_task_capsule(
            compile_task_capsule(
                task={**TASK, "scope": [root]},
                graph=graph,
            ),
            checkout_path="relative/root",
        )


def test_public_capsule_projection_requires_exact_single_root_scope(graph, fx):
    root = normalize_path(fx["paths"]["canonical"])
    other_root = normalize_path(fx["paths"]["staleNeighbor"])

    for task, checkout_path in (
        (TASK, root),
        ({**TASK, "scope": [root]}, other_root),
        ({**TASK, "scope": [root, other_root]}, root),
    ):
        capsule = compile_task_capsule(task=task, graph=graph)
        with pytest.raises(ValueError, match="projection refused"):
            project_public_task_capsule(
                capsule,
                checkout_path=checkout_path,
            )


def test_public_capsule_schema_is_closed_local_ref_only_and_fresh():
    schema = public_task_capsule_json_schema()
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"

    def inspect(value):
        if isinstance(value, dict):
            if value.get("type") == "object":
                assert value.get("additionalProperties") is False
            if "$ref" in value:
                assert value["$ref"].startswith("#/")
            for nested in value.values():
                inspect(nested)
        elif isinstance(value, list):
            for nested in value:
                inspect(nested)

    inspect(schema)
    schema["properties"].clear()
    assert public_task_capsule_json_schema()["properties"]
