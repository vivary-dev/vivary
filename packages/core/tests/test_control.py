"""Pytest translation of tests/control.test.mjs (graduation slice 5,
ticket #8, decision 0008).

Contract tests for the Exo control-graph slice. Agent Relay's durable
coordination concepts (src/migration/relay-views.mjs "Exo" view: owner,
next actor, claim, dependencies, blocked_reason, handoff) are the migration
source for the vocabulary here, projected into a typed, pure, in-memory
module family that mirrors vivary_core.policy_*'s purity: no I/O, no
persistence, caller-owned state threaded in and out, pinned reason codes,
fail closed on any unrecognized shape.

Three laws pinned end-to-end in this file:
  1. claim stays the one narrow writer - exactly one active claim per
     scope, overlapping-scope claims are refused as conflicts before any
     edit collides (PRD user story 6).
  2. control and execution stay distinguishable - execution edges derived
     from receipts are append-only evidence; a task marked done can never
     erase or mask a failed verification edge (docs/ARCHITECTURE.md, "Exo
     execution graph").
  3. workers never become product owners - an actor of kind worker/agent
     cannot acquire ownership-class authority via a claim or a handoff.
"""

from __future__ import annotations

import inspect
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

from vivary_core.control_scope import normalize_scope, scopes_overlap  # noqa: E402
from vivary_core.control_actors import (  # noqa: E402
    ACTOR_KIND,
    AUTHORITY_CLASS,
    can_hold_authority,
)
from vivary_core.control_claims import (  # noqa: E402
    CLAIM_DECISION,
    expire_leases,
    release_claim,
    request_claim,
)
from vivary_core.control_reason_codes import (  # noqa: E402
    AUTHORITY_REASON,
    CLAIM_REASON,
    DEPENDENCY_DECISION,
    DEPENDENCY_REASON,
    EXECUTION_REASON,
    HANDOFF_DECISION,
    HANDOFF_REASON,
    LEASE_REASON,
)
from vivary_core.control_dependencies import detect_dependency_cycle, evaluate_dependencies  # noqa: E402
from vivary_core.control_handoffs import create_handoff  # noqa: E402
from vivary_core.control_execution import append_execution_edges, derive_execution_edges  # noqa: E402
from vivary_core.control_tasks import mark_task_done, task_integrity_view, with_gate_reference  # noqa: E402
from vivary_core.receipt import RECEIPT_SCHEMA  # noqa: E402
from vivary_core.capsule_compile import CAPSULE_SCHEMA  # noqa: E402

CONTROL_DIR = os.path.join(PY_ROOT, "vivary_core")
CONTROL_MODULE_NAMES = [
    "control_actors.py",
    "control_claims.py",
    "control_dependencies.py",
    "control_execution.py",
    "control_handoffs.py",
    "control_reason_codes.py",
    "control_scope.py",
    "control_tasks.py",
    "control.py",
]

# -- fixtures shared across groups ---------------------------------------------------

HUMAN = {"kind": ACTOR_KIND["HUMAN"], "id": "jeff"}
AGENT = {"kind": ACTOR_KIND["AGENT"], "id": "codex:task-1"}
WORKER = {"kind": ACTOR_KIND["WORKER"], "id": "worker:runner-1"}


def scope(project, paths):
    return {"project": project, "paths": paths}


def capsule_like(overrides=None):
    base = {
        "schema": CAPSULE_SCHEMA,
        "capsule_id": "capsule_abc",
        "fingerprint": "sha256:capsule-fp",
        "workspace": {"fingerprint": "sha256:workspace-fp", "observed_at": "2026-07-20T15:00:00.000Z"},
    }
    return {**base, **(overrides or {})}


