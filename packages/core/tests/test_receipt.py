"""Translation of tests/receipt.test.mjs (ticket #84, decision 0008).

ADAPTATION: tests/receipt.test.mjs builds its capsule via the Node
observe -> graph -> compile pipeline (src/workspace/observe.mjs,
src/workspace/model.mjs, src/capsule/compile.mjs) - none of which are part
of this slice. Every behavioral assertion below instead runs against the
captured, path-tokenized capsule fixtures in python/parity/fixtures/
(capsule-basic.json, capsule-tight-budget.json): the same shape of capsule
the Node pipeline would have produced, pre-baked and parametrized over both.

In addition to the behavioral translation, this file adds byte-parity tests
against the Node oracle: for each capsule fixture and each checks variant in
python/parity/fixtures/receipt-inputs.json, the receipt is recreated with the
pinned `now` and provenance, and canonicalize(receipt) must equal the
corresponding *.receipt-*.expected.txt file byte-for-byte.
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)
sys.path.insert(0, PY_ROOT)

from vivary_core.canonical import canonicalize  # noqa: E402
from vivary_core.policy_gates import GATE_DECISION, evaluate_receipt_gate  # noqa: E402
from vivary_core.receipt import create_integrity_receipt  # noqa: E402
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES  # noqa: E402
from vivary_core.verify_receipt import verify_receipt_integrity  # noqa: E402

FIXTURES_DIR = os.path.join(HERE, "fixtures", "parity")


def _load_json(name):
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def _load_text(name):
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as f:
        return f.read()


CAPSULE_NAMES = ["capsule-basic", "capsule-tight-budget"]
CAPSULES = {name: _load_json(f"{name}.json") for name in CAPSULE_NAMES}
RECEIPT_INPUTS = _load_json("receipt-inputs.json")

NOW = lambda: "2026-07-20T15:00:00.000Z"  # noqa: E731
RUNTIME = {"harness": "claude-code-2.1.215", "model": "claude-fable-5", "actor": "vivary-lattice-session"}
PASSING_CHECKS = [
    {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"},
    {"name": "vivary-graph-doctor", "command": "npx create-vivary doctor . --json", "outcome": "passed"},
]


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_receipt_binds_the_exact_capsule_and_workspace_fingerprints(capsule_name):
    capsule = CAPSULES[capsule_name]
    receipt = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    assert receipt["capsule"]["id"] == capsule["capsule_id"]
    assert receipt["capsule"]["fingerprint"] == capsule["fingerprint"]
    assert receipt["workspace"]["fingerprint"] == capsule["workspace"]["fingerprint"]


@pytest.mark.parametrize("empty_binding", ["capsule_id", "capsule_fingerprint", "workspace_fingerprint"])
def test_receipt_construction_rejects_empty_capsule_or_workspace_bindings(empty_binding):
    capsule = {**CAPSULES["capsule-basic"]}
    if empty_binding == "capsule_id":
        capsule["capsule_id"] = ""
    elif empty_binding == "capsule_fingerprint":
        capsule["fingerprint"] = ""
    else:
        capsule["workspace"] = {**capsule["workspace"], "fingerprint": ""}

    with pytest.raises(ValueError, match="non-empty capsule and workspace bindings"):
        create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)


@pytest.mark.parametrize(
    "runtime",
    [
        {**RUNTIME, "actor": None},
        {**RUNTIME, "actor": ""},
        None,
        "not a runtime mapping",
        [],
    ],
    ids=["null-actor", "empty-actor", "null-runtime", "string-runtime", "list-runtime"],
)
def test_receipt_construction_rejects_an_invalid_runtime_actor(runtime):
    with pytest.raises(ValueError, match="non-empty runtime actor"):
        create_integrity_receipt(
            capsule=CAPSULES["capsule-basic"],
            runtime=runtime,
            checks=PASSING_CHECKS,
            now=NOW,
        )


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_all_checks_passing_marks_claims_verified_any_failure_leaves_all_unverified(capsule_name):
    capsule = CAPSULES[capsule_name]
    passed = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    assert passed["claims_verified"] == [c["id"] for c in capsule["claims"]]
    assert passed["claims_unverified"] == []

    failed = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[PASSING_CHECKS[0], {**PASSING_CHECKS[1], "outcome": "failed"}],
        now=NOW,
    )
    assert failed["claims_verified"] == []
    assert len(failed["claims_unverified"]) == len(capsule["claims"])


def test_receipt_id_substitution_cannot_clear_the_policy_gate():
    capsule = CAPSULES["capsule-basic"]
    receipt = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    other_receipt = create_integrity_receipt(
        capsule=capsule,
        runtime={**RUNTIME, "actor": "other-vivary-lattice-session"},
        checks=PASSING_CHECKS,
        now=NOW,
    )
    substituted = {**receipt, "receipt_id": other_receipt["receipt_id"]}

    assert substituted["receipt_id"] != receipt["receipt_id"]
    integrity = verify_receipt_integrity(receipt=substituted, capsule=capsule)
    assert integrity["outcome"] == OUTCOMES["INSUFFICIENT"]
    assert integrity["reason_codes"] == [REASON_CODES["RECEIPT_ID_MISMATCH"]]

    outcome = evaluate_receipt_gate(capsule=capsule, receipt=substituted)
    assert outcome["decision"] != GATE_DECISION["CLEAR"]
    assert outcome["reason_codes"]

@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_no_checks_means_nothing_is_verified(capsule_name):
    capsule = CAPSULES[capsule_name]
    receipt = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=[], now=NOW)
    assert receipt["claims_verified"] == []


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_conflicts_and_unknowns_remain_unresolved_in_the_receipt(capsule_name):
    capsule = CAPSULES[capsule_name]
    receipt = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    assert len(receipt["unresolved_conflicts"]) == len(capsule["conflicts"])
    assert receipt["unresolved_conflicts"][0]["decision"] == "review_required"
    assert receipt["unresolved_unknowns"] == capsule["unknowns"]


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_provenance_references_are_labeled_as_provenance_never_proof(capsule_name):
    capsule = CAPSULES[capsule_name]
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=PASSING_CHECKS,
        provenance=[{"kind": "entire_checkpoint", "ref": "entire:session/example"}],
        now=NOW,
    )
    assert len(receipt["provenance"]) == 1
    assert "not proof of correctness" in receipt["provenance"][0]["note"]


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_a_skipped_check_is_not_a_passed_check_claims_are_not_verified_and_the_receipt_records_it_honestly_64(capsule_name):
    capsule = CAPSULES[capsule_name]
    with_skipped = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[PASSING_CHECKS[0], {**PASSING_CHECKS[1], "outcome": "skipped"}],
        now=NOW,
    )
    # The every-passed rule treats "skipped" the same as any non-"passed"
    # outcome: nothing is verified, even though nothing explicitly failed.
    assert with_skipped["claims_verified"] == []
    assert len(with_skipped["claims_unverified"]) == len(capsule["claims"])
    # The skipped outcome itself is preserved verbatim in the receipt - the
    # dishonesty this guards against would be silently coercing it to
    # "passed" or dropping it, not merely under-verifying claims.
    skipped_check = next((c for c in with_skipped["checks"] if c["outcome"] == "skipped"), None)
    assert skipped_check is not None, "the skipped check must survive into the receipt unmodified"
    assert skipped_check["name"] == PASSING_CHECKS[1]["name"]


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_all_skipped_checks_no_passes_no_failures_still_verify_nothing(capsule_name):
    capsule = CAPSULES[capsule_name]
    all_skipped = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[
            {**PASSING_CHECKS[0], "outcome": "skipped"},
            {**PASSING_CHECKS[1], "outcome": "skipped"},
        ],
        now=NOW,
    )
    assert all_skipped["claims_verified"] == []
    assert len(all_skipped["claims_unverified"]) == len(capsule["claims"])


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_duplicate_check_names_are_carried_through_as_is_never_deduplicated_or_merged_characterization_64(capsule_name):
    capsule = CAPSULES[capsule_name]
    duplicate_named = create_integrity_receipt(
        capsule=capsule,
        runtime=RUNTIME,
        checks=[
            {"name": "unit-and-contract-tests", "command": "npm test", "outcome": "passed"},
            {"name": "unit-and-contract-tests", "command": "npm test -- --shard=2", "outcome": "failed"},
        ],
        now=NOW,
    )
    # No dedup by name: both entries survive, in the order given.
    assert len(duplicate_named["checks"]) == 2
    assert [c["outcome"] for c in duplicate_named["checks"]] == ["passed", "failed"]
    # The every-passed rule is computed over the raw array, name collisions
    # included: one "failed" entry among duplicates still fails the whole run.
    assert duplicate_named["claims_verified"] == []
    assert len(duplicate_named["claims_unverified"]) == len(capsule["claims"])


@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_receipt_is_deterministic_under_an_injected_clock(capsule_name):
    capsule = CAPSULES[capsule_name]
    a = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    b = create_integrity_receipt(capsule=capsule, runtime=RUNTIME, checks=PASSING_CHECKS, now=NOW)
    assert a == b


# --- Byte-parity tests against the Node oracle ------------------------------

CHECKS_VARIANTS = ["checks_passed", "checks_mixed", "checks_empty"]


@pytest.mark.parametrize("checks_name", CHECKS_VARIANTS)
@pytest.mark.parametrize("capsule_name", CAPSULE_NAMES)
def test_receipt_byte_parity_with_the_node_oracle(capsule_name, checks_name):
    capsule = CAPSULES[capsule_name]
    receipt = create_integrity_receipt(
        capsule=capsule,
        runtime=RECEIPT_INPUTS["runtime"],
        checks=RECEIPT_INPUTS[checks_name],
        provenance=[{"kind": "entire-checkpoint", "ref": "entire://fixture/checkpoint"}],
        now=lambda: RECEIPT_INPUTS["now"],
    )
    expected = _load_text(f"{capsule_name}.receipt-{checks_name}.expected.txt")
    assert canonicalize(receipt) == expected
