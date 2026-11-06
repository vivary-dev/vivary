import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import type { ActionRunContext } from "@agent-native/core/action";

import type {
  ProjectFile,
  ProjectFileBlockedReason,
  ProjectFileCreateResult,
  ProjectFileIdentity,
  ProjectFileRemoveResult,
  ProjectFileRenameResult,
  ProjectFilesResult,
  ProjectFileSaveResult,
  ProjectFileSummary,
} from "../app/lib/project-file-schema.ts";
import { resolveLocalProjectWorkspace } from "./project-services.mjs";

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 400;
const MAX_SCANNED_ENTRIES = 4_000;
const MAX_SCAN_DEPTH = 8;
export const SKIPPED_DIRECTORIES = new Set([
  ".aws", ".azure", ".git", ".gnupg", ".next", ".ssh", ".turbo", ".vercel",
  "build", "coverage", "dist", "node_modules", "out", "vendor",
]);
const SECRET_EXTENSIONS = new Set([".cer", ".crt", ".der", ".key", ".p12", ".pfx", ".pem"]);
const EDITABLE_EXTENSIONS = new Map<string, ProjectFile["kind"]>([
  [".md", "markdown"], [".markdown", "markdown"], [".mdx", "markdown"], [".txt", "text"],
  [".toml", "toml"],
  [".c", "source"], [".cc", "source"], [".cpp", "source"], [".css", "source"],
  [".go", "source"], [".h", "source"], [".html", "source"], [".java", "source"],
  [".js", "source"], [".json", "source"], [".jsonc", "source"], [".jsx", "source"],
  [".kt", "source"], [".mjs", "source"], [".cjs", "source"], [".py", "source"],
  [".rs", "source"], [".scss", "source"], [".sh", "source"], [".ps1", "source"],
  [".ts", "source"], [".tsx", "source"], [".xml", "source"], [".yaml", "source"], [".yml", "source"],
]);

export type Workspace = Readonly<{
  root: string;
  label: string;
  projectId?: string;
  bindingId?: string;
  bindingRevision?: number;
  policyRevision?: number;
  rootId?: string;
}>;

export type Resolver = (context: ActionRunContext | undefined, projectId: string) => Promise<Workspace | undefined>;

class ProjectFileBoundaryError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: "invalid-path" | "blocked-path") {
    super(code === "invalid-path" ? "Choose a file inside the selected project." : "This file is not available in Vivary.");
  }
}

export function projectIdentity(workspace: Workspace): ProjectFileIdentity {
  if (!workspace.projectId || !workspace.bindingId || !workspace.rootId
    || !workspace.bindingRevision || !workspace.policyRevision) {
    throw new Error("The selected project binding is incomplete.");
  }
  return {
    projectId: workspace.projectId,
    label: workspace.label,
    rootId: workspace.rootId,
    bindingId: workspace.bindingId,
    bindingRevision: workspace.bindingRevision,
    policyRevision: workspace.policyRevision,
  };
}

export function sameProject(left: ProjectFileIdentity, right: ProjectFileIdentity): boolean {
  return left.projectId === right.projectId && left.rootId === right.rootId
    && left.bindingId === right.bindingId && left.bindingRevision === right.bindingRevision
    && left.policyRevision === right.policyRevision;
}

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower === ".npmrc"
    || lower === ".netrc" || lower === ".pypirc" || lower === "credentials"
    || lower === "credentials.json" || lower === "id_ed25519" || lower === "id_rsa"
    || lower.includes("credential") || lower.includes("secret")
    || SECRET_EXTENSIONS.has(path.extname(lower));
}

function relativeParts(requestedPath: string): string[] {
  if (!requestedPath || requestedPath.includes("\\") || path.posix.isAbsolute(requestedPath)) {
    throw new ProjectFileBoundaryError("invalid-path");
  }
  const parts = requestedPath.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || isSecretName(part))
    || parts.some(part => SKIPPED_DIRECTORIES.has(part.toLowerCase()))) {
    throw new ProjectFileBoundaryError("blocked-path");
  }
  return parts;
}

export function portablePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolvePathWithoutLinks(root: string, requestedPath: string, allowMissingLeaf = false): Promise<string> {
  const parts = relativeParts(requestedPath);
  let candidate = root;
  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    let entry: Stats;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
    if (entry.isSymbolicLink()) throw new ProjectFileBoundaryError("blocked-path");
    if (index < parts.length - 1 && !entry.isDirectory()) throw new ProjectFileBoundaryError("invalid-path");
  }
  const canonical = await realpath(candidate);
  if (!contained(root, canonical)) throw new ProjectFileBoundaryError("blocked-path");
  return canonical;
}

