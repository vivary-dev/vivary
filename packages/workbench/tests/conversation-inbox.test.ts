import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodeAgentRunRecord, getCodeAgentRunRecord } from "@agent-native/core/code-agents";

const temporary = await mkdtemp(path.join(os.tmpdir(), "vivary-inbox-"));
const database = "file:" + path.join(temporary, "history.sqlite");
Object.assign(process.env, { APP_NAME: "VivaryInboxTest", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARYINBOXTEST_DATABASE_URL: database, AGENT_NATIVE_CODE_AGENTS_HOME: path.join(temporary, "code") });
const { getDbExec, withMigrationRuntime, closeDbExec } = await import("@agent-native/core/db");
const coreAgentChat = import.meta.resolve("@agent-native/core/client/agent-chat");
const { createThread, updateThreadData, ensureChatThreadTables } = await import(
  new URL("../../chat-threads/store.js", coreAgentChat).href);
const { ensureRunTables } = await import(new URL("../../agent/run-store.js", coreAgentChat).href);
const inbox = await import("../server/conversation-inbox.ts");
const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
const metaAction = (await import("../actions/vivary-code-conversation-meta.ts")).default;
const archiveAction = (await import("../actions/vivary-conversation-archive.ts")).default;
const { changeIndexedChatDraft, createCodeDraftIdentity } = await import("../server/chat-draft.ts");
const { codeDraftThreadId } = await import("../shared/code-draft.ts");
async function saveDraft(identity: { storageKey: string }, threadId: string, text: string, pending = false, user = owner) {
  await asUser(user, orgId, () => changeIndexedChatDraft(identity, threadId, null, pending
    ? { text, status: "pending", submitId: crypto.randomUUID() } : { text, status: "draft", submitId: null }));
}

const owner = "owner@example.test", orgId = "org-a", personalRoot = path.join(temporary, "personal");
const history = (projectId: string) => ({ label: projectId === "alpha" ? "Alpha" : "Beta", projectId,
  bindingId: `binding-${projectId}`, rootId: `root-${projectId}`, bindingRevision: 1 });
const projects = [{ projectId: "alpha", label: "Alpha", code: history("alpha") },
  { projectId: "beta", label: "Beta", code: history("beta") }];
const personal = { root: personalRoot, label: "personal" };
// The scope the meta action resolves for a project's current binding, or for Personal workspace.
const codeChange = (runId: string, projectId: string | null, change: Parameters<typeof inbox.changeCodeConversation>[0]["change"],
  input: Partial<Parameters<typeof inbox.changeCodeConversation>[0]> = {}) => asUser(owner, orgId,
  () => inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId, projectId,
    scope: projectId === null ? personal : history(projectId), change, ...input }));
const { runWithRequestContext } = await import("@agent-native/core/server");
// Drafts live in application state, which Native scopes to the request's user, as an action's request does.
const asUser = <T>(userEmail: string, org: string, work: () => Promise<T>) => runWithRequestContext({ userEmail, orgId: org }, work);
const load = (input: Partial<Parameters<typeof inbox.loadConversationInbox>[0]> = {}) => asUser(input.ownerEmail ?? owner,
  input.orgId ?? orgId, () => inbox.loadConversationInbox({ ownerEmail: owner, orgId, projects, personal, ...input }));

function codeRun(id: string, projectId: string | null, metadata: Record<string, unknown> = {}, status = "completed") {
  createCodeAgentRunRecord({ id, goalId: "vivary-local-code", title: `Code ${id}`, status: status as never,
    cwd: projectId ? path.join(temporary, projectId) : personalRoot, metadata: { app: "vivary-workbench-local-code",
      ownerEmail: owner, orgId, engine: projectId === "beta" ? "codex-cli" : "claude-cli", model: "sonnet",
      workspaceRoot: projectId ? path.join(temporary, projectId) : personalRoot,
      ...(projectId ? { projectId, bindingId: `binding-${projectId}`, rootId: `root-${projectId}`, bindingRevision: 1 } : {}),
      ...metadata } });
}
const nativeScope = (projectId: string | null) =>
  createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: projectId ?? "Personal workspace" }).scope;
