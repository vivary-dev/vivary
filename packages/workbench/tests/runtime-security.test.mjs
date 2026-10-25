import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADMITTED_ELECTRON, NODE_ADVISORIES, NODE_SECURITY_FLOORS, QUALIFIED_NPM, assertCurrentNode,
  assertElectronPublication,
  assertNodeFacts, assertNodeVersion, collectCurrentNode, collectExecutableNode, executableSha256,
} from "../bin/runtime-security.mjs";

const guard = fileURLToPath(new URL("../bin/runtime-security.mjs", import.meta.url));
const repository = path.resolve(path.dirname(guard), "../../..");
const actualAdmitted = (() => { try { assertNodeVersion(process.versions.node); return true; } catch { return false; } })();
const child = (args, options = {}) => spawnSync(process.execPath, args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024, ...options,
});
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-node-security-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const absent = async file => assert.equal(await lstat(file).catch(() => null), null);

test("October Node security floors are branch specific and do not select Node 26", () => {
  assert.deepEqual(NODE_SECURITY_FLOORS, { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" });
  for (const [bad, good] of [["22.23.3", "22.23.4"], ["24.22.0", "24.22.1"], ["26.12.0", "26.12.1"]]) {
    assert.throws(() => assertNodeVersion(bad), /affected/);
    assert.doesNotThrow(() => assertNodeVersion(good));
  }
  for (const bad of ["22.22.0", "24.19.0", "24.20.0", "24.21.0", "18.99.0", "20.99.0", "23.99.0", "25.99.0", "28.0.0",
    "24.22", "24.022.1", "24.22.1-rc.1", "24.22.1+local", "24.22.1\n", " 24.22.1", "garbage", "", null, undefined, {}, 24]) {
    assert.throws(() => assertNodeVersion(bad), /Runtime security/, String(bad));
  }
  assert.doesNotThrow(() => assertNodeVersion("v22.24.0"));
});

test("all ten advisory identifiers retain their actual affected major sets", () => {
  assert.deepEqual(Object.fromEntries(NODE_ADVISORIES.map(({ id, majors }) => [id, majors])), {
    "CVE-2026-105482": [22, 24, 26], "CVE-2026-105483": [24, 26],
    "CVE-2026-106069": [22, 24, 26], "CVE-2026-111497": [22, 24, 26],
    "CVE-2026-105481": [22, 24, 26], "CVE-2026-106070": [26], "CVE-2026-106071": [26],
    "CVE-2026-106072": [22, 24, 26], "CVE-2026-106074": [22, 24, 26], "CVE-2026-106073": [22, 24, 26],
  });
});

test("current-process collection binds the actual executable bytes and rejects Electron substitution", async () => {
  const facts = await collectCurrentNode();
  assert.equal(facts.execPath, await realpath(process.execPath));
  assert.deepEqual(facts.versions, { ...process.versions });
  assert.equal(facts.platform, process.platform);
  assert.equal(facts.arch, process.arch);
  assert.equal(facts.sha256, createHash("sha256").update(await readFile(process.execPath)).digest("hex"));
  assert.throws(() => assertNodeFacts({ ...facts, versions: { node: "24.22.1", electron: "44.9.3" } }), /Electron/);
  assert.throws(() => assertNodeFacts({ ...facts, sha256: "safe build marker" }), /evidence/);
  for (const node of ["22.23.4", "24.22.1", "26.12.1"]) assert.doesNotThrow(() => assertNodeFacts({ ...facts, versions: { node } }));
  if (actualAdmitted) assert.equal((await assertCurrentNode()).sha256, facts.sha256);
  else await assert.rejects(assertCurrentNode(), /Runtime security/);
});

test("guard CLI uses actual child facts despite safe engines, build metadata and environment markers", () => fixture(async directory => {
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ engines: { node: "24.22.1" } }));
  await writeFile(path.join(directory, "build.json"), JSON.stringify({ node: "26.12.1" }));
  const result = child([guard], { cwd: directory, env: { ...process.env, NODE_VERSION: "26.12.1", VIVARY_NODE_VERSION: "24.22.1" } });
  assert.equal(result.status, actualAdmitted ? 0 : 1, result.stderr);
  if (actualAdmitted) assert.equal(JSON.parse(result.stdout).sha256, await executableSha256(process.execPath));
  else assert.match(result.stderr, /Runtime security/);
  const diagnostic = child([guard, "collect"], { cwd: directory });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).versions.node, process.versions.node);
}));

test("guard CLI still runs when it is invoked through a symlinked path", {
  skip: process.platform === "win32" ? "directory symlinks need extra privileges on Windows" : false,
}, () => fixture(async directory => {
  const linked = path.join(directory, "linked-bin");
  await symlink(path.dirname(guard), linked, "dir");
  const viaLink = path.join(linked, path.basename(guard));
  const diagnostic = child([viaLink, "collect"], { cwd: directory });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).versions.node, process.versions.node);
  const refused = child([viaLink, "not-a-guard-command"], { cwd: directory });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unsupported guard command/);
}));

