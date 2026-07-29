"""Tests for the ozone review layer. Run: python tests/test_ozone.py (or pytest)."""
import contextlib
import io
import json
import os
import shutil
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

OZONE_ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = OZONE_ROOT.parent / "core"
STRATO_ROOT = OZONE_ROOT.parent / "strato"
for package_root in (OZONE_ROOT, CORE_ROOT, STRATO_ROOT):
    sys.path.insert(0, str(package_root))

import ozone  # noqa: E402
import strato  # noqa: E402
from vivary_core.canonical import deterministic_id, fingerprint  # noqa: E402
from vivary_core.capsule_compile import CAPSULE_SCHEMA  # noqa: E402
from vivary_core.capsule_select import OMITTED_LIST_CAP  # noqa: E402
from vivary_core.receipt import create_integrity_receipt  # noqa: E402
from vivary_core.verify_repair import MAX_DEDUPE_CHECKOUTS  # noqa: E402

ROOT = str(OZONE_ROOT)
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-ozone-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        shutil.rmtree(path)


def _vault(td, complete=False):
    """A minimal vivary-vocab vault. `c1` is a complete change (verified + gated);
    unless `complete`, `c2` is a change with nothing linked. `m1` is an unverified
    module. v1/g1 are the verification/gate targets."""
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.module.optional]\nverification = "ref-list"\n'
        '[types.change]\nfolder = "changes"\n'
        '[types.change.optional]\nverification = "ref-list"\ngates = "ref-list"\n'
        '[types.verification]\nfolder = "verification"\n'
        '[types.gate]\nfolder = "gates"\n')
    for d in ("modules", "changes", "verification", "gates"):
        Path(td, d).mkdir()
    Path(td, "modules", "m1.md").write_text("# Module One\n")
    Path(td, "verification", "v1.md").write_text("# Verify One\n")
    Path(td, "gates", "g1.md").write_text("# Gate One\n")
    Path(td, "changes", "c1.md").write_text(
        "---\nverification: [v1]\ngates: [g1]\n---\n# Change One\n")
    if not complete:
        Path(td, "changes", "c2.md").write_text("# Change Two\n")


def _writing_vault(td):
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.draft]\nfolder = ["drafts", "manuscripts"]\n'
        '[types.draft.optional]\nreviews = "ref-list"\nedits = "ref-list"\noutline = "ref"\n'
        '[types.review]\nfolder = ["reviews", "editorial-reviews"]\n'
        '[types.review.optional]\ndraft = "ref"\nedits = "ref-list"\n'
        '[types.edit]\nfolder = ["edits", "revisions"]\n'
        '[types.edit.optional]\ndraft = "ref"\nreview = "ref"\n'
        '[types.outline]\nfolder = ["outlines", "structures", "beats"]\n'
        '[types.outline.optional]\ndraft = "ref"\n')
    for d in ("drafts", "reviews", "edits", "outlines"):
        Path(td, d).mkdir()
    Path(td, "drafts", "complete.md").write_text(
        "---\nreviews: [review-complete]\nedits: [edit-complete]\noutline: outline-complete\n---\n"
        "# Complete Draft\n")
    Path(td, "reviews", "review-complete.md").write_text(
        "---\ndraft: complete\n---\n# Review Complete\n")
    Path(td, "edits", "edit-complete.md").write_text(
        "---\ndraft: complete\nreview: review-complete\n---\n# Edit Complete\n")
    Path(td, "outlines", "outline-complete.md").write_text(
        "---\ndraft: complete\n---\n# Outline Complete\n")
    Path(td, "drafts", "raw.md").write_text("# Raw Draft\n")
    Path(td, "reviews", "orphan-review.md").write_text("# Orphan Review\n")
    Path(td, "edits", "orphan-edit.md").write_text("# Orphan Edit\n")


def _run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = ozone.main(argv)
    return rc, buf.getvalue()


def _run_json(argv):
    rc, out = _run(argv)
    return rc, json.loads(out)