export function kindFor(filePath: string): ProjectFile["kind"] | null {
  return EDITABLE_EXTENSIONS.get(path.extname(filePath).toLowerCase()) ?? null;
}

function versionFor(project: ProjectFileIdentity, filePath: string, info: Stats, bytes: Buffer): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(project)).update("\0").update(filePath).update("\0")
    .update(String(info.dev)).update(":").update(String(info.ino)).update(":")
    .update(String(info.birthtimeMs)).update(":").update(String(info.mtimeMs)).update(":")
    .update(String(info.size)).update("\0").update(bytes).digest("hex");
  return `pf_${digest}`;
}

export function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readBoundedFile(absolute: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  const handle = await open(absolute, "r");
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer.subarray(0, offset);
}

/**
 * The device and inode of one file, as bigints so an NTFS file ID above 2^53
 * cannot collide with another. A delete removes only the file it names.
 */
type FileIdentity = { dev: bigint; ino: bigint };

function identityOf(info: BigIntStats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

/** Write a new file that must not exist yet. Returns its identity from the open handle. */
async function writeExclusiveBounded(target: string, bytes: Buffer, mode: number): Promise<FileIdentity> {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Project files are limited to 256 KB.");
  const handle = await open(target, "wx", mode & 0o777);
  let written: FileIdentity | null = null;
  try {
    written = identityOf(await handle.stat({ bigint: true }));
    await handle.chmod(mode & 0o777);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    if (written) await unlinkIfWritten(target, written);
    throw error;
  }
  await handle.close();
  return written;
}

/** Remove `absolute` only when it is still the regular file `identity` names. */
async function unlinkIfWritten(absolute: string, identity: FileIdentity,
  remove: (target: string) => Promise<void> = unlink): Promise<boolean> {
  const info = await lstat(absolute, { bigint: true }).catch(() => null);
  if (!info?.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) return false;
  await remove(absolute);
  return true;
}

/**
 * Remove the file `identity` names at `requestedPath` under `root`. Every
 * path component is checked again right before the delete, so a folder
 * swapped for a link sends nothing to another file of the same name.
 * `linked` means the path now runs through a link, `changed` that another
 * file is there, and in both cases nothing was deleted.
 */
async function removeIdentifiedFile(root: string, requestedPath: string, identity: FileIdentity,
  remove: (target: string) => Promise<void> = unlink): Promise<"removed" | "linked" | "changed"> {
  let absolute: string;
  try {
    absolute = await resolvePathWithoutLinks(root, requestedPath);
  } catch (error) {
    if (error instanceof ProjectFileBoundaryError) return "linked";
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "changed";
    throw error;
  }
  return await unlinkIfWritten(absolute, identity, remove) ? "removed" : "changed";
}

/** Remove the file this process wrote, or leave it in place when its path or identity changed. */
async function removeWrittenFile(root: string, requestedPath: string, written: FileIdentity,
  remove: (target: string) => Promise<void> = unlink): Promise<boolean> {
  return await removeIdentifiedFile(root, requestedPath, written, remove) === "removed";
}

/**
 * One read of one file: the editable file, or the reason it is not one, and
 * the bytes the read took. Null when the file is missing. Throws a boundary
 * error for a blocked name or a linked path. Each file is read at most once.
 */
export type FileInspection = { file: ProjectFile; bytesRead: number }
  | { file: null; reason: ProjectFileBlockedReason; bytesRead: number };

export async function inspectEditableFile(root: string, requestedPath: string, project: ProjectFileIdentity):
  Promise<FileInspection | null> {
  let absolute: string;
  try {
    absolute = await resolvePathWithoutLinks(root, requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const info = await lstat(absolute);
  if (!info.isFile()) throw new ProjectFileBoundaryError("blocked-path");
  if (info.nlink !== 1) return { file: null, reason: "linked", bytesRead: 0 };
  const kind = kindFor(absolute);
  if (!kind) return { file: null, reason: "unsupported", bytesRead: 0 };
  if (info.size > MAX_FILE_BYTES) return { file: null, reason: "too-large", bytesRead: 0 };
  const bytes = await readBoundedFile(absolute);
  if (bytes.length > MAX_FILE_BYTES) return { file: null, reason: "too-large", bytesRead: bytes.length };
  const content = decodeText(bytes);
  if (content === null) return { file: null, reason: "binary", bytesRead: bytes.length };
  return { bytesRead: bytes.length, file: {
    access: "editable",
    path: portablePath(root, absolute),
    name: path.basename(absolute),
    sizeBytes: bytes.length,
    updatedAt: info.mtime.toISOString(),
    kind,
    content,
    version: versionFor(project, portablePath(root, absolute), info, bytes),
  } };
}

/**
 * One editable file, or null when it is missing, multiply linked, or not
 * bounded text. Throws a boundary error for a blocked name or a linked path.
 */
export async function readEditableFile(root: string, requestedPath: string, project: ProjectFileIdentity): Promise<ProjectFile | null> {
  return (await inspectEditableFile(root, requestedPath, project))?.file ?? null;
}

async function blockedReason(root: string, requestedPath: string): Promise<ProjectFileBlockedReason> {
  const absolute = await resolvePathWithoutLinks(root, requestedPath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.nlink !== 1) return "linked";
  if (!kindFor(absolute)) return "unsupported";
  if (info.size > MAX_FILE_BYTES) return "too-large";
  const bytes = await readBoundedFile(absolute);
  if (bytes.length > MAX_FILE_BYTES) return "too-large";
  return decodeText(bytes) === null ? "binary" : "unsupported";
}

export type FolderListing =
  | { status: "absent" | "not-folder" | "linked" | "blocked" }
  /**
   * Fact file names directly inside the folder, sorted, links included so a
   * read can report them. `linked` names the links among them. `truncated` is
   * true when the folder held more entries than one listing scans or more
   * fact files than `limit`.
   */
  | { status: "ready"; names: string[]; linked: string[]; truncated: boolean };

/** Entries one folder listing scans before it stops. The creator's `_CONTEXT_SCANNED_ENTRIES` matches it. */
const MAX_FOLDER_ENTRIES = 4_000;

/**
 * A fact file name: `<something>.md`, not secret-looking. The creator's
 * `_is_fact_file_name` applies the same rule.
 */
export function isFactFileName(name: string): boolean {
  return name.length > 3 && name.toLowerCase().endsWith(".md") && !isSecretName(name);
}

/**
 * List the fact files directly inside one project folder without following
 * links. `absent` covers a missing folder or parent. Regular files and links
 * with a fact file name count. At most MAX_FOLDER_ENTRIES entries are scanned
 * and `limit` names returned, in UTF-16 code unit order among those scanned.
 * The creator's `_markdown_names` makes the same listing, so the files it
 * checks are exactly the regular files here.
 */
export async function listFolder(root: string, folder: string, limit: number,
  { platform = process.platform, inspect = lstat }: { platform?: NodeJS.Platform; inspect?: typeof lstat } = {}):
  Promise<FolderListing> {
  let parts: string[];
  try {
    parts = relativeParts(folder);
  } catch {
    return { status: "blocked" };
  }
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    let entry: Stats;
    try {
      entry = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    if (entry.isSymbolicLink()) return { status: "linked" };
    if (!entry.isDirectory()) return { status: "not-folder" };
  }
  if (!contained(root, await realpath(directory))) return { status: "linked" };
  const names: string[] = [];
  const links = new Set<string>();
  let scanned = 0;
  let truncated = false;
  for await (const entry of await opendir(directory)) {
    if (++scanned > MAX_FOLDER_ENTRIES) {
      truncated = true;
      break;
    }
    if (!isFactFileName(entry.name)) continue;
    let isLink = entry.isSymbolicLink();
    let isFile = entry.isFile();
    if (isLink && platform === "win32") {
      // A Windows directory entry reports other reparse points as links too,
      // so lstat decides. Node's lstat also reports a junction as a link, while
      // Python's is_symlink() does not. The engine then leaves a junction out
      // of its checked files, and the Workbench skips it as linked, which
      // fails closed.
      const info = await inspect(path.join(directory, entry.name)).catch(() => null);
      isLink = info?.isSymbolicLink() ?? false;
      isFile = !isLink && (info?.isFile() ?? false);
    }
    if (isLink) links.add(entry.name);
    if (isFile || isLink) names.push(entry.name);
  }
  names.sort();
  const shown = names.slice(0, limit);
  return { status: "ready", names: shown, linked: shown.filter(name => links.has(name)),
    truncated: truncated || names.length > limit };
}

/**
 * Whether `error` means another program holds the file. Windows reports an
 * open file as EBUSY, EPERM, or EACCES. On other systems only EBUSY does, and
 * EACCES or EPERM is a permission refusal.
 */
export function isLockError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  return platform === "win32" ? ["EBUSY", "EPERM", "EACCES"].includes(code) : code === "EBUSY";
}

/** Whether `error` is a permission refusal rather than a lock. */
export function isPermissionError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  return platform !== "win32" && (code === "EACCES" || code === "EPERM");
}

export type ListedFileSkip = { path: string; reason: ProjectFileBlockedReason | "unreadable" | "no-permission" };

/**
 * Read listed files the way the file tree checks them: no links, and only
 * bounded text. A file that is not readable, including one another program
 * holds open, is skipped with its reason. A file removed since it was listed
 * is left out. Each file keeps the path it was listed under, so a folder's
 * configured spelling wins over the disk's case. Each file is read once, and
 * `bytesRead` counts every byte read, whether or not the file loaded.
 */
export async function readListedFiles(root: string, paths: readonly string[], project: ProjectFileIdentity,
  read: typeof inspectEditableFile = inspectEditableFile):
  Promise<{ files: ProjectFile[]; skipped: ListedFileSkip[]; bytesRead: number }> {
  const files: ProjectFile[] = [];
  const skipped: ListedFileSkip[] = [];
  let bytesRead = 0;
  for (const filePath of paths) {
    try {
      const inspection = await read(root, filePath, project);
      if (!inspection) continue;
      bytesRead += inspection.bytesRead;
      if (inspection.file) files.push({ ...inspection.file, path: filePath });
      else skipped.push({ path: filePath, reason: inspection.reason });
    } catch (error) {
      if (error instanceof ProjectFileBoundaryError) skipped.push({ path: filePath, reason: "linked" });
      else if (isLockError(error)) skipped.push({ path: filePath, reason: "unreadable" });
      else if (isPermissionError(error)) skipped.push({ path: filePath, reason: "no-permission" });
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { files, skipped, bytesRead };
}

/**
 * A content key for one small settings file: `absent`, `unreadable` for a
 * link or a blocked path, `unreadable:` plus its size, mtime, inode, and link
 * count for a multiply linked or oversize file, so an edit still changes the
 * key, or the SHA-256 of its bytes. Callers use it to tell whether a cached
 * answer still applies. Every unreadable key starts with `unreadable`.
 */
export async function fileDigest(root: string, requestedPath: string): Promise<string> {
  let absolute: string;
  try {
    absolute = await resolvePathWithoutLinks(root, requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    if (error instanceof ProjectFileBoundaryError) return "unreadable";
    throw error;
  }
  const info = await lstat(absolute);
  const statKey = `unreadable:${info.size}:${info.mtimeMs}:${info.ino}:${info.nlink}`;
  if (!info.isFile()) return "unreadable";
  if (info.nlink !== 1 || info.size > MAX_FILE_BYTES) return statKey;
  const bytes = await readBoundedFile(absolute);
  if (bytes.length > MAX_FILE_BYTES) return statKey;
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Create each missing parent folder of `requestedPath`, one component at a
 * time, without following links. An existing component must be a real folder.
 * Returns the folders this call created, deepest last.
 */
async function createParentFolders(root: string, requestedPath: string): Promise<string[]> {
  const parts = relativeParts(requestedPath).slice(0, -1);
  const created: string[] = [];
  let directory = root;
  try {
    for (const part of parts) {
      directory = path.join(directory, part);
      try {
        await mkdir(directory);
        created.push(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const entry = await lstat(directory);
      if (entry.isSymbolicLink()) throw new ProjectFileBoundaryError("blocked-path");
      if (!entry.isDirectory()) throw new ProjectFileBoundaryError("invalid-path");
    }
    if (!contained(root, await realpath(directory))) throw new ProjectFileBoundaryError("blocked-path");
  } catch (error) {
    await removeCreatedFolders(created);
    throw error;
  }
  return created;
}

/** Remove folders a refused create made, deepest first. A folder something else filled stays. */
async function removeCreatedFolders(created: readonly string[]): Promise<void> {
  for (const directory of [...created].reverse()) await rmdir(directory).catch(() => undefined);
}

/** The file stayed locked after retries. The message names no path. */
export class ProjectFileLockedError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("Another program is using this file. Close it and try again.");
  }
}

/** The system refused the change. The message names no path. */
export class ProjectFilePermissionError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Vivary does not have permission to change this file.");
  }
}

export type FileOperations = { unlink: typeof unlink; rename: typeof rename };
const fileOperations: FileOperations = { unlink, rename };
const LOCK_RETRY_DELAYS_MS = [50, 150, 400];

/** The file changed while a locked unlink or rename waited to retry. `current` is null when it is gone. */
class ProjectFileChangedWhileLocked extends Error {
  constructor(readonly current: ProjectFile | null) {
    super("The project file changed while it was locked.");
  }
}

/**
 * Retry an unlink or rename refused because another program holds the file,
 * then give up with a fixed message. A permission refusal gets its own fixed
 * message at once. Before each retry, `check` reads the file again, so a save
 * another program made while it held the file is not overwritten or deleted:
 * the retry stops with ProjectFileChangedWhileLocked instead.
 */
export async function withLockRetries<T>(operation: () => Promise<T>,
  check?: { read: () => Promise<ProjectFile | null>; expected: ProjectFile }): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isPermissionError(error)) throw new ProjectFilePermissionError();
      if (!isLockError(error)) throw error;
      if (attempt >= LOCK_RETRY_DELAYS_MS.length) throw new ProjectFileLockedError();
      await delay(LOCK_RETRY_DELAYS_MS[attempt]);
      if (check) {
        let current: ProjectFile | null;
        try {
          current = await check.read();
        } catch (readError) {
          if (isPermissionError(readError)) throw new ProjectFilePermissionError();
          if (isLockError(readError)) throw new ProjectFileLockedError();
          throw readError;
        }
        // Content, not the version: the version also hashes mtime, which some
        // file systems report differently between two reads of an unchanged file.
        if (current?.content !== check.expected.content) throw new ProjectFileChangedWhileLocked(current);
      }
    }
  }
}

