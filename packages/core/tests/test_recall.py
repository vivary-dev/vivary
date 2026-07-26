"""Pytest translation of tests/recall.test.mjs (graduation slice 6, ticket
#12, decision 0008). docs/NEAR-NEIGHBOR-POLICY.md is the verbatim source of
truth: "near neighbor" is a retrieval signal, never permission to overwrite.
Candidates may only reference existing graph nodes by identity; a recall
provider is optional, and its absence degrades to a clean structured no-op,
never a throw and never a fabricated decision.

Outcome vocabulary note: docs/NEAR-NEIGHBOR-POLICY.md's "Outcomes" section (a
closed 8-item enum) lists review_required, corroboration_recorded, and
superseded_explicitly, but NOT identity_unresolved - that appears only as a
reason code attached to review_required, both in the matrix ("ambiguous
subject identity -> add `identity_unresolved`, return `review_required`")
and in docs/ARCHITECTURE.md's ContextIntegrityEvent example
(`"decision": "review_required", "reason_codes": ["identity_unresolved", ...]`).
recall_outcomes.py's OUTCOME constants therefore hold exactly the three
outcomes this ticket implements; identity_unresolved is exported as a reason
code.

ADAPTATION: the real-fixture-graph test builds real temp git repositories,
the same way python/tests/test_observe.py's own local `build_fixtures`/
`_git`/`_commit_file` helpers do (that file's docstring notes this mirrors
tests/helpers/fixtures.mjs and is "re-expressed as a local pytest fixture/
helpers in this one owned file, the same pattern python/tests/test_evidence.py
uses for its own fixtures") - this file follows the same house pattern,
trimmed to just the origin/canonical/stale-neighbor/no-origin shapes the Node
recall test actually consumes (tests/helpers/fixtures.mjs's `dirty`,
`detached`, `spaced`, and `disallowed` shapes are not exercised by
tests/recall.test.mjs and are omitted here).
"""

from __future__ import annotations

import glob
import os
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from vivary_core.recall_outcomes import (  # noqa: E402
    ACTIVE_TRUTH_NEW_VERSION_ACTIVE,
    ACTIVE_TRUTH_UNCHANGED,
    CORROBORATION_RECORDED,
    OUTCOMES,
    REASON_ACTOR_NOT_AUTHORIZED,
    REASON_AUTHORED_TRUTH_PROTECTED,
    REASON_CONFLICTS_WITH,
    REASON_EXACT_DUPLICATE_OUT_OF_SCOPE,
    REASON_EXPLICIT_CORRECTION,
    REASON_IDENTITY_UNRESOLVED,
    REASON_INDEPENDENT_EVIDENCE,
    REASON_NO_SIMILAR_NEIGHBOR,
    REASON_RECALL_PROVIDER_ABSENT,
    REASON_RECALL_PROVIDER_FAILED,
    REASON_SUPERSESSION_INPUTS_INCOMPLETE,
    REASON_SUPERSESSION_SUBJECT_MISMATCH,
    REASON_SUPERSESSION_TARGET_MISSING,
    REVIEW_REQUIRED,
    STATUS_EVALUATED,
    STATUS_NO_PROVIDER,
    STATUS_PROVIDER_DEGRADED,
    SUPERSEDED_EXPLICITLY,
)
from vivary_core.recall_classify import classify_candidate  # noqa: E402
from vivary_core.recall_firewall import evaluate_candidate  # noqa: E402
from vivary_core.workspace_observe import observe_checkouts  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402

FIXTURE_BASE = os.path.join(HERE, ".fixtures", "recall")


def NOW():
    return "2026-07-21T12:00:00.000Z"


# -- fixture plumbing (trimmed port of tests/helpers/fixtures.mjs's
# buildFixtures, matching python/tests/test_observe.py's local pattern) ------

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP = datetime(2026, 7, 2, 0, 0, 0, tzinfo=timezone.utc)


