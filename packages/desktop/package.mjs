import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, cp, glob, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertCurrentNode, assertElectronPublication, validateStagedNode } from "../workbench/bin/runtime-security.mjs";


const decodeGitPaths = value => value.toString("utf8").split("\0").filter(Boolean);

/** Snapshot recorded HEAD plus the tracked working-tree overlay without touching the index. */
export async function snapshotTrackedRepository(repository, destination) {
  if (!path.isAbsolute(repository) || !path.isAbsolute(destination)) {
    throw new Error("Packaging source snapshot paths must be absolute.");
  }
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repository, encoding: "utf8",
  }).trim();
  if (!path.isAbsolute(gitRoot)) throw new Error("Git returned an invalid packaging source root.");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: gitRoot, encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: gitRoot, encoding: "utf8",
  });
  const trackedOverlay = decodeGitPaths(execFileSync(
    "git", ["diff", "--name-only", "--no-renames", "-z", sourceCommit, "--"],
    { cwd: gitRoot },
  ));
  const sourceDirty = status.trim().length > 0 || trackedOverlay.length > 0;
  await mkdir(destination);
  const archive = destination + ".tar";
  try {
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, sourceCommit], { cwd: gitRoot });
    execFileSync("tar", ["-xf", archive, "-C", destination]);
  } finally {
    await rm(archive, { force: true });
  }

  const sourcePrefix = path.resolve(gitRoot) + path.sep;
  const destinationPrefix = path.resolve(destination) + path.sep;
  for (const relative of trackedOverlay) {
    const source = path.resolve(gitRoot, relative);
    const target = path.resolve(destination, relative);
    if (!source.startsWith(sourcePrefix) || !target.startsWith(destinationPrefix)) {
      throw new Error("Git returned a tracked path outside the packaging snapshot.");
    }
    await rm(target, { recursive: true, force: true });
    let info;
    try { info = await lstat(source); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: info.isDirectory(), verbatimSymlinks: true });
  }
  return Object.freeze({
    sourceCommit, sourceDirty, trackedOverlayCount: trackedOverlay.length,
    kind: trackedOverlay.length > 0 ? "git-archive-with-tracked-overlays" : "git-archive",
  });
}