def test_runtime_version_matches_package_manifest():
    import tomllib

    project = tomllib.loads(
        (OZONE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]
    assert ozone.__version__ == project["version"]
    assert "vivary-core>=0.2.2" in project["dependencies"]


def test_run_receipt_appends_jsonl_without_polluting_stdout():
    with temp_workspace() as td:
        receipt = td / "receipts" / "runs.jsonl"
        rc, data = _run_json(["packs", "--json", "--receipt", str(receipt)])

        assert rc == 0
        assert "packs" in data
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        assert record["schema"] == "vivary.run_receipt.v1"
        assert record["tool"] == "ozone"
        assert record["command"] == "packs"
        assert record["exit_code"] == 0
        assert record["ok"] is True
        assert "--json" in record["flags"]
        assert "--receipt" not in record["flags"]
        assert str(td) not in json.dumps(record, sort_keys=True)


def test_impact_receipt_does_not_record_target_id():
    with temp_workspace() as td:
        _vault(td)
        receipt = td / "runs.jsonl"
        secret_target = "c1"

        rc, data = _run_json([
            "impact",
            secret_target,
            "--root",
            str(td),
            "--json",
            "--receipt",
            str(receipt),
        ])

        assert rc == 0
        assert data["target"] == secret_target
        record = json.loads(receipt.read_text(encoding="utf-8").strip())
        serialized = json.dumps(record, sort_keys=True)
        assert record["command"] == "impact"
        assert secret_target not in serialized
        assert str(td) not in serialized


def test_packs_lists_structure_and_context_budget():
    rc, data = _run_json(["packs", "--json"])
    assert rc == 0
    names = {p["name"] for p in data["packs"]}
    assert {"structure", "context-budget", "editorial"} <= names


def test_review_flags_unverified_change():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        rules = {(f["rule"], f["id"]) for f in data["findings"]}
        assert ("change-unverified", "c2") in rules     # c2 has nothing linked
        assert ("change-unverified", "c1") not in rules  # c1 is verified
        assert rc == 0                                   # advisory by default


def test_review_default_remains_structure_only():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        assert data["packs"] == ["structure"]
        assert not any(f["rule"] == "module-index-missing" for f in data["findings"])
        assert rc == 0


def test_context_budget_flags_missing_module_index():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        findings = {(f["rule"], f["path"]) for f in data["findings"]}
        assert data["packs"] == ["context-budget"]
        assert ("module-index-missing", "modules/m2/index.md") in findings
        assert data["warnings"] == 1
        assert rc == 0


def test_context_budget_flags_legacy_module_file_with_index():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m1").mkdir()
        Path(td, "modules", "m1", "index.md").write_text("# Module One Index\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        findings = {(f["rule"], f["path"]) for f in data["findings"]}
        assert ("legacy-module-file", "modules/m1.md") in findings
        assert data["warnings"] == 1
        assert rc == 0


def test_context_budget_flags_large_public_routing_surfaces_as_info():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text("\n".join(f"root line {i}" for i in range(161)))
        Path(td, "modules", "big").mkdir()
        Path(td, "modules", "big", "index.md").write_text(
            "\n".join(f"module line {i}" for i in range(121)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        by_rule = {(f["rule"], f["path"]): f for f in data["findings"]}
        assert by_rule[("always-on-large", "AGENTS.md")]["severity"] == "info"
        assert by_rule[("module-index-large", "modules/big/index.md")]["severity"] == "info"
        assert data["warnings"] == 0
        assert data["notes"] == 2
        assert rc == 0


def test_context_budget_flags_positive_bulk_load_cues_only():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text(
            "Before every task, read the entire docs folder for context.\n")
        Path(td, "modules", "index.md").write_text(
            "Do not read the whole repo by default; use targeted pointers.\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        matches = [f for f in data["findings"] if f["rule"] == "bulk-load-cue"]
        assert [(f["severity"], f["path"]) for f in matches] == [("info", "AGENTS.md")]
        assert data["warnings"] == 0
        assert rc == 0


def test_context_budget_ignores_private_memory_surfaces():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "USER.md").write_text("\n".join("private user line" for _ in range(1000)))
        Path(td, "MEMORY.md").write_text(
            "Before every task, read the entire docs folder for context.\n")
        Path(td, "memory").mkdir()
        Path(td, "memory", "notes.md").write_text("\n".join("private memory line" for _ in range(1000)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        assert data["findings"] == []
        assert rc == 0


def test_context_budget_flags_duplicate_long_routing_blocks():
    block = (
        "This routing surface owns a short stable summary for agents and points them "
        "toward the one canonical detail file for each durable fact in the workspace."
    )
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text(f"# Agent Contract\n\n{block}\n")
        Path(td, "modules", "index.md").write_text(f"# Modules\n\n{block}\n")
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "context-budget", "--json"])
        matches = [f for f in data["findings"] if f["rule"] == "duplicate-routing-block"]
        assert len(matches) == 1
        assert matches[0]["severity"] == "info"
        assert matches[0]["path"] == "AGENTS.md"
        assert "modules/index.md" in matches[0]["message"]
        assert data["warnings"] == 0
        assert rc == 0


def test_editorial_flags_missing_review_edit_and_structure():
    with temp_workspace() as td:
        _writing_vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        by_rule = {(f["rule"], f["id"]): f for f in data["findings"]}
        assert data["packs"] == ["editorial"]
        assert by_rule[("draft-unreviewed", "raw")]["severity"] == "warn"
        assert by_rule[("draft-unedited", "raw")]["severity"] == "info"
        assert by_rule[("draft-structure-missing", "raw")]["severity"] == "info"
        assert ("draft-unreviewed", "complete") not in by_rule
        assert ("draft-unedited", "complete") not in by_rule
        assert ("draft-structure-missing", "complete") not in by_rule
        assert data["warnings"] == 3
        assert rc == 0


def test_editorial_flags_unlinked_reviews_and_edits():
    with temp_workspace() as td:
        _writing_vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        by_rule = {(f["rule"], f["id"]): f for f in data["findings"]}
        assert by_rule[("review-unlinked", "orphan-review")]["severity"] == "warn"
        assert by_rule[("edit-unlinked", "orphan-edit")]["severity"] == "warn"
        assert ("review-unlinked", "review-complete") not in by_rule
        assert ("edit-unlinked", "edit-complete") not in by_rule
        assert rc == 0


def test_editorial_pack_stays_quiet_for_non_writing_workspace():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "editorial", "--json"])
        assert data["findings"] == []
        assert data["warnings"] == 0
        assert rc == 0


def test_strict_gates_on_warnings():
    with temp_workspace() as td:
        _vault(td)
        rc, _ = _run(["review", "--root", str(td), "--strict"])
        assert rc == 1  # c2 is unverified -> warn -> strict fails


def test_strict_gates_on_context_budget_warnings_with_pack_all():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "modules", "m2").mkdir()
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "all", "--strict", "--json"])
        assert data["packs"] == ["structure", "context-budget", "editorial"]
        assert any(f["rule"] == "module-index-missing" for f in data["findings"])
        assert rc == 1


