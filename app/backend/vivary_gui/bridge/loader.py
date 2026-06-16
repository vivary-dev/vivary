"""Load Vivary's stdlib-only engines in-process from the repo's packages/ dir.

The backend lives at <repo>/app/backend/vivary_gui/bridge/loader.py, so the repo root
is four parents up and the engines are under <repo>/packages/. We import by file path
(create-vivary's dir has a hyphen, so it isn't importable by name).
"""

from __future__ import annotations

import importlib.util
from functools import lru_cache
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[4]
PACKAGES = REPO_ROOT / "packages"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name} from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@lru_cache(maxsize=1)
def create_vivary() -> ModuleType:
    return _load("vivary_create_cli", PACKAGES / "create-vivary" / "create_vivary.py")


def doctor(target: str | Path) -> dict:
    """Validate a directory as a Vivary workspace. Returns
    {ok, root, errors, warnings, graph:{nodes,edges,broken}}."""
    return create_vivary().doctor_workspace(target)
