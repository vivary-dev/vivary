"""Offline tests of the canonical and actual inline runner bootstrap sources."""

import contextlib
import ast
import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
CANONICAL = ROOT / "scripts/check_runner_action_node.py"
WORKFLOWS = (ROOT / ".github/workflows/ci.yml", ROOT / ".github/workflows/npm-trusted-publish.yml")


def inline_source(text):
    header = ("      - &runner_action_node_bootstrap\n"
              "        name: runner action Node admission\n"
              "        id: runner_action_node\n"
              "        shell: python -I -B {0}\n"
              "        run: |\n")
    steps = re.split(r"(?m)(?=^      - )", text)[1:]
    selected = [step for step in steps if re.search(
        r"(?m)^        (?:name: runner action Node admission|id: runner_action_node)$", step)]
    anchors = re.findall(r"(?m)^      - &runner_action_node_bootstrap(?:\s|$)", text)
    if len(selected) != 1 or len(anchors) != 1 or not selected[0].startswith(header):
        raise AssertionError("one complete named runner bootstrap mapping is required")
    lines = selected[0][len(header):].splitlines(keepends=True)
    source = []
    for line in lines:
        if line.startswith("          "):
            source.append(line[10:])
        elif not line.strip():
            source.append("\n")
        else:
            raise AssertionError("runner bootstrap must contain only its literal Python body")
    if not "".join(source).strip():
        raise AssertionError("runner bootstrap Python body is required")
    # YAML's literal block clips trailing empty lines to one final newline.
    return "".join(source).rstrip("\n") + "\n"


def sources():
    return [("canonical", CANONICAL.read_text())] + [(path.name, admission_source(inline_source(path.read_text()))) for path in WORKFLOWS]


def admission_source(source):
    """Read the complete unchanged guard embedded by the repair wrapper."""
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "RUNNER_ADMISSION_SOURCE" for target in node.targets):
            value = ast.literal_eval(node.value)
            if not isinstance(value, str):
                raise AssertionError("literal runner admission source is required")
            return value
    raise AssertionError("complete runner admission source is missing")


def load_source(source):
    module = types.ModuleType("fixture_runner_bootstrap")
    exec(compile(source, "fixture-runner-bootstrap.py", "exec"), module.__dict__)
    return getattr(module, "admission", module)


def contract():
    spec = importlib.util.spec_from_file_location("fixture_workflow_contract", ROOT / "scripts/check_ci_workflow.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def elf(machine=62):
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, machine)
    return header


def pe(machine=0x8664):
    header = bytearray(154)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 60, 128)
    header[128:132] = b"PE\0\0"
    struct.pack_into("<H", header, 132, machine)
    struct.pack_into("<H", header, 152, 0x20b)
    return header


def process_chain(root, system="linux"):
    if system == "win32":
        worker, python, init = r"C:\runner\bin\Runner.Worker.exe", r"C:\Python\python.exe", r"C:\Windows\init.exe"
    else:
        worker, python, init = str(PurePosixPath(root.as_posix()) / "bin/Runner.Worker"), "/usr/bin/python3", "/sbin/init"
    return {30: {"pid": 30, "ppid": 20, "created": 300, "exe": python},
            20: {"pid": 20, "ppid": 1, "created": 200, "exe": worker},
            1: {"pid": 1, "ppid": 0, "created": 1, "exe": init}}


@contextlib.contextmanager
def controlled_runner(module, directory, probe="v24.22.1"):
    root = Path(directory) / "runner"
    worker = root / "bin/Runner.Worker"
    interpreter = root / "externals/node24/bin/node"
    worker.parent.mkdir(parents=True)
    interpreter.parent.mkdir(parents=True)
    worker.write_bytes(elf())
    interpreter.write_bytes(elf() + b"controlled interpreter bytes")
    chain = process_chain(root)
    def read(pid):
        return dict(chain[pid])
    with mock.patch.object(module.sys, "platform", "linux"), \
         mock.patch.object(module.platform, "machine", return_value="x86_64"), \
         mock.patch.dict(module.os.environ, {}, clear=True), \
         mock.patch.object(module.os, "getpid", return_value=30), \
         mock.patch.object(module, "container_host", return_value=False), \
         mock.patch.object(module, "linux_process", side_effect=read), \
         mock.patch.object(module, "sanitized_environment", return_value={"LANG": "C", "LC_ALL": "C"}), \
         mock.patch.object(module, "probe_version", return_value=probe) as probing:
        yield root, worker, interpreter, chain, probing


