// Windows CI runs this file too, so the extended-length prefix, junction
// refusals, and the deep-tree sweep are proven on a real Windows file system.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fsPromises, { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { originalChildEnvironment, runOriginalProcess } from "../server/original-runtime.ts";
import { bytecodeFlag, pycachePrefixFlag } from "../server/python-bytecode.ts";

const BUILD = "3f9a0c12";
const freshState = () => ({ prepared: new Map(), logged: new Set() });
// A link the current user can always make: a junction on Windows, a symbolic link elsewhere.
const link = (target, at) => symlink(target, at, process.platform === "win32" ? "junction" : "dir");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const python = execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
// Imports a package from the folder in argv[1] and prints where its bytecode belongs.
// Given a marker path, it then creates the marker and waits to be stopped.
const IMPORT = [
  "import sys",
  "sys.path.insert(0, sys.argv[1])",
  "import cachedpkg.module as module",
  "print(module.__cached__, flush=True)",
  "if len(sys.argv) > 2:",
  "    open(sys.argv[2], 'w').close()",
  "    import time",
  "    time.sleep(60)",
].join("\n");
const launch = (flag, args, signal) => runOriginalProcess(python, ["-I", "-X", "utf8", flag, "-c", IMPORT, ...args], "",
  os.tmpdir(), originalChildEnvironment(process.env, undefined), signal);

async function packageTree(lib) {
  await mkdir(path.join(lib, "cachedpkg"), { recursive: true });
  await writeFile(path.join(lib, "cachedpkg", "__init__.py"), "");
  await writeFile(path.join(lib, "cachedpkg", "module.py"), "VALUE = 155\n");
}

// CPython mirrors a source path as it is spelled on sys.path, which on a Windows
// runner is an 8.3 temp folder name, so the test searches rather than predicts.
async function findCached(prefix, name) {
  const entries = await readdir(prefix, { recursive: true }).catch(() => []);
  const hit = entries.find(entry => path.basename(entry).startsWith(`${name}.`) && entry.endsWith(".pyc"));
  return hit && path.join(prefix, hit);
}

// `data` and `install` keep the temp folder's spelling, an 8.3 name on a Windows
// runner. The bundle root and `realData` are canonical, as production passes them.
async function folders(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-bytecode-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const data = path.join(directory, "app data é");
  const install = path.join(directory, "install");
  await Promise.all([mkdir(data), mkdir(install)]);
  const realData = await realpath(data);
  const prefix = async () => path.join(realData, "python-cache", BUILD);
  return { directory, data, realData, install, bundle: { root: await realpath(install), build: BUILD }, prefix };
}

// Swaps one fs/promises function, here and in the module under test, while `run` runs.
async function patched(name, replace, run) {
  const original = fsPromises[name];
  fsPromises[name] = replace(original);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fsPromises[name] = original;
    syncBuiltinESMExports();
  }
}

