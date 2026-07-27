"""Translation of tests/policy.test.mjs (graduation slice 3, decision 0008)
for the Python port (python/vivary_core/policy_budget.py, policy_gates.py,
policy_loop.py, policy_reason_codes.py).

Node's policy.test.mjs builds its `realGraph`/`realCapsule` fixtures via a
`before()` hook that calls observeCheckouts (src/workspace/observe.mjs) and
projectWorkspaceGraph (src/workspace/model.mjs) over real disposable git
repositories built by tests/helpers/fixtures.mjs (buildFixtures). Those
Python ports (workspace_observe.py / workspace_model.py) already live in
python/vivary_core/, so this file builds the same real git fixtures - pinned
identity/date, isolated global/system config - as a module-scoped pytest
fixture and runs the pipeline for real, mirroring python/tests/test_capsule.py's
precedent of self-contained per-file fixture plumbing (its `build_fixtures`
is copied here verbatim rather than factored into a shared helper module,
matching that same precedent) rather than a shared fixtures module.

ADAPTATION - the Ozone gate-verdict seam (#13): several Node tests build a
real verdict via `evaluateGateSufficiency` (src/verify/sufficiency.mjs).
That module is not part of this slice (not in the owned-files list, and not
one of the already-ported "capsule_compile, receipt, workspace_*" modules
this task's rules call out as importable). Rather than port the whole Ozone
sufficiency module speculatively, `_ozone_verdict_stub` emits the bound verdict
fields Strato consumes: `capsule`, `receipt_id`, `outcome`, `reason_codes`, and
`failing_checks`. It mirrors Ozone's missing/failed check classification while
leaving Strato's independently derived receipt checks observable as a baseline
that a valid Ozone verdict can only augment.
"""

from __future__ import annotations

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

from vivary_core.capsule_compile import (  # noqa: E402
    CAPSULE_SCHEMA,
    compile_task_capsule,
)
from vivary_core.receipt import RECEIPT_SCHEMA, create_integrity_receipt  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402
from vivary_core.workspace_observe import observe_checkouts  # noqa: E402

from vivary_core.policy_budget import BUDGET_DECISION, BUDGET_REASON, evaluate_budget  # noqa: E402
from vivary_core.policy_gates import (  # noqa: E402
    GATE_DECISION,
    GATE_REASON,
    evaluate_capsule_gate,
    evaluate_receipt_gate,
)
from vivary_core.policy_loop import LOOP_DECISION, LOOP_REASON, next_loop_step  # noqa: E402

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP_EPOCH = 1782000000.0  # 2026-07-02T00:00:00Z


def NOW():
    return "2026-07-20T15:00:00.000Z"


TASK = {"question": "Which local checkout of the shared origin reflects current repository truth?"}
SYNTHETIC_REQUIRED_CHECKS = [
    {"name": "unit-and-contract-tests", "command": "python -m pytest"},
    {"name": "vivary-graph-doctor", "command": "create-vivary doctor . --json"},
]


# -- fixture plumbing (mirrors tests/helpers/fixtures.mjs / test_capsule.py's copy) --


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

    _git(base_dir, base_dir, ["init", "-q", "--bare", "-b", "main", paths["origin"]])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["canonical"]])
    _commit_file(base_dir, paths["canonical"], "README.md", "# canonical\n", "commit A")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["staleNeighbor"]])
    commit_b = _commit_file(base_dir, paths["canonical"], "NOTES.md", "commit B content\n", "commit B")
    _git(base_dir, paths["canonical"], ["push", "-q", "origin", "main"])

    canonical_fetch_head = os.path.join(paths["canonical"], ".git", "FETCH_HEAD")
    _write(canonical_fetch_head, f"{commit_b}\t\tbranch 'main' of {paths['origin']}\n")
    os.utime(canonical_fetch_head, (FETCH_STAMP_EPOCH, FETCH_STAMP_EPOCH))
    stale_fetch_head = os.path.join(paths["staleNeighbor"], ".git", "FETCH_HEAD")
    if os.path.exists(stale_fetch_head):
        os.remove(stale_fetch_head)

    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["dirty"]])
    _write(os.path.join(paths["dirty"], ".gitignore"), "secrets/\n")
    _git(base_dir, paths["dirty"], ["add", ".gitignore"])
    _commit_file(base_dir, paths["dirty"], "tracked.md", "original\n", "dirty base")
    _write(os.path.join(paths["dirty"], "tracked.md"), "modified\n")
    _write(os.path.join(paths["dirty"], "untracked.md"), "untracked\n")
    os.makedirs(os.path.join(paths["dirty"], "secrets"), exist_ok=True)
    _write(os.path.join(paths["dirty"], "secrets", "private-note.md"), "PRIVATE_FIXTURE_MARKER\n")

    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["noOrigin"]])
    _commit_file(base_dir, paths["noOrigin"], "solo.md", "solo\n", "solo")

    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["disallowed"]])
    _commit_file(base_dir, paths["disallowed"], "nope.md", "nope\n", "disallowed")

    return {"paths": paths}


@pytest.fixture(scope="module")
def fx():
    base_dir = tempfile.mkdtemp(prefix="vivary-policy-fixtures-")
    try:
        yield build_fixtures(base_dir)
    finally:
        _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def real_graph(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"], p["disallowed"]],
        allowlist=allowlist,
        now=NOW,
    )
    return project_workspace_graph(observation)


