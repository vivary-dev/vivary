import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMetadata, buildWorkbenchFromSource } from "../package.mjs";
import { releaseIdentity } from "../release-version.mjs";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const commit = "2aaf04fe2fb4d4de272f73ff516714ee9760c89c";
const cleanSource = { sourceCommit: commit, sourceDirty: false, kind: "git-archive", trackedOverlayCount: 0 };
const windowsTarget = { platform: "win32", arch: "x64", nodeVersion: "v24.19.0", nodeAbi: "137" };
// validateStagedNode also returns the executable path, which build.json leaves out.
const standalone = { sha256: "a".repeat(64), versions: { node: "24.19.0" }, platform: "win32", arch: "x64",
  executable: "/stage/node/node.exe" };
const originalRuntime = {
  pythonVersion: "3.12.14",
  components: [{ distribution: "vivary-core", version: "0.1.0", path: "ignored" }],
};

test("the desktop package is 0.1.0-beta.1 on the beta channel", async () => {
  const manifest = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(desktop, "package-lock.json"), "utf8"));
  assert.equal(manifest.version, "0.1.0-beta.1");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual({ ...releaseIdentity(manifest.version) },
    { version: "0.1.0-beta.1", channel: "beta", windowsVersion: "0.1.0.1" });
});

test("a release version maps to its channel and Windows version", () => {
  assert.deepEqual({ ...releaseIdentity("0.1.0") }, { version: "0.1.0", channel: "stable", windowsVersion: "0.1.0.0" });
  assert.deepEqual({ ...releaseIdentity("2.10.3-beta.12") },
    { version: "2.10.3-beta.12", channel: "beta", windowsVersion: "2.10.3.12" });
  assert.equal(releaseIdentity("65535.0.0-beta.65535").windowsVersion, "65535.0.0.65535");
  for (const version of ["0.0.0+2aaf04f", "0.1.0-rc.1", "0.1.0-beta", "0.1.0-beta.01", "01.0.0", "0.1",
    "0.1.0.1", "0.65536.0", "0.1.0-beta.65536", " 0.1.0", undefined, 1]) {
    assert.throws(() => releaseIdentity(version), /major\.minor\.patch or major\.minor\.patch-beta\.N/, String(version));
  }
});

test("build metadata records the version, the beta channel and a verified source build", async () => {
  const manifest = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const metadata = buildMetadata({ manifest, source: cleanSource, target: windowsTarget, standalone, originalRuntime, workbenchCommit: commit });
  assert.deepEqual(metadata, {
    product: "Vivary", version: "0.1.0-beta.1", sourceCommit: commit, sourceDirty: false,
    sourceSnapshot: { kind: "git-archive", trackedOverlayCount: 0, commitMatchesPackagedSource: true, untrackedFilesIncluded: false },
    workbenchOutput: { kind: "built-from-source", capturedOnce: true, sourceCommitVerified: true },
    platform: "win32", architecture: "x64", node: "v24.19.0", nodeAbi: "137",
    electron: manifest.devDependencies.electron,
    runtimeSecurity: { standalone: { sha256: "a".repeat(64), versions: { node: "24.19.0" }, platform: "win32", arch: "x64" } },
    buildHost: { platform: process.platform, architecture: process.arch },
    channel: "beta",
    originalRuntime: {
      manifest: "../original-runtime/manifest.json", python: "3.12.14",
      components: [{ distribution: "vivary-core", version: "0.1.0" }],
    },
  });
});

test("build metadata never verifies a prebuilt, mismatched or dirty Workbench output", () => {
  const manifest = { version: "0.1.0-beta.1", devDependencies: { electron: "44.3.0" } };
  const workbenchOutput = (source, workbenchCommit) =>
    buildMetadata({ manifest, source, target: windowsTarget, standalone, originalRuntime, workbenchCommit }).workbenchOutput;
  assert.deepEqual(workbenchOutput(cleanSource, undefined), { kind: "prebuilt", capturedOnce: true, sourceCommitVerified: false });
  assert.deepEqual(workbenchOutput(cleanSource, "1".repeat(40)),
    { kind: "built-from-source", capturedOnce: true, sourceCommitVerified: false });
  const dirtySource = { ...cleanSource, sourceDirty: true, kind: "git-archive-with-tracked-overlays", trackedOverlayCount: 1 };
  assert.equal(workbenchOutput(dirtySource, commit).sourceCommitVerified, false);
  assert.throws(() => buildMetadata({ manifest: { ...manifest, version: "0.0.0-private" }, source: cleanSource,
    target: windowsTarget, standalone, originalRuntime }), /major\.minor\.patch/);
});

test("a source build of Workbench needs a checkout that stays clean on one commit", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-workbench-build-"));
  const repository = path.join(directory, "repository");
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  const tracked = path.join(repository, "tracked.txt");
  try {
    await mkdir(repository);
    git("init", "-q");
    git("config", "user.email", "packaging@example.test");
    git("config", "user.name", "Packaging Test");
    await writeFile(path.join(repository, ".gitignore"), ".output/\n");
    await writeFile(tracked, "committed\n");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    const head = git("rev-parse", "HEAD");

    await t.test("a clean build returns the commit it built", () => {
      let ran = false;
      // Ignored build output does not count as a change.
      const built = buildWorkbenchFromSource(repository, () => {
        ran = true;
        mkdirSync(path.join(repository, ".output"));
        writeFileSync(path.join(repository, ".output", "index.mjs"), "built\n");
      });
      assert.equal(built, head);
      assert.ok(ran);
    });
    await t.test("a modified checkout is refused before the build runs", async () => {
      await writeFile(tracked, "modified\n");
      let ran = false;
      assert.throws(() => buildWorkbenchFromSource(repository, () => { ran = true; }), /needs a clean checkout:\n M tracked.txt/);
      assert.equal(ran, false);
      git("checkout", "--", "tracked.txt");
    });
    await t.test("an untracked file is refused before the build runs", async () => {
      await writeFile(path.join(repository, "new.txt"), "new\n");
      assert.throws(() => buildWorkbenchFromSource(repository, () => {}), /needs a clean checkout:\n\?\? new.txt/);
      await rm(path.join(repository, "new.txt"));
    });
    await t.test("a build that changes a tracked file is refused", async () => {
      assert.throws(() => buildWorkbenchFromSource(repository, () => {
        writeFileSync(tracked, "generated\n");
      }), /changed while Workbench was building:\n M tracked.txt/);
      git("checkout", "--", "tracked.txt");
    });
    await t.test("a build that leaves an untracked file is refused", async () => {
      assert.throws(() => buildWorkbenchFromSource(repository, () => {
        writeFileSync(path.join(repository, "generated.txt"), "generated\n");
      }), /changed while Workbench was building:\n\?\? generated.txt/);
      await rm(path.join(repository, "generated.txt"));
    });
    await t.test("a build during which HEAD moves is refused", () => {
      assert.throws(() => buildWorkbenchFromSource(repository, () => {
        git("commit", "-q", "--allow-empty", "-m", "moved");
      }), /HEAD moved while Workbench was building/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
