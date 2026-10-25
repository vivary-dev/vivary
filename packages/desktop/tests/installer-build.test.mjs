import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInstaller as buildProductionInstaller, countAddedFiles, findMakensis, installFileList, isSameOrInside, longestPayloadPaths,
  maxFolderPath, maxPayloadPath, outputFiles, resolveInstallerCommit, resolveInstallerInputs, verifyPayloadManifest,
} from "../build-installer.mjs";
import { writePackageFileManifest } from "../package.mjs";
import { assertCurrentNode } from "../../workbench/bin/runtime-security.mjs";

const commit = "2aaf04fe2fb4d4de272f73ff516714ee9760c89c";
const installerCommit = "1111111111111111111111111111111111111111";
const buildScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build-installer.mjs");
// Retain compiler/content coverage while every desktop publication is held for Electron.
// This compiles the real private compiler body, never a production admission waiver.
const installerSource = await readFile(buildScript, "utf8");
const compilerSource = installerSource.slice(installerSource.indexOf("async function compileInstaller("), installerSource.indexOf("\nasync function main()"));
const hashSource = installerSource.slice(installerSource.indexOf("async function sha256("), installerSource.indexOf("\n/** Checks that the payload"));
const compilerDependencies = { spawnSync, createHash, createReadStream, outputFiles, mkdtemp, path, os, writeFile,
  installFileList, countAddedFiles, stat, lstat, rm,
  installerScript: path.resolve(path.dirname(buildScript), "installer/vivary.nsi"),
  licenseFile: path.resolve(path.dirname(buildScript), "../../LICENSE"),
  iconFile: path.resolve(path.dirname(buildScript), "assets/vivary.ico") };
const compileFixtureInstaller = new Function(...Object.keys(compilerDependencies),
  `${hashSource}\n${compilerSource}\nreturn compileInstaller;`)(...Object.values(compilerDependencies));
// Case-sensitive names, trailing dots and device names exist only off Windows and macOS.
const linuxOnly = process.platform !== "linux" && "needs a case-sensitive Linux file system";

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
    product: "Vivary", platform: "win32", architecture: "x64", version: "0.1.0-beta.1",
    sourceCommit: commit, sourceDirty: false, ...build,
  }));
}