def real_capsule(real_graph, budget=None):
    kwargs = {"budget": budget} if budget else {}
    return compile_task_capsule(task=TASK, graph=real_graph, **kwargs)


# -- a fully known, single-checkout synthetic observation -----------------------------
# Hand-built (not from git) so it is guaranteed conflict-free and unknown-free: every
# fact is marked "known". This still runs through the real workspace_model.py/
# capsule_compile.py seam; only the observation layer (normally the sole impure module)
# is faked here, and the path is a synthetic label, never a real machine path.


def _known(value, command):
    return {"status": "known", "value": value, "evidence": {"command": command}}


def build_clean_capsule():
    checkout = {
        "raw_path": "synthetic-clean/repo",
        "path": "synthetic-clean/repo",
        "status": "observed",
        "facts": {
            "is_git_repository": _known(True, "git rev-parse --show-toplevel"),
            "worktree_root": _known("synthetic-clean/repo", "git rev-parse --show-toplevel"),
            "head_revision": _known("0" * 40, "git rev-parse HEAD"),
            "head_ref": _known({"kind": "branch", "name": "main"}, "git symbolic-ref --short -q HEAD"),
            "dirty_entries": _known([], "git status --porcelain"),
            "is_dirty": _known(False, "git status --porcelain"),
            "remotes": _known(
                [{"name": "origin", "fetch_url": "https://example.test/synthetic-clean.git"}], "git remote -v"
            ),
            "upstream": _known("origin/main", "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"),
            "last_fetch": _known("2026-07-01T00:00:00.000Z", "fs.stat FETCH_HEAD"),
            "workspace_markers": _known(["tropo.toml"], "fs.stat workspace markers"),
        },
    }
    observation = {
        "schema": "vivary.workspace-observation/v0",
        "observed_at": NOW(),
        "allowlist": ["synthetic-clean/repo"],
        "checkouts": [checkout],
        "refusals": [],
    }
    graph = project_workspace_graph(observation)
    return compile_task_capsule(task={"question": "Is the synthetic checkout clean?"}, graph=graph)


# -- minimal hand-built capsule/receipt shapes for isolating one reason code at a time -


def base_capsule_like(overrides=None):
    capsule = {
        "schema": CAPSULE_SCHEMA,
        "capsule_id": "capsule_test0000",
        "fingerprint": "sha256:test-capsule",
        "task": {"question": "test"},
        "workspace": {"fingerprint": "sha256:test-workspace", "observed_at": NOW()},
        "claims": [],
        "conflicts": [],
        "unknowns": [],
        "omissions": [],
        "required_checks": SYNTHETIC_REQUIRED_CHECKS,
        "budget": {"max_claims": 24},
    }
    capsule.update(overrides or {})
    return capsule


def base_receipt_like(capsule, overrides=None):
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "receipt_id": "receipt_test0000",
        "fingerprint": "sha256:test-receipt",
        "capsule": {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]},
        "workspace": capsule["workspace"],
        "runtime": {"harness": "test", "actor": "test-actor"},
        "checks": [{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        "claims_in_scope": [],
        "claims_verified": [],
        "claims_unverified": [],
        "unresolved_conflicts": [],
        "unresolved_unknowns": [],
        "provenance": [],
        "created_at": NOW(),
    }
    receipt.update(overrides or {})
    return receipt


# -- ADAPTATION: scoped Ozone gate-verdict stub (see module docstring) ----------------


def _bound_verdict(*, capsule, receipt, **fields):
    return {
        **fields,
        "capsule": {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]},
        "receipt_id": receipt["receipt_id"],
    }


def _ozone_verdict_stub(*, capsule, receipt, required_checks):
    outcome_by_name = {c["name"]: c.get("outcome") for c in receipt.get("checks", [])}
    failing_checks = []
    reason_codes = []
    for name in required_checks:
        if name not in outcome_by_name:
            failing_checks.append({"name": name, "expected": "passed", "actual": "missing"})
            reason_codes.append("required_check_missing")
        elif outcome_by_name[name] != "passed":
            failing_checks.append({"name": name, "expected": "passed", "actual": outcome_by_name[name]})
            reason_codes.append("required_check_failed")
    return _bound_verdict(
        capsule=capsule,
        receipt=receipt,
        outcome="insufficient" if failing_checks else "sufficient",
        reason_codes=list(dict.fromkeys(reason_codes)),
        failing_checks=failing_checks,
    )


# -- reason-code vocabulary is pinned -------------------------------------------------


def test_budget_reason_code_vocabulary_is_pinned():
    assert dict(BUDGET_DECISION) == {
        "WITHIN_BUDGET": "within_budget",
        "EXHAUSTED": "budget_exhausted",
        "REFUSED": "refused",
    }
    assert dict(BUDGET_REASON) == {
        "TURN_BUDGET_EXCEEDED": "turn_budget_exceeded",
        "ACTION_BUDGET_EXCEEDED": "action_budget_exceeded",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
    }
    with pytest.raises(TypeError):
        BUDGET_DECISION["WITHIN_BUDGET"] = "nope"
    with pytest.raises(TypeError):
        BUDGET_REASON["TURN_BUDGET_EXCEEDED"] = "nope"


