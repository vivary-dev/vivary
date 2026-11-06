import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

// The packaged app runs as a production server with no app URL and no A2A_SECRET, so Core cannot
// dispatch Run now back to itself over HTTP. The maintained Core patch lets the server that owns the
// recurring-jobs timer run the queued row in its own process. Core's package entries do not export
// these modules, so load the installed, patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-run-now-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
for (const name of ["DEPLOY_PRIME_URL", "DEPLOY_URL", "URL", "APP_URL", "BETTER_AUTH_URL", "A2A_SECRET"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes fixed app URL and signing names. No value is read.
}
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
});

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = relative => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
const [runNow, runHistory, { defineAutomation }, { getDbExec }, { runQueuedAutomation }] = await Promise.all([
  load("jobs/run-now.js"),
  load("jobs/run-history.js"),
  load("automations/service.js"),
  load("db/client.js"),
  load("jobs/scheduler.js"),
]);
const { queueAutomationRunNow, redispatchUnclaimedAutomationRuns, setInProcessAutomationRunner } = runNow;
const { claimAutomationRun, getAutomationRun, startAutomationRun } = runHistory;

const owner = "owner@example.test";
const appId = "workbench";
const runNowInput = { userEmail: owner, appId, scope: "personal", name: "digest" };

after(async () => {
  setInProcessAutomationRunner?.(null);
  await rm(caseRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await getDbExec().execute({ sql: "DELETE FROM automation_runs", args: [] }).catch(() => {});
  setInProcessAutomationRunner?.(null);
});

await defineAutomation({ userEmail: owner, appId }, {
  scope: "personal",
  name: "digest",
  body: "Summarize the project in one sentence.",
  triggerType: "schedule",
  schedule: "0 * * * *",
  timezone: "UTC",
});

const registerRunner = runner => setInProcessAutomationRunner(runner, { appId });
const queuedRow = async (startedAgoMs, claimedAgoMs = null, rowAppId = appId) => {
  const id = await startAutomationRun({ owner, automation: "digest", path: "jobs/digest.md", scope: "personal", appId: rowAppId, dispatchPending: true });
  await getDbExec().execute({
    sql: "UPDATE automation_runs SET started_at = ?, claimed_at = ? WHERE id = ?",
    args: [Date.now() - startedAgoMs, claimedAgoMs === null ? null : Date.now() - claimedAgoMs, id],
  });
  return id;
};

test("Run now queues the row and hands it to the in-process runner without an app URL", async () => {
  assert.equal(typeof setInProcessAutomationRunner, "function", "Core exports setInProcessAutomationRunner");
  let deliver;
  const delivered = new Promise(resolve => { deliver = resolve; });
  registerRunner(async id => deliver(id));

  const queued = await queueAutomationRunNow(runNowInput);
  assert.equal(queued.queued, true);
  assert.equal(queued.automationRunId, queued.runId);
  assert.equal(await delivered, queued.runId, "the runner receives the queued run id");
  const row = await getAutomationRun(queued.runId);
  assert.equal(row.status, "running");
  assert.equal(row.automation, "digest");
});

test("without a runner, Run now still needs a self-dispatch URL in production", async () => {
  await assert.rejects(queueAutomationRunNow(runNowInput), /Self-dispatch requires/);
});

test("with a runner, the sweep runs recent unclaimed rows and ends old ones instead of running them late", async () => {
  assert.equal(typeof setInProcessAutomationRunner, "function", "Core exports setInProcessAutomationRunner");
  const received = [];
  registerRunner(async id => { received.push(id); });
  const hour = 60 * 60_000;
  const recent = await queuedRow(60_000);
  const neverStarted = await queuedRow(hour);
  const stoppedMidRun = await queuedRow(hour, hour - 60_000);

  assert.equal(await redispatchUnclaimedAutomationRuns({ appId }), 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [recent], "only the recent row reaches the runner");

  const expired = await getAutomationRun(neverStarted);
  assert.equal(expired.status, "error");
  assert.ok(expired.finishedAt);
  assert.match(expired.error, /^Run now did not start within \d+ minutes/);
  assert.match(expired.error, /No delivery was confirmed\.$/);
  assert.equal(expired.errorCode, "automation_run_not_started");

  const interrupted = await getAutomationRun(stoppedMidRun);
  assert.equal(interrupted.status, "error");
  assert.match(interrupted.error, /^The run stopped before it recorded a result/);
  assert.doesNotMatch(interrupted.error, /serverless/);
  assert.equal((await getAutomationRun(recent)).status, "running");
});

test("the runner takes only its own app's rows, and other apps keep self-dispatch", async () => {
  const received = [];
  registerRunner(async id => { received.push(id); });
  const otherApp = await queuedRow(60 * 60_000, null, "other-app");
  // Self-dispatch has no app URL in this production test, so the redelivery fails and counts 0.
  assert.equal(await redispatchUnclaimedAutomationRuns(), 0, "the other app's row is not delivered in process");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, []);
  const row = await getAutomationRun(otherApp);
  // An old unfinished row reads as interrupted. This process neither claimed nor finished it.
  assert.equal(row.claimedAt, null, "the other app's row was not claimed here");
  assert.equal(row.finishedAt ?? null, null, "the other app's row was not ended late here");
  assert.notEqual(row.errorCode, "automation_run_not_started");
});

