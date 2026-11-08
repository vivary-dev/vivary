import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseIdentity } from "./release-version.mjs";
import { zipFolder } from "./zip-writer.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, "../..");
const usage = "Usage: node release-assets.mjs --payload <Vivary-win32-x64 directory> --installer <release folder>/Vivary-Setup-<version>.exe --commit <full commit>";

// Folders and files that hold a user's profile or credentials. Matching names is
// a shape check, not proof that no private data is present. It catches a profile,
// an environment file or a key copied into the payload by mistake.
const privateFolders = new Set([".vivary", ".codex", ".claude", ".ssh", ".aws", ".gnupg", ".git"]);
const privateFiles = new Set([".env", ".npmrc", ".netrc", ".git-credentials", ".pypirc", "id_rsa", "id_ed25519"]);
const licenseName = /^(licen[cs]es?|copying|notice|third-party-notices)(?:$|[._-])/i;
// Every Windows package carries these, so a release without one is incomplete.
const requiredLicenses = ["LICENSE", "LICENSES.chromium.html", "resources/node/LICENSE",
  "resources/workbench/THIRD-PARTY-NOTICES.txt"];
const workbenchPackageFile = /^resources\/workbench\/\.output\/server\/(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/;

const sha256 = async file => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Lists every file under a folder by its forward-slash relative path, refusing links. */
export async function listFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
      else throw new Error(`A release payload may contain only files and folders: ${absolute}`);
    }
  }
  return files.sort();
}

/**
 * Refuses a payload whose build.json does not describe a clean, verified build of
 * the expected commit at the desktop package's version and its channel.
 */
export function verifyReleaseBuild(build, { commit, version }) {
  if (build.product !== "Vivary" || build.platform !== "win32" || build.architecture !== "x64") {
    throw new Error("The payload is not a Vivary Windows x64 package.");
  }
  const release = releaseIdentity(version);
  if (build.version !== version) throw new Error(`The payload is version ${build.version}, not ${version}.`);
  if (build.channel !== release.channel) throw new Error(`The payload's channel is ${build.channel}, not ${release.channel}.`);
  if (!/^[0-9a-f]{40}$/.test(commit) || build.sourceCommit !== commit) {
    throw new Error(`The payload was built from ${build.sourceCommit}, not ${commit}.`);
  }
  if (build.sourceDirty !== false) throw new Error("The payload was built from a modified checkout.");
  if (build.workbenchOutput?.sourceCommitVerified !== true) {
    throw new Error("The payload's Workbench output is not a verified source build. Package with --build-workbench.");
  }
  return release;
}

/** Returns the payload paths whose names mark a profile or credential file. */
export function findPrivatePaths(files) {
  return files.filter(file => {
    const parts = file.split("/");
    const name = parts.at(-1).toLowerCase();
    return parts.slice(0, -1).some(part => privateFolders.has(part.toLowerCase()))
      || privateFiles.has(name) || (name.startsWith(".env.") && name !== ".env.example");
  });
}

/**
 * Returns the payload's license files: every file named like a license or
 * notice, and every license the original runtime manifest lists.
 */
export function selectLicenseFiles(files, originalRuntime) {
  const present = new Set(files);
  const listed = [...originalRuntime.runtimeLicensePaths,
    ...originalRuntime.components.flatMap(component => component.licensePaths)]
    .map(file => `resources/original-runtime/${file}`);
  const missing = [...requiredLicenses, ...listed].filter(file => !present.has(file));
  if (missing.length > 0) throw new Error(`The payload is missing license files: ${missing.join(", ")}`);
  const named = files.filter(file => licenseName.test(file.split("/").at(-1)));
  return [...new Set([...named, ...listed])].sort();
}