def test_gate_reason_code_vocabulary_is_pinned():
    assert dict(GATE_DECISION) == {"CLEAR": "clear", "GATE_REQUIRED": "gate_required", "BLOCKED": "blocked"}
    assert dict(GATE_REASON) == {
        "UNRESOLVED_CONFLICT": "unresolved_conflict",
        "UNRESOLVED_UNKNOWN": "unresolved_unknown",
        "CLAIM_MISSING_EVIDENCE": "claim_missing_evidence",
        "CAPSULE_OVER_BUDGET": "capsule_over_budget",
        "REQUIRED_CHECK_MISSING": "required_check_missing",
        "REQUIRED_CHECK_FAILED": "required_check_failed",
        "RECEIPT_CAPSULE_MISMATCH": "receipt_capsule_mismatch",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
        "UNKNOWN_RECEIPT_SHAPE": "unknown_receipt_shape",
        "VERDICT_INSUFFICIENT": "verdict_insufficient",
        "VERDICT_BINDING_MISMATCH": "verdict_binding_mismatch",
    }
    with pytest.raises(TypeError):
        GATE_DECISION["CLEAR"] = "nope"
    with pytest.raises(TypeError):
        GATE_REASON["UNRESOLVED_CONFLICT"] = "nope"


def test_loop_reason_code_vocabulary_is_pinned():
    assert dict(LOOP_DECISION) == {"ACT": "act", "REQUEST_GATE": "request_gate", "STOP": "stop", "BLOCKED": "blocked"}
    assert dict(LOOP_REASON) == {
        "BUDGET_EXHAUSTED": "budget_exhausted",
        "GATE_REQUIRED": "gate_required",
        "BLOCKED_BY_GATE": "blocked_by_gate",
        "ALL_CHECKS_CLEAR": "all_checks_clear",
        "UNKNOWN_CAPSULE_SHAPE": "unknown_capsule_shape",
    }
    with pytest.raises(TypeError):
        LOOP_DECISION["ACT"] = "nope"
    with pytest.raises(TypeError):
        LOOP_REASON["BUDGET_EXHAUSTED"] = "nope"


# -- policy_budget.py -------------------------------------------------------------------

def test_evaluate_budget_within_budget_when_no_limit_is_exceeded():
    capsule = build_clean_capsule()
    outcome = evaluate_budget(
        capsule=capsule, state={"turns_used": 1, "actions_used": 2}, limits={"max_turns": 5, "max_actions": 5}
    )
    assert outcome == {"decision": BUDGET_DECISION["WITHIN_BUDGET"], "reason_codes": [], "details": {}}


def test_evaluate_budget_within_budget_with_no_limits_configured_at_all():
    capsule = build_clean_capsule()
    outcome = evaluate_budget(capsule=capsule)
    assert outcome == {"decision": BUDGET_DECISION["WITHIN_BUDGET"], "reason_codes": [], "details": {}}


def test_evaluate_budget_turn_budget_exceeded():
    capsule = build_clean_capsule()
    outcome = evaluate_budget(capsule=capsule, state={"turns_used": 3}, limits={"max_turns": 3})
    assert outcome["decision"] == BUDGET_DECISION["EXHAUSTED"]
    assert outcome["reason_codes"] == [BUDGET_REASON["TURN_BUDGET_EXCEEDED"]]
    assert outcome["details"]["turns"] == {"used": 3, "max": 3}


def test_evaluate_budget_action_budget_exceeded():
    capsule = build_clean_capsule()
    outcome = evaluate_budget(capsule=capsule, state={"actions_used": 10}, limits={"max_actions": 10})
    assert outcome["decision"] == BUDGET_DECISION["EXHAUSTED"]
    assert outcome["reason_codes"] == [BUDGET_REASON["ACTION_BUDGET_EXCEEDED"]]


def test_evaluate_budget_both_turn_and_action_budgets_can_be_exceeded_together():
    capsule = build_clean_capsule()
    outcome = evaluate_budget(
        capsule=capsule, state={"turns_used": 4, "actions_used": 4}, limits={"max_turns": 2, "max_actions": 2}
    )
    assert outcome["reason_codes"] == [BUDGET_REASON["TURN_BUDGET_EXCEEDED"], BUDGET_REASON["ACTION_BUDGET_EXCEEDED"]]


@pytest.mark.parametrize(
    ("state", "limits", "reason", "details"),
    [
        (
            {"turns_used": 999},
            {"max_turns": float("nan")},
            BUDGET_REASON["TURN_BUDGET_EXCEEDED"],
            {"turns": {"used": 999, "max": None}},
        ),
        (
            {"turns_used": "3"},
            {"max_turns": 5},
            BUDGET_REASON["TURN_BUDGET_EXCEEDED"],
            {"turns": {"used": None, "max": 5}},
        ),
        (
            {"turns_used": 3},
            {"max_turns": "5"},
            BUDGET_REASON["TURN_BUDGET_EXCEEDED"],
            {"turns": {"used": 3, "max": None}},
        ),
        (
            {"actions_used": 3},
            {"max_actions": float("inf")},
            BUDGET_REASON["ACTION_BUDGET_EXCEEDED"],
            {"actions": {"used": 3, "max": None}},
        ),
        (
            {"actions_used": True},
            {"max_actions": 5},
            BUDGET_REASON["ACTION_BUDGET_EXCEEDED"],
            {"actions": {"used": None, "max": 5}},
        ),
    ],
)
def test_evaluate_budget_fails_closed_on_present_malformed_limits_or_counters(state, limits, reason, details):
    capsule = build_clean_capsule()
    outcome = evaluate_budget(capsule=capsule, state=state, limits=limits)

    assert outcome["decision"] == BUDGET_DECISION["EXHAUSTED"]
    assert outcome["reason_codes"] == [reason]
    assert outcome["details"] == details
    assert evaluate_budget(capsule=capsule, state=state, limits=limits) == outcome
    loop_outcome = next_loop_step(capsule=capsule, state=state, limits=limits)
    assert loop_outcome["decision"] == LOOP_DECISION["STOP"]
    assert loop_outcome["budget"] == outcome

