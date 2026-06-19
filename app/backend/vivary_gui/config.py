"""Runtime configuration and per-launch state.

App state lives under ~/.vivary-gui/ (overridable via VIVARY_GUI_HOME): the workspace
registry, the rebuildable search index, and this launch's runtime descriptor. No
workspace content is stored here — plain files remain the source of truth.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

APP_DIR = Path(os.environ.get("VIVARY_GUI_HOME", Path.home() / ".vivary-gui"))
REGISTRY_PATH = APP_DIR / "registry.json"
RUNTIME_PATH = APP_DIR / "runtime.json"
INDEX_DB = APP_DIR / "index.db"
MESO_DIR = APP_DIR / "canvases"

DEFAULT_HOST = os.environ.get("VIVARY_GUI_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("VIVARY_GUI_PORT", "8765"))

# CORS: the Vite dev server only — never "*", so a custom-header preflight blocks
# cross-origin pages.
DEV_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]


def ensure_app_dir() -> Path:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    return APP_DIR


def issue_token() -> str:
    return secrets.token_urlsafe(32)


def write_runtime(host: str, port: int, token: str) -> None:
    ensure_app_dir()
    RUNTIME_PATH.write_text(
        json.dumps({"host": host, "port": port, "token": token}, indent=2),
        encoding="utf-8",
    )
