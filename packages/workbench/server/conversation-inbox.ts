import { fail } from "@agent-native/core/action";
import { updateCodeAgentRunRecord, type CodeAgentRunRecord } from "@agent-native/core/code-agents";
import { getDbExec } from "@agent-native/core/db";
import { listThreads } from "@agent-native/core/server";
import { LINKED_TARGET_SOURCE_URL } from "../shared/linked-conversation";
import { projectChatScopeId } from "./chat-project-scope.mjs";
import {
  engineLabelFromRun, getVivaryCodeHostState, isOwnedRun, listOwnedVivaryCodeRuns, modelFromRun,
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
};

export type ConversationInbox = {
  rows: InboxRow[];
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
      attention: codeAttention(run, active.get(run.id), input.now), nativeScopeId: null,
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
      nativeScopeId: String(thread.scope_id),
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
  return {
    rows: [...code, ...native.rows].sort(compareInboxRows),
    unavailableProjects: input.projects.filter(project => !project.code).map(project => project.projectId),
    limited: native.limited,
  };
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
    if (host.activeRuns.some(run => run.id === input.runId)) {
      fail("This conversation is working. Stop it or let it finish, then archive it.", {
        errorCode: "vivary_code_archive_active", statusCode: 409 });
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
