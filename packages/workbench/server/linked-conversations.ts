import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { fail, type ActionRunContext } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { isOrgMember } from "@agent-native/core/org";
import { createThread, deleteThread, getThread, updateThreadData, getRequestOrgId, getRequestRunContext, type ChatThread } from "@agent-native/core/server";
import { codeAgentRunsDir, codeAgentRunTranscriptPath, createCodeAgentRunRecord, getCodeAgentRunRecord,
  updateCodeAgentRunRecord, listCodeAgentTranscriptEvents, type CodeAgentRunRecord } from "@agent-native/core/code-agents";
import { z } from "zod";
import { createVivaryChatIdentity, threadBelongsToChatIdentity } from "./chat-identity";
import { PROJECT_CHAT_SCOPE_PREFIX } from "./chat-project-scope.mjs";
import { changeChatDraft, createCodeDraftIdentity } from "./chat-draft";
import { resolveVivaryCodeProject, resolveVivaryCodeProjectHistory } from "./code-project";
import { isOwnedRun, resolveWorkspace, resolveVivaryCodeModel, VIVARY_CODE_MODELS, type VivaryCodeProjectHistory,
  type VivaryCodeWorkspace } from "./local-code-agent";
import { getVivaryRuntimeStatus } from "./local-runtime-setup";
import { getCodexModels } from "./codex-models";
import { redactCredentialsInValue, refreshHeldCredentials } from "./credential-redaction";
import { codeBoundaryBytes, codeCompletedPrefix, codeHistoryItems, codeHistoryRecords, historyDigest, historyExcerpt,
  isCompletedNativeMessage, LINK_HISTORY_BYTES, LINK_RETAINED_PARSE_BYTES, LinkedSourceChanged, nativeHistoryItems, nativeHistoryPath, quotedLinkedHistory } from "./linked-history";
import type { ConversationReference, LinkedConversationResult, LinkedHistoryPage, PreparedLinkedContext } from "../shared/linked-conversation";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const conversationReferenceSchema = z.object({ kind: z.enum(["code", "native"]), id: identifier }).strict();
export const linkedTargetSchema = z.discriminatedUnion("engine", [
  z.object({ engine: z.literal("native") }).strict(),
  z.object({ engine: z.enum(["claude-cli", "codex-cli"]), model: z.string().min(1).max(128) }).strict(),
]);
type TargetChoice = z.infer<typeof linkedTargetSchema>;
const portionSchema = z.object({ entries: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), truncated: z.boolean() });
const acceptedPortionSchema = portionSchema.extend({ linkId: z.string().uuid(), boundaryDigest: z.string() });
const linkSchema = z.object({
  version: z.literal(1), app: z.literal("vivary"), id: z.string().uuid(), owner: z.string(), orgId: identifier,
  projectId: identifier.nullable(), bindingId: z.string().nullable(), rootId: z.string().nullable(),
  source: conversationReferenceSchema, sourceCreatedAt: z.union([z.number(), z.string()]), sourceTitle: z.string(),
  target: conversationReferenceSchema, targetCreatedAt: z.union([z.number(), z.string()]),
  boundaryId: z.string().nullable(), boundaryDigest: z.string(),
  boundaryBytes: z.number().int().nonnegative().max(LINK_HISTORY_BYTES).nullable(),
  lastPrepared: portionSchema.nullable().default(null),
  // Earlier local candidates called preparation supplied. It is never accepted-send evidence.
  lastSupplied: portionSchema.nullable().optional(),
}).strict();
type Link = z.infer<typeof linkSchema>;
type Scope = { owner: string; orgId: string; projectId: string | null; history: VivaryCodeProjectHistory | undefined;
  /** The configured personal workspace, read only when a personal Code record is checked. */
  personal: () => Promise<VivaryCodeWorkspace | undefined> };
