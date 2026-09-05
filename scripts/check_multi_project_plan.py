"""Validate the tracked Vivary program's ticket graph and local links (stdlib only)."""
from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import unquote


def check(root: Path) -> list[str]:
    plan = root / "docs/product/multi-project"
    errors: list[str] = []
    tickets: dict[str, tuple[str, list[str], list[str]]] = {}
    allowed = {"needs-info", "ready", "in-progress", "ready-for-human", "done", "blocked"}
    for path in sorted((plan / "tickets").glob("*.md")):
        body = path.read_text(encoding="utf-8")
        ticket_id = path.name.split("-", 1)[0]
        if ticket_id in tickets:
            errors.append(f"duplicate ticket {ticket_id}")
        fields = {}
        for field in ("Status", "Blocked-by", "Unlocks"):
            match = re.search(rf"^{field}: (.+)$", body, re.M)
            fields[field] = match.group(1).strip() if match else ""
        status = fields["Status"]
        if status not in allowed:
            errors.append(f"{ticket_id}: invalid status {status!r}")
        edges = []
        for field in ("Blocked-by", "Unlocks"):
            value = fields[field]
            if not re.fullmatch(r"\[(?:\d{2}(?:, \d{2})*)?\]", value):
                errors.append(f"{ticket_id}: invalid {field} list {value!r}")
            edges.append(re.findall(r"\d{2}", value))
        tickets[ticket_id] = (status, *edges)
        for heading in ("Goal", "Context", "Done condition", "Verify", "Log"):
            if f"## {heading}\n" not in body:
                errors.append(f"{ticket_id}: missing {heading}")
        if "```console\n" not in body:
            errors.append(f"{ticket_id}: missing verification commands")
        if status in {"ready", "in-progress", "ready-for-human"}:
            for field in ("Owner", "Scope"):
                if not re.search(rf"^{field}: \S", body, re.M):
                    errors.append(f"{ticket_id}: actionable ticket needs {field}")
    expected = {f"{n:02}" for n in range(1, 37)}
    if tickets.keys() != expected:
        errors.append(f"ticket IDs differ from 01-36: {sorted(tickets.keys() ^ expected)}")
    graph = (plan / "graph.md").read_text(encoding="utf-8")
    for key, (status, dependencies, unlocks) in tickets.items():
        if not re.search(rf"\| \[{key}\]\([^\n]+?\) \| {status} \|", graph):
            errors.append(f"{key}: graph status does not match ticket")
        for dependency in dependencies:
            if dependency not in tickets:
                errors.append(f"{key}: unknown dependency {dependency}")
            elif key not in tickets[dependency][2]:
                errors.append(f"{key}: missing reverse Unlocks on {dependency}")
            elif status in {"ready", "in-progress", "done"} and tickets[dependency][0] != "done":
                errors.append(f"{key}: {status} with unfinished dependency {dependency}")
        for unlocked in unlocks:
            if unlocked not in tickets or key not in tickets[unlocked][1]:
                errors.append(f"{key}: inconsistent Unlocks {unlocked}")
    visited: set[str] = set()
    active: set[str] = set()

    def visit(key: str) -> None:
        if key in active:
            errors.append(f"dependency cycle through {key}")
            return
        if key in visited or key not in tickets:
            return
        active.add(key)
        for dependency in tickets[key][1]:
            visit(dependency)
        active.remove(key)
        visited.add(key)

    for key in tickets:
        visit(key)
    for path in sorted(plan.rglob("*.md")):
        body = path.read_text(encoding="utf-8")
        for link in re.findall(r"\]\(([^)\n]+)\)", body):
            if re.match(r"(?:https?://|mailto:|#)", link):
                continue
            target = (path.parent / unquote(link.split("#", 1)[0])).resolve()
            if not target.is_relative_to(root.resolve()) or not target.exists():
                errors.append(f"{path.relative_to(root)}: missing or escaping link {link}")
        if re.search(r"[A-Za-z]:[\\/](?:Users|home)[\\/]|/home/[^/\s]+/|gh[pousr]_[A-Za-z0-9]{20,}", body):
            errors.append(f"{path.relative_to(root)}: possible private path or credential")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate without changing files")
    parser.parse_args()
    failures = check(Path(__file__).resolve().parents[1])
    for failure in failures:
        print(f"ERROR: {failure}")
    if not failures:
        print("Program checks passed: 36 tickets, dependencies, statuses, commands, links and privacy patterns.")
    raise SystemExit(bool(failures))