def test_strict_allows_info_only_context_budget_findings():
    with temp_workspace() as td:
        _vault(td, complete=True)
        Path(td, "AGENTS.md").write_text("\n".join(f"root line {i}" for i in range(161)))
        rc, data = _run_json(["review", "--root", str(td),
                              "--pack", "all", "--strict", "--json"])
        assert any(f["rule"] == "always-on-large" for f in data["findings"])
        assert data["warnings"] == 0
        assert rc == 0


def test_clean_vault_has_no_warnings():
    with temp_workspace() as td:
        _vault(td, complete=True)
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        assert data["warnings"] == 0
        rc2, _ = _run(["review", "--root", str(td), "--strict"])
        assert rc2 == 0


def test_module_unverified_is_a_note_not_a_warning():
    with temp_workspace() as td:
        _vault(td, complete=True)
        _, data = _run_json(["review", "--root", str(td), "--json"])
        mod = [f for f in data["findings"] if f["rule"] == "module-unverified"]
        assert mod and all(f["severity"] == "info" for f in mod)


def test_impact_returns_dependents():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["impact", "v1", "--root", str(td), "--json"])
        assert rc == 0
        ids = {n["id"] for n in data["nodes"]}
        assert "c1" in ids  # c1 depends on v1 via its verification edge


def test_review_json_shape():
    with temp_workspace() as td:
        _vault(td)
        _, data = _run_json(["review", "--root", str(td), "--json"])
        assert set(data) >= {"reviewed", "warnings", "notes", "findings"}
        for f in data["findings"]:
            assert set(f) >= {"severity", "rule", "id", "type", "path", "message"}


NOW = "2026-07-28T12:00:00+00:00"


