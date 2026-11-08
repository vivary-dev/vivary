"""Network-free tests for the executing interpreter's pip admission."""

from contextlib import redirect_stdout
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import ssl
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


GUARD = Path(__file__).resolve().parents[1] / "check_pip_runtime.py"
SPEC = importlib.util.spec_from_file_location("pip_runtime_guard", GUARD)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
CA_VARIABLES = {"PIP_CERT", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"}


class StableVersionTests(unittest.TestCase):
    def test_minimum_and_future_stable_versions(self):
        for value, expected in (
            ("26.2.2", (26, 2, 2)),
            ("26.2.3", (26, 2, 3)),
            ("26.3", (26, 3, 0)),
            ("26.3.0", (26, 3, 0)),
            ("27.0", (27, 0, 0)),
        ):
            with self.subTest(value=value):
                self.assertEqual(guard.stable_version(value), expected)

    def test_old_or_unknown_versions_fail_closed(self):
        for value in (
            "26.2.1", "26.2", "25.3.1", "0.0", "26", "26.2.2.0",
            "26.2.2rc1", "26.2.2a1", "26.2.2.dev1", "26.2.2.post1",
            "26.2.2+local", "v26.2.2", "26.02.2", "026.2.2", "26.2.02",
            "26.3.", " 26.2.2", "26.2.2\n", "", None, 26.3, (26, 3),
        ):
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    guard.stable_version(value)


class PipRuntimeTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {name: value for name, value in os.environ.items()
                                                   if name not in CA_VARIABLES}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.executable = self.root / "python"
        self.module = self.root / "pip" / "__init__.py"
        self.main_module = self.root / "pip" / "__main__.py"
        self.module.parent.mkdir()
        for path in (self.executable, self.module, self.main_module):
            path.write_text("", encoding="utf-8")
        self.pip = SimpleNamespace(__version__="26.2.2", __file__=str(self.module))
        self.distribution = SimpleNamespace(
            version="26.2.2", locate_file=lambda name: self.root / name
        )
        self.certifi_module = self.root / "pip/_vendor/certifi/__init__.py"
        self.certifi_module.parent.mkdir(parents=True)
        self.certifi_module.write_text("")
        self.ca = self.certifi_module.with_name("cacert.pem")
        self.ca.write_bytes(b"inert qualified CA fixture")
        self.certifi = SimpleNamespace(__version__="2026.10.23", __file__=str(self.certifi_module), where=lambda: str(self.ca))
        self.config_items = []
        loaded = self
        class FakeConfiguration:
            def __init__(self, isolated):
                loaded.config_isolated = isolated
            def load(self):
                pass
            def items(self):
                # Real pip groups keys by source: [(source, {"section.option": value})].
                return [(source, dict(values)) for source, values in loaded.config_items]
        self.configuration = SimpleNamespace(Configuration=FakeConfiguration)
        modules = {"pip": self.pip, "pip._internal.configuration": self.configuration}
        self.import_pip = mock.Mock(side_effect=lambda name: modules.get(name, self.certifi))
        policy = mock.patch.dict(guard.CA_POLICY, CERTIFI_CA_SHA256=guard.hashlib.sha256(self.ca.read_bytes()).hexdigest())
        policy.start()
        self.addCleanup(policy.stop)
        self.find_distribution = mock.Mock(return_value=self.distribution)
        self.main_spec = mock.Mock(return_value=SimpleNamespace(origin=str(self.main_module)))
        fake_importlib = SimpleNamespace(
            import_module=self.import_pip,
            metadata=SimpleNamespace(distribution=self.find_distribution),
            util=SimpleNamespace(find_spec=self.main_spec),
        )
        self.runtime = SimpleNamespace(
            flags=SimpleNamespace(isolated=1), executable=str(self.executable),
            argv=[str(GUARD)], stderr=io.StringIO(),
        )
        for name, value in (("importlib", fake_importlib), ("sys", self.runtime)):
            patch = mock.patch.object(guard, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_matching_loaded_pip_and_entrypoint_pass(self):
        result = guard.assert_pip_runtime()
        self.assertEqual(result, {
            "python": str(self.executable.resolve()), "pip": "26.2.2",
            "module": str(self.module.resolve()), "main": str(self.main_module.resolve()),
            "certifi": "2026.10.23", "ca": str(self.ca),
        })
        self.assertEqual(self.import_pip.call_args_list, [mock.call("pip"), mock.call("pip._vendor.certifi"),
                                                          mock.call("pip._internal.configuration")])
        self.assertIs(self.config_isolated, False)
        self.find_distribution.assert_called_once_with("pip")
        self.main_spec.assert_called_once_with("pip.__main__")

    def test_pip_configuration_cannot_change_trusted_hosts_indexes_or_certificates(self):
        for key in (":env:.trusted-host", "global.index-url", "install.extra-index-url", ":env:.find-links",
                    ":env:.client-cert", "global.cert", "user.cert"):
            source = ":env:" if key.startswith(":env:") else "/etc/pip.conf"
            self.config_items = [(":env:", {":env:.use-deprecated": "legacy-certs"}),
                                 (source, {"global.timeout": "60", key: "fixture"})]
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "pip configuration cannot change"):
                guard.assert_pip_runtime()

    def test_environment_cert_and_unrelated_pip_configuration_are_admitted(self):
        self.config_items = [("/etc/pip.conf", {"global.timeout": "60"}),
                             (":env:", {":env:.cert": "validated by the override check",
                                        ":env:.use-deprecated": "legacy-certs", ":env:.config-file": "/dev/null"})]
        guard.assert_pip_runtime()

    def test_old_or_altered_vendored_certifi_is_refused(self):
        for variant in ("old-version", "changed-ca", "foreign-path"):
            with self.subTest(variant=variant):
                if variant == "old-version":
                    self.certifi.__version__ = "2026.10.19"
                elif variant == "changed-ca":
                    self.certifi.__version__ = "2026.10.23"
                    self.ca.write_bytes(b"changed roots")
                else:
                    self.ca.write_bytes(b"inert qualified CA fixture")
                    self.certifi.__file__ = str(self.module)
                with self.assertRaisesRegex(RuntimeError, "qualified certifi"):
                    guard.assert_pip_runtime()

    def test_each_effective_certificate_override_must_match_the_qualified_ca(self):
        changed = self.root / "unrelated-host-roots.pem"
        changed.write_bytes(b"unrelated CA fixture")
        for name in ("PIP_CERT", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
            with self.subTest(name=name), mock.patch.dict(os.environ, {name: str(changed)}):
                with self.assertRaisesRegex(RuntimeError, "certificate override"):
                    guard.assert_pip_runtime()

    def test_qualified_exact_copies_are_admitted_for_each_effective_override(self):
        copy = self.root / "qualified-copy.pem"
        copy.write_bytes(self.ca.read_bytes())
        for name in ("PIP_CERT", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
            with self.subTest(name=name), mock.patch.dict(os.environ, {name: str(copy)}):
                self.assertEqual(guard.assert_pip_runtime()["ca"], str(self.ca))

    def test_pip_cert_and_requests_effective_bundle_are_independently_admitted(self):
        changed = self.root / "unrelated-host-roots.pem"
        changed.write_bytes(b"unrelated CA fixture")
        for values in ({"PIP_CERT": str(changed), "REQUESTS_CA_BUNDLE": str(self.ca)},
                       {"PIP_CERT": str(self.ca), "REQUESTS_CA_BUNDLE": str(changed)},
                       {"PIP_CERT": str(self.ca), "CURL_CA_BUNDLE": str(changed)}):
            with self.subTest(values=tuple(values)), mock.patch.dict(os.environ, values):
                with self.assertRaisesRegex(RuntimeError, "certificate override"):
                    guard.assert_pip_runtime()

    def test_requests_qualified_bundle_takes_precedence_over_unrelated_curl_bundle(self):
        changed = self.root / "unrelated-host-roots.pem"
        changed.write_bytes(b"unrelated CA fixture")
        with mock.patch.dict(os.environ, REQUESTS_CA_BUNDLE=str(self.ca), CURL_CA_BUNDLE=str(changed)):
            guard.assert_pip_runtime()
        with mock.patch.dict(os.environ, REQUESTS_CA_BUNDLE="", CURL_CA_BUNDLE=str(changed)):
            with self.assertRaisesRegex(RuntimeError, "certificate override"):
                guard.assert_pip_runtime()
        with mock.patch.dict(os.environ, REQUESTS_CA_BUNDLE="", CURL_CA_BUNDLE=str(self.ca)):
            guard.assert_pip_runtime()

    def test_certificate_override_requires_a_plain_absolute_exclusive_file(self):
        copy = self.root / "qualified-copy.pem"
        copy.write_bytes(self.ca.read_bytes())
        alias = self.root / "qualified-alias.pem"
        alias.symlink_to(copy)
        hardlink = self.root / "qualified-hardlink.pem"
        os.link(copy, hardlink)
        for path in (self.root, alias, hardlink, self.root / "missing.pem"):
            with self.subTest(path=path.name), mock.patch.dict(os.environ, PIP_CERT=str(path)):
                with self.assertRaisesRegex(RuntimeError, "certificate override"):
                    guard.assert_pip_runtime()
        # A relative path to a real, unlinked qualified copy must fail on the absolute-path rule itself.
        (self.root / "relative-qualified.pem").write_bytes(self.ca.read_bytes())
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        with mock.patch.dict(os.environ, PIP_CERT="relative-qualified.pem"):
            with self.assertRaisesRegex(RuntimeError, "plain absolute CA file"):
                guard.assert_pip_runtime()

    def test_equivalent_stable_two_component_versions_pass(self):
        self.pip.__version__ = "26.3"
        self.distribution.version = "26.3.0"
        self.assertEqual(guard.assert_pip_runtime()["pip"], "26.3")

    def test_metadata_cannot_admit_an_old_loaded_module(self):
        self.pip.__version__ = "26.2.1"
        with self.assertRaisesRegex(RuntimeError, "26.2.2 or later"):
            guard.assert_pip_runtime()

    def test_different_stable_metadata_version_fails(self):
        self.distribution.version = "26.3"
        with self.assertRaisesRegex(RuntimeError, "versions disagree"):
            guard.assert_pip_runtime()

    def test_old_or_unknown_metadata_fails(self):
        for version in ("26.2.1", "26.3rc1", None):
            with self.subTest(version=version):
                self.distribution.version = version
                with self.assertRaises(RuntimeError):
                    guard.assert_pip_runtime()

    def test_nonisolated_interpreter_fails_before_importing_pip(self):
        self.runtime.flags.isolated = 0
        with self.assertRaisesRegex(RuntimeError, "Python -I"):
            guard.assert_pip_runtime()
        self.import_pip.assert_not_called()

    def test_loaded_package_origin_must_match_distribution(self):
        other = self.root / "other.py"
        other.write_text("", encoding="utf-8")
        self.pip.__file__ = str(other)
        with self.assertRaisesRegex(RuntimeError, "do not match the distribution"):
            guard.assert_pip_runtime()

    def test_executable_module_origin_must_match_distribution(self):
        other = self.root / "other-main.py"
        other.write_text("", encoding="utf-8")
        self.main_spec.return_value = SimpleNamespace(origin=str(other))
        with self.assertRaisesRegex(RuntimeError, "do not match the distribution"):
            guard.assert_pip_runtime()

    def test_unknown_entrypoint_fails(self):
        for spec in (None, SimpleNamespace(origin=None)):
            with self.subTest(spec=spec):
                self.main_spec.return_value = spec
                with self.assertRaisesRegex(RuntimeError, "entrypoint is unavailable"):
                    guard.assert_pip_runtime()

    def test_cli_reports_missing_pip_without_installing_it(self):
        self.import_pip.side_effect = ModuleNotFoundError("missing pip")
        self.assertEqual(guard.main(), 1)
        self.assertIn("required runtime evidence is unavailable", self.runtime.stderr.getvalue())

    def test_cli_rejects_missing_origin_evidence(self):
        self.module.unlink()
        self.assertEqual(guard.main(), 1)
        self.assertIn("required runtime evidence is unavailable", self.runtime.stderr.getvalue())

    def test_cli_rejects_caller_supplied_facts_before_import(self):
        self.runtime.argv.append("--pip-version=26.3")
        self.assertEqual(guard.main(), 1)
        self.assertIn("accepts no caller-supplied", self.runtime.stderr.getvalue())
        self.import_pip.assert_not_called()

    def test_cli_prints_observed_runtime_on_success(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(guard.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["pip"], "26.2.2")
        self.assertEqual(self.runtime.stderr.getvalue(), "")


class ActualPipConfigurationTests(unittest.TestCase):
    def test_actual_pip_configuration_files_and_variables_are_refused(self):
        # The real Configuration groups keys by source. A flat fixture cannot prove the walk.
        try:
            qualified = importlib.metadata.distribution("pip").version == "26.2.2"
        except importlib.metadata.PackageNotFoundError:
            qualified = False
        if not qualified:
            self.skipTest("actual pip 26.2.2 is unavailable")
        configuration = importlib.import_module("pip._internal.configuration")
        clean = {name: value for name, value in os.environ.items() if not name.startswith("PIP_")}
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "pip.conf"
            config.write_text("[global]\ntimeout = 60\n", encoding="utf-8")
            admitted = {"PIP_CONFIG_FILE": str(config), "PIP_CERT": "validated by the override check",
                        "PIP_USE_DEPRECATED": "legacy-certs"}
            # The harmless file is really loaded, so a walk that refused every file key would fail here.
            with mock.patch.dict(os.environ, {**clean, **admitted}, clear=True):
                guard.assert_pip_configuration(configuration)
                loaded = configuration.Configuration(isolated=False)
                loaded.load()
                self.assertIn((str(config), {"global.timeout": "60"}), list(loaded.items()))
            for name, value in (("PIP_TRUSTED_HOST", "evil.example"), ("PIP_INDEX_URL", "https://evil.example/simple"),
                                ("PIP_EXTRA_INDEX_URL", "https://evil.example/simple"), ("PIP_FIND_LINKS", "https://evil.example/"),
                                ("PIP_CLIENT_CERT", "/client.pem")):
                with self.subTest(variable=name), mock.patch.dict(os.environ, {**clean, "PIP_CONFIG_FILE": os.devnull, name: value},
                                                                  clear=True):
                    with self.assertRaisesRegex(RuntimeError, "pip configuration cannot change.* from :env:"):
                        guard.assert_pip_configuration(configuration)
            for section, option in (("global", "index-url"), ("install", "trusted-host"), ("global", "cert")):
                config.write_text(f"[{section}]\n{option} = https://evil.example/\n", encoding="utf-8")
                with self.subTest(file=f"{section}.{option}"), mock.patch.dict(os.environ, {**clean, **admitted}, clear=True):
                    with self.assertRaisesRegex(RuntimeError, re.escape(f"{section}.{option} from {config}")):
                        guard.assert_pip_configuration(configuration)


class ActualPipRequestsTests(unittest.TestCase):
    def test_qualified_actual_session_uses_the_same_environment_precedence_offline(self):
        # Inspect local metadata/CA bytes before importing the optional real pip.
        # This is an offline settings test, not a TLS handshake or CI-pass claim.
        if (sys.implementation.name != "cpython" or tuple(sys.version_info) != (3, 12, 15, "final", 0)
                or ssl.OPENSSL_VERSION.split()[:2] != ["OpenSSL", "3.5.9"] or not sys.flags.isolated):
            self.skipTest("actual session test requires the qualified isolated CPython/OpenSSL runtime")
        try:
            distribution = importlib.metadata.distribution("pip")
            ca = Path(distribution.locate_file("pip/_vendor/certifi/cacert.pem"))
            qualified = (distribution.version == "26.2.2" and ca.is_file()
                         and guard.hashlib.sha256(ca.read_bytes()).hexdigest() == guard.CA_POLICY["CERTIFI_CA_SHA256"])
        except (OSError, importlib.metadata.PackageNotFoundError):
            qualified = False
        if not qualified:
            self.skipTest("actual pip 26.2.2 with the qualified certifi overlay is unavailable")
        clean = {name: value for name, value in os.environ.items() if name not in CA_VARIABLES}
        with mock.patch.dict(os.environ, clean, clear=True), tempfile.TemporaryDirectory() as temporary:
            guard.assert_pip_runtime()
            session_type = importlib.import_module("pip._internal.network.session").PipSession
            copy, changed = Path(temporary) / "qualified.pem", Path(temporary) / "unrelated.pem"
            copy.write_bytes(ca.read_bytes())
            changed.write_bytes(b"unrelated CA fixture")
            with session_type(retries=0) as session, \
                    mock.patch.object(session_type, "send", side_effect=AssertionError("offline settings test cannot network")) as send:
                settings = lambda: session.merge_environment_settings("https://example.invalid/", {}, None, None, None)["verify"]
                self.assertIs(settings(), True)
                with mock.patch.dict(os.environ, CURL_CA_BUNDLE=str(changed)):
                    self.assertEqual(settings(), str(changed))
                    with self.assertRaisesRegex(RuntimeError, "certificate override"):
                        guard.assert_pip_runtime()
                with mock.patch.dict(os.environ, REQUESTS_CA_BUNDLE=str(copy), CURL_CA_BUNDLE=str(changed)):
                    self.assertEqual(settings(), str(copy))
                    guard.assert_pip_runtime()
                # Requests can override pip's explicit session CA as well.
                session.verify = str(copy)
                with mock.patch.dict(os.environ, PIP_CERT=str(copy), CURL_CA_BUNDLE=str(changed)):
                    self.assertEqual(settings(), str(changed))
                    with self.assertRaisesRegex(RuntimeError, "certificate override"):
                        guard.assert_pip_runtime()
                send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
