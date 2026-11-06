import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import vm from "node:vm";

import type { ActionRunContext } from "@agent-native/core/action";

import type { ProjectFileIdentity } from "../app/lib/project-file-schema.ts";
import type {
  ProjectSearchFileMatch,
  ProjectSearchInput,
  ProjectSearchResult,
  ProjectSearchTextMatch,
  ProjectSearchTruncation,
} from "../app/lib/project-search-schema.ts";
import {
  MAX_FILE_BYTES,
  SKIPPED_DIRECTORIES,
  contained,
  decodeText,
  isSecretName,
  kindFor,
  projectIdentity,
  sameProject,
  type Resolver,
} from "./project-files.ts";
import { resolveLocalProjectWorkspace } from "./project-services.mjs";

// Bounded exact search over one authorized project. No index, no shell, no
// binary: the walk applies the same skip list, secret filter, and text
// sniffing as the project file surface, and every request stops at explicit
// caps so the panel can page with `continueAfter` instead of waiting.
export type ProjectSearchLimits = Readonly<{
  maxScannedEntries: number;
  maxReadFiles: number;
  maxMatches: number;
  maxFileMatches: number;
  maxLineLength: number;
  maxDepth: number;
  timeBudgetMs: number;
  excerptLength: number;
  // Per-file limit for user-supplied regular expressions, enforced with a
  // vm timeout because a pathological pattern can otherwise block the loop.
  regexTimeoutMs: number;
}>;

export const DEFAULT_PROJECT_SEARCH_LIMITS: ProjectSearchLimits = Object.freeze({
  maxScannedEntries: 50_000,
  maxReadFiles: 2_000,
  maxMatches: 200,
  maxFileMatches: 20,
  maxLineLength: 2_000,
  maxDepth: 16,
  timeBudgetMs: 1_500,
  excerptLength: 160,
  regexTimeoutMs: 200,
});

// A scanner returns, per line, the 0-based column of the first match or -1,
// or "timeout" when the pattern exceeded its per-file time limit. A null
// line is excluded from matching (it was longer than the line cap).
type Scanner = (lines: Array<string | null>) => number[] | "timeout";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Literal text is matched with a case-insensitive pattern over the original
// line, so the reported column stays an offset into that line (lowercasing
// can change a string's length).
function literalScanner(query: string): Scanner {
  const pattern = new RegExp(escapeRegExp(query), "iu");
  return lines => lines.map(line => (line === null ? -1 : pattern.exec(line)?.index ?? -1));
}

// User patterns run inside a vm context whose timeout interrupts even a
// catastrophic backtrack, one file at a time. Compiling outside the context
// first reports syntax errors without any scanning.
const REGEX_SCAN = new vm.Script(
  '(function () { const pattern = new RegExp(source, "u"); return lines.map(line => { if (line === null) return -1; const found = pattern.exec(line); return found ? found.index : -1; }); })()',
  { filename: "project-search-regex.vm" },
);

function regexScanner(query: string, timeoutMs: number): Scanner | string {
  try {
    new RegExp(query, "u");
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression";
  }
  const context = vm.createContext({ source: query, lines: [] as Array<string | null> });
  return lines => {
    context.lines = lines;
    try {
      return REGEX_SCAN.runInContext(context, { timeout: timeoutMs }) as number[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "timeout";
      throw error;
    } finally {
      context.lines = [];
    }
  };
}

// Read a file only if it is still the regular, singly linked file that was
// inspected a moment ago: open without following a link at the leaf and
// without blocking (a FIFO swapped in would otherwise wait for a writer),
// then compare the open handle's identity with the earlier stat. A path
// swapped for a link, a FIFO, or another file between the two steps yields
// null.
export async function readVerifiedFile(absolute: string, expected: Stats, maxBytes: number): Promise<Buffer | null> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(absolute, flags);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== expected.ino || opened.dev !== expected.dev) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function abortError(): Error {
  const error = new Error("The search was cancelled.");
  error.name = "AbortError";
  return error;
}

function excerptFor(line: string, column: number, length: number): string {
  if (line.length <= length) return line;
  const start = Math.max(0, Math.min(column - Math.floor(length / 4), line.length - length));
  const slice = line.slice(start, start + length);
  return (start > 0 ? "…" : "") + slice + (start + length < line.length ? "…" : "");
}

