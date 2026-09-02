"""Offline behavior tests for the installed route parity checker."""

import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "scripts" / "check_installed_route_parity.py"
VIVARY_PACKAGE = ROOT / "packages" / "vivary"


def _load():
    spec = importlib.util.spec_from_file_location("installed_route_parity", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _result(module, code=0, stdout="out", stderr=""):
    return module.Result(code, stdout, stderr)


def test_identical_results_are_parity():
    module = _load()
    routed = _result(module)
    standalone = _result(module)
    assert module.compare("vivary check --help", routed, standalone) == []


def test_exit_code_mismatch_is_reported():
    module = _load()
    problems = module.compare(
        "vivary check --help", _result(module, code=1), _result(module)
    )
    assert len(problems) == 1
    assert "exit code 1 does not match 0" in problems[0]


def test_stream_mismatches_are_reported_per_stream():
    module = _load()
    stdout_problems = module.compare(
        "vivary find", _result(module, stdout="other"), _result(module)
    )
    assert len(stdout_problems) == 1
    assert "stdout does not match" in stdout_problems[0]

    stderr_problems = module.compare(
        "vivary find", _result(module, stderr="boom"), _result(module)
    )
    assert len(stderr_problems) == 1
    assert "stderr does not match" in stderr_problems[0]


def test_every_stream_can_fail_at_once():
    module = _load()
    problems = module.compare(
        "vivary decide",
        _result(module, code=2, stdout="a", stderr="b"),
        _result(module, code=0, stdout="c", stderr="d"),
    )
    assert len(problems) == 3


def test_unrouted_operation_stays_standalone():
    module = _load()
    problems = module.unrouted_problems(
        "map",
        _result(module, code=0, stdout="# tropo map"),
        _result(module, code=2, stdout="", stderr="usage: vivary\nerror"),
        "Task verbs:\n\n  Graph and retrieval\n    check  Validate the graph\n",
    )
    assert problems == []


def test_broken_standalone_operation_is_reported():
    module = _load()
    problems = module.unrouted_problems(
        "map",
        _result(module, code=1, stdout=""),
        _result(module, code=2, stdout="", stderr="usage: vivary"),
        "Task verbs:\n",
    )
    assert len(problems) == 1
    assert "the standalone operation exited 1" in problems[0]


def test_a_silently_routed_operation_is_reported():
    module = _load()
    problems = module.unrouted_problems(
        "map",
        _result(module, code=0, stdout="# tropo map"),
        _result(module, code=0, stdout="# tropo map", stderr=""),
        "Task verbs:\n",
    )
    assert any("instead of the usage error 2" in problem for problem in problems)
    assert any("no vivary usage error" in problem for problem in problems)


def test_usage_error_must_not_write_stdout():
    module = _load()
    problems = module.unrouted_problems(
        "map",
        _result(module, code=0, stdout="# tropo map"),
        _result(module, code=2, stdout="leaked", stderr="usage: vivary"),
        "Task verbs:\n",
    )
    assert len(problems) == 1
    assert "must not write stdout" in problems[0]


def test_help_that_lists_the_unrouted_operation_is_reported():
    module = _load()
    problems = module.unrouted_problems(
        "map",
        _result(module, code=0, stdout="# tropo map"),
        _result(module, code=2, stdout="", stderr="usage: vivary"),
        "Task verbs:\n\n  Graph and retrieval\n    map    Draw the tree\n",
    )
    assert len(problems) == 1
    assert "lists the unrouted operation map" in problems[0]


def test_script_path_prefers_the_windows_executable():
    module = _load()
    with tempfile.TemporaryDirectory() as tmp:
        bin_dir = Path(tmp)
        assert module.script_path(bin_dir, "vivary") == bin_dir / "vivary"
        (bin_dir / "vivary.exe").touch()
        assert module.script_path(bin_dir, "vivary") == bin_dir / "vivary.exe"


def test_a_missing_script_directory_is_a_usage_error():
    module = _load()
    with tempfile.TemporaryDirectory() as tmp:
        assert module.main([str(Path(tmp) / "absent")]) == 2


def test_every_routed_module_has_a_console_script_name():
    module = _load()
    if str(VIVARY_PACKAGE) not in sys.path:
        sys.path.insert(0, str(VIVARY_PACKAGE))
    import vivary_cli

    for route in vivary_cli.ROUTES:
        assert route.module in module.COMMAND_FOR_MODULE, route.verb


def test_fixture_arguments_cover_every_non_writing_verb():
    module = _load()
    if str(VIVARY_PACKAGE) not in sys.path:
        sys.path.insert(0, str(VIVARY_PACKAGE))
    import vivary_cli

    writing = {"create", "adopt"}
    verbs = {route.verb for route in vivary_cli.ROUTES}
    assert set(module.FIXTURE_ARGS) == verbs - writing


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    passed = 0
    for test in tests:
        try:
            test()
            print(f"  ok  {test.__name__}")
            passed += 1
        except Exception as exc:
            print(f"FAIL  {test.__name__}: {exc}")
    print(f"\n{passed}/{len(tests)} passed")
    sys.exit(0 if passed == len(tests) else 1)
