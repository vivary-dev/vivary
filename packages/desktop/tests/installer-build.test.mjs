import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildInstaller, countAddedFiles, findMakensis, resolveInstallerInputs } from "../build-installer.mjs";

const commit = "2aaf04fe2fb4d4de272f73ff516714ee9760c89c";
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

async function withFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-installer-"));
  try {
    const payload = path.join(directory, "Vivary-win32-x64");
    await writePayload(payload);
    await run({ directory, payload, output: path.join(directory, "Vivary-Setup-2aaf04f.exe") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("valid payload yields the version and commit from build.json", () => withFixture(async ({ payload, output }) => {
  const inputs = await resolveInstallerInputs({ payload, output });
  assert.equal(inputs.version, "0.0.0");
  assert.equal(inputs.sourceCommit, commit);
  assert.equal(inputs.sourceCommitShort, "2aaf04f");
  assert.equal(inputs.fileCount, 6);
  assert.equal(inputs.payloadDir, payload);
}));

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
    'OutFile: "/out/setup.exe"',
  ].join("\n");
  assert.equal(countAddedFiles(log), 3);
});

const makensis = (() => { try { return findMakensis(); } catch { return null; } })();

test("makensis builds an installer from a fixture payload", { skip: !makensis && "makensis is not installed" },
  () => withFixture(async ({ payload, output }) => {
    const inputs = await resolveInstallerInputs({ payload, output });
    const built = await buildInstaller(inputs, makensis);
    assert.equal(built.filesAdded, 6, "every payload file, including the dot folder, extensionless and duplicate files");
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "MZ");
    assert.equal(bytes.length, built.size);
    assert.equal(await readFile(`${output}.sha256`, "utf8"), `${built.sha256}  ${path.basename(output)}\n`);
    // The version resource holds these strings, so the metadata defines arrived.
    assert.ok(bytes.includes(Buffer.from("0.0.0+2aaf04f", "utf16le")));
    assert.ok(bytes.includes(Buffer.from("Vivary Setup", "utf16le")));
  }));
