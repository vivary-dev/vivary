"""Gate surface: list workspace gates and approve/reject them (human-approval gate)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..security import require_token
from ..services import gates, registry

router = APIRouter(prefix="/api/workspaces", tags=["gates"], dependencies=[Depends(require_token)])


class Decision(BaseModel):
    approver: str | None = None


def _root(wsid: str) -> Path:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    return Path(ws["path"])


@router.get("/{wsid}/gates")
async def list_gates(wsid: str) -> list[dict]:
    return gates.list_gates(_root(wsid))


@router.post("/{wsid}/gates/{gid}/{decision}")
async def decide(wsid: str, gid: str, decision: str, body: Decision | None = None) -> dict:
    status = {"approve": "approved", "reject": "rejected"}.get(decision)
    if status is None:
        raise HTTPException(400, "decision must be approve or reject")
    updated = gates.set_status(_root(wsid), gid, status, body.approver if body else None)
    if updated is None:
        raise HTTPException(404, "gate not found")
    return updated
