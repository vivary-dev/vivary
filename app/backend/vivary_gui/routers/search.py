"""Full-text search over the workspace index."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..index import indexer
from ..security import require_token

router = APIRouter(prefix="/api", tags=["search"], dependencies=[Depends(require_token)])


@router.get("/search")
async def search(
    q: str,
    workspace: str | None = None,
    limit: int = 25,
    include_private: bool = True,
) -> dict:
    hits = indexer.search(q, workspace_id=workspace, limit=limit, include_private=include_private)
    return {"query": q, "count": len(hits), "hits": hits}
