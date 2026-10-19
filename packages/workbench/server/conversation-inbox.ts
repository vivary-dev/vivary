import { fail } from "@agent-native/core/action";
import { updateCodeAgentRunRecord, type CodeAgentRunRecord } from "@agent-native/core/code-agents";
import { getDbExec } from "@agent-native/core/db";
import { getThread, listThreads, setThreadArchived } from "@agent-native/core/server";
import { codeDraftSelectionKey } from "../shared/code-draft";
import { LINKED_TARGET_SOURCE_URL } from "../shared/linked-conversation";
import { createCodeDraftIdentity, listChatDrafts, listNativeChatDrafts, readChatDraft } from "./chat-draft";
import { createVivaryChatIdentity, threadBelongsToChatIdentity } from "./chat-identity";
import { projectChatScopeId } from "./chat-project-scope.mjs";
import {
  engineLabelFromRun, getVivaryCodeHostState, isOwnedRun, linkedCodeDraftRuns, listOwnedVivaryCodeRuns, modelFromRun,
  type VivaryCodeActiveRun, type VivaryCodeProjectHistory, type VivaryCodeWorkspace,
} from "./local-code-agent";

/**
 * The one state a row shows, chosen in this order. Execution, archive and pin stay separate fields, so a row can be
 * archived and failed at once. Native conversations have no approval or stopping state, so they show the rest. Failed
 * and Completed describe the last run for `RESULT_SHOWN_MS` after it ended, then the row reads idle, so the list stays
 * quiet without unread tracking.
 */
export const INBOX_ATTENTION = ["needs-approval", "stopping", "running", "failed", "completed", "idle"] as const;
export type InboxAttention = typeof INBOX_ATTENTION[number];

export type InboxRow = {
  /** `code:<runId>` or `native:<threadId>`, the same identity the routes and saved selections use. */
  id: string;
  kind: "code" | "native";
  projectId: string | null;
  projectLabel: string;
  title: string;
  /** Milliseconds since the epoch. Rows sort by creation, so a background update never moves a row. */
  createdAt: number;
  updatedAt: number;
  /** Code only. Native rows are API chats with their model chosen in the composer. */
  runtime: string | null;
  model: string | null;
  pinned: boolean;
  archived: boolean;
  attention: InboxAttention;
  /** Native only. The owner's own chat scope, which Native's rename, pin and archive routes require. */
  nativeScopeId: string | null;
  /** Unsent text saved for this conversation's next message, and whether its send is pending. */
  draft: "draft" | "pending" | null;
};

/** A conversation that exists only as unsent text: a Code draft key or a Native thread with no saved row yet. */
export type InboxDraft = {
  /** `code-draft:<key>` or `native:<threadId>`, the identity its route and saved selection use. */
  id: string;
  kind: "code" | "native";
  projectId: string | null;
  projectLabel: string;
  preview: string;
  createdAt: number;
  status: "draft" | "pending";
};

export type ConversationInbox = {
  rows: InboxRow[];
  /** New conversations with unsent text, in every listed project, newest first. */
  drafts: InboxDraft[];
  /** Projects whose Code history could not be resolved. Their Native rows still appear. */
  unavailableProjects: string[];
  /** More Native conversations exist than one read returns. */
  limited: boolean;
};

/** A project the caller may read, with its Code history scope when the registry resolved one. */
export type InboxProject = { projectId: string; label: string; code: VivaryCodeProjectHistory | null };

export const PERSONAL_LABEL = "Personal workspace";
const NATIVE_SCOPE_TYPE = "workspace-app";
const MAX_NATIVE_ROWS = 1_000;
export const RESULT_SHOWN_MS = 24 * 60 * 60 * 1000;

/** A finished run's result shows while it is recent. A run with no known end shows nothing. */
function recentResult(result: "failed" | "completed", endedAt: number, now: number): InboxAttention {
  return endedAt > 0 && now - endedAt < RESULT_SHOWN_MS ? result : "idle";
}

