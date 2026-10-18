import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCacheDirectory = path.join(packageRoot, ".tmp", "windows-assets");
const SQLITE_VERSION = "12.11.1";
const SQLITE_ARCHIVE_ENTRY = "build/Release/better_sqlite3.node";
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const NODE_ASSET = Object.freeze({
  fileName: "node-v24.20.0-win-x64.exe",
  sha256: "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5",
  url: "https://nodejs.org/dist/v24.20.0/win-x64/node.exe",
});

const SQLITE_ASSET = Object.freeze({
  fileName: "better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz",
  sha256: "4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255",
  url: "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz",
});

export const WINDOWS_X64_TARGET = Object.freeze({
  platform: "win32",
  arch: "x64",
  nodeVersion: "v24.20.0",
  nodeAbi: "137",
  nodeExecutable: "node.exe",
});

export async function prepareWindowsX64Target({ runtimeDir, nodeDir, cacheDirectory = defaultCacheDirectory }) {
  requireAbsoluteDirectoryPath(cacheDirectory, "cacheDirectory");
  const cacheDir = cacheDirectory;
  requireAbsoluteDirectoryPath(runtimeDir, "runtimeDir");
  requireAbsoluteDirectoryPath(nodeDir, "nodeDir");
  if (path.resolve(runtimeDir) === path.resolve(packageRoot, "../workbench")) {
    throw new Error("Refusing to replace native modules in the source Workbench.");
  }

  const serverRoot = path.join(runtimeDir, ".output", "server");
  const sqliteRoot = path.join(serverRoot, "node_modules", "better-sqlite3");
  const sqliteBinding = path.join(sqliteRoot, SQLITE_ARCHIVE_ENTRY);
  const sourceMarker = await verifyTracedRuntime(serverRoot, sqliteRoot, sqliteBinding);

  await mkdir(cacheDir, { recursive: true });
  const nodeAsset = await cachedAsset(NODE_ASSET, cacheDir);
  const sqliteAsset = await cachedAsset(SQLITE_ASSET, cacheDir);
  await mkdir(nodeDir, { recursive: true });
  await copyFile(nodeAsset, path.join(nodeDir, WINDOWS_X64_TARGET.nodeExecutable));

  const extractDir = await mkdtemp(path.join(cacheDir, "sqlite-"));
  try {
    await execFile("tar", [
      "-xzf",
      sqliteAsset,
      "-C",
      extractDir,
      SQLITE_ARCHIVE_ENTRY,
    ], { maxBuffer: 64 * 1024, windowsHide: true });
    await copyFile(path.join(extractDir, SQLITE_ARCHIVE_ENTRY), sqliteBinding);
    await writeFile(
      path.join(serverRoot, ".agent-native-node-runtime.json"),
      `${JSON.stringify({
        nodeVersion: sourceMarker.nodeVersion,
        nodeAbi: sourceMarker.nodeAbi,
        platform: WINDOWS_X64_TARGET.platform,
        arch: WINDOWS_X64_TARGET.arch,
      })}\n`,
    );
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }

  return WINDOWS_X64_TARGET;
}

async function verifyTracedRuntime(serverRoot, sqliteRoot, sqliteBinding) {
  const runtime = JSON.parse(await readFile(
    path.join(serverRoot, ".agent-native-node-runtime.json"),
    "utf8",
  ));
  if (
    runtime.nodeVersion !== WINDOWS_X64_TARGET.nodeVersion ||
    runtime.nodeAbi !== WINDOWS_X64_TARGET.nodeAbi
  ) {
    throw new Error("Windows packaging requires Workbench built with Node 24.20.0 ABI 137.");
  }

  const sqlite = JSON.parse(await readFile(path.join(sqliteRoot, "package.json"), "utf8"));
  if (sqlite.name !== "better-sqlite3" || sqlite.version !== SQLITE_VERSION) {
    throw new Error(`Windows packaging requires traced better-sqlite3 ${SQLITE_VERSION}.`);
  }
  let binding;
  try {
    binding = await stat(sqliteBinding);
  } catch {
    throw new Error("The traced better-sqlite3 runtime binding is missing.");
  }
  if (!binding.isFile()) {
    throw new Error("The traced better-sqlite3 runtime binding is missing.");
  }
  return { nodeVersion: runtime.nodeVersion, nodeAbi: runtime.nodeAbi };
}

async function cachedAsset(asset, cacheDir) {
  const destination = path.join(cacheDir, asset.fileName);
  try {
    if (await fileSha256(destination) === asset.sha256) return destination;
    await rm(destination, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const partial = `${destination}.${process.pid}.partial`;
  await rm(partial, { force: true });
  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${asset.fileName} (HTTP ${response.status}).`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    if (await fileSha256(partial) !== asset.sha256) {
      throw new Error(`Checksum verification failed for ${asset.fileName}.`);
    }
    await rename(partial, destination);
    return destination;
  } finally {
    await rm(partial, { force: true });
  }
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function requireAbsoluteDirectoryPath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
}
