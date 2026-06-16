"""Phase 0 smoke: health is open, ping is token-guarded."""

from fastapi.testclient import TestClient

from vivary_gui.main import create_app
from vivary_gui.security import AUTH_TOKEN

client = TestClient(create_app())


def test_health_open():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_ping_requires_token():
    assert client.get("/api/ping").status_code == 401
    assert client.get("/api/ping", headers={"X-Vivary-Token": "wrong"}).status_code == 401


def test_ping_with_token():
    res = client.get("/api/ping", headers={"X-Vivary-Token": AUTH_TOKEN})
    assert res.status_code == 200 and res.json() == {"pong": True}
