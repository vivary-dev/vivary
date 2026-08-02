"""Contract tests for Core-owned governed control semantics (#204)."""

from __future__ import annotations

import copy
import inspect
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

from vivary_core.capsule_compile import compile_task_capsule, verify_task_capsule_integrity  # noqa: E402
from vivary_core.canonical import deterministic_id  # noqa: E402
from vivary_core.control import (  # noqa: E402
    ACTOR_KIND,
    AUTHORITY_CLASS,
    AUTHORITY_REASON,
    CLAIM_DECISION,
    CLAIM_REASON,
    DEPENDENCY_DECISION,
    DEPENDENCY_REASON,
    EXECUTION_REASON,
    GATE_REFERENCE_REASON,
    HANDOFF_DECISION,
    HANDOFF_REASON,
    LEASE_REASON,
    TASK_REASON,
    can_hold_authority,
    create_handoff,
    derive_execution_edges,
    evaluate_dependencies,
    expire_leases,
    mark_task_done,
    record_execution,
    release_claim,
    request_claim,
    task_integrity_view,
    with_gate_reference,
)  # noqa: E402
from vivary_core.control_scope import normalize_scope, scopes_overlap  # noqa: E402
from vivary_core.receipt import create_integrity_receipt  # noqa: E402
from vivary_core.verify_receipt import verify_receipt_integrity  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402

NOW = "2026-08-01T12:00:00Z"
RUN_AT = "2026-08-01T12:10:00Z"
HANDOFF_AT = "2026-08-01T12:15:00Z"
EXPIRES_AT = "2026-08-01T13:00:00Z"
HUMAN = {"kind": ACTOR_KIND["HUMAN"], "id": "jeff"}
AGENT = {"kind": ACTOR_KIND["AGENT"], "id": "agent:runner"}
OTHER_AGENT = {"kind": ACTOR_KIND["AGENT"], "id": "agent:reviewer"}
WORKER = {"kind": ACTOR_KIND["WORKER"], "id": "worker:runner"}
_MISSING = object()


def scope(project="vivary", paths=None):
    return {"project": project, "paths": ["packages/exo"] if paths is None else paths}


def lease(granted_at=NOW, expires_at=EXPIRES_AT):
    return {"granted_at": granted_at, "expires_at": expires_at}


def claim_request(*, paths=None, actor=AGENT, now=NOW, lease_value=_MISSING, authority_class=None):
    request = {"scope": scope(paths=paths), "actor": actor, "now": now}
    if lease_value is not _MISSING:
        request["lease"] = lease_value
    if authority_class is not None:
        request["authority_class"] = authority_class
    return request


def grant(**fields):
    result = request_claim([], claim_request(**fields))
    assert result["decision"] == CLAIM_DECISION["GRANTED"]
    return result


def _known(value, command):
    return {"status": "known", "value": value, "evidence": {"command": command}}


@pytest.fixture(scope="module")
def capsule():
    root = "/synthetic-governed/repo"
    checkout = {
        "raw_path": root,
        "path": root,
        "status": "observed",
        "facts": {
            "is_git_repository": _known(True, "git rev-parse --show-toplevel"),
            "worktree_root": _known(root, "git rev-parse --show-toplevel"),
            "head_revision": _known("0" * 40, "git rev-parse HEAD"),
            "head_ref": _known({"kind": "branch", "name": "main"}, "git symbolic-ref --short -q HEAD"),
            "dirty_entries": _known([], "git status --porcelain"),
            "is_dirty": _known(False, "git status --porcelain"),
            "remotes": _known([{"name": "origin", "fetch_url": "https://example.test/governed.git"}], "git remote -v"),
            "upstream": _known("origin/main", "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"),
            "last_fetch": _known("2026-07-31T00:00:00Z", "fs.stat FETCH_HEAD"),
            "workspace_markers": _known(["tropo.toml", "AGENTS.md"], "fs.stat workspace markers"),
        },
    }
    observation = {
        "schema": "vivary.workspace-observation/v0",
        "observed_at": NOW,
        "allowlist": [root],
        "checkouts": [checkout],
        "refusals": [],
    }
    compiled = compile_task_capsule(
        task={"question": "Does governed execution retain failed evidence?"},
        graph=project_workspace_graph(observation),
    )
    assert verify_task_capsule_integrity(compiled)
    return compiled