def _governed_capsule(*, claims=None, unknowns=None, omissions=None):
    value = {
        "schema": CAPSULE_SCHEMA,
        "capsule_id": None,
        "task": {
            "question": "Can this task pass the release gate?",
            "scope": ["/repo/packages/ozone"],
        },
        "workspace": {
            "fingerprint": "sha256:test-workspace",
            "observed_at": NOW,
        },
        "claims": [] if claims is None else claims,
        "conflicts": [],
        "unknowns": [] if unknowns is None else unknowns,
        "omissions": [] if omissions is None else omissions,
        "required_checks": [
            {"name": "unit", "command": "python packages/ozone/tests/test_ozone.py"}
        ],
        "budget": {"max_claims": 24},
    }
    value["capsule_id"] = deterministic_id(
        "capsule",
        {
            "task": value["task"]["question"],
            "filters": None,
            "workspace": value["workspace"]["fingerprint"],
        },
    )
    value["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in value.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    return value


def _governed_receipt(capsule, *, outcome="passed", created_at=NOW):
    return create_integrity_receipt(
        capsule=capsule,
        runtime={"harness": "test", "actor": "agent:test"},
        checks=[
            {
                "name": "unit",
                "command": "python packages/ozone/tests/test_ozone.py",
                "outcome": outcome,
            }
        ],
        now=lambda: created_at,
    )


def _governed_request(*, capsule=None, receipt=True, gate=None, graph=False, **overrides):
    governed_capsule = _governed_capsule() if capsule is None else capsule
    value = {
        "schema": ozone.REQUEST_SCHEMA,
        "workspace": {"fingerprint": governed_capsule["workspace"]["fingerprint"]},
        "verified_at": NOW,
        "capsule": governed_capsule,
        "gate": {
            "name": "release",
            "required_checks": ["unit"],
            "require_claims_verified": True,
        }
        if gate is None
        else gate,
    }
    if receipt is not False:
        value["receipt"] = (
            _governed_receipt(governed_capsule) if receipt is True else receipt
        )
    if graph is not False:
        value["graph"] = (
            {
                "schema": "vivary.workspace-graph/v0",
                "workspace_fingerprint": governed_capsule["workspace"]["fingerprint"],
                "nodes": [],
                "edges": [],
                "conflicts": [],
            }
            if graph is True
            else graph
        )
    value.update(overrides)
    return value


def test_governed_verification_returns_raw_bound_core_verdicts():
    result = ozone.verify_governed(_governed_request(graph=True))

    assert result["schema"] == ozone.VERIFICATION_SCHEMA
    assert result["outcome"] == "sufficient"
    assert result["reason_codes"] == []
    assert result["receipt_verdict"]["schema"] == "vivary.receipt-verdict/v0"
    assert result["receipt_verdict"]["outcome"] == "verified"
    assert result["gate_verdict"]["schema"] == "vivary.gate-verdict/v0"
    assert result["gate_verdict"]["outcome"] == "sufficient"
    assert result["repair_proposal"]["schema"] == "vivary.context-repair-proposal/v0"
    assert result["repair_proposal"]["writes_performed"] == 0


def test_governed_verification_refuses_unknown_artifact_fields():
    unknown_capsule = _governed_capsule()
    unknown_capsule["unexpected"] = "accepted"
    unknown_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in unknown_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    capsule_result = ozone.verify_governed(
        _governed_request(
            capsule=unknown_capsule,
            receipt=_governed_receipt(unknown_capsule),
        )
    )

    receipt_capsule = _governed_capsule()
    unknown_receipt = _governed_receipt(receipt_capsule)
    unknown_receipt["unexpected"] = "accepted"
    unknown_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in unknown_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )
    receipt_result = ozone.verify_governed(
        _governed_request(capsule=receipt_capsule, receipt=unknown_receipt)
    )

    assert capsule_result["schema"] == ozone.REFUSAL_SCHEMA
    assert capsule_result["reason_codes"] == [
        "unknown_capsule_field:unexpected"
    ]
    assert receipt_result["schema"] == ozone.REFUSAL_SCHEMA
    assert receipt_result["reason_codes"] == [
        "unknown_receipt_field:unexpected"
    ]


