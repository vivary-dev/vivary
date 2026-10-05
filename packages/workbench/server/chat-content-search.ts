import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { opendir, open } from "node:fs/promises";
import path from "node:path";
import { fail } from "@agent-native/core/action";
import { getDbExec, isPostgres } from "@agent-native/core/db";
import { listThreads } from "@agent-native/core/server";
import { codeAgentRunsDir, type CodeAgentRunRecord } from "@agent-native/core/code-agents";
import type { VivaryChatIdentity } from "../app/lib/chat-scope";
import type { ChatSearchHit, ChatSearchInput, ChatSearchPage } from "../app/lib/chat-search-schema";
import { isOwnedRun, type VivaryCodeReadScope } from "./local-code-agent";
import { readCodeTranscriptPage, TRANSCRIPT_PAGE_BYTES } from "./code-transcript-page";
import { createVivaryChatIdentity } from "./chat-identity";

const LIMITS = { sessions: 25, messages: 500, bytes: 16 * 1024 * 1024, results: 25 };
const MAX_RUN_NAMES = 10_000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_REPOSITORY_BYTES = 8 * 1024 * 1024;
// Opaque process-local cursors keep authorized scan positions private.
const CURSOR_KEY = randomBytes(32);
function encodeCursor(value: unknown): string {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", CURSOR_KEY, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
}
function decodeCursor(cursor: string): unknown {
  const bytes = Buffer.from(cursor, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", CURSOR_KEY, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}
type SearchOwner = { ownerEmail: string; orgId: string; identity: VivaryChatIdentity; codeScope?: VivaryCodeReadScope };
type Position = { phase: "native" | "code"; session: string; time: number; snapshot: number; searched: number;
  active: boolean; message: number; offset: number; discardLine: boolean; titleDone: boolean };
const positionSchema = (value: unknown): value is Position => {
  if (!value || typeof value !== "object") return false;
  const p = value as Position;
  return (p.phase === "native" || p.phase === "code") && typeof p.session === "string" && p.session.length <= 240
    && [p.time, p.snapshot, p.searched, p.message, p.offset].every(n => Number.isSafeInteger(n) && n >= 0)
    && [p.active, p.discardLine, p.titleDone].every(v => typeof v === "boolean");
};
const initialPosition = (): Position => {
  const snapshot = Date.now();
  return { phase: "native", session: "", time: snapshot, snapshot, searched: 0,
    active: false, message: 0, offset: 0, discardLine: false, titleDone: false };
};
function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 70);
  const slice = text.slice(start, start + 234).replace(/\s+/g, " ");
  return `${start ? "…" : ""}${slice}${start + 234 < text.length ? "…" : ""}`;
}
function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap(part => {
    if (typeof part?.text === "string") return [part.text];
    if (part?.type === "tool-call") return [JSON.stringify(part.args ?? {}), JSON.stringify(part.result ?? "")];
    return [];
  }).join("\n");
}