def receipt_for(capsule, *, actor=AGENT["id"], created_at=RUN_AT, failed=True):
    checks = [
        {
            "name": check["name"],
            "command": check["command"],
            "outcome": "failed" if failed and index == 0 else "passed",
        }
        for index, check in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "core-control-test", "actor": actor},
        checks=checks,
        now=lambda: created_at,
    )
    assert verify_receipt_integrity(receipt=receipt, capsule=capsule)["outcome"] == "verified"
    return receipt


@pytest.fixture(scope="module")
def receipt(capsule):
    return receipt_for(capsule)


# Scope identity

def test_normalize_scope_is_deterministic_and_idempotent():
    normalized = normalize_scope(scope(paths=["b/two", "a/one", "a/one", "b\\two"]))
    assert normalized == {"project": "vivary", "paths": ["a/one", "b/two"]}
    assert normalize_scope(normalized) == normalized


@pytest.mark.parametrize(
    ("left", "right", "overlap"),
    [
        (["src/control"], ["src/control/claims.py"], True),
        (["src/control"], ["src/policy"], False),
        (["/"], ["/etc/vivary"], True),
        ([r"C:\\Repo"], [r"c:\\repo\\src"], True),
        ([r"C:Repo"], [r"C:/Repo"], False),
    ],
)
def test_scopes_overlap_uses_canonical_segment_anchors(left, right, overlap):
    assert scopes_overlap(scope(paths=left), scope(paths=right)) is overlap


def test_scopes_never_overlap_across_projects():
    assert not scopes_overlap(scope("vivary", ["src"]), scope("other", ["src/x"]))


@pytest.mark.parametrize(
    ("raw_path", "expected_path"),
    [
        ("src//control/../policy/.", "src/policy"),
        ("\N{ZERO WIDTH NO-BREAK SPACE}src/control", "src/control"),
        ("/src//control/../../", "/"),
        (r"\\Server\Share\folder\..\..", "//server/share"),
        (r"C:\Repo\src\..\Tests", "c:/repo/tests"),
        (r"C:Repo\src\..\Tests", "c:repo/tests"),
    ],
)
def test_normalize_scope_collapses_paths_without_escaping_anchors(raw_path, expected_path):
    normalized = normalize_scope(scope(paths=[raw_path]))
    assert normalized["paths"] == [expected_path]
    assert normalize_scope(normalized) == normalized


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ([r"C:\Repo"], [r"\\?\C:\Repo\src\control.py"]),
        ([r"C:\Repo"], [r"\\.\C:\Repo\src\control.py"]),
        ([r"\\Server\Share"], [r"\\?\UNC\server\share\src\control.py"]),
    ],
)
def test_scopes_overlap_folds_device_namespaces_to_drive_or_unc_anchors(left, right):
    assert scopes_overlap(scope(paths=left), scope(paths=right))


@pytest.mark.parametrize("device_root", ["\\\\?\\C:\\", r"\\?\C:", "\\\\.\\C:\\"])
def test_win32_device_roots_preserve_drive_anchor_semantics(device_root):
    normalized = normalize_scope(scope(paths=[device_root]))
    assert normalized["paths"] == ["c:/"]
    assert normalize_scope(normalized) == normalized
    assert scopes_overlap(scope(paths=[device_root]), scope(paths=[r"C:\Repo"]))
    assert not scopes_overlap(scope(paths=[device_root]), scope(paths=[r"C:Repo"]))


def test_windows_scope_casefold_remains_nfc_and_reusable_in_a_claim_ledger():
    path = "C:/\u0390"
    normalized = normalize_scope(scope(paths=[path]))
    assert normalized["paths"] == ["c:/\u0390"]
    claimed = grant(paths=[path])
    result = request_claim(
        claimed["claims"],
        claim_request(paths=["packages/core"], actor=OTHER_AGENT),
    )
    assert result["decision"] == CLAIM_DECISION["GRANTED"]

