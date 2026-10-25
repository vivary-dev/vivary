// Issue #205: approval asks and waits that never ended. Each case failed against
// the Core patch before the fix. This file owns its database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval205s-"));
const url = `file:${path.join(root, "stuck.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Stuck-wait tests forbid outward network calls."); };
const { runner, history, approvalStore, runStore, service, database, restoreTimers, makeApprovalCase, actor, owner, appId, mcpName, until } =
  await import("./fixtures/automation-approval-fixture.mjs");
after(async () => {
  globalThis.fetch = savedFetch;
  restoreTimers();
  await database.closeDbExec();
  await rm(root, { recursive: true, force: true });
});

const db = () => database.getDbExec();
const configuredCalls = fixture => fixture.calls.filter(call => call.name === mcpName).length;
const askStatus = async pending => (await approvalStore.readAgentToolApproval(pending)).status;
const row = async id => (await db().execute({ sql: "SELECT status, finished_at, error_code, resume_run_id, approval_outcome_reconciled AS reconciled FROM automation_runs WHERE id = ?",
  args: [id] })).rows[0];

async function waitingCase(name) {
  const fixture = await makeApprovalCase(name, { repeatLocal: false });
  const result = await fixture.start();
  assert.equal(result.status, "waiting_approval");
  await until(async () => (await history.getAutomationRun(result.historyId)).approvalReady);
  return { fixture, result, pending: await fixture.pending(result.historyId) };
}
// Move the exact ask and its retained binding past expiry together, as time would.
async function expire({ result, pending }) {
  const past = Date.now() - 1000;
  await db().execute({ sql: "UPDATE agent_tool_approvals SET expires_at = ? WHERE id = ?", args: [past, pending.askId] });
  const stored = (await db().execute({ sql: "SELECT approval_context FROM automation_runs WHERE id = ?", args: [result.historyId] })).rows[0];
  await db().execute({ sql: "UPDATE automation_runs SET approval_context = ? WHERE id = ?",
    args: [JSON.stringify({ ...JSON.parse(String(stored.approval_context)), expiresAt: past }), result.historyId] });
}
// An owner's decision claim, then a crash before its continuation ran. The claim is older than its lease.
async function crashedClaim({ result, pending }, resumeRunId) {
  assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, resumeRunId), true);
  await db().execute({ sql: "UPDATE automation_runs SET decision_at = ? WHERE id = ?",
    args: [Date.now() - history.automationRunClaimLeaseMs() - 1000, result.historyId] });
}
async function quietly(work) {
  const error = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = error; }
}

test("a run that ends with its ask still pending declines that ask when its outcome settles", async () => {
  const { fixture, result, pending } = await waitingCase("stuck-ask-terminal-error");
  // The grant expires after the decision, so the continuation fails without running the action.
  const client = db(), execute = client.execute;
  client.execute = async statement => {
    const sql = String(statement?.sql ?? statement);
    if (sql.includes("SET status = 'consumed'") && statement.args?.[3] === pending.askId)
      await execute.call(client, { sql: "UPDATE agent_tool_approvals SET expires_at = ? WHERE id = ?", args: [Date.now() - 1000, pending.askId] });
    return execute.call(client, statement);
  };
  try {
    await fixture.decide(result.historyId, pending, "approve");
    await quietly(() => fixture.terminal(result.historyId));
  } finally { client.execute = execute; }
  await until(async () => Number((await row(result.historyId)).reconciled) === 1);
  assert.equal((await row(result.historyId)).status, "error");
  assert.equal(await askStatus(pending), "declined", "a finished run's ask cannot stay pending");
  assert.equal(configuredCalls(fixture), 0);
  await service.deleteAutomation(actor, "personal", fixture.automation.name);
  assert.equal(await askStatus(pending), "declined", "deleting the automation leaves no pending ask");
});

test("an unready wait whose Native run row is gone can still be declined by its owner", async () => {
  const { fixture, result, pending } = await waitingCase("unready-wait-pruned-run");
  await db().execute({ sql: "UPDATE automation_runs SET approval_ready = 0 WHERE id = ?", args: [result.historyId] });
  await db().execute({ sql: "DELETE FROM agent_runs WHERE id = ?", args: [result.runId] });
  await assert.rejects(fixture.decide(result.historyId, pending, "approve"), /still saving/, "approval still needs the saved turn");
  const declined = await fixture.decide(result.historyId, pending, "decline");
  assert.equal(declined.status, "declined");
  const run = await history.getAutomationRun(result.historyId);
  assert.equal(run.status, "declined");
  assert.equal(await askStatus(pending), "declined");
  assert.equal(await history.hasUnresolvedAutomationApproval(owner, fixture.automation.resource.path), false);
  assert.equal(configuredCalls(fixture), 0);
});

test("an expired unready wait whose turn was stopped is declined by the expiry sweep", async () => {
  const waiting = await waitingCase("unready-wait-stopped-turn");
  const { fixture, result, pending } = waiting;
  await db().execute({ sql: "UPDATE automation_runs SET approval_ready = 0 WHERE id = ?", args: [result.historyId] });
  await runStore.markTurnAborted(result.threadId, result.turnId);
  await expire(waiting);
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const run = await history.getAutomationRun(result.historyId);
  assert.equal(run.status, "declined", "the sweep ends a wait that nobody can recover");
  assert.equal(run.errorCode, "automation_approval_expired");
  assert.equal(await askStatus(pending), "declined");
  assert.equal(configuredCalls(fixture), 0);
});

test("an owner's claim left resuming by a crash returns to waiting while its ask is pending", async () => {
  const waiting = await waitingCase("crashed-claim-pending");
  const { fixture, result, pending } = waiting;
  await crashedClaim(waiting, "automation-approval-crashed-pending");
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const restored = await row(result.historyId);
  assert.equal(restored.status, "waiting_approval", "the sweep restores the unconsumed wait");
  assert.equal(restored.resume_run_id, null);
  assert.equal(await askStatus(pending), "pending");
  await fixture.decide(result.historyId, pending, "decline");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "declined");
  assert.equal(configuredCalls(fixture), 0);
});

test("an owner's claim left resuming after its ask was consumed ends as interrupted", async () => {
  const waiting = await waitingCase("crashed-claim-consumed");
  const { fixture, result, pending } = waiting;
  await crashedClaim(waiting, "automation-approval-crashed-consumed");
  assert.equal(await approvalStore.consumeAgentToolApproval(pending), true);
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const run = await history.getAutomationRun(result.historyId);
  assert.equal(run.status, "interrupted", "a consumed approval has an unconfirmed outcome");
  assert.ok(run.finishedAt);
  assert.equal(await history.hasUnresolvedAutomationApproval(owner, fixture.automation.resource.path), false);
  assert.equal(configuredCalls(fixture), 0, "the sweep never dispatches the consumed action");
});

test("an owner's decline claim left resuming after the decline is finished as declined", async () => {
  const waiting = await waitingCase("crashed-claim-declined");
  const { result, pending } = waiting;
  await crashedClaim(waiting, "automation-decline-crashed");
  assert.equal(await approvalStore.declineAgentToolApproval(pending), true);
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const run = await history.getAutomationRun(result.historyId);
  assert.equal(run.status, "declined");
  assert.equal(run.errorCode, "automation_approval_declined");
});

test("an expired owner's claim left resuming is restored and then declined in one pass", async () => {
  const waiting = await waitingCase("crashed-claim-expired");
  const { result, pending } = waiting;
  await crashedClaim(waiting, "automation-approval-crashed-expired");
  await expire(waiting);
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const run = await history.getAutomationRun(result.historyId);
  assert.equal(run.status, "declined");
  assert.equal(run.errorCode, "automation_approval_expired");
  assert.equal(await askStatus(pending), "declined");
});

test("an owner's claim inside its lease is left to its continuation", async () => {
  const waiting = await waitingCase("fresh-claim");
  const { result, pending } = waiting;
  assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "automation-approval-fresh"), true);
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const claimed = await row(result.historyId);
  assert.equal(claimed.status, "resuming");
  assert.equal(claimed.resume_run_id, "automation-approval-fresh");
  assert.equal(await askStatus(pending), "pending");
});