def receipt_like(overrides=None):
    base = {
        "schema": RECEIPT_SCHEMA,
        "receipt_id": "receipt_abc",
        "fingerprint": "sha256:receipt-fp",
        "capsule": {"id": "capsule_abc", "fingerprint": "sha256:capsule-fp"},
        "workspace": {"fingerprint": "sha256:workspace-fp", "observed_at": "2026-07-20T15:00:00.000Z"},
        "runtime": {"harness": "claude-code", "actor": "codex:task-1"},
        "checks": [{"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"}],
        "claims_in_scope": [],
        "claims_verified": [],
        "claims_unverified": [],
        "unresolved_conflicts": [],
        "unresolved_unknowns": [],
        "provenance": [],
        "created_at": "2026-07-20T15:05:00.000Z",
    }
    return {**base, **(overrides or {})}


# -- control_scope.py -------------------------------------------------------------------


def test_normalize_scope_sorts_and_de_duplicates_paths_and_leaves_project_untouched():
    normalized = normalize_scope(scope("vivary", ["b/two", "a/one", "a/one", "b\\two"]))
    assert normalized["project"] == "vivary"
    assert normalized["paths"] == ["a/one", "b/two"]


def test_scopes_overlap_is_false_across_different_projects_even_with_identical_paths():
    assert scopes_overlap(scope("vivary", ["src/a"]), scope("bellamente", ["src/a"])) is False


def test_scopes_overlap_is_true_when_one_scopes_path_nests_inside_the_others():
    assert scopes_overlap(scope("vivary", ["src/control"]), scope("vivary", ["src/control/claims.mjs"])) is True


def test_scopes_overlap_is_false_for_disjoint_sibling_paths_in_the_same_project():
    assert scopes_overlap(scope("vivary", ["src/control"]), scope("vivary", ["src/policy"])) is False


# -- control_actors.py -------------------------------------------------------------------


def test_a_human_actor_can_hold_owner_class_authority():
    assert can_hold_authority(HUMAN, AUTHORITY_CLASS["OWNER"])["allowed"] is True


def test_an_agent_actor_cannot_hold_owner_class_authority():
    result = can_hold_authority(AGENT, AUTHORITY_CLASS["OWNER"])
    assert result["allowed"] is False
    assert result["reason_codes"] == [AUTHORITY_REASON["WORKERS_CANNOT_OWN"]]


def test_a_worker_actor_cannot_hold_owner_class_authority():
    result = can_hold_authority(WORKER, AUTHORITY_CLASS["OWNER"])
    assert result["allowed"] is False
    assert result["reason_codes"] == [AUTHORITY_REASON["WORKERS_CANNOT_OWN"]]


def test_any_actor_kind_can_hold_contributor_class_authority():
    for actor in [HUMAN, AGENT, WORKER]:
        assert can_hold_authority(actor, AUTHORITY_CLASS["CONTRIBUTOR"])["allowed"] is True


