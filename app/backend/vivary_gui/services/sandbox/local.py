"""Local execution backend.

`isolation="worktree"` creates a per-session git worktree — but ONLY when the workspace
is its own git repo root (otherwise a worktree wouldn't carry the workspace's files). For
a workspace that isn't a standalone repo (e.g. a sandbox dir inside another repo), we run
in-place. Docker/Daytona providers would implement the same `create()` contract later.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ... import config


@dataclass
class Sandbox:
    cwd: Path
    isolation: str
    _cleanup: Callable[[], None] | None = None

    def teardown(self) -> None:
        if self._cleanup:
            try:
                self._cleanup()
            except Exception:  # noqa: BLE001 - teardown is best-effort
                pass


def _repo_root(path: Path) -> Path | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return Path(out.stdout.strip()).resolve()


class LocalProvider:
    name = "local"

    def create(self, workspace_root: Path, session_id: str, isolation: str = "worktree") -> Sandbox:
        workspace_root = workspace_root.resolve()
        if isolation == "worktree" and _repo_root(workspace_root) == workspace_root:
            wt = config.APP_DIR / "worktrees" / session_id
            wt.parent.mkdir(parents=True, exist_ok=True)
            res = subprocess.run(
                ["git", "-C", str(workspace_root), "worktree", "add", "--detach", str(wt)],
                capture_output=True, text=True, timeout=60,
            )
            if res.returncode == 0:
                def cleanup() -> None:
                    subprocess.run(
                        ["git", "-C", str(workspace_root), "worktree", "remove", "--force", str(wt)],
                        capture_output=True, text=True, timeout=60,
                    )
                    shutil.rmtree(wt, ignore_errors=True)
                return Sandbox(cwd=wt, isolation="worktree", _cleanup=cleanup)
        # Fallback: run in the workspace directory itself.
        return Sandbox(cwd=workspace_root, isolation="none")
