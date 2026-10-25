import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReleaseAssets, findPrivatePaths, listFiles, runtimeInventory, selectLicenseFiles, verifyReleaseBuild, writeChecksums,
} from "../release-assets.mjs";

const commit = "2aaf04fe2fb4d4de272f73ff516714ee9760c89c";
const version = "0.1.0-beta.1";
const build = {
  product: "Vivary", version, sourceCommit: commit, sourceDirty: false,
  workbenchOutput: { kind: "built-from-source", capturedOnce: true, sourceCommitVerified: true },
  platform: "win32", architecture: "x64", node: "v24.20.0", nodeAbi: "137", electron: "44.3.0", channel: "beta",
  originalRuntime: { python: "3.12.14", components: [{ distribution: "vivary-core", version: "0.1.0" }] },
};
const originalRuntime = {
  pythonVersion: "3.12.14", runtimeAsset: { fileName: "cpython.tar.gz", sha256: "a".repeat(64) },
  components: [{ distribution: "vivary-core", version: "0.1.0", licensePaths: ["python/Lib/site-packages/core.dist-info/licenses/LICENSE"] }],
  runtimeLicensePaths: ["python/LICENSE.txt", "licenses/python-build-standalone.rst"],
};
const sha256 = text => createHash("sha256").update(text).digest("hex");
const hasZip = spawnSync("zip", ["-v"]).status === 0;

/** Writes a packaged folder with the files the release step reads. */
async function writePayload(payload, overrides = {}) {
  const files = {
    "vivary.exe": "MZ fixture",
    "LICENSE": "electron license\n",
    "LICENSES.chromium.html": "<p>chromium</p>\n",
    "resources/node/LICENSE": "node license\n",
    "resources/workbench/THIRD-PARTY-NOTICES.txt": "notices\n",
    "resources/workbench/build.json": JSON.stringify(build),
    "resources/workbench/.output/server/index.mjs": "export {};\n",
    "resources/workbench/.output/server/node_modules/zod/package.json": JSON.stringify({ name: "zod", version: "4.6.7" }),
    "resources/workbench/.output/server/node_modules/zod/LICENSE": "zod license\n",
    "resources/workbench/.output/server/node_modules/zod/v4/package.json": JSON.stringify({ type: "module" }),
    "resources/workbench/.output/server/node_modules/@scope/pkg/package.json": JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }),
    "resources/workbench/.output/server/node_modules/a/node_modules/b/package.json": JSON.stringify({ name: "b", version: "0.0.1" }),
    "resources/original-runtime/manifest.json": JSON.stringify(originalRuntime),
    "resources/original-runtime/python/LICENSE.txt": "python license\n",
    "resources/original-runtime/licenses/python-build-standalone.rst": "pbs licenses\n",
    "resources/original-runtime/python/Lib/site-packages/core.dist-info/licenses/LICENSE": "core license\n",
    ...overrides,
  };
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    await mkdir(path.dirname(path.join(payload, name)), { recursive: true });
    await writeFile(path.join(payload, name), text);
  }
}

async function withRelease(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-release-assets-"));
  try {
    const payload = path.join(directory, "dist", "Vivary-win32-x64");
    const release = path.join(directory, "release");
    const installer = path.join(release, `Vivary-Setup-${version}.exe`);
    await writePayload(payload);
    await mkdir(release);
    await writeFile(installer, "MZ installer");
    await writeFile(`${installer}.sha256`, `${sha256("MZ installer")}  ${path.basename(installer)}\n`);
    await writeFile(`${installer}.receipt.json`, JSON.stringify({ version, payloadCommit: commit }));
    const license = path.join(directory, "LICENSE");
    await writeFile(license, "vivary license\n");
    await run({ directory, payload, release, installer, license });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a release build must be a clean, verified build of the expected commit and version", () => {
  assert.equal(verifyReleaseBuild(build, { commit, version }).channel, "beta");
  const cases = [
    ["dirty source", { sourceDirty: true }, {}, /modified checkout/],
    ["prebuilt Workbench", { workbenchOutput: { kind: "prebuilt", sourceCommitVerified: false } }, {}, /--build-workbench/],
    ["no Workbench record", { workbenchOutput: undefined }, {}, /--build-workbench/],
    ["other commit", { sourceCommit: "1".repeat(40) }, {}, /not 2aaf04fe/],
    ["short expected commit", {}, { commit: "2aaf04f" }, /not 2aaf04f/],
    ["other version", { version: "0.1.0-beta.2" }, {}, /version 0\.1\.0-beta\.2, not 0\.1\.0-beta\.1/],
    ["stale channel", { channel: "private-preview" }, {}, /channel is private-preview, not beta/],
    ["stable channel on a beta", { channel: "stable" }, {}, /not beta/],
    ["Linux package", { platform: "linux" }, {}, /not a Vivary Windows x64 package/],
    ["unreleasable version", {}, { version: "0.0.0-dev" }, /major\.minor\.patch/],
  ];
  for (const [name, change, expected, error] of cases) {
    assert.throws(() => verifyReleaseBuild({ ...build, ...change }, { commit, version, ...expected }), error, name);
  }
});