# Exact actor authority

def test_only_humans_can_hold_owner_authority():
    assert can_hold_authority(HUMAN, AUTHORITY_CLASS["OWNER"])["allowed"]
    for actor in (AGENT, WORKER):
        assert can_hold_authority(actor, AUTHORITY_CLASS["OWNER"]) == {
            "allowed": False,
            "reason_codes": [AUTHORITY_REASON["WORKERS_CANNOT_OWN"]],
        }


def test_contributors_may_be_human_agent_or_worker():
    assert all(can_hold_authority(actor, AUTHORITY_CLASS["CONTRIBUTOR"])["allowed"] for actor in (HUMAN, AGENT, WORKER))


@pytest.mark.parametrize(
    "actor",
    [
        {"kind": "agent", "id": ""},
        {"kind": "agent", "id": " padded "},
        {"kind": "agent", "id": "agent", "metadata": {}},
        {"kind": "agent"},
        {"kind": "agent", "id": "a" * 257},
        {"kind": "agent", "id": "e\u0301"},
    ],
)
def test_actor_identity_is_exact_canonical_and_bounded(actor):
    result = can_hold_authority(actor, AUTHORITY_CLASS["CONTRIBUTOR"])
    assert result["reason_codes"] == [AUTHORITY_REASON["UNKNOWN_ACTOR_SHAPE"]]


def test_unknown_actor_kind_and_authority_class_remain_distinct():
    assert can_hold_authority({"kind": "ghost", "id": "x"}, "contributor")["reason_codes"] == [AUTHORITY_REASON["UNKNOWN_ACTOR_KIND"]]
    assert can_hold_authority(AGENT, "root")["reason_codes"] == [AUTHORITY_REASON["UNKNOWN_AUTHORITY_CLASS"]]


# Claims, leases, and narrow-writer behavior

def test_claim_requires_explicit_now_and_returns_an_exact_identity():
    missing_now = request_claim([], {"scope": scope(), "actor": AGENT})
    assert missing_now["reason_codes"] == [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]]

    result = grant(lease_value=lease())
    claim = result["claim"]
    assert set(claim) == {"claim_id", "scope", "actor", "authority_class", "lease", "status", "created_at"}
    assert claim["created_at"] == NOW
    assert claim["lease"] == lease()


def test_claim_id_binds_created_at_and_lease_not_ledger_position():
    first = grant(lease_value=lease())
    later = grant(now="2026-08-01T12:00:01Z", lease_value=lease("2026-08-01T12:00:01Z"))
    unleased = grant()
    assert len({first["claim"]["claim_id"], later["claim"]["claim_id"], unleased["claim"]["claim_id"]}) == 3


def test_claim_normalizes_scope_and_refuses_overlap_before_writing():
    first = grant(paths=["packages/exo/./src"])
    before = copy.deepcopy(first["claims"])
    second = request_claim(first["claims"], claim_request(paths=["packages/exo/src/commands"], actor=OTHER_AGENT))
    assert second["decision"] == CLAIM_DECISION["REFUSED"]
    assert second["reason_codes"] == [CLAIM_REASON["SCOPE_CONFLICT"]]
    assert second["claims"] == before == first["claims"]


def test_disjoint_claims_can_coexist():
    first = grant(paths=["packages/exo"])
    second = request_claim(first["claims"], claim_request(paths=["packages/core"], actor=OTHER_AGENT))
    assert second["decision"] == CLAIM_DECISION["GRANTED"]
    assert len(second["claims"]) == 2


def test_large_disjoint_claim_projection_avoids_a_claim_by_request_path_join():
    active_claims = [
        grant(paths=[f"claims/{index}"])["claim"]
        for index in range(2_000)
    ]
    deep_paths = [
        "/".join([*(["d"] * 255), f"target-{index}"])
        for index in range(1_000)
    ]
    result = request_claim(
        active_claims,
        claim_request(paths=deep_paths, actor=OTHER_AGENT),
    )
    assert result["decision"] == CLAIM_DECISION["GRANTED"]