test("a failed in-process run is logged once, by the runner", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(" ")); };
  try {
    let fail;
    const failed = new Promise(resolve => { fail = resolve; });
    registerRunner(async id => { fail(id); throw new Error("stub runner failed"); });
    await queueAutomationRunNow(runNowInput);
    await failed;
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logged.filter(line => line.includes("In-process run")), [], "Run now does not log the runner's failure again");
});

test("a second delivery of a claimed row is skipped and leaves the row unchanged", async () => {
  let toolsLoaded = false;
  const deps = { appId, getActions: () => { toolsLoaded = true; return {}; }, getSystemPrompt: async () => "" };
  const id = await queuedRow(60_000);
  assert.equal(await claimAutomationRun(id), true, "the first delivery claims the row");
  const before = await getAutomationRun(id);
  assert.deepEqual(await runQueuedAutomation(id, deps), { skipped: true });
  assert.deepEqual(await getAutomationRun(id), before);
  assert.equal(toolsLoaded, false, "the second delivery never started a run");
});

test("a failure inside the real runner lands on the row as an error", async () => {
  const deps = { appId, getActions: () => { throw new Error("stub tools failed"); }, getSystemPrompt: async () => "" };
  const id = await queuedRow(60_000);
  const result = await runQueuedAutomation(id, deps);
  assert.equal(result.skipped, false);
  const row = await getAutomationRun(id);
  assert.equal(row.status, "error");
  assert.match(row.error, /stub tools failed\. No delivery was confirmed\.$/);
  assert.ok(row.finishedAt);
});

test("the plugin registers the runner, with its app, only where it starts the in-process timer", async () => {
  const plugin = await readFile(path.join(coreRoot, "dist", "server", "agent-chat-plugin.js"), "utf8");
  const calls = plugin.split("setInProcessAutomationRunner(runQueuedAutomationRun, { appId: options?.appId })").length - 1;
  assert.equal(calls, 1, "one registration, with the app id");
  assert.equal(plugin.split("setInProcessAutomationRunner(").length - 1, 1, "no other registration");
  const branchStart = plugin.indexOf("if (disableRecurringJobsRuntime) {");
  const netlifyBranch = plugin.indexOf("else if (isNetlifyRecurringJobsRuntime()) {", branchStart);
  const timerBranch = plugin.indexOf("else {", netlifyBranch);
  const registration = plugin.indexOf("setInProcessAutomationRunner(runQueuedAutomationRun");
  const timerStart = plugin.indexOf("processRecurringJobs(schedulerDeps)", registration);
  assert.ok(branchStart > 0 && netlifyBranch > branchStart && timerBranch > netlifyBranch, "the timer branch exists");
  assert.ok(registration > timerBranch && timerStart > registration, "the runner registers in the timer branch, before the timer starts");
  // The readiness gate holds these routes until the plugin init that registers the runner settles.
  const tracked = plugin.slice(plugin.lastIndexOf("trackPluginInit(nitroApp, initPromise"));
  assert.ok(tracked.includes('"/_agent-native/actions"') && tracked.includes('"/_agent-native/agent-chat"'));
});
