"""Approval policy for agent actions.

This is deterministic harness logic. The model may describe an action, but it does not
get to label its own risk or decide whether protected paths are auto-approved.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .. import config

Mode = Literal["manual", "auto", "yolo"]
Decision = Literal["allow", "ask", "deny"]
Scope = Literal["command", "project", "global"]

PROTECTED_PARTS = {".git", ".env", ".codex", ".claude", ".agents"}
PROTECTED_FILES = {"AGENTS.md", "CLAUDE.md", "pyproject.toml", "package.json", "package-lock.json"}
READ_RE = re.compile(r"^(?:ls|dir|pwd|cat|type|Get-Content|rg|grep|find|git\s+(?:status|diff|log|show))\b", re.IGNORECASE)
WRITE_RE = re.compile(r"^(?:apply_patch|Set-Content|Add-Content|Out-File|git\s+(?:add|commit)|npm\s+install|pip\s+install)\b", re.IGNORECASE)
DELETE_RE = re.compile(r"\b(?:rm|del|erase|rmdir|Remove-Item|git\s+clean)\b", re.IGNORECASE)
NETWORK_RE = re.compile(r"\b(?:curl|wget|Invoke-WebRequest|iwr|npm\s+install|pip\s+install|uv\s+add|pnpm\s+add)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Action:
    kind: str
    command: str = ""
    target: str = ""
    paths: tuple[str, ...] = ()


def default_policy() -> dict:
    return {"mode": "auto", "rules": [], "circuit_breaker": {"per_turn": 20}}


def load_policy(path: Path | None = None) -> dict:
    p = path or config.POLICY_PATH
    if not p.exists():
        return default_policy()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default_policy()
    policy = default_policy()
    if isinstance(data, dict):
        policy.update({k: v for k, v in data.items() if k in policy})
    if policy.get("mode") not in {"manual", "auto", "yolo"}:
        policy["mode"] = "auto"
    if not isinstance(policy.get("rules"), list):
        policy["rules"] = []
    return policy


def save_policy(policy: dict, path: Path | None = None) -> None:
    p = path or config.POLICY_PATH
    config.ensure_app_dir()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(policy, indent=2), encoding="utf-8")


def classify(action: Action) -> str:
    kind = action.kind.lower()
    command = _classifiable_command(action.command)
    if kind in {"delete", "destructive"} or DELETE_RE.search(command):
        return "danger"
    if is_protected(action):
        return "protected"
    if kind in {"network"} or NETWORK_RE.search(command):
        return "write"
    if kind in {"write", "edit", "file_change"} or WRITE_RE.search(command):
        return "write"
    if kind == "read" or READ_RE.search(command):
        return "read"
    if kind in {"execute", "command"}:
        return "danger"
    return "write"


def _normalize_command(command: str) -> str:
    return " ".join(command.split())


def _classifiable_command(command: str) -> str:
    cmd = _normalize_command(command)
    marker = re.search(r"\s-(?:Command|c)\s+(.+)$", cmd, re.IGNORECASE)
    if marker and re.search(r"(?:powershell|pwsh)(?:\.exe)?", cmd[: marker.start()], re.IGNORECASE):
        inner = marker.group(1).strip()
        if len(inner) >= 2 and inner[0] == inner[-1] and inner[0] in {"'", '"'}:
            inner = inner[1:-1]
        return _normalize_command(inner)
    return cmd


def is_protected(action: Action) -> bool:
    candidates = [action.target, *action.paths, *_command_path_candidates(action.command)]
    for raw in candidates:
        if not raw:
            continue
        if _path_is_protected(raw):
            return True
    return False


def _command_path_candidates(command: str) -> list[str]:
    cmd = _classifiable_command(command)
    candidates: list[str] = []
    for token in re.findall(r'"[^"]+"|\'[^\']+\'|\S+', cmd):
        token = token.strip("'\"")
        token = token.rstrip(",;)")
        if not token or token.startswith("-"):
            continue
        candidates.append(token)
    return candidates


def _path_is_protected(raw: str) -> bool:
    normalized = raw.replace("\\", "/")
    parts = {p for p in Path(normalized).parts}
    if parts & PROTECTED_PARTS:
        return True
    if any(p.startswith(".") and p not in {".", ".."} for p in parts):
        return True
    name = Path(normalized).name
    if name in PROTECTED_FILES:
        return True
    return False


def evaluate(policy: dict, action: Action, auto_count: int = 0) -> dict:
    risk = classify(action)
    if risk == "protected":
        return {"decision": "ask", "risk": risk, "reason": "protected path"}

    limit = ((policy.get("circuit_breaker") or {}).get("per_turn") or 20)
    if auto_count >= limit:
        return {"decision": "ask", "risk": risk, "reason": "circuit breaker"}

    rule = match_rule(policy.get("rules", []), action.command)
    if rule:
        return {"decision": rule["decision"], "risk": risk, "reason": "rule", "rule": rule}

    mode = policy.get("mode", "auto")
    if mode == "manual":
        return {"decision": "ask", "risk": risk, "reason": "manual mode"}
    if mode == "yolo" and risk == "read":
        return {"decision": "allow", "risk": risk, "reason": "yolo read"}
    if mode == "yolo" and risk == "write":
        return {"decision": "allow", "risk": risk, "reason": "yolo write"}
    if risk == "read":
        return {"decision": "allow", "risk": risk, "reason": "read default"}
    return {"decision": "ask", "risk": risk, "reason": "risk default"}


def match_rule(rules: list, command: str) -> dict | None:
    normalized = _normalize_command(command)
    matches = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        pattern = rule.get("pattern")
        decision = rule.get("decision")
        scope = rule.get("scope", "global")
        if not isinstance(pattern, str) or decision not in {"allow", "ask", "deny"}:
            continue
        if scope == "project":
            continue
        pattern = _normalize_command(pattern)
        if not pattern:
            continue
        if normalized == pattern or normalized.startswith(pattern + " "):
            matches.append(rule)
    if not matches:
        return None
    rank = {"deny": 3, "ask": 2, "allow": 1}
    return sorted(matches, key=lambda r: (rank[r["decision"]], len(r["pattern"])), reverse=True)[0]


def add_rule(policy: dict, pattern: str, decision: Decision, scope: Scope = "global", reason: str = "") -> dict:
    rule = {"pattern": _normalize_command(pattern), "decision": decision, "scope": scope, "reason": reason}
    policy.setdefault("rules", [])
    policy["rules"] = [r for r in policy["rules"] if not (isinstance(r, dict) and r.get("pattern") == rule["pattern"] and r.get("scope") == scope)]
    policy["rules"].append(rule)
    return rule


def safe_prefix(command: str) -> str:
    parts = command.split()
    return " ".join(parts[:2]) if len(parts) >= 2 else command.strip()
