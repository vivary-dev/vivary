"""Registry of known Vivary workspaces, persisted at ~/.vivary-gui/registry.json.

The registry is just pointers (id + name + absolute path). Workspace content stays on
disk; nothing is copied here.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .. import config
from ..bridge import loader


def _wsid(path: Path) -> str:
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:12]


def _load() -> list[dict]:
    if not config.REGISTRY_PATH.exists():
        return []
    try:
        data = json.loads(config.REGISTRY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save(items: list[dict]) -> None:
    config.ensure_app_dir()
    config.REGISTRY_PATH.write_text(json.dumps(items, indent=2), encoding="utf-8")


def list_workspaces() -> list[dict]:
    return _load()


def get_workspace(wsid: str) -> dict | None:
    return next((w for w in _load() if w["id"] == wsid), None)


def add_workspace(path: str, name: str | None = None) -> dict:
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"not a directory: {root}")

    # Best-effort health probe via the Vivary bridge; never fatal to registration.
    health: dict = {"ok": None, "errors": [], "warnings": [], "graph": {}}
    try:
        report = loader.doctor(root)
        health = {
            "ok": report.get("ok"),
            "errors": report.get("errors", []),
            "warnings": report.get("warnings", []),
            "graph": report.get("graph", {}),
        }
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        health = {"ok": None, "errors": [f"doctor unavailable: {exc}"], "warnings": [], "graph": {}}

    entry = {
        "id": _wsid(root),
        "name": name or root.name,
        "path": str(root),
        "health": health,
    }
    items = [w for w in _load() if w["id"] != entry["id"]]
    items.append(entry)
    _save(items)
    return entry


def remove_workspace(wsid: str) -> bool:
    items = _load()
    kept = [w for w in items if w["id"] != wsid]
    if len(kept) == len(items):
        return False
    _save(kept)
    return True
