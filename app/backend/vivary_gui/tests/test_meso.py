"""Meso Canvas: derived workspace map, app-owned layout, and context bundles."""

from pathlib import Path

from fastapi.testclient import TestClient

from vivary_gui import config
from vivary_gui.main import create_app
from vivary_gui.security import AUTH_TOKEN
from vivary_gui.services import meso, registry
from vivary_gui.services.agents.base import AgentEvent
from vivary_gui.services.agents.manager import Session, manager

H = {"X-Vivary-Token": AUTH_TOKEN}


def _configure_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(config, "APP_DIR", home)
    monkeypatch.setattr(config, "REGISTRY_PATH", home / "registry.json")
    monkeypatch.setattr(config, "INDEX_DB", home / "index.db")
    monkeypatch.setattr(config, "MESO_DIR", home / "canvases")
    return home


def _workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / "src").mkdir(parents=True)
    (ws / "memory").mkdir()
    (ws / "gates").mkdir()
    (ws / "README.md").write_text("# Root Doc\nA useful entrypoint.\n", encoding="utf-8")
    (ws / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
    (ws / "memory" / "MEMORY.md").write_text("# Private Memory\n", encoding="utf-8")
    (ws / "USER.md").write_text("private identity\n", encoding="utf-8")
    (ws / "gates" / "ship.md").write_text(
        "---\nstatus: open\ngate: Ship approval\ncommand_intent: merge branch\n---\n",
        encoding="utf-8",
    )
    return ws


def _fake_graph(root):
    return {
        "nodes": [{"id": "architecture", "type": "module", "path": "README.md"}],
        "edges": [],
    }


def test_meso_model_derives_workspace_objects_and_sessions(tmp_path, monkeypatch):
    _configure_home(tmp_path, monkeypatch)
    monkeypatch.setattr(meso.cli, "graph", _fake_graph)
    manager.sessions.clear()
    wsid = registry.add_workspace(str(_workspace(tmp_path)))["id"]
    manager.sessions["s1"] = Session(
        id="s1",
        runtime="echo",
        workspace_id=wsid,
        cwd=tmp_path,
        status="running",
        events=[AgentEvent("plan", "Check docs"), AgentEvent("file_change", "Updated README")],
    )

    try:
        client = TestClient(create_app())
        res = client.get(f"/api/workspaces/{wsid}/meso", headers=H)
        assert res.status_code == 200
        data = res.json()
        nodes = {n["id"]: n for n in data["nodes"]}
        assert nodes["doc:README.md"]["summary"] == "# Root Doc"
        assert nodes["file:src/app.py"]["kind"] == "file"
        assert nodes["doc:memory/MEMORY.md"]["private"] is True
        assert nodes["gate:ship"]["status"] == "blocked"
        assert nodes["graph:architecture"]["graphId"] == "architecture"
        assert nodes["run:s1"]["summary"] == "running"
        assert any(n["kind"] == "plan" for n in data["nodes"])
        assert any(n["kind"] == "diff" for n in data["nodes"])
    finally:
        manager.sessions.clear()


def test_meso_layout_context_and_owned_note_persist(tmp_path, monkeypatch):
    _configure_home(tmp_path, monkeypatch)
    monkeypatch.setattr(meso.cli, "graph", _fake_graph)
    wsid = registry.add_workspace(str(_workspace(tmp_path)))["id"]
    client = TestClient(create_app())

    saved = client.put(
        f"/api/workspaces/{wsid}/meso/layout",
        headers=H,
        json={"positions": {"doc:README.md": {"x": 42, "y": 84}}},
    )
    assert saved.status_code == 200
    assert saved.json()["saved"] == 1
    model = client.get(f"/api/workspaces/{wsid}/meso", headers=H).json()
    readme = next(n for n in model["nodes"] if n["id"] == "doc:README.md")
    assert readme["position"] == {"x": 42.0, "y": 84.0}

    note = client.post(
        f"/api/workspaces/{wsid}/meso/nodes",
        headers=H,
        json={"kind": "note", "id": "note:1", "title": "Review note", "text": "Pin this."},
    )
    assert note.status_code == 200
    assert note.json()["id"] == "note:1"

    ctx = client.post(
        f"/api/workspaces/{wsid}/meso/context",
        headers=H,
        json={"nodes": ["doc:README.md", "doc:memory/MEMORY.md", "graph:architecture"]},
    )
    assert ctx.status_code == 200
    assert ctx.json()["paths"] == ["README.md", "memory/MEMORY.md"]
    assert ctx.json()["graphIds"] == ["architecture"]
    assert "private path" in ctx.json()["summary"]
