import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
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
import { changeChatDraft, chatDraftKey, createCodeDraftIdentity, type ChatDraftRecord } from "./chat-draft";
import { compareAndSetAppState } from "@agent-native/core/application-state";
import type { VivaryChatIdentity } from "../app/lib/chat-scope";
import { resolveVivaryCodeProject, resolveVivaryCodeProjectHistory } from "./code-project";
import { isOwnedRun, providerSessionId, resolveWorkspace, sameWorkspace, resolveVivaryCodeModel, VIVARY_CODE_MODELS, type VivaryCodeProjectHistory,
  type VivaryCodeWorkspace } from "./local-code-agent";
import { getVivaryRuntimeStatus } from "./local-runtime-setup";
import { getCodexModels } from "./codex-models";
import { claudeCodeModelChoices } from "../shared/claude-models";
import { redactCredentialsInValue, refreshHeldCredentials } from "./credential-redaction";
import { codeBoundaryBytes, codeCompletedPrefix, codeHistoryItems, codeHistoryRecords, historyDigest, historyExcerpt, historyLatest,
  isCompletedNativeMessage, LINK_HISTORY_BYTES, LINK_RETAINED_PARSE_BYTES, LinkedSourceChanged, nativeHistoryItems, nativeHistoryPath, quotedLinkedHistory } from "./linked-history";
import { LINKED_TARGET_SOURCE_URL, type ConversationReference, type LinkedConversationResult, type LinkedHistoryPage,
  type PreparedLinkedContext } from "../shared/linked-conversation";

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
  /** The client's operation ID. A retry of the same choice returns this link instead of creating another target. */
  operationId: z.string().uuid().optional(),
  /** Set from the link insert until the target and draft are finalized. Absent on finished and earlier links. */
  creationPending: z.literal(true).optional(),
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
  /** The no-follow open flag. Windows has none, which tests simulate with 0. */
  noFollowFlag?: number;
};
/** The default target model discovery. Runtime and Codex catalog readers are injectable for tests. */
export async function linkedTargetModel(choice: Exclude<TargetChoice, { engine: "native" }>, workspace: VivaryCodeWorkspace,
  runtimeStatus = getVivaryRuntimeStatus, codexModels = getCodexModels): Promise<string> {
  const runtime = await runtimeStatus(choice.engine);
  if (runtime.status !== "ready")
    fail("Connect this runtime in Settings before linking a conversation.", { statusCode: 409 });
  const models = choice.engine === "codex-cli" ? await codexModels(workspace.root) : null;
  if (models && models.status !== "ready") fail("Codex models are unavailable. Retry after refreshing Settings.", { statusCode: 409 });
  const model = resolveVivaryCodeModel(choice.engine, choice.model,
    models?.status === "ready" ? models.models.map(model => model.id) : VIVARY_CODE_MODELS);
  // The same refusal sendVivaryCodeMessage makes, so a target is never pinned to a model it can never send with.
  const claude = choice.engine === "claude-cli" ? claudeCodeModelChoices(runtime.version).find(item => item.id === model) : undefined;
  if (claude && claude.support !== "supported") fail(claude.message, { errorCode: "vivary_code_model_unsupported", statusCode: 400 });
  return model;
}
const defaults: Dependencies = { member: isOrgMember, history: resolveVivaryCodeProjectHistory,
  workspace: (ctx, projectId) => projectId ? resolveVivaryCodeProject(ctx, projectId) : resolveWorkspace(),
  targetModel: (choice, workspace) => linkedTargetModel(choice, workspace) };

function unavailable(message = "The linked conversation is no longer available in this project."): never {
  fail(message, { errorCode: "vivary_linked_history_unavailable", statusCode: 409 });
}
/**
 * Registry migration 5 creates the link table, and project services skip that migration while unconfigured
 * or before bootstrap finishes. A missing table holds no links, so ordinary conversations never depend on it.
 */
const isMissingLinkTable = (error: unknown) =>
  /no such table: vivary_conversation_links\b|relation "vivary_conversation_links" does not exist/.test(String((error as Error)?.message));