/** Writes a manifest of the payload's current files, as the package build records it. */
async function writeManifest(payload, file) {
  const manifest = {};
  for (const entry of await readdir(payload, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    manifest[path.relative(payload, absolute).replaceAll(path.sep, "/")] =
      createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
  await writeFile(file, JSON.stringify(manifest));
}

/** Runs a test against a fresh payload whose manifest matches it. */
async function withFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-installer-"));
  try {
    const payload = path.join(directory, "Vivary-win32-x64");
    const manifest = path.join(directory, "manifest.json");
    await writePayload(payload);
    await writeManifest(payload, manifest);
    await run({ directory, payload, manifest, output: path.join(directory, "Vivary-Setup-2aaf04f.exe") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fixtureFiles = [
  "LICENSE", "resources/LICENSE", "resources/workbench/.output/server/index.mjs",
  "resources/workbench/build.json", "version", "vivary.exe",
];

test("valid payload yields its files, folders, version, commit and manifest", () => withFixture(async ({ payload, output, manifest }) => {
  const inputs = await resolveInstallerInputs({ payload, output, manifest });
  assert.equal(inputs.version, "0.1.0-beta.1");
  assert.equal(inputs.windowsVersion, "0.1.0.1");
  assert.equal(inputs.payloadCommit, commit);
  assert.equal(inputs.payloadCommitShort, "2aaf04f");
  assert.deepEqual(inputs.files, fixtureFiles);
  assert.deepEqual(inputs.directories, ["resources", "resources/workbench", "resources/workbench/.output", "resources/workbench/.output/server"]);
  assert.equal(inputs.fileCount, 6);
  assert.equal(inputs.manifest.files, 6);
  assert.equal(inputs.manifest.sha256, createHash("sha256").update(await readFile(manifest)).digest("hex"));
}));

test("the installed-file list names files, then folders deepest first", () => {
  assert.equal(installFileList(["b/c.txt", "a.txt"], ["b", "b/d", "e"]),
    "a.txt\r\nb\\c.txt\r\nb\\d\\\r\nb\\\r\ne\\\r\n");
});

test("payload paths the installer cannot list or Windows cannot hold are refused", async t => {
  const refuse = (name, setup, expected = /cannot list this payload path/) =>
    t.test(name, { skip: linuxOnly }, () => withFixture(async ({ payload, output, manifest }) => {
      await setup(payload);
      await writeManifest(payload, manifest);
      await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), expected);
    }));
  const file = (...parts) => async payload => {
    await mkdir(path.join(payload, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(payload, ...parts), "x");
  };
  await refuse("colon", file("a:b"));
  await refuse("wildcard", file("a*b"));
  await refuse("backslash", file("a\\b"));
  await refuse("non-ASCII", file("caf\u00e9.txt"));
  await refuse("too long", file(...Array.from({ length: 25 }, () => "abcdefghij"), "x"), /may have at most 179/);
  await refuse("trailing dot", file("notes."));
  await refuse("trailing space", file("notes "));
  await refuse("trailing dot on a folder", file("lib.", "x.js"));
  await refuse("trailing space on a folder", file("lib ", "x.js"));
  for (const name of ["install-files.txt", "Install-Files.TMP", "VIVARY-SETUP.txt", "Uninstall Vivary.exe", "INSTALL-FILES.TXT", "uninstall vivary.EXE"]) {
    await refuse(`setup's own file name ${name}`, file(name));
    await refuse(`setup's own file name ${name} as a folder`, file(name, "x.js"));
  }
  await t.test("setup's file names below the root are allowed", () => withFixture(async ({ payload, output, manifest }) => {
    await mkdir(path.join(payload, "docs"));
    await writeFile(path.join(payload, "docs", "install-files.txt"), "x");
    await writeManifest(payload, manifest);
    assert.ok((await resolveInstallerInputs({ payload, output, manifest })).files.includes("docs/install-files.txt"));
  }));
  for (const name of ["CON", "prn.txt", "Aux.tar.gz", "nul", "COM1.log", "com9", "LPT1", "lpt9.dat", "CON .txt"]) {
    await refuse(`reserved name ${name}`, file(name));
  }
  await refuse("reserved folder name", file("resources", "NUL", "x.js"));
  await refuse("files that differ only in case", file("Version"), /same file on Windows: Version and version|same file on Windows: version and Version/);
  await refuse("folders that differ only in case", file("Resources", "x.js"), /same file on Windows/);
  await t.test("names that only resemble reserved ones are allowed", () => withFixture(async ({ payload, output, manifest }) => {
    for (const name of ["core+[...].mjs", "CONSOLE.txt", "com10", "auxiliary.js", "nul_file"]) {
      await writeFile(path.join(payload, name), "x");
    }
    await writeManifest(payload, manifest);
    const { files } = await resolveInstallerInputs({ payload, output, manifest });
    for (const name of ["core+[...].mjs", "CONSOLE.txt", "com10", "auxiliary.js", "nul_file"]) assert.ok(files.includes(name), name);
  }));
});

test("the manifest must match every payload path and SHA-256", async t => {
  await t.test("missing file", () => withFixture(async ({ payload, output, manifest }) => {
    await rm(path.join(payload, "version"));
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /1 missing \(version\), 0 extra/);
  }));
  await t.test("extra file", () => withFixture(async ({ payload, output, manifest }) => {
    await writeFile(path.join(payload, "added.txt"), "x");
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /0 missing \(\), 1 extra \(added\.txt\)/);
  }));
  await t.test("changed file", () => withFixture(async ({ payload, output, manifest }) => {
    await writeFile(path.join(payload, "version"), "changed");
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /1 changed \(version\)/);
  }));
  await t.test("not a path map", () => withFixture(async ({ payload, manifest }) => {
    await writeFile(manifest, "[]");
    await assert.rejects(verifyPayloadManifest(payload, fixtureFiles, manifest), /must map each relative path/);
  }));
});

test("the packager's file manifest is the one the installer build checks", () => withFixture(async ({ directory, payload, output }) => {
  const manifest = path.join(directory, "package-file-manifest.json");
  assert.equal(await writePackageFileManifest(payload, manifest), 6);
  const written = JSON.parse(await readFile(manifest, "utf8"));
  assert.deepEqual(Object.keys(written), fixtureFiles, "paths relative to the tree, forward slashes, sorted");
  assert.equal(written.version, createHash("sha256").update("44.3.0").digest("hex"));
  for (const digest of Object.values(written)) assert.match(digest, /^[0-9a-f]{64}$/);
  const inputs = await resolveInstallerInputs({ payload, output, manifest });
  assert.equal(inputs.manifest.files, 6);
  await assert.rejects(writePackageFileManifest(payload, manifest), /EEXIST/, "an existing manifest is not replaced");
}));

test("the packager's file manifest refuses links", { skip: process.platform === "win32" && "links need privileges on Windows" },
  () => withFixture(async ({ directory, payload }) => {
    await symlink(path.join(payload, "version"), path.join(payload, "linked"));
    await assert.rejects(writePackageFileManifest(payload, path.join(directory, "m.json")), /only files and folders/);
  }));

test("the path budget leaves room for a 40-character profile folder", () => {
  // Files: 259 usable characters minus C:\Users\<40 characters>\AppData\Local\Programs\Vivary\ (80).
  assert.equal(maxPayloadPath, 179);
  // Folders: CreateDirectory allows 247 characters (MAX_PATH - 12 with its terminator), minus the same 80.
  assert.equal(maxFolderPath, 167);
  const fileAtLimit = `${"a".repeat(173)}/b.txt`;
  const folderAtLimit = `${"a".repeat(160)}/folder`;
  const longest = longestPayloadPaths([fileAtLimit, "x"], [folderAtLimit, "a"]);
  assert.deepEqual({ ...longest.file }, { path: fileAtLimit.replaceAll("/", "\\"), length: 179, limit: 179 });
  assert.deepEqual({ ...longest.folder }, { path: folderAtLimit.replaceAll("/", "\\"), length: 167, limit: 167 });
  assert.throws(() => longestPayloadPaths([`${"a".repeat(179)}x`], []), /payload file path .* has 180 characters/);
  assert.throws(() => longestPayloadPaths([], [`${"a".repeat(167)}x`]), /payload folder path .* has 168 characters.*at most 167/);
  // A file may sit in a folder of up to 167 characters and still reach 179.
  assert.equal(longestPayloadPaths([`${"a".repeat(167)}/0123456789a`], ["a".repeat(167)]).file.length, 179);
});

test("payload, output and manifest are all required", async () => {
  await assert.rejects(resolveInstallerInputs({}), /^Error: Usage: node build-installer\.mjs --payload/);
  await assert.rejects(resolveInstallerInputs({ payload: "x", output: "y.exe" }), /Usage: .* --manifest/);
  assert.throws(() => execFileSync(process.execPath, [buildScript], { stdio: "pipe" }),
    error => error.status === 1 && /Usage/.test(error.stderr.toString()));
});

test("output paths are validated before any build", () => withFixture(async ({ directory, payload, output, manifest }) => {
  const resolve = target => resolveInstallerInputs({ payload, output: target, manifest });
  await assert.rejects(resolve(path.join(directory, "setup.zip")), /must end in \.exe/);
  await assert.rejects(resolve(path.join(directory, "missing", "setup.exe")), /output folder does not exist/);
  await assert.rejects(resolve(path.join(payload, "setup.exe")), /outside the payload/);
  await assert.rejects(resolve(path.join(directory, "a$b.exe")), /containing \$/);
  for (const existing of outputFiles(output)) {
    await writeFile(existing, "existing");
    await assert.rejects(resolve(output), error => error.message === `Refusing to overwrite ${existing}.`);
    await rm(existing);
  }
}));

test("output inside the payload is detected as each platform compares paths", () => {
  assert.equal(isSameOrInside("C:\\Build\\Payload", "c:\\build\\payload\\Setup.exe", "win32"), true);
  assert.equal(isSameOrInside("C:\\Build\\Payload", "C:\\BUILD\\PAYLOAD", "win32"), true);
  assert.equal(isSameOrInside("C:\\Build\\Payload", "C:\\Build\\Payload2\\Setup.exe", "win32"), false);
  assert.equal(isSameOrInside("C:\\Build\\Payload", "C:\\Build\\Setup.exe", "win32"), false);
  assert.equal(isSameOrInside("/build/payload", "/build/payload/setup.exe", "linux"), true);
  assert.equal(isSameOrInside("/build/payload", "/build/Payload/setup.exe", "linux"), false);
  assert.equal(isSameOrInside("/build/payload", "/build/payload/..setup.exe", "linux"), true);
  assert.equal(isSameOrInside("/build/payload", "/build/payload-other/setup.exe", "linux"), false);
});

test("payload must be a clean Vivary Windows package", async t => {
  const cases = [
    ["dirty source", { sourceDirty: true }, /modified checkout/],
    ["missing dirty flag", { sourceDirty: undefined }, /modified checkout/],
    ["short commit", { sourceCommit: "2aaf04f" }, /full source commit/],
    ["other platform", { platform: "linux" }, /not a Vivary Windows x64 package/],
    ["other product", { product: "Other" }, /not a Vivary Windows x64 package/],
    ["build metadata in the version", { version: "0.0.0+2aaf04f" }, /major\.minor\.patch/],
    ["release candidate", { version: "0.1.0-rc.1" }, /major\.minor\.patch or major\.minor\.patch-beta\.N/],
    ["beta without a number", { version: "0.1.0-beta" }, /major\.minor\.patch/],
    ["part too large for Windows", { version: "0.65536.0" }, /major\.minor\.patch/],
    ["missing version", { version: undefined }, /major\.minor\.patch/],
  ];
  for (const [name, build, expected] of cases) {
    await t.test(name, () => withFixture(async ({ payload, output, manifest }) => {
      await writePayload(payload, build);
      await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), expected);
    }));
  }
  await t.test("not a folder", () => withFixture(async ({ directory, output, manifest }) => {
    await assert.rejects(resolveInstallerInputs({ payload: path.join(directory, "absent"), output, manifest }), /not a folder/);
  }));
  await t.test("no vivary.exe", () => withFixture(async ({ payload, output, manifest }) => {
    await rm(path.join(payload, "vivary.exe"));
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /no vivary\.exe/);
  }));
  await t.test("no build.json", () => withFixture(async ({ payload, output, manifest }) => {
    await rm(path.join(payload, "resources", "workbench", "build.json"));
    await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /no resources\/workbench\/build\.json/);
  }));
  await t.test("link inside the payload", { skip: process.platform === "win32" && "links need privileges on Windows" },
    () => withFixture(async ({ directory, payload, output, manifest }) => {
      await writeFile(path.join(directory, "outside.txt"), "outside");
      await symlink(path.join(directory, "outside.txt"), path.join(payload, "linked.txt"));
      await assert.rejects(resolveInstallerInputs({ payload, output, manifest }), /only files and folders/);
    }));
});