export async function packageDesktop() {
  await assertCurrentNode();
  assertElectronPublication();
  const { values } = parseArgs({ options: { "windows-x64": { type: "boolean" } } });

  const root = path.dirname(fileURLToPath(import.meta.url));
  const workbench = path.resolve(root, "../workbench");
  const repository = path.resolve(root, "../..");
  const stagingParent = path.join(root, ".tmp");
  await access(path.join(workbench, ".output/server/index.mjs"));
  await mkdir(stagingParent, { recursive: true });
  const stage = await mkdtemp(path.join(stagingParent, "package-"));
  const output = path.join(root, "dist", new Date().toISOString().replace(/[:.]/g, "-"));

  try {
    const sourceRepository = path.join(stage, "source");
    const source = await snapshotTrackedRepository(repository, sourceRepository);
    const sourceDesktop = path.join(sourceRepository, "packages", "desktop");
    const sourceWorkbench = path.join(sourceRepository, "packages", "workbench");
    const [{ packager }, { prepareWindowsX64Target }, { prepareOriginalRuntime }] = await Promise.all([
      import("@electron/packager"),
      import(pathToFileURL(path.join(sourceDesktop, "windows-target.mjs")).href),
      import(pathToFileURL(path.join(sourceDesktop, "original-runtime.mjs")).href),
    ]);
    const manifest = JSON.parse(await readFile(path.join(sourceDesktop, "package.json"), "utf8"));
    const appDir = path.join(stage, "app");
    const runtimeDir = path.join(stage, "workbench");
    const nodeDir = path.join(stage, "node");
    await Promise.all([mkdir(appDir), mkdir(path.join(runtimeDir, "bin"), { recursive: true }), mkdir(nodeDir)]);
    await copyFile(path.join(sourceDesktop, "main.mjs"), path.join(appDir, "main.mjs"));
    await writeFile(path.join(appDir, "package.json"), JSON.stringify({
      name: "vivary", productName: "Vivary", version: manifest.version,
      private: true, type: "module", main: "main.mjs",
    }, null, 2));
    await cp(path.join(workbench, ".output"), path.join(runtimeDir, ".output"), { recursive: true, dereference: true });
    for (const file of ["start.mjs", "desktop-server.mjs", "runtime-security.mjs"]) {
      await copyFile(path.join(sourceWorkbench, "bin", file), path.join(runtimeDir, "bin", file));
    }
    await writeFile(path.join(runtimeDir, "package.json"), JSON.stringify({
      name: "@vivary/workbench", version: manifest.version, private: true, type: "module",
    }, null, 2));
    await copyFile(path.join(sourceRepository, "LICENSE"), path.join(appDir, "LICENSE"));
    const target = values["windows-x64"]
      ? await prepareWindowsX64Target({ runtimeDir, nodeDir,
        cacheDirectory: path.join(root, ".tmp", "windows-assets") })
      : {
        platform: process.platform, arch: process.arch, nodeVersion: process.version,
        nodeAbi: process.versions.modules,
        nodeExecutable: process.platform === "win32" ? "node.exe" : "node",
      };
    if (!values["windows-x64"]) {
      await copyFile(process.execPath, path.join(nodeDir, target.nodeExecutable));
      if (target.platform !== "win32") await chmod(path.join(nodeDir, target.nodeExecutable), 0o755);
    }

    const standalone = await validateStagedNode(path.join(nodeDir, target.nodeExecutable), target);

    const nodeLicense = await fetch(
      `https://raw.githubusercontent.com/nodejs/node/${target.nodeVersion}/LICENSE`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!nodeLicense.ok) throw new Error("Could not retrieve the bundled Node version's license.");
    await writeFile(path.join(nodeDir, "LICENSE"), await nodeLicense.text());

    const notices = ["Third-party notices from the locked Workbench dependency tree.\n"];
    const packageStore = path.join(workbench, "node_modules/.pnpm");
    const patterns = ["LICENSE*", "LICENCE*", "COPYING*", "NOTICE*"].flatMap(name => [
      path.join(packageStore, "*/node_modules/*", name).replaceAll(path.sep, "/"),
      path.join(packageStore, "*/node_modules/@*/*", name).replaceAll(path.sep, "/"),
    ]);
    for await (const file of glob(patterns)) {
      if (!(await stat(file)).isFile()) continue;
      const text = await readFile(file, "utf8");
      notices.push(`\n--- ${path.relative(packageStore, file).replaceAll(path.sep, "/")} ---\n${text}\n`);
    }
    await writeFile(path.join(runtimeDir, "THIRD-PARTY-NOTICES.txt"), notices.join(""));
    const originalRuntimeDir = path.join(stage, "original-runtime");
    const originalRuntime = await prepareOriginalRuntime({
      destination: originalRuntimeDir, platform: target.platform, arch: target.arch,
      repository: sourceRepository, sourceCommit: source.sourceCommit, sourceDirty: source.sourceDirty,
      cacheDirectory: path.join(root, ".tmp", "original-runtime"),
    });
    await writeFile(path.join(runtimeDir, "build.json"), JSON.stringify({
      product: "Vivary", version: manifest.version, sourceCommit: source.sourceCommit, sourceDirty: source.sourceDirty,
      sourceSnapshot: { kind: source.kind, trackedOverlayCount: source.trackedOverlayCount,
        commitMatchesPackagedSource: !source.sourceDirty, untrackedFilesIncluded: false },
      workbenchOutput: { kind: "prebuilt", capturedOnce: true, sourceCommitVerified: false },
      platform: target.platform, architecture: target.arch, node: target.nodeVersion,
      nodeAbi: target.nodeAbi, electron: manifest.devDependencies.electron,
      runtimeSecurity: { standalone: { sha256: standalone.sha256, versions: standalone.versions,
        platform: standalone.platform, arch: standalone.arch } },
      buildHost: { platform: process.platform, architecture: process.arch },
      channel: "private-preview",
      originalRuntime: {
        manifest: "../original-runtime/manifest.json",
        python: originalRuntime.pythonVersion,
        components: originalRuntime.components.map(({ distribution, version }) => ({ distribution, version })),
      },
    }, null, 2));

    const built = await packager({
      dir: appDir, out: output, name: "Vivary", executableName: "vivary",
      appBundleId: "com.vivary.desktop", appVersion: manifest.version,
      win32metadata: { CompanyName: "Vivary", ProductName: "Vivary", FileDescription: "Vivary local desktop" },
      electronVersion: manifest.devDependencies.electron,
      platform: target.platform, arch: target.arch, asar: true,
      extraResource: [runtimeDir, nodeDir], overwrite: false,
      // Packager's default resource copy makes relative symlinks point at staging.
      // Keep Python's links relative so they survive staging cleanup and relocation.
      afterCopyExtraResources: [({ buildPath }) => cp(originalRuntimeDir,
        path.join(buildPath, "resources", "original-runtime"), { recursive: true, verbatimSymlinks: true })],
    });
    for (const directory of built) console.log(directory);
  } finally {
    if (path.dirname(stage) !== stagingParent || !path.basename(stage).startsWith("package-")) {
      throw new Error("Refusing to clean an unexpected packaging directory.");
    }
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageDesktop();
}
