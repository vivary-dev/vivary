import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  cacheVerifiedAsset,
  createOriginalRuntimeManifest,
  ORIGINAL_RUNTIME_BUILD_BACKEND_ASSETS,
  ORIGINAL_RUNTIME_COMPONENTS,
  ORIGINAL_RUNTIME_LICENSE_ASSET,
  originalRuntimeTarget,
  stageWorkbenchBridge,
  writeOriginalRuntimeLauncher,
} from "../original-runtime.mjs";

const execFile = promisify(execFileCallback);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(testRoot, "../build-original-wheels.py");
const python = process.platform === "win32" ? "python" : "python3";

test("runtime targets pin fixed relocated interpreter paths and archive hashes", () => {
  const linux = originalRuntimeTarget("linux", "x64");
  const windows = originalRuntimeTarget("win32", "x64");
  assert.equal(linux.pythonExecutable, "python/bin/python3");
  assert.equal(windows.pythonExecutable, "python/python.exe");
  assert.equal(linux.pythonVersion, "3.12.14");
  assert.match(linux.asset.sha256, /^[a-f0-9]{64}$/);
  assert.match(windows.asset.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ORIGINAL_RUNTIME_LICENSE_ASSET.size, 105_875);
  assert.equal(ORIGINAL_RUNTIME_LICENSE_ASSET.sha256, "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab");
  assert.deepEqual(
    ORIGINAL_RUNTIME_BUILD_BACKEND_ASSETS.map(asset => [asset.distribution, asset.version, asset.fileName, asset.sha256]),
    [
      ["pip", "26.2.2", "pip-26.2.2-py3-none-any.whl", "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"],
      ["setuptools", "84.0.0", "setuptools-84.0.0-py3-none-any.whl", "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670"],
    ],
  );
  assert.throws(() => originalRuntimeTarget("darwin", "arm64"), /does not support/);
});

test("wheel build refuses an undeclared ambient build backend", async () => {
  const wheelhouse = await mkdtemp(path.join(os.tmpdir(), "vivary-wheel-backend-required-"));
  try {
    await assert.rejects(
      execFile(python, [
        helper,
        "build-wheels",
        "--repository", path.resolve(testRoot, "../../.."),
        "--wheelhouse", wheelhouse,
      ]),
      error => String(error.stderr).includes("--build-backend-wheel"),
    );
  } finally {
    await rm(wheelhouse, { recursive: true, force: true });
  }
});

test("build-only pip assets bind the authenticated 26.2.2 wheel tuple", () => {
  const pip = ORIGINAL_RUNTIME_BUILD_BACKEND_ASSETS.find(asset => asset.distribution === "pip");
  assert.deepEqual(pip && { version: pip.version, fileName: pip.fileName, sha256: pip.sha256, size: pip.size }, {
    version: "26.2.2", fileName: "pip-26.2.2-py3-none-any.whl",
    sha256: "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70", size: 1_819_850,
  });
});