def test_evaluate_budget_fails_closed_on_an_unrecognized_capsule_shape():
    for bad in [None, {}, {"schema": "not-a-capsule"}, {"capsule_id": "x"}]:
        outcome = evaluate_budget(capsule=bad)
        assert outcome == {
            "decision": BUDGET_DECISION["REFUSED"],
            "reason_codes": [BUDGET_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "details": {},
        }


# -- policy_gates.py: evaluate_capsule_gate -----------------------------------------------

def test_evaluate_capsule_gate_clear_on_a_fully_known_conflict_free_capsule():
    capsule = build_clean_capsule()
    outcome = evaluate_capsule_gate(capsule=capsule)
    assert outcome == {"decision": GATE_DECISION["CLEAR"], "reason_codes": [], "gate_requests": []}


def test_evaluate_capsule_gate_gate_required_on_unresolved_conflicts_and_unknowns_real_fixture(real_graph):
    capsule = real_capsule(real_graph)
    outcome = evaluate_capsule_gate(capsule=capsule)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["UNRESOLVED_CONFLICT"] in outcome["reason_codes"]
    assert GATE_REASON["UNRESOLVED_UNKNOWN"] in outcome["reason_codes"]
    conflict_request = next(r for r in outcome["gate_requests"] if r["reason_code"] == GATE_REASON["UNRESOLVED_CONFLICT"])
    assert conflict_request["target"] == capsule["conflicts"][0]["id"]


def test_evaluate_capsule_gate_gate_required_when_the_capsule_blew_its_claim_budget_real_fixture(real_graph):
    capsule = real_capsule(real_graph, budget={"max_claims": 5})
    outcome = evaluate_capsule_gate(capsule=capsule)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["CAPSULE_OVER_BUDGET"] in outcome["reason_codes"]
    request = next(r for r in outcome["gate_requests"] if r["reason_code"] == GATE_REASON["CAPSULE_OVER_BUDGET"])
    assert request["omitted_count"] > 0


def test_evaluate_capsule_gate_gate_required_when_a_claim_carries_no_evidence():
    capsule = base_capsule_like(
        {"claims": [{"id": "claim_no_evidence", "subject": "s", "fact": "f", "claim": "c", "status": "known", "evidence": []}]}
    )
    outcome = evaluate_capsule_gate(capsule=capsule)
    assert outcome == {
        "decision": GATE_DECISION["GATE_REQUIRED"],
        "reason_codes": [GATE_REASON["CLAIM_MISSING_EVIDENCE"]],
        "gate_requests": [{"reason_code": GATE_REASON["CLAIM_MISSING_EVIDENCE"], "target": "claim_no_evidence"}],
    }


def test_evaluate_capsule_gate_fails_closed_on_an_unrecognized_capsule_shape():
    for bad in [None, {}, {"schema": CAPSULE_SCHEMA}]:
        outcome = evaluate_capsule_gate(capsule=bad)
        assert outcome == {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "gate_requests": [],
        }


def test_evaluate_capsule_gate_never_echoes_a_checkout_path_only_ids_and_counts(real_graph):
    import json

    capsule = real_capsule(real_graph, budget={"max_claims": 5})
    outcome = evaluate_capsule_gate(capsule=capsule)
    serialized = json.dumps(outcome)
    assert not re.search(r"[a-zA-Z]:[\\/]", serialized), "gate outcome must not carry a machine path"
    assert "private-note" not in serialized
    assert "secrets" not in serialized


# -- policy_gates.py: evaluate_receipt_gate ------------------------------------------------

def test_evaluate_receipt_gate_clear_when_all_required_checks_passed_and_nothing_is_unresolved():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        now=NOW,
    )
    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)
    assert outcome == {"decision": GATE_DECISION["CLEAR"], "reason_codes": [], "gate_requests": []}


def test_evaluate_receipt_gate_gate_required_when_a_required_check_is_missing():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"][1:]
        ],
        now=NOW,
    )
    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["REQUIRED_CHECK_MISSING"] in outcome["reason_codes"]
    assert any(
        r["reason_code"] == GATE_REASON["REQUIRED_CHECK_MISSING"] and r["check"] == capsule["required_checks"][0]["name"]
        for r in outcome["gate_requests"]
    )


