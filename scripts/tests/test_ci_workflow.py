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


RELEASE_BUILD_COMMANDS = _load().release_build_commands()


def _workflow(site_steps: str, trailing_job: str = "") -> str:
    return (
        "name: ci\n"
        "on:\n"
        "  workflow_dispatch:\n"
        "    inputs:\n"
        "      head_sha:\n"
        "        required: true\n"
        "      base_sha:\n"
        "        required: true\n"
        "      pull_request_number:\n"
        "        required: true\n"
        "permissions:\n"
        "  contents: read\n"
        "  pull-requests: read\n"
        "jobs:\n"
        "  changes:\n"
        "    steps:\n"
        "      - name: validate dispatched pull request\n"
        "        env:\n"
        "          HEAD_SHA: ${{ inputs.head_sha }}\n"
        "          BASE_SHA: ${{ inputs.base_sha }}\n"
        "          PR_NUMBER: ${{ inputs.pull_request_number }}\n"
        "        run: |\n"
        "          test \"$GITHUB_SHA\" = \"$HEAD_SHA\"\n"
        "          LIVE_HEAD=$(gh pr view \"$PR_NUMBER\" --json headRefOid --jq .headRefOid)\n"
        "          LIVE_BASE=$(gh pr view \"$PR_NUMBER\" --json baseRefOid --jq .baseRefOid)\n"
        "          test \"$LIVE_HEAD\" = \"$HEAD_SHA\"\n"
        "          test \"$LIVE_BASE\" = \"$BASE_SHA\"\n"
        "      - name: detect site inputs\n"
        "        env:\n"
        "          BASE_SHA: ${{ inputs.base_sha || github.event.pull_request.base.sha || github.event.before }}\n"
        "          HEAD_SHA: ${{ inputs.head_sha || github.event.pull_request.head.sha || github.sha }}\n"
        "        run: echo detect\n"
        "\n"
        "  test:\n"
        "    needs: changes\n"
        "    if: ${{ always() }}\n"
        "    steps:\n"
        "      - name: require changed-path and dispatch validation\n"
        "        if: needs.changes.result != 'success'\n"
        "        run: exit 1\n"
        "      - name: install Python test runner\n"
        "        run: python -m pip install pytest packaging\n"
        "      - name: CI workflow contract\n"
        "        run: python scripts/check_ci_workflow.py\n"
        "      - name: CI workflow contract tests\n"
        "        run: python scripts/tests/test_ci_workflow.py\n"
        "      - name: repository automation contract\n"
        "        run: python scripts/check_repository_automation.py\n"
        "      - name: repository automation contract tests\n"
        "        run: python scripts/tests/test_repository_automation.py\n"
        "      - name: repository automation behavior tests\n"
        "        run: python -m pytest scripts/tests/test_update_stats.py scripts/tests/test_steward_health.py -q\n"
        "      - name: install release build frontend\n"
        "        run: python -m pip install uv==0.11.21\n"
        "      - name: release artifact contract tests\n"
        "        run: python scripts/tests/test_release_artifacts.py\n"
        "      - name: release artifact license contract\n"
        "        run: |\n"
        "          artifacts=\"$(mktemp -d)\"\n"
        + "".join(f"          {command}\n" for command in RELEASE_BUILD_COMMANDS)
        + "          npm pack packages/create-vivary/npm --pack-destination \"$artifacts\"\n"
        "          python scripts/check_release_artifacts.py --repository . --artifacts \"$artifacts\"\n"
        "      - name: installed route parity contract tests\n"
        "        run: python scripts/tests/test_installed_route_parity.py\n"
        "      - name: core\n"
        "        run: python -m pytest packages/core/tests/ -q\n"
        "      - name: wheelhouse smoke\n"
        "        run: |\n"
        "          assert version(\"vivary-strato\") == \"0.1.3\"\n"
        "      - name: packaged front door smoke\n"
        "        run: python scripts/check_installed_route_parity.py \"$smoke/venv/bin\"\n"
        "      - name: installed command surface\n"
        "        run: python scripts/check_installed_route_parity.py --characterize \"$smoke/venv/bin\"\n"
        "      - name: diff hygiene\n"
        "        env:\n"
        "          BASE_SHA: ${{ inputs.base_sha || github.event.pull_request.base.sha || github.event.before }}\n"
        "        run: git diff --check \"$BASE_SHA...HEAD\"\n"
        "\n"
        "  governed-platform-proof:\n"
        "    needs: changes\n"
        "    steps:\n"
        "      - name: installed-wheel capability surface\n"
        "        shell: pwsh\n"
        "        run: |\n"
        f"          {WINDOWS_PARITY_CHECK_COMMAND}\n"
        "          if ($LASTEXITCODE -ne 0) { throw \"installed route parity failed\" }\n"
        f"          {WINDOWS_PARITY_CHARACTERIZE_COMMAND}\n"
        "          if ($LASTEXITCODE -ne 0) { throw \"installed command surface failed\" }\n"
        "\n"
        "  orientation-proof:\n"
        "    needs: changes\n"
        "    steps: []\n"
        "\n"
        "  review:\n"
        "    needs: changes\n"
        "    if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'\n"
        "    steps: []\n"
        "\n"
        "  site:\n"
        "    needs: changes\n"
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
AUTOMATION_GUARD_COMMAND = "python scripts/check_repository_automation.py"
AUTOMATION_TEST_COMMAND = "python scripts/tests/test_repository_automation.py"
AUTOMATION_BEHAVIOR_COMMAND = (
    "python -m pytest scripts/tests/test_update_stats.py "
    "scripts/tests/test_steward_health.py -q"
)
ARTIFACT_TEST_COMMAND = "python scripts/tests/test_release_artifacts.py"
ARTIFACT_CHECK_COMMAND = (
    'python scripts/check_release_artifacts.py --repository . --artifacts "$artifacts"'
)
PARITY_TEST_COMMAND = "python scripts/tests/test_installed_route_parity.py"
PARITY_CHECK_COMMAND = (
    'python scripts/check_installed_route_parity.py "$smoke/venv/bin"'
)
PARITY_CHARACTERIZE_COMMAND = (
    'python scripts/check_installed_route_parity.py --characterize "$smoke/venv/bin"'
)
WINDOWS_PARITY_CHECK_COMMAND = "python scripts/check_installed_route_parity.py $scripts"
WINDOWS_PARITY_CHARACTERIZE_COMMAND = (
    "python scripts/check_installed_route_parity.py --characterize $scripts"
)
STRATO_PIN = 'assert version("vivary-strato") == "0.1.3"'


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


def test_repository_automation_guard_and_regressions_must_run():
    for command in (AUTOMATION_GUARD_COMMAND, AUTOMATION_TEST_COMMAND):
        workflow = _workflow(INSTALL + AUDIT).replace(command, "echo skipped")
        message = _run(workflow)
        assert message, f"CI must execute {command}"
        assert command in message


def test_repository_automation_behavior_tests_must_run():
    workflow = _workflow(INSTALL + AUDIT).replace(
        AUTOMATION_BEHAVIOR_COMMAND,
        "echo behavior tests skipped",
    )
    message = _run(workflow)
    assert message
    assert "test_update_stats.py" in message


def test_release_artifact_contract_and_real_archives_must_run():
    workflow = _workflow(INSTALL + AUDIT)
    for command in (
        "python -m pip install uv==0.11.21",
        ARTIFACT_TEST_COMMAND,
        *RELEASE_BUILD_COMMANDS,
        'npm pack packages/create-vivary/npm --pack-destination "$artifacts"',
        ARTIFACT_CHECK_COMMAND,
    ):
        message = _run(workflow.replace(command, "echo artifact proof skipped", 1))
        assert message, f"CI must execute {command}"
        assert command in message


def test_installed_route_parity_proofs_must_run():
    workflow = _workflow(INSTALL + AUDIT)
    for command in (
        PARITY_TEST_COMMAND,
        PARITY_CHECK_COMMAND,
        PARITY_CHARACTERIZE_COMMAND,
    ):
        message = _run(workflow.replace(command, "echo parity proof skipped", 1))
        assert message, f"CI must execute {command}"
        assert command in message


def test_installed_command_surface_must_follow_route_parity():
    reordered = _workflow(INSTALL + AUDIT).replace(
        "      - name: packaged front door smoke\n"
        f"        run: {PARITY_CHECK_COMMAND}\n"
        "      - name: installed command surface\n"
        f"        run: {PARITY_CHARACTERIZE_COMMAND}\n",
        "      - name: installed command surface\n"
        f"        run: {PARITY_CHARACTERIZE_COMMAND}\n"
        "      - name: packaged front door smoke\n"
        f"        run: {PARITY_CHECK_COMMAND}\n",
        1,
    )
    message = _run(reordered)
    assert message, "replaying the surface before proving route parity must fail"
    assert "must precede" in message


def test_windows_governed_job_must_prove_installed_route_parity():
    workflow = _workflow(INSTALL + AUDIT)
    for command in (
        WINDOWS_PARITY_CHECK_COMMAND,
        WINDOWS_PARITY_CHARACTERIZE_COMMAND,
    ):
        message = _run(workflow.replace(command, "echo windows proof skipped", 1))
        assert message, f"the Windows job must execute {command}"
        assert command in message


def test_windows_command_surface_must_follow_route_parity():
    reordered = _workflow(INSTALL + AUDIT).replace(
        f"          {WINDOWS_PARITY_CHECK_COMMAND}\n"
        "          if ($LASTEXITCODE -ne 0) { throw \"installed route parity failed\" }\n"
        f"          {WINDOWS_PARITY_CHARACTERIZE_COMMAND}\n",
        f"          {WINDOWS_PARITY_CHARACTERIZE_COMMAND}\n"
        "          if ($LASTEXITCODE -ne 0) { throw \"installed route parity failed\" }\n"
        f"          {WINDOWS_PARITY_CHECK_COMMAND}\n",
        1,
    )
    message = _run(reordered)
    assert message, "replaying the Windows surface before proving parity must fail"
    assert "must precede" in message


def test_wheelhouse_smoke_must_pin_the_installed_strato_version():
    workflow = _workflow(INSTALL + AUDIT).replace(STRATO_PIN, "assert True", 1)
    message = _run(workflow)
    assert message, "the wheelhouse smoke must pin every routed component version"
    assert "vivary-strato" in message


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


def test_dispatch_requires_all_exact_context_inputs():
    workflow = _workflow(INSTALL + AUDIT).replace(
        "      head_sha:\n        required: true\n",
        "",
    )
    message = _run(workflow)
    assert message, "dispatch must bind a required head SHA"
    assert "head_sha" in message


def test_dispatch_must_validate_live_pr_head_and_base():
    workflow = _workflow(INSTALL + AUDIT).replace(
        'LIVE_HEAD=$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)',
        'echo "validation skipped"',
    )
    message = _run(workflow)
    assert message, "dispatch must validate the named PR against live GitHub state"
    assert "headRefOid" in message


def test_dispatch_must_compare_live_head_and_base_to_inputs():
    workflow = _workflow(INSTALL + AUDIT)
    for comparison in (
        'test "$LIVE_HEAD" = "$HEAD_SHA"',
        'test "$LIVE_BASE" = "$BASE_SHA"',
    ):
        message = _run(workflow.replace(comparison, "echo comparison skipped", 1))
        assert message, "reading live PR metadata without comparing it is not validation"
        assert comparison in message


def test_required_check_must_fail_closed_when_dispatch_validation_fails():
    workflow = _workflow(INSTALL + AUDIT)
    for contract in (
        "    if: ${{ always() }}\n",
        "        if: needs.changes.result != 'success'\n",
        "        run: exit 1\n",
    ):
        message = _run(workflow.replace(contract, "", 1))
        assert message, "a validation failure must reach a required failing check"
        assert "must" in message.lower()


def test_dispatch_base_sha_must_reach_diff_hygiene():
    workflow = _workflow(INSTALL + AUDIT).replace(
        "${{ inputs.base_sha || github.event.pull_request.base.sha || github.event.before }}",
        "${{ github.event.pull_request.base.sha || github.event.before }}",
    )
    message = _run(workflow)
    assert message, "dispatch must check the exact PR base range"
    assert "inputs.base_sha" in message


def test_dispatch_must_run_graph_review_gate():
    workflow = _workflow(INSTALL + AUDIT).replace(
        "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'",
        "github.event_name == 'pull_request'",
    )
    message = _run(workflow)
    assert message, "validated dispatches must retain the graph review gate"
    assert "workflow_dispatch" in message


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