def _rmtree_force(path):
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
    """Trimmed port of tests/helpers/fixtures.mjs's buildFixtures: only the
    shared-origin (canonical + stale-neighbor) and no-origin shapes the Node
    recall test actually consumes."""
    _rmtree_force(base_dir)
    os.makedirs(base_dir, exist_ok=True)
    with open(os.path.join(base_dir, "empty-gitconfig"), "w", encoding="utf-8") as handle:
        handle.write("")

    paths = {
        "base": base_dir,
        "origin": os.path.join(base_dir, "origin.git"),
        "canonical": os.path.join(base_dir, "canonical"),
        "stale_neighbor": os.path.join(base_dir, "stale-neighbor"),
        "no_origin": os.path.join(base_dir, "no-origin"),
    }

    # Shared origin with two checkouts: canonical at commit B, the stale
    # neighbor cloned while origin was still at commit A. Both are clean;
    # they simply disagree about where main is. That ambiguity is the
    # fixture, and gives the graph its one proven-identity (known) repository
    # node.
    _git(base_dir, base_dir, ["init", "-q", "--bare", "-b", "main", paths["origin"]])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["canonical"]])
    _commit_file(base_dir, paths["canonical"], "README.md", "# canonical\n", "commit A")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["stale_neighbor"]])
    _commit_file(base_dir, paths["canonical"], "NOTES.md", "commit B content\n", "commit B")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])

    canonical_fetch_head = os.path.join(paths["canonical"], ".git", "FETCH_HEAD")
    stamp = FETCH_STAMP.timestamp()
    if os.path.exists(canonical_fetch_head):
        os.utime(canonical_fetch_head, (stamp, stamp))

    # No remotes configured at all: identity_status stays "unknown" - the
    # not-proven repository node the real-fixture test needs.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["no_origin"]])
    _commit_file(base_dir, paths["no_origin"], "solo.md", "solo\n", "solo")

    return {"paths": paths}


@pytest.fixture(scope="module")
def fx():
    base_dir = FIXTURE_BASE
    result = build_fixtures(base_dir)
    yield result
    _rmtree_force(base_dir)


# -- synthetic graph + candidate/neighbor builders ---------------------------


def synthetic_graph(nodes):
    return {
        "schema": "vivary.workspace-graph/v0",
        "workspace_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "nodes": nodes,
        "edges": [],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
    }


KNOWN_REPO = {"id": "repository_aaaa", "kind": "repository", "identity": "https://github.com/x/y.git", "identity_status": "known"}
AMBIGUOUS_REPO = {"id": "repository_bbbb", "kind": "repository", "identity": "local:c:/somewhere", "identity_status": "inferred"}
UNKNOWN_STATUS_REPO = {"id": "repository_cccc", "kind": "repository", "identity": "local:c:/elsewhere", "identity_status": "unknown"}
PLAIN_CHECKOUT = {"id": "checkout_dddd", "kind": "checkout", "label": "vivary", "path": "irrelevant"}

GRAPH = synthetic_graph([KNOWN_REPO, AMBIGUOUS_REPO, UNKNOWN_STATUS_REPO, PLAIN_CHECKOUT])


def candidate(overrides=None):
    base = {
        "subject": {"node_id": KNOWN_REPO["id"]},
        "predicate": "primary_language",
        "value": {"normalized": "javascript"},
        "authority": {"class": "learned", "actor": {"kind": "agent", "id": "codex:task-1"}, "authorized": True},
        "scope": {"project": "vivary-lattice-lab", "visibility": "local"},
        "valid_time": {"from": "2026-07-01T00:00:00Z", "to": None},
        "observed_time": {"at": "2026-07-01T00:00:00Z"},
        "source": {"evidence": [{"ref": "docs/note.md", "digest": "sha256:aaa"}], "fingerprint": "sha256:candidate-fp"},
        "target_assertion_id": None,
    }
    base.update(overrides or {})
    return base


def neighbor(overrides=None):
    base = {
        "id": "assertion_existing_1",
        "subject": {"node_id": KNOWN_REPO["id"]},
        "predicate": "primary_language",
        "value": {"normalized": "javascript"},
        "authority": {"class": "learned", "actor": {"kind": "agent", "id": "codex:task-0"}},
        "scope": {"project": "vivary-lattice-lab", "visibility": "local"},
        "source": {"evidence": [{"ref": "docs/prior.md", "digest": "sha256:bbb"}], "fingerprint": "sha256:neighbor-fp"},
        "active": True,
    }
    base.update(overrides or {})
    return base


# -- pinned outcome/reason-code vocabulary -----------------------------------


