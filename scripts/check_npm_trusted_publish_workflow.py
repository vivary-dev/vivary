from pathlib import Path
import importlib.util
import re
import shlex


WORKFLOW = Path(".github/workflows/npm-trusted-publish.yml")
SCRIPTS = Path(__file__).resolve().parent
RUNTIME_SECURITY = SCRIPTS.parent / "packages/workbench/bin/runtime-security.mjs"
ACTION_PINS = (
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


NODE_GUARD = "node packages/workbench/bin/runtime-security.mjs"
TOOLS = '"$RUNNER_TEMP/vivary-build-tools'
QUALIFIED_NPM = "12.2.1"
PUBLISH = (TOOLS + '/bin/node" packages/workbench/bin/runtime-security.mjs publish-npm "$RUNNER_TEMP/npm-candidate" '
           + TOOLS + '"')
# Both jobs run these exact reviewed steps. Text inside a heredoc, an uncalled
# function or a dead branch can match the old substring checks without running.
GUARD_STEP = (
    "      - name: Verify trusted publishing runtime\n"
    "        shell: bash\n"
    "        run: |\n"
    "          set -euo pipefail\n"
    "          " + NODE_GUARD + "\n"
    "          node --version\n"
)
# Both jobs provision the qualified client right after the Node guard. No other npm runs.
CLIENT_STEP = (
    "      - name: qualified npm client\n"
    "        # Every npm command in this job runs this client, as in ci.yml.\n"
    "        shell: bash\n"
    "        run: |\n"
    "          set -euo pipefail\n"
    "          python -I -B scripts/bootstrap_build_tools.py --root \"$RUNNER_TEMP/vivary-build-tools\"\n"
    "          test \"$(" + TOOLS + "/bin/npm\" --version)\" = \"" + QUALIFIED_NPM + "\"\n"
)
PACK = TOOLS + '/bin/npm" pack --pack-destination "$RUNNER_TEMP/npm-candidate"'
PACK_STEP = (
    "      - name: Verify npm package contents\n"
    "        working-directory: packages/create-vivary/npm\n"
    "        run: |\n"
    "          mkdir -p \"$RUNNER_TEMP/npm-candidate\"\n"
    "          " + PACK + "\n"
    "          python ../../../scripts/check_release_artifacts.py --repository ../../.. --artifacts \"$RUNNER_TEMP/npm-candidate\" --scope npm\n"
)


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


def npm_pins() -> dict:
    spec = importlib.util.spec_from_file_location("bootstrap_build_tools", SCRIPTS / "bootstrap_build_tools.py")
    tools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tools)
    return {name: version for name, version, _ in tools.NPM_PINS}