def test_claim_refuses_a_projection_beyond_the_ledger_ceiling_atomically():
    at_limit = [
        grant(paths=[f"claims/{index}"])["claim"]
        for index in range(10_000)
    ]
    result = request_claim(
        at_limit,
        claim_request(paths=["next-claim"], actor=OTHER_AGENT),
    )
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [CLAIM_REASON["WORK_UNBOUNDED"]]
    assert result["claim"] is None
    assert result["claims"] == at_limit


def test_caller_supplied_overlapping_ledger_is_refused():
    first = grant(paths=["packages/exo"])["claim"]
    second = grant(paths=["packages/exo/src"], actor=OTHER_AGENT, now="2026-08-01T12:00:01Z")["claim"]
    result = request_claim([first, second], claim_request(paths=["packages/core"]))
    assert result["reason_codes"] == [CLAIM_REASON["LEDGER_SCOPE_CONFLICT"]]
    assert result["claims"] == [first, second]


def test_duplicate_or_tampered_claim_identity_is_refused():
    claim = grant()["claim"]
    duplicate = request_claim([claim, claim], claim_request(paths=["packages/core"]))
    assert duplicate["reason_codes"] == [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]]
    tampered = {**claim, "created_at": "2026-08-01T12:00:01Z"}
    assert request_claim([tampered], claim_request(paths=["packages/core"]))["reason_codes"] == [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]]


@pytest.mark.parametrize(
    ("lease_value", "reason"),
    [
        (lease("bad", EXPIRES_AT), LEASE_REASON["UNKNOWN_LEASE_SHAPE"]),
        (lease(NOW, "2026-08-01T11:59:59Z"), LEASE_REASON["UNKNOWN_LEASE_SHAPE"]),
        (lease("2026-08-01T11:00:00Z", NOW), LEASE_REASON["LEASE_EXPIRED"]),
        (lease("2026-08-01T13:00:00Z", "2026-08-01T14:00:00Z"), LEASE_REASON["LEASE_NOT_LIVE"]),
    ],
)
def test_requested_lease_must_be_well_formed_and_live_at_now(lease_value, reason):
    result = request_claim([], claim_request(lease_value=lease_value))
    assert result["decision"] == CLAIM_DECISION["REFUSED"]
    assert result["reason_codes"] == [reason]


def test_stale_ledger_requires_explicit_expiry_before_reclaim():
    old = grant(now="2026-08-01T10:00:00Z", lease_value=lease("2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z"))
    refused = request_claim(old["claims"], claim_request(paths=["packages/core"]))
    assert refused["reason_codes"] == [LEASE_REASON["LEASE_EXPIRED"]]
    projection = expire_leases(old["claims"], NOW)
    assert projection["claims"] == []
    assert len(projection["expired"]) == 1
    assert request_claim(projection["claims"], claim_request(paths=["packages/core"]))["decision"] == CLAIM_DECISION["GRANTED"]


def test_future_active_ledger_is_not_live_at_an_earlier_now():
    future = grant(now="2026-08-01T13:00:00Z", lease_value=lease("2026-08-01T13:00:00Z", "2026-08-01T14:00:00Z"))
    result = request_claim(future["claims"], claim_request(paths=["packages/core"]))
    assert result["reason_codes"] == [LEASE_REASON["LEASE_NOT_LIVE"]]


def test_persisted_claim_must_have_been_created_during_its_lease():
    claim = grant(lease_value=lease())["claim"]
    future_lease = lease("2026-08-01T13:00:00Z", "2026-08-01T14:00:00Z")
    impossible = {**claim, "lease": future_lease}
    impossible["claim_id"] = deterministic_id(
        "claim",
        {
            "scope": impossible["scope"],
            "actor": impossible["actor"],
            "authority_class": impossible["authority_class"],
            "lease": impossible["lease"],
            "created_at": impossible["created_at"],
        },
    )
    result = request_claim(
        [impossible],
        claim_request(paths=["packages/core"]),
    )
    assert result["reason_codes"] == [CLAIM_REASON["UNKNOWN_CLAIM_SHAPE"]]


