"""Translation of tests/event.test.mjs (ticket #84, decision 0008).

Deterministic clocks: occurred/recorded are separate instants, mirroring the
ARCHITECTURE.md envelope example.
"""

import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(PY_ROOT)
sys.path.insert(0, PY_ROOT)

from vivary_core.event_contract import (  # noqa: E402
    EVENT_SCHEMA,
    PROJECTION_SCHEMA,
    create_context_integrity_event,
    create_event_log,
    project_from_events,
    validate_context_integrity_event,
)

OCCURRED = "2026-07-20T15:00:00.000Z"
RECORDED = "2026-07-20T15:00:01.000Z"


def base_input():
    return {
        "event_type": "memory.assertion.proposed",
        "occurred_at": OCCURRED,
        "producer": {"module": "bellamente", "version": "0.0.0"},
        "actor": {"kind": "agent", "id": "claude-code:vivary-lattice"},
        "workspace": {"id": "ws_lattice_fixture", "revision": "lab://fixtures"},
        "subject": {"kind": "repository", "id": "repo_vivary"},
        "scope": {"project": "vivary-lattice-lab", "visibility": "local"},
        "payload": {"assertion": "canonical checkout is lab://fixtures/canonical"},
        "now": lambda: RECORDED,
    }


def test_created_event_carries_the_v0_schema_and_a_deterministic_event_id():
    a = create_context_integrity_event(**base_input())
    b = create_context_integrity_event(**base_input())
    assert a["schema"] == EVENT_SCHEMA
    assert EVENT_SCHEMA == "vivary.context-integrity-event/v0"
    assert re.match(r"^evt_[0-9a-f]{16}$", a["event_id"])
    assert a == b


def test_occurred_at_and_recorded_at_are_separate_fields_with_separate_sources():
    event = create_context_integrity_event(**base_input())
    assert event["occurred_at"] == OCCURRED
    assert event["recorded_at"] == RECORDED


def test_different_bodies_yield_different_event_ids():
    a = create_context_integrity_event(**base_input())
    b = create_context_integrity_event(**{**base_input(), "event_type": "capsule.compiled"})
    assert a["event_id"] != b["event_id"]


def test_a_well_formed_event_validates_with_no_reason_codes():
    verdict = validate_context_integrity_event(create_context_integrity_event(**base_input()))
    assert verdict == {"valid": True, "reason_codes": []}


def test_an_unknown_schema_version_fails_closed():
    event = {**create_context_integrity_event(**base_input()), "schema": "vivary.context-integrity-event/v1"}
    verdict = validate_context_integrity_event(event)
    assert verdict["valid"] is False
    assert verdict["reason_codes"] == ["unsupported_schema"]


def test_actor_identity_must_be_explicit_kind_and_id():
    no_actor = {**create_context_integrity_event(**base_input())}
    del no_actor["actor"]
    assert validate_context_integrity_event(no_actor)["reason_codes"] == ["missing_actor_identity"]

    half_actor = {**create_context_integrity_event(**base_input()), "actor": {"kind": "agent"}}
    assert validate_context_integrity_event(half_actor)["reason_codes"] == ["missing_actor_identity"]


def test_producer_workspace_subject_and_scope_are_required_and_explicit():
    for field, code in [
        ("producer", "missing_producer"),
        ("workspace", "missing_workspace"),
        ("subject", "missing_subject"),
        ("scope", "missing_scope"),
    ]:
        event = {**create_context_integrity_event(**base_input())}
        del event[field]
        assert validate_context_integrity_event(event)["reason_codes"] == [code], field


def test_timestamps_must_both_be_present_and_be_valid_instants():
    # ADAPTATION: JS `occurred_at: undefined` -> Python absent-key analog
    # (deleting the key), per the undefined <-> absent-key mapping rule.
    no_occurred = {**create_context_integrity_event(**base_input())}
    del no_occurred["occurred_at"]
    assert validate_context_integrity_event(no_occurred)["reason_codes"] == ["invalid_occurred_at"]

    bad_recorded = {**create_context_integrity_event(**base_input()), "recorded_at": "yesterday-ish"}
    assert validate_context_integrity_event(bad_recorded)["reason_codes"] == ["invalid_recorded_at"]


def test_evidence_is_referenced_and_fingerprinted_never_silently_copied():
    fingerprinted = create_context_integrity_event(
        **{**base_input(), "evidence": [{"kind": "file", "ref": "docs/source.md", "digest": "sha256:abc"}]}
    )
    assert validate_context_integrity_event(fingerprinted)["valid"] is True

    bare = create_context_integrity_event(
        **{**base_input(), "evidence": [{"kind": "file", "ref": "docs/source.md"}]}
    )
    assert validate_context_integrity_event(bare)["reason_codes"] == ["evidence_not_fingerprinted"]


