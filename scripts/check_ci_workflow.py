import importlib.util
import re
from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")
ARTIFACT_CHECKER = Path("scripts/check_release_artifacts.py")


def release_build_commands() -> tuple[str, ...]:
    """One `uv build` line per Python distribution the release checker verifies."""
    spec = importlib.util.spec_from_file_location("release_artifacts", ARTIFACT_CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return tuple(
        f'uv build --out-dir "$artifacts" packages/{package}'
        for package, _ in module.PYTHON_CANDIDATES
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"{WORKFLOW}: {message}")


def job_block(text: str, name: str) -> str:
    """Return one top-level job without accepting commands from later jobs."""
    jobs_marker = "\njobs:\n"
    require(jobs_marker in text, "workflow must declare jobs")
    jobs = text[text.index(jobs_marker) + len(jobs_marker) :]
    headers = list(re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", jobs))
    matches = [index for index, match in enumerate(headers) if match.group(1) == name]
    require(len(matches) == 1, f"workflow must declare exactly one {name} job")

    index = matches[0]
    start = headers[index].start()
    end = headers[index + 1].start() if index + 1 < len(headers) else len(jobs)
    return jobs[start:end]


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    changes_job = job_block(text, "changes")
    test_job = job_block(text, "test")
    governed_job = job_block(text, "governed-platform-proof")
    orientation_job = job_block(text, "orientation-proof")
    review_job = job_block(text, "review")
    site_job = job_block(text, "site")

    runner_install = "python -m pip install pytest packaging"
    first_pytest = "python -m pytest"
    contract_tests = "python scripts/tests/test_ci_workflow.py"
    automation_guard = "python scripts/check_repository_automation.py"
    automation_tests = "python scripts/tests/test_repository_automation.py"
    automation_behavior = (
        "python -m pytest scripts/tests/test_update_stats.py "
        "scripts/tests/test_steward_health.py -q"
    )
    artifact_test = "python scripts/tests/test_release_artifacts.py"
    artifact_check = (
        'python scripts/check_release_artifacts.py --repository . --artifacts "$artifacts"'
    )
    parity_tests = "python scripts/tests/test_installed_route_parity.py"
    parity_check = (
        'python scripts/check_installed_route_parity.py "$smoke/venv/bin"'
    )
    parity_characterize = (
        "python scripts/check_installed_route_parity.py --characterize"
        ' "$smoke/venv/bin"'
    )
    site_install = "        run: npm ci\n        working-directory: site"
    site_audit = (
        "        run: npm audit --audit-level=high\n"
        "        working-directory: site"
    )
    dispatched_base = (
        "${{ inputs.base_sha || github.event.pull_request.base.sha || "
        "github.event.before }}"
    )

    require("workflow_dispatch:" in text, "workflow must accept trusted dispatches")
    for input_name in ("head_sha", "base_sha", "pull_request_number"):
        input_pattern = rf"(?m)^      {input_name}:\s*$[\s\S]*?^        required: true\s*$"
        require(
            re.search(input_pattern, text) is not None,
            f"workflow_dispatch must require {input_name}",
        )
    require(
        "  pull-requests: read" in text,
        "workflow must grant read-only pull-request validation access",
    )
    require(
        'test "$GITHUB_SHA" = "$HEAD_SHA"' in changes_job,
        "dispatch must bind github.sha to inputs.head_sha",
    )
    for validation in (
        'LIVE_HEAD=$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)',
        'LIVE_BASE=$(gh pr view "$PR_NUMBER" --json baseRefOid --jq .baseRefOid)',
        'test "$LIVE_HEAD" = "$HEAD_SHA"',
        'test "$LIVE_BASE" = "$BASE_SHA"',
    ):
        require(validation in changes_job, f"dispatch validation must include {validation}")
    for input_name in ("head_sha", "base_sha", "pull_request_number"):
        require(
            f"${{{{ inputs.{input_name} }}}}" in changes_job,
            f"changes job must consume inputs.{input_name}",
        )
    require(
        dispatched_base in changes_job,
        "changed-path detection must use inputs.base_sha for dispatch",
    )
    require(
        dispatched_base in test_job,
        "diff hygiene must use inputs.base_sha for dispatch",
    )
    for name, block in (
        ("test", test_job),
        ("governed-platform-proof", governed_job),
        ("orientation-proof", orientation_job),
        ("review", review_job),
        ("site", site_job),
    ):
        require(
            "    needs: changes" in block,
            f"{name} job must wait for dispatch validation",
        )
    require(
        "    if: ${{ always() }}" in test_job,
        "required tests job must run even when dispatch validation fails",
    )
    require(
        "if: needs.changes.result != 'success'" in test_job
        and "run: exit 1" in test_job,
        "required tests job must fail closed when dispatch validation fails",
    )
    require(
        "github.event_name == 'pull_request' || "
        "github.event_name == 'workflow_dispatch'" in review_job,
        "graph review gate must run for pull requests and trusted workflow_dispatch",
    )

    require(runner_install in test_job, "tests job must install pytest and packaging")
    require(first_pytest in test_job, "tests job must run a pytest suite")
    require(
        test_job.index(runner_install) < test_job.index(first_pytest),
        "shared test runner install must precede the first pytest suite",
    )
    require(
        test_job.count(runner_install) == 1,
        "tests job must install the shared test runner exactly once",
    )
    require(
        "python scripts/check_ci_workflow.py" in test_job,
        "tests job must run the CI workflow contract guard",
    )
    require(
        contract_tests in test_job,
        f"tests job must run {contract_tests}",
    )
    require(
        test_job.count(contract_tests) == 1,
        "tests job must run the CI workflow contract regression suite exactly once",
    )
    for command in (automation_guard, automation_tests, automation_behavior):
        require(command in test_job, f"tests job must run {command}")
        require(
            test_job.count(command) == 1,
            f"tests job must run {command} exactly once",
        )
    for command in (
        "python -m pip install uv==0.11.21",
        artifact_test,
        *release_build_commands(),
        'npm pack packages/create-vivary/npm --pack-destination "$artifacts"',
        artifact_check,
    ):
        require(command in test_job, f"tests job must run {command}")
        require(test_job.count(command) == 1, f"tests job must run {command} exactly once")
    require(
        test_job.index(artifact_test) < test_job.index(artifact_check),
        "artifact contract tests must precede the real archive check",
    )
    for command in (parity_tests, parity_check, parity_characterize):
        require(command in test_job, f"tests job must run {command}")
        require(test_job.count(command) == 1, f"tests job must run {command} exactly once")
    require(
        test_job.index(parity_check) < test_job.index(parity_characterize),
        "route parity must precede the installed command surface replay",
    )
    require(
        site_install in site_job,
        "site job must run npm ci with working-directory: site",
    )
    require(
        site_job.count(site_install) == 1,
        "site job must run npm ci in site exactly once",
    )
    require(
        site_audit in site_job,
        "site job must run npm audit --audit-level=high with working-directory: site",
    )
    require(
        site_job.count(site_audit) == 1,
        "site job must run the blocking high-severity audit exactly once",
    )
    require(
        site_job.index(site_install) < site_job.index(site_audit),
        "site dependency audit must follow the locked npm install",
    )

    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
