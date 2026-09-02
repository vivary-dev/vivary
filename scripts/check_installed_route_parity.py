"""Prove the installed Vivary front door matches the standalone commands.

Given the script directory of a virtual environment that has `vivary` and its
components installed, this runs every legacy help command, compares each routed
verb against the component invocation it stands for, and checks that an unrouted
component operation stays standalone and stays out of the front door's help.
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

COMMAND_FOR_MODULE = {
    "create_vivary": "create-vivary",
    "tropo": "tropo",
    "strato": "strato",
    "ozone": "ozone",
    "exo": "exo",
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


def compare(label: str, routed: Result, standalone: Result) -> list[str]:
    problems = []
    if routed.code != standalone.code:
        problems.append(
            f"{label}: exit code {routed.code} does not match {standalone.code}"
        )
    if routed.stdout != standalone.stdout:
        problems.append(f"{label}: stdout does not match the standalone command")
    if routed.stderr != standalone.stderr:
        problems.append(f"{label}: stderr does not match the standalone command")
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="check_installed_route_parity.py",
        description="Compare installed Vivary verbs with the standalone commands.",
    )
    parser.add_argument(
        "bin_dir",
        help="script directory of a virtual environment with vivary installed",
    )
    args = parser.parse_args(argv)

    bin_dir = Path(args.bin_dir).expanduser().resolve()
    if not bin_dir.is_dir():
        print(f"{bin_dir}: not a directory", file=sys.stderr)
        return 2

    runner = Runner(bin_dir)
    problems: list[str] = []
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
        fixtures = 0
        for verb, module, operation in routes:
            command = COMMAND_FOR_MODULE[module]
            cases = [("--help",)]
            if verb in FIXTURE_ARGS:
                cases.append(FIXTURE_ARGS[verb])
            for case in cases:
                routed = runner.run("vivary", (verb, *case), work)
                standalone = runner.run(command, (*operation, *case), work)
                label = f"vivary {verb} {' '.join(case)}"
                problems.extend(compare(label, routed, standalone))
                if case == ("--help",):
                    helps += 1
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
        f" {fixtures} fixture parity, 1 unrouted operation)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
