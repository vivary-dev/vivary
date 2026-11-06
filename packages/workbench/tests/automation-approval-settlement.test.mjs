// Issue #205: approval settlement sweeps. Each case failed against the Core
// patch before the fix. This file owns its database, so a real scheduler sweep
// sees only the jobs these cases define.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval205-"));
const url = `file:${path.join(root, "settlement.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Settlement tests forbid outward network calls."); };
const { runner, history, approvalStore, resources, frontmatter, database, restoreTimers, loadCore, makeApprovalCase,
  owner, appId, mcpName, until } = await import("./fixtures/automation-approval-fixture.mjs");
const [scheduler, health, retry, dispatch] = await Promise.all(["jobs/scheduler.js", "jobs/scheduler-health.js",
  "integrations/pending-tasks-retry-job.js", "integrations/integration-durable-dispatch.js"].map(loadCore));
after(async () => {
  dispatch.setInProcessIntegrationTaskRunner(null);
  globalThis.fetch = savedFetch;
  restoreTimers();
  await database.closeDbExec();
  await rm(root, { recursive: true, force: true });
});

await history.ensureTable();
const db = () => database.getDbExec();
const UNRECONCILED_LIST = /SELECT id\b.*FROM automation_runs WHERE approval_context IS NOT NULL\s+AND approval_outcome_reconciled = 0/s;
const EXPIRED_LIST = /SELECT id\b.*FROM automation_runs WHERE finished_at IS NULL\s+AND \(status = 'waiting_approval'/s;
const sqlOf = statement => String(statement?.sql ?? statement);

async function waitingCase(name, options) {
  const fixture = await makeApprovalCase(name, { repeatLocal: false, ...options });
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

// History rows that every pass lists and none can settle. Each sorts before the real row.
async function insertStuckRows(kind, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = `stuck-${kind}-${String(index).padStart(3, "0")}`;
    const terminal = kind === "unreconciled";
    await db().execute({
      sql: `INSERT INTO automation_runs (id, owner, automation, path, scope, app_id, status, started_at, finished_at,
              approval_context, approval_outcome_reconciled) VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, ?, ?, 0)`,
      args: [id, owner, `stuck-${index}`, `jobs/stuck-${kind}-${index}.md`, appId, terminal ? "declined" : "waiting_approval",
        1000 + index, terminal ? 1000 + index : null,
        // A mismatched history binding makes reconciliation refuse. An unknown ask makes expiry skip.
        JSON.stringify(terminal ? { historyId: "another-history" } : { historyId: id, askId: `missing-${id}`, expiresAt: 1 })],
    });
    ids.push(id);
  }
  return ids;
}
const removeRows = async ids => { for (const id of ids) await db().execute({ sql: "DELETE FROM automation_runs WHERE id = ?", args: [id] }); };
async function quietly(work) {
  const error = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = error; }
}

test("a full page of terminal rows that fail to reconcile cannot starve a later row", async () => {
  const stuck = await insertStuckRows("unreconciled", 150);
  try {
    const { fixture, result, pending } = await waitingCase("starved-terminal");
    await fixture.decide(result.historyId, pending, "decline");
    const reconciled = async () => Number((await db().execute({ sql: "SELECT approval_outcome_reconciled AS done FROM automation_runs WHERE id = ?",
      args: [result.historyId] })).rows[0].done);
    assert.equal(await reconciled(), 1);
    // The bookkeeping write was lost, so the declined row needs another pass.
    await db().execute({ sql: "UPDATE automation_runs SET approval_outcome_reconciled = 0 WHERE id = ?", args: [result.historyId] });
    await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
    await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
    assert.equal(await reconciled(), 1, "the later row settles although 150 earlier rows keep failing");
    const left = (await db().execute({ sql: "SELECT COUNT(*) AS n FROM automation_runs WHERE id LIKE 'stuck-unreconciled-%' AND approval_outcome_reconciled = 0" })).rows[0];
    assert.equal(Number(left.n), 150, "the failing rows stay listed for a later retry");
  } finally {
    await removeRows(stuck);
  }
});

test("a full page of expired waits that cannot settle cannot starve a later expired wait", async () => {
  const stuck = await insertStuckRows("expired", 150);
  try {
    const waiting = await waitingCase("starved-expiry");
    await expire(waiting);
    await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
    await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
    const run = await history.getAutomationRun(waiting.result.historyId);
    assert.equal(run.status, "declined", "the later expired wait is declined although 150 earlier waits are skipped");
    assert.equal(run.errorCode, "automation_approval_expired");
    assert.equal((await approvalStore.readAgentToolApproval(waiting.pending)).status, "declined");
    assert.equal(configuredCallsOf(waiting.fixture), 0);
  } finally {
    await removeRows(stuck);
  }
});
const configuredCallsOf = fixture => fixture.calls.filter(call => call.name === mcpName).length;

test("a failed reconciliation list neither skips due jobs nor hides the scheduler tick", async () => {
  const fixture = await makeApprovalCase("scheduler-reconcile-fault", { repeatLocal: false });
  const jobPath = fixture.automation.resource.path;
  const current = frontmatter.parseJobResource((await resources.resourceGetByPath(owner, jobPath)).content);
  await resources.resourcePut(owner, jobPath, frontmatter.buildJobResourceContent(
    { ...current.meta, enabled: true, nextRun: new Date(Date.now() - 60_000).toISOString() }, current.body));
  const tickStart = Date.now();
  const client = db(), execute = client.execute;
  let faults = 0, heartbeatBeforeReconcile = false;
  client.execute = async statement => {
    if (faults === 0 && UNRECONCILED_LIST.test(sqlOf(statement))) {
      faults++;
      const beat = await health.getAutomationSchedulerHealth({ appId });
      heartbeatBeforeReconcile = Boolean(beat && beat.lastCheckedAt >= tickStart);
      throw new Error("selected reconciliation list failure");
    }
    return execute.call(client, statement);
  };
  try {
    await quietly(() => scheduler.processRecurringJobs(fixture.deps));
  } finally {
    client.execute = execute;
  }
  assert.equal(faults, 1);
  assert.equal(heartbeatBeforeReconcile, true, "the heartbeat is written before reconciliation runs");
  const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  assert.ok(run, "the due job still ran");
  assert.equal(run.status, "waiting_approval");
  const tick = await health.getAutomationSchedulerHealth({ appId });
  assert.match(String(tick.lastError), /approval/i, "scheduler health records the reconciliation failure");
  await fixture.decide(run.id, await fixture.pending(run.id), "decline");
  await fixture.terminal(run.id);
  // The next healthy tick clears the error.
  await scheduler.processRecurringJobs(fixture.deps);
  assert.equal((await health.getAutomationSchedulerHealth({ appId })).lastError, null);
});

const registerRunner = (runnerAppId, acceptsTask = async () => true) => dispatch.setInProcessIntegrationTaskRunner(
  async () => assert.fail("Settlement sweeps must not dispatch a task"), { platforms: ["automation-webhook"], appId: runnerAppId, acceptsTask });

test("the pending-task sweep settles approvals only for its own app's runner", async () => {
  const waiting = await waitingCase("retry-app-scope");
  await expire(waiting);
  const status = async () => (await history.getAutomationRun(waiting.result.historyId)).status;
  try {
    // A process without the automation runner does not own settlement.
    dispatch.setInProcessIntegrationTaskRunner(null);
    await retry.retryStuckPendingTasks();
    assert.equal(await status(), "waiting_approval", "a process without a runner leaves the wait");
    registerRunner("other-app");
    await retry.retryStuckPendingTasks();
    assert.equal(await status(), "waiting_approval", "another app's sweep leaves this app's expired wait");
    registerRunner(appId);
    await retry.retryStuckPendingTasks();
    assert.equal(await status(), "declined", "the owning app's sweep declines its expired wait");
    assert.equal(configuredCallsOf(waiting.fixture), 0);
  } finally {
    dispatch.setInProcessIntegrationTaskRunner(null);
  }
});

test("the pending-task sweep survives a reconciliation failure and reconciles on its first page only", async () => {
  // Two stuck tasks of another app and a page size of one make the sweep read a second page.
  const tasks = await loadCore("integrations/pending-tasks-store.js");
  const ids = ["foreign-task-1", "foreign-task-2"], old = Date.now() - 60 * 60_000;
  for (const id of ids) await tasks.insertPendingTask({ id, platform: "automation-webhook", externalThreadId: `foreign:${id}`,
    ownerEmail: "foreign@example.test", orgId: null, externalEventKey: `foreign:${id}`, payload: "{}" });
  await db().execute({ sql: "UPDATE integration_pending_tasks SET created_at = ?, updated_at = ? WHERE id LIKE 'foreign-task-%'", args: [old, old] });
  const client = db(), execute = client.execute;
  const lists = { unreconciled: 0, expired: 0 };
  client.execute = async statement => {
    const sql = sqlOf(statement);
    if (EXPIRED_LIST.test(sql)) lists.expired++;
    if (UNRECONCILED_LIST.test(sql) && lists.unreconciled++ === 0) throw new Error("selected reconciliation list failure");
    return execute.call(client, statement);
  };
  registerRunner(appId, async () => false);
  try {
    const result = await quietly(() => retry.retryStuckPendingTasks({ limit: 1 }));
    assert.equal(result.skipped, 2, "the sweep read both pages and left the other app's tasks");
    assert.equal(result.dispatched, 0);
    assert.deepEqual(lists, { unreconciled: 1, expired: 1 }, "only the first page reconciles");
  } finally {
    client.execute = execute;
    dispatch.setInProcessIntegrationTaskRunner(null);
    for (const id of ids) await db().execute({ sql: "DELETE FROM integration_pending_tasks WHERE id = ?", args: [id] });
  }
});