def test_evaluate_receipt_gate_gate_required_when_a_required_check_failed():
    capsule = build_clean_capsule()
    checks = [
        {"name": c["name"], "command": c["command"], "outcome": "failed" if i == 0 else "passed"}
        for i, c in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )
    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["REQUIRED_CHECK_FAILED"] in outcome["reason_codes"]
    request = next(r for r in outcome["gate_requests"] if r["reason_code"] == GATE_REASON["REQUIRED_CHECK_FAILED"])
    assert request["check"] == capsule["required_checks"][0]["name"]
    assert request["outcome"] == "failed"


# -- gate-seam harmonization: unioning bound Ozone verdict evidence with receipt checks --

def test_evaluate_receipt_gate_given_an_ozone_gate_verdict_unions_its_failing_checks_with_receipt_derivation():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"][1:]
        ],
        now=NOW,
    )
    verdict = _ozone_verdict_stub(
        capsule=capsule, receipt=receipt, required_checks=[c["name"] for c in capsule["required_checks"]]
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["REQUIRED_CHECK_MISSING"] in outcome["reason_codes"]
    assert [
        r["check"] for r in outcome["gate_requests"] if r["reason_code"] == GATE_REASON["REQUIRED_CHECK_MISSING"]
    ] == [capsule["required_checks"][0]["name"]]


def test_evaluate_receipt_gate_an_ozone_verdict_reporting_a_failed_not_missing_check_maps_to_required_check_failed_with_the_actual_outcome():
    capsule = build_clean_capsule()
    checks = [
        {"name": c["name"], "command": c["command"], "outcome": "failed" if i == 0 else "passed"}
        for i, c in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )
    verdict = _ozone_verdict_stub(
        capsule=capsule, receipt=receipt, required_checks=[c["name"] for c in capsule["required_checks"]]
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
    assert GATE_REASON["REQUIRED_CHECK_FAILED"] in outcome["reason_codes"]
    request = next(r for r in outcome["gate_requests"] if r["reason_code"] == GATE_REASON["REQUIRED_CHECK_FAILED"])
    assert request["check"] == capsule["required_checks"][0]["name"]
    assert request["outcome"] == "failed"



def test_evaluate_receipt_gate_preserves_ozone_non_check_reasons_alongside_specific_check_failures():
    capsule = build_clean_capsule()
    checks = [
        {"name": check["name"], "command": check["command"], "outcome": "failed" if index == 0 else "passed"}
        for index, check in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )
    verdict = _bound_verdict(
        capsule=capsule,
        receipt=receipt,
        outcome="insufficient",
        reason_codes=["claims_not_fully_verified"],
        failing_checks=[
            {"name": capsule["required_checks"][0]["name"], "expected": "passed", "actual": "failed"},
        ],
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)

    assert GATE_REASON["REQUIRED_CHECK_FAILED"] in outcome["reason_codes"]
    assert GATE_REASON["VERDICT_INSUFFICIENT"] in outcome["reason_codes"]
    verdict_request = next(
        request for request in outcome["gate_requests"] if request["reason_code"] == GATE_REASON["VERDICT_INSUFFICIENT"]
    )
    assert verdict_request["verdict_reason_codes"] == ["claims_not_fully_verified"]
def test_evaluate_receipt_gate_a_sufficient_ozone_verdict_clears_the_required_checks_portion_of_the_gate():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        now=NOW,
    )
    verdict = _ozone_verdict_stub(
        capsule=capsule, receipt=receipt, required_checks=[c["name"] for c in capsule["required_checks"]]
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
    assert outcome == {"decision": GATE_DECISION["CLEAR"], "reason_codes": [], "gate_requests": []}

def test_evaluate_receipt_gate_honors_an_insufficient_verdict_with_no_failing_checks():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": check["name"], "command": check["command"], "outcome": "passed"}
            for check in capsule["required_checks"]
        ],
        now=NOW,
    )
    verdict = _bound_verdict(
        capsule=capsule,
        receipt=receipt,
        outcome="insufficient",
        reason_codes=["claims_not_fully_verified"],
        failing_checks=[],
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)

    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert outcome["reason_codes"] == [GATE_REASON["VERDICT_INSUFFICIENT"]]
    assert outcome["gate_requests"] == [
        {
            "reason_code": GATE_REASON["VERDICT_INSUFFICIENT"],
            "verdict_outcome": "insufficient",
            "verdict_reason_codes": ["claims_not_fully_verified"],
        }
    ]


def test_evaluate_receipt_gate_rejects_an_unbound_verdict_without_trusting_its_failing_checks():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        now=NOW,
    )
    verdict = {
        "outcome": "insufficient",
        "reason_codes": ["claims_not_fully_verified"],
        "failing_checks": [{"name": capsule["required_checks"][0]["name"], "expected": "passed", "actual": "missing"}],
    }

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)

    assert outcome == {
        "decision": GATE_DECISION["GATE_REQUIRED"],
        "reason_codes": [GATE_REASON["VERDICT_BINDING_MISMATCH"]],
        "gate_requests": [{"reason_code": GATE_REASON["VERDICT_BINDING_MISMATCH"]}],
    }


