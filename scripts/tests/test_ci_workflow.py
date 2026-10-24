"""Behavior tests for the repository CI workflow contract guard."""

import importlib.util
import hashlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

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
    # Mutate the actual six-job security composition, retaining its source bindings.
    module = _load()
    text = REAL_WORKFLOW.read_text(encoding="utf-8")
    text = re.sub(r"(?m)^        description:.*\n", "", text)
    site = module.job_block(text, "site")
    altered = site.replace(INSTALL, "__SITE_STEPS__", 1).replace(AUDIT, "", 1)
    altered = altered.replace(module.SITE_INSTALLED_DEPENDENCY_STEP, "", 1)
    site_steps = site_steps.replace(INSTALL, INSTALL + module.SITE_INSTALLED_DEPENDENCY_STEP)
    return text.replace(site, altered.replace("__SITE_STEPS__", site_steps), 1) + trailing_job



INSTALL = (
    "      - name: install\n"
    '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" ci --ignore-scripts\'\n'
    "        working-directory: site\n"
)
AUDIT = (
    "      - name: audit high and critical site dependencies\n"
    '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" audit --audit-level=high\'\n'
    "        working-directory: site\n"
    "      - name: site behavior and information architecture tests\n"
    '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" run test:site\'\n'
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
        _load().UV_INSTALLS["test"],
        ARTIFACT_TEST_COMMAND,
        *RELEASE_BUILD_COMMANDS,
        _load().TEST_PACK_COMMAND,
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
    workflow = _workflow(INSTALL + AUDIT)
    first = "          " + PARITY_CHECK_COMMAND + "\n"
    second = "          " + PARITY_CHARACTERIZE_COMMAND + "\n"
    reordered = workflow.replace(first + second, second + first, 1)
    assert reordered != workflow, "the fixture must reorder the real smoke commands"
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
        assert message and "dispatch validation" in message, message


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


def test_node_guard_must_run_in_each_owning_job_immediately_after_selection():
    module = _load()
    text = _workflow(INSTALL + AUDIT)
    guard_step = '      - name: actual Node security admission\n        run: ' + module.NODE_GUARD + '\n'
    for name in module.NODE_JOBS:
        block = module.job_block(text, name)
        expected = 'site' if name == 'site' else 'Node guard'
        missing = text.replace(block, block.replace(guard_step, '', 1), 1)
        message = _run(missing)
        assert message and expected in message, (name, message)
        review = module.job_block(missing, 'review')
        decoy = missing.replace(review, review.rstrip('\n') + '\n' + guard_step, 1)
        message = _run(decoy)
        # A guard in a job that does not own it cannot stand in for the owning job's guard.
        assert message and expected in message, (name, message)
        for alteration in (
            guard_step.replace('        run:', '        if: false\n        run:'),
            guard_step.replace('        run:', '        continue-on-error: true\n        run:'),
            guard_step.replace(module.NODE_GUARD, module.NODE_GUARD + ' || true'),
            guard_step.replace(module.NODE_GUARD, module.NODE_GUARD + '; exit 0'),
        ):
            message = _run(text.replace(block, block.replace(guard_step, alteration, 1), 1))
            assert message and 'Node guard' in message, (name, alteration, message)
        delayed = block.replace(guard_step, '', 1) + '      - run: echo before delayed admission\n' + guard_step
        message = _run(text.replace(block, delayed, 1))
        assert message and (expected in message or 'Node' in message), (name, message)


def test_node_guard_cannot_follow_install_or_an_unguarded_direct_build():
    module = _load()
    text = _workflow(INSTALL + AUDIT)
    block = module.job_block(text, 'test')
    guard_step = '      - name: actual Node security admission\n        run: ' + module.NODE_GUARD + '\n'
    for command in ('npm install', 'pnpm install', 'agent-native build', 'astro build'):
        mutation = block.replace(guard_step, '      - run: ' + command + '\n' + guard_step, 1)
        message = _run(text.replace(block, mutation, 1))
        assert message and 'Node' in message, (command, message)
    for command in ('agent-native build', 'astro build'):
        message = _run(text.replace(block, block + '      - run: ' + command + '\n', 1))
        assert message and ('Node' in message or 'build' in message), (command, message)


def test_node_guard_suites_and_required_changes_success_cannot_be_removed():
    text = _workflow(INSTALL + AUDIT)
    for command in ('node --test packages/workbench/tests/runtime-security.test.mjs',
                    'python scripts/tests/test_npm_trusted_publish_workflow.py'):
        message = _run(text.replace(command, 'echo skipped', 1))
        assert message and 'must run' in message, (command, message)
    message = _run(text.replace('    needs: changes\n', '', 1))
    assert message and 'dispatch validation' in message, message



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
    "test": 'python -I -m pip --use-deprecated=legacy-certs --isolated install --force-reinstall --no-deps --only-binary=:all: "' + UV_DIGEST_LINUX_WHEEL + '"',
    "orientation-proof": (
        'python -I -m pip --use-deprecated=legacy-certs --isolated install --force-reinstall --no-deps --only-binary=:all: "${{ '
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
        r"\b(?:python(?:3)?\s+(?:-I\s+)?-m\s+pip|pip(?:3)?)\s+(?:--use-deprecated=legacy-certs\s+)?(?:--isolated\s+)?install\b[^\n]*\buv\b", step
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
        "affected": name_line + "\n        run: python -m pip --use-deprecated=legacy-certs install uv==0.11.21\n",
        "missing": "",
        "unpinned": name_line + "\n        run: python -m pip --use-deprecated=legacy-certs install uv\n",
        "last_affected": name_line + "\n        run: python -m pip --use-deprecated=legacy-certs install uv==0.13.3\n",
        "pin_only": name_line + "\n        run: python -m pip --use-deprecated=legacy-certs install uv==0.13.5\n",
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
        "second_affected": fixed_step + "      - run: python -m pip --use-deprecated=legacy-certs install uv==0.11.21\n",
        "second_isolated_affected": fixed_step + "      - run: python -I -m pip --use-deprecated=legacy-certs --isolated install uv==0.11.21\n",
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


PIP_BOOTSTRAP_STEP = ('      - name: verified pip runtime provisioning\n'
 '        shell: python -I -B {0}\n'
 '        run: |\n'
 '          import runpy\n'
 '          runpy.run_path("scripts/bootstrap_ci_pip.py", run_name="__main__")\n')
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
def test_actual_workflow_requires_pip_runtime_admission():
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None, "actual admitted workflow must pass"
    job_block = _load().job_block
    for name in ("test", "governed-platform-proof", "orientation-proof"):
        block = job_block(workflow, name)
        assert block.count(PIP_RUNTIME_STEP) == 1, name
        assert block.count(PIP_BOOTSTRAP_STEP) == 1, (name, "verified pip provisioning missing")
        unchecked = '      - run: python -I -m pip --use-deprecated=legacy-certs install pip==26.2.2\n'
        cases = {
            "setup_old_pip_network": block.replace('          python-version: "3.12.15"\n', '          python-version: "3.12.15"\n          pip-version: "26.2.2"\n', 1),
            "missing_provisioning": block.replace(PIP_BOOTSTRAP_STEP, "", 1),
            "provisioning_after_guard": block.replace(PIP_BOOTSTRAP_STEP + PIP_RUNTIME_STEP, PIP_RUNTIME_STEP + PIP_BOOTSTRAP_STEP, 1),
            "conditional_provisioning": block.replace(PIP_BOOTSTRAP_STEP, PIP_BOOTSTRAP_STEP.replace("        shell:", "        if: false\n        shell:"), 1),
            "ignored_provisioning": block.replace(PIP_BOOTSTRAP_STEP, PIP_BOOTSTRAP_STEP.replace("        shell:", "        continue-on-error: true\n        shell:"), 1),
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
        if name == "governed-platform-proof":
            cases["setup_old_pip_network"] = block.replace(_load().WINDOWS_PYTHON_PROVISIONING_STEP,
                _load().PIP_SETUP_STEP.replace('          python-version: "3.12.15"\n',
                    '          python-version: "3.12.15"\n          pip-version: "26.2.2"\n', 1)
                + _load().WINDOWS_PYTHON_PROVISIONING_STEP, 1)
        for label, changed in cases.items():
            assert changed != block, (name, label)
            message = _run(workflow.replace(block, changed, 1))
            assert message and name in message and "pip" in message, (name, label, message)
    # This uses only the preexisting full-checker entrypoint. On old code the
    # missing-admission rejection assertion fails because the workflow is accepted.
    unsafe = workflow.replace(PIP_RUNTIME_STEP, "").replace(PIP_LINUX_MCP_GUARD, "").replace(PIP_WINDOWS_MCP_GUARD, "")
    unsafe = unsafe.replace(" -I -m pip --use-deprecated=legacy-certs ", " -m pip --use-deprecated=legacy-certs ")
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
            '          mcp_python="$mcp_venv/bin/python"\n          "$mcp_python" -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n'
            '          mcp_python="$mcp_venv/bin/python"\n', 1),
        "early_windows_network": workflow.replace(
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n',
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n          & $mcpPython -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n'
            '          $mcpPython = Join-Path $mcpScripts "python.exe"\n', 1),
        "reassigned_linux_network_after_admission": workflow.replace(
            '          "$mcp_python" -I -m pip --use-deprecated=legacy-certs check\n',
            '          mcp_python="/path/to/old/python"\n'
            '          "$mcp_python" -I -m pip --use-deprecated=legacy-certs install example\n'
            '          "$mcp_python" -I -m pip --use-deprecated=legacy-certs check\n', 1),
        "reassigned_windows_network_after_admission": workflow.replace(
            '          & $mcpPython -I -m pip --use-deprecated=legacy-certs check\n',
            '          $mcpPython = "C:\\old\\python.exe"\n'
            '          & $mcpPython -I -m pip --use-deprecated=legacy-certs install example\n'
            '          & $mcpPython -I -m pip --use-deprecated=legacy-certs check\n', 1),
        "missing_linux_venv_admission": workflow.replace(PIP_LINUX_MCP_GUARD, "", 1),
        "missing_windows_venv_admission": workflow.replace(PIP_WINDOWS_MCP_GUARD, "", 1),
        "linux_host_instead_of_venv": workflow.replace(PIP_LINUX_MCP_GUARD, PIP_LINUX_MCP_GUARD.replace('"$mcp_python"', "python", 1), 1),
        "windows_host_instead_of_venv": workflow.replace(PIP_WINDOWS_MCP_GUARD, PIP_WINDOWS_MCP_GUARD.replace("& $mcpPython", "python", 1), 1),
        "ignored_linux_venv": workflow.replace(PIP_LINUX_MCP_GUARD, PIP_LINUX_MCP_GUARD.replace("exit $?", "true", 1), 1),
        "ignored_windows_venv": workflow.replace(PIP_WINDOWS_MCP_GUARD, PIP_WINDOWS_MCP_GUARD.splitlines(keepends=True)[0], 1),
        "nonisolated_linux_network": workflow.replace('"$mcp_python" -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', '"$mcp_python" -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 1),
        "nonisolated_windows_network": workflow.replace('& $mcpPython -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', '& $mcpPython -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 1),
        "nonisolated_later_linux_pip": workflow.replace('"$mcp_python" -I -m pip --use-deprecated=legacy-certs check', '"$mcp_python" -m pip --use-deprecated=legacy-certs check', 1),
        "nonisolated_later_windows_pip": workflow.replace('& $mcpPython -I -m pip --use-deprecated=legacy-certs check', '& $mcpPython -m pip --use-deprecated=legacy-certs check', 1),
        "different_linux_network_interpreter": workflow.replace('"$mcp_python" -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 'python -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 1),
        "different_windows_network_interpreter": workflow.replace('& $mcpPython -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 'python -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"', 1),
    }
    for label, mutation in cases.items():
        assert mutation != workflow, label
        message = _run(mutation)
        assert message and "pip" in message, (label, message)
    assert REAL_WORKFLOW.read_bytes() == before


def test_installed_mcp_proofs_require_the_admitted_sdk_identity_on_each_platform():
    before = REAL_WORKFLOW.read_bytes()
    workflow = before.decode("utf-8")
    assert _run(workflow) is None
    for name in ("test", "governed-platform-proof"):
        block = _load().job_block(workflow, name)
        expected = '          assert interop["sdk_version"] == "2.2.0"\n'
        assert block.count(expected) == 1, name
        for label, changed in {
            "stale_doctor_sdk": block.replace(expected, expected.replace("2.2.0", "2.0.0"), 1),
            "missing_doctor_sdk": block.replace(expected, "", 1),
            "stale_sdk_module": block.replace('assert version("mcp") == "2.2.0"', 'assert version("mcp") == "2.0.0"', 1),
            "stale_types_module": block.replace('assert version("mcp-types") == "2.2.0"', 'assert version("mcp-types") == "2.0.0"', 1),
            "stale_dependency": block.replace('assert "mcp==2.2.0" in mcp_requirements', 'assert "mcp==2.0.0" in mcp_requirements', 1),
            "doctor_assertion_outside_proof": block.replace(expected, "", 1) + expected,
        }.items():
            assert changed != block, (name, label)
            message = _run(workflow.replace(block, changed, 1))
            assert message and name in message and "MCP installed identity" in message, (name, label, message)
    assert REAL_WORKFLOW.read_bytes() == before


def test_all_fresh_venvs_provision_fixed_pip_before_actual_admission():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    assert _run(workflow) is None
    for name, blocks in module.PIP_VENV_BLOCKS.items():
        for index, required in enumerate(blocks):
            guard = next(line for line in required.splitlines(keepends=True) if "scripts/check_pip_runtime.py" in line)
            seed = next(line for line in required.splitlines(keepends=True) if "scripts/bootstrap_ci_pip.py" in line)
            swapped = required.replace(seed, "<SEED>\n", 1).replace(guard, seed, 1).replace("<SEED>\n", guard, 1)
            if "exit $?" in seed:
                ignored = required.replace(seed, seed.replace("exit $?", "true"), 1)
            else:
                lines = required.splitlines(keepends=True)
                failure = lines[lines.index(seed) + 1]
                assert "$LASTEXITCODE -ne 0" in failure
                ignored = required.replace(failure, failure.replace("$LASTEXITCODE -ne 0", "$false"), 1)
            changes = {
                "old_seeded_venv": required.replace(" --without-pip", "", 1),
                "missing_seed": required.replace(seed, "", 1),
                "missing_guard": required.replace(guard, "", 1),
                "guard_before_seed": swapped,
                "ignored_seed": ignored,
                "wrong_seed_target": required.replace(seed, seed.replace('"$venv_python"', "python").replace('"$mcp_python"', "python").replace("& $mcpPython", "python").replace("& $python", "python"), 1),
                "wrong_guard_target": required.replace(guard, guard.replace('"$venv_python"', "python").replace('"$mcp_python"', "python").replace("& $mcpPython", "python").replace("& $python", "python"), 1),
            }
            for label, mutation in changes.items():
                assert mutation != required, (name, index, label)
                message = _run(workflow.replace(required, mutation, 1))
                assert message and "pip" in message, (name, index, label, message)


def test_selected_node_pin_cannot_regress_or_float():
    module = _load()
    text = REAL_WORKFLOW.read_text(encoding="utf-8")
    module.check_runtime_security(text)
    pin = '          node-version: "24.22.1"\n'
    for name in module.NODE_JOBS:
        block = module.job_block(text, name)
        assert block.count(pin) == 1, name
        for unsafe in ("22", "22.22.0", "24.20.0", ">=24.22.1"):
            mutation = block.replace(pin, f'          node-version: "{unsafe}"\n', 1)
            try:
                module.check_runtime_security(text.replace(block, mutation, 1))
            except SystemExit as error:
                assert "fixed admitted Node 24.22.1" in str(error), (name, unsafe, error)
            else:
                raise AssertionError((name, unsafe))


def test_site_lock_admission_precedes_install_and_build():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    module.check_site_dependencies(workflow)
    block = module.job_block(workflow, "site")
    guard = module.SITE_DEPENDENCY_STEP
    installed = module.SITE_INSTALLED_DEPENDENCY_STEP
    install = INSTALL
    audit = AUDIT
    build = module.SITE_BUILD_STEP
    tools = module.SITE_TOOLS_STEP
    mutations = {
        "missing_tools": block.replace(tools, "", 1),
        "conditional_tools": block.replace(tools, tools.replace("        run:", "        if: false\n        run:"), 1),
        "ignored_tools": block.replace(tools, tools.replace("        run:", "        continue-on-error: true\n        run:"), 1),
        "masked_tools": block.replace(tools, tools.replace("|| exit $?", "|| true", 1), 1),
        "tools_after_lock": block.replace(tools + guard, guard + tools, 1),
        "unqualified_cache": block.replace('          node-version: "24.22.1"\n',
                                             '          node-version: "24.22.1"\n          cache: npm\n', 1),
        "missing_sync": block.replace('          "$RUNNER_TEMP/vivary-build-tools/bin/npm" run sync-docs || exit $?\n', '', 1),
        "lifecycle_install": block.replace(" ci --ignore-scripts", " ci", 1),
        "missing": block.replace(guard, "", 1),
        "duplicate": block.replace(guard, guard + guard, 1),
        "conditional": block.replace(guard, guard.replace("        run:", "        if: false\n        run:"), 1),
        "ignored": block.replace(guard, guard.replace("        run:", "        continue-on-error: true\n        run:"), 1),
        "masked": block.replace(guard, guard.replace(".py\n", ".py || true\n"), 1),
        "redirected": block.replace(guard, guard + "        working-directory: site\n", 1),
        "after_install": block.replace(guard + install, install + guard, 1),
        "after_build": block.replace(guard, "", 1).replace(build, build + guard, 1),
        "build_before_audit": block.replace(build, "", 1).replace(audit, build + audit, 1),
        "no_build": block.replace(build, "", 1),
        "ignored_build": block.replace(build, build.replace("        run:", "        continue-on-error: true\n        run:"), 1),
        "inherited_shell": block.replace("    steps:\n", "    defaults:\n      run:\n        shell: echo {0}\n    steps:\n", 1),
        "ignored_job": block.replace("    steps:\n", "    continue-on-error: true\n    steps:\n", 1),
        "missing_installed": block.replace(installed, "", 1),
        "duplicate_installed": block.replace(installed, installed + installed, 1),
        "conditional_installed": block.replace(installed, installed.replace("        run:", "        if: false\n        run:"), 1),
        "ignored_installed": block.replace(installed, installed.replace("        run:", "        continue-on-error: true\n        run:"), 1),
        "masked_installed": block.replace(installed, installed.replace("--installed\n", "--installed || true\n"), 1),
        "redirected_installed": block.replace(installed, installed + "        working-directory: site\n", 1),
        "installed_after_audit": block.replace(installed, "", 1).replace(audit, audit + installed, 1),
        "installed_before_install": block.replace(install + installed, installed + install, 1),
        "escaped_defaults": block.replace("    steps:\n", r'    "def\u0061ults":' + "\n      run:\n        shell: echo {0}\n    steps:\n", 1),
        "escaped_continue_on_error": block.replace("    steps:\n", r'    "continue-on-err\u006fr": true' + "\n    steps:\n", 1),
        "late_defaults": block.rstrip("\n") + "\n    defaults:\n      run:\n        shell: echo {0}\n",
        "late_continue_on_error": block.rstrip("\n") + "\n    'continue-on-error': true\n",
    }
    # These are YAML mapping keys, including the exact two previously accepted forms.
    for key, value in (("defaults", "\n      run:\n        shell: echo {0}\n"),
                       ("continue-on-error", " true\n")):
        for spelling in (key, "'" + key + "'", '"' + key + '"'):
            for spacing in ("", " ", "\t"):
                if spelling == key and not spacing:
                    continue  # The two plain forms already occur above.
                addition = "    " + spelling + spacing + ":" + value
                mutations[f"header:{spelling}:{spacing!r}"] = block.replace("    steps:\n", addition + "    steps:\n", 1)
    for label, mutation in mutations.items():
        assert mutation != block, label
        try:
            module.check_site_dependencies(workflow.replace(block, mutation, 1))
        except SystemExit as error:
            assert "site known dependency admission" in str(error) or "site cannot add job fields" in str(error), (label, error)
        else:
            raise AssertionError(label + " bypassed site dependency admission")
    assert REAL_WORKFLOW.read_text(encoding="utf-8") == workflow


def test_pip_network_cannot_reintroduce_host_truststore_roots():
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    assert _run(workflow) is None
    for mutation in (workflow.replace(" --use-deprecated=legacy-certs", ""),
                     workflow.replace("  PIP_USE_DEPRECATED: legacy-certs\n", ""),
                     workflow.replace("  PIP_USE_DEPRECATED: legacy-certs", "  PIP_USE_DEPRECATED: other")):
        assert mutation != workflow
        message = _run(mutation)
        assert message and "pip" in message, message


def test_python_selection_and_actual_admission_cannot_float_or_be_bypassed():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    module.check_python_runtime(workflow)
    guard = module.PYTHON_RUNTIME_STEP
    for name in module.PYTHON_JOBS:
        block = module.job_block(workflow, name)
        prefix = module.python_admission_prefix(name)
        provision = prefix[-2]
        entry = prefix[0]
        cases = {
            "old_python": block.replace('python-version: "3.12.15"', 'python-version: "3.11"', 1),
            "floating_python": block.replace('python-version: "3.12.15"', 'python-version: "3.12"', 1),
            "future_python": block.replace('python-version: "3.12.15"', 'python-version: "3.12.16"', 1),
            "missing_provisioning": block.replace(provision, "", 1),
            "conditional_provisioning": block.replace(provision,
                                                     provision.replace("        shell:", "        if: false\n        shell:"), 1),
            "wrong_provisioning": block.replace(provision,
                                               provision.replace("bootstrap_ci_python", "bootstrap_ci_pip"), 1),
            "provisioning_after_admission": block.replace(provision + guard,
                                                         guard + provision, 1),
            "missing_guard": block.replace(guard, "", 1),
            "conditional_guard": block.replace(guard, guard.replace("        shell:", "        if: false\n        shell:"), 1),
            "ignored_guard": block.replace(guard, guard.replace("        shell:", "        continue-on-error: true\n        shell:"), 1),
            "nonisolated_guard": block.replace(guard, guard.replace("python -I -B", "python -B"), 1),
            "bytecode_guard": block.replace(guard, guard.replace("python -I -B", "python -I"), 1),
            "wrong_guard": block.replace(guard, guard.replace("check_python_runtime.py", "check_pip_runtime.py"), 1),
            "early_pip": block.replace(guard, '      - run: python -m pip install anything\n' + guard, 1),
            "early_tools": block.replace(entry,
                                        '      - run: python scripts/bootstrap_build_tools.py --root /tmp/tools\n' + entry, 1),
        }
        if name == "governed-platform-proof":
            for label in ("old_python", "floating_python", "future_python"):
                del cases[label]
            cases["unqualified_image_python"] = block.replace(provision,
                "      - run: python scripts/bootstrap_ci_python.py\n", 1)
        if name == "orientation-proof":
            linux_provision = prefix[1]
            cases["missing_linux_provision"] = block.replace(linux_provision, "", 1)
            cases["wrong_platform_condition"] = block.replace("runner.os == 'Windows'", "runner.os != 'Windows'", 1)
            cases["unconditional_linux_setup"] = block.replace(
                "        if: ${{ runner.os != 'Windows' && steps.runner_action_node.outcome == 'success' }}\n", "", 1)
        for label, mutation in cases.items():
            assert mutation != block, (name, label)
            try:
                module.check_python_runtime(workflow.replace(block, mutation, 1))
            except SystemExit as error:
                assert name in str(error) and "Python" in str(error), (name, label, error)
            else:
                raise AssertionError((name, label, "bypassed actual Python/OpenSSL admission"))


def test_python_runtime_regressions_must_run():
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    message = _run(workflow.replace("python -I -B scripts/tests/test_python_runtime.py", "echo skipped", 1))
    assert message and "Python runtime admission regressions" in message


def test_python_provisioning_regressions_must_run():
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    message = _run(workflow.replace("python -I -B scripts/tests/test_bootstrap_ci_python.py", "echo skipped", 1))
    assert message and "verified Python provisioning regressions" in message


def test_windows_python_bootstrap_regressions_must_run():
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    message = _run(workflow.replace("python -I -B scripts/tests/test_ci_python_windows_bootstrap.py", "echo skipped", 1))
    assert message and "native Windows Python bootstrap regressions" in message


def test_runner_node_repair_regressions_must_run():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    step = module.REPAIR_TEST_STEP
    for mutation in (
        step.replace("python -I -B scripts/tests/test_bootstrap_runner_action_node.py", "echo skipped", 1),
        step.replace("/node/bin/node", "/bin/node", 1),
        step.replace('        env:\n          VIVARY_TEST_NODE: ${{ runner.temp }}/vivary-build-tools/node/bin/node\n', "", 1),
    ):
        assert mutation != step
        message = _run(workflow.replace(step, mutation, 1))
        assert message and "runner action repair regressions" in message


def test_fresh_venvs_admit_their_actual_python_before_pip_provisioning():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    for name, blocks in module.PIP_VENV_BLOCKS.items():
        for required in blocks:
            lines = required.splitlines(keepends=True)
            guard = next(line for line in lines if "scripts/check_python_runtime.py" in line)
            seed = next(line for line in lines if "scripts/bootstrap_ci_pip.py" in line)
            assert lines.index(guard) < lines.index(seed)
            failure = guard if "exit $?" in guard else lines[lines.index(guard) + 1]
            mutations = {
                "missing_python_admission": required.replace(guard, "", 1),
                "wrong_python_target": required.replace(guard, guard.replace('"$venv_python"', "python").replace('"$mcp_python"', "python").replace("& $mcpPython", "python").replace("& $python", "python"), 1),
                "python_after_pip_seed": required.replace(guard, "", 1).replace(seed, seed + guard, 1),
                "ignored_python_failure": required.replace(failure, failure.replace("exit $?", "true").replace("$LASTEXITCODE -ne 0", "$false"), 1),
            }
            for label, mutation in mutations.items():
                assert mutation != required, (name, label)
                message = _run(workflow.replace(required, mutation, 1))
                assert message and "pip" in message, (name, label, message)


def test_review_python_admission_remains_bound_to_the_helper_after_canonical_edits():
    module = _load()
    canonical = module.CANONICAL_REVIEW_WORKFLOW
    guard = module.python_runtime_step(inline=True)
    for mutation in (canonical.replace(guard, "", 1),
                     canonical.replace(guard, guard.replace('OPENSSL = ["OpenSSL", "3.5.9"]',
                                                           'OPENSSL = ["OpenSSL", "3.5.8"]'), 1),
                     canonical.replace('python-version: "3.12.15"', 'python-version: "3.12.16"', 1)):
        assert mutation != canonical
        module.CANONICAL_REVIEW_WORKFLOW = mutation
        try:
            module.check_review_workflow(mutation)
        except SystemExit as error:
            assert "Python" in str(error), error
        else:
            raise AssertionError("canonical edits bypassed the actual review Python admission")


def test_review_python_provisioning_remains_bound_to_the_helper_and_ca_policy():
    module = _load()
    canonical = module.CANONICAL_REVIEW_WORKFLOW
    step = module.python_provisioning_step(inline=True)
    for mutation in (canonical.replace(step, "", 1),
                     canonical.replace(step, step.replace('"size": 34479606', '"size": 34479607'), 1),
                     canonical.replace(step, step.replace('CERTIFI_VERSION = "2026.10.23"',
                                                         'CERTIFI_VERSION = "2026.10.19"'), 1)):
        assert mutation != canonical
        module.CANONICAL_REVIEW_WORKFLOW = mutation
        try:
            module.check_review_workflow(mutation)
        except SystemExit as error:
            assert "Python" in str(error), error
        else:
            raise AssertionError("canonical edits bypassed authenticated review Python provisioning")


def test_linux_workbench_jobs_cannot_restore_unqualified_clients_or_compilers():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    module.check_workbench_build_tools(workflow)
    for name in ("test",):
        block = module.job_block(workflow, name)
        tools, install, dependencies = module.WORKBENCH_TOOLS_STEP, module.WORKBENCH_INSTALL_STEP, module.WORKBENCH_DEPENDENCY_STEP
        mutations = {
            "missing_tools": block.replace(tools, "", 1),
            "conditional_tools": block.replace(tools, tools.replace("        shell:", "        if: false\n        shell:"), 1),
            "ignored_tools": block.replace(tools, tools.replace("        shell:", "        continue-on-error: true\n        shell:"), 1),
            "masked_failure": block.replace(tools, tools.replace("|| exit $?", "|| true", 1), 1),
            "unrebuilt_typescript": block.replace(tools, tools.replace(" --typescript", ""), 1),
            "late_tools": block.replace(tools + dependencies + install, dependencies + install + tools, 1),
            "missing_dependency_admission": block.replace(dependencies, "", 1),
            "late_dependency_admission": block.replace(dependencies + install, install + dependencies, 1),
            "global_client": block.replace(install, install + "      - run: npm install --global pnpm@10.33.2\n", 1),
            "lifecycle_install": block.replace(install, install.replace(" --ignore-scripts", ""), 1),
            "floating_lock": block.replace(install, install.replace(" --frozen-lockfile", ""), 1),
            "wrong_client": block.replace(install, install.replace('"$RUNNER_TEMP/vivary-build-tools/bin/pnpm"', "pnpm"), 1),
        }
        for label, mutation in mutations.items():
            assert mutation != block, (name, label)
            try:
                module.check_workbench_build_tools(workflow.replace(block, mutation, 1))
            except SystemExit as error:
                assert name in str(error), (name, label, error)
            else:
                raise AssertionError((name, label, "bypassed Workbench client/compiler admission"))
    for mutation in (
        workflow.replace(module.WORKBENCH_TYPECHECK, "          pnpm --dir packages/workbench typecheck\n", 1),
        workflow.replace(module.WORKBENCH_TYPECHECK, '', 1),
    ):
        try:
            module.check_workbench_build_tools(mutation)
        except SystemExit as error:
            assert "TypeScript" in str(error), error
        else:
            raise AssertionError("unqualified TypeScript bypassed Workbench compiler admission")




def test_release_pack_cannot_use_the_unqualified_image_client():
    module = _load()
    workflow = REAL_WORKFLOW.read_text(encoding="utf-8")
    block = module.job_block(workflow, "test")
    tools = module.WORKBENCH_TOOLS_STEP
    mutations = {
        "missing_client_setup": block.replace(tools, "", 1),
        "conditional_client_setup": block.replace(tools, tools.replace("        shell:", "        if: false\n        shell:"), 1),
        "ignored_failure": block.replace(tools, tools.replace("|| exit $?", "|| true"), 1),
        "late_client_setup": block.replace(tools, "", 1) + tools,
        "image_client": block.replace(module.TEST_PACK_COMMAND, 'npm pack packages/create-vivary/npm --pack-destination "$artifacts"', 1),
    }
    for label, mutation in mutations.items():
        assert mutation != block, label
        try:
            module.check_release_package_clients(workflow.replace(block, mutation, 1))
        except SystemExit as error:
            assert "package clients" in str(error), (label, error)
        else:
            raise AssertionError((label, "release packaging bypassed qualified clients"))


def test_first_key_action_condition_still_requires_bootstrap_success():
    text = REAL_WORKFLOW.read_text(encoding="utf-8")
    mutated, count = re.subn(r"(?m)^      - uses: (actions/\S+)$", r"      - if: ${{ always() }}\n        uses: \1", text, count=1)
    assert count == 1
    message = _run(mutated)
    assert message and "must require bootstrap success" in message, message


def test_auxiliary_workflow_bootstraps_must_match_the_canonical_step():
    module = _load()
    for path, names in module.AUXILIARY_WORKFLOWS:
        text = (ROOT / path).read_text(encoding="utf-8")
        module.check_runner_action_bootstrap(text, names, auxiliary=True)
        drifted = text.replace('"sha256": "', '"sha256": "0', 1)
        assert drifted != text, path
        with tempfile.TemporaryDirectory() as tmp:
            stale = Path(tmp) / path.name
            stale.write_text(drifted, encoding="utf-8")
            module = _load()
            module.AUXILIARY_WORKFLOWS = ((stale, names),)
            try:
                module.main()
            except SystemExit as error:
                assert "first step must be the canonical" in str(error), (path, error)
            else:
                raise AssertionError(f"{path} bootstrap drift was not refused")


def test_site_job_must_run_its_behavior_tests_before_the_build():
    text = REAL_WORKFLOW.read_text(encoding="utf-8")
    step = _load().SITE_TEST_STEP
    assert text.count(step) == 1
    for mutated in (text.replace(step, "", 1),
                    text.replace(step, step.replace("        run:", "        if: false\n        run:"), 1)):
        message = _run(mutated)
        assert message and "site behavior tests must run before the build" in message, message


def test_synthetic_workflow_fixture_passes_the_contract():
    # Every mutation test below starts from this fixture, so it must pass on its own,
    # or each mutation would be refused for an unrelated reason.
    assert _run(_workflow(INSTALL + AUDIT)) is None


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