/** Returns the runtime inventory: the bundled runtimes and every Workbench server package. */
export async function runtimeInventory(payload, files, build, originalRuntime) {
  const workbenchPackages = [];
  for (const file of files) {
    const match = workbenchPackageFile.exec(file);
    if (!match) continue;
    const { name, version } = JSON.parse(await readFile(path.join(payload, file), "utf8"));
    // A package.json without both fields marks a module format, not a package.
    if (name !== match[1] || typeof version !== "string") continue;
    workbenchPackages.push({ name, version, path: path.posix.dirname(file) });
  }
  return {
    product: build.product, version: build.version, channel: build.channel, sourceCommit: build.sourceCommit,
    platform: build.platform, architecture: build.architecture,
    electron: build.electron, node: { version: build.node, abi: build.nodeAbi },
    python: { version: originalRuntime.pythonVersion, asset: originalRuntime.runtimeAsset },
    originalRuntimeComponents: originalRuntime.components.map(({ distribution, version }) => ({ distribution, version })),
    workbenchPackages,
  };
}

/** Writes SHA256SUMS for every file directly in a folder, in `sha256sum --check` form. */
export async function writeChecksums(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name !== "SHA256SUMS").map(entry => entry.name).sort();
  const lines = [];
  for (const name of names) lines.push(`${await sha256(path.join(directory, name))}  ${name}\n`);
  await writeFile(path.join(directory, "SHA256SUMS"), lines.join(""), { flag: "wx" });
  return names;
}

/**
 * Writes the release files beside an installer built by build-installer.mjs:
 * the portable ZIP and its .sha256, a licenses ZIP, BUILD-INFO.json,
 * RUNTIME-INVENTORY.json and SHA256SUMS. The installer's receipt must name the
 * same commit and version as the payload.
 */
export async function buildReleaseAssets({ payload, installer, commit, version, license = path.join(repository, "LICENSE") }) {
  if (!payload || !installer || !commit) throw new Error(usage);
  payload = path.resolve(payload);
  installer = path.resolve(installer);
  const output = path.dirname(installer);
  const buildFile = path.join(payload, "resources", "workbench", "build.json");
  const build = JSON.parse(await readFile(buildFile, "utf8"));
  verifyReleaseBuild(build, { commit, version });
  const receipt = JSON.parse(await readFile(`${installer}.receipt.json`, "utf8"));
  if (receipt.payloadCommit !== commit || receipt.version !== version) {
    throw new Error("The installer receipt names a different commit or version than the payload.");
  }

  const files = await listFiles(payload);
  const privatePaths = findPrivatePaths(files);
  if (privatePaths.length > 0) throw new Error(`The payload holds profile or credential files: ${privatePaths.join(", ")}`);
  const originalRuntime = JSON.parse(await readFile(
    path.join(payload, "resources", "original-runtime", "manifest.json"), "utf8"));
  const licenses = selectLicenseFiles(files, originalRuntime);
  const inventory = await runtimeInventory(payload, files, build, originalRuntime);

  const base = `Vivary-${version}-windows-x64`;
  const portable = path.join(output, `${base}.zip`);
  await zipFolder(path.dirname(payload), path.basename(payload), portable);
  await writeFile(`${portable}.sha256`, `${await sha256(portable)}  ${path.basename(portable)}\n`, { flag: "wx" });

  const staging = await mkdtemp(path.join(os.tmpdir(), "vivary-release-licenses-"));
  try {
    const folder = path.join(staging, `Vivary-${version}-licenses`);
    await mkdir(path.join(folder, "vivary"), { recursive: true });
    await copyFile(license, path.join(folder, "vivary", "LICENSE"));
    for (const file of licenses) {
      const target = path.join(folder, "Vivary-win32-x64", ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(payload, ...file.split("/")), target);
    }
    await zipFolder(staging, path.basename(folder), path.join(output, `${path.basename(folder)}.zip`));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  await copyFile(buildFile, path.join(output, "BUILD-INFO.json"), constants.COPYFILE_EXCL);
  await writeFile(path.join(output, "RUNTIME-INVENTORY.json"), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
  const checked = await writeChecksums(output);
  return Object.freeze({ output, files: [...checked, "SHA256SUMS"], licenses: licenses.length,
    workbenchPackages: inventory.workbenchPackages.length });
}

async function main() {
  const { values } = parseArgs({ options: {
    payload: { type: "string" }, installer: { type: "string" }, commit: { type: "string" },
  } });
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const result = await buildReleaseAssets({ ...values, version });
  console.log(`${result.output}\n${result.files.join("\n")}\n${result.licenses} license files, ${result.workbenchPackages} Workbench packages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
