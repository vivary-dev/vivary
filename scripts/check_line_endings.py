"""Check tracked text files for repo line-ending policy.

Vivary's standard is LF for text files. A small legacy allowlist exists so the
standard can land without a noisy all-repo renormalization; remove paths from the
allowlist as they are intentionally normalized.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


BINARY_EXTENSIONS = {
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".webp",
    ".woff2",
}

CRLF_ALLOWED_EXTENSIONS = {
    ".bat",
    ".cmd",
}

LEGACY_LINE_ENDING_ALLOWLIST = {
    "packages/create-vivary/create_vivary_assets/__init__.py",
    "packages/tropo/examples/vault/projects/tropo/decisions/0001-folder-as-type.md",
    "site/package-lock.json",
    "site/package.json",
    "site/src/pages/index.astro",
}


def repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return Path(result.stdout.strip())


def tracked_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [name.decode("utf-8") for name in result.stdout.split(b"\0") if name]


def is_binary_path(path: str) -> bool:
    return Path(path).suffix.lower() in BINARY_EXTENSIONS


def count_line_endings(data: bytes) -> tuple[int, int, int]:
    crlf = 0
    lf_only = 0
    lone_cr = 0
    for index, byte in enumerate(data):
        if byte == 10:
            if index > 0 and data[index - 1] == 13:
                crlf += 1
            else:
                lf_only += 1
        elif byte == 13 and (index + 1 >= len(data) or data[index + 1] != 10):
            lone_cr += 1
    return crlf, lf_only, lone_cr


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="print line-ending counts for legacy allowlisted files",
    )
    args = parser.parse_args()

    root = repo_root()
    failures: list[str] = []
    checked = 0
    legacy_seen = 0

    for rel_path in tracked_files(root):
        normalized = rel_path.replace("\\", "/")
        if is_binary_path(normalized):
            continue
        path = root / normalized
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue

        crlf, lf_only, lone_cr = count_line_endings(data)
        if crlf == 0 and lone_cr == 0:
            checked += 1
            continue

        if Path(normalized).suffix.lower() in CRLF_ALLOWED_EXTENSIONS:
            checked += 1
            continue

        if normalized in LEGACY_LINE_ENDING_ALLOWLIST:
            legacy_seen += 1
            if args.verbose:
                print(
                    f"legacy line endings allowed: {normalized} "
                    f"(CRLF={crlf}, LF_only={lf_only}, lone_CR={lone_cr})"
                )
            continue

        failures.append(
            f"{normalized}: CRLF={crlf}, LF_only={lf_only}, lone_CR={lone_cr}"
        )

    if failures:
        print("Line-ending policy failed: text files must use LF only.", file=sys.stderr)
        print(
            "Normalize the file or add a deliberate temporary allowlist entry with a "
            "cleanup note.",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(
        f"Line endings OK: checked {checked} tracked text files; "
        f"{legacy_seen} legacy allowlisted files remain."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