def test_can_hold_authority_fails_closed_on_an_unrecognized_actor_kind():
    result = can_hold_authority({"kind": "ghost", "id": "x"}, AUTHORITY_CLASS["CONTRIBUTOR"])
    assert result["allowed"] is False
    assert result["reason_codes"] == [AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"]]

def test_can_hold_authority_fails_closed_on_an_unrecognized_authority_class():
    for authority_class in ("root", {}, []):
        result = can_hold_authority(HUMAN, authority_class)

        assert result["allowed"] is False
        assert result["reason_codes"] == [AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"]]


# -- control_claims.py: narrow-writer law -------------------------------------------------


def test_request_claim_grants_a_claim_when_no_active_claim_overlaps_its_scope():
    result = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    assert result["decision"] == CLAIM_DECISION["GRANTED"]
    assert result["reason_codes"] == []
    assert result["claim"]["actor"]["id"] == AGENT["id"]
    assert len(result["claims"]) == 1


def test_request_claim_refuses_an_overlapping_scope_claim_from_a_different_actor_as_a_conflict_before_any_edit():
    first = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    second = request_claim(
        active_claims=first["claims"],
        request={"scope": scope("vivary", ["src/control/claims.mjs"]), "actor": HUMAN},
    )
    assert second["decision"] == CLAIM_DECISION["REFUSED"]
    assert second["reason_codes"] == [CLAIM_REASON["SCOPE_CONFLICT"]]
    assert len(second["conflicts"]) == 1
    assert second["conflicts"][0]["claim_id"] == first["claim"]["claim_id"]
    # the ledger is unchanged - no partial write occurred
    assert len(second["claims"]) == 1


def test_request_claim_refuses_a_second_overlapping_claim_even_from_the_same_actor_exactly_one_active_claim_per_scope():
    first = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    second = request_claim(active_claims=first["claims"], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    assert second["decision"] == CLAIM_DECISION["REFUSED"]
    assert second["reason_codes"] == [CLAIM_REASON["SCOPE_CONFLICT"]]


def test_request_claim_grants_disjoint_scope_claims_from_different_actors_concurrently():
    first = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    second = request_claim(active_claims=first["claims"], request={"scope": scope("vivary", ["src/policy"]), "actor": HUMAN})
    assert second["decision"] == CLAIM_DECISION["GRANTED"]
    assert len(second["claims"]) == 2


def test_request_claim_fails_closed_on_a_malformed_request_shape():
    result = request_claim(active_claims=[], request={"scope": None, "actor": AGENT})
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]]


# -- control_claims.py: workers never become owners ---------------------------------------


def test_request_claim_refuses_owner_class_authority_for_a_worker_actor_workers_never_become_product_owners():
    result = request_claim(
        active_claims=[],
        request={"scope": scope("vivary", ["src/control"]), "actor": WORKER, "authority_class": AUTHORITY_CLASS["OWNER"]},
    )
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["WORKERS_CANNOT_OWN"]]
    assert len(result["claims"]) == 0


def test_request_claim_refuses_owner_class_authority_for_an_agent_actor_workers_never_become_product_owners():
    result = request_claim(
        active_claims=[],
        request={"scope": scope("vivary", ["src/control"]), "actor": AGENT, "authority_class": AUTHORITY_CLASS["OWNER"]},
    )
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["WORKERS_CANNOT_OWN"]]


def test_request_claim_grants_owner_class_authority_for_a_human_actor():
    result = request_claim(
        active_claims=[],
        request={"scope": scope("vivary", ["src/control"]), "actor": HUMAN, "authority_class": AUTHORITY_CLASS["OWNER"]},
    )
    assert result["decision"] == CLAIM_DECISION["GRANTED"]
    assert result["claim"]["authority_class"] == AUTHORITY_CLASS["OWNER"]


# -- control_claims.py: release ------------------------------------------------------------


def test_release_claim_releases_a_claim_for_its_holder():
    granted = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    result = release_claim(active_claims=granted["claims"], claim_id=granted["claim"]["claim_id"], actor=AGENT)
    assert result["decision"] == CLAIM_DECISION["RELEASED"]
    assert len(result["claims"]) == 0


def test_release_claim_fails_closed_for_an_actor_that_does_not_hold_the_claim():
    granted = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    result = release_claim(active_claims=granted["claims"], claim_id=granted["claim"]["claim_id"], actor=HUMAN)
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["NOT_CLAIM_HOLDER"]]
    assert len(result["claims"]) == 1


def test_release_claim_fails_closed_on_an_unknown_claim_id():
    result = release_claim(active_claims=[], claim_id="claim_missing", actor=AGENT)
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["CLAIM_NOT_FOUND"]]


def test_once_a_claim_releases_the_freed_scope_can_be_claimed_again():
    granted = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    released = release_claim(active_claims=granted["claims"], claim_id=granted["claim"]["claim_id"], actor=AGENT)
    regranted = request_claim(active_claims=released["claims"], request={"scope": scope("vivary", ["src/control"]), "actor": HUMAN})
    assert regranted["decision"] == CLAIM_DECISION["GRANTED"]


# -- control_claims.py: leases, time as input only ------------------------------------------


