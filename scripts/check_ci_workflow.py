import importlib.util
import re
from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")
REVIEW_WORKFLOW = Path(".github/workflows/review-gate.yml")
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


# The required review gate workflow must match this text exactly, so no extra step, job,
# trigger or condition can weaken it unnoticed. Change both together, with owner review.
CANONICAL_REVIEW_WORKFLOW = """name: review gate

# The required review gate runs only for pull requests, so pushes to long-lived
# branches never publish its check. It runs the gate script from the pull request's
# base commit, so edits to that script take effect only after review and merge.
# Only while the base has no gate script does it fetch and run the script from the
# commit pinned below. For PR #193, which introduced the gate, that is its own reviewed
# commit; after that merge it is in dev's history, and main uses it until main has the script.
# A pull request can still edit this workflow file, so .github changes need owner review.
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]

concurrency:
  group: review-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  issues: read

jobs:
  review-gate:
    name: required review gate
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
          persist-credentials: false
      - name: find the base commit's gate script
        id: base
        run: |
          if [ -f base/scripts/check_review_gate.py ]; then
            echo "missing=false" >> "$GITHUB_OUTPUT"
          else
            echo "missing=true" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.base.outputs.missing == 'true'
        uses: actions/checkout@v7.0.1
        with:
          ref: 80370e094248c84c55da663d977efc7601d17e84
          path: bootstrap
          persist-credentials: false
      - uses: actions/setup-python@v7
        with:
          python-version: "3.11"
      - name: wait for completed reviews and resolved threads
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          gate=base/scripts/check_review_gate.py
          if [ ! -f "$gate" ]; then
            echo "required review gate: base has no gate script; using the pinned bootstrap script"
            gate=bootstrap/scripts/check_review_gate.py
          fi
          python "$gate" --wait-seconds 2400 --interval 30
"""


def check_review_workflow(text: str) -> None:
    """The required review gate workflow is exactly the reviewed canonical text."""
    if text != CANONICAL_REVIEW_WORKFLOW:
        raise SystemExit(f"{REVIEW_WORKFLOW}: must match the canonical required review gate workflow "
                         "in scripts/check_ci_workflow.py (pull requests only, base-revision or pinned bootstrap script, real wait)")


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


NODE_GUARD = "node packages/workbench/bin/runtime-security.mjs"
NODE_JOBS = ("test", "workbench", "workbench-maintained", "governed-platform-proof", "orientation-proof", "site")
CI_JOBS = ("changes", "test", "workbench", "workbench-maintained", "governed-platform-proof", "orientation-proof", "review", "site")
RUNNER_BOOTSTRAP = Path(__file__).resolve().with_name("check_runner_action_node.py")
BOOTSTRAP_ANCHOR = "runner_action_node_bootstrap"
BOOTSTRAP_ALIAS = "      - *" + BOOTSTRAP_ANCHOR + "\n"

# Official manifests examined by the controller, not mutable release tags.
# Runner dispatch source 197ca027b90de199464dee3bb9ff198a1db60967:
# NodeScriptActionHandler.cs:116-118 selects externals/node24/bin/node.
# JobExtension.cs:325-330 prepares pre steps before workflow steps, so no-pre
# is essential to the first-step admission argument, including post actions.
ACTION_MANIFESTS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1": {"using": "node24", "main": "dist/index.js", "post": "dist/index.js"},
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9": {"using": "node24", "main": "dist/upload/index.js"},
}


def validate_action_manifest(reference: str, runs: dict) -> None:
    require(reference in ACTION_MANIFESTS, "unproved or mutable action identity: " + reference)
    require(runs == ACTION_MANIFESTS[reference] and "pre" not in runs and runs.get("using") == "node24",
            "action main/post/no-pre metadata mismatch: " + reference)


def runner_bootstrap_step() -> str:
    source = RUNNER_BOOTSTRAP.read_text(encoding="utf-8").replace("\r\n", "\n")
    require(source.endswith("\n") and "\r" not in source, "canonical runner bootstrap must use LF and a final newline")
    return ("      - &" + BOOTSTRAP_ANCHOR + "\n"
            "        name: runner action Node admission\n"
            "        id: runner_action_node\n"
            "        shell: python -I -B {0}\n"
            "        run: |\n" + "".join("          " + line + "\n" if line else "\n" for line in source.splitlines()))


