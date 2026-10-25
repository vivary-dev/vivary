"""Guard the desktop release workflow's triggers, toolchain, pins and draft-only release.

The runner admission, Python and build tool steps are the canonical ones from
check_ci_workflow.py, so they cannot drift from ci.yml.
"""

import importlib.util
import re
import sys
from pathlib import Path


WORKFLOW = Path(".github/workflows/desktop-release.yml")
CI_WORKFLOW = Path(".github/workflows/ci.yml")
WINDOWS_TARGET = Path("packages/desktop/windows-target.mjs")
BUILD_JOBS = ("build", "draft")


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ci = load("check_ci_workflow")
build_tools = load("bootstrap_build_tools")

TRIGGERS = """on:
  workflow_dispatch:
  push:
    branches: ["release-dry-run/**"]
    tags: ["v*.*.*-beta.*"]

permissions:
  contents: read
"""
DRAFT_JOB = """  draft:
    name: Draft prerelease
    if: github.event_name == 'push' && github.ref_type == 'tag'
    needs: build
"""
NODE_GUARD_STEP = (
    "      - name: actual Node security admission\n"
    "        run: " + ci.NODE_GUARD + "\n"
)
TOOLS = (ci.WORKBENCH_TOOLS_STEP, ci.WORKBENCH_DEPENDENCY_STEP, ci.WORKBENCH_INSTALL_STEP)
DESKTOP_INSTALL_STEP = (
    "      - name: install desktop dependencies\n"
    "        shell: bash\n"
    "        run: '\"$RUNNER_TEMP/vivary-build-tools/bin/npm\" --prefix packages/desktop ci --ignore-scripts'\n"
)
TAG_STEP = (
    "      - name: Require a release tag to name the desktop version\n"
    "        if: github.ref_type == 'tag'\n"
    "        env:\n"
    "          VERSION: ${{ steps.version.outputs.version }}\n"
    "        run: test \"$GITHUB_REF_NAME\" = \"v$VERSION\"\n"
)
PACKAGE_STEP = (
    "      - name: Package Windows x64 from a source build of Workbench\n"
    "        shell: bash\n"
    "        run: '\"$RUNNER_TEMP/vivary-build-tools/bin/npm\" --prefix packages/desktop run package"
    " -- --windows-x64 --build-workbench'\n"
)


def steps_of(text: str, job: str) -> list[str]:
    return re.split(r"(?m)(?=^      - )", ci.job_block(text, job))[1:]


