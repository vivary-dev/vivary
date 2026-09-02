"""Prove the installed Vivary front door matches the seam it routes to.

Given the script directory of a virtual environment that has `vivary` and its
components installed, this runs every legacy help command, compares each routed
verb against the installed component run under the same program name, and checks
that an unrouted component operation stays standalone and stays out of the front
door's help.

With --characterize it instead replays the repository characterization table
through the installed console scripts, so the frozen command surface is proven
from a real installation rather than from the checked-out modules.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
VAULT = str(ROOT / "packages" / "tropo" / "examples" / "vault")
CHARACTERIZATION_TESTS = ROOT / "packages" / "vivary" / "tests"

if str(CHARACTERIZATION_TESTS) not in sys.path:
    sys.path.insert(0, str(CHARACTERIZATION_TESTS))

COMMAND_FOR_MODULE = {
    "create_vivary": "create-vivary",
    "tropo": "tropo",
    "strato": "strato",
    "ozone": "ozone",
    "exo": "exo",
}

UNKNOWN_FLAG = "--definitely-not-a-flag"

LEGACY_COMMANDS = (
    ("vivary", ("--help",)),
    ("vivary", ("--version",)),
    ("vivary", ("logs", "--help")),
    ("create-vivary", ("--help",)),
    ("tropo", ("--help",)),
    ("strato", ("--help",)),
    ("ozone", ("--help",)),
    ("exo", ("--help",)),
)

FIXTURE_ARGS = {
    "doctor": (".",),
    "capabilities": ("--preset", "coding"),
    "check": ("--root", VAULT),
    "find": ("vault", "--root", VAULT),
    "decide": ("--governed", "missing.json"),
    "review": ("--root", VAULT),
    "impact": ("nope-id", "--root", VAULT),
    "control": ("--governed", "missing.json", "--strict"),
}

SCRIPT_FOR_CASE = {
    "create-vivary": "create-vivary",
    "tropo": "tropo",
    "strato": "strato",
    "ozone": "ozone",
    "exo": "exo",
    "vivary": "vivary",
}

UNROUTED_COMMAND = "tropo"
UNROUTED_OPERATION = "map"
UNROUTED_ARGS = ("--root", VAULT)

ROUTE_PROBE = (
    "import json, vivary_cli\n"
    "print(json.dumps([[route.verb, route.module, list(route.operation)]\n"
    "                  for route in vivary_cli.ROUTES]))\n"
)


class Result(NamedTuple):
    code: int
    stdout: str
    stderr: str


def script_path(bin_dir: Path, name: str) -> Path:
    windows = bin_dir / f"{name}.exe"
    return windows if windows.exists() else bin_dir / name


def routed_prog(verb: str) -> str:
    return f"vivary {verb}"


def oracle_source(module: str, operation: list[str], args: tuple[str, ...], name: str) -> str:
    """Source that runs the installed component under the router's program name."""
    return (
        f"import {module}\n"
        f"raise SystemExit({module}.main({[*operation, *args]!r}, prog={name!r}))\n"
    )


def compare(label: str, routed: Result, expected: Result) -> list[str]:
    """Compare one routed run with the component run under the same program name."""
    problems = []
    if routed.code != expected.code:
        problems.append(
            f"{label}: exit code {routed.code} does not match {expected.code}"
        )
    for stream, left, right in zip(
        ("stdout", "stderr"),
        (routed.stdout, routed.stderr),
        (expected.stdout, expected.stderr),
    ):
        if left != right:
            problems.append(f"{label}: {stream} does not match the component run")
    return problems


def usage_error_problems(label: str, name: str, routed: Result) -> list[str]:
    """Judge a routed usage error on its exit code, its silence, and its name."""
    problems = []
    if routed.code != 2:
        problems.append(f"{label}: exited {routed.code} instead of the usage error 2")
    if routed.stdout != "":
        problems.append(f"{label}: a usage error must not write stdout")
    if not routed.stderr.startswith(f"usage: {name}"):
        problems.append(f"{label}: stderr does not open with usage: {name}")
    if f"{name}: error:" not in routed.stderr:
        problems.append(f"{label}: stderr carries no {name}: error: prefix")
    return problems


def unrouted_problems(
    operation: str, standalone: Result, routed: Result, front_door_help: str
) -> list[str]:
    problems = []
    if standalone.code != 0:
        problems.append(
            f"{UNROUTED_COMMAND} {operation}: the standalone operation exited"
            f" {standalone.code}"
        )
    if routed.code != 2:
        problems.append(
            f"vivary {operation}: exited {routed.code} instead of the usage error 2"
        )
    if "usage: vivary" not in routed.stderr:
        problems.append(f"vivary {operation}: stderr carries no vivary usage error")
    if routed.stdout != "":
        problems.append(f"vivary {operation}: a usage error must not write stdout")
    if re.search(rf"(?m)^\s+{re.escape(operation)}\b", front_door_help):
        problems.append(f"vivary --help lists the unrouted operation {operation}")
    return problems


def load_command_surface():
    """Import the characterization table the repository suite records."""
    if str(CHARACTERIZATION_TESTS) not in sys.path:
        sys.path.insert(0, str(CHARACTERIZATION_TESTS))
    import test_command_surface_characterization as surface

    return surface