class InlineSourceTests(unittest.TestCase):
    BOOTSTRAP = ("      - &runner_action_node_bootstrap\n"
                 "        name: runner action Node admission\n"
                 "        id: runner_action_node\n"
                 "        shell: python -I -B {0}\n"
                 "        run: |\n"
                 "          selected = True\n")
    GUARD = ("      - name: unrelated Python guard\n"
             "        shell: python -I -B {0}\n"
             "        run: |\n"
             "          raise AssertionError('unrelated guard must not be selected')\n")

    def test_inline_extraction_selects_runner_among_unrelated_python_guards(self):
        self.assertEqual(inline_source(self.GUARD + self.BOOTSTRAP + self.GUARD), "selected = True\n")

    def test_inline_extraction_refuses_missing_duplicate_or_malformed_runner(self):
        mutations = {
            "missing": self.GUARD,
            "duplicate": self.BOOTSTRAP + self.BOOTSTRAP,
            "duplicate-result": self.BOOTSTRAP + self.GUARD.replace(
                "        shell:", "        id: runner_action_node\n        shell:"),
            "anchor": self.BOOTSTRAP.replace("&runner_action_node_bootstrap", "&other_bootstrap"),
            "name": self.BOOTSTRAP.replace("name: runner action Node admission", "name: other admission"),
            "id": self.BOOTSTRAP.replace("id: runner_action_node", "id: other_result"),
            "shell": self.BOOTSTRAP.replace("python -I -B {0}", "python {0}"),
            "folded": self.BOOTSTRAP.replace("run: |", "run: >"),
            "empty": self.BOOTSTRAP.replace("          selected = True\n", ""),
            "dedented": self.BOOTSTRAP.replace("          selected", "        selected"),
            "condition": self.BOOTSTRAP + "        if: false\n",
            "ignored-failure": self.BOOTSTRAP + "        continue-on-error: true\n",
        }
        for name, text in mutations.items():
            with self.subTest(mutation=name), self.assertRaises(AssertionError):
                inline_source(text)


