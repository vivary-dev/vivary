"""Prove the ten task-first verbs behave exactly like the standalone commands.

Each verb is compared against its component invocation in exit code, stdout, and
stderr. `create` and `adopt` write a workspace, so they have no read-only offline
fixture and are compared on help output only.
"""

import contextlib
import io
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import types
import unittest
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[3]
PACKAGES = ROOT / "packages"
VAULT = str(PACKAGES / "tropo" / "examples" / "vault")

IMPORT_PATHS = tuple(
    str(PACKAGES / name)
    for name in ("vivary", "create-vivary", "tropo", "strato", "ozone", "exo", "core")
)

for _path in IMPORT_PATHS:
    if _path not in sys.path:
        sys.path.insert(0, _path)

import vivary_cli

VIVARY_CLI = str(PACKAGES / "vivary" / "vivary_cli.py")
MODULE_FILES = {
    "create_vivary": str(PACKAGES / "create-vivary" / "create_vivary.py"),
    "tropo": str(PACKAGES / "tropo" / "tropo.py"),
    "strato": str(PACKAGES / "strato" / "strato.py"),
    "ozone": str(PACKAGES / "ozone" / "ozone.py"),
    "exo": str(PACKAGES / "exo" / "exo.py"),
}
DISTRIBUTIONS = {
    "create_vivary": "create-vivary",
    "tropo": "vivary-tropo",
    "strato": "vivary-strato",
    "ozone": "vivary-ozone",
    "exo": "vivary-exo",
}
COMPONENT_MODULES = ("create_vivary", "tropo", "strato", "ozone", "exo")
UNROUTED_MODULE = "tropo"
UNROUTED_OPERATION = "map"


class ParityCase(NamedTuple):
    verb: str
    args: tuple[str, ...]


FIXTURE_CASES = (
    ParityCase("doctor", (".",)),
    ParityCase("capabilities", ("--preset", "coding")),
    ParityCase("check", ("--root", VAULT)),
    ParityCase("find", ("vault", "--root", VAULT)),
    ParityCase("decide", ("--governed", "missing.json")),
    ParityCase("review", ("--root", VAULT)),
    ParityCase("impact", ("nope-id", "--root", VAULT)),
    ParityCase("control", ("--governed", "missing.json", "--strict")),
)

VERSION_PROBE = (
    "import json, sys, vivary_cli\n"
    "try:\n"
    "    vivary_cli.main(['--version'])\n"
    "except SystemExit:\n"
    "    pass\n"
    "names = [name for name in %r if name in sys.modules]\n"
    "print(json.dumps(names))\n"
) % (COMPONENT_MODULES,)


def subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("VIVARY_RECEIPT_LOG", None)
    env.pop("PYTHONWARNINGS", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["COLUMNS"] = "80"
    env["PYTHONPATH"] = os.pathsep.join(IMPORT_PATHS)
    return env


def run(argv: list[str], cwd: str) -> tuple[int, str, str]:
    completed = subprocess.run(
        [sys.executable, *argv],
        cwd=cwd,
        env=subprocess_env(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        encoding="utf-8",
        check=False,
        timeout=120,
    )
    return completed.returncode, completed.stdout, completed.stderr


class RouteParityTests(unittest.TestCase):
    def assert_parity(self, case: ParityCase) -> None:
        route = vivary_cli.ROUTE_BY_VERB[case.verb]
        with tempfile.TemporaryDirectory() as work:
            routed = run([VIVARY_CLI, route.verb, *case.args], work)
            standalone = run(
                [MODULE_FILES[route.module], *route.operation, *case.args], work
            )
        self.assertEqual(routed, standalone)

    def test_help_matches_the_standalone_command(self):
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                self.assert_parity(ParityCase(route.verb, ("--help",)))

    def test_offline_fixtures_match_the_standalone_command(self):
        for case in FIXTURE_CASES:
            with self.subTest(verb=case.verb, args=case.args):
                self.assert_parity(case)


class RouterBehaviorTests(unittest.TestCase):
    def test_unknown_verb_reports_usage_and_exits_two(self):
        with tempfile.TemporaryDirectory() as work:
            code, out, err = run([VIVARY_CLI, "nope"], work)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("usage: vivary", err)

    def test_unrouted_component_operation_stays_standalone(self):
        self.assertNotIn(UNROUTED_OPERATION, vivary_cli.ROUTE_BY_VERB)
        args = [UNROUTED_OPERATION, "--root", VAULT]
        with tempfile.TemporaryDirectory() as work:
            standalone = run([MODULE_FILES[UNROUTED_MODULE], *args], work)
            routed = run([VIVARY_CLI, *args], work)
            front_door_help = run([VIVARY_CLI, "--help"], work)
        self.assertEqual(standalone[0], 0, standalone[2])
        self.assertIn(f"tropo {UNROUTED_OPERATION}", standalone[1])
        self.assertEqual(routed[0], 2)
        self.assertEqual(routed[1], "")
        self.assertIn("usage: vivary", routed[2])
        self.assertIsNone(
            re.search(rf"(?m)^\s+{UNROUTED_OPERATION}\b", front_door_help[1])
        )

    def test_version_imports_no_component(self):
        with tempfile.TemporaryDirectory() as work:
            code, out, err = run(["-c", VERSION_PROBE], work)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.splitlines()[-1], "[]")

    def test_component_below_its_floor_is_refused(self):
        route = vivary_cli.ROUTE_BY_VERB["check"]
        stand_in = types.ModuleType(route.module)
        stand_in.__version__ = "0.0.1"

        def refuse(argv=None):
            raise AssertionError("the router ran a component below its floor")

        stand_in.main = refuse
        saved = sys.modules.get(route.module)
        sys.modules[route.module] = stand_in
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = vivary_cli.main([route.verb])
        finally:
            if saved is None:
                sys.modules.pop(route.module, None)
            else:
                sys.modules[route.module] = saved
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn(route.floor, err.getvalue())


class RouteTableTests(unittest.TestCase):
    def test_table_holds_ten_unique_verbs(self):
        self.assertEqual(len(vivary_cli.ROUTES), 10)
        verbs = [route.verb for route in vivary_cli.ROUTES]
        self.assertEqual(len(set(verbs)), 10)
        self.assertEqual(set(vivary_cli.ROUTE_BY_VERB), set(verbs))

    def test_every_floor_matches_the_declared_dependency(self):
        manifest = tomllib.loads(
            (PACKAGES / "vivary" / "pyproject.toml").read_text(encoding="utf-8")
        )["project"]
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                requirement = f"{DISTRIBUTIONS[route.module]}>={route.floor}"
                self.assertIn(requirement, manifest["dependencies"])


if __name__ == "__main__":
    unittest.main()
