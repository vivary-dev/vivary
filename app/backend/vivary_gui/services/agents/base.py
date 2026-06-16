"""Agent runtimes normalize different CLIs into one rich, observable event stream.

A runtime knows how to (a) build the command for a turn (optionally resuming a prior
conversation) and (b) turn one line of output into zero or more AgentEvents — assistant
text, tool calls, results with token/cost usage. The manager spawns/streams uniformly
and drives multi-turn conversations.
"""

from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Event types:
#   user_msg | text | tool_use | tool_result | result | status | error | turn_end | gates_open
@dataclass
class AgentEvent:
    type: str
    text: str = ""
    tool: str = ""
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"type": self.type, "text": self.text, "tool": self.tool, "meta": self.meta}


class Runtime:
    name: str = "base"
    label: str = "Base"
    multi_turn: bool = False          # can it resume a conversation across turns?
    stderr_is_error: bool = True

    def available(self) -> str | None:
        raise NotImplementedError

    def build_command(self, prompt: str, resume: str | None = None) -> list[str]:
        raise NotImplementedError

    def parse(self, line: str) -> list[AgentEvent]:
        raise NotImplementedError

    def session_id_from(self, line: str) -> str | None:
        return None


def _json(line: str) -> dict | None:
    try:
        obj = json.loads(line)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _result_preview(content) -> str:
    """A short, one-line preview of a tool_result (which may be a string or a list of
    content blocks) for the inline tool card."""
    text = ""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    text = " ".join(text.split())
    return text[:160] + ("…" if len(text) > 160 else "")


def _tool_summary(name: str, inp: dict) -> str:
    """A short, human label for a tool call (for the activity feed)."""
    if not isinstance(inp, dict):
        return name
    for key in ("file_path", "path", "command", "pattern", "url", "query"):
        if key in inp:
            val = str(inp[key])
            return f"{name}: {val[:80]}"
    return name


class EchoRuntime(Runtime):
    """Deterministic, dependency-free runtime for proving the chat pipeline (no tokens)."""

    name = "echo"
    label = "Echo (test)"
    multi_turn = False

    def available(self) -> str | None:
        return sys.executable

    def build_command(self, prompt: str, resume: str | None = None) -> list[str]:
        # Safe from flag-smuggling: Python doesn't treat args after the script path as
        # interpreter flags, and _echo_agent.py reads sys.argv[1] literally.
        return [sys.executable, str(Path(__file__).parent / "_echo_agent.py"), prompt]

    def parse(self, line: str) -> list[AgentEvent]:
        obj = _json(line)
        if obj is None:
            return []
        t = obj.get("type")
        if t == "message":
            return [AgentEvent("text", obj.get("text", ""))]
        if t == "status":
            return [AgentEvent("status", obj.get("text", ""))]
        return []  # 'done' -> manager emits turn_end


class ClaudeCodeRuntime(Runtime):
    name = "claude"
    label = "Claude Code"
    multi_turn = True

    def available(self) -> str | None:
        return shutil.which("claude")

    def build_command(self, prompt: str, resume: str | None = None) -> list[str]:
        exe = shutil.which("claude") or "claude"
        cmd = [exe, "-p", "--output-format", "stream-json", "--verbose",
               "--permission-mode", "acceptEdits"]
        if resume:
            cmd += ["--resume", resume]
        # `--` ends option parsing so a prompt starting with '-' can't smuggle flags.
        cmd += ["--", prompt]
        return cmd

    def session_id_from(self, line: str) -> str | None:
        obj = _json(line)
        return obj.get("session_id") if obj else None

    def parse(self, line: str) -> list[AgentEvent]:
        obj = _json(line)
        if obj is None:
            return []
        t = obj.get("type")
        events: list[AgentEvent] = []
        if t == "assistant":
            for b in obj.get("message", {}).get("content", []):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    events.append(AgentEvent("text", b["text"]))
                elif b.get("type") == "tool_use":
                    name = b.get("name", "tool")
                    events.append(AgentEvent("tool_use", _tool_summary(name, b.get("input", {})), tool=name, meta={"input": b.get("input", {})}))
        elif t == "user":
            for b in obj.get("message", {}).get("content", []):
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    events.append(AgentEvent("tool_result", _result_preview(b.get("content"))))
        elif t == "result":
            usage = obj.get("usage", {}) or {}
            events.append(AgentEvent("result", obj.get("result", ""), meta={
                "cost": obj.get("total_cost_usd"),
                "duration_ms": obj.get("duration_ms"),
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            }))
        elif t == "system" and obj.get("subtype") == "init":
            events.append(AgentEvent("status", "session ready"))
        return events


class CodexRuntime(Runtime):
    name = "codex"
    label = "Codex"
    multi_turn = False
    stderr_is_error = False  # codex exec writes its transcript to stderr

    def available(self) -> str | None:
        return shutil.which("codex")

    def build_command(self, prompt: str, resume: str | None = None) -> list[str]:
        exe = shutil.which("codex") or "codex"
        # `--` ends option parsing so the prompt can't smuggle flags.
        return [exe, "exec", "--", prompt]

    def parse(self, line: str) -> list[AgentEvent]:
        return [AgentEvent("text", line)] if line.strip() else []


RUNTIMES: dict[str, Runtime] = {r.name: r for r in (ClaudeCodeRuntime(), CodexRuntime(), EchoRuntime())}
