"""Mutations of the actual protected npm workflow, without publishing anything."""

import contextlib
import importlib.util
import io
from pathlib import Path
import re
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/npm-trusted-publish.yml"


def load():
    spec = importlib.util.spec_from_file_location("npm_publish_contract", ROOT / "scripts/check_npm_trusted_publish_workflow.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def python_contract():
    spec = importlib.util.spec_from_file_location("ci_workflow_contract", ROOT / "scripts/check_ci_workflow.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(text):
    with tempfile.TemporaryDirectory() as directory:
        workflow = Path(directory) / "npm.yml"
        workflow.write_text(text, encoding="utf-8")
        module = load()
        module.WORKFLOW = workflow
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                module.main()
        except SystemExit as error:
            return str(error)
    return None


def test_actual_workflow_passes_without_changing_it():
    before = WORKFLOW.read_bytes()
    assert check(before.decode()) is None
    assert WORKFLOW.read_bytes() == before


def test_each_job_must_guard_its_own_runtime_before_npm():
    text = WORKFLOW.read_text()
    command = "          " + load().NODE_GUARD + "\n"
    for occurrence in (0, 1):
        start = [i for i in range(len(text)) if text.startswith(command, i)][occurrence]
        end = start + len(command)
        for replacement in ("", command.rstrip() + " || true\n", "          exit 0\n" + command):
            assert check(text[:start] + replacement + text[end:]), (occurrence, replacement)
        missing = text[:start] + text[end:]
        assert check(missing + "\n  unrelated:\n    steps:\n      - run: " + load().NODE_GUARD + "\n")
    for header in ("        if: false\n", "        continue-on-error: true\n"):
        assert check(text.replace("        shell: bash\n", header + "        shell: bash\n", 1))
    # Leaving the correct command in the job, after npm, is insufficient.
    moved = text.replace(command + "          node --version\n",
                         '          "$RUNNER_TEMP/vivary-build-tools/bin/npm" --version\n' + command + "          node --version\n", 1)
    assert moved != text
    assert check(moved)


def test_publication_requires_success_and_the_same_checked_candidate():
    text = WORKFLOW.read_text()
    for old, new in (
        ("    needs: verify\n", ""),
        ("    environment: npm-publish\n", ""),
        ("inputs.publish && needs.verify.result == 'success'", "inputs.publish"),
        ("inputs.publish && needs.verify.result == 'success'", "always()"),
        (load().PUBLISH, "npm publish"),
        (load().PUBLISH, "npm publish packages/create-vivary/npm"),
        (load().PUBLISH, load().PUBLISH.replace("npm-candidate", "different-candidate")),
        (load().PUBLISH, load().PUBLISH + " || true"),
        (load().PUBLISH, load().PUBLISH.replace(' "$RUNNER_TEMP/vivary-build-tools"', "")),
        (load().PUBLISH, load().PUBLISH.replace('"$RUNNER_TEMP/vivary-build-tools/bin/node"', "node", 1)),
        ("      - name: Publish @vivary/create with npm trusted publishing\n",
         "      - name: Publish @vivary/create with npm trusted publishing\n        if: false\n"),
        ("      - name: Re-verify npm package contents\n",
         "      - name: Re-verify npm package contents\n        continue-on-error: true\n"),
    ):
        assert old in text, old
        assert check(text.replace(old, new)), (old, new)
    # Matching commands in verify do not admit the protected publish job.
    before, publish = text.split("\n  publish:\n", 1)
    assert check(before + "\n  publish:\n" + publish.replace(load().PUBLISH, "echo omitted"))


def test_each_job_runs_npm_only_through_the_qualified_client():
    text = WORKFLOW.read_text(encoding="utf-8")
    module = load()
    contract = python_contract()
    client = module.CLIENT_STEP
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        assert job.count(client) == 1, name
        pack_name = "Verify npm" if name == "verify" else "Re-verify npm"
        pack = module.PACK_STEP.replace("Verify npm", pack_name, 1)
        assert job.count(pack) == 1, name
        mutations = {
            "missing_client": job.replace(client, "", 1),
            "late_client": job.replace(client, "", 1).replace(pack, client + "\n" + pack, 1),
            "image_npm_pack": job.replace(module.PACK, 'npm pack --pack-destination "$RUNNER_TEMP/npm-candidate"', 1),
            "image_npm_version": job.replace(client, client + "          npm --version\n", 1),
            "older_client": job.replace('= "12.2.1"', '= "11.19.1"', 1),
            "unchecked_client": job.replace('          test "$("$RUNNER_TEMP', '          echo "$("$RUNNER_TEMP', 1),
            "ignored_client": job.replace(client, client.replace("        shell:", "        continue-on-error: true\n        shell:"), 1),
            "npx": job.replace(pack, "      - run: npx --yes pkg\n" + pack, 1),
            "corepack": job.replace(pack, "      - run: corepack enable\n" + pack, 1),
            "quoted_npm": job.replace(pack, "      - run: 'npm whoami'\n" + pack, 1),
            "second_client_use": job.replace(pack, '      - run: \'"$RUNNER_TEMP/vivary-build-tools/bin/npm" whoami\'\n' + pack, 1),
            "registry_url": job.replace('          node-version: "24.22.1"\n',
                                        '          node-version: "24.22.1"\n          registry-url: "https://registry.npmjs.org"\n', 1),
        }
        for label, mutation in mutations.items():
            assert mutation != job, (name, label)
            assert check(text.replace(job, mutation, 1)), (name, label)


def test_workflow_publisher_and_provisioner_name_one_client():
    module = load()
    source = module.RUNTIME_SECURITY.read_text(encoding="utf-8")
    pins = module.npm_pins()
    assert pins == {"npm": "12.2.1", "undici": "6.29.1", "ip-address": "10.7.4"}
    module.check_qualified_client(source, pins)
    for label, mutated_source, mutated_pins in (
        ("publisher npm", source.replace('npm: "12.2.1"', 'npm: "11.19.1"', 1), pins),
        ("publisher undici", source.replace('undici: "6.29.1"', 'undici: "6.28.0"', 1), pins),
        ("publisher missing", source.replace("export const QUALIFIED_NPM", "const QUALIFIED_NPM", 1), pins),
        ("provisioner ip-address", source, {**pins, "ip-address": "10.5.0"}),
        ("provisioner npm", source, {**pins, "npm": "12.2.2"}),
    ):
        assert mutated_source != source or mutated_pins != pins, label
        try:
            module.check_qualified_client(mutated_source, mutated_pins)
        except SystemExit as error:
            assert "qualified npm" in str(error), (label, error)
        else:
            raise AssertionError(label)
    # The workflow pin itself is the third name for the client.
    module.QUALIFIED_NPM = "12.2.2"
    try:
        module.check_qualified_client(source, pins)
    except SystemExit:
        pass
    else:
        raise AssertionError("workflow pin")
    # main() reads the publisher's pins from runtime-security.mjs.
    with tempfile.TemporaryDirectory() as directory:
        changed = Path(directory) / "runtime-security.mjs"
        changed.write_text(source.replace('npm: "12.2.1"', 'npm: "11.19.1"', 1), encoding="utf-8")
        workflow = Path(directory) / "npm.yml"
        workflow.write_text(WORKFLOW.read_text(encoding="utf-8"), encoding="utf-8")
        module = load()
        module.WORKFLOW, module.RUNTIME_SECURITY = workflow, changed
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                module.main()
        except SystemExit as error:
            assert "qualified npm pins differ" in str(error), error
        else:
            raise AssertionError("main must compare the publisher's pins")


def test_publisher_cannot_move_before_archive_validation():
    text = WORKFLOW.read_text()
    marker = "      - name: Publish @vivary/create with npm trusted publishing\n"
    start = text.index(marker)
    step = text[start:]
    without = text[:start]
    insertion = without.index("      - name: Re-verify npm package contents\n")
    assert check(without[:insertion] + step + "\n" + without[insertion:])


def test_quoted_javascript_operators_do_not_mask_shell_failures():
    module = load()
    legitimate = '        run: |\n          node -e "if (major < 11 || (major === 11 && minor < 5)) throw new Error(\'npm 11.5.1+ is required\');"\n'
    assert not module.shell_masks_failure(legitimate)
    for extra in (' || true', ' | true', '; exit 0', ' &'):
        assert module.shell_masks_failure(legitimate.rstrip() + extra + '\n'), extra
    assert module.shell_masks_failure(legitimate + '          set +e\n')


def test_each_job_requires_the_fixed_admitted_node_pin():
    text = WORKFLOW.read_text(encoding="utf-8")
    pin = '          node-version: "24.22.1"\n'
    assert text.count(pin) == 2
    for occurrence in (0, 1):
        start = [i for i in range(len(text)) if text.startswith(pin, i)][occurrence]
        end = start + len(pin)
        for unsafe in ("24", "24.20.0", "22.22.0", ">=24.22.1"):
            mutation = text[:start] + f'          node-version: "{unsafe}"\n' + text[end:]
            message = check(mutation)
            assert message and "fixed admitted Node 24.22.1" in message, (occurrence, unsafe, message)


def test_each_job_requires_its_own_python_provisioning_and_actual_admission():
    text = WORKFLOW.read_text(encoding="utf-8")
    contract = python_contract()
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        provision = contract.PYTHON_PROVISIONING_STEP
        guard = contract.PYTHON_RUNTIME_STEP
        mutations = {
            "missing_provision": job.replace(provision, "", 1),
            "missing_guard": job.replace(guard, "", 1),
            "conditional_provision": job.replace(provision, provision.replace("        shell:", "        if: false\n        shell:"), 1),
            "ignored_guard": job.replace(guard, guard.replace("        shell:", "        continue-on-error: true\n        shell:"), 1),
            "late_guard": job.replace(guard, "", 1) + guard,
            "changed_provisioner": job.replace('runpy.run_path("scripts/bootstrap_ci_python.py"',
                                                'runpy.run_path("scripts/bootstrap_ci_pip.py"', 1),
        }
        for label, mutation in mutations.items():
            assert mutation != job, (name, label)
            message = check(text.replace(job, mutation, 1))
            assert message and "Python" in message, (name, label, message)


def test_each_job_requires_the_exact_python_bootstrap_version():
    text = WORKFLOW.read_text(encoding="utf-8")
    contract = python_contract()
    pin = '          python-version: "3.12.15"\n'
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        for unsafe in ("3.11", "3.12.14", "3.12", ">=3.12.15"):
            mutation = job.replace(pin, f'          python-version: "{unsafe}"\n', 1)
            assert mutation != job, (name, unsafe)
            message = check(text.replace(job, mutation, 1))
            assert message and "exact Python selection" in message, (name, unsafe, message)


def test_existing_python_consumers_cannot_move_before_runtime_setup():
    text = WORKFLOW.read_text(encoding="utf-8")
    contract = python_contract()
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        match = re.search(r"(?ms)^      - name: (?:Verify|Re-verify) release tag and package versions\n.*?(?=^      - |\Z)", job)
        assert match, name
        consumer = match[0]
        assert "          python - <<'PY'\n" in consumer, name
        without = job[:match.start()] + job[match.end():]
        setup = without.index(contract.PIP_SETUP_STEP)
        mutation = without[:setup] + consumer + without[setup:]
        assert mutation != job, name
        message = check(text.replace(job, mutation, 1))
        assert message and "actual Python before its consumers" in message, (name, message)


def test_compact_python_consumers_cannot_move_before_runtime_setup():
    text = WORKFLOW.read_text(encoding="utf-8")
    contract = python_contract()
    compact = {
        "run": '      - run: python -c "print(1)"\n',
        "shell": "      - shell: python {0}\n        run: print(1)\n",
    }
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        setup = job.index(contract.PIP_SETUP_STEP)
        for label, step in compact.items():
            mutation = job[:setup] + step + job[setup:]
            message = check(text.replace(job, mutation, 1))
            assert message and "actual Python before its consumers" in message, (name, label, message)


def test_guard_or_validation_text_hidden_in_shell_structure_is_refused():
    text = WORKFLOW.read_text(encoding="utf-8")
    module = load()
    guard = "          set -euo pipefail\n          " + module.NODE_GUARD + "\n"
    assert text.count(guard) == 2
    for wrap in (lambda body: "          cat <<'EOF'\n" + body + "          EOF\n",
                 lambda body: "          guard() {\n" + body + "          }\n",
                 lambda body: "          if false\n          then\n" + body + "          fi\n"):
        message = check(text.replace(guard, wrap(guard), 1))
        assert message and "runtime guard must be exactly the reviewed step" in message, message
    validation = ('          python ../../../scripts/check_release_artifacts.py --repository ../../.. '
                  '--artifacts "$RUNNER_TEMP/npm-candidate" --scope npm\n')
    assert text.count(validation) == 2
    hidden = "          if " + validation.strip() + "\n          then :\n          fi\n"
    message = check(text.replace(validation, hidden, 1))
    assert message and "archive validation must be exactly the reviewed step" in message, message


def test_python_spelled_as_a_path_or_through_env_cannot_run_before_admission():
    text = WORKFLOW.read_text(encoding="utf-8")
    contract = python_contract()
    for name in ("verify", "publish"):
        job = contract.job_block(text, name)
        setup = job.index(contract.PIP_SETUP_STEP)
        for label, step in (("absolute", "      - run: /usr/bin/python3 scripts/check_release_artifacts.py --help\n"),
                            ("env", "      - run: env python -c 'print(1)'\n"),
                            ("shell", "      - shell: /usr/bin/python3 {0}\n        run: print(1)\n")):
            message = check(text.replace(job, job[:setup] + step + job[setup:], 1))
            assert message and "actual Python before its consumers" in message, (name, label, message)


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"ok {test.__name__}")
        except Exception as error:
            failed += 1
            print(f"FAIL {test.__name__}: {error}")
    sys.exit(1 if failed else 0)
