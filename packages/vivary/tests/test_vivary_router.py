"""Prove the ten task-first verbs behave exactly like the standalone commands.

Each verb is compared against its component invocation in exit code, stdout, and
stderr. `create` and `adopt` write a workspace, so they have no read-only offline
fixture and are compared on help output only. The refusal paths run in-process
against stand-in modules, because a missing or prerelease component cannot be
staged from this checkout.
"""

import argparse
import contextlib
import importlib
import io
import os
import re
import sys
import tempfile
import tomllib
import types
import unittest
from pathlib import Path
from typing import NamedTuple

from cli_runner import run_cli
from route_prog import (
    COMMAND_FOR_MODULE,
    normalize_prog,
    routed_prog,
    standalone_prog,
)

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
COMPONENT_FILES = {
    "create_vivary": str(PACKAGES / "create-vivary" / "create_vivary.py"),
    "tropo": str(PACKAGES / "tropo" / "tropo.py"),
    "strato": str(PACKAGES / "strato" / "strato.py"),
    "ozone": str(PACKAGES / "ozone" / "ozone.py"),
    "exo": str(PACKAGES / "exo" / "exo.py"),
}
UNROUTED_MODULE = "tropo"
UNROUTED_OPERATION = "map"
STAND_IN_VERB = "check"
SEAM_VERBS = ("create", "check", "decide", "review", "control")

# Each installed version paired with whether the tropo floor of 0.5.4 accepts it.
FLOOR_CASES = (
    ("0.5.3", False),
    ("0.5.4rc1", False),
    ("0.5.4.dev1", False),
    ("0.5.4", True),
    ("0.5.4.post1", True),
    ("0.5.5rc1", True),
    ("0.6", True),
)


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
) % (tuple(vivary_cli.COMPONENTS),)


def run(argv: list[str], cwd: str) -> tuple[int, str, str]:
    return run_cli(argv, cwd, IMPORT_PATHS)


def front_door_help() -> tuple[int, str, str]:
    with tempfile.TemporaryDirectory() as work:
        return run([VIVARY_CLI, "--help"], work)


@contextlib.contextmanager
def stand_in_component(module_name: str, stand_in: types.ModuleType | None):
    """Route one verb at a stand-in module and read its version, not the wheel's.

    `importlib.metadata` answers for whatever is installed beside this checkout,
    so the lookup has to miss before the fallback to `__version__` can be seen.
    """
    saved_module = sys.modules.get(module_name)
    saved_version = vivary_cli.importlib.metadata.version

    def not_installed(distribution):
        raise vivary_cli.importlib.metadata.PackageNotFoundError(distribution)

    sys.modules[module_name] = stand_in
    vivary_cli.importlib.metadata.version = not_installed
    try:
        yield
    finally:
        vivary_cli.importlib.metadata.version = saved_version
        if saved_module is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = saved_module