test("profile and credential names are refused, ordinary names are not", () => {
  assert.deepEqual(findPrivatePaths([
    ".env", "resources/.ENV.local", "resources/x/.vivary/workbench/db.sqlite", ".ssh/known_hosts", "a/.npmrc",
    "a/.git/config", "keys/id_ed25519", ".git-credentials", ".codex/auth.json",
    ".env.example", "resources/envelope.js", "LICENSE", "a/.github/funding.yml", "id_rsa.pub",
  ]), [
    ".env", "resources/.ENV.local", "resources/x/.vivary/workbench/db.sqlite", ".ssh/known_hosts", "a/.npmrc",
    "a/.git/config", "keys/id_ed25519", ".git-credentials", ".codex/auth.json",
  ]);
});

test("licenses come from license names and the original runtime manifest", () => withRelease(async ({ payload }) => {
  const files = await listFiles(payload);
  assert.deepEqual(selectLicenseFiles(files, originalRuntime), [
    "LICENSE", "LICENSES.chromium.html", "resources/node/LICENSE",
    "resources/original-runtime/licenses/python-build-standalone.rst",
    "resources/original-runtime/python/LICENSE.txt",
    "resources/original-runtime/python/Lib/site-packages/core.dist-info/licenses/LICENSE",
    "resources/workbench/.output/server/node_modules/zod/LICENSE",
    "resources/workbench/THIRD-PARTY-NOTICES.txt",
  ]);
  for (const missing of ["resources/node/LICENSE", "LICENSES.chromium.html"]) {
    assert.throws(() => selectLicenseFiles(files.filter(file => file !== missing), originalRuntime),
      new RegExp(`missing license files: ${missing.replaceAll(".", "\\.")}`));
  }
  assert.throws(() => selectLicenseFiles(files, { ...originalRuntime, runtimeLicensePaths: ["python/COPYING"] }),
    /missing license files: resources\/original-runtime\/python\/COPYING/);
}));

test("the runtime inventory lists the runtimes and each Workbench server package", () => withRelease(async ({ payload }) => {
  const inventory = await runtimeInventory(payload, await listFiles(payload), build, originalRuntime);
  assert.deepEqual(inventory, {
    product: "Vivary", version, channel: "beta", sourceCommit: commit, platform: "win32", architecture: "x64",
    electron: "44.3.0", node: { version: "v24.20.0", abi: "137" },
    python: { version: "3.12.14", asset: originalRuntime.runtimeAsset },
    originalRuntimeComponents: [{ distribution: "vivary-core", version: "0.1.0" }],
    workbenchPackages: [
      { name: "@scope/pkg", version: "1.2.3", path: "resources/workbench/.output/server/node_modules/@scope/pkg" },
      { name: "b", version: "0.0.1", path: "resources/workbench/.output/server/node_modules/a/node_modules/b" },
      { name: "zod", version: "4.6.7", path: "resources/workbench/.output/server/node_modules/zod" },
    ],
  });
}));