def test_a_missing_event_id_or_event_type_is_rejected():
    event = create_context_integrity_event(**base_input())
    no_id = {k: v for k, v in event.items() if k != "event_id"}
    assert validate_context_integrity_event(no_id)["reason_codes"] == ["missing_event_id"]

    no_type = {**event, "event_type": ""}
    assert validate_context_integrity_event(no_type)["reason_codes"] == ["missing_event_type"]


def new_log():
    return create_event_log(project="vivary-lattice-lab", visibility="local", policy_version="policy/v0")


def test_appending_the_same_event_twice_is_idempotent_once_accepted_then_a_no_op_duplicate():
    log = new_log()
    event = create_context_integrity_event(**base_input())
    assert log.append(event) == {"decision": "accepted", "reason_codes": []}
    assert log.append(event) == {"decision": "duplicate", "reason_codes": []}
    assert len(log.accepted()) == 1


def test_reusing_an_event_id_for_a_different_body_fails_closed():
    log = new_log()
    event = create_context_integrity_event(**base_input())
    log.append(event)
    imposter = {
        **create_context_integrity_event(**{**base_input(), "event_type": "capsule.compiled"}),
        "event_id": event["event_id"],
    }
    assert log.append(imposter) == {"decision": "rejected", "reason_codes": ["event_id_reuse"]}
    assert len(log.accepted()) == 1


def test_an_invalid_envelope_is_rejected_with_its_validation_reason_codes():
    # ADAPTATION: JS `actor: undefined` -> Python absent-key analog.
    log = new_log()
    event = {**create_context_integrity_event(**base_input())}
    del event["actor"]
    assert log.append(event) == {"decision": "rejected", "reason_codes": ["missing_actor_identity"]}
    assert log.accepted() == ()


def test_cross_project_writes_fail_closed():
    log = new_log()
    foreign = create_context_integrity_event(
        **{**base_input(), "scope": {"project": "some-other-project", "visibility": "local"}}
    )
    assert log.append(foreign) == {"decision": "rejected", "reason_codes": ["cross_project_write"]}
    assert log.accepted() == ()


def test_private_to_public_writes_fail_closed_equal_or_broader_sinks_never_widen_an_event():
    public_sink = create_event_log(project="vivary-lattice-lab", visibility="public", policy_version="policy/v0")
    private_event = create_context_integrity_event(
        **{**base_input(), "scope": {"project": "vivary-lattice-lab", "visibility": "private"}}
    )
    local_event = create_context_integrity_event(**base_input())
    assert public_sink.append(private_event) == {"decision": "rejected", "reason_codes": ["private_to_public_write"]}
    assert public_sink.append(local_event) == {"decision": "rejected", "reason_codes": ["private_to_public_write"]}

    local_sink = new_log()
    assert local_sink.append(private_event)["decision"] == "rejected"
    assert local_sink.append(local_event)["decision"] == "accepted"

    public_event = create_context_integrity_event(
        **{**base_input(), "scope": {"project": "vivary-lattice-lab", "visibility": "public"}}
    )
    assert new_log().append(public_event)["decision"] == "accepted"


def test_acceptance_order_is_the_replay_order_monotonic_sequence_occurred_at_does_not_reorder():
    log = new_log()
    later = create_context_integrity_event(**{**base_input(), "occurred_at": "2026-07-20T18:00:00.000Z"})
    earlier = create_context_integrity_event(**base_input())
    log.append(later)
    log.append(earlier)
    accepted = log.accepted()
    assert [e["sequence"] for e in accepted] == [1, 2]
    assert [e["event"]["event_id"] for e in accepted] == [later["event_id"], earlier["event_id"]]


def test_the_log_is_append_only_no_mutation_surface_and_accepted_entries_are_frozen():
    # ADAPTATION: JS Object.freeze()/deep-freeze makes mutation throw
    # TypeError; Python dicts have no such mechanism. The Python translation
    # of "no mutation surface": accepted() always hands back a tuple (no
    # append/push method - AttributeError on the attempt, the closest Python
    # analog of "throws") wrapping a *fresh deep copy* of each entry, so
    # mutating what you got back can never leak into the log's internal
    # state - proven below instead of asserting a JS-specific exception type.
    log = new_log()
    log.append(create_context_integrity_event(**base_input()))
    assert not hasattr(log, "remove")
    assert not hasattr(log, "update")

    entries = log.accepted()
    assert isinstance(entries, tuple)
    with pytest.raises(AttributeError):
        entries.append("extra")

    entry = entries[0]
    entry["event"]["event_type"] = "tampered"
    assert log.accepted()[0]["event"]["event_type"] != "tampered"
    assert len(log.accepted()) == 1


