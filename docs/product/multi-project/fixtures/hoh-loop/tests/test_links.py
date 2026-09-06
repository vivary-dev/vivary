"""Fixed product oracle for the local Markdown link checker."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
_CHILD_RUNNER = """\
import importlib.util
import json
import os
import sys
from pathlib import Path

candidate = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("hoh_candidate", candidate)
if spec is None or spec.loader is None:
    raise RuntimeError("candidate module cannot be loaded")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value = module.check_tree(Path(sys.argv[2]))
raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
if len(raw) > 16_384:
    raise RuntimeError("candidate result exceeds the oracle IPC bound")
os.write(int(sys.argv[3]), raw)
"""


def preserved_case(prefix: str) -> Path:
    parent = Path("/tmp/fixture-cases")
    parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=parent))


def run_candidate(root: Path) -> object:
    """Execute candidate code in a disposable child; parse only parent-owned output."""
    read_fd, write_fd = os.pipe()
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                _CHILD_RUNNER,
                str(PROJECT / "linkcheck.py"),
                str(root),
                str(write_fd),
            ],
            cwd=PROJECT,
            pass_fds=(write_fd,),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    finally:
        os.close(write_fd)
    stdout, stderr = process.communicate()
    del stdout
    with os.fdopen(read_fd, "rb") as result_stream:
        raw = result_stream.read(16_385)
    if process.returncode != 0 or not raw:
        raise AssertionError(
            "candidate subprocess did not return a result "
            f"(returncode={process.returncode}, stderr={stderr.strip()!r})"
        )
    if len(raw) > 16_384:
        raise AssertionError("candidate result exceeds the oracle IPC bound")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise AssertionError(f"candidate result is unreadable: {error}") from error


class LinkCheckTests(unittest.TestCase):
    def test_reports_missing_relative_target(self) -> None:
        root = preserved_case("missing-")
        (root / "index.md").write_text("[Missing](missing.md)\n", encoding="utf-8")
        self.assertEqual(
            run_candidate(root),
            [{"source": "index.md", "target": "missing.md", "code": "missing_target"}],
            "observation=missing-target-was-not-reported",
        )

    def test_rejects_parent_escape(self) -> None:
        case = preserved_case("escape-")
        root = case / "root"
        root.mkdir()
        (case / "outside.md").write_text("# Outside\n", encoding="utf-8")
        (root / "index.md").write_text("[Outside](../outside.md)\n", encoding="utf-8")
        self.assertEqual(
            run_candidate(root),
            [{"source": "index.md", "target": "../outside.md", "code": "path_escape"}],
            "observation=parent-escape-was-accepted",
        )

    def test_ignores_anchor_only_target(self) -> None:
        root = preserved_case("anchor-")
        (root / "index.md").write_text("[Section](#section)\n", encoding="utf-8")
        self.assertEqual(
            run_candidate(root),
            [],
            "observation=anchor-only-target-was-read",
        )

    def test_accepts_existing_relative_target(self) -> None:
        root = preserved_case("existing-")
        (root / "target.md").write_text("# Target\n", encoding="utf-8")
        (root / "index.md").write_text("[Target](target.md)\n", encoding="utf-8")
        self.assertEqual(run_candidate(root), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