/** The row order: pinned first, then newest created. The id breaks ties so the order never depends on read order. */
export function compareInboxRows(left: InboxRow, right: InboxRow): number {
  return Number(right.pinned) - Number(left.pinned) || right.createdAt - left.createdAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * The host's active map decides whether a run works. A record left `running` by an ended host is not running. A Code
 * record has no end time, so its `updatedAt` stands for it. List changes keep `updatedAt`, so they never revive a label.
 */
export function codeAttention(run: Pick<CodeAgentRunRecord, "status" | "updatedAt">, active: VivaryCodeActiveRun | undefined,
  now = Date.now()): InboxAttention {
  if (active) return active.pendingApprovals.length ? "needs-approval" : active.stopping ? "stopping" : "running";
  if (run.status === "errored") return recentResult("failed", timestamp(run.updatedAt), now);
  if (run.status === "completed") return recentResult("completed", timestamp(run.updatedAt), now);
  return "idle";
}

/** Native keeps one `agent_runs` row per turn. Only the newest decides. Pruned history reads as idle. */
export function nativeAttention(latest: { status: string; endedAt: number } | undefined, now = Date.now()): InboxAttention {
  if (latest?.status === "running") return "running";
  if (latest?.status === "errored" || latest?.status === "truncated") return recentResult("failed", latest.endedAt, now);
  if (latest?.status === "completed") return recentResult("completed", latest.endedAt, now);
  return "idle";
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Builds the owner's Code rows. Each run must pass `isOwnedRun` for the project it names, the same check that opens
 * it, so a row never links to a conversation its project cannot open.
 */
export function buildCodeRows(input: { runs: readonly CodeAgentRunRecord[]; ownerEmail: string; orgId?: string;
  projects: readonly InboxProject[]; personal: VivaryCodeWorkspace | null;
  activeRuns: readonly VivaryCodeActiveRun[]; now?: number }): InboxRow[] {
  const active = new Map(input.activeRuns.map(run => [run.id, run]));
  const projects = new Map(input.projects.map(project => [project.projectId, project]));
  return input.runs.flatMap(run => {
    const projectId = typeof run.metadata?.projectId === "string" ? run.metadata.projectId : null;
    const project = projectId === null ? null : projects.get(projectId);
    const scope = projectId === null ? input.personal : project?.code ?? null;
    if (!scope || !isOwnedRun(run, input.ownerEmail, input.orgId, scope)) return [];
    return [{
      id: `code:${run.id}`, kind: "code" as const, projectId, projectLabel: project?.label ?? PERSONAL_LABEL,
      title: run.title || "Untitled conversation", createdAt: timestamp(run.createdAt), updatedAt: timestamp(run.updatedAt),
      runtime: engineLabelFromRun(run), model: modelFromRun(run),
      pinned: typeof run.metadata?.pinnedAt === "string", archived: typeof run.metadata?.archivedAt === "string",
      attention: codeAttention(run, active.get(run.id), input.now), nativeScopeId: null, draft: null,
    }];
  });
}

type NativeRow = { id: unknown; title: unknown; preview: unknown; scope_id: unknown; created_at: unknown;
  updated_at: unknown; pinned_at: unknown; archived_at: unknown };

/**
 * One read of the owner's Native conversations across the given scopes, with the same owner, organization, scope and
 * source filters as Native's own listing and the content search. Empty conversations have no row, as in `listThreads`,
 * except an empty linked target, which `nativeHistoryRows` also lists so it can be found again.
 */
export async function readNativeRows(input: { ownerEmail: string; orgId: string; now?: number;
  scopes: ReadonlyMap<string, { projectId: string | null; label: string }> }): Promise<{ rows: InboxRow[]; limited: boolean }> {
  const scopeIds = [...input.scopes.keys()];
  if (!scopeIds.length) return { rows: [], limited: false };
  // Native creates its tables on first use. This one-row read makes sure they exist before the direct SQL below.
  await listThreads(input.ownerEmail, { scope: { type: NATIVE_SCOPE_TYPE, id: scopeIds[0] }, orgId: input.orgId,
    includeExternal: false, limit: 1 });
  const db = getDbExec();
  const where = `LOWER(t.owner_email) = ? AND (t.org_id = ? OR t.org_id IS NULL) AND t.scope_type = ?
    AND t.scope_id IN (${scopeIds.map(() => "?").join(", ")}) AND t.source_platform IS NULL AND (t.message_count > 0 OR t.source_url = ?)`;
  const args = [input.ownerEmail.toLowerCase(), input.orgId, NATIVE_SCOPE_TYPE, ...scopeIds, LINKED_TARGET_SOURCE_URL];
  const threads = await db.execute({ sql: `SELECT t.id, t.title, t.preview, t.scope_id, t.created_at, t.updated_at,
    t.pinned_at, t.archived_at FROM chat_threads t WHERE ${where}
    ORDER BY CASE WHEN t.pinned_at IS NULL THEN 1 ELSE 0 END, t.created_at DESC, t.id LIMIT ?`,
  args: [...args, MAX_NATIVE_ROWS + 1] });
  const limited = threads.rows.length > MAX_NATIVE_ROWS;
  // The join repeats the owner filter, so a run row can only describe one of these conversations.
  const runs = await db.execute({ sql: `SELECT r.thread_id, r.status, COALESCE(r.completed_at, r.started_at) AS ended_at
    FROM agent_runs r JOIN chat_threads t ON t.id = r.thread_id WHERE ${where} ORDER BY r.started_at DESC`, args });
  const latest = new Map<string, { status: string; endedAt: number }>();
  for (const run of runs.rows) {
    const threadId = String(run.thread_id);
    if (!latest.has(threadId)) latest.set(threadId, { status: String(run.status), endedAt: timestamp(run.ended_at) });
  }
  const rows = (threads.rows.slice(0, MAX_NATIVE_ROWS) as NativeRow[]).flatMap(thread => {
    const scope = input.scopes.get(String(thread.scope_id));
    if (!scope) return [];
    const id = String(thread.id);
    return [{
      id: `native:${id}`, kind: "native" as const, projectId: scope.projectId, projectLabel: scope.label,
      title: String(thread.title || thread.preview || "") || "Untitled conversation",
      createdAt: timestamp(thread.created_at), updatedAt: timestamp(thread.updated_at), runtime: null, model: null,
      pinned: thread.pinned_at != null, archived: thread.archived_at != null, attention: nativeAttention(latest.get(id), input.now),
      nativeScopeId: String(thread.scope_id), draft: null,
    }];
  });
  return { rows, limited };
}

/**
 * The owner's conversations in every given project and Personal workspace: one scan of the Code run records, one
 * Native read, and the host's live state for approvals, Stop and running work. It probes no runtime.
 */
export async function loadConversationInbox(input: { ownerEmail: string; orgId: string;
  projects: readonly InboxProject[]; personal: VivaryCodeWorkspace | null; now?: number }): Promise<ConversationInbox> {
  const now = input.now ?? Date.now();
  const host = await getVivaryCodeHostState(input.ownerEmail, input.orgId);
  const code = buildCodeRows({ runs: listOwnedVivaryCodeRuns(input.ownerEmail, input.orgId), ownerEmail: input.ownerEmail,
    orgId: input.orgId, projects: input.projects, personal: input.personal, activeRuns: host.activeRuns, now });
  const scopes = new Map<string, { projectId: string | null; label: string }>([
    [projectChatScopeId(input.ownerEmail, input.orgId, null), { projectId: null, label: PERSONAL_LABEL }],
    ...input.projects.map(project => [projectChatScopeId(input.ownerEmail, input.orgId, project.projectId),
      { projectId: project.projectId, label: project.label }] as const),
  ]);
  const native = await readNativeRows({ ownerEmail: input.ownerEmail, orgId: input.orgId, scopes, now });
  const rows = [...code, ...native.rows];
  const drafts = await readInboxDrafts(input, new Set(rows.map(row => row.id)));
  return {
    rows: rows.map(row => drafts.onRows.has(row.id) ? { ...row, draft: drafts.onRows.get(row.id)! } : row)
      .sort(compareInboxRows),
    drafts: drafts.drafts.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1)),
    unavailableProjects: input.projects.filter(project => !project.code).map(project => project.projectId),
    limited: native.limited,
  };
}