def test_evaluate_receipt_gate_a_bound_verdict_augments_but_never_weakens_receipt_derived_checks():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"][1:]
        ],
        now=NOW,
    )
    verdict = _ozone_verdict_stub(
        capsule=capsule, receipt=receipt, required_checks=[c["name"] for c in capsule["required_checks"]]
    )
    with_verdict = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
    without_verdict = evaluate_receipt_gate(capsule=capsule, receipt=receipt)

    assert set(without_verdict["reason_codes"]) <= set(with_verdict["reason_codes"])
    assert all(request in with_verdict["gate_requests"] for request in without_verdict["gate_requests"])
    assert GATE_REASON["VERDICT_INSUFFICIENT"] in with_verdict["reason_codes"]


def test_next_loop_step_threads_an_optional_verdict_through_to_evaluate_receipt_gate_unchanged():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"][1:]
        ],
        now=NOW,
    )
    verdict = _ozone_verdict_stub(
        capsule=capsule, receipt=receipt, required_checks=[c["name"] for c in capsule["required_checks"]]
    )

    with_verdict = next_loop_step(capsule=capsule, receipt=receipt, verdict=verdict)
    direct = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
    assert with_verdict["gate"] == direct



def test_evaluate_receipt_gate_derives_required_checks_even_when_a_bound_verdict_claims_sufficient():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[
            {"name": check["name"], "command": check["command"], "outcome": "passed"}
            for check in capsule["required_checks"][1:]
        ],
        now=NOW,
    )
    verdict = _bound_verdict(
        capsule=capsule, receipt=receipt, outcome="sufficient", reason_codes=[], failing_checks=[]
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)

    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["REQUIRED_CHECK_MISSING"] in outcome["reason_codes"]
    assert GATE_REASON["VERDICT_BINDING_MISMATCH"] not in outcome["reason_codes"]


def test_evaluate_receipt_gate_unions_distinct_bound_verdict_failures_with_receipt_failures():
    capsule = build_clean_capsule()
    checks = [
        {"name": check["name"], "command": check["command"], "outcome": "failed" if index == 0 else "passed"}
        for index, check in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )
    verdict = _bound_verdict(
        capsule=capsule,
        receipt=receipt,
        outcome="insufficient",
        reason_codes=["claims_not_fully_verified"],
        failing_checks=[
            {"name": capsule["required_checks"][1]["name"], "expected": "passed", "actual": "missing"},
        ],
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)

    assert any(
        request["reason_code"] == GATE_REASON["REQUIRED_CHECK_FAILED"]
        and request["check"] == capsule["required_checks"][0]["name"]
        for request in outcome["gate_requests"]
    )
    assert any(
        request["reason_code"] == GATE_REASON["REQUIRED_CHECK_MISSING"]
        and request["check"] == capsule["required_checks"][1]["name"]
        for request in outcome["gate_requests"]
    )


def test_evaluate_receipt_gate_rejects_missing_or_mismatched_verdict_bindings():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": check["name"], "command": check["command"], "outcome": "passed"} for check in capsule["required_checks"]],
        now=NOW,
    )
    valid = _bound_verdict(capsule=capsule, receipt=receipt, outcome="sufficient", reason_codes=[], failing_checks=[])
    missing_receipt_id = {key: value for key, value in valid.items() if key != "receipt_id"}
    invalid_verdicts = [
        {**valid, "capsule": {"fingerprint": capsule["fingerprint"]}},
        {**valid, "capsule": {"id": "capsule_other", "fingerprint": capsule["fingerprint"]}},
        {**valid, "capsule": {"id": capsule["capsule_id"], "fingerprint": "sha256:other"}},
        missing_receipt_id,
        {**valid, "receipt_id": "receipt_other"},
    ]

    for verdict in invalid_verdicts:
        outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt, verdict=verdict)
        assert outcome == {
            "decision": GATE_DECISION["GATE_REQUIRED"],
            "reason_codes": [GATE_REASON["VERDICT_BINDING_MISMATCH"]],
            "gate_requests": [{"reason_code": GATE_REASON["VERDICT_BINDING_MISMATCH"]}],
        }


def test_evaluate_receipt_gate_duplicate_matching_checks_cannot_mask_a_failure():
    capsule = build_clean_capsule()
    required = capsule["required_checks"][0]
    checks = [
        {"name": required["name"], "command": required["command"], "outcome": "failed"},
        {"name": required["name"], "command": required["command"], "outcome": "passed"},
        *[
            {"name": check["name"], "command": check["command"], "outcome": "passed"}
            for check in capsule["required_checks"][1:]
        ],
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)

    assert any(
        request["reason_code"] == GATE_REASON["REQUIRED_CHECK_FAILED"]
        and request["check"] == required["name"]
        and request["outcome"] == "failed"
        for request in outcome["gate_requests"]
    )


def test_evaluate_receipt_gate_requires_a_matching_check_command():
    capsule = build_clean_capsule()
    required = capsule["required_checks"][0]
    checks = [
        {"name": required["name"], "command": "not-the-required-command", "outcome": "passed"},
        *[
            {"name": check["name"], "command": check["command"], "outcome": "passed"}
            for check in capsule["required_checks"][1:]
        ],
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)

    assert any(
        request["reason_code"] == GATE_REASON["REQUIRED_CHECK_MISSING"] and request["check"] == required["name"]
        for request in outcome["gate_requests"]
    )
def test_evaluate_receipt_gate_gate_required_when_the_receipt_binds_to_a_different_capsule_fingerprint():
    capsule = build_clean_capsule()
    receipt = base_receipt_like(
        capsule, {"capsule": {"id": capsule["capsule_id"], "fingerprint": "sha256:not-this-capsule"}}
    )
    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)
    assert GATE_REASON["RECEIPT_CAPSULE_MISMATCH"] in outcome["reason_codes"]


