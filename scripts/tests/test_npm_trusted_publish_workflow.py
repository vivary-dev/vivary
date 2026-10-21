"""Mutations of the actual protected npm workflow, without publishing anything."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/npm-trusted-publish.yml"


def load():
    spec = importlib.util.spec_from_file_location("npm_publish_contract", ROOT / "scripts/check_npm_trusted_publish_workflow.py")
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
    assert check(text.replace(command + "          node --version\n          npm --version\n",
                            "          npm --version\n" + command + "          node --version\n", 1))


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