def test_lease_expiry_boundary_is_exclusive():
    active = grant(lease_value=lease())
    expired = expire_leases(active["claims"], EXPIRES_AT)
    assert expired["claims"] == []
    assert expired["expired"][0]["reason_codes"] == [LEASE_REASON["LEASE_EXPIRED"]]


def test_release_requires_exact_holder_and_preserves_input():
    granted = grant()
    before = copy.deepcopy(granted["claims"])
    refused = release_claim(granted["claims"], granted["claim"]["claim_id"], OTHER_AGENT)
    assert refused["reason_codes"] == [CLAIM_REASON["NOT_CLAIM_HOLDER"]]
    assert granted["claims"] == before
    released = release_claim(granted["claims"], granted["claim"]["claim_id"], AGENT)
    assert released == {"decision": CLAIM_DECISION["RELEASED"], "reason_codes": [], "claims": []}


def test_released_scope_can_be_regranted_with_a_new_identity():
    first = grant()
    released = release_claim(first["claims"], first["claim"]["claim_id"], AGENT)
    second = request_claim(released["claims"], claim_request(now="2026-08-01T12:00:01Z"))
    assert second["decision"] == CLAIM_DECISION["GRANTED"]
    assert second["claim"]["claim_id"] != first["claim"]["claim_id"]


def test_owner_authority_is_granted_only_to_humans():
    assert grant(actor=HUMAN, authority_class=AUTHORITY_CLASS["OWNER"])["claim"]["authority_class"] == "owner"
    refused = request_claim([], claim_request(actor=AGENT, authority_class=AUTHORITY_CLASS["OWNER"]))
    assert refused["reason_codes"] == [CLAIM_REASON["WORKERS_CANNOT_OWN"]]


def test_claim_scope_and_actor_bounds_fail_closed():
    oversized_scope = request_claim([], claim_request(paths=["x" * 4097]))
    assert oversized_scope["reason_codes"] == [CLAIM_REASON["UNKNOWN_REQUEST_SHAPE"]]
    unknown_actor_field = request_claim([], claim_request(actor={**AGENT, "role": "owner"}))
    assert unknown_actor_field["reason_codes"] == [CLAIM_REASON["UNKNOWN_ACTOR_SHAPE"]]


# Dependency projection

def test_dependencies_report_ready_blocked_and_missing_without_adapter_policy():
    blocked_tasks = [{"id": "a", "status": "open"}, {"id": "b", "status": "open", "depends_on": ["a"]}]
    blocked = evaluate_dependencies(blocked_tasks, "b")
    assert blocked == {"decision": "blocked", "reason_codes": [DEPENDENCY_REASON["DEPENDENCY_NOT_SATISFIED"]], "unmet": ["a"], "cycle": []}
    ready_tasks = [{"id": "a", "status": "done"}, {"id": "b", "status": "open", "depends_on": ["a"]}]
    assert evaluate_dependencies(ready_tasks, "b") == {"decision": "ready", "reason_codes": [], "unmet": [], "cycle": []}
    assert evaluate_dependencies(ready_tasks, "missing")["reason_codes"] == [DEPENDENCY_REASON["UNKNOWN_TASK"]]


def test_dependency_cycle_is_a_typed_core_blocked_decision():
    tasks = [{"id": "a", "status": "open", "depends_on": ["b"]}, {"id": "b", "status": "open", "depends_on": ["a"]}]
    result = evaluate_dependencies(tasks, "a")
    assert result["decision"] == DEPENDENCY_DECISION["BLOCKED"]
    assert result["reason_codes"] == [DEPENDENCY_REASON["DEPENDENCY_CYCLE"]]
    assert result["cycle"] == ["a", "b", "a"]