def check(text: str, windows_target: str, ci_text: str) -> list[str]:
    """Returns every rule the workflow text breaks, given the Windows target and ci.yml sources."""
    problems = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    def contract(rule, *args, **kwargs) -> None:
        try:
            rule(*args, **kwargs)
        except SystemExit as error:
            problems.append(str(error).removeprefix(f"{ci.WORKFLOW}: "))

    # ci.yml's runner admission, action manifests and setup-node pin, then its Python selection and admission.
    contract(ci.check_runner_action_bootstrap, text, BUILD_JOBS, auxiliary=True)
    contract(ci.check_python_runtime, text, names=("build",))

    bundled = re.search(r'nodeVersion: "v(\d+\.\d+\.\d+)"', windows_target)
    require(bundled is not None, f"{WINDOWS_TARGET} names no bundled Node version")
    ci_nodes = set(re.findall(r'node-version: "([^"]+)"', ci_text))
    if bundled:
        node = bundled.group(1)
        require(build_tools.NODE == node, f"scripts/bootstrap_build_tools.py must pin Node {node}, which the Windows package bundles")
        require(ci_nodes == {node}, f"ci.yml must select Node {node}, which the Windows package bundles")
        require(re.findall(r'node-version: "([^"]+)"', text) == [node],
                f"setup-node must install Node {node}, which the Windows package bundles")

    try:
        steps = steps_of(text, "build")
    except SystemExit as error:
        problems.append(str(error))
        return problems
    setup = [i for i, step in enumerate(steps) if "uses: actions/setup-node@" in step]
    guard = [i for i, step in enumerate(steps) if ci.NODE_GUARD in step]
    require(len(setup) == len(guard) == 1 and guard[0] == setup[0] + 1
            and steps[guard[0]] == NODE_GUARD_STEP, "the Node security admission must directly follow setup-node")
    tools = [i for i, step in enumerate(steps) if step.rstrip("\n") == TOOLS[0].rstrip("\n")]
    require(len(tools) == 1 and [step.rstrip("\n") for step in steps[tools[0]:tools[0] + 4]]
            == [step.rstrip("\n") for step in (*TOOLS, DESKTOP_INSTALL_STEP)],
            "build tools, dependency admission and both locked installs must use ci.yml's isolated clients in order")
    if setup and guard and tools:
        require(guard[0] < tools[0], "Node must be admitted before the build tools")
        before = "".join(steps[:tools[0]])
        require(not re.search(r"(?m)^\s*(?:run:\s*)?['\"]?(?:npm|pnpm|corepack|npx)\s", before),
                "no package client may run before the isolated build tools")
    require(sum(step.rstrip("\n") == PACKAGE_STEP.rstrip("\n") for step in steps) == 1,
            "the package must come from a source build of Workbench with the isolated npm")
    require(not re.search(r"(?m)^\s*(?:run:\s*)?['\"]?(?:npm|pnpm|corepack|npx)\s", text),
            "every package command must use the isolated clients under $RUNNER_TEMP/vivary-build-tools")
    require("npm install --global" not in text, "no global package client install")

    require(TRIGGERS in text, "triggers must be workflow_dispatch, dry-run branches and beta tags, with read-only default permissions")
    require(text.count("\non:") == 1 and text.count("\npermissions:") == 1, "one trigger block and one default permissions block")
    uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", text, re.MULTILINE)
    require(sorted(action.split("@")[0] for action in uses) == sorted((
        "actions/checkout", "actions/setup-python", "actions/setup-node", "actions/upload-artifact", "actions/download-artifact")),
        "checkout, setup-python, setup-node, upload-artifact and download-artifact only")
    require(text.count("persist-credentials: false") == text.count("actions/checkout@"),
            "every checkout must drop its credentials")
    require("secrets." not in text, "the workflow reads no secrets beyond the job token")
    for forbidden in ("git push", "git tag", "gh release edit", "gh release upload", "--draft=false", "pull_request"):
        require(forbidden not in text, f"forbidden in the release workflow: {forbidden}")

    require(DRAFT_JOB in text, "the draft job must run only for a pushed tag, after the build")
    draft = text.index(DRAFT_JOB) if DRAFT_JOB in text else len(text)
    require(text.count("contents: write") == 1 and text.find("contents: write") > draft,
            "contents: write belongs to the draft job only")
    require(text.count("gh release create") == 1 and text.find("gh release create") > draft,
            "only the draft job creates a release")
    create = text[text.find("gh release create"):]
    for flag in ("--verify-tag", "--draft", "--prerelease", "--latest=false"):
        require(flag in create.split("./*")[0], f"the release must be created with {flag}")
    require(sum(step.rstrip("\n") == TAG_STEP.rstrip("\n") for step in steps) == 1,
            "a release tag must name the desktop version, in the exact reviewed step")
    require('--commit "$GITHUB_SHA"' in text, "the release files must be checked against the built commit")
    require("sha256sum --check --strict SHA256SUMS" in text[draft:], "the draft job must check the downloaded files")
    require("if-no-files-found: error" in text, "a missing release file must fail the upload")
    return problems


def main() -> None:
    problems = check(WORKFLOW.read_text(encoding="utf-8"), WINDOWS_TARGET.read_text(encoding="utf-8"),
                     CI_WORKFLOW.read_text(encoding="utf-8"))
    for problem in problems:
        print(f"{WORKFLOW}: {problem}", file=sys.stderr)
    if problems:
        raise SystemExit(1)
    print(f"{WORKFLOW}: desktop release guard passed")


if __name__ == "__main__":
    main()
