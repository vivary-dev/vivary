import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, "../..");
const installerScript = path.join(root, "installer", "vivary.nsi");
// Changes to these paths change what an installer does, so they must be committed.
const installerSources = ["packages/desktop/installer", "packages/desktop/build-installer.mjs"];
const usage = "Usage: node build-installer.mjs --payload <Vivary-win32-x64 directory> --output <Vivary-Setup-<commit>.exe> [--manifest <package-file-manifest.json>]";
// Must match MAX_LIST_LINE in installer/vivary.nsi.
const maxListLine = 240;

/** Lists every regular file and folder under the payload. Links are refused, because makensis would follow them. */
async function listPayload(directory) {
  const files = [];
  const directories = [];
  let totalBytes = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        directories.push(relative);
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
        totalBytes += (await stat(absolute)).size;
      } else {
        throw new Error(`The payload may contain only files and folders: ${absolute}`);
      }
    }
  }
  return { files: files.sort(), directories: directories.sort(), totalBytes };
}

/**
 * Refuses a payload path the installer's list check would reject, so the
 * build fails instead of the uninstaller. The list is read as plain ASCII.
 */
function requireListablePath(relative, isDirectory) {
  const line = relative.replaceAll("/", "\\") + (isDirectory ? "\\" : "");
  const parts = relative.split("/");
  if (!/^[\x20-\x7e]+$/.test(relative) || /[:*?"<>|\\]/.test(relative) || line.length > maxListLine
    || parts.some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`The installer cannot list this payload path: ${relative}`);
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Checks that the payload holds exactly the manifest's files with the manifest's SHA-256 values. */
export async function verifyPayloadManifest(payloadDir, files, manifestFile) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The payload manifest must map each relative path to its SHA-256.");
  }
  const expected = new Map(Object.entries(manifest));
  const present = new Set(files);
  const missing = [...expected.keys()].filter(name => !present.has(name));
  const extra = files.filter(name => !expected.has(name));
  const changed = [];
  for (const name of files) {
    if (expected.has(name) && await sha256(path.join(payloadDir, ...name.split("/"))) !== String(expected.get(name)).toLowerCase()) {
      changed.push(name);
    }
  }
  if (missing.length || extra.length || changed.length) {
    const sample = list => list.slice(0, 5).join(", ");
    throw new Error(`The payload does not match its manifest: ${missing.length} missing (${sample(missing)}), `
      + `${extra.length} extra (${sample(extra)}), ${changed.length} changed (${sample(changed)}).`);
  }
  return Object.freeze({ files: expected.size, sha256: await sha256(manifestFile) });
}

