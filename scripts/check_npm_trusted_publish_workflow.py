from pathlib import Path
import importlib.util
import re
import shlex


WORKFLOW = Path(".github/workflows/npm-trusted-publish.yml")
ACTION_PINS = (
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


NODE_GUARD = "node packages/workbench/bin/runtime-security.mjs"
PUBLISH = NODE_GUARD + ' publish-npm "$RUNNER_TEMP/npm-candidate"'


def shell_masks_failure(step: str) -> bool:
    """Quoted JavaScript operators are data, unlike shell failure masking."""
    run = step.split("        run: |\n", 1)[-1]
    lexer = shlex.shlex(run, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return True
    return any(token in ("||", "|", ";", "&") for token in tokens) or bool(
        re.search(r"(?m)^\s*(?:set\s+\+e|exit\s+0|true)(?:\s|$)", run)
    )


def check_runtime_and_archive(text: str) -> None:
    jobs = text.split("\njobs:\n", 1)[1]
    for name in ("verify", "publish"):
        match = re.search(r"(?ms)^  " + name + r":\n(.*?)(?=^  [\w-]+:\n|\Z)", jobs)
        require(match is not None, f"missing {name} job")
        job = match[0]
        header = job.split("    steps:", 1)[0]
        require("continue-on-error:" not in header, f"{name} cannot ignore failure")
        if name == "verify":
            require("    if:" not in header, "verify must not skip admission")
        else:
            require("    if: ${{ inputs.publish && needs.verify.result == 'success' }}" in header,
                    "publish must require explicit consent and verify success")
            require("    needs: verify\n" in header and "    environment: npm-publish\n" in header,
                    "publish must depend on verify in the protected environment")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        setups = [i for i, step in enumerate(steps) if "uses: actions/setup-node@" in step]
        guards = [i for i, step in enumerate(steps) if "          " + NODE_GUARD + "\n" in step]
        require(len(setups) == len(guards) == 1 and guards[0] == setups[0] + 1,
                f"{name} must guard its actual Node immediately after selection")
        require('          node-version: "24.22.1"\n' in steps[setups[0]],
                f"{name} must select the fixed admitted Node 24.22.1 runtime")
        guard = steps[guards[0]]
        require("        shell: bash\n" in guard and "          set -euo pipefail\n          " + NODE_GUARD + "\n" in guard,
                f"{name} runtime guard must fail closed before npm")
        require(not re.search(r"(?m)^\s+(?:if|continue-on-error|env|working-directory):", guard)
                and not shell_masks_failure(guard), f"{name} runtime guard cannot be skipped or ignored")
        require("npm 11.5.1+ is required for trusted publishing" in guard, f"{name} must retain npm admission")
        require(not re.search(r"(?m)^\s*(?:run:\s*)?npm\s", "".join(steps[:guards[0]])),
                f"{name} must guard Node before npm")
        packs = [i for i, step in enumerate(steps) if 'npm pack --pack-destination "$RUNNER_TEMP/npm-candidate"' in step]
        require(len(packs) == 1 and packs[0] > guards[0], f"{name} must pack after admission")
        pack = steps[packs[0]]
        require(not re.search(r"(?m)^\s+(?:if|continue-on-error):", pack) and not shell_masks_failure(pack),
                f"{name} archive validation cannot be skipped or ignored")
        require('--artifacts "$RUNNER_TEMP/npm-candidate" --scope npm' in pack, f"{name} must validate its exact archive")
        if name == "publish":
            publishing = [i for i, step in enumerate(steps) if "publish-npm" in step]
            require(len(publishing) == 1 and publishing[0] > packs[0], "publication must follow archive validation")
            step = steps[publishing[0]]
            require(re.search(r"(?m)^        run: " + re.escape(PUBLISH) + r"\s*$", step) is not None,
                    "publish must recheck Node and publish only the checked candidate archive")
            require(not re.search(r"(?m)^\s+(?:if|continue-on-error|working-directory|env):", step),
                    "publication admission cannot be skipped or redirected")
    require(not re.search(r"(?m)^\s*(?:run:\s*)?npm publish(?:\s|$)", text), "raw npm publication is forbidden")


def check_python_consumers(text: str, contract) -> None:
    contract.check_python_runtime(text, names=("verify", "publish"))
    for name in ("verify", "publish"):
        steps = re.split(r"(?m)(?=^      - )", contract.job_block(text, name))[1:]
        guard = next(index for index, step in enumerate(steps)
                     if "name: actual Python runtime admission" in step)
        for index, step in enumerate(steps[:guard]):
            # The first runner admission and authenticated Python provisioner
            # intentionally run before the newly provisioned Python is exposed.
            if index == 0 or step.rstrip("\n") == contract.PYTHON_PROVISIONING_STEP.rstrip("\n"):
                continue
            require(not re.search(r"(?m)^\s*(?:(?:run|shell):\s*)?['\"]?python(?:3(?:\.\d+)?)?(?:\s|$)", step),
                    f"{name} must admit actual Python before its consumers")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    required_snippets = [
        "workflow_dispatch:",
        "release_tag:",
        "publish:",
        "contents: read",
        "id-token: write",
        "needs: verify",
        "environment: npm-publish",
        "runs-on: ubuntu-latest",
        *ACTION_PINS,
        'node-version: "24.22.1"',
        'registry-url: "https://registry.npmjs.org"',
        "package-manager-cache: false",
        "Verify trusted publishing runtime",
        "npm 11.5.1+ is required for trusted publishing",
        "packages/create-vivary/tests/test_create_vivary.py",
        "packages/create-vivary/tests/test_init_thin.py",
        "packages/create-vivary/tests/test_record_workflow.py",
        "packages/create-vivary/tests/test_adopt.py",
        "packages/create-vivary/tests/test_assets_parity.py",
        "packages/create-vivary/tests/test_npm_launcher.js",
        'npm pack --pack-destination "$RUNNER_TEMP/npm-candidate"',
        "python ../../../scripts/check_release_artifacts.py --repository ../../.. "
        '--artifacts "$RUNNER_TEMP/npm-candidate" --scope npm',
        PUBLISH,
        "packages/create-vivary/npm",
        "persist-credentials: false",
    ]

    for snippet in required_snippets:
        require(snippet in text, f"{WORKFLOW}: missing required snippet: {snippet}")

    for snippet in (
        'mkdir -p "$RUNNER_TEMP/npm-candidate"',
        'npm pack --pack-destination "$RUNNER_TEMP/npm-candidate"',
        "python ../../../scripts/check_release_artifacts.py --repository ../../.. "
        '--artifacts "$RUNNER_TEMP/npm-candidate" --scope npm',
    ):
        require(
            text.count(snippet) == 2,
            f"{WORKFLOW}: verify and publish jobs must each run: {snippet}",
        )

    forbidden_snippets = [
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "_authToken",
        "always-auth",
        "npm publish --otp",
        "npm pack --dry-run",
        "--auth-type",
    ]

    for snippet in forbidden_snippets:
        require(snippet not in text, f"{WORKFLOW}: forbidden token/auth snippet: {snippet}")

    for mutable_ref in (
        "actions/checkout@v",
        "actions/setup-python@v",
        "actions/setup-node@v",
    ):
        require(
            mutable_ref not in text,
            f"{WORKFLOW}: external Action must use an immutable commit SHA: {mutable_ref}",
        )

    require(
        'test "${{ inputs.release_tag }}" = "v${{ inputs.version }}"' in text,
        f"{WORKFLOW}: publish path must be release-tag gated",
    )
    require(
        'git rev-parse "refs/tags/${{ inputs.release_tag }}^{commit}"' in text,
        f"{WORKFLOW}: checked-out commit must be verified against the release tag",
    )
    require(
        "require('./packages/create-vivary/npm/package.json').version" in text,
        f"{WORKFLOW}: npm package version must be verified before publish",
    )
    require(
        "pyproject={pypi_version} npm={npm_version}" in text,
        f"{WORKFLOW}: PyPI/npm lockstep version check must be present",
    )
    require(
        "if: ${{ inputs.publish && needs.verify.result == 'success' }}" in text,
        f"{WORKFLOW}: npm publish must require explicit publish=true",
    )
    require(
        "if: ${{ !inputs.publish }}" in text,
        f"{WORKFLOW}: dry-run gate must be the default path",
    )
    publish_job = text.index('\n  publish:\n    name: "@vivary/create trusted publish"')
    require(
        "id-token: write" not in text[:publish_job],
        f"{WORKFLOW}: OIDC permission must only exist on the publish job",
    )
    require(
        text.index("run: " + PUBLISH) > publish_job,
        f"{WORKFLOW}: npm publish must only run inside the publish job",
    )

    check_runtime_and_archive(text)
    # Shared source/inline/action identity contract, without executing the bootstrap.
    spec = importlib.util.spec_from_file_location("runner_workflow_contract", Path(__file__).with_name("check_ci_workflow.py"))
    contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract)
    contract.WORKFLOW = WORKFLOW
    contract.check_runner_action_bootstrap(text, ("verify", "publish"), npm=True)
    check_python_consumers(text, contract)
    print(f"{WORKFLOW}: trusted publish guard passed")


if __name__ == "__main__":
    main()