class RunnerBootstrapTests(unittest.TestCase):
    def test_actual_inline_sources_are_byte_identical_and_import_has_no_probe(self):
        source = CANONICAL.read_text()
        for name, candidate in sources():
            with self.subTest(source=name), mock.patch("subprocess.Popen", side_effect=AssertionError("import must not probe")):
                self.assertEqual(candidate, source)
                module = load_source(candidate)
                self.assertTrue(callable(module.check_runner_action_node))

    def test_all_workflows_bind_the_complete_guard_and_repair_sources(self):
        repair = (ROOT / "scripts/bootstrap_runner_action_node.py").read_text()
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            if "runner_action_node_bootstrap" not in path.read_text():
                continue
            source = inline_source(path.read_text())
            with self.subTest(workflow=path.name):
                self.assertEqual(admission_source(source), CANONICAL.read_text())
                self.assertTrue(source.endswith(repair))
                module = types.ModuleType("fixture_runner_repair")
                with mock.patch("subprocess.run", side_effect=AssertionError("import cannot run a downloader or Node")):
                    exec(compile(source, "fixture-inline-repair.py", "exec"), module.__dict__)
                self.assertTrue(callable(module.repair_runner_action_node))
                self.assertTrue(callable(module.admission.check_runner_action_node))

    def test_policy_boundaries_and_node24_selection_for_every_actual_source(self):
        for name, source in sources():
            module = load_source(source)
            for bad, good in (("22.23.3", "22.23.4"), ("24.22.0", "24.22.1"), ("26.12.0", "26.12.1")):
                with self.subTest(source=name, version=bad):
                    with self.assertRaises(RuntimeError): module.node_version(bad)
                    self.assertEqual(module.node_version(good), good)
            for bad in ("24.19.0", "24.21.0", "18.99.0", "20.99.0", "25.99.0", "28.0.0", "24.22", "24.022.1", "24.22.1-rc.1", "24.22.1+local", "24.22.1\n", "", None, {}, 24):
                with self.subTest(source=name, version=bad), self.assertRaises(RuntimeError): module.node_version(bad)
            for other in ("22.23.4", "26.12.1"):
                with self.assertRaisesRegex(RuntimeError, "actually be Node 24"): module.node_version(other, selected_major=24)
            self.assertEqual(module.node_version("v24.22.1", selected_major=24), "24.22.1")

    def test_linux_stat_and_windows_process_api_keep_creation_and_parent_identity(self):
        module = load_source(CANONICAL.read_text())
        fields = ["S", "20"] + ["0"] * 17 + ["1234"]
        self.assertEqual(module.parse_linux_stat("30 (python (fixture)) " + " ".join(fields)), {"pid": 30, "ppid": 20, "created": 1234})
        with self.assertRaises(RuntimeError): module.parse_linux_stat("bad process")
        class Function:
            def __init__(self, call): self.call = call
            def __call__(self, *args): return self.call(*args)
        kernel = types.SimpleNamespace()
        kernel.pid = 0
        def opening(access, inherit, pid):
            kernel.pid = pid
            return 99
        kernel.OpenProcess = Function(opening)
        kernel.CloseHandle = Function(lambda handle: True)
        kernel.WaitForSingleObject = Function(lambda handle, timeout: 258)
        def times(handle, created, exited, system, user):
            created._obj.dwLowDateTime = 1234
            return True
        kernel.GetProcessTimes = Function(times)
        def image(handle, flags, buffer, length):
            buffer.value = r"C:\runner\bin\Runner.Worker.exe"
            return True
        kernel.QueryFullProcessImageNameW = Function(image)
        def information(handle, kind, info, size, returned):
            info._obj.pid = kernel.pid
            info._obj.parent = 1
            return 0
        ntdll = types.SimpleNamespace(NtQueryInformationProcess=Function(information))
        with mock.patch.object(ctypes, "WinDLL", side_effect=lambda name, **options: kernel if name == "kernel32" else ntdll, create=True):
            actual = module.windows_process(20)
            self.assertEqual((actual["pid"], actual["ppid"], actual["created"]), (20, 1, 1234))
            kernel.WaitForSingleObject.call = lambda handle, timeout: 0
            with self.assertRaisesRegex(RuntimeError, "disappeared or reused"): module.windows_process(20)
            kernel.OpenProcess.call = lambda *args: None
            with self.assertRaisesRegex(RuntimeError, "unreadable"): module.windows_process(20)

    def test_owning_worker_prefix_and_same_root_on_linux_and_windows(self):
        for name, source in sources():
            module = load_source(source)
            for system in ("linux", "win32"):
                chain = process_chain(Path("/runner"), system)
                worker, observed = module.discover_worker(30, lambda pid: dict(chain[pid]), system)
                root, node = module.runner_paths(worker, system)
                self.assertEqual([item["pid"] for item in observed], [30, 20])
                self.assertEqual(root, r"C:\runner" if system == "win32" else "/runner")
                self.assertEqual(node, r"C:\runner\externals\node24\bin\node.exe" if system == "win32" else "/runner/externals/node24/bin/node")
                with mock.patch.object(module, "MAX_ANCESTORS", 1), self.assertRaisesRegex(RuntimeError, "overlong"):
                    module.discover_worker(30, lambda pid: dict(chain[pid]), system)
                for mode in ("missing", "reused", "unreadable", "cycle", "bad-path"):
                    altered = {pid: dict(value) for pid, value in chain.items()}
                    calls = {}
                    if mode == "missing": altered[20]["exe"] = altered[30]["exe"]
                    if mode == "cycle": altered[20]["ppid"] = 30
                    if mode == "bad-path": altered[20]["exe"] = r"C:\other\Runner.Worker.exe" if system == "win32" else "/other/Runner.Worker"
                    def read(pid):
                        calls[pid] = calls.get(pid, 0) + 1
                        if mode == "unreadable" and pid == 20: raise PermissionError("fixture process denied")
                        item = dict(altered[pid])
                        if mode == "reused" and calls[pid] > 1: item["created"] += 1
                        return item
                    with self.subTest(source=name, system=system, mode=mode), self.assertRaises((RuntimeError, PermissionError)):
                        module.discover_worker(30, read, system)

    def test_unsupported_hosts_containers_and_unproved_overrides_refuse_without_values(self):
        module = load_source(CANONICAL.read_text())
        for system, machine, environment, container in (("darwin", "x86_64", {}, False), ("linux", "aarch64", {}, False),
            ("win32", "ARM64", {}, False), ("linux", "x86_64", {}, True), ("linux", "x86_64", {"RUNNER_ARCH": "ARM64"}, False)):
            with self.assertRaises(RuntimeError): module.check_host(system, machine, environment, container)
        for flag in ("ACTIONS_RUNNER_FORCE_ACTIONS_NODE_VERSION", "ACTIONS_RUNNER_UNKNOWN_NODE_OVERRIDE"):
            with self.assertRaises(RuntimeError) as caught: module.check_selection_overrides({flag: "secret-value"})
            self.assertIn(flag, str(caught.exception))
            self.assertNotIn("secret-value", str(caught.exception))
        module.check_host("linux", "x86_64", {"FORCE_JAVASCRIPT_ACTIONS_TO_NODE24": "true", "ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION": "true"})

    def test_native_binary_identity_rejects_arm_wrong_os_and_malformed_data(self):
        module = load_source(CANONICAL.read_text())
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "executable"
            for system, data, valid in (("linux", elf(), True), ("win32", pe(), True), ("linux", elf(183), False),
                ("win32", pe(0xaa64), False), ("linux", pe(), False), ("win32", elf(), False), ("win32", b"MZ", False)):
                file.write_bytes(data)
                if valid: module.binary_x64(file, system)
                else:
                    with self.assertRaises(RuntimeError): module.binary_x64(file, system)

    @unittest.skipUnless(sys.platform == "linux", "full ELF runner fixture uses native Linux paths")
    def test_collector_uses_only_worker_node_and_rejects_affected_missing_changed_or_reused_evidence(self):
        for name, source in sources():
            for mode in ("fixed", "affected", "other-major", "missing", "missing-probe", "replaced", "worker-replaced", "reused", "wrong-root", "wrong-arch"):
                with self.subTest(source=name, mode=mode), tempfile.TemporaryDirectory() as directory:
                    module = load_source(source)
                    with controlled_runner(module, directory) as (root, worker, interpreter, chain, probing):
                        if mode == "affected": probing.return_value = "v24.22.0"
                        if mode == "other-major": probing.return_value = "v26.12.1"
                        if mode == "missing": interpreter.unlink()
                        if mode == "missing-probe": probing.side_effect = FileNotFoundError("controlled missing probe")
                        if mode == "wrong-arch": interpreter.write_bytes(elf(183))
                        if mode == "wrong-root":
                            interpreter.unlink()
                            outside = Path(directory) / "other-node"
                            outside.write_bytes(elf())
                            interpreter.symlink_to(outside)
                        if mode == "replaced":
                            def replace(*args):
                                interpreter.write_bytes(elf() + b"replaced")
                                return "v24.22.1"
                            probing.side_effect = replace
                        if mode == "worker-replaced":
                            def replace_worker(*args):
                                worker.write_bytes(elf() + b"changed Worker")
                                return "v24.22.1"
                            probing.side_effect = replace_worker
                        if mode == "reused":
                            def reuse(*args):
                                chain[20]["created"] += 1
                                return "v24.22.1"
                            probing.side_effect = reuse
                        # A safe-version PATH stand-in must never rescue the affected
                        # provider interpreter or even be consulted by the probe.
                        path_bin = Path(directory) / "safe-path"
                        path_bin.mkdir()
                        path_marker = Path(directory) / "path-node-used"
                        path_node = path_bin / "node"
                        path_node.write_text("#!" + sys.executable + "\nfrom pathlib import Path\nPath(" + repr(str(path_marker)) + ").write_text('used')\nprint('v24.22.1')\n")
                        path_node.chmod(0o700)
                        module.os.environ["PATH"] = str(path_bin)
                        if mode == "fixed":
                            actual = module.check_runner_action_node()
                            self.assertEqual(actual["interpreter"], str(interpreter))
                            self.assertEqual(actual["sha256"], module.sha256(interpreter))
                            self.assertEqual(actual["root"], str(root))
                            self.assertEqual((actual["version"], actual["platform"], actual["architecture"]), ("24.22.1", "linux", "x64"))
                            probing.assert_called_once_with(interpreter, {"LANG": "C", "LC_ALL": "C"})
                        else:
                            with self.assertRaises((RuntimeError, OSError)): module.check_runner_action_node()
                        self.assertFalse(path_marker.exists())
                        self.assertLessEqual(probing.call_count, 1)
                        if probing.called:
                            self.assertEqual(probing.call_args.args[0], interpreter)

    @unittest.skipIf(sys.platform == "win32", "executable Python stand-ins need Unix shebang execution")
    def test_real_bounded_probe_rejects_bad_failed_oversized_and_timeout_output(self):
        module = load_source(CANONICAL.read_text())
        with tempfile.TemporaryDirectory() as directory:
            program = Path(directory) / "controlled-version"
            for body, valid in (("print('v24.22.1')", True), ("print('v24.22.1', end='\\r\\n')", True),
                ("print('v24.22.1-rc.1')", False), ("print('not Node')", False), ("raise SystemExit(7)", False),
                ("print('x' * 1000)", False), ("import time; time.sleep(5)", False)):
                program.write_text("#!" + sys.executable + "\n" + body + "\n")
                program.chmod(0o700)
                module.PROBE_TIMEOUT = 0.2
                if valid: self.assertEqual(module.probe_version(program, {"LANG": "C", "LC_ALL": "C"}), "v24.22.1")
                else:
                    with self.assertRaises(RuntimeError): module.probe_version(program, {"LANG": "C", "LC_ALL": "C"})

    @unittest.skipUnless(sys.platform == "linux", "full ELF runner fixture uses native Linux paths")
    def test_failed_actual_inline_bootstrap_admits_no_action_or_publisher_markers(self):
        for workflow in WORKFLOWS:
            module = load_source(inline_source(workflow.read_text()))
            with tempfile.TemporaryDirectory() as directory, controlled_runner(module, directory, "v24.22.0"):
                with contextlib.redirect_stderr(io.StringIO()): result = module.main()
                self.assertEqual(result, 1)
                # Controlled action transports obey the workflow's default success admission.
                for action in ("checkout", "setup", "upload", "publisher"):
                    marker = Path(directory) / (action + ".marker")
                    if result == 0: marker.write_text("admitted")
                    self.assertFalse(marker.exists(), action)


