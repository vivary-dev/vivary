import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotTrackedRepository } from "../package.mjs";
import { fileURLToPath } from "node:url";
import { assertDesktopPayload, assertNodeVersion, collectCurrentNode, validateStagedNode } from "../../workbench/bin/runtime-security.mjs";

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
    const executable = path.join(directory, "node");
    const target = { platform: process.platform, arch: process.arch, nodeVersion: process.version };
    await copyFile(process.execPath, executable);
    let safe = false;
    try { assertNodeVersion(process.versions.node); safe = true; } catch { /* Diagnostic runtimes remain importable. */ }
    if (safe && process.platform === "linux" && process.arch === "x64") {
      const actual = await collectCurrentNode();
      assert.equal((await validateStagedNode(executable, target)).sha256, actual.sha256);
    } else await assert.rejects(validateStagedNode(executable, target), /Runtime security/);
    await writeFile(executable, "replaced bytes with safe build metadata");
    await assert.rejects(validateStagedNode(executable, target), /Runtime security/);
    await assert.rejects(validateStagedNode(executable, { platform: "win32", arch: "x64", nodeVersion: "24.20.0" }), /authenticated asset/);
    await assert.rejects(validateStagedNode(executable, { platform: "win32", arch: "x64", nodeVersion: "24.22.1" }), /authenticated Windows/);
    await assert.rejects(validateStagedNode(executable, { platform: "darwin", arch: "x64", nodeVersion: "24.22.1" }), /unsupported/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("safe build metadata cannot authorize missing or replaced desktop runtime evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-payload-node-"));
  try {
    await mkdir(path.join(directory, "resources/workbench"), { recursive: true });
    await mkdir(path.join(directory, "resources/node"));
    await writeFile(path.join(directory, "resources/node/node.exe"), "not the authenticated Node bytes");
    const buildFile = path.join(directory, "resources/workbench/build.json");
    for (const node of ["24.20.0", "24.22.1"]) {
      await writeFile(buildFile, JSON.stringify({ platform: "win32", architecture: "x64", node,
        runtimeSecurity: { standalone: { sha256: "a".repeat(64), versions: { node: "24.22.1" } } } }));
      await assert.rejects(assertDesktopPayload(directory), /authenticated/);
    }
    await writeFile(buildFile, JSON.stringify({ platform: "win32", architecture: "x64", node: "24.22.1" }));
    await assert.rejects(assertDesktopPayload(directory), /Runtime security/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