def test_expire_leases_releases_a_claim_whose_lease_has_expired_as_of_the_given_now_deterministic_on_input_time_alone():
    granted = request_claim(
        active_claims=[],
        request={
            "scope": scope("vivary", ["src/control"]),
            "actor": AGENT,
            "lease": {"granted_at": "2026-07-20T15:00:00.000Z", "expires_at": "2026-07-20T15:10:00.000Z"},
        },
    )
    still_live = expire_leases(active_claims=granted["claims"], now="2026-07-20T15:05:00.000Z")
    assert len(still_live["claims"]) == 1
    assert len(still_live["expired"]) == 0

    expired = expire_leases(active_claims=granted["claims"], now="2026-07-20T15:10:00.000Z")
    assert len(expired["claims"]) == 0
    assert len(expired["expired"]) == 1
    assert expired["expired"][0]["reason_codes"] == [LEASE_REASON["LEASE_EXPIRED"]]


def test_expire_leases_leaves_lease_less_claims_untouched_regardless_of_now():
    granted = request_claim(active_claims=[], request={"scope": scope("vivary", ["src/control"]), "actor": AGENT})
    result = expire_leases(active_claims=granted["claims"], now="2099-01-01T00:00:00.000Z")
    assert len(result["claims"]) == 1
    assert len(result["expired"]) == 0


def test_an_expired_leases_scope_is_claimable_again_once_expire_leases_has_run():
    granted = request_claim(
        active_claims=[],
        request={
            "scope": scope("vivary", ["src/control"]),
            "actor": AGENT,
            "lease": {"granted_at": "2026-07-20T15:00:00.000Z", "expires_at": "2026-07-20T15:10:00.000Z"},
        },
    )
    swept = expire_leases(active_claims=granted["claims"], now="2026-07-20T15:11:00.000Z")
    regranted = request_claim(active_claims=swept["claims"], request={"scope": scope("vivary", ["src/control"]), "actor": HUMAN})
    assert regranted["decision"] == CLAIM_DECISION["GRANTED"]


def test_control_never_reads_the_wall_clock_no_datetime_now_or_time_time_in_any_module():
    # Node equivalent: no `Date.now(` / bare `new Date()` in src/control/*.mjs.
    # Python equivalent: no wall-clock read in vivary_core/control*.py -
    # `now` is always a caller-supplied argument (see expire_leases).
    forbidden = ["datetime.now(", "time.time(", "time.time_ns(", ".utcnow("]
    for name in CONTROL_MODULE_NAMES:
        with open(os.path.join(CONTROL_DIR, name), encoding="utf-8") as f:
            source = f.read()
        for pattern in forbidden:
            assert pattern not in source, f"{name} must not read the wall clock ({pattern})"


# -- control_dependencies.py --------------------------------------------------------------


def test_evaluate_dependencies_is_ready_when_every_dependency_task_is_done():
    tasks = [
        {"id": "t1", "status": "done", "depends_on": []},
        {"id": "t2", "status": "open", "depends_on": ["t1"]},
    ]
    result = evaluate_dependencies(tasks=tasks, task_id="t2")
    assert result["decision"] == DEPENDENCY_DECISION["READY"]
    assert result["reason_codes"] == []


def test_evaluate_dependencies_blocks_when_a_dependency_task_is_not_done():
    tasks = [
        {"id": "t1", "status": "open", "depends_on": []},
        {"id": "t2", "status": "open", "depends_on": ["t1"]},
    ]
    result = evaluate_dependencies(tasks=tasks, task_id="t2")
    assert result["decision"] == DEPENDENCY_DECISION["BLOCKED"]
    assert result["reason_codes"] == [DEPENDENCY_REASON["DEPENDENCY_NOT_SATISFIED"]]
    assert result["unmet"] == ["t1"]


