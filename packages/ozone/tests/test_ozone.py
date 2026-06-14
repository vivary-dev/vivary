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


def _run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = ozone.main(argv)
    return rc, buf.getvalue()


def _run_json(argv):
    rc, out = _run(argv)
    return rc, json.loads(out)


def test_packs_lists_structure():
    rc, data = _run_json(["packs", "--json"])
    assert rc == 0
    assert any(p["name"] == "structure" for p in data["packs"])


def test_review_flags_unverified_change():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["review", "--root", str(td), "--json"])
        rules = {(f["rule"], f["id"]) for f in data["findings"]}
        assert ("change-unverified", "c2") in rules     # c2 has nothing linked
        assert ("change-unverified", "c1") not in rules  # c1 is verified
        assert rc == 0                                   # advisory by default


def test_strict_gates_on_warnings():
    with temp_workspace() as td:
        _vault(td)
        rc, _ = _run(["review", "--root", str(td), "--strict"])
        assert rc == 1  # c2 is unverified -> warn -> strict fails


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