/** Validates the packaged folder, output path and optional manifest, and reads the version the installer will carry. */
export async function resolveInstallerInputs({ payload, output, manifest } = {}) {
  if (!payload || !output) throw new Error(usage);
  const payloadDir = path.resolve(payload);
  const outputFile = path.resolve(output);
  for (const value of [payloadDir, outputFile]) {
    // NSIS reads $ and " inside a define as syntax.
    if (/[$"]/.test(value)) throw new Error(`The installer build cannot use a path containing $ or ": ${value}`);
  }
  if (path.extname(outputFile).toLowerCase() !== ".exe") throw new Error("The installer output must end in .exe.");
  if (outputFile.startsWith(payloadDir + path.sep)) throw new Error("The installer output must be outside the payload.");
  const outputParent = await stat(path.dirname(outputFile)).catch(() => null);
  if (!outputParent?.isDirectory()) throw new Error(`The output folder does not exist: ${path.dirname(outputFile)}`);
  if (await lstat(outputFile).catch(() => null)) throw new Error(`Refusing to overwrite ${outputFile}.`);
  const payloadInfo = await lstat(payloadDir).catch(() => null);
  if (!payloadInfo?.isDirectory()) throw new Error(`The payload is not a folder: ${payloadDir}`);

  const { files, directories, totalBytes } = await listPayload(payloadDir);
  if (!files.includes("vivary.exe")) throw new Error("The payload has no vivary.exe. Pass the packaged Vivary-win32-x64 folder.");
  for (const file of files) requireListablePath(file, false);
  for (const directory of directories) requireListablePath(directory, true);
  const buildFile = path.join(payloadDir, "resources", "workbench", "build.json");
  const build = JSON.parse(await readFile(buildFile, "utf8").catch(() => {
    throw new Error("The payload has no resources/workbench/build.json.");
  }));
  if (build.product !== "Vivary" || build.platform !== "win32" || build.architecture !== "x64") {
    throw new Error("The payload is not a Vivary Windows x64 package.");
  }
  if (typeof build.version !== "string" || !/^\d+\.\d+\.\d+$/.test(build.version)) {
    throw new Error("The payload's build.json version must have the form major.minor.patch.");
  }
  if (typeof build.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(build.sourceCommit)) {
    throw new Error("The payload's build.json has no full source commit.");
  }
  // The installer's version names the commit, so the files must match it.
  if (build.sourceDirty !== false) throw new Error("The payload was built from a modified checkout.");
  const manifestCheck = manifest ? await verifyPayloadManifest(payloadDir, files, path.resolve(manifest)) : null;
  return Object.freeze({
    payloadDir, outputFile, files, directories, fileCount: files.length, totalBytes, manifest: manifestCheck,
    version: build.version, payloadCommit: build.sourceCommit, payloadCommitShort: build.sourceCommit.slice(0, 7),
  });
}

/**
 * Returns the installed-file list: files, then folders deepest first, with
 * Windows separators and CRLF endings. A folder line ends with a backslash.
 * Upgrade and uninstall delete only what this list names.
 */
export function installFileList(files, directories) {
  const depth = name => name.split("/").length;
  const folders = [...directories].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0));
  const lines = [...files].sort().map(file => file.replaceAll("/", "\\"))
    .concat(folders.map(folder => `${folder.replaceAll("/", "\\")}\\`));
  return lines.map(line => `${line}\r\n`).join("");
}

/** Returns the commit that holds the installer sources, refusing uncommitted changes to them. */
export function resolveInstallerCommit(repositoryRoot = repository) {
  const git = args => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const changes = git(["status", "--porcelain", "--untracked-files=all", "--", ...installerSources]);
  if (changes) throw new Error(`Commit the installer sources before building:\n${changes}`);
  return git(["rev-parse", "HEAD"]);
}

/** Returns makensis from MAKENSIS, or from PATH, or null when neither has it. */
export function findMakensis(env = process.env, platform = process.platform) {
  const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
  if (env.MAKENSIS) {
    if (!path.isAbsolute(env.MAKENSIS) || !isFile(env.MAKENSIS)) {
      throw new Error("MAKENSIS must be the absolute path of the makensis program.");
    }
    return env.MAKENSIS;
  }
  const name = platform === "win32" ? "makensis.exe" : "makensis";
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory && path.isAbsolute(directory) && isFile(path.join(directory, name))) return path.join(directory, name);
  }
  return null;
}

/**
 * Counts the files makensis reported adding. Its -V4 log has one `File: "<name>" <n> bytes`
 * line per file, `"<source>"->"<name>"` for a renamed file, `<stored>/<n> bytes` when
 * it reuses identical earlier data, and separate "Descending to" lines for folders.
 */
export function countAddedFiles(log) {
  return log.split(/\r?\n/).filter(line => /^File: "[^"]+"(->"[^"]+")? (\d+\/)?\d+ bytes/.test(line)).length;
}

/**
 * Builds the installer, checks that every payload file went in, and writes a
 * .sha256 companion and a .receipt.json beside it. The makensis log is
 * returned, or attached to the error as `log` when the build fails.
 */
export async function buildInstaller(inputs, makensis, { installerCommit }) {
  if (!/^[0-9a-f]{40}$/.test(installerCommit ?? "")) throw new Error("The installer commit must be a full Git commit.");
  const version = spawnSync(makensis, ["-VERSION"], { encoding: "utf8" });
  if (version.error || version.status !== 0) throw new Error("makensis -VERSION failed.");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "vivary-installer-list-"));
  try {
    // The installed-file list's lines carry only the ASCII that requireListablePath allows.
    const listFile = path.join(scratch, "install-files.txt");
    await writeFile(listFile, installFileList(inputs.files, inputs.directories), "ascii");
    const result = spawnSync(makensis, [
      "-V4", "-WX", "-INPUTCHARSET", "UTF8",
      `-DPAYLOAD_DIR=${inputs.payloadDir}`,
      `-DINSTALL_LIST_FILE=${listFile}`,
      `-DOUTFILE=${inputs.outputFile}`,
      `-DLICENSE_FILE=${path.join(repository, "LICENSE")}`,
      `-DICON_FILE=${path.join(root, "assets", "vivary.ico")}`,
      `-DAPP_VERSION=${inputs.version}`,
      `-DPAYLOAD_COMMIT=${inputs.payloadCommit}`,
      `-DPAYLOAD_COMMIT_SHORT=${inputs.payloadCommitShort}`,
      `-DINSTALLER_COMMIT=${installerCommit}`,
      `-DESTIMATED_KB=${Math.ceil(inputs.totalBytes / 1024)}`,
      installerScript,
    ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    const log = result.stdout + result.stderr;
    const fail = async message => {
      // makensis writes the output as it goes, so a failed build can leave part of a file.
      await rm(inputs.outputFile, { force: true });
      return Object.assign(new Error(message), { log });
    };
    if (result.status !== 0) throw await fail(`makensis failed with exit code ${result.status}.`);
    // The payload count plus the installed-file list itself.
    const added = countAddedFiles(result.stdout);
    if (added !== inputs.fileCount + 1) {
      throw await fail(`makensis added ${added} files but the payload and list have ${inputs.fileCount + 1}. The installer was removed.`);
    }
    const digest = await sha256(inputs.outputFile);
    const { size } = await stat(inputs.outputFile);
    const name = path.basename(inputs.outputFile);
    await writeFile(`${inputs.outputFile}.sha256`, `${digest}  ${name}\n`);
    const receipt = {
      installer: name, bytes: size, sha256: digest,
      version: inputs.version, displayVersion: `${inputs.version}+${inputs.payloadCommitShort}`,
      payloadCommit: inputs.payloadCommit, installerCommit, makensisVersion: version.stdout.trim(),
      payloadFiles: inputs.fileCount, payloadFolders: inputs.directories.length, payloadBytes: inputs.totalBytes,
      payloadManifest: inputs.manifest ? { verified: true, files: inputs.manifest.files, sha256: inputs.manifest.sha256 } : { verified: false },
      filesAdded: added,
    };
    await writeFile(`${inputs.outputFile}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return Object.freeze({ outputFile: inputs.outputFile, size, sha256: digest, filesAdded: added, receipt, log });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    payload: { type: "string" }, output: { type: "string" }, manifest: { type: "string" },
  } });
  const inputs = await resolveInstallerInputs(values);
  const makensis = findMakensis();
  if (!makensis) throw new Error("makensis was not found. Install NSIS 3 or set MAKENSIS to its absolute path.");
  const installerCommit = resolveInstallerCommit();
  if (!inputs.manifest) console.error("No --manifest given. The receipt records the payload as unverified.");
  const built = await buildInstaller(inputs, makensis, { installerCommit });
  process.stdout.write(built.log);
  console.log(`${built.outputFile}\n${built.size} bytes, ${built.filesAdded} files\nSHA-256 ${built.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    if (error.log) process.stdout.write(error.log);
    console.error(error.message);
    process.exitCode = 1;
  }
}