def check_runner_action_bootstrap(text: str, names: tuple[str, ...], npm=False) -> None:
    jobs = text.split("\njobs:\n", 1)[-1]
    headers = re.findall(r"(?m)^  ([\w-]+):\s*$", jobs)
    require(tuple(headers) == names, "runner bootstrap must cover the exact job inventory")
    canonical = runner_bootstrap_step().rstrip("\n")
    require(len(re.findall(r"(?m)^      - &", jobs)) == 1, "exactly one complete bootstrap mapping anchor is required")
    total_uses = 0
    for index, name in enumerate(names):
        job = job_block(text, name)
        header = job.split("    steps:", 1)[0]
        require(not re.search(r"(?m)^\s+(?:container|services|continue-on-error):", header),
                name + " has unsupported container/failure configuration")
        supported = "    runs-on: ubuntu-latest\n" in header or "    runs-on: windows-latest\n" in header
        if name == "orientation-proof":
            supported = "    runs-on: ${{ matrix.os }}\n" in header and "        os: [ubuntu-latest, windows-latest]\n" in header
        require(supported, name + " requires the approved Ubuntu/Windows x64 configuration")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        require(bool(steps), name + " has no bootstrap")
        expected = canonical if index == 0 else BOOTSTRAP_ALIAS.rstrip("\n")
        require(steps[0].rstrip("\n") == expected, name + " first step must be the canonical unconditional Python bootstrap")
        require(sum(step.count("id: runner_action_node") for step in steps[1:]) == 0,
                name + " cannot replace the bootstrap result")
        for step in steps[1:]:
            require(not step.startswith(("      - &", "      - *")) and "        <<:" not in step,
                    name + " has an unproved step alias or merge")
            require(re.match(r"^      - (?:name|uses|run|if|id|shell|env):", step) is not None,
                    name + " has an unsupported step mapping")
            uses = re.findall(r"(?m)^(?:      - |        )uses: (\S+)\s*$", step)
            if not uses:
                continue
            require(len(uses) == 1, name + " has ambiguous action identity")
            reference = uses[0]
            validate_action_manifest(reference, ACTION_MANIFESTS.get(reference, {}))
            if reference.startswith("actions/setup-node@"):
                pin = "820762786026740c76f36085b0efc47a31fe5020" if npm else "949feb2413d6458794dcd2491c4babbbce0c15c1"
                require(reference == "actions/setup-node@" + pin, name + " has the wrong setup-node identity")
            require("continue-on-error:" not in step, name + " cannot ignore an action failure")
            conditions = re.findall(r"(?m)^        if: (.+)$", step)
            if conditions:
                require(len(conditions) == 1, name + " has ambiguous action conditions")
                expression = conditions[0].removeprefix("${{").removesuffix("}}").strip()
                require("||" not in expression and "steps.runner_action_node.outcome == 'success'" in [part.strip() for part in expression.split("&&")],
                        name + " conditional action must require bootstrap success")
            total_uses += 1
    require(total_uses == len(re.findall(r"(?m)^\s*(?:-\s+)?uses:", jobs)), "unproved action outside an admitted step")
    if npm:
        publish = job_block(text, "publish").split("    steps:", 1)[0]
        require("    needs: verify\n" in publish and "    if: ${{ inputs.publish && needs.verify.result == 'success' }}" in publish,
                "npm publication requires explicit approval and successful verify dependency")
    else:
        orientation = job_block(text, "orientation-proof")
        require("if: ${{ !cancelled() && steps.runner_action_node.outcome == 'success' }}" in orientation,
                "orientation upload must survive later failure only after bootstrap success")
        require("uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" in orientation,
                "orientation receipt upload must retain its exact no-pre action")