/**
 * The owner's saved drafts in every listed project, read from the same application-state owner the composers write.
 * A draft whose conversation is listed marks that row. Any other draft is a new conversation not yet sent.
 */
async function readInboxDrafts(input: { ownerEmail: string; orgId: string; projects: readonly InboxProject[];
  personal: VivaryCodeWorkspace | null }, rowIds: ReadonlySet<string>) {
  const onRows = new Map<string, "draft" | "pending">();
  const drafts: InboxDraft[] = [];
  const scopes = [{ projectId: null, label: PERSONAL_LABEL, code: undefined, codeListed: input.personal !== null },
    ...input.projects.map(project => ({ projectId: project.projectId, label: project.label, code: project.code ?? undefined,
      codeListed: project.code !== null }))];
  await Promise.all(scopes.map(async scope => {
    const identity = createVivaryChatIdentity(input.ownerEmail, input.orgId,
      { kind: "project", projectId: scope.projectId, label: scope.label });
    for (const draft of await listNativeChatDrafts(identity, input.ownerEmail, input.orgId)) {
      const id = `native:${draft.threadId}`;
      if (rowIds.has(id)) onRows.set(id, draft.status);
      else drafts.push({ id, kind: "native", projectId: scope.projectId, projectLabel: scope.label,
        preview: draft.preview, createdAt: draft.createdAt, status: draft.status });
    }
    // A project whose Code history cannot resolve lists no Code rows, so its Code drafts wait with them.
    if (!scope.codeListed) return;
    const codeDrafts = await listChatDrafts(createCodeDraftIdentity(input.ownerEmail, input.orgId, scope.projectId));
    const linked = linkedCodeDraftRuns(input.ownerEmail, input.orgId, scope.code, codeDrafts.map(draft => draft.threadId));
    for (const draft of codeDrafts) {
      const run = linked.get(draft.threadId);
      if (run) { onRows.set(`code:${run.id}`, draft.status); continue; }
      const key = codeDraftSelectionKey(scope.projectId, draft.threadId);
      if (key) drafts.push({ id: `code-draft:${key}`, kind: "code", projectId: scope.projectId, projectLabel: scope.label,
        preview: draft.preview, createdAt: draft.createdAt, status: draft.status });
    }
  }));
  return { onRows, drafts };
}

