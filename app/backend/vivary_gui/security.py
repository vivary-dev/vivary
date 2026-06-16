"""Per-launch auth token + the guard reused by every protected router.

Two layers: the custom header forces a CORS preflight (blocking cross-origin pages),
and the token blocks other local processes that could otherwise reach 127.0.0.1.
"""

from __future__ import annotations

import json
import os
import secrets

from fastapi import Header, HTTPException, status

from . import config


def _resolve_token() -> str:
    """Prefer an explicit env token, then reuse the last launch's token (so dev
    restarts don't invalidate the frontend's .env.local), else issue a fresh one."""
    env = os.environ.get("VIVARY_GUI_TOKEN")
    if env:
        return env
    try:
        if config.RUNTIME_PATH.exists():
            tok = json.loads(config.RUNTIME_PATH.read_text(encoding="utf-8")).get("token")
            if tok:
                return tok
    except (json.JSONDecodeError, OSError):
        pass
    return config.issue_token()


AUTH_TOKEN = _resolve_token()


async def require_token(x_vivary_token: str | None = Header(default=None)) -> None:
    if not x_vivary_token or not secrets.compare_digest(x_vivary_token, AUTH_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing or invalid token")
