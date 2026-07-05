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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ozone  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
