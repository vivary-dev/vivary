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
from vivary_core.recall import (  # noqa: E402
    RECALL_OPERATION,
    RECALL_TRANSITION_DECISION,
    RECALL_TRANSITION_REASON,
    RECALL_TRANSITION_SCHEMA,
    project_recall_transition,
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


def test_duplicate_recalled_assertion_ids_degrade_independent_of_provider_order():
    correction = candidate({"target_assertion_id": "assertion_target"})
    matching = neighbor({"id": "assertion_target"})
    mismatched = neighbor(
        {"id": "assertion_target", "predicate": "different_predicate"}
    )

    for current_neighbors in ([matching, mismatched], [mismatched, matching]):
        direct = classify_candidate(
            graph=graph(),
            candidate=correction,
            neighbors=current_neighbors,
        )
        through_firewall = evaluate_candidate(
            graph=graph(),
            candidate=correction,
            provider={"recall": lambda **_: current_neighbors},
        )

        assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
        assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
        assert_result(
            through_firewall,
            REJECTED,
            [REASON_PROVIDER_DEGRADED],
        )


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



@pytest.mark.parametrize(
    ("node_id", "projected_node_id", "resolved"),
    [
        (KNOWN_NODE["id"], KNOWN_NODE["id"], True),
        (None, None, False),
        ("", None, False),
        (123, None, False),
    ],
    ids=["valid", "null", "empty", "non-string"],
)
def test_unresolved_identity_marker_rejects_any_node_id_key_and_preserves_provider_reference(
    node_id, projected_node_id, resolved
):
    marker = {"provider_ref": "bellamente:assertion-42"}
    result = classify_candidate(
        graph=graph(),
        candidate=candidate({"subject": {"node_id": node_id, "unresolved_identity": marker}}),
        neighbors=[],
    )

    assert_result(result, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert result["subject"] == {
        "node_id": projected_node_id,
        "unresolved_identity": marker,
        "resolved": resolved,
    }

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
    result = classify_candidate(
        graph=graph([KNOWN_NODE, INFERRED_NODE]),
        candidate=ambiguous,
        neighbors=[neighbor()],
    )

    assert_result(result, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert result["subject"] == {"node_id": INFERRED_NODE["id"], "resolved": False}


def test_duplicate_graph_node_ids_are_not_treated_as_stable_identity():
    duplicate = {**KNOWN_NODE, "identity": "https://example.test/other.git"}
    ambiguous_graph = graph([KNOWN_NODE, duplicate])

    candidate_only = classify_candidate(
        graph=ambiguous_graph,
        candidate=candidate(),
        neighbors=[],
    )
    with_recalled_assertion = classify_candidate(
        graph=ambiguous_graph,
        candidate=candidate(),
        neighbors=[neighbor()],
    )

    assert_result(candidate_only, REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED])
    assert_result(
        with_recalled_assertion,
        REJECTED,
        [REASON_PROVIDER_DEGRADED],
    )


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
    other_node = {**KNOWN_NODE, "id": "repository_other", "identity": "https://github.com/vivary-dev/other.git"}
    prior = neighbor({"id": "assertion_other", "subject": {"node_id": other_node["id"]}})
    result = classify_candidate(
        graph=graph([KNOWN_NODE, other_node]),
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


# -- bounded hostile-input and result-ownership boundary ----------------------


@pytest.mark.parametrize(
    "prepared",
    [
        pytest.param(
            lambda: (graph([KNOWN_NODE] * 10_001), candidate(), []),
            id="graph-node-limit",
        ),
        pytest.param(
            lambda: (graph(), candidate(), [neighbor()] * 10_001),
            id="provider-neighbor-limit",
        ),
        pytest.param(
            lambda: (graph(), candidate({"predicate": "x" * 1_048_577}), []),
            id="utf8-string-limit",
        ),
        pytest.param(
            lambda: (
                graph(),
                candidate({"payload": [[0] * 10_000 for _ in range(10)]}),
                [],
            ),
            id="aggregate-value-limit",
        ),
        pytest.param(
            lambda: (graph(), candidate({"payload": float("nan")}), []),
            id="non-finite-json-number",
        ),
        pytest.param(
            lambda: (
                graph(),
                candidate({"value": {"normalized": 2**53}}),
                [],
            ),
            id="lossy-integer",
        ),
        pytest.param(
            lambda: (
                graph(),
                candidate({"payload": ["x" * 1_048_576] * 17}),
                [],
            ),
            id="aggregate-utf8-byte-limit",
        ),
    ],
)
def test_bounded_input_limits_degrade_at_direct_and_provider_boundaries(prepared):
    current_graph, current_candidate, current_neighbors = prepared()

    direct = classify_candidate(
        graph=current_graph,
        candidate=current_candidate,
        neighbors=current_neighbors,
    )
    through_firewall = evaluate_candidate(
        graph=current_graph,
        candidate=current_candidate,
        provider={"recall": lambda **_: current_neighbors},
    )

    assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(through_firewall, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_cyclic_input_is_contained_before_a_provider_can_receive_it():
    cyclic = candidate()
    cyclic["value"]["normalized"] = cyclic
    provider_calls = []

    direct = classify_candidate(graph=graph(), candidate=cyclic, neighbors=[])
    through_firewall = evaluate_candidate(
        graph=graph(),
        candidate=cyclic,
        provider={"recall": lambda **_: provider_calls.append("called") or []},
    )

    assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(through_firewall, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert provider_calls == []


def test_excessive_json_depth_degrades_at_direct_and_provider_boundaries():
    nested = []
    cursor = nested
    for _ in range(65):
        child = []
        cursor.append(child)
        cursor = child
    current_candidate = candidate({"payload": nested})

    direct = classify_candidate(graph=graph(), candidate=current_candidate, neighbors=[])
    through_firewall = evaluate_candidate(
        graph=graph(),
        candidate=current_candidate,
        provider={"recall": lambda **_: []},
    )

    assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(through_firewall, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_recalled_neighbor_must_resolve_to_a_known_graph_node_at_both_boundaries():
    unknown_subject = neighbor({"subject": {"node_id": "repository_missing"}})

    direct = classify_candidate(graph=graph(), candidate=candidate(), neighbors=[unknown_subject])
    through_firewall = evaluate_candidate(
        graph=graph(),
        candidate=candidate(),
        provider={"recall": lambda **_: [unknown_subject]},
    )

    assert_result(direct, REJECTED, [REASON_PROVIDER_DEGRADED])
    assert through_firewall["status"] == STATUS_PROVIDER_DEGRADED
    assert_result(through_firewall, REJECTED, [REASON_PROVIDER_DEGRADED])


def test_classifier_result_values_are_detached_from_subject_evidence_and_proposal_inputs():
    unresolved = candidate(
        {
            "subject": {"unresolved_identity": {"provider_ref": "bellamente:assertion-42"}},
        }
    )
    unresolved_result = classify_candidate(graph=graph(), candidate=unresolved, neighbors=[])
    unresolved_result["subject"]["unresolved_identity"]["provider_ref"] = "mutated"
    unresolved_result["evidence"][0]["ref"] = "mutated.md"

    prior = neighbor({"id": "assertion_authored", "authority": {"class": "authored"}})
    proposed = candidate({"target_assertion_id": prior["id"]})
    proposal_result = classify_candidate(graph=graph(), candidate=proposed, neighbors=[prior])
    proposal_result["proposal"]["target_assertion_id"] = "mutated"

    assert unresolved["subject"]["unresolved_identity"]["provider_ref"] == "bellamente:assertion-42"
    assert unresolved["source"]["evidence"][0]["ref"] == "docs/note.md"
    assert proposed["target_assertion_id"] == prior["id"] == "assertion_authored"

# -- pure deterministic boundary ------------------------------------------------


def test_provider_receives_detached_graph_and_candidate_values():
    current_graph = graph()
    current_candidate = candidate()
    original = deepcopy((current_graph, current_candidate))

    def mutating_provider(*, graph, candidate):
        graph["nodes"].clear()
        candidate["value"]["normalized"] = "mutated"
        return []

    result = evaluate_candidate(
        graph=current_graph,
        candidate=current_candidate,
        provider={"recall": mutating_provider},
    )

    assert result["status"] == STATUS_EVALUATED
    assert_result(result, ACCEPTED, [])
    assert (current_graph, current_candidate) == original


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


# -- caller-owned governed transitions ----------------------------------------


def transition_approval(proposal, actor_id="jeff"):
    return {
        "proposal_id": proposal["proposal_id"],
        "approved_by": {"kind": "human", "id": actor_id},
    }


def test_novel_recall_create_is_proposed_human_bound_applied_and_idempotent():
    current_graph = graph()
    proposed_candidate = candidate()
    original = deepcopy((current_graph, proposed_candidate))

    proposed = project_recall_transition(
        graph=current_graph,
        candidate=proposed_candidate,
        assertions=[],
        operation=RECALL_OPERATION["CREATE"],
    )

    assert proposed["schema"] == RECALL_TRANSITION_SCHEMA
    assert proposed["decision"] == RECALL_TRANSITION_DECISION["PROPOSED"]
    assert proposed["reason_codes"] == []
    assert proposed["assertions"] == proposed["added"] == []
    assert proposed["proposal"] == {
        "proposal_id": proposed["proposal"]["proposal_id"],
        "operation": "create",
        "assertion_id": proposed["proposal"]["assertion_id"],
        "target_assertion_id": None,
        "requires_human_approval": True,
    }

    approval = transition_approval(proposed["proposal"])
    applied = project_recall_transition(
        graph=current_graph,
        candidate=proposed_candidate,
        assertions=[],
        operation=RECALL_OPERATION["CREATE"],
        approval=approval,
    )

    assert applied["decision"] == RECALL_TRANSITION_DECISION["APPLIED"]
    assert len(applied["assertions"]) == len(applied["added"]) == 1
    created = applied["added"][0]
    assert created["id"] == proposed["proposal"]["assertion_id"]
    assert created["authority"]["class"] == "learned"
    assert "authorized" not in created["authority"]
    assert created["transition_provenance"] == {
        "proposal_id": proposed["proposal"]["proposal_id"],
        "operation": "create",
        "approved_by": {"kind": "human", "id": "jeff"},
    }

    replay = project_recall_transition(
        graph=current_graph,
        candidate=proposed_candidate,
        assertions=applied["assertions"],
        operation=RECALL_OPERATION["CREATE"],
        approval=approval,
    )
    assert replay["decision"] == RECALL_TRANSITION_DECISION["APPLIED"]
    assert replay["assertions"] == applied["assertions"]
    assert replay["added"] == []
    unapproved_replay = project_recall_transition(
        graph=current_graph,
        candidate=proposed_candidate,
        assertions=applied["assertions"],
        operation=RECALL_OPERATION["CREATE"],
    )
    assert unapproved_replay["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert unapproved_replay["reason_codes"] == [
        RECALL_TRANSITION_REASON["NOT_PERMITTED"]
    ]
    assert unapproved_replay["assertions"] == applied["assertions"]
    assert unapproved_replay["added"] == []

    different_approver = project_recall_transition(
        graph=current_graph,
        candidate=proposed_candidate,
        assertions=applied["assertions"],
        operation=RECALL_OPERATION["CREATE"],
        approval=transition_approval(proposed["proposal"], actor_id="other"),
    )
    assert different_approver["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert different_approver["reason_codes"] == [
        RECALL_TRANSITION_REASON["ASSERTION_IDENTITY_CONFLICT"]
    ]
    assert different_approver["assertions"] == applied["assertions"]
    assert different_approver["added"] == []
    assert (current_graph, proposed_candidate) == original


def test_transition_ignores_unrelated_stale_history_and_keeps_the_append_only_ledger():
    stale_unrelated = neighbor(
        {
            "id": "assertion_stale_license",
            "predicate": "license",
            "value": {"normalized": "apache-2.0"},
            "freshness": "stale",
        }
    )
    proposed_candidate = candidate()

    proposed = project_recall_transition(
        graph=graph(),
        candidate=proposed_candidate,
        assertions=[stale_unrelated],
        operation=RECALL_OPERATION["CREATE"],
    )

    assert proposed["decision"] == RECALL_TRANSITION_DECISION["PROPOSED"]
    assert_result(proposed["evaluation"], ACCEPTED, [])
    assert proposed["assertions"] == [stale_unrelated]

    applied = project_recall_transition(
        graph=graph(),
        candidate=proposed_candidate,
        assertions=[stale_unrelated],
        operation=RECALL_OPERATION["CREATE"],
        approval=transition_approval(proposed["proposal"]),
    )

    assert applied["decision"] == RECALL_TRANSITION_DECISION["APPLIED"]
    assert applied["assertions"][0] == stale_unrelated
    assert len(applied["assertions"]) == 2


def test_transition_rejects_invalid_freshness_in_unrelated_ledger_history():
    malformed_unrelated = neighbor(
        {
            "id": "assertion_invalid_license",
            "predicate": "license",
            "value": {"normalized": "apache-2.0"},
        }
    )
    malformed_unrelated["source"]["freshness"] = "bogus"

    result = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[malformed_unrelated],
        operation=RECALL_OPERATION["CREATE"],
    )

    assert result["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert result["reason_codes"] == [RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]]
    assert result["evaluation"] is None
    assert result["assertions"] == result["added"] == []


def test_transition_rejects_lossy_integers_before_proposal_identity():
    results = [
        project_recall_transition(
            graph=graph(),
            candidate=candidate({"value": {"normalized": value}}),
            assertions=[],
            operation=RECALL_OPERATION["CREATE"],
        )
        for value in (2**53, 2**53 + 1)
    ]

    for result in results:
        assert result["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
        assert result["reason_codes"] == [RECALL_TRANSITION_REASON["NOT_PERMITTED"]]
        assert_result(result["evaluation"], REJECTED, [REASON_PROVIDER_DEGRADED])
        assert result["proposal"] is None
        assert result["assertions"] == result["added"] == []


def test_transition_preflights_candidate_before_filtering_history():
    class HostileEquality:
        def __eq__(self, other):
            raise AssertionError("malformed candidate equality must not run")

    malformed = candidate({"predicate": HostileEquality()})
    result = project_recall_transition(
        graph=graph(),
        candidate=malformed,
        assertions=[neighbor()],
        operation=RECALL_OPERATION["CREATE"],
    )

    assert result["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert result["reason_codes"] == [RECALL_TRANSITION_REASON["NOT_PERMITTED"]]
    assert_result(result["evaluation"], REJECTED, [REASON_PROVIDER_DEGRADED])
    assert result["assertions"] == [neighbor()]
    assert result["added"] == []
    assert result["proposal"] is None


def test_exact_duplicate_preserve_is_read_only_ungated_and_detached():
    proposed_candidate = candidate()
    prior = neighbor({"source": deepcopy(proposed_candidate["source"])})
    original = deepcopy((proposed_candidate, prior))

    result = project_recall_transition(
        graph=graph(),
        candidate=proposed_candidate,
        assertions=[prior],
        operation=RECALL_OPERATION["PRESERVE"],
    )

    assert result["decision"] == RECALL_TRANSITION_DECISION["PRESERVED"]
    assert result["reason_codes"] == []
    assert_result(result["evaluation"], ACCEPTED, [REASON_EXACT_DUPLICATE])
    assert result["assertions"] == [prior]
    assert result["added"] == []
    assert result["proposal"] is None
    result["assertions"][0]["value"]["normalized"] = "mutated"
    result["evaluation"]["evidence"][0]["ref"] = "mutated.md"
    assert (proposed_candidate, prior) == original


def test_explicit_correction_supersedes_by_append_and_preserves_both_records():
    prior = neighbor(
        {
            "id": "assertion_authored",
            "authority": {"class": "authored"},
            "value": {"normalized": "ruby"},
        }
    )
    correction = candidate({"target_assertion_id": prior["id"]})

    proposed = project_recall_transition(
        graph=graph(),
        candidate=correction,
        assertions=[prior],
        operation=RECALL_OPERATION["SUPERSEDE"],
    )
    assert proposed["decision"] == RECALL_TRANSITION_DECISION["PROPOSED"]
    assert_result(proposed["evaluation"], REVIEW_REQUIRED, [REASON_EXPLICIT_CORRECTION])
    assert proposed["proposal"]["operation"] == "supersede"
    assert proposed["proposal"]["target_assertion_id"] == prior["id"]

    approval = transition_approval(proposed["proposal"])
    applied = project_recall_transition(
        graph=graph(),
        candidate=correction,
        assertions=[prior],
        operation=RECALL_OPERATION["SUPERSEDE"],
        approval=approval,
    )

    assert applied["decision"] == RECALL_TRANSITION_DECISION["APPLIED"]
    assert applied["assertions"][0] == prior
    assert len(applied["assertions"]) == 2
    assert applied["added"][0]["supersedes_assertion_id"] == prior["id"]
    assert applied["added"][0]["authority"]["class"] == "learned"
    assert applied["superseded_assertion_ids"] == [prior["id"]]

    replay = project_recall_transition(
        graph=graph(),
        candidate=correction,
        assertions=applied["assertions"],
        operation=RECALL_OPERATION["SUPERSEDE"],
        approval=approval,
    )
    assert replay["decision"] == RECALL_TRANSITION_DECISION["APPLIED"]
    assert replay["assertions"] == applied["assertions"]
    assert replay["added"] == []


@pytest.mark.parametrize(
    "proposed_candidate, assertions, operation",
    [
        (candidate({"freshness": "stale"}), [], RECALL_OPERATION["CREATE"]),
        (
            candidate(
                {
                    "subject": {
                        "unresolved_identity": {
                            "provider_ref": "bellamente:assertion-42"
                        }
                    }
                }
            ),
            [],
            RECALL_OPERATION["CREATE"],
        ),
        (
            candidate(),
            [neighbor({"value": {"normalized": "ruby"}})],
            RECALL_OPERATION["CREATE"],
        ),
        (
            candidate(
                {
                    "source": {
                        "evidence": [evidence(digest="not-a-fingerprint")],
                        "fingerprint": "sha256:candidate-fingerprint",
                    }
                }
            ),
            [],
            RECALL_OPERATION["CREATE"],
        ),
        (
            candidate(),
            [neighbor()],
            RECALL_OPERATION["CREATE"],
        ),
        (
            candidate({"target_assertion_id": "assertion_missing"}),
            [],
            RECALL_OPERATION["SUPERSEDE"],
        ),
    ],
    ids=[
        "stale",
        "unresolved",
        "value-conflict",
        "degraded",
        "corroboration",
        "missing-correction-target",
    ],
)
def test_non_writable_recall_outcomes_cannot_fall_through_to_state_changes(
    proposed_candidate, assertions, operation
):
    original = deepcopy(assertions)

    result = project_recall_transition(
        graph=graph(),
        candidate=proposed_candidate,
        assertions=assertions,
        operation=operation,
    )

    assert result["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert result["reason_codes"] == [
        RECALL_TRANSITION_REASON["NOT_PERMITTED"]
    ]
    assert result["assertions"] == assertions == original
    assert result["added"] == []


@pytest.mark.parametrize(
    "approval",
    [
        {"proposal_id": "wrong", "approved_by": {"kind": "human", "id": "jeff"}},
        {"proposal_id": None, "approved_by": {"kind": "agent", "id": "agent:1"}},
        {
            "proposal_id": None,
            "approved_by": {"kind": "human", "id": "jeff"},
            "extra": True,
        },
    ],
)
def test_state_change_requires_an_exact_proposal_bound_human_approval(approval):
    proposed = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[],
        operation=RECALL_OPERATION["CREATE"],
    )
    if approval["proposal_id"] is None:
        approval["proposal_id"] = proposed["proposal"]["proposal_id"]

    result = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[],
        operation=RECALL_OPERATION["CREATE"],
        approval=approval,
    )

    assert result["decision"] == RECALL_TRANSITION_DECISION["REFUSED"]
    assert result["reason_codes"] == [
        RECALL_TRANSITION_REASON["NOT_APPROVED"]
    ]
    assert result["assertions"] == result["added"] == []


def test_transition_refuses_invalid_unbounded_and_identity_conflicting_ledgers():
    not_a_ledger = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions={},
        operation=RECALL_OPERATION["PRESERVE"],
    )
    assert not_a_ledger["reason_codes"] == [
        RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
    ]

    cyclic = []
    cyclic.append(cyclic)
    unbounded = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=cyclic,
        operation=RECALL_OPERATION["PRESERVE"],
    )
    assert unbounded["reason_codes"] == [
        RECALL_TRANSITION_REASON["WORK_UNBOUNDED"]
    ]

    too_many = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[neighbor()] * 10_001,
        operation=RECALL_OPERATION["PRESERVE"],
    )
    assert too_many["reason_codes"] == [
        RECALL_TRANSITION_REASON["WORK_UNBOUNDED"]
    ]

    unknown = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[neighbor({"subject": {"node_id": "repository_missing"}})],
        operation=RECALL_OPERATION["PRESERVE"],
    )
    assert unknown["reason_codes"] == [
        RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
    ]

    proposed = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[],
        operation=RECALL_OPERATION["CREATE"],
    )
    occupied = neighbor(
        {
            "id": proposed["proposal"]["assertion_id"],
            "predicate": "different_predicate",
        }
    )
    conflict = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[occupied],
        operation=RECALL_OPERATION["CREATE"],
    )
    assert conflict["reason_codes"] == [
        RECALL_TRANSITION_REASON["ASSERTION_IDENTITY_CONFLICT"]
    ]
    assert conflict["assertions"] == [occupied]


def test_public_recall_seam_and_unknown_operation_are_stable():
    result = project_recall_transition(
        graph=graph(),
        candidate=candidate(),
        assertions=[],
        operation="write",
    )

    assert callable(project_recall_transition)
    assert result == {
        "schema": RECALL_TRANSITION_SCHEMA,
        "decision": RECALL_TRANSITION_DECISION["REFUSED"],
        "operation": "write",
        "reason_codes": [RECALL_TRANSITION_REASON["UNKNOWN_OPERATION"]],
        "evaluation": None,
        "assertions": [],
        "added": [],
        "superseded_assertion_ids": [],
        "proposal": None,
    }
