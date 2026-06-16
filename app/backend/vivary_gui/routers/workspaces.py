"""Workspace registry + (re)indexing endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..bridge import loader
from ..index import indexer
from ..security import require_token
from ..services import registry

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"], dependencies=[Depends(require_token)])


class AddWorkspace(BaseModel):
    path: str
    name: str | None = None


class ScaffoldWorkspace(BaseModel):
    path: str
    name: str | None = None
    preset: str = "coding"
    obsidian: bool = False


@router.get("")
async def list_workspaces() -> list[dict]:
    return registry.list_workspaces()


@router.post("")
async def add_workspace(body: AddWorkspace) -> dict:
    try:
        entry = registry.add_workspace(body.path, body.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    # Index immediately so search works right after adding.
    try:
        entry["index"] = indexer.reindex(entry["id"], entry["path"])
    except indexer.FTS5Unavailable as exc:
        raise HTTPException(500, str(exc))
    return entry


@router.post("/scaffold")
async def scaffold_workspace(body: ScaffoldWorkspace) -> dict:
    try:
        scaffold = loader.scaffold(
            body.path,
            preset=body.preset,
            obsidian=body.obsidian,
        )
        entry = registry.add_workspace(body.path, body.name)
    except (loader.WorkspaceScaffoldError, ValueError) as exc:
        raise HTTPException(400, str(exc))

    # Index immediately so search works right after creating the workspace.
    try:
        entry["index"] = indexer.reindex(entry["id"], entry["path"])
    except indexer.FTS5Unavailable as exc:
        raise HTTPException(500, str(exc))
    entry["scaffold"] = {"created": scaffold["created"]}
    return entry


@router.delete("/{wsid}")
async def remove_workspace(wsid: str) -> dict:
    if not registry.remove_workspace(wsid):
        raise HTTPException(404, "workspace not found")
    return {"removed": wsid}


@router.post("/{wsid}/reindex")
async def reindex(wsid: str) -> dict:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    try:
        return indexer.reindex(wsid, ws["path"])
    except indexer.FTS5Unavailable as exc:
        raise HTTPException(500, str(exc))
