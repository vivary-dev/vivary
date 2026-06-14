"""Tests for the exo coordination layer. Run: python tests/test_exo.py (or pytest)."""
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
import exo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_TMP = os.path.abspath(os.path.join(ROOT, "..", "..", "sandboxes"))


def make_tmp_path():
    base = REPO_TMP if os.path.isdir(REPO_TMP) else os.getcwd()
    path = Path(base) / f"test-exo-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


@contextmanager
def temp_workspace():
    path = make_tmp_path()
    try:
        yield path
    finally:
        shutil.rmtree(path)


def _vault(td):
    """Three active changes (a touches core; b touches core+api; c touches api) and
    one planned change d (touches core). a<->b share core; b<->c share api; a<->c
    share nothing; d is excluded from conflicts (not active)."""
    Path(td, "tropo.toml").write_text(
        '[base]\nallow_untyped = true\n'
        '[types.module]\nfolder = "modules"\n'
        '[types.change]\nfolder = "changes"\n'
        '[types.change.optional]\nstatus = "enum:active|done|planned"\n'
        'related_modules = "ref-list"\n')
    Path(td, "modules").mkdir()
    Path(td, "changes").mkdir()
    Path(td, "modules", "core.md").write_text("# Core\n")
    Path(td, "modules", "api.md").write_text("# Api\n")
    Path(td, "changes", "change-a.md").write_text(
        "---\nstatus: active\nrelated_modules: [core]\n---\n# A\n")
    Path(td, "changes", "change-b.md").write_text(
        "---\nstatus: active\nrelated_modules: [core, api]\n---\n# B\n")
    Path(td, "changes", "change-c.md").write_text(
        "---\nstatus: active\nrelated_modules: [api]\n---\n# C\n")
    Path(td, "changes", "change-d.md").write_text(
        "---\nstatus: planned\nrelated_modules: [core]\n---\n# D\n")


def _run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = exo.main(argv)
    return rc, buf.getvalue()


def _run_json(argv):
    rc, out = _run(argv)
    return rc, json.loads(out)


def test_roles_lists_seven():
    rc, data = _run_json(["roles", "--json"])
    assert rc == 0
    names = {r["role"] for r in data["roles"]}
    assert {"Orchestrator", "Builder", "Verifier", "Reviewer"} <= names
    assert len(data["roles"]) == 7


def test_board_groups_work_items_by_status():
    with temp_workspace() as td:
        _vault(td)
        _, data = _run_json(["board", "--root", str(td), "--json"])
        by_id = {i["id"]: i["status"] for i in data["items"]}
        assert by_id["change-a"] == "active"
        assert by_id["change-d"] == "planned"
        assert len(data["items"]) == 4


def test_conflicts_flags_shared_active_changes():
    with temp_workspace() as td:
        _vault(td)
        rc, data = _run_json(["conflicts", "--root", str(td), "--json"])
        assert rc == 0
        pairs = {(c["a"], c["b"]): c["shared"] for c in data["conflicts"]}
        assert pairs[("change-a", "change-b")] == ["core"]
        assert pairs[("change-b", "change-c")] == ["api"]
        assert ("change-a", "change-c") not in pairs   # disjoint targets
        assert all("change-d" not in (c["a"], c["b"]) for c in data["conflicts"])  # not active


def test_conflicts_empty_when_no_overlap():
    with temp_workspace() as td:
        # two active changes touching different modules -> no conflict
        Path(td, "tropo.toml").write_text(
            '[base]\nallow_untyped = true\n[types.change]\nfolder = "changes"\n'
            '[types.change.optional]\nstatus = "enum:active|done"\n'
            'related_modules = "string-list"\n')
        Path(td, "changes").mkdir()
        Path(td, "changes", "x.md").write_text("---\nstatus: active\n---\n# X\n")
        Path(td, "changes", "y.md").write_text("---\nstatus: active\n---\n# Y\n")
        rc, data = _run_json(["conflicts", "--root", str(td), "--json"])
        assert rc == 0
        assert data["conflicts"] == []
        assert set(data["active"]) == {"x", "y"}


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