def characterized_problems(surface, case, result: Result) -> list[str]:
    """Apply the recorded exact and fragment assertions to one installed run."""
    script = SCRIPT_FOR_CASE.get(case.command)
    if script is None:
        return [f"{case.name}: {case.command} has no installed console script"]
    return surface.case_problems(
        case, result.code, result.stdout, result.stderr, installed=True
    )


def base_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("VIVARY_RECEIPT_LOG", None)
    env.pop("PYTHONWARNINGS", None)
    env.pop("PYTHONPATH", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["COLUMNS"] = "80"
    return env


class Runner:
    def __init__(self, bin_dir: Path) -> None:
        self.bin_dir = bin_dir
        self.python = script_path(bin_dir, "python")
        self.direct = True

    def _invoke(self, argv: list[str], cwd: str) -> Result:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=base_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            check=False,
            timeout=120,
        )
        return Result(completed.returncode, completed.stdout, completed.stderr)

    def run_python(self, code: str, cwd: str) -> Result:
        return self._invoke([str(self.python), "-c", code], cwd)

    def run(self, name: str, args: tuple[str, ...], cwd: str) -> Result:
        path = script_path(self.bin_dir, name)
        if not path.exists():
            raise SystemExit(f"{path}: installed console script not found")
        if self.direct:
            try:
                return self._invoke([str(path), *args], cwd)
            except PermissionError:
                # A noexec mount refuses the shebang, so read the same installed
                # script through the environment's own interpreter instead.
                if path.suffix == ".exe":
                    raise
                self.direct = False
                print(f"{path.parent}: noexec, running console scripts through python")
        return self._invoke([str(self.python), str(path), *args], cwd)


def characterize(runner: Runner) -> tuple[list[str], int]:
    """Replay every characterized case through the installed console scripts."""
    surface = load_command_surface()
    problems: list[str] = []
    for case in surface.CASES:
        script = SCRIPT_FOR_CASE.get(case.command, case.command)
        with tempfile.TemporaryDirectory() as work:
            for name in case.empty_files:
                (Path(work) / name).touch()
            result = runner.run(script, case.argv, work)
        problems.extend(characterized_problems(surface, case, result))
    return problems, len(surface.CASES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="check_installed_route_parity.py",
        description="Compare installed Vivary verbs with the standalone commands.",
    )
    parser.add_argument(
        "bin_dir",
        help="script directory of a virtual environment with vivary installed",
    )
    parser.add_argument(
        "--characterize",
        action="store_true",
        help="replay the characterization table through the installed scripts",
    )
    args = parser.parse_args(argv)

    bin_dir = Path(args.bin_dir).expanduser().resolve()
    if not bin_dir.is_dir():
        print(f"{bin_dir}: not a directory", file=sys.stderr)
        return 2

    runner = Runner(bin_dir)
    problems: list[str] = []

    if args.characterize:
        problems, cases = characterize(runner)
        if problems:
            for problem in problems:
                print(problem, file=sys.stderr)
            print(f"{bin_dir}: installed command surface failed", file=sys.stderr)
            return 1
        print(f"{bin_dir}: installed command surface passed ({cases} case(s))")
        return 0

    with tempfile.TemporaryDirectory() as work:
        for name, command_args in LEGACY_COMMANDS:
            label = " ".join((name, *command_args))
            result = runner.run(name, command_args, work)
            if result.code != 0:
                problems.append(f"{label}: exited {result.code}")
            if result.stderr != "":
                problems.append(f"{label}: wrote stderr")

        probe = runner.run_python(ROUTE_PROBE, work)
        if probe.code != 0:
            print(probe.stderr, file=sys.stderr)
            print(f"{bin_dir}: could not read the installed route table", file=sys.stderr)
            return 2
        routes = json.loads(probe.stdout)

        helps = 0
        usage_errors = 0
        fixtures = 0
        for verb, module, operation in routes:
            name = routed_prog(verb)
            cases = [("--help",), (UNKNOWN_FLAG,)]
            if verb in FIXTURE_ARGS:
                cases.append(FIXTURE_ARGS[verb])
            for case in cases:
                routed = runner.run("vivary", (verb, *case), work)
                expected = runner.run_python(
                    oracle_source(module, operation, case, name), work
                )
                label = f"vivary {verb} {' '.join(case)}"
                problems.extend(compare(label, routed, expected))
                if case == ("--help",):
                    if not routed.stdout.startswith(f"usage: {name}"):
                        problems.append(f"{label}: routed help does not name {name}")
                    helps += 1
                elif case == (UNKNOWN_FLAG,):
                    problems.extend(usage_error_problems(label, name, routed))
                    usage_errors += 1
                else:
                    fixtures += 1

        standalone = runner.run(
            UNROUTED_COMMAND, (UNROUTED_OPERATION, *UNROUTED_ARGS), work
        )
        routed = runner.run("vivary", (UNROUTED_OPERATION, *UNROUTED_ARGS), work)
        front_door_help = runner.run("vivary", ("--help",), work).stdout
        problems.extend(
            unrouted_problems(UNROUTED_OPERATION, standalone, routed, front_door_help)
        )

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        print(f"{bin_dir}: installed route parity failed", file=sys.stderr)
        return 1

    print(
        f"{bin_dir}: installed route parity passed"
        f" ({len(LEGACY_COMMANDS)} legacy command(s), {helps} help parity,"
        f" {usage_errors} usage-error parity, {fixtures} fixture parity,"
        " 1 unrouted operation)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
