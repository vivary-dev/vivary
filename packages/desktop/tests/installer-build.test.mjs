import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInstaller, countAddedFiles, findMakensis, installFileList, resolveInstallerCommit,
  resolveInstallerInputs, verifyPayloadManifest,
} from "../build-installer.mjs";

const commit = "2aaf04fe2fb4d4de272f73ff516714ee9760c89c";
const installerCommit = "1111111111111111111111111111111111111111";
const buildScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build-installer.mjs");

/**
 * Writes a minimal packaged folder. The smoke build needs the dot folder, the
 * extensionless file, and two identical files, which makensis stores once.
 */
async function writePayload(directory, build = {}) {
  await mkdir(path.join(directory, "resources", "workbench", ".output", "server"), { recursive: true });
  await writeFile(path.join(directory, "vivary.exe"), "MZ fixture");
  await writeFile(path.join(directory, "version"), "44.3.0");
  await writeFile(path.join(directory, "LICENSE"), "fixture license\n");
  await writeFile(path.join(directory, "resources", "LICENSE"), "fixture license\n");
  await writeFile(path.join(directory, "resources", "workbench", ".output", "server", "index.mjs"), "export {};\n");
  await writeFile(path.join(directory, "resources", "workbench", "build.json"), JSON.stringify({
    product: "Vivary", platform: "win32", architecture: "x64", version: "0.0.0",
    sourceCommit: commit, sourceDirty: false, ...build,
  }));
}

/** Writes a manifest of the payload's current files, as the package build records it. */
async function writeManifest(payload, files, file) {
  const manifest = {};
  for (const name of files) {
    manifest[name] = createHash("sha256").update(await readFile(path.join(payload, ...name.split("/")))).digest("hex");
  }
  await writeFile(file, JSON.stringify(manifest));
  return manifest;
}

async function withFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-installer-"));
  try {
    const payload = path.join(directory, "Vivary-win32-x64");
    await writePayload(payload);
    await run({ directory, payload, output: path.join(directory, "Vivary-Setup-2aaf04f.exe"), manifest: path.join(directory, "manifest.json") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fixtureFiles = [
  "LICENSE", "resources/LICENSE", "resources/workbench/.output/server/index.mjs",
  "resources/workbench/build.json", "version", "vivary.exe",
];

test("valid payload yields its files, folders, version and commit", () => withFixture(async ({ payload, output }) => {
  const inputs = await resolveInstallerInputs({ payload, output });
  assert.equal(inputs.version, "0.0.0");
  assert.equal(inputs.payloadCommit, commit);
  assert.equal(inputs.payloadCommitShort, "2aaf04f");
  assert.deepEqual(inputs.files, fixtureFiles);
  assert.deepEqual(inputs.directories, ["resources", "resources/workbench", "resources/workbench/.output", "resources/workbench/.output/server"]);
  assert.equal(inputs.fileCount, 6);
  assert.equal(inputs.manifest, null);
}));

test("the installed-file list names files, then folders deepest first", () => {
  assert.equal(installFileList(["b/c.txt", "a.txt"], ["b", "b/d", "e"]),
    "a.txt\r\nb\\c.txt\r\nb\\d\\\r\nb\\\r\ne\\\r\n");
});

test("payload paths the installer cannot list are refused", async t => {
  const refuse = (name, setup) => t.test(name, { skip: process.platform === "win32" && "Windows cannot create these names" },
    () => withFixture(async ({ payload, output }) => {
      await setup(payload);
      await assert.rejects(resolveInstallerInputs({ payload, output }), /cannot list this payload path/);
    }));
  await refuse("colon", payload => writeFile(path.join(payload, "a:b"), "x"));
  await refuse("wildcard", payload => writeFile(path.join(payload, "a*b"), "x"));
  await refuse("backslash", payload => writeFile(path.join(payload, "a\\b"), "x"));
  await refuse("non-ASCII", payload => writeFile(path.join(payload, "café.txt"), "x"));
  await refuse("too long", async payload => {
    const deep = path.join(payload, ...Array.from({ length: 25 }, () => "abcdefghij"));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "x"), "x");
  });
  await t.test("two dots inside a name are allowed", () => withFixture(async ({ payload, output }) => {
    await writeFile(path.join(payload, "core+[...].mjs"), "x");
    assert.ok((await resolveInstallerInputs({ payload, output })).files.includes("core+[...].mjs"));
  }));
});

test("the manifest must match every payload path and SHA-256", async t => {
  await t.test("matching", () => withFixture(async ({ payload, output, manifest }) => {
    await writeManifest(payload, fixtureFiles, manifest);
    const inputs = await resolveInstallerInputs({ payload, output, manifest });
    assert.equal(inputs.manifest.files, 6);
    assert.equal(inputs.manifest.sha256, createHash("sha256").update(await readFile(manifest)).digest("hex"));
  }));
  await t.test("missing file", () => withFixture(async ({ payload, output, manifest }) => {
    await writeManifest(payload, fixtureFiles, manifest);
    await rm(path.join(payload, "version"));
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /1 missing \(version\), 0 extra/);
  }));
  await t.test("extra file", () => withFixture(async ({ payload, output, manifest }) => {
    await writeManifest(payload, fixtureFiles, manifest);
    await writeFile(path.join(payload, "added.txt"), "x");
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /0 missing \(\), 1 extra \(added\.txt\)/);
  }));
  await t.test("changed file", () => withFixture(async ({ payload, output, manifest }) => {
    await writeManifest(payload, fixtureFiles, manifest);
    await writeFile(path.join(payload, "version"), "changed");
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /1 changed \(version\)/);
  }));
  await t.test("not a path map", () => withFixture(async ({ payload, manifest }) => {
    await writeFile(manifest, "[]");
    await assert.rejects(verifyPayloadManifest(payload, fixtureFiles, manifest), /must map each relative path/);
  }));
});

