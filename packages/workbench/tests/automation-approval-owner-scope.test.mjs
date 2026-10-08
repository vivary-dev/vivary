import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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
  DATABASE_URL: url, DATABASE_URL_UNPOOLED: url,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
approvalFixture = await import("./fixtures/automation-approval-fixture.mjs");
const { makeApprovalCase, actor, owner, appId, mcpName, runner, history, threads,
  approvalStore, resources, frontmatter, service, database, runStore, loadCore } = approvalFixture;
const { H3, toNodeHandler } = await import("h3");
const { mountActionRoutes } = await loadCore("server/action-routes.js");
const { default: inspectAction } = await loadCore("jobs/actions/inspect-automation-run.js");
const { default: decideAction } = await loadCore("jobs/actions/decide-automation-approval.js");
const { setActiveOrgId } = await loadCore("org/active-org.js");
const { resolveOrgIdForEmail } = await loadCore("org/context.js");
const db = database.getDbExec();
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

const actions = { "inspect-automation-run": inspectAction, "decide-automation-approval": decideAction };
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
  return nativeFetch(input, options);
};
async function call(name, input, { email = owner, prefix = "" } = {}) {
  const inspect = name === "inspect-automation-run";
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
