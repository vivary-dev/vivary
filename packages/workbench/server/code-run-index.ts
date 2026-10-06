import fs from "node:fs";
import path from "node:path";
import {
  codeAgentRunsDir,
  codeAgentRunTranscriptPath,
  getCodeAgentRunRecord,
  listCodeAgentTranscriptEvents,
  type CodeAgentRunRecord,
  type CodeAgentTranscriptEvent,
} from "@agent-native/core/code-agents";

// Charge parsed contents conservatively, including per-entry/event overhead.
// These are retention budgets, not an exact measurement of V8's heap layout.
const RUN_LIMITS = { entries: 4096, bytes: 16 * 1024 * 1024 };
const TRANSCRIPT_LIMITS = { entries: 64, bytes: 64 * 1024 * 1024 };
const MAX_LEGACY_DRAFT_ID_CHARS = 512;
type Identity = { token: string; bytes: number };
type Entry<T> = { identity: string; value: T; bytes: number };

function identity(file: string): Identity | null {
  try {
    const info = fs.statSync(file, { bigint: true });
    return { token: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      bytes: Number(info.size) };
  } catch { return null; }
}

class FileContentCache<T> {
  readonly entries = new Map<string, Entry<T>>();
  bytes = 0;

  constructor(readonly limits: { entries: number; bytes: number }) {}

  remove(file: string): void {
    const entry = this.entries.get(file);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(file); }
  }

  read(file: string, reader: () => T, overhead = (_value: T) => 0): T {
    const before = identity(file);
    const cached = this.entries.get(file);
    if (before && cached?.identity === before.token) {
      // LRU affects only retention; even a hit checks the file on every call.
      this.entries.delete(file);
      this.entries.set(file, cached);
      return cached.value;
    }
    this.remove(file);
    const value = reader(); // Core owns parsing, normalization and validation.
    const after = identity(file);
    // A writer can replace/append while Core reads. Never tag that result with
    // the new identity: the next call must re-read it. Do not retain failed reads.
    if (value !== null && before && after?.token === before.token) {
      const bytes = before.bytes * 8 + 512 + overhead(value);
      if (bytes <= this.limits.bytes) {
        while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(file, { identity: before.token, value, bytes });
        this.bytes += bytes;
      }
    }
    return value;
  }
}

type StoreCache = { root: string; runs: FileContentCache<CodeAgentRunRecord | null>;
  transcripts: FileContentCache<CodeAgentTranscriptEvent[]>;
  legacyDraftIds: Map<string, { identity: string | null; draftThreadId: string | null }> };
// Nitro and dynamically loaded Native actions share one process-level cache.
// A store change releases all entries; no private contents cross store roots.
const key = Symbol.for("vivary.workbench.code-run-index");
const processState = globalThis as typeof globalThis & { [key]?: StoreCache };

/** Release private contents after sign-out, including references held by a reader. */
export function clearCodeRunIndex(): void {
  const cache = processState[key];
  if (!cache) return;
  cache.runs.entries.clear(); cache.runs.bytes = 0;
  cache.transcripts.entries.clear(); cache.transcripts.bytes = 0;
  cache.legacyDraftIds.clear();
  delete processState[key];
}

function storeCache(): StoreCache {
  const root = codeAgentRunsDir();
  if (processState[key]?.root !== root) processState[key] = { root,
    runs: new FileContentCache(RUN_LIMITS), transcripts: new FileContentCache(TRANSCRIPT_LIMITS),
    legacyDraftIds: new Map() };
  return processState[key]!;
}

/** Fresh directory membership and file identities; callers still apply scope admission. */
export function listIndexedCodeRuns(goalId?: string): CodeAgentRunRecord[] {
  const cache = storeCache();
  if (!fs.existsSync(cache.root)) {
    cache.runs.entries.clear(); cache.runs.bytes = 0;
    cache.transcripts.entries.clear(); cache.transcripts.bytes = 0;
    cache.legacyDraftIds.clear();
    return [];
  }
  // Readdir on every listing avoids a directory timestamp becoming a membership TTL.
  const names = fs.readdirSync(cache.root).filter(name => name.endsWith(".json"));
  const present = new Set(names.map(name => path.join(cache.root, name)));
  for (const file of cache.runs.entries.keys()) if (!present.has(file)) cache.runs.remove(file);
  const runs: CodeAgentRunRecord[] = [];
  const presentRunIds = new Set<string>();
  for (const name of names) {
    const run = cache.runs.read(path.join(cache.root, name), () => getCodeAgentRunRecord(name.slice(0, -5)));
    if (run) presentRunIds.add(run.id);
    if (run && (!goalId || run.goalId === goalId)) runs.push(run);
  }
  for (const runId of cache.legacyDraftIds.keys()) if (!presentRunIds.has(runId)) cache.legacyDraftIds.delete(runId);
  // Match Core's stable ordering, including ties and filenames differing from record IDs.
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Call only after owner/org/project admission, as with Core's transcript reader. */
export function listIndexedCodeTranscript(runId: string): CodeAgentTranscriptEvent[] {
  return storeCache().transcripts.read(codeAgentRunTranscriptPath(runId),
    () => listCodeAgentTranscriptEvents(runId), events => events.length * 256);
}

/** After scope admission, retain only the legacy link, even when its full transcript is evicted. */
export function getIndexedLegacyCodeDraftId(runId: string): string | null {
  const cache = storeCache(), file = codeAgentRunTranscriptPath(runId);
  const before = identity(file)?.token ?? null;
  const cached = cache.legacyDraftIds.get(runId);
  if (cached && cached.identity === before) return cached.draftThreadId;
  cache.legacyDraftIds.delete(runId);
  const first = listIndexedCodeTranscript(runId).find(event =>
    event.kind === "user" && typeof event.metadata?.draftThreadId === "string");
  const draftThreadId = typeof first?.metadata?.draftThreadId === "string" ? first.metadata.draftThreadId : null;
  // Retain at most 4096 small links, evicting in insertion order. Listings prune
  // deletions; oversized IDs keep the same response but are not retained.
  if (before === (identity(file)?.token ?? null) && runId.length <= MAX_LEGACY_DRAFT_ID_CHARS
    && (draftThreadId === null || draftThreadId.length <= MAX_LEGACY_DRAFT_ID_CHARS)) {
    if (cache.legacyDraftIds.size >= RUN_LIMITS.entries) {
      cache.legacyDraftIds.delete(cache.legacyDraftIds.keys().next().value!);
    }
    cache.legacyDraftIds.set(runId, { identity: before, draftThreadId });
  }
  return draftThreadId;
}