test("SHA256SUMS covers every file in the folder in sha256sum form", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-release-sums-"));
  try {
    await writeFile(path.join(directory, "b.zip"), "b");
    await writeFile(path.join(directory, "a.exe"), "a");
    await mkdir(path.join(directory, "folder"));
    assert.deepEqual(await writeChecksums(directory), ["a.exe", "b.zip"]);
    assert.equal(await readFile(path.join(directory, "SHA256SUMS"), "utf8"), `${sha256("a")}  a.exe\n${sha256("b")}  b.zip\n`);
    await assert.rejects(writeChecksums(directory), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release assets refuse a payload that does not match its installer or holds private files", () => withRelease(async ({ payload, installer, license }) => {
  await assert.rejects(buildReleaseAssets({ payload, installer, version, license }), /Usage/);
  await writeFile(`${installer}.receipt.json`, JSON.stringify({ version, payloadCommit: "1".repeat(40) }));
  await assert.rejects(buildReleaseAssets({ payload, installer, commit, version, license }), /installer receipt names a different commit/);
  await writeFile(`${installer}.receipt.json`, JSON.stringify({ version, payloadCommit: commit }));
  await writePayload(payload, { "resources/workbench/.vivary/state.json": "{}" });
  await assert.rejects(buildReleaseAssets({ payload, installer, commit, version, license }),
    /profile or credential files: resources\/workbench\/\.vivary\/state\.json/);
}));

test("release assets write the ZIPs, metadata, inventory and checksums", { skip: !hasZip && "zip is not installed" },
  () => withRelease(async ({ payload, release, installer, license }) => {
    const result = await buildReleaseAssets({ payload, installer, commit, version, license });
    const expected = [
      "BUILD-INFO.json", "RUNTIME-INVENTORY.json", `Vivary-${version}-licenses.zip`, `Vivary-${version}-windows-x64.zip`,
      `Vivary-${version}-windows-x64.zip.sha256`, `Vivary-Setup-${version}.exe`, `Vivary-Setup-${version}.exe.receipt.json`,
      `Vivary-Setup-${version}.exe.sha256`,
    ];
    assert.deepEqual(result.files, [...expected, "SHA256SUMS"]);
    assert.deepEqual((await readdir(release)).sort(), [...expected, "SHA256SUMS"].sort());
    assert.equal(result.licenses, 8);
    assert.equal(result.workbenchPackages, 3);
    assert.deepEqual(JSON.parse(await readFile(path.join(release, "BUILD-INFO.json"), "utf8")), build);
    execFileSync("sha256sum", ["--check", "--strict", "--quiet", "SHA256SUMS"], { cwd: release });
    execFileSync("sha256sum", ["--check", "--strict", "--quiet", `Vivary-${version}-windows-x64.zip.sha256`], { cwd: release });
    const listing = name => execFileSync("unzip", ["-Z1", path.join(release, name)], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(listing(`Vivary-${version}-windows-x64.zip`).includes("Vivary-win32-x64/resources/workbench/build.json"));
    assert.deepEqual(listing(`Vivary-${version}-licenses.zip`).filter(name => !name.endsWith("/")).sort(), [
      `Vivary-${version}-licenses/Vivary-win32-x64/LICENSE`,
      `Vivary-${version}-licenses/Vivary-win32-x64/LICENSES.chromium.html`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/node/LICENSE`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/original-runtime/licenses/python-build-standalone.rst`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/original-runtime/python/LICENSE.txt`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/original-runtime/python/Lib/site-packages/core.dist-info/licenses/LICENSE`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/workbench/.output/server/node_modules/zod/LICENSE`,
      `Vivary-${version}-licenses/Vivary-win32-x64/resources/workbench/THIRD-PARTY-NOTICES.txt`,
      `Vivary-${version}-licenses/vivary/LICENSE`,
    ]);
    await assert.rejects(buildReleaseAssets({ payload, installer, commit, version, license }), /Refusing to overwrite/);
  }));

test("release assets keep an existing BUILD-INFO.json", { skip: !hasZip && "zip is not installed" },
  () => withRelease(async ({ payload, release, installer, license }) => {
    // #291 review: every release file refuses an overwrite, BUILD-INFO.json included.
    await writeFile(path.join(release, "BUILD-INFO.json"), "earlier\n");
    await assert.rejects(buildReleaseAssets({ payload, installer, commit, version, license }), /EEXIST/);
    assert.equal(await readFile(path.join(release, "BUILD-INFO.json"), "utf8"), "earlier\n");
  }));
