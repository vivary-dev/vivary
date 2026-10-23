"""Network-free checks for the exact executing Python/OpenSSL admission."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


GUARD = Path(__file__).resolve().parents[1] / "check_python_runtime.py"
SPEC = importlib.util.spec_from_file_location("python_runtime_guard", GUARD)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class PythonRuntimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.executable = Path(directory.name) / "python"
        self.executable.write_bytes(b"inert executable fixture")
        self.runtime = SimpleNamespace(
            flags=SimpleNamespace(isolated=1, dont_write_bytecode=1),
            implementation=SimpleNamespace(name="cpython"),
            version_info=(3, 12, 15, "final", 0), executable=str(self.executable),
            argv=[str(GUARD)], stderr=io.StringIO(),
        )
        self.ssl = SimpleNamespace(OPENSSL_VERSION="OpenSSL 3.5.9 29 Sep 2026")
        for name, value in (("sys", self.runtime), ("ssl", self.ssl)):
            patch = mock.patch.object(guard, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_exact_current_runtime_reports_its_actual_executable(self):
        self.assertEqual(guard.assert_python_runtime(), {
            "python": str(self.executable.resolve()), "implementation": "CPython",
            "version": "3.12.15", "openssl": self.ssl.OPENSSL_VERSION,
        })

    def test_other_patch_lines_and_unqualified_future_releases_are_refused(self):
        for value in ((3, 11, 15, "final", 0), (3, 12, 14, "final", 0),
                      (3, 12, 16, "final", 0), (3, 13, 9, "final", 0),
                      (3, 12, 15, "candidate", 1), (3, 12, 15, "alpha", 1),
                      (3, 12, 15, "final", 1)):
            with self.subTest(version=value):
                self.runtime.version_info = value
                with self.assertRaisesRegex(RuntimeError, "CPython 3.12.15 final"):
                    guard.assert_python_runtime()

    def test_another_python_implementation_cannot_reuse_the_version(self):
        self.runtime.implementation.name = "pypy"
        with self.assertRaisesRegex(RuntimeError, "CPython"):
            guard.assert_python_runtime()

    def test_loaded_openssl_must_match_the_qualified_release(self):
        for value in ("OpenSSL 3.5.8 1 Jul 2026", "OpenSSL 3.5.10 1 Nov 2026",
                      "OpenSSL 3.6.0 1 Nov 2026", "OpenSSL 3.5.9-dev",
                      "LibreSSL 3.5.9", "", None):
            with self.subTest(openssl=value):
                self.ssl.OPENSSL_VERSION = value
                self.assertEqual(guard.main(), 1)

    def test_isolation_and_bytecode_suppression_are_required(self):
        for name in ("isolated", "dont_write_bytecode"):
            with self.subTest(flag=name):
                with mock.patch.object(self.runtime.flags, name, 0):
                    with self.assertRaisesRegex(RuntimeError, "Python -I -B"):
                        guard.assert_python_runtime()

    def test_missing_or_nonfile_executable_is_refused(self):
        for value in (str(self.executable.parent), str(self.executable.with_name("missing"))):
            with self.subTest(executable=value):
                self.runtime.executable = value
                self.assertEqual(guard.main(), 1)

    def test_cli_rejects_arguments_instead_of_accepting_claimed_runtime_facts(self):
        self.runtime.argv += ["--python", "3.12.15", "--openssl", "3.5.9"]
        with mock.patch.object(guard, "assert_python_runtime") as admission:
            self.assertEqual(guard.main(), 1)
            admission.assert_not_called()

    def test_cli_emits_only_the_actual_admitted_runtime(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(guard.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), guard.assert_python_runtime())


if __name__ == "__main__":
    unittest.main()