async function nativeThread(id: string, scope: { type: string; id: string }, createdAt: number,
  options: { owner?: string; org?: string; messages?: number; sourceUrl?: string } = {}) {
  await createThread(options.owner ?? owner, { id, orgId: options.org ?? orgId, scope });
  if (options.messages !== 0) {
    await updateThreadData(id, JSON.stringify({ headId: `${id}-m`, messages: [
      { message: { id: `${id}-m`, role: "user", content: [{ type: "text", text: "Hello" }] }, parentId: null }] }),
    `Native ${id}`, "Hello", 1);
  }
  await getDbExec().execute({ sql: "UPDATE chat_threads SET created_at = ?, source_url = ? WHERE id = ?",
    args: [createdAt, options.sourceUrl ?? null, id] });
}
const HOUR = 60 * 60 * 1000;
const loadedAt = Date.now();
async function nativeRun(id: string, threadId: string, status: string, startedAt: number, completedAt: number | null = null) {
  await getDbExec().execute({ sql: "INSERT INTO agent_runs (id, thread_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, threadId, status, startedAt, completedAt] });
}
// The host keeps active runs in process memory. The fixture adds one the way a started turn does.
type HostRun = { ownerEmail: string; orgId?: string; stopReason: string | null; workspace: { label: string };
  requests: Map<string, { request: Record<string, unknown> }> };
const host = (globalThis as unknown as Record<symbol, { activeRuns: Map<string, HostRun> }>)[Symbol.for("vivary.workbench.code-host")];
const activate = (runId: string, extra: Partial<HostRun> = {}) => host.activeRuns.set(runId, { ownerEmail: owner, orgId,
  stopReason: null, workspace: { label: "alpha" }, requests: new Map(), ...extra } as HostRun);

test.before(async () => {
  await withMigrationRuntime(async () => { await ensureChatThreadTables(); await ensureRunTables(); });
  codeRun("alpha-old", "alpha");
  codeRun("alpha-failed", "alpha", {}, "errored");
  codeRun("beta-one", "beta");
  codeRun("personal-one", null);
  codeRun("foreign-owner", "alpha", { ownerEmail: "other@example.test" });
  codeRun("foreign-org", "alpha", { orgId: "org-b" });
  codeRun("unlisted-project", "gamma");
  codeRun("stale-binding", "alpha", { bindingId: "binding-old" });
  codeRun("linking", "alpha", { linkedCreationPending: true });
  await nativeThread("native-alpha", nativeScope("alpha"), 3_000);
  await nativeThread("native-beta", nativeScope("beta"), 2_000);
  await nativeThread("native-personal", nativeScope(null), 1_000);
  await nativeThread("native-empty", nativeScope("alpha"), 4_000, { messages: 0 });
  await nativeThread("native-linked-target", nativeScope("alpha"), 5_000, { messages: 0, sourceUrl: "vivary:linked-conversation" });
  await nativeThread("native-foreign-owner", nativeScope("alpha"), 6_000, { owner: "other@example.test" });
  await nativeThread("native-foreign-org", nativeScope("alpha"), 6_000, { org: "org-b" });
  await nativeThread("native-gamma", nativeScope("gamma"), 6_000);
  await nativeThread("native-unassigned", createVivaryChatIdentity(owner, orgId, { kind: "unassigned" }).scope, 6_000);
  await nativeRun("run-1", "native-alpha", "completed", loadedAt - 3 * HOUR, loadedAt - 2 * HOUR);
  await nativeRun("run-2", "native-alpha", "running", loadedAt - HOUR);
  await nativeRun("run-3", "native-beta", "errored", loadedAt - 2 * HOUR, loadedAt - HOUR);
  await nativeRun("run-4", "native-personal", "aborted", loadedAt - 2 * HOUR, loadedAt - HOUR);
  await nativeRun("run-5", "native-foreign-owner", "running", loadedAt - HOUR);
  await nativeRun("run-6", "native-linked-target", "completed", loadedAt - 30 * HOUR, loadedAt - 25 * HOUR);
});
test.after(async () => { host?.activeRuns.clear(); await closeDbExec(); await rm(temporary, { recursive: true, force: true }); });

test("lists the owner's Code and Native conversations across projects and Personal workspace, and nothing else", async () => {
  const result = await load();
  const ids = result.rows.map(row => row.id).sort();
  assert.deepEqual(ids, ["code:alpha-failed", "code:alpha-old", "code:beta-one", "code:personal-one",
    "native:native-alpha", "native:native-beta", "native:native-linked-target", "native:native-personal"]);
  const byId = new Map(result.rows.map(row => [row.id, row]));
  assert.deepEqual(byId.get("code:beta-one"), { ...byId.get("code:beta-one"), kind: "code", projectId: "beta",
    projectLabel: "Beta", title: "Code beta-one", runtime: "Codex CLI", pinned: false, archived: false, nativeScopeId: null });
  assert.equal(byId.get("code:personal-one")?.projectLabel, "Personal workspace");
  assert.equal(byId.get("code:personal-one")?.projectId, null);
  assert.equal(byId.get("native:native-personal")?.projectId, null);
  assert.equal(byId.get("native:native-alpha")?.runtime, null, "API chats show no runtime");
  assert.equal(byId.get("native:native-alpha")?.nativeScopeId, nativeScope("alpha").id);
  assert.deepEqual(result.unavailableProjects, []);
  assert.equal(result.limited, false);
});

test("another owner or organization reads none of these rows", async () => {
  // Each sees only its own run. The other owner's Native thread sits in this owner's scope, so it reaches neither.
  const other = await load({ ownerEmail: "other@example.test" });
  assert.deepEqual(other.rows.map(row => row.id), ["code:foreign-owner"]);
  const org = await load({ orgId: "org-b" });
  assert.deepEqual(org.rows.map(row => row.id), ["code:foreign-org"]);
});

test("a project without resolvable Code history keeps its API chats and is reported", async () => {
  const result = await load({ projects: [projects[0], { ...projects[1], code: null }] });
  assert.equal(result.rows.some(row => row.id === "code:beta-one"), false);
  assert.ok(result.rows.some(row => row.id === "native:native-beta"));
  assert.deepEqual(result.unavailableProjects, ["beta"]);
  const noPersonal = await load({ personal: null });
  assert.equal(noPersonal.rows.some(row => row.id === "code:personal-one"), false);
  assert.ok(noPersonal.rows.some(row => row.id === "native:native-personal"));
});

test("state precedence: approval, stopping, running, failed, completed, idle", async () => {
  const active = (pending: number, stopping: boolean) => ({ id: "x", pendingApprovals: Array(pending).fill({}), stopping }) as never;
  const recent = new Date(loadedAt - HOUR).toISOString();
  assert.equal(inbox.codeAttention({ status: "errored", updatedAt: recent }, active(1, true)), "needs-approval");
  assert.equal(inbox.codeAttention({ status: "running", updatedAt: recent }, active(0, true)), "stopping");
  assert.equal(inbox.codeAttention({ status: "completed", updatedAt: recent }, active(0, false)), "running");
  assert.equal(inbox.codeAttention({ status: "errored", updatedAt: recent }, undefined), "failed");
  assert.equal(inbox.codeAttention({ status: "completed", updatedAt: recent }, undefined), "completed");
  for (const status of ["running", "queued", "paused", "needs-approval", "unknown"] as const) {
    assert.equal(inbox.codeAttention({ status, updatedAt: recent }, undefined), "idle", `${status} without a host run`);
  }
  const native = (status: string | null) => inbox.nativeAttention(status ? { status, endedAt: loadedAt - HOUR } : undefined);
  assert.deepEqual(["running", "errored", "truncated", "completed", "aborted", null].map(native),
    ["running", "failed", "failed", "completed", "idle", "idle"]);
  const rows = new Map((await load()).rows.map(row => [row.id, row.attention]));
  assert.equal(rows.get("native:native-alpha"), "running", "the newest Native turn decides");
  assert.equal(rows.get("native:native-beta"), "failed");
  assert.equal(rows.get("native:native-personal"), "idle");
  assert.equal(rows.get("native:native-linked-target"), "idle", "a result older than 24 hours shows nothing");
  assert.equal(rows.get("code:alpha-failed"), "failed");
  activate("alpha-old", { requests: new Map([["r1", { request: { requestId: "r1", kind: "command" } }]]) });
  activate("beta-one", { stopReason: "user" });
  activate("personal-one");
  try {
    const live = new Map((await load()).rows.map(row => [row.id, row.attention]));
    assert.equal(live.get("code:alpha-old"), "needs-approval");
    assert.equal(live.get("code:beta-one"), "stopping");
    assert.equal(live.get("code:personal-one"), "running");
  } finally { host.activeRuns.clear(); }
});

test("Failed and Completed show for 24 hours after the run ended, for Code and API chat alike", async () => {
  const at = async (offset: number) => new Map((await load({ now: loadedAt + offset })).rows.map(row => [row.id, row.attention]));
  const soon = await at(20 * HOUR);
  assert.deepEqual([soon.get("code:alpha-failed"), soon.get("code:beta-one"), soon.get("native:native-beta")],
    ["failed", "completed", "failed"]);
  const later = await at(26 * HOUR);
  assert.deepEqual([later.get("code:alpha-failed"), later.get("code:beta-one"), later.get("native:native-beta")],
    ["idle", "idle", "idle"]);
  assert.equal(later.get("native:native-alpha"), "running", "running work shows however long it takes");
  const result = inbox.codeAttention({ status: "completed", updatedAt: "not a date" }, undefined);
  assert.equal(result, "idle", "a run with no known end shows nothing");
});

test("drafts in every project are listed, and unsent text on a saved conversation marks its row", async () => {
  await saveDraft(createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "beta", label: "Beta" }),
    "native-new-beta", "Ask about the release");
  await saveDraft(createCodeDraftIdentity(owner, orgId, "alpha"), codeDraftThreadId("alpha", "fresh-alpha"), "Plan it", true);
  await saveDraft(createCodeDraftIdentity(owner, orgId, null), codeDraftThreadId(null, "fresh-personal"), "Personal note");
  await saveDraft(createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "alpha", label: "Alpha" }),
    "native-alpha", "A follow-up");
  // Another owner's draft in the same project never appears.
  await saveDraft(createCodeDraftIdentity("other@example.test", orgId, "alpha"), codeDraftThreadId("alpha", "foreign"), "Not yours",
    false, "other@example.test");
  const result = await load();
  assert.deepEqual(result.drafts.map(draft => [draft.id, draft.kind, draft.projectId, draft.preview, draft.status]).sort(), [
    ["code-draft:fresh-alpha", "code", "alpha", "Plan it", "pending"],
    ["code-draft:fresh-personal", "code", null, "Personal note", "draft"],
    ["native:native-new-beta", "native", "beta", "Ask about the release", "draft"],
  ]);
  assert.equal(result.rows.find(row => row.id === "native:native-alpha")?.draft, "draft");
  assert.equal(result.rows.find(row => row.id === "code:alpha-old")?.draft, null);
  const noBetaCode = await load({ projects: [projects[0], { ...projects[1], code: null }] });
  assert.ok(noBetaCode.drafts.some(draft => draft.id === "native:native-new-beta"), "API chat drafts stay without Code history");
});

