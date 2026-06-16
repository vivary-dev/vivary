"""Deterministic rich-event agent for GUI tests.

Enabled only through FixtureRuntime, which is hidden unless
VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1 is set before backend import.
"""

from __future__ import annotations

import json
import sys
import time

prompt = sys.argv[1] if len(sys.argv) > 1 else ""


def emit(type_: str, text: str = "", tool: str = "", meta: dict | None = None) -> None:
    print(json.dumps({"type": type_, "text": text, "tool": tool, "meta": meta or {}}), flush=True)


emit("status", "fixture run started")
emit("reasoning", "I will inspect the workspace before answering.", meta={"id": "reason_1", "status": "in_progress", "streaming": True})
time.sleep(0.05)
emit("reasoning", "I inspected the workspace and can answer cleanly.", meta={"id": "reason_1", "status": "completed", "streaming": False})
emit("tool", "Read README.md", "command", {
    "id": "tool_1",
    "kind": "read",
    "risk": "read",
    "status": "in_progress",
    "command": "Get-Content README.md",
    "target": "README.md",
})
time.sleep(0.05)
emit("tool", "Read README.md", "command", {
    "id": "tool_1",
    "kind": "read",
    "risk": "read",
    "status": "completed",
    "command": "Get-Content README.md",
    "target": "README.md",
    "aggregated_output": "# Vivary\nA standard plus scaffolder for agent workspaces.",
    "exit_code": 0,
})
emit("plan", meta={"id": "plan_1", "status": "completed", "items": [
    {"text": "Inspect workspace", "completed": True},
    {"text": "Answer without raw transcript noise", "completed": True},
]})
if "approval" in prompt.lower():
    emit("approval_request", meta={
        "id": "approval_1",
        "kind": "execute",
        "risk": "danger",
        "status": "pending",
        "command": "npm test",
        "options": [
            {"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "allow_always", "name": "Allow always", "kind": "allow_always"},
            {"optionId": "reject_once", "name": "Deny", "kind": "reject_once"},
        ],
    })
emit("file_change", meta={"id": "file_1", "status": "completed", "changes": [
    {"path": "OBSERVABILITY-REDESIGN.md", "kind": "update", "additions": 4, "deletions": 1},
]})
emit("text", f"Structured fixture answer for: {prompt}")
emit("result", meta={"input_tokens": 12, "cached_input_tokens": 4, "output_tokens": 8, "reasoning_output_tokens": 3})