def test_evaluate_receipt_gate_all_checks_passing_does_not_clear_unresolved_conflicts_or_unknowns_real_fixture(real_graph):
    capsule = real_capsule(real_graph)
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        now=NOW,
    )
    outcome = evaluate_receipt_gate(capsule=capsule, receipt=receipt)
    assert outcome["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["UNRESOLVED_CONFLICT"] in outcome["reason_codes"]
    assert GATE_REASON["UNRESOLVED_UNKNOWN"] in outcome["reason_codes"]



def test_evaluate_capsule_gate_blocks_malformed_collection_entries_and_required_fields():
    malformed_capsules = [
        {"claims": [None]},
        {"claims": [{"evidence": []}]},
        {"conflicts": [{"id": "conflict"}]},
        {"unknowns": ["unknown"]},
        {"omissions": [{}]},
        {"required_checks": [{"name": "check"}]},
    ]

    for overrides in malformed_capsules:
        outcome = evaluate_capsule_gate(capsule=base_capsule_like(overrides))
        assert outcome == {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]],
            "gate_requests": [],
        }


def test_evaluate_receipt_gate_blocks_malformed_collection_entries_and_required_fields():
    capsule = base_capsule_like()
    malformed_receipts = [
        {"checks": [None]},
        {"checks": [{"name": "check", "outcome": "passed"}]},
        {"unresolved_conflicts": [None]},
        {"unresolved_unknowns": ["unknown"]},
        {"capsule": {"fingerprint": capsule["fingerprint"]}},
        {"receipt_id": ""},
    ]

    for overrides in malformed_receipts:
        outcome = evaluate_receipt_gate(capsule=capsule, receipt=base_receipt_like(capsule, overrides))
        assert outcome == {
            "decision": GATE_DECISION["BLOCKED"],
            "reason_codes": [GATE_REASON["UNKNOWN_RECEIPT_SHAPE"]],
            "gate_requests": [],
        }
def test_evaluate_receipt_gate_fails_closed_on_an_unrecognized_receipt_or_capsule_shape():
    capsule = build_clean_capsule()
    good_receipt = base_receipt_like(capsule)
    assert evaluate_receipt_gate(capsule=capsule, receipt=None) == {
        "decision": GATE_DECISION["BLOCKED"],
        "reason_codes": [GATE_REASON["UNKNOWN_RECEIPT_SHAPE"]],
        "gate_requests": [],
    }
    assert evaluate_receipt_gate(capsule=capsule, receipt={"schema": RECEIPT_SCHEMA}) == {
        "decision": GATE_DECISION["BLOCKED"],
        "reason_codes": [GATE_REASON["UNKNOWN_RECEIPT_SHAPE"]],
        "gate_requests": [],
    }
    assert evaluate_receipt_gate(capsule={}, receipt=good_receipt) == {
        "decision": GATE_DECISION["BLOCKED"],
        "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]],
        "gate_requests": [],
    }


# -- policy_loop.py -----------------------------------------------------------------------

def test_next_loop_step_act_on_a_clean_capsule_with_no_receipt_and_budget_available():
    capsule = build_clean_capsule()
    outcome = next_loop_step(capsule=capsule, state={"turns_used": 0}, limits={"max_turns": 5})
    assert outcome["decision"] == LOOP_DECISION["ACT"]
    assert outcome["reason_codes"] == []
    assert outcome["budget"]["decision"] == BUDGET_DECISION["WITHIN_BUDGET"]
    assert outcome["gate"]["decision"] == GATE_DECISION["CLEAR"]


def test_next_loop_step_request_gate_before_acting_when_the_capsule_itself_needs_review_real_fixture(real_graph):
    capsule = real_capsule(real_graph)
    outcome = next_loop_step(capsule=capsule)
    assert outcome["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert outcome["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]


def test_next_loop_step_stop_when_the_turn_budget_is_exhausted_even_on_a_clean_capsule():
    capsule = build_clean_capsule()
    outcome = next_loop_step(capsule=capsule, state={"turns_used": 5}, limits={"max_turns": 5})
    assert outcome["decision"] == LOOP_DECISION["STOP"]
    assert outcome["reason_codes"] == [LOOP_REASON["BUDGET_EXHAUSTED"]]


def test_next_loop_step_stop_with_all_checks_clear_once_a_receipt_clears_every_gate():
    capsule = build_clean_capsule()
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=[{"name": c["name"], "command": c["command"], "outcome": "passed"} for c in capsule["required_checks"]],
        now=NOW,
    )
    outcome = next_loop_step(capsule=capsule, receipt=receipt)
    assert outcome["decision"] == LOOP_DECISION["STOP"]
    assert outcome["reason_codes"] == [LOOP_REASON["ALL_CHECKS_CLEAR"]]