test("rows are ordered pinned first, then newest created, and live updates never move them", async () => {
  const first = (await load()).rows.map(row => row.id);
  const sorted = [...(await load()).rows].sort(inbox.compareInboxRows).map(row => row.id);
  assert.deepEqual(first, sorted);
  await getDbExec().execute({ sql: "UPDATE chat_threads SET updated_at = ? WHERE id = ?", args: [Date.now() + 100_000, "native-personal"] });
  assert.deepEqual((await load()).rows.map(row => row.id), first);
});

test("rename, pin and archive keep the conversation's identity, updatedAt and order, and are reversible", async () => {
  const before = getCodeAgentRunRecord("alpha-old")!;
  const order = (await load()).rows.filter(row => !row.pinned).map(row => row.id);
  await codeChange("alpha-old", "alpha", { operation: "rename", title: "  Release plan  " });
  await codeChange("alpha-old", "alpha", { operation: "rename", title: "Release plan v2" });
  await codeChange("alpha-old", "alpha", { operation: "archive" });
  let after = getCodeAgentRunRecord("alpha-old")!;
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.title, "Release plan v2", "the header, Agent work and search read the record's title");
  assert.equal(after.metadata?.generatedTitle, before.title, "the first generated title is kept, not the first rename");
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.status, before.status);
  let row = (await load()).rows.find(item => item.id === "code:alpha-old")!;
  assert.equal(row.title, "Release plan v2");
  assert.equal(row.archived, true);
  assert.deepEqual((await load()).rows.filter(item => !item.pinned).map(item => item.id), order, "archive changes no order");
  await codeChange("alpha-old", "alpha", { operation: "restore" });
  await codeChange("alpha-old", "alpha", { operation: "pin" });
  row = (await load()).rows.find(item => item.id === "code:alpha-old")!;
  assert.deepEqual([row.archived, row.pinned], [false, true]);
  assert.equal((await load()).rows[0].id, "code:alpha-old", "pinned rows lead");
  await codeChange("alpha-old", "alpha", { operation: "unpin" });
  after = getCodeAgentRunRecord("alpha-old")!;
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual((await load()).rows.filter(item => !item.pinned).map(item => item.id), order);
});

