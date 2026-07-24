"""Pytest translation of tests/verify.test.mjs (graduation slice 4, Ozone;
decision 0008).

Node's verify.test.mjs builds its receipt/gate-sufficiency `capsule` and
`receipt` fixtures via the real observe -> model -> compile -> receipt
pipeline over disposable git repositories (tests/helpers/fixtures.mjs) - the
same self-contained real-git-fixture pattern python/tests/test_capsule.py
already uses for its own module-scoped `graph`/pipeline fixtures, reused
here directly (module-scoped `fx` -> `capsule` -> `receipt`).

The `proposeContextRepairs` tests are split the same way the Node suite
splits them (per its own header comment): most build hand-crafted synthetic
capsules/graphs as plain dict literals (mirroring tests/router.test.mjs's
precision), and one final test ("real fixture graph: ...") runs the real
pipeline with a tight budget to prove repairs surface over genuine data
without leaking fixture paths.
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

from vivary_core.canonical import deterministic_id  # noqa: E402
from vivary_core.capsule_compile import compile_task_capsule  # noqa: E402
from vivary_core.receipt import RECEIPT_SCHEMA, create_integrity_receipt  # noqa: E402
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES  # noqa: E402
from vivary_core.verify_receipt import RECEIPT_VERDICT_SCHEMA, verify_receipt_integrity  # noqa: E402
from vivary_core.verify_repair import (  # noqa: E402
    REPAIR_KINDS,
    REPAIR_PROPOSAL_SCHEMA,
    propose_context_repairs,
)
from vivary_core.verify_sufficiency import GATE_VERDICT_SCHEMA, evaluate_gate_sufficiency  # noqa: E402
from vivary_core.workspace_model import project_workspace_graph  # noqa: E402
from vivary_core.workspace_observe import observe_checkouts  # noqa: E402

FIXED_DATE = "2026-07-01T12:00:00Z"
FETCH_STAMP_EPOCH = 1782000000.0  # 2026-07-02T00:00:00Z


def NOW():
    return "2026-07-21T15:00:00.000Z"


RUNTIME = {"harness": "claude-code-2.1.215", "model": "claude-fable-5", "actor": "vivary-lattice-session"}
TASK = {"question": "Which local checkout of the shared origin reflects current repository truth?"}

PASSING_CHECKS = [
    {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"},
    {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "passed"},
]


# --- fixture plumbing (mirrors tests/helpers/fixtures.mjs / test_capsule.py) --


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
        "noOrigin": os.path.join(base_dir, "no-origin"),
    }

    # Shared origin with two checkouts: canonical at commit B, the stale
    # neighbor cloned while origin was still at commit A. Both are clean;
    # they simply disagree about where main is. That ambiguity is the
    # fixture.
    _git(base_dir, base_dir, ["init", "-q", "--bare", "-b", "main", paths["origin"]])
    _git(base_dir, base_dir, ["clone", "-q", paths["origin"], paths["canonical"]])
    _commit_file(base_dir, paths["canonical"], "README.md", "# canonical\n", "commit A")
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

    # No remotes configured at all.
    _git(base_dir, base_dir, ["init", "-q", "-b", "main", paths["noOrigin"]])
    _commit_file(base_dir, paths["noOrigin"], "solo.md", "solo\n", "solo")

    return {"paths": paths}


@pytest.fixture(scope="module")
def fx():
    base_dir = tempfile.mkdtemp(prefix="vivary-verify-fixtures-")
    try:
        yield build_fixtures(base_dir)
    finally:
        _rmtree_force(base_dir)


@pytest.fixture(scope="module")
def capsule(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"]]
    observation = observe_checkouts([p["canonical"], p["staleNeighbor"]], allowlist=allowlist, now=NOW)
    graph = project_workspace_graph(observation)
    return compile_task_capsule(task=TASK, graph=graph)


@pytest.fixture(scope="module")
def receipt(capsule):
    return create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)


# -- verify_receipt_integrity -------------------------------------------------


def test_a_genuine_receipt_bound_to_its_capsule_verifies_with_no_reason_codes(capsule, receipt):
    verdict = verify_receipt_integrity(receipt=receipt, capsule=capsule)
    assert verdict["schema"] == RECEIPT_VERDICT_SCHEMA
    assert verdict["outcome"] == OUTCOMES["VERIFIED"]
    assert verdict["reason_codes"] == []
    assert verdict["receipt_id"] == receipt["receipt_id"]


def test_a_genuine_receipt_verifies_on_its_own_integrity_even_with_no_capsule_supplied(receipt):
    verdict = verify_receipt_integrity(receipt=receipt)
    assert verdict["outcome"] == OUTCOMES["VERIFIED"]


def test_a_missing_receipt_is_refused_never_silently_passed():
    assert verify_receipt_integrity()["outcome"] == OUTCOMES["REFUSED"]
    assert verify_receipt_integrity()["reason_codes"] == [REASON_CODES["MISSING_RECEIPT"]]
    assert verify_receipt_integrity(receipt=None)["outcome"] == OUTCOMES["REFUSED"]
    assert verify_receipt_integrity(receipt="not-an-object")["outcome"] == OUTCOMES["REFUSED"]


def test_an_unrecognized_schema_is_refused_by_reason_code():
    verdict = verify_receipt_integrity(receipt={"schema": "vivary.something-else/v0"})
    assert verdict["outcome"] == OUTCOMES["REFUSED"]
    assert verdict["reason_codes"] == [REASON_CODES["UNSUPPORTED_SCHEMA"]]


def test_a_shape_unknown_receipt_right_schema_missing_fingerprint_id_is_insufficient_not_verified():
    verdict = verify_receipt_integrity(receipt={"schema": RECEIPT_SCHEMA})
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert REASON_CODES["MISSING_FINGERPRINT"] in verdict["reason_codes"]
    assert REASON_CODES["MISSING_ID"] in verdict["reason_codes"]


def test_a_tampered_receipt_fails_fingerprint_verification_and_is_marked_insufficient(receipt):
    tampered = {**receipt, "claims_verified": []}
    verdict = verify_receipt_integrity(receipt=tampered)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert verdict["reason_codes"] == [REASON_CODES["FINGERPRINT_MISMATCH"]]


def test_a_receipt_bound_to_a_different_capsule_is_insufficient_with_capsule_binding_mismatch(capsule, receipt):
    other_capsule = {**capsule, "capsule_id": "capsule_other", "fingerprint": "sha256:" + "a" * 64}
    verdict = verify_receipt_integrity(receipt=receipt, capsule=other_capsule)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert verdict["reason_codes"] == [REASON_CODES["CAPSULE_BINDING_MISMATCH"]]


def test_receipt_verification_is_deterministic(capsule, receipt):
    a = verify_receipt_integrity(receipt=receipt, capsule=capsule)
    b = verify_receipt_integrity(receipt=receipt, capsule=capsule)
    assert a == b


# -- evaluate_gate_sufficiency -------------------------------------------------


def passing_gate():
    return {
        "name": "ci",
        "required_checks": ["unit-and-contract-tests", "vivary-graph-doctor"],
        "require_claims_verified": True,
    }


def test_a_gate_whose_required_checks_all_passed_and_whose_claims_are_all_verified_is_sufficient(capsule, receipt):
    verdict = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule, receipt=receipt)
    assert verdict["schema"] == GATE_VERDICT_SCHEMA
    assert verdict["outcome"] == OUTCOMES["SUFFICIENT"]
    assert verdict["reason_codes"] == []
    assert verdict["claims_verified"] == len(capsule["claims"])
    assert verdict["claims_total"] == len(capsule["claims"])


def test_a_missing_required_check_is_insufficient_with_a_named_failing_check(capsule, receipt):
    gate = {"name": "ci", "required_checks": ["unit-and-contract-tests", "some-check-never-run"]}
    verdict = evaluate_gate_sufficiency(gate=gate, capsule=capsule, receipt=receipt)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert REASON_CODES["REQUIRED_CHECK_MISSING"] in verdict["reason_codes"]
    found = next((f for f in verdict["failing_checks"] if f["name"] == "some-check-never-run"), None)
    assert found == {"name": "some-check-never-run", "expected": "passed", "actual": "missing"}


def test_a_failed_required_check_is_insufficient_with_its_actual_outcome_named(capsule):
    failed_receipt = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[
            {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "failed"},
            {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "passed"},
        ],
        now=NOW,
    )
    verdict = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule, receipt=failed_receipt)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert REASON_CODES["REQUIRED_CHECK_FAILED"] in verdict["reason_codes"]
    found = next((f for f in verdict["failing_checks"] if f["name"] == "unit-and-contract-tests"), None)
    assert found == {"name": "unit-and-contract-tests", "expected": "passed", "actual": "failed"}
    # any failure marks the whole receipt's claims unverified (receipt.py contract)
    assert REASON_CODES["CLAIMS_NOT_FULLY_VERIFIED"] in verdict["reason_codes"]


def test_unresolved_conflicts_beyond_the_gates_limit_are_insufficient(capsule):
    gate = {"name": "no-conflicts", "max_unresolved_conflicts": 0}
    verdict = evaluate_gate_sufficiency(gate=gate, capsule=capsule)
    assert len(capsule["conflicts"]) > 0, "fixture capsule should carry the divergent-checkout conflict"
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert verdict["reason_codes"] == [REASON_CODES["UNRESOLVED_CONFLICTS_EXCEED_LIMIT"]]
    assert verdict["unresolved_conflicts"] == len(capsule["conflicts"])


def test_a_gate_needing_checks_or_claim_verification_with_no_receipt_at_all_is_insufficient_never_sufficient(capsule):
    verdict = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert REASON_CODES["RECEIPT_MISSING_FOR_REQUIRED_CHECKS"] in verdict["reason_codes"]
    assert REASON_CODES["RECEIPT_MISSING_FOR_CLAIMS_VERIFICATION"] in verdict["reason_codes"]


def test_a_tampered_receipt_cannot_satisfy_a_gate_even_if_its_self_reported_checks_look_fine(capsule):
    failed_receipt = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[
            {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "failed"},
            {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "passed"},
        ],
        now=NOW,
    )
    # Genuinely tamper: flip the failed check to "passed" after the fact,
    # without recomputing the fingerprint - exactly what a forged receipt
    # would look like from the outside.
    tampered = {**failed_receipt, "checks": [{**c, "outcome": "passed"} for c in failed_receipt["checks"]]}
    verdict = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule, receipt=tampered)
    assert verdict["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert REASON_CODES["RECEIPT_INVALID"] in verdict["reason_codes"]
    assert REASON_CODES["RECEIPT_MISSING_FOR_REQUIRED_CHECKS"] in verdict["reason_codes"]
    assert verdict["receipt_outcome"] == OUTCOMES["INSUFFICIENT"]


def test_a_missing_or_malformed_capsule_is_refused_not_evaluated_as_insufficient():
    assert evaluate_gate_sufficiency(gate=passing_gate())["outcome"] == OUTCOMES["REFUSED"]
    assert evaluate_gate_sufficiency(gate=passing_gate())["reason_codes"] == [REASON_CODES["MISSING_CAPSULE"]]
    assert evaluate_gate_sufficiency(gate=passing_gate(), capsule={})["outcome"] == OUTCOMES["REFUSED"]


def test_a_missing_or_nameless_gate_is_refused_not_evaluated_as_insufficient(capsule):
    assert evaluate_gate_sufficiency(capsule=capsule)["outcome"] == OUTCOMES["REFUSED"]
    assert evaluate_gate_sufficiency(capsule=capsule)["reason_codes"] == [REASON_CODES["MISSING_GATE"]]
    assert evaluate_gate_sufficiency(gate={}, capsule=capsule)["outcome"] == OUTCOMES["REFUSED"]


def test_gate_sufficiency_evaluation_is_deterministic(capsule, receipt):
    a = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule, receipt=receipt)
    b = evaluate_gate_sufficiency(gate=passing_gate(), capsule=capsule, receipt=receipt)
    assert a == b


# -- propose_context_repairs ---------------------------------------------------

MACHINE_PATH_MARKER = "someone"  # fixture-only path segment; must never leak into any proposal


def synthetic_claim(*, subject, fact, tier="allowlisted", evidence_count=1, text="sample claim text for tests"):
    return {
        "id": deterministic_id("claim", {"subject": subject, "fact": fact, "claim": text}),
        "subject": subject,
        "subject_path": f"c:/users/{MACHINE_PATH_MARKER}/dev/{subject}",
        "claim": text,
        "fact": fact,
        "status": "known",
        "evidence": [
            {"command": f"git --no-optional-locks -C c:/users/{MACHINE_PATH_MARKER}/dev/{subject} rev-parse HEAD #{i}"}
            for i in range(evidence_count)
        ],
        "selection_reason": "test fixture",
        "selection": {"tier": tier, "signals": []},
    }


def synthetic_graph(*, with_conflict=False, extra_checkout=False):
    edges = [
        {"id": "edge_1", "kind": "checkout_of", "from": "checkout_aaaa", "to": "repository_xxxx", "evidence": None},
        {"id": "edge_2", "kind": "checkout_of", "from": "checkout_bbbb", "to": "repository_xxxx", "evidence": None},
    ]
    if extra_checkout:
        edges.append({"id": "edge_3", "kind": "checkout_of", "from": "checkout_cccc", "to": "repository_xxxx", "evidence": None})
    return {
        "schema": "vivary.workspace-graph/v0",
        "workspace_fingerprint": "sha256:" + "0" * 64,
        "nodes": [],
        "edges": edges,
        "conflicts": (
            [
                {
                    "id": "conflict_dddd",
                    "kind": "divergent_checkouts",
                    "repository": "repository_xxxx",
                    "sides": [{"checkout": "checkout_aaaa"}, {"checkout": "checkout_bbbb"}],
                    "status": "unresolved",
                }
            ]
            if with_conflict
            else []
        ),
    }


def synthetic_capsule(*, claims=None, omissions=None):
    return {
        "capsule_id": "capsule_test0001",
        "fingerprint": "sha256:" + "1" * 64,
        "workspace": {"fingerprint": "sha256:" + "0" * 64},
        "claims": claims if claims is not None else [],
        "omissions": omissions if omissions is not None else [],
    }


def test_an_empty_capsule_and_single_checkout_graph_produce_no_proposals_and_no_writes():
    graph = {"schema": "vivary.workspace-graph/v0", "workspace_fingerprint": "sha256:x", "nodes": [], "edges": [], "conflicts": []}
    capsule_fx = synthetic_capsule()
    result = propose_context_repairs(capsule=capsule_fx, graph=graph)
    assert result["schema"] == REPAIR_PROPOSAL_SCHEMA
    assert result["proposals"] == []
    assert result["withheld"] == []
    assert result["writes_performed"] == 0
    assert result["requires_gate"] is False


def test_open_first_is_proposed_for_a_weakest_tier_claim_with_no_cited_evidence():
    claim = synthetic_claim(subject="checkout_aaaa", fact="last_fetch", tier="allowlisted", evidence_count=0)
    graph = synthetic_graph()
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim]), graph=graph)
    proposal = next((p for p in result["proposals"] if p["kind"] == REPAIR_KINDS["OPEN_FIRST"]), None)
    assert proposal is not None, "expected an open_first proposal"
    assert proposal["status"] == "proposed"
    assert proposal["requires_gate"] is True
    assert proposal["target"] == claim["id"]
    assert proposal["evidence"] == [claim["id"]]
    assert proposal["estimate"]["estimate_quality"] == "approximate"
    assert isinstance(proposal["estimate"]["token_savings"], (int, float))


def test_open_first_is_not_proposed_once_the_claim_carries_evidence():
    claim = synthetic_claim(subject="checkout_aaaa", fact="last_fetch", tier="allowlisted", evidence_count=1)
    graph = synthetic_graph()
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim]), graph=graph)
    assert not any(p["kind"] == REPAIR_KINDS["OPEN_FIRST"] for p in result["proposals"])


def test_split_is_proposed_for_an_over_budget_capsule_and_cites_the_capsule_and_cut_tiers_never_raw_paths():
    graph = synthetic_graph()
    capsule_fx = synthetic_capsule(
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget 5 reached",
                "omitted_count": 2,
                "omitted": [
                    {"subject_path": f"c:/users/{MACHINE_PATH_MARKER}/dev/x", "fact": "last_fetch", "tier": "allowlisted"},
                    {"subject_path": f"c:/users/{MACHINE_PATH_MARKER}/dev/y", "fact": "remotes", "tier": "allowlisted"},
                ],
            }
        ]
    )
    result = propose_context_repairs(capsule=capsule_fx, graph=graph)
    proposal = next((p for p in result["proposals"] if p["kind"] == REPAIR_KINDS["SPLIT"]), None)
    assert proposal is not None, "expected a split proposal"
    assert proposal["requires_gate"] is True
    assert proposal["target"] == capsule_fx["capsule_id"]
    assert capsule_fx["capsule_id"] in proposal["evidence"]
    assert "2 claim" in proposal["purpose"]
    assert proposal["estimate"]["estimate_quality"] == "approximate"
    serialized = json.dumps(result)
    assert MACHINE_PATH_MARKER not in serialized, "split proposal must not echo the omitted claims' raw paths"


def test_deduplicate_is_proposed_for_two_checkouts_of_one_repository_sharing_a_fact_citing_both_and_justifying_ownership():
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="head_revision", evidence_count=1)
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="head_revision", evidence_count=2)
    graph = synthetic_graph()
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim_a, claim_b]), graph=graph)
    proposal = next((p for p in result["proposals"] if p["kind"] == REPAIR_KINDS["DEDUPLICATE"]), None)
    assert proposal is not None, "expected a deduplicate proposal"
    assert proposal["requires_gate"] is True
    assert sorted(proposal["cites"]) == ["checkout_aaaa", "checkout_bbbb"]
    assert sorted(proposal["evidence"]) == sorted([claim_a["id"], claim_b["id"]])
    assert proposal["ownership"]["subject"] == "checkout_bbbb", "the claim with more cited evidence should be preferred"
    assert proposal["ownership"]["basis"] == "more_evidence_citations"
    assert len(result["withheld"]) == 0


def test_deduplicate_is_withheld_not_proposed_when_the_pair_is_a_side_of_an_unresolved_conflict():
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="head_revision", evidence_count=1)
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="head_revision", evidence_count=1)
    graph = synthetic_graph(with_conflict=True)
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim_a, claim_b]), graph=graph)
    assert not any(p["kind"] == REPAIR_KINDS["DEDUPLICATE"] for p in result["proposals"])
    assert result["withheld"] == [
        {"kind": REPAIR_KINDS["DEDUPLICATE"], "repository": "repository_xxxx", "sides": ["checkout_aaaa", "checkout_bbbb"], "reason": "conflict_unresolved"}
    ]


def test_deduplicate_does_not_fire_when_the_fact_name_matches_but_the_asserted_value_differs():
    # Same fact, genuinely different content (e.g. one checkout dirty, the
    # other clean) - not duplication, so there is nothing to route through
    # one owner and no withheld entry to record either.
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="is_dirty", text="worktree is clean")
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="is_dirty", text="worktree has uncommitted changes")
    graph = synthetic_graph()
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim_a, claim_b]), graph=graph)
    assert result["proposals"] == []
    assert result["withheld"] == []


def test_deduplicate_with_equal_evidence_on_both_sides_declines_to_prefer_an_owner():
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="head_revision", evidence_count=1)
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="head_revision", evidence_count=1)
    graph = synthetic_graph()
    result = propose_context_repairs(capsule=synthetic_capsule(claims=[claim_a, claim_b]), graph=graph)
    proposal = next((p for p in result["proposals"] if p["kind"] == REPAIR_KINDS["DEDUPLICATE"]), None)
    assert proposal["ownership"]["subject"] is None
    assert proposal["ownership"]["basis"] == "tie_no_preference"


def test_route_through_index_escalates_only_once_duplication_coincides_with_budget_pressure():
    claims = [
        synthetic_claim(subject="checkout_aaaa", fact="head_revision"),
        synthetic_claim(subject="checkout_aaaa", fact="head_ref"),
        synthetic_claim(subject="checkout_bbbb", fact="head_revision"),
    ]
    graph = synthetic_graph(extra_checkout=False)
    over_budget_omission = {
        "kind": "claims_over_budget",
        "omitted_count": 1,
        "omitted": [{"subject_path": f"c:/users/{MACHINE_PATH_MARKER}/dev/z", "fact": "last_fetch", "tier": "allowlisted"}],
    }

    under_pressure = propose_context_repairs(
        capsule=synthetic_capsule(claims=claims, omissions=[over_budget_omission]), graph=graph
    )
    routed = next((p for p in under_pressure["proposals"] if p["kind"] == REPAIR_KINDS["ROUTE_THROUGH_INDEX"]), None)
    assert routed is not None, "expected route_through_index once duplication and budget pressure coincide"
    assert routed["target"] == "modules/index.md"
    assert routed["requires_gate"] is True
    assert sorted(routed["evidence"]) == sorted(["checkout_aaaa", "checkout_bbbb", "repository_xxxx"])

    no_pressure = propose_context_repairs(capsule=synthetic_capsule(claims=claims), graph=graph)
    assert not any(p["kind"] == REPAIR_KINDS["ROUTE_THROUGH_INDEX"] for p in no_pressure["proposals"])


def test_no_machine_path_or_private_marker_ever_appears_in_a_repair_envelope():
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="head_revision", evidence_count=0, tier="allowlisted")
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="head_revision", evidence_count=1)
    graph = synthetic_graph()
    capsule_fx = synthetic_capsule(
        claims=[claim_a, claim_b],
        omissions=[
            {
                "kind": "claims_over_budget",
                "omitted_count": 1,
                "omitted": [{"subject_path": f"c:/users/{MACHINE_PATH_MARKER}/dev/w", "fact": "remotes", "tier": "allowlisted"}],
            }
        ],
    )
    result = propose_context_repairs(capsule=capsule_fx, graph=graph)
    serialized = json.dumps(result)
    assert MACHINE_PATH_MARKER not in serialized
    assert "c:/users" not in serialized


def test_proposecontextrepairs_is_deterministic_and_performs_zero_writes_by_construction():
    claim_a = synthetic_claim(subject="checkout_aaaa", fact="head_revision")
    claim_b = synthetic_claim(subject="checkout_bbbb", fact="head_revision")
    graph = synthetic_graph()
    capsule_fx = synthetic_capsule(claims=[claim_a, claim_b])
    a = propose_context_repairs(capsule=capsule_fx, graph=graph)
    b = propose_context_repairs(capsule=capsule_fx, graph=graph)
    assert a == b
    assert a["writes_performed"] == 0


def test_real_fixture_graph_repairs_surface_without_leaking_fixture_paths_or_private_material(fx):
    p = fx["paths"]
    allowlist = [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]]
    observation = observe_checkouts(
        [p["canonical"], p["staleNeighbor"], p["dirty"], p["noOrigin"]], allowlist=allowlist, now=NOW
    )
    graph = project_workspace_graph(observation)
    tight_capsule = compile_task_capsule(task=TASK, graph=graph, budget={"max_claims": 3})
    result = propose_context_repairs(capsule=tight_capsule, graph=graph)
    serialized = json.dumps(result)
    assert p["base"].replace("\\", "/") not in serialized
    assert "secrets" not in serialized.lower()
    assert "private-note" not in serialized
    assert result["writes_performed"] == 0
    # Real evidence, not just synthetic fixtures: the tight budget forces a
    # `split` proposal, and the shared-origin repository (canonical +
    # staleNeighbor) is duplicated enough under pressure to route through the
    # index. Their only shared included fact is head_revision, and it is the
    # very thing they disagree about (that's the conflict) - never a genuine
    # duplicate, so dedupe correctly proposes and withholds nothing here.
    kinds = sorted(p["kind"] for p in result["proposals"])
    assert kinds == sorted([REPAIR_KINDS["ROUTE_THROUGH_INDEX"], REPAIR_KINDS["SPLIT"]])
    assert result["requires_gate"] is True


# -- purity: no I/O anywhere in the verify_* modules --------------------------


def test_verify_modules_perform_zero_filesystem_writes_and_never_spawn_a_process_by_construction():
    verify_dir = os.path.join(PY_ROOT, "vivary_core")
    files = [f for f in os.listdir(verify_dir) if f.startswith("verify") and f.endswith(".py")]
    assert len(files) > 0
    for file_name in files:
        with open(os.path.join(verify_dir, file_name), encoding="utf-8") as handle:
            source = handle.read()
        assert "import subprocess" not in source, f"{file_name} must not spawn processes"
        assert "import os" not in source, f"{file_name} must not import the filesystem"
        assert "open(" not in source, f"{file_name} must not open files"
