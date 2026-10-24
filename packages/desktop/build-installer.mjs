import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertCurrentNode, assertDesktopPayload } from "../workbench/bin/runtime-security.mjs";
import { releaseIdentity } from "./release-version.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, "../..");
const installerScript = path.join(root, "installer", "vivary.nsi");
const licenseFile = path.join(repository, "LICENSE");
const iconFile = path.join(root, "assets", "vivary.ico");
// Every repository file the build reads or passes to makensis. A change to any
// of them changes the installer, so the recorded installer commit must hold them.
const installerSources = [
  "packages/desktop/installer", "packages/desktop/build-installer.mjs",
  "packages/desktop/release-version.mjs", "packages/desktop/assets/vivary.ico", "LICENSE",
  "packages/workbench/bin/runtime-security.mjs",
];
const usage = "Usage: node build-installer.mjs --payload <Vivary-win32-x64 directory> --output <Vivary-Setup-<commit>.exe> --manifest <package-file-manifest.json>";
// Windows reserves these device names in any path part, with or without an extension.
const reservedNames = new Set(["CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
// Windows file paths stop at 259 characters (MAX_PATH 260 with its terminator),
// and CreateDirectory stops at 247 (MAX_PATH - 12 = 248 with its terminator).
// The install root for a profile folder name of up to 40 characters,
// C:\Users\<name>\AppData\Local\Programs\Vivary\, takes 80 of them. Windows
// limits account names to 20 characters, and the profile folder adds at most a
// domain or machine suffix, so 40 leaves room. That leaves 179 for a file path,
// which MAX_LIST_LINE in installer/vivary.nsi must equal, and 167 for a folder
// path (168 for its list line with the trailing backslash). Setup also checks the
// real install root against the payload's own longest paths (RequirePathRoom).
const longestInstallRoot = "C:\\Users\\".length + 40 + "\\AppData\\Local\\Programs\\Vivary\\".length;
export const maxPayloadPath = 259 - longestInstallRoot;
export const maxFolderPath = 247 - longestInstallRoot;
// Setup writes these into the install folder root, so no payload file or folder
// there may share a name with them, in any case. installer/vivary.nsi writes
// nothing else into the install folder besides the payload.
const setupFiles = new Set(["install-files.txt", "install-files.tmp", "vivary-setup.txt", "uninstall vivary.exe"]);

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
  const parts = relative.split("/");
  if (!/^[\x20-\x7e]+$/.test(relative) || /[:*?"<>|\\]/.test(relative)
    || setupFiles.has(relative.toLowerCase())
    || parts.some(part => part === "" || part === "." || part === ".."
      // Windows drops a trailing dot or space, so the file would land under another name.
      || /[. ]$/.test(part) || reservedNames.has(part.split(".")[0].trimEnd().toUpperCase()))) {
    throw new Error(`The installer cannot list this payload path: ${relative}`);
  }
}

/**
 * Returns the longest payload file path and folder path, with Windows
 * separators and no trailing backslash, and refuses either past its budget.
 * Setup takes both lengths as LONGEST_FILE and LONGEST_FOLDER.
 */
export function longestPayloadPaths(files, directories) {
  const longest = (paths, limit, kind) => {
    const found = paths.map(name => name.replaceAll("/", "\\"))
      .reduce((best, name) => (name.length > best.length ? name : best), "");
    if (found.length > limit) {
      throw new Error(`The payload ${kind} path ${found} has ${found.length} characters. Under a long profile folder `
        + `it would pass the Windows path limit, so payload ${kind} paths may have at most ${limit}.`);
    }
    return Object.freeze({ path: found, length: found.length, limit });
  };
  return Object.freeze({
    file: longest(files, maxPayloadPath, "file"),
    folder: longest(directories, maxFolderPath, "folder"),
  });
}

/** Refuses two payload paths that name the same file on Windows, which ignores case. */
function requireDistinctOnWindows(paths) {
  const seen = new Map();
  for (const relative of paths) {
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`These payload paths are the same file on Windows: ${seen.get(key)} and ${relative}`);
    seen.set(key, relative);
  }
}

/** Reports whether `child` is `parent` or inside it, comparing as the given platform does. */
export function isSameOrInside(parent, child, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const fold = value => (platform === "win32" ? value.toLowerCase() : value);
  const relative = paths.relative(fold(parent), fold(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

/** The installer and the two files written beside it. */
export const outputFiles = output => [output, `${output}.sha256`, `${output}.receipt.json`];

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

/** Validates the packaged folder, output paths and manifest, and reads the version the installer will carry. */
export async function resolveInstallerInputs({ payload, output, manifest } = {}) {
  // The receipt records a verified payload, so the manifest is required.
  if (!payload || !output || !manifest) throw new Error(usage);
  const payloadDir = path.resolve(payload);
  const outputFile = path.resolve(output);
  for (const value of [payloadDir, outputFile]) {
    // NSIS reads $ and " inside a define as syntax.
    if (/[$"]/.test(value)) throw new Error(`The installer build cannot use a path containing $ or ": ${value}`);
  }
  if (path.extname(outputFile).toLowerCase() !== ".exe") throw new Error("The installer output must end in .exe.");
  if (isSameOrInside(payloadDir, outputFile)) throw new Error("The installer output must be outside the payload.");
  const outputParent = await stat(path.dirname(outputFile)).catch(() => null);
  if (!outputParent?.isDirectory()) throw new Error(`The output folder does not exist: ${path.dirname(outputFile)}`);
  for (const file of outputFiles(outputFile)) {
    if (await lstat(file).catch(() => null)) throw new Error(`Refusing to overwrite ${file}.`);
  }
  const payloadInfo = await lstat(payloadDir).catch(() => null);
  if (!payloadInfo?.isDirectory()) throw new Error(`The payload is not a folder: ${payloadDir}`);

  const { files, directories, totalBytes } = await listPayload(payloadDir);
  if (!files.includes("vivary.exe")) throw new Error("The payload has no vivary.exe. Pass the packaged Vivary-win32-x64 folder.");
  for (const file of files) requireListablePath(file, false);
  for (const directory of directories) requireListablePath(directory, true);
  requireDistinctOnWindows([...files, ...directories]);
  const longestPaths = longestPayloadPaths(files, directories);
  const buildFile = path.join(payloadDir, "resources", "workbench", "build.json");
  const build = JSON.parse(await readFile(buildFile, "utf8").catch(() => {
    throw new Error("The payload has no resources/workbench/build.json.");
  }));
  if (build.product !== "Vivary" || build.platform !== "win32" || build.architecture !== "x64") {
    throw new Error("The payload is not a Vivary Windows x64 package.");
  }
  let release;
  try { release = releaseIdentity(build.version); }
  catch { throw new Error("The payload's build.json version must have the form major.minor.patch or major.minor.patch-beta.N."); }
  if (typeof build.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(build.sourceCommit)) {
    throw new Error("The payload's build.json has no full source commit.");
  }
  // The installer's version names the commit, so the files must match it.
  if (build.sourceDirty !== false) throw new Error("The payload was built from a modified checkout.");
  const manifestCheck = await verifyPayloadManifest(payloadDir, files, path.resolve(manifest));
  return Object.freeze({
    payloadDir, outputFile, files, directories, fileCount: files.length, totalBytes, manifest: manifestCheck, longestPaths,
    manifestFile: path.resolve(manifest),
    version: build.version, windowsVersion: release.windowsVersion,
    payloadCommit: build.sourceCommit, payloadCommitShort: build.sourceCommit.slice(0, 7),
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
 * .sha256 companion and a .receipt.json beside it. Once makensis starts, any
 * failure removes what this build wrote, so a partial set never looks like a
 * finished build. The makensis log is returned, or attached to the error as `log`.
 */
export async function buildInstaller(inputs, makensis, { installerCommit }) {
  await assertCurrentNode();
  // Re-read the payload and its manifest here, including callers that bypass the CLI.
  const checked = await resolveInstallerInputs({ payload: inputs.payloadDir, output: inputs.outputFile, manifest: inputs.manifestFile });
  await assertDesktopPayload(checked.payloadDir);
  return compileInstaller(checked, makensis, { installerCommit });
}

// Content/compiler tests exercise this private boundary without admitting a desktop release.
async function compileInstaller(inputs, makensis, { installerCommit }) {
  if (!/^[0-9a-f]{40}$/.test(installerCommit ?? "")) throw new Error("The installer commit must be a full Git commit.");
  const version = spawnSync(makensis, ["-VERSION"], { encoding: "utf8" });
  if (version.error || version.status !== 0) throw new Error("makensis -VERSION failed.");
  const [installer, checksum, receiptFile] = outputFiles(inputs.outputFile);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "vivary-installer-list-"));
  let log = "";
  // The files this build wrote. The inputs check refused existing ones, and
  // makensis creates the installer as soon as it starts writing.
  const written = [installer];
  try {
    // The installed-file list's lines carry only the ASCII that requireListablePath allows.
    const listFile = path.join(scratch, "install-files.txt");
    await writeFile(listFile, installFileList(inputs.files, inputs.directories), "ascii");
    const result = spawnSync(makensis, [
      "-V4", "-WX", "-INPUTCHARSET", "UTF8",
      `-DPAYLOAD_DIR=${inputs.payloadDir}`,
      `-DINSTALL_LIST_FILE=${listFile}`,
      `-DOUTFILE=${installer}`,
      `-DLICENSE_FILE=${licenseFile}`,
      `-DICON_FILE=${iconFile}`,
      `-DAPP_VERSION=${inputs.version}`,
      `-DAPP_WINDOWS_VERSION=${inputs.windowsVersion}`,
      `-DPAYLOAD_COMMIT=${inputs.payloadCommit}`,
      `-DPAYLOAD_COMMIT_SHORT=${inputs.payloadCommitShort}`,
      `-DINSTALLER_COMMIT=${installerCommit}`,
      `-DESTIMATED_KB=${Math.ceil(inputs.totalBytes / 1024)}`,
      `-DLONGEST_FILE=${inputs.longestPaths.file.length}`,
      `-DLONGEST_FOLDER=${inputs.longestPaths.folder.length}`,
      installerScript,
    ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    log = result.stdout + result.stderr;
    if (result.status !== 0) throw new Error(`makensis failed with exit code ${result.status}.`);
    // The payload count plus the installed-file list itself.
    const added = countAddedFiles(result.stdout);
    if (added !== inputs.fileCount + 1) {
      throw new Error(`makensis added ${added} files but the payload and list have ${inputs.fileCount + 1}. The installer was removed.`);
    }
    const digest = await sha256(installer);
    const { size } = await stat(installer);
    const name = path.basename(installer);
    // "wx" refuses a file that appeared after the inputs were checked.
    await writeFile(checksum, `${digest}  ${name}\n`, { flag: "wx" });
    written.push(checksum);
    const receipt = {
      installer: name, bytes: size, sha256: digest,
      version: inputs.version, displayVersion: `${inputs.version}+${inputs.payloadCommitShort}`,
      payloadCommit: inputs.payloadCommit, installerCommit, makensisVersion: version.stdout.trim(),
      payloadFiles: inputs.fileCount, payloadFolders: inputs.directories.length, payloadBytes: inputs.totalBytes,
      longestPayloadFile: { ...inputs.longestPaths.file },
      longestPayloadFolder: { ...inputs.longestPaths.folder },
      payloadManifest: { verified: true, files: inputs.manifest.files, sha256: inputs.manifest.sha256 },
      filesAdded: added,
    };
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    written.push(receiptFile);
    return Object.freeze({ outputFile: installer, size, sha256: digest, filesAdded: added, receipt, log });
  } catch (error) {
    // makensis writes the installer as it goes, so a failure can leave part of it.
    for (const file of written) {
      if ((await lstat(file).catch(() => null))?.isFile()) await rm(file, { force: true });
    }
    throw Object.assign(error, { log });
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