test("archive refuses a working conversation and never stops it", async () => {
  activate("beta-one");
  try {
    await assert.rejects(inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "beta-one", projectId: "beta", scope: history("beta"),
      change: { operation: "archive" } }), (error: { statusCode?: number; message: string }) =>
      error.statusCode === 409 && /working\. Stop it or let it finish/.test(error.message));
    assert.ok(host.activeRuns.has("beta-one"), "the run is untouched");
    assert.equal(getCodeAgentRunRecord("beta-one")?.metadata?.archivedAt, undefined);
    await inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "beta-one", projectId: "beta", scope: history("beta"),
      change: { operation: "rename", title: "Renamed while working" } });
  } finally { host.activeRuns.clear(); }
  await codeChange("beta-one", "beta", { operation: "archive" });
  assert.equal(typeof getCodeAgentRunRecord("beta-one")?.metadata?.archivedAt, "string");
});

test("changes refuse another owner's run, another project's run and invalid titles", async () => {
  const refuse = (input: Partial<Parameters<typeof inbox.changeCodeConversation>[0]>) => assert.rejects(
    inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "alpha-failed", projectId: "alpha", scope: history("alpha"),
      change: { operation: "pin" }, ...input }), (error: { statusCode?: number }) => error.statusCode === 404);
  await refuse({ runId: "foreign-owner" });
  await refuse({ runId: "foreign-org" });
  await refuse({ projectId: "beta" });
  await refuse({ ownerEmail: "other@example.test" });
  await refuse({ runId: "missing" });
  assert.equal(metaAction.schema.safeParse({ operation: "rename", runId: "a", projectId: null, title: "  " }).success, false);
  assert.equal(metaAction.schema.safeParse({ operation: "rename", runId: "a", projectId: null, title: "x".repeat(161) }).success, false);
  assert.equal(metaAction.schema.safeParse({ operation: "delete", runId: "a", projectId: null }).success, false);
});