@pytest.mark.parametrize("tasks", [None, {}, [{"id": "a", "status": "open"}, {"id": "a", "status": "done"}], [{"id": "a", "status": "open", "depends_on": "b"}]])
def test_malformed_dependency_graph_fails_closed(tasks):
    assert evaluate_dependencies(tasks, "a")["reason_codes"] == [DEPENDENCY_REASON["UNKNOWN_TASK"]]


def test_dependency_task_count_is_bounded():
    tasks = [{"id": f"t{index}", "status": "open"} for index in range(10_001)]
    assert evaluate_dependencies(tasks, "t0")["reason_codes"] == [DEPENDENCY_REASON["WORK_UNBOUNDED"]]


def test_dependency_edge_count_is_bounded_before_edge_validation():
    tasks = [
        {
            "id": "a",
            "status": "open",
            "depends_on": ["missing"] * 100_001,
        }
    ]
    assert evaluate_dependencies(tasks, "a")["reason_codes"] == [
        DEPENDENCY_REASON["WORK_UNBOUNDED"]
    ]


# Handoffs bind live authority and exact evidence

def handoff_args(capsule, receipt, claim_result, **overrides):
    values = {
        "active_claims": claim_result["claims"],
        "claim_id": claim_result["claim"]["claim_id"],
        "receipt": receipt,
        "capsule": capsule,
        "from_actor": AGENT,
        "to_actor": OTHER_AGENT,
        "workspace_revision": capsule["workspace"]["fingerprint"],
        "created_at": HANDOFF_AT,
    }
    values.update(overrides)
    return values


def test_handoff_binds_live_claim_scope_actors_lease_and_evidence_without_transferring(capsule, receipt):
    claimed = grant(lease_value=lease())
    before = copy.deepcopy(claimed["claims"])
    result = create_handoff(**handoff_args(capsule, receipt, claimed))
    assert result["decision"] == HANDOFF_DECISION["BOUND"]
    handoff = result["handoff"]
    assert handoff["claim_id"] == claimed["claim"]["claim_id"]
    assert handoff["claim_created_at"] == NOW
    assert handoff["scope"] == claimed["claim"]["scope"]
    assert handoff["holder"] == handoff["from_actor"] == AGENT
    assert handoff["to_actor"] == OTHER_AGENT
    assert handoff["lease"] == lease()
    assert handoff["capsule"] == {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]}
    assert handoff["receipt"]["id"] == receipt["receipt_id"]
    assert "claims" not in result
    assert claimed["claims"] == before


def test_handoff_requires_existing_exact_holder_and_valid_ledger(capsule, receipt):
    claimed = grant(lease_value=lease())
    missing = create_handoff(**handoff_args(capsule, receipt, claimed, claim_id="claim_missing"))
    assert missing["reason_codes"] == [HANDOFF_REASON["CLAIM_NOT_FOUND"]]
    wrong_holder = create_handoff(**handoff_args(capsule, receipt, claimed, from_actor=OTHER_AGENT))
    assert wrong_holder["reason_codes"] == [HANDOFF_REASON["NOT_CLAIM_HOLDER"]]


def test_handoff_refuses_expired_or_not_yet_live_claim(capsule, receipt):
    claimed = grant(lease_value=lease())
    expired = create_handoff(**handoff_args(capsule, receipt, claimed, created_at=EXPIRES_AT))
    assert expired["reason_codes"] == [HANDOFF_REASON["LEASE_EXPIRED"]]
    future = grant(now="2026-08-01T12:20:00Z")
    not_live = create_handoff(**handoff_args(capsule, receipt, future, created_at=HANDOFF_AT))
    assert not_live["reason_codes"] == [HANDOFF_REASON["LEASE_NOT_LIVE"]]


