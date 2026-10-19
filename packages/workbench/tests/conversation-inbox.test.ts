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

const owner = "owner@example.test", orgId = "org-a", personalRoot = path.join(temporary, "personal");
const history = (projectId: string) => ({ label: projectId === "alpha" ? "Alpha" : "Beta", projectId,
  bindingId: `binding-${projectId}`, rootId: `root-${projectId}`, bindingRevision: 1 });
const projects = [{ projectId: "alpha", label: "Alpha", code: history("alpha") },
  { projectId: "beta", label: "Beta", code: history("beta") }];
const personal = { root: personalRoot, label: "personal" };
const load = (input: Partial<Parameters<typeof inbox.loadConversationInbox>[0]> = {}) =>
  inbox.loadConversationInbox({ ownerEmail: owner, orgId, projects, personal, ...input });

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
async function nativeRun(id: string, threadId: string, status: string, startedAt: number) {
  await getDbExec().execute({ sql: "INSERT INTO agent_runs (id, thread_id, status, started_at) VALUES (?, ?, ?, ?)",
    args: [id, threadId, status, startedAt] });
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
  await nativeRun("run-1", "native-alpha", "completed", 10);
  await nativeRun("run-2", "native-alpha", "running", 20);
  await nativeRun("run-3", "native-beta", "errored", 10);
  await nativeRun("run-4", "native-personal", "aborted", 10);
  await nativeRun("run-5", "native-foreign-owner", "running", 10);
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
  assert.equal(inbox.codeAttention({ status: "errored" }, active(1, true)), "needs-approval");
  assert.equal(inbox.codeAttention({ status: "running" }, active(0, true)), "stopping");
  assert.equal(inbox.codeAttention({ status: "completed" }, active(0, false)), "running");
  assert.equal(inbox.codeAttention({ status: "errored" }, undefined), "failed");
  assert.equal(inbox.codeAttention({ status: "completed" }, undefined), "completed");
  for (const status of ["running", "queued", "paused", "needs-approval", "unknown"] as const) {
    assert.equal(inbox.codeAttention({ status }, undefined), "idle", `${status} without a host run`);
  }
  assert.deepEqual(["running", "errored", "truncated", "completed", "aborted", null].map(inbox.nativeAttention),
    ["running", "failed", "failed", "completed", "idle", "idle"]);
  const rows = new Map((await load()).rows.map(row => [row.id, row.attention]));
  assert.equal(rows.get("native:native-alpha"), "running", "the newest Native turn decides");
  assert.equal(rows.get("native:native-beta"), "failed");
  assert.equal(rows.get("native:native-personal"), "idle");
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
  const ctx = { userEmail: owner, orgId };
  await metaAction.run({ operation: "rename", runId: "alpha-old", projectId: "alpha", title: "  Release plan  " }, ctx as never);
  await metaAction.run({ operation: "archive", runId: "alpha-old", projectId: "alpha" }, ctx as never);
  let after = getCodeAgentRunRecord("alpha-old")!;
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.title, before.title, "the generated title stays as history");
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.status, before.status);
  let row = (await load()).rows.find(item => item.id === "code:alpha-old")!;
  assert.equal(row.title, "Release plan");
  assert.equal(row.archived, true);
  assert.deepEqual((await load()).rows.filter(item => !item.pinned).map(item => item.id), order, "archive changes no order");
  await metaAction.run({ operation: "restore", runId: "alpha-old", projectId: "alpha" }, ctx as never);
  await metaAction.run({ operation: "pin", runId: "alpha-old", projectId: "alpha" }, ctx as never);
  row = (await load()).rows.find(item => item.id === "code:alpha-old")!;
  assert.deepEqual([row.archived, row.pinned], [false, true]);
  assert.equal((await load()).rows[0].id, "code:alpha-old", "pinned rows lead");
  await metaAction.run({ operation: "unpin", runId: "alpha-old", projectId: "alpha" }, ctx as never);
  after = getCodeAgentRunRecord("alpha-old")!;
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual((await load()).rows.filter(item => !item.pinned).map(item => item.id), order);
});

test("archive refuses a working conversation and never stops it", async () => {
  activate("beta-one");
  try {
    await assert.rejects(inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "beta-one", projectId: "beta",
      change: { operation: "archive" } }), (error: { statusCode?: number; message: string }) =>
      error.statusCode === 409 && /working\. Stop it or let it finish/.test(error.message));
    assert.ok(host.activeRuns.has("beta-one"), "the run is untouched");
    assert.equal(getCodeAgentRunRecord("beta-one")?.metadata?.archivedAt, undefined);
    await inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "beta-one", projectId: "beta",
      change: { operation: "rename", title: "Renamed while working" } });
  } finally { host.activeRuns.clear(); }
  await inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "beta-one", projectId: "beta",
    change: { operation: "archive" } });
  assert.equal(typeof getCodeAgentRunRecord("beta-one")?.metadata?.archivedAt, "string");
});

test("changes refuse another owner's run, another project's run and invalid titles", async () => {
  const refuse = (input: Partial<Parameters<typeof inbox.changeCodeConversation>[0]>) => assert.rejects(
    inbox.changeCodeConversation({ ownerEmail: owner, orgId, runId: "alpha-failed", projectId: "alpha",
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
