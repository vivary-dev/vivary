import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createProjectFileService,
  fileDigest,
  isLockError,
  inspectEditableFile,
  isPermissionError,
  listFolder,
  ProjectFileLockedError,
  ProjectFilePermissionError,
  readEditableFile,
  readListedFiles,
  withLockRetries,
} from "../server/project-files.ts";
import {
  projectFileRenameInputSchema,
  projectFileSaveInputSchema,
  projectFilesInputSchema,
} from "../app/lib/project-file-schema.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-"));
  roots.push(root);
  let revision = 1;
  let available = true;
  const workspace = () => ({ root, label: "Example", projectId: "project_a", bindingId: "binding_a",
    rootId: "root_a", bindingRevision: revision, policyRevision: 1 });
  const service = createProjectFileService(async (_context, projectId) => {
    if (!available || projectId !== "project_a") throw new Error("Project unavailable");
    return workspace();
  });
  return { root, service, revoke: () => { available = false; }, rebind: () => { revision += 1; } };
}

describe("project file boundary", () => {
  it("lists and reads bounded text including workspace TOML while hiding secret and dependency trees", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "README.md"), "# Hello\n");
    await writeFile(path.join(f.root, "workspace.toml"), "name = \"Example\"\n");
    await writeFile(path.join(f.root, ".env"), "SECRET=value\n");
    await mkdir(path.join(f.root, "node_modules"));
    await writeFile(path.join(f.root, "node_modules", "package.js"), "ignored\n");
    await writeFile(path.join(f.root, "image.png"), Buffer.from([0, 1, 2]));

    const listing = await f.service.get(undefined, "project_a");
    assert.equal(listing.code, "listing");
    if (listing.code !== "listing") return;
    assert.deepEqual(listing.files.map(file => file.path), ["image.png", "README.md", "workspace.toml"]);
    assert.deepEqual(listing.files.find(file => file.path === "workspace.toml"), {
      path: "workspace.toml", name: "workspace.toml", sizeBytes: 17,
      updatedAt: listing.files.find(file => file.path === "workspace.toml")?.updatedAt,
      access: "editable", kind: "toml",
    });
    assert.equal(listing.files.find(file => file.path === "image.png")?.access, "blocked");
    const read = await f.service.get(undefined, "project_a", "README.md");
    assert.equal(read.code, "file");
    if (read.code === "file") assert.equal(read.file.content, "# Hello\n");
  });

  it("saves normally and returns a new exact version", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "before\n");
    await chmod(path.join(f.root, "note.md"), 0o664);
    const opened = await f.service.get(undefined, "project_a", "note.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const result = await f.service.save(undefined, { projectId: "project_a", path: "note.md",
      expectedVersion: opened.file.version, content: "after\n" });
    assert.equal(result.code, "saved");
    assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "after\n");
    assert.equal((await stat(path.join(f.root, "note.md"))).mode & 0o777, 0o664);
    if (result.code === "saved") assert.notEqual(result.file.version, opened.file.version);
  });

  it("serializes app saves so one stale writer conflicts", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "before\n");
    const opened = await f.service.get(undefined, "project_a", "note.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const results = await Promise.all([
      f.service.save(undefined, { projectId: "project_a", path: "note.md", expectedVersion: opened.file.version, content: "first\n" }),
      f.service.save(undefined, { projectId: "project_a", path: "note.md", expectedVersion: opened.file.version, content: "second\n" }),
    ]);
    assert.deepEqual(results.map(result => result.code).sort(), ["conflict", "saved"]);
    assert.ok(["first\n", "second\n"].includes(await readFile(path.join(f.root, "note.md"), "utf8")));
  });

  it("preserves externally changed bytes on save conflict", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "before\n");
    const opened = await f.service.get(undefined, "project_a", "note.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    await writeFile(path.join(f.root, "note.md"), "external\n");
    const result = await f.service.save(undefined, { projectId: "project_a", path: "note.md",
      expectedVersion: opened.file.version, content: "mine\n" });
    assert.deepEqual({ code: result.code, reason: result.code === "conflict" ? result.reason : null },
      { code: "conflict", reason: "changed" });
    assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "external\n");
  });

  it("reports deletion and rename as conflict without recreating the original", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "before\n");
    const opened = await f.service.get(undefined, "project_a", "note.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    await rename(path.join(f.root, "note.md"), path.join(f.root, "moved.md"));
    const result = await f.service.save(undefined, { projectId: "project_a", path: "note.md",
      expectedVersion: opened.file.version, content: "mine\n" });
    assert.deepEqual(result, { code: "conflict", operation: "save", reason: "renamed-or-deleted", path: "note.md" });
    await assert.rejects(lstat(path.join(f.root, "note.md")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(f.root, "moved.md"), "utf8"), "before\n");
  });

  it("blocks revoked and rebound roots before saving", async () => {
    const revoked = await fixture();
    await writeFile(path.join(revoked.root, "note.md"), "before\n");
    const first = await revoked.service.get(undefined, "project_a", "note.md");
    assert.equal(first.code, "file");
    if (first.code !== "file") return;
    revoked.revoke();
    await assert.rejects(revoked.service.save(undefined, { projectId: "project_a", path: "note.md",
      expectedVersion: first.file.version, content: "mine\n" }), /unavailable/);
    assert.equal(await readFile(path.join(revoked.root, "note.md"), "utf8"), "before\n");

    const rebound = await fixture();
    await writeFile(path.join(rebound.root, "note.md"), "before\n");
    const second = await rebound.service.get(undefined, "project_a", "note.md");
    assert.equal(second.code, "file");
    if (second.code !== "file") return;
    rebound.rebind();
    const conflict = await rebound.service.save(undefined, { projectId: "project_a", path: "note.md",
      expectedVersion: second.file.version, content: "mine\n" });
    assert.equal(conflict.code, "conflict");
    if (conflict.code === "conflict") assert.equal(conflict.reason, "changed");
  });

  it("blocks symlink directories and multiply linked files", async () => {
    const f = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "outside.md"), "outside\n");
    await symlink(outside, path.join(f.root, "linked-dir"), "dir");
    await assert.rejects(f.service.get(undefined, "project_a", "linked-dir/outside.md"), /not available/);
    await writeFile(path.join(f.root, "note.md"), "one inode\n");
    await link(path.join(f.root, "note.md"), path.join(f.root, "alias.md"));
    const listing = await f.service.get(undefined, "project_a");
    assert.equal(listing.code, "listing");
    if (listing.code === "listing") {
      assert.equal(listing.files.find(file => file.path === "note.md")?.access, "blocked");
      assert.equal(listing.files.find(file => file.path === "alias.md")?.access, "blocked");
    }
  });

  it("renames within one directory and refuses destination collisions", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "hello\n");
    const opened = await f.service.get(undefined, "project_a", "note.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const outside = path.join(path.dirname(f.root), path.basename(f.root) + "-escape.txt");
    await assert.rejects(
      f.service.rename(undefined, { projectId: "project_a", path: "note.md",
        name: `../${path.basename(outside)}`, expectedVersion: opened.file.version }),
      error => error instanceof Error && error.message === "Choose a file inside the selected project."
        && "statusCode" in error && error.statusCode === 400,
    );
    assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "hello\n");
    await assert.rejects(stat(outside), { code: "ENOENT" });
    const renamed = await f.service.rename(undefined, { projectId: "project_a", path: "note.md",
      name: "renamed.md", expectedVersion: opened.file.version });
    assert.equal(renamed.code, "renamed");
    assert.equal(await readFile(path.join(f.root, "renamed.md"), "utf8"), "hello\n");

    await writeFile(path.join(f.root, "other.md"), "other\n");
    const current = await f.service.get(undefined, "project_a", "renamed.md");
    assert.equal(current.code, "file");
    if (current.code !== "file") return;
    const collision = await f.service.rename(undefined, { projectId: "project_a", path: "renamed.md",
      name: "other.md", expectedVersion: current.file.version });
    assert.equal(collision.code, "conflict");
    if (collision.code === "conflict") assert.equal(collision.reason, "target-exists");
    assert.equal(await readFile(path.join(f.root, "renamed.md"), "utf8"), "hello\n");
    assert.equal(await readFile(path.join(f.root, "other.md"), "utf8"), "other\n");
  });

  it("normalizes denied directories and reports a same-directory file cap", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "NODE_MODULES"));
    await writeFile(path.join(f.root, "NODE_MODULES", "hidden.ts"), "hidden\n");
    await Promise.all(Array.from({ length: 401 }, (_, index) =>
      writeFile(path.join(f.root, `visible-${String(index).padStart(3, "0")}.txt`), "visible\n")));
    const listing = await f.service.get(undefined, "project_a");
    assert.equal(listing.code, "listing");
    if (listing.code !== "listing") return;
    assert.equal(listing.files.length, 400);
    assert.equal(listing.truncated, true);
    assert.equal(listing.files.some(file => file.path.includes("NODE_MODULES")), false);
    await assert.rejects(f.service.get(undefined, "project_a", "NODE_MODULES/hidden.ts"), /not available/);
  });

  it("keeps spaced filenames distinct through read, save, and rename", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, " note.md"), "spaced\n");
    await writeFile(path.join(f.root, "note.md"), "plain\n");
    const readInput = projectFilesInputSchema.parse({ projectId: "project_a", path: " note.md" });
    assert.equal(readInput.path, " note.md");
    const opened = await f.service.get(undefined, readInput.projectId, readInput.path);
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const saveInput = projectFileSaveInputSchema.parse({ projectId: "project_a", path: " note.md",
      expectedVersion: opened.file.version, content: "changed\n" });
    assert.equal(saveInput.path, " note.md");
    const saved = await f.service.save(undefined, saveInput);
    assert.equal(saved.code, "saved");
    assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "plain\n");
    if (saved.code !== "saved") return;
    const renameInput = projectFileRenameInputSchema.parse({ projectId: "project_a", path: " note.md",
      name: " moved.md", expectedVersion: saved.file.version });
    assert.deepEqual({ path: renameInput.path, name: renameInput.name }, { path: " note.md", name: " moved.md" });
    const renamed = await f.service.rename(undefined, renameInput);
    assert.equal(renamed.code, "renamed");
    assert.equal(await readFile(path.join(f.root, " moved.md"), "utf8"), "changed\n");
    assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "plain\n");
  });

  it("bounds oversized files and preserves permissions during rename", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "large.txt"), Buffer.alloc(256 * 1024 + 1, 65));
    await writeFile(path.join(f.root, "script.sh"), "echo hello\n");
    await chmod(path.join(f.root, "script.sh"), 0o754);
    const listing = await f.service.get(undefined, "project_a");
    assert.equal(listing.code, "listing");
    if (listing.code !== "listing") return;
    assert.equal(listing.files.find(file => file.path === "large.txt")?.access, "blocked");
    assert.deepEqual(await f.service.get(undefined, "project_a", "large.txt"),
      { code: "blocked", path: "large.txt", reason: "too-large" });
    const opened = await f.service.get(undefined, "project_a", "script.sh");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const renamed = await f.service.rename(undefined, { projectId: "project_a", path: "script.sh",
      name: "moved.sh", expectedVersion: opened.file.version });
    assert.equal(renamed.code, "renamed");
    assert.equal((await stat(path.join(f.root, "moved.sh"))).mode & 0o777, 0o754);
  });

  it("renames UTF-8 BOM files without changing their bytes", async () => {
    const f = await fixture();
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Note\n")]);
    await writeFile(path.join(f.root, "bom.md"), original);
    const opened = await f.service.get(undefined, "project_a", "bom.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const renamed = await f.service.rename(undefined, { projectId: "project_a", path: "bom.md",
      name: "moved.md", expectedVersion: opened.file.version });
    assert.equal(renamed.code, "renamed");
    assert.deepEqual(await readFile(path.join(f.root, "moved.md")), original);
  });

  it("create makes missing folders without following links and writes exclusively", async () => {
    const f = await fixture();
    const created = await f.service.create(undefined, { projectId: "project_a",
      path: ".vivary/knowledge/relay-budget.md", content: "# Relay budget\n" });
    assert.equal(created.code, "created");
    if (created.code !== "created") return;
    assert.equal(created.file.path, ".vivary/knowledge/relay-budget.md");
    assert.equal(await readFile(path.join(f.root, ".vivary", "knowledge", "relay-budget.md"), "utf8"),
      "# Relay budget\n");
    assert.equal((await stat(path.join(f.root, ".vivary", "knowledge", "relay-budget.md"))).mode & 0o777, 0o644);
    await assert.rejects(f.service.create(undefined, { projectId: "project_a", path: "notes/secret-plan.md",
      content: "x\n" }), /not available/);
    await assert.rejects(f.service.create(undefined, { projectId: "project_a", path: "notes/image.png",
      content: "x\n" }), /not available/);
  });

  it("create refuses a symlinked parent and returns target-exists for an existing file", async () => {
    const f = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
    roots.push(outside);
    await symlink(outside, path.join(f.root, "linked-dir"), "dir");
    await assert.rejects(f.service.create(undefined, { projectId: "project_a", path: "linked-dir/fact.md",
      content: "x\n" }), /not available/);
    await assert.rejects(stat(path.join(outside, "fact.md")), { code: "ENOENT" });

    await writeFile(path.join(f.root, "fact.md"), "existing\n");
    const existing = await f.service.create(undefined, { projectId: "project_a", path: "fact.md", content: "new\n" });
    assert.equal(existing.code, "conflict");
    if (existing.code === "conflict") {
      assert.equal(existing.reason, "target-exists");
      assert.equal(existing.current?.content, "existing\n");
    }
    assert.equal(await readFile(path.join(f.root, "fact.md"), "utf8"), "existing\n");
  });

  it("remove deletes one file after a matching version and never a folder", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, "facts"));
    await writeFile(path.join(f.root, "facts", "fact.md"), "fact\n");
    const opened = await f.service.get(undefined, "project_a", "facts/fact.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    await assert.rejects(f.service.remove(undefined, { projectId: "project_a", path: "facts",
      expectedVersion: opened.file.version }), /not available/);
    const removed = await f.service.remove(undefined, { projectId: "project_a", path: "facts/fact.md",
      expectedVersion: opened.file.version });
    assert.equal(removed.code, "removed");
    assert.equal(removed.code === "removed" && removed.path, "facts/fact.md");
    await assert.rejects(lstat(path.join(f.root, "facts", "fact.md")), { code: "ENOENT" });
    assert.equal((await lstat(path.join(f.root, "facts"))).isDirectory(), true);
  });

  it("remove returns changed, renamed-or-deleted, and project-changed conflicts", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "fact.md"), "before\n");
    const opened = await f.service.get(undefined, "project_a", "fact.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const input = { projectId: "project_a", path: "fact.md", expectedVersion: opened.file.version };
    await writeFile(path.join(f.root, "fact.md"), "external\n");
    const changed = await f.service.remove(undefined, input);
    assert.equal(changed.code === "conflict" && changed.reason, "changed");
    assert.equal(changed.code === "conflict" && changed.current?.content, "external\n");
    await rm(path.join(f.root, "fact.md"));
    assert.deepEqual(await f.service.remove(undefined, input),
      { code: "conflict", operation: "remove", reason: "renamed-or-deleted", path: "fact.md" });

    let call = 0;
    await writeFile(path.join(f.root, "fact.md"), "again\n");
    const moving = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
      bindingId: "binding_a", rootId: "root_a", bindingRevision: ++call, policyRevision: 1 }));
    const result = await moving.remove(undefined, { ...input, expectedVersion: opened.file.version });
    assert.equal(result.code === "conflict" && result.reason, "project-changed");
    assert.equal(await readFile(path.join(f.root, "fact.md"), "utf8"), "again\n");
  });

  it("listFolder and readListedFiles skip links, hardlinks, secret names, binaries, and oversize files", async () => {
    const f = await fixture();
    const project = { projectId: "project_a", label: "Example", rootId: "root_a", bindingId: "binding_a",
      bindingRevision: 1, policyRevision: 1 };
    const folder = path.join(f.root, "facts");
    await mkdir(folder);
    await writeFile(path.join(folder, "b-fact.md"), "# B\n");
    await writeFile(path.join(folder, "a-fact.md"), "# A\n");
    await writeFile(path.join(folder, "notes.txt"), "not markdown\n");
    await writeFile(path.join(folder, "secret-plan.md"), "hidden\n");
    await writeFile(path.join(folder, "binary.md"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(folder, "large.md"), Buffer.alloc(256 * 1024 + 1, 65));
    await writeFile(path.join(f.root, "outside.md"), "outside\n");
    await symlink(path.join(f.root, "outside.md"), path.join(folder, "linked.md"));
    await writeFile(path.join(f.root, "twin.md"), "twin\n");
    await link(path.join(f.root, "twin.md"), path.join(folder, "twin.md"));

    const listing = await listFolder(f.root, "facts", 10);
    assert.deepEqual(listing, { status: "ready",
      names: ["a-fact.md", "b-fact.md", "binary.md", "large.md", "linked.md", "twin.md"], linked: ["linked.md"],
      truncated: false });
    assert.deepEqual(await listFolder(f.root, "facts", 2), { status: "ready", names: ["a-fact.md", "b-fact.md"],
      linked: [], truncated: true });
    // On Windows a link-typed entry counts as a link only when lstat confirms it.
    assert.deepEqual(await listFolder(f.root, "facts", 10, { platform: "win32" }), listing);
    const reparse = await listFolder(f.root, "facts", 10, { platform: "win32",
      inspect: (async (target: string) => (target.endsWith("linked.md")
        ? { isSymbolicLink: () => false, isFile: () => true } : lstat(target))) as unknown as typeof lstat });
    assert.deepEqual(reparse, { ...listing, linked: [] });
    const vanished = await listFolder(f.root, "facts", 10, { platform: "win32",
      inspect: (async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }) as unknown as typeof lstat });
    assert.deepEqual(vanished, { status: "ready", names: ["a-fact.md", "b-fact.md", "binary.md", "large.md", "twin.md"],
      linked: [], truncated: false });
    if (listing.status !== "ready") return;
    const read = await readListedFiles(f.root, listing.names.map(name => `facts/${name}`), project);
    assert.deepEqual(read.files.map(file => file.path), ["facts/a-fact.md", "facts/b-fact.md"]);
    assert.deepEqual(read.skipped, [
      { path: "facts/binary.md", reason: "binary" },
      { path: "facts/large.md", reason: "too-large" },
      { path: "facts/linked.md", reason: "linked" },
      { path: "facts/twin.md", reason: "linked" },
    ]);

    const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
    roots.push(outside);
    await symlink(outside, path.join(f.root, "linked-facts"), "dir");
    assert.deepEqual(await listFolder(f.root, "linked-facts", 10), { status: "linked" });
    assert.deepEqual(await listFolder(f.root, "missing/facts", 10), { status: "absent" });
    assert.deepEqual(await listFolder(f.root, "outside.md", 10), { status: "not-folder" });
    assert.deepEqual(await listFolder(f.root, "outside.md/facts", 10), { status: "not-folder" });
    assert.deepEqual(await listFolder(f.root, "credentials/facts", 10), { status: "blocked" });
  });

  it("skips a fact file another program holds open instead of failing the read", async () => {
    const f = await fixture();
    const project = { projectId: "project_a", label: "Example", rootId: "root_a", bindingId: "binding_a",
      bindingRevision: 1, policyRevision: 1 };
    await mkdir(path.join(f.root, "facts"));
    await writeFile(path.join(f.root, "facts", "open.md"), "# Open\n");
    await writeFile(path.join(f.root, "facts", "free.md"), "# Free\n");
    const read = await readListedFiles(f.root, ["facts/open.md", "facts/free.md"], project,
      async (root, requested, identity) => {
        if (requested === "facts/open.md") throw Object.assign(new Error(`EBUSY: ${root}/facts/open.md`), { code: "EBUSY" });
        return inspectEditableFile(root, requested, identity);
      });
    assert.deepEqual(read.files.map(file => file.path), ["facts/free.md"]);
    assert.deepEqual(read.skipped, [{ path: "facts/open.md", reason: "unreadable" }]);
  });

  it("reads a lock only from Windows lock codes on Windows and from EBUSY elsewhere", () => {
    const failure = (code: string) => Object.assign(new Error(code), { code });
    for (const code of ["EBUSY", "EPERM", "EACCES"]) {
      assert.equal(isLockError(failure(code), "win32"), true, code);
      assert.equal(isPermissionError(failure(code), "win32"), false, code);
    }
    assert.equal(isLockError(failure("EBUSY"), "linux"), true);
    for (const code of ["EPERM", "EACCES"]) {
      assert.equal(isLockError(failure(code), "darwin"), false, code);
      assert.equal(isPermissionError(failure(code), "linux"), true, code);
    }
    assert.equal(isLockError(failure("EIO"), "win32"), false);
  });

  it("refuses a permission error at once off Windows, with its own wording", { skip: process.platform === "win32" },
    async () => {
      const f = await fixture();
      await writeFile(path.join(f.root, "fact.md"), "fact\n");
      let attempts = 0;
      const denied = Object.assign(new Error(`EACCES: permission denied, unlink '${f.root}/fact.md'`), { code: "EACCES" });
      const service = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
        bindingId: "binding_a", rootId: "root_a", bindingRevision: 1, policyRevision: 1 }),
      { unlink: async () => { attempts += 1; throw denied; }, rename });
      const opened = await service.get(undefined, "project_a", "fact.md");
      if (opened.code !== "file") throw new Error("fixture file missing");
      await assert.rejects(service.remove(undefined, { projectId: "project_a", path: "fact.md",
        expectedVersion: opened.file.version }), (error: Error) => error instanceof ProjectFilePermissionError
        && error.message === "Vivary does not have permission to change this file.");
      assert.equal(attempts, 1);
      const project = { projectId: "project_a", label: "Example", rootId: "root_a", bindingId: "binding_a",
        bindingRevision: 1, policyRevision: 1 };
      const read = await readListedFiles(f.root, ["fact.md"], project, async () => { throw denied; });
      assert.deepEqual(read.skipped, [{ path: "fact.md", reason: "no-permission" }]);
    });

  it("retries a locked unlink or rename, then refuses with a fixed message", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "fact.md"), "fact\n");
    let attempts = 0;
    const locked = Object.assign(new Error(`EBUSY: resource busy, unlink '${f.root}/fact.md'`), { code: "EBUSY" });
    const always = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
      bindingId: "binding_a", rootId: "root_a", bindingRevision: 1, policyRevision: 1 }),
    { unlink: async () => { attempts += 1; throw locked; }, rename });
    const opened = await always.get(undefined, "project_a", "fact.md");
    assert.equal(opened.code, "file");
    if (opened.code !== "file") return;
    const inode = (await stat(path.join(f.root, "fact.md"))).ino;
    await assert.rejects(always.remove(undefined, { projectId: "project_a", path: "fact.md",
      expectedVersion: opened.file.version }), (error: Error) => error instanceof ProjectFileLockedError
      && !error.message.includes(f.root));
    assert.equal(attempts, 4);
    assert.equal(await readFile(path.join(f.root, "fact.md"), "utf8"), "fact\n");

    let flaky = 0;
    const eventually = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
      bindingId: "binding_a", rootId: "root_a", bindingRevision: 1, policyRevision: 1 }),
    { unlink: async target => { flaky += 1; if (flaky < 3) throw locked; return unlink(target); }, rename });
    // The failed attempts left the file as it was: same inode, same bytes. The
    // version also hashes mtime, which Zo's gVisor 9p file system reported
    // moving back by about 1 ms between two plain stat calls during the full
    // CI list, with nothing writing the file, so the version is not compared.
    const reopened = await eventually.get(undefined, "project_a", "fact.md");
    if (reopened.code !== "file") throw new Error("fixture file missing");
    assert.equal(reopened.file.content, opened.file.content);
    assert.equal((await stat(path.join(f.root, "fact.md"))).ino, inode);
    const removed = await eventually.remove(undefined, { projectId: "project_a", path: "fact.md",
      expectedVersion: reopened.file.version });
    assert.equal(removed.code, "removed", JSON.stringify(removed));
    assert.equal(flaky, 3);
  });

  it("a locked unlink or rename stops when another program saves between attempts", async () => {
    const f = await fixture();
    const file = path.join(f.root, "fact.md");
    await writeFile(file, "fact\n");
    const resolver = async () => ({ root: f.root, label: "Example", projectId: "project_a", bindingId: "binding_a",
      rootId: "root_a", bindingRevision: 1, policyRevision: 1 });
    const locked = () => Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    let unlinks = 0;
    const removing = createProjectFileService(resolver, { rename, unlink: async target => {
      unlinks += 1;
      if (unlinks === 1) {
        await writeFile(file, "saved by another program\n");
        throw locked();
      }
      return unlink(target);
    } });
    const opened = await removing.get(undefined, "project_a", "fact.md");
    if (opened.code !== "file") throw new Error("fixture file missing");
    const removed = await removing.remove(undefined, { projectId: "project_a", path: "fact.md",
      expectedVersion: opened.file.version });
    assert.equal(removed.code === "conflict" && removed.reason, "changed");
    assert.equal(unlinks, 1);
    assert.equal(await readFile(file, "utf8"), "saved by another program\n");

    let renames = 0;
    const saving = createProjectFileService(resolver, { unlink, rename: async (from, to) => {
      renames += 1;
      if (renames === 1) {
        await writeFile(file, "saved again by another program\n");
        throw locked();
      }
      return rename(from, to);
    } });
    const reopened = await saving.get(undefined, "project_a", "fact.md");
    if (reopened.code !== "file") throw new Error("fixture file missing");
    const saved = await saving.save(undefined, { projectId: "project_a", path: "fact.md",
      expectedVersion: reopened.file.version, content: "mine\n" });
    assert.equal(saved.code === "conflict" && saved.reason, "changed");
    assert.equal(renames, 1);
    assert.equal(await readFile(file, "utf8"), "saved again by another program\n");
  });

  it("never deletes another file when the folder is swapped after the write", async () => {
    const f = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "fact.md"), "unrelated\n");
    let calls = 0;
    const swapping = createProjectFileService(async () => {
      calls += 1;
      if (calls === 4) {
        // After the write and before the check, the folder moves and a link to another place takes its name.
        await rename(path.join(f.root, "notes"), path.join(f.root, "notes-moved"));
        await symlink(outside, path.join(f.root, "notes"));
      }
      return { root: f.root, label: "Example", projectId: "project_a", bindingId: "binding_a",
        rootId: "root_a", bindingRevision: 1, policyRevision: 1 };
    });
    await assert.rejects(swapping.create(undefined, { projectId: "project_a", path: "notes/fact.md", content: "mine\n" }),
      /not available in Vivary/);
    assert.equal(await readFile(path.join(outside, "fact.md"), "utf8"), "unrelated\n");
  });

  it("removes the written file or copy when the project becomes unavailable right after the write", async () => {
    const f = await fixture();
    let calls = 0;
    let failAt = 4;
    const workspace = { root: f.root, label: "Example", projectId: "project_a", bindingId: "binding_a",
      rootId: "root_a", bindingRevision: 1, policyRevision: 1 };
    const flaky = createProjectFileService(async () => {
      calls += 1;
      if (calls === failAt) throw new Error("Project unavailable");
      return workspace;
    });
    await assert.rejects(flaky.create(undefined, { projectId: "project_a", path: "notes/fact.md", content: "x\n" }),
      /Project unavailable/);
    await assert.rejects(stat(path.join(f.root, "notes", "fact.md")), { code: "ENOENT" });

    await writeFile(path.join(f.root, "source.md"), "source\n");
    calls = 0;
    const opened = await flaky.get(undefined, "project_a", "source.md");
    if (opened.code !== "file") throw new Error("fixture file missing");
    // get resolves twice. The rename's post-write resolve is its fourth call after that.
    failAt = 6;
    await assert.rejects(flaky.rename(undefined, { projectId: "project_a", path: "source.md", name: "target.md",
      expectedVersion: opened.file.version }), /Project unavailable/);
    await assert.rejects(stat(path.join(f.root, "target.md")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(f.root, "source.md"), "utf8"), "source\n");
  });

  it("never deletes another file when a folder is swapped just before a remove or a Rename's source delete", async () => {
    for (const operation of ["remove", "rename"] as const) {
      const f = await fixture();
      const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
      roots.push(outside);
      await mkdir(path.join(f.root, "notes"));
      await writeFile(path.join(f.root, "notes", "fact.md"), "same\n");
      // Same name and same bytes, so only the file identity tells them apart.
      await writeFile(path.join(outside, "fact.md"), "same\n");
      let unlinks = 0;
      const service = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
        bindingId: "binding_a", rootId: "root_a", bindingRevision: 1, policyRevision: 1 }), { rename,
        unlink: async target => {
          unlinks += 1;
          if (unlinks === 1) {
            await rename(path.join(f.root, "notes"), path.join(f.root, "notes-moved"));
            await symlink(outside, path.join(f.root, "notes"));
            throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
          }
          return unlink(target);
        } });
      const opened = await service.get(undefined, "project_a", "notes/fact.md");
      if (opened.code !== "file") throw new Error("fixture file missing");
      const attempt = operation === "remove"
        ? service.remove(undefined, { projectId: "project_a", path: "notes/fact.md", expectedVersion: opened.file.version })
        : service.rename(undefined, { projectId: "project_a", path: "notes/fact.md", name: "renamed.md",
          expectedVersion: opened.file.version });
      await assert.rejects(attempt, /not available in Vivary/, operation);
      assert.equal(await readFile(path.join(outside, "fact.md"), "utf8"), "same\n", operation);
      assert.equal(await readFile(path.join(f.root, "notes-moved", "fact.md"), "utf8"), "same\n", operation);
    }
  });

  it("maps a lock error from the re-read before a retry to the fixed message", async () => {
    const locked = () => Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    const expected = { access: "editable", path: "fact.md", name: "fact.md", sizeBytes: 5, updatedAt: "",
      kind: "markdown", content: "fact\n", version: "pf_x" } as const;
    await assert.rejects(withLockRetries(async () => { throw locked(); },
      { read: async () => { throw locked(); }, expected }), ProjectFileLockedError);
  });

  it("refuses a create or save whose parent folder became a link during the write", async () => {
    const f = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "vivary-project-files-outside-"));
    roots.push(outside);
    let calls = 0;
    const swapping = createProjectFileService(async () => {
      calls += 1;
      if (calls === 3) {
        // After the path checks, the new folder is replaced by a link that leaves the project.
        await rm(path.join(f.root, "notes"), { recursive: true });
        await symlink(outside, path.join(f.root, "notes"));
      }
      return { root: f.root, label: "Example", projectId: "project_a", bindingId: "binding_a",
        rootId: "root_a", bindingRevision: 1, policyRevision: 1 };
    });
    await assert.rejects(swapping.create(undefined, { projectId: "project_a", path: "notes/fact.md", content: "x\n" }),
      /not available in Vivary/);
    // The path to the written file now runs through a link, so it is left in place rather than removed by path.
    assert.deepEqual(await readdir(outside), ["fact.md"]);

    await rm(path.join(f.root, "notes"));
    await mkdir(path.join(f.root, "docs"));
    await writeFile(path.join(f.root, "docs", "fact.md"), "fact\n");
    const moved = path.join(f.root, "moved-docs");
    const resolver = async () => ({ root: f.root, label: "Example", projectId: "project_a", bindingId: "binding_a",
      rootId: "root_a", bindingRevision: 1, policyRevision: 1 });
    const swappingSave = createProjectFileService(resolver, { unlink, rename: async (from, to) => {
      await rename(path.join(f.root, "docs"), moved);
      await symlink(moved, path.join(f.root, "docs"));
      return rename(from, to);
    } });
    const opened = await swappingSave.get(undefined, "project_a", "docs/fact.md");
    if (opened.code !== "file") throw new Error("fixture file missing");
    await assert.rejects(swappingSave.save(undefined, { projectId: "project_a", path: "docs/fact.md",
      expectedVersion: opened.file.version, content: "new\n" }), /not available in Vivary/);
  });

  it("keys an oversize settings file on its stat, so an edit changes the key", async () => {
    const f = await fixture();
    const file = path.join(f.root, ".gitignore");
    await writeFile(file, "x".repeat(300 * 1024));
    const first = await fileDigest(f.root, ".gitignore");
    assert.match(first, /^unreadable:/);
    await writeFile(file, "y".repeat(301 * 1024));
    const second = await fileDigest(f.root, ".gitignore");
    assert.match(second, /^unreadable:/);
    assert.notEqual(first, second);
  });

  it("create removes the folders it made when it then refuses", async () => {
    const f = await fixture();
    let calls = 0;
    // The binding changes after the create made its folders.
    const moving = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
      bindingId: "binding_a", rootId: "root_a", bindingRevision: ++calls < 3 ? 1 : 2, policyRevision: 1 }));
    const result = await moving.create(undefined, { projectId: "project_a", path: "new/deeper/fact.md", content: "x\n" });
    assert.equal(result.code === "conflict" && result.reason, "project-changed");
    await assert.rejects(lstat(path.join(f.root, "new")), { code: "ENOENT" });
  });

  it("rejects reads when the project binding changes before return", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "note.md"), "private\n");
    let call = 0;
    const changing = createProjectFileService(async () => ({ root: f.root, label: "Example", projectId: "project_a",
      bindingId: "binding_a", rootId: "root_a", bindingRevision: ++call, policyRevision: 1 }));
    await assert.rejects(changing.get(undefined, "project_a", "note.md"), /changed while its files were being read/);
  });
});
