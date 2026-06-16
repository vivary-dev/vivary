"""Agent session lifecycle: list runtimes, create a conversation, send a turn, cancel."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..security import require_token
from ..services import gates, registry
from ..services.agents import RUNTIMES, manager

router = APIRouter(prefix="/api", tags=["sessions"], dependencies=[Depends(require_token)])


class CreateSession(BaseModel):
    workspace: str
    runtime: str
    tool_mode: str = "read-only"


class SendMessage(BaseModel):
    text: str


class GateDecision(BaseModel):
    approver: str | None = None


class ApprovalDecision(BaseModel):
    scope: str = "global"
    pattern: str = ""
    steering: str = ""


def _session(sid: str):
    sess = manager.sessions.get(sid)
    if sess is None:
        raise HTTPException(404, "session not found")
    return sess


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
        sid = manager.create(Path(ws["path"]), body.workspace, body.runtime, body.tool_mode)
    except KeyError as exc:
        raise HTTPException(400, str(exc))
    except ValueError as exc:
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


# Gates are decided against the session's own cwd (a git worktree under isolation), which
# is where the agent raised them — the workspace-scoped gate routes would miss them.
@router.get("/sessions/{sid}/gates")
async def session_gates(sid: str) -> list[dict]:
    return gates.list_gates(_session(sid).cwd)


@router.post("/sessions/{sid}/gates/{gid}/{decision}")
async def decide_session_gate(sid: str, gid: str, decision: str, body: GateDecision | None = None) -> dict:
    status = {"approve": "approved", "reject": "rejected"}.get(decision)
    if status is None:
        raise HTTPException(400, "decision must be approve or reject")
    try:
        updated = gates.set_status(_session(sid).cwd, gid, status, body.approver if body else None)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if updated is None:
        raise HTTPException(404, "gate not found")
    return updated


@router.post("/sessions/{sid}/resume")
async def resume_session(sid: str) -> dict:
    try:
        await manager.resume(sid)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return {"resumed": sid}


@router.post("/sessions/{sid}/approvals/{approval_id}/{decision}")
async def decide_approval(sid: str, approval_id: str, decision: str, body: ApprovalDecision | None = None) -> dict:
    try:
        return manager.decide_approval(
            sid,
            approval_id,
            decision,
            scope=body.scope if body else "global",
            pattern=body.pattern if body else "",
            steering=body.steering if body else "",
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
