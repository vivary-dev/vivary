import importlib.util
import re
from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")
REVIEW_WORKFLOW = Path(".github/workflows/review-gate.yml")
AUXILIARY_WORKFLOWS = ((Path(".github/workflows/steward.yml"), ("daily-health-check",)),
                       (Path(".github/workflows/track-stats.yml"), ("snapshot",)))
ARTIFACT_CHECKER = Path("scripts/check_release_artifacts.py")


def release_build_commands() -> tuple[str, ...]:
    """One admitted uv build per Python distribution the release checker verifies."""
    spec = importlib.util.spec_from_file_location("release_artifacts", ARTIFACT_CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return tuple(
        f'"$uv" build --out-dir "$artifacts" packages/{package}'
        for package, _ in module.PYTHON_CANDIDATES
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"{WORKFLOW}: {message}")


# The required review gate workflow must match this text exactly, so no extra step, job,
# trigger or condition can weaken it unnoticed. Change both together, with owner review.
CANONICAL_REVIEW_WORKFLOW = r'''name: review gate

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
      - __RUNNER_BOOTSTRAP__
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        if: ${{ steps.base.outputs.missing == 'true' && steps.runner_action_node.outcome == 'success' }}
        with:
          ref: 80370e094248c84c55da663d977efc7601d17e84
          path: bootstrap
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
        with:
          python-version: "3.12.15"
      - __PYTHON_PROVISIONING__
      - name: actual Python runtime admission
        shell: python -I -B {0}
        run: |
          """Admit the executing CI Python and its loaded OpenSSL before network use."""

          import json
          from pathlib import Path
          import re
          import ssl
          import sys


          PYTHON = (3, 12, 15, "final", 0)
          OPENSSL = ["OpenSSL", "3.5.9"]


          class PythonRuntimeRefusal(RuntimeError):
              pass


          def refuse(message):
              raise PythonRuntimeRefusal("Python runtime admission: " + message)


          def observed_runtime():
              # Emit only bounded runtime version facts, never exception text, paths,
              # environment values, or the remainder of an OpenSSL build description.
              implementation = getattr(getattr(sys, "implementation", None), "name", None)
              if type(implementation) is not str or implementation not in ("cpython", "pypy", "graalpy", "ironpython", "jython", "micropython"):
                  implementation = "unknown"
              version = getattr(sys, "version_info", ())
              version = version if isinstance(version, tuple) and len(version) == 5 else (None,) * 5
              numeric = lambda value: str(value) if type(value) is int and 0 <= value <= 9999 else "unknown"
              python = ".".join(numeric(value) for value in version[:3])
              release = version[3] if type(version[3]) is str and version[3] in ("alpha", "beta", "candidate", "final") else "unknown"
              description = getattr(ssl, "OPENSSL_VERSION", None)
              tokens = description.split()[:2] if type(description) is str and len(description) <= 256 else []
              openssl = "unknown"
              if (len(tokens) == 2 and tokens[0] in ("OpenSSL", "LibreSSL", "BoringSSL")
                      and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}(?:[a-z]|-(?:dev|alpha[0-9]{0,4}|beta[0-9]{0,4}|rc[0-9]{0,4}))?", tokens[1])):
                  openssl = " ".join(tokens)
              return (f"observedImplementation={implementation}, observedPython={python}, "
                      f"observedRelease={release}, observedSerial={numeric(version[4])}, observedOpenSSL={openssl}")


          def assert_python_runtime():
              # Read the current process, never caller-supplied version or environment facts.
              if not sys.flags.isolated or not sys.flags.dont_write_bytecode:
                  refuse("invoke this guard with Python -I -B")
              if sys.implementation.name != "cpython" or tuple(sys.version_info) != PYTHON:
                  refuse("the qualified CPython 3.12.15 final runtime is required")
              # Match the separately qualified build-tool baseline, including the library
              # actually loaded by ssl rather than an executable's declared dependency.
              if ssl.OPENSSL_VERSION.split()[:2] != OPENSSL:
                  refuse("the loaded OpenSSL library must be the qualified 3.5.9 release")
              executable = Path(sys.executable).resolve(strict=True)
              if not executable.is_file():
                  refuse("the executing Python must resolve to a regular file")
              return {"python": str(executable), "implementation": "CPython",
                      "version": "3.12.15", "openssl": ssl.OPENSSL_VERSION}


          def main():
              try:
                  if len(sys.argv) != 1:
                      refuse("this guard accepts no caller-supplied runtime facts or arguments")
                  print(json.dumps(assert_python_runtime(), sort_keys=True))
                  return 0
              except (RuntimeError, OSError, ValueError, TypeError, AttributeError) as error:
                  message = str(error) if type(error) is PythonRuntimeRefusal else "Python runtime admission: actual runtime evidence is unavailable"
                  print(message + " (" + observed_runtime() + ")", file=sys.stderr)
                  return 1


          if __name__ == "__main__":
              sys.exit(main())
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
'''


def check_review_workflow(text: str) -> None:
    """The required review gate workflow is exactly the reviewed canonical text."""
    if text != CANONICAL_REVIEW_WORKFLOW:
        raise SystemExit(f"{REVIEW_WORKFLOW}: must match the canonical required review gate workflow "
                         "in scripts/check_ci_workflow.py (pull requests only, base-revision or pinned bootstrap script, real wait)")
    check_runner_action_bootstrap(text, ("review-gate",), auxiliary=True)
    check_python_runtime(text, ("review-gate",), inline=True)


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
RUNNER_REPAIR = Path(__file__).resolve().with_name("bootstrap_runner_action_node.py")
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
    repair = RUNNER_REPAIR.read_text(encoding="utf-8")
    require(repair.endswith("\n") and "\r" not in repair, "canonical runner repair must use LF and a final newline")
    require("'''" not in source, "runner admission cannot close its inline source literal")
    body = ("import types\n\nRUNNER_ADMISSION_SOURCE = r'''" + source + "'''\n"
            "admission = types.ModuleType('runner_node_admission')\n"
            "exec(compile(RUNNER_ADMISSION_SOURCE, 'runner-node-admission.py', 'exec'), admission.__dict__)\n\n"
            + repair)
    return ("      - &" + BOOTSTRAP_ANCHOR + "\n"
            "        name: runner action Node admission\n"
            "        id: runner_action_node\n"
            "        shell: python -I -B {0}\n"
            "        run: |\n" + "".join("          " + line + "\n" if line else "\n" for line in body.splitlines()))


CANONICAL_REVIEW_WORKFLOW = CANONICAL_REVIEW_WORKFLOW.replace(
    "      - __RUNNER_BOOTSTRAP__\n", runner_bootstrap_step(), 1)

def check_runner_action_bootstrap(text: str, names: tuple[str, ...], npm=False, auxiliary=False) -> None:
    if auxiliary:
        require(not npm and names in (("review-gate",), ("daily-health-check",), ("snapshot",)),
                "auxiliary bootstrap requires an exact owned job inventory")
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
            # GitHub also accepts quoted, spaced, escaped and complex keys. Refuse them, so `uses`
            # and `if` cannot hide from the patterns below. Block-scalar content sits deeper.
            require(all(re.match(r"^        (?:#|[A-Za-z_][\w-]*:(?:[ \t]|$))", line)
                        for line in step.splitlines()[1:] if re.match(r"^        \S", line)),
                    name + " has a quoted or unsupported step key")
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
            conditions = re.findall(r"(?m)^(?:      - |        )if: (.+)$", step)
            if conditions:
                require(len(conditions) == 1, name + " has ambiguous action conditions")
                expression = conditions[0].removeprefix("${{").removesuffix("}}").strip()
                require("||" not in expression and "steps.runner_action_node.outcome == 'success'" in [part.strip() for part in expression.split("&&")],
                        name + " conditional action must require bootstrap success")
            total_uses += 1
    require(total_uses == len(re.findall(r"(?m)^\s*(?:-\s+)?(?:uses|'uses'|\"uses\")\s*:", jobs)),
            "unproved action outside an admitted step")
    if npm:
        publish = job_block(text, "publish").split("    steps:", 1)[0]
        require("    needs: verify\n" in publish and "    if: ${{ inputs.publish && needs.verify.result == 'success' }}" in publish,
                "npm publication requires explicit approval and successful verify dependency")
    elif not auxiliary:
        orientation = job_block(text, "orientation-proof")
        require("if: ${{ !cancelled() && steps.runner_action_node.outcome == 'success' }}" in orientation,
                "orientation upload must survive later failure only after bootstrap success")
        require("uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" in orientation,
                "orientation receipt upload must retain its exact no-pre action")


UV_LINUX_WHEEL = (
    "https://files.pythonhosted.org/packages/3a/ad/"
    "3c2a81d66d1839063662e5b6c0002ec31f8ee987dbc5295747627ca6160a/"
    "uv-0.13.5-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
    "#sha256=fa8d26e08e34c29c0c4e820cf3181757086d547240b4f4d31ff1d8bd810ca946"
)
UV_WINDOWS_WHEEL = (
    "https://files.pythonhosted.org/packages/32/ea/"
    "771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/"
    "uv-0.13.5-py3-none-win_amd64.whl"
    "#sha256=1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f"
)
UV_PIP_CONFIG_FILE = "${{ runner.os == 'Windows' && 'nul' || '/dev/null' }}"
UV_INSTALLS = {
    "test": 'python -I -m pip --use-deprecated=legacy-certs --isolated install --force-reinstall --no-deps --only-binary=:all: "' + UV_LINUX_WHEEL + '"',
    "orientation-proof": (
        'python -I -m pip --use-deprecated=legacy-certs --isolated install --force-reinstall --no-deps --only-binary=:all: "${{ '
        "runner.os == 'Linux' && '" + UV_LINUX_WHEEL
        + "' || runner.os == 'Windows' && '" + UV_WINDOWS_WHEEL + "' || '' }}\""
    ),
}
UV_JOBS = ("test", "orientation-proof")
UV_RUNTIME_COMMAND = "python -I -B scripts/check_uv_runtime.py"
UV_RUNTIME_STEP = (
    "      - name: actual uv runtime admission\n"
    f"        run: {UV_RUNTIME_COMMAND}\n"
)
UV_BUILD_ADMISSION = f'uv="$({UV_RUNTIME_COMMAND})" || exit $?'
UV_ORIENTATION_PROOF = (
    "      - name: run disposable orientation proof\n"
    "        run: python packages/create-vivary/tests/orientation_proof.py --receipt orientation-proof.json\n"
)


def _check_uv_inherited_controls(header: str, pad: str, owner: str) -> None:
    require(
        not re.search(rf"(?m)^{pad}(?:defaults|'defaults'|\"defaults\")[ \t]*:", header),
        owner + " uv acquisition must not inherit run defaults",
    )
    environments = list(re.finditer(
        rf"(?m)^{pad}(?:env|'env'|\"env\")[ \t]*:([^\n]*)$", header
    ))
    explicit = owner + " uv acquisition requires explicit inherited env mappings"
    require(len(environments) <= 1, explicit)
    if not environments:
        return
    environment = environments[0]
    require(re.fullmatch(r"[ \t]*(?:#.*)?", environment.group(1)) is not None, explicit)
    body = re.split(rf"(?m)^{pad}(?=[^\s#])", header[environment.end():], maxsplit=1)[0]
    require(not re.search(r"(?m)^[ \t]*(?:\{|\[|\*|&|\$\{\{)", body), explicit)
    require(not re.search(r"(?m)^[ \t]*(?:<<|'<<'|\"<<\")[ \t]*:", body), explicit)
    for key in ("PIP_DRY_RUN", "PIP_CONFIG_FILE"):
        require(
            not re.search(rf"(?mi)^[ \t]*(?:{key}|'{key}'|\"{key}\")[ \t]*:", body),
            owner + " uv acquisition must not inherit " + key,
        )


def check_uv_acquisition(text: str) -> None:
    _check_uv_inherited_controls(text.split("\njobs:\n", 1)[0], "", "workflow")
    acquisition = re.compile(
        r"\b(?:python(?:3)?\s+(?:-I\s+)?-m\s+pip|pip(?:3)?)\s+(?:--use-deprecated=legacy-certs\s+)?(?:--isolated\s+)?install\b[^\n]*\buv\b"
    )
    for name in UV_JOBS:
        job = job_block(text, name)
        _check_uv_inherited_controls(job.split("    steps:\n", 1)[0], "    ", f"{name} job")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        installs = [
            index for index, step in enumerate(steps)
            if acquisition.search(re.sub(r"(?m)^\s*#.*$", "", step))
        ]
        command = UV_INSTALLS[name]
        contract = f"{name} job must acquire uv==0.13.5 with {command}"
        require(len(installs) == 1, contract + " exactly once in its own job")
        index = installs[0]
        step = steps[index]
        require(
            re.fullmatch(
                r"      - name: [^\n]+\n        env:\n          PIP_CONFIG_FILE: "
                + re.escape(UV_PIP_CONFIG_FILE) + r"\n        run: \|\n          "
                + re.escape(command) + r"\n[ \t\n]*",
                step,
            ) is not None,
            contract + " with its exact null pip config as its only command in an unconditional, blocking step",
        )
        require(
            "continue-on-error:" not in job.split("    steps:", 1)[0],
            contract + " without job-level continue-on-error",
        )
        runtime_contract = f"{name} job must admit actual uv 0.13.5 immediately after acquisition and at use"
        require(index + 1 < len(steps) and steps[index + 1] == UV_RUNTIME_STEP,
                runtime_contract)
        if name == "test":
            builds = [candidate for candidate in steps if '"$uv" build ' in candidate]
            require(len(builds) == 1 and builds[0].count(UV_BUILD_ADMISSION) == 1,
                    runtime_contract)
            build_sequence = "\n          ".join((UV_BUILD_ADMISSION, *release_build_commands()))
            require("\n          " + build_sequence + "\n" in builds[0], runtime_contract)
            require(not re.search(r"(?m)^        (?:if|continue-on-error|env|working-directory):", builds[0]),
                    runtime_contract)
            require(not re.search(r"(?m)^\s*uv build ", job), runtime_contract)
        else:
            proofs = [position for position, candidate in enumerate(steps)
                      if "packages/create-vivary/tests/orientation_proof.py --receipt" in candidate]
            require(len(proofs) == 1 and proofs[0] > 0
                    and steps[proofs[0]] == UV_ORIENTATION_PROOF
                    and steps[proofs[0] - 1] == UV_RUNTIME_STEP,
                    runtime_contract)
        consumers = (
            '"$uv" build ',
            "python packages/tropo/tests/test_tropo.py",
            "python packages/create-vivary/tests/",
        )
        require(
            all(index < position for position, candidate in enumerate(steps)
                if any(consumer in candidate for consumer in consumers)),
            contract + " before its build and proof commands",
        )


PIP_JOBS = ("test", "workbench", "workbench-maintained", "governed-platform-proof", "orientation-proof")
PIP_BOOTSTRAP_STEP = ('      - name: verified pip runtime provisioning\n'
 '        shell: python -I -B {0}\n'
 '        run: |\n'
 '          import runpy\n'
 '          runpy.run_path("scripts/bootstrap_ci_pip.py", run_name="__main__")\n')
PIP_SETUP_STEP = ('      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97\n'
 '        with:\n'
 '          python-version: "3.12.15"\n')
PYTHON_JOBS = (*PIP_JOBS, "review", "site")
PYTHON_PROVISIONING_SOURCE = Path(__file__).resolve().with_name("bootstrap_ci_python.py")
PYTHON_PROVISIONING_STEP = (
    "      - name: verified Python runtime provisioning\n"
    "        shell: python -I -B {0}\n"
    "        run: |\n"
    "          import runpy\n"
    '          runpy.run_path("scripts/bootstrap_ci_python.py", run_name="__main__")\n'
)
WINDOWS_PYTHON_PROVISIONING_STEP = (
    "      - name: verified Windows Python runtime provisioning\n"
    "        shell: pwsh\n"
    "        run: ./scripts/bootstrap_ci_python_windows.ps1\n"
)


def python_admission_prefix(name, inline=False):
    guard = python_runtime_step(inline)
    if name == "governed-platform-proof":
        return [WINDOWS_PYTHON_PROVISIONING_STEP, guard]
    if name == "orientation-proof":
        def when(step, condition):
            first, rest = step.split("\n", 1)
            return first + "\n        if: " + condition + "\n" + rest
        return [when(PIP_SETUP_STEP, "${{ runner.os != 'Windows' && steps.runner_action_node.outcome == 'success' }}"),
                when(PYTHON_PROVISIONING_STEP, "runner.os != 'Windows'"),
                when(WINDOWS_PYTHON_PROVISIONING_STEP, "runner.os == 'Windows'"), guard]
    return [PIP_SETUP_STEP, python_provisioning_step(inline), guard]


def python_provisioning_step(inline=False) -> str:
    if not inline:
        return PYTHON_PROVISIONING_STEP
    policy = PYTHON_PROVISIONING_SOURCE.with_name("certifi_bundle.py").read_text(encoding="utf-8")
    source = PYTHON_PROVISIONING_SOURCE.read_text(encoding="utf-8")
    require(all(item.endswith("\n") and "\r" not in item for item in (policy, source))
            and "'''" not in policy,
            "canonical Python provisioning requires LF and a final newline")
    body = ("CERTIFI_POLICY_SOURCE = r'''" + policy + "'''\n"
            "CA_POLICY = {}\n"
            "exec(compile(CERTIFI_POLICY_SOURCE, 'certifi-policy.py', 'exec'), CA_POLICY)\n\n" + source)
    return ("      - name: verified Python runtime provisioning\n"
            "        shell: python -I -B {0}\n"
            "        run: |\n"
            + "".join("          " + line + "\n" if line else "\n" for line in body.splitlines()))


CANONICAL_REVIEW_WORKFLOW = CANONICAL_REVIEW_WORKFLOW.replace(
    "      - __PYTHON_PROVISIONING__\n", python_provisioning_step(inline=True), 1)

PYTHON_RUNTIME_SOURCE = Path(__file__).resolve().with_name("check_python_runtime.py")
PYTHON_RUNTIME_STEP = (
    "      - name: actual Python runtime admission\n"
    "        shell: python -I -B {0}\n"
    "        run: |\n"
    "          import runpy\n"
    '          runpy.run_path("scripts/check_python_runtime.py", run_name="__main__")\n'
)


def python_runtime_step(inline=False) -> str:
    if not inline:
        return PYTHON_RUNTIME_STEP
    # The review gate checks out only the base and pinned fallback gate scripts.
    # Bind its inline admission to this helper without adding a head checkout.
    source = PYTHON_RUNTIME_SOURCE.read_text(encoding="utf-8")
    require(source.endswith("\n") and "\r" not in source,
            "canonical Python runtime guard requires LF and a final newline")
    return ("      - name: actual Python runtime admission\n"
            "        shell: python -I -B {0}\n"
            "        run: |\n"
            + "".join("          " + line + "\n" if line else "\n" for line in source.splitlines()))


def check_python_runtime(text: str, names=PYTHON_JOBS, inline=False) -> None:
    for name in names:
        steps = re.split(r"(?m)(?=^      - )", job_block(text, name))[1:]
        setups = [index for index, step in enumerate(steps) if "uses: actions/setup-python@" in step]
        guards = [index for index, step in enumerate(steps) if "name: actual Python runtime admission" in step]
        contract = name + " requires exact Python selection and actual Python/OpenSSL admission before use"
        require(len(setups) == (0 if name == "governed-platform-proof" else 1)
                and len(guards) == 1, contract)
        guard = guards[0]
        prefix = python_admission_prefix(name, inline)
        first = guard - len(prefix) + 1
        require(first >= 0 and [step.rstrip("\n") for step in steps[first:guard + 1]]
                == [step.rstrip("\n") for step in prefix], contract)
        require(sum("name: verified Python runtime provisioning" in step
                    or "name: verified Windows Python runtime provisioning" in step for step in steps)
                == (2 if name == "orientation-proof" else 1), contract)
        require(not re.search(r"scripts/(?:bootstrap_ci_pip|check_pip_runtime|bootstrap_build_tools|build_go_tools)\.py|\s-m\s+pip\b",
                              "".join(steps[:guard])), contract)


PIP_VENV_BLOCKS = {'test': ('          python -m venv --without-pip "$smoke/venv"\n'
          '          venv_python="$smoke/venv/bin/python"\n'
          '          export PATH="$smoke/venv/bin:$PATH"\n'
          '          unset PYTHONPATH\n'
          '          "$venv_python" -I -B scripts/check_python_runtime.py || exit $?\n'
          '          "$venv_python" -I -B scripts/bootstrap_ci_pip.py || exit $?\n'
          '          "$venv_python" -I -B scripts/check_pip_runtime.py || exit $?\n'
          '          "$venv_python" -I -m pip --use-deprecated=legacy-certs install --no-index --find-links "$wheelhouse" '
          'vivary\n',
          '          python -m venv --without-pip "$mcp_venv"\n'
          '          mcp_python="$mcp_venv/bin/python"\n'
          '          "$mcp_python" -I -B scripts/check_python_runtime.py || exit $?\n'
          '          "$mcp_python" -I -B scripts/bootstrap_ci_pip.py || exit $?\n'
          '          "$mcp_python" -I -B scripts/check_pip_runtime.py || exit $?\n'
          '          "$mcp_python" -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n'),
 'governed-platform-proof': ('          python -m venv --without-pip (Join-Path $smoke "venv")\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }\n'
                             '          $scripts = Join-Path $smoke "venv\\Scripts"\n'
                             '          $python = Join-Path $scripts "python.exe"\n'
                             '          & $python -I -B scripts/check_python_runtime.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "Python runtime admission failed" }\n'
                             '          & $python -I -B scripts/bootstrap_ci_pip.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "pip provisioning failed" '
                             '}\n'
                             '          & $python -I -B scripts/check_pip_runtime.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "pip runtime admission '
                             'failed" }\n'
                             '          & $python -I -m pip --use-deprecated=legacy-certs install --no-index --find-links '
                             '$wheelhouse vivary\n',
                             '          python -m venv --without-pip $mcpVenv\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "MCP venv creation '
                             'failed" }\n'
                             '          $mcpScripts = Join-Path $mcpVenv "Scripts"\n'
                             '          $mcpPython = Join-Path $mcpScripts "python.exe"\n'
                             '          & $mcpPython -I -B scripts/check_python_runtime.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "MCP Python runtime admission failed" }\n'
                             '          & $mcpPython -I -B scripts/bootstrap_ci_pip.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "MCP pip provisioning '
                             'failed" }\n'
                             '          & $mcpPython -I -B scripts/check_pip_runtime.py\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "MCP pip runtime '
                             'admission failed" }\n'
                             '          & $mcpPython -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n'
                             '          if ($LASTEXITCODE -ne 0) { throw "MCP dependency install '
                             'failed" }\n')}
PIP_RUNTIME_STEP = (
    "      - name: actual pip runtime admission\n"
    "        shell: python -I -B {0}\n"
    "        run: |\n"
    "          import runpy\n"
    '          runpy.run_path("scripts/check_pip_runtime.py", run_name="__main__")\n'
)
PIP_MCP_BLOCKS = {'test': '          mcp_python="$mcp_venv/bin/python"\n'
         '          "$mcp_python" -I -B scripts/check_python_runtime.py || exit $?\n'
         '          "$mcp_python" -I -B scripts/bootstrap_ci_pip.py || exit $?\n'
         '          "$mcp_python" -I -B scripts/check_pip_runtime.py || exit $?\n'
         '          "$mcp_python" -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n',
 'governed-platform-proof': '          $mcpPython = Join-Path $mcpScripts "python.exe"\n'
                            '          & $mcpPython -I -B scripts/check_python_runtime.py\n'
                            '          if ($LASTEXITCODE -ne 0) { throw "MCP Python runtime admission failed" }\n'
                            '          & $mcpPython -I -B scripts/bootstrap_ci_pip.py\n'
                            '          if ($LASTEXITCODE -ne 0) { throw "MCP pip provisioning '
                            'failed" }\n'
                            '          & $mcpPython -I -B scripts/check_pip_runtime.py\n'
                            '          if ($LASTEXITCODE -ne 0) { throw "MCP pip runtime admission '
                            'failed" }\n'
                            '          & $mcpPython -I -m pip --use-deprecated=legacy-certs install "mcp==2.2.0"\n'
                            '          if ($LASTEXITCODE -ne 0) { throw "MCP dependency install '
                            'failed" }\n'}


def check_pip_runtime(text: str) -> None:
    try:
        check_python_runtime(text, names=PIP_JOBS)
    except SystemExit as error:
        raise SystemExit("pip provisioning prerequisite: " + str(error)) from error
    for name in PIP_JOBS:
        job = job_block(text, name)
        header = job.split("    steps:\n", 1)[0]
        require("continue-on-error:" not in header, f"{name} cannot ignore job failure")
        if name not in UV_JOBS:
            require(not re.search(r"(?m)^    (?:defaults|'defaults'|\"defaults\"):", header),
                    f"{name} pip runtime admission cannot inherit run defaults")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        python_guards = [index for index, step in enumerate(steps) if "name: actual Python runtime admission" in step]
        guards = [index for index, step in enumerate(steps) if "name: actual pip runtime admission" in step]
        require(len(python_guards) == len(guards) == 1,
                f"{name} needs exactly one actual Python and pip runtime admission")
        python_guard, guard = python_guards[0], guards[0]
        require(guard == python_guard + 2
                and steps[python_guard + 1].rstrip("\n") == PIP_BOOTSTRAP_STEP.rstrip("\n")
                and steps[guard].rstrip("\n") == PIP_RUNTIME_STEP.rstrip("\n"),
                f"{name} verified pip provisioning and admission must immediately follow actual Python admission unconditionally")
        require(not re.search(r"\b(?:pip|pip3)\b", "".join(steps[:python_guard])),
                f"{name} must admit the selected pip before package operations")
        if name in PIP_VENV_BLOCKS:
            expected_venvs = PIP_VENV_BLOCKS[name]
            require(len(re.findall(r"(?m)^          python -m venv ", job)) == len(expected_venvs),
                    f"{name} must bind every fresh venv to pip provisioning")
            for required in expected_venvs:
                require(job.count(required) == 1,
                        f"{name} fresh venv requires --without-pip, exact-target provisioning and runtime admission before pip")
                install = next(line.strip() for line in required.splitlines() if " -I -m pip --use-deprecated=legacy-certs install " in line)
                prefix = install.split(" install ", 1)[0] + " "
                require(not any(line.strip().startswith(prefix) for line in job[:job.index(required)].splitlines()),
                        f"{name} fresh venv pip cannot run before its provisioning and admission")
                owner = next(step for step in steps if required in step)
                require(not re.search(r"(?m)^        (?:if|continue-on-error|working-directory|env):", owner),
                        f"{name} fresh venv pip provisioning cannot be skipped, redirected or ignored")
        if name in PIP_MCP_BLOCKS:
            block = PIP_MCP_BLOCKS[name]
            require(job.count(block) == 1,
                    f"{name} must admit its exact MCP venv interpreter before its first network pip install")
            require(not re.search(r'(?m)^\s*(?:"\$mcp_python"|& \$mcpPython)\s+(?:-I\s+)?-m\s+pip\b',
                                  job[:job.index(block)]),
                    f"{name} MCP pip cannot run before its venv admission")
            network_install = next(line.strip() for line in block.splitlines() if " -I -m pip --use-deprecated=legacy-certs install " in line)
            mcp_pip = network_install.split(" install ", 1)[0] + " "
            wheelhouse = '\"$wheelhouse\"' if name == "test" else "$wheelhouse"
            offline_install = mcp_pip + "install --no-index --find-links " + wheelhouse + " vivary-mcp create-vivary"
            network_commands = [
                line.strip() for line in job.splitlines()
                if line.strip().startswith(mcp_pip)
                and line.strip() not in (offline_install, mcp_pip + "check")
            ]
            require(network_commands == [network_install],
                    f"{name} MCP pip may network only in its canonical admitted install block")
            owner = next(step for step in steps if block in step)
            require(not re.search(r"(?m)^        (?:if|continue-on-error|working-directory|env):", owner),
                    f"{name} MCP pip admission cannot be skipped, redirected or ignored")
            shell = "bash" if name == "test" else "pwsh"
            require(f"        shell: {shell}\n" in owner,
                    f"{name} MCP pip admission requires its explicit platform shell")


def check_pip_commands(text: str) -> None:
    require(re.search(r"(?m)^  PIP_USE_DEPRECATED: legacy-certs$", text.split("\njobs:\n", 1)[0])
            and text.count("PIP_USE_DEPRECATED") == 1,
            "pip build-isolation children must inherit the qualified certifi-only trust policy")
    for name in PIP_JOBS:
        prefixes = ("python -I -m pip --use-deprecated=legacy-certs ",)
        if name == "test":
            prefixes += ('"$venv_python" -I -m pip --use-deprecated=legacy-certs ', '"$mcp_python" -I -m pip --use-deprecated=legacy-certs ')
        elif name == "governed-platform-proof":
            prefixes += ("& $python -I -m pip --use-deprecated=legacy-certs ", "& $mcpPython -I -m pip --use-deprecated=legacy-certs ")
        for step in re.split(r"(?m)(?=^      - )", job_block(text, name))[1:]:
            run = re.search(r"(?m)^(?:      - |        )run: ([^\n]*)$", step)
            if run is None:
                continue
            commands = run.group(1) + "\n" + step[run.end():]
            pip_commands = False
            for line in commands.splitlines():
                command = line.strip()
                if not re.search(r"(?:\s-m\s+pip\b|(?:^|[;&|]\s*)pip(?:3)?\s+(?:install|wheel|download)\b)", command):
                    continue
                pip_commands = True
                require(command.startswith(prefixes),
                        f"{name} pip commands must use the admitted interpreter and Python -I")
                require(not re.search(r"\binstall\s+(?:-\S+\s+)*pip(?:[<=>!~\[]|\s|$)", command),
                        f"{name} cannot use a network pip self-upgrade to clear runtime admission")
                if command.startswith(('"$venv_python"', "& $python ")):
                    require(" -m pip --use-deprecated=legacy-certs check" in command or " install --no-index " in command,
                            f"{name} unadmitted offline venv pip cannot access the network")
            if pip_commands:
                require(not re.search(r"(?m)^        (?:if|continue-on-error|working-directory):", step),
                        f"{name} pip commands cannot be skipped, redirected or ignored")
                if not any(command in step for command in UV_INSTALLS.values()):
                    require(not re.search(r"(?m)^        env:", step),
                            f"{name} pip commands cannot override their admitted interpreter environment")


SITE_JOB_HEADER = (
    "  site:\n"
    "    name: site build\n"
    "    needs: changes\n"
    "    if: needs.changes.outputs.site == 'true'\n"
    "    runs-on: ubuntu-latest\n"
    "    timeout-minutes: 10\n"
)
SITE_TOOLS_STEP = (
    '      - name: qualified site build tools\n'
    '        run: |\n'
    '          python -I -B scripts/bootstrap_build_tools.py --root "$RUNNER_TEMP/vivary-build-tools" || exit $?\n'
    '          python -I -B scripts/build_go_tools.py --root "$RUNNER_TEMP/vivary-build-tools" || exit $?\n'
    '          printf \'ESBUILD_BINARY_PATH=%s/vivary-build-tools/esbuild-0.28.2-go1.26.10\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"\n'
)
SITE_DEPENDENCY_STEP = (
    "      - name: known site dependency admission\n"
    "        run: python -I -B scripts/check_site_dependencies.py\n"
)
SITE_INSTALLED_DEPENDENCY_STEP = (
    "      - name: installed site dependency admission\n"
    "        run: python -I -B scripts/check_site_dependencies.py --installed\n"
)
SITE_BUILD_STEP = (
    "      - name: build (re-syncs docs, then astro build)\n"
    '        run: |\n          "$RUNNER_TEMP/vivary-build-tools/bin/npm" run sync-docs || exit $?\n          "$RUNNER_TEMP/vivary-build-tools/bin/npm" run build\n'
    "        working-directory: site\n"
)


def check_site_dependencies(text: str) -> None:
    job = job_block(text, "site")
    header, steps_key, body = job.partition("    steps:\n")
    contract = "site known dependency admission must block before install and admit installed packages before audit and build"
    require(steps_key and header == SITE_JOB_HEADER, contract)
    require(not re.search(r"(?m)^    [^\s#]", body),
            "site cannot add job fields after its canonical header and steps key")
    steps = re.split(r"(?m)(?=^      - )", job)[1:]
    guard = [index for index, step in enumerate(steps) if "scripts/check_site_dependencies.py" in step]
    tools = [index for index, step in enumerate(steps) if "scripts/bootstrap_build_tools.py" in step]
    node = [index for index, step in enumerate(steps) if NODE_GUARD in step]
    installs = [index for index, step in enumerate(steps) if '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" ci --ignore-scripts\'\n' in step]
    audits = [index for index, step in enumerate(steps) if '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" audit --audit-level=high\'\n' in step]
    builds = [index for index, step in enumerate(steps) if '        run: |\n          "$RUNNER_TEMP/vivary-build-tools/bin/npm" run sync-docs || exit $?\n          "$RUNNER_TEMP/vivary-build-tools/bin/npm" run build\n' in step]
    require(len(guard) == 2 and len(installs) == len(audits) == len(builds) == 1, contract)
    require(len(tools) == len(node) == 1 and tools[0] == node[0] + 1 and tools[0] + 1 == guard[0], contract)
    require(steps[tools[0]].rstrip("\n") == SITE_TOOLS_STEP.rstrip("\n"), contract)
    require(not any(re.search(r"(?m)^\s+cache(?:-dependency-path)?:", step)
                    for step in steps[:tools[0]]), contract + ": setup-node cache can invoke unqualified npm")
    require(steps[guard[0]].rstrip("\n") == SITE_DEPENDENCY_STEP.rstrip("\n"), contract)
    require(steps[guard[1]].rstrip("\n") == SITE_INSTALLED_DEPENDENCY_STEP.rstrip("\n"), contract)
    require(guard[0] + 1 == installs[0] and installs[0] + 1 == guard[1] < audits[0] < builds[0], contract)
    require(steps[builds[0]].rstrip("\n") == SITE_BUILD_STEP.rstrip("\n"), contract)
    site_tests = [index for index, step in enumerate(steps) if "run test:site" in step]
    require(len(site_tests) == 1 and steps[site_tests[0]].rstrip("\n") == SITE_TEST_STEP.rstrip("\n")
            and guard[1] < site_tests[0] < builds[0], contract + ": site behavior tests must run before the build")


SITE_TEST_STEP = (
    "      - name: site behavior and information architecture tests\n"
    "        run: '\"$RUNNER_TEMP/vivary-build-tools/bin/npm\" run test:site'\n"
    "        working-directory: site\n"
)

WORKBENCH_TOOLS_STEP = (
    '      - name: qualified workbench build tools\n'
    '        shell: bash\n'
    '        run: |\n'
    '          python -I -B scripts/bootstrap_build_tools.py --root "$RUNNER_TEMP/vivary-build-tools" || exit $?\n'
    '          python -I -B scripts/build_go_tools.py --root "$RUNNER_TEMP/vivary-build-tools" --typescript || exit $?\n'
    '          printf \'%s/vivary-build-tools/bin\\n\' "$RUNNER_TEMP" >> "$GITHUB_PATH"\n'
    '          printf \'ESBUILD_BINARY_PATH=%s/vivary-build-tools/esbuild-0.28.2-go1.26.10\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"\n'
)

WORKBENCH_INSTALL_STEP = (
    '      - name: install workbench dependencies\n'
    '        shell: bash\n'
    '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/pnpm" --dir packages/workbench install --frozen-lockfile --ignore-scripts\'\n'
)

WORKBENCH_DEPENDENCY_STEP = (
    '      - name: known workbench dependency admission\n'
    '        shell: bash\n'
    '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/node" --test --test-name-pattern="locked|archive|SemVer|TipTap|xlsx" packages/workbench/tests/dependency-advisories.test.mjs\'\n'
)

WINDOWS_WORKBENCH_TOOLS_STEP = (
    '      - name: qualified workbench build tools\n'
    '        shell: pwsh\n'
    '        run: |\n'
    '          python -I -B scripts/bootstrap_build_tools.py --root "$env:RUNNER_TEMP/vivary-build-tools"\n'
    '          if ($LASTEXITCODE -ne 0) { throw "build client provisioning failed" }\n'
    '          python -I -B scripts/build_go_tools.py --root "$env:RUNNER_TEMP/vivary-build-tools" --typescript\n'
    '          if ($LASTEXITCODE -ne 0) { throw "compiler provisioning failed" }\n'
    '          "$env:RUNNER_TEMP/vivary-build-tools/bin" | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append\n'
    '          "ESBUILD_BINARY_PATH=$env:RUNNER_TEMP/vivary-build-tools/esbuild-0.28.2-go1.26.10.exe" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append\n'
)

WINDOWS_WORKBENCH_INSTALL_STEP = (
    '      - name: install workbench dependencies\n'
    '        shell: pwsh\n'
    '        run: |\n'
    '          & "$env:RUNNER_TEMP/vivary-build-tools/bin/pnpm.cmd" --dir packages/workbench install --frozen-lockfile --ignore-scripts\n'
    '          if ($LASTEXITCODE -ne 0) { throw "workbench dependency install failed" }\n'
)

WINDOWS_WORKBENCH_DEPENDENCY_STEP = (
    '      - name: known workbench dependency admission\n'
    '        shell: pwsh\n'
    '        run: |\n'
    '          & "$env:RUNNER_TEMP/vivary-build-tools/bin/node.cmd" --% --test --test-name-pattern="locked|archive|SemVer|TipTap|xlsx" packages/workbench/tests/dependency-advisories.test.mjs\n'
    '          if ($LASTEXITCODE -ne 0) { throw "workbench dependency admission failed" }\n'
)

WORKBENCH_TYPECHECK = (
    '          pnpm --dir packages/workbench exec react-router typegen\n'
    '          "$RUNNER_TEMP/vivary-build-tools/typescript-7.0.2-go1.26.10/tsc" --noEmit --project packages/workbench/tsconfig.json\n'
)


TEST_CLIENTS_STEP = (
    '      - name: qualified release package clients\n'
    '        shell: bash\n'
    '        run: |\n'
    '          python -I -B scripts/bootstrap_build_tools.py --root "$RUNNER_TEMP/vivary-build-tools" || exit $?\n'
    '          printf \'%s/vivary-build-tools/bin\\n\' "$RUNNER_TEMP" >> "$GITHUB_PATH"\n'
)
TEST_PACK_COMMAND = '"$RUNNER_TEMP/vivary-build-tools/bin/npm" pack packages/create-vivary/npm --pack-destination "$artifacts"'
REPAIR_TEST_STEP = (
    '      - name: runner action Node repair tests\n'
    '        env:\n'
    '          VIVARY_TEST_NODE: ${{ runner.temp }}/vivary-build-tools/node/bin/node\n'
    '        run: python -I -B scripts/tests/test_bootstrap_runner_action_node.py\n'
)
BUILD_TEST_STEP = (
    '      - name: isolated build tool tests\n'
    '        env:\n'
    '          VIVARY_TEST_NODE: ${{ runner.temp }}/vivary-build-tools/node/bin/node\n'
    '          VIVARY_TEST_TOOL_ROOT: ${{ runner.temp }}/vivary-build-tools\n'
    '        run: python -I -B scripts/tests/test_build_tools.py\n'
)


def check_release_package_clients(text: str) -> None:
    job = job_block(text, "test")
    steps = re.split(r"(?m)(?=^      - )", job)[1:]
    tools = [i for i, step in enumerate(steps) if "scripts/bootstrap_build_tools.py" in step]
    node = [i for i, step in enumerate(steps) if NODE_GUARD in step]
    pack = [i for i, step in enumerate(steps) if TEST_PACK_COMMAND in step]
    contract = "test must provision isolated package clients before packing release artifacts"
    require(len(tools) == len(node) == len(pack) == 1 and node[0] < tools[0] < pack[0], contract)
    require(steps[tools[0]].rstrip("\n") == TEST_CLIENTS_STEP.rstrip("\n"), contract)
    require(not re.search(r"(?m)^\s*(?:run:\s*)?npm\s", job), contract)


def check_workbench_build_tools(text: str) -> None:
    for name in ("workbench", "workbench-maintained", "governed-platform-proof"):
        job = job_block(text, name)
        contract = f"{name} must provision isolated clients and rebuilt Go compilers before dependencies"
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        tools = [i for i, step in enumerate(steps) if "scripts/bootstrap_build_tools.py" in step]
        installs = [i for i, step in enumerate(steps) if "- name: install workbench dependencies" in step]
        dependencies = [i for i, step in enumerate(steps) if "- name: known workbench dependency admission" in step]
        node = [i for i, step in enumerate(steps) if NODE_GUARD in step]
        require(len(tools) == len(installs) == len(node) == len(dependencies) == 1, contract)
        require(node[0] < tools[0] and tools[0] + 1 == dependencies[0] and dependencies[0] + 1 == installs[0], contract)
        windows = name == "governed-platform-proof"
        expected = (WINDOWS_WORKBENCH_TOOLS_STEP, WINDOWS_WORKBENCH_DEPENDENCY_STEP, WINDOWS_WORKBENCH_INSTALL_STEP) if windows else (WORKBENCH_TOOLS_STEP, WORKBENCH_DEPENDENCY_STEP, WORKBENCH_INSTALL_STEP)
        require(all(steps[index].rstrip("\n") == value.rstrip("\n") for index, value in zip((tools[0], dependencies[0], installs[0]), expected)), contract)
        require(not re.search(r"(?m)^\s*(?:run:\s*)?(?:npm|pnpm|corepack)\s", "".join(steps[:tools[0]])), contract)
        require("npm install --global" not in job, contract)
    workbench = job_block(text, "workbench")
    require(WORKBENCH_TYPECHECK in workbench,
            "workbench must retain route type generation and use the rebuilt TypeScript compiler")
    require("pnpm --dir packages/workbench typecheck" not in workbench,
            "workbench cannot execute the package's unqualified TypeScript binary")


def check_runtime_security(text: str) -> None:
    for name in NODE_JOBS:
        job = job_block(text, name)
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        setups = [i for i, step in enumerate(steps) if "uses: actions/setup-node@" in step]
        guards = [i for i, step in enumerate(steps) if NODE_GUARD in step]
        require(len(setups) == len(guards) == 1, f"{name} needs exactly one actual Node guard and setup")
        require(guards[0] == setups[0] + 1, f"{name} Node guard must immediately follow setup-node")
        require('          node-version: "24.22.1"\n' in steps[setups[0]],
                f"{name} must select the fixed admitted Node 24.22.1 runtime")
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
    check_pip_runtime(text)
    check_python_runtime(text)
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

    runner_install = "python -I -m pip --use-deprecated=legacy-certs install pytest packaging"
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
    site_install = '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" ci --ignore-scripts\'\n        working-directory: site'
    site_audit = (
        '        run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" audit --audit-level=high\'\n'
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
        artifact_test,
        *release_build_commands(),
        TEST_PACK_COMMAND,
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

    check_site_dependencies(text)
    check_runtime_security(text)
    check_workbench_build_tools(text)
    check_release_package_clients(text)
    check_uv_acquisition(text)
    check_pip_commands(text)
    require("python -I -B scripts/tests/test_pip_runtime.py" in test_job,
            "tests job must run pip runtime admission regressions")
    require("python -I -B scripts/tests/test_bootstrap_ci_python.py" in test_job,
            "tests job must run verified Python provisioning regressions")
    require("python -I -B scripts/tests/test_ci_python_windows_bootstrap.py" in test_job,
            "tests job must run native Windows Python bootstrap regressions")
    require("python -I -B scripts/tests/test_python_runtime.py" in test_job,
            "tests job must run Python runtime admission regressions")
    require("python -I -B scripts/tests/test_bootstrap_ci_pip.py" in test_job,
            "tests job must run verified pip provisioning regressions")
    require("python -I -B scripts/tests/test_certifi_bundle.py" in test_job,
            "tests job must run certificate overlay preservation regressions")
    require("python -I -B scripts/tests/test_site_dependencies.py" in test_job,
            "tests job must run known site dependency admission regressions")
    require(test_job.count(BUILD_TEST_STEP) == 1,
            "tests job must run isolated build tool regressions")
    check_runner_action_bootstrap(text, CI_JOBS)
    require("python -I -B scripts/tests/test_runner_action_node.py" in test_job,
            "tests job must run the runner action bootstrap regressions")
    require(test_job.count(REPAIR_TEST_STEP) == 1,
            "tests job must run the runner action repair regressions")
    check_review_workflow(REVIEW_WORKFLOW.read_text(encoding="utf-8"))
    for path, names in AUXILIARY_WORKFLOWS:
        check_runner_action_bootstrap(path.read_text(encoding="utf-8"), names, auxiliary=True)
    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
