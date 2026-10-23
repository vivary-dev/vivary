"""Network-free controls for the internal site's known-version lock admission."""

from copy import deepcopy
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


GUARD = Path(__file__).resolve().parents[1] / "check_site_dependencies.py"
SPEC = importlib.util.spec_from_file_location("site_dependency_guard", GUARD)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def record(name, version):
    return {"version": version, "resolved": f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz",
            "integrity": "sha512-" + base64.b64encode(bytes(64)).decode("ascii")}


def fixed_lock():
    return {"lockfileVersion": 3, "packages": {
        "": {"dependencies": {"http-cache-semantics": "file:./" + guard.VENDOR}},
        "node_modules/http-cache-semantics": deepcopy(guard.VENDOR_LINK),
        guard.VENDOR: deepcopy(guard.VENDOR_PACKAGE),
        "node_modules/vite": record("vite", "8.1.6"),
        "node_modules/postcss-selector-parser": record("postcss-selector-parser", "6.1.5"),
    }}


def write_installed(site, lock):
    for location, entry in lock["packages"].items():
        if not location.startswith("node_modules/") or entry.get("link"):
            continue
        name = entry.get("name", location.rsplit("/node_modules/", 1)[-1].removeprefix("node_modules/"))
        filename = site / location / "package.json"
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(json.dumps({"name": name, "version": entry["version"]}), encoding="utf-8")