/**
 * Node has no openat, so a parent folder swapped for a link between the path
 * check and a write can redirect it. After a write this confirms the file is
 * still inside `root` with no link on its path.
 */
async function writtenInsideRoot(root: string, requestedPath: string): Promise<boolean> {
  try {
    const absolute = await resolvePathWithoutLinks(root, requestedPath);
    return contained(root, await realpath(absolute));
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<{ files: ProjectFileSummary[]; truncated: boolean }> {
  const files: ProjectFileSummary[] = [];
  const pending = [{ directory: root, depth: 0 }];
  let scanned = 0;
  let truncated = false;
  scan: while (pending.length && files.length < MAX_LISTED_FILES) {
    const next = pending.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(next.directory, { withFileTypes: true });
    } catch (error) {
      if (next.directory === root) throw error;
      continue;
    }
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) { truncated = true; break scan; }
      if (entry.isSymbolicLink() || isSecretName(entry.name)) continue;
      try {
        if (entry.isDirectory()) {
          if (next.depth < MAX_SCAN_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
            const child = path.join(next.directory, entry.name);
            const canonical = await realpath(child);
            if (contained(root, canonical)) pending.push({ directory: canonical, depth: next.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const absolute = path.join(next.directory, entry.name);
        const info = await lstat(absolute);
        const common = { path: portablePath(root, absolute), name: entry.name,
          sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
        const kind = kindFor(absolute);
        if (info.nlink !== 1) files.push({ ...common, access: "blocked", kind: "unknown", reason: "linked" });
        else if (!kind) files.push({ ...common, access: "blocked", kind: "unknown", reason: "unsupported" });
        else if (info.size > MAX_FILE_BYTES) files.push({ ...common, access: "blocked", kind: "unknown", reason: "too-large" });
        else {
          const bytes = await readBoundedFile(absolute);
          const content = bytes.length > MAX_FILE_BYTES ? null : decodeText(bytes);
          files.push(bytes.length > MAX_FILE_BYTES
            ? { ...common, sizeBytes: bytes.length, access: "blocked", kind: "unknown", reason: "too-large" }
            : content === null
              ? { ...common, access: "blocked", kind: "unknown", reason: "binary" }
              : { ...common, access: "editable", kind });
        }
      } catch { continue; }
      if (files.length >= MAX_LISTED_FILES) {
        truncated = entryIndex < entries.length - 1 || pending.length > 0;
        break scan;
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated: truncated || pending.length > 0 };
}

async function writeTemporarySibling(target: string, content: string, mode: number): Promise<string> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Project files are limited to 256 KB.");
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.vivary-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode & 0o777);
  try {
    await handle.chmod(mode & 0o777);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

const mutationTails = new Map<string, Promise<void>>();

async function serializeMutation<T>(project: ProjectFileIdentity, operation: () => Promise<T>): Promise<T> {
  const key = `${project.rootId}:${project.bindingId}`;
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => turn);
  mutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

export function createProjectFileService(resolveWorkspace: Resolver = resolveLocalProjectWorkspace,
  operations: FileOperations = fileOperations) {
  const resolve = async (context: ActionRunContext | undefined, projectId: string) => {
    const workspace = await resolveWorkspace(context, projectId);
    if (!workspace) throw new Error("The selected project folder is unavailable.");
    return { workspace, project: projectIdentity(workspace) };
  };

  return {
    async get(context: ActionRunContext | undefined, projectId: string, requestedPath?: string): Promise<ProjectFilesResult> {
      const { workspace, project } = await resolve(context, projectId);
      try {
        let result: ProjectFilesResult;
        if (!requestedPath) result = { code: "listing", project, ...await listFiles(workspace.root) };
        else {
          const file = await readEditableFile(workspace.root, requestedPath, project);
          result = file ? { code: "file", project, file }
            : { code: "blocked", path: requestedPath, reason: await blockedReason(workspace.root, requestedPath) };
        }
        const finalScope = await resolve(context, projectId);
        if (!sameProject(project, finalScope.project)) throw new Error("The selected project changed while its files were being read.");
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw Object.assign(new Error("The requested project file was not found."), { statusCode: 404 });
        }
        throw error;
      }
    },

    async save(context: ActionRunContext | undefined, input: {
      projectId: string; path: string; expectedVersion: string; content: string;
      /** The binding the caller read from. A different binding is `project-changed`. */
      expectedProject?: ProjectFileIdentity;
    }): Promise<ProjectFileSaveResult> {
      const initial = await resolve(context, input.projectId);
      return serializeMutation(initial.project, async () => {
        const lockedScope = await resolve(context, input.projectId);
        if (!sameProject(initial.project, lockedScope.project)
          || (input.expectedProject && !sameProject(input.expectedProject, lockedScope.project))) {
          return { code: "conflict", operation: "save", reason: "project-changed", path: input.path };
        }
        const current = await readEditableFile(lockedScope.workspace.root, input.path, lockedScope.project);
        if (!current) return { code: "conflict", operation: "save", reason: "renamed-or-deleted", path: input.path };
        if (current.version !== input.expectedVersion) {
          return { code: "conflict", operation: "save", reason: "changed", path: input.path, current };
        }
        const target = await resolvePathWithoutLinks(lockedScope.workspace.root, input.path);
        const targetInfo = await lstat(target);
        const temporary = await writeTemporarySibling(target, input.content, targetInfo.mode);
        try {
          const finalScope = await resolve(context, input.projectId);
          if (!sameProject(lockedScope.project, finalScope.project)) {
            return { code: "conflict", operation: "save", reason: "project-changed", path: input.path };
          }
          const finalCurrent = await readEditableFile(finalScope.workspace.root, input.path, finalScope.project);
          if (!finalCurrent) return { code: "conflict", operation: "save", reason: "renamed-or-deleted", path: input.path };
          if (finalCurrent.version !== input.expectedVersion) {
            return { code: "conflict", operation: "save", reason: "changed", path: input.path, current: finalCurrent };
          }
          try {
            await withLockRetries(() => operations.rename(temporary, target), {
              read: () => readEditableFile(finalScope.workspace.root, input.path, finalScope.project),
              expected: finalCurrent });
          } catch (error) {
            if (!(error instanceof ProjectFileChangedWhileLocked)) throw error;
            return error.current
              ? { code: "conflict", operation: "save", reason: "changed", path: input.path, current: error.current }
              : { code: "conflict", operation: "save", reason: "renamed-or-deleted", path: input.path };
          }
          // The replaced file cannot be restored, so a redirected save is refused and reported.
          if (!await writtenInsideRoot(finalScope.workspace.root, input.path)) {
            throw new ProjectFileBoundaryError("blocked-path");
          }
          const saved = await readEditableFile(finalScope.workspace.root, input.path, finalScope.project);
          if (!saved) throw new Error("The saved project file could not be verified.");
          return { code: "saved", project: finalScope.project, file: saved };
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      });
    },

    async rename(context: ActionRunContext | undefined, input: {
      projectId: string; path: string; name: string; expectedVersion: string;
    }): Promise<ProjectFileRenameResult> {
      if (input.name === "." || input.name === ".." || input.name.includes("/") || input.name.includes("\\")
        || isSecretName(input.name) || SKIPPED_DIRECTORIES.has(input.name)) {
        throw new ProjectFileBoundaryError("invalid-path");
      }
      const initial = await resolve(context, input.projectId);
      return serializeMutation(initial.project, async () => {
        const lockedScope = await resolve(context, input.projectId);
        const targetPath = path.posix.join(path.posix.dirname(input.path), input.name);
        if (!sameProject(initial.project, lockedScope.project)) {
          return { code: "conflict", operation: "rename", reason: "project-changed", path: input.path, targetPath };
        }
        const current = await readEditableFile(lockedScope.workspace.root, input.path, lockedScope.project);
        if (!current) return { code: "conflict", operation: "rename", reason: "renamed-or-deleted", path: input.path, targetPath };
        if (current.version !== input.expectedVersion) {
          return { code: "conflict", operation: "rename", reason: "changed", path: input.path, targetPath, current };
        }
        if (!kindFor(input.name)) throw new ProjectFileBoundaryError("blocked-path");
        const source = await resolvePathWithoutLinks(lockedScope.workspace.root, input.path);
        const target = await resolvePathWithoutLinks(lockedScope.workspace.root, targetPath, true);
        const finalScope = await resolve(context, input.projectId);
        if (!sameProject(lockedScope.project, finalScope.project)) {
          return { code: "conflict", operation: "rename", reason: "project-changed", path: input.path, targetPath };
        }
        const finalCurrent = await readEditableFile(finalScope.workspace.root, input.path, finalScope.project);
        if (!finalCurrent) return { code: "conflict", operation: "rename", reason: "renamed-or-deleted", path: input.path, targetPath };
        if (finalCurrent.version !== input.expectedVersion) {
          return { code: "conflict", operation: "rename", reason: "changed", path: input.path, targetPath, current: finalCurrent };
        }
        let written: FileIdentity;
        let sourceIdentity: FileIdentity;
        try {
          sourceIdentity = identityOf(await lstat(source, { bigint: true }));
          const sourceInfo = await lstat(source);
          const sourceBytes = await readBoundedFile(source);
          if (sourceBytes.length > MAX_FILE_BYTES
            || versionFor(finalScope.project, input.path, sourceInfo, sourceBytes) !== input.expectedVersion) {
            return { code: "conflict", operation: "rename", reason: "changed", path: input.path, targetPath, current: finalCurrent };
          }
          written = await writeExclusiveBounded(target, sourceBytes, sourceInfo.mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { code: "conflict", operation: "rename", reason: "target-exists", path: input.path, targetPath };
          }
          throw error;
        }
        const copy = written;
        const checkedSource = sourceIdentity;
        const removeCopy = () => removeWrittenFile(finalScope.workspace.root, targetPath, copy, operations.unlink);
        let writtenScope: Awaited<ReturnType<typeof resolve>>;
        try {
          writtenScope = await resolve(context, input.projectId);
        } catch (error) {
          await removeCopy().catch(() => false);
          throw error;
        }
        if (!sameProject(finalScope.project, writtenScope.project)) {
          await withLockRetries(removeCopy);
          return { code: "conflict", operation: "rename", reason: "project-changed", path: input.path, targetPath };
        }
        if (!await writtenInsideRoot(finalScope.workspace.root, targetPath)) {
          await removeCopy().catch(() => false);
          throw new ProjectFileBoundaryError("blocked-path");
        }
        try {
          const copied = await readBoundedFile(target);
          const sourceInfo = await lstat(source);
          if (copied.length > MAX_FILE_BYTES
            || versionFor(finalScope.project, input.path, sourceInfo, copied) !== input.expectedVersion) {
            throw new Error("The renamed project file copy could not be verified.");
          }
          const latestScope = await resolve(context, input.projectId);
          if (!sameProject(finalScope.project, latestScope.project)) {
            await withLockRetries(removeCopy);
            return { code: "conflict", operation: "rename", reason: "project-changed", path: input.path, targetPath };
          }
          const latestCurrent = await readEditableFile(latestScope.workspace.root, input.path, latestScope.project);
          if (!latestCurrent || latestCurrent.version !== input.expectedVersion) {
            await withLockRetries(removeCopy);
            return latestCurrent
              ? { code: "conflict", operation: "rename", reason: "changed", path: input.path, targetPath, current: latestCurrent }
              : { code: "conflict", operation: "rename", reason: "renamed-or-deleted", path: input.path, targetPath };
          }
          const removal = await withLockRetries(
            () => removeIdentifiedFile(latestScope.workspace.root, input.path, checkedSource, operations.unlink), {
              read: () => readEditableFile(latestScope.workspace.root, input.path, latestScope.project),
              expected: latestCurrent });
          if (removal === "linked") throw new ProjectFileBoundaryError("blocked-path");
          if (removal === "changed") {
            const now = await readEditableFile(latestScope.workspace.root, input.path, latestScope.project)
              .catch(() => null);
            throw new ProjectFileChangedWhileLocked(now);
          }
        } catch (error) {
          await removeCopy().catch(() => false);
          if (error instanceof ProjectFileChangedWhileLocked) {
            return error.current
              ? { code: "conflict", operation: "rename", reason: "changed", path: input.path, targetPath, current: error.current }
              : { code: "conflict", operation: "rename", reason: "renamed-or-deleted", path: input.path, targetPath };
          }
          throw error;
        }
        const renamed = await readEditableFile(finalScope.workspace.root, targetPath, finalScope.project);
        if (!renamed) throw new Error("The renamed project file could not be verified.");
        return { code: "renamed", project: finalScope.project, previousPath: input.path, file: renamed };
      });
    },

    /**
     * Create one new editable file, making missing parent folders without
     * following links. Never replaces an existing file. The generic Files
     * view does not call this. Project memory does.
     */
    async create(context: ActionRunContext | undefined, input: {
      projectId: string; path: string; content: string;
      /** The binding the caller read from. A different binding is `project-changed`. */
      expectedProject?: ProjectFileIdentity;
    }): Promise<ProjectFileCreateResult> {
      if (!kindFor(input.path)) throw new ProjectFileBoundaryError("blocked-path");
      const initial = await resolve(context, input.projectId);
      return serializeMutation(initial.project, async () => {
        // Custody is checked inside the queue, before any folder is made.
        const lockedScope = await resolve(context, input.projectId);
        if (!sameProject(initial.project, lockedScope.project)
          || (input.expectedProject && !sameProject(input.expectedProject, lockedScope.project))) {
          return { code: "conflict", operation: "create", reason: "project-changed", path: input.path };
        }
        const root = lockedScope.workspace.root;
        const createdFolders = await createParentFolders(root, input.path);
        let written = false;
        let finalScope = lockedScope;
        try {
          const target = await resolvePathWithoutLinks(root, input.path, true);
          finalScope = await resolve(context, input.projectId);
          if (!sameProject(lockedScope.project, finalScope.project)) {
            return { code: "conflict", operation: "create", reason: "project-changed", path: input.path };
          }
          try {
            const file = await writeExclusiveBounded(target, Buffer.from(input.content, "utf8"), 0o644);
            let writtenScope: Awaited<ReturnType<typeof resolve>>;
            try {
              writtenScope = await resolve(context, input.projectId);
            } catch (error) {
              await removeWrittenFile(root, input.path, file).catch(() => false);
              throw error;
            }
            if (!sameProject(finalScope.project, writtenScope.project)) {
              await removeWrittenFile(root, input.path, file).catch(() => false);
              return { code: "conflict", operation: "create", reason: "project-changed", path: input.path };
            }
            if (!await writtenInsideRoot(root, input.path)) {
              // A parent folder became a link. Remove the file this call made
              // only when its path still reaches it without a link, and refuse.
              await removeWrittenFile(root, input.path, file).catch(() => false);
              throw new ProjectFileBoundaryError("blocked-path");
            }
            written = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const current = await readEditableFile(root, input.path, finalScope.project).catch(() => null);
            return { code: "conflict", operation: "create", reason: "target-exists", path: input.path,
              ...(current ? { current } : {}) };
          }
        } finally {
          if (!written) await removeCreatedFolders(createdFolders);
        }
        const created = await readEditableFile(root, input.path, finalScope.project);
        if (!created) throw new Error("The created project file could not be verified.");
        return { code: "created", project: finalScope.project, file: created };
      });
    },

    /** Delete one editable file whose version still matches. Never removes a folder. */
    async remove(context: ActionRunContext | undefined, input: {
      projectId: string; path: string; expectedVersion: string;
      /** The binding the caller read from. A different binding is `project-changed`. */
      expectedProject?: ProjectFileIdentity;
    }): Promise<ProjectFileRemoveResult> {
      const initial = await resolve(context, input.projectId);
      return serializeMutation(initial.project, async () => {
        const conflict = (reason: "changed" | "renamed-or-deleted" | "project-changed", current?: ProjectFile) =>
          ({ code: "conflict", operation: "remove", reason, path: input.path, ...(current ? { current } : {}) }) as const;
        const lockedScope = await resolve(context, input.projectId);
        if (!sameProject(initial.project, lockedScope.project)
          || (input.expectedProject && !sameProject(input.expectedProject, lockedScope.project))) {
          return conflict("project-changed");
        }
        const current = await readEditableFile(lockedScope.workspace.root, input.path, lockedScope.project);
        if (!current) return conflict("renamed-or-deleted");
        if (current.version !== input.expectedVersion) return conflict("changed", current);
        const finalScope = await resolve(context, input.projectId);
        if (!sameProject(lockedScope.project, finalScope.project)) return conflict("project-changed");
        const finalCurrent = await readEditableFile(finalScope.workspace.root, input.path, finalScope.project);
        if (!finalCurrent) return conflict("renamed-or-deleted");
        if (finalCurrent.version !== input.expectedVersion) return conflict("changed", finalCurrent);
        const target = await resolvePathWithoutLinks(finalScope.workspace.root, input.path);
        const checked = identityOf(await lstat(target, { bigint: true }));
        let removal: "removed" | "linked" | "changed";
        try {
          removal = await withLockRetries(
            () => removeIdentifiedFile(finalScope.workspace.root, input.path, checked, operations.unlink), {
              read: () => readEditableFile(finalScope.workspace.root, input.path, finalScope.project),
              expected: finalCurrent });
        } catch (error) {
          if (!(error instanceof ProjectFileChangedWhileLocked)) throw error;
          return error.current ? conflict("changed", error.current) : conflict("renamed-or-deleted");
        }
        // A path through a link or another file at the path: nothing was deleted.
        if (removal === "linked") throw new ProjectFileBoundaryError("blocked-path");
        if (removal === "changed") {
          const now = await readEditableFile(finalScope.workspace.root, input.path, finalScope.project).catch(() => null);
          return now ? conflict("changed", now) : conflict("renamed-or-deleted");
        }
        return { code: "removed", project: finalScope.project, path: input.path };
      });
    },
  };
}

export const projectFileService = createProjectFileService();