def test_handoff_receipt_must_be_causally_within_claim_and_handoff(capsule):
    claimed = grant(lease_value=lease())
    earlier_receipt = receipt_for(capsule, created_at="2026-08-01T11:59:59Z")
    predates = create_handoff(**handoff_args(capsule, earlier_receipt, claimed))
    assert predates["reason_codes"] == [HANDOFF_REASON["RECEIPT_PREDATES_CLAIM"]]
    later_receipt = receipt_for(capsule, created_at="2026-08-01T12:20:00Z")
    later = create_handoff(**handoff_args(capsule, later_receipt, claimed))
    assert later["reason_codes"] == [HANDOFF_REASON["RECEIPT_CREATED_AFTER_HANDOFF"]]


def test_handoff_receipt_runtime_actor_must_be_claim_holder(capsule):
    claimed = grant(lease_value=lease())
    other_receipt = receipt_for(capsule, actor=OTHER_AGENT["id"])
    result = create_handoff(**handoff_args(capsule, other_receipt, claimed))
    assert result["reason_codes"] == [HANDOFF_REASON["RECEIPT_ACTOR_MISMATCH"]]


def test_handoff_requires_complete_capsule_authorized_receipt_and_workspace(capsule, receipt):
    claimed = grant(lease_value=lease())
    malformed_args = handoff_args(capsule, receipt, claimed)
    malformed_args["capsule"] = {"schema": "vivary.task-capsule/v0"}
    malformed = create_handoff(**malformed_args)
    assert malformed["reason_codes"] == [HANDOFF_REASON["UNKNOWN_CAPSULE_SHAPE"]]
    tampered_receipt = {**receipt, "receipt_id": "receipt_forged"}
    invalid_receipt = create_handoff(**handoff_args(capsule, tampered_receipt, claimed))
    assert invalid_receipt["reason_codes"] == [HANDOFF_REASON["UNKNOWN_RECEIPT_SHAPE"]]
    wrong_workspace = create_handoff(**handoff_args(capsule, receipt, claimed, workspace_revision="sha256:other"))
    assert wrong_workspace["reason_codes"] == [HANDOFF_REASON["WORKSPACE_REVISION_MISMATCH"]]


def test_handoff_cannot_transfer_owner_authority_to_nonhuman(capsule, receipt):
    claimed = grant(lease_value=lease())
    result = create_handoff(**handoff_args(capsule, receipt, claimed, to_authority_class=AUTHORITY_CLASS["OWNER"]))
    assert result["reason_codes"] == [HANDOFF_REASON["WORKERS_CANNOT_OWN"]]


# Execution evidence is exact, append-only, and conflict-visible

def test_execution_derivation_requires_exact_capsule_and_authorized_receipt(capsule, receipt):
    result = derive_execution_edges(receipt, capsule)
    assert result["reason_codes"] == []
    assert len(result["edges"]) == len(receipt["checks"])
    assert all(edge["capsule_id"] == capsule["capsule_id"] and edge["receipt_id"] == receipt["receipt_id"] for edge in result["edges"])
    assert derive_execution_edges(receipt, {"schema": "vivary.task-capsule/v0"})["reason_codes"] == [EXECUTION_REASON["UNKNOWN_CAPSULE_SHAPE"]]
    assert derive_execution_edges({**receipt, "receipt_id": "receipt_forged"}, capsule)["reason_codes"] == [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]


def test_record_execution_is_idempotent_and_does_not_mutate_input(capsule, receipt):
    original_log = []
    first = record_execution(original_log, receipt, capsule)
    assert original_log == []
    assert first["edges"] == first["added"]
    replay = record_execution(first["edges"], receipt, capsule)
    assert replay == {"edges": first["edges"], "added": [], "reason_codes": []}


def test_record_execution_refuses_same_id_conflicting_evidence_atomically(capsule, receipt):
    first = record_execution([], receipt, capsule)
    conflicting = {**first["edges"][0], "outcome": "passed" if first["edges"][0]["outcome"] == "failed" else "failed"}
    before = [conflicting]
    result = record_execution(before, receipt, capsule)
    assert result == {"edges": before, "added": [], "reason_codes": [EXECUTION_REASON["EDGE_IDENTITY_CONFLICT"]]}
    assert before == [conflicting]


