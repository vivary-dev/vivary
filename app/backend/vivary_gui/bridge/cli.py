"""Bridge to Vivary's CLIs for read-only views (graph, blast, board, review) and the
self-contained graph HTML (`tropo view`).

These run the stdlib-only CLIs as subprocesses with --json against a workspace root.
Subprocess (not in-process import) keeps this robust to engine internals and matches the
verified JSON contracts; the per-call latency is fine for interactive reads.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .loader import PACKAGES

TROPO = PACKAGES / "tropo" / "tropo.py"
OZONE = PACKAGES / "ozone" / "ozone.py"
EXO = PACKAGES / "exo" / "exo.py"


def _run_json(script: Path, args: list[str], root: str | Path) -> dict:
    cmd = [sys.executable, str(script), *args, "--root", str(root), "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        msg = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise RuntimeError(f"{script.name} {args[0] if args else ''}: {msg}") from exc


def graph(root: str | Path) -> dict:
    return _run_json(TROPO, ["graph"], root)


def blast(root: str | Path, node: str) -> dict:
    return _run_json(TROPO, ["blast", node], root)


def review(root: str | Path) -> dict:
    return _run_json(OZONE, ["review"], root)


def board(root: str | Path) -> dict:
    return _run_json(EXO, ["board"], root)


def conflicts(root: str | Path) -> dict:
    return _run_json(EXO, ["conflicts"], root)


def view_html(root: str | Path, out_path: Path) -> str:
    """Generate the self-contained interactive graph HTML to out_path and return it.
    Written to an app-local temp path (not the system %TEMP%, which misbehaves here)."""
    cmd = [sys.executable, str(TROPO), "view", "--root", str(root), "--out", str(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if not out_path.exists():
        raise RuntimeError(f"tropo view failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return out_path.read_text(encoding="utf-8")
