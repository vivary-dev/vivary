"""Vivary gate files (`gates/*.md`): list them and approve/reject by writing the
frontmatter `status` (open → approved | rejected). Working-tree edits only — never a
git commit (committing is itself a Vivary hard gate). Maps the GUI onto Vivary's
existing human-approval model.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

GATES_DIR = "gates"
_FM = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
VALID = {"open", "approved", "rejected", "deferred"}


def _frontmatter(text: str) -> dict[str, str]:
    m = _FM.match(text)
    fm: dict[str, str] = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
    return fm


def list_gates(root: str | Path) -> list[dict]:
    gdir = Path(root) / GATES_DIR
    if not gdir.is_dir():
        return []
    gates = []
    for p in sorted(gdir.glob("*.md")):
        fm = _frontmatter(p.read_text(encoding="utf-8", errors="replace"))
        gates.append({
            "id": p.stem,
            "path": f"{GATES_DIR}/{p.name}",
            "status": fm.get("status", "open"),
            "gate": fm.get("gate", ""),
            "command_intent": fm.get("command_intent", ""),
            "approver": fm.get("approver", ""),
            "approved_at": fm.get("approved_at", ""),
        })
    return gates


def set_status(root: str | Path, gate_id: str, status: str, approver: str | None = None) -> dict | None:
    if status not in VALID:
        raise ValueError(f"invalid status: {status}")
    p = Path(root) / GATES_DIR / f"{gate_id}.md"
    if not p.is_file():
        return None
    text = p.read_text(encoding="utf-8", errors="replace")
    m = _FM.match(text)
    if not m:
        raise ValueError("gate file has no frontmatter")

    lines = m.group(1).splitlines()
    index = {line.split(":", 1)[0].strip(): i for i, line in enumerate(lines) if ":" in line}

    def upsert(key: str, value: str) -> None:
        if key in index:
            lines[index[key]] = f"{key}: {value}"
        else:
            lines.append(f"{key}: {value}")
            index[key] = len(lines) - 1

    upsert("status", status)
    if status in ("approved", "rejected"):
        upsert("approver", approver or "gui")
        upsert("approved_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))

    new_text = text[: m.start(1)] + "\n".join(lines) + text[m.end(1):]
    p.write_text(new_text, encoding="utf-8")
    return next((g for g in list_gates(root) if g["id"] == gate_id), None)
