"""Behavior tests for the repository CI workflow contract guard."""

import importlib.util
import hashlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock


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
    text = (
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
        "      - name: high-level design review\n"
        "        env:\n"
        "          BASE_SHA: ${{ inputs.base_sha || github.event.pull_request.base.sha || github.event.before }}\n"
        "          HEAD_SHA: ${{ inputs.head_sha || github.event.pull_request.head.sha || github.sha }}\n"
        "        run: |\n"
        "          python scripts/tests/test_hldd.py\n"
        "          python scripts/check_hldd.py --base \"$BASE_SHA\" --head \"$HEAD_SHA\"\n"
        "      - name: install Python test runner\n"
        "        run: python -I -m pip install pytest packaging\n"
        "      - name: CI workflow contract\n"
        "        run: python scripts/check_ci_workflow.py\n"
        "      - name: CI workflow contract tests\n"
        "        run: python scripts/tests/test_ci_workflow.py\n"
        "      - name: required review gate tests\n"
        "        run: python scripts/tests/test_review_gate.py\n"
        "      - name: source navigation contract\n"
        "        run: python -B scripts/check-source-navigation.py --check\n"
        "      - name: source navigation contract tests\n"
        "        run: python -B scripts/tests/test-source-navigation.py\n"
        "      - name: repository automation contract\n"
        "        run: python scripts/check_repository_automation.py\n"
        "      - name: repository automation contract tests\n"
        "        run: python scripts/tests/test_repository_automation.py\n"
        "      - name: repository automation behavior tests\n"
        "        run: python -m pytest scripts/tests/test_update_stats.py scripts/tests/test_steward_health.py -q\n"
        "      - name: install release build frontend\n"
        "        env:\n"
        f"          PIP_CONFIG_FILE: {UV_DIGEST_PIP_CONFIG_FILE}\n"
        "        run: |\n"
        f"          {UV_DIGEST_COMMANDS['test']}\n"
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
        "  workbench:\n"
        "    needs: changes\n"
        "    if: ${{ always() }}\n"
        "    steps:\n"
        "      - name: require changed-path and dispatch validation\n"
        "        if: needs.changes.result != 'success'\n"
        "        run: exit 1\n"
        "\n"
        "  workbench-maintained:\n"
        "    needs: changes\n"
        "    if: ${{ always() }}\n"
        "    steps:\n"
        "      - name: require changed-path and dispatch validation\n"
        "        if: needs.changes.result != 'success'\n"
        "        run: exit 1\n"
        "      - name: maintained workbench checks\n"
        f"        run: {MAINTAINED_CHECKS_COMMAND}\n"
        "\n"
        "  governed-platform-proof:\n"
        "    needs: changes\n"
        "    steps:\n"
        "      - name: source navigation contract on Windows\n"
        f"        run: {SOURCE_NAVIGATION_CHECK_COMMAND}\n"
        "      - name: source navigation contract tests on Windows\n"
        f"        run: {SOURCE_NAVIGATION_TEST_COMMAND}\n"
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
        "    steps:\n"
        "      - name: install pinned uv runner\n"
        "        env:\n"
        f"          PIP_CONFIG_FILE: {UV_DIGEST_PIP_CONFIG_FILE}\n"
        "        run: |\n"
        f"          {UV_DIGEST_COMMANDS['orientation-proof']}\n"
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

    module = _load()
    for name in module.NODE_JOBS:
        block = module.job_block(text, name)
        setup = (
            '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1\n'
            '        with:\n          node-version: "22"\n'
            '      - name: actual Node security admission\n'
            f'        run: {module.NODE_GUARD}\n'
        )
        if name == "workbench":
            setup += '      - run: node --test packages/workbench/tests/runtime-security.test.mjs\n'
        if name == "test":
            setup += '      - run: python scripts/tests/test_npm_trusted_publish_workflow.py\n'
            setup += '      - run: python -I -B scripts/tests/test_runner_action_node.py\n'
            setup += '      - run: python -I -B scripts/tests/test_pip_runtime.py\n'
        if '    steps: []\n' in block:
            updated = block.replace('    steps: []\n', '    steps:\n' + setup, 1)
        else:
            updated = block.replace('    steps:\n', '    steps:\n' + setup, 1)
        text = text.replace(block, updated, 1)
    for name in ("test", "workbench", "governed-platform-proof", "orientation-proof"):
        block = module.job_block(text, name)
        setup = (
            '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97\n'
            '        with:\n          python-version: "3.11"\n'
            + PIP_RUNTIME_STEP
        )
        if name in PIP_MCP_FIXTURES:
            block += PIP_MCP_FIXTURES[name]
        updated = block.replace('    steps:\n', '    steps:\n' + setup, 1)
        original = module.job_block(text, name)
        text = text.replace(original, updated, 1)
    for index, name in enumerate(module.CI_JOBS):
        block = module.job_block(text, name)
        bootstrap = module.runner_bootstrap_step() if index == 0 else module.BOOTSTRAP_ALIAS
        host = '    runs-on: ubuntu-latest\n'
        if name == 'orientation-proof':
            host = '    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n'
            block_with_upload = block + (
                '      - name: preserve orientation receipt\n'
                "        if: ${{ !cancelled() && steps.runner_action_node.outcome == 'success' }}\n"
                '        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n'
            )
        else:
            block_with_upload = block
        if '    steps: []\n' in block_with_upload:
            updated = block_with_upload.replace('    steps: []\n', host + '    steps:\n' + bootstrap, 1)
        else:
            updated = block_with_upload.replace('    steps:\n', host + '    steps:\n' + bootstrap, 1)
        text = text.replace(block, updated, 1)
    return text


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
SOURCE_NAVIGATION_CHECK_COMMAND = "python -B scripts/check-source-navigation.py --check"
SOURCE_NAVIGATION_TEST_COMMAND = "python -B scripts/tests/test-source-navigation.py"
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
MAINTAINED_CHECKS_COMMAND = "pnpm --dir packages/workbench test:maintained"


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


def test_source_navigation_contract_must_run():
    workflow = _workflow(INSTALL + AUDIT).replace(
        SOURCE_NAVIGATION_CHECK_COMMAND,
        "echo source navigation check skipped",
        1,
    )
    message = _run(workflow)
    assert message, "CI must execute the source-navigation checker"
    assert SOURCE_NAVIGATION_CHECK_COMMAND in message


def test_source_navigation_regressions_must_run():
    workflow = _workflow(INSTALL + AUDIT).replace(
        SOURCE_NAVIGATION_TEST_COMMAND,
        "echo source navigation tests skipped",
        1,
    )
    message = _run(workflow)
    assert message, "CI must execute the source-navigation regression suite"
    assert SOURCE_NAVIGATION_TEST_COMMAND in message


def _without_governed_command(workflow: str, command: str) -> str:
    marker = "  governed-platform-proof:\n"
    before, governed_and_later = workflow.split(marker, 1)
    return before + marker + governed_and_later.replace(command, "echo skipped", 1)


def test_windows_governed_job_must_run_source_navigation_contract():
    workflow = _without_governed_command(
        _workflow(INSTALL + AUDIT),
        SOURCE_NAVIGATION_CHECK_COMMAND,
    )
    message = _run(workflow)
    assert message, "the Windows job must execute the source-navigation checker"
    assert SOURCE_NAVIGATION_CHECK_COMMAND in message


def test_windows_governed_job_must_run_source_navigation_regressions():
    workflow = _without_governed_command(
        _workflow(INSTALL + AUDIT),
        SOURCE_NAVIGATION_TEST_COMMAND,
    )
    message = _run(workflow)
    assert message, "the Windows job must execute the source-navigation regression suite"
    assert SOURCE_NAVIGATION_TEST_COMMAND in message


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
        UV_DIGEST_COMMANDS["test"],
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


def test_workbench_jobs_must_wait_for_dispatch_validation():
    for job in ("workbench", "workbench-maintained"):
        workflow = _workflow(INSTALL + AUDIT).replace(
            f"  {job}:\n    needs: changes\n",
            f"  {job}:\n",
            1,
        )
        message = _run(workflow)
        assert message, f"the {job} job must wait for dispatch validation"
        assert f"{job} job must wait" in message


def test_maintained_workbench_checks_must_run_once_in_their_own_job():
    workflow = _workflow(INSTALL + AUDIT)
    step = (
        "      - name: maintained workbench checks\n"
        f"        run: {MAINTAINED_CHECKS_COMMAND}\n"
    )
    duplicated_in_tests = workflow.replace(
        "      - name: diff hygiene\n",
        step + "      - name: diff hygiene\n",
        1,
    )
    in_workbench_job = workflow.replace(step, "").replace(
        "\n  workbench-maintained:\n",
        step + "\n  workbench-maintained:\n",
        1,
    )
    skipped = workflow.replace(MAINTAINED_CHECKS_COMMAND, "echo skipped")
    for variant in (duplicated_in_tests, in_workbench_job, skipped):
        message = _run(variant)
        assert message, "maintained checks must run once, in their own job"
        assert MAINTAINED_CHECKS_COMMAND in message


def test_hldd_gate_and_regressions_must_run():
    workflow = _workflow(INSTALL + AUDIT)
    for command in (
        "python scripts/tests/test_hldd.py",
        'python scripts/check_hldd.py --base "$BASE_SHA" --head "$HEAD_SHA"',
    ):
        message = _run(workflow.replace(command, "echo skipped", 1))
        assert message and "HLDD" in message


def test_hldd_must_use_the_actual_pr_head():
    workflow = _workflow(INSTALL + AUDIT).replace(
        "HEAD_SHA: ${{ inputs.head_sha || github.event.pull_request.head.sha || github.sha }}",
        "HEAD_SHA: ${{ github.sha }}",
    )
    message = _run(workflow)
    assert message and "actual PR head" in message


def test_node_guard_must_run_in_each_owning_job_immediately_after_selection():
    module = _load()
    text = _workflow(INSTALL + AUDIT)
    guard_step = '      - name: actual Node security admission\n        run: ' + module.NODE_GUARD + '\n'
    for name in module.NODE_JOBS:
        block = module.job_block(text, name)
        missing = text.replace(block, block.replace(guard_step, '', 1), 1)
        assert _run(missing), name
        unrelated = missing + '\n  unrelated:\n    steps:\n' + guard_step
        assert _run(unrelated), name
        for alteration in (
            guard_step.replace('        run:', '        if: false\n        run:'),
            guard_step.replace('        run:', '        continue-on-error: true\n        run:'),
            guard_step.replace(module.NODE_GUARD, module.NODE_GUARD + ' || true'),
            guard_step.replace(module.NODE_GUARD, module.NODE_GUARD + '; exit 0'),
        ):
            assert _run(text.replace(block, block.replace(guard_step, alteration, 1), 1)), (name, alteration)
        delayed = block.replace(guard_step, '', 1) + '      - run: echo before delayed admission\n' + guard_step
        assert _run(text.replace(block, delayed, 1)), name


def test_node_guard_cannot_follow_install_or_an_unguarded_direct_build():
    module = _load()
    text = _workflow(INSTALL + AUDIT)
    block = module.job_block(text, 'workbench')
    guard_step = '      - name: actual Node security admission\n        run: ' + module.NODE_GUARD + '\n'
    for command in ('npm install', 'pnpm install', 'agent-native build', 'astro build'):
        mutation = block.replace(guard_step, '      - run: ' + command + '\n' + guard_step, 1)
        assert _run(text.replace(block, mutation, 1)), command
    for command in ('agent-native build', 'astro build'):
        assert _run(text.replace(block, block + '      - run: ' + command + '\n', 1)), command


def test_node_guard_suites_and_required_changes_success_cannot_be_removed():
    text = _workflow(INSTALL + AUDIT)
    for command in ('node --test packages/workbench/tests/runtime-security.test.mjs',
                    'python scripts/tests/test_npm_trusted_publish_workflow.py'):
        assert _run(text.replace(command, 'echo skipped', 1)), command
    assert _run(text.replace('    needs: changes\n', '', 1))



def test_review_workflow_admits_runner_before_first_checkout():
    module = _load()
    text = REAL_WORKFLOW.with_name("review-gate.yml").read_text(encoding="utf-8")
    block = module.job_block(text, "review-gate")
    assert block.split("    steps:\n", 1)[1].startswith(module.runner_bootstrap_step())
    module.check_review_workflow(text)


def test_review_bootstrap_cannot_be_lost_when_canonical_text_is_updated():
    module = _load()
    canonical = module.CANONICAL_REVIEW_WORKFLOW
    bootstrap = module.runner_bootstrap_step()
    for unsafe in (
        canonical.replace(bootstrap, "", 1),
        canonical.replace("        shell: python -I -B {0}\n",
                          "        if: false\n        shell: python -I -B {0}\n", 1),
        canonical.replace("        shell: python -I -B {0}\n",
                          "        continue-on-error: true\n        shell: python -I -B {0}\n", 1),
    ):
        # Simulate a synchronized canonical edit; runtime admission stays invariant.
        module.CANONICAL_REVIEW_WORKFLOW = unsafe
        try:
            module.check_review_workflow(unsafe)
        except SystemExit:
            continue
        raise AssertionError("The canonical review contract must still enforce runner admission")

# REAL_WORKFLOW is deliberate: old and repaired actual baselines are each
# validated before mutation, without normalizing the old checker's pin.
UV_DIGEST_LINUX_WHEEL = (
    "https://files.pythonhosted.org/packages/3a/ad/"
    "3c2a81d66d1839063662e5b6c0002ec31f8ee987dbc5295747627ca6160a/"
    "uv-0.13.5-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
    "#sha256=fa8d26e08e34c29c0c4e820cf3181757086d547240b4f4d31ff1d8bd810ca946"
)
UV_DIGEST_WINDOWS_WHEEL = (
    "https://files.pythonhosted.org/packages/32/ea/"
    "771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/"
    "uv-0.13.5-py3-none-win_amd64.whl"
    "#sha256=1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f"
)
# 0.13.4 removed the root; these valid wheels lack 0.13.5's key-level rejection.
UV_ROOT_REMOVAL_ONLY_WHEELS = (
    "https://files.pythonhosted.org/packages/4b/a1/"
    "de02c0913726728eca56ee258875cbba9c7b0572c63f494fd9f55c7852e3/"
    "uv-0.13.4-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
    "#sha256=05e4332791b4d55b6dde8695b7fa6079b26991519f44760887c5dfbd5ca4fe53",
    "https://files.pythonhosted.org/packages/2f/b9/"
    "b526eab6c72eacc705a58378f6850fde046b28c86fed01bd42da61367c6b/"
    "uv-0.13.4-py3-none-win_amd64.whl"
    "#sha256=b2ff80397273fff0e02c20eacae6882834c811827d6fc08f658db156fe754386",
)
UV_DIGEST_PIP_CONFIG_FILE = "${{ runner.os == 'Windows' && 'nul' || '/dev/null' }}"
UV_DIGEST_COMMANDS = {
    "test": 'python -I -m pip --isolated install --force-reinstall --no-deps --only-binary=:all: "' + UV_DIGEST_LINUX_WHEEL + '"',
    "orientation-proof": (
        'python -I -m pip --isolated install --force-reinstall --no-deps --only-binary=:all: "${{ '
        "runner.os == 'Linux' && '" + UV_DIGEST_LINUX_WHEEL
        + "' || runner.os == 'Windows' && '" + UV_DIGEST_WINDOWS_WHEEL + "' || '' }}\""
    ),
}


def _assert_owned_uv_acquisition(job_name: str, first_case: str) -> None:
    module = _load()
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual workflow prerequisite must pass"
    block = module.job_block(workflow, job_name)
    steps = re.split(r"(?m)(?=^      - )", block)[1:]
    installs = [step for step in steps if re.search(
        r"\b(?:python(?:3)?\s+(?:-I\s+)?-m\s+pip|pip(?:3)?)\s+(?:--isolated\s+)?install\b[^\n]*\buv\b", step
    )]
    assert len(installs) == 1, (job_name, "expected one actual uv install step")
    step = installs[0]
    name_line = step.splitlines()[0]
    assert name_line.startswith("      - name: "), (job_name, name_line)
    fixed_command = UV_DIGEST_COMMANDS[job_name]
    fixed_run = "        run: |\n          " + fixed_command + "\n"
    fixed_env = "        env:\n          PIP_CONFIG_FILE: " + UV_DIGEST_PIP_CONFIG_FILE + "\n"
    fixed_step = name_line + "\n" + fixed_env + fixed_run
    cases = {
        "affected": name_line + "\n        run: python -m pip install uv==0.11.21\n",
        "missing": "",
        "unpinned": name_line + "\n        run: python -m pip install uv\n",
        "last_affected": name_line + "\n        run: python -m pip install uv==0.13.3\n",
        "pin_only": name_line + "\n        run: python -m pip install uv==0.13.5\n",
        "conditional": fixed_step.replace(fixed_run, "        if: false\n" + fixed_run, 1),
        "ignored": fixed_step.replace(fixed_run, "        continue-on-error: true\n" + fixed_run, 1),
        "environment": fixed_step.replace(fixed_env, fixed_env + "          PIP_NO_VERIFY: 1\n", 1),
        "directory": fixed_step.replace(fixed_run, "        working-directory: other\n" + fixed_run, 1),
        "shell": fixed_step.replace(fixed_run, "        shell: custom {0}\n" + fixed_run, 1),
        "masked": fixed_step.replace(fixed_command, fixed_command + " || true", 1),
        "extra_command": fixed_step + "          echo skipped\n",
        "duplicate_run": fixed_step + "        run: echo skipped\n",
        "without_config_env": fixed_step.replace(fixed_env, "", 1),
        "wrong_config_file": fixed_step.replace(UV_DIGEST_PIP_CONFIG_FILE, "/tmp/untrusted-pip.conf", 1),
        "wrong_windows_null": fixed_step.replace("'nul'", "'/dev/null'", 1),
        "wrong_linux_null": fixed_step.replace("'/dev/null'", "'nul'", 1),
        "wrong_config_platform": fixed_step.replace("runner.os == 'Windows'", "runner.os == 'Linux'", 1),
        "without_isolated": fixed_step.replace(" --isolated", "", 1),
        "without_force_reinstall": fixed_step.replace(" --force-reinstall", "", 1),
        "without_no_deps": fixed_step.replace(" --no-deps", "", 1),
        "without_wheel_only": fixed_step.replace(" --only-binary=:all:", "", 1),
        "second_affected": fixed_step + "      - run: python -m pip install uv==0.11.21\n",
        "second_isolated_affected": fixed_step + "      - run: python -I -m pip --isolated install uv==0.11.21\n",
        "duplicate_fixed": fixed_step + fixed_step,
    }
    wheels = (UV_DIGEST_LINUX_WHEEL,) if job_name == "test" else (
        UV_DIGEST_LINUX_WHEEL, UV_DIGEST_WINDOWS_WHEEL,
    )
    for number, wheel in enumerate(wheels):
        url, digest = wheel.split("#sha256=", 1)
        cases[f"root_removal_only_{number}"] = step.replace(
            wheel, UV_ROOT_REMOVAL_ONLY_WHEELS[number], 1
        )
        cases[f"wrong_digest_{number}"] = fixed_step.replace(wheel, url + "#sha256=" + "0" * 64, 1)
        cases[f"wrong_url_{number}"] = fixed_step.replace(wheel, wheel.replace("files.pythonhosted.org", "pypi.org"), 1)
        cases[f"sdist_{number}"] = fixed_step.replace(wheel, wheel.replace(".whl#", ".tar.gz#"), 1)
        cases[f"missing_hash_{number}"] = fixed_step.replace(wheel, url, 1)
    if job_name == "orientation-proof":
        cases["wrong_linux_selection"] = fixed_step.replace(
            fixed_command, fixed_command.replace("runner.os == 'Linux'", "runner.os == 'Darwin'", 1), 1
        )
        cases["wrong_windows_selection"] = fixed_step.replace(
            fixed_command, fixed_command.replace("runner.os == 'Windows'", "runner.os == 'Darwin'", 1), 1
        )
        cases["swapped_platform_wheels"] = fixed_step.replace(UV_DIGEST_LINUX_WHEEL, UV_DIGEST_WINDOWS_WHEEL, 1)
    for label in (first_case, *(label for label in cases if label != first_case)):
        mutation = workflow.replace(block, block.replace(step, cases[label], 1), 1)
        message = _run(mutation)
        assert message and f"{job_name} job" in message and "uv==0.13.5" in message, (
            job_name, label, message
        )
    missing = workflow.replace(block, block.replace(step, "", 1), 1)
    decoy = missing + "\n  unrelated_uv:\n    steps:\n" + fixed_step
    message = _run(decoy)
    assert message and f"{job_name} job" in message and "uv==0.13.5" in message, (
        job_name, "another job cannot supply the wheel", message
    )
    delayed = workflow.replace(block, block.replace(step, "", 1) + fixed_step, 1)
    message = _run(delayed)
    assert message and (
        (f"{job_name} job" in message and "uv==0.13.5" in message)
        or message.endswith(
            f": {job_name} job must admit actual uv 0.13.5 "
            "immediately after acquisition and at use"
        )
    ), (
        job_name, "install must precede the real consumers", message
    )
    ignored_job = block.replace(step, fixed_step, 1).replace(
        "    steps:\n", "    continue-on-error: true\n    steps:\n", 1
    )
    message = _run(workflow.replace(block, ignored_job, 1))
    assert message and message.endswith(f": {job_name} cannot ignore job failure"), (
        job_name, "job cannot ignore acquisition failure", message
    )
    fixed = workflow.replace(block, block.replace(step, fixed_step, 1), 1)
    assert _run(fixed) is None, (job_name, "exact platform null config and fixed wheel command must pass")
    assert REAL_WORKFLOW.read_bytes() == before


def test_test_job_requires_fixed_uv_acquisition():
    _assert_owned_uv_acquisition("test", "root_removal_only_0")


def test_orientation_job_requires_fixed_uv_acquisition():
    _assert_owned_uv_acquisition("orientation-proof", "root_removal_only_1")


def test_uv_runtime_admission_cannot_be_removed_moved_or_ignored():
    module = _load()
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual workflow prerequisite must pass"
    for job_name in ("test", "orientation-proof"):
        block = module.job_block(workflow, job_name)
        guard = module.UV_RUNTIME_STEP
        assert block.count(guard) == (1 if job_name == "test" else 2), job_name
        cases = {
            "missing_after_install": block.replace(guard, "", 1),
            "conditional": block.replace(guard, guard.replace("        run:", "        if: false\n        run:"), 1),
            "ignored": block.replace(guard, guard.replace("        run:", "        continue-on-error: true\n        run:"), 1),
            "different_guard": block.replace(module.UV_RUNTIME_COMMAND, "uv --version", 1),
            "moved_before_install": block.replace(guard, "", 1).replace("    steps:\n", "    steps:\n" + guard, 1),
        }
        if job_name == "test":
            cases["commented_capture_after_unverified_selection"] = block.replace(
                "          " + module.UV_BUILD_ADMISSION + "\n",
                "          uv=uv\n          # " + module.UV_BUILD_ADMISSION + "\n", 1
            )
            cases["missing_at_build"] = block.replace(module.UV_BUILD_ADMISSION, "uv=uv", 1)
            cases["ignored_at_build"] = block.replace(module.UV_BUILD_ADMISSION, module.UV_BUILD_ADMISSION.replace(" || exit $?", " || true"), 1)
            cases["rebound_between_builds"] = block.replace(
                module.release_build_commands()[1], "uv=uv\n          " + module.release_build_commands()[1], 1
            )
        else:
            use_guard = guard + module.UV_ORIENTATION_PROOF
            assert block.count(use_guard) == 1
            cases["missing_at_proof"] = block.replace(use_guard, module.UV_ORIENTATION_PROOF, 1)
            cases["proof_path_override"] = block.replace(
                module.UV_ORIENTATION_PROOF,
                module.UV_ORIENTATION_PROOF.replace("        run:", "        env:\n          PATH: /unadmitted\n        run:"), 1
            )
        for label, mutation in cases.items():
            assert mutation != block, (job_name, label)
            message = _run(workflow.replace(block, mutation, 1))
            assert message and f"{job_name} job must admit actual uv 0.13.5" in message, (
                job_name, label, message
            )
    assert REAL_WORKFLOW.read_bytes() == before


def test_uv_runtime_admits_only_verified_paths_and_exact_version():
    spec = importlib.util.spec_from_file_location("uv_runtime_contract", ROOT / "scripts/check_uv_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory() as tmp:
        paths = {name: Path(tmp) / name for name in ("uv", "uvx")}
        for name, path in paths.items():
            path.write_bytes(name.encode("ascii"))
        module.UV_SHA256 = {"linux": tuple(hashlib.sha256(path.read_bytes()).hexdigest() for path in paths.values())}
        with mock.patch.object(module.sys, "platform", "linux"), \
                mock.patch.object(module.shutil, "which", side_effect=paths.get), \
                mock.patch.object(module.subprocess, "run") as run:
            run.return_value.stdout = "uv 0.13.5 (fixture)\n"
            assert module.admitted_uv() == paths["uv"].resolve()
            run.assert_called_once_with(
                [str(paths["uv"].resolve()), "--version"], check=True,
                capture_output=True, text=True, timeout=10
            )
            for version in ("uv 0.13.4", "uv 0.13.50", "uv 0.13.5rc1", "uvx 0.13.5", ""):
                run.return_value.stdout = version
                try:
                    module.admitted_uv()
                except SystemExit as exc:
                    assert "must identify version 0.13.5" in str(exc)
                else:
                    raise AssertionError(f"accepted an unqualified uv version: {version!r}")
            run.side_effect = subprocess.CalledProcessError(1, [str(paths["uv"]), "--version"])
            try:
                module.admitted_uv()
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError("ignored the actual uv command failure")
            run.reset_mock(side_effect=True)
            paths["uvx"].write_bytes(b"unverified uvx")
            try:
                module.admitted_uv()
            except SystemExit as exc:
                assert "uvx does not match" in str(exc)
            else:
                raise AssertionError("accepted an unverified uvx payload")
            run.assert_not_called()
            paths.pop("uvx")
            try:
                module.admitted_uv()
            except SystemExit as exc:
                assert "missing CI executable: uvx" in str(exc)
            else:
                raise AssertionError("accepted a missing uvx executable")
            run.assert_not_called()
        with mock.patch.object(module.sys, "platform", "darwin"), \
                mock.patch.object(module.subprocess, "run") as run:
            try:
                module.admitted_uv()
            except SystemExit as exc:
                assert "supports only Linux x64 and Windows amd64" in str(exc)
            else:
                raise AssertionError("accepted an unsupported uv platform")
            run.assert_not_called()


def _uv_inherited_cases(text, job_block, safe=False):
    cases = []
    for owner in ("workflow", "test", "orientation-proof"):
        block = text if owner == "workflow" else job_block(text, owner)
        boundary = "\njobs:\n" if owner == "workflow" else "    steps:\n"
        assert block.count(boundary) == 1
        head, tail = block.split(boundary, 1)
        pad = "" if owner == "workflow" else "    "
        label = owner if owner == "workflow" else owner + " job"
        for kind in (("safe-env",) if safe else ("defaults", "dry-run", "config-file")):
            updated = head
            if kind == "defaults":
                assert not re.search(rf"(?m)^{pad}defaults[ \t]*:", head)
                addition = pad + 'defaults:\n' + pad + '  run:\n' + pad + '    shell: "bash -c \'true\' {0}"\n'
                updated = head.rstrip("\n") + "\n" + addition
                diagnostic = label + " uv acquisition must not inherit run defaults"
            else:
                key = "VIVARY_UV_INHERITANCE_FIXTURE" if safe else (
                    "PIP_CONFIG_FILE" if kind == "config-file" else "PIP_DRY_RUN"
                )
                value = "preserved" if safe else ("/tmp/vivary-pip.conf" if kind == "config-file" else "1")
                assert key not in head
                field = re.search(rf"(?m)^{pad}(?:env|'env'|\"env\")[ \t]*:[ \t]*(?:#[^\n]*)?$", head)
                if field:
                    updated = head[:field.end()] + "\n" + pad + f'  {key}: "{value}"' + head[field.end():]
                else:
                    assert not re.search(rf"(?m)^{pad}(?:env|'env'|\"env\")[ \t]*:", head), "existing env must be explicit block mapping"
                    updated = head.rstrip("\n") + "\n" + pad + "env:\n" + pad + f'  {key}: "{value}"\n'
                diagnostic = label + " uv acquisition must not inherit " + key
            replacement = updated + boundary + tail
            mutated = replacement if owner == "workflow" else text.replace(block, replacement, 1)
            cases.append((owner + ":" + kind, mutated, diagnostic))
    if not safe:
        head, tail = text.split("\njobs:\n", 1)
        field = re.search(r"(?m)^(?:env|'env'|\"env\")[ \t]*:[^\n]*$", head)
        flow = 'env:\n  {PIP_DRY_RUN: "1"}\n'
        if field:
            following = head[field.end():]
            next_field = re.search(r"(?m)^(?=[^\s#])", following)
            end = field.end() + (next_field.start() if next_field else len(following))
            head = head[:field.start()] + flow + head[end:]
        else:
            head = head.rstrip("\n") + "\n" + flow
        cases.append(("workflow:env-body-flow", head + "\njobs:\n" + tail,
                      "workflow uv acquisition requires explicit inherited env mappings"))
    return cases


def test_uv_acquisition_rejects_inherited_execution_overrides():
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual workflow prerequisite must pass"
    job_block = _load().job_block
    try:
        for label, mutation, diagnostic in _uv_inherited_cases(workflow, job_block):
            message = _run(mutation)
            assert message and message.endswith(": " + diagnostic), (label, diagnostic, message)
        for label, mutation, _ in _uv_inherited_cases(workflow, job_block, safe=True):
            assert _run(mutation) is None, (label, "legitimate inherited env must pass")
        assert _run(workflow) is None, "unchanged actual workflow must pass"
    finally:
        assert REAL_WORKFLOW.read_bytes() == before


PIP_RUNTIME_STEP = (
    "      - name: actual pip runtime admission\n"
    "        shell: python -I -B {0}\n"
    "        run: |\n"
    "          import runpy\n"
    '          runpy.run_path("scripts/check_pip_runtime.py", run_name="__main__")\n'
)
PIP_LINUX_MCP_GUARD = '          "$mcp_python" -I -B scripts/check_pip_runtime.py || exit $?\n'
PIP_WINDOWS_MCP_GUARD = (
    '          & $mcpPython -I -B scripts/check_pip_runtime.py\n'
    '          if ($LASTEXITCODE -ne 0) { throw "MCP pip runtime admission failed" }\n'
)
PIP_MCP_FIXTURES = {
    "test": (
        '      - name: MCP pip fixture\n        shell: bash\n        run: |\n'
        '          mcp_python="$mcp_venv/bin/python"\n' + PIP_LINUX_MCP_GUARD
        + '          "$mcp_python" -I -m pip install "mcp==2.2.0"\n'
    ),
    "governed-platform-proof": (
        '      - name: MCP pip fixture\n        shell: pwsh\n        run: |\n'
        '          $mcpPython = Join-Path $mcpScripts "python.exe"\n' + PIP_WINDOWS_MCP_GUARD
        + '          & $mcpPython -I -m pip install "mcp==2.2.0"\n'
        '          if ($LASTEXITCODE -ne 0) { throw "MCP dependency install failed" }\n'
    ),
}


def test_actual_workflow_requires_pip_runtime_admission():
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual admitted workflow must pass"
    job_block = _load().job_block
    for name in ("test", "workbench", "governed-platform-proof", "orientation-proof"):
        block = job_block(workflow, name)
        assert block.count(PIP_RUNTIME_STEP) == 1, name
        unchecked = '      - run: python -I -m pip install pip==26.2.2\n'
        cases = {
            "missing": block.replace(PIP_RUNTIME_STEP, "", 1),
            "after_network_bootstrap": block.replace(PIP_RUNTIME_STEP, unchecked + PIP_RUNTIME_STEP, 1),
            "conditional": block.replace(PIP_RUNTIME_STEP, PIP_RUNTIME_STEP.replace(
                "        shell:", "        if: false\n        shell:", 1), 1),
            "ignored": block.replace(PIP_RUNTIME_STEP, PIP_RUNTIME_STEP.replace(
                "        shell:", "        continue-on-error: true\n        shell:", 1), 1),
            "nonisolated_guard": block.replace(PIP_RUNTIME_STEP, PIP_RUNTIME_STEP.replace(" -I", "", 1), 1),
            "redirected_guard": block.replace(PIP_RUNTIME_STEP, PIP_RUNTIME_STEP.replace(
                "        shell:", "        working-directory: other\n        shell:", 1), 1),
        }
        for label, changed in cases.items():
            message = _run(workflow.replace(block, changed, 1))
            assert message and name in message and "pip" in message, (name, label, message)
    # This uses only the preexisting full-checker entrypoint. On old code the
    # missing-admission rejection assertion fails because the workflow is accepted.
    unsafe = workflow.replace(PIP_RUNTIME_STEP, "").replace(PIP_LINUX_MCP_GUARD, "").replace(PIP_WINDOWS_MCP_GUARD, "")
    unsafe = unsafe.replace(" -I -m pip ", " -m pip ")
    unsafe = unsafe.replace('      - name: pip runtime admission tests\n        run: python -I -B scripts/tests/test_pip_runtime.py\n', "")
    message = _run(unsafe)
    assert message and "pip runtime admission" in message, ("pre-admission workflow must be refused", message)
    assert REAL_WORKFLOW.read_bytes() == before


def test_actual_workflow_binds_mcp_pip_interpreters_and_later_isolation():
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual admitted workflow must pass"
    cases = {
        "early_linux_network": workflow.replace(
            '          mcp_python="$mcp_venv/bin/python"\n',
            '          mcp_python="$mcp_venv/bin/python"\n          "$mcp_python" -I -m pip install "mcp==2.2.0"\n'
            '          mcp_python="$mcp_venv/bin/python"\n', 1),
        "early_windows_network": workflow.replace(
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n',
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n          & $mcpPython -I -m pip install "mcp==2.2.0"\n'
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n', 1),
        "reassigned_linux_network_after_admission": workflow.replace(
            '          "$mcp_python" -I -m pip check\n',
            '          mcp_python="/path/to/old/python"\n'
            '          "$mcp_python" -I -m pip install example\n'
            '          "$mcp_python" -I -m pip check\n', 1),
        "reassigned_windows_network_after_admission": workflow.replace(
            '          & $mcpPython -I -m pip check\n',
            '          $mcpPython = "C:\\old\\python.exe"\n'
            '          & $mcpPython -I -m pip install example\n'
            '          & $mcpPython -I -m pip check\n', 1),
        "missing_linux_venv_admission": workflow.replace(PIP_LINUX_MCP_GUARD, "", 1),
        "missing_windows_venv_admission": workflow.replace(PIP_WINDOWS_MCP_GUARD, "", 1),
        "linux_host_instead_of_venv": workflow.replace(PIP_LINUX_MCP_GUARD, PIP_LINUX_MCP_GUARD.replace('"$mcp_python"', "python", 1), 1),
        "windows_host_instead_of_venv": workflow.replace(PIP_WINDOWS_MCP_GUARD, PIP_WINDOWS_MCP_GUARD.replace("& $mcpPython", "python", 1), 1),
        "ignored_linux_venv": workflow.replace(PIP_LINUX_MCP_GUARD, PIP_LINUX_MCP_GUARD.replace("exit $?", "true", 1), 1),
        "ignored_windows_venv": workflow.replace(PIP_WINDOWS_MCP_GUARD, PIP_WINDOWS_MCP_GUARD.splitlines(keepends=True)[0], 1),
        "nonisolated_linux_network": workflow.replace('"$mcp_python" -I -m pip install "mcp==2.2.0"', '"$mcp_python" -m pip install "mcp==2.2.0"', 1),
        "nonisolated_windows_network": workflow.replace('& $mcpPython -I -m pip install "mcp==2.2.0"', '& $mcpPython -m pip install "mcp==2.2.0"', 1),
        "nonisolated_later_linux_pip": workflow.replace('"$mcp_python" -I -m pip check', '"$mcp_python" -m pip check', 1),
        "nonisolated_later_windows_pip": workflow.replace('& $mcpPython -I -m pip check', '& $mcpPython -m pip check', 1),
        "different_linux_network_interpreter": workflow.replace('"$mcp_python" -I -m pip install "mcp==2.2.0"', 'python -I -m pip install "mcp==2.2.0"', 1),
        "different_windows_network_interpreter": workflow.replace('& $mcpPython -I -m pip install "mcp==2.2.0"', 'python -I -m pip install "mcp==2.2.0"', 1),
    }
    for label, mutation in cases.items():
        assert mutation != workflow, label
        message = _run(mutation)
        assert message and "pip" in message, (label, message)
    assert REAL_WORKFLOW.read_bytes() == before

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