def check_qualified_client(runtime_source: str, pins: dict) -> None:
    """The workflow step, the publisher and the provisioner name one client."""
    match = re.search(r'(?m)^export const QUALIFIED_NPM = Object\.freeze\(\{ npm: "([^"]+)", undici: "([^"]+)", '
                      r'"ip-address": "([^"]+)" \}\);$', runtime_source)
    require(match is not None, f"{RUNTIME_SECURITY.name}: missing the qualified npm client pins")
    publisher = dict(zip(("npm", "undici", "ip-address"), match.groups()))
    require(publisher == pins and pins.get("npm") == QUALIFIED_NPM,
            f"qualified npm pins differ: workflow npm {QUALIFIED_NPM}, publisher {publisher}, bootstrap_build_tools {pins}")


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
        require(guard.rstrip("\n") == GUARD_STEP.rstrip("\n"), f"{name} runtime guard must be exactly the reviewed step")
        require(not re.search(r"(?m)^\s*(?:-\s+)?(?:run:\s*)?['\"]?(?:npm|npx|corepack)\s", job),
                f"{name} must run npm only through the qualified client")
        clients = [i for i, step in enumerate(steps) if "scripts/bootstrap_build_tools.py" in step or "vivary-build-tools/bin/npm" in step]
        require(clients and clients[0] == guards[0] + 1 and steps[clients[0]].rstrip("\n") == CLIENT_STEP.rstrip("\n"),
                f"{name} must provision the qualified npm client right after the Node guard")
        packs = [i for i, step in enumerate(steps) if PACK in step]
        require(len(packs) == 1 and packs[0] > clients[0] and clients[1:] == packs,
                f"{name} must pack with the qualified client after provisioning it")
        pack = steps[packs[0]]
        require(not re.search(r"(?m)^\s+(?:if|continue-on-error):", pack) and not shell_masks_failure(pack),
                f"{name} archive validation cannot be skipped or ignored")
        require('--artifacts "$RUNNER_TEMP/npm-candidate" --scope npm' in pack, f"{name} must validate its exact archive")
        # Only the step name differs between the two jobs.
        expected = PACK_STEP if name == "verify" else PACK_STEP.replace("- name: Verify npm", "- name: Re-verify npm", 1)
        require(pack.rstrip("\n") == expected.rstrip("\n"), f"{name} archive validation must be exactly the reviewed step")
        if name == "publish":
            publishing = [i for i, step in enumerate(steps) if "publish-npm" in step]
            require(len(publishing) == 1 and publishing[0] > packs[0], "publication must follow archive validation")
            step = steps[publishing[0]]
            require(re.search(r"(?m)^        run: '" + re.escape(PUBLISH) + r"'\s*$", step) is not None,
                    "publish must recheck the qualified Node and client and publish only the checked candidate archive")
            require(not re.search(r"(?m)^\s+(?:if|continue-on-error|working-directory|env):", step),
                    "publication admission cannot be skipped or redirected")
    require(not re.search(r"(?m)^\s*(?:-\s+)?(?:run:\s*)?['\"]?npm publish(?:\s|$)", text), "raw npm publication is forbidden")


def check_python_consumers(text: str, contract) -> None:
    contract.check_python_runtime(text, names=("verify", "publish"))
    for name in ("verify", "publish"):
        steps = re.split(r"(?m)(?=^      - )", contract.job_block(text, name))[1:]
        guard = next(index for index, step in enumerate(steps)
                     if "name: actual Python runtime admission" in step)
        # Before the guard, only the runner admission, a checkout-only release checkout,
        # setup-python and the authenticated provisioner run. An exact inventory refuses any
        # other step, so Python spelled as an absolute path or through env cannot slip in.
        allowed = (contract.PIP_SETUP_STEP.rstrip("\n"), contract.PYTHON_PROVISIONING_STEP.rstrip("\n"))
        for index, step in enumerate(steps[:guard]):
            checkout = (step.startswith("      - name: Checkout release tag\n")
                        and "uses: actions/checkout@" in step and not re.search(r"(?m)^\s+(?:run|shell):", step))
            require(index == 0 or checkout or step.rstrip("\n") in allowed,
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
        "package-manager-cache: false",
        "Verify trusted publishing runtime",
        "scripts/bootstrap_build_tools.py",
        "packages/create-vivary/tests/test_create_vivary.py",
        "packages/create-vivary/tests/test_init_thin.py",
        "packages/create-vivary/tests/test_record_workflow.py",
        "packages/create-vivary/tests/test_adopt.py",
        "packages/create-vivary/tests/test_assets_parity.py",
        "packages/create-vivary/tests/test_npm_launcher.js",
        PACK,
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
        PACK,
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
    # The qualified client replaces the user and global npmrc that registry-url would write.
    require("registry-url:" not in text, f"{WORKFLOW}: registry-url configures an npm that no step runs")

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
        text.index("run: '" + PUBLISH) > publish_job,
        f"{WORKFLOW}: npm publish must only run inside the publish job",
    )

    check_runtime_and_archive(text)
    check_qualified_client(RUNTIME_SECURITY.read_text(encoding="utf-8"), npm_pins())
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