test("missing arguments print usage", async () => {
  await assert.rejects(resolveInstallerInputs({}), /^Error: Usage: node build-installer\.mjs --payload/);
  await assert.rejects(resolveInstallerInputs({ payload: "x" }), /Usage/);
  assert.throws(() => execFileSync(process.execPath, [buildScript], { stdio: "pipe" }),
    error => error.status === 1 && /Usage/.test(error.stderr.toString()));
});

test("output path is validated before any build", () => withFixture(async ({ directory, payload, output }) => {
  await assert.rejects(resolveInstallerInputs({ payload, output: path.join(directory, "setup.zip") }), /must end in \.exe/);
  await assert.rejects(resolveInstallerInputs({ payload, output: path.join(directory, "missing", "setup.exe") }), /output folder does not exist/);
  await assert.rejects(resolveInstallerInputs({ payload, output: path.join(payload, "setup.exe") }), /outside the payload/);
  await assert.rejects(resolveInstallerInputs({ payload, output: path.join(directory, "a$b.exe") }), /containing \$/);
  await writeFile(output, "existing");
  await assert.rejects(resolveInstallerInputs({ payload, output }), /Refusing to overwrite/);
}));

test("payload must be a clean Vivary Windows package", async t => {
  const cases = [
    ["dirty source", { sourceDirty: true }, /modified checkout/],
    ["missing dirty flag", { sourceDirty: undefined }, /modified checkout/],
    ["short commit", { sourceCommit: "2aaf04f" }, /full source commit/],
    ["other platform", { platform: "linux" }, /not a Vivary Windows x64 package/],
    ["other product", { product: "Other" }, /not a Vivary Windows x64 package/],
    ["bad version", { version: "0.0.0+2aaf04f" }, /major\.minor\.patch/],
  ];
  for (const [name, build, expected] of cases) {
    await t.test(name, () => withFixture(async ({ payload, output }) => {
      await writePayload(payload, build);
      await assert.rejects(resolveInstallerInputs({ payload, output }), expected);
    }));
  }
  await t.test("not a folder", () => withFixture(async ({ directory, output }) => {
    await assert.rejects(resolveInstallerInputs({ payload: path.join(directory, "absent"), output }), /not a folder/);
  }));
  await t.test("no vivary.exe", () => withFixture(async ({ payload, output }) => {
    await rm(path.join(payload, "vivary.exe"));
    await assert.rejects(resolveInstallerInputs({ payload, output }), /no vivary\.exe/);
  }));
  await t.test("no build.json", () => withFixture(async ({ payload, output }) => {
    await rm(path.join(payload, "resources", "workbench", "build.json"));
    await assert.rejects(resolveInstallerInputs({ payload, output }), /no resources\/workbench\/build\.json/);
  }));
  await t.test("link inside the payload", { skip: process.platform === "win32" && "links need privileges on Windows" },
    () => withFixture(async ({ directory, payload, output }) => {
      await writeFile(path.join(directory, "outside.txt"), "outside");
      await symlink(path.join(directory, "outside.txt"), path.join(payload, "linked.txt"));
      await assert.rejects(resolveInstallerInputs({ payload, output }), /only files and folders/);
    }));
});