def test_a_correction_is_a_new_event_referencing_the_prior_one_not_an_edit():
    log = new_log()
    original = create_context_integrity_event(**base_input())
    log.append(original)
    correction = create_context_integrity_event(
        **{**base_input(), "event_type": "memory.assertion.corrected", "causation_id": original["event_id"]}
    )
    assert log.append(correction)["decision"] == "accepted"
    accepted = log.accepted()
    assert len(accepted) == 2
    assert accepted[1]["event"]["causation_id"] == original["event_id"]
    assert accepted[0]["event"]["event_type"] == "memory.assertion.proposed"


def sample_log():
    log = new_log()
    log.append(create_context_integrity_event(**base_input()))
    log.append(
        create_context_integrity_event(
            **{
                **base_input(),
                "event_type": "capsule.compiled",
                "subject": {"kind": "capsule", "id": "capsule_fixture"},
            }
        )
    )
    log.append(
        create_context_integrity_event(
            **{**base_input(), "event_type": "memory.assertion.corrected"}
        )
    )
    return log


def test_a_projection_is_rebuilt_from_accepted_events_and_its_policy_version_deterministically():
    a = project_from_events(sample_log().accepted(), policy_version="policy/v0")
    b = project_from_events(sample_log().accepted(), policy_version="policy/v0")
    assert a["schema"] == PROJECTION_SCHEMA
    assert a["policy_version"] == "policy/v0"
    assert a == b
    assert re.match(r"^sha256:[0-9a-f]{64}$", a["fingerprint"])


def test_the_projection_summarizes_subjects_in_replay_order():
    projection = project_from_events(sample_log().accepted(), policy_version="policy/v0")
    assert projection["event_count"] == 3
    assert projection["event_types"] == {
        "capsule.compiled": 1,
        "memory.assertion.corrected": 1,
        "memory.assertion.proposed": 1,
    }
    repo = projection["subjects"]["repository:repo_vivary"]
    assert repo["event_count"] == 2
    assert repo["last_event_type"] == "memory.assertion.corrected"
    assert projection["subjects"]["capsule:capsule_fixture"]["last_event_type"] == "capsule.compiled"


def test_a_different_policy_version_is_a_different_projection():
    a = project_from_events(sample_log().accepted(), policy_version="policy/v0")
    b = project_from_events(sample_log().accepted(), policy_version="policy/v1-strict")
    assert a["fingerprint"] != b["fingerprint"]


def test_consumers_ignore_unknown_namespaced_extensions_they_never_change_the_projection():
    log = sample_log()
    entries = log.accepted()
    extended = json.loads(json.dumps(entries))
    extended[0]["event"]["extensions"]["future-module"] = {"experimental": True, "weight": 42}
    a = project_from_events(entries, policy_version="policy/v0")
    b = project_from_events(extended, policy_version="policy/v0")
    assert a == b


def test_every_reason_code_is_reported_when_several_invariants_break_at_once():
    verdict = validate_context_integrity_event({"schema": "garbage"})
    assert verdict["valid"] is False
    assert "unsupported_schema" in verdict["reason_codes"]
    assert "missing_actor_identity" in verdict["reason_codes"]
    assert len(verdict["reason_codes"]) >= 5


# --- Frozen conformance fixtures -------------------------------------------
# The committed JSON under tests/fixtures/context-integrity-event-v0/ is the
# v0 seam. These tests only replay it; if implementation and fixture disagree,
# the fixture wins - changing an expectation is a schema version bump.

FROZEN_DIR = os.path.join(HERE, "fixtures", "context-integrity-event-v0")


def load_frozen(name):
    with open(os.path.join(FROZEN_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def test_frozen_conformance_cases_every_decision_and_reason_code_reproduces_exactly():
    fixture = load_frozen("conformance.json")
    sink, cases = fixture["sink"], fixture["cases"]
    assert len(cases) >= 12
    for case in cases:
        outcome = create_event_log(**sink).append(case["event"])
        assert outcome == case["expect"], case["name"]


def test_frozen_replay_append_outcomes_acceptance_order_and_rebuilt_projection_reproduce_exactly():
    fixture = load_frozen("replay.json")
    sink, events, expect = fixture["sink"], fixture["events"], fixture["expect"]
    log = create_event_log(**sink)
    outcomes = [log.append(event) for event in events]
    assert outcomes == expect["append_outcomes"]

    accepted = log.accepted()
    assert [entry["event"]["event_id"] for entry in accepted] == expect["accepted_event_ids"]
    assert [entry["sequence"] for entry in accepted] == list(range(1, len(accepted) + 1))

    projection = project_from_events(accepted, policy_version=sink["policy_version"])
    assert projection == expect["projection"]

    # Rebuilding from a serialization round-trip of the accepted events - not
    # from live log state - must yield the same bytes.
    rebuilt = project_from_events(json.loads(json.dumps(accepted)), policy_version=sink["policy_version"])
    assert rebuilt == expect["projection"]