type Dependencies = {
  member: typeof isOrgMember;
  history: typeof resolveVivaryCodeProjectHistory;
  workspace: (ctx: ActionRunContext | undefined, projectId: string | undefined) => Promise<VivaryCodeWorkspace | undefined>;
  /** Discovery only. Selection must never start a worker or send a message. */
  targetModel: (choice: Exclude<TargetChoice, { engine: "native" }>, workspace: VivaryCodeWorkspace) => Promise<string>;
};
const defaults: Dependencies = { member: isOrgMember, history: resolveVivaryCodeProjectHistory,
  workspace: (ctx, projectId) => projectId ? resolveVivaryCodeProject(ctx, projectId) : resolveWorkspace(),
  targetModel: async (choice, workspace) => {
    if ((await getVivaryRuntimeStatus(choice.engine)).status !== "ready")
      fail("Connect this runtime in Settings before linking a conversation.", { statusCode: 409 });
    const models = choice.engine === "codex-cli" ? await getCodexModels(workspace.root) : null;
    if (models && models.status !== "ready") fail("Codex models are unavailable. Retry after refreshing Settings.", { statusCode: 409 });
    return resolveVivaryCodeModel(choice.engine, choice.model,
      models?.status === "ready" ? models.models.map(model => model.id) : VIVARY_CODE_MODELS);
  } };

function unavailable(message = "The linked conversation is no longer available in this project."): never {
  fail(message, { errorCode: "vivary_linked_history_unavailable", statusCode: 409 });
}
/**
 * Registry migration 5 creates the link table, and project services skip that migration while unconfigured
 * or before bootstrap finishes. A missing table holds no links, so ordinary conversations never depend on it.
 */
async function linkRows(targetKind: ConversationReference["kind"], targetId: string) {
  try {
    return (await getDbExec().execute({ sql: "SELECT record_json FROM vivary_conversation_links WHERE target_kind = ? AND target_id = ?",
      args: [targetKind, targetId] })).rows;
  } catch (error) {
    if (/no such table: vivary_conversation_links\b|relation "vivary_conversation_links" does not exist/.test(String((error as Error)?.message))) return [];
    throw error;
  }
}
const isSourceFault = (error: unknown) => error instanceof LinkedSourceChanged
  || (error as { errorCode?: string } | null)?.errorCode === "vivary_linked_history_unavailable";