/** Why archive waits. Archive never stops, approves, sends or discards work to make itself possible. */
const ARCHIVE_REFUSALS = {
  approval: "This conversation is waiting for your approval. Answer or stop it, then archive it.",
  working: "This conversation is working. Stop it or let it finish, then archive it.",
  queued: "This conversation has queued messages. Send or remove them, then archive it.",
  sending: "A message to this conversation is still being sent. Wait for it, then archive it.",
} as const;

function refuseArchive(message: string): never {
  fail(message, { errorCode: "vivary_conversation_archive_pending", statusCode: 409 });
}

/**
 * Archives the owner's API chat in one project, the inbox's only archive path for Native. It refuses while a turn
 * runs, while queued messages wait in the thread, or while a send from its draft is pending. Restore stays with
 * `vivary-native-archive`.
 */
export async function archiveNativeConversation(input: { ownerEmail: string; orgId: string; projectId: string | null;
  threadId: string }): Promise<{ archived: true }> {
  const identity = createVivaryChatIdentity(input.ownerEmail, input.orgId,
    { kind: "project", projectId: input.projectId, label: "" });
  const thread = await getThread(input.threadId);
  if (!thread || !threadBelongsToChatIdentity(identity, thread, input.ownerEmail, input.orgId)) {
    fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  }
  const latest = await getDbExec().execute({
    sql: "SELECT status FROM agent_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1", args: [input.threadId] });
  if (latest.rows[0]?.status === "running") refuseArchive(ARCHIVE_REFUSALS.working);
  let queued: unknown;
  try { queued = (JSON.parse(thread.threadData || "{}") as { queuedMessages?: unknown }).queuedMessages; }
  catch { queued = undefined; }
  if (Array.isArray(queued) && queued.length) refuseArchive(ARCHIVE_REFUSALS.queued);
  if ((await readChatDraft(identity, input.threadId))?.status === "pending") refuseArchive(ARCHIVE_REFUSALS.sending);
  // Core's owner filter is case-sensitive, so pass the stored owner after the case-insensitive check.
  if (!await setThreadArchived(input.threadId, true, { ownerEmail: thread.ownerEmail })) {
    fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  }
  return { archived: true };
}