def test_governed_verdict_is_consumed_unchanged_by_strato():
    governed = _governed_request()
    ozone_result = ozone.verify_governed(governed)
    strato_result = strato.decide_governed(
        {
            "schema": strato.REQUEST_SCHEMA,
            "policy_version": strato.POLICY_VERSION,
            "actor": {"kind": "agent", "id": "agent:test"},
            "authority_class": "contributor",
            "workspace": governed["workspace"],
            "scope": {"project": "vivary", "paths": ["/repo/packages/ozone"]},
            "requested_at": NOW,
            "decision_at": NOW,
            "capsule": governed["capsule"],
            "receipt": governed["receipt"],
            "verdict": ozone_result["gate_verdict"],
            "state": {"turns_used": 0, "actions_used": 0},
            "limits": {"max_turns": 3, "max_actions": 3},
        }
    )

    assert strato_result["decision"] == "stop"
    assert strato_result["reason_codes"] == ["all_checks_clear"]
    assert "verdict_integrity_mismatch" not in strato_result["gate"]["reason_codes"]


def test_governed_claim_sufficiency_matches_ids_not_counts():
    governed_capsule = _governed_capsule(
        claims=[
            {"id": "claim:first", "subject": "checkout:a", "claim": "first"},
            {"id": "claim:second", "subject": "checkout:a", "claim": "second"},
        ]
    )
    governed_receipt = _governed_receipt(governed_capsule)
    governed_receipt["claims_verified"] = ["claim:unrelated-a", "claim:unrelated-b"]
    governed_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["outcome"] == "insufficient"
    assert "claims_not_fully_verified" in result["gate_verdict"]["reason_codes"]
    assert result["gate_verdict"]["claims_total"] == 2
    assert result["gate_verdict"]["claims_verified"] == 0


def test_governed_verification_refuses_duplicate_claim_ids():
    governed_capsule = _governed_capsule(
        claims=[
            {"id": "claim:duplicate", "subject": "checkout:a", "claim": "first"},
            {"id": "claim:duplicate", "subject": "checkout:b", "claim": "second"},
        ]
    )
    governed_receipt = _governed_receipt(governed_capsule)
    governed_receipt["claims_verified"] = ["claim:duplicate"]
    governed_receipt["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_receipt.items()
            if key not in {"receipt_id", "fingerprint"}
        }
    )

    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, receipt=governed_receipt)
    )

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["duplicate_claim_id"]
    over_budget_capsule = _governed_capsule(
        claims=[{"id": "claim:one", "subject": "checkout:a", "claim": "one"}]
    )
    over_budget_capsule["budget"] = {"max_claims": 0}
    over_budget_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in over_budget_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    over_budget = ozone.verify_governed(
        _governed_request(capsule=over_budget_capsule)
    )

    assert over_budget["schema"] == ozone.REFUSAL_SCHEMA
    assert over_budget["reason_codes"] == ["capsule_claim_budget_exceeded"]


def test_governed_verification_fails_closed_for_missing_and_tampered_receipts():
    missing = ozone.verify_governed(_governed_request(receipt=False))
    tampered_request = _governed_request()
    tampered_request["receipt"]["checks"][0]["outcome"] = "failed"
    tampered = ozone.verify_governed(tampered_request)

    assert missing["outcome"] == "insufficient"
    assert missing["receipt_verdict"]["outcome"] == "refused"
    assert "receipt_missing_for_required_checks" in missing["gate_verdict"]["reason_codes"]
    assert tampered["outcome"] == "insufficient"
    assert tampered["receipt_verdict"]["outcome"] == "insufficient"
    assert "fingerprint_mismatch" in tampered["receipt_verdict"]["reason_codes"]


def test_governed_verification_refuses_stale_and_mismatched_evidence():
    stale_request = _governed_request()
    stale_request["verified_at"] = "2026-07-28T12:06:00+00:00"
    mismatch_request = _governed_request()
    mismatch_request["workspace"] = {"fingerprint": "sha256:other-workspace"}

    stale = ozone.verify_governed(stale_request)
    mismatch = ozone.verify_governed(mismatch_request)

    assert stale["schema"] == ozone.REFUSAL_SCHEMA
    assert "stale_capsule" in stale["reason_codes"]
    assert "stale_receipt" in stale["reason_codes"]
    assert mismatch["schema"] == ozone.REFUSAL_SCHEMA
    assert mismatch["reason_codes"] == ["workspace_mismatch"]


def test_governed_verification_enforces_gate_budgets():
    governed_capsule = _governed_capsule(unknowns=[{"id": "unknown:release"}])
    result = ozone.verify_governed(
        _governed_request(
            capsule=governed_capsule,
            gate={"name": "release", "max_unresolved_unknowns": 0},
        )
    )

    assert result["outcome"] == "insufficient"
    assert result["gate_verdict"]["unresolved_unknowns"] == 1
    assert "unresolved_unknowns_exceed_limit" in result["reason_codes"]


