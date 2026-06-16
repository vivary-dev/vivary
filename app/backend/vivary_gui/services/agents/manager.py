"""Conversational agent sessions.

A session is a persistent conversation: created idle, then `send()` runs one turn
(resuming the agent's prior context for multi-turn runtimes) and streams rich events to
all subscribers. The subscription stays open across turns for live observability; it ends
only when the session is ended.
"""

from __future__ import annotations

import asyncio
import secrets
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..sandbox.local import LocalProvider, Sandbox
from .base import RUNTIMES, AgentEvent, Runtime

_SENTINEL = object()


@dataclass
class Session:
    id: str
    runtime: str
    workspace_id: str
    cwd: Path
    sandbox: Sandbox | None = None
    agent_session_id: str | None = None   # the runtime's own conversation id (for resume)
    status: str = "idle"                  # idle | running | error
    events: list[AgentEvent] = field(default_factory=list)
    queues: set[asyncio.Queue] = field(default_factory=set)
    proc: asyncio.subprocess.Process | None = None

    def summary(self) -> dict:
        return {"id": self.id, "runtime": self.runtime, "workspace": self.workspace_id, "status": self.status}


class Manager:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.provider = LocalProvider()

    def create(self, workspace_root: Path, workspace_id: str, runtime_name: str) -> str:
        rt: Runtime | None = RUNTIMES.get(runtime_name)
        if rt is None:
            raise KeyError(f"unknown runtime: {runtime_name}")
        if not rt.available():
            raise RuntimeError(f"runtime '{runtime_name}' is not installed / on PATH")
        sid = secrets.token_hex(6)
        sandbox = self.provider.create(workspace_root, sid)
        sess = Session(id=sid, runtime=runtime_name, workspace_id=workspace_id, cwd=sandbox.cwd, sandbox=sandbox)
        self.sessions[sid] = sess
        self._emit(sess, AgentEvent("status", "session created"))
        return sid

    def _emit(self, sess: Session, ev: AgentEvent) -> None:
        sess.events.append(ev)
        for q in list(sess.queues):
            q.put_nowait(ev)

    async def send(self, sid: str, text: str) -> None:
        sess = self.sessions.get(sid)
        if sess is None:
            raise KeyError("session not found")
        if sess.status == "running":
            raise RuntimeError("session is busy with the current turn")
        rt = RUNTIMES[sess.runtime]
        sess.status = "running"
        self._emit(sess, AgentEvent("user_msg", text))

        resume = sess.agent_session_id if rt.multi_turn else None
        proc = await asyncio.create_subprocess_exec(
            *rt.build_command(text, resume),
            cwd=str(sess.cwd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        sess.proc = proc
        asyncio.create_task(self._run_turn(sess, rt, proc))

    async def _run_turn(self, sess: Session, rt: Runtime, proc: asyncio.subprocess.Process) -> None:
        async def read(stream, is_stderr: bool) -> None:
            async for raw in stream:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                if not is_stderr:
                    found = rt.session_id_from(line)
                    if found:
                        sess.agent_session_id = found
                if is_stderr and rt.stderr_is_error:
                    self._emit(sess, AgentEvent("error", line))
                else:
                    for ev in rt.parse(line):
                        self._emit(sess, ev)

        try:
            await asyncio.gather(read(proc.stdout, False), read(proc.stderr, True))
            rc = await proc.wait()
        finally:
            sess.proc = None
        sess.status = "error" if rc != 0 else "idle"
        self._emit(sess, AgentEvent("turn_end", f"exit {rc}"))

    async def subscribe(self, sid: str):
        sess = self.sessions.get(sid)
        if sess is None:
            return
        q: asyncio.Queue = asyncio.Queue()
        for ev in list(sess.events):  # replay history so a (re)connect sees the full thread
            q.put_nowait(ev)
        sess.queues.add(q)
        try:
            while True:
                item = await q.get()
                if item is _SENTINEL:
                    break
                yield item
        finally:
            sess.queues.discard(q)

    async def cancel(self, sid: str) -> bool:
        """Kill the in-flight turn (the conversation stays alive)."""
        sess = self.sessions.get(sid)
        if sess is None:
            return False
        if sess.proc and sess.proc.returncode is None:
            subprocess.run(["taskkill", "/PID", str(sess.proc.pid), "/T", "/F"], capture_output=True)
        sess.status = "idle"
        return True

    async def end(self, sid: str) -> None:
        await self.cancel(sid)
        sess = self.sessions.get(sid)
        if sess:
            if sess.sandbox:
                sess.sandbox.teardown()
            for q in list(sess.queues):
                q.put_nowait(_SENTINEL)

    async def shutdown(self) -> None:
        for sid in list(self.sessions):
            await self.end(sid)


manager = Manager()
