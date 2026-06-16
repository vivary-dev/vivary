"""Agent session lifecycle: list runtimes, create a conversation, send a turn, cancel."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..security import require_token
from ..services import registry
from ..services.agents import RUNTIMES, manager

router = APIRouter(prefix="/api", tags=["sessions"], dependencies=[Depends(require_token)])


class CreateSession(BaseModel):
    workspace: str
    runtime: str


class SendMessage(BaseModel):
    text: str


@router.get("/runtimes")
async def runtimes() -> list[dict]:
    return [{"name": r.name, "label": r.label, "available": bool(r.available()), "multi_turn": r.multi_turn} for r in RUNTIMES.values()]


@router.get("/sessions")
async def list_sessions() -> list[dict]:
    return [s.summary() for s in manager.sessions.values()]


@router.post("/sessions")
async def create_session(body: CreateSession) -> dict:
    ws = registry.get_workspace(body.workspace)
    if not ws:
        raise HTTPException(404, "workspace not found")
    try:
        sid = manager.create(Path(ws["path"]), body.workspace, body.runtime)
    except KeyError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return {"id": sid}


@router.post("/sessions/{sid}/send")
async def send_message(sid: str, body: SendMessage) -> dict:
    try:
        await manager.send(sid, body.text)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return {"ok": True}


@router.post("/sessions/{sid}/cancel")
async def cancel_session(sid: str) -> dict:
    if not await manager.cancel(sid):
        raise HTTPException(404, "session not found")
    return {"cancelled": sid}
