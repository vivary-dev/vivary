"""Incomplete starter for the headless-loop fixture."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote


LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def check_tree(root: Path) -> list[dict[str, str]]:
    """Return starter observations. Three required cases remain incomplete."""
    findings: list[dict[str, str]] = []
    root = root.resolve()
    for source in sorted(root.rglob("*.md")):
        for raw_target in LINK.findall(source.read_text(encoding="utf-8")):
            target = unquote(raw_target.strip())
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            file_target = target.split("#", 1)[0]
            if not file_target:
                findings.append(
                    {"source": source.relative_to(root).as_posix(), "target": target, "code": "missing_target"}
                )
                continue
            resolved = (source.parent / file_target).resolve()
            if resolved.is_relative_to(root) and not resolved.exists():
                continue
    return findings
