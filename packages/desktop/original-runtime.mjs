import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultCacheDirectory = path.join(packageRoot, ".tmp", "original-runtime");
const buildHelper = path.join(packageRoot, "build-original-wheels.py");
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const PYTHON_RELEASE = "20260901";
const PYTHON_VERSION = "3.12.14";

const linuxAsset = Object.freeze({
  provider: "astral-sh/python-build-standalone",
  release: PYTHON_RELEASE,
  fileName: "cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  sha256: "72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c",
});
export const ORIGINAL_RUNTIME_LICENSE_ASSET = Object.freeze({
  provider: "astral-sh/python-build-standalone",
  release: PYTHON_RELEASE,
  fileName: "python-build-standalone-20260901-licenses.rst",
  url: "https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260901/python-licenses.rst",
  sha256: "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab",
  size: 105_875,
});
export const ORIGINAL_RUNTIME_BUILD_BACKEND_ASSETS = Object.freeze([
  Object.freeze({
    provider: "PyPI",
    distribution: "pip",
    version: "26.2.2",
    fileName: "pip-26.2.2-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl",
    sha256: "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70",
    size: 1_819_850,
  }),
  Object.freeze({
    provider: "PyPI",
    distribution: "setuptools",
    version: "84.0.0",
    fileName: "setuptools-84.0.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl",
    sha256: "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670",
    size: 818_216,
  }),
]);
const windowsAsset = Object.freeze({
  provider: "astral-sh/python-build-standalone",
  release: PYTHON_RELEASE,
  fileName: "cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
  sha256: "7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14",
});

export const ORIGINAL_RUNTIME_TARGETS = Object.freeze({
  "linux:x64": Object.freeze({
    platform: "linux",
    arch: "x64",
    pythonVersion: PYTHON_VERSION,
    pythonExecutable: "python/bin/python3",
    sitePackages: "python/lib/python3.12/site-packages",
    cliLauncher: "bin/vivary",
    asset: linuxAsset,
  }),
  "win32:x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    pythonVersion: PYTHON_VERSION,
    pythonExecutable: "python/python.exe",
    sitePackages: "python/Lib/site-packages",
    cliLauncher: "bin/vivary.cmd",
    asset: windowsAsset,
  }),
});

export const ORIGINAL_RUNTIME_COMPONENTS = Object.freeze([
  Object.freeze({ distribution: "vivary", version: "0.2.1", wheel: "vivary-0.2.1-py3-none-any.whl", distInfo: "vivary-0.2.1.dist-info" }),
  Object.freeze({ distribution: "create-vivary", version: "0.4.4", wheel: "create_vivary-0.4.4-py3-none-any.whl", distInfo: "create_vivary-0.4.4.dist-info" }),
  Object.freeze({ distribution: "vivary-core", version: "0.2.7", wheel: "vivary_core-0.2.7-py3-none-any.whl", distInfo: "vivary_core-0.2.7.dist-info" }),
  Object.freeze({ distribution: "vivary-tropo", version: "0.5.5", wheel: "vivary_tropo-0.5.5-py3-none-any.whl", distInfo: "vivary_tropo-0.5.5.dist-info" }),
  Object.freeze({ distribution: "vivary-strato", version: "0.1.3", wheel: "vivary_strato-0.1.3-py3-none-any.whl", distInfo: "vivary_strato-0.1.3.dist-info" }),
  Object.freeze({ distribution: "vivary-ozone", version: "0.3.2", wheel: "vivary_ozone-0.3.2-py3-none-any.whl", distInfo: "vivary_ozone-0.3.2.dist-info" }),
  Object.freeze({ distribution: "vivary-exo", version: "0.3.1", wheel: "vivary_exo-0.3.1-py3-none-any.whl", distInfo: "vivary_exo-0.3.1.dist-info" }),
]);

export function originalRuntimeTarget(platform, arch) {
  const target = ORIGINAL_RUNTIME_TARGETS[platform + ":" + arch];
  if (!target) throw new Error("The original Vivary runtime does not support " + platform + "/" + arch + ".");
  return target;
}

