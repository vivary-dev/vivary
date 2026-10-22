"""Network-free command and refusal controls for the fixed CI pip bootstrap."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "bootstrap_ci_pip.py"
SPEC = importlib.util.spec_from_file_location("bootstrap_ci_pip", SOURCE)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_bad_size_or_digest_refuses_before_any_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            wheel = Path(directory) / bootstrap.WHEEL
            for data in (b"", b"old pip bytes", b"x" * bootstrap.SIZE, b"x" * (bootstrap.SIZE + 1)):
                wheel.write_bytes(data)
                with self.subTest(bytes=len(data)), mock.patch.object(bootstrap.subprocess, "run") as child, self.assertRaises(ValueError):
                    bootstrap.verify_wheel(wheel)
                child.assert_not_called()

    def test_existing_reviewed_wheel_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            wheel = cache / bootstrap.WHEEL
            wheel.write_bytes(b"fixed inert fixture")
            with mock.patch.object(bootstrap, "SIZE", wheel.stat().st_size), \
                 mock.patch.object(bootstrap, "SHA256", hashlib.sha256(wheel.read_bytes()).hexdigest()), \
                 mock.patch.object(bootstrap.urllib.request, "build_opener", side_effect=AssertionError("no network")):
                self.assertEqual(bootstrap.obtain_wheel(cache), wheel)

    def test_download_has_fixed_origin_no_proxy_no_redirect_and_exact_byte_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            for mode in ("fixed", "redirect", "status", "oversized", "truncated", "digest", "deadline"):
                cache = Path(directory) / mode
                cache.mkdir()
                class Response(io.BytesIO):
                    status = 200 if mode != "status" else 403
                    headers = {}
                    def geturl(self):
                        return bootstrap.URL if mode != "redirect" else "https://example.invalid/wheel"
                data = b"fixture" if mode not in ("oversized", "truncated") else (b"fixture!" if mode == "oversized" else b"short")
                opener = mock.Mock()
                opener.open.return_value = Response(data)
                with self.subTest(mode=mode), contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.object(bootstrap, "SIZE", 7))
                    stack.enter_context(mock.patch.object(bootstrap, "SHA256", hashlib.sha256(b"fixture").hexdigest() if mode != "digest" else "0" * 64))
                    factory = stack.enter_context(mock.patch.object(bootstrap.urllib.request, "build_opener", return_value=opener))
                    if mode == "deadline":
                        stack.enter_context(mock.patch.object(bootstrap.time, "monotonic", side_effect=(0, 31)))
                    if mode == "fixed":
                        bootstrap.obtain_wheel(cache)
                    else:
                        with self.assertRaises((OSError, ValueError)):
                            bootstrap.obtain_wheel(cache)
                    handlers = factory.call_args.args
                    self.assertEqual(handlers[0].proxies, {})
                    self.assertIsInstance(handlers[1], bootstrap.NoRedirect)
                    self.assertEqual(opener.open.call_args.args[0].full_url, bootstrap.URL)
                    self.assertEqual(opener.open.call_args.kwargs, {"timeout": 10})
            with self.assertRaises(ValueError):
                bootstrap.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid")

    def test_only_exact_target_python_and_verified_wheel_are_executed_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            wheel = temporary / "vivary-pip-26.2.2" / bootstrap.WHEEL
            wheel.parent.mkdir()
            wheel.write_bytes(b"inert verified fixture")
            fixture_size = wheel.stat().st_size
            fixture_sha = hashlib.sha256(wheel.read_bytes()).hexdigest()
            environment = {"RUNNER_TEMP": str(temporary), "PIP_INDEX_URL": "PRIVATE", "PIP_CONFIG_FILE": "PRIVATE",
                           "HTTPS_PROXY": "PRIVATE", "PYTHONPATH": "PRIVATE", "SECRET_TOKEN": "PRIVATE"}
            with mock.patch.object(bootstrap.sys, "argv", [str(SOURCE)]), \
                 mock.patch.dict(bootstrap.os.environ, environment, clear=True), \
                 mock.patch.object(bootstrap, "SIZE", fixture_size), \
                 mock.patch.object(bootstrap, "SHA256", fixture_sha), \
                 mock.patch.object(bootstrap.urllib.request, "build_opener", side_effect=AssertionError("no network")), \
                 mock.patch.object(bootstrap, "verify_wheel", wraps=bootstrap.verify_wheel) as verify, \
                 mock.patch.object(bootstrap.subprocess, "run") as child, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bootstrap.main(), 0)
            argv = child.call_args.args[0]
            self.assertEqual(argv, [sys.executable, "-I", "-B", "-c", bootstrap.WHEEL_ENTRY, str(wheel), "install", "--isolated",
                                   "--no-index", "--no-deps", "--only-binary=:all:", "--no-cache-dir",
                                   "--disable-pip-version-check", "--no-input", "--force-reinstall", str(wheel)])
            clean = child.call_args.kwargs["env"]
            self.assertFalse(any(name in clean for name in ("PIP_INDEX_URL", "HTTPS_PROXY", "PYTHONPATH", "SECRET_TOKEN")))
            self.assertEqual(clean["PIP_CONFIG_FILE"], os.devnull)
            self.assertEqual(child.call_args.kwargs["stdin"], subprocess.DEVNULL)
            self.assertTrue(child.call_args.kwargs["check"])
            self.assertEqual(child.call_args.kwargs["timeout"], 60)
            self.assertEqual(verify.call_args_list, [mock.call(wheel), mock.call(wheel)])

    def test_failed_verification_or_installer_refuses_without_further_action(self):
        with tempfile.TemporaryDirectory() as directory:
            for failure in ("artifact", "installer"):
                temporary = Path(directory) / failure
                cache = temporary / "vivary-pip-26.2.2"
                cache.mkdir(parents=True)
                wheel = cache / bootstrap.WHEEL
                fixed = b"inert verified fixture"
                wheel.write_bytes(b"PRIVATE old wheel" if failure == "artifact" else fixed)
                with self.subTest(failure=failure), mock.patch.object(bootstrap.sys, "argv", [str(SOURCE)]), \
                     mock.patch.dict(bootstrap.os.environ, {"RUNNER_TEMP": str(temporary)}, clear=True), \
                     mock.patch.object(bootstrap, "SIZE", len(fixed)), \
                     mock.patch.object(bootstrap, "SHA256", hashlib.sha256(fixed).hexdigest()), \
                     mock.patch.object(bootstrap.urllib.request, "build_opener", side_effect=AssertionError("no network")), \
                     mock.patch.object(bootstrap.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["PRIVATE"])) as child, \
                     mock.patch.object(bootstrap, "verify_wheel", wraps=bootstrap.verify_wheel) as verify, contextlib.redirect_stderr(io.StringIO()) as stderr:
                    self.assertEqual(bootstrap.main(), 1)
                self.assertNotIn("PRIVATE", stderr.getvalue())
                self.assertEqual(child.call_count, int(failure == "installer"))
                self.assertEqual(verify.call_args_list, [mock.call(wheel)], "failed installation must not reach the post-install verification")


    def inert_pip_wheel(self, temporary):
        wheel = temporary / bootstrap.WHEEL
        # Inert fixture only: reproduce the wheel entry and exact Windows guard
        # predicate, without importing or executing any pip/vendor implementation.
        main = (
            "import json,os,sys\n"
            "if not __spec__ or __spec__.parent == '':\n"
            " sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))\n"
            "import pip\n"
            "pip_names=['pip',f'pip{sys.version_info.major}',f'pip{sys.version_info.major}.{sys.version_info.minor}']\n"
            "if os.path.basename(sys.argv[0]) in pip_names:\n"
            " print('Windows pip self-modification refusal'); sys.exit(23)\n"
            "print(json.dumps({'argv':sys.argv,'module':pip.__file__,'main':__file__,'spec':__spec__.name}))\n"
        )
        with zipfile.ZipFile(wheel, "x") as archive:
            archive.writestr("pip/__init__.py", "# inert test package\n")
            archive.writestr("pip/__main__.py", main)
        return wheel

    def test_module_entry_matches_m_semantics_and_old_windows_entry_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            wheel = self.inert_pip_wheel(temporary)
            poison = temporary / "poison"
            poison.mkdir()
            (poison / "pip.py").write_text("raise AssertionError('ambient pip imported')\n")
            environment = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR") if key in os.environ}
            environment["PYTHONPATH"] = str(poison)
            options = dict(cwd=temporary, env=environment, stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=10)
            legacy = subprocess.run([sys.executable, "-I", "-B", str(wheel) + "/pip", "install"], **options)
            self.assertEqual(legacy.returncode, 23, legacy.stderr)
            self.assertEqual(legacy.stdout.strip(), "Windows pip self-modification refusal")
            fixed = subprocess.run([sys.executable, "-I", "-B", "-c", bootstrap.WHEEL_ENTRY,
                                    str(wheel), "install", "--no-index"], **options)
            self.assertEqual(fixed.returncode, 0, fixed.stderr)
            facts = json.loads(fixed.stdout)
            normalized = lambda value: value.replace("\\", "/")
            self.assertEqual(normalized(facts["module"]), normalized(str(wheel)) + "/pip/__init__.py")
            self.assertEqual(normalized(facts["main"]), normalized(str(wheel)) + "/pip/__main__.py")
            self.assertEqual(facts["argv"], [facts["main"], "install", "--no-index"])
            self.assertEqual(facts["spec"], "pip.__main__")

            for name in ("pip", "pip._internal"):
                with self.subTest(preloaded=name):
                    program = f"import sys,types;sys.modules[{name!r}]=types.ModuleType({name!r})\n" + bootstrap.WHEEL_ENTRY
                    child = subprocess.run([sys.executable, "-I", "-B", "-c", program, str(wheel), "install"],
                                           cwd=temporary, stdin=subprocess.DEVNULL, capture_output=True,
                                           text=True, timeout=10)
                    self.assertNotEqual(child.returncode, 0)
                    self.assertEqual(child.stdout, "")
                    self.assertIn("RuntimeError: pip was loaded before the verified wheel", child.stderr)


if __name__ == "__main__":
    unittest.main()
