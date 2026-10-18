import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { lstat, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.dirname(fileURLToPath(import.meta.url));
const installerScript = path.join(root, "installer", "vivary.nsi");
const usage = "Usage: node build-installer.mjs --payload <Vivary-win32-x64 directory> --output <Vivary-Setup-<commit>.exe>";

/** Lists every regular file under the payload. Links are refused, because makensis would follow them. */
async function listPayloadFiles(directory) {
  const files = [];
  let totalBytes = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
        totalBytes += (await stat(absolute)).size;
      } else {
        throw new Error(`The payload may contain only files and folders: ${absolute}`);
      }
    }
  }
  return { files, totalBytes };
}

/** Validates the packaged folder and output path, and reads the version the installer will carry. */
export async function resolveInstallerInputs({ payload, output } = {}) {
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

  const { files, totalBytes } = await listPayloadFiles(payloadDir);
  if (!files.includes("vivary.exe")) throw new Error("The payload has no vivary.exe. Pass the packaged Vivary-win32-x64 folder.");
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
  return Object.freeze({
    payloadDir, outputFile, fileCount: files.length, totalBytes,
    version: build.version, sourceCommit: build.sourceCommit, sourceCommitShort: build.sourceCommit.slice(0, 7),
  });
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
 * line per file, or `<stored>/<n> bytes` when it reuses identical earlier data, and
 * separate "Descending to" lines for folders.
 */
export function countAddedFiles(log) {
  return log.split(/\r?\n/).filter(line => /^File: "[^"]+" (\d+\/)?\d+ bytes/.test(line)).length;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Builds the installer, checks that every payload file went in, and writes a .sha256 companion.
 * The makensis log is returned, or attached to the error as `log` when the build fails.
 */
export async function buildInstaller(inputs, makensis) {
  const result = spawnSync(makensis, [
    "-V4", "-WX", "-INPUTCHARSET", "UTF8",
    `-DPAYLOAD_DIR=${inputs.payloadDir}`,
    `-DOUTFILE=${inputs.outputFile}`,
    `-DLICENSE_FILE=${path.resolve(root, "../../LICENSE")}`,
    `-DICON_FILE=${path.join(root, "assets", "vivary.ico")}`,
    `-DAPP_VERSION=${inputs.version}`,
    `-DSOURCE_COMMIT=${inputs.sourceCommit}`,
    `-DSOURCE_COMMIT_SHORT=${inputs.sourceCommitShort}`,
    `-DESTIMATED_KB=${Math.ceil(inputs.totalBytes / 1024)}`,
    installerScript,
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  const log = result.stdout + result.stderr;
  const fail = message => Object.assign(new Error(message), { log });
  if (result.status !== 0) throw fail(`makensis failed with exit code ${result.status}.`);
  const added = countAddedFiles(result.stdout);
  if (added !== inputs.fileCount) {
    await rm(inputs.outputFile, { force: true });
    throw fail(`makensis added ${added} files but the payload has ${inputs.fileCount}. The installer was removed.`);
  }
  const digest = await sha256(inputs.outputFile);
  const { size } = await stat(inputs.outputFile);
  await writeFile(`${inputs.outputFile}.sha256`, `${digest}  ${path.basename(inputs.outputFile)}\n`);
  return Object.freeze({ outputFile: inputs.outputFile, size, sha256: digest, filesAdded: added, log });
}

async function main() {
  const { values } = parseArgs({ options: { payload: { type: "string" }, output: { type: "string" } } });
  const inputs = await resolveInstallerInputs(values);
  const makensis = findMakensis();
  if (!makensis) throw new Error("makensis was not found. Install NSIS 3 or set MAKENSIS to its absolute path.");
  const built = await buildInstaller(inputs, makensis);
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