async function stderrOf(run) {
  const lines = [];
  const original = console.error;
  console.error = line => { lines.push(String(line)); };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

test("a launch keeps -B without a bundle, a valid build, or a usable absolute data folder", async t => {
  const f = await folders(t);
  const state = freshState();
  for (const [bundle, dataDir] of [
    [null, f.data],
    [{ root: f.install, build: "3f9a0c1" }, f.data],
    [{ root: f.install, build: "3f9a0c12a" }, f.data],
    [{ root: f.install, build: "3F9A0C12" }, f.data],
    [{ root: f.install, build: "../a0c12" }, f.data],
    [f.bundle, undefined],
    [f.bundle, "data"],
    [f.bundle, path.join(f.directory, "missing")],
  ]) {
    assert.equal(await bytecodeFlag(state, bundle, dataDir), "-B", JSON.stringify({ bundle, dataDir }));
  }
  assert.deepEqual(await readdir(f.data), [], "nothing was created");
});

test("the prefix is one argument, extended-length on Windows and plain elsewhere", () => {
  assert.equal(pycachePrefixFlag("C:\\Users\\Ann\\.vivary\\workbench\\python-cache\\3f9a0c12", path.win32),
    "-Xpycache_prefix=\\\\?\\C:\\Users\\Ann\\.vivary\\workbench\\python-cache\\3f9a0c12");
  assert.equal(pycachePrefixFlag("\\\\server\\share\\vivary\\python-cache\\3f9a0c12", path.win32),
    "-Xpycache_prefix=\\\\?\\UNC\\server\\share\\vivary\\python-cache\\3f9a0c12");
  assert.equal(pycachePrefixFlag("/home/ann/.vivary/workbench/python-cache/3f9a0c12", path.posix),
    "-Xpycache_prefix=/home/ann/.vivary/workbench/python-cache/3f9a0c12");
});

test("a bundle compiles into its build's private folder in the canonical data folder", async t => {
  const f = await folders(t);
  const flag = await bytecodeFlag(freshState(), f.bundle, f.data);
  const prefix = await f.prefix();
  assert.equal(flag, pycachePrefixFlag(prefix));
  // An empty value would turn the cache off without a word.
  assert.match(flag, process.platform === "win32" ? /^-Xpycache_prefix=\\\\\?\\.+/ : /^-Xpycache_prefix=\/.+/);
  for (const folder of [path.dirname(prefix), prefix]) {
    const info = await stat(folder);
    assert.ok(info.isDirectory(), folder);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700, folder);
  }
});

test("a cache inside the install folder or the call's project is refused once per process and writes nothing", async t => {
  const f = await folders(t);
  const inner = path.join(f.install, "data");
  await mkdir(inner);
  const state = freshState();
  const { lines } = await stderrOf(async () => {
    assert.equal(await bytecodeFlag(state, f.bundle, inner), "-B");
    for (let call = 0; call < 2; call++) assert.equal(await bytecodeFlag(state, f.bundle, f.data, f.realData), "-B");
  });
  assert.deepEqual(await readdir(inner), [], "nothing was written in the install folder");
  assert.deepEqual(await readdir(f.data), [], "nothing was written in the project");
  assert.deepEqual(lines, ["[vivary-python-cache] refused inside=bundle", "[vivary-python-cache] refused inside=project"]);
  assert.equal(await bytecodeFlag(state, f.bundle, f.data, path.join(f.realData, "projects", "Alpha")),
    pycachePrefixFlag(await f.prefix()), "a managed project inside the data folder does not hold the cache");
});

test("a project inside the cache folder is refused once per process, and the refused call does not sweep", async t => {
  const f = await folders(t);
  const project = path.join(f.realData, "python-cache", "a71d44e0", "project");
  await mkdir(project, { recursive: true });
  const state = freshState();
  const { lines } = await stderrOf(async () => {
    for (let call = 0; call < 2; call++) assert.equal(await bytecodeFlag(state, f.bundle, f.data, project), "-B");
  });
  assert.deepEqual(lines, ["[vivary-python-cache] refused holds=project"]);
  assert.deepEqual(await readdir(path.join(f.realData, "python-cache")), ["a71d44e0"], "no build folder was made");
  assert.ok((await stat(project)).isDirectory(), "the refused call did not sweep");
});

test("a cache folder whose real path is elsewhere, such as a mount point, is refused, and the sweep keeps one", async t => {
  const elsewhere = name => realpath => (target, options) => path.basename(target) === name
    ? Promise.resolve(path.join(path.dirname(target), "elsewhere")) : realpath(target, options);
  const f = await folders(t);
  const refused = await patched("realpath", elsewhere(BUILD),
    () => stderrOf(() => bytecodeFlag(freshState(), f.bundle, f.data)));
  assert.equal(refused.result, "-B");
  assert.deepEqual(refused.lines, ["[vivary-python-cache] unavailable code=ENOTDIR"]);
  const g = await folders(t);
  const old = path.join(g.data, "python-cache", "a71d44e0");
  await mkdir(old, { recursive: true });
  const swept = await patched("realpath", elsewhere("a71d44e0"),
    () => stderrOf(() => bytecodeFlag(freshState(), g.bundle, g.data)));
  assert.equal(swept.result, pycachePrefixFlag(await g.prefix()));
  assert.deepEqual(swept.lines, [], "nothing was removed");
  assert.ok((await stat(old)).isDirectory(), "the sweep keeps a folder whose real path is elsewhere");
});