// Traversal is depth-first with every directory's entries in name order and
// each directory visited at its own sorted position, so a project path's
// place in the walk is its segment-wise comparison.
//
// The cursor names the last entry the previous page counted: a file, a
// directory it had entered but not finished (no trailing slash), or a
// directory it finished (trailing slash). Resuming skips files at or before
// the cursor, prunes finished directories, re-enters an unfinished one, and
// never counts the cursor's ancestors again, so every page makes progress.
type Cursor = Readonly<{ segments: string[]; done: boolean }>;

function parseCursor(after: string | undefined): Cursor | null {
  if (!after) return null;
  const done = after.endsWith("/");
  return { segments: (done ? after.slice(0, -1) : after).split("/"), done };
}

function formatCursor(cursor: Cursor): string {
  return cursor.segments.join("/") + (cursor.done ? "/" : "");
}

function compareSegments(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

function isPrefix(prefix: string[], segments: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segment === segments[index]);
}

function fileBeforeCursor(segments: string[], cursor: Cursor | null): boolean {
  if (cursor === null) return false;
  if (cursor.done && isPrefix(cursor.segments, segments)) return true;
  return compareSegments(segments, cursor.segments) <= 0;
}

function directoryBeforeCursor(segments: string[], cursor: Cursor | null): boolean {
  if (cursor === null) return false;
  if (isPrefix(segments, cursor.segments)) return cursor.done && segments.length === cursor.segments.length;
  return compareSegments(segments, cursor.segments) < 0;
}