export async function prepareOriginalRuntime({
  destination,
  platform,
  arch,
  repository,
  sourceCommit,
  sourceDirty,
  cacheDirectory = defaultCacheDirectory,
}) {
  requireAbsolutePath(destination, "destination");
  requireAbsolutePath(repository, "repository");
  requireAbsolutePath(cacheDirectory, "cacheDirectory");
  if (typeof sourceCommit !== "string" || !sourceCommit.trim()) {
    throw new Error("sourceCommit must be a non-empty string.");
  }
  if (typeof sourceDirty !== "boolean") throw new Error("sourceDirty must be a boolean.");

  const target = originalRuntimeTarget(platform, arch);
  await prepareEmptyDirectory(destination);
  await mkdir(cacheDirectory, { recursive: true });
  const wheelhouse = await mkdtemp(path.join(cacheDirectory, "wheels-"));
  try {
    const archive = await cacheVerifiedAsset(target.asset, { cacheDirectory });
    const aggregateLicense = await cacheVerifiedAsset(ORIGINAL_RUNTIME_LICENSE_ASSET, { cacheDirectory });
    const buildBackendWheels = [];
    for (const asset of ORIGINAL_RUNTIME_BUILD_BACKEND_ASSETS) {
      buildBackendWheels.push(await cacheVerifiedAsset(asset, { cacheDirectory }));
    }
    await runBuildHelper([
      "extract-runtime",
      "--archive", archive,
      "--destination", destination,
      "--platform", platform,
    ], repository);
    await access(path.join(destination, ...target.pythonExecutable.split("/")));

    const sitePackages = path.join(destination, ...target.sitePackages.split("/"));
    await runBuildHelper([
      "build-wheels",
      "--repository", repository,
      "--wheelhouse", wheelhouse,
      ...buildBackendWheels.flatMap(wheel => ["--build-backend-wheel", wheel]),
      "--runtime-root", destination,
      "--site-packages", sitePackages,
      "--platform", platform,
    ], repository);
    const components = await componentManifestEntries(wheelhouse, destination, target);
    await verifyComponentLicenses(destination, components);
    await writeOriginalRuntimeLauncher(destination, target);
    const managedProjectBridge = await stageWorkbenchBridge(destination, repository,
      "managed_project_workspace.py", "LICENSE.vivary-managed-project-bridge");
    const previewOwnerBridge = await stageWorkbenchBridge(destination, repository,
      "windows_preview_owner.py", "LICENSE.vivary-preview-owner");
    const aggregateLicensePath = await stageAggregateRuntimeLicense(destination, aggregateLicense);

    const componentLicensePaths = new Set(components.flatMap(component => component.licensePaths));
    const runtimeLicensePaths = await collectRuntimeLicenses(destination, componentLicensePaths);
    runtimeLicensePaths.push(aggregateLicensePath);
    runtimeLicensePaths.sort();
    if (runtimeLicensePaths.length === 0) {
      throw new Error("The bundled Python distribution contains no discoverable license text.");
    }
    const manifest = createOriginalRuntimeManifest({
      target,
      sourceCommit: sourceCommit.trim(),
      sourceDirty,
      components,
      managedProjectBridge,
      previewOwnerBridge,
      runtimeLicensePaths,
    });
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    await rm(wheelhouse, { recursive: true, force: true });
  }
}