def test_evaluate_dependencies_fails_closed_when_a_dependency_task_id_does_not_exist_in_the_graph():
    tasks = [{"id": "t2", "status": "open", "depends_on": ["ghost"]}]
    result = evaluate_dependencies(tasks=tasks, task_id="t2")
    assert result["decision"] == DEPENDENCY_DECISION["BLOCKED"]
    assert result["reason_codes"] == [DEPENDENCY_REASON["DEPENDENCY_NOT_SATISFIED"]]
    assert result["unmet"] == ["ghost"]


def test_evaluate_dependencies_fails_closed_when_the_task_itself_is_unknown():
    result = evaluate_dependencies(tasks=[], task_id="ghost")
    assert result["decision"] == DEPENDENCY_DECISION["BLOCKED"]
    assert result["reason_codes"] == [DEPENDENCY_REASON["UNKNOWN_TASK"]]


def test_detect_dependency_cycle_finds_a_direct_cycle_and_fails_closed():
    tasks = [
        {"id": "a", "depends_on": ["b"]},
        {"id": "b", "depends_on": ["a"]},
    ]
    result = detect_dependency_cycle(tasks=tasks)
    assert result["has_cycle"] is True
    assert "a" in result["cycle"] and "b" in result["cycle"]


def test_detect_dependency_cycle_reports_no_cycle_for_a_dag():
    tasks = [
        {"id": "a", "depends_on": []},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["a", "b"]},
    ]
    result = detect_dependency_cycle(tasks=tasks)
    assert result["has_cycle"] is False
    assert result["cycle"] == []


# -- control_handoffs.py: bind claim + receipt to capsule fingerprint + workspace revision ---