export const MAX_TITLE_LENGTH = 160;
export type CodeConversationChange =
  | { operation: "rename"; title: string }
  | { operation: "archive" | "restore" | "pin" | "unpin" };

/**
 * Changes the owner's Code conversation without touching its run, transcript or folder. Rename writes the record's
 * `title`, which the header, Agent work and search read, and keeps the first generated title as
 * `metadata.generatedTitle`. Archive and pin write `metadata.archivedAt` and `metadata.pinnedAt`. Every change keeps
 * `updatedAt`, so no list reorders. Archive refuses a working conversation, because archive must not stop work and a
 * hidden run would keep its approvals out of sight.
 */
export async function changeCodeConversation(input: { ownerEmail: string; orgId?: string; runId: string;
  projectId: string | null; change: CodeConversationChange }): Promise<{ changed: true }> {
  const owned = listOwnedVivaryCodeRuns(input.ownerEmail, input.orgId).find(run => run.id === input.runId
    && (typeof run.metadata?.projectId === "string" ? run.metadata.projectId : null) === input.projectId);
  if (!owned) fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  if (input.change.operation === "archive") {
    const host = await getVivaryCodeHostState(input.ownerEmail, input.orgId);
    const active = host.activeRuns.find(run => run.id === input.runId);
    if (active?.pendingApprovals.length) refuseArchive(ARCHIVE_REFUSALS.approval);
    if (active) refuseArchive(ARCHIVE_REFUSALS.working);
    // A follow-up whose send is still pending is queued work for this conversation.
    const draftThreadId = owned.metadata?.draftThreadId;
    if (typeof draftThreadId === "string" && input.orgId) {
      const draft = await readChatDraft(createCodeDraftIdentity(input.ownerEmail, input.orgId, input.projectId), draftThreadId);
      if (draft?.status === "pending") refuseArchive(ARCHIVE_REFUSALS.sending);
    }
  }
  const now = new Date().toISOString();
  const change = input.change;
  // The updater reads the record under Core's file lock, so a concurrent worker write keeps its own updatedAt.
  const updated = updateCodeAgentRunRecord(input.runId, record => change.operation === "rename"
    ? { title: change.title.trim(), updatedAt: record.updatedAt,
      metadata: typeof record.metadata?.generatedTitle === "string" ? {} : { generatedTitle: record.title } }
    : { updatedAt: record.updatedAt, metadata: change.operation === "archive" ? { archivedAt: now }
      : change.operation === "restore" ? { archivedAt: null } : { pinnedAt: change.operation === "pin" ? now : null } });
  if (!updated) fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  return { changed: true };
}