async function linkRows(targetKind: ConversationReference["kind"], targetId: string) {
  try {
    return (await getDbExec().execute({ sql: "SELECT record_json FROM vivary_conversation_links WHERE target_kind = ? AND target_id = ?",
      args: [targetKind, targetId] })).rows;
  } catch (error) {
    if (isMissingLinkTable(error)) return [];
    throw error;
  }
}
/** Linking needs the table, so create() refuses before it makes any target when the migration has not run. */
async function requireLinkTable() {
  try { await getDbExec().execute("SELECT link_id FROM vivary_conversation_links WHERE 1 = 0"); }
  catch (error) {
    if (isMissingLinkTable(error))
      unavailable("Linking conversations is not available yet. Finish setting up Vivary projects, then retry.");
    throw error;
  }
}
/**
 * Link operations being created in this process. Production runs one supervised server process, so this set is
 * the authority on whether an unfinished operation is still in flight or was left behind by a failed rollback.
 */
const creatingTargets = new Set<string>();
const stillCreating = (): never =>
  fail("This link is still being created. Retry in a moment.", { errorCode: "vivary_linked_history_unavailable", statusCode: 409 });
const targetRoute = (target: ConversationReference) => target.kind === "code" ? `/?run=${encodeURIComponent(target.id)}`
  : `/?runtime=native&history=project&thread=${encodeURIComponent(target.id)}`;