def test_create_handoff_binds_a_claim_and_receipt_to_the_capsule_fingerprint_and_workspace_revision():
    capsule = capsule_like()
    receipt = receipt_like()
    claim = {"claim_id": "claim_1", "actor": AGENT, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["CONTRIBUTOR"]}
    result = create_handoff(
        claim=claim,
        receipt=receipt,
        capsule=capsule,
        from_actor=AGENT,
        to_actor=HUMAN,
        workspace_revision=capsule["workspace"]["fingerprint"],
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["BOUND"]
    assert result["reason_codes"] == []
    assert result["handoff"]["claim_id"] == claim["claim_id"]
    assert result["handoff"]["capsule"]["fingerprint"] == capsule["fingerprint"]
    assert result["handoff"]["receipt"]["fingerprint"] == receipt["fingerprint"]
    assert result["handoff"]["workspace_revision"] == capsule["workspace"]["fingerprint"]


def test_create_handoff_fails_closed_when_the_receipt_was_not_run_against_the_given_capsule():
    capsule = capsule_like()
    receipt = receipt_like(overrides={"capsule": {"id": "capsule_other", "fingerprint": "sha256:different"}})
    claim = {"claim_id": "claim_1", "actor": AGENT, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["CONTRIBUTOR"]}
    result = create_handoff(
        claim=claim,
        receipt=receipt,
        capsule=capsule,
        from_actor=AGENT,
        to_actor=HUMAN,
        workspace_revision=capsule["workspace"]["fingerprint"],
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["REFUSED"]
    assert result["reason_codes"] == [HANDOFF_REASON["RECEIPT_CAPSULE_MISMATCH"]]


def test_create_handoff_fails_closed_when_the_workspace_revision_does_not_match_the_receipts():
    capsule = capsule_like()
    receipt = receipt_like()
    claim = {"claim_id": "claim_1", "actor": AGENT, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["CONTRIBUTOR"]}
    result = create_handoff(
        claim=claim,
        receipt=receipt,
        capsule=capsule,
        from_actor=AGENT,
        to_actor=HUMAN,
        workspace_revision="sha256:stale-revision",
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["REFUSED"]
    assert result["reason_codes"] == [HANDOFF_REASON["WORKSPACE_REVISION_MISMATCH"]]


def test_create_handoff_fails_closed_on_a_malformed_capsule_or_receipt_shape():
    claim = {"claim_id": "claim_1", "actor": AGENT, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["CONTRIBUTOR"]}
    result = create_handoff(
        claim=claim,
        receipt={"not": "a receipt"},
        capsule=capsule_like(),
        from_actor=AGENT,
        to_actor=HUMAN,
        workspace_revision="sha256:workspace-fp",
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["REFUSED"]
    assert result["reason_codes"] == [HANDOFF_REASON["UNKNOWN_RECEIPT_SHAPE"]]


def test_create_handoff_refuses_to_hand_ownership_authority_to_a_worker_or_agent_actor_workers_never_become_product_owners():
    capsule = capsule_like()
    receipt = receipt_like()
    claim = {"claim_id": "claim_1", "actor": HUMAN, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["OWNER"]}
    result = create_handoff(
        claim=claim,
        receipt=receipt,
        capsule=capsule,
        from_actor=HUMAN,
        to_actor=WORKER,
        to_authority_class=AUTHORITY_CLASS["OWNER"],
        workspace_revision=capsule["workspace"]["fingerprint"],
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["REFUSED"]
    assert result["reason_codes"] == [HANDOFF_REASON["WORKERS_CANNOT_OWN"]]


def test_create_handoff_allows_handing_contributor_class_authority_to_an_agent_actor():
    capsule = capsule_like()
    receipt = receipt_like()
    claim = {"claim_id": "claim_1", "actor": HUMAN, "scope": scope("vivary", ["src/control"]), "authority_class": AUTHORITY_CLASS["OWNER"]}
    result = create_handoff(
        claim=claim,
        receipt=receipt,
        capsule=capsule,
        from_actor=HUMAN,
        to_actor=AGENT,
        to_authority_class=AUTHORITY_CLASS["CONTRIBUTOR"],
        workspace_revision=capsule["workspace"]["fingerprint"],
        created_at="2026-07-20T15:06:00.000Z",
    )
    assert result["decision"] == HANDOFF_DECISION["BOUND"]


# -- control_execution.py: append-only evidence derived from receipts -----------------------


def test_derive_execution_edges_produces_one_edge_per_check_carrying_the_receipts_fingerprint_and_outcome():
    receipt = receipt_like(
        overrides={
            "checks": [
                {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"},
                {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "failed", "detail": "2 errors"},
            ]
        }
    )
    result = derive_execution_edges(receipt=receipt)
    assert result["reason_codes"] == []
    assert len(result["edges"]) == 2
    assert result["edges"][0]["outcome"] == "passed"
    assert result["edges"][1]["outcome"] == "failed"
    assert result["edges"][1]["detail"] == "2 errors"
    for edge in result["edges"]:
        assert edge["receipt_fingerprint"] == receipt["fingerprint"]
        assert edge["capsule_id"] == receipt["capsule"]["id"]
        assert edge["kind"] == "check"


def test_derive_execution_edges_fails_closed_on_a_malformed_receipt_shape():
    result = derive_execution_edges(receipt={"not": "a receipt"})
    assert result["edges"] == []
    assert result["reason_codes"] == [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]


def test_append_execution_edges_is_append_only_it_returns_a_new_list_and_never_mutates_the_log_passed_in():
    receipt = receipt_like()
    edges = derive_execution_edges(receipt=receipt)["edges"]
    original_log = ()  # an immutable tuple, the Python stand-in for Node's Object.freeze([])
    result = append_execution_edges(log=original_log, edges=edges)
    assert len(original_log) == 0, "the caller's original log must be untouched"
    assert len(result) == 1


def test_append_execution_edges_is_idempotent_by_edge_id_appending_the_same_derived_edges_twice_does_not_duplicate_them():
    receipt = receipt_like()
    edges = derive_execution_edges(receipt=receipt)["edges"]
    once = append_execution_edges(log=[], edges=edges)
    twice = append_execution_edges(log=once, edges=edges)
    assert len(twice) == len(once)


# -- control_tasks.py: adversarial law - done cannot erase or mask a failed verification edge ---


def test_a_task_marked_done_cannot_erase_or_mask_a_failed_verification_edge_it_stays_reachable_and_reported():
    receipt = receipt_like(
        overrides={
            "checks": [
                {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"},
                {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "failed", "detail": "2 errors"},
            ]
        }
    )
    edges = derive_execution_edges(receipt=receipt)["edges"]
    execution_log = append_execution_edges(log=[], edges=edges)

    task = {"task_id": "t1", "capsule_id": receipt["capsule"]["id"], "status": "open", "depends_on": []}
    before = task_integrity_view(task=task, execution_log=execution_log)
    assert before["has_failed_verification"] is True
    assert len(before["failed_edges"]) == 1

    done = mark_task_done(task=task)
    assert done["status"] == "done"

    after = task_integrity_view(task=done, execution_log=execution_log)
    assert after["status"] == "done"
    assert after["has_failed_verification"] is True, "marking done must not mask the failed edge"
    assert len(after["failed_edges"]) == 1, "the failed edge must remain reachable after completion"
    assert after["failed_edges"][0]["outcome"] == "failed"


def test_mark_task_dones_signature_carries_no_execution_log_completion_is_architecturally_unable_to_touch_execution_evidence():
    # mark_task_done only ever receives {task}; it has no parameter through
    # which an execution log (or any edge array) could be passed in and
    # mutated.
    params = inspect.signature(mark_task_done).parameters
    assert list(params.keys()) == ["task"]


def test_task_integrity_view_reports_no_failed_edges_once_every_check_for_the_tasks_capsule_passed():
    receipt = receipt_like(overrides={"checks": [{"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"}]})
    edges = derive_execution_edges(receipt=receipt)["edges"]
    execution_log = append_execution_edges(log=[], edges=edges)
    task = mark_task_done(task={"task_id": "t1", "capsule_id": receipt["capsule"]["id"], "status": "open", "depends_on": []})
    view = task_integrity_view(task=task, execution_log=execution_log)
    assert view["has_failed_verification"] is False
    assert view["failed_edges"] == []


def test_control_tasks_and_execution_never_remove_entries_from_an_execution_log_no_pop_del_or_remove_on_lists():
    for name in ["control_tasks.py", "control_execution.py"]:
        with open(os.path.join(CONTROL_DIR, name), encoding="utf-8") as f:
            source = f.read()
        assert ".pop(" not in source, f"{name} must not pop"
        assert ".remove(" not in source, f"{name} must not remove"
        assert ".clear(" not in source, f"{name} must not clear"
        assert "del " not in source, f"{name} must not delete entries"


# -- control_tasks.py: gates-as-references -----------------------------------------------


def test_with_gate_reference_attaches_a_well_formed_gate_reference_read_only_without_re_evaluating_it():
    task = {"task_id": "t1", "capsule_id": "capsule_abc", "status": "open", "depends_on": []}
    gate_result = {"decision": "gate_required", "reason_codes": ["unresolved_conflict"]}
    result = with_gate_reference(task=task, gate_result=gate_result)
    assert result["task"]["gate_ref"] == gate_result
    assert result["reason_codes"] == []


def test_with_gate_reference_fails_closed_on_a_malformed_gate_shape():
    task = {"task_id": "t1", "capsule_id": "capsule_abc", "status": "open", "depends_on": []}
    result = with_gate_reference(task=task, gate_result={"decision": "clear"})
    assert result["task"] == task
    assert result["reason_codes"] == ["unknown_gate_shape"]


# -- source scan: no persistence, no process, no network, by construction ------------------


def test_control_performs_no_filesystem_process_or_network_io_by_source_scan_of_every_module():
    forbidden = [
        "import os",
        "import subprocess",
        "import socket",
        "import shutil",
        "urllib",
        "requests",
        "open(",
        "input(",
    ]
    for name in CONTROL_MODULE_NAMES:
        with open(os.path.join(CONTROL_DIR, name), encoding="utf-8") as f:
            source = f.read()
        for pattern in forbidden:
            assert pattern not in source, f"{name} must not reference {pattern}"