def test_outcome_constants_are_pinned_to_the_policy_docs_literal_vocabulary_and_no_others():
    assert REVIEW_REQUIRED == "review_required"
    assert CORROBORATION_RECORDED == "corroboration_recorded"
    assert SUPERSEDED_EXPLICITLY == "superseded_explicitly"
    assert sorted(OUTCOMES) == sorted([CORROBORATION_RECORDED, REVIEW_REQUIRED, SUPERSEDED_EXPLICITLY])
    # identity_unresolved is a reason code per docs/ARCHITECTURE.md's policy.decision
    # / policy.reason_codes split - it must never be a member of OUTCOMES.
    assert REASON_IDENTITY_UNRESOLVED not in OUTCOMES


def test_reason_code_constants_are_pinned_strings():
    assert REASON_IDENTITY_UNRESOLVED == "identity_unresolved"
    assert REASON_CONFLICTS_WITH == "conflicts_with"
    assert REASON_INDEPENDENT_EVIDENCE == "independent_evidence"
    assert REASON_EXPLICIT_CORRECTION == "explicit_correction"
    assert REASON_AUTHORED_TRUTH_PROTECTED == "authored_truth_protected"
    assert REASON_ACTOR_NOT_AUTHORIZED == "actor_not_authorized"
    assert REASON_SUPERSESSION_TARGET_MISSING == "supersession_target_missing"
    assert REASON_SUPERSESSION_SUBJECT_MISMATCH == "supersession_subject_mismatch"
    assert REASON_SUPERSESSION_INPUTS_INCOMPLETE == "supersession_inputs_incomplete"
    assert REASON_NO_SIMILAR_NEIGHBOR == "no_similar_neighbor"
    assert REASON_EXACT_DUPLICATE_OUT_OF_SCOPE == "exact_duplicate_out_of_scope"
    assert REASON_RECALL_PROVIDER_ABSENT == "recall_provider_absent"
    assert REASON_RECALL_PROVIDER_FAILED == "recall_provider_failed"
    assert STATUS_EVALUATED == "evaluated"
    assert STATUS_NO_PROVIDER == "no_provider"
    assert STATUS_PROVIDER_DEGRADED == "provider_degraded"
    assert ACTIVE_TRUTH_UNCHANGED == "unchanged"
    assert ACTIVE_TRUTH_NEW_VERSION_ACTIVE == "new_version_active"


# -- candidates may only reference existing graph nodes ----------------------


def test_a_candidate_referencing_a_node_id_that_is_not_in_the_graph_cannot_become_truth_review_required_identity_unresolved():
    result = classify_candidate(
        graph=GRAPH,
        candidate=candidate({"subject": {"node_id": "repository_ffff_never_observed"}}),
        neighbors=[],
    )
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_IDENTITY_UNRESOLVED]
    assert result["subject"]["resolved"] is False


def test_a_candidate_referencing_a_repository_node_whose_identity_is_not_proven_inferred_is_ambiguous_subject_identity():
    result = classify_candidate(
        graph=GRAPH, candidate=candidate({"subject": {"node_id": AMBIGUOUS_REPO["id"]}}), neighbors=[]
    )
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_IDENTITY_UNRESOLVED]


def test_a_candidate_referencing_a_repository_node_whose_identity_status_is_unknown_is_also_ambiguous_subject_identity():
    result = classify_candidate(
        graph=GRAPH, candidate=candidate({"subject": {"node_id": UNKNOWN_STATUS_REPO["id"]}}), neighbors=[]
    )
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_IDENTITY_UNRESOLVED]


def test_a_candidate_referencing_a_node_kind_with_no_identity_status_field_deterministic_id_resolves_cleanly():
    result = classify_candidate(
        graph=GRAPH, candidate=candidate({"subject": {"node_id": PLAIN_CHECKOUT["id"]}}), neighbors=[]
    )
    assert result["subject"]["resolved"] is True
    # no matching neighbor either way -> not one of the three write outcomes
    assert result["outcome"] is None


# -- corroboration -------------------------------------------------------------


def test_same_subject_predicate_compatible_value_independent_evidence_corroboration_recorded_active_truth_unchanged():
    n = neighbor()
    result = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n])
    assert result["outcome"] == CORROBORATION_RECORDED
    assert result["reason_codes"] == [REASON_INDEPENDENT_EVIDENCE]
    assert result["related_assertion_ids"] == [n["id"]]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