def check_runtime_security(text: str) -> None:
    for name in NODE_JOBS:
        job = job_block(text, name)
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        setups = [i for i, step in enumerate(steps) if "uses: actions/setup-node@" in step]
        guards = [i for i, step in enumerate(steps) if NODE_GUARD in step]
        require(len(setups) == len(guards) == 1, f"{name} needs exactly one actual Node guard and setup")
        require(guards[0] == setups[0] + 1, f"{name} Node guard must immediately follow setup-node")
        guard = steps[guards[0]]
        require(re.search(r"(?m)^        run: " + re.escape(NODE_GUARD) + r"\s*$", guard) is not None,
                f"{name} Node guard must be an unconditional standalone command")
        require(not re.search(r"(?m)^\s+(?:if|continue-on-error|working-directory|env):", guard),
                f"{name} Node guard cannot be skipped, redirected or ignored")
        require("continue-on-error:" not in job.split("    steps:", 1)[0], f"{name} cannot ignore job failure")
        before = "".join(steps[:guards[0]])
        require(not re.search(r"(?m)^\s*(?:run:\s*)?(?:npm|pnpm|corepack)\s", before),
                f"{name} must admit Node before package operations")
        for step in steps:
            # A one-line YAML run step includes its list dash. Inspect its command,
            # as well as block commands, rather than the surrounding YAML text.
            commands = re.sub(r"(?m)^      - run:\s*", "", step)
            commands = re.sub(r"(?m)^        run:\s*", "", commands)
            require(not re.search(r"(?m)^\s*['\"]?(?:agent-native|astro) build(?:\s|$|['\"])", commands),
                    f"{name} direct builds must use the guarded package build command")
    require("node --test packages/workbench/tests/runtime-security.test.mjs" in job_block(text, "workbench"),
            "workbench must run Node security policy and entry tests")
    require("python scripts/tests/test_npm_trusted_publish_workflow.py" in job_block(text, "test"),
            "tests job must run npm runtime/publication mutation tests")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    changes_job = job_block(text, "changes")
    test_job = job_block(text, "test")
    workbench_job = job_block(text, "workbench")
    workbench_maintained_job = job_block(text, "workbench-maintained")
    governed_job = job_block(text, "governed-platform-proof")
    orientation_job = job_block(text, "orientation-proof")
    review_job = job_block(text, "review")
    site_job = job_block(text, "site")
    require("python scripts/tests/test_review_gate.py" in test_job,
            "tests job must exercise the required review gate")

    require("python scripts/tests/test_hldd.py" in test_job,
            "tests job must exercise the HLDD gate")
    require('python scripts/check_hldd.py --base "$BASE_SHA" --head "$HEAD_SHA"' in test_job,
            "tests job must enforce HLDD review on the explicit commit range")
    require("HEAD_SHA: ${{ inputs.head_sha || github.event.pull_request.head.sha || github.sha }}" in test_job,
            "HLDD review must use the actual PR head, not the synthetic merge")

    runner_install = "python -m pip install pytest packaging"
    first_pytest = "python -m pytest"
    contract_tests = "python scripts/tests/test_ci_workflow.py"
    source_navigation_check = "python -B scripts/check-source-navigation.py --check"
    source_navigation_tests = "python -B scripts/tests/test-source-navigation.py"
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
    windows_parity_check = "python scripts/check_installed_route_parity.py $scripts"
    windows_parity_characterize = (
        "python scripts/check_installed_route_parity.py --characterize $scripts"
    )
    strato_pin = 'assert version("vivary-strato") == "0.1.3"'
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
        ("workbench", workbench_job),
        ("workbench-maintained", workbench_maintained_job),
        ("governed-platform-proof", governed_job),
        ("orientation-proof", orientation_job),
        ("review", review_job),
        ("site", site_job),
    ):
        require(
            "    needs: changes" in block,
            f"{name} job must wait for dispatch validation",
        )
    for name, block in (
        ("test", test_job),
        ("workbench", workbench_job),
        ("workbench-maintained", workbench_maintained_job),
    ):
        require(
            "    if: ${{ always() }}" in block,
            f"required {name} job must run even when dispatch validation fails",
        )
        require(
            "if: needs.changes.result != 'success'" in block
            and "run: exit 1" in block,
            f"required {name} job must fail closed when dispatch validation fails",
        )
    maintained_checks = "pnpm --dir packages/workbench test:maintained"
    require(
        text.count(maintained_checks) == 1
        and maintained_checks in workbench_maintained_job,
        f"{maintained_checks} must run exactly once, in the workbench-maintained job",
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
    for command in (source_navigation_check, source_navigation_tests):
        require(command in test_job, f"tests job must run {command}")
        require(
            test_job.count(command) == 1,
            f"tests job must run {command} exactly once",
        )
        require(
            command in governed_job,
            f"governed-platform-proof job must run {command}",
        )
        require(
            governed_job.count(command) == 1,
            f"governed-platform-proof job must run {command} exactly once",
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
        strato_pin in test_job,
        f"wheelhouse smoke must pin the installed strato version with {strato_pin}",
    )
    for command in (windows_parity_check, windows_parity_characterize):
        require(
            command in governed_job,
            f"governed-platform-proof job must run {command}",
        )
        require(
            governed_job.count(command) == 1,
            f"governed-platform-proof job must run {command} exactly once",
        )
    require(
        governed_job.index(windows_parity_check)
        < governed_job.index(windows_parity_characterize),
        "Windows route parity must precede the installed command surface replay",
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

    check_runtime_security(text)
    check_runner_action_bootstrap(text, CI_JOBS)
    require("python -I -B scripts/tests/test_runner_action_node.py" in test_job,
            "tests job must run the runner action bootstrap regressions")
    check_review_workflow(REVIEW_WORKFLOW.read_text(encoding="utf-8"))
    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