test("a sweep that cannot list or remove a folder logs it and the launch still gets the cache", async t => {
  const f = await folders(t);
  const old = path.join(f.data, "python-cache", "a71d44e0");
  await mkdir(old, { recursive: true });
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  const removal = await patched("rm", rm => (target, options) =>
    path.basename(target) === "a71d44e0" ? Promise.reject(busy) : rm(target, options),
  () => stderrOf(() => bytecodeFlag(freshState(), f.bundle, f.data)));
  assert.equal(removal.result, pycachePrefixFlag(await f.prefix()));
  assert.deepEqual(removal.lines, ["[vivary-python-cache] kept build=a71d44e0 code=EBUSY"]);
  assert.ok((await stat(old)).isDirectory(), "the folder waits for a later start");
  const g = await folders(t);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const listing = await patched("readdir", readdir => (target, options) =>
    path.basename(target) === "python-cache" ? Promise.reject(denied) : readdir(target, options),
  () => stderrOf(() => bytecodeFlag(freshState(), g.bundle, g.data)));
  assert.equal(listing.result, pycachePrefixFlag(await g.prefix()));
  assert.deepEqual(listing.lines, ["[vivary-python-cache] sweep skipped code=EACCES"]);
});

test("a link or a file where a cache folder belongs gives -B, writes nothing through it, and is retried", async t => {
  for (const plant of [
    async (data, outside) => link(outside, path.join(data, "python-cache")),
    async (data, outside) => {
      await mkdir(path.join(data, "python-cache"));
      await link(outside, path.join(data, "python-cache", BUILD));
    },
    async data => writeFile(path.join(data, "python-cache"), ""),
  ]) {
    const f = await folders(t);
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await plant(f.data, outside);
    const state = freshState();
    const { lines } = await stderrOf(async () => {
      for (let call = 0; call < 2; call++) assert.equal(await bytecodeFlag(state, f.bundle, f.data), "-B");
    });
    assert.deepEqual(lines, ["[vivary-python-cache] unavailable code=ENOTDIR"], "logged once per process");
    assert.deepEqual(await readdir(outside), [], "the link's target stays empty");
    await rm(path.join(f.data, "python-cache"), { recursive: true, force: true });
    assert.equal(await bytecodeFlag(state, f.bundle, f.data), pycachePrefixFlag(await f.prefix()),
      "the next launch prepares the cache again");
  }
});

test("the first launch removes other builds' folders and nothing else", async t => {
  const f = await folders(t);
  const root = path.join(f.data, "python-cache");
  const old = path.join(root, "a71d44e0");
  const deep = path.join(old, ...Array.from({ length: 6 }, (_, index) => `folder-${index}-${"x".repeat(40)}`), "module.pyc");
  const kept = path.join(f.directory, "kept");
  await mkdir(path.dirname(deep), { recursive: true });
  await writeFile(deep, "old build");
  assert.ok(deep.length > 300, "the old build holds a path past the Windows limit");
  await mkdir(path.join(root, "ABCDEF12"));
  await writeFile(path.join(root, "notes.txt"), "notes");
  await mkdir(kept);
  await writeFile(path.join(kept, "file"), "kept");
  await link(kept, path.join(root, "b0b0b0b0"));
  const state = freshState();
  const { result, lines } = await stderrOf(() => Promise.all([1, 2, 3, 4].map(() => bytecodeFlag(state, f.bundle, f.data))));
  assert.deepEqual(result, Array(4).fill(pycachePrefixFlag(await f.prefix())), "four concurrent first launches get the cache");
  assert.deepEqual(lines, ["[vivary-python-cache] removed build=a71d44e0"], "one sweep, one line per removed folder");
  assert.deepEqual((await readdir(root)).sort(), [BUILD, "ABCDEF12", "b0b0b0b0", "notes.txt"].sort());
  assert.equal(await readFile(path.join(kept, "file"), "utf8"), "kept", "the sweep never follows a link");
  await mkdir(old);
  assert.equal(await bytecodeFlag(state, f.bundle, f.data), pycachePrefixFlag(await f.prefix()));
  assert.ok((await stat(old)).isDirectory(), "a later launch in the same process does not sweep again");
});

