"""Workspace validation via the published create-vivary engine.

Once `create-vivary` is pip-installed, doctor() imports it directly — no monorepo
`packages/` dir required. The import is lazy so a missing dependency surfaces as a clean
runtime error (handled best-effort by the routers) rather than crashing app startup.
"""

from __future__ import annotations

from pathlib import Path


class WorkspaceScaffoldError(ValueError):
    """Raised when create-vivary refuses or fails to scaffold a workspace."""


def doctor(target: str | Path) -> dict:
    """Validate a directory as a Vivary workspace. Returns
    {ok, root, errors, warnings, graph:{nodes,edges,broken}}."""
    from create_vivary import doctor_workspace

    return doctor_workspace(target)


def scaffold(target: str | Path, *, preset: str = "coding", obsidian: bool = False) -> dict:
    """Create a Vivary workspace scaffold without overwrite support.

    Returns {created, doctor}. The bridge intentionally does not expose
    create-vivary's force flag; overwrites should require a separate explicit UX.
    """
    from create_vivary import ScaffoldError, doctor_workspace, scaffold_workspace

    try:
        created = scaffold_workspace(
            target,
            preset=preset,
            force=False,
            obsidian=obsidian,
        )
    except ScaffoldError as exc:
        raise WorkspaceScaffoldError(str(exc)) from exc

    return {
        "created": [str(path) for path in created],
        "doctor": doctor_workspace(target),
    }