def test_execution_replay_uses_canonical_equality_not_python_bool_number_equality(capsule):
    checks = [
        {
            "name": check["name"],
            "command": check["command"],
            "outcome": "passed",
            "detail": 1,
        }
        for check in capsule["required_checks"]
    ]
    numeric_receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "core-control-test", "actor": AGENT["id"]},
        checks=checks,
        now=lambda: RUN_AT,
    )
    first = record_execution([], numeric_receipt, capsule)
    conflicting = {**first["edges"][0], "detail": True}
    result = record_execution([conflicting], numeric_receipt, capsule)
    assert result["reason_codes"] == [
        EXECUTION_REASON["EDGE_IDENTITY_CONFLICT"]
    ]
    assert result["edges"] == [conflicting]


def test_record_execution_validates_existing_log_before_evidence(capsule, receipt):
    malformed = record_execution([{}], receipt, capsule)
    assert malformed["reason_codes"] == [EXECUTION_REASON["UNKNOWN_EXECUTION_LOG_SHAPE"]]
    recorded = record_execution([], receipt, capsule)
    invalid_receipt = record_execution(recorded["edges"], {**receipt, "receipt_id": "forged"}, capsule)
    assert invalid_receipt == {"edges": recorded["edges"], "added": [], "reason_codes": [EXECUTION_REASON["UNKNOWN_RECEIPT_SHAPE"]]}


def test_execution_log_size_is_bounded(capsule, receipt):
    edge = record_execution([], receipt, capsule)["edges"][0]
    result = record_execution([edge] * 10_001, receipt, capsule)
    assert result["reason_codes"] == [EXECUTION_REASON["WORK_UNBOUNDED"]]


def test_execution_receipt_check_count_is_bounded_before_verification(capsule, receipt):
    oversized_receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "core-control-test", "actor": AGENT["id"]},
        checks=[receipt["checks"][0]] * 10_001,
        now=lambda: RUN_AT,
    )
    assert verify_receipt_integrity(
        receipt=oversized_receipt,
        capsule=capsule,
    )["outcome"] == "verified"
    result = derive_execution_edges(oversized_receipt, capsule)
    assert result["reason_codes"] == [EXECUTION_REASON["WORK_UNBOUNDED"]]


# Task completion cannot erase failure evidence

def test_mark_done_and_integrity_view_are_typed(capsule, receipt):
    task = {"task_id": "task-204", "capsule_id": capsule["capsule_id"], "status": "in_progress"}
    execution = record_execution([], receipt, capsule)
    transition = mark_task_done(task=task)
    assert transition == {"task": {**task, "status": "done"}, "reason_codes": []}
    view = task_integrity_view(task=transition["task"], execution_log=execution["edges"])
    assert view["status"] == "done"
    assert view["has_failed_verification"] is True
    assert view["failed_edges"]
    assert view["reason_codes"] == []


def test_task_functions_fail_closed_on_malformed_task_or_log(capsule):
    assert mark_task_done(task={}) == {"task": None, "reason_codes": [TASK_REASON["UNKNOWN_TASK_SHAPE"]]}
    task = {"task_id": "task-204", "capsule_id": capsule["capsule_id"], "status": "open"}
    view = task_integrity_view(task=task, execution_log=[{}])
    assert view["reason_codes"] == [EXECUTION_REASON["UNKNOWN_EXECUTION_LOG_SHAPE"]]
    assert view["execution_edges"] == []


def test_mark_task_done_has_no_execution_log_parameter():
    assert list(inspect.signature(mark_task_done).parameters) == ["task"]


def test_gate_reference_is_recorded_without_re_evaluation():
    task = {"task_id": "task-204", "capsule_id": "capsule", "status": "open"}
    gate = {"decision": "clear", "reason_codes": []}
    assert with_gate_reference(task=task, gate_result=gate) == {"task": {**task, "gate_ref": gate}, "reason_codes": []}
    refused = with_gate_reference(task=task, gate_result={})
    assert refused == {"task": task, "reason_codes": [GATE_REFERENCE_REASON["UNKNOWN_GATE_SHAPE"]]}