export async function cacheVerifiedAsset(asset, {
  cacheDirectory: requestedCacheDirectory,
  fetchImpl = globalThis.fetch,
}) {
  requireAbsolutePath(requestedCacheDirectory, "cacheDirectory");
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || path.basename(asset.fileName) !== asset.fileName) {
    throw new Error("Runtime asset metadata is invalid.");
  }
  await mkdir(requestedCacheDirectory, { recursive: true });
  const destination = path.join(requestedCacheDirectory, asset.fileName);
  try {
    const cached = await lstat(destination);
    if (cached.isFile() && await fileSha256(destination) === asset.sha256) return destination;
    await rm(destination, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const partial = destination + "." + process.pid + "." + randomUUID() + ".partial";
  try {
    const response = await fetchImpl(asset.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error("Could not download " + asset.fileName + " (HTTP " + response.status + ").");
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
    if (await fileSha256(partial) !== asset.sha256) {
      throw new Error("Checksum verification failed for " + asset.fileName + ".");
    }
    await rename(partial, destination);
    return destination;
  } finally {
    await rm(partial, { force: true });
  }
}

export async function writeOriginalRuntimeLauncher(destination, target) {
  const interpreter = path.join(destination, ...target.pythonExecutable.split("/"));
  await access(interpreter);
  const launcher = path.join(destination, ...target.cliLauncher.split("/"));
  await mkdir(path.dirname(launcher), { recursive: true });
  if (target.platform === "win32") {
    await writeFile(launcher, "@echo off\r\nsetlocal\r\n\"%~dp0..\\python\\python.exe\" -I -X utf8 -B -m vivary_cli %*\r\n");
  } else {
    await writeFile(
      launcher,
      "#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$SCRIPT_DIR/../python/bin/python3\" -I -X utf8 -B -m vivary_cli \"$@\"\n",
    );
    await chmod(launcher, 0o755);
  }
  return launcher;
}

export function createOriginalRuntimeManifest({
  target,
  sourceCommit,
  sourceDirty,
  components,
  managedProjectBridge,
  previewOwnerBridge,
  runtimeLicensePaths,
}) {
  return {
    schemaVersion: 1,
    platform: target.platform,
    arch: target.arch,
    pythonVersion: target.pythonVersion,
    pythonExecutable: target.pythonExecutable,
    cliLauncher: target.cliLauncher,
    source: { commit: sourceCommit, dirty: sourceDirty },
    runtimeAsset: { ...target.asset },
    runtimeLicenseAsset: { ...ORIGINAL_RUNTIME_LICENSE_ASSET },
    components: components.map(component => ({ ...component })),
    managedProjectBridge: { ...managedProjectBridge },
    previewOwnerBridge: { ...previewOwnerBridge },
    runtimeLicensePaths: [...runtimeLicensePaths],
  };
}

async function componentManifestEntries(wheelhouse, destination, target) {
  const sitePackages = path.join(destination, ...target.sitePackages.split("/"));
  const actualWheels = (await readdir(wheelhouse)).filter(file => file.endsWith(".whl")).sort();
  const expectedWheels = ORIGINAL_RUNTIME_COMPONENTS.map(component => component.wheel).sort();
  if (JSON.stringify(actualWheels) !== JSON.stringify(expectedWheels)) {
    throw new Error("Unexpected original runtime wheel set: " + actualWheels.join(", ") + ".");
  }

  const entries = [];
  for (const component of ORIGINAL_RUNTIME_COMPONENTS) {
    const license = path.join(sitePackages, component.distInfo, "licenses", "LICENSE");
    entries.push({
      distribution: component.distribution,
      version: component.version,
      wheel: component.wheel,
      sha256: await fileSha256(path.join(wheelhouse, component.wheel)),
      licensePaths: [relativePosix(destination, license)],
    });
  }
  return entries;
}

async function verifyComponentLicenses(destination, components) {
  for (const component of components) {
    for (const license of component.licensePaths) {
      await access(path.join(destination, ...license.split("/")));
    }
  }
}

export async function stageWorkbenchBridge(destination, repository, fileName, licenseName) {
  requireAbsolutePath(destination, "destination");
  requireAbsolutePath(repository, "repository");
  const sourceBridge = path.join(repository, "packages", "workbench", "server", fileName);
  const sourceLicense = path.join(repository, "LICENSE");
  for (const source of [sourceBridge, sourceLicense]) {
    const metadata = await lstat(source);
    if (!metadata.isFile()) throw new Error("Workbench bridge source must be a regular file.");
  }

  const bridgePath = path.join(destination, "bridge", fileName);
  const licensePath = path.join(destination, "licenses", licenseName);
  await Promise.all([mkdir(path.dirname(bridgePath), { recursive: true }), mkdir(path.dirname(licensePath), { recursive: true })]);
  await Promise.all([copyFile(sourceBridge, bridgePath), copyFile(sourceLicense, licensePath)]);
  return {
    path: relativePosix(destination, bridgePath),
    sha256: await fileSha256(bridgePath),
    licensePath: relativePosix(destination, licensePath),
  };
}

async function stageAggregateRuntimeLicense(destination, source) {
  const licenseDirectory = path.join(destination, "licenses");
  await mkdir(licenseDirectory, { recursive: true });
  const destinationPath = path.join(licenseDirectory, "python-build-standalone.rst");
  await copyFile(source, destinationPath);
  return relativePosix(destination, destinationPath);
}

async function collectRuntimeLicenses(destination, componentLicensePaths) {
  const licenses = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(current);
      else if (entry.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(entry.name)) {
        const relative = relativePosix(destination, current);
        if (!componentLicensePaths.has(relative)) licenses.push(relative);
      }
    }
  }

  await visit(destination);
  return licenses.sort();
}

async function runBuildHelper(args, repository) {
  const python = process.platform === "win32" ? "python" : "python3";
  await execFile(python, [buildHelper, ...args], {
    cwd: repository,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INDEX: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

async function prepareEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0) {
    throw new Error("Original runtime destination must be empty.");
  }
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(name + " must be an absolute path.");
  }
}