test("API chat archive waits for a running turn, queued messages and a pending send, and restore keeps identity and order", async () => {
  const archive = (threadId: string, projectId: string | null = "beta", user = owner) => asUser(user, orgId,
    () => inbox.changeNativeConversation({ ownerEmail: user, orgId, projectId, threadId, change: { operation: "archive" } }));
  const refused = (pattern: RegExp) => (error: { statusCode?: number; errorCode?: string; message: string }) =>
    error.statusCode === 409 && error.errorCode === "vivary_conversation_archive_pending" && pattern.test(error.message);
  const before = (await load()).rows.filter(row => !row.archived).map(row => row.id);
  await assert.rejects(archive("native-alpha", "alpha"), refused(/is working/), "a running turn blocks archive");
  const thread = await getDbExec().execute({ sql: "SELECT thread_data FROM chat_threads WHERE id = ?", args: ["native-beta"] });
  const data = JSON.parse(String(thread.rows[0].thread_data));
  await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data = ? WHERE id = ?",
    args: [JSON.stringify({ ...data, queuedMessages: [{ id: "q1", text: "Next" }] }), "native-beta"] });
  await assert.rejects(archive("native-beta"), refused(/queued messages/));
  await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data = ? WHERE id = ?",
    args: [JSON.stringify({ ...data, queuedMessages: [] }), "native-beta"] });
  const betaChat = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "beta", label: "Beta" });
  await saveDraft(betaChat, "native-beta", "Sending now", true);
  await assert.rejects(archive("native-beta"), refused(/still being sent/));
  await asUser(owner, orgId, async () => {
    const { readChatDraft } = await import("../server/chat-draft.ts");
    await changeIndexedChatDraft(betaChat, "native-beta", await readChatDraft(betaChat, "native-beta"),
      { text: "", status: "cleared", submitId: null });
  });
  await assert.rejects(archive("native-beta", "beta", "other@example.test"), (error: { statusCode?: number }) => error.statusCode === 404,
    "another owner cannot archive it");
  await assert.rejects(archive("native-beta", "alpha"), (error: { statusCode?: number }) => error.statusCode === 404,
    "the wrong project cannot archive it");
  assert.deepEqual(await archive("native-beta"), { changed: true });
  assert.equal((await load()).rows.find(row => row.id === "native:native-beta")?.archived, true);
  const { restoreArchivedNativeChat } = await import("../server/native-archive.ts");
  await restoreArchivedNativeChat(betaChat, "native-beta", owner, orgId);
  assert.deepEqual((await load()).rows.filter(row => !row.archived).map(row => row.id), before, "restore keeps the place");
});

