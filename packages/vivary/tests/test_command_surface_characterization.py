"""Freeze the observed command-line surface of the six Vivary entry modules.

Each case records the exit code and the streams one real run produced. A stream
that two runs under different temporary directories agree on is frozen whole in
command_surface_snapshots.py, and a stream that varies between runs or that the
case calls environment-dependent keeps fragments. Routing work must keep every
recorded value unchanged.
"""

import tempfile
import unittest
from pathlib import Path
from typing import NamedTuple

from cli_runner import run_cli
from command_surface_snapshots import SNAPSHOTS

ROOT = Path(__file__).resolve().parents[3]
PACKAGES = ROOT / "packages"
VAULT = str(PACKAGES / "tropo" / "examples" / "vault")

STREAMS = ("stdout", "stderr")


class Command(NamedTuple):
    module: str
    import_paths: tuple[str, ...] = ()


class CommandCase(NamedTuple):
    name: str
    command: str
    argv: tuple[str, ...]
    exit_code: int
    stdout: tuple[str, ...] = ()
    stderr: tuple[str, ...] = ()
    stdout_exact: str | None = None
    stderr_exact: str | None = None
    silent_stream: str | None = None
    empty_files: tuple[str, ...] = ()
    environment_dependent: tuple[str, ...] = ()


COMMANDS = {
    "create-vivary": Command(str(PACKAGES / "create-vivary" / "create_vivary.py")),
    "tropo": Command(str(PACKAGES / "tropo" / "tropo.py")),
    # strato.py imports vivary_core at module scope and this checkout is not installed.
    "strato": Command(str(PACKAGES / "strato" / "strato.py"), (str(PACKAGES / "core"),)),
    "ozone": Command(str(PACKAGES / "ozone" / "ozone.py")),
    "exo": Command(str(PACKAGES / "exo" / "exo.py")),
    "vivary": Command(str(PACKAGES / "vivary" / "vivary_cli.py")),
}


def normalize(text: str) -> str:
    """Strip trailing whitespace per line and close the stream with one newline."""
    lines = [line.rstrip() for line in text.splitlines()]
    return "\n".join(lines) + "\n" if lines else ""


def recorded(case: CommandCase) -> CommandCase:
    """Attach the complete streams the snapshot module froze for this case."""
    streams = SNAPSHOTS.get(case.name, {})
    return case._replace(
        stdout_exact=streams.get("stdout"), stderr_exact=streams.get("stderr")
    )


CASES = tuple(
    recorded(case)
    for case in (
        CommandCase("create-vivary-help", "create-vivary", ("--help",), 0,
                    silent_stream="stderr"),
        # why: the capability report names the components installed in this environment
        CommandCase("create-vivary-capabilities", "create-vivary",
                    ("capabilities", "--preset", "coding"), 0,
                    stdout=("create-vivary capabilities for coding:", "storage:file"),
                    silent_stream="stderr", environment_dependent=("stdout",)),
        CommandCase("create-vivary-unknown-flag", "create-vivary", ("--nope",), 2,
                    silent_stream="stdout"),
        # why: the doctor report names the components installed in this environment
        CommandCase("create-vivary-doctor", "create-vivary", ("doctor", "."), 1,
                    stdout=("create-vivary doctor: failed (0 node(s), 0 edge(s), 0 broken)",),
                    silent_stream="stderr", environment_dependent=("stdout",)),

        CommandCase("tropo-help", "tropo", ("--help",), 0, silent_stream="stderr"),
        CommandCase("tropo-check", "tropo", ("check", "--root", VAULT), 0,
                    silent_stream="stderr"),
        CommandCase("tropo-check-json", "tropo", ("check", "--root", VAULT, "--json"), 0,
                    silent_stream="stderr"),
        CommandCase("tropo-unknown-flag", "tropo", ("--nope",), 2,
                    silent_stream="stdout"),
        # why: the stderr names the temporary working directory it walked up from
        CommandCase("tropo-check-no-config", "tropo", ("check",), 1,
                    stderr=("tropo: no tropo.toml found walking up from",),
                    silent_stream="stdout"),

        CommandCase("strato-help", "strato", ("--help",), 0, silent_stream="stderr"),
        CommandCase("strato-decide-help", "strato", ("decide", "--help"), 0,
                    silent_stream="stderr"),
        CommandCase("strato-missing-command", "strato", ("--nope",), 2,
                    silent_stream="stdout"),
        CommandCase("strato-decide-missing-request", "strato",
                    ("decide", "--governed", "missing.json"), 2),
        CommandCase("strato-decide-missing-request-json", "strato",
                    ("decide", "--governed", "--json", "missing.json"), 2),

        CommandCase("ozone-help", "ozone", ("--help",), 0, silent_stream="stderr"),
        CommandCase("ozone-review", "ozone", ("review", "--root", VAULT), 0,
                    silent_stream="stderr"),
        CommandCase("ozone-packs", "ozone", ("packs",), 0, silent_stream="stderr"),
        CommandCase("ozone-unknown-flag", "ozone", ("--nope",), 2,
                    silent_stream="stdout"),
        CommandCase("ozone-verify-ungoverned", "ozone", ("verify",), 2,
                    silent_stream="stdout"),
        CommandCase("ozone-impact-missing-node", "ozone",
                    ("impact", "nope-id", "--root", VAULT), 1, silent_stream="stdout"),

        CommandCase("exo-help", "exo", ("--help",), 0, silent_stream="stderr"),
        CommandCase("exo-control-help", "exo", ("control", "--help"), 0,
                    silent_stream="stderr"),
        CommandCase("exo-conflicts", "exo", ("conflicts", "--root", VAULT), 0,
                    silent_stream="stderr"),
        CommandCase("exo-roles", "exo", ("roles", "--root", VAULT), 0,
                    silent_stream="stderr"),
        CommandCase("exo-unknown-flag", "exo", ("--nope",), 2, silent_stream="stdout"),
        CommandCase("exo-claim-without-agent", "exo",
                    ("claim", "task-1", "--root", VAULT), 2, silent_stream="stdout"),
        CommandCase("exo-control-missing-request", "exo",
                    ("control", "--governed", "missing.json", "--strict"), 1,
                    silent_stream="stderr"),

        CommandCase("vivary-help", "vivary", ("--help",), 0, silent_stream="stderr"),
        CommandCase("vivary-no-arguments", "vivary", (), 0, silent_stream="stderr"),
        CommandCase("vivary-logs-help", "vivary", ("logs", "--help"), 0,
                    silent_stream="stderr"),
        CommandCase("vivary-logs-email-help", "vivary", ("logs", "email", "--help"), 0,
                    silent_stream="stderr"),
        CommandCase("vivary-logs-empty", "vivary", ("logs", "receipts.jsonl"), 0,
                    silent_stream="stderr", empty_files=("receipts.jsonl",)),
        CommandCase("vivary-logs-empty-json", "vivary",
                    ("logs", "receipts.jsonl", "--json"), 0,
                    silent_stream="stderr", empty_files=("receipts.jsonl",)),
        CommandCase("vivary-logs-email", "vivary",
                    ("logs", "email", "receipts.jsonl", "--to", "support@example.com"), 0,
                    silent_stream="stderr", empty_files=("receipts.jsonl",)),
        CommandCase("vivary-logs-missing", "vivary", ("logs", "missing.jsonl"), 1,
                    silent_stream="stdout"),
        CommandCase("vivary-logs-email-missing", "vivary",
                    ("logs", "email", "missing.jsonl", "--to", "support@example.com"), 1,
                    silent_stream="stdout"),
        CommandCase("vivary-logs-unknown-flag", "vivary", ("logs", "--nope"), 2,
                    silent_stream="stdout"),
    )
)