def test_next_loop_step_retains_capsule_evidence_and_budget_gates_after_a_clean_receipt():
    capsule = base_capsule_like(
        {
            "claims": [{"id": "claim_missing_evidence", "evidence": []}],
            "omissions": [{"kind": "claims_over_budget", "omitted_count": 2}],
        }
    )
    receipt = base_receipt_like(capsule)

    outcome = next_loop_step(capsule=capsule, receipt=receipt)

    assert outcome["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert outcome["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]
    assert GATE_REASON["CLAIM_MISSING_EVIDENCE"] in outcome["gate"]["reason_codes"]
    assert GATE_REASON["CAPSULE_OVER_BUDGET"] in outcome["gate"]["reason_codes"]
    assert {"reason_code": GATE_REASON["CLAIM_MISSING_EVIDENCE"], "target": "claim_missing_evidence"} in outcome["gate"]["gate_requests"]
    assert {"reason_code": GATE_REASON["CAPSULE_OVER_BUDGET"], "omitted_count": 2} in outcome["gate"]["gate_requests"]


def test_next_loop_step_request_gate_after_a_receipt_with_a_failed_required_check():
    capsule = build_clean_capsule()
    checks = [
        {"name": c["name"], "command": c["command"], "outcome": "failed" if i == 0 else "passed"}
        for i, c in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule, runtime={"harness": "test", "actor": "test-actor"}, checks=checks, now=NOW
    )
    outcome = next_loop_step(capsule=capsule, receipt=receipt)
    assert outcome["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert outcome["reason_codes"] == [LOOP_REASON["GATE_REQUIRED"]]

def test_next_loop_step_evaluates_a_failed_receipt_at_the_budget_boundary_before_stopping():
    capsule = build_clean_capsule()
    checks = [
        {
            "name": check["name"],
            "command": check["command"],
            "outcome": "failed" if index == 0 else "passed",
        }
        for index, check in enumerate(capsule["required_checks"])
    ]
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "test-actor"},
        checks=checks,
        now=NOW,
    )

    outcome = next_loop_step(
        capsule=capsule,
        receipt=receipt,
        state={"turns_used": 5},
        limits={"max_turns": 5},
    )

    assert outcome["decision"] == LOOP_DECISION["REQUEST_GATE"]
    assert outcome["reason_codes"] == [
        LOOP_REASON["GATE_REQUIRED"],
        LOOP_REASON["BUDGET_EXHAUSTED"],
    ]
    assert outcome["budget"]["decision"] == BUDGET_DECISION["EXHAUSTED"]
    assert outcome["gate"]["decision"] == GATE_DECISION["GATE_REQUIRED"]
    assert GATE_REASON["REQUIRED_CHECK_FAILED"] in outcome["gate"]["reason_codes"]


def test_next_loop_step_blocks_a_capsule_the_budget_refuses_instead_of_acting():
    capsule = build_clean_capsule()
    del capsule["capsule_id"]

    outcome = next_loop_step(capsule=capsule)

    assert outcome["decision"] == LOOP_DECISION["BLOCKED"]
    assert outcome["reason_codes"] == [LOOP_REASON["UNKNOWN_CAPSULE_SHAPE"]]
    assert outcome["budget"] is None
    assert outcome["gate"]["decision"] == GATE_DECISION["BLOCKED"]


def test_next_loop_step_blocked_not_a_silent_pass_on_an_unrecognized_capsule_shape():
    outcome = next_loop_step(capsule={"not": "a capsule"})
    assert outcome == {
        "decision": LOOP_DECISION["BLOCKED"],
        "reason_codes": [LOOP_REASON["UNKNOWN_CAPSULE_SHAPE"]],
        "budget": None,
        "gate": {"decision": GATE_DECISION["BLOCKED"], "reason_codes": [GATE_REASON["UNKNOWN_CAPSULE_SHAPE"]], "gate_requests": []},
    }


def test_next_loop_step_is_pure_the_same_inputs_always_yield_the_same_outcome(real_graph):
    capsule = real_capsule(real_graph, budget={"max_claims": 5})
    a = next_loop_step(capsule=capsule, state={"turns_used": 1}, limits={"max_turns": 5})
    b = next_loop_step(capsule=capsule, state={"turns_used": 1}, limits={"max_turns": 5})
    assert a == b


# -- purity / no second durable memory store -----------------------------------------
# Node's version asserts src/policy/*.mjs never imports node:fs, node:child_process,
# node:net, etc. The Python-idiomatic equivalent (matching test_capsule.py's
# "test_capsule_compile_modules_never_import_filesystem_or_subprocess_access"
# precedent): the pure policy modules never reference filesystem, subprocess,
# or network access.

def test_policy_modules_perform_zero_io_by_construction():
    module_dir = os.path.join(PY_ROOT, "vivary_core")
    files = ["policy_reason_codes.py", "policy_budget.py", "policy_gates.py", "policy_loop.py"]
    forbidden_import_re = re.compile(
        r"^\s*(import|from)\s+(os|subprocess|socket|shutil|pathlib|tempfile)\b", re.MULTILINE
    )
    forbidden_calls = ["open(", "os.open(", "os.remove(", "os.unlink("]
    read_any = False
    for name in files:
        path = os.path.join(module_dir, name)
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        assert len(source) > 0
        read_any = True
        assert not forbidden_import_re.search(source), f"{name} must not import filesystem/subprocess/network modules"
        for token in forbidden_calls:
            assert token not in source, f"{name} must not reference '{token}' (pure decision layer, no I/O)"
    assert read_any, "expected to actually read the policy source files, not vacuously pass"