/** A target ID no other owner's operation can produce, in the UUID shape other targets use. */
export function operationTargetId(owner: string, orgId: string, operationId: string): string {
  const hash = createHash("sha256").update(JSON.stringify(["vivary-linked-target", owner, orgId, operationId])).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
}
/** Each target records that it is linked: a Code run in linkedHistoryId, a Native thread in its source URL. */
async function isMarkedLinkTarget(target: ConversationReference): Promise<boolean> {
  return target.kind === "code" ? Boolean(getCodeAgentRunRecord(target.id)?.metadata?.linkedHistoryId)
    : (await getThread(target.id))?.source?.url === LINKED_TARGET_SOURCE_URL;
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
  /**
   * The caller check for a conversation that may have no link. Code conversations support an owner with no
   * organization, so organization membership is verified only when one is present. Links always need one.
   */
  async function verifiedCaller(ctx: ActionRunContext | undefined) {
    if (ctx?.orgId) return verifiedOwner(ctx);
    if (!ctx?.userEmail?.trim() || !["vivary", "workbench"].includes(ctx?.appId ?? "") || !["http", "frontend"].includes(ctx?.caller ?? ""))
      fail("The conversation owner could not be verified.", { statusCode: 403 });
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
        const transcript = codeAgentRunTranscriptPath(ref.id);
        // O_NONBLOCK keeps a FIFO with no writer from blocking the open. The checks below then reject it as not a
        // regular file. Reads of a regular file are unaffected.
        file = await open(transcript, constants.O_RDONLY | (dependencies.noFollowFlag ?? constants.O_NOFOLLOW ?? 0)
          | (constants.O_NONBLOCK ?? 0));
        // Windows has no O_NOFOLLOW, so the opened file must be the path's own regular file, as in original-runtime.ts.
        const [stat, named] = await Promise.all([file.stat(), lstat(transcript)]);
        if (!named.isFile() || stat.ino !== named.ino || stat.dev !== named.dev)
          unavailable("The source transcript is not a safe regular file.");
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
        // Only a linked Code target that has never sent has no transcript by design. Any other missing transcript
        // was deleted, so neither a new link nor a retained read may treat it as empty history.
        if (boundaryId || (source as CodeAgentRunRecord).phase !== "linked-inactive")
          unavailable("The source transcript is missing.");
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
    return (await loadWithLatest(ctx, projectId, target, cursor))?.page ?? null;
  }
  /** The inspection page from the cursor, plus the send block's latest-entries excerpt. */
  async function loadWithLatest(ctx: ActionRunContext | undefined, projectId: string | null, target: ConversationReference,
    cursor?: string): Promise<{ page: LinkedHistoryPage; latestExcerpt: string } | null> {
    // An unlinked conversation needs only a verified caller, with or without an organization. Project history, which
    // an unavailable folder refuses, and organization membership are required only for a conversation with a link row.
    await verifiedCaller(ctx);
    const rows = await linkRows(target.kind, target.id);
    if (!rows.length) {
      // A durably marked target with no row (or no table yet) is an invalid link, never an ordinary conversation.
      if (await isMarkedLinkTarget(target)) unavailable();
      return null;
    }
    const identity = await scope(ctx, projectId);
    const currentTarget = await record(target, identity);
    const parsed = linkSchema.safeParse(JSON.parse(String(rows[0].record_json)));
    if (!parsed.success) unavailable();
    const link = parsed.data;
    // An unfinished link has no caller with its route yet. It is either still being created or left to clean up.
    if (link.creationPending) unavailable();
    if (link.owner !== identity.owner || link.orgId !== identity.orgId || link.projectId !== projectId
      || link.bindingId !== (identity.history?.bindingId ?? null)
      || historyDigest(link.target) !== historyDigest(target) || link.targetCreatedAt !== currentTarget.createdAt
      // Each target keeps its durable marker while its row exists: a Code run its linkedHistoryId, a Native thread its source URL.
      || (target.kind === "code" && (currentTarget as CodeAgentRunRecord).metadata?.linkedHistoryId !== link.id)
      || (target.kind === "native" && (currentTarget as ChatThread).source?.url !== LINKED_TARGET_SOURCE_URL)) unavailable();
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
    const latest = items ? historyLatest(redacted) : { excerpt: "", suppliedEntries: 0, truncated: false };
    const accepted = target.kind === "code" ? listCodeAgentTranscriptEvents(target.id).findLast(event => {
      const parsed = acceptedPortionSchema.safeParse(event.metadata?.linkedHistory);
      return event.kind === "user" && parsed.success && parsed.data.linkId === link.id && parsed.data.boundaryDigest === link.boundaryDigest;
    }) : undefined;
    const acceptedPortion = accepted ? acceptedPortionSchema.parse(accepted.metadata?.linkedHistory) : null;
    // A Code target that resumes its own provider session already holds the block from its accepted send, so a later
    // send would only add another copy. Without a session, Code rebuilds context from the transcript, which keeps the
    // raw request only, and Native persists the visible message only, so both need the block on every send.
    const run = target.kind === "code" ? currentTarget as CodeAgentRunRecord : null;
    const engine = run?.metadata?.engine;
    const sessionHasBlock = Boolean(run && acceptedPortion && (engine === "claude-cli" || engine === "codex-cli")
      && providerSessionId(run, engine) !== null);
    return { latestExcerpt: latest.excerpt, page: { ...page, sourceStatus: items ? "available" : "unavailable",
      nextSendSupplies: Boolean(items) && !sessionHasBlock,
      nextSend: { entries: latest.suppliedEntries, characters: latest.excerpt.length, truncated: latest.truncated },
      source: link.source, sourceTitle: link.sourceTitle,
      boundaryId: link.boundaryId, availableEntries: redacted.length, nativeContinuity: false, lastPrepared: link.lastPrepared,
      lastAccepted: acceptedPortion && accepted ? { entries: acceptedPortion.entries, characters: acceptedPortion.characters,
        truncated: acceptedPortion.truncated, userEventId: accepted.id } : null } };
  }

  async function create(ctx: ActionRunContext | undefined, input: { projectId: string | null; source: ConversationReference;
    target: TargetChoice; operationId?: string }): Promise<LinkedConversationResult> {
    if (!ctx?.orgId) unavailable("Linking conversations needs an organization. Select one, then retry.");
    const identity = await scope(ctx, input.projectId);
    await requireLinkTable();
    // The target ID derives from the owner and the client's operation ID, so a retry after a lost response finds the
    // link it already made instead of creating a second target. Another owner's operation can never reach this ID.
    const operationId = input.operationId ?? randomUUID();
    const targetId = operationTargetId(identity.owner, identity.orgId, operationId);
    // A retry that arrives while the first request is still working waits for it rather than racing it.
    if (creatingTargets.has(targetId)) stillCreating();
    creatingTargets.add(targetId);
    try { return await createOperation(ctx, input, identity, operationId, targetId); }
    finally { creatingTargets.delete(targetId); }
  }
  async function createOperation(ctx: ActionRunContext | undefined, input: { projectId: string | null;
    source: ConversationReference; target: TargetChoice }, identity: Scope, operationId: string, targetId: string): Promise<LinkedConversationResult> {
    // Only a finalized link replays. Anything unfinalized for this operation was left by a failed rollback or a
    // process exit, because no request is creating it now, so it is removed and the link is created again.
    for (const kind of ["code", "native"] as const) {
      const existing = await linkRows(kind, targetId);
      if (!existing.length) continue;
      const parsed = linkSchema.safeParse(JSON.parse(String(existing[0].record_json)));
      if (!parsed.success || !parsed.data.creationPending) return replayOperation(existing[0].record_json, identity, input, operationId);
      await getDbExec().execute({ sql: "DELETE FROM vivary_conversation_links WHERE target_kind = ? AND target_id = ?", args: [kind, targetId] });
      await removeUnfinishedTarget({ kind, id: targetId }, identity, true);
    }
    for (const kind of ["code", "native"] as const) await removeUnfinishedTarget({ kind, id: targetId }, identity, false);
    const source = await record(input.source, identity);
    // A linked target used as a source must still be a valid link itself, so its frozen history is not bypassed.
    await validateMarkedSource(ctx, input.projectId, input.source);
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
    // As Code send admission does, the folder is resolved again after discovery. A personal workspace has no project
    // history to compare, so only this check catches a move during discovery.
    if (workspace) {
      const current = await dependencies.workspace(ctx, input.projectId ?? undefined);
      if (!current || !sameWorkspace(current, workspace)) unavailable("The workspace folder changed. Retry the link.");
    }
    const currentSource = await record(input.source, again);
    if (currentSource.createdAt !== source.createdAt || (await sourcePrefix(input.source, currentSource, prefix.boundaryId, prefix.boundaryBytes)).digest !== prefix.digest) unavailable();
    const linkId = randomUUID(), title = `Linked: ${source.title || "Conversation"}`.slice(0, 100);
    let target: ConversationReference, targetCreatedAt: number | string;
    // Each target owner's cleared draft is written after finalization, and rollback removes it with the target.
    let draftOwner: { identity: Pick<VivaryChatIdentity, "storageKey">; threadId: string }, removeTarget: () => Promise<unknown>;
    if (input.target.engine === "native") {
      const chat = createVivaryChatIdentity(identity.owner, identity.orgId,
        { kind: "project", projectId: input.projectId, label: identity.history?.label ?? "Personal workspace" });
      // The linked marker is added at finalization, so an unfinished thread is never listed as a linked target.
      const thread = await createThread(identity.owner, { id: targetId, scope: chat.scope, orgId: identity.orgId,
        source: { appId: "vivary" } });
      target = { kind: "native", id: thread.id }; targetCreatedAt = thread.createdAt;
      draftOwner = { identity: chat, threadId: thread.id };
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
      draftOwner = { identity: createCodeDraftIdentity(identity.owner, identity.orgId, input.projectId), threadId: draftThreadId };
      // Core has no run removal. Its record is <id>.json in codeAgentRunsDir.
      removeTarget = () => rm(join(codeAgentRunsDir(), `${run.id}.json`), { force: true });
    }
    const link: Link = { version: 1, app: "vivary", id: linkId, owner: identity.owner, orgId: identity.orgId,
      projectId: input.projectId, bindingId: identity.history?.bindingId ?? null, rootId: identity.history?.rootId ?? null,
      source: input.source, sourceCreatedAt: source.createdAt, sourceTitle: source.title, target, targetCreatedAt,
      boundaryId: prefix.boundaryId, boundaryBytes: prefix.boundaryBytes, boundaryDigest: prefix.digest, lastPrepared: null, operationId,
      creationPending: true };
    const pendingJson = JSON.stringify(link);
    let linked = false, clearedDraft: ChatDraftRecord | null = null;
    try {
      await getDbExec().execute({ sql: "INSERT INTO vivary_conversation_links (link_id, target_kind, target_id, record_json) VALUES (?, ?, ?, ?)",
        args: [link.id, target.kind, target.id, pendingJson] });
      linked = true;
      if (target.kind === "code") updateCodeAgentRunRecord(target.id, { metadata: { linkedCreationPending: false } });
      else {
        await updateThreadData(target.id, "{}", title, "", 0);
        // Core's setThreadSourceIfMissing is not exported. This is the same fill-only update, so no source is overwritten.
        await getDbExec().execute({ sql: "UPDATE chat_threads SET source_url = COALESCE(source_url, ?) WHERE id = ?",
          args: [LINKED_TARGET_SOURCE_URL, target.id] });
      }
      // A failed clear writes nothing (compare-and-set). A written one is removed again if a later step fails.
      const cleared = await changeChatDraft(draftOwner.identity, draftOwner.threadId, null, { status: "cleared", text: "", submitId: null });
      if (cleared.changed) clearedDraft = cleared.record;
      const { creationPending: _pending, ...finished } = link;
      const result = await getDbExec().execute({ sql: "UPDATE vivary_conversation_links SET record_json = ? WHERE link_id = ? AND record_json = ?",
        args: [JSON.stringify(finished), link.id, pendingJson] });
      if (!result.rowsAffected) throw new Error("The link changed while it was being created.");
    } catch (error) {
      // A failed link leaves no hidden target behind, so each Retry starts clean.
      if (linked) await getDbExec().execute({ sql: "DELETE FROM vivary_conversation_links WHERE link_id = ?", args: [link.id] }).catch(() => undefined);
      if (clearedDraft) await compareAndSetAppState(chatDraftKey(draftOwner.identity, draftOwner.threadId), clearedDraft, null).catch(() => undefined);
      await removeTarget().catch(() => undefined);
      throw error;
    }
    return { target, route: targetRoute(target) };
  }
  /**
   * Removes a target this operation left unfinished. With its pending row, any target for the operation is unfinished.
   * Without a row, only a Code record still marked linkedCreationPending, or an empty unmarked Native thread of this
   * owner, qualifies. A finished-looking target with no row is damage, so creation refuses rather than delete it.
   */
  async function removeUnfinishedTarget(target: ConversationReference, identity: Scope, pendingRow: boolean) {
    if (target.kind === "code") {
      const run = getCodeAgentRunRecord(target.id);
      if (!run) return;
      if (!pendingRow && (run.metadata?.linkedCreationPending !== true || run.metadata?.ownerEmail !== identity.owner)) unavailable();
      await rm(join(codeAgentRunsDir(), `${target.id}.json`), { force: true });
      return;
    }
    const thread = await getThread(target.id);
    if (!thread) return;
    if (!pendingRow && (thread.messageCount !== 0 || thread.ownerEmail.toLowerCase() !== identity.owner
      || thread.source?.url === LINKED_TARGET_SOURCE_URL)) unavailable();
    await deleteThread(target.id);
  }
  /** A repeated operation returns its own link. Any other owner, project, source or harness is a mismatched reuse. */
  function replayOperation(recordJson: unknown, identity: Scope, input: { projectId: string | null; source: ConversationReference;
    target: TargetChoice }, operationId: string): LinkedConversationResult {
    const parsed = linkSchema.safeParse(JSON.parse(String(recordJson)));
    if (!parsed.success) unavailable();
    const link = parsed.data;
    const engine = link.target.kind === "native" ? "native" : getCodeAgentRunRecord(link.target.id)?.metadata?.engine;
    if (link.operationId !== operationId || link.owner !== identity.owner || link.orgId !== identity.orgId
      || link.projectId !== input.projectId || historyDigest(link.source) !== historyDigest(input.source) || engine !== input.target.engine)
      fail("This link request was already used for a different choice. Choose the harness again.",
        { errorCode: "vivary_link_operation_mismatch", statusCode: 409 });
    return { target: link.target, route: targetRoute(link.target) };
  }

  async function context(ctx: ActionRunContext | undefined, projectId: string | null, target: ConversationReference): Promise<PreparedLinkedContext | null> {
    const loaded = await loadWithLatest(ctx, projectId, target);
    if (!loaded) return null;
    const { page, latestExcerpt } = loaded;
    // An unavailable source, or a session that already holds the block, supplies nothing, so nothing is recorded as prepared.
    if (!page.nextSendSupplies) return { block: null, portion: null };
    // Preparation is not acceptance or observed provider delivery. The Code send records acceptance on its actual user event after final admission.
    const rows = await linkRows(target.kind, target.id);
    const link = linkSchema.parse(JSON.parse(String(rows[0]?.record_json)));
    // The send block is the latest entries ending at the boundary, not the first inspection page.
    link.lastPrepared = page.nextSend;
    await getDbExec().execute({ sql: "UPDATE vivary_conversation_links SET record_json = ? WHERE link_id = ? AND record_json = ?",
      args: [JSON.stringify(link), link.id, String(rows[0].record_json)] });
    return { block: quotedLinkedHistory(page.source, page.boundaryId, { excerpt: latestExcerpt,
      suppliedEntries: page.nextSend.entries, availableEntries: page.availableEntries, truncated: page.nextSend.truncated }),
      portion: { ...link.lastPrepared, linkId: link.id, boundaryDigest: link.boundaryDigest } };
  }
  /** A durably marked target is a source only while its own link metadata passes load()'s validation. */
  async function validateMarkedSource(ctx: ActionRunContext | undefined, projectId: string | null, source: ConversationReference) {
    // The marker is mutable, so every source is probed. load() returns null for an ordinary source and refuses a
    // link row that no longer matches its target, as a Code send does.
    await load(ctx, projectId, source);
  }
  async function sourceAvailable(ctx: ActionRunContext | undefined, projectId: string | null, source: ConversationReference) {
    // Linking needs an organization, so an owner without one is not offered the chooser.
    await verifiedCaller(ctx);
    if (!ctx?.orgId) return { available: false };
    // A project with no connected folder has no project history to link from. That is a state, not a failure,
    // so the chooser stays hidden without an alert. Refused access and other faults still fail and keep Retry.
    let identity: Scope;
    try { identity = await scope(ctx, projectId); }
    catch (error) {
      if ((error as { errorCode?: string } | null)?.errorCode === "vivary_code_project_history_unavailable") return { available: false };
      throw error;
    }
    if (source.kind === "native" && !await getThread(source.id)) return { available: false };
    await record(source, identity);
    // An invalid linked target is not offered as a source. create() refuses it too.
    try { await validateMarkedSource(ctx, projectId, source); }
    catch (error) {
      if ((error as { errorCode?: string } | null)?.errorCode === "vivary_linked_history_unavailable") return { available: false };
      throw error;
    }
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
    if (!rows.length) {
      if (await isMarkedLinkTarget({ kind: "native", id: details.threadId })) unavailable();
      return;
    }
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

  /**
   * The linked-context loader a Code send uses for an existing run. The run's linkedHistoryId marker is mutable,
   * so every existing run is probed. context() supplies nothing for an ordinary run and refuses a link row that no
   * longer matches its target. A missing link table still means no link for an unmarked run.
   */
  function codeSendLinkedContext(ctx: ActionRunContext | undefined, projectId: string | null, runId: string | undefined) {
    return runId ? () => context(ctx, projectId, { kind: "code", id: runId }) : undefined;
  }

  return { create, load, context, sourceAvailable, prepareNativeMessage, codeSendLinkedContext };
}
export const linkedConversations = createLinkedConversationService();


/** Native calls this before model work. The visible user message remains unchanged. */
export const prepareLinkedNativeMessage = linkedConversations.prepareNativeMessage;