test("native executable collection refuses missing cross-platform evidence and malformed or failed probes", () => fixture(async directory => {
  await assert.rejects(collectExecutableNode(process.execPath, { platform: process.platform === "win32" ? "linux" : "win32", arch: process.arch }), /matching-platform/);
  if (process.platform === "win32") return; // Shell fixtures below are not Windows executables.
  for (const [name, text, expected] of [
    ["malformed", "printf 'not-json'", /malformed output/],
    ["failed", "exit 7", /collector failed/],
    ["forged", "printf '{\"execPath\":\"/different\",\"versions\":{\"node\":\"24.22.1\"}}'", /identity/],
  ]) {
    const executable = path.join(directory, name);
    await writeFile(executable, "#!/bin/sh\n" + text + "\n");
    await chmod(executable, 0o700);
    await assert.rejects(collectExecutableNode(executable, { platform: process.platform, arch: process.arch }), expected);
  }
}));

test("guarded real package executables stop before builder markers on affected Node", () => fixture(async directory => {
  const marker = path.join(directory, "builder-ran");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", bin: { builder: "builder.mjs" }, engines: { node: "24.22.1" } }));
  await writeFile(path.join(directory, "builder.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`);
  const result = child([guard, "run", path.join(directory, "package.json"), "builder", "build"]);
  assert.equal(result.status, actualAdmitted ? 0 : 1, result.stderr);
  if (actualAdmitted) assert.equal(await readFile(marker, "utf8"), "build");
  else { assert.match(result.stderr, /Runtime security/); await absent(marker); }
  // Both supported build scripts must invoke this same guarded executable boundary.
  for (const [file, prefix] of [["packages/workbench/package.json", "node bin/runtime-security.mjs run "],
    ["site/package.json", "node ../packages/workbench/bin/runtime-security.mjs run "]]) {
    const pkg = JSON.parse(await readFile(path.join(repository, file), "utf8"));
    assert.ok(pkg.scripts.build.startsWith(prefix), file);
    // Execute the real command shape with only its installed-package path supplied by the fixture.
    const args = pkg.scripts.build.split(" ").slice(1);
    args[0] = guard;
    args[2] = path.join(directory, "package.json");
    args[3] = "builder";
    await rm(marker, { force: true });
    const built = child(args, { cwd: directory });
    assert.equal(built.status, actualAdmitted ? 0 : 1, built.stderr);
    if (actualAdmitted) assert.equal(await readFile(marker, "utf8"), "build");
    else await absent(marker);
  }
}));

test("real Workbench start admits Node before port probing, user state or server import", () => fixture(async directory => {
  await mkdir(path.join(directory, "bin"));
  await mkdir(path.join(directory, ".output/server"), { recursive: true });
  for (const name of ["start.mjs", "runtime-security.mjs"]) await copyFile(path.join(path.dirname(guard), name), path.join(directory, "bin", name));
  const marker = path.join(directory, "server-imported");
  const data = path.join(directory, "data");
  await writeFile(path.join(directory, ".output/server/index.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported');`);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const result = child([path.join(directory, "bin/start.mjs"), "--port", String(port), "--data-dir", data]);
  assert.equal(result.status, actualAdmitted ? 0 : 1, result.stderr);
  if (actualAdmitted) {
    assert.equal(await readFile(marker, "utf8"), "imported");
    assert.ok((await readFile(path.join(data, "auth-secret"), "utf8")).trim().length >= 32);
  } else {
    assert.match(result.stderr, /Runtime security/);
    await absent(data);
    await absent(marker);
    // An occupied port would fail at the next startup boundary if Node admission ran late.
    await new Promise(resolve => probe.listen(port, "127.0.0.1", resolve));
    try {
      const occupied = child([path.join(directory, "bin/start.mjs"), "--port", String(port), "--data-dir", data]);
      assert.match(occupied.stderr, /Runtime security/);
      assert.doesNotMatch(occupied.stderr, /already in use/);
    } finally { await new Promise(resolve => probe.close(resolve)); }
  }
}));

test("standalone Node policy never waives the Electron publication hold", () => {
  assert.doesNotThrow(() => assertNodeVersion("24.22.1"));
  assert.throws(() => assertElectronPublication(), /Electron publication is held\. Electron 44\.9\.3 is not admitted.*No Electron release is admitted/);
});

test("Electron publication admits only a listed release whose bundled Node meets the floor", () => {
  assert.deepEqual(ADMITTED_ELECTRON, {});
  const admitted = { "44.9.4": "24.22.1" };
  assert.deepEqual(assertElectronPublication("44.9.4", admitted), { electron: "44.9.4", node: "24.22.1" });
  assert.throws(() => assertElectronPublication("44.9.3", admitted), /Electron 44\.9\.3 is not admitted\. Admitted: 44\.9\.4\./);
  assert.throws(() => assertElectronPublication("44.9.4", { "44.9.4": "24.22.0" }), /Node 24\.22\.0 is affected/);
  assert.throws(() => assertElectronPublication("toString", admitted), /Electron toString is not admitted/);
});

test("npm publisher rechecks its actual Node and exact validated archive before the qualified client", () => fixture(async directory => {
  if (process.platform === "win32") return; // Trusted publication is a Linux job, with Unix npm links.
  const bin = path.join(directory, "bin");
  const candidate = path.join(directory, "candidate");
  const tools = path.join(directory, "tools");
  await mkdir(bin); await mkdir(candidate);
  await writeFile(path.join(candidate, "candidate.tgz"), "fixture archive bytes");
  const marker = path.join(directory, "published");
  const validation = path.join(directory, "validated");
  // Only the external validator and the qualified client's npm are faked. The guard, the tool
  // root identity checks and the copying are real.
  const validator = path.join(bin, "python3");
  await writeFile(validator, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[process.argv.indexOf('--artifacts') + 1];
const archive = path.join(dir, fs.readdirSync(dir)[0]);
// guard:allow-env-credential - Test fixture validation marker path in its owned temporary directory.
fs.writeFileSync(process.env.VALIDATED, archive);
// guard:allow-env-credential - Test fixture rejection switch set to the literal 1.
if (process.env.REFUSE_ARCHIVE === '1') process.exit(9);\n`);
  await chmod(validator, 0o700);
  await mkdir(path.join(tools, "node/bin"), { recursive: true });
  await symlink(process.execPath, path.join(tools, "node/bin/node"));
  const manifest = async (name, version) => {
    const directory = path.join(tools, "npm", ...(name === "npm" ? [] : ["node_modules", name]));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version }));
  };
  for (const [name, version] of Object.entries(QUALIFIED_NPM)) await manifest(name, version);
  await mkdir(path.join(tools, "npm/bin"));
  await writeFile(path.join(tools, "npm/bin/npm-cli.js"), "throw new Error('the fixture client never loads npm');\n");
  const client = path.join(tools, "client.cjs");
  await writeFile(client, `const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2, 4), ['npm', 'publish']); assert.equal(process.argv.length, 5);
// guard:allow-env-credential - Test fixture validation marker path used to compare the checked archive.
const archive = process.argv[4]; assert.equal(archive, fs.readFileSync(process.env.VALIDATED, 'utf8'));
assert.equal(fs.readFileSync(archive, 'utf8'), 'fixture archive bytes');
assert.equal(process.cwd(), fs.realpathSync(path.dirname(archive)));
// guard:allow-env-credential - Test fixture publication marker path in its owned temporary directory.
fs.writeFileSync(process.env.PUBLISHED, archive);`);
  // guard:allow-env-credential - Test fixture executable search path for the fake validator.
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, VALIDATED: validation, PUBLISHED: marker };
  const publish = (options = {}) => child([guard, "publish-npm", candidate, tools], { env, ...options });
  let result = publish({ env: { ...env, REFUSE_ARCHIVE: "1" } });
  assert.equal(result.status, 1);
  await absent(marker);
  result = child([guard, "publish-npm", candidate], { env });
  assert.equal(result.status, 1, "publication without the qualified tool root must be refused");
  assert.match(result.stderr, /unsupported guard command/);
  await rm(validation, { force: true });
  result = publish();
  assert.equal(result.status, actualAdmitted ? 0 : 1, result.stderr);
  if (actualAdmitted) {
    const published = await readFile(marker, "utf8");
    assert.notEqual(published, path.join(candidate, "candidate.tgz"));
    assert.equal(published.endsWith("candidate.tgz"), true);
    await absent(published); // Owned copy is cleaned after the synchronous publisher returns.
    await rm(marker);
    await rm(validation);
  } else { await absent(marker); await absent(validation); assert.match(result.stderr, /Runtime security/); }
  // Each identity change is refused before the archive is copied or validated.
  const refused = async (label, change, restore, pattern) => {
    await change();
    const outcome = publish();
    await restore();
    assert.equal(outcome.status, 1, label);
    assert.match(outcome.stderr, pattern, label);
    await absent(marker); await absent(validation);
  };
  if (actualAdmitted) {
    for (const [name, version] of [["npm", "11.19.1"], ["undici", "6.28.0"], ["ip-address", "10.5.0"]]) {
      await refused(`${name} ${version}`, () => manifest(name, version), () => manifest(name, QUALIFIED_NPM[name]),
        new RegExp(`requires ${name} ${QUALIFIED_NPM[name].replaceAll(".", "\\.")}`));
    }
    const node = path.join(tools, "node/bin/node");
    await refused("another Node", async () => { await rm(node); await writeFile(node, ""); },
      async () => { await rm(node); await symlink(process.execPath, node); }, /qualified tool root's Node/);
    const outside = path.join(directory, "client.cjs");
    await copyFile(client, outside);
    await refused("client.cjs outside the root", async () => { await rm(client); await symlink(outside, client); },
      async () => { await rm(client); await copyFile(outside, client); }, /escapes its tool root/);
    const relative = child([guard, "publish-npm", candidate, "tools"], { env, cwd: directory });
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /absolute qualified tool root/);
    const missing = child([guard, "publish-npm", candidate, path.join(directory, "missing")], { env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /tool root does not exist/);
    await absent(marker); await absent(validation);
  }
  await writeFile(path.join(candidate, "other.tgz"), "unchecked");
  result = publish();
  assert.equal(result.status, 1, "a directory of candidate archives must never be published");
}));
