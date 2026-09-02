"""Freeze the observed command-line surface of the six Vivary entry modules.

Each case records the exit code, the output fragments, and the stream boundaries
one real run produced. Routing work must keep every recorded value unchanged.
"""

import tempfile
import unittest
from pathlib import Path
from typing import NamedTuple

from cli_runner import run_cli

ROOT = Path(__file__).resolve().parents[3]
PACKAGES = ROOT / "packages"
VAULT = str(PACKAGES / "tropo" / "examples" / "vault")


class Command(NamedTuple):
    module: str
    import_paths: tuple[str, ...] = ()


class CommandCase(NamedTuple):
    command: str
    argv: tuple[str, ...]
    exit_code: int
    stdout: tuple[str, ...] = ()
    stderr: tuple[str, ...] = ()
    silent_stream: str | None = None
    empty_files: tuple[str, ...] = ()


COMMANDS = {
    "create-vivary": Command(str(PACKAGES / "create-vivary" / "create_vivary.py")),
    "tropo": Command(str(PACKAGES / "tropo" / "tropo.py")),
    # strato.py imports vivary_core at module scope and this checkout is not installed.
    "strato": Command(str(PACKAGES / "strato" / "strato.py"), (str(PACKAGES / "core"),)),
    "ozone": Command(str(PACKAGES / "ozone" / "ozone.py")),
    "exo": Command(str(PACKAGES / "exo" / "exo.py")),
    "vivary": Command(str(PACKAGES / "vivary" / "vivary_cli.py")),
}