def test_same_subject_predicate_value_but_identical_evidence_fingerprint_exact_duplicate_is_not_corroboration_and_not_review_noise():
    n = neighbor({"source": {"evidence": [{"ref": "docs/prior.md", "digest": "sha256:bbb"}], "fingerprint": "sha256:candidate-fp"}})
    result = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n])
    assert result["outcome"] != CORROBORATION_RECORDED
    assert result["outcome"] != REVIEW_REQUIRED
    assert result["outcome"] is None
    assert result["reason_codes"] == [REASON_EXACT_DUPLICATE_OUT_OF_SCOPE]


# -- conflict / ambiguity ------------------------------------------------------


def test_same_subject_predicate_incompatible_value_preserve_both_review_required_conflicts_with_active_truth_unchanged():
    n = neighbor({"value": {"normalized": "python"}})
    result = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n])
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_CONFLICTS_WITH]
    assert result["related_assertion_ids"] == [n["id"]]


def test_no_similar_neighbor_at_all_is_not_treated_as_ambiguity_or_conflict_avoids_review_queue_noise_and_is_not_one_of_the_three_outcomes():
    result = classify_candidate(
        graph=GRAPH, candidate=candidate({"predicate": "brand_new_predicate"}), neighbors=[neighbor()]
    )
    assert result["outcome"] is None
    assert result["reason_codes"] == [REASON_NO_SIMILAR_NEIGHBOR]


# -- explicit, authorized correction -------------------------------------------


def test_explicit_correction_authorized_actor_learned_target_all_required_inputs_present_superseded_explicitly():
    n = neighbor({"id": "assertion_target_1", "authority": {"class": "learned", "actor": {"kind": "agent", "id": "codex:task-0"}}})
    result = classify_candidate(graph=GRAPH, candidate=candidate({"target_assertion_id": n["id"]}), neighbors=[n])
    assert result["outcome"] == SUPERSEDED_EXPLICITLY
    assert result["reason_codes"] == [REASON_EXPLICIT_CORRECTION]
    assert result["related_assertion_ids"] == [n["id"]]
    # The one and only path where active truth is allowed to change - a caller
    # never has to infer this from the outcome string alone.
    assert result["active_truth"] == ACTIVE_TRUTH_NEW_VERSION_ACTIVE


def test_similarity_grants_no_overwrite_rights_an_explicit_target_pointing_at_authored_truth_is_never_superseded_even_at_maximum_similarity():
    n = neighbor(
        {
            "id": "assertion_authored_1",
            "authority": {"class": "authored", "actor": {"kind": "human", "id": "jeff"}},
            # identical value/predicate/subject/evidence to the candidate: maximum similarity
            "value": {"normalized": "javascript"},
        }
    )
    result = classify_candidate(graph=GRAPH, candidate=candidate({"target_assertion_id": n["id"]}), neighbors=[n])
    assert result["outcome"] != SUPERSEDED_EXPLICITLY
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_AUTHORED_TRUTH_PROTECTED]
    assert result["related_assertion_ids"] == [n["id"]]
    # The load-bearing assertion: no matter how similar, active truth is
    # never marked replaced when the target is authored.
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


def test_explicit_correction_by_an_unauthorized_actor_falls_back_to_review_required_never_supersedes():
    n = neighbor({"id": "assertion_target_2"})
    result = classify_candidate(
        graph=GRAPH,
        candidate=candidate(
            {
                "target_assertion_id": n["id"],
                "authority": {"class": "learned", "actor": {"kind": "agent", "id": "codex:task-1"}, "authorized": False},
            }
        ),
        neighbors=[n],
    )
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_ACTOR_NOT_AUTHORIZED]


def test_explicit_correction_naming_a_target_assertion_id_that_does_not_exist_among_neighbors_falls_back_to_review_required():
    result = classify_candidate(
        graph=GRAPH,
        candidate=candidate({"target_assertion_id": "assertion_never_recalled"}),
        neighbors=[neighbor({"id": "assertion_target_3"})],
    )
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_SUPERSESSION_TARGET_MISSING]