def call_main(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = vivary_cli.main(argv)
    return code, out.getvalue(), err.getvalue()


class RouteParityTests(unittest.TestCase):
    def run_both(self, case: ParityCase):
        route = vivary_cli.ROUTE_BY_VERB[case.verb]
        with tempfile.TemporaryDirectory() as work:
            routed = run([VIVARY_CLI, route.verb, *case.args], work)
        with tempfile.TemporaryDirectory() as work:
            standalone = run(
                [COMPONENT_FILES[route.module], *route.operation, *case.args], work
            )
        return route, routed, standalone

    def assert_parity(self, case: ParityCase) -> None:
        _, routed, standalone = self.run_both(case)
        self.assertEqual(routed, standalone)

    def test_help_matches_the_standalone_command(self):
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                _, routed, standalone = self.run_both(
                    ParityCase(route.verb, ("--help",))
                )
                names = (
                    standalone_prog(route.module, route.operation),
                    routed_prog(route.verb),
                )
                self.assertEqual(routed[0], standalone[0])
                for index in (1, 2):
                    self.assertEqual(
                        normalize_prog(routed[index], names[1], names[1]),
                        normalize_prog(standalone[index], *names),
                    )

    def test_routed_help_names_the_front_door(self):
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                with tempfile.TemporaryDirectory() as work:
                    code, out, err = run([VIVARY_CLI, route.verb, "--help"], work)
                self.assertEqual(code, 0, err)
                self.assertTrue(
                    out.startswith(f"usage: vivary {route.verb}"), out[:80]
                )

    def test_offline_fixtures_match_the_standalone_command(self):
        for case in FIXTURE_CASES:
            with self.subTest(verb=case.verb, args=case.args):
                self.assert_parity(case)


class ProgSeamTests(unittest.TestCase):
    @contextlib.contextmanager
    def no_receipt_log(self):
        saved = os.environ.pop("VIVARY_RECEIPT_LOG", None)
        try:
            yield
        finally:
            if saved is not None:
                os.environ["VIVARY_RECEIPT_LOG"] = saved

    def help_usage(self, module, operation, prog) -> str:
        out = io.StringIO()
        with self.no_receipt_log(), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as raised:
                module.main([*operation, "--help"], **({"prog": prog} if prog else {}))
        self.assertEqual(raised.exception.code, 0)
        return out.getvalue()

    def test_the_characterization_suite_freezes_every_standalone_help(self):
        import test_command_surface_characterization as surface

        frozen = {
            case.command: case.stdout_exact
            for case in surface.CASES
            if case.argv == ("--help",)
        }
        for verb in SEAM_VERBS:
            command = COMMAND_FOR_MODULE[vivary_cli.ROUTE_BY_VERB[verb].module]
            with self.subTest(command=command):
                self.assertIsNotNone(frozen.get(command))

    def test_a_component_renders_the_routed_usage_line(self):
        for verb in SEAM_VERBS:
            route = vivary_cli.ROUTE_BY_VERB[verb]
            module = importlib.import_module(route.module)
            with self.subTest(verb=verb):
                routed = self.help_usage(module, route.operation, routed_prog(verb))
                self.assertTrue(
                    routed.startswith(f"usage: {routed_prog(verb)}"), routed[:80]
                )

    def test_a_component_without_prog_keeps_its_standalone_usage_line(self):
        for verb in SEAM_VERBS:
            route = vivary_cli.ROUTE_BY_VERB[verb]
            module = importlib.import_module(route.module)
            with self.subTest(verb=verb):
                standalone = self.help_usage(module, route.operation, None)
                name = standalone_prog(route.module, route.operation)
                self.assertTrue(standalone.startswith(f"usage: {name}"), standalone[:80])


class ProgKeywordTests(unittest.TestCase):
    def test_a_component_without_the_seam_is_called_verbatim(self):
        def legacy_main(argv=None):
            return 0

        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        self.assertEqual(vivary_cli._prog_keyword(legacy_main, route), {})

    def test_a_component_with_the_seam_is_named_for_the_front_door(self):
        def seam_main(argv=None, *, prog=None):
            return 0

        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        self.assertEqual(
            vivary_cli._prog_keyword(seam_main, route),
            {"prog": routed_prog(STAND_IN_VERB)},
        )

    def test_the_router_passes_prog_only_to_a_component_that_accepts_it(self):
        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        component = vivary_cli.COMPONENTS[route.module]
        for accepts in (False, True):
            with self.subTest(accepts=accepts):
                calls = []
                if accepts:
                    def record(argv=None, *, prog=None, calls=calls):
                        calls.append((argv, prog))
                        return 0
                else:
                    def record(argv=None, calls=calls):
                        calls.append((argv, None))
                        return 0

                stand_in = types.ModuleType(route.module)
                stand_in.__version__ = component.floor
                stand_in.main = record
                with stand_in_component(route.module, stand_in):
                    code, _, err = call_main([route.verb])
                self.assertEqual(code, 0, err)
                expected = routed_prog(STAND_IN_VERB) if accepts else None
                self.assertEqual(calls, [(list(route.operation), expected)])


class FrontDoorHelpTests(unittest.TestCase):
    def test_help_names_every_verb_group_and_advanced_command(self):
        code, out, err = front_door_help()
        self.assertEqual(code, 0, err)
        usage = out.split("\n\n", 1)[0]
        groups = {
            vivary_cli.COMPONENTS[route.module].group for route in vivary_cli.ROUTES
        }
        for group in groups:
            self.assertIn(f"\n  {group}\n", out)
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                self.assertRegex(usage, rf"\b{route.verb}\b")
                self.assertRegex(
                    out, rf"(?m)^ +{route.verb} +{re.escape(route.summary)}$"
                )
        self.assertIn("Advanced:", out)
        for name, _ in vivary_cli.ADVANCED_COMMANDS:
            self.assertRegex(out, rf"(?m)^ +{re.escape(name)} ")

    def test_every_help_line_fits_the_width_budget(self):
        code, out, err = front_door_help()
        self.assertEqual(code, 0, err)
        too_wide = [line for line in out.splitlines() if len(line) > 79]
        self.assertEqual(too_wide, [])

    def test_every_verb_is_a_parser_choice_beside_the_receipt_commands(self):
        verbs = set(vivary_cli.ROUTE_BY_VERB)
        self.assertEqual(verbs & set(vivary_cli.HELPER_COMMANDS), set())
        parser = vivary_cli.build_parser()
        choices: dict[str, argparse.ArgumentParser] = {}
        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                choices = action.choices
        self.assertTrue(verbs.issubset(choices), sorted(verbs - set(choices)))
        for name in vivary_cli.HELPER_COMMANDS:
            self.assertIn(name, choices)


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
            standalone = run([COMPONENT_FILES[UNROUTED_MODULE], *args], work)
            routed = run([VIVARY_CLI, *args], work)
        self.assertEqual(standalone[0], 0, standalone[2])
        self.assertIn(f"tropo {UNROUTED_OPERATION}", standalone[1])
        self.assertEqual(routed[0], 2)
        self.assertEqual(routed[1], "")
        self.assertIn("usage: vivary", routed[2])
        self.assertIsNone(
            re.search(rf"(?m)^\s+{UNROUTED_OPERATION}\b", front_door_help()[1])
        )

    def test_version_imports_no_component(self):
        with tempfile.TemporaryDirectory() as work:
            code, out, err = run(["-c", VERSION_PROBE], work)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.splitlines()[-1], "[]")

    def test_missing_component_names_the_install_command(self):
        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        component = vivary_cli.COMPONENTS[route.module]
        saved = sys.modules.get(route.module)
        sys.modules[route.module] = None
        try:
            code, out, err = call_main([route.verb])
        finally:
            if saved is None:
                sys.modules.pop(route.module, None)
            else:
                sys.modules[route.module] = saved
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn(component.distribution, err)
        self.assertIn("pip install", err)

    def test_module_without_a_main_is_refused(self):
        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        component = vivary_cli.COMPONENTS[route.module]
        stand_in = types.ModuleType(route.module)
        stand_in.__version__ = component.floor
        with stand_in_component(route.module, stand_in):
            code, out, err = call_main([route.verb])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn(f"not {component.distribution}", err)

    def test_the_floor_orders_prereleases_below_their_release(self):
        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        component = vivary_cli.COMPONENTS[route.module]
        for installed, accepted in FLOOR_CASES:
            with self.subTest(installed=installed):
                calls = []
                stand_in = types.ModuleType(route.module)
                stand_in.__version__ = installed

                def record(argv, calls=calls):
                    calls.append(argv)
                    return 0

                stand_in.main = record
                with stand_in_component(route.module, stand_in):
                    code, out, err = call_main([route.verb])
                if accepted:
                    self.assertEqual(code, 0, err)
                    self.assertEqual(calls, [list(route.operation)])
                else:
                    self.assertEqual(code, 2)
                    self.assertEqual(out, "")
                    self.assertEqual(calls, [])
                    self.assertIn(component.distribution, err)
                    self.assertIn(component.floor, err)

    def test_component_below_its_floor_is_refused(self):
        route = vivary_cli.ROUTE_BY_VERB[STAND_IN_VERB]
        component = vivary_cli.COMPONENTS[route.module]
        stand_in = types.ModuleType(route.module)
        stand_in.__version__ = "0.0.1"

        def refuse(argv=None):
            raise AssertionError("the router ran a component below its floor")

        stand_in.main = refuse
        with stand_in_component(route.module, stand_in):
            code, out, err = call_main([route.verb])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn(component.floor, err)