class RunnerDiagnosticTests(unittest.TestCase):
    def all_sources(self):
        auxiliary = (ROOT / ".github/workflows" / name for name in ("review-gate.yml", "steward.yml", "track-stats.yml"))
        return sources() + [(path.name, admission_source(inline_source(path.read_text()))) for path in auxiliary]

    def test_supported_errors_report_only_phase_and_exception_class(self):
        errors = (RuntimeError("private policy value"), PermissionError("private path"),
                  ValueError("private value"), TypeError("private argument"), KeyError("private key"),
                  AttributeError("private attribute"), subprocess.TimeoutExpired("private command", 1))
        for name, source in self.all_sources():
            self.assertEqual(source, CANONICAL.read_text())
            for error in errors:
                module = load_source(source)
                stdout, stderr = io.StringIO(), io.StringIO()
                with self.subTest(source=name, error=type(error).__name__), \
                     mock.patch.object(module, "check_runner_action_node", side_effect=error), \
                     mock.patch.object(module.subprocess, "Popen", side_effect=AssertionError("no probe")) as probe, \
                     contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(module.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "Runner action Node: admission failed (phase=admission, exception=" + type(error).__name__ + ")\n")
                probe.assert_not_called()

    def test_actual_guard_failures_identify_container_process_probe_and_policy_phases(self):
        fields = ["S", "20"] + ["0"] * 17 + ["300"]
        for name, source in self.all_sources():
            for phase in ("container-detection", "process-identity", "interpreter-probe", "interpreter-version"):
                module = load_source(source)
                stdout, stderr = io.StringIO(), io.StringIO()
                expected_class = "RuntimeError" if phase == "interpreter-version" else "PermissionError"
                with self.subTest(source=name, phase=phase), contextlib.ExitStack() as stack:
                    stack.enter_context(contextlib.redirect_stdout(stdout))
                    stack.enter_context(contextlib.redirect_stderr(stderr))
                    probe = stack.enter_context(mock.patch.object(module.subprocess, "Popen", side_effect=PermissionError("private executable path")))
                    if phase == "interpreter-probe":
                        stack.enter_context(mock.patch.object(module, "check_runner_action_node", side_effect=lambda: module.probe_version(Path("private-selected-node"), {})))
                    elif phase == "interpreter-version":
                        stack.enter_context(mock.patch.object(module, "check_runner_action_node", side_effect=lambda: module.node_version("24.22.0", selected_major=24)))
                    else:
                        stack.enter_context(mock.patch.object(module.sys, "platform", "linux"))
                        stack.enter_context(mock.patch.object(module.platform, "machine", return_value="x86_64"))
                        stack.enter_context(mock.patch.dict(module.os.environ, {}, clear=True))
                        if phase == "container-detection":
                            stack.enter_context(mock.patch.object(module.Path, "exists", return_value=False))
                            stack.enter_context(mock.patch.object(module.Path, "read_text", side_effect=PermissionError("private cgroup path")))
                        else:
                            stack.enter_context(mock.patch.object(module, "container_host", return_value=False))
                            stack.enter_context(mock.patch.object(module.os, "getpid", return_value=30))
                            stack.enter_context(mock.patch.object(module.Path, "read_text", return_value="30 (python) " + " ".join(fields)))
                            stack.enter_context(mock.patch.object(module.os, "readlink", side_effect=PermissionError("private ancestor path")))
                    self.assertEqual(module.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                detail = ", observedNode=24.22.0, requiredNode=24.22.1" if phase == "interpreter-version" else ""
                self.assertEqual(stderr.getvalue(), f"Runner action Node: admission failed (phase={phase}, exception={expected_class}{detail})\n")
                self.assertEqual(probe.call_count, int(phase == "interpreter-probe"))

    def test_errors_outside_existing_catch_families_still_propagate(self):
        for name, source in self.all_sources():
            module = load_source(source)
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(source=name), \
                 mock.patch.object(module, "check_runner_action_node", side_effect=LookupError("private value")), \
                 mock.patch.object(module.subprocess, "Popen", side_effect=AssertionError("no probe")) as probe, \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), self.assertRaises(LookupError):
                module.main()
            self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
            probe.assert_not_called()