class SiteDependencyTests(unittest.TestCase):
    def test_fixed_controls_and_future_patch_releases(self):
        for vite in ("8.1.6", "8.1.7"):
            for parser in ("6.1.5", "6.2.0", "7.1.6", "7.2.0"):
                with self.subTest(vite=vite, parser=parser):
                    lock = fixed_lock()
                    lock["packages"]["node_modules/vite"] = record("vite", vite)
                    lock["packages"]["node_modules/postcss-selector-parser"] = record("postcss-selector-parser", parser)
                    self.assertEqual(len(guard.validate_lock(lock)), 2)

    def test_fixed_labels_cannot_hide_older_tarball_urls(self):
        for name, old, fixed in (("vite", "8.1.3", "8.1.6"),
                                 ("postcss-selector-parser", "6.1.4", "6.1.5")):
            lock = fixed_lock()
            lock["packages"]["node_modules/" + name] = {**record(name, old), "version": fixed}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "tarball URL disagree"):
                guard.validate_lock(lock)

    def test_integrity_requires_canonical_complete_sha_digests(self):
        for bits in (256, 384, 512):
            value = "sha" + str(bits) + "-" + base64.b64encode(bytes(bits // 8)).decode("ascii")
            guard.validate_integrity(value)
            with self.subTest(bits=bits):
                for invalid in (None, "sha512-", "sha512-AA==", value[:-1], value + "=", value + "\n",
                                value.replace("-", "-!", 1), value.replace("sha", "md", 1)):
                    with self.assertRaisesRegex(ValueError, "canonical full"):
                        guard.validate_integrity(invalid)
        canonical = base64.b64encode(bytes(64)).decode("ascii")
        noncanonical = canonical[:-3] + "B=="  # Same decoded bytes; nonzero unused padding bits.
        self.assertEqual(base64.b64decode(canonical), base64.b64decode(noncanonical))
        lock = fixed_lock()
        lock["packages"]["node_modules/vite"]["integrity"] = "sha512-" + noncanonical
        with self.assertRaisesRegex(ValueError, "canonical full"):
            guard.validate_lock(lock)

    def test_affected_and_unverified_majors_fail(self):
        for name, versions in (
            ("vite", ("8.1.5", "8.0.0", "8.2.0", "8.2.3", "8.3.2", "8.2.4", "8.3.3", "7.3.1", "9.0.0")),
            ("postcss-selector-parser", ("6.1.4", "7.0.0", "7.1.5", "5.0.0", "8.0.0")),
        ):
            for version in versions:
                with self.subTest(name=name, version=version):
                    lock = fixed_lock()
                    lock["packages"]["node_modules/" + name]["version"] = version
                    with self.assertRaisesRegex(ValueError, "affected or on an unverified major"):
                        guard.validate_lock(lock)

    def test_all_nested_and_duplicate_copies_are_checked(self):
        for name, version in (("vite", "8.1.5"), ("postcss-selector-parser", "6.1.4"),
                              ("postcss-selector-parser", "7.1.5")):
            with self.subTest(name=name, version=version):
                lock = fixed_lock()
                location = "node_modules/@scope/outer/node_modules/inner/node_modules/" + name
                lock["packages"][location] = record(name, version)
                with self.assertRaisesRegex(ValueError, location):
                    guard.validate_lock(lock)
        lock = fixed_lock()
        lock["packages"]["node_modules/other/node_modules/vite"] = record("vite", "8.1.6")
        lock["packages"]["node_modules/other/node_modules/postcss-selector-parser"] = record("postcss-selector-parser", "7.1.6")
        guard.validate_lock(lock)

    def test_aliased_target_packages_are_checked(self):
        for name, version in (("vite", "8.1.5"), ("postcss-selector-parser", "6.1.4")):
            with self.subTest(name=name):
                lock = fixed_lock()
                lock["packages"]["node_modules/alias"] = {"name": name, **record(name, version)}
                with self.assertRaisesRegex(ValueError, name):
                    guard.validate_lock(lock)
        for name in (None, "different"):
            lock = fixed_lock()
            lock["packages"]["node_modules/alias"] = record("vite", "8.1.6")
            if name is not None:
                lock["packages"]["node_modules/alias"]["name"] = name
            with self.subTest(alias_name=name), self.assertRaisesRegex(ValueError, "name/version and registry tarball URL disagree"):
                guard.validate_lock(lock)

    def test_malformed_and_prerelease_versions_fail(self):
        for name in ("vite", "postcss-selector-parser"):
            for version in (None, 8, "", "8.1", "8.01.6", "v8.1.6", "8.1.6rc1", "8.1.6-rc.1",
                            "8.1.6+local", "8.1.6\n", " 8.1.6", "9" * 101):
                with self.subTest(name=name, version=version):
                    lock = fixed_lock()
                    lock["packages"]["node_modules/" + name]["version"] = version
                    with self.assertRaisesRegex(ValueError, "stable numeric release"):
                        guard.validate_lock(lock)

    def test_missing_expected_graph_and_invalid_lock_fail(self):
        for lock in (None, [], {}, {"lockfileVersion": 2}, {"lockfileVersion": 3.0}, {"lockfileVersion": 3, "packages": {}},
                     {"lockfileVersion": 3, "packages": []}):
            with self.subTest(lock=lock), self.assertRaises(ValueError):
                guard.validate_lock(lock)
        for missing in ("", "node_modules/vite", "node_modules/postcss-selector-parser"):
            lock = fixed_lock()
            del lock["packages"][missing]
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                guard.validate_lock(lock)
        lock = fixed_lock()
        lock["packages"]["node_modules/vite"] = None
        with self.assertRaisesRegex(ValueError, "malformed package record"):
            guard.validate_lock(lock)

    def test_only_exact_existing_vendor_edge_is_allowed(self):
        for change in ("root", "link", "target", "extra-field", "another-link", "git", "file", "traversal"):
            with self.subTest(change=change):
                lock = fixed_lock()
                packages = lock["packages"]
                if change == "root":
                    packages[""]["dependencies"]["http-cache-semantics"] = "file:../elsewhere"
                elif change == "link":
                    packages["node_modules/http-cache-semantics"]["resolved"] = "vendor/elsewhere"
                elif change == "target":
                    del packages[guard.VENDOR]
                elif change == "extra-field":
                    packages[guard.VENDOR]["scripts"] = {"install": "unreviewed"}
                elif change == "another-link":
                    packages["node_modules/another"] = {"resolved": guard.VENDOR, "link": True}
                elif change in ("git", "file"):
                    packages["node_modules/vite"]["resolved"] = "git+https://example.test/repo" if change == "git" else "file:other.tgz"
                else:
                    packages["node_modules/../node_modules/vite"] = record("vite", "8.1.6")
                with self.assertRaises(ValueError):
                    guard.validate_lock(lock)

    def test_json_duplicate_keys_and_invalid_constants_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "lock.json"
            for source in ('{"lockfileVersion": 3, "packages": {}, "packages": {}}',
                           '{"packages":{"node_modules/vite":{},"node_modules/vite":{}}}',
                           '{"lockfileVersion": NaN}', '{malformed', 'null'):
                filename.write_text(source, encoding="utf-8")
                with self.subTest(source=source), self.assertRaises(ValueError):
                    guard.validate_lock(guard.load_lock(filename))

    def test_installed_root_nested_and_aliased_metadata_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "site"
            lock = fixed_lock()
            lock["packages"]["node_modules/outer/node_modules/vite"] = record("vite", "8.1.6")
            lock["packages"]["node_modules/alias"] = {"name": "postcss-selector-parser", **record("postcss-selector-parser", "7.1.6")}
            write_installed(site, lock)
            guard.validate_installed(lock, site)
            for location in ("node_modules/vite", "node_modules/postcss-selector-parser",
                             "node_modules/outer/node_modules/vite", "node_modules/alias"):
                filename = site / location / "package.json"
                original = filename.read_text()
                observed = json.loads(original)
                observed["version"] = "8.1.3" if observed["name"] == "vite" else "6.1.4"
                filename.write_text(json.dumps(observed), encoding="utf-8")
                with self.subTest(location=location), self.assertRaisesRegex(ValueError, "differs from the admitted lock"):
                    guard.validate_installed(lock, site)
                filename.write_text(original, encoding="utf-8")

    def test_installed_missing_malformed_and_wrong_identity_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "site"
            lock = fixed_lock()
            write_installed(site, lock)
            filename = site / "node_modules/vite/package.json"
            filename.unlink()
            with self.assertRaises(OSError):
                guard.validate_installed(lock, site)
            for source in ("{malformed", "[]", '{"name":"vite"}',
                           '{"name":"different","version":"8.1.6"}',
                           '{"name":"vite","version":"8.1.6-rc.1"}',
                           '{"name":"vite","version":"8.1.3","version":"8.1.6"}'):
                filename.write_text(source, encoding="utf-8")
                with self.subTest(source=source), self.assertRaises(ValueError):
                    guard.validate_installed(lock, site)

    def test_installed_symlink_reparse_and_escape_evidence_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "site"
            lock = fixed_lock()
            write_installed(site, lock)
            metadata = site / "node_modules/vite/package.json"
            actual_lstat = Path.lstat
            for selected in (site / "node_modules", metadata):
                for evidence in (SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0),
                                 SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)):
                    def inspect(path, *args, **kwargs):
                        return evidence if path == selected else actual_lstat(path, *args, **kwargs)
                    with self.subTest(selected=selected, evidence=evidence), mock.patch.object(Path, "lstat", inspect):
                        with self.assertRaisesRegex(ValueError, "symlinked or reparse"):
                            guard.validate_installed(lock, site)
            actual_resolve = Path.resolve
            def resolve(path, *args, **kwargs):
                return Path(directory) / "outside/package.json" if path == metadata else actual_resolve(path, *args, **kwargs)
            with mock.patch.object(Path, "resolve", resolve):
                with self.assertRaisesRegex(ValueError, "escapes the site"):
                    guard.validate_installed(lock, site)

    def test_cli_reads_actual_relative_lock_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "site"
            site.mkdir()
            filename = site / "package-lock.json"
            command = [sys.executable, "-I", "-B", str(GUARD)]
            def run(*args):
                return subprocess.run(command + list(args), cwd=directory, capture_output=True, text=True, timeout=10)
            self.assertEqual(run().returncode, 1, "a missing actual lock cannot pass")
            filename.write_text("{malformed", encoding="utf-8")
            self.assertEqual(run().returncode, 1)
            filename.write_text(json.dumps(fixed_lock()), encoding="utf-8")
            self.assertEqual(run().returncode, 0)
            self.assertEqual(run("--installed").returncode, 1, "missing installed packages cannot pass")
            write_installed(site, fixed_lock())
            self.assertEqual(run("--installed").returncode, 0)
            (site / "node_modules/vite/package.json").write_text('{"name":"vite","version":"8.1.3"}', encoding="utf-8")
            self.assertEqual(run("--installed").returncode, 1)
            self.assertEqual(run("--version=8.1.6").returncode, 1)
            lock = fixed_lock()
            lock["packages"]["node_modules/nested/node_modules/vite"] = record("vite", "8.1.5")
            filename.write_text(json.dumps(lock), encoding="utf-8")
            self.assertEqual(run().returncode, 1, "a nested vulnerable copy cannot pass the real CLI")


if __name__ == "__main__":
    unittest.main()
