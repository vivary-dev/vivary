"""Focused contract tests for the SPEC §6 CandidateRecallProvider firewall.

The authoritative result table lives in
``docs/bellamente-memory/SPEC-bellamente-memory.md``.  These tests keep the
firewall pure, deterministic, provider-free, and unable to activate truth.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from vivary_core.canonical import fingerprint  # noqa: E402
from vivary_core.recall_classify import classify_candidate  # noqa: E402
from vivary_core.recall_firewall import evaluate_candidate  # noqa: E402
from vivary_core.recall_outcomes import (  # noqa: E402
    ACCEPTED,
    ACTIVE_TRUTH_UNCHANGED,
    OUTCOMES,
    REASON_CORRECTION_INPUTS_INCOMPLETE,
    REASON_CORRECTION_NOT_AUTHORIZED,
    REASON_CORRECTION_SUBJECT_MISMATCH,
    REASON_CORRECTION_TARGET_MISMATCH,
    REASON_CORRECTION_TARGET_MISSING,
    REASON_CORROBORATION,
    REASON_EVIDENCE_NOT_FINGERPRINTED,
    REASON_EXACT_DUPLICATE,
    REASON_EXPLICIT_CORRECTION,
    REASON_IDENTITY_UNRESOLVED,
    REASON_PROVIDER_DEGRADED,
    REASON_STALE,
    REASON_VALUE_CONFLICT,
    REJECTED,
    REVIEW_REQUIRED,
    STATUS_EVALUATED,
    STATUS_PROVIDER_DEGRADED,
)

KNOWN_NODE = {
    "id": "repository_aaaa",
    "kind": "repository",
    "identity": "https://github.com/vivary-dev/vivary.git",
    "identity_status": "known",
}
INFERRED_NODE = {
    "id": "repository_bbbb",
    "kind": "repository",
    "identity": "local:c:/ambiguous",
    "identity_status": "inferred",
}


def graph(nodes=None):
    return {
        "schema": "vivary.workspace-graph/v0",
        "workspace_fingerprint": "sha256:workspace",
        "nodes": [KNOWN_NODE] if nodes is None else nodes,
        "edges": [],
        "conflicts": [],
        "unknowns": [],
        "refusals": [],
    }


def evidence(digest="sha256:candidate-evidence"):
    body = {
        "kind": "file",
        "ref": "docs/note.md",
        "digest": digest,
        "freshness": "current",
    }
    return {**body, "fingerprint": fingerprint(body)}


def refingerprint_evidence(item):
    item["fingerprint"] = fingerprint({key: value for key, value in item.items() if key != "fingerprint"})


def candidate(overrides=None):
    value = {
        "subject": {"node_id": KNOWN_NODE["id"]},
        "predicate": "primary_language",
        "value": {"normalized": "python"},
        "authority": {
            "class": "learned",
            "actor": {"kind": "agent", "id": "agent:recall"},
            "authorized": True,
        },
        "scope": {"project": "vivary", "visibility": "local"},
        "valid_time": {"from": "2026-07-01T00:00:00Z", "to": None},
        "observed_time": {"at": "2026-07-01T00:00:00Z"},
        "source": {"evidence": [evidence()], "fingerprint": "sha256:candidate-fingerprint"},
        "freshness": "current",
        "target_assertion_id": None,
    }
    value.update(overrides or {})
    return value


def neighbor(overrides=None):
    value = {
        "id": "assertion_existing",
        "subject": {"node_id": KNOWN_NODE["id"]},
        "predicate": "primary_language",
        "value": {"normalized": "python"},
        "authority": {"class": "learned", "actor": {"kind": "agent", "id": "agent:prior"}},
        "scope": {"project": "vivary", "visibility": "local"},
        "observed_time": {"at": "2026-07-01T00:00:00Z"},
        "source": {"evidence": [evidence("sha256:neighbor-evidence")], "fingerprint": "sha256:neighbor-fingerprint"},
        "freshness": "current",
    }
    value.update(overrides or {})
    return value


def assert_result(result, outcome, reason_codes):
    assert result["outcome"] == outcome
    assert result["reason_codes"] == reason_codes
    assert result["active_truth"] == ACTIVE_TRUTH_UNCHANGED


# -- pinned §6 vocabulary ------------------------------------------------------


def test_core_outcomes_and_condition_codes_are_the_spec_literals():
    assert set(OUTCOMES) == {ACCEPTED, REVIEW_REQUIRED, REJECTED}
    assert {
        REASON_EXACT_DUPLICATE,
        REASON_CORROBORATION,
        REASON_EXPLICIT_CORRECTION,
        REASON_IDENTITY_UNRESOLVED,
        REASON_VALUE_CONFLICT,
        REASON_STALE,
        REASON_PROVIDER_DEGRADED,
        REASON_EVIDENCE_NOT_FINGERPRINTED,
    } == {
        "exact_duplicate",
        "corroboration",
        "explicit_correction",
        "identity_unresolved",
        "value_conflict",
        "stale",
        "provider_degraded",
        "evidence_not_fingerprinted",
    }


# -- SPEC §6.2 required distinct results --------------------------------------


def test_exact_duplicate_with_the_same_fingerprinted_evidence_is_accepted_and_preserved():
    prior = neighbor(
        {
            "source": {
                "evidence": [evidence()],
                "fingerprint": "sha256:candidate-fingerprint",
            }
        }
    )
    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[prior])

    assert_result(result, ACCEPTED, [REASON_EXACT_DUPLICATE])
    assert result["related_assertion_ids"] == [prior["id"]]
    assert result["proposal"] is None


def test_duplicate_classification_compares_actual_evidence_not_only_source_fingerprint():
    same_evidence = neighbor(
        {
            "source": {
                "evidence": [evidence()],
                "fingerprint": "sha256:different-source",
            }
        }
    )
    independent_evidence = neighbor(
        {
            "id": "assertion_independent",
            "source": {
                "evidence": [evidence("sha256:independent-evidence")],
                "fingerprint": "sha256:candidate-fingerprint",
            },
        }
    )

    duplicate = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[same_evidence])
    corroboration = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[independent_evidence])

    assert_result(duplicate, ACCEPTED, [REASON_EXACT_DUPLICATE])
    assert_result(corroboration, ACCEPTED, [REASON_CORROBORATION])


@pytest.mark.parametrize(
    ("candidate_evidence", "neighbor_evidence", "reason_code"),
    [
        pytest.param(
            [evidence("sha256:replayed-a")],
            [evidence("sha256:replayed-a"), evidence("sha256:replayed-b")],
            REASON_EXACT_DUPLICATE,
            id="replayed",
        ),
        pytest.param(
            [evidence("sha256:reordered-a"), evidence("sha256:reordered-b")],
            [evidence("sha256:reordered-b"), evidence("sha256:reordered-a")],
            REASON_EXACT_DUPLICATE,
            id="reordered",
        ),
        pytest.param(
            [evidence("sha256:duplicated")],
            [evidence("sha256:duplicated"), evidence("sha256:duplicated")],
            REASON_EXACT_DUPLICATE,
            id="duplicated",
        ),
        pytest.param(
            [evidence("sha256:independent-a"), evidence("sha256:independent-b")],
            [evidence("sha256:independent-c")],
            REASON_CORROBORATION,
            id="independent",
        ),
        pytest.param(
            [evidence("sha256:shared"), evidence("sha256:new")],
            [evidence("sha256:shared")],
            REASON_CORROBORATION,
            id="shared-plus-new",
        ),
    ],
)
def test_compatible_evidence_requires_material_independent_of_the_recalled_record(
    candidate_evidence, neighbor_evidence, reason_code
):
    prior = neighbor(
        {
            "source": {
                "evidence": neighbor_evidence,
                "fingerprint": "sha256:recalled-source",
            }
        }
    )
    result = classify_candidate(
        graph=graph(),
        candidate=candidate(
            {
                "source": {
                    "evidence": candidate_evidence,
                    "fingerprint": "sha256:candidate-source",
                }
            }
        ),
        neighbors=[prior],
    )

    assert_result(result, ACCEPTED, [reason_code])
    assert set(result["related_assertion_ids"]) == {prior["id"]}
    assert result["proposal"] is None


def test_corroboration_excludes_replayed_evidence_from_its_related_assertions():
    replayed = neighbor(
        {
            "id": "assertion_replayed",
            "source": {
                "evidence": [evidence("sha256:shared"), evidence("sha256:shared")],
                "fingerprint": "sha256:replayed-source",
            },
        }
    )
    independent = neighbor(
        {
            "id": "assertion_independent",
            "source": {
                "evidence": [evidence("sha256:independent")],
                "fingerprint": "sha256:independent-source",
            },
        }
    )
    result = classify_candidate(
        graph=graph(),
        candidate=candidate(
            {
                "source": {
                    "evidence": [evidence("sha256:shared")],
                    "fingerprint": "sha256:candidate-source",
                }
            }
        ),
        neighbors=[replayed, independent],
    )

    assert_result(result, ACCEPTED, [REASON_CORROBORATION])
    assert set(result["related_assertion_ids"]) == {independent["id"]}
    assert result["proposal"] is None


def test_compatible_assertion_with_independent_fingerprinted_evidence_is_accepted_as_corroboration():
    prior = neighbor()
    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[prior])

    assert_result(result, ACCEPTED, [REASON_CORROBORATION])
    assert result["related_assertion_ids"] == [prior["id"]]
    assert result["proposal"] is None


def test_explicit_correction_of_authored_truth_is_a_human_gated_review_proposal_never_an_activation():
    prior = neighbor({"id": "assertion_authored", "authority": {"class": "authored"}})
    proposed = candidate({"target_assertion_id": prior["id"]})
    result = classify_candidate(graph=graph(), candidate=proposed, neighbors=[prior])

    assert_result(result, REVIEW_REQUIRED, [REASON_EXPLICIT_CORRECTION])
    assert result["related_assertion_ids"] == [prior["id"]]
    assert result["proposal"] == {
        "kind": "explicit_correction",
        "target_assertion_id": prior["id"],
        "requires_human_approval": True,
    }


def test_unknown_or_ambiguous_identity_is_review_required_without_entering_comparison_paths():
    unknown = candidate({"subject": {"node_id": "repository_missing"}})
    result = classify_candidate(graph=graph(), candidate=unknown, neighbors=[neighbor()])

    assert_result(result, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert result["subject"] == {"node_id": "repository_missing", "resolved": False}


@pytest.mark.parametrize(
    "subject",
    [
        {},
        {"unresolved_identity": "not a marker mapping"},
        {"unresolved_identity": {}},
        {
            "node_id": KNOWN_NODE["id"],
            "unresolved_identity": {"provider_ref": "bellamente:assertion-42"},
        },
    ],
    ids=["missing", "non-dict-marker", "missing-provider-ref", "node-and-marker"],
)
def test_missing_or_invalid_subject_identity_is_rejected(subject):
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"subject": subject}),
        neighbors=[],
    )

    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_explicit_unresolved_identity_marker_is_review_required_and_preserves_the_provider_reference():
    marker = {"provider_ref": "bellamente:assertion-42"}
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"subject": {"unresolved_identity": marker}}),
        neighbors=[],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert result["subject"] == {
        "node_id": None,
        "unresolved_identity": marker,
        "resolved": False,
    }


def test_unresolved_identity_marker_never_enters_duplicate_or_corroboration_paths():
    marker = {"provider_ref": "bellamente:assertion-42"}

    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"subject": {"unresolved_identity": marker}}),
        neighbors=[neighbor()],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert result["related_assertion_ids"] == []


def test_unresolved_identity_marker_does_not_bypass_fingerprinted_evidence_requirement():
    unresolved = candidate(
        {
            "subject": {"unresolved_identity": {"provider_ref": "bellamente:assertion-42"}},
            "source": {
                "evidence": [evidence(digest="not-a-fingerprint")],
                "fingerprint": "sha256:candidate-fingerprint",
            },
        }
    )

    result = classify_candidate(graph=graph(), candidate=unresolved, neighbors=[])

    assert_result(result, REJECTED, [REASON_EVIDENCE_NOT_FINGERPRINTED])


def test_recalled_neighbors_cannot_carry_unresolved_identity_markers():
    malformed_neighbor = neighbor(
        {
            "subject": {
                "node_id": KNOWN_NODE["id"],
                "unresolved_identity": {"provider_ref": "bellamente:assertion-42"},
            }
        }
    )

    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[malformed_neighbor])

    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_ambiguous_identity_status_is_review_required_not_a_resolved_subject():
    ambiguous = candidate({"subject": {"node_id": INFERRED_NODE["id"]}})
    result = classify_candidate(graph=graph([INFERRED_NODE]), candidate=ambiguous, neighbors=[neighbor()])

    assert_result(result, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert result["subject"] == {"node_id": INFERRED_NODE["id"], "resolved": False}


def test_incompatible_value_for_the_same_identity_is_review_required_and_preserves_both_sides():
    prior = neighbor({"value": {"normalized": "ruby"}})
    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[prior])

    assert_result(result, REVIEW_REQUIRED, [REASON_VALUE_CONFLICT])
    assert result["related_assertion_ids"] == [prior["id"]]


def test_stale_candidate_is_rejected_before_duplicate_or_corroboration_classification():
    stale = candidate({"freshness": "stale"})
    result = classify_candidate(graph=graph(), candidate=stale, neighbors=[neighbor()])

    assert_result(result, REJECTED, [REASON_STALE])


def test_stale_neighbor_is_rejected_before_duplicate_or_corroboration_classification():
    stale = neighbor({"freshness": "stale"})
    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[stale])

    assert_result(result, REJECTED, [REASON_STALE])


def test_stale_evidence_is_rejected_before_duplicate_or_corroboration_classification():
    stale = candidate()
    item = stale["source"]["evidence"][0]
    item["freshness"] = "stale"
    item["fingerprint"] = fingerprint({key: value for key, value in item.items() if key != "fingerprint"})
    result = classify_candidate(graph=graph(), candidate=stale, neighbors=[neighbor()])

    assert_result(result, REJECTED, [REASON_STALE])


def test_stale_graph_node_is_rejected_before_the_candidate_can_be_evaluated():
    stale_node = {**KNOWN_NODE, "freshness": "stale"}
    result = classify_candidate(graph=graph([stale_node]), candidate=candidate(), neighbors=[])

    assert_result(result, REJECTED, [REASON_STALE])


def test_no_matching_neighbor_is_an_accepted_evaluation_not_a_hidden_write_or_coined_reason():
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"predicate": "new_normalized_predicate"}),
        neighbors=[neighbor()],
    )

    assert_result(result, ACCEPTED, [])
    assert result["proposal"] is None


# -- evidence and normalized authority boundaries -----------------------------


@pytest.mark.parametrize(
    "mutate",
    [
        lambda assertion: assertion["source"].pop("fingerprint"),
        lambda assertion: assertion["source"].__setitem__("fingerprint", "not-a-fingerprint"),
        lambda assertion: (
            assertion["source"]["evidence"][0].__setitem__("digest", "not-a-fingerprint"),
            refingerprint_evidence(assertion["source"]["evidence"][0]),
        ),
    ],
)
def test_missing_or_malformed_candidate_fingerprint_is_rejected_fail_closed(mutate):
    malformed = candidate()
    mutate(malformed)
    result = classify_candidate(graph=graph(), candidate=malformed, neighbors=[])

    assert_result(result, REJECTED, [REASON_EVIDENCE_NOT_FINGERPRINTED])


@pytest.mark.parametrize(
    "mutate",
    [
        lambda item: (item.pop("kind"), refingerprint_evidence(item)),
        lambda item: (item.__setitem__("kind", ""), refingerprint_evidence(item)),
        lambda item: item.pop("fingerprint"),
        lambda item: item.__setitem__("fingerprint", "sha256:not-the-evidence"),
        lambda item: (item.pop("ref"), refingerprint_evidence(item)),
        lambda item: (item.__setitem__("ref", ""), refingerprint_evidence(item)),
    ],
)
def test_evidence_must_be_typed_and_bound_to_its_claimed_fingerprint(mutate):
    malformed = candidate()
    mutate(malformed["source"]["evidence"][0])

    result = classify_candidate(graph=graph(), candidate=malformed, neighbors=[])

    assert_result(result, REJECTED, [REASON_EVIDENCE_NOT_FINGERPRINTED])


def test_unfingerprinted_neighbor_cannot_be_counted_as_independent_corroboration():
    prior = neighbor({"source": {"evidence": [evidence("sha256:prior")], "fingerprint": "broken"}})
    result = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[prior])

    assert_result(result, REJECTED, [REASON_EVIDENCE_NOT_FINGERPRINTED])


@pytest.mark.parametrize("authority_class", [None, "authored", "unknown_authority"])
def test_candidate_authority_must_use_the_learned_candidate_vocabulary(authority_class):
    malformed = candidate()
    malformed["authority"]["class"] = authority_class
    result = classify_candidate(graph=graph(), candidate=malformed, neighbors=[])

    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


@pytest.mark.parametrize("authority", [{}, {"class": "unknown_authority"}])
def test_missing_or_unknown_neighbor_authority_cannot_bypass_authored_truth_protection(authority):
    prior = neighbor({"id": "assertion_target", "authority": authority})
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"target_assertion_id": prior["id"]}),
        neighbors=[prior],
    )

    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert result["proposal"] is None


# -- explicit correction malformed subcases -----------------------------------


def test_unknown_correction_target_is_a_fail_closed_review_subcase():
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"target_assertion_id": "assertion_missing"}),
        neighbors=[neighbor()],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_CORRECTION_TARGET_MISSING])


def test_cross_subject_correction_target_is_a_fail_closed_review_subcase():
    prior = neighbor({"id": "assertion_other", "subject": {"node_id": "repository_other"}})
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"target_assertion_id": prior["id"]}),
        neighbors=[prior],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_CORRECTION_SUBJECT_MISMATCH])


@pytest.mark.parametrize(
    "target_overrides",
    [
        {"predicate": "different_predicate"},
        {"scope": {"project": "other-project", "visibility": "local"}},
        {"scope": {"project": "vivary", "visibility": "public"}},
    ],
)
def test_correction_target_must_match_the_candidate_predicate_and_scope(target_overrides):
    prior = neighbor({"id": "assertion_target", **target_overrides})
    proposed = candidate({"target_assertion_id": prior["id"]})

    result = classify_candidate(graph=graph(), candidate=proposed, neighbors=[prior])

    assert_result(result, REVIEW_REQUIRED, [REASON_CORRECTION_TARGET_MISMATCH])
    assert result["proposal"] is None


def test_unauthorized_correction_is_a_fail_closed_review_subcase():
    proposed = candidate({"target_assertion_id": "assertion_target"})
    proposed["authority"]["authorized"] = False
    result = classify_candidate(
        graph=graph(),
        candidate=proposed,
        neighbors=[neighbor({"id": "assertion_target"})],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_CORRECTION_NOT_AUTHORIZED])


def test_correction_missing_required_comparison_input_is_a_fail_closed_review_subcase():
    proposed = candidate({"target_assertion_id": "assertion_target"})
    proposed.pop("valid_time")
    result = classify_candidate(
        graph=graph(),
        candidate=proposed,
        neighbors=[neighbor({"id": "assertion_target"})],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_CORRECTION_INPUTS_INCOMPLETE])


# -- provider boundary and never-throw containment ----------------------------


def test_absent_provider_is_visible_rejected_provider_degradation():
    result = evaluate_candidate(graph=graph(), candidate=candidate())

    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_malformed_provider_result_is_visible_rejected_provider_degradation():
    result = evaluate_candidate(
        graph=graph(),
        candidate=candidate(),
        provider={"recall": lambda **_: "not-a-neighbor-list"},
    )

    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_failed_provider_call_is_visible_rejected_provider_degradation():
    def fail(**_):
        raise RuntimeError("provider unavailable")

    result = evaluate_candidate(graph=graph(), candidate=candidate(), provider={"recall": fail})

    assert result["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_classification_exception_from_untrusted_provider_data_is_contained_at_both_boundaries():
    malformed = neighbor({"value": {"normalized": {1: "non-string-key"}}})
    direct = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[malformed])
    through_firewall = evaluate_candidate(
        graph=graph(),
        candidate=candidate(),
        provider={"recall": lambda **_: [malformed]},
    )

    assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(through_firewall, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_freshness_precedence_is_deterministic_for_any_neighbor_order():
    stale = neighbor({"id": "assertion_stale", "freshness": "stale"})
    malformed_freshness = neighbor({"id": "assertion_invalid", "source": {"evidence": [evidence()], "fingerprint": "sha256:other", "freshness": "bogus"}})

    forward = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[stale, malformed_freshness])
    reverse = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[malformed_freshness, stale])

    assert_result(forward, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert reverse == forward


# -- pure deterministic boundary ------------------------------------------------


def test_classification_is_deterministic_and_leaves_caller_owned_inputs_unchanged():
    current_graph = graph()
    current_candidate = candidate()
    current_neighbors = [neighbor({"id": "assertion_z"}), neighbor({"id": "assertion_a", "value": {"normalized": "ruby"}})]
    original = deepcopy((current_graph, current_candidate, current_neighbors))

    first = classify_candidate(graph=current_graph, candidate=current_candidate, neighbors=current_neighbors)
    second = classify_candidate(graph=current_graph, candidate=current_candidate, neighbors=current_neighbors)

    assert first == second
    assert (current_graph, current_candidate, current_neighbors) == original


def test_recall_modules_have_no_filesystem_process_network_or_embedding_io_surface():
    forbidden = ("subprocess", "requests", "urllib", "socket", "open(", "datetime.now", "time.time", "embed")
    for path in (HERE.parent / "vivary_core").glob("recall_*.py"):
        source = path.read_text(encoding="utf-8")
        for pattern in forbidden:
            assert pattern not in source, f"{path.name} must not reference forbidden pattern: {pattern}"


def test_public_classifier_and_firewall_are_callables():
    assert callable(classify_candidate)
    assert callable(evaluate_candidate)