class WorkflowBootstrapTests(unittest.TestCase):
    def test_first_step_and_canonical_mapping_mutations_cover_all_ten_jobs(self):
        module = contract()
        for workflow in WORKFLOWS:
            text = workflow.read_text()
            names = module.CI_JOBS if workflow.name == "ci.yml" else ("verify", "publish")
            npm = workflow.name != "ci.yml"
            module.check_runner_action_bootstrap(text, names, npm=npm)
            for index, name in enumerate(names):
                block = module.job_block(text, name)
                first = module.runner_bootstrap_step() if index == 0 else module.BOOTSTRAP_ALIAS
                alterations = ["", first.replace("runner_action_node", "wrong_result"),
                    "      - run: echo omitted\n", first.replace("python -I -B {0}", "python {0}"),
                    first.rstrip() + "\n        if: false\n", first.rstrip() + "\n        continue-on-error: true\n"]
                if index:
                    alterations += ["      - *unknown_bootstrap\n", "      - <<: *runner_action_node_bootstrap\n        if: false\n"]
                else:
                    alterations += [first.replace("run: |", "run: >"), first.replace("before workflow", "altered before workflow") + "\n        env:\n          BYPASS: yes\n"]
                for changed in alterations:
                    if changed == first: continue
                    with self.subTest(workflow=workflow.name, job=name, mutation=changed[:60]), self.assertRaises(SystemExit):
                        module.check_runner_action_bootstrap(text.replace(block, block.replace(first, changed, 1), 1), names, npm=npm)
                with self.assertRaises(SystemExit):
                    module.check_runner_action_bootstrap(text.replace(block, block.replace(first, "", 1) + first, 1), names, npm=npm)
            with self.assertRaises(SystemExit):
                module.check_runner_action_bootstrap(text.replace("CVE-2026-111497", "altered-advisory", 1), names, npm=npm)

    def test_exact_action_identities_and_no_pre_main_post_bindings(self):
        module = contract()
        for reference, manifest in module.ACTION_MANIFESTS.items():
            module.validate_action_manifest(reference, dict(manifest))
            for changed in ({**manifest, "pre": "pre.js"}, {**manifest, "using": "composite"},
                            {**manifest, "using": "docker"}, {**manifest, "main": "different.js"}, {**manifest, "post": "different.js"}):
                with self.assertRaises(SystemExit): module.validate_action_manifest(reference, changed)
        for workflow in WORKFLOWS:
            text = workflow.read_text()
            names = module.CI_JOBS if workflow.name == "ci.yml" else ("verify", "publish")
            for bad in ("actions/checkout@v7.0.1", "unknown/pre-action@" + "a" * 40, "./composite-action", "docker://node:24"):
                altered = text.replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", bad, 1)
                with self.assertRaises(SystemExit): module.check_runner_action_bootstrap(altered, names, npm=workflow.name != "ci.yml")

    def test_containers_arm_and_unsupported_runner_configurations_remain_held(self):
        module = contract()
        text = WORKFLOWS[0].read_text()
        for old, new in (("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-24.04-arm\n"),
            ("    runs-on: ubuntu-latest\n", "    runs-on: macos-latest\n"),
            ("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    container: node:24\n")):
            with self.assertRaises(SystemExit): module.check_runner_action_bootstrap(text.replace(old, new, 1), module.CI_JOBS)

    def test_npm_bootstrap_contract_retains_explicit_successful_verify_dependency(self):
        module = contract()
        text = WORKFLOWS[1].read_text()
        for old, new in (("    needs: verify\n", ""),
                         ("inputs.publish && needs.verify.result == 'success'", "inputs.publish")):
            with self.assertRaises(SystemExit):
                module.check_runner_action_bootstrap(text.replace(old, new, 1), ("verify", "publish"), npm=True)

    def test_orientation_upload_requires_bootstrap_success_but_survives_later_test_failure(self):
        module = contract()
        text = WORKFLOWS[0].read_text()
        condition = "!cancelled() && steps.runner_action_node.outcome == 'success'"
        self.assertIn("if: ${{ " + condition + " }}", module.job_block(text, "orientation-proof"))
        with self.assertRaises(SystemExit):
            module.check_runner_action_bootstrap(text.replace(condition, "!cancelled()", 1), module.CI_JOBS)
        # Interpret only the exact admitted expression. This is an offline condition
        # boundary test, not execution of GitHub's runner or artifact action.
        terms = {"!cancelled()": True, "steps.runner_action_node.outcome == 'success'": True}
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "orientation-upload"
            later_test_failed = True
            if all(terms[part.strip()] for part in condition.split("&&")): marker.write_text("uploaded")
            self.assertTrue(later_test_failed)
            self.assertTrue(marker.exists())
            marker.unlink()
            terms["steps.runner_action_node.outcome == 'success'"] = False
            if all(terms[part.strip()] for part in condition.split("&&")): marker.write_text("uploaded")
            self.assertFalse(marker.exists())



