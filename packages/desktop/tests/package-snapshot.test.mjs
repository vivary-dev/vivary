import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotTrackedRepository } from "../package.mjs";
import { prepareWindowsX64Target } from "../windows-target.mjs";
import { fileURLToPath } from "node:url";
import { assertCurrentNode, assertDesktopPayload, assertNodeVersion, collectCurrentNode, validateStagedNode } from "../../workbench/bin/runtime-security.mjs";

const git = (repository, args) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });

test("packaging source snapshot is immutable and records tracked overlays", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-package-snapshot-"));
  const repository = path.join(directory, "repository");
  const stagedSource = path.join(repository, ".tmp", "package-source");
  const tracked = path.join(repository, "tracked.txt");
  try {
    await mkdir(repository);
    git(repository, ["init"]);
    git(repository, ["config", "user.email", "packaging@example.test"]);
    git(repository, ["config", "user.name", "Packaging Test"]);
    await writeFile(tracked, "committed\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "-m", "fixture"]);
    await mkdir(stagedSource, { recursive: true });

    const cleanDestination = path.join(directory, "clean-snapshot");
    const clean = await snapshotTrackedRepository(stagedSource, cleanDestination);
    await writeFile(tracked, "changed after clean snapshot\n");
    assert.equal(await readFile(path.join(cleanDestination, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(clean.sourceDirty, false);
    assert.equal(clean.kind, "git-archive");
    assert.equal(clean.trackedOverlayCount, 0);

    await writeFile(tracked, "dirty snapshot value\n");
    await writeFile(path.join(repository, "untracked.txt"), "excluded\n");
    const dirtyDestination = path.join(directory, "dirty-snapshot");
    const dirty = await snapshotTrackedRepository(stagedSource, dirtyDestination);
    await writeFile(tracked, "changed after dirty snapshot\n");
    assert.equal(await readFile(path.join(dirtyDestination, "tracked.txt"), "utf8"), "dirty snapshot value\n");
    await assert.rejects(readFile(path.join(dirtyDestination, "untracked.txt")), { code: "ENOENT" });
    assert.equal(dirty.sourceCommit, clean.sourceCommit);
    assert.equal(dirty.sourceDirty, true);
    assert.equal(dirty.kind, "git-archive-with-tracked-overlays");
    assert.equal(dirty.trackedOverlayCount, 1);

    await rm(tracked);
    const deletedDestination = path.join(directory, "deleted-snapshot");
    const deleted = await snapshotTrackedRepository(stagedSource, deletedDestination);
    await assert.rejects(readFile(path.join(deletedDestination, "tracked.txt")), { code: "ENOENT" });
    assert.equal(deleted.sourceDirty, true);
    assert.equal(deleted.kind, "git-archive-with-tracked-overlays");
    assert.equal(deleted.trackedOverlayCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real desktop packaging entry refuses before a packager or staging can run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-package-admission-"));
  try {
    const desktop = path.join(directory, "packages/desktop");
    const workbench = path.join(directory, "packages/workbench");
    await mkdir(desktop, { recursive: true });
    await mkdir(path.join(workbench, "bin"), { recursive: true });
    await mkdir(path.join(workbench, ".output/server"), { recursive: true });
    const entry = path.join(desktop, "package.mjs");
    await copyFile(fileURLToPath(new URL("../package.mjs", import.meta.url)), entry);
    await copyFile(fileURLToPath(new URL("../../workbench/bin/runtime-security.mjs", import.meta.url)), path.join(workbench, "bin/runtime-security.mjs"));
    await writeFile(path.join(workbench, ".output/server/index.mjs"), "export {};\n");
    const packager = path.join(desktop, "node_modules/@electron/packager");
    await mkdir(packager, { recursive: true });
    const marker = path.join(directory, "packager-imported");
    await writeFile(path.join(packager, "package.json"), '{"type":"module","exports":"./index.mjs"}');
    await writeFile(path.join(packager, "index.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); export const packager = () => [];`);
    const result = spawnSync(process.execPath, [entry], { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Runtime security/);
    let safe = false;
    try { assertNodeVersion(process.versions.node); safe = true; } catch { /* Affected diagnostic runtime. */ }
    if (safe) assert.match(result.stderr, /Electron publication is held/);
    assert.equal(await lstat(marker).catch(() => null), null, "even the fake packager must not load");
    assert.equal(await lstat(path.join(desktop, ".tmp")).catch(() => null), null, "no packaging staging before admission");
    assert.equal(await lstat(path.join(desktop, "dist")).catch(() => null), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("staged standalone runtime binding refuses replaced bytes, forged releases and unsupported targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-staged-node-"));
  try {
    const executable = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
    const target = { platform: process.platform, arch: process.arch, nodeVersion: process.version };
    await copyFile(process.execPath, executable);
    let safe = false;
    try { assertNodeVersion(process.versions.node); safe = true; } catch { /* Diagnostic runtimes remain importable. */ }
    const actual = await collectCurrentNode();
    const authenticatedWindows = actual.platform === "win32" && actual.arch === "x64"
      && actual.versions.node === "24.22.1" && actual.versions.modules === "137"
      && actual.sha256 === "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5";
    if ((safe && process.platform === "linux" && process.arch === "x64") || authenticatedWindows) {
      assert.equal((await validateStagedNode(executable, target)).sha256, actual.sha256);
    } else await assert.rejects(validateStagedNode(executable, target), /Runtime security/);
    await writeFile(executable, "replaced bytes with safe build metadata");
    await assert.rejects(validateStagedNode(executable, target), /Runtime security/);
    await assert.rejects(validateStagedNode(executable, { platform: "win32", arch: "x64", nodeVersion: "24.20.0" }), /no authenticated Windows asset binding/);
    await assert.rejects(validateStagedNode(executable, { platform: "win32", arch: "x64", nodeVersion: "24.22.1" }), /Windows Node bytes do not match the authenticated asset/);
    await assert.rejects(validateStagedNode(executable, { platform: "darwin", arch: "x64", nodeVersion: "24.22.1" }), /unsupported/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const fixture of [
  { name: "rejects the affected 24.20.0 marker before staging assets", nodeVersion: "v24.20.0", nodeAbi: "137",
    refusal: /Windows packaging requires Workbench built with Node 24\.22\.1 ABI 137\./ },
  { name: "rejects a fixed release with the wrong ABI before staging assets", nodeVersion: "v24.22.1", nodeAbi: "136",
    refusal: /Windows packaging requires Workbench built with Node 24\.22\.1 ABI 137\./ },
  { name: "accepts the fixed version and ABI through the next SQLite validation boundary", nodeVersion: "v24.22.1", nodeAbi: "137",
    refusal: /Windows packaging requires traced better-sqlite3 13\.0\.3\./ },
  { name: "rejects changed Windows N-API bytes before staging assets", nodeVersion: "v24.22.1", nodeAbi: "137",
    sqliteVersion: "13.0.3", refusal: /Windows binding does not match the authenticated asset/ },
]) {
  test("Windows traced runtime " + fixture.name, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-windows-traced-runtime-"));
    try {
      const runtimeDir = path.join(directory, "workbench");
      const server = path.join(runtimeDir, ".output/server");
      const sqlite = path.join(server, "node_modules/better-sqlite3");
      await mkdir(path.join(sqlite, "prebuilds"), { recursive: true });
      const marker = path.join(server, ".agent-native-node-runtime.json");
      const originalMarker = JSON.stringify({ nodeVersion: fixture.nodeVersion, nodeAbi: fixture.nodeAbi,
        platform: "linux", arch: "x64" }) + "\n";
      await writeFile(marker, originalMarker);
      // Both mismatched metadata and unverified binding bytes stop before any download.
      await writeFile(path.join(sqlite, "package.json"), JSON.stringify({ name: "better-sqlite3", version: fixture.sqliteVersion ?? "12.11.0" }));
      const binding = path.join(sqlite, "prebuilds/win32-x64.node");
      await writeFile(binding, "unchanged fixture binding\n");
      const nodeDir = path.join(directory, "node");
      const cacheDirectory = path.join(directory, "cache");
      await assert.rejects(prepareWindowsX64Target({ runtimeDir, nodeDir, cacheDirectory }), fixture.refusal);
      assert.equal(await readFile(marker, "utf8"), originalMarker);
      assert.equal(await readFile(binding, "utf8"), "unchanged fixture binding\n");
      assert.equal(await lstat(nodeDir).catch(() => null), null, "no staged Node before runtime validation");
      assert.equal(await lstat(cacheDirectory).catch(() => null), null, "the offline fixture must stop before downloads");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

// Missing runtime evidence is refused by the Linux evidence test below, which stages real Node bytes.
test("safe build metadata cannot authorize an unbound Node version or replaced Windows Node bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-payload-node-"));
  try {
    await mkdir(path.join(directory, "resources/workbench"), { recursive: true });
    await mkdir(path.join(directory, "resources/node"));
    await writeFile(path.join(directory, "resources/node/node.exe"), "not the authenticated Node bytes");
    const buildFile = path.join(directory, "resources/workbench/build.json");
    for (const [node, reason] of [["24.20.0", /no authenticated Windows asset binding exists/],
      ["24.22.1", /Windows Node bytes do not match the authenticated asset/]]) {
      await writeFile(buildFile, JSON.stringify({ platform: "win32", architecture: "x64", node,
        runtimeSecurity: { standalone: { sha256: "a".repeat(64), versions: { node: "24.22.1" } } } }));
      await assert.rejects(assertDesktopPayload(directory), reason);
    }
    await writeFile(buildFile, JSON.stringify({ platform: "win32", architecture: "x64", node: "24.22.1" }));
    await assert.rejects(assertDesktopPayload(directory), /Windows Node bytes do not match the authenticated asset/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("payload runtime evidence must match the staged Node exactly", {
  skip: process.platform !== "linux" || process.arch !== "x64" ? "the staged Node fixture is a Linux x64 copy" : false,
}, async (t) => {
  let facts;
  try { facts = await assertCurrentNode(); } catch { t.skip("the current Node is not an admitted runtime"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-payload-evidence-"));
  try {
    await mkdir(path.join(directory, "resources/workbench"), { recursive: true });
    await mkdir(path.join(directory, "resources/node"));
    const staged = path.join(directory, "resources/node/node");
    await copyFile(process.execPath, staged);
    await chmod(staged, 0o755);
    const buildFile = path.join(directory, "resources/workbench/build.json");
    const base = { platform: "linux", architecture: "x64", node: process.versions.node };
    const evidence = { standalone: { sha256: facts.sha256, versions: { node: facts.versions.node } } };
    // The staged Node passes validateStagedNode, so each refusal comes from the evidence comparison.
    for (const runtimeSecurity of [undefined,
      { standalone: { ...evidence.standalone, sha256: "a".repeat(64) } },
      { standalone: { ...evidence.standalone, versions: { node: "24.22.0" } } }]) {
      await writeFile(buildFile, JSON.stringify({ ...base, runtimeSecurity }));
      await assert.rejects(assertDesktopPayload(directory), /payload runtime evidence is missing or changed/);
    }
    await writeFile(buildFile, JSON.stringify({ ...base, runtimeSecurity: evidence }));
    await assert.rejects(assertDesktopPayload(directory), /Electron publication is held/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
