"""Knowledge-graph views: typed graph JSON, blast radius, and the self-contained
interactive HTML graph from `tropo view`."""

from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from .. import config
from ..bridge import cli
from ..security import require_token
from ..services import registry

router = APIRouter(prefix="/api/workspaces", tags=["graph"], dependencies=[Depends(require_token)])


def _root(wsid: str) -> Path:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    return Path(ws["path"])


@router.get("/{wsid}/graph")
async def graph(wsid: str) -> dict:
    try:
        return cli.graph(_root(wsid))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


@router.get("/{wsid}/blast")
async def blast(wsid: str, node: str) -> dict:
    try:
        return cli.blast(_root(wsid), node)
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


@router.get("/{wsid}/conflicts")
async def conflicts(wsid: str) -> dict:
    try:
        return cli.conflicts(_root(wsid))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


@router.get("/{wsid}/graph/view", response_class=HTMLResponse)
async def graph_view(wsid: str) -> HTMLResponse:
    root = _root(wsid)
    config.ensure_app_dir()
    out = config.APP_DIR / f"graph-{hashlib.sha1(str(root).encode()).hexdigest()[:8]}.html"
    try:
        html = cli.view_html(root, out)
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return HTMLResponse(content=html)