test("Code archive also waits for an approval and a pending send", async () => {
  const change = () => asUser(owner, orgId, () => inbox.changeCodeConversation({ ownerEmail: owner, orgId,
    runId: "alpha-failed", projectId: "alpha", scope: history("alpha"), change: { operation: "archive" } }));
  activate("alpha-failed", { requests: new Map([["r1", { request: { requestId: "r1", kind: "command" } }]]) });
  try {
    await assert.rejects(change(), (error: { statusCode?: number; message: string }) =>
      error.statusCode === 409 && /waiting for your approval/.test(error.message));
  } finally { host.activeRuns.clear(); }
  const { updateCodeAgentRunRecord } = await import("@agent-native/core/code-agents");
  const draftThreadId = codeDraftThreadId("alpha", "follow-up");
  updateCodeAgentRunRecord("alpha-failed", record => ({ metadata: { draftThreadId }, updatedAt: record.updatedAt }));
  await saveDraft(createCodeDraftIdentity(owner, orgId, "alpha"), draftThreadId, "Next step", true);
  await assert.rejects(change(), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && /still being sent/.test(error.message));
  assert.equal(getCodeAgentRunRecord("alpha-failed")?.metadata?.archivedAt, undefined, "nothing was archived");
});

test("API chat rename and pin keep its messages, survive a generated title and refuse another project", async () => {
  const change = (change: Parameters<typeof inbox.changeNativeConversation>[0]["change"], projectId: string | null = null) =>
    asUser(owner, orgId, () => inbox.changeNativeConversation({ ownerEmail: owner, orgId, projectId,
      threadId: "native-personal", change }));
  assert.deepEqual(await change({ operation: "rename", title: "  Personal   plan " }), { changed: true });
  const saved = await getDbExec().execute({ sql: "SELECT title, thread_data FROM chat_threads WHERE id = ?",
    args: ["native-personal"] });
  const data = JSON.parse(String(saved.rows[0].thread_data));
  assert.equal(saved.rows[0].title, "Personal plan");
  assert.equal(data._titleOverride, "Personal plan", "a later generated title keeps the owner's");
  assert.equal(data.messages.length, 1, "the messages stay");
  await change({ operation: "pin" });
  let row = (await load()).rows.find(item => item.id === "native:native-personal")!;
  assert.deepEqual([row.title, row.pinned], ["Personal plan", true]);
  await change({ operation: "unpin" });
  row = (await load()).rows.find(item => item.id === "native:native-personal")!;
  assert.equal(row.pinned, false);
  await assert.rejects(change({ operation: "pin" }, "alpha"), (error: { statusCode?: number }) => error.statusCode === 404);
  await change({ operation: "archive" });
  assert.equal((await load()).rows.find(item => item.id === "native:native-personal")?.archived, true);
  assert.deepEqual(await change({ operation: "restore" }), { changed: true }, "restore needs no Code history");
  assert.equal((await load()).rows.find(item => item.id === "native:native-personal")?.archived, false);
});

