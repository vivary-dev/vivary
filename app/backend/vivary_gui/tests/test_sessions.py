from fastapi.testclient import TestClient

from vivary_gui import config
from vivary_gui.main import create_app
from vivary_gui.security import AUTH_TOKEN
from vivary_gui.services import registry
from vivary_gui.services.agents.manager import manager

H = {"X-Vivary-Token": AUTH_TOKEN}


def _isolate_app_state(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setattr(config, "APP_DIR", home)
    monkeypatch.setattr(config, "REGISTRY_PATH", home / "registry.json")
    monkeypatch.setattr(config, "INDEX_DB", home / "index.db")
    manager.sessions.clear()


def test_create_session_accepts_tool_mode(tmp_path, monkeypatch):
    _isolate_app_state(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    wsid = registry.add_workspace(str(ws))["id"]
    client = TestClient(create_app())

    res = client.post(
        "/api/sessions",
        json={"workspace": wsid, "runtime": "echo", "tool_mode": "workspace-write"},
        headers=H,
    )

    assert res.status_code == 200, res.text
    sid = res.json()["id"]
    assert manager.sessions[sid].tool_mode == "workspace-write"


def test_create_session_rejects_unknown_tool_mode(tmp_path, monkeypatch):
    _isolate_app_state(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    wsid = registry.add_workspace(str(ws))["id"]
    client = TestClient(create_app())

    res = client.post(
        "/api/sessions",
        json={"workspace": wsid, "runtime": "echo", "tool_mode": "danger-full-access"},
        headers=H,
    )

    assert res.status_code == 400
    assert "tool_mode must be" in res.json()["detail"]
    assert manager.sessions == {}