// Ancestors of the cursor (and the cursor directory itself) were counted by
// the page that produced it.
function countedBefore(segments: string[], cursor: Cursor | null): boolean {
  return cursor !== null && isPrefix(segments, cursor.segments);
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

export function createProjectSearchService(
  resolveWorkspace: Resolver = resolveLocalProjectWorkspace,
  limits: Partial<ProjectSearchLimits> = {},
) {
  const bounds: ProjectSearchLimits = { ...DEFAULT_PROJECT_SEARCH_LIMITS, ...limits };

  const resolve = async (context: ActionRunContext | undefined, projectId: string) => {
    const workspace = await resolveWorkspace(context, projectId);
    if (!workspace) throw new Error("The selected project folder is unavailable.");
    return { workspace, project: projectIdentity(workspace) };
  };

  async function walk(root: string, input: ProjectSearchInput, project: ProjectFileIdentity, scanner: Scanner | null, signal?: AbortSignal) {
    const started = performance.now();
    const after = parseCursor(input.after);
    const files: ProjectSearchFileMatch[] = [];
    const matches: ProjectSearchTextMatch[] = [];
    let scannedEntries = 0;
    let readFiles = 0;
    let regexTimeouts = 0;
    let truncated: ProjectSearchTruncation | null = null;
    // The last entry this page counted; the next page resumes after it. A
    // limit never advances it past the entry that tripped the limit.
    let lastCounted: Cursor | null = null;

    const stop = (reason: ProjectSearchTruncation) => { truncated = reason; };
    // Cancellation and the time budget are honored between filesystem
    // operations; a single pending read or listing finishes first.
    const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
    // The budget applies once one entry has been counted, so a page always
    // makes progress.
    const outOfTime = () => lastCounted !== null && performance.now() - started >= bounds.timeBudgetMs;
    const countEntry = (segments: string[]): boolean => {
      if (scannedEntries >= bounds.maxScannedEntries) { stop("entries"); return false; }
      scannedEntries += 1;
      lastCounted = { segments, done: false };
      return true;
    };

    // Returns false when the file was not handled on this page (a limit
    // tripped first) so the caller leaves the cursor before it.
    async function scanFile(absolute: string, relative: string): Promise<boolean> {
      if (!kindFor(absolute)) return true;
      let info;
      try { info = await lstat(absolute); } catch { return true; }
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) return true;
      if (readFiles >= bounds.maxReadFiles) { stop("files"); return false; }
      readFiles += 1;
      const bytes = await readVerifiedFile(absolute, info, MAX_FILE_BYTES);
      throwIfAborted();
      if (bytes === null) return true;
      const content = bytes.length > MAX_FILE_BYTES ? null : decodeText(bytes);
      if (content === null || !scanner) return true;
      const lines = content.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
      // A final newline ends the last line; it does not start an empty one.
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const columns = scanner(lines.map(line => (line.length > bounds.maxLineLength ? null : line)));
      if (columns === "timeout") { regexTimeouts += 1; return true; }
      const found: ProjectSearchTextMatch[] = [];
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        if (column < 0) continue;
        if (found.length === bounds.maxFileMatches) { found[found.length - 1].more = true; break; }
        found.push({ path: relative, line: index + 1, column: column + 1,
          excerpt: excerptFor(lines[index], column, bounds.excerptLength) });
      }
      const room = bounds.maxMatches - matches.length;
      if (found.length > room) {
        // Keep the page cap exact. A file that would overflow it is left for
        // the next page, unless it is the page's only file with results, in
        // which case its first `room` matches are returned and flagged.
        if (matches.length === 0) {
          const kept = found.slice(0, room);
          kept[kept.length - 1].more = true;
          matches.push(...kept);
          return true;
        }
        stop("matches");
        return false;
      }
      matches.push(...found);
      if (matches.length >= bounds.maxMatches) stop("matches");
      return true;
    }

    async function visit(directory: string, segments: string[]): Promise<void> {
      throwIfAborted();
      // The canonical directory was contained when it was queued; make sure
      // the path still names a real directory before listing it.
      try {
        if (!(await lstat(directory)).isDirectory()) return;
      } catch {
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (segments.length === 0) throw error;
        return;
      }
      throwIfAborted();
      entries.sort(byName);
      if (outOfTime()) { stop("time"); return; }
      for (const entry of entries) {
        if (truncated !== null) return;
        if (entry.isSymbolicLink() || isSecretName(entry.name)) continue;
        const childSegments = [...segments, entry.name];
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (segments.length >= bounds.maxDepth || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (directoryBeforeCursor(childSegments, after)) continue;
          if (!countedBefore(childSegments, after) && !countEntry(childSegments)) return;
          let canonical: string;
          try { canonical = await realpath(absolute); } catch { continue; }
          if (!contained(root, canonical)) continue;
          await visit(canonical, childSegments);
          if (truncated !== null) return;
          // The whole subtree is done: the next page prunes it.
          lastCounted = { segments: childSegments, done: true };
          if (outOfTime()) { stop("time"); return; }
          continue;
        }
        if (!entry.isFile() || fileBeforeCursor(childSegments, after)) continue;
        const before = lastCounted;
        if (!countEntry(childSegments)) return;
        const relative = childSegments.join("/");
        if (input.mode === "filename") {
          // Names need no stat: the directory entry already says this is a
          // regular file, and nothing is read.
          if (relative.toLowerCase().includes(input.query.toLowerCase())) {
            files.push({ path: relative, name: entry.name });
          }
          if (files.length >= bounds.maxMatches) { stop("matches"); return; }
        } else if (!(await scanFile(absolute, relative))) {
          // A limit tripped before this file was handled: resume at it.
          lastCounted = before;
          scannedEntries -= 1;
          return;
        }
        if (truncated !== null) return;
        throwIfAborted();
        if (outOfTime()) { stop("time"); return; }
      }
    }

    await visit(root, []);

    const result: ProjectSearchResult = {
      code: "results",
      project,
      query: input.query,
      mode: input.mode,
      files,
      matches,
      scannedEntries,
      readFiles,
      regexTimeouts,
      truncated,
      continueAfter: truncated === null || lastCounted === null ? null : formatCursor(lastCounted),
      elapsedMs: Math.round(performance.now() - started),
    };
    return result;
  }

  return {
    limits: bounds,

    async search(context: ActionRunContext | undefined, input: ProjectSearchInput, signal?: AbortSignal): Promise<ProjectSearchResult> {
      if (signal?.aborted) throw abortError();
      const { workspace, project } = await resolve(context, input.projectId);
      let scanner: Scanner | null = null;
      if (input.mode === "text") scanner = literalScanner(input.query);
      else if (input.mode === "regex") {
        const built = regexScanner(input.query, bounds.regexTimeoutMs);
        if (typeof built === "string") {
          return { code: "invalid-pattern", project, query: input.query, mode: "regex", reason: built };
        }
        scanner = built;
      }
      const result = await walk(workspace.root, input, project, scanner, signal);
      const finalScope = await resolve(context, input.projectId);
      if (signal?.aborted) throw abortError();
      if (!sameProject(project, finalScope.project)) {
        throw new Error("The selected project changed while it was being searched.");
      }
      return result;
    },
  };
}

export const projectSearchService = createProjectSearchService();
