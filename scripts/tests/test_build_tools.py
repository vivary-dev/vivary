"""Boundaries which prevent executing a different client or changed artifact."""

import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
TOOLS = runpy.run_path(str(SCRIPTS / "bootstrap_build_tools.py"))
GO = runpy.run_path(str(SCRIPTS / "build_go_tools.py"))


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
            with patch("urllib.request.urlopen", side_effect=AssertionError("no network")):
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch"):
                    TOOLS["download"](root, "https://registry.npmjs.org/tool.tgz", "tool.tgz",
                                      "sha256", hashlib.sha256(b"expected").digest())

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
