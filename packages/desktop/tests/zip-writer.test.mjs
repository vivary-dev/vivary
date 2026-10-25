import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readZip, zipFolder } from "../zip-writer.mjs";

const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["-c", "import zipfile"]).status === 0;
const sha256 = data => createHash("sha256").update(data).digest("hex");

async function withTree(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-zip-writer-"));
  try {
    const folder = path.join(root, "Vivary-test");
    await mkdir(path.join(folder, "resources", "empty"), { recursive: true });
    await mkdir(path.join(folder, "resources", "node"), { recursive: true });
    const files = {
      "Vivary-test/LICENSE": Buffer.from("MIT\n"),
      "Vivary-test/resources/node/node.exe": randomBytes(3 * 1024 * 1024),
      "Vivary-test/resources/empty.txt": Buffer.alloc(0),
      "Vivary-test/resources/café ü.txt": Buffer.from("unicode name\n".repeat(1000)),
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, ...name.split("/")), content);
    const fixed = new Date("2026-10-24T12:00:00Z");
    for (const name of [...Object.keys(files), "Vivary-test/resources/empty", "Vivary-test/resources/node", "Vivary-test/resources", "Vivary-test"]) {
      await utimes(path.join(root, ...name.split("/")), fixed, fixed);
    }
    await body({ root, files });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a zipped folder reads back with every file, folder and byte", () => withTree(async ({ root, files }) => {
  const output = path.join(root, "out.zip");
  const count = await zipFolder(root, "Vivary-test", output);
  const read = await readZip(output);
  assert.equal(read.length, count);
  assert.deepEqual(read.map(({ name }) => name), [
    "Vivary-test/", "Vivary-test/LICENSE", "Vivary-test/resources/", "Vivary-test/resources/café ü.txt",
    "Vivary-test/resources/empty/", "Vivary-test/resources/empty.txt", "Vivary-test/resources/node/",
    "Vivary-test/resources/node/node.exe",
  ]);
  for (const { name, content } of read) {
    if (name.endsWith("/")) assert.equal(content.length, 0);
    else assert.equal(sha256(content), sha256(files[name]), name);
  }
}));

test("an independent ZIP reader accepts the archive and finds the same contents", { skip: !hasPython && "Python is not installed" },
  () => withTree(async ({ root, files }) => {
    const output = path.join(root, "out.zip");
    await zipFolder(root, "Vivary-test", output);
    const script = [
      "import hashlib, json, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}))",
    ].join("\n");
    const result = spawnSync(python, ["-I", "-c", script, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])));
  }));

test("the same tree gives the same archive bytes", () => withTree(async ({ root }) => {
  await zipFolder(root, "Vivary-test", path.join(root, "a.zip"));
  await zipFolder(root, "Vivary-test", path.join(root, "b.zip"));
  assert.equal(sha256(await readFile(path.join(root, "a.zip"))), sha256(await readFile(path.join(root, "b.zip"))));
}));

test("an existing output file is never overwritten", () => withTree(async ({ root }) => {
  const output = path.join(root, "out.zip");
  await writeFile(output, "earlier\n");
  await assert.rejects(zipFolder(root, "Vivary-test", output), /Refusing to overwrite/);
  assert.equal(await readFile(output, "utf8"), "earlier\n");
}));

test("a symbolic link is refused and leaves no partial archive", { skip: process.platform === "win32" && "symbolic links need privileges on Windows" },
  () => withTree(async ({ root }) => {
    await symlink(path.join(root, "Vivary-test", "LICENSE"), path.join(root, "Vivary-test", "resources", "link"));
    const output = path.join(root, "out.zip");
    await assert.rejects(zipFolder(root, "Vivary-test", output), /symbolic link Vivary-test\/resources\/link/);
    assert.equal(await lstat(output).catch(() => null), null);
  }));

test("a folder name that leaves the parent is refused", () => withTree(async ({ root }) => {
  for (const name of ["../escape", "a/../b", "", "a\\b"]) {
    await assert.rejects(zipFolder(root, name, path.join(root, "x.zip")), /Refusing to zip the folder name/, name);
  }
}));

test("more than 65,534 entries use the ZIP64 end records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-zip64-"));
  try {
    const folder = path.join(root, "many");
    const groups = 66;
    for (let group = 0; group < groups; group++) {
      const dir = path.join(folder, `g${String(group).padStart(2, "0")}`);
      await mkdir(dir, { recursive: true });
      await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(dir, `f${String(index).padStart(4, "0")}`), "")));
    }
    const output = path.join(root, "many.zip");
    const count = await zipFolder(root, "many", output);
    assert.equal(count, 1 + groups + groups * 1000);
    const read = await readZip(output);
    assert.equal(read.length, count);
    const data = await readFile(output);
    assert.ok(data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), "a ZIP64 end record is written");
    if (hasPython) {
      const result = spawnSync(python, ["-I", "-c", "import sys, zipfile; print(len(zipfile.ZipFile(sys.argv[1]).infolist()))", output], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(Number(result.stdout.trim()), count);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