def test_governed_repairs_are_typed_bounded_and_dry_run():
    governed_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:weak",
                "fact": "weak_evidence",
                "subject": "checkout:a",
                "claim": "Open the source before relying on this claim.",
                "selection": {"tier": "allowlisted"},
                "evidence": [],
            }
        ]
    )
    result = ozone.verify_governed(
        _governed_request(capsule=governed_capsule, graph=True)
    )
    proposal = result["repair_proposal"]

    assert proposal["writes_performed"] == 0
    assert proposal["requires_gate"] is True
    assert len(proposal["proposals"]) == 1
    assert proposal["proposals"][0]["target"] == "claim:weak"
    assert proposal["proposals"][0]["requires_gate"] is True


def test_governed_verification_refuses_malformed_repair_inputs_without_crashing():
    malformed_graph = {
        "schema": "vivary.workspace-graph/v0",
        "workspace_fingerprint": "sha256:test-workspace",
        "nodes": [],
        "edges": [None],
        "conflicts": [],
    }
    malformed = ozone.verify_governed(_governed_request(graph=malformed_graph))
    malformed_claim_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:malformed",
                "fact": [],
                "subject": "checkout:a",
                "claim": "This fact cannot be used as a dedupe key.",
                "selection": {"tier": "allowlisted"},
                "evidence": [],
            }
        ]
    )
    malformed_claim = ozone.verify_governed(
        _governed_request(capsule=malformed_claim_capsule, graph=True)
    )
    missing_capsule_request = _governed_request(graph=True)
    missing_capsule_request["capsule"] = None
    missing_capsule = ozone.verify_governed(missing_capsule_request)
    mismatched_graph_request = _governed_request(graph=True)
    uncollatable_graph_request = _governed_request(graph=True)
    uncollatable_graph_request["graph"]["edges"] = [
        {"kind": "checkout_of", "from": "checkout:a", "to": "repo:🚀"}
    ]
    uncollatable_graph = ozone.verify_governed(uncollatable_graph_request)
    duplicate_edge_capsule = _governed_capsule(
        claims=[
            {
                "id": "claim:checkout-a",
                "fact": "head_revision",
                "subject": "checkout:a",
                "claim": "abc123",
                "evidence": [],
            }
        ]
    )
    duplicate_edge_request = _governed_request(
        capsule=duplicate_edge_capsule,
        graph=True,
    )
    checkout_edge = {
        "kind": "checkout_of",
        "from": "checkout:a",
        "to": "repository:x",
    }
    duplicate_edge_request["graph"]["edges"] = [checkout_edge, dict(checkout_edge)]
    duplicate_edge_graph = ozone.verify_governed(duplicate_edge_request)
    oversized_conflict_request = _governed_request(graph=True)
    checkout_ids = [
        f"checkout:{index}" for index in range(MAX_DEDUPE_CHECKOUTS + 1)
    ]
    oversized_conflict_request["graph"]["edges"] = [
        {"kind": "checkout_of", "from": checkout_id, "to": "repository:x"}
        for checkout_id in checkout_ids
    ]
    oversized_conflict_request["graph"]["conflicts"] = [
        {
            "repository": "repository:x",
            "sides": [{"checkout": checkout_id} for checkout_id in checkout_ids],
        }
    ]
    oversized_conflict_graph = ozone.verify_governed(oversized_conflict_request)
    mismatched_graph_request["graph"]["workspace_fingerprint"] = "sha256:other"
    mismatched_graph = ozone.verify_governed(mismatched_graph_request)
    recursive_request = _governed_request()
    nested = []
    cursor = nested
    for _ in range(1100):
        child = []
        cursor.append(child)
        cursor = child
    recursive_request["receipt"] = nested
    recursive = ozone.verify_governed(recursive_request)

    assert malformed["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed["reason_codes"] == ["invalid_repair_graph"]
    assert malformed_claim["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed_claim["reason_codes"] == ["invalid_repair_capsule"]
    assert missing_capsule["schema"] == ozone.REFUSAL_SCHEMA
    assert missing_capsule["reason_codes"] == [
        "invalid_capsule",
        "invalid_capsule_observed_at",
        "invalid_repair_capsule",
    ]
    assert uncollatable_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert uncollatable_graph["reason_codes"] == ["invalid_repair_graph"]
    assert duplicate_edge_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert duplicate_edge_graph["reason_codes"] == ["invalid_repair_graph"]
    assert oversized_conflict_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert oversized_conflict_graph["reason_codes"] == ["invalid_repair_graph"]
    assert mismatched_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert mismatched_graph["reason_codes"] == ["repair_graph_workspace_mismatch"]
    assert recursive["schema"] == ozone.REFUSAL_SCHEMA
    assert recursive["reason_codes"] == ["request_too_deeply_nested"]


def test_governed_verification_refuses_unbounded_repair_products():
    checkout_ids = [
        f"checkout:{index}" for index in range(MAX_DEDUPE_CHECKOUTS)
    ]
    claims = [
        {
            "id": f"claim:{checkout_id}:{fact_index}",
            "fact": f"fact:{fact_index}",
            "subject": checkout_id,
            "claim": f"value:{fact_index}",
            "evidence": [],
        }
        for checkout_id in checkout_ids
        for fact_index in range(2)
    ]
    governed_capsule = _governed_capsule(claims=claims)
    governed_capsule["budget"] = {"max_claims": len(claims)}
    governed_capsule["fingerprint"] = fingerprint(
        {
            key: item
            for key, item in governed_capsule.items()
            if key not in {"capsule_id", "fingerprint"}
        }
    )
    request = _governed_request(
        capsule=governed_capsule,
        receipt=False,
        graph=True,
    )
    request["graph"]["edges"] = [
        {"kind": "checkout_of", "from": checkout_id, "to": "repository:x"}
        for checkout_id in checkout_ids
    ]

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]

    oversized_estimate_capsule = _governed_capsule(
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget reached",
                "omitted_count": 2**53 - 1,
                "omitted": [
                    {
                        "subject_path": f"/repo/omitted/{index}",
                        "fact": f"omitted:{index}",
                        "tier": "allowlisted",
                    }
                    for index in range(OMITTED_LIST_CAP)
                ],
            }
        ]
    )
    oversized_estimate = ozone.verify_governed(
        _governed_request(
            capsule=oversized_estimate_capsule,
            receipt=_governed_receipt(oversized_estimate_capsule),
            graph=True,
        )
    )

    assert oversized_estimate["schema"] == ozone.REFUSAL_SCHEMA
    assert oversized_estimate["reason_codes"] == ["repair_estimate_unbounded"]


