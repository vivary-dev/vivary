import { createHash, randomUUID } from "node:crypto";
import { compareAndSetAppState, listAppState, readAppState } from "@agent-native/core/application-state";
import { getThread } from "@agent-native/core/server";
import { fail } from "@agent-native/core/action";
import { z } from "zod";
import { hasOwnedVivaryCodeSubmit, type VivaryCodeReadScope } from "./local-code-agent";
import type { VivaryChatIdentity } from "../app/lib/chat-scope";
import { threadBelongsToChatIdentity } from "./chat-identity";

const revision = z.string().uuid();
export const chatDraftRecordSchema = z.discriminatedUnion("status", [
  z.object({ revision, text: z.string().max(32_000), status: z.literal("draft"), submitId: z.null() }).strict(),
  z.object({ revision, text: z.string().max(32_000), status: z.literal("pending"), submitId: z.string().uuid() }).strict(),
  z.object({ revision, text: z.literal(""), status: z.literal("cleared"), submitId: z.null() }).strict(),
]);
export const chatDraftNextSchema = z.discriminatedUnion("status", [
  z.object({ text: z.string().max(32_000), status: z.literal("draft"), submitId: z.null() }).strict(),
  z.object({ text: z.string().max(32_000), status: z.literal("pending"), submitId: z.string().uuid() }).strict(),
  z.object({ text: z.literal(""), status: z.literal("cleared"), submitId: z.null() }).strict(),
]);
export type ChatDraftRecord = z.infer<typeof chatDraftRecordSchema>;

export function createCodeDraftIdentity(ownerEmail: string, orgId: string, projectId: string | null) {
  const key = createHash("sha256").update(JSON.stringify([ownerEmail.toLowerCase(), orgId, projectId])).digest("hex");
  return { storageKey: "vivary-code-draft-v1:" + key };
}

function chatDraftIndexPrefix(identity: Pick<VivaryChatIdentity, "storageKey">): string {
  const hash = createHash("sha256").update(identity.storageKey).digest("hex");
  return "vivary-chat-draft-index-v1:" + hash + ":";
}

async function indexChatDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string,
  refreshGeneration = false): Promise<void> {
  const key = chatDraftIndexPrefix(identity) + threadId;
  for (;;) {
    const previous = await readAppState(key);
    if (previous && !refreshGeneration) return;
    // Index before the draft CAS. Refreshing this generation prevents an older
    // clear from removing a pointer needed by a concurrent new draft.
    const marker = { threadId, createdAt: typeof previous?.createdAt === "number"
      ? previous.createdAt : Date.now(), generation: randomUUID() };
    if (await compareAndSetAppState(key, previous, marker)) return;
  }
}

export async function listChatDrafts(identity: Pick<VivaryChatIdentity, "storageKey">): Promise<Array<{ threadId: string; createdAt: number; preview: string; status: "draft" | "pending" }>> {
  const prefix = chatDraftIndexPrefix(identity);
  const entries = await listAppState(prefix);
  const visible = await Promise.all(entries.map(async ({ key, value }) => {
    const threadId = value.threadId;
    if (typeof threadId !== "string" || key !== prefix + threadId || !/^[A-Za-z0-9_:-]{1,200}$/.test(threadId)) return null;
    const record = await readChatDraft(identity, threadId);
    if (!record || record.status === "cleared" || !record.text) return null;
    return { threadId, createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt : 0, preview: Array.from(record.text.replace(/\s+/g, " ").trim()).slice(0, 80).join(""),
      status: record.status };
  }));
  return visible.filter((entry): entry is { threadId: string; createdAt: number; preview: string; status: "draft" | "pending" } => entry !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function readIndexedChatDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string) {
  const record = await readChatDraft(identity, threadId);
  if (record && record.status !== "cleared" && record.text) await indexChatDraft(identity, threadId);
  return record;
}

export async function changeIndexedChatDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string,
  expected: ChatDraftRecord | null, next: z.infer<typeof chatDraftNextSchema>) {
  const indexKey = chatDraftIndexPrefix(identity) + threadId;
  const markerBeforeClear = next.status === "cleared" ? await readAppState(indexKey) : null;
  if (next.status !== "cleared" && next.text) await indexChatDraft(identity, threadId, true);
  const result = await changeChatDraft(identity, threadId, expected, next);
  if (result.changed && next.status === "cleared" && markerBeforeClear) {
    // A concurrent edit refreshes the marker before changing the record. Its
    // new generation defeats this removal and keeps the draft discoverable.
    try { await compareAndSetAppState(indexKey, markerBeforeClear, null); }
    catch { /* The cleared record stays authoritative. A stale marker is invisible. */ }
  }
  return result;
}

