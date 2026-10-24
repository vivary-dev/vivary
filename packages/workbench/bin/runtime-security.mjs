import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
// Advisory ranges checked by the controller on 2026-10-21. Each floor applies only within its major.
export const NODE_SECURITY_FLOORS = Object.freeze({ 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" });
export const NODE_ADVISORIES = Object.freeze([
  ["CVE-2026-105482", [22, 24, 26]],
  ["CVE-2026-105483", [24, 26]], // TLS
  ["CVE-2026-106069", [22, 24, 26]],
  ["CVE-2026-111497", [22, 24, 26]], // Brotli out-of-bounds write / RCE
  ["CVE-2026-105481", [22, 24, 26]],
  ["CVE-2026-106070", [26]], // ZipFile prefix bytes after failed header validation
  ["CVE-2026-106071", [26]], // Permission issue
  ["CVE-2026-106072", [22, 24, 26]],
  ["CVE-2026-106074", [22, 24, 26]],
  ["CVE-2026-106073", [22, 24, 26]], // realpathSync permission bypass
].map(([id, majors]) => Object.freeze({ id, majors: Object.freeze(majors) })));

// Exact executable independently bound by the signed Node 24.22.1 release manifest.
// Its retained native Windows probe is separate; staged bytes and facts are still checked below.
const WINDOWS_NODE_ASSET = Object.freeze({ version: "24.22.1", platform: "win32", arch: "x64",
  fileName: "node-v24.22.1-win-x64.exe", sha256: "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5" });
const helper = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(helper), "../../..");

function refuse(message) { throw new Error(`Runtime security: ${message}`); }

function parts(version) {
  if (typeof version !== "string" || version !== version.trim()
    || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    refuse("a stable major.minor.patch Node version is required, without prerelease or build suffixes.");
  }
  const values = version.replace(/^v/, "").split(".").map(Number);
  if (!values.every(Number.isSafeInteger)) refuse("malformed Node version.");
  return values;
}

export function assertNodeVersion(version) {
  const [major, minor, patch] = parts(version);
  const floor = NODE_SECURITY_FLOORS[major];
  if (!floor) refuse(`Node ${major} is EOL, unknown or unsupported by this security policy.`);
  const [, fixedMinor, fixedPatch] = parts(floor);
  if (minor < fixedMinor || (minor === fixedMinor && patch < fixedPatch)) {
    refuse(`Node ${version} is affected by the October 2026 advisory. Node ${major} requires ${floor} or later in that line.`);
  }
  return floor;
}

export async function executableSha256(file) {
  const info = await lstat(file);
  if (!info.isFile()) refuse("the runtime executable must be a regular file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Explicit collection only. Importing this module is safe on diagnostic runtimes.
export async function collectCurrentNode() {
  const execPath = await realpath(process.execPath);
  return Object.freeze({ execPath, versions: Object.freeze({ ...process.versions }),
    platform: process.platform, arch: process.arch, sha256: await executableSha256(execPath) });
}

export function assertNodeFacts(facts) {
  if (!facts || typeof facts !== "object" || !facts.versions || typeof facts.versions !== "object"
    || typeof facts.execPath !== "string" || !path.isAbsolute(facts.execPath)
    || typeof facts.sha256 !== "string" || facts.sha256.length !== 64
    || !/^[a-f0-9]{64}$/.test(facts.sha256)) refuse("missing or malformed executable evidence.");
  if (facts.versions.electron !== undefined) refuse("Electron is not an ordinary Node runtime.");
  if (!["linux", "win32", "darwin"].includes(facts.platform) || !["x64", "arm64"].includes(facts.arch)) {
    refuse("unsupported runtime platform or architecture.");
  }
  assertNodeVersion(facts.versions.node);
  return facts;
}

export async function assertCurrentNode() {
  // No arguments, environment override or build marker can supply the current process's facts.
  return assertNodeFacts(await collectCurrentNode());
}

export async function collectExecutableNode(executable, { platform, arch }) {
  if (platform !== process.platform || arch !== process.arch) refuse("matching-platform native Node evidence is required.");
  const actualPath = await realpath(executable);
  const before = await executableSha256(actualPath);
  const result = spawnSync(actualPath, [helper, "collect"], { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 });
  if (result.error || result.status !== 0) refuse("the staged Node collector failed.");
  let facts;
  try { facts = JSON.parse(result.stdout); } catch { refuse("the staged Node collector returned malformed output."); }
  if (facts?.execPath !== actualPath || facts?.sha256 !== before
    || facts?.platform !== platform || facts?.arch !== arch || await executableSha256(actualPath) !== before) {
    refuse("the staged executable changed or its collected identity does not match its bytes.");
  }
  return assertNodeFacts(facts);
}

export async function validateStagedNode(executable, target) {
  if (!target || !["linux", "win32"].includes(target.platform) || target.arch !== "x64") {
    refuse("desktop runtime target is unsupported.");
  }
  const claimedVersion = parts(target.nodeVersion).join(".");
  let source;
  if (target.platform === "win32") {
    if (claimedVersion !== WINDOWS_NODE_ASSET.version) refuse("no authenticated Windows asset binding exists for this release.");
    if (await executableSha256(executable) !== WINDOWS_NODE_ASSET.sha256) refuse("Windows Node bytes do not match the authenticated asset.");
    // Apply the security floor before native evidence collection.
    assertNodeVersion(claimedVersion);
    source = WINDOWS_NODE_ASSET;
  } else {
    source = await assertCurrentNode();
    if (source.platform !== target.platform || source.arch !== target.arch
      || source.versions.node !== claimedVersion) refuse("the copied Node must be the actual packaging process runtime.");
    if (await executableSha256(executable) !== source.sha256) refuse("copied Node bytes differ from process.execPath.");
  }
  const facts = await collectExecutableNode(executable, target);
  if (facts.versions.node !== claimedVersion || facts.sha256 !== source.sha256) refuse("runtime release/hash binding failed.");
  return facts;
}

// Electron releases admitted for packaging, each with the Node version that DEPS pins at its tag
// and with no patches/node file touching the October fix files. Empty until a stable release
// bundles Node 24.22.1 or later: 44.9.3 bundles 24.22.0.
export const ADMITTED_ELECTRON = Object.freeze({});

function pinnedElectron() {
  try {
    return JSON.parse(readFileSync(path.join(repository, "packages/desktop/package.json"), "utf8")).devDependencies.electron;
  } catch {
    refuse("Electron publication is held. The pinned Electron version in packages/desktop/package.json cannot be read.");
  }
}

export function assertElectronPublication(version = pinnedElectron(), admitted = ADMITTED_ELECTRON) {
  if (!Object.hasOwn(admitted, version)) {
    refuse(Object.keys(admitted).length === 0
      ? `Electron publication is held. Electron ${version} is not admitted, because no stable Electron release with Node 24.22.1 or later is qualified yet. No Electron release is admitted.`
      : `Electron publication is held. Electron ${version} is not admitted. Admitted: ${Object.keys(admitted).join(", ")}.`);
  }
  assertNodeVersion(admitted[version]);
  return { electron: version, node: admitted[version] };
}

export async function assertDesktopPayload(payload) {
  const build = JSON.parse(await readFile(path.join(payload, "resources/workbench/build.json"), "utf8"));
  const executable = path.join(payload, "resources/node", build.platform === "win32" ? "node.exe" : "node");
  const facts = await validateStagedNode(executable, { platform: build.platform, arch: build.architecture, nodeVersion: build.node });
  if (!build.runtimeSecurity?.standalone || build.runtimeSecurity.standalone.sha256 !== facts.sha256
    || build.runtimeSecurity.standalone.versions?.node !== facts.versions.node) refuse("payload runtime evidence is missing or changed.");
  assertElectronPublication();
}

function checkedChild(script, args, archive) {
  // Collect in the very Node process which imports the builder or publisher, before its code runs.
  const code = `import {assertCurrentNode, executableSha256} from ${JSON.stringify(pathToFileURL(helper).href)};
await assertCurrentNode();
${archive ? `if (await executableSha256(${JSON.stringify(archive.file)}) !== ${JSON.stringify(archive.sha256)}) throw new Error("Checked archive changed");` : ""}
await import(${JSON.stringify(pathToFileURL(script).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, script, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) refuse(`guarded child failed (${result.status ?? result.signal}).`);
}

export async function runPackageBin(packageFile, name, args) {
  await assertCurrentNode();
  const root = path.dirname(await realpath(packageFile));
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
  if (typeof bin !== "string") refuse("the build package has no declared Node executable.");
  const script = await realpath(path.resolve(root, bin));
  if (!script.startsWith(root + path.sep)) refuse("the build executable escapes its package.");
  checkedChild(script, args);
}

export async function publishNpmArchive(candidateDirectory) {
  await assertCurrentNode();
  const entries = await readdir(candidateDirectory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.endsWith(".tgz")) {
    refuse("npm publication requires exactly one regular candidate tarball.");
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "vivary-checked-npm-"));
  try {
    const archive = path.join(scratch, entries[0].name);
    await copyFile(path.join(candidateDirectory, entries[0].name), archive, constants.COPYFILE_EXCL);
    await chmod(archive, 0o400);
    const digest = await executableSha256(archive);
    const validation = spawnSync(process.platform === "win32" ? "python" : "python3", [
      path.join(repository, "scripts/check_release_artifacts.py"), "--repository", repository,
      "--artifacts", scratch, "--scope", "npm",
    ], { stdio: "inherit" });
    if (validation.error || validation.status !== 0) refuse("the exact npm archive failed release-artifact validation.");
    if (await executableSha256(archive) !== digest) refuse("the checked npm archive changed.");
    let npm;
    // guard:allow-env-credential - Executable search path used to locate the installed npm entrypoint.
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        const candidate = await realpath(path.join(directory, "npm"));
        if (path.basename(candidate) === "npm-cli.js") { npm = candidate; break; }
      } catch { /* Try the next installed npm location. */ }
    }
    if (!npm) refuse("the installed npm Node entrypoint could not be resolved.");
    checkedChild(npm, ["publish", archive], { file: archive, sha256: digest });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Node resolves the main module through symlinks, so compare real paths. A symlinked
// invocation must still run the guard, never fall through and exit 0.
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try { return realpathSync(path.resolve(process.argv[1])) === helper; } catch { return false; }
}

if (invokedAsCli()) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "collect" && args.length === 0) console.log(JSON.stringify(await collectCurrentNode()));
    else if (command === "run" && args.length >= 2) await runPackageBin(args[0], args[1], args.slice(2));
    else if (command === "publish-npm" && args.length === 1) await publishNpmArchive(args[0]);
    else if (command === undefined) console.log(JSON.stringify(await assertCurrentNode()));
    else refuse("unsupported guard command.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
