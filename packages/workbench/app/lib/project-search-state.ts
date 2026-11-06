import type { ProjectFileIdentity } from "./project-file-schema.ts";
import type {
  ProjectSearchFileMatch,
  ProjectSearchMode,
  ProjectSearchResult,
  ProjectSearchTextMatch,
  ProjectSearchTruncation,
} from "./project-search-schema.ts";

// Pure state for the search panel: which request is current, and how pages
// accumulate. A response counts only when it echoes the request the panel
// is showing; anything else is stale and ignored.
export type SearchRequest = Readonly<{ projectId: string; query: string; mode: ProjectSearchMode }>;

export type SearchPages = Readonly<{
  request: SearchRequest;
  // The exact binding the pages came from; a rebound project never continues them.
  identity: ProjectFileIdentity;
  files: ProjectSearchFileMatch[];
  matches: ProjectSearchTextMatch[];
  truncated: ProjectSearchTruncation | null;
  continueAfter: string | null;
  scannedEntries: number;
  readFiles: number;
  regexTimeouts: number;
  elapsedMs: number;
  invalidPattern: string | null;
}>;

export const MIN_QUERY_LENGTH = 2;

export function committedQuery(input: string): string {
  const trimmed = input.trim();
  return trimmed.length >= MIN_QUERY_LENGTH ? trimmed.slice(0, 200) : "";
}

export function sameIdentity(left: ProjectFileIdentity, right: ProjectFileIdentity): boolean {
  return left.projectId === right.projectId && left.rootId === right.rootId && left.bindingId === right.bindingId
    && left.bindingRevision === right.bindingRevision && left.policyRevision === right.policyRevision;
}

export function sameRequest(left: SearchRequest, right: SearchRequest): boolean {
  return left.projectId === right.projectId && left.query === right.query && left.mode === right.mode;
}

export function isCurrentSearch(result: ProjectSearchResult | undefined, request: SearchRequest): result is ProjectSearchResult {
  if (!result) return false;
  return result.project.projectId === request.projectId && result.query === request.query && result.mode === request.mode;
}

// Fold a page into the accumulated state. The first page (no `after`)
// replaces everything; a continuation appends only when it continues the
// cursor the previous page returned from the same project binding. A
// continuation from a different binding clears the pages so the panel
// starts a fresh search; anything else is ignored.
export function reduceSearchPages(
  previous: SearchPages | null,
  result: ProjectSearchResult,
  request: SearchRequest,
  after: string | undefined,
): SearchPages | null {
  if (!isCurrentSearch(result, request)) return previous;
  if (result.code === "invalid-pattern") {
    return { request, identity: result.project, files: [], matches: [], truncated: null, continueAfter: null,
      scannedEntries: 0, readFiles: 0, regexTimeouts: 0, elapsedMs: 0, invalidPattern: result.reason };
  }
  const fresh: SearchPages = { request, identity: result.project, files: result.files, matches: result.matches, truncated: result.truncated,
    continueAfter: result.continueAfter, scannedEntries: result.scannedEntries, readFiles: result.readFiles,
    regexTimeouts: result.regexTimeouts, elapsedMs: result.elapsedMs, invalidPattern: null };
  if (!after) return fresh;
  if (!previous || !sameRequest(previous.request, request) || previous.continueAfter !== after) return previous;
  if (!sameIdentity(previous.identity, result.project)) return null;
  return {
    ...fresh,
    files: [...previous.files, ...result.files],
    matches: [...previous.matches, ...result.matches],
    scannedEntries: previous.scannedEntries + result.scannedEntries,
    readFiles: previous.readFiles + result.readFiles,
    regexTimeouts: previous.regexTimeouts + result.regexTimeouts,
    elapsedMs: previous.elapsedMs + result.elapsedMs,
  };
}

// True when some of the project was not searched: a limit stopped the page
// or a slow pattern skipped files.
export function incompleteCoverage(pages: SearchPages): boolean {
  return pages.truncated !== null || pages.regexTimeouts > 0;
}

export function summarize(pages: SearchPages): string {
  if (pages.invalidPattern) return "";
  const hits = pages.request.mode === "filename" ? pages.files.length : pages.matches.length;
  const noun = pages.request.mode === "filename" ? "file" : "match";
  const fileCount = pages.request.mode === "filename" ? pages.files.length : new Set(pages.matches.map(match => match.path)).size;
  const where = pages.request.mode === "filename" ? "" : ` in ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const base = `${hits} ${hits === 1 ? noun : noun + (noun === "match" ? "es" : "s")}${where} · ${pages.scannedEntries} entries in ${pages.elapsedMs} ms`;
  const skipped = pages.regexTimeouts > 0
    ? ` · ${pages.regexTimeouts} ${pages.regexTimeouts === 1 ? "file" : "files"} skipped: pattern too slow` : "";
  if (!pages.truncated) return base + skipped;
  const reason = { entries: "the entry limit", files: "the file limit", matches: "the match limit", time: "the time budget" }[pages.truncated];
  return `${base} · stopped at ${reason}${skipped}`;
}
