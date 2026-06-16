"""Sandboxed file read within a registered workspace."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from ..index.indexer import NEVER, SKIP_DIRS, _is_private
from ..security import require_token
from ..services import registry

router = APIRouter(prefix="/api/workspaces", tags=["files"], dependencies=[Depends(require_token)])


def _resolve_within(root: Path, rel: str) -> Path:
    """Resolve rel under root, rejecting traversal / symlink escapes."""
    target = (root / rel).resolve()
    root = root.resolve()
    if root != target and root not in target.parents:
        raise HTTPException(400, "path escapes workspace")
    return target


def _build_tree(dir_path: Path, root: Path) -> list[dict]:
    """Recursive file tree, skipping noise dirs and flagging private files."""
    entries = []
    try:
        children = sorted(dir_path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return entries
    for p in children:
        if p.name in SKIP_DIRS:
            continue
        rel = p.relative_to(root)
        if p.is_dir():
            entries.append({
                "name": p.name,
                "path": str(rel).replace("\\", "/"),
                "type": "dir",
                "children": _build_tree(p, root),
            })
        else:
            entries.append({
                "name": p.name,
                "path": str(rel).replace("\\", "/"),
                "type": "file",
                "private": _is_private(rel) or rel.name in NEVER,
            })
    return entries


@router.get("/{wsid}/tree")
async def tree(wsid: str) -> dict:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    root = Path(ws["path"]).resolve()
    return {"name": root.name, "path": "", "type": "dir", "children": _build_tree(root, root)}


@router.get("/{wsid}/file")
async def read_file(wsid: str, path: str) -> dict:
    ws = registry.get_workspace(wsid)
    if not ws:
        raise HTTPException(404, "workspace not found")
    target = _resolve_within(Path(ws["path"]), path)
    if not target.is_file():
        raise HTTPException(404, "file not found")
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise HTTPException(500, f"read failed: {exc}")
    return {"path": path, "content": content}