test("a Code change follows the project's current binding, so a replaced binding's conversation is read-only", async () => {
  const refused = (error: { statusCode?: number }) => error.statusCode === 404;
  await assert.rejects(codeChange("stale-binding", "alpha", { operation: "archive" }), refused);
  await assert.rejects(codeChange("stale-binding", "alpha", { operation: "rename", title: "Kept" }), refused);
  assert.equal(getCodeAgentRunRecord("stale-binding")?.metadata?.archivedAt, undefined);
  await assert.rejects(codeChange("alpha-failed", "alpha", { operation: "pin" },
    { scope: { ...history("alpha"), bindingId: "binding-replaced" } }), refused, "a rebound project refuses its old runs");
  await codeChange("personal-one", null, { operation: "pin" });
  await codeChange("personal-one", null, { operation: "unpin" });
});

test("an API chat change needs the project in the owner's current catalog", () => {
  const catalog = { code: "catalog", projects: [{ projectId: "beta" }] };
  const denied = (error: { statusCode?: number }) => error.statusCode === 403;
  assert.throws(() => inbox.requireCatalogProject(catalog, "alpha"), denied, "a project that left the catalog is not writable");
  assert.throws(() => inbox.requireCatalogProject({ code: "registry-unavailable" }, "beta"), denied);
  inbox.requireCatalogProject(catalog, "beta");
  assert.equal(typeof archiveAction.run, "function");
});

test("Code archive resolves a legacy draft ID from the transcript, so a row showing Review send is not archived", async () => {
  const { appendCodeAgentTranscriptEvent } = await import("@agent-native/core/code-agents");
  const draftThreadId = codeDraftThreadId("beta", "legacy-follow-up");
  codeRun("legacy-draft", "beta");
  appendCodeAgentTranscriptEvent({ runId: "legacy-draft", kind: "user", message: "First ask", metadata: { draftThreadId } });
  await saveDraft(createCodeDraftIdentity(owner, orgId, "beta"), draftThreadId, "Next step", true);
  assert.equal((await load()).rows.find(row => row.id === "code:legacy-draft")?.draft, "pending", "the row shows Review send");
  await assert.rejects(codeChange("legacy-draft", "beta", { operation: "archive" }),
    (error: { statusCode?: number; message: string }) => error.statusCode === 409 && /still being sent/.test(error.message));
  assert.equal(getCodeAgentRunRecord("legacy-draft")?.metadata?.archivedAt, undefined, "nothing was archived");
});

