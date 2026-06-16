"""The strato state surface: STATE.md (parsed), SOUL.md, plus exo board + ozone review."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from ..bridge import cli
from ..security import require_token
from ..services import registry

router = APIRouter(prefix="/api/workspaces", tags=["state"], dependencies=[Depends(require_token)])


def _read(root: Path, name: str) -> str | None:
    p = root / name
    if p.is_file():
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
    return None


def _sections(md: str) -> dict[str, str]:
    """Split markdown into {heading: body} on '#'/'##' lines (display-first, lenient)."""
    out: dict[str, str] = {}
    current = "_preamble"
    buf: list[str] = []
    for line in md.splitlines():
        if line.lstrip().startswith("#"):
            if buf:
                out[current] = "\n".join(buf).strip()
            current = line.lstrip("#").strip() or current
            buf = []
        else:
            buf.append(line)
    if buf:
        out[current] = "\n".join(buf).strip()
    return {k: v for k, v in out.items() if v}


@router.get("/{wsid}/state")
async def state(wsid: str) -> dict:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    root = Path(ws["path"])

    state_md = _read(root, "STATE.md")
    result: dict = {
        "state": {"raw": state_md, "sections": _sections(state_md)} if state_md else None,
        "soul": _read(root, "SOUL.md"),
        "board": None,
        "review": None,
    }
    # Best-effort engine views — never fail the whole surface if one errors.
    try:
        result["board"] = cli.board(root)
    except Exception as exc:  # noqa: BLE001
        result["board"] = {"error": str(exc)}
    try:
        result["review"] = cli.review(root)
    except Exception as exc:  # noqa: BLE001
        result["review"] = {"error": str(exc)}
    return result
