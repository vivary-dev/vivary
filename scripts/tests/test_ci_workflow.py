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
        "        run: python -m pip install uv==0.11.21 setuptools==84.0.0\n"
        "      - name: release artifact contract tests\n"
        "        run: python scripts/tests/test_release_artifacts.py\n"
        "      - name: release artifact license contract\n"
        "        run: |\n"
        "          artifacts=\"$(mktemp -d)\"\n"
        "          uv build --out-dir \"$artifacts\" packages/core\n"
        "          uv build --out-dir \"$artifacts\" packages/tropo\n"
        "          uv build --out-dir \"$artifacts\" packages/strato\n"
        "          uv build --out-dir \"$artifacts\" packages/ozone\n"
        "          uv build --out-dir \"$artifacts\" packages/exo\n"
        "          uv build --out-dir \"$artifacts\" packages/memory-cognee\n"
        "          uv build --out-dir \"$artifacts\" packages/create-vivary\n"
        "          uv build --out-dir \"$artifacts\" packages/mcp\n"
        "          uv build --out-dir \"$artifacts\" packages/vivary\n"
        "          npm pack packages/create-vivary/npm --pack-destination \"$artifacts\"\n"
        "          python scripts/check_release_artifacts.py --repository . --artifacts \"$artifacts\"\n"
        "          wheel_smoke=\"$(mktemp -d)\"\n"
        "          python -m venv \"$wheel_smoke/venv\"\n"
        "          wheel_python=\"$wheel_smoke/venv/bin/python\"\n"
        "          unset PYTHONPATH\n"
        "          uv pip install --python \"$wheel_python\" --no-index --find-links \"$artifacts\" \"vivary==0.1.10\"\n"
        "          uv pip check --python \"$wheel_python\"\n"
        "          \"$wheel_smoke/venv/bin/vivary\" --version\n"
        "          sdist_smoke=\"$(mktemp -d)\"\n"
        "          python -m venv \"$sdist_smoke/venv\"\n"
        "          sdist_python=\"$sdist_smoke/venv/bin/python\"\n"
        "          uv pip install --python \"$sdist_python\" \"setuptools==84.0.0\"\n"
        "          uv pip install --python \"$sdist_python\" --no-index --find-links \"$artifacts\" --no-binary :all: --no-build-isolation \"vivary==0.1.10\"\n"
        "          uv pip check --python \"$sdist_python\"\n"
        "          npm_smoke=\"$(mktemp -d)\"\n"
        "          npm install --prefix \"$npm_smoke\" --offline --ignore-scripts --no-audit --no-fund \"$artifacts/vivary-create-0.4.2.tgz\"\n"
        "          VIVARY_FROM=\"$artifacts/create_vivary-0.4.2-py3-none-any.whl\" UV_FIND_LINKS=\"$artifacts\" UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never \"$npm_smoke/node_modules/.bin/create-vivary\" --version\n"
        "      - name: core\n"
        "        run: python -m pytest packages/core/tests/ -q\n"
        "      - name: diff hygiene\n"
        "        env:\n"
        "          BASE_SHA: ${{ inputs.base_sha || github.event.pull_request.base.sha || github.event.before }}\n"
        "        run: git diff --check \"$BASE_SHA...HEAD\"\n"
        "\n"
        "  governed-platform-proof:\n"
        "    needs: changes\n"
        "    steps: []\n"
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
        "python -m pip install uv==0.11.21 setuptools==84.0.0",
        ARTIFACT_TEST_COMMAND,
        'uv build --out-dir "$artifacts" packages/core',
        'uv build --out-dir "$artifacts" packages/tropo',
        'uv build --out-dir "$artifacts" packages/strato',
        'uv build --out-dir "$artifacts" packages/ozone',
        'uv build --out-dir "$artifacts" packages/exo',
        'uv build --out-dir "$artifacts" packages/memory-cognee',
        'uv build --out-dir "$artifacts" packages/create-vivary',
        'uv build --out-dir "$artifacts" packages/mcp',
        'uv build --out-dir "$artifacts" packages/vivary',
        'npm pack packages/create-vivary/npm --pack-destination "$artifacts"',
        ARTIFACT_CHECK_COMMAND,
        'uv pip install --python "$wheel_python" --no-index --find-links "$artifacts" "vivary==0.1.10"',
        'uv pip check --python "$wheel_python"',
        '"$wheel_smoke/venv/bin/vivary" --version',
        'uv pip install --python "$sdist_python" "setuptools==84.0.0"',
        'uv pip install --python "$sdist_python" --no-index --find-links "$artifacts" --no-binary :all: --no-build-isolation "vivary==0.1.10"',
        'uv pip check --python "$sdist_python"',
        'npm install --prefix "$npm_smoke" --offline --ignore-scripts --no-audit --no-fund "$artifacts/vivary-create-0.4.2.tgz"',
        'VIVARY_FROM="$artifacts/create_vivary-0.4.2-py3-none-any.whl" UV_FIND_LINKS="$artifacts" UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never "$npm_smoke/node_modules/.bin/create-vivary" --version',
    ):
        message = _run(workflow.replace(command, "echo artifact proof skipped", 1))
        assert message, f"CI must execute {command}"
        assert command in message


def test_release_artifact_proof_order_is_fail_closed():
    workflow = _workflow(INSTALL + AUDIT).replace(
        '          npm pack packages/create-vivary/npm --pack-destination "$artifacts"\n'
        '          python scripts/check_release_artifacts.py --repository . --artifacts "$artifacts"\n',
        '          python scripts/check_release_artifacts.py --repository . --artifacts "$artifacts"\n'
        '          npm pack packages/create-vivary/npm --pack-destination "$artifacts"\n',
    )
    message = _run(workflow)
    assert message, "archive inspection must follow every candidate build"
    assert "release artifact" in message.lower()


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
