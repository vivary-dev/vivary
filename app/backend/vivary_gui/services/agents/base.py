"""Agent runtimes normalize different CLIs into one rich, observable event stream.

A runtime knows how to (a) build the command for a turn (optionally resuming a prior
conversation) and (b) turn one line of output into zero or more AgentEvents — assistant
text, tool calls, results with token/cost usage. The manager spawns/streams uniformly
and drives multi-turn conversations.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Event types:
#   user_msg | text | tool_use | tool_result | result | status | error | turn_end | gates_open
#   reasoning | tool | file_change | plan | approval_request
@dataclass
class AgentEvent:
    type: str
    text: str = ""
    tool: str = ""
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"type": self.type, "text": self.text, "tool": self.tool, "meta": self.meta}


DEFAULT_TOOL_MODE = "read-only"
TOOL_MODES = {"read-only", "workspace-write"}


def validate_tool_mode(tool_mode: str | None) -> str:
    mode = (tool_mode or DEFAULT_TOOL_MODE).strip()
    if mode not in TOOL_MODES:
        raise ValueError("tool_mode must be read-only or workspace-write")
    return mode


class Runtime:
    name: str = "base"
    label: str = "Base"
    multi_turn: bool = False          # can it resume a conversation across turns?
    stderr_is_error: bool = True

    def available(self) -> str | None:
        raise NotImplementedError

    def build_command(
        self,
        prompt: str,
        resume: str | None = None,
        cwd: Path | None = None,
        tool_mode: str = DEFAULT_TOOL_MODE,
    ) -> list[str]:
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

    def build_command(
        self,
        prompt: str,
        resume: str | None = None,
        cwd: Path | None = None,
        tool_mode: str = DEFAULT_TOOL_MODE,
    ) -> list[str]:
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

    def build_command(
        self,
        prompt: str,
        resume: str | None = None,
        cwd: Path | None = None,
        tool_mode: str = DEFAULT_TOOL_MODE,
    ) -> list[str]:
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
    stderr_is_error = False  # codex may write progress/warnings to stderr

    def available(self) -> str | None:
        return shutil.which("codex")

    def build_command(
        self,
        prompt: str,
        resume: str | None = None,
        cwd: Path | None = None,
        tool_mode: str = DEFAULT_TOOL_MODE,
    ) -> list[str]:
        exe = shutil.which("codex") or "codex"
        sandbox = {
            "read-only": "read-only",
            "workspace-write": "workspace-write",
        }[validate_tool_mode(tool_mode)]
        cmd = [
            exe,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            sandbox,
        ]
        if cwd:
            cmd += ["-C", str(cwd)]
        # Resume stays disabled until the app-server/exec resume spike proves the
        # exact protocol shape for this GUI. We still capture thread_id for that slice.
        return cmd + ["--", prompt]

    def session_id_from(self, line: str) -> str | None:
        obj = _json(line)
        if obj and obj.get("type") == "thread.started":
            thread_id = obj.get("thread_id")
            return str(thread_id) if thread_id else None
        return None

    def parse(self, line: str) -> list[AgentEvent]:
        obj = _json(line)
        if obj is None:
            return [AgentEvent("status", line)] if line.strip() else []

        t = obj.get("type")
        if t == "turn.completed":
            usage = obj.get("usage", {}) or {}
            return [AgentEvent("result", meta={
                "input_tokens": usage.get("input_tokens"),
                "cached_input_tokens": usage.get("cached_input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "reasoning_output_tokens": usage.get("reasoning_output_tokens"),
            })]
        if t == "turn.failed":
            err = obj.get("error") or obj.get("message") or "Codex turn failed"
            return [AgentEvent("error", str(err))]
        if t == "error":
            msg = obj.get("message") or obj.get("error") or "Codex error"
            return [AgentEvent("error", str(msg))]
        if t in {"thread.started", "turn.started"}:
            return []

        if t in {"item.started", "item.updated", "item.completed"}:
            item = obj.get("item")
            if not isinstance(item, dict):
                return []
            return [_codex_item_event(t, item)]
        return []


_READ_COMMAND = re.compile(
    r"^(?:ls|dir|pwd|cat|type|more|less|head|tail|rg|grep|find|Get-ChildItem|Get-Content|Select-String|git\s+(?:status|diff|log|show|branch))\b",
    re.IGNORECASE,
)
_WRITE_COMMAND = re.compile(
    r"^(?:apply_patch|python\b.*(?:write_text|open\(.+[\"']w)|node\b.*writeFile|Set-Content|Add-Content|Out-File|git\s+(?:add|commit))\b",
    re.IGNORECASE,
)
_DELETE_COMMAND = re.compile(r"\b(?:rm|del|erase|rmdir|Remove-Item|git\s+clean)\b", re.IGNORECASE)
_NETWORK_COMMAND = re.compile(r"\b(?:curl|wget|Invoke-WebRequest|iwr|npm\s+install|pip\s+install|uv\s+add|pnpm\s+add)\b", re.IGNORECASE)


def _command_kind(command: str) -> str:
    cmd = _classifiable_command(command)
    if _DELETE_COMMAND.search(cmd):
        return "delete"
    if _NETWORK_COMMAND.search(cmd):
        return "network"
    if _WRITE_COMMAND.search(cmd):
        return "write"
    if _READ_COMMAND.search(cmd):
        return "read"
    return "execute"


def _classifiable_command(command: str) -> str:
    """Prefer the inner command when Codex wraps a shell call.

    On Windows, Codex often emits commands as a full powershell.exe invocation:
    `"C:\\...\\powershell.exe" -Command 'Get-Content README.md'`. The wrapper is
    execution machinery; risk/color should be derived from the inner command.
    """
    cmd = " ".join(command.split())
    marker = re.search(r"\s-(?:Command|c)\s+(.+)$", cmd, re.IGNORECASE)
    if marker and re.search(r"(?:powershell|pwsh)(?:\.exe)?", cmd[: marker.start()], re.IGNORECASE):
        inner = marker.group(1).strip()
        if len(inner) >= 2 and inner[0] == inner[-1] and inner[0] in {"'", '"'}:
            inner = inner[1:-1]
        return inner
    return cmd


def _status_from_item(event_type: str, item: dict) -> str:
    status = item.get("status")
    if status:
        return str(status)
    return {
        "item.started": "in_progress",
        "item.updated": "in_progress",
        "item.completed": "completed",
    }.get(event_type, "unknown")


def _item_id(item: dict) -> str:
    return str(item.get("id") or "")


def _codex_item_event(event_type: str, item: dict) -> AgentEvent:
    item_type = item.get("type")
    status = _status_from_item(event_type, item)
    base_meta = {
        "id": _item_id(item),
        "status": status,
        "codex_item_type": item_type,
        "streaming": event_type != "item.completed",
    }

    if item_type == "agent_message":
        return AgentEvent("text", str(item.get("text") or ""), meta=base_meta)

    if item_type == "reasoning":
        return AgentEvent("reasoning", str(item.get("text") or ""), meta=base_meta)

    if item_type == "command_execution":
        command = str(item.get("command") or "")
        kind = _command_kind(command)
        output = item.get("aggregated_output")
        return AgentEvent("tool", _tool_label(kind, command), tool="command", meta={
            **base_meta,
            "kind": kind,
            "risk": _risk_for_kind(kind),
            "command": command,
            "target": _command_target(command),
            "aggregated_output": output if output is not None else "",
            "exit_code": item.get("exit_code"),
        })

    if item_type == "file_change":
        changes = item.get("changes")
        return AgentEvent("file_change", _file_change_label(changes), meta={
            **base_meta,
            "changes": changes if isinstance(changes, list) else [],
        })

    if item_type == "mcp_tool_call":
        server = str(item.get("server") or "mcp")
        tool = str(item.get("tool") or "tool")
        return AgentEvent("tool", f"{server}.{tool}", tool=f"{server}.{tool}", meta={
            **base_meta,
            "kind": "tool",
            "risk": "write",
            "server": server,
            "arguments": item.get("arguments") or item.get("input") or {},
            "result": item.get("result"),
        })

    if item_type == "web_search":
        query = str(item.get("query") or "")
        return AgentEvent("tool", f"Search {query}".strip(), tool="web_search", meta={
            **base_meta,
            "kind": "network",
            "risk": "write",
            "query": query,
        })

    if item_type in {"todo_list", "plan_update"}:
        items = item.get("items")
        return AgentEvent("plan", meta={**base_meta, "items": items if isinstance(items, list) else []})

    if item_type == "error":
        return AgentEvent("error", str(item.get("message") or item.get("text") or "Codex item error"), meta=base_meta)

    return AgentEvent("status", f"Codex item: {item_type}", meta=base_meta)


def _risk_for_kind(kind: str) -> str:
    if kind == "read":
        return "read"
    if kind in {"write", "network"}:
        return "write"
    return "danger"


def _tool_label(kind: str, command: str) -> str:
    verb = {
        "read": "Read",
        "write": "Write",
        "network": "Network",
        "delete": "Delete",
        "execute": "Run",
    }.get(kind, "Tool")
    target = _command_target(command)
    return f"{verb} {target}".strip()


def _command_target(command: str) -> str:
    parts = _classifiable_command(command).split()
    if not parts:
        return ""
    return " ".join(parts[:4]) + (" …" if len(parts) > 4 else "")


def _file_change_label(changes) -> str:
    if not isinstance(changes, list) or not changes:
        return "Files changed"
    counts: dict[str, int] = {}
    for c in changes:
        if isinstance(c, dict):
            kind = str(c.get("kind") or "change")
            counts[kind] = counts.get(kind, 0) + 1
    return ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "Files changed"


class FixtureRuntime(Runtime):
    """Deterministic rich-event runtime for frontend/e2e tests only.

    It is gated by VIVARY_GUI_ENABLE_FIXTURE_RUNTIME so production runs do not expose
    a fake agent choice.
    """

    name = "fixture"
    label = "Fixture (test)"
    multi_turn = False
    stderr_is_error = True

    def available(self) -> str | None:
        return sys.executable

    def build_command(
        self,
        prompt: str,
        resume: str | None = None,
        cwd: Path | None = None,
        tool_mode: str = DEFAULT_TOOL_MODE,
    ) -> list[str]:
        return [sys.executable, str(Path(__file__).parent / "_fixture_agent.py"), prompt]

    def parse(self, line: str) -> list[AgentEvent]:
        obj = _json(line)
        if obj is None:
            return []
        t = obj.get("type")
        if not isinstance(t, str):
            return []
        return [AgentEvent(t, str(obj.get("text") or ""), str(obj.get("tool") or ""), obj.get("meta") if isinstance(obj.get("meta"), dict) else {})]


_runtime_list: list[Runtime] = [ClaudeCodeRuntime(), CodexRuntime(), EchoRuntime()]
if os.environ.get("VIVARY_GUI_ENABLE_FIXTURE_RUNTIME") == "1":
    _runtime_list.append(FixtureRuntime())

RUNTIMES: dict[str, Runtime] = {r.name: r for r in _runtime_list}