class OwningWorkerBoundaryTests(unittest.TestCase):
    def all_sources(self):
        auxiliary = (ROOT / ".github/workflows" / name for name in ("review-gate.yml", "steward.yml", "track-stats.yml"))
        return sources() + [(path.name, inline_source(path.read_text())) for path in auxiliary]

    def test_protected_or_second_worker_above_owner_is_outside_the_boundary(self):
        for name, source in self.all_sources():
            module = load_source(source)
            for system in ("linux", "win32"):
                for above in ("protected", "another-worker"):
                    chain = process_chain(Path("/runner"), system)
                    chain[1]["exe"] = chain[20]["exe"]
                    calls = []
                    def read(pid):
                        calls.append(pid)
                        if above == "protected" and pid == 1:
                            raise PermissionError("protected service ancestor")
                        return dict(chain[pid])
                    with self.subTest(source=name, system=system, above=above):
                        worker, prefix = module.discover_worker(30, read, system)
                        self.assertEqual(worker, chain[20])
                        self.assertEqual([item["pid"] for item in prefix], [30, 20])
                        self.assertEqual(calls, [30, 20, 30, 20])
                        root, node = module.runner_paths(worker, system)
                        self.assertEqual(root, r"C:\runner" if system == "win32" else "/runner")
                        self.assertEqual(node, r"C:\runner\externals\node24\bin\node.exe" if system == "win32" else "/runner/externals/node24/bin/node")

    def test_unreadable_stale_reused_or_changed_relevant_prefix_refuses(self):
        for name, source in self.all_sources():
            module = load_source(source)
            for system in ("linux", "win32"):
                for selected in (30, 20):
                    for mode in ("unreadable", "stale", "created", "ppid", "exe", "bad-pid", "zero-created", "negative-parent", "relative-exe"):
                        chain = process_chain(Path("/runner"), system)
                        calls = {}
                        def read(pid):
                            calls[pid] = calls.get(pid, 0) + 1
                            item = dict(chain[pid])
                            if pid == selected:
                                if mode == "unreadable": raise PermissionError("prefix denied")
                                if mode == "stale" and calls[pid] > 1: raise FileNotFoundError("prefix disappeared")
                                if mode in ("created", "ppid", "exe") and calls[pid] > 1:
                                    item[mode] = item[mode] + 1 if mode != "exe" else item[mode] + ".changed"
                                if mode == "bad-pid": item["pid"] += 1
                                if mode == "zero-created": item["created"] = 0
                                if mode == "negative-parent": item["ppid"] = -1
                                if mode == "relative-exe": item["exe"] = "relative/executable"
                            return item
                        with self.subTest(source=name, system=system, selected=selected, mode=mode), self.assertRaises((RuntimeError, OSError)):
                            module.discover_worker(30, read, system)

    def test_missing_cyclic_deep_and_bad_owner_layout_refuse_without_fallback(self):
        for name, source in self.all_sources():
            module = load_source(source)
            for system in ("linux", "win32"):
                for mode in ("missing", "self-is-not-owner", "cycle", "owner-parent-cycle", "deep", "bad-owner-path"):
                    chain = process_chain(Path("/runner"), system)
                    chain[1]["exe"] = chain[20]["exe"]
                    if mode in ("missing", "self-is-not-owner", "cycle", "deep"):
                        chain[20]["exe"] = chain[30]["exe"]
                        chain[1]["exe"] = chain[30]["exe"]
                    if mode == "self-is-not-owner":
                        chain[30]["exe"] = r"C:\runner\bin\Runner.Worker.exe" if system == "win32" else "/runner/bin/Runner.Worker"
                    if mode == "cycle": chain[20]["ppid"] = 30
                    if mode == "owner-parent-cycle": chain[20]["ppid"] = 30
                    if mode == "bad-owner-path":
                        chain[20]["exe"] = r"C:\other\Runner.Worker.exe" if system == "win32" else "/other/Runner.Worker"
                    calls = []
                    def read(pid):
                        calls.append(pid)
                        return dict(chain[pid])
                    with self.subTest(source=name, system=system, mode=mode), mock.patch.object(module, "MAX_ANCESTORS", 2 if mode == "deep" else 64), self.assertRaises(RuntimeError):
                        module.discover_worker(30, read, system)
                    if mode in ("owner-parent-cycle", "bad-owner-path"):
                        self.assertNotIn(1, calls, "a bad nearest Worker must not fall back to a higher Worker")

    @unittest.skipUnless(sys.platform == "linux", "full ELF collector fixture uses native Linux paths")
    def test_actual_collector_keeps_runtime_checks_and_final_prefix_revalidation(self):
        for name, source in self.all_sources():
            for mode in ("fixed", "prefix-changed-after-probe", "worker-changed-after-probe", "affected-node"):
                module = load_source(source)
                with self.subTest(source=name, mode=mode), tempfile.TemporaryDirectory() as directory:
                    with controlled_runner(module, directory) as (root, worker, interpreter, chain, probing):
                        calls = []
                        def read(pid):
                            calls.append(pid)
                            if pid == 1: raise PermissionError("protected service ancestor")
                            return dict(chain[pid])
                        if mode == "prefix-changed-after-probe":
                            def change(*args):
                                chain[30]["created"] += 1
                                return "v24.22.1"
                            probing.side_effect = change
                        if mode == "worker-changed-after-probe":
                            def change_worker(*args):
                                worker.write_bytes(elf() + b"changed worker bytes")
                                return "v24.22.1"
                            probing.side_effect = change_worker
                        if mode == "affected-node": probing.return_value = "v24.22.0"
                        with mock.patch.object(module, "linux_process", side_effect=read):
                            if mode == "fixed":
                                actual = module.check_runner_action_node()
                                self.assertEqual(actual["interpreter"], str(interpreter))
                                self.assertEqual(actual["sha256"], module.sha256(interpreter))
                                self.assertEqual(actual["workerSha256"], module.sha256(worker))
                                self.assertEqual(actual["version"], "24.22.1")
                                self.assertEqual(calls, [30, 20, 30, 20, 30, 20])
                            else:
                                with self.assertRaises(RuntimeError): module.check_runner_action_node()
                        self.assertNotIn(1, calls)
                        probing.assert_called_once_with(interpreter, {"LANG": "C", "LC_ALL": "C"})