test("the installer commit must hold every committed installer source", () => withFixture(async ({ directory }) => {
  const repository = path.join(directory, "repository");
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  const sources = {
    "packages/desktop/installer/vivary.nsi": "; script\n",
    "packages/desktop/build-installer.mjs": "// build\n",
    "packages/desktop/release-version.mjs": "// version\n",
    "packages/workbench/bin/runtime-security.mjs": "// policy\n",
    "packages/desktop/assets/vivary.ico": "icon\n",
    "LICENSE": "license\n",
    "README.md": "readme\n",
  };
  for (const [name, text] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await writeFile(path.join(repository, name), text);
  }
  git("init", "-q");
  git("config", "user.email", "installer@example.test");
  git("config", "user.name", "Installer Test");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  assert.equal(resolveInstallerCommit(repository), git("rev-parse", "HEAD"));
  await writeFile(path.join(repository, "README.md"), "other changes do not matter\n");
  assert.equal(resolveInstallerCommit(repository), git("rev-parse", "HEAD"));
  for (const name of Object.keys(sources).filter(name => name !== "README.md")) {
    await writeFile(path.join(repository, name), "changed\n");
    assert.throws(() => resolveInstallerCommit(repository), /Commit the installer sources/, name);
    git("checkout", "--", name);
  }
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

/**
 * Writes a stand-in for makensis that writes the -DOUTFILE file and reports
 * FAKE_FILES added files, so the failure paths run without NSIS.
 */
async function writeFakeMakensis(directory) {
  const program = path.join(directory, "fake-makensis");
  await writeFile(program, [
    "#!/bin/sh",
    'if [ "$1" = "-VERSION" ]; then echo v3.10-fake; exit 0; fi',
    'for argument in "$@"; do case "$argument" in -DOUTFILE=*) printf MZfake > "${argument#-DOUTFILE=}";; esac; done',
    'i=0; while [ "$i" -lt "$FAKE_FILES" ]; do echo "File: \\"f$i\\" 1 bytes"; i=$((i + 1)); done',
    // Echo the arguments so a test can read the defines the build passed.
    'for argument in "$@"; do echo "argument $argument"; done',
  ].join("\n"));
  await chmod(program, 0o755);
  return program;
}

test("the build passes the payload's longest file and folder lengths to setup",
  { skip: process.platform === "win32" && "the stand-in makensis is a shell script" },
  () => withFixture(async ({ directory, payload, output, manifest }) => {
    const inputs = await resolveInstallerInputs({ payload, output, manifest });
    process.env.FAKE_FILES = "7";
    let built;
    try { built = await compileFixtureInstaller(inputs, await writeFakeMakensis(directory), { installerCommit }); }
    finally { delete process.env.FAKE_FILES; }
    // resources\workbench\.output\server\index.mjs and resources\workbench\.output\server.
    assert.ok(built.log.includes("argument -DLONGEST_FILE=44\n"), built.log);
    assert.ok(built.log.includes("argument -DLONGEST_FOLDER=34\n"), built.log);
    assert.equal(built.receipt.longestPayloadFile.length, 44);
    assert.equal(built.receipt.longestPayloadFolder.length, 34);
  }));

test("a failed build leaves no installer, checksum or receipt", { skip: process.platform === "win32" && "the stand-in makensis is a shell script" },
  async t => {
    await t.test("file count mismatch", () => withFixture(async ({ directory, payload, output, manifest }) => {
      const inputs = await resolveInstallerInputs({ payload, output, manifest });
      process.env.FAKE_FILES = "3";
      try {
        await assert.rejects(compileFixtureInstaller(inputs, await writeFakeMakensis(directory), { installerCommit }), /added 3 files/);
      } finally { delete process.env.FAKE_FILES; }
      for (const file of outputFiles(output)) assert.equal(await lstat(file).catch(() => null), null, file);
    }));
    await t.test("receipt cannot be written", () => withFixture(async ({ directory, payload, output, manifest }) => {
      const inputs = await resolveInstallerInputs({ payload, output, manifest });
      // A folder that appears at the receipt path after the inputs check.
      await mkdir(`${output}.receipt.json`);
      process.env.FAKE_FILES = "7";
      try {
        await assert.rejects(compileFixtureInstaller(inputs, await writeFakeMakensis(directory), { installerCommit }), /EEXIST/);
      } finally { delete process.env.FAKE_FILES; }
      assert.equal(await lstat(output).catch(() => null), null, "installer removed");
      assert.equal(await lstat(`${output}.sha256`).catch(() => null), null, "checksum removed");
      assert.ok((await lstat(`${output}.receipt.json`)).isDirectory(), "a path this build did not write stays");
    }));
  });

const makensis = (() => { try { return findMakensis(); } catch { return null; } })();
// The production builder refuses an affected current Node before it checks the payload.
const admittedNode = await assertCurrentNode().then(() => true, () => false);

test("production installer refuses unverified runtime payloads before invoking NSIS", () => withFixture(async ({ directory, payload, output, manifest }) => {
  const marker = path.join(directory, "nsis-invoked");
  // A Node script used as an executable is sufficient to detect any attempted invocation on Unix.
  // On Windows a missing executable is also an error if the production boundary reaches NSIS.
  const fake = path.join(directory, "makensis");
  await writeFile(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`);
  await chmod(fake, 0o700);
  await writeFile(path.join(payload, "resources/workbench/build.json"), JSON.stringify({
    product: "Vivary", platform: "win32", architecture: "x64", version: "0.0.0", sourceCommit: commit, sourceDirty: false,
    node: "24.22.1", runtimeSecurity: { standalone: { sha256: "a".repeat(64), versions: { node: "24.22.1" } } },
  }));
  await mkdir(path.join(payload, "resources/node"), { recursive: true });
  await writeFile(path.join(payload, "resources/node/node.exe"), "synthetic corrupt Windows Node fixture\n");
  await writeManifest(payload, manifest);
  const inputs = await resolveInstallerInputs({ payload, output, manifest });
  // A non-admitted Node can be affected, EOL, unknown or a prerelease. Each refuses with its own reason.
  await assert.rejects(buildProductionInstaller(inputs, fake, { installerCommit }), admittedNode
    ? /Windows Node bytes do not match the authenticated asset/ : /Runtime security/);
  assert.equal(await lstat(marker).catch(() => null), null, "runtime refusal precedes even makensis -VERSION");
  assert.equal(await lstat(output).catch(() => null), null);
}));

test("production installer rechecks manifest bytes instead of trusting a previously resolved input",
  { skip: !admittedNode && "the current Node is not an admitted runtime" }, () => withFixture(async ({ directory, payload, output, manifest }) => {
  const inputs = await resolveInstallerInputs({ payload, output, manifest });
  await writeFile(path.join(payload, "vivary.exe"), "changed after input validation");
  await assert.rejects(buildProductionInstaller(inputs, path.join(directory, "missing-nsis"), { installerCommit }),
    /does not match its manifest/);
  assert.equal(await lstat(output).catch(() => null), null);
}));

test("makensis builds an installer and receipt from a fixture payload", { skip: !makensis && "makensis is not installed" },
  () => withFixture(async ({ payload, output, manifest }) => {
    const inputs = await resolveInstallerInputs({ payload, output, manifest });
    await assert.rejects(compileFixtureInstaller(inputs, makensis, { installerCommit: "abc" }), /full Git commit/);
    const built = await compileFixtureInstaller(inputs, makensis, { installerCommit });
    assert.equal(built.filesAdded, 7, "every payload file, including the dot folder, extensionless and duplicate files, and the list");
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "MZ");
    assert.equal(bytes.length, built.size);
    assert.equal(await readFile(`${output}.sha256`, "utf8"), `${built.sha256}  ${path.basename(output)}\n`);
    const receipt = JSON.parse(await readFile(`${output}.receipt.json`, "utf8"));
    assert.deepEqual({ ...receipt, makensisVersion: undefined }, {
      installer: path.basename(output), bytes: built.size, sha256: built.sha256,
      version: "0.1.0-beta.1", displayVersion: "0.1.0-beta.1+2aaf04f", payloadCommit: commit, installerCommit,
      makensisVersion: undefined, payloadFiles: 6, payloadFolders: 4, payloadBytes: inputs.totalBytes,
      longestPayloadFile: { path: "resources\\workbench\\.output\\server\\index.mjs", length: 44, limit: 179 },
      longestPayloadFolder: { path: "resources\\workbench\\.output\\server", length: 34, limit: 167 },
      payloadManifest: { verified: true, files: 6, sha256: inputs.manifest.sha256 }, filesAdded: 7,
    });
    assert.match(receipt.makensisVersion, /^v3\./);
    // The version resource holds these strings, so the metadata defines arrived.
    for (const text of ["0.1.0-beta.1+2aaf04f", "Vivary Setup", commit, installerCommit]) {
      assert.ok(bytes.includes(Buffer.from(text, "utf16le")), text);
    }
  }));
