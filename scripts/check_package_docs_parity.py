"""Check that documented PyPI package truth matches the packaging manifests.

`docs/ARCHITECTURE.md` claims to state "current package truth", but that list drifted
two published packages behind `packages/*/pyproject.toml` before this guard existed.
So it is derived rather than maintained by hand: the manifests are the single
declaration, and `UNPUBLISHED` is the one explicit exception recording a distribution
that exists in-repo without a PyPI release.

Publishing a distribution means removing its name from `UNPUBLISHED`, which then
requires it in the documented list. Adding a package requires documenting it. Neither
can drift silently.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path


PACKAGES = Path("packages")
ARCHITECTURE = Path("docs/ARCHITECTURE.md")
PYPI_BULLET = "- PyPI:"

# Distributions that deliberately have no PyPI release yet. `vivary-core` is unpublished
# on purpose: it ships with the next major alongside the role packages, never ahead of
# them.
UNPUBLISHED = {"vivary-core"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def declared_distributions() -> set[str]:
    """Every distribution name declared by a packaging manifest."""
    manifests = sorted(PACKAGES.glob("*/pyproject.toml"))
    require(bool(manifests), f"{PACKAGES}: found no pyproject.toml manifests")

    names: set[str] = set()
    for manifest in manifests:
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
        name = (data.get("project") or {}).get("name")
        require(bool(name), f"{manifest}: [project] table declares no name")
        names.add(name)
    return names


def documented_distributions() -> set[str]:
    """Every package name backticked on the PyPI bullet in the architecture doc.

    The bullet is prose and wraps, so continuation lines belong to it too. Reading only
    the first physical line would silently miss names and report them as undocumented.
    """
    lines = ARCHITECTURE.read_text(encoding="utf-8").splitlines()
    starts = [index for index, line in enumerate(lines) if line.startswith(PYPI_BULLET)]
    require(
        len(starts) == 1,
        f"{ARCHITECTURE}: expected exactly one '{PYPI_BULLET}' bullet, found {len(starts)}",
    )

    start = starts[0]
    bullet = [lines[start]]
    for line in lines[start + 1 :]:
        # A wrapped continuation is indented and non-empty; a new bullet or a blank
        # line ends the block.
        if not line.strip() or not line.startswith((" ", "\t")):
            break
        bullet.append(line)

    return set(re.findall(r"`([^`]+)`", " ".join(part.strip() for part in bullet)))


def main() -> None:
    declared = declared_distributions()
    documented = documented_distributions()

    stale_allowlist = sorted(UNPUBLISHED - declared)
    require(
        not stale_allowlist,
        "UNPUBLISHED names distributions that have no manifest: "
        + ", ".join(stale_allowlist),
    )

    published = declared - UNPUBLISHED

    listed_but_unpublished = sorted(UNPUBLISHED & documented)
    require(
        not listed_but_unpublished,
        f"{ARCHITECTURE}: the PyPI list names unpublished distributions: "
        + ", ".join(listed_but_unpublished),
    )

    missing = sorted(published - documented)
    require(
        not missing,
        f"{ARCHITECTURE}: published distributions missing from the PyPI list: "
        + ", ".join(missing),
    )

    unknown = sorted(documented - published)
    require(
        not unknown,
        f"{ARCHITECTURE}: the PyPI list names distributions with no manifest: "
        + ", ".join(unknown),
    )

    print(
        f"{ARCHITECTURE}: PyPI list matches {len(published)} published manifests; "
        f"{len(UNPUBLISHED)} unpublished allowlisted."
    )


if __name__ == "__main__":
    main()