export function chatDraftKey(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([identity.storageKey, threadId])).digest("hex");
  return "vivary-chat-draft-v1:" + hash;
}

export function parseChatDraft(value: Record<string, unknown> | null): ChatDraftRecord | null {
  if (!value) return null;
  const parsed = chatDraftRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function assertChatDraftThread(identity: VivaryChatIdentity, threadId: string,
  ownerEmail: string, orgId: string) {
  const thread = await getThread(threadId);
  // Native creates a client-side optimistic ID before the first message.
  // An empty conversation may therefore have a draft but no thread row yet.
  if (!thread) return null;
  if (!threadBelongsToChatIdentity(identity, thread, ownerEmail, orgId)) {
    fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  }
  return thread;
}

export async function listNativeChatDrafts(identity: VivaryChatIdentity, ownerEmail: string, orgId: string) {
  const drafts = await listChatDrafts(identity);
  const visible = await Promise.all(drafts.map(async draft => {
    const thread = await getThread(draft.threadId);
    return thread && (!threadBelongsToChatIdentity(identity, thread, ownerEmail, orgId) || thread.archivedAt)
      ? null : draft;
  }));
  return visible.filter((draft): draft is { threadId: string; createdAt: number; preview: string; status: "draft" | "pending" } => draft !== null);
}

export async function readChatDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string): Promise<ChatDraftRecord | null> {
  const raw = await readAppState(chatDraftKey(identity, threadId));
  if (raw && !parseChatDraft(raw)) throw new Error("The saved draft could not be verified.");
  return parseChatDraft(raw);
}

export async function changeChatDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string,
  expected: ChatDraftRecord | null, next: z.infer<typeof chatDraftNextSchema>): Promise<{ record: ChatDraftRecord | null; changed: boolean }> {
  const key = chatDraftKey(identity, threadId);
  const record = chatDraftRecordSchema.parse({ ...next, revision: randomUUID() });
  const changed = await compareAndSetAppState(key, expected, record);
  return { changed, record: changed ? record : await readChatDraft(identity, threadId) };
}

export function savedThreadHasSubmit(threadData: string, submitId: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(threadData); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || !("messages" in parsed) || !Array.isArray(parsed.messages)) return false;
  const markerMatches = (value: unknown) => {
    if (!value || typeof value !== "object" || !("custom" in value)
      || !value.custom || typeof value.custom !== "object"
      || !("agentNativeQueuedMessageId" in value.custom)) return false;
    return value.custom.agentNativeQueuedMessageId === submitId;
  };
  const savedMessage = parsed.messages.some((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("message" in entry)) return false;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return false;
    return ("metadata" in message && markerMatches(message.metadata))
      || ("runConfig" in entry && markerMatches(entry.runConfig))
      || ("runConfig" in message && markerMatches(message.runConfig));
  });
  if (savedMessage) return true;
  return "queuedMessages" in parsed && Array.isArray(parsed.queuedMessages)
    && parsed.queuedMessages.some((queued: unknown) =>
      queued !== null && typeof queued === "object" && "id" in queued && queued.id === submitId);
}

export async function reconcileChatDraft(identity: VivaryChatIdentity, threadId: string, ownerEmail: string, orgId: string) {
  const current = await readChatDraft(identity, threadId);
  if (!current || current.status !== "pending" || !current.submitId) return { record: current, saved: false };
  const thread = await assertChatDraftThread(identity, threadId, ownerEmail, orgId);
  if (!thread || !savedThreadHasSubmit(thread.threadData, current.submitId)) return { record: current, saved: false };
  const result = await changeIndexedChatDraft(identity, threadId, current,
    { text: "", status: "cleared", submitId: null });
  return { record: result.record, saved: result.changed };
}


export async function reconcileCodeDraft(identity: Pick<VivaryChatIdentity, "storageKey">, threadId: string,
  ownerEmail: string, orgId: string, scope: VivaryCodeReadScope | undefined) {
  const current = await readChatDraft(identity, threadId);
  if (!current || current.status !== "pending" || !current.submitId) return { record: current, saved: false };
  if (!hasOwnedVivaryCodeSubmit(ownerEmail, orgId, scope, threadId, current.submitId)) {
    return { record: current, saved: false };
  }
  const result = await changeIndexedChatDraft(identity, threadId, current,
    { text: "", status: "cleared", submitId: null });
  return { record: result.record, saved: result.changed };
}