class RouteTableTests(unittest.TestCase):
    def test_table_holds_ten_unique_verbs(self):
        self.assertEqual(len(vivary_cli.ROUTES), 10)
        verbs = [route.verb for route in vivary_cli.ROUTES]
        self.assertEqual(len(set(verbs)), 10)
        self.assertEqual(set(vivary_cli.ROUTE_BY_VERB), set(verbs))

    def test_every_route_names_a_known_component(self):
        for route in vivary_cli.ROUTES:
            with self.subTest(verb=route.verb):
                self.assertIn(route.module, vivary_cli.COMPONENTS)
        for module, component in vivary_cli.COMPONENTS.items():
            with self.subTest(module=module):
                self.assertEqual(component.module, module)

    def test_every_floor_matches_the_declared_dependency(self):
        manifest = tomllib.loads(
            (PACKAGES / "vivary" / "pyproject.toml").read_text(encoding="utf-8")
        )["project"]
        for module, component in vivary_cli.COMPONENTS.items():
            with self.subTest(module=module):
                requirement = f"{component.distribution}>={component.floor}"
                self.assertIn(requirement, manifest["dependencies"])


class ReleaseOrderingTests(unittest.TestCase):
    def test_a_release_pads_to_three_places_and_marks_final(self):
        self.assertEqual(vivary_cli._release_tuple("0.6"), ((0, 6, 0), True))
        self.assertEqual(vivary_cli._release_tuple("0.5.4.post1"), ((0, 5, 4), True))
        self.assertEqual(vivary_cli._release_tuple("0.5.4rc1"), ((0, 5, 4), False))
        self.assertEqual(vivary_cli._release_tuple("0.5.4.dev1"), ((0, 5, 4), False))
        self.assertEqual(vivary_cli._release_tuple("0.5.4+local"), ((0, 5, 4), False))

    def test_the_floor_comparison_matches_the_recorded_cases(self):
        for installed, accepted in FLOOR_CASES:
            with self.subTest(installed=installed):
                self.assertEqual(
                    vivary_cli._below_floor(installed, "0.5.4"), not accepted
                )


if __name__ == "__main__":
    unittest.main()
