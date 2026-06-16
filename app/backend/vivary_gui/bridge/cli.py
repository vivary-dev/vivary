"""Bridge to Vivary's engines for read-only views (graph, blast, board, review) and the
self-contained graph HTML (`tropo view`).

These run the published stdlib-only engines as subprocesses (`python -m <engine>`) with
`--json` against a workspace root. Subprocess (not in-process import) keeps this robust to
engine internals and matches the verified JSON contracts; the per-call latency is fine for
interactive reads. `python -m` resolves the engine from the backend's own environment, so
no monorepo path is needed — `pip install vivary-tropo vivary-ozone vivary-exo` is enough.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _run_json(module: str, args: list[str], root: str | Path) -> dict:
    cmd = [sys.executable, "-m", module, *args, "--root", str(root), "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        msg = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise RuntimeError(f"{module} {args[0] if args else ''}: {msg}") from exc


def graph(root: str | Path) -> dict:
    return _run_json("tropo", ["graph"], root)


def blast(root: str | Path, node: str) -> dict:
    return _run_json("tropo", ["blast", node], root)


def review(root: str | Path) -> dict:
    return _run_json("ozone", ["review"], root)


def board(root: str | Path) -> dict:
    return _run_json("exo", ["board"], root)


def conflicts(root: str | Path) -> dict:
    return _run_json("exo", ["conflicts"], root)


def view_html(root: str | Path, out_path: Path) -> str:
    """Generate the self-contained interactive graph HTML to out_path and return it.
    Written to an app-local temp path (not the system %TEMP%, which misbehaves here)."""
    cmd = [sys.executable, "-m", "tropo", "view", "--root", str(root), "--out", str(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if not out_path.exists():
        raise RuntimeError(f"tropo view failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return out_path.read_text(encoding="utf-8")
