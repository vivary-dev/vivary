"""FastAPI application factory for the Vivary GUI backend.

Slice 1: workspace registry + a SQLite FTS5 search index over workspace markdown +
sandboxed file read. Binds 127.0.0.1 only; everything but /api/health requires the
per-launch token.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .routers import files, gates, graph, meso, search, sessions, state, workspaces, ws
from .security import AUTH_TOKEN, require_token
from .services.agents import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.write_runtime(config.DEFAULT_HOST, config.DEFAULT_PORT, AUTH_TOKEN)
    print(f"[vivary-gui] http://{config.DEFAULT_HOST}:{config.DEFAULT_PORT}")
    print(f"[vivary-gui] auth token written to {config.RUNTIME_PATH}")
    yield
    await manager.shutdown()  # kill any live agent processes on exit


def create_app() -> FastAPI:
    app = FastAPI(title="Vivary GUI", version="0.0.1", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.DEV_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok", "service": "vivary-gui", "version": "0.0.1"}

    @app.get("/api/ping", dependencies=[Depends(require_token)])
    async def ping() -> dict:
        return {"pong": True}

    app.include_router(workspaces.router)
    app.include_router(search.router)
    app.include_router(files.router)
    app.include_router(state.router)
    app.include_router(graph.router)
    app.include_router(meso.router)
    app.include_router(sessions.router)
    app.include_router(gates.router)
    app.include_router(ws.router)
    return app


app = create_app()