def test_governed_verification_refuses_unbounded_checkout_pair_scans():
    request = _governed_request(receipt=False, graph=True)
    request["graph"]["edges"] = [
        {
            "kind": "checkout_of",
            "from": f"checkout:{repository_index}:{checkout_index}",
            "to": f"repository:{repository_index}",
        }
        for repository_index in range(2)
        for checkout_index in range(MAX_DEDUPE_CHECKOUTS)
    ]

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_unbounded_route_evidence():
    overflow_checkout = f"checkout:{MAX_DEDUPE_CHECKOUTS:03d}"
    capsule = _governed_capsule(
        claims=[
            {
                "id": f"claim:overflow:{index}",
                "fact": f"fact:{index}",
                "subject": overflow_checkout,
                "claim": f"value:{index}",
                "evidence": [],
            }
            for index in range(3)
        ],
        omissions=[
            {
                "kind": "claims_over_budget",
                "reason": "claim budget reached",
                "omitted_count": 1,
                "omitted": [
                    {
                        "subject_path": "/repo/omitted",
                        "fact": "omitted:0",
                        "tier": "allowlisted",
                    }
                ],
            }
        ],
    )
    request = _governed_request(capsule=capsule, receipt=False, graph=True)
    request["graph"]["edges"] = [
        {
            "kind": "checkout_of",
            "from": f"checkout:{index:03d}",
            "to": "repository:x",
        }
        for index in range(MAX_DEDUPE_CHECKOUTS + 1)
    ]

    result = ozone.verify_governed(request)

    assert result["schema"] == ozone.REFUSAL_SCHEMA
    assert result["reason_codes"] == ["repair_work_unbounded"]


