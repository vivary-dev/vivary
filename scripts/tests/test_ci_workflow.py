"""Behavior tests for the repository CI workflow contract guard."""

import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts" / "check_ci_workflow.py"
REAL_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"


def _load():
    spec = importlib.util.spec_from_file_location("ci_workflow_contract", GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.WORKFLOW = REAL_WORKFLOW
    return module


def _run(workflow_text=None):
    module = _load()
    if workflow_text is None:
        try:
            module.main()
        except SystemExit as exc:
            return str(exc)
        return None

    with tempfile.TemporaryDirectory() as tmp:
        workflow = Path(tmp) / "ci.yml"
        workflow.write_text(workflow_text, encoding="utf-8")
        module.WORKFLOW = workflow
        try:
            module.main()
        except SystemExit as exc:
            return str(exc)
    return None


def _workflow(site_steps: str, trailing_job: str = "") -> str:
    return (
        "name: ci\n"
        "jobs:\n"
        "  test:\n"
        "    steps:\n"
        "      - name: install Python test runner\n"
        "        run: python -m pip install pytest packaging\n"
        "      - name: CI workflow contract\n"
        "        run: python scripts/check_ci_workflow.py\n"
        "      - name: CI workflow contract tests\n"
        "        run: python scripts/tests/test_ci_workflow.py\n"
        "      - name: core\n"
        "        run: python -m pytest packages/core/tests/ -q\n"
        "\n"
        "  governed-platform-proof:\n"
        "    steps: []\n"
        "\n"
        "  site:\n"
        "    steps:\n"
        f"{site_steps}"
        f"{trailing_job}"
    )


INSTALL = (
    "      - name: install\n"
    "        run: npm ci\n"
    "        working-directory: site\n"
)
AUDIT = (
    "      - name: audit high and critical site dependencies\n"
    "        run: npm audit --audit-level=high\n"
    "        working-directory: site\n"
)
CONTRACT_TEST_COMMAND = "python scripts/tests/test_ci_workflow.py"


def test_real_workflow_passes_and_is_not_modified():
    before = REAL_WORKFLOW.read_bytes()
    assert _run() is None
    assert REAL_WORKFLOW.read_bytes() == before


def test_ci_contract_regression_suite_must_run():
    workflow = _workflow(INSTALL + AUDIT).replace(
        CONTRACT_TEST_COMMAND,
        "echo contract tests skipped",
    )
    message = _run(workflow)
    assert message, "CI must execute the contract's negative regression suite"
    assert CONTRACT_TEST_COMMAND in message


def test_missing_site_audit_gate_fails():
    message = _run(_workflow(INSTALL))
    assert message, "a workflow without the blocking audit must fail"
    assert "npm audit --audit-level=high" in message


def test_site_audit_must_follow_install():
    message = _run(_workflow(AUDIT + INSTALL))
    assert message, "auditing before the locked install must fail"
    assert "must follow" in message


def test_site_audit_must_run_in_site_directory():
    wrong_directory = AUDIT.replace("working-directory: site", "working-directory: .")
    message = _run(_workflow(INSTALL + wrong_directory))
    assert message, "auditing the repository root must fail"
    assert "working-directory: site" in message


def test_site_audit_in_later_job_does_not_satisfy_contract():
    later_job = (
        "\n"
        "  release:\n"
        "    steps:\n"
        f"{AUDIT}"
    )
    message = _run(_workflow(INSTALL, later_job))
    assert message, "an audit in another job must not satisfy the site contract"
    assert "npm audit --audit-level=high" in message


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