/** Existing Native record owners plus a metadata row, never a copied transcript. */
export function createLinkedConversationService(dependencies: Dependencies = defaults) {
  async function verifiedOwner(ctx: ActionRunContext | undefined) {
    const owner = ctx?.userEmail?.trim().toLowerCase(), orgId = ctx?.orgId;
    if (!owner || !orgId || !["vivary", "workbench"].includes(ctx?.appId ?? "")
      || !["http", "frontend"].includes(ctx?.caller ?? "") || !await dependencies.member(orgId, owner))
      fail("The conversation owner could not be verified.", { statusCode: 403 });
    return { owner, orgId };
  }
  async function scope(ctx: ActionRunContext | undefined, projectId: string | null): Promise<Scope> {
    const { owner, orgId } = await verifiedOwner(ctx);
    let personal: Promise<VivaryCodeWorkspace | undefined> | undefined;
    return { owner, orgId, projectId, history: await dependencies.history(ctx, projectId ?? undefined),
      // An unconfigured or unavailable personal workspace owns no Code history.
      personal: () => personal ??= dependencies.workspace(ctx, undefined).catch(() => undefined) };
  }
  async function record(ref: ConversationReference, identity: Scope): Promise<CodeAgentRunRecord | ChatThread> {
    if (ref.kind === "code") {
      const run = getCodeAgentRunRecord(ref.id);
      // The same run scope isOwnedRun applies: projectId plus bindingId for a project, so a folder reconnect keeps
      // history, and the current personal workspace root otherwise.
      const runScope = identity.history ?? await identity.personal();
      if (!run || run.metadata?.app !== "vivary-workbench-local-code" || !runScope
        || !isOwnedRun(run, identity.owner, identity.orgId, runScope)) unavailable();
      return run;
    }
    const thread = await getThread(ref.id);
    const chatIdentity = createVivaryChatIdentity(identity.owner, identity.orgId,
      { kind: "project", projectId: identity.projectId, label: identity.history?.label ?? "Personal workspace" });
    if (!thread || !threadBelongsToChatIdentity(chatIdentity, thread, identity.owner, identity.orgId)
      || thread.source?.platform || (thread.source?.appId && !["vivary", "workbench"].includes(thread.source.appId))) unavailable();
    return thread;
  }

  async function sourcePrefix(ref: ConversationReference, source: CodeAgentRunRecord | ChatThread, boundaryId?: string | null,
    boundaryBytes?: number | null) {
    if (ref.kind === "code") {
      let text = "";
      let file;
      try {
        file = await open(codeAgentRunTranscriptPath(ref.id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await file.stat();
        const bytes = boundaryBytes ?? stat.size;
        if (!stat.isFile() || stat.nlink !== 1 || bytes > LINK_HISTORY_BYTES || stat.size < bytes)
          unavailable("The source history exceeds the safe 8 MiB linking limit or is unavailable.");
        const buffer = Buffer.alloc(bytes);
        let read = 0;
        while (read < bytes) {
          const result = await file.read(buffer, read, bytes - read, read);
          if (!result.bytesRead) unavailable("The source transcript was replaced or truncated.");
          read += result.bytesRead;
        }
        text = buffer.toString("utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // O_NOFOLLOW refuses a symbolic link with ELOOP. A link, a non-directory parent or a refused open
        // is a transcript that no longer verifies, so the source is unavailable. The link is never followed.
        if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
          unavailable("The source transcript is not a safe regular file.");
        if (code !== "ENOENT") throw error;
        if (boundaryId) unavailable("The source transcript is missing.");
      } finally { await file?.close(); }
      const events = codeHistoryRecords(text, ref.id);
      const end = boundaryId === undefined ? codeCompletedPrefix(events)
        : boundaryId === null ? [] : events.slice(0, events.findIndex(event => event.id === boundaryId) + 1);
      if (boundaryId && (end.at(-1)?.id !== boundaryId || codeCompletedPrefix(end).at(-1)?.id !== boundaryId)) unavailable();
      return { boundaryId: end.at(-1)?.id ?? null, boundaryBytes: codeBoundaryBytes(text, end.at(-1)?.id ?? null),
        digest: historyDigest(end), items: codeHistoryItems(end) };
    }
    const thread = source as ChatThread;
    // New linking bounds the whole thread. A retained read bounds parsing more loosely and the walked prefix exactly,
    // so later source work past the boundary cannot break an existing link.
    const threadBytes = Buffer.byteLength(thread.threadData);
    if (boundaryId === undefined ? threadBytes > LINK_HISTORY_BYTES : threadBytes > LINK_RETAINED_PARSE_BYTES)
      unavailable("The source history exceeds the safe 8 MiB linking limit.");
    // A retained boundary walks parentId from its own message, not from the current head.
    const path = nativeHistoryPath(thread.threadData, boundaryId ?? undefined);
    let index = boundaryId === undefined ? path.findLastIndex(isCompletedNativeMessage)
      : boundaryId === null ? -1 : path.length - 1;
    // A persisted assistant snapshot is not complete while its Native execution is live or saving.
    while (index >= 0) {
      const entry = path[index], folded = entry.message.metadata?.custom?.foldedRunIds;
      const runId = Array.isArray(folded) ? folded.at(-1) : entry.message.metadata?.runId;
      if (!isCompletedNativeMessage(entry)) { if (boundaryId) unavailable(); index--; continue; }
      if (runId) {
        const { rows } = await getDbExec().execute({ sql: "SELECT status FROM agent_runs WHERE id = ? AND thread_id = ?", args: [runId, ref.id] });
        if (rows.length && rows[0].status !== "completed") { if (boundaryId) unavailable(); index--; continue; }
      }
      break;
    }
    if (boundaryId && path[index]?.message.id !== boundaryId) unavailable();
    const prefix = path.slice(0, index + 1);
    if (boundaryId !== undefined && Buffer.byteLength(JSON.stringify(prefix)) > LINK_HISTORY_BYTES)
      unavailable("The source history exceeds the safe 8 MiB linking limit.");
    return { boundaryId: prefix.at(-1)?.message.id ?? null, boundaryBytes: null, digest: historyDigest(prefix), items: nativeHistoryItems(prefix) };
  }

  async function load(ctx: ActionRunContext | undefined, projectId: string | null, target: ConversationReference, cursor?: string): Promise<LinkedHistoryPage | null> {
    // An unlinked conversation needs only a verified owner. Project history, which an unavailable folder refuses,
    // is resolved only for a conversation that has a link row.
    await verifiedOwner(ctx);
    const rows = await linkRows(target.kind, target.id);
    if (!rows.length) {
      if (target.kind === "code" && getCodeAgentRunRecord(target.id)?.metadata?.linkedHistoryId) unavailable();
      return null;
    }
    const identity = await scope(ctx, projectId);
    const currentTarget = await record(target, identity);
    const parsed = linkSchema.safeParse(JSON.parse(String(rows[0].record_json)));
    if (!parsed.success) unavailable();
    const link = parsed.data;
    if (link.owner !== identity.owner || link.orgId !== identity.orgId || link.projectId !== projectId
      || link.bindingId !== (identity.history?.bindingId ?? null)
      || historyDigest(link.target) !== historyDigest(target) || link.targetCreatedAt !== currentTarget.createdAt
      || (target.kind === "code" && (currentTarget as CodeAgentRunRecord).metadata?.linkedHistoryId !== link.id)) unavailable();
    // The target link is valid from here. A deleted, revoked or changed source leaves the target usable without linked context.
    let items: Awaited<ReturnType<typeof sourcePrefix>>["items"] | null = null;
    try {
      const source = await record(link.source, identity);
      if (source.createdAt !== link.sourceCreatedAt) unavailable("The source conversation was replaced.");
      const prefix = await sourcePrefix(link.source, source, link.boundaryId, link.boundaryBytes);
      if (prefix.digest !== link.boundaryDigest) unavailable("The completed source history changed.");
      items = prefix.items;
    } catch (error) { if (!isSourceFault(error)) throw error; }
    if (!items && cursor) unavailable("The original conversation is unavailable.");
    await refreshHeldCredentials();
    const redacted = (items ?? []).map(item => ({ ...item, text: redactCredentialsInValue(item.text) }));
    const page = items ? historyExcerpt(redacted, historyDigest([link.id, link.source, link.boundaryId, link.boundaryDigest]), cursor)
      : { excerpt: "", suppliedEntries: 0, truncated: false, nextCursor: null };
    const accepted = target.kind === "code" ? listCodeAgentTranscriptEvents(target.id).findLast(event => {
      const parsed = acceptedPortionSchema.safeParse(event.metadata?.linkedHistory);
      return event.kind === "user" && parsed.success && parsed.data.linkId === link.id && parsed.data.boundaryDigest === link.boundaryDigest;
    }) : undefined;
    const acceptedPortion = accepted ? acceptedPortionSchema.parse(accepted.metadata?.linkedHistory) : null;
    return { ...page, sourceStatus: items ? "available" : "unavailable", source: link.source, sourceTitle: link.sourceTitle,
      boundaryId: link.boundaryId, availableEntries: redacted.length, nativeContinuity: false, lastPrepared: link.lastPrepared,
      lastAccepted: acceptedPortion && accepted ? { entries: acceptedPortion.entries, characters: acceptedPortion.characters,
        truncated: acceptedPortion.truncated, userEventId: accepted.id } : null };
  }

  async function create(ctx: ActionRunContext | undefined, input: { projectId: string | null; source: ConversationReference; target: TargetChoice }): Promise<LinkedConversationResult> {
    const identity = await scope(ctx, input.projectId);
    const source = await record(input.source, identity);
    if (input.source.kind === "code" && input.target.engine === (source as CodeAgentRunRecord).metadata?.engine)
      fail("Choose a different harness for a linked conversation.", { statusCode: 400 });
    if (input.source.kind === "native" && input.target.engine === "native") fail("Choose a different harness.", { statusCode: 400 });
    const prefix = await sourcePrefix(input.source, source);
    const workspace = input.target.engine !== "native" ? await dependencies.workspace(ctx, input.projectId ?? undefined) : undefined;
    // Registered projects require a folder to create a Code record. Native history creation needs none.
    if (input.target.engine !== "native" && !workspace) unavailable("Select a connected project before linking a Code conversation.");
    const model = input.target.engine !== "native" ? await dependencies.targetModel(input.target, workspace!) : null;
    const again = await scope(ctx, input.projectId);
    if (historyDigest(again.history) !== historyDigest(identity.history)) unavailable("The project changed. Retry the link.");
    const currentSource = await record(input.source, again);
    if (currentSource.createdAt !== source.createdAt || (await sourcePrefix(input.source, currentSource, prefix.boundaryId, prefix.boundaryBytes)).digest !== prefix.digest) unavailable();
    const linkId = randomUUID(), targetId = randomUUID(), title = `Linked: ${source.title || "Conversation"}`.slice(0, 100);
    let target: ConversationReference, targetCreatedAt: number | string;
    // Each target owner's cleared draft is written only after the link exists, and removeTarget undoes the creation.
    let clearDraft: () => Promise<unknown>, removeTarget: () => Promise<unknown>;
    if (input.target.engine === "native") {
      const chat = createVivaryChatIdentity(identity.owner, identity.orgId,
        { kind: "project", projectId: input.projectId, label: identity.history?.label ?? "Personal workspace" });
      const thread = await createThread(identity.owner, { id: targetId, scope: chat.scope, orgId: identity.orgId, source: { appId: "vivary" } });
      target = { kind: "native", id: thread.id }; targetCreatedAt = thread.createdAt;
      clearDraft = () => changeChatDraft(chat, thread.id, null, { status: "cleared", text: "", submitId: null });
      removeTarget = () => deleteThread(thread.id);
    } else {
      const draftThreadId = `vivary-code:${input.projectId ? "project:" + input.projectId + ":" : ""}${targetId}`;
      // Paused has no startRequested, pendingLaunch, prompt, transcript or provider session.
      const run = createCodeAgentRunRecord({ id: targetId, goalId: "vivary-local-code", title,
        status: "paused", phase: "linked-inactive", needsApproval: false, permissionMode: "auto-edit", cwd: workspace!.root,
        metadata: { app: "vivary-workbench-local-code", ownerEmail: identity.owner, orgId: identity.orgId,
          engine: input.target.engine, model, workspaceRoot: workspace!.root,
          ...(identity.history ? { ...identity.history } : {}), draftThreadId, linkedHistoryId: linkId, linkedCreationPending: true } });
      target = { kind: "code", id: run.id }; targetCreatedAt = run.createdAt;
      clearDraft = () => changeChatDraft(createCodeDraftIdentity(identity.owner, identity.orgId, input.projectId), draftThreadId, null,
        { status: "cleared", text: "", submitId: null });
      // Core has no run removal. Its record is <id>.json in codeAgentRunsDir.
      removeTarget = () => rm(join(codeAgentRunsDir(), `${run.id}.json`), { force: true });
    }
    const link: Link = { version: 1, app: "vivary", id: linkId, owner: identity.owner, orgId: identity.orgId,
      projectId: input.projectId, bindingId: identity.history?.bindingId ?? null, rootId: identity.history?.rootId ?? null,
      source: input.source, sourceCreatedAt: source.createdAt, sourceTitle: source.title, target, targetCreatedAt,
      boundaryId: prefix.boundaryId, boundaryBytes: prefix.boundaryBytes, boundaryDigest: prefix.digest, lastPrepared: null };
    let linked = false;
    try {
      await getDbExec().execute({ sql: "INSERT INTO vivary_conversation_links (link_id, target_kind, target_id, record_json) VALUES (?, ?, ?, ?)",
        args: [link.id, target.kind, target.id, JSON.stringify(link)] });
      linked = true;
      await clearDraft();
      if (target.kind === "code") updateCodeAgentRunRecord(target.id, { metadata: { linkedCreationPending: false } });
      else await updateThreadData(target.id, "{}", title, "", 0);
    } catch (error) {
      // A failed link leaves no hidden target behind, so each Retry starts clean.
      if (linked) await getDbExec().execute({ sql: "DELETE FROM vivary_conversation_links WHERE link_id = ?", args: [link.id] }).catch(() => undefined);
      await removeTarget().catch(() => undefined);
      throw error;
    }
    return { target, route: target.kind === "code" ? `/?run=${encodeURIComponent(target.id)}`
      : `/?runtime=native&history=project&thread=${encodeURIComponent(target.id)}` };
  }

  async function context(ctx: ActionRunContext | undefined, projectId: string | null, target: ConversationReference): Promise<PreparedLinkedContext | null> {
    const page = await load(ctx, projectId, target);
    if (!page) return null;
    // An unavailable source supplies nothing, so nothing is recorded as prepared.
    if (page.sourceStatus === "unavailable") return { block: null, portion: null };
    // Preparation is not acceptance or observed provider delivery. The Code send records acceptance on its actual user event after final admission.
    const rows = await linkRows(target.kind, target.id);
    const link = linkSchema.parse(JSON.parse(String(rows[0]?.record_json)));
    link.lastPrepared = { entries: page.suppliedEntries, characters: page.excerpt.length, truncated: page.truncated };
    await getDbExec().execute({ sql: "UPDATE vivary_conversation_links SET record_json = ? WHERE link_id = ? AND record_json = ?",
      args: [JSON.stringify(link), link.id, String(rows[0].record_json)] });
    return { block: quotedLinkedHistory(page.source, page.boundaryId, page),
      portion: { ...link.lastPrepared, linkId: link.id, boundaryDigest: link.boundaryDigest } };
  }
  async function sourceAvailable(ctx: ActionRunContext | undefined, projectId: string | null, source: ConversationReference) {
    const identity = await scope(ctx, projectId);
    if (source.kind === "native" && !await getThread(source.id)) return { available: false };
    await record(source, identity);
    return { available: true };
  }
  /** Template prepareRequest is before model/attachment work and preserves visible user text. */
  async function prepareNativeMessage(details: { threadId?: string; ownerEmail: string | null;
    message: string; displayMessage?: string; internalContinuation?: boolean }) {
    if (!details.threadId || details.internalContinuation) return;
    // Link targets are always project or personal workspace conversations, which share the project scope prefix.
    // A send pinned to any other scope never reads link metadata, so it cannot receive linked history.
    const pinned = getRequestRunContext()?.chatScope;
    if (pinned?.type !== "workspace-app" || !pinned.id.startsWith(PROJECT_CHAT_SCOPE_PREFIX)) return;
    const rows = await linkRows("native", details.threadId);
    if (!rows.length) return;
    const link = linkSchema.parse(JSON.parse(String(rows[0].record_json)));
    const orgId = getRequestOrgId(), owner = details.ownerEmail?.trim().toLowerCase();
    if (!orgId || !owner) unavailable();
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: link.projectId, label: "Project" });
    if (pinned.type !== identity.scope.type || pinned.id !== identity.scope.id) unavailable();
    const prepared = await context({ caller: "http", userEmail: owner, orgId, appId: "workbench" },
      link.projectId, { kind: "native", id: details.threadId });
    if (!prepared) unavailable();
    // The source is unavailable, so the request proceeds unchanged without linked context.
    if (!prepared.block) return;
    return { message: `${prepared.block}\n\n# Current request\n${details.message}`,
      displayMessage: details.displayMessage ?? details.message };
  }

  return { create, load, context, sourceAvailable, prepareNativeMessage };
}
export const linkedConversations = createLinkedConversationService();


/** Native calls this before model work. The visible user message remains unchanged. */
export const prepareLinkedNativeMessage = linkedConversations.prepareNativeMessage;