CASES = (
    CommandCase(
        "create-vivary",
        ("--help",),
        0,
        stdout=(
            "usage: create-vivary",
            "Create a lightweight local-first Vivary context workspace.",
        ),
        silent_stream="stderr",
    ),
    CommandCase(
        "create-vivary",
        ("capabilities", "--preset", "coding"),
        0,
        stdout=("create-vivary capabilities for coding:", "storage:file"),
        silent_stream="stderr",
    ),
    CommandCase(
        "create-vivary",
        ("--nope",),
        2,
        stderr=(
            "usage: create-vivary",
            "create-vivary: error: unrecognized arguments: --nope",
        ),
        silent_stream="stdout",
    ),
    CommandCase(
        "create-vivary",
        ("doctor", "."),
        1,
        stdout=("create-vivary doctor: failed (0 node(s), 0 edge(s), 0 broken)",),
        silent_stream="stderr",
    ),

    CommandCase(
        "tropo",
        ("--help",),
        0,
        stdout=("usage: tropo", "The filesystem is the schema."),
        silent_stream="stderr",
    ),
    CommandCase(
        "tropo",
        ("check", "--root", VAULT),
        0,
        stdout=("tropo: 4 document(s), 0 error(s), 0 warning(s)",),
        silent_stream="stderr",
    ),
    CommandCase(
        "tropo",
        ("check", "--root", VAULT, "--json"),
        0,
        stdout=('"checked": 4', '"errors": 0', '"warnings": 0'),
        silent_stream="stderr",
    ),
    CommandCase(
        "tropo",
        ("--nope",),
        2,
        stderr=("usage: tropo", "tropo: error: unrecognized arguments: --nope"),
        silent_stream="stdout",
    ),
    CommandCase(
        "tropo",
        ("check",),
        1,
        stderr=("tropo: no tropo.toml found walking up from",),
        silent_stream="stdout",
    ),

    CommandCase(
        "strato",
        ("--help",),
        0,
        stdout=("usage: strato", "Vivary governed loop policy"),
        silent_stream="stderr",
    ),
    CommandCase(
        "strato",
        ("decide", "--help"),
        0,
        stdout=("usage: strato decide", "decision-request JSON file, or - for stdin"),
        silent_stream="stderr",
    ),
    CommandCase(
        "strato",
        ("--nope",),
        2,
        stderr=(
            "usage: strato",
            "strato: error: the following arguments are required: command",
        ),
        silent_stream="stdout",
    ),
    CommandCase(
        "strato",
        ("decide", "--governed", "missing.json"),
        2,
        stdout=("strato decide: blocked", "reasons: invalid_request_document"),
        stderr=("strato: ", "missing.json"),
    ),
    CommandCase(
        "strato",
        ("decide", "--governed", "--json", "missing.json"),
        2,
        stdout=(
            '"schema":"vivary.strato-decision-refusal/v0"',
            '"reason_codes":["invalid_request_document"]',
        ),
        stderr=("strato: ",),
    ),

    CommandCase(
        "ozone",
        ("--help",),
        0,
        stdout=(
            "usage: ozone",
            "Vivary review, impact, and governed evidence verification.",
        ),
        silent_stream="stderr",
    ),
    CommandCase(
        "ozone",
        ("review", "--root", VAULT),
        0,
        stdout=("ozone: reviewed 4 node(s), 0 warning(s), 2 note(s)",),
        silent_stream="stderr",
    ),
    CommandCase(
        "ozone",
        ("packs",),
        0,
        stdout=("structure", "context-budget", "editorial"),
        silent_stream="stderr",
    ),
    CommandCase(
        "ozone",
        ("--nope",),
        2,
        stderr=("usage: ozone", "ozone: error: unrecognized arguments: --nope"),
        silent_stream="stdout",
    ),
    CommandCase(
        "ozone",
        ("verify",),
        2,
        stderr=("usage: ozone", "ozone: error: verify requires --governed"),
        silent_stream="stdout",
    ),
    CommandCase(
        "ozone",
        ("impact", "nope-id", "--root", VAULT),
        1,
        stderr=("ozone: no node with id 'nope-id'",),
        silent_stream="stdout",
    ),

    CommandCase(
        "exo",
        ("--help",),
        0,
        stdout=("usage: exo", "The coordination layer over the tropo graph."),
        silent_stream="stderr",
    ),
    CommandCase(
        "exo",
        ("control", "--help"),
        0,
        stdout=("usage: exo control", "Dispatch one governed Core control request."),
        silent_stream="stderr",
    ),
    CommandCase(
        "exo",
        ("conflicts", "--root", VAULT),
        0,
        stdout=("exo: no conflicts among 0 active work item(s)",),
        silent_stream="stderr",
    ),
    CommandCase(
        "exo",
        ("roles", "--root", VAULT),
        0,
        stdout=("exo: role contracts", "Orchestrator"),
        silent_stream="stderr",
    ),
    CommandCase(
        "exo",
        ("--nope",),
        2,
        stderr=("usage: exo", "exo: error: unrecognized arguments: --nope"),
        silent_stream="stdout",
    ),
    CommandCase(
        "exo",
        ("claim", "task-1", "--root", VAULT),
        2,
        stderr=("usage: exo", "exo: error: claim requires --agent <handle>"),
        silent_stream="stdout",
    ),
    CommandCase(
        "exo",
        ("control", "--governed", "missing.json", "--strict"),
        1,
        stdout=("exo control: refused: invalid_request_document",),
        silent_stream="stderr",
    ),

    CommandCase(
        "vivary",
        ("--help",),
        0,
        stdout=("usage: vivary", "The Vivary front door"),
        silent_stream="stderr",
    ),
    CommandCase(
        "vivary",
        (),
        0,
        stdout=("usage: vivary", "The Vivary front door"),
        silent_stream="stderr",
    ),
    CommandCase(
        "vivary",
        ("logs", "--help"),
        0,
        stdout=("usage: vivary logs",),
        silent_stream="stderr",
    ),
    CommandCase(
        "vivary",
        ("logs", "email", "--help"),
        0,
        stdout=("usage: vivary logs email", "--to TO"),
        silent_stream="stderr",
    ),
    CommandCase(
        "vivary",
        ("logs", "receipts.jsonl"),
        0,
        stdout=("Vivary receipt log", "total=0 failed=0 invalid_lines=0"),
        silent_stream="stderr",
        empty_files=("receipts.jsonl",),
    ),
    CommandCase(
        "vivary",
        ("logs", "receipts.jsonl", "--json"),
        0,
        stdout=('"total": 0', '"failed": 0', '"invalid_lines": 0'),
        silent_stream="stderr",
        empty_files=("receipts.jsonl",),
    ),
    CommandCase(
        "vivary",
        ("logs", "email", "receipts.jsonl", "--to", "support@example.com"),
        0,
        stdout=(
            "mailto:support@example.com?subject=Vivary%20support%20receipt%20summary",
        ),
        silent_stream="stderr",
        empty_files=("receipts.jsonl",),
    ),
    CommandCase(
        "vivary",
        ("logs", "missing.jsonl"),
        1,
        stderr=("vivary logs: receipt log not found",),
        silent_stream="stdout",
    ),
    CommandCase(
        "vivary",
        ("logs", "email", "missing.jsonl", "--to", "support@example.com"),
        1,
        stderr=("vivary logs email: receipt log not found",),
        silent_stream="stdout",
    ),
    CommandCase(
        "vivary",
        ("logs", "--nope"),
        2,
        stderr=("usage: vivary", "vivary: error: unrecognized arguments: --nope"),
        silent_stream="stdout",
    ),
)


def run_case(case: CommandCase) -> tuple[int, str, str]:
    command = COMMANDS[case.command]
    with tempfile.TemporaryDirectory() as work:
        for name in case.empty_files:
            (Path(work) / name).touch()
        return run_cli([command.module, *case.argv], work, command.import_paths)


class CommandSurfaceCharacterizationTests(unittest.TestCase):
    def test_recorded_command_surface(self):
        for case in CASES:
            with self.subTest(command=case.command, argv=case.argv):
                code, out, err = run_case(case)
                self.assertEqual(code, case.exit_code, err or out)
                for fragment in case.stdout:
                    self.assertIn(fragment, out)
                for fragment in case.stderr:
                    self.assertIn(fragment, err)
                if case.silent_stream is not None:
                    streams = {"stdout": out, "stderr": err}
                    self.assertEqual(streams[case.silent_stream], "")


if __name__ == "__main__":
    unittest.main()