def test_governed_verification_refuses_unbounded_or_inconsistent_omission_lists():
    oversized_omitted = [
        {
            "subject_path": f"/repo/omitted/{index}",
            "fact": f"omitted:{index}",
            "tier": "allowlisted",
        }
        for index in range(OMITTED_LIST_CAP + 1)
    ]
    inconsistent_omitted = oversized_omitted[:2]

    for omitted_count, omitted in (
        (len(oversized_omitted), oversized_omitted),
        (1, inconsistent_omitted),
    ):
        capsule = _governed_capsule(
            omissions=[
                {
                    "kind": "claims_over_budget",
                    "reason": "claim budget reached",
                    "omitted_count": omitted_count,
                    "omitted": omitted,
                }
            ]
        )

        result = ozone.verify_governed(
            _governed_request(capsule=capsule, graph=True)
        )

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_repair_capsule"]


def test_governed_verification_refuses_malformed_gate_constraints():
    malformed_constraints = (
        ("required_checks", "unit"),
        ("required_checks", ["unit", 1]),
        ("require_claims_verified", 1),
        ("max_unresolved_conflicts", "0"),
        ("max_unresolved_conflicts", True),
        ("max_unresolved_unknowns", []),
    )

    for field, value in malformed_constraints:
        request = _governed_request()
        request["gate"][field] = value

        result = ozone.verify_governed(request)

        assert result["schema"] == ozone.REFUSAL_SCHEMA
        assert result["reason_codes"] == ["invalid_gate"]

    nullable_request = _governed_request()
    nullable_request["gate"].update(
        {
            "required_checks": None,
            "require_claims_verified": None,
            "max_unresolved_conflicts": None,
            "max_unresolved_unknowns": None,
        }
    )
    assert ozone.verify_governed(nullable_request)["schema"] == ozone.VERIFICATION_SCHEMA


def test_governed_verification_refuses_unbound_graph_and_unknown_gate_fields():
    unbound_graph_request = _governed_request(graph=True)
    del unbound_graph_request["graph"]["workspace_fingerprint"]
    unbound_graph = ozone.verify_governed(unbound_graph_request)
    unknown_gate_request = _governed_request()
    unknown_gate_request["gate"]["max_unresolved_conflict"] = 0
    unknown_gate = ozone.verify_governed(unknown_gate_request)

    lossy_integer_request = _governed_request()
    lossy_integer_request["gate"]["max_unresolved_unknowns"] = 2**53
    lossy_integer = ozone.verify_governed(lossy_integer_request)

    assert unbound_graph["schema"] == ozone.REFUSAL_SCHEMA
    assert unbound_graph["reason_codes"] == ["invalid_repair_graph"]
    assert unknown_gate["schema"] == ozone.REFUSAL_SCHEMA
    assert unknown_gate["reason_codes"] == [
        "unknown_gate_field:max_unresolved_conflict"
    ]
    assert lossy_integer["schema"] == ozone.REFUSAL_SCHEMA
    assert lossy_integer["reason_codes"] == ["invalid_json_value"]


def test_governed_verify_cli_emits_typed_json_and_honest_exit_codes():
    with temp_workspace() as td:
        request_path = td / "request.json"
        request_path.write_text(
            json.dumps(_governed_request()),
            encoding="utf-8",
        )
        sufficient_rc, sufficient = _run_json(
            ["verify", str(request_path), "--governed", "--json", "--strict"]
        )

        tampered_request = _governed_request()
        tampered_request["receipt"]["checks"][0]["outcome"] = "failed"
        request_path.write_text(json.dumps(tampered_request), encoding="utf-8")
        insufficient_rc, insufficient = _run_json(
            ["verify", str(request_path), "--governed", "--json", "--strict"]
        )
        refused_request = _governed_request(gate={})
        request_path.write_text(json.dumps(refused_request), encoding="utf-8")
        refused_rc, refused = _run_json(
            ["verify", str(request_path), "--governed", "--json"]
        )

        request_path.write_text("{", encoding="utf-8")
        malformed_rc, malformed = _run_json(
            ["verify", str(request_path), "--governed", "--json"]
        )

    assert sufficient_rc == 0
    assert sufficient["outcome"] == "sufficient"
    assert insufficient_rc == 1
    assert insufficient["outcome"] == "insufficient"
    assert refused_rc == 2
    assert refused["schema"] == ozone.REFUSAL_SCHEMA
    assert refused["reason_codes"] == ["invalid_gate"]
    assert malformed_rc == 2
    assert malformed["schema"] == ozone.REFUSAL_SCHEMA
    assert malformed["reason_codes"] == ["invalid_request_document"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
