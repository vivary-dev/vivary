"""WebSocket stream of a session's agent events.

The token travels in the WebSocket subprotocol offer (`token.<TOKEN>`), NOT the URL —
query strings leak into access logs, proxies, and browser history. The server reads it
from the handshake and accepts the constant `vivary` subprotocol, so the token never
appears in a response header either.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..security import AUTH_TOKEN
from ..services.agents import manager

router = APIRouter(tags=["ws"])
_PREFIX = "token."


@router.websocket("/ws/sessions/{sid}")
async def session_stream(websocket: WebSocket, sid: str) -> None:
    offered = websocket.scope.get("subprotocols", [])
    token = next((s[len(_PREFIX):] for s in offered if s.startswith(_PREFIX)), "")
    if not secrets.compare_digest(token, AUTH_TOKEN):
        await websocket.close(code=1008)  # policy violation
        return
    await websocket.accept(subprotocol="vivary" if "vivary" in offered else None)
    try:
        async for ev in manager.subscribe(sid):
            await websocket.send_json(ev.to_dict())
        await websocket.send_json({"type": "_end", "text": ""})
    except WebSocketDisconnect:
        pass
