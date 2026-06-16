"""Workspace validation via the published create-vivary engine.

Once `create-vivary` is pip-installed, doctor() imports it directly — no monorepo
`packages/` dir required. The import is lazy so a missing dependency surfaces as a clean
runtime error (handled best-effort by the routers) rather than crashing app startup.
"""

from __future__ import annotations

from pathlib import Path


def doctor(target: str | Path) -> dict:
    """Validate a directory as a Vivary workspace. Returns
    {ok, root, errors, warnings, graph:{nodes,edges,broken}}."""
    from create_vivary import doctor_workspace

    return doctor_workspace(target)
