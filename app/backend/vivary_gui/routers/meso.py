"""Meso Canvas routes: workspace map, layout persistence, selected context, and flows."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..security import require_token
from ..services import meso, registry

router = APIRouter(prefix="/api/workspaces", tags=["meso"], dependencies=[Depends(require_token)])


class LayoutBody(BaseModel):
    positions: dict[str, dict] = {}
    viewport: dict | None = None


class ContextBody(BaseModel):
    nodes: list[str] = []
    edges: list[str] = []


class NodeBody(BaseModel):
    id: str | None = None
    kind: str = "note"
    title: str | None = None
    text: str | None = None
    summary: str | None = None
    position: dict | None = None


class FlowRunBody(BaseModel):
    nodes: list[str] = []


def _root(wsid: str) -> Path:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    return Path(ws["path"])


@router.get("/{wsid}/meso")
async def get_meso(wsid: str) -> dict:
    return meso.build_model(wsid, _root(wsid))


@router.put("/{wsid}/meso/layout")
async def put_meso_layout(wsid: str, body: LayoutBody) -> dict:
    _root(wsid)
    return meso.save_layout(wsid, body.positions, body.viewport)


@router.post("/{wsid}/meso/context")
async def post_meso_context(wsid: str, body: ContextBody) -> dict:
    return meso.build_context(wsid, _root(wsid), body.nodes, body.edges)


@router.post("/{wsid}/meso/nodes")
async def post_meso_node(wsid: str, body: NodeBody) -> dict:
    _root(wsid)
    payload = body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True)
    try:
        return meso.add_node(wsid, payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/{wsid}/meso/flows/{flow_id}/run")
async def post_meso_flow_run(wsid: str, flow_id: str, body: FlowRunBody | None = None) -> dict:
    _root(wsid)
    return meso.run_flow(wsid, flow_id, body.nodes if body else [])