def case_problems(
    case: CommandCase,
    code: int,
    stdout: str,
    stderr: str,
    installed: bool = False,
) -> list[str]:
    """Report every recorded value the capture failed to reproduce.

    The source run and the installed replay judge a case the same way, so a
    stream the case calls environment-dependent falls back to fragments in both.
    """
    problems = []
    if code != case.exit_code:
        problems.append(f"{case.name}: exited {code} instead of {case.exit_code}")
    for stream, text in zip(STREAMS, (stdout, stderr)):
        exact = case.stdout_exact if stream == "stdout" else case.stderr_exact
        if stream in case.environment_dependent:
            exact = None
        if exact is not None:
            if normalize(text) != exact:
                problems.append(f"{case.name}: {stream} does not match the frozen stream")
        else:
            fragments = case.stdout if stream == "stdout" else case.stderr
            problems.extend(
                f"{case.name}: {stream} is missing {fragment!r}"
                for fragment in fragments
                if fragment not in text
            )
        if case.silent_stream == stream and text != "":
            problems.append(f"{case.name}: {stream} must stay silent")
    return problems


def run_case(case: CommandCase) -> tuple[int, str, str]:
    command = COMMANDS[case.command]
    with tempfile.TemporaryDirectory() as work:
        for name in case.empty_files:
            (Path(work) / name).touch()
        return run_cli([command.module, *case.argv], work, command.import_paths)


CAPTURES: dict[str, list[tuple[int, str, str]]] = {}


def capture(case: CommandCase, runs: int = 1) -> list[tuple[int, str, str]]:
    """Run one case in a fresh temporary directory, reusing earlier captures."""
    recorded_runs = CAPTURES.setdefault(case.name, [])
    while len(recorded_runs) < runs:
        recorded_runs.append(run_case(case))
    return recorded_runs[:runs]


class CommandSurfaceCharacterizationTests(unittest.TestCase):
    def test_recorded_command_surface(self):
        for case in CASES:
            with self.subTest(command=case.command, argv=case.argv):
                code, out, err = capture(case)[0]
                self.assertEqual(case_problems(case, code, out, err), [], err or out)

    def test_deterministic_streams_are_frozen_whole(self):
        self.assertEqual(set(SNAPSHOTS) - {case.name for case in CASES}, set())
        for case in CASES:
            first, second = capture(case, 2)
            for index, stream in enumerate(STREAMS, start=1):
                if (
                    case.silent_stream == stream
                    or stream in case.environment_dependent
                    or first[index] != second[index]
                ):
                    continue
                with self.subTest(case=case.name, stream=stream):
                    exact = case.stdout_exact if stream == "stdout" else case.stderr_exact
                    self.assertIsNotNone(
                        exact, f"{case.name}: {stream} is deterministic and must be frozen"
                    )

    def test_environment_dependent_streams_are_judged_by_fragments(self):
        case = CommandCase(
            "probe", "tropo", ("--help",), 0,
            stdout=("storage:file",), stdout_exact="storage:file installed\n",
            silent_stream="stderr", environment_dependent=("stdout",),
        )
        for installed in (False, True):
            with self.subTest(installed=installed):
                self.assertEqual(
                    case_problems(case, 0, "storage:file not-installed\n", "", installed),
                    [],
                )
                self.assertEqual(
                    case_problems(case, 0, "storage:embedded\n", "", installed),
                    ["probe: stdout is missing 'storage:file'"],
                )


if __name__ == "__main__":
    unittest.main()
