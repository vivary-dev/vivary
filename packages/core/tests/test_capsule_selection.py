"""Translation of tests/capsule-selection.test.mjs (slice 2, decision 0008)
for the Python port (python/vivary_core/capsule_select.py, capsule_compile.py).

Node's capsule-selection.test.mjs builds its `graph` fixture (and derived
`conflictSubjects`/`checkoutIdByLabel` maps) via a `before()` hook that calls
observeCheckouts (src/workspace/observe.mjs) and projectWorkspaceGraph
(src/workspace/model.mjs) over real disposable git repositories built by
tests/helpers/fixtures.mjs. Those Python ports (workspace_observe.py /
workspace_model.py) now live in python/vivary_core/, so this file builds the
same real git fixtures - pinned identity/date, isolated global/system config
- as a module-scoped pytest fixture and runs the pipeline for real, mirroring
python/tests/test_capsule.py's/test_model.py's precedent of self-contained
per-file fixture plumbing rather than a shared fixtures module.

The "fact-family budget ranking (#59)" describe block is fully portable: it
builds its own synthetic graph and candidate lists inline and calls
select_claims directly, with no dependency on the observe/model pipeline. It
was already translated in full - this is the block that actually exercises
the budget-rank fix (#59) this module ports.

The fixture tree is built under the OS temp directory (tempfile.mkdtemp,
with no `dir=` pointing back into this repo) rather than a fixed path under
python/tests/ - see python/tests/test_capsule.py's identical rationale for
why (git directory-discovery escape risk).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

from vivary_core.capsule_compile import compile_task_capsule  # noqa: E402
from vivary_core.capsule_select import select_claims  # noqa: E402
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
    base_dir = tempfile.mkdtemp(prefix="vivary-capsule-selection-fixtures-")
    try:
        yield build_fixtures(base_dir)
    finally:
        _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def graph(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]], allowlist=allowlist, now=NOW
    )
    return project_workspace_graph(observation)


@pytest.fixture(scope="module")
def conflict_subjects(graph):
    subjects = set()
    for conflict in graph["conflicts"]:
        for side in conflict["sides"]:
            subjects.add(side["checkout"])
    return subjects


@pytest.fixture(scope="module")
def checkout_id_by_label(graph):
    return {n["label"]: n["id"] for n in graph["nodes"] if n["kind"] == "checkout"}


# -- tests over the real observe/model pipeline ------------------------------


def test_budget_cuts_are_relevance_ranked_every_conflict_side_claim_survives_a_tight_budget(
    graph, conflict_subjects, checkout_id_by_label
):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 9})
    assert len(capsule["claims"]) == 9
    for claim in capsule["claims"]:
        assert claim["subject"] in conflict_subjects, (
            f"off-conflict claim survived: {claim['subject_path']} {claim['fact']}"
        )
    overflow = next((o for o in capsule["omissions"] if o["kind"] == "claims_over_budget"), None)
    assert overflow is not None
    for cut in overflow["omitted"]:
        cut_subject = checkout_id_by_label.get(cut["subject_path"].rstrip("/").split("/")[-1])
        assert cut_subject not in conflict_subjects, (
            f"conflict-side claim was cut while off-task claims survived: {cut['subject_path']} {cut['fact']}"
        )


def test_within_a_subject_the_weakest_fact_is_cut_first_last_fetch_goes_before_identity_facts(graph):
    # 9 conflict-side claims exist; at budget 8 the single cut inside the
    # conflict tier must be last_fetch - the dogfood run proved fetch
    # recency is the least trustworthy signal, so it is the first sacrifice.
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 8})
    assert all(c["fact"] != "last_fetch" for c in capsule["claims"])
    overflow = next(o for o in capsule["omissions"] if o["kind"] == "claims_over_budget")
    assert any(cut["fact"] == "last_fetch" and cut["tier"] == "conflict_side" for cut in overflow["omitted"])


def test_selection_reasons_are_claim_specific_and_the_explain_object_names_the_signal(graph, conflict_subjects):
    capsule = compile_task_capsule(task=TASK, graph=graph)
    reasons = {c["selection_reason"] for c in capsule["claims"]}
    assert len(reasons) >= 2, "selection reasons are still one boilerplate string"
    for claim in capsule["claims"]:
        assert claim.get("selection"), f"claim {claim['id']} lacks structured selection explain"
        assert claim["selection"]["tier"] in ("conflict_side", "question_match", "allowlisted")
        assert isinstance(claim["selection"]["signals"], list) and len(claim["selection"]["signals"]) > 0
    conflict_claims = [c for c in capsule["claims"] if c["subject"] in conflict_subjects]
    assert len(conflict_claims) > 0
    for claim in conflict_claims:
        assert claim["selection"]["tier"] == "conflict_side"
        assert "conflict" in claim["selection_reason"]
        signal = next(s for s in claim["selection"]["signals"] if s["signal"] == "conflict_side")
        assert any(c["id"] == signal["conflict"] for c in graph["conflicts"])


def test_task_question_terms_rank_subjects_above_the_baseline_and_the_explain_names_term_and_field(
    graph, checkout_id_by_label
):
    task = {"question": "Is the dirty tree safe to prune?"}
    capsule = compile_task_capsule(task=task, graph=graph, budget={"max_claims": 13})
    dirty_id = checkout_id_by_label["dirty"]
    no_origin_id = checkout_id_by_label["no-origin"]
    dirty_claims = [c for c in capsule["claims"] if c["subject"] == dirty_id]
    assert len(dirty_claims) > 0
    for claim in dirty_claims:
        assert claim["selection"]["tier"] == "question_match"
        signal = next(s for s in claim["selection"]["signals"] if s["signal"] == "question_term_match")
        assert signal["term"] == "dirty"
        assert signal["field"] == "label"
        assert "'dirty'" in claim["selection_reason"]
    # The question-matched subject fills the budget before the unmatched one.
    assert not any(c["subject"] == no_origin_id for c in capsule["claims"])


def test_structured_equals_filter_restricts_candidates_and_records_which_field_matched(graph):
    task = {**TASK, "filters": [{"field": "fact", "equals": "head_revision"}]}
    capsule = compile_task_capsule(task=task, graph=graph)
    assert len(capsule["claims"]) == 4
    for claim in capsule["claims"]:
        assert claim["fact"] == "head_revision"
        assert claim["selection"]["matched_filters"] == [
            {"field": "fact", "operator": "equals", "value": "head_revision"}
        ]
    filtered = next(o for o in capsule["omissions"] if o["kind"] == "filtered_out")
    assert filtered["omitted_count"] == 14
    assert filtered["filters"] == task["filters"]
    assert capsule["task"]["filters"] == task["filters"]


def test_structured_includes_filter_matches_on_label(graph, checkout_id_by_label):
    task = {**TASK, "filters": [{"field": "label", "includes": "origin"}]}
    capsule = compile_task_capsule(task=task, graph=graph)
    no_origin_id = checkout_id_by_label["no-origin"]
    assert len(capsule["claims"]) > 0
    for claim in capsule["claims"]:
        assert claim["subject"] == no_origin_id
        assert claim["selection"]["matched_filters"] == [
            {"field": "label", "operator": "includes", "value": "origin"}
        ]


def test_unknown_filter_fields_and_malformed_operators_fail_closed(graph):
    with pytest.raises(ValueError, match="task.filters is invalid"):
        compile_task_capsule(task={**TASK, "filters": [{"field": "frontmatter", "equals": "x"}]}, graph=graph)
    with pytest.raises(ValueError, match="task.filters is invalid"):
        compile_task_capsule(
            task={**TASK, "filters": [{"field": "fact", "equals": "a", "includes": "b"}]}, graph=graph
        )
    with pytest.raises(ValueError, match="task.filters is invalid"):
        compile_task_capsule(task={**TASK, "filters": [{"field": "fact"}]}, graph=graph)


def test_the_over_budget_omission_lists_every_cut_with_its_tier_bounded_by_a_cap(graph):
    capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 1})
    overflow = next(o for o in capsule["omissions"] if o["kind"] == "claims_over_budget")
    assert overflow["omitted_count"] == 17
    assert len(overflow["omitted"]) == 16
    for cut in overflow["omitted"]:
        assert cut.get("subject_path")
        assert cut.get("fact")
        assert cut["tier"] in ("conflict_side", "question_match", "allowlisted")


def test_selection_explains_never_echo_subject_values_or_private_content(graph, fx):
    task = {"question": "Which vivary checkout is canonical and dirty?"}
    capsule = compile_task_capsule(task=task, graph=graph)
    explains = json.dumps(
        [{"selection": c["selection"], "reason": c["selection_reason"]} for c in capsule["claims"]]
    )
    fixture_dir = fx["paths"]["base"].replace("\\", "/")
    assert fixture_dir not in explains
    assert "secrets" not in explains.lower()
    assert "private-note" not in explains


def test_selection_is_deterministic_and_filters_enter_the_capsule_identity(graph):
    task = {**TASK, "filters": [{"field": "fact", "equals": "head_revision"}]}
    a = compile_task_capsule(task=task, graph=graph)
    b = compile_task_capsule(task=task, graph=graph)
    assert a["fingerprint"] == b["fingerprint"]
    assert a["capsule_id"] == b["capsule_id"]
    unfiltered = compile_task_capsule(task=TASK, graph=graph)
    assert a["capsule_id"] != unfiltered["capsule_id"]


# --- Fact-family budget ranking (#59) ---------------------------------------
# The dogfood autopsy this ticket fixes: a conflict-side subject's
# content_match facts inherited the whole subject's conflict_side tier for
# budget purposes, so a flood of generic grep hits from one checkout crowded
# out a completely different subject's baseline identity facts outright. A
# synthetic, hand-built graph/candidate set (select_claims called directly,
# bypassing observe/compile) isolates the ranking property from any real
# fixture's specific shape - deliberately not tuned to any task's answer key,
# just a generic flood-vs-baseline-coverage scenario. Fully portable: no
# fixture pipeline involved.

FLOODED_ID = "checkout_flooded"
OTHER_ID = "checkout_other"
FLOOD_COUNT = 14  # matches the dogfood autopsy's measured 13-14 hit flood

SYNTHETIC_GRAPH = {
    "nodes": [
        {
            "kind": "checkout",
            "id": FLOODED_ID,
            "label": "flooded",
            "path": "workspace://flooded",
            "facts": {"head_ref": {"status": "known", "value": {"kind": "branch", "name": "main"}}},
        },
        {
            "kind": "checkout",
            "id": OTHER_ID,
            "label": "other",
            "path": "workspace://other",
            "facts": {"head_ref": {"status": "known", "value": {"kind": "branch", "name": "main"}}},
        },
    ],
    "edges": [],
    # `flooded` is the (sole-named-side, for this synthetic scenario) side of
    # an unresolved conflict - real conflicts always carry >=2 sides, but
    # rank_claim/subject_profiles only ever look at whether a subject's OWN
    # conflict list is non-empty, so one side suffices to exercise the
    # conflict_side tier path this test targets.
    "conflicts": [{"id": "conflict_1", "kind": "divergent_checkouts", "sides": [{"checkout": FLOODED_ID}]}],
}


def _flooded_identity_candidates():
    return [
        {"subject": FLOODED_ID, "subject_path": "workspace://flooded", "claim": "HEAD revision is aaa", "fact": "head_revision", "status": "known", "evidence": []},
        {"subject": FLOODED_ID, "subject_path": "workspace://flooded", "claim": "HEAD is on branch 'main'", "fact": "head_ref", "status": "known", "evidence": []},
        {"subject": FLOODED_ID, "subject_path": "workspace://flooded", "claim": "worktree is clean", "fact": "is_dirty", "status": "known", "evidence": []},
    ]


def _flooded_content_candidates():
    return [
        {
            "subject": FLOODED_ID,
            "subject_path": "workspace://flooded",
            "claim": f"file-{i:02d}.md:1 matches 'x': \"generic boilerplate line {i}\"",
            "fact": "content_match",
            "status": "known",
            "evidence": [],
        }
        for i in range(FLOOD_COUNT)
    ]


def _other_identity_candidates():
    return [
        {"subject": OTHER_ID, "subject_path": "workspace://other", "claim": "HEAD revision is bbb", "fact": "head_revision", "status": "known", "evidence": []},
        {"subject": OTHER_ID, "subject_path": "workspace://other", "claim": "HEAD is on branch 'main'", "fact": "head_ref", "status": "known", "evidence": []},
        {"subject": OTHER_ID, "subject_path": "workspace://other", "claim": "worktree is clean", "fact": "is_dirty", "status": "known", "evidence": []},
    ]


# A question with no term matching either subject's label/branch, so `other`
# lands in the weakest (allowlisted) tier - the tier furthest from
# conflict_side, and the one the old ranking could never protect from a
# conflict-side content-match flood no matter how large the budget got short
# of exhausting the entire flood first. NOTE: this shadows the module-level
# TASK-shaped fixture used by the (skipped) top-level tests above - this is
# a deliberate re-scoping, matching tests/capsule-selection.test.mjs's own
# `describe` block, which locally redefines `TASK` for this exact reason.
FLOOD_TASK = {"question": "What is the state of this workspace?"}


def test_tight_budget_ranks_every_content_match_below_the_flooded_subjects_own_identity_facts():
    candidates = [*_flooded_identity_candidates(), *_flooded_content_candidates(), *_other_identity_candidates()]
    result = select_claims(task=FLOOD_TASK, graph=SYNTHETIC_GRAPH, candidates=candidates, max_claims=3)
    included = result["included"]
    assert len(included) == 3
    for claim in included:
        assert claim["subject"] == FLOODED_ID
        assert claim["fact"] != "content_match", (
            "identity facts must fill the budget before any content_match, even the flooded subject's own"
        )


def test_a_single_content_match_hit_still_outranks_a_lower_tier_subjects_identity_facts():
    # Budget for: flooded's 3 identity facts + exactly 1 content_match.
    candidates = [*_flooded_identity_candidates(), *_flooded_content_candidates(), *_other_identity_candidates()]
    result = select_claims(task=FLOOD_TASK, graph=SYNTHETIC_GRAPH, candidates=candidates, max_claims=4)
    included = result["included"]
    assert len(included) == 4
    content_included = [c for c in included if c["fact"] == "content_match"]
    assert len(content_included) == 1, (
        "the flooded subject's single strongest content_match still wins a slot ahead of `other`'s identity facts"
    )
    assert not any(c["subject"] == OTHER_ID for c in included)


def test_the_fix_at_a_budget_the_flood_alone_could_previously_exhaust_entirely_others_identity_facts_now_survive_the_cut():
    # 3 (flooded identity) + 14 (flood) = 17 candidates that are ALL
    # conflict_side tier. Before #59, sortKey was strictly [tier, weight,
    # ...]: every one of those 17 ranks ahead of ANY allowlisted-tier claim
    # regardless of budget, so `other`'s 3 identity facts could only ever
    # appear at budget >= 18 (past the entire flood) - "ranking does no
    # useful exclusion". At budget 15, comfortably inside the flood's own
    # size (17 > 15), `other`'s claims must still get in.
    candidates = [*_flooded_identity_candidates(), *_flooded_content_candidates(), *_other_identity_candidates()]
    result = select_claims(task=FLOOD_TASK, graph=SYNTHETIC_GRAPH, candidates=candidates, max_claims=15)
    included = result["included"]
    over_budget = result["over_budget"]
    assert len(included) == 15
    other_included = [c for c in included if c["subject"] == OTHER_ID]
    assert len(other_included) == 3, (
        "`other`'s identity facts must all survive - the flood alone (17 candidates) exceeds this budget (15)"
    )
    for claim in other_included:
        assert claim["selection"]["tier"] == "allowlisted"
    # The flooded subject's identity facts always survive too (same-subject
    # law: identity ahead of content_match is unconditional).
    assert len([c for c in included if c["subject"] == FLOODED_ID and c["fact"] != "content_match"]) == 3
    assert over_budget is not None and over_budget["omitted_count"] > 0, (
        "the flood is large enough that something real is still cut - this is diminishing returns, not deletion"
    )


def test_retroactive_red_green_this_exact_scenario_fails_against_the_pre_59_flat_weight_ranking():
    # Reimplements the OLD (pre-#59) sortKey inline - [tier, flat weight 5
    # for every content_match, tiebreak] - to prove this test module
    # actually discriminates old from new behavior, not just describing the
    # new one. select.mjs's `surviving.sort` comparator used plain JS `<`/`>`
    # on the sortKey tuple, which for strings is UTF-16-code-unit order (see
    # capsule_select.py's module docstring) - reproduced here the same way.
    from vivary_core.canonical import utf16_sort_key

    old_fact_weights = {
        "head_revision": 0,
        "head_ref": 1,
        "is_dirty": 2,
        "dirty_entries": 2.5,
        "remotes": 3,
        "last_fetch": 4,
        "content_match": 5,
    }
    old_tier_names = ["conflict_side", "question_match", "allowlisted"]

    def old_rank_tier(subject_id):
        return 0 if subject_id == FLOODED_ID else 2  # flooded is the only conflict side here; other is allowlisted

    candidates = [*_flooded_identity_candidates(), *_flooded_content_candidates(), *_other_identity_candidates()]
    surviving = [
        {
            "subject": c["subject"],
            "fact": c["fact"],
            "sort_key": (
                old_rank_tier(c["subject"]),
                old_fact_weights.get(c["fact"], 9),
                utf16_sort_key(f"{c['subject']}:{c['fact']}:{c['claim']}"),
            ),
        }
        for c in candidates
    ]
    surviving.sort(key=lambda s: s["sort_key"])
    old_included = surviving[:15]
    old_other_included = [c for c in old_included if c["subject"] == OTHER_ID]
    assert len(old_other_included) == 0, (
        "confirms the OLD ranking crowds `other` out entirely at this budget - the defect #59 fixes"
    )
    assert len(old_tier_names) == 3, "sanity: three tiers, matching the live TIER_NAMES contract"
