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

from .. import gates
from .. import approval
from ..sandbox.local import LocalProvider, Sandbox
from .base import RUNTIMES, AgentEvent, Runtime, validate_tool_mode

_SENTINEL = object()


def _open_gate_ids(cwd: Path) -> set[str]:
    """Ids of gates currently sitting at status `open` in this session's cwd."""
    try:
        return {g["id"] for g in gates.list_gates(cwd) if g["status"] == "open"}
    except Exception:
        return set()


def _build_resume_note(decided: list[dict]) -> str:
    """The follow-up prompt that tells a resumed agent what the human decided."""
    rejected = [g for g in decided if g.get("status") == "rejected"]
    if rejected:
        names = ", ".join(g.get("gate") or g["id"] for g in rejected)
        return f"The gate(s) were rejected: {names}. Do not perform the gated action; choose an alternative or stop."
    names = ", ".join(g.get("gate") or g["id"] for g in decided) or "the pending gate"
    return f"Approved: {names}. Proceed with the gated action."


@dataclass
class Session:
    id: str
    runtime: str
    workspace_id: str
    cwd: Path
    tool_mode: str = "read-only"
    sandbox: Sandbox | None = None
    agent_session_id: str | None = None   # the runtime's own conversation id (for resume)
    status: str = "idle"                  # idle | running | error | awaiting
    events: list[AgentEvent] = field(default_factory=list)
    queues: set[asyncio.Queue] = field(default_factory=set)
    proc: asyncio.subprocess.Process | None = None
    awaiting_gates: set[str] = field(default_factory=set)  # gates this session raised, pending decision
    approvals: dict[str, dict] = field(default_factory=dict)
    _open_before: set[str] = field(default_factory=set)    # open-gate snapshot taken before the turn

    def summary(self) -> dict:
        return {
            "id": self.id,
            "runtime": self.runtime,
            "workspace": self.workspace_id,
            "status": self.status,
            "tool_mode": self.tool_mode,
        }


class Manager:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.provider = LocalProvider()

    def create(
        self,
        workspace_root: Path,
        workspace_id: str,
        runtime_name: str,
        tool_mode: str = "read-only",
    ) -> str:
        rt: Runtime | None = RUNTIMES.get(runtime_name)
        if rt is None:
            raise KeyError(f"unknown runtime: {runtime_name}")
        mode = validate_tool_mode(tool_mode)
        if not rt.available():
            raise RuntimeError(f"runtime '{runtime_name}' is not installed / on PATH")
        sid = secrets.token_hex(6)
        sandbox = self.provider.create(workspace_root, sid)
        sess = Session(
            id=sid,
            runtime=runtime_name,
            workspace_id=workspace_id,
            cwd=sandbox.cwd,
            tool_mode=mode,
            sandbox=sandbox,
        )
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
        sess.awaiting_gates = set()
        sess._open_before = _open_gate_ids(sess.cwd)  # so we can spot gates this turn raises
        self._emit(sess, AgentEvent("user_msg", text))

        resume = sess.agent_session_id if rt.multi_turn else None
        proc = await asyncio.create_subprocess_exec(
            *rt.build_command(text, resume, sess.cwd, sess.tool_mode),
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
        new_open = _open_gate_ids(sess.cwd) - sess._open_before
        if new_open:  # the agent raised a gate and stopped — pause for human approval
            try:
                raised = [g for g in gates.list_gates(sess.cwd) if g["id"] in new_open]
            except Exception:
                raised = [{"id": gid} for gid in sorted(new_open)]
            sess.awaiting_gates = set(new_open)
            sess.status = "awaiting"
            self._emit(sess, AgentEvent("gates_open", f"{len(new_open)} gate(s) awaiting approval", meta={"gates": raised}))
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

    async def resume(self, sid: str) -> None:
        """After a raised gate is decided in the UI, continue the agent's conversation."""
        sess = self.sessions.get(sid)
        if sess is None:
            raise KeyError("session not found")
        if sess.status == "running":
            raise RuntimeError("session is busy with the current turn")
        if not sess.awaiting_gates:
            return  # nothing was awaiting (e.g. a duplicate resume) — no-op
        rt = RUNTIMES[sess.runtime]
        try:
            decided = [g for g in gates.list_gates(sess.cwd) if g["id"] in sess.awaiting_gates]
        except Exception:
            decided = []
        note = _build_resume_note(decided)
        sess.awaiting_gates = set()
        if not rt.multi_turn or not sess.agent_session_id:
            sess.status = "idle"
            self._emit(sess, AgentEvent("status", "gate decided — re-prompt the agent to continue (this runtime can't auto-resume)"))
            return
        await self.send(sid, note)  # reuses --resume plumbing + emits the note as the next turn

    def decide_approval(
        self,
        sid: str,
        approval_id: str,
        decision: str,
        scope: str = "global",
        pattern: str = "",
        steering: str = "",
    ) -> dict:
        sess = self.sessions.get(sid)
        if sess is None:
            raise KeyError("session not found")
        if decision not in {"allow_once", "allow_always", "reject_once", "reject_always"}:
            raise ValueError("invalid approval decision")
        status = "approved" if decision.startswith("allow") else "rejected"
        saved_rule = None
        rule_scope = scope if scope in {"command", "project", "global"} else "global"
        if decision in {"allow_always", "reject_always"}:
            pol = approval.load_policy()
            rule_decision = "allow" if decision == "allow_always" else "deny"
            rule_pattern = pattern or approval.safe_prefix(steering)
            if rule_pattern.strip() and rule_scope != "project":
                saved_rule = approval.add_rule(
                    pol,
                    rule_pattern,
                    rule_decision,  # type: ignore[arg-type]
                    rule_scope,  # type: ignore[arg-type]
                    steering,
                )
                approval.save_policy(pol)
        meta = {
            "id": approval_id,
            "status": status,
            "decision": decision,
            "scope": rule_scope,
            "pattern": pattern,
            "steering": steering,
            "saved_rule": saved_rule,
        }
        sess.approvals[approval_id] = meta
        self._emit(sess, AgentEvent("approval_request", f"approval {status}", meta=meta))
        return meta

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