class RunnerNumericDiagnosticTests(unittest.TestCase):
    def all_sources(self):
        auxiliary = (ROOT / ".github/workflows" / name for name in ("review-gate.yml", "steward.yml", "track-stats.yml"))
        return sources() + [(path.name, inline_source(path.read_text())) for path in auxiliary]

    def test_actual_policy_refusal_reports_only_bounded_canonical_observed_version(self):
        for name, source in self.all_sources():
            module = load_source(source)
            for value in ("24.22.0", "v24.19.0", "22.23.4", "26.12.1", "18.99.0",
                          "9999999999.9999999999.9999999999"):
                observed = value.removeprefix("v")
                stdout, stderr = io.StringIO(), io.StringIO()
                with self.subTest(source=name, value=value), \
                     mock.patch.object(module, "check_runner_action_node", side_effect=lambda: module.node_version(value, selected_major=24)), \
                     mock.patch.object(module.subprocess, "Popen", side_effect=AssertionError("no provider probe")) as probe, \
                     contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(module.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "Runner action Node: admission failed (phase=interpreter-version, exception=RuntimeError, observedNode=" + observed + ", requiredNode=24.22.1)\n")
                probe.assert_not_called()
            self.assertEqual(module.node_version("v24.22.1", selected_major=24), "24.22.1")
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.object(module, "check_runner_action_node", return_value={"version": "24.22.1"}), \
                 mock.patch.object(module, "admission_failure", side_effect=AssertionError("success must not format a refusal")), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(module.main(), 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"version": "24.22.1"})
            self.assertEqual(stderr.getvalue(), "")

    def test_malformed_malicious_unicode_subclass_and_oversized_versions_remain_redacted(self):
        class StringSubclass(str):
            pass
        values = (None, {}, [], b"24.22.0", 24, "", "24.022.0", "24.22", "24.22.0-rc.1",
                  "24.22.0+private", "24.22.0\nPRIVATE_PATH", "/private/node24.22.0", "24.2２.0",
                  "24.22.0\x00PRIVATE", "v9999999999.9999999999.9999999999", "9" * 40 + ".0.0",
                  StringSubclass("24.22.0"))
        for name, source in self.all_sources():
            module = load_source(source)
            for value in values:
                stdout, stderr = io.StringIO(), io.StringIO()
                with self.subTest(source=name, kind=type(value).__name__), \
                     mock.patch.object(module, "check_runner_action_node", side_effect=lambda: module.node_version(value, selected_major=24)), \
                     mock.patch.object(module.subprocess, "Popen", side_effect=AssertionError("no provider probe")) as probe, \
                     contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(module.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "Runner action Node: admission failed (phase=interpreter-version, exception=RuntimeError)\n")
                probe.assert_not_called()

    def test_foreign_same_name_frames_unselected_policy_and_nonpolicy_errors_stay_redacted(self):
        def node_version(value, selected_major=None):
            raise RuntimeError("PRIVATE_PATH 24.22.0 ENV=secret")
        class DeniedFloors(dict):
            def __contains__(self, key):
                raise PermissionError("PRIVATE_FLOOR_METADATA")
        for name, source in self.all_sources():
            module = load_source(source)
            generic = RuntimeError("PRIVATE 24.22.0")
            generic.observedNode = "24.22.0"
            calls = ((lambda: node_version("24.22.0", selected_major=24), "interpreter-version", "RuntimeError", False),
                     (lambda: module.node_version("18.99.0"), "interpreter-version", "RuntimeError", False),
                     (lambda: module.node_version("24.22.0", selected_major="24"), "interpreter-version", "RuntimeError", False),
                     (lambda: module.node_version("24.22.0", selected_major=24), "interpreter-version", "PermissionError", True),
                     (generic, "admission", "RuntimeError", False))
            for call, phase, error_class, denied in calls:
                stdout, stderr = io.StringIO(), io.StringIO()
                with self.subTest(source=name, phase=phase, error=error_class), contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.object(module, "check_runner_action_node", side_effect=call))
                    stack.enter_context(mock.patch.object(module.subprocess, "Popen", side_effect=AssertionError("no provider probe")))
                    stack.enter_context(contextlib.redirect_stdout(stdout))
                    stack.enter_context(contextlib.redirect_stderr(stderr))
                    if denied:
                        stack.enter_context(mock.patch.object(module, "FLOORS", DeniedFloors(module.FLOORS)))
                    self.assertEqual(module.main(), 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), f"Runner action Node: admission failed (phase={phase}, exception={error_class})\n")


if __name__ == "__main__":
    unittest.main()
