"""Offline safety fixtures for authenticated task-local Python provisioning."""

import hashlib
import importlib.util
import io
import os
from pathlib import Path
import struct
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / "bootstrap_ci_python.py"


def load():
    spec = importlib.util.spec_from_file_location("ci_python_fixture", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def executable(machine=62):
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", data, 18, machine)
    return bytes(data) + b"inert Python fixture; never executed"


def archive(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz") as output:
        for name, data, link in entries:
            member = tarfile.TarInfo(name)
            member.mode = 0o755
            if link is not None:
                member.type, member.linkname = tarfile.SYMTYPE, link
            else:
                member.size = len(data)
            output.addfile(member, io.BytesIO(data) if link is None else None)
    return result.getvalue()


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.target = self.root / "runtime"
        self.target.mkdir()
        self.archive = self.root / "python.tar.gz"
        self.node = executable()

    def fixture(self, entries=None):
        data = archive(entries or [("python/bin/python3.12", self.node, None),
                                   ("python/bin/python", b"", "python3.12")])
        self.archive.write_bytes(data)
        return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "executable": "python/bin/python3.12", "executable_sha256": hashlib.sha256(self.node).hexdigest()}

    def test_authenticated_native_files_and_internal_alias_extract_privately(self):
        asset = self.fixture()
        actual = self.module.unpack(self.archive, self.target, asset, "linux")
        self.assertEqual(actual.read_bytes(), self.node)
        self.assertEqual((self.target / "python/bin/python").resolve(), actual)

    def test_modified_archive_refuses_before_parser_or_destination_writes(self):
        asset = self.fixture()
        self.archive.write_bytes(self.archive.read_bytes() + b"changed")
        with mock.patch.object(self.module.tarfile, "open") as opening:
            with self.assertRaisesRegex(ValueError, "SHA256"):
                self.module.unpack(self.archive, self.target, asset, "linux")
        opening.assert_not_called()
        self.assertEqual(list(self.target.iterdir()), [])

    def test_traversal_links_duplicates_and_writes_through_aliases_are_refused(self):
        for entries in (
            [("../outside", b"inert", None)],
            [("python/bin/alias", b"", "../../../outside")],
            [("python/file", b"a", None), ("python/file", b"b", None)],
            [("python/alias", b"", "real"), ("python/alias/file", b"a", None)],
            [("python/escape:stream", b"a", None)],
        ):
            with self.subTest(entries=entries):
                asset = self.fixture(entries)
                with self.assertRaises(ValueError):
                    self.module.unpack(self.archive, self.target, asset, "linux")
                self.assertEqual(list(self.target.iterdir()), [])

    def test_authenticated_wrong_architecture_and_executable_hash_are_refused(self):
        self.node = executable(183)
        asset = self.fixture()
        with self.assertRaisesRegex(ValueError, "native x64"):
            self.module.unpack(self.archive, self.target, asset, "linux")
        other = self.root / "other"
        other.mkdir()
        asset["executable_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "qualified executable"):
            self.module.unpack(self.archive, other, asset, "linux")

    def test_download_cache_cannot_silently_reuse_changed_bytes_or_symlinks(self):
        self.archive.write_bytes(b"changed cache")
        with mock.patch.object(self.module.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                self.module.download("https://github.com/fixed", self.archive, 1, "0" * 64)
        run.assert_not_called()
        alias = self.root / "archive-alias"
        alias.symlink_to(self.archive)
        with self.assertRaises(ValueError):
            self.module.download("https://github.com/fixed", alias, 13, hashlib.sha256(b"changed cache").hexdigest())

    def test_native_downloader_preserves_tls_and_bounds_without_inherited_injection(self):
        target = self.root / "download"
        payload = b"authenticated fixture"
        def curl(arguments, **options):
            self.assertEqual(arguments[:2], ["/usr/bin/curl", "--disable"])
            self.assertEqual(arguments[arguments.index("--proto") + 1], "=https")
            self.assertEqual(arguments[arguments.index("--proto-redir") + 1], "=https")
            self.assertEqual(arguments[arguments.index("--max-filesize") + 1], str(len(payload)))
            self.assertEqual(arguments[arguments.index("--max-redirs") + 1], "3")
            self.assertNotIn("--insecure", arguments)
            self.assertNotIn("LD_PRELOAD", options["env"])
            self.assertNotIn("PYTHONPATH", options["env"])
            self.assertFalse(options.get("shell", False))
            Path(arguments[arguments.index("--output") + 1]).write_bytes(payload)
            return SimpleNamespace(returncode=0)
        with mock.patch.dict(os.environ, LD_PRELOAD="private", PYTHONPATH="private"), \
                mock.patch.object(self.module.subprocess, "run", side_effect=curl):
            self.module.download("https://github.com/fixed", target, len(payload), hashlib.sha256(payload).hexdigest())

    def test_caller_arguments_cannot_select_runtime_artifacts_or_export_paths(self):
        with mock.patch.object(self.module.sys, "argv", [str(HELPER), "--url", "private"]), \
                mock.patch.object(self.module, "provision_python") as provisioning:
            self.assertEqual(self.module.main(), 1)
        provisioning.assert_not_called()

    def seed_fixture(self):
        library = self.target / "python/lib/python3.12"
        bundled = library / "ensurepip/_bundled"
        bundled.mkdir(parents=True)
        marker = library / "ensurepip/__init__.py"
        marker.write_text('_PIP_VERSION = "26.2.2"\n')
        payload = b"authenticated inert pip seed".ljust(1819850, b"\0")
        seed = bundled / self.module.CA_POLICY["PIP_WHEEL"]
        seed.write_bytes(payload)
        self.module.CA_POLICY["PIP_SHA256"] = hashlib.sha256(payload).hexdigest()
        return seed, marker

    def test_seed_is_authenticated_before_derivation_and_atomically_replaced(self):
        seed, _ = self.seed_fixture()
        original = seed.read_bytes()
        overlay = b"inert authenticated certifi overlay fixture"
        def derive(upstream, certifi, target):
            self.assertEqual(upstream.read_bytes(), original)
            self.assertEqual(seed.read_bytes(), original)
            target.write_bytes(overlay)
            return target
        with mock.patch.object(self.module, "download", return_value=self.root / "certifi.whl"), \
                mock.patch.dict(self.module.CA_POLICY, prepare_pip=derive):
            digest = self.module.patch_seed(self.target, self.root, "linux")
        self.assertEqual(seed.read_bytes(), overlay)
        self.assertEqual(digest, hashlib.sha256(overlay).hexdigest())
        self.assertFalse((seed.parent / ".vivary-qualified-pip-seed").exists())

    def test_changed_retained_seed_marker_or_inventory_refuses_before_download_or_derivation(self):
        seed, marker = self.seed_fixture()
        original = seed.read_bytes()
        for changed in ("marker", "wheel", "inventory"):
            with self.subTest(changed=changed):
                seed.write_bytes(original)
                marker.write_text('_PIP_VERSION = "26.2.2"\n')
                extra = seed.parent / "unexpected.whl"
                extra.unlink(missing_ok=True)
                if changed == "marker":
                    marker.write_text('_PIP_VERSION = "26.0.1"\n')
                elif changed == "wheel":
                    seed.write_bytes(b"modified seed")
                else:
                    extra.write_bytes(b"extra wheel")
                before = seed.read_bytes()
                with mock.patch.object(self.module, "download") as download, \
                        mock.patch.dict(self.module.CA_POLICY, prepare_pip=mock.Mock()) as policy:
                    with self.assertRaisesRegex(ValueError, "retained ensurepip seed"):
                        self.module.patch_seed(self.target, self.root, "linux")
                    download.assert_not_called()
                    policy["prepare_pip"].assert_not_called()
                self.assertEqual(seed.read_bytes(), before)

    def test_failed_preparation_never_exports_or_retains_an_unqualified_runtime(self):
        export = self.root / "github-path"
        export.touch()
        environment = self.root / "github-env"
        environment.touch()
        with mock.patch.dict(os.environ, RUNNER_TEMP=str(self.root), GITHUB_PATH=str(export), GITHUB_ENV=str(environment)), \
                mock.patch.object(self.module, "download", side_effect=ValueError("fixture refusal")) as download:
            with self.assertRaisesRegex(ValueError, "^fixture refusal$"):
                self.module.provision_python()
        # The refusal must come from the download, past the runtime guard, and
        # the private prefix it was writing into must be gone.
        download.assert_called_once()
        self.assertFalse(download.call_args.args[1].parent.exists())
        self.assertEqual(export.read_text(), "")
        self.assertEqual(environment.read_text(), "")
        self.assertEqual(list(self.root.glob("vivary-python-3.12.15-*")), [])

    def test_exports_only_prepared_private_runtime_and_filtered_trust_with_empty_ca_directory(self):
        export, environment = self.root / "github-path", self.root / "github-env"
        export.touch(); environment.touch()
        trust = b"inert eligible filtered host anchors"
        pip_trust = b"inert authenticated certifi anchors"
        certifi = self.root / "vivary-pip-26.2.2" / self.module.CA_POLICY["CERTIFI_WHEEL"]
        certifi.parent.mkdir()
        certifi.write_bytes(b"authenticated certifi wheel fixture")
        def extracted(archive, runtime, asset, system):
            executable = runtime / "python/bin/python3.12"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(self.node)
            return executable
        with mock.patch.dict(os.environ, RUNNER_TEMP=str(self.root), GITHUB_PATH=str(export), GITHUB_ENV=str(environment)), \
                mock.patch.object(self.module, "download", return_value=self.archive), \
                mock.patch.object(self.module, "unpack", side_effect=extracted), \
                mock.patch.object(self.module, "patch_seed", return_value="authenticated-seed-fixture"), \
                mock.patch.dict(self.module.CA_POLICY, host_ca_bytes=lambda: trust,
                                certifi_ca_bytes=lambda data: pip_trust if data == certifi.read_bytes() else self.fail("wrong wheel")):
            receipt = self.module.provision_python()
        values = dict(line.split("=", 1) for line in environment.read_text().splitlines())
        self.assertEqual(set(values), {"SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"})
        bundle = Path(values["SSL_CERT_FILE"])
        self.assertEqual(bundle.read_bytes(), trust)
        self.assertEqual(bundle.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(Path(values["SSL_CERT_DIR"]).iterdir()), [])
        self.assertEqual({values[name] for name in ("SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO")}, {str(bundle)})
        pip_bundle = Path(values["PIP_CERT"])
        self.assertNotEqual(pip_bundle, bundle)
        self.assertEqual(values["REQUESTS_CA_BUNDLE"], str(pip_bundle))
        self.assertEqual(pip_bundle.read_bytes(), pip_trust)
        self.assertEqual(pip_bundle.stat().st_mode & 0o777, 0o600)
        self.assertEqual(export.read_text().splitlines(), [str(Path(receipt["python"]).parent)])
        self.assertEqual(receipt["trustSha256"], hashlib.sha256(trust).hexdigest())
        self.assertEqual(receipt["pipTrustSha256"], hashlib.sha256(pip_trust).hexdigest())


if __name__ == "__main__":
    unittest.main()
