"""Boundaries which prevent executing a different client or changed artifact."""

import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1]
TOOLS = runpy.run_path(str(SCRIPTS / "bootstrap_build_tools.py"))
GO = runpy.run_path(str(SCRIPTS / "build_go_tools.py"))


def windows_executable():
    data = bytearray(154)
    data[:2] = b"MZ"
    data[60:64] = (128).to_bytes(4, "little")
    data[128:132] = b"PE\0\0"
    data[132:134] = (0x8664).to_bytes(2, "little")
    data[152:154] = (0x20b).to_bytes(2, "little")
    return bytes(data)


def write_tar(path, files):
    with tarfile.open(path, "w:gz") as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))


class BuildToolsTest(unittest.TestCase):
    def test_unqualified_python_or_openssl_is_refused(self):
        with patch("sys.version_info", (3, 12, 14)):
            with self.assertRaisesRegex(RuntimeError, "separately qualified"):
                TOOLS["admit_host"]()
        with patch("sys.version_info", (3, 12, 15)), patch("ssl.OPENSSL_VERSION", "OpenSSL 3.5.8"):
            with self.assertRaisesRegex(RuntimeError, "separately qualified"):
                TOOLS["admit_host"]()

    def test_https_redirect_cannot_downgrade_transport(self):
        import urllib.request
        handler = TOOLS["HTTPSOnlyRedirect"]()
        with self.assertRaisesRegex(RuntimeError, "Non-HTTPS artifact redirect"):
            handler.redirect_request(urllib.request.Request("https://example.invalid/tool"),
                                     None, 302, "Found", {}, "http://example.invalid/tool")

    def test_changed_cached_archive_refused_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "archives").mkdir()
            (root / "archives/tool.tgz").write_bytes(b"tampered")
            with patch("urllib.request.build_opener", side_effect=AssertionError("no network")):
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch"):
                    TOOLS["download"](root, "https://registry.npmjs.org/tool.tgz", "tool.tgz",
                                      "sha256", hashlib.sha256(b"expected").digest())
            self.assertEqual((root / "archives/tool.tgz").read_bytes(), b"tampered")

    def test_download_requires_full_identity_response_before_cache_publish(self):
        payload = b"authenticated inert artifact fixture"
        class Response(io.BytesIO):
            status = 200
            def __init__(self, data, headers=None, status=200):
                super().__init__(data)
                self.headers = {} if headers is None else headers
                self.status, self.reads = status, 0
            def read(self, size=-1):
                self.reads += 1
                return super().read(size)
        cases = (
            ("valid", payload, {"Content-Length": str(len(payload))}, 200),
            ("short", payload[:-1], {}, 200),
            ("oversize", payload + b"extra", {}, 200),
            ("partial-status", payload, {}, 206),
            ("partial-header", payload, {"Content-Range": "PRIVATE"}, 200),
            ("encoded", payload, {"Content-Encoding": "PRIVATE"}, 200),
            ("wrong-length", payload, {"Content-Length": str(len(payload) + 1)}, 200),
            ("invalid-length", payload, {"Content-Length": "PRIVATE"}, 200),
            ("bad-hash", b"x" * len(payload), {}, 200),
            ("non-200", payload, {}, 503),
        )
        with tempfile.TemporaryDirectory() as temporary:
            for label, data, headers, status in cases:
                root = Path(temporary) / label
                response, opener = Response(data, headers, status), Mock()
                opener.open.return_value = response
                with self.subTest(label=label), patch("ssl.create_default_context") as context, \
                        patch("urllib.request.build_opener", return_value=opener):
                    if label == "valid":
                        result = TOOLS["download"](root, "https://go.dev/dl/PRIVATE", "tool.tgz", "sha256",
                                                   hashlib.sha256(payload).digest(), size=len(payload))
                        self.assertEqual(result.read_bytes(), payload)
                    else:
                        with self.assertRaises(RuntimeError) as refusal:
                            TOOLS["download"](root, "https://go.dev/dl/PRIVATE", "tool.tgz", "sha256",
                                              hashlib.sha256(payload).digest(), size=len(payload))
                        message = str(refusal.exception)
                        self.assertRegex(message, r"bytes=\d+, algorithm=sha256, digest=[0-9a-f]{64}, status=\d{3}")
                        self.assertNotIn("PRIVATE", message)
                        self.assertFalse((root / "archives/tool.tgz").exists())
                    context.assert_called_once_with(cafile=str(root / "ca.pem"))
                    request = opener.open.call_args.args[0]
                    self.assertEqual(request.get_header("Accept-encoding"), "identity")
                    self.assertEqual(opener.open.call_args.kwargs, {"timeout": 90})
                    self.assertEqual(opener.open.call_count, 1, "download failures cannot retry")
                if label in ("partial-status", "partial-header", "encoded", "invalid-length", "non-200"):
                    self.assertEqual(response.reads, 0)

    def test_http_and_incomplete_read_errors_are_sanitized_and_never_cached(self):
        import urllib.error
        payload = b"complete fixture"
        for failure in (urllib.error.HTTPError("https://PRIVATE", 403, "PRIVATE", {"PRIVATE": "PRIVATE"}, None),
                        http.client.IncompleteRead(b"short", len(payload)),
                        urllib.error.URLError("PRIVATE transport diagnostics")):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                root, opener = Path(temporary), Mock()
                if isinstance(failure, http.client.IncompleteRead):
                    response = Mock(status=200, headers={})
                    response.__enter__ = Mock(return_value=response)
                    response.__exit__ = Mock(return_value=False)
                    response.read.side_effect = failure
                    opener.open.return_value = response
                else:
                    opener.open.side_effect = failure
                with patch("ssl.create_default_context"), patch("urllib.request.build_opener", return_value=opener):
                    with self.assertRaises(RuntimeError) as refusal:
                        TOOLS["download"](root, "https://go.dev/dl/PRIVATE", "tool.tgz", "sha256",
                                          hashlib.sha256(payload).digest(), size=len(payload))
                message = str(refusal.exception)
                self.assertNotIn("PRIVATE", message)
                self.assertIn("algorithm=sha256", message)
                self.assertIn("bytes=5" if isinstance(failure, http.client.IncompleteRead) else "bytes=0", message)
                self.assertFalse((root / "archives/tool.tgz").exists())
                self.assertTrue(refusal.exception.__suppress_context__)

    def test_known_size_is_rechecked_on_cached_bytes_and_sha512_remains_supported(self):
        payload = b"authenticated inert SHA512 fixture"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "archives").mkdir()
            target = root / "archives/tool.tgz"
            target.write_bytes(payload)
            with patch("urllib.request.build_opener", side_effect=AssertionError("cache cannot network")):
                self.assertEqual(TOOLS["download"](root, "https://example.invalid", "tool.tgz", "sha512",
                                                   hashlib.sha512(payload).digest()), target)
                with self.assertRaisesRegex(RuntimeError, "Artifact byte count mismatch.*status=cache"):
                    TOOLS["download"](root, "https://example.invalid", "tool.tgz", "sha512",
                                      hashlib.sha512(payload).digest(), size=len(payload) + 1)
            self.assertEqual(target.read_bytes(), payload)

    def test_go_archive_sizes_are_bound_for_both_platforms_before_compiler_execution(self):
        bootstrap = GO["build"].__globals__["bootstrap"]
        for windows, size, digest in ((False, 66936659, GO["GO_SHA"]), (True, 75004774, GO["WINDOWS_GO_SHA"])):
            with self.subTest(windows=windows), patch.object(bootstrap, "windows_host", return_value=windows), \
                    patch.object(bootstrap, "download", side_effect=RuntimeError("fixture stop before parsing")) as download, \
                    patch("subprocess.check_output", side_effect=AssertionError("no compiler execution")):
                with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                    GO["build"](Path("/owned"))
            self.assertEqual(download.call_args.kwargs, {"size": size})
            self.assertEqual(download.call_args.args[-1].hex(), digest)

    def test_archive_traversal_and_devices_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, kind in (("package/../../outside", tarfile.REGTYPE),
                               ("package/device", tarfile.CHRTYPE)):
                archive = root / "bad.tar"
                with tarfile.open(archive, "w") as bundle:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    bundle.addfile(item)
                with self.assertRaises(RuntimeError):
                    TOOLS["unpack"](archive, root / "stage", "package")
            self.assertFalse((root / "outside").exists())

    def test_archive_link_escape_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "bad.tar"
            with tarfile.open(archive, "w") as bundle:
                item = tarfile.TarInfo("package/escape")
                item.type = tarfile.SYMTYPE
                item.linkname = "../../outside"
                bundle.addfile(item)
            with self.assertRaises(tarfile.FilterError):
                TOOLS["unpack"](archive, root / "stage", "package")

    def test_repeat_tree_verification_rejects_extra_changed_and_linked_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage, target = root / "stage", root / "installed"
            stage.mkdir()
            target.mkdir()
            (stage / "client").write_text("owned")
            (target / "client").write_text("owned")
            TOOLS["publish_tree"](stage, target)
            (target / "injected.cjs").write_text("extra")
            with self.assertRaisesRegex(RuntimeError, "Installed tree changed"):
                TOOLS["publish_tree"](stage, target)
            (target / "injected.cjs").unlink()
            (target / "client").write_text("modified")
            with self.assertRaises(RuntimeError):
                TOOLS["publish_tree"](stage, target)
            (target / "client").unlink()
            (target / "client").symlink_to(stage / "client")
            with self.assertRaises(RuntimeError):
                TOOLS["publish_tree"](stage, target)

    def test_root_and_config_symlinks_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "redirect").symlink_to(root, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                TOOLS["plain_directory"](root / "redirect/tools")
            (root / "user.npmrc").symlink_to(root / "missing")
            with self.assertRaises(RuntimeError):
                TOOLS["write_exact"](root / "user.npmrc", b"")

    def test_existing_nonempty_config_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "user.npmrc"
            path.write_bytes(b"strict-ssl=false\n")
            with self.assertRaises(RuntimeError):
                TOOLS["write_exact"](path, b"")
            self.assertEqual(path.read_bytes(), b"strict-ssl=false\n")

    def test_go_environment_pins_compiler_and_keeps_tls_verification(self):
        with patch.dict(os.environ, {"GOTOOLCHAIN": "auto", "GOPROXY": "http://example.invalid",
                                     "GIT_SSL_NO_VERIFY": "true", "GIT_CONFIG_COUNT": "2"}):
            env = GO["environment"](Path("/tmp/owned"))
        self.assertEqual(env["GOTOOLCHAIN"], "local")
        self.assertEqual(env["GOPROXY"], "https://proxy.golang.org")
        self.assertEqual(env["GIT_SSL_NO_VERIFY"], "false")
        self.assertEqual(env["GOENV"], "off")
        self.assertNotIn("GIT_CONFIG_COUNT", env)

    def test_windows_launchers_bind_actual_node_and_clean_injection_before_startup(self):
        with tempfile.TemporaryDirectory(prefix="vivary windows tools ") as temporary:
            root = Path(temporary)
            (root / "bin").mkdir()
            globals_ = TOOLS["write_launchers"].__globals__
            with patch.dict(globals_, windows_host=lambda: True):
                TOOLS["write_launchers"](root)
            for name in ("node", "npm", "pnpm"):
                source = (root / "bin" / (name + ".cmd")).read_text()
                self.assertIn('setlocal DisableDelayedExpansion', source)
                self.assertIn('set "NODE_OPTIONS="', source)
                self.assertIn('set "NODE_EXTRA_CA_CERTS="', source)
                self.assertIn('set "NODE_TLS_REJECT_UNAUTHORIZED="', source)
                self.assertIn('set "SSL_CERT_FILE=%~dp0..\\ca.pem"', source)
                self.assertIn('set "SSL_CERT_DIR=%~dp0..\\empty-ca"', source)
                self.assertIn('"%~dp0..\\node\\node.exe" --use-openssl-ca', source)
                self.assertLess(source.index('set "NODE_OPTIONS="'), source.index('"%~dp0..\\node\\node.exe"'))
                if name != "node":
                    self.assertIn('"%~dp0..\\client.cjs" ' + name + ' %*', source)
            self.assertFalse((root / "bin/node.exe").exists())
            self.assertIn('exit /b 78', (root / "bin/npx.cmd").read_text())
            client = (root / "client.cjs").read_text()
            self.assertIn("path.dirname(process.execPath) + path.delimiter", client)
            self.assertIn("npm_config_ignore_scripts: 'true'", client)
            self.assertIn("npm_config_manage_package_manager_versions: 'false'", client)
            self.assertIn("blocked-npm.cmd", client)

    def test_windows_prepare_uses_pinned_raw_node_and_same_authenticated_client_overlays(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            node = root / "official-node.exe"
            node.write_bytes(windows_executable())
            packages = {}
            for name, version in (("pnpm", "10.34.7"), ("npm", "12.2.1"), ("undici", "6.29.1"), ("ip-address", "10.7.4")):
                archive = root / (name + ".tgz")
                files = {"package/package.json": json.dumps({"name": name, "version": version}).encode()}
                if name == "npm":
                    files.update({"package/node_modules/undici/old": b"old", "package/node_modules/ip-address/old": b"old"})
                write_tar(archive, files)
                packages[name] = archive
            def download(directory, url, filename, algorithm, expected):
                self.assertEqual(url, "https://nodejs.org/dist/v24.22.1/win-x64/node.exe")
                self.assertEqual((algorithm, expected.hex()), ("sha256", TOOLS["WINDOWS_NODE_SHA"]))
                return node
            def npm_archive(directory, name, version, sri):
                if name == "pnpm":
                    self.assertEqual((version, sri), (TOOLS["PNPM"], TOOLS["PNPM_SRI"]))
                else:
                    self.assertIn((name, version, sri), TOOLS["NPM_PINS"])
                return packages[name]
            with patch.dict(TOOLS["prepare"].__globals__, windows_host=lambda: True,
                            download=download, npm_archive=npm_archive), \
                    patch("subprocess.run", side_effect=AssertionError("provisioning must not execute payloads")):
                TOOLS["prepare"](root)
            self.assertEqual((root / "node/node.exe").read_bytes(), node.read_bytes())
            self.assertFalse((root / "node/bin/npm").exists())
            self.assertFalse((root / "npm/node_modules/undici/old").exists())
            self.assertEqual(json.loads((root / "npm/node_modules/undici/package.json").read_text())["version"], "6.29.1")

    def test_windows_zip_rejects_case_collisions_devices_links_and_path_escapes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for names in (("go/../outside",), ("go/CON",), ("go/name.",), ("go/C:escape",), ("go/Foo", "go/foo")):
                archive = root / "unsafe.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    for name in names:
                        bundle.writestr(name, b"inert")
                with self.subTest(names=names), patch.dict(TOOLS["unpack"].__globals__, windows_host=lambda: True):
                    with self.assertRaises(RuntimeError): TOOLS["unpack"](archive, root / "stage", "go")
            with zipfile.ZipFile(root / "link.zip", "w") as bundle:
                member = zipfile.ZipInfo("go/link")
                member.external_attr = (0o120777 << 16)
                bundle.writestr(member, b"/outside")
            with self.assertRaises(RuntimeError): TOOLS["unpack"](root / "link.zip", root / "stage", "go")
            self.assertFalse((root / "outside").exists())

    def test_windows_go_environment_never_selects_native_system_trust_or_network_proxy(self):
        bootstrap = GO["environment"].__globals__["bootstrap"]
        with patch.object(bootstrap, "windows_host", return_value=True), \
                patch.dict(os.environ, GOTOOLCHAIN="auto", GOPROXY="https://unqualified.invalid", GOSUMDB="off", GONOSUMDB="*"):
            env = GO["environment"](Path("/tmp/owned"))
        self.assertEqual(env["GOOS"], "windows")
        self.assertEqual(env["GOARCH"], "amd64")
        self.assertEqual(env["GOTOOLCHAIN"], "local")
        self.assertEqual(env["GOPROXY"], "file:///tmp/owned/go-proxy")
        self.assertEqual(env["GOVCS"], "*:off")
        self.assertNotIn("GONOSUMDB", env)

    def test_module_prefetch_uses_filtered_python_tls_and_checks_go_hashes_before_cache_publish(self):
        module, version = "example.com/Module", "v1.2.3"
        mod = b"module example.com/Module\n"
        zipped = io.BytesIO()
        members = {module + "@" + version + "/go.mod": mod, module + "@" + version + "/source.go": b"package fixture\n"}
        with zipfile.ZipFile(zipped, "w") as archive:
            for name, data in members.items(): archive.writestr(name, data)
        payload = zipped.getvalue()
        pins = {(module, version): {"zip": GO["module_hash"](members), "mod": GO["module_hash"]({"go.mod": mod})}}
        def response(url, **options):
            self.assertTrue(url.startswith("https://proxy.golang.org/example.com/!module/@v/v1.2.3."))
            self.assertEqual(options["timeout"], 60)
            return io.BytesIO(payload if url.endswith(".zip") else mod if url.endswith(".mod") else b'{"Version":"v1.2.3"}')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            opener = Mock()
            opener.open.side_effect = response
            with patch("ssl.create_default_context") as context, \
                    patch("urllib.request.build_opener", return_value=opener):
                self.assertEqual(GO["prefetch_modules"](root, pins), (root / "go-proxy").as_uri())
            context.assert_called_once_with(cafile=str(root / "ca.pem"))
            self.assertEqual(opener.open.call_count, 3)
            target = root / "go-proxy/example.com/!module/@v/v1.2.3.zip"
            target.write_bytes(payload + b"tampered ZIP trailer")
            # HashZip authenticates module contents, so harmless ZIP encoding or
            # trailers do not alter h1; modified source bytes must still refuse.
            bad = io.BytesIO()
            with zipfile.ZipFile(bad, "w") as archive:
                for name, data in members.items(): archive.writestr(name, data + b"changed")
            target.write_bytes(bad.getvalue())
            with patch("ssl.create_default_context"), patch("urllib.request.build_opener") as network:
                with self.assertRaisesRegex(RuntimeError, "module checksum"):
                    GO["prefetch_modules"](root, pins)
                network.return_value.open.assert_not_called()

    def test_go_sum_identities_and_module_contents_cannot_escape_or_change(self):
        for module, version in (("../outside", "v1.2.3"), ("example.com/m", "v1/../../bad")):
            with tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "go.sum"
                source.write_text(f"{module} {version} {GO['ESBUILD_SUM']}\n")
                with self.assertRaises(RuntimeError): GO["module_checksums"](source)
        with self.assertRaisesRegex(RuntimeError, "module checksum"):
            GO["verify_module"](b"changed go.mod", GO["ESBUILD_MOD_SUM"], "github.com/evanw/esbuild", "v0.28.2", "mod")

    def test_windows_compiler_flow_uses_native_pinned_go_and_offline_modules_without_git(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            go_archive = root / "official-go.zip"
            with zipfile.ZipFile(go_archive, "w") as archive:
                archive.writestr("go/bin/go.exe", windows_executable())
            source = root / "esbuild-source"
            source.mkdir()
            sums = (f"golang.org/x/sys v0.0.0-20220715151400-c0bba94af5f8 {GO['SYS_SUM']}\n"
                    f"golang.org/x/sys v0.0.0-20220715151400-c0bba94af5f8/go.mod {GO['ESBUILD_MOD_SUM']}\n")
            (source / "go.sum").write_text(sums)
            ts_mod, ts_sum = b"module fixture\ngo 1.26\n", sums.encode()
            ts_archive = root / "official-ts.tar.gz"
            write_tar(ts_archive, {"typescript-go-" + GO["TS_COMMIT"] + "/go.mod": ts_mod,
                                   "typescript-go-" + GO["TS_COMMIT"] + "/go.sum": ts_sum})
            declaration = root / "declarations.tgz"
            write_tar(declaration, {"package/lib/lib.es5.d.ts": b"inert declaration"})
            manifest = json.dumps({"lib.es5.d.ts": hashlib.sha256(b"inert declaration").hexdigest()}, indent=2) + "\n"
            global_ = GO["build"].__globals__
            bootstrap = global_["bootstrap"]
            downloads = []
            def download(directory, url, filename, algorithm, expected, size=None):
                downloads.append(url)
                if filename.startswith("go1."):
                    self.assertEqual(expected.hex(), "7ecd2d7260e82c59bcbd7f1077a07cee2dea607295b858df67195a1e4e09629b")
                    self.assertEqual(size, 75004774)
                    return go_archive
                self.assertIn(GO["TS_COMMIT"], url)
                self.assertEqual(expected.hex(), GO["TS_ARCHIVE_SHA"])
                return ts_archive
            calls = []
            def command(arguments, **options):
                calls.append(arguments)
                if arguments[0].endswith("go.exe"):
                    self.assertEqual(options["env"]["GOTOOLCHAIN"], "local")
                    self.assertEqual(options["env"]["GOOS"], "windows")
                    self.assertIn(options["env"]["GOPROXY"].split(":")[0], ("file", "off"))
                    if arguments[1:] == ["version"]: return "go version go1.26.10 windows/amd64\n"
                    if arguments[1:4] == ["mod", "download", "-json"]:
                        return json.dumps({"Dir": str(source), "Sum": GO["ESBUILD_SUM"], "GoModSum": GO["ESBUILD_MOD_SUM"]}
                                          if len(arguments) == 5 else {"Path": "golang.org/x/sys", "Sum": GO["SYS_SUM"]})
                    if arguments[1] == "build":
                        output = Path(arguments[arguments.index("-o") + 1])
                        self.assertEqual(output.suffix, ".exe")
                        output.write_bytes(windows_executable())
                    if arguments[1:3] == ["version", "-m"]: return str(arguments[-1]) + ": go1.26.10\n"
                    return "verified\n"
                return "Version 7.0.2\n" if Path(arguments[0]).name == "tsc.exe" else "0.28.2\n"
            # These inert routing fixtures replace source identity only here;
            # artifact tuples and source/hash primitives are checked separately.
            with patch.object(bootstrap, "windows_host", return_value=True), \
                    patch.object(bootstrap, "download", side_effect=download), \
                    patch.object(bootstrap, "npm_archive", return_value=declaration), \
                    patch.dict(global_, prefetch_modules=Mock(), TS_MOD_SHA=hashlib.sha256(ts_mod).hexdigest(),
                               TS_SUM_SHA=hashlib.sha256(ts_sum).hexdigest(), TS_DECLARATION_SHA=hashlib.sha256(manifest.encode()).hexdigest()), \
                    patch("subprocess.check_output", side_effect=command), \
                    patch("subprocess.run", side_effect=AssertionError("Windows source acquisition must not execute Git")):
                GO["build"](root, typescript=True)
            self.assertEqual(len(downloads), 2)
            self.assertTrue((root / "esbuild-0.28.2-go1.26.10.exe").is_file())
            self.assertTrue((root / "typescript-7.0.2-go1.26.10/tsc.exe").is_file())
            self.assertTrue(all(Path(args[0]).name in ("go.exe", "esbuild.exe", "tsc.exe") for args in calls))

    @unittest.skipUnless(os.environ.get("VIVARY_TEST_NODE"), "explicit qualified Node needed for launcher execution")
    def test_client_actual_interpreter_and_environment_cannot_be_redirected(self):
        qualified_node = Path(os.environ["VIVARY_TEST_NODE"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="vivary tools ") as temporary:
            root = Path(temporary)
            (root / "bin").mkdir()
            (root / "node/bin").mkdir(parents=True)
            (root / "node/bin/node").symlink_to(qualified_node)
            (root / "npm/bin").mkdir(parents=True)
            (root / "npm/bin/npm-cli.js").write_text(
                "console.log(JSON.stringify({execPath:process.execPath,argv:process.argv,env:process.env}));")
            TOOLS["write_launchers"](root)
            hostile = dict(os.environ, NODE_OPTIONS="--import=/nonexistent-trap.mjs", NODE_PATH="/bad",
                           NODE_EXTRA_CA_CERTS="/bad", NODE_TLS_REJECT_UNAUTHORIZED="0",
                           npm_config_strict_ssl="false", NPM_CONFIG_CAFILE="/bad",
                           npm_config_manage_package_manager_versions="true", PNPM_HOME="/bad")
            result = subprocess.run([str(root / "bin/npm"), "--version"], env=hostile,
                                    text=True, capture_output=True, check=True, timeout=10)
            facts = json.loads(result.stdout)
            self.assertEqual(Path(facts["execPath"]), qualified_node)
            self.assertEqual(facts["argv"][1:], [str(root / "npm/bin/npm-cli.js"), "--version"])
            self.assertEqual(facts["env"]["npm_config_strict_ssl"], "true")
            self.assertNotIn("npm_config_manage_package_manager_versions", facts["env"])
            self.assertEqual(facts["env"]["npm_config_ignore_scripts"], "true")
            self.assertEqual(facts["env"]["NODE_OPTIONS"], "--use-openssl-ca")
            self.assertEqual(facts["env"]["npm_config_node_options"], "--use-openssl-ca")
            self.assertNotIn("NODE_EXTRA_CA_CERTS", facts["env"])
            self.assertNotIn("NODE_TLS_REJECT_UNAUTHORIZED", facts["env"])
            self.assertNotIn("PNPM_HOME", facts["env"])

    @unittest.skipUnless(os.environ.get("VIVARY_TEST_TOOL_ROOT"), "fresh qualified tool tree needed")
    def test_actual_clients_keep_raw_node_children_on_isolated_ca_policy(self):
        root = Path(os.environ["VIVARY_TEST_TOOL_ROOT"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="vivary-client-child-") as temporary:
            project = Path(temporary)
            (project / "package.json").write_text(json.dumps({"name": "owned-client-probe", "version": "1.0.0",
                "scripts": {"preprobe": "node -e \"require('fs').writeFileSync('unexpected-hook','bad')\"",
                            "probe": "node probe.cjs"}}))
            (project / "probe.cjs").write_text("""const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = process.env.VIVARY_TEST_TOOL_ROOT;
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(root, 'node/bin/node')));
assert.equal(process.version, 'v24.22.1');
assert.equal(process.env.NODE_OPTIONS, '--use-openssl-ca');
assert.equal(process.env.SSL_CERT_FILE, path.join(root, 'ca.pem'));
assert.equal(process.env.SSL_CERT_DIR, path.join(root, 'empty-ca'));
assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined);
assert.equal(process.env.NODE_USE_SYSTEM_CA, undefined);
assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
// With OpenSSL's store selected and no extra CA, Node's separate default
// in-memory bundled store is empty. Without the flag it contains bundled roots.
assert.equal(tls.getCACertificates('default').length, 0);
const pems = fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8').match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g);
assert.ok(pems.length > 0);
const excluded = new Set([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  '125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f',
  'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3']);
assert.ok(pems.every(pem => !excluded.has(crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex'))));
const raw = JSON.parse(execFileSync(process.execPath, ['-e',
  "console.log(JSON.stringify({path:process.execPath,options:process.env.NODE_OPTIONS,ca:process.env.SSL_CERT_FILE,defaults:require('node:tls').getCACertificates('default').length}))"], {encoding:'utf8'}));
assert.equal(raw.path, process.execPath);
assert.equal(raw.options, '--use-openssl-ca');
assert.equal(raw.ca, process.env.SSL_CERT_FILE);
assert.equal(raw.defaults, 0);
console.log('VIVARY_CLIENT_PROBE_OK');
""")
            for client in ("npm", "pnpm"):
                env = dict(os.environ, VIVARY_TEST_TOOL_ROOT=str(root), NODE_OPTIONS="--import=/absent-injection.mjs",
                           NODE_EXTRA_CA_CERTS="/bad", NODE_USE_SYSTEM_CA="1", NODE_TLS_REJECT_UNAUTHORIZED="0",
                           NPM_CONFIG_CAFILE="/bad", npm_config_strict_ssl="false")
                result = subprocess.run([str(root / "bin" / client), "run", "probe"], cwd=project, env=env,
                                        text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("VIVARY_CLIENT_PROBE_OK", result.stdout)
                self.assertFalse((project / "unexpected-hook").exists(), client + " ran preprobe: " + result.stdout)


if __name__ == "__main__":
    unittest.main()