test("the real wheel backend validator accepts the intended pip 26.2.2 build-only tuple", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-backend-tuple-"));
  try {
    // These are metadata-only fixture wheels, not downloaded or installable backend artifacts.
    const script = String.raw`
import json, sys, types, zipfile
from pathlib import Path
source, root = Path(sys.argv[1]), Path(sys.argv[2])
module = types.ModuleType("fixture_original_wheels")
module.__file__ = str(source)
exec(compile(source.read_text(), str(source), "exec"), module.__dict__)
wheels = []
for name, version in [("pip", "26.2.2"), ("setuptools", "84.0.0")]:
    wheel = root / (name + "-" + version + "-py3-none-any.whl")
    info = name + "-" + version + ".dist-info/"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(info + "METADATA", "Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n")
        archive.writestr(info + "WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    wheels.append(wheel)
try:
    accepted = module._validated_build_backend_wheels(wheels)
    result = {"accepted": [wheel.name for wheel in accepted], "error": None}
except ValueError as error:
    result = {"accepted": [], "error": str(error)}
print(json.dumps(result))
`;
    const { stdout } = await execFile(python, ["-I", "-B", "-c", script, helper, directory], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.accepted, ["pip-26.2.2-py3-none-any.whl", "setuptools-84.0.0-py3-none-any.whl"], result.error ?? "accepted backend wheel names");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function distlibBoundaryFixture(mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-distlib-boundary-"));
  try {
    const script = String.raw`
import builtins, hashlib, importlib.metadata, json, sys, types
from pathlib import Path
from pip._vendor import distlib
source, root, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
assert importlib.metadata.version("pip") == "26.2.2", "fixture requires the pinned pip 26.2.2"
assert distlib.__version__ == "0.4.2", "fixture requires its pinned vendored distlib 0.4.2"
vendor = Path(distlib.__file__).resolve().parent
license_bytes = (vendor / "LICENSE.txt").read_bytes()
stub_bytes = (vendor / "t64.exe").read_bytes()
assert len(license_bytes) == 14531, "authenticated distlib license length"
assert hashlib.sha256(license_bytes).hexdigest() == "808e10c8a6ab8deb149ff9b3fb19f447a808094606d712a9ca57fead3552599d", "authenticated distlib license hash"
assert hashlib.sha256(stub_bytes).hexdigest() == "81a618f21cb87db9076134e70388b6e9cb7c2106739011b6a51772d22cae06b7", "authenticated console launcher hash"
fixture_vendor = root / "vendor"
fixture_vendor.mkdir()
(fixture_vendor / "__init__.py").write_text("")
(fixture_vendor / "LICENSE.txt").write_bytes(license_bytes + (b"altered" if mode == "altered-license" else b""))
(fixture_vendor / "t64.exe").write_bytes(stub_bytes + (b"altered" if mode == "altered-stub" else b""))
fixture_distlib = types.SimpleNamespace(__file__=str(fixture_vendor / "__init__.py"),
    __version__="unknown-vendor" if mode == "unknown-version" else distlib.__version__)
real_import = builtins.__import__
def fixture_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "pip._vendor" and "distlib" in fromlist:
        return types.SimpleNamespace(distlib=fixture_distlib)
    return real_import(name, globals, locals, fromlist, level)
module = types.ModuleType("fixture_original_wheels")
module.__file__ = str(source)
module.__dict__["__builtins__"] = {**vars(builtins), "__import__": fixture_import}
exec(compile(source.read_text(), str(source), "exec"), module.__dict__)
# Normalize only the expected vendor-version guard in this fixture-owned module.
# The real license acceptance/copy and launcher validation bodies remain unchanged.
module.WINDOWS_DISTLIB_VERSION = "0.4.2"
runtime = root / "runtime"
scripts = runtime / "python" / "Scripts"
scripts.mkdir(parents=True)
destination = runtime / "licenses" / "LICENSE.distlib"
try:
    if mode in ("altered-stub", "valid-stub"):
        module._write_windows_launcher(scripts, "fixture", "fixture_module", "main")
    else:
        module._stage_distlib_license(runtime)
    rejected, error = False, None
except ValueError as refusal:
    rejected, error = True, str(refusal)
copied = destination.read_bytes() if destination.is_file() else None
launcher = scripts / "fixture.exe"
print(json.dumps({"rejected": rejected, "error": error, "copied": copied is not None,
    "licenseSize": len(copied) if copied is not None else None,
    "licenseHash": hashlib.sha256(copied).hexdigest() if copied is not None else None,
    "exactLicense": copied == license_bytes, "launcherCreated": launcher.is_file()}))
`;
    const { stdout } = await execFile(python, ["-I", "-B", "-c", script, helper, directory, mode], { timeout: 5_000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("distlib license copy rejects altered bytes with only the fixture vendor guard normalized to 0.4.2", async () => {
  const result = await distlibBoundaryFixture("altered-license");
  assert.equal(result.copied, false, "altered authenticated license bytes must not reach the staged license");
  assert.equal(result.rejected, true, "the actual license boundary must refuse altered authenticated bytes");
});

test("distlib license copy retains exact authenticated bytes with only the fixture vendor guard normalized to 0.4.2", async () => {
  const result = await distlibBoundaryFixture("valid-license");
  assert.equal(result.rejected, false, result.error ?? "exact license accepted");
  assert.equal(result.copied, true);
  assert.equal(result.exactLicense, true);
  assert.equal(result.licenseSize, 14_531);
  assert.equal(result.licenseHash, "808e10c8a6ab8deb149ff9b3fb19f447a808094606d712a9ca57fead3552599d");
});

test("distlib license copy refuses an unknown vendor with the fixture vendor guard normalized to 0.4.2", async () => {
  const result = await distlibBoundaryFixture("unknown-version");
  assert.equal(result.rejected, true);
  assert.match(result.error ?? "", /require pip-vendored distlib 0\.4\.2/);
  assert.equal(result.copied, false);
});

test("distlib launcher refuses altered stub bytes with only the fixture vendor guard normalized to 0.4.2", async () => {
  const result = await distlibBoundaryFixture("altered-stub");
  assert.equal(result.rejected, true);
  assert.match(result.error ?? "", /pinned distlib Windows console launcher is unavailable/);
  assert.equal(result.launcherCreated, false);
});

test("distlib launcher accepts the authenticated stub with only the fixture vendor guard normalized to 0.4.2", async () => {
  const result = await distlibBoundaryFixture("valid-stub");
  assert.equal(result.rejected, false, result.error ?? "authenticated launcher accepted");
  assert.equal(result.launcherCreated, true);
});

test("runtime cache replaces corrupt content and reuses only the verified hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-runtime-cache-"));
  try {
    const content = Buffer.from("verified portable runtime fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const asset = { fileName: "runtime.tar.gz", url: "https://invalid.test/runtime", sha256 };
    await writeFile(path.join(directory, asset.fileName), "corrupt");
    let downloads = 0;
    const downloaded = await cacheVerifiedAsset(asset, {
      cacheDirectory: directory,
      fetchImpl: async () => {
        downloads++;
        return new Response(content);
      },
    });
    assert.deepEqual(await readFile(downloaded), content);
    await cacheVerifiedAsset(asset, {
      cacheDirectory: directory,
      fetchImpl: async () => assert.fail("A verified cache entry must not download again."),
    });
    assert.equal(downloads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relative launchers invoke the fixed bundled interpreter in isolated mode", async () => {
  for (const [platform, executable] of [
    ["linux", "python/bin/python3"],
    ["win32", "python/python.exe"],
  ]) {
    const destination = await mkdtemp(path.join(os.tmpdir(), "vivary-" + platform + "-launcher-"));
    try {
      const target = originalRuntimeTarget(platform, "x64");
      const interpreter = path.join(destination, ...executable.split("/"));
      await mkdir(path.dirname(interpreter), { recursive: true });
      await writeFile(interpreter, "fixture");
      const launcher = await writeOriginalRuntimeLauncher(destination, target);
      const text = await readFile(launcher, "utf8");
      assert.match(text, /-I -X utf8 -B -m vivary_cli/);
      assert.equal(text.includes(destination), false);
      if (platform === "linux") assert.equal((await stat(launcher)).mode & 0o111, 0o111);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  }
});

test("manifest records the runtime, source, exact component closure, and relative licenses", () => {
  const target = originalRuntimeTarget("linux", "x64");
  const components = ORIGINAL_RUNTIME_COMPONENTS.map(component => ({
    distribution: component.distribution,
    version: component.version,
    wheel: component.wheel,
    sha256: "a".repeat(64),
    licensePaths: ["python/lib/python3.12/site-packages/" + component.distInfo + "/licenses/LICENSE"],
  }));
  const manifest = createOriginalRuntimeManifest({
    target,
    sourceCommit: "f".repeat(40),
    sourceDirty: false,
    components,
    managedProjectBridge: {
      path: "bridge/managed_project_workspace.py",
      sha256: "b".repeat(64),
      licensePath: "licenses/LICENSE.vivary-managed-project-bridge",
    },
    previewOwnerBridge: {
      path: "bridge/windows_preview_owner.py", sha256: "c".repeat(64),
      licensePath: "licenses/LICENSE.vivary-preview-owner",
    },
    runtimeLicensePaths: ["licenses/LICENSE.distlib", "licenses/python-build-standalone.rst", "python/LICENSE.txt"],
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.components.length, 7);
  assert.deepEqual(manifest.source, { commit: "f".repeat(40), dirty: false });
  assert.equal(manifest.runtimeAsset.release, "20260901");
  assert.equal(manifest.runtimeLicenseAsset.url, "https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260901/python-licenses.rst");
  assert.equal(manifest.managedProjectBridge.path, "bridge/managed_project_workspace.py");
  assert.equal(manifest.managedProjectBridge.sha256, "b".repeat(64));
  assert.equal(manifest.previewOwnerBridge.path, "bridge/windows_preview_owner.py");
  assert.equal(manifest.previewOwnerBridge.sha256, "c".repeat(64));
  assert.deepEqual(manifest.runtimeLicensePaths,
    ["licenses/LICENSE.distlib", "licenses/python-build-standalone.rst", "python/LICENSE.txt"]);
  assert.equal(JSON.stringify(manifest).includes(os.tmpdir()), false);
});

test("managed project bridge is copied with a content hash and repository license", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-managed-bridge-"));
  try {
    const repository = path.join(fixture, "repository");
    const destination = path.join(fixture, "runtime");
    await mkdir(path.join(repository, "packages", "workbench", "server"), { recursive: true });
    await mkdir(destination, { recursive: true });
    const bridge = "def main():\n    return 'installed creator'\n";
    await writeFile(path.join(repository, "packages", "workbench", "server", "managed_project_workspace.py"), bridge);
    await writeFile(path.join(repository, "LICENSE"), "MIT fixture license\n");
    const entry = await stageWorkbenchBridge(destination, repository,
      "managed_project_workspace.py", "LICENSE.vivary-managed-project-bridge");
    assert.deepEqual(entry, {
      path: "bridge/managed_project_workspace.py",
      sha256: createHash("sha256").update(bridge).digest("hex"),
      licensePath: "licenses/LICENSE.vivary-managed-project-bridge",
    });
    assert.equal(await readFile(path.join(destination, ...entry.path.split("/")), "utf8"), bridge);
    assert.equal(await readFile(path.join(destination, ...entry.licensePath.split("/")), "utf8"), "MIT fixture license\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("preview owner bridge is staged byte-for-byte with a recorded digest", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "vivary-preview-owner-bundle-"));
  const repository = path.resolve(testRoot, "../../..");
  try {
    const expected = await readFile(path.join(repository, "packages/workbench/server/windows_preview_owner.py"));
    const entry = await stageWorkbenchBridge(destination, repository,
      "windows_preview_owner.py", "LICENSE.vivary-preview-owner");
    const staged = await readFile(path.join(destination, ...entry.path.split("/")));
    assert.deepEqual(staged, expected);
    assert.equal(entry.sha256, createHash("sha256").update(staged).digest("hex"));
    assert.deepEqual(await readFile(path.join(destination, ...entry.licensePath.split("/"))),
      await readFile(path.join(repository, "LICENSE")));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("runtime extraction rejects traversal before writing outside the destination", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-runtime-archive-"));
  try {
    const archive = path.join(fixture, "runtime.tar.gz");
    const destination = path.join(fixture, "runtime");
    const makeArchive = [
      "import io, tarfile, sys",
      "archive = tarfile.open(sys.argv[1], 'w:gz')",
      "data = b'escape'",
      "item = tarfile.TarInfo('../escape.txt')",
      "item.size = len(data)",
      "archive.addfile(item, io.BytesIO(data))",
      "archive.close()",
    ].join("\n");
    await execFile(python, ["-c", makeArchive, archive]);
    await assert.rejects(
      execFile(python, [
        helper,
        "extract-runtime",
        "--archive", archive,
        "--destination", destination,
        "--platform", "linux",
      ]),
      error => String(error.stderr).includes("unsafe archive member"),
    );
    await assert.rejects(
      stat(path.join(fixture, "escape.txt")),
      error => error.code === "ENOENT",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("runtime extraction preserves the required layout and removes unnecessary Python caches and pip", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-runtime-safe-archive-"));
  try {
    const archive = path.join(fixture, "runtime.tar.gz");
    const destination = path.join(fixture, "runtime");
    const makeArchive = [
      "import io, tarfile, sys",
      "archive = tarfile.open(sys.argv[1], 'w:gz')",
      "items = [",
      "    ('python/bin/python3', b'python', 0o755),",
      "    ('python/LICENSE.txt', b'license', 0o644),",
      "    ('python/lib/python3.12/__pycache__/os.cpython-312.pyc', b'cache', 0o644),",
      "    ('python/lib/python3.12/os.py', b'source', 0o644),",
      "    ('python/lib/python3.12/site-packages/pip/__init__.py', b'pip', 0o644),",
      "    ('python/lib/python3.12/site-packages/pip-26.2.1.dist-info/METADATA', b'pip metadata', 0o644),",
      "    ('python/lib/python3.12/site-packages/retained/__init__.py', b'retained', 0o644),",
      "]",
      "for name, data, mode in items:",
      "    item = tarfile.TarInfo(name)",
      "    item.size = len(data)",
      "    item.mode = mode",
      "    archive.addfile(item, io.BytesIO(data))",
      "archive.close()",
    ].join("\n");
    await execFile(python, ["-c", makeArchive, archive]);
    await execFile(python, [
      helper,
      "extract-runtime",
      "--archive", archive,
      "--destination", destination,
      "--platform", "linux",
    ]);
    const executable = path.join(destination, "python", "bin", "python3");
    assert.equal(await readFile(executable, "utf8"), "python");
    assert.equal((await stat(executable)).mode & 0o111, 0o111);
    assert.equal(await readFile(path.join(destination, "python", "LICENSE.txt"), "utf8"), "license");
    assert.equal(await readFile(path.join(destination, "python", "lib", "python3.12", "os.py"), "utf8"), "source");
    assert.equal(await readFile(path.join(destination, "python", "lib", "python3.12", "site-packages", "retained", "__init__.py"), "utf8"), "retained");
    for (const relative of [
      ["python", "lib", "python3.12", "__pycache__", "os.cpython-312.pyc"],
      ["python", "lib", "python3.12", "site-packages", "pip", "__init__.py"],
      ["python", "lib", "python3.12", "site-packages", "pip-26.2.1.dist-info", "METADATA"],
    ]) {
      await assert.rejects(stat(path.join(destination, ...relative)), { code: "ENOENT" });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

const consoleEntries = [
  ["vivary-0.2.1.dist-info", "vivary"],
  ["create_vivary-0.4.4.dist-info", "create-vivary"],
  ["vivary_tropo-0.5.5.dist-info", "tropo"],
  ["vivary_strato-0.1.3.dist-info", "strato"],
  ["vivary_ozone-0.3.2.dist-info", "ozone"],
  ["vivary_exo-0.3.1.dist-info", "exo"],
];

async function launcherFixture(platform) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-launcher-records-"));
  const sitePackages = platform === "win32"
    ? path.join(fixture, "python", "Lib", "site-packages")
    : path.join(fixture, "python", "lib", "python3.12", "site-packages");
  await mkdir(sitePackages, { recursive: true });
  for (const [distInfo, script] of consoleEntries) {
    const directory = path.join(sitePackages, distInfo);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "RECORD"), [
      distInfo + "/METADATA,sha256=fixture,1",
      "../../bin/" + script + ",sha256=stale,1",
      distInfo + "/direct_url.json,sha256=stale,1",
      distInfo + "/RECORD,,",
      "",
    ].join("\n"));
  }
  const coreInfo = "vivary_core-0.2.7.dist-info";
  await mkdir(path.join(sitePackages, coreInfo), { recursive: true });
  await writeFile(path.join(sitePackages, coreInfo, "direct_url.json"), "{}\n");
  await writeFile(path.join(sitePackages, coreInfo, "RECORD"), [
    coreInfo + "/METADATA,sha256=fixture,1",
    coreInfo + "/direct_url.json,sha256=stale,1",
    coreInfo + "/RECORD,,",
    "",
  ].join("\n"));
  if (platform === "win32") {
    await writeFile(path.join(fixture, "python", "python.exe"), "fixture");
  } else {
    const interpreter = path.join(fixture, "python", "bin", "python3");
    await mkdir(path.dirname(interpreter), { recursive: true });
    await writeFile(interpreter, "fixture");
  }
  return { fixture, sitePackages };
}

test("component launchers stay relative and replace stale pip RECORD rows", async () => {
  for (const platform of ["linux", "win32"]) {
    const { fixture, sitePackages } = await launcherFixture(platform);
    try {
      await execFile(python, [
        helper,
        "write-launchers",
        "--runtime-root", fixture,
        "--site-packages", sitePackages,
        "--platform", platform,
      ]);
      const distlibLicense = path.join(fixture, "licenses", "LICENSE.distlib");
      if (platform === "win32") {
        assert.match(await readFile(distlibLicense, "utf8"), /^A\. HISTORY OF THE SOFTWARE/);
      } else {
        await assert.rejects(stat(distlibLicense), { code: "ENOENT" });
      }
      const coreRecord = await readFile(path.join(sitePackages, "vivary_core-0.2.7.dist-info", "RECORD"), "utf8");
      assert.equal(coreRecord.includes("direct_url.json"), false);
      await assert.rejects(
        stat(path.join(sitePackages, "vivary_core-0.2.7.dist-info", "direct_url.json")),
        error => error.code === "ENOENT",
      );
      for (const [distInfo, script] of consoleEntries) {
        const relativeLauncher = platform === "win32"
          ? path.join("python", "Scripts", script + ".exe")
          : path.join("python", "bin", script);
        const launcher = path.join(fixture, relativeLauncher);
        const data = await readFile(launcher);
        if (platform === "win32") {
          assert.equal(data.subarray(0, 2).toString("ascii"), "MZ");
          assert.equal(data.includes(Buffer.from("#!<launcher_dir>\\..\\python.exe -I -X utf8 -B\n")), true);
        } else {
          assert.equal(data.includes(Buffer.from('exec "$SCRIPT_DIR/python3" -I -X utf8 -B')), true);
          assert.equal(data.includes(Buffer.from(fixture)), false);
          assert.equal((await stat(launcher)).mode & 0o111, 0o111);
        }
        const record = await readFile(path.join(sitePackages, distInfo, "RECORD"), "utf8");
        const expected = platform === "win32"
          ? "../../Scripts/" + script + ".exe,sha256="
          : "../../../bin/" + script + ",sha256=";
        assert.equal(record.includes(expected), true);
        assert.equal(record.includes("sha256=stale"), false);
        assert.equal(record.includes("direct_url.json"), false);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});
