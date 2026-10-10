import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the real Native action definitions and HTTP transport. Only the
// authenticated owner resolver and deterministic engine/MCP dependencies are
// injected. Every profile, membership, approval and effect belongs to this DB.
const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval-owner-scope-"));
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
let server;
let approvalFixture;
// Register disposal before importing Native or awaiting schema initialization.
after(async () => {
  globalThis.fetch = nativeFetch;
  approvalFixture?.runner.setAutomationApprovalDependencies(null);
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  globalThis.setTimeout = nativeSetTimeout;
  await rm(root, { recursive: true, force: true });
});
const url = `file:${path.join(root, "scope.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary",
  // Supported Native controls apply to this entire isolated test process.
  // HTTP and explicit approval/recovery calls remain live. Unrelated lazy pollers do not own this fixture.
  AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: "true", AGENT_NATIVE_DISABLE_RECURRING_JOBS: "true",
  DATABASE_URL: url, DATABASE_URL_UNPOOLED: url,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
approvalFixture = await import("./fixtures/automation-approval-fixture.mjs");
const { makeApprovalCase, actor, owner, appId, mcpName, runner, history, threads,
  approvalStore, resources, frontmatter, service, database, runStore, loadCore, until } = approvalFixture;
const { H3, toNodeHandler } = await import("h3");
const { mountActionRoutes } = await loadCore("server/action-routes.js");
const { default: listAction } = await loadCore("jobs/actions/list-automation-runs.js");
const { default: inspectAction } = await loadCore("jobs/actions/inspect-automation-run.js");
const { default: decideAction } = await loadCore("jobs/actions/decide-automation-approval.js");
const { default: recurringAction } = await loadCore("jobs/actions/manage-recurring-job.js");
const { createResourceScriptEntries } = await loadCore("server/agent-chat/script-entries.js");
const { context: requestContext } = approvalFixture;
const resourceScripts = await createResourceScriptEntries();
assert.equal(typeof resourceScripts.resources?.run, "function", "Native provides its actual personal-chat resources entry");
const { setActiveOrgId } = await loadCore("org/active-org.js");
const { resolveOrgIdForEmail } = await loadCore("org/context.js");
const orgId = "approval-owned-organization";
const unrelatedOrg = "approval-unrelated-active-organization";
const otherOwner = "another-approval-owner@example.test";
const nitroApp = { h3: new H3() };
const { runBetterAuthMigrations } = await loadCore("server/better-auth-migrations.js");
const { runMigrations } = await loadCore("db/migrations.js");
const { ORG_MIGRATIONS } = await loadCore("org/migrations.js");
// These are the same initialization owners used by Native's auth and org
// plugins. Await their complete schema before rows or action routes exist.
await runBetterAuthMigrations(nitroApp);
await runMigrations(ORG_MIGRATIONS, { table: "_org_migrations" })(nitroApp);
const db = database.getDbExec();
const seededAt = Date.now();
for (const email of [owner, otherOwner]) await db.execute({
  sql: 'INSERT INTO "user" (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  args: [email, email, "Fixture owner", seededAt, seededAt] });
for (const id of [orgId, unrelatedOrg]) {
  await db.execute({ sql: "INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
    args: [id, id, owner, seededAt] });
  await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
    args: ["membership-" + id, id, owner, "owner", seededAt] });
}
await setActiveOrgId(owner, unrelatedOrg, "approval transport fixture setup");

// Resources use Native getSession, not the action-only owner resolver below.
// BYOA is Native's supported authentication seam for the stored fixture users.
let resourceSessionHits = 0;
const { createAuthPlugin } = await loadCore("server/auth-plugin.js");
const { markDefaultPluginProvided } = await loadCore("server/framework-request-handler.js");
markDefaultPluginProvided(nitroApp, "resources");
createAuthPlugin({ getSession: async event => {
  const email = event.headers.get("x-fixture-owner");
  if (![owner, otherOwner].includes(email)) return null;
  resourceSessionHits++;
  return { email, emailVerified: true };
} })(nitroApp);
const { createResourcesPlugin } = await loadCore("server/resources-plugin.js");
await createResourcesPlugin()(nitroApp);

const actions = { "list-automation-runs": listAction, "inspect-automation-run": inspectAction, "decide-automation-approval": decideAction, "manage-recurring-job": recurringAction };
const resolveOwner = async event => {
  const email = event.headers.get("x-fixture-owner") ?? owner;
  assert.ok([owner, otherOwner].includes(email), "fixture identity resolver recognizes only stored users");
  return email;
};
mountActionRoutes(nitroApp, actions, { appId, getOwnerFromEvent: resolveOwner });
mountActionRoutes(nitroApp, actions, { appId: "wrong-app", getOwnerFromEvent: resolveOwner,
  routePrefix: "/wrong-app/_agent-native/actions" });
// A previously authenticated organization session can outlive membership.
// Its retained org context must still fail the current membership read.
mountActionRoutes(nitroApp, actions, { appId, getOwnerFromEvent: resolveOwner,
  resolveOrgId: async () => orgId, routePrefix: "/retained-org/_agent-native/actions" });
server = createServer(toNodeHandler(nitroApp.h3));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (input, options) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  assert.equal(target.origin, origin, "fixture forbids all outward network calls");
  // Isolate fixture requests from connections left idle between assertions.
  const headers = new Headers(options?.headers !== undefined ? options.headers : input instanceof Request ? input.headers : undefined);
  headers.set("Connection", "close");
  return nativeFetch(input, { ...options, headers });
};
async function call(name, input, { email = owner, prefix = "" } = {}) {
  const inspect = name === "inspect-automation-run" || name === "list-automation-runs";
  const response = await fetch(`${origin}${prefix}/_agent-native/actions/${name}${inspect ? "?" + new URLSearchParams(input) : ""}`, {
    method: inspect ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-owner": email },
    ...(inspect ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
const effects = fixture => fixture.calls.filter(call => call.name === mcpName).length;
async function ready(name, organization = false) {
  const fixture = await makeApprovalCase(name);
  if (organization) {
    await service.defineAutomation({ ...actor, orgId }, { scope: "organization", name,
      body: fixture.automation.body, triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC", mcpTools: [mcpName] });
    const resource = await resources.resourceGetByPath(resources.organizationResourceOwner(orgId), `jobs/${name}.md`);
    fixture.automation = { name, resource, ...frontmatter.parseJobResource(resource.content) };
    Object.assign(fixture.options, { automation: fixture.automation, orgId, requestContext: { userEmail: owner, orgId } });
  }
  runner.setAutomationApprovalDependencies(fixture.deps);
  const result = await fixture.start();
  assert.equal(result.status, "waiting_approval");
  const pending = await fixture.pending(result.historyId);
  return { fixture, result, pending, decision: { historyId: result.historyId, askId: pending.askId } };
}

for (const decision of ["decline", "approve"]) test(`normal HTTP owner with active organization can inspect and ${decision} a personal wait`, async () => {
  assert.equal(await resolveOrgIdForEmail(owner), unrelatedOrg, "the normal route will backfill a real active organization");
  const { fixture, result, pending, decision: input } = await ready(`http-personal-${decision}`);
  assert.equal((await history.getAutomationRun(result.historyId)).orgId, null);
  assert.equal((await threads.getThread(result.threadId)).orgId ?? null, null);
  const inspected = await call("inspect-automation-run", { historyId: result.historyId });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.run.id, result.historyId);
  assert.equal(inspected.body.run.threadId, result.threadId);
  assert.equal(inspected.body.pending.askId, pending.askId);
  const settled = await call("decide-automation-approval", { ...input, decision });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  const final = await fixture.terminal(result.historyId);
  assert.equal(final.status, decision === "approve" ? "success" : "declined");
  assert.equal(final.id, result.historyId);
  assert.equal(final.threadId, result.threadId);
  if (decision === "approve") {
    const freshInspection = await call("inspect-automation-run", { historyId: result.historyId });
    assert.equal(freshInspection.status, 200);
    const repository = JSON.parse(freshInspection.body.threadData);
    const finalAssistant = repository.messages.map(item => item.message ?? item)
      .filter(message => message.role === "assistant").at(-1);
    const visibleText = finalAssistant.content.filter(part => part.type === "text")
      .map(part => part.text).join("");
    assert.match(visibleText, /Automation complete\./,
      "the normal HTTP owner route freshly reads the persisted final answer");
  }
  const retained = await fixture.pending(result.historyId);
  assert.equal(retained.turnId, pending.turnId);
  const thread = await threads.getThread(result.threadId);
  assert.equal((await runStore.getRunTurnRef(final.runId)).turnId, pending.turnId);
  if (decision === "approve") assert.notEqual(final.runId, result.runId);
  const transcript = JSON.parse(thread.threadData);
  assert.equal(transcript.messages.filter(item => (item.message ?? item).role === "user").length, 1);
  assert.equal(transcript.messages.filter(item => (item.message ?? item).role === "assistant").length, 1);
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, decision === "approve" ? "consumed" : "declined");
  assert.equal(effects(fixture), decision === "approve" ? 1 : 0);
  assert.equal(fixture.calls.filter(call => call.name === "resources").length, 1, "the original local step is never replayed");
  const models = fixture.modelCalls.length;
  const duplicate = await call("decide-automation-approval", { ...input, decision });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /no longer waiting/);
  assert.equal(effects(fixture), decision === "approve" ? 1 : 0);
  assert.equal(fixture.modelCalls.length, models);
  const rows = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  assert.deepEqual(rows.map(run => run.id), [result.historyId]);
});

test("normal HTTP personal approval still refuses another owner and another app", async () => {
  const { fixture, result, pending, decision } = await ready("http-personal-refusals");
  const modelsBefore = fixture.modelCalls.length;
  for (const options of [{ email: otherOwner }, { prefix: "/wrong-app" }]) {
    for (const [action, input] of [["inspect-automation-run", { historyId: result.historyId }],
      ["decide-automation-approval", { ...decision, decision: "approve" }]]) {
      const refused = await call(action, input, options);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /not available to this owner/);
    }
  }
  assert.equal((await history.getAutomationRun(result.historyId)).status, "waiting_approval");
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
  assert.equal(effects(fixture), 0);
  assert.equal(fixture.modelCalls.length, modelsBefore, "refused transport calls never resume the model");
  assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
});

test("normal HTTP organization approvals require the persisted organization and current membership", async () => {
  const { fixture, result, pending, decision } = await ready("http-organization-refusals", true);
  assert.equal((await history.getAutomationRun(result.historyId)).orgId, orgId);
  const modelsBefore = fixture.modelCalls.length;
  for (const action of ["inspect-automation-run", "decide-automation-approval"]) {
    const input = action === "inspect-automation-run" ? { historyId: result.historyId } : { ...decision, decision: "approve" };
    const wrongScope = await call(action, input);
    assert.equal(wrongScope.status, 409);
    assert.match(wrongScope.body.error, /not available to this owner/);
  }
  await setActiveOrgId(owner, orgId, "approval organization positive control");
  assert.equal((await call("inspect-automation-run", { historyId: result.historyId })).status, 200);
  await db.execute({ sql: "DELETE FROM org_members WHERE org_id = ? AND email = ?", args: [orgId, owner] });
  for (const action of ["inspect-automation-run", "decide-automation-approval"]) {
    const input = action === "inspect-automation-run" ? { historyId: result.historyId } : { ...decision, decision: "approve" };
    const removedMember = await call(action, input, { prefix: "/retained-org" });
    assert.equal(removedMember.status, 409);
    assert.match(removedMember.body.error, /no longer a member/);
  }
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "waiting_approval");
  assert.equal(effects(fixture), 0);
  assert.equal(fixture.modelCalls.length, modelsBefore, "scope and membership refusals never resume the model");
  await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)", args: ["membership-" + orgId, orgId, owner, "owner", Date.now()] });
  assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
  assert.equal((await fixture.terminal(result.historyId)).status, "declined");
  assert.equal(effects(fixture), 0);
  await setActiveOrgId(owner, unrelatedOrg, "restore fixture active organization");
});

test("normal HTTP organization history advertises inspection only to its retained execution owner", async () => {
  const { fixture, result, pending, decision } = await ready("http-org-inspection-capability", true);
  const membershipId = "inspection-second-member";
  await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
    args: [membershipId, orgId, otherOwner, "member", Date.now()] });
  await setActiveOrgId(owner, orgId, "inspection owner capability control");
  await setActiveOrgId(otherOwner, orgId, "inspection member capability control");
  const input = { name: fixture.automation.name, scope: "organization", includePendingApprovals: "true" };
  const counts = [fixture.modelCalls.length, fixture.calls.length];
  try {
    for (const status of ["waiting_approval", "declined"]) {
      if (status === "declined") assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
      const before = await custodySnapshot(fixture.automation.resource, result.historyId, pending);
      const originalExecute = db.execute, execute = originalExecute.bind(db);
      let listWrites = 0, ownerList, memberList;
      db.execute = async statement => {
        const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
        if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) listWrites++;
        return execute(statement);
      };
      try {
        ownerList = await call("list-automation-runs", input);
        memberList = await call("list-automation-runs", input, { email: otherOwner });
      } finally { db.execute = originalExecute; }
      assert.equal(ownerList.status, 200); assert.equal(memberList.status, 200);
      const owned = ownerList.body.find(row => row.id === result.historyId);
      const shared = memberList.body.find(row => row.id === result.historyId);
      assert.ok(owned); assert.ok(shared, "current members still see shared organization history");
      assert.equal(owned.status, status); assert.equal(shared.status, status);
      assert.equal(owned.canInspect, true); assert.equal(shared.canInspect, false);
      assert.equal(listWrites, 0, "capability discovery is read-only, including terminal history");
      assert.deepEqual(await custodySnapshot(fixture.automation.resource, result.historyId, pending), before);
      assert.equal((await call("inspect-automation-run", { historyId: result.historyId })).status, 200);
      for (const [action, request] of [["inspect-automation-run", { historyId: result.historyId }],
        ["decide-automation-approval", { ...decision, decision: "approve" }]]) {
        const denied = await call(action, request, { email: otherOwner });
        assert.equal(denied.status, 409); assert.match(denied.body.error, /not available to this owner/);
      }
      assert.deepEqual([fixture.modelCalls.length, fixture.calls.length], counts); assert.equal(effects(fixture), 0);
    }
    await db.execute({ sql: "DELETE FROM org_members WHERE id = ?", args: [membershipId] });
    assert.notEqual((await call("list-automation-runs", input, { email: otherOwner, prefix: "/retained-org" })).status, 200);
    assert.equal((await call("inspect-automation-run", { historyId: result.historyId }, { email: otherOwner, prefix: "/retained-org" })).status, 409);
    await setActiveOrgId(owner, unrelatedOrg, "foreign organization capability control");
    const foreign = await call("list-automation-runs", input);
    assert.equal(foreign.status, 200); assert.deepEqual(foreign.body, []);
    assert.equal((await call("inspect-automation-run", { historyId: result.historyId })).status, 409);
    await setActiveOrgId(owner, orgId, "restore inspection owner organization");
    assert.deepEqual((await call("list-automation-runs", input, { prefix: "/wrong-app" })).body, []);
    assert.equal((await call("inspect-automation-run", { historyId: result.historyId }, { prefix: "/wrong-app" })).status, 409);
  } finally {
    await db.execute({ sql: "DELETE FROM org_members WHERE id = ?", args: [membershipId] });
    await setActiveOrgId(owner, orgId, "inspection cleanup organization");
    if (!(await history.getAutomationRun(result.historyId)).finishedAt) assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
    await setActiveOrgId(owner, unrelatedOrg, "restore fixture active organization");
    await setActiveOrgId(otherOwner, null, "restore second member selection");
  }
});

for (const recovery of [false, true]) test(`normal HTTP history discovers an older ${recovery ? "recoverable claim" : "ready wait"} after actual refused Run now rows`, async () => {
  await setActiveOrgId(owner, unrelatedOrg, "retained personal history control");
  const { fixture, result, pending, decision } = await ready(`http-old-wait-${recovery}`);
  if (recovery) {
    const chunk = `recoverable-${result.historyId}`;
    assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, chunk), true);
    await runStore.insertRun(chunk, result.threadId, result.turnId, { dispatchMode: "background" });
    await runStore.updateRunStatus(chunk, "aborted");
  }
  const scheduler = await loadCore("jobs/scheduler.js"), runNow = await loadCore("jobs/run-now.js");
  const models = fixture.modelCalls.length, calls = fixture.calls.length;
  runNow.setInProcessAutomationRunner(id => scheduler.runQueuedAutomation(id, fixture.deps), { appId });
  try {
    for (let i = 0; i < 22; i++) {
      const queued = await runNow.queueAutomationRunNow({ userEmail: owner, appId, scope: "personal", name: fixture.automation.name });
      const refused = await fixture.terminal(queued.automationRunId);
      assert.equal(refused.status, "error");
      assert.equal(refused.threadId, null); assert.equal(refused.runId, null);
    }
  } finally { runNow.setInProcessAutomationRunner(null); }
  assert.equal(fixture.modelCalls.length, models); assert.equal(fixture.calls.length, calls);
  const ordinary = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  assert.equal(ordinary.length, 20); assert.equal(ordinary.some(run => run.id === result.historyId), false);
  assert.equal((await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId, limit: 1 })).length, 1);
  const listed = await call("list-automation-runs", { name: fixture.automation.name, scope: "personal", includePendingApprovals: "true" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.filter(run => run.id === result.historyId).length, 1);
  assert.equal(listed.body.length, 21, "recent history stays bounded and includes retained custody once");
  for (const options of [{ email: otherOwner }, { prefix: "/wrong-app" }]) {
    const foreign = await call("list-automation-runs", { name: fixture.automation.name, scope: "personal", includePendingApprovals: "true" }, options);
    assert.equal(foreign.status, 200); assert.deepEqual(foreign.body, []);
  }
  const foreignOrg = await call("list-automation-runs", { name: fixture.automation.name, scope: "organization", includePendingApprovals: "true" });
  assert.equal(foreignOrg.status, 200); assert.deepEqual(foreignOrg.body, []);
  assert.equal((await call("inspect-automation-run", { historyId: result.historyId })).status, 200);
  assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
  const terminal = await history.getAutomationRun(result.historyId);
  assert.equal(terminal.status, "declined"); assert.equal(terminal.threadId, result.threadId);
  assert.equal((await runStore.getRunTurnRef(pending.runId)).turnId, result.turnId);
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "declined");
  assert.equal(effects(fixture), 0); assert.equal(fixture.modelCalls.length, models);
});

// A personal job made while an organization was active runs under it and keeps its
// run history there, keyed by path. A wait there would block other members' jobs of
// the same name and stay hidden from its owner, so such a job is refused connected
// tools at start, whether Run now or its schedule starts it.
test("a personal job that keeps its history under an organization is refused connected tools at start", async () => {
  // The manage-jobs tool stamps the active organization on a personal legacy job.
  const { createJobTools } = await loadCore("jobs/tools.js");
  const create = (name, mcpTools) => requestContext.runWithRequestContext({ userEmail: owner, orgId }, async () =>
    JSON.parse(await createJobTools(appId)["manage-jobs"].run({ action: "create", name, scope: "personal",
      instructions: "Perform the local step, then the configured step.", schedule: "0 * * * *", timezone: "UTC",
      ...(mcpTools ? { mcpTools } : {}) }, { caller: "human" })));
  // Control: without connected tools the same kind of job runs under the organization.
  assert.equal((await create("run-now-org-history-plain")).created, true);
  const plain = await makeApprovalCase("run-now-org-history-plain", { existing: true });
  const plainIdentity = await runner.resolveBackgroundAutomationIdentity(plain.automation);
  assert.equal(plainIdentity.ok, true); assert.equal(plainIdentity.identity.orgId, orgId);
  const name = "run-now-org-history";
  assert.equal((await create(name, [mcpName])).created, true);
  const fixture = await makeApprovalCase(name, { existing: true });
  const { resource } = fixture.automation;
  assert.equal(resource.owner, owner); assert.equal(fixture.automation.meta.orgId, orgId);
  const identity = await runner.resolveBackgroundAutomationIdentity(fixture.automation);
  assert.equal(identity.ok, false); assert.match(identity.reason, /cannot pause for approval/);
  runner.setAutomationApprovalDependencies(fixture.deps);
  const scheduler = await loadCore("jobs/scheduler.js"), runNow = await loadCore("jobs/run-now.js");
  const orgOwner = resources.organizationResourceOwner(orgId);
  runNow.setInProcessAutomationRunner(id => scheduler.runQueuedAutomation(id, fixture.deps), { appId });
  let refused;
  try {
    const queued = await runNow.queueAutomationRunNow({ userEmail: owner, appId, scope: "personal", name });
    await until(async () => (await history.getAutomationRun(queued.automationRunId)).status !== "running");
    refused = await history.getAutomationRun(queued.automationRunId);
  } finally { runNow.setInProcessAutomationRunner(null); }
  assert.equal(refused.status, "error"); assert.match(refused.error, /cannot pause for approval/);
  assert.equal((await scheduler.runJobNow(owner, name, fixture.deps)).status, "skipped");
  assert.equal(fixture.modelCalls.length, 0); assert.equal(effects(fixture), 0);
  for (const key of [owner, orgOwner]) assert.equal(await history.hasUnresolvedAutomationApproval(key, resource.path), false);
  const current = frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta;
  assert.equal(current.lastStatus, "skipped"); assert.match(current.lastError, /cannot pause for approval/);
  assert.equal(runner.isBackgroundAutomationRunActive(current), false);
});

test("normal HTTP history includes current organization custody without duplicating recent rows", async () => {
  const { fixture, result, decision } = await ready("http-org-list", true);
  await setActiveOrgId(owner, orgId, "organization history control");
  const listed = await call("list-automation-runs", { name: fixture.automation.name, scope: "organization", includePendingApprovals: "true" });
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.map(run => run.id), [result.historyId]);
  const personal = await call("list-automation-runs", { name: fixture.automation.name, scope: "personal", includePendingApprovals: "true" });
  assert.equal(personal.status, 200); assert.deepEqual(personal.body, []);
  assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
});


test("normal HTTP organization history fails closed while personal NULL-org custody survives unavailable membership", async () => {
  const { fixture, result, decision } = await ready("http-membership-list");
  await setActiveOrgId(owner, orgId, "membership history control");
  const input = { name: fixture.automation.name, scope: "organization", includePendingApprovals: "true" };
  const { rows: memberships } = await db.execute({
    sql: "SELECT id, org_id, email, role, joined_at FROM org_members WHERE org_id = ? AND email = ?",
    args: [orgId, owner] });
  assert.equal(memberships.length, 1, "the real fixture membership exists before revocation");
  const membership = memberships[0];
  const restoreMembership = () => db.execute({
    sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
    args: [membership.id, membership.org_id, membership.email, membership.role, membership.joined_at] });
  await db.execute({ sql: "DELETE FROM org_members WHERE org_id = ? AND email = ?", args: [orgId, owner] });
  const originalExecute = db.execute;
  const execute = originalExecute.bind(db);
  let membershipRestored = false;
  let membershipQueries = 0;
  try {
    const revoked = await call("list-automation-runs", input, { prefix: "/retained-org" });
    assert.equal(revoked.status, 403);
    assert.match(revoked.body.error, /no longer a member/);
    await restoreMembership();
    membershipRestored = true;
    const { rows: restored } = await db.execute({
      sql: "SELECT id, org_id, email, role, joined_at FROM org_members WHERE org_id = ? AND email = ?",
      args: [orgId, owner] });
    assert.deepEqual(restored, [membership], "healthy membership is restored before the selected lookup fault");
    assert.equal(db, database.getDbExec(), "the hook owns the current initialized singleton executor");
    db.execute = async statement => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql?.includes("SELECT email FROM org_members WHERE org_id = ? AND LOWER(email) = ? LIMIT 1")) {
        assert.deepEqual(statement.args, [orgId, owner.toLowerCase()]);
        membershipQueries += 1;
        throw new Error("selected membership lookup unavailable");
      }
      return execute(statement);
    };
    const unavailable = await call("list-automation-runs", input, { prefix: "/retained-org" });
    assert.notEqual(unavailable.status, 200);
    const personal = await call("list-automation-runs", { ...input, scope: "personal" }, { prefix: "/retained-org" });
    assert.equal(personal.status, 200);
    assert.deepEqual(personal.body.map(run => run.id), [result.historyId]);
    assert.equal(membershipQueries, 2, "actual action queries exact current membership on both routes");
    assert.equal((await history.getAutomationRun(result.historyId)).status, "waiting_approval");
    assert.equal(effects(fixture), 0);
  } finally {
    db.execute = originalExecute;
    if (!membershipRestored) await restoreMembership();
    assert.equal((await call("decide-automation-approval", { ...decision, decision: "decline" })).status, 200);
  }
});


async function resourceRequest(id, { method = "DELETE", email = owner } = {}) {
  const before = resourceSessionHits;
  const response = await fetch(`${origin}/_agent-native/resources/${id}`, { method,
    headers: { "x-fixture-owner": email }, signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  assert.equal(resourceSessionHits - before, 1, "the actual resource handler authenticates this request through getSession");
  return { status: response.status, body };
}
async function faultResourceCompletion(fixture) {
  const originalExecute = db.execute, execute = originalExecute.bind(db);
  let saved, faultHits = 0, successfulThreadSaves = 0;
  db.execute = async statement => {
    const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
    if (saved && faultHits === 0 && sql === "SELECT id FROM agent_runs WHERE id = ? AND thread_id = ? AND status = 'aborted' LIMIT 1" &&
        statement.args?.[0] === `turn-abort-${saved.run_id}` && statement.args?.[1] === saved.thread_id) {
      const state = await history.getAutomationContinuation(saved.id);
      assert.equal(state.storedStatus, "waiting_approval"); assert.ok(state.context.askId);
      faultHits++; throw new Error("Selected resource-delete completion read failed.");
    }
    const result = await execute(statement);
    if (sql.startsWith("UPDATE chat_threads SET thread_data = ?") && result.rowsAffected === 1) {
      const repo = JSON.parse(statement.args[0]);
      if (repo._automationRunId && repo.messages?.some(item => (item.message ?? item).role === "assistant")) {
        const { rows } = await execute({ sql: "SELECT id, run_id, thread_id FROM automation_runs WHERE id = ? AND owner = ? AND automation = ? AND app_id = ?",
          args: [repo._automationRunId, owner, fixture.automation.name, appId] });
        if (rows.length === 1 && rows[0].thread_id === statement.args[5]) { saved = rows[0]; successfulThreadSaves++; }
      }
    }
    return result;
  };
  try { await assert.rejects(fixture.start(), /Selected resource-delete completion read failed/); }
  finally { db.execute = originalExecute; }
  return { saved, faultHits, successfulThreadSaves };
}
async function resourceToolDelete(resourcePath, email = owner) {
  return requestContext.runWithRequestContext({ userEmail: email }, () =>
    resourceScripts.resources.run({ action: "delete", path: resourcePath, scope: "personal" }, { caller: "tool" }));
}
async function assertHelperCustody(resource, historyId, pending, fixture, taskId) {
  const counts = [fixture.calls.length, fixture.modelCalls.length];
  for (const kind of ["tool", "path", "id"]) {
    const before = await custodySnapshot(resource, historyId, pending, taskId);
    const originalExecute = db.execute, execute = originalExecute.bind(db);
    let selectedReads = 0, result, error;
    db.execute = async statement => {
      const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT") && (kind === "id"
        ? sql.includes("FROM resources WHERE id = ?") && statement.args?.[0] === resource.id
        : sql.includes("FROM resources WHERE owner = ? AND path = ?") && statement.args?.[0] === resource.owner && statement.args?.[1] === resource.path)) selectedReads++;
      return execute(statement);
    };
    try {
      result = await (kind === "tool" ? resourceToolDelete(resource.path) : kind === "path"
        ? resources.resourceDeleteByPath(resource.owner, resource.path) : resources.resourceDelete(resource.id));
    } catch (caught) { error = caught; }
    finally { db.execute = originalExecute; }
    const after = await custodySnapshot(resource, historyId, pending, taskId);
    console.log("RESOURCE_HELPER_DELETE_CUSTODY " + JSON.stringify({ kind, selectedReads,
      status: before.history.storedStatus, resourceRetained: Boolean(after.resource), historyId, askId: pending.askId,
      taskStatus: after.task?.status ?? null, configuredEffects: effects(fixture), refused: Boolean(error) || /^Error:/.test(String(result)) }));
    assert.ok(selectedReads >= 1, "the actual script/helper reached its exact database resource lookup");
    if (kind === "tool") assert.match(String(result), /^Error:.*approval/i);
    else { assert.ok(error); assert.equal(error.statusCode, 409); assert.match(error.message, /approval/i); }
    assert.deepEqual(after, before, "each helper refuses before changing resource or approval custody");
    assert.deepEqual([fixture.calls.length, fixture.modelCalls.length], counts); assert.equal(effects(fixture), 0);
  }
}
async function webhookRows(resource) {
  return (await db.execute({ sql: "SELECT * FROM automation_webhook_tokens WHERE automation_id = ?", args: [resource.id] })).rows;
}
async function custodySnapshot(resource, historyId, pending, taskId) {
  return { resource: await resources.resourceGetByPath(resource.owner, resource.path),
    history: await history.getAutomationContinuation(historyId), thread: await threads.getThread(pending.threadId),
    ask: await approvalStore.readAgentToolApproval(pending),
    ...(taskId ? { task: await (await loadCore("integrations/pending-tasks-store.js")).getPendingTask(taskId),
      tokens: await webhookRows(resource), secrets: (await db.execute({ sql: "SELECT * FROM app_secrets ORDER BY id" })).rows } : {}) };
}
for (const triggerType of ["schedule", "webhook"]) test(`authenticated resource DELETE preserves ${triggerType} waiting and resuming custody`, async () => {
  const fixture = await makeApprovalCase(`http-resource-${triggerType}`, { triggerType, repeatLocal: false });
  runner.setAutomationApprovalDependencies(fixture.deps);
  let result, taskId;
  if (triggerType === "webhook") {
    const tasks = await loadCore("integrations/pending-tasks-store.js"), dispatcher = await loadCore("triggers/dispatcher.js");
    const worker = await loadCore("integrations/automation-webhook-task.js"), resource = fixture.automation.resource;
    await dispatcher.initTriggerDispatcher(fixture.deps);
    taskId = "http-delete-task-" + resource.id;
    await tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
      ownerEmail: owner, orgId: null, externalEventKey: taskId, payload: JSON.stringify({ kind: "automation-webhook",
        automationId: resource.id, owner, path: resource.path, eventId: taskId, payload: {} }) });
    assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId }), "waiting_approval");
    const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    result = { historyId: run.id };
  } else result = await fixture.start();
  const pending = await fixture.pending(result.historyId), resource = fixture.automation.resource;
  const counts = [fixture.calls.length, fixture.modelCalls.length];
  try {
    const session = await fetch(`${origin}/_agent-native/auth/session`, { headers: { "x-fixture-owner": owner } });
    assert.equal(session.status, 200); assert.equal((await session.json()).email, owner);
    assert.equal((await resourceRequest(resource.id, { method: "GET" })).status, 200, "the actual authenticated resource route is reachable");
    for (const status of ["waiting_approval", "resuming"]) {
      if (status === "resuming") assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "http-delete-unstarted-" + resource.id), true);
      const before = await custodySnapshot(resource, result.historyId, pending, taskId);
      const response = await resourceRequest(resource.id);
      const after = await custodySnapshot(resource, result.historyId, pending, taskId);
      console.log("RESOURCE_HTTP_DELETE_CUSTODY " + JSON.stringify({ triggerType, status, httpStatus: response.status,
        resourceRetained: Boolean(after.resource), historyId: after.history.run.id, askId: pending.askId,
        taskStatus: after.task?.status ?? null, configuredEffects: effects(fixture) }));
      assert.equal(response.status, 409); assert.match(response.body.error ?? response.body.message ?? response.body.statusMessage, /approval/i);
      assert.deepEqual(after, before, "refusal precedes definition, token, history, thread, ask and task mutation");
      assert.deepEqual([fixture.calls.length, fixture.modelCalls.length], counts); assert.equal(effects(fixture), 0);
      await assertHelperCustody(resource, result.historyId, pending, fixture, taskId);
      if (status === "resuming") assert.equal(await history.restoreUnconsumedAutomationApproval(result.historyId, pending.askId, "http-delete-unstarted-" + resource.id), true);
    }
  } finally {
    const state = await history.getAutomationContinuation(result.historyId);
    if (state.storedStatus === "resuming") await history.restoreUnconsumedAutomationApproval(result.historyId, pending.askId, "http-delete-unstarted-" + resource.id);
    await fixture.decide(result.historyId, pending, "decline");
  }
  const settled = await history.getAutomationContinuation(result.historyId);
  assert.equal(settled.outcomeReconciled, true); assert.equal(settled.run.status, "declined");
  assert.equal((await resourceRequest(resource.id)).status, 200);
  assert.equal(await resources.resourceGetByPath(owner, resource.path), null);
  assert.equal((await history.getAutomationRun(result.historyId)).id, result.historyId, "snapshot deletion retains the original history");
  assert.equal(effects(fixture), 0);
});

test("authenticated resource DELETE refuses terminal unreconciled approval before mutation", async () => {
  const fixture = await makeApprovalCase("http-resource-terminal-error", { repeatLocal: false });
  runner.setAutomationApprovalDependencies(fixture.deps);
  const { saved, faultHits, successfulThreadSaves } = await faultResourceCompletion(fixture);
  const state = await history.getAutomationContinuation(saved.id), pending = state.context, resource = fixture.automation.resource;
  const before = await custodySnapshot(resource, saved.id, pending);
  const counts = [fixture.calls.length, fixture.modelCalls.length];
  const response = await resourceRequest(resource.id);
  const after = await custodySnapshot(resource, saved.id, pending);
  console.log("RESOURCE_HTTP_DELETE_TERMINAL " + JSON.stringify({ faultHits, successfulThreadSaves, httpStatus: response.status,
    historyStatus: state.run.status, outcomeReconciled: state.outcomeReconciled, resourceRetained: Boolean(after.resource), configuredEffects: effects(fixture) }));
  assert.equal(faultHits, 1); assert.equal(successfulThreadSaves, 1);
  assert.equal(state.run.status, "error"); assert.ok(state.run.finishedAt); assert.equal(state.outcomeReconciled, false);
  assert.equal(response.status, 409); assert.deepEqual(after, before);
  assert.deepEqual([fixture.calls.length, fixture.modelCalls.length], counts); assert.equal(effects(fixture), 0);
  await assertHelperCustody(resource, saved.id, pending, fixture);
  await runner.reconcileAutomationApprovalOutcomes(appId);
  assert.equal((await history.getAutomationContinuation(saved.id)).outcomeReconciled, true);
  assert.equal((await resourceRequest(resource.id)).status, 200);
  assert.equal((await history.getAutomationRun(saved.id)).status, "error");
  assert.deepEqual([fixture.calls.length, fixture.modelCalls.length], counts);
});

test("authenticated resource DELETE preserves ordinary deletion, wrong-owner refusal and full snapshot CAS", async () => {
  const fixture = await makeApprovalCase("http-resource-no-wait");
  const job = fixture.automation.resource;
  const before = await resources.resourceGetByPath(owner, job.path);
  assert.equal((await resourceRequest(job.id, { email: otherOwner })).status, 404);
  assert.deepEqual(await resources.resourceGetByPath(owner, job.path), before);
  assert.equal((await resourceRequest(job.id)).status, 200);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.modelCalls.length, 0);
  const original = await resources.resourcePut(owner, "notes/http-delete.md", "original");
  const current = await resources.resourcePut(owner, original.path, "updated");
  assert.equal(await resources.resourceDeleteIfCurrent(original), false, "a stale full snapshot cannot delete a changed resource");
  assert.deepEqual(await resources.resourceGetByPath(owner, original.path), current);
  assert.equal((await resourceRequest(current.id)).status, 200);
  assert.equal(await resources.resourceGetByPath(owner, original.path), null);
  const staleJob = await makeApprovalCase("http-resource-stale-job");
  const stale = staleJob.automation.resource;
  const changed = await resources.resourcePut(owner, stale.path, stale.content + "\nchanged");
  assert.equal(await resources.resourceDeleteIfCurrent(stale), false);
  assert.deepEqual(await resources.resourceGetByPath(owner, stale.path), changed);
  assert.equal((await resourceRequest(changed.id)).status, 200);
});

for (const order of ["lock", "delete"]) test(`authenticated snapshot DELETE serializes actual wait publication with ${order} ordering`, async () => {
  const fixture = await makeApprovalCase("http-snapshot-race-" + order, { repeatLocal: false });
  const { deletionRaceCase } = await import("./fixtures/automation-approval-recovery-gaps.mjs");
  const result = await deletionRaceCase("http-snapshot-" + order, fixture, approvalFixture, async () => {
    const response = await resourceRequest(fixture.automation.resource.id);
    return response.status === 200 ? { deleted: true } : { error: response.body.error ?? response.body.message };
  }, async () => [], "snapshot-delete");
  assert.equal(result.predicateHit, 1); assert.equal(result.configuredEffects, 0);
  assert.equal(result.deleteBarrierHit, order === "lock" ? 1 : 0);
  assert.ok(["wait", "delete"].includes(result.winner));
  if (result.winner === "delete") assert.equal(result.terminalCode, "automation_approval_changed");
});


for (const kind of ["tool", "path", "id"]) test(`personal resource ${kind} deletion permits a settled job and ordinary resources`, async () => {
  const fixture = await makeApprovalCase("helper-settled-" + kind, { repeatLocal: false });
  const ready = await fixture.start(), pending = await fixture.pending(ready.historyId);
  await fixture.decide(ready.historyId, pending, "decline");
  assert.equal((await history.getAutomationContinuation(ready.historyId)).outcomeReconciled, true);
  const remove = resource => kind === "tool" ? resourceToolDelete(resource.path) : kind === "path"
    ? resources.resourceDeleteByPath(resource.owner, resource.path) : resources.resourceDelete(resource.id);
  const job = fixture.automation.resource;
  const removed = await remove(job);
  if (kind === "tool") assert.match(String(removed), /Deleted resource:/); else assert.equal(removed, true);
  assert.equal(await resources.resourceGetByPath(owner, job.path), null);
  assert.equal((await history.getAutomationRun(ready.historyId)).status, "declined", "store helpers retain settled history");
  const empty = await makeApprovalCase("helper-no-wait-" + kind);
  const noWait = await remove(empty.automation.resource);
  if (kind === "tool") assert.match(String(noWait), /Deleted resource:/); else assert.equal(noWait, true);
  assert.equal(empty.modelCalls.length, 0); assert.equal(empty.calls.length, 0);
  const note = await resources.resourcePut(owner, `notes/helper-${kind}.md`, "ordinary note");
  const ordinary = await remove(note);
  if (kind === "tool") assert.match(String(ordinary), /Deleted resource:/); else assert.equal(ordinary, true);
  assert.equal(await resources.resourceGetByPath(owner, note.path), null);
  const missing = await remove(note);
  if (kind === "tool") assert.match(String(missing), /Resource not found:/); else assert.equal(missing, false);
  assert.equal(effects(fixture), 0);
});

test("personal resource tool and legacy Settings keep another owner's job untouched", async () => {
  const { fixture, result, pending } = await ready("helper-foreign-owner");
  const before = await custodySnapshot(fixture.automation.resource, result.historyId, pending);
  const output = await resourceToolDelete(fixture.automation.resource.path, otherOwner);
  assert.match(String(output), /Resource not found:/);
  const legacy = await call("manage-recurring-job", { operation: "delete", scope: "personal", name: fixture.automation.name }, { email: otherOwner });
  assert.equal(legacy.status, 404);
  assert.deepEqual(await custodySnapshot(fixture.automation.resource, result.historyId, pending), before);
  assert.equal(effects(fixture), 0);
  await fixture.decide(result.historyId, pending, "decline");
});

for (const terminal of [false, true]) test(`actual legacy Settings ID deletion refuses ${terminal ? "terminal unreconciled" : "waiting and resuming"} custody`, async () => {
  const name = "legacy-helper-" + terminal;
  const { createJobTools } = await loadCore("jobs/tools.js");
  const tools = createJobTools(appId);
  const created = await requestContext.runWithRequestContext({ userEmail: owner }, () => tools["manage-jobs"].run({
    action: "create", name, scope: "personal", instructions: "Retain this legacy job until its exact ask settles.",
    schedule: "0 * * * *", timezone: "UTC", mcpTools: [mcpName] }, { caller: "tool" }));
  assert.equal(JSON.parse(created).created, true, "normal job owner creates a real legacy definition");
  const fixture = await makeApprovalCase(name, { existing: true, repeatLocal: false });
  assert.equal(frontmatter.classifyJobResource(fixture.automation.resource.content).kind, "job");
  let result;
  if (terminal) {
    const fault = await faultResourceCompletion(fixture);
    assert.equal(fault.faultHits, 1); assert.equal(fault.successfulThreadSaves, 1);
    result = { historyId: fault.saved.id };
    const state = await history.getAutomationContinuation(result.historyId);
    assert.equal(state.run.status, "error"); assert.ok(state.run.finishedAt);
    assert.equal(state.run.errorCode, "background_automation_failed");
    assert.equal(state.outcomeReconciled, false);
    assert.equal(await runStore.getRunStatus(state.run.runId), "errored");
  } else result = await fixture.start();
  const pending = await fixture.pending(result.historyId), resource = fixture.automation.resource;
  try {
    for (const status of terminal ? ["error"] : ["waiting_approval", "resuming"]) {
      if (status === "resuming") assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "legacy-helper-claim-" + resource.id), true);
      const before = await custodySnapshot(resource, result.historyId, pending), counts = [fixture.calls.length, fixture.modelCalls.length];
      const originalExecute = db.execute, execute = originalExecute.bind(db);
      let actionReads = 0, response;
      db.execute = async statement => {
        const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
        if (sql.startsWith("SELECT") && sql.includes("FROM resources WHERE owner = ? AND path = ?") &&
            statement.args?.[0] === owner && statement.args?.[1] === resource.path) actionReads++;
        return execute(statement);
      };
      try { response = await call("manage-recurring-job", { operation: "delete", scope: "personal", name }); }
      finally { db.execute = originalExecute; }
      const after = await custodySnapshot(resource, result.historyId, pending);
      console.log("LEGACY_SETTINGS_DELETE_CUSTODY " + JSON.stringify({ actionReads, status, httpStatus: response.status,
        resourceRetained: Boolean(after.resource), historyId: result.historyId, configuredEffects: effects(fixture) }));
      assert.ok(actionReads >= 1, "the actual Settings action reaches its bound job lookup");
      assert.equal(response.status, 409); assert.deepEqual(after, before);
      assert.deepEqual([fixture.calls.length, fixture.modelCalls.length], counts); assert.equal(effects(fixture), 0);
      if (status === "resuming") assert.equal(await history.restoreUnconsumedAutomationApproval(result.historyId, pending.askId, "legacy-helper-claim-" + resource.id), true);
    }
  } finally {
    if (terminal) await runner.reconcileAutomationApprovalOutcomes(appId);
    else {
      const state = await history.getAutomationContinuation(result.historyId);
      if (state.storedStatus === "resuming") await history.restoreUnconsumedAutomationApproval(result.historyId, pending.askId, "legacy-helper-claim-" + resource.id);
      await fixture.decide(result.historyId, pending, "decline");
    }
  }
  assert.equal((await call("manage-recurring-job", { operation: "delete", scope: "personal", name })).status, 200);
  assert.equal(await resources.resourceGetByPath(owner, resource.path), null);
  assert.equal(effects(fixture), 0);
});

for (const kind of ["path", "id"]) test(`delegated ${kind} job deletion serializes the actual approval publication boundary`, async () => {
  const fixture = await makeApprovalCase("helper-race-" + kind, { repeatLocal: false });
  const { deletionRaceCase } = await import("./fixtures/automation-approval-recovery-gaps.mjs");
  const result = await deletionRaceCase("helper-" + kind + "-lock", fixture, approvalFixture, async () => ({ deleted:
    await (kind === "path" ? resources.resourceDeleteByPath(owner, fixture.automation.resource.path) : resources.resourceDelete(fixture.automation.resource.id))
  }), async () => [], "snapshot-delete");
  assert.equal(result.predicateHit, 1); assert.equal(result.deleteBarrierHit, 1);
  assert.equal(result.heldTransaction, true); assert.equal(result.configuredEffects, 0);
  assert.ok(["wait", "delete"].includes(result.winner));
});

test("resource ID and path helpers retain actual local-workspace deletion behavior", async () => {
  const directory = await mkdtemp(path.join(root, "local-workspace-"));
  await writeFile(path.join(directory, "agent-native.json"), JSON.stringify({ version: 1, mode: "local-files" }));
  // Native's supported single-tenant bridge flag and the local workspace apply
  // only to this disposable child, never to this test process or production.
  const script = fileURLToPath(new URL("./fixtures/automation-approval-local-workspace.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script], { cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, AGENT_NATIVE_ALLOW_LOCAL_FILES_IN_PRODUCTION: "true" } });
  const receipt = output.split("\n").find(line => line.startsWith("APPROVAL_RESULT "));
  assert.ok(receipt, "local-workspace child reported its result");
  const result = JSON.parse(receipt.slice("APPROVAL_RESULT ".length));
  assert.equal(result.cwd, await realpath(directory), "the child used the disposable local workspace");
  assert.equal(result.enabled, true);
  assert.deepEqual(result.cases, ["id", "path"].map(kind => ({ kind, resourcePath: `skills/helper-${kind}/SKILL.md`,
    localId: true, storedBeforeDelete: true, deleted: true, readAfterDelete: null })));
});


// A jobs file whose creator scope cannot be resolved and that has no approval history
// stays deletable. Exact-bound unresolved history still refuses (see the org-scope cases).
test("job deletion helpers delete an unresolvable-scope job that has no approval history", async () => {
  const cases = [["shared", resources.SHARED_OWNER, {}], ["org", resources.organizationResourceOwner(orgId), { orgId: "a-different-org" }]];
  for (const [kind, resourceOwner, scope] of cases) for (const remove of ["id", "path"]) {
    const resourcePath = `jobs/unscoped-${kind}-${remove}.md`;
    const saved = await resources.resourcePut(resourceOwner, resourcePath, frontmatter.buildJobResourceContent(
      { schedule: "0 * * * *", timezone: "UTC", enabled: true, ...scope }, "Legacy job with no recorded creator."));
    assert.equal(frontmatter.parseJobResource(saved.content).meta.createdBy, undefined);
    assert.equal(await (remove === "id" ? resources.resourceDelete(saved.id) : resources.resourceDeleteByPath(resourceOwner, resourcePath)), true);
    assert.equal(await resources.resourceGetByPath(resourceOwner, resourcePath), null);
  }
});

test("job ID custody delegation preserves webhook token-setup compensation", async () => {
  const name = "helper-webhook-compensation", resourcePath = `jobs/${name}.md`;
  const originalExecute = db.execute, execute = originalExecute.bind(db);
  const selectedError = new Error("Selected webhook token setup failed before commit.");
  let faultHits = 0;
  db.execute = async statement => {
    const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO automation_webhook_tokens") && statement.args?.[3] === resourcePath) {
      faultHits++; throw selectedError;
    }
    return execute(statement);
  };
  let error;
  try {
    await service.defineAutomation(actor, { scope: "personal", name, body: "No execution during token setup.", triggerType: "webhook" });
  } catch (caught) { error = caught; }
  finally { db.execute = originalExecute; }
  const resource = await resources.resourceGetByPath(owner, resourcePath);
  const rows = (await db.execute({ sql: "SELECT automation_id FROM automation_webhook_tokens WHERE owner = ? AND path = ?", args: [owner, resourcePath] })).rows;
  console.log("WEBHOOK_HELPER_COMPENSATION " + JSON.stringify({ faultHits, originalErrorPreserved: error === selectedError,
    resourcePresent: Boolean(resource), tokenRows: rows.length }));
  assert.equal(faultHits, 1); assert.equal(error, selectedError);
  assert.equal(resource, null); assert.deepEqual(rows, []);
  assert.deepEqual(await history.listAutomationRuns({ owners: [owner], automation: name, appId }), []);
});
