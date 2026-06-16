"""Slice 2: file tree flags private files; file read is sandboxed to the workspace root."""

from fastapi.testclient import TestClient

from vivary_gui import config
from vivary_gui.main import create_app
from vivary_gui.security import AUTH_TOKEN

H = {"X-Vivary-Token": AUTH_TOKEN}


def test_tree_and_sandbox(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(config, "APP_DIR", home)
    monkeypatch.setattr(config, "REGISTRY_PATH", home / "registry.json")
    monkeypatch.setattr(config, "INDEX_DB", home / "index.db")

    ws = tmp_path / "ws"
    (ws / "memory").mkdir(parents=True)
    (ws / "STATE.md").write_text("# STATE\nFocus: ship slice 2\n", encoding="utf-8")
    (ws / "USER.md").write_text("secret identity\n", encoding="utf-8")

    from vivary_gui.services import registry

    wsid = registry.add_workspace(str(ws))["id"]
    client = TestClient(create_app())

    tree = client.get(f"/api/workspaces/{wsid}/tree", headers=H)
    assert tree.status_code == 200
    children = {c["name"]: c for c in tree.json()["children"]}
    assert "STATE.md" in children
    assert children["USER.md"]["private"] is True  # identity flagged

    ok = client.get(f"/api/workspaces/{wsid}/file", params={"path": "STATE.md"}, headers=H)
    assert ok.status_code == 200 and "Focus" in ok.json()["content"]

    # traversal is rejected
    esc = client.get(f"/api/workspaces/{wsid}/file", params={"path": "../../../Windows/win.ini"}, headers=H)
    assert esc.status_code == 400
