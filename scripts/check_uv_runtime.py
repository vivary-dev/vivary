"""Admit the actual CI uv/uvx wheel executables before using them."""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path


# Native payloads from the exact 0.13.5 wheels selected by ci.yml.
UV_SHA256 = {
    "linux": (
        "8a70db72685b7138121bfcda71fa1a00cb709ed9f1fdc4ecf1dd871e8e167e52",
        "a54e15e5ff32ac5432fdd7a9819e2b2a326651f0589d6b58b8b98c3cc28d3592",
    ),
    "win32": (
        "f45d1cb9d9140ca6d3f4005fdfc0ebeccf849fd04d1dc85804155cb923f1597b",
        "df072bb833b88deb80ddd1fb44c5d711abdf35ef690331ca6d8af4647a55cfa4",
    ),
}


def admitted_uv() -> Path:
    expected = UV_SHA256.get(sys.platform)
    if expected is None:
        raise SystemExit("uv CI admission supports only Linux x64 and Windows amd64")
    paths = []
    for name, digest in zip(("uv", "uvx"), expected):
        selected = shutil.which(name)
        if selected is None:
            raise SystemExit(f"missing CI executable: {name}")
        path = Path(selected).resolve(strict=True)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise SystemExit(f"{name} does not match the admitted uv 0.13.5 wheel")
        paths.append(path)
    if paths[0].parent != paths[1].parent:
        raise SystemExit("uv and uvx must come from the same admitted wheel scripts directory")
    version = subprocess.run(
        [str(paths[0]), "--version"], check=True, capture_output=True, text=True, timeout=10
    ).stdout
    if version.split()[:2] != ["uv", "0.13.5"]:
        raise SystemExit("the actual uv runtime must identify version 0.13.5")
    print(version.strip(), file=sys.stderr)
    return paths[0]


if __name__ == "__main__":
    print(admitted_uv())