test("the installer commit must hold committed installer sources", () => withFixture(async ({ directory }) => {
  const repository = path.join(directory, "repository");
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  await mkdir(path.join(repository, "packages", "desktop", "installer"), { recursive: true });
  await writeFile(path.join(repository, "packages", "desktop", "installer", "vivary.nsi"), "; script\n");
  await writeFile(path.join(repository, "packages", "desktop", "build-installer.mjs"), "// build\n");
  await writeFile(path.join(repository, "README.md"), "readme\n");
  git("init", "-q");
  git("config", "user.email", "installer@example.test");
  git("config", "user.name", "Installer Test");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  assert.equal(resolveInstallerCommit(repository), git("rev-parse", "HEAD"));
  await writeFile(path.join(repository, "README.md"), "other changes do not matter\n");
  assert.equal(resolveInstallerCommit(repository), git("rev-parse", "HEAD"));
  await writeFile(path.join(repository, "packages", "desktop", "installer", "vivary.nsi"), "; changed\n");
  assert.throws(() => resolveInstallerCommit(repository), /Commit the installer sources/);
  git("checkout", "--", "packages/desktop/installer/vivary.nsi");
  await writeFile(path.join(repository, "packages", "desktop", "installer", "extra.nsh"), "; new\n");
  assert.throws(() => resolveInstallerCommit(repository), /Commit the installer sources/);
}));

test("makensis comes from MAKENSIS or PATH", () => withFixture(async ({ directory }) => {
  const program = path.join(directory, process.platform === "win32" ? "makensis.exe" : "makensis");
  await writeFile(program, "");
  assert.equal(findMakensis({ MAKENSIS: program }), program);
  assert.throws(() => findMakensis({ MAKENSIS: path.join(directory, "absent") }), /MAKENSIS must be/);
  assert.throws(() => findMakensis({ MAKENSIS: "makensis" }), /MAKENSIS must be/);
  assert.equal(findMakensis({ PATH: ["relative", directory].join(path.delimiter) }), program);
  assert.equal(findMakensis({ PATH: path.join(directory, "empty") }), null);
  assert.equal(findMakensis({}), null);
}));

test("file count reads only makensis file lines", () => {
  const log = [
    'File: "version" 6 bytes',
    'File: Descending to: "/payload/resources/"',
    'File: "index.mjs" 12 bytes',
    // makensis stores identical data once and reports the later copy as 0 bytes stored.
    'File: "LICENSE" 0/1068 bytes',
    'File: Returning to: "/payload"',
    'File: "install-files.txt"->"install-files.txt" 78 bytes',
    'OutFile: "/out/setup.exe"',
  ].join("\n");
  assert.equal(countAddedFiles(log), 4);
});

const makensis = (() => { try { return findMakensis(); } catch { return null; } })();

test("makensis builds an installer and receipt from a fixture payload", { skip: !makensis && "makensis is not installed" },
  () => withFixture(async ({ payload, output, manifest }) => {
    await writeManifest(payload, fixtureFiles, manifest);
    const inputs = await resolveInstallerInputs({ payload, output, manifest });
    await assert.rejects(buildInstaller(inputs, makensis, { installerCommit: "abc" }), /full Git commit/);
    const built = await buildInstaller(inputs, makensis, { installerCommit });
    assert.equal(built.filesAdded, 7, "every payload file, including the dot folder, extensionless and duplicate files, and the list");
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "MZ");
    assert.equal(bytes.length, built.size);
    assert.equal(await readFile(`${output}.sha256`, "utf8"), `${built.sha256}  ${path.basename(output)}\n`);
    const receipt = JSON.parse(await readFile(`${output}.receipt.json`, "utf8"));
    assert.deepEqual({ ...receipt, makensisVersion: undefined }, {
      installer: path.basename(output), bytes: built.size, sha256: built.sha256,
      version: "0.0.0", displayVersion: "0.0.0+2aaf04f", payloadCommit: commit, installerCommit,
      makensisVersion: undefined, payloadFiles: 6, payloadFolders: 4, payloadBytes: inputs.totalBytes,
      payloadManifest: { verified: true, files: 6, sha256: inputs.manifest.sha256 }, filesAdded: 7,
    });
    assert.match(receipt.makensisVersion, /^v3\./);
    // The version resource holds these strings, so the metadata defines arrived.
    for (const text of ["0.0.0+2aaf04f", "Vivary Setup", commit, installerCommit]) {
      assert.ok(bytes.includes(Buffer.from(text, "utf16le")), text);
    }
  }));
