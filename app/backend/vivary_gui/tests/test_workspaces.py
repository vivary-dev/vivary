from fastapi.testclient import TestClient

from vivary_gui import config
from vivary_gui.main import create_app
from vivary_gui.security import AUTH_TOKEN

H = {"X-Vivary-Token": AUTH_TOKEN}


def _isolate_app_state(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setattr(config, "APP_DIR", home)
    monkeypatch.setattr(config, "REGISTRY_PATH", home / "registry.json")
    monkeypatch.setattr(config, "INDEX_DB", home / "index.db")


def test_scaffold_workspace_creates_registers_and_indexes(tmp_path, monkeypatch):
    _isolate_app_state(tmp_path, monkeypatch)
    target = tmp_path / "control-workspace"
    client = TestClient(create_app())

    res = client.post(
        "/api/workspaces/scaffold",
        json={"path": str(target), "name": "Control Workspace", "preset": "coding"},
        headers=H,
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "Control Workspace"
    assert body["path"] == str(target.resolve())
    assert body["health"]["ok"] is True
    assert body["index"]["indexed"] > 0
    assert body["scaffold"]["created"]

    for rel in ("tropo.toml", "AGENTS.md", "STATE.md"):
        assert (target / rel).exists()

    listed = client.get("/api/workspaces", headers=H)
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == body["id"]


def test_scaffold_workspace_refuses_existing_files(tmp_path, monkeypatch):
    _isolate_app_state(tmp_path, monkeypatch)
    target = tmp_path / "control-workspace"
    target.mkdir()
    existing = target / "AGENTS.md"
    existing.write_text("keep me\n", encoding="utf-8")
    client = TestClient(create_app())

    res = client.post(
        "/api/workspaces/scaffold",
        json={"path": str(target), "preset": "coding"},
        headers=H,
    )

    assert res.status_code == 400
    assert "refusing to overwrite existing scaffold file" in res.json()["detail"]
    assert existing.read_text(encoding="utf-8") == "keep me\n"


def test_scaffold_workspace_rejects_invalid_preset(tmp_path, monkeypatch):
    _isolate_app_state(tmp_path, monkeypatch)
    client = TestClient(create_app())

    res = client.post(
        "/api/workspaces/scaffold",
        json={"path": str(tmp_path / "bad-preset"), "preset": "not-a-preset"},
        headers=H,
    )

    assert res.status_code == 400
    assert "unknown preset" in res.json()["detail"]