def test_explicit_correction_whose_target_is_about_a_different_subject_node_falls_back_to_review_required():
    n = neighbor({"id": "assertion_target_4", "subject": {"node_id": PLAIN_CHECKOUT["id"]}})
    result = classify_candidate(graph=GRAPH, candidate=candidate({"target_assertion_id": n["id"]}), neighbors=[n])
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_SUPERSESSION_SUBJECT_MISMATCH]


def test_a_supersession_decision_missing_a_required_comparison_input_eg_valid_time_is_invalid_and_falls_back_to_review_required():
    n = neighbor({"id": "assertion_target_5"})
    incomplete = candidate({"target_assertion_id": n["id"]})
    del incomplete["valid_time"]
    result = classify_candidate(graph=GRAPH, candidate=incomplete, neighbors=[n])
    assert result["outcome"] == REVIEW_REQUIRED
    assert result["reason_codes"] == [REASON_SUPERSESSION_INPUTS_INCOMPLETE]


# -- determinism and shape ------------------------------------------------------


def test_classification_is_pure_identical_inputs_yield_byte_identical_decisions_reason_codes_and_related_ids_are_sorted():
    n1 = neighbor({"id": "assertion_z", "value": {"normalized": "python"}})
    n2 = neighbor({"id": "assertion_a", "value": {"normalized": "python"}})
    a = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n1, n2])
    b = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n1, n2])
    assert a == b
    assert a["related_assertion_ids"] == sorted(a["related_assertion_ids"])


# -- graceful degradation: no recall provider ----------------------------------


def test_with_no_recall_provider_the_firewall_is_a_clean_structured_no_op_never_throws_never_fabricates_a_write_decision():
    result = evaluate_candidate(graph=GRAPH, candidate=candidate())
    assert result["status"] == STATUS_NO_PROVIDER
    assert result["outcome"] is None
    assert result["outcome"] not in OUTCOMES
    assert result["reason_codes"] == [REASON_RECALL_PROVIDER_ABSENT]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


def test_a_provider_object_without_a_recall_function_also_degrades_to_the_no_provider_no_op_rather_than_throwing():
    # doesNotThrow
    evaluate_candidate(graph=GRAPH, candidate=candidate(), provider={})
    result = evaluate_candidate(graph=GRAPH, candidate=candidate(), provider={})
    assert result["status"] == STATUS_NO_PROVIDER


def test_with_a_recall_provider_present_the_firewall_evaluates_and_matches_the_pure_classifier_directly():
    n = neighbor()
    provider = {"recall": lambda **kwargs: [n]}
    result = evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)
    assert result["status"] == STATUS_EVALUATED
    direct = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[n])
    assert result["outcome"] == direct["outcome"]
    assert result["reason_codes"] == direct["reason_codes"]
    assert result["related_assertion_ids"] == direct["related_assertion_ids"]
    assert result["active_truth"] == direct["active_truth"]


def test_a_provider_whose_recall_returns_non_array_garbage_degrades_to_its_own_visible_status_distinct_from_a_healthy_evaluation():
    provider = {"recall": lambda **kwargs: None}
    evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)  # doesNotThrow
    result = evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)
    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert result["status"] != STATUS_EVALUATED
    assert result["status"] != STATUS_NO_PROVIDER
    assert result["outcome"] is None
    assert result["outcome"] not in OUTCOMES
    assert result["reason_codes"] == [REASON_RECALL_PROVIDER_FAILED]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED

@pytest.mark.parametrize("malformed_neighbor", ["garbage", None])
def test_a_provider_whose_neighbor_list_contains_a_non_object_degrades_instead_of_evaluating_partial_results(
    malformed_neighbor,
):
    provider = {"recall": lambda **kwargs: [neighbor(), malformed_neighbor]}

    result = evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)

    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert result["outcome"] is None
    assert result["reason_codes"] == [REASON_RECALL_PROVIDER_FAILED]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


def test_an_idless_matching_neighbor_never_crashes_classification_and_degrades_at_the_provider_boundary():
    malformed_neighbor = neighbor()
    del malformed_neighbor["id"]

    direct = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[malformed_neighbor])
    result = evaluate_candidate(
        graph=GRAPH,
        candidate=candidate(),
        provider={"recall": lambda **kwargs: [malformed_neighbor]},
    )

    assert direct["outcome"] == REVIEW_REQUIRED
    assert direct["reason_codes"] == [REASON_RECALL_PROVIDER_FAILED]
    assert direct["related_assertion_ids"] == []
    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert result["outcome"] is None
    assert result["reason_codes"] == [REASON_RECALL_PROVIDER_FAILED]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