test("a real child compiles into the cache, the next launch reads it, and nothing lands beside the sources", async t => {
  const f = await folders(t);
  const lib = path.join(f.install, "lib");
  const marker = path.join(f.directory, "imported");
  await packageTree(lib);
  const flag = await bytecodeFlag(freshState(), f.bundle, f.data);
  assert.equal(flag, pycachePrefixFlag(await f.prefix()));
  const readOnly = mode => process.platform === "win32" ? undefined
    : Promise.all([lib, path.join(lib, "cachedpkg")].map(folder => chmod(folder, mode)));
  await readOnly(0o555);
  try {
    const controller = new AbortController();
    const first = launch(flag, [lib, marker], controller.signal);
    first.catch(() => undefined);
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await delay(100);
    assert.ok(existsSync(marker), "the first child imported the package");
    controller.abort();
    await assert.rejects(first, /cancelled/);
    const cached = await findCached(await f.prefix(), "module");
    assert.ok(cached, "the stopped child left its bytecode under the prefix");
    const before = await stat(cached, { bigint: true });
    const second = await launch(flag, [lib]);
    assert.equal(second.exitCode, 0, second.stderr);
    const after = await stat(second.stdout.trim(), { bigint: true });
    assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs],
      "the second child read the first child's file instead of compiling again");
  } finally {
    await readOnly(0o755);
  }
  const stray = (await readdir(f.install, { recursive: true }))
    .filter(entry => entry.endsWith(".pyc") || path.basename(entry) === "__pycache__");
  assert.deepEqual(stray, [], "nothing was written beside the sources");
});

test("on Windows a cached path past 300 characters is written through the extended-length prefix",
  { skip: process.platform !== "win32" && "Windows paths only" }, async t => {
    const f = await folders(t);
    let lib = f.install;
    while (path.join(lib, "cachedpkg", "module.py").length < 200) lib = path.join(lib, "s".repeat(39));
    await packageTree(lib);
    const flag = await bytecodeFlag(freshState(), f.bundle, f.data);
    const run = await launch(flag, [lib]);
    assert.equal(run.exitCode, 0, run.stderr);
    const cached = await findCached(await f.prefix(), "module");
    assert.ok(cached, "the bytecode file exists");
    assert.ok(cached.length > 300, `the cached path has ${cached.length} characters`);
    const longPaths = execFileSync(python, ["-c", "import ctypes; enabled = ctypes.windll.ntdll.RtlAreLongPathsEnabled; "
      + "enabled.restype = ctypes.c_ubyte; print(enabled())"], { encoding: "utf8" }).trim() === "1";
    await t.test("a plain prefix loses the same file while long paths are off",
      { skip: longPaths && "long paths are enabled on this computer, so a plain prefix would also work" }, async () => {
        const plain = path.join(await realpath(f.data), "python-cache", "plain");
        await mkdir(plain);
        const control = await launch(`-Xpycache_prefix=${plain}`, [lib]);
        assert.equal(control.exitCode, 0, control.stderr);
        assert.equal(await findCached(plain, "module"), undefined, "the plain prefix wrote no bytecode");
      });
  });