/** Select an authorized row before reading content; scan only authoritative Native/Code stores. */
export async function searchChatContent(owner: SearchOwner, input: ChatSearchInput, signal?: AbortSignal): Promise<ChatSearchPage> {
  signal?.throwIfAborted();
  const fingerprint = createHash("sha256").update(JSON.stringify([owner.ownerEmail.toLowerCase(), owner.orgId,
    owner.identity.scope, owner.codeScope, input.projectId, input.unassigned, input.includeArchived, input.query])).digest("hex");
  let cursor = initialPosition();
  if (input.after) {
    try {
      const decoded = decodeCursor(input.after) as { key?: unknown; position?: unknown };
      if (decoded.key !== fingerprint || !positionSchema(decoded.position)) throw new Error();
      cursor = decoded.position;
    } catch { fail("Search changed. Start the search again.", { statusCode: 400 }); }
  }
  const page: ChatSearchPage = { results: [], continueAfter: null, scannedSessions: 0, scannedMessages: 0,
    searchedSessions: cursor.searched, readBytes: 0, limited: false, limits: LIMITS,
    codeUnavailable: !input.unassigned && !owner.codeScope };
  const projectLabel = input.unassigned ? "Unassigned" : owner.codeScope?.label ?? owner.identity.scope.label ?? "Personal workspace";
  const expected = createVivaryChatIdentity(owner.ownerEmail, owner.orgId, input.unassigned ? { kind: "unassigned" }
    : { kind: "project", projectId: input.projectId, label: projectLabel });
  if (expected.scope.id !== owner.identity.scope.id || expected.scope.type !== owner.identity.scope.type) return page;
  const query = input.query.toLowerCase();
  let budgetBytes = 0;
  const canProcessMessages = () => page.scannedMessages < LIMITS.messages && page.results.length < LIMITS.results;
  const canRead = () => canProcessMessages() && budgetBytes + TRANSCRIPT_PAGE_BYTES <= LIMITS.bytes;
  const canStartSession = () => page.scannedSessions < LIMITS.sessions && canRead();
  const beginSession = (id: string, time: number) => {
    page.scannedSessions++;
    if (!cursor.active || cursor.session !== id) {
      cursor = { ...cursor, session: id, time, active: true, message: 0, offset: 0, discardLine: false, titleDone: false };
      cursor.searched++;
    }
  };
  const finishSession = () => { cursor.active = false; cursor.message = 0; cursor.offset = 0; cursor.titleDone = false; cursor.discardLine = false; };
  const hit = (sessionId: string, title: string, referenceId: string, text: string, runtime: ChatSearchHit["runtime"],
    archived: boolean, match: ChatSearchHit["match"], updatedAt: number, matchedAt?: unknown, eventOffset?: number) => page.results.push({
      projectId: input.unassigned ? null : owner.identity.projectId, projectLabel, sessionId,
      title: title || "Untitled conversation", referenceId, excerpt: excerpt(text, input.query), runtime, archived, match,
      sessionUpdatedAt: updatedAt, matchedAt: typeof matchedAt === "string" ? matchedAt : undefined,
      ...(eventOffset === undefined ? {} : { eventOffset }),
    });
  const db = getDbExec();
  const where = `LOWER(owner_email) = ? AND (org_id = ? OR org_id IS NULL)
    AND scope_type = ? AND scope_id = ? AND source_platform IS NULL
    ${input.includeArchived ? "" : "AND archived_at IS NULL"}`;
  const args = [owner.ownerEmail.toLowerCase(), owner.orgId, owner.identity.scope.type, owner.identity.scope.id];
  await listThreads(owner.ownerEmail, { scope: owner.identity.scope, orgId: owner.orgId, includeExternal: false, limit: 1 });
  const count = await db.execute({ sql: `SELECT COUNT(*) AS count FROM chat_threads WHERE ${where} AND message_count > 0 AND updated_at <= ?`,
    args: [...args, cursor.snapshot] });
  const nativeTotal = Number(count.rows[0]?.count ?? 0);
  // Flag existing conversations that changed outside this search's admission window.
  // The active session still finishes below; this probe reads no transcript content.
  const changed = await db.execute({ sql: `SELECT 1 FROM chat_threads WHERE ${where} AND message_count > 0
    AND created_at <= ? AND updated_at > ? AND id <> ? LIMIT 1`,
    args: [...args, cursor.snapshot, cursor.snapshot, cursor.phase === "native" && cursor.active ? cursor.session : ""] });
  page.limited ||= changed.rows.length > 0;
  if (input.unassigned || !owner.codeScope) page.totalSessions = nativeTotal;
  if (cursor.phase === "native") {
    while (canStartSession()) {
      signal?.throwIfAborted();
      const selection = cursor.active ? "AND id = ?" : "AND updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND id > ?))";
      const headers = await db.execute({ sql: `SELECT id, title, archived_at, updated_at,
        ${isPostgres() ? "octet_length(thread_data)" : "length(CAST(thread_data AS BLOB))"} AS repository_size
        FROM chat_threads WHERE ${where} AND message_count > 0 ${selection}
        ORDER BY updated_at DESC, id LIMIT 1`,
        args: [...args, ...(cursor.active ? [cursor.session] : [cursor.snapshot, cursor.time, cursor.time, cursor.session])] });
      const header = headers.rows[0];
      if (!header) {
        if (cursor.active) { finishSession(); continue; }
        cursor = { ...cursor, phase: "code", session: "", time: cursor.snapshot }; break;
      }
      const size = Number(header.repository_size);
      if (size <= MAX_REPOSITORY_BYTES && budgetBytes + size > LIMITS.bytes) break;
      beginSession(String(header.id), Number(header.updated_at));
      if (size > MAX_REPOSITORY_BYTES) { page.limited = true; finishSession(); continue; }
      // Read/parse the capped repository ONCE per session page. The content read repeats authorization;
      // no SQLite JSON traversal (or PostgreSQL JSON cast) can inspect another owner's blob.
      const rows = await db.execute({ sql: `SELECT thread_data FROM chat_threads WHERE ${where} AND id = ?
        AND ${isPostgres() ? "octet_length(thread_data)" : "length(CAST(thread_data AS BLOB))"} <= ?`,
        args: [...args, cursor.session, Math.min(MAX_REPOSITORY_BYTES, LIMITS.bytes - budgetBytes)] });
      if (!rows.rows[0]) { page.limited = true; finishSession(); continue; }
      const data = String(rows.rows[0].thread_data);
      const bytes = Buffer.byteLength(data); budgetBytes += bytes; page.readBytes += bytes;
      if (bytes > MAX_REPOSITORY_BYTES) { page.limited = true; finishSession(); continue; }
      let entries: Array<{ message?: { id?: string; content?: unknown; createdAt?: unknown } }>;
      try {
        const repository = JSON.parse(data);
        if (!Array.isArray(repository.messages)) throw new Error("Malformed repository");
        entries = repository.messages;
      } catch { page.limited = true; finishSession(); continue; }
      while (cursor.message < entries.length && canProcessMessages()) {
        signal?.throwIfAborted();
        const message = entries[cursor.message++]?.message; page.scannedMessages++;
        if (!message || typeof message.id !== "string") continue;
        const text = messageText(message);
        if (text.length > MAX_MESSAGE_CHARS) { page.limited = true; continue; }
        const contentMatch = text.toLowerCase().includes(query);
        const titleMatch = !cursor.titleDone && String(header.title ?? "").toLowerCase().includes(query);
        if (contentMatch || titleMatch) hit(cursor.session, String(header.title ?? ""), message.id, contentMatch ? text : String(header.title),
          "native", header.archived_at != null, contentMatch ? "content" : "title", cursor.time, message.createdAt);
        cursor.titleDone = true;
      }
      if (cursor.message < entries.length) break;
      finishSession();
    }
  }
  if (cursor.phase === "code" && (input.unassigned || !owner.codeScope)) { page.searchedSessions = cursor.searched; return page; }
  // Defer Code until its full metadata window and one transcript page fit the remaining budget.
  if (cursor.phase === "code" && canStartSession()
    && budgetBytes + MAX_METADATA_BYTES + TRANSCRIPT_PAGE_BYTES <= LIMITS.bytes) {
    const names: string[] = [];
    let directory;
    try { directory = await opendir(codeAgentRunsDir()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (directory) {
      let visited = 0;
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++visited > MAX_RUN_NAMES) { page.limited = true; break; }
        if (entry.isFile() && /^[A-Za-z0-9_.:-]+\.json$/.test(entry.name)) names.push(entry.name);
      }
    }
    // Metadata establishes membership before the session cap, transcript reads, counts, or excerpts.
    // Its own byte cap also bounds stores containing many unrelated projects.
    const owned: Array<{ record: CodeAgentRunRecord; time: number; bytes: number }> = [];
    let metadataBytes = 0;
    // Native's generated run IDs contain creation timestamps. Admit recent
    // metadata first when this bounded scan cannot cover the entire directory;
    // authorized candidates still use updated-time/ID ordering below.
    for (const name of names.sort().reverse()) {
      signal?.throwIfAborted();
      // Post-snapshot runs must not spend metadata budget or displace a partly-read session.
      const timestamp = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-[^.]+\.json$/.exec(name);
      const createdAt = timestamp
        ? Date.parse(`${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}:${timestamp[6]}Z`) : NaN;
      if (createdAt > cursor.snapshot) continue;
      if (metadataBytes + MAX_RECORD_BYTES + 1 > MAX_METADATA_BYTES) {
        page.limited = true; break;
      }
      let handle;
      try {
        handle = await open(path.join(codeAgentRunsDir(), name), "r");
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        metadataBytes += bytesRead; budgetBytes += bytesRead;
        if (bytesRead > MAX_RECORD_BYTES) { page.limited = true; continue; }
        const record: CodeAgentRunRecord = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        if (!record || typeof record !== "object" || record.id + ".json" !== name || typeof record.title !== "string"
          || !isOwnedRun(record, owner.ownerEmail, owner.orgId, owner.codeScope!)) continue;
        const time = Date.parse(record.updatedAt);
        if (!Number.isFinite(time)) continue;
        if (time <= cursor.snapshot || (cursor.active && record.id === cursor.session)) owned.push({ record, time, bytes: bytesRead });
        else page.limited = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        // A malformed metadata file cannot establish ownership; it contributes no public counts.
      } finally { await handle?.close(); }
    }
    owned.sort((a, b) => b.time - a.time || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
    page.totalSessions = nativeTotal + owned.length;
    const active = cursor.active ? owned.find(({ record }) => record.id === cursor.session) : undefined;
    const candidates = [...(active ? [active] : []), ...owned.filter(({ record, time }) => record.id !== active?.record.id
      && (time < cursor.time || time === cursor.time && record.id > cursor.session))];
    let completed = true;
    for (const { record, time, bytes } of candidates) {
      signal?.throwIfAborted();
      if (!canStartSession()) { completed = false; break; }
      const wasActive = cursor.active && cursor.session === record.id;
      beginSession(record.id, wasActive ? cursor.time : time); page.readBytes += bytes;
      let done = false;
      while (canRead()) {
        const transcript = await readCodeTranscriptPage(record.id, cursor.offset, LIMITS.messages - page.scannedMessages, cursor.discardLine);
        page.readBytes += transcript.readBytes; budgetBytes += transcript.readBytes; page.limited ||= transcript.limited;
        for (const entry of transcript.entries) {
          if (page.results.length >= LIMITS.results) break;
          page.scannedMessages++;
          const contentMatch = entry.event.message.toLowerCase().includes(query);
          const titleMatch = !cursor.titleDone && record.title.toLowerCase().includes(query);
          if (contentMatch || titleMatch) hit(record.id, record.title, entry.event.id, contentMatch ? entry.event.message : record.title,
            "code", false, contentMatch ? "content" : "title", cursor.time, entry.event.createdAt, entry.offset);
          cursor.offset = entry.nextOffset; cursor.discardLine = false; cursor.titleDone = true;
        }
        if (page.results.length >= LIMITS.results) break;
        cursor.offset = transcript.nextOffset; cursor.discardLine = transcript.discardLine;
        if (transcript.done) { done = true; break; }
      }
      if (!done) { completed = false; break; }
      finishSession();
    }
    if (completed) { page.searchedSessions = cursor.searched; return page; }
  }
  page.searchedSessions = cursor.searched;
  page.continueAfter = encodeCursor({ key: fingerprint, position: cursor });
  return page;
}