def test_a_provider_whose_recall_throws_degrades_to_status_provider_degraded_never_status_evaluated_and_never_fabricates_no_similar_neighbor():
    # If the provider had actually returned this neighbor, it would have been
    # an incompatible-value conflict. The throw must not silently collapse
    # that possibility into "found nothing" (a would-be conflict masquerading
    # as review-free harmless novelty is exactly the failure mode a caller
    # must never be able to mistake for a healthy evaluation).
    would_have_conflicted = neighbor({"value": {"normalized": "python"}})

    def _raising_recall(**kwargs):
        raise RuntimeError("recall backend unavailable")

    provider = {"recall": _raising_recall}
    evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)  # doesNotThrow
    result = evaluate_candidate(graph=GRAPH, candidate=candidate(), provider=provider)
    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert result["status"] != STATUS_EVALUATED
    assert result["outcome"] is None
    assert result["reason_codes"] == [REASON_RECALL_PROVIDER_FAILED]
    assert REASON_NO_SIMILAR_NEIGHBOR not in result["reason_codes"]
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED
    # sanity: confirm the discarded neighbor really would have conflicted,
    # proving the degraded status is hiding a real signal, not a non-event.
    would_be = classify_candidate(graph=GRAPH, candidate=candidate(), neighbors=[would_have_conflicted])
    assert would_be["outcome"] == REVIEW_REQUIRED


# -- real fixture graph: no leaks, real node identities ------------------------


def test_real_fixture_graph_a_candidate_about_the_shared_origin_repository_classifies_against_real_node_ids_no_fixture_path_leaks(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["stale_neighbor"], p["no_origin"]]
    observation = observe_checkouts([p["canonical"], p["stale_neighbor"], p["no_origin"]], allowlist=allowlist, now=NOW)
    graph = project_workspace_graph(observation)

    shared_repo = next((n for n in graph["nodes"] if n.get("kind") == "repository" and n.get("identity_status") == "known"), None)
    assert shared_repo is not None, "fixture graph should contain the shared-origin repository node"
    solo_repo = next((n for n in graph["nodes"] if n.get("kind") == "repository" and n.get("identity_status") != "known"), None)
    assert solo_repo is not None, "fixture graph should contain a repository whose identity is not proven"

    known = classify_candidate(graph=graph, candidate=candidate({"subject": {"node_id": shared_repo["id"]}}), neighbors=[])
    assert known["subject"]["resolved"] is True

    ambiguous = classify_candidate(graph=graph, candidate=candidate({"subject": {"node_id": solo_repo["id"]}}), neighbors=[])
    assert ambiguous["outcome"] == REVIEW_REQUIRED
    assert ambiguous["reason_codes"] == [REASON_IDENTITY_UNRESOLVED]

    import json as _json

    serialized = _json.dumps([known, ambiguous])
    assert FIXTURE_BASE.replace("\\", "/") not in serialized
    assert "secrets" not in serialized.lower()
    assert "private-note" not in serialized


# -- no I/O, no network, no embedding dependency, by construction --------------


def test_recall_modules_perform_no_filesystem_process_network_or_embedding_io_by_source_scan_of_every_owned_file():
    vivary_core_dir = os.path.join(os.path.dirname(HERE), "vivary_core")
    files = sorted(glob.glob(os.path.join(vivary_core_dir, "recall_*.py")))
    assert len(files) >= 3, "expected recall_classify.py, recall_firewall.py, and recall_outcomes.py"
    forbidden = [
        "import os",
        "import io",
        "import socket",
        "import subprocess",
        "import http",
        "import urllib",
        "import requests",
        "import ftplib",
        "import smtplib",
        "open(",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "embedding",
        "onnx",
        "tensorflow",
        "faiss",
    ]
    for path in files:
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
        for pattern in forbidden:
            assert pattern not in source, f"{os.path.basename(path)} must not reference forbidden pattern: {pattern}"


def test_evaluate_candidate_and_classify_candidate_are_exported_as_callables_with_the_expected_arity_of_options_objects():
    assert callable(classify_candidate)
    assert callable(evaluate_candidate)