test("database timestamps read as epoch milliseconds whether the driver returns numbers or numeric strings", () => {
  assert.equal(inbox.epochMilliseconds(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(inbox.epochMilliseconds("1700000000000"), 1_700_000_000_000, "a Postgres BIGINT string is not a date string");
  assert.equal(inbox.epochMilliseconds("2024"), 2024, "a short numeric string is not a calendar year");
  assert.equal(inbox.epochMilliseconds("2026-10-20T00:00:00.000Z"), Date.parse("2026-10-20T00:00:00.000Z"));
  assert.equal(inbox.epochMilliseconds(null), 0);
  assert.equal(inbox.epochMilliseconds("not a time"), 0);
});

test("message search keeps a project's API chats searchable when its Code history is unavailable", async () => {
  const { chatSearchScope } = await import("../actions/vivary-chat-search.ts");
  const unavailable = Object.assign(new Error("This project's conversation history is unavailable."),
    { statusCode: 409, errorCode: "vivary_code_project_history_unavailable" });
  const catalog = { code: "catalog", projects: [{ projectId: "alpha", displayName: "Alpha" }] };
  const deps = (history: () => Promise<unknown>) => ({ projectHistory: history, workspace: async () => personal,
    catalog: async () => catalog });
  const refused = await chatSearchScope({ projectId: "alpha", unassigned: false }, deps(() => Promise.reject(unavailable)));
  assert.deepEqual(refused, { codeScope: undefined, label: "Alpha" }, "Native search runs and Code reads as unavailable");
  await assert.rejects(chatSearchScope({ projectId: "gone", unassigned: false }, deps(() => Promise.reject(unavailable))),
    (error: { statusCode?: number }) => error.statusCode === 403, "a project outside the catalog stays unsearchable");
  const denied = Object.assign(new Error("Denied"), { statusCode: 403 });
  await assert.rejects(chatSearchScope({ projectId: "alpha", unassigned: false }, deps(() => Promise.reject(denied))),
    (error: { statusCode?: number }) => error.statusCode === 403);
  const found = await chatSearchScope({ projectId: "alpha", unassigned: false }, deps(async () => history("alpha")));
  assert.deepEqual(found, { codeScope: history("alpha"), label: "Alpha" });
  assert.deepEqual(await chatSearchScope({ projectId: null, unassigned: false }, deps(async () => undefined)),
    { codeScope: personal, label: "personal" });
  assert.deepEqual(await chatSearchScope({ projectId: null, unassigned: true }, deps(async () => undefined)),
    { codeScope: undefined, label: "Unassigned" });
});

test("Code archive that meets a send admitted during its checks is undone and refused", async () => {
  codeRun("race-code", "alpha");
  // The run turns active only once its record says archived: a send admitted after the checks, before the write.
  const runs = host.activeRuns as Map<string, HostRun> & { [Symbol.iterator]: () => IterableIterator<[string, HostRun]> };
  const late = { ownerEmail: owner, orgId, stopReason: null, workspace: { label: "alpha" }, requests: new Map() } as HostRun;
  runs[Symbol.iterator] = function* () {
    yield* Map.prototype.entries.call(runs);
    if (getCodeAgentRunRecord("race-code")?.metadata?.archivedAt) yield ["race-code", late];
  };
  try {
    await assert.rejects(codeChange("race-code", "alpha", { operation: "archive" }),
      (error: { statusCode?: number; message: string }) => error.statusCode === 409 && /is working/.test(error.message));
  } finally { delete (runs as Partial<typeof runs>)[Symbol.iterator]; }
  assert.equal(getCodeAgentRunRecord("race-code")?.metadata?.archivedAt ?? null, null, "the archive was undone");
});

test("API chat archive that meets a turn started during its checks is undone and refused", async () => {
  await nativeThread("race-native", nativeScope(null), 7_000);
  const db = getDbExec() as { execute: (query: { sql: string; args: unknown[] }) => Promise<unknown> };
  const execute = db.execute;
  db.execute = async query => {
    const result = await execute.call(db, query);
    // A turn starts right after the archive write lands.
    if (/^\s*UPDATE chat_threads SET archived_at/i.test(query.sql) && query.args[0] != null) {
      await execute.call(db, { sql: "INSERT INTO agent_runs (id, thread_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
        args: ["race-run", "race-native", "running", Date.now(), null] });
    }
    return result;
  };
  try {
    await assert.rejects(asUser(owner, orgId, () => inbox.changeNativeConversation({ ownerEmail: owner, orgId,
      projectId: null, threadId: "race-native", change: { operation: "archive" } })),
    (error: { statusCode?: number; message: string }) => error.statusCode === 409 && /is working/.test(error.message));
  } finally { db.execute = execute; }
  assert.equal((await load()).rows.find(row => row.id === "native:race-native")?.archived, false, "the archive was undone");
});
