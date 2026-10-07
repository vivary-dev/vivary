import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Issue #114. A normal quit must end in-flight automation runs as interrupted and release the scheduler lease, and a
// hard kill must keep the lease expiry as the fallback. The stop is process state, so each quitting or killed process
// is a child that runs automation-quit-process.mjs against this file's disposable database. This process plays the
// next launch. Core's package entries do not export the runner internals, so load the installed, patched files by path.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "automation-quit-process.mjs");
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-quit-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
for (const name of ["DEPLOY_PRIME_URL", "DEPLOY_URL", "URL", "APP_URL", "BETTER_AUTH_URL", "A2A_SECRET",
  "ANTHROPIC_API_KEY", "AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes app URL, signing, provider key, and timeout names. No value is read.
}
// A webhook automation's token is stored as an encrypted app secret, which needs a key in production. The children
// inherit this random, disposable value.
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
});

// A finished run schedules a five-minute in-memory cleanup. Unref long timers so this file can exit.
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (handler, delay, ...args) => {
  const timer = originalSetTimeout(handler, delay, ...args);
  if ((delay ?? 0) >= 60_000) timer.unref();
  return timer;
};

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = relative => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
const [scheduler, runHistory, { defineAutomation, updateAutomation }, { getDbExec }, { resourceGetByPath, resourcePut },
  { parseJobResource, patchJobFrontmatterFields }, { initTriggerDispatcher }, webhookTask,
  { setInProcessIntegrationTaskRunner }, { insertPendingTask }, { retryStuckPendingTasks },
  listAutomations, { AUTOMATION_SCHEDULER_LEASE_MS, acquireAutomationRunLease, acquireAutomationSchedulerLease,
    ensureHealthTable, releaseAutomationRunLease, releaseAutomationSchedulerLease }] = await Promise.all([
  load("jobs/scheduler.js"),
  load("jobs/run-history.js"),
  load("automations/service.js"),
  load("db/client.js"),
  load("resources/store.js"),
  load("jobs/frontmatter.js"),
  load("triggers/dispatcher.js"),
  load("integrations/automation-webhook-task.js"),
  load("integrations/integration-durable-dispatch.js"),
  load("integrations/pending-tasks-store.js"),
  load("integrations/pending-tasks-retry-job.js"),
  load("triggers/actions/list-automations.js"),
  load("jobs/scheduler-health.js"),
]);
const { INTERRUPTED_RUN_ERROR_CODE, INTERRUPTED_RUN_MESSAGE, claimAutomationRun, finishAutomationRun, getAutomationRun,
  listAutomationRuns, startAutomationRun } = runHistory;

const owner = "owner@example.test";
const children = new Set();

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  setInProcessIntegrationTaskRunner(null);
  globalThis.setTimeout = originalSetTimeout;
  await rm(caseRoot, { recursive: true, force: true });
});

const defineScheduled = (appId, name, schedule = "* * * * *") => defineAutomation({ userEmail: owner, appId }, {
  scope: "personal", name, body: "Summarize the project in one sentence.", triggerType: "schedule", schedule,
  timezone: "UTC",
});
const stored = async name => parseJobResource((await resourceGetByPath(owner, `jobs/${name}.md`)).content).meta;
const patchStored = async (name, fields) => {
  const resource = await resourceGetByPath(owner, `jobs/${name}.md`);
  await resourcePut(owner, resource.path, patchJobFrontmatterFields(resource.content, fields));
};
const makeDue = name => patchStored(name, { nextRun: new Date(Date.now() - 60_000).toISOString() });
const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const runsOf = (appId, automation) => listAutomationRuns({ owners: [owner], automation, appId, limit: 20 });
const healthRow = async id => {
  const { rows } = await getDbExec().execute({
    sql: "SELECT lease_owner, lease_expires_at, last_checked_at, last_error FROM automation_scheduler_health WHERE id = ?",
    args: [id],
  });
  const row = rows?.[0];
  return row ? {
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    lastCheckedAt: row.last_checked_at == null ? null : Number(row.last_checked_at),
    lastError: row.last_error ?? null,
  } : null;
};
const leaseRow = appId => healthRow(`${appId}:global`);
const runLeaseKey = name => `${owner}:jobs/${name}.md`;
const runLeaseRow = name => healthRow(`run:${runLeaseKey(name)}`);

// Start one child process and resolve with its first report.
function spawnChild(role, appId) {
  const child = fork(CHILD, [role, appId], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("exit", () => { children.delete(child); resolve(); }));
  const report = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} sent no report within 60 s. ${stderr.slice(-2000)}`)), 60_000);
    child.once("message", message => { clearTimeout(timer); resolve(message); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`${role} exited ${code} without a report. ${stderr.slice(-2000)}`)); });
  });
  return { child, report, exited };
}

// A quick engine for this process, the next launch.
const quickEngine = {
  name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
  capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
  async *stream() {
    yield { type: "assistant-content", parts: [{ type: "text", text: "Done." }] };
    yield { type: "stop", reason: "end_turn" };
  },
};
const nextLaunch = appId => ({ appId, engine: quickEngine, model: "fake-model", getActions: () => ({}),
  getSystemPrompt: async () => "" });

// The quit scenario: a scheduled run of "nightly" and a Run now of "manual" are in flight when the child quits.
await defineScheduled("quit-app", "nightly");
await defineScheduled("quit-app", "second");
await defineScheduled("quit-app", "manual", "0 0 1 1 *");
await makeDue("nightly");
const manualNextRun = (await stored("manual")).nextRun;
let quitting;
const quit = () => {
  quitting ??= (async () => {
    const { report, exited } = spawnChild("quit", "quit-app");
    const result = await report;
    await exited;
    return result;
  })();
  return quitting;
};

test("a quit during a scheduled run marks it interrupted with the honest message", async () => {
  const result = await quit();
  const [row] = await runsOf("quit-app", "nightly");
  assert.equal(row.status, "interrupted", "the run reads interrupted");
  assert.ok(row.finishedAt, "the run has a finish time");
  assert.equal(row.error, INTERRUPTED_RUN_MESSAGE, "the message appears once, whole");
  assert.equal(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  const meta = await stored("nightly");
  assert.equal(meta.lastStatus, "error", "the automation is no longer running");
  assert.equal(meta.lastError, INTERRUPTED_RUN_MESSAGE);
  assert.ok(Date.parse(meta.nextRun) > result.quitAt, "the next run is after the quit");
  assert.deepEqual(result.outcomes, ["fulfilled", "fulfilled"]);
  assert.ok(result.settledAt.sweep <= result.stoppedAt && result.settledAt.manual <= result.stoppedAt,
    "the stop waited for both runs to record their outcome");
  assert.ok(result.stoppedAt - result.quitAt < 10_000, "the runs settled inside the bound");
});

test("a quit releases the scheduler lease", async () => {
  await quit();
  const lease = await leaseRow("quit-app");
  assert.equal(lease.leaseOwner, null, "no process holds the lease");
  assert.equal(lease.leaseExpiresAt, null);
});

test("a Run now interrupted by a quit keeps its schedule", async () => {
  const result = await quit();
  const row = await getAutomationRun(result.manualId);
  assert.equal(row.status, "interrupted");
  assert.equal(row.error, INTERRUPTED_RUN_MESSAGE);
  assert.equal(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  const meta = await stored("manual");
  assert.equal(meta.lastStatus, "error");
  assert.equal(meta.lastError, INTERRUPTED_RUN_MESSAGE);
  assert.equal(meta.nextRun, manualNextRun, "Run now does not move the next scheduled run");
});

test("after the stop, a timer tick and a Run now delivery start nothing", async () => {
  const result = await quit();
  assert.equal(result.stopExported, true, "Core exports stopRecurringJobs");
  assert.deepEqual(result.leaseAfter, result.leaseBefore, "the tick took no lease and wrote no heartbeat");
  assert.equal(result.runsAfter, result.runsBefore, "the tick started no run");
  assert.deepEqual(result.late, { skipped: true });
  const late = await getAutomationRun(result.lateId);
  assert.equal(late.claimedAt, null, "the queued row is left for the next launch");
  assert.equal(late.status, "running");
});

test("the next launch schedules at its first tick", async () => {
  await quit();
  await makeDue("nightly");
  await makeDue("second");
  await scheduler.processRecurringJobs(nextLaunch("quit-app"));
  const [second] = await runsOf("quit-app", "second");
  assert.equal(second?.status, "success", "the next launch ran a due automation at its first tick");
  const [nightly] = await runsOf("quit-app", "nightly");
  assert.equal(nightly.status, "success", "the interrupted automation runs again when it is due");
});

test("a hard kill keeps the run lease until it expires, and other automations still run", async () => {
  await defineScheduled("kill-app", "held");
  // Not due until the case makes it due, so a minute boundary during the case cannot start it in the killed child.
  await defineScheduled("kill-app", "held-second", "0 0 1 1 *");
  await makeDue("held");
  const { child, report, exited } = spawnChild("hold", "kill-app");
  const { running, lease: scan, runLease: held } = await report;
  assert.equal(running, "held");
  assert.ok(held.leaseOwner, "the child holds the run's lease");
  assert.equal(scan.leaseOwner, null, "the child's scan released the scheduler lease");
  child.kill("SIGKILL");
  await exited;

  const lease = await runLeaseRow("held");
  assert.equal(lease.leaseOwner, held.leaseOwner, "the run lease still names the killed process");
  assert.equal(lease.leaseExpiresAt, held.leaseExpiresAt);
  const remainingMs = lease.leaseExpiresAt - Date.now();
  assert.ok(remainingMs > 9 * 60_000 && remainingMs <= 10 * 60_000, `the run lease expires about 10 minutes out (${remainingMs} ms)`);

  await makeDue("held-second");
  await scheduler.processRecurringJobs(nextLaunch("kill-app"));
  assert.ok((await leaseRow("kill-app")).lastCheckedAt > scan.lastCheckedAt, "the next launch scanned");
  assert.deepEqual((await runsOf("kill-app", "held-second")).map(run => run.status), ["success"],
    "another due automation ran at the next launch's first tick");

  const runs = await runsOf("kill-app", "held");
  assert.deepEqual(runs.map(run => run.status), ["running"], "the killed run reads running until the liveness ceiling");
  const [row] = runs;
  assert.equal(row.finishedAt, null);
  await getDbExec().execute({ sql: "UPDATE automation_runs SET started_at = ? WHERE id = ?",
    args: [Date.now() - 16 * 60_000, row.id] });
  const aged = await getAutomationRun(row.id);
  assert.equal(aged.status, "interrupted", "past the ceiling it reads interrupted");
  assert.equal(aged.error, INTERRUPTED_RUN_MESSAGE);

  // Ten minutes after the last renewal the run lease has expired and the mark is past the run's time limit.
  await getDbExec().execute({ sql: "UPDATE automation_scheduler_health SET lease_expires_at = ? WHERE id = ?",
    args: [Date.now() - 1, `run:${runLeaseKey("held")}`] });
  await patchStored("held", { lastRun: minutesAgo(11) });
  await scheduler.processRecurringJobs(nextLaunch("kill-app"));
  const meta = await stored("held");
  assert.equal(meta.lastStatus, "error", "a scan reset the killed run once its run lease expired");
  assert.equal(meta.lastError, INTERRUPTED_RUN_MESSAGE);
  assert.ok((await getAutomationRun(row.id)).finishedAt, "its run row is finished");
  assert.equal(await runLeaseRow("held"), null, "its run lease row is gone");
});

test("a stop in one process leaves another process's run lease alone", async () => {
  await defineScheduled("shared-app", "busy");
  await makeDue("busy");
  const holder = spawnChild("hold", "shared-app");
  const { runLease: held } = await holder.report;
  assert.ok(held.leaseOwner, "the first process holds the run's lease");
  const tickAt = Date.now();
  const stopper = spawnChild("stop-only", "shared-app");
  const { stopExported } = await stopper.report;
  await stopper.exited;
  assert.equal(stopExported, true, "Core exports stopRecurringJobs");
  const lease = await runLeaseRow("busy");
  assert.equal(lease.leaseOwner, held.leaseOwner, "the run lease still names the first process");
  assert.ok(lease.leaseExpiresAt >= held.leaseExpiresAt);
  assert.ok((await leaseRow("shared-app")).lastCheckedAt >= tickAt, "the second process scanned");
  assert.equal((await runsOf("shared-app", "busy")).length, 1, "the second process's scan started nothing");
  holder.child.kill("SIGKILL");
  await holder.exited;
});

test("the stop returns at its bound when a run ignores its abort", async () => {
  await defineScheduled("stubborn-app", "stuck");
  await makeDue("stuck");
  const { report, exited } = spawnChild("stubborn", "stubborn-app");
  const result = await report;
  await exited;
  assert.equal(result.stopExported, true, "Core exports stopRecurringJobs");
  assert.ok(result.elapsedMs >= 950 && result.elapsedMs < 3_000, `the stop returned at its 1-second bound (${result.elapsedMs} ms)`);
  assert.deepEqual(result.statuses, ["running"], "a run that did not settle is left for the fallback");
  assert.equal(result.lease.leaseOwner, null, "its scan released the scheduler lease");
  assert.ok(result.runLease.leaseOwner, "the stuck run still holds its run lease, which then expires as after a hard kill");
});

// Issue #139. A scheduled run in progress must not keep the app's next tick from starting other due automations.
const gate = () => {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
};
const within = (promise, ms, what) => Promise.race([promise, sleep(ms, undefined, { ref: false }).then(() => {
  throw new Error(`${what} did not happen within ${ms} ms`);
})]);
const poll = async (read, done, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(20);
  }
};
// Route this process's database calls through `intercept(query, run)` until the returned restore runs.
const interceptQueries = intercept => {
  const db = getDbExec();
  const execute = db.execute;
  db.execute = function (query) {
    return intercept(query, () => execute.call(this, query));
  };
  return () => { db.execute = execute; };
};
const LIST_JOBS = /^SELECT \* FROM resources WHERE path LIKE \? ESCAPE '!'$/;
const writesJob = (query, name, field) => /^UPDATE resources SET content = \?/.test(query?.sql ?? "")
  && query.args?.[5] === `jobs/${name}.md` && field.test(String(query.args[0]));
const acquiresRunLease = (query, name) => /^INSERT INTO automation_scheduler_health\s/.test(query?.sql ?? "")
  && query.args?.[0] === `run:${runLeaseKey(name)}`;
// Reject each query `refused(sql, args)` matches until the returned restore runs.
const refuseQueries = refused => interceptQueries((query, run) => refused(query?.sql ?? "", query?.args ?? [])
  ? Promise.reject(new Error("The database refused this query.")) : run());
// Run `work` and return what it wrote through console[method]. The lines still reach the output.
const consoleLines = async (method, work) => {
  const lines = [];
  const write = console[method];
  console[method] = (...args) => {
    lines.push(args.map(String).join(" "));
    write(...args);
  };
  try {
    await work();
  } finally {
    console[method] = write;
  }
  return lines;
};
const markCheckFailures = lines => lines.filter(line => line.includes("Could not check the running mark"));
// Run one tick of `appId` and return its warnings and how often it tried to take the run lease of `name`.
const countedTick = async (appId, name) => {
  let acquires = 0;
  const restore = interceptQueries((query, run) => {
    if (acquiresRunLease(query, name)) acquires += 1;
    return run();
  });
  try {
    const warnings = await consoleLines("warn", () => scheduler.processRecurringJobs(nextLaunch(appId)));
    return { warnings, acquires };
  } finally {
    restore();
  }
};

test("a due automation starts at the next tick while another automation's scheduled run is in progress", async () => {
  await defineScheduled("overlap-app", "long-run", "0 0 1 1 *");
  await defineScheduled("overlap-app", "on-time", "0 0 1 1 *");
  const starts = [];
  const longRunStarted = gate();
  const release = gate();
  const engine = { ...quickEngine, async *stream(options) {
    const name = JSON.stringify(options.messages).match(/Recurring Job: ([a-z-]+)/)?.[1];
    starts.push({ name, at: Date.now() });
    if (name === "long-run") {
      longRunStarted.open();
      await new Promise(resolve => {
        void release.promise.then(resolve);
        options.abortSignal?.addEventListener("abort", resolve, { once: true });
      });
      options.abortSignal?.throwIfAborted();
    }
    yield* quickEngine.stream(options);
  } };
  const engineStarts = name => starts.filter(start => start.name === name);
  const deps = { ...nextLaunch("overlap-app"), engine };
  let leaseAtOutcome;
  const restore = interceptQueries(async (query, run) => {
    if (leaseAtOutcome === undefined && writesJob(query, "long-run", /^lastStatus: success$/m)) {
      leaseAtOutcome = await runLeaseRow("long-run");
    }
    return run();
  });
  await makeDue("long-run");
  const first = scheduler.processRecurringJobs(deps);
  let second;
  let onTime;
  try {
    await within(longRunStarted.promise, 30_000, "long-run starting");
    const checkedBefore = (await leaseRow("overlap-app")).lastCheckedAt;
    await makeDue("on-time");
    // Heartbeats are whole milliseconds, so the second tick's check must land in a later one.
    await sleep(5);
    const tick2At = Date.now();
    second = scheduler.processRecurringJobs(deps);
    const onTimeRuns = await poll(() => runsOf("overlap-app", "on-time"),
      runs => runs.some(run => run.status === "success"), 10_000);
    assert.deepEqual(onTimeRuns.map(run => run.status), ["success"],
      "a due automation started at the next tick while another automation's scheduled run was in progress");
    [onTime] = onTimeRuns;
    assert.ok(onTime.startedAt >= tick2At && onTime.startedAt - tick2At < 5_000,
      `it started within 5 s of that tick (${onTime.startedAt - tick2At} ms)`);
    assert.equal(engineStarts("on-time").length, 1, "the engine started on-time once");
    assert.ok(engineStarts("on-time")[0].at >= tick2At, "the engine started on-time after the second tick began");
    const longRuns = await runsOf("overlap-app", "long-run");
    assert.equal(longRuns.length, 1, "long-run has one run although the second tick scanned it while it was in progress");
    assert.equal(engineStarts("long-run").length, 1, "the engine started long-run once");
    assert.equal(longRuns[0].status, "running", "long-run was still in progress while on-time ran");
    assert.equal(longRuns[0].finishedAt, null);
    assert.ok(longRuns[0].startedAt < onTime.startedAt, "long-run started before on-time");
    assert.ok((await leaseRow("overlap-app")).lastCheckedAt > checkedBefore,
      "the scheduler's last check advanced at the second tick during long-run");
    const listed = (await listAutomations.default.run({ scope: "personal" }, { userEmail: owner, appId: "overlap-app" }))
      .find(row => row.name === "long-run");
    assert.ok(Date.parse(listed.lastCheck) > checkedBefore, "LAST CHECKED in the automation list advanced during long-run");
  } finally {
    release.open();
    await Promise.allSettled([first, second]);
    restore();
  }
  const [longRun] = await runsOf("overlap-app", "long-run");
  assert.equal(longRun.status, "success", "long-run finished once released");
  assert.ok(longRun.finishedAt > onTime.startedAt, "on-time started before long-run finished");
  assert.ok(leaseAtOutcome?.leaseOwner, "long-run still held its run lease when its outcome was written");
  assert.deepEqual([await runLeaseRow("long-run"), await runLeaseRow("on-time")], [null, null],
    "each run deleted its run lease row after its outcome");
  assert.ok((await leaseRow("overlap-app")).lastCheckedAt < longRun.finishedAt,
    "no tick wrote a check when its runs ended");
});

test("two processes on one database never scan at the same time", async () => {
  await defineScheduled("scan-app", "scan-due", "0 0 1 1 *");
  const { child, report, exited } = spawnChild("scan-hold", "scan-app");
  try {
    const { lease: held } = await report;
    assert.ok(held.leaseOwner, "the child's sweep holds the lease while it scans");
    await makeDue("scan-due");
    const before = await leaseRow("scan-app");
    await within(scheduler.processRecurringJobs(nextLaunch("scan-app")), 30_000, "the parent's tick");
    assert.equal((await leaseRow("scan-app")).lastCheckedAt, before.lastCheckedAt,
      "the parent's tick did not scan while the child's sweep was scanning");
    assert.deepEqual(await runsOf("scan-app", "scan-due"), [], "the parent's tick started nothing");
    assert.equal((await leaseRow("scan-app")).leaseOwner, held.leaseOwner, "the lease still names the child");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("a run another process still holds stays live past the time window", async () => {
  await defineScheduled("live-app", "live");
  await makeDue("live");
  const { child, report, exited } = spawnChild("hold", "live-app");
  try {
    const { running, runLease: held } = await report;
    assert.equal(running, "live");
    // Not due, so only the scan's check of the mark can try to take its run lease.
    await patchStored("live", { lastRun: minutesAgo(30), nextRun: new Date(Date.now() + 3_600_000).toISOString() });
    const tickAt = Date.now();
    const { warnings, acquires } = await countedTick("live-app", "live");
    assert.ok((await leaseRow("live-app")).lastCheckedAt >= tickAt, "the tick scanned");
    assert.deepEqual(markCheckFailures(warnings), [], "the tick checked the mark without an error");
    assert.equal(acquires, 1, "the scan tried to take the mark's run lease");
    assert.equal((await runLeaseRow("live"))?.leaseOwner, held.leaseOwner,
      "the scan got no run lease, and the run still holds it");
    assert.equal((await stored("live")).lastStatus, "running", "the scan left a run whose lease is held");
    assert.equal((await runsOf("live-app", "live")).length, 1);
    assert.deepEqual(await scheduler.runJobNow(owner, "live", nextLaunch("live-app")),
      { status: "skipped", error: "The automation is already running." }, "Run now refused the live run");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("a running mark no run lease covers keeps today's time window", async () => {
  await defineScheduled("unleased-app", "unleased");
  await patchStored("unleased", { lastStatus: "running", lastRun: new Date().toISOString() });
  const tickAt = Date.now();
  const { warnings, acquires } = await countedTick("unleased-app", "unleased");
  assert.ok((await leaseRow("unleased-app")).lastCheckedAt >= tickAt, "the tick scanned");
  assert.deepEqual(markCheckFailures(warnings), [], "the tick checked the mark without an error");
  assert.equal((await stored("unleased")).lastStatus, "running", "a mark inside the run's time limit stays running");
  assert.equal(acquires, 1, "the scan took the run lease");
  assert.equal(await runLeaseRow("unleased"), null, "the scan released the run lease it took");
  await patchStored("unleased", { lastRun: minutesAgo(11) });
  await scheduler.processRecurringJobs(nextLaunch("unleased-app"));
  const meta = await stored("unleased");
  assert.equal(meta.lastStatus, "error", "past the time limit the scan reset it");
  assert.equal(meta.lastError, INTERRUPTED_RUN_MESSAGE);
  assert.equal(await runLeaseRow("unleased"), null, "no run lease row is left");
});

const definePairedHost = async (appId, name, label) => {
  const { createRemoteDevice } = await load("integrations/remote-devices-store.js");
  const { device } = await createRemoteDevice({ ownerEmail: owner, label });
  await defineAutomation({ userEmail: owner, appId }, { scope: "personal", name,
    body: "Summarize the project in one sentence.", triggerType: "schedule", schedule: "0 0 1 1 *", timezone: "UTC",
    executionHostId: device.id });
};

test("a tick leaves a paired-host mark alone while its dispatch holds the run lease", async () => {
  await definePairedHost("dispatch-app", "dispatching", "Dispatch test host");
  await patchStored("dispatching", { lastStatus: "running", lastRun: new Date().toISOString() });
  const key = runLeaseKey("dispatching");
  const leaseOwner = await acquireAutomationRunLease({ key });
  assert.ok(leaseOwner, "the dispatch holds the run lease");
  const tickAt = Date.now();
  const { warnings, acquires } = await countedTick("dispatch-app", "dispatching");
  assert.ok((await leaseRow("dispatch-app")).lastCheckedAt >= tickAt, "the tick scanned");
  assert.deepEqual(markCheckFailures(warnings), [], "the tick checked the mark without an error");
  assert.equal(acquires, 1, "the scan tried to take the mark's run lease");
  assert.equal((await runLeaseRow("dispatching"))?.leaseOwner, leaseOwner,
    "the scan got no run lease, and the dispatch still holds it");
  const held = await stored("dispatching");
  assert.equal(held.lastStatus, "running", "the tick left the mark whose dispatch holds the run lease");
  assert.equal(held.lastError, undefined);
  await releaseAutomationRunLease({ key, owner: leaseOwner });
  await scheduler.processRecurringJobs(nextLaunch("dispatch-app"));
  const reconciled = await stored("dispatching");
  assert.equal(reconciled.lastStatus, "error", "with the lease released, the next tick reconciled the mark as failed");
  assert.equal(reconciled.lastError, "Remote dispatch bookkeeping is missing its request id.");
});

test("a tick leaves a run that finished after the scan read it", async () => {
  await defineScheduled("fresh-app", "finished-late");
  await patchStored("finished-late", { lastStatus: "running", lastRun: minutesAgo(11) });
  const historyRow = dispatchPending => startAutomationRun({ owner, automation: "finished-late",
    path: "jobs/finished-late.md", scope: "personal", appId: "fresh-app", dispatchPending });
  const finishedId = await historyRow(false);
  let listed = false;
  let finished;
  let runNowId;
  let acquires = 0;
  const restore = interceptQueries(async (query, run) => {
    if (acquiresRunLease(query, "finished-late")) acquires += 1;
    const result = await run();
    if (!listed && LIST_JOBS.test(query?.sql ?? "")) {
      listed = true;
      await finishAutomationRun(finishedId, "success");
      await patchStored("finished-late", { lastStatus: "success" });
      finished = await getAutomationRun(finishedId);
      // History orders rows by their whole-millisecond start, so the Run now row must start in a later one.
      await sleep(5);
      runNowId = await historyRow(true);
      await claimAutomationRun(runNowId);
    }
    return result;
  });
  let warnings;
  try {
    warnings = await consoleLines("warn", () => scheduler.processRecurringJobs(nextLaunch("fresh-app")));
  } finally {
    restore();
  }
  assert.ok(finished, "the run finished after the scan listed the automations");
  assert.deepEqual(markCheckFailures(warnings), [], "the tick checked the mark without an error");
  assert.equal(acquires, 1, "the scan took the mark's run lease");
  assert.equal((await leaseRow("fresh-app")).lastError, null, "the scan recorded no error");
  const meta = await stored("finished-late");
  assert.equal(meta.lastStatus, "success", "the scan read the mark again and left the finished run");
  assert.equal(meta.lastError, undefined);
  const [runNow, done] = await runsOf("fresh-app", "finished-late");
  assert.deepEqual([done.id, done.status, done.finishedAt], [finishedId, "success", finished.finishedAt],
    "the finished run's history row keeps its status and finish time");
  assert.deepEqual([runNow.id, runNow.status, runNow.finishedAt], [runNowId, "running", null],
    "a Run now claimed after the run finished stays unfinished");
});

test("a tick reconciles a paired-host mark from a fresh read", async () => {
  await definePairedHost("queued-app", "queued", "Bookkeeping test host");
  await patchStored("queued", { lastStatus: "running", lastRun: new Date().toISOString() });
  const key = runLeaseKey("queued");
  const leaseOwner = await acquireAutomationRunLease({ key });
  let queued = false;
  let acquires = 0;
  const restore = interceptQueries(async (query, run) => {
    if (acquiresRunLease(query, "queued")) acquires += 1;
    const result = await run();
    if (!queued && LIST_JOBS.test(query?.sql ?? "")) {
      queued = true;
      await patchStored("queued", { remoteRequestId: "remote-automation:queued", remoteCommandId: "queued-command" });
      await releaseAutomationRunLease({ key, owner: leaseOwner });
    }
    return result;
  });
  let warnings;
  try {
    warnings = await consoleLines("warn", () => scheduler.processRecurringJobs(nextLaunch("queued-app")));
  } finally {
    restore();
  }
  assert.equal(queued, true, "the dispatch saved its bookkeeping and released the lease after the scan listed the mark");
  assert.deepEqual(markCheckFailures(warnings), [], "the tick checked the mark without an error");
  assert.equal(acquires, 1, "the scan took the mark's run lease");
  assert.equal((await leaseRow("queued-app")).lastError, null, "the scan recorded no error");
  const meta = await stored("queued");
  assert.equal(meta.lastStatus, "running", "the scan read the mark again and left the queued run");
  assert.equal(meta.lastError, undefined);
});

test("a paired-host dispatch holds the run lease until the run is queued", async () => {
  await definePairedHost("queue-app", "queueing", "Queue test host");
  await makeDue("queueing");
  let leaseAtQueue;
  const restore = interceptQueries(async (query, run) => {
    if (leaseAtQueue === undefined && writesJob(query, "queueing", /^remoteCommandId:/m)) {
      leaseAtQueue = await runLeaseRow("queueing");
    }
    return run();
  });
  try {
    await scheduler.processRecurringJobs(nextLaunch("queue-app"));
  } finally {
    restore();
  }
  assert.ok(leaseAtQueue?.leaseOwner, "the dispatch held the run lease while it saved the queued run's bookkeeping");
  const meta = await stored("queueing");
  assert.equal(meta.lastStatus, "running");
  assert.ok(meta.remoteCommandId, "the run was queued on the paired host");
  assert.equal(await runLeaseRow("queueing"), null, "the dispatch released the run lease once the run was queued");
});

test("a due automation whose run lease another run holds is skipped and stays due", async () => {
  await defineScheduled("skip-app", "leased");
  await makeDue("leased");
  const before = await stored("leased");
  const key = runLeaseKey("leased");
  const leaseOwner = await acquireAutomationRunLease({ key });
  let logs;
  try {
    logs = await consoleLines("log", () => scheduler.processRecurringJobs(nextLaunch("skip-app")));
  } finally {
    await releaseAutomationRunLease({ key, owner: leaseOwner });
  }
  assert.deepEqual(logs.filter(line => line.includes('"leased"')),
    ['[recurring-jobs] Job "leased" was skipped because another run holds its run lease.'], "the skip was logged once");
  const meta = await stored("leased");
  assert.deepEqual([meta.lastStatus, meta.nextRun], [before.lastStatus, before.nextRun], "the job stays due");
  assert.deepEqual(await runsOf("skip-app", "leased"), [], "nothing ran");
});

test("a run lease release the database refuses leaves the run's outcome", async () => {
  await defineScheduled("release-app", "released");
  await defineScheduled("release-app", "released-now", "0 0 1 1 *");
  await makeDue("released");
  const restore = refuseQueries((sql, args) => /^DELETE FROM automation_scheduler_health\s/.test(sql)
    && String(args[0]).startsWith("run:"));
  try {
    const warnings = await consoleLines("warn", () => scheduler.processRecurringJobs(nextLaunch("release-app")));
    assert.ok(warnings.some(line => line.includes('Run lease release for "jobs/released.md" failed')),
      "the refused release was logged");
    assert.equal((await stored("released")).lastStatus, "success", "the scheduled run kept its success outcome");
    const historyId = await startAutomationRun({ owner, automation: "released-now", path: "jobs/released-now.md",
      scope: "personal", appId: "release-app", dispatchPending: true });
    let runNow;
    const runNowWarnings = await consoleLines("warn", async () => {
      runNow = await scheduler.runQueuedAutomation(historyId, nextLaunch("release-app"));
    });
    assert.equal(runNowWarnings.filter(line => line.includes('Run lease release for "jobs/released-now.md" failed')).length,
      1, "the Run now's refused release was logged");
    assert.equal(runNow.error, undefined, "Run now returned without an error");
    assert.equal((await getAutomationRun(historyId)).status, "success", "the Run now row reads success");
  } finally {
    restore();
  }
  assert.ok((await runLeaseRow("released"))?.leaseOwner, "the row the release could not delete is left to expire");
  assert.ok((await runLeaseRow("released-now"))?.leaseOwner, "the Run now's row is left to expire too");
});

test("a running mark the scan cannot check leaves the rest of the scan", async () => {
  await defineScheduled("check-app", "unchecked");
  await defineScheduled("check-app", "checked-due");
  await patchStored("unchecked", { lastStatus: "running", lastRun: minutesAgo(11) });
  await makeDue("checked-due");
  const restore = refuseQueries((sql, args) => /^INSERT INTO automation_scheduler_health\s/.test(sql)
    && args[0] === `run:${runLeaseKey("unchecked")}`);
  let warnings;
  try {
    warnings = await consoleLines("warn", () => scheduler.processRecurringJobs(nextLaunch("check-app")));
  } finally {
    restore();
  }
  assert.equal(markCheckFailures(warnings).length, 1, "the failed check was logged");
  assert.equal((await stored("unchecked")).lastStatus, "running", "the scan left the mark it could not check");
  assert.deepEqual((await runsOf("check-app", "checked-due")).map(run => run.status), ["success"],
    "another due automation started in the same tick");
  assert.equal((await leaseRow("check-app")).lastError, null, "the scan recorded no error");
});

// Issue #140. While a lease keeps the scheduler from acting on an automation, the list must not name a next run before
// that lease expires.
test("the list names no next run before a killed run's lease lets the scheduler act", async t => {
  await defineScheduled("dead-run-app", "dead-run");
  await makeDue("dead-run");
  const { child, report, exited } = spawnChild("hold", "dead-run-app");
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const { running, runLease: held } = await report;
  assert.equal(running, "dead-run");
  assert.ok(held.leaseOwner, "the child holds the run's lease");
  child.kill("SIGKILL");
  const killedAt = Date.now();
  await within(exited, 10_000, "the killed child exiting");
  // Defined after the kill, so the child's scan could not start it.
  await defineScheduled("dead-run-app", "unblocked");

  const lease = await runLeaseRow("dead-run");
  assert.equal(lease?.leaseOwner, held.leaseOwner, "the run lease still names the killed process");
  const resumesAt = lease.leaseExpiresAt;
  assert.ok(resumesAt - killedAt > 8 * 60_000,
    `the run lease holds more than 8 minutes after the kill (${resumesAt - killedAt} ms)`);
  const markBefore = await stored("dead-run");
  const listedAt = Date.now();
  const rows = await listAutomations.default.run({ scope: "personal" }, { userEmail: owner, appId: "dead-run-app" });
  const dead = rows.find(row => row.name === "dead-run");
  const unblocked = rows.find(row => row.name === "unblocked");
  assert.equal(dead.lastStatus, "running", "the killed run's automation reads running");
  assert.deepEqual(await runLeaseRow("dead-run"), lease, "listing left the run lease alone");
  assert.deepEqual(await stored("dead-run"), markBefore, "listing left the running mark alone");
  assert.equal(await runLeaseRow("unblocked"), null, "the other automation holds no run lease");
  assert.notEqual(unblocked.lastStatus, "running", "the other automation is not running");
  const unblockedNext = Date.parse(unblocked.nextRun);
  assert.ok(unblockedNext >= listedAt && unblockedNext - listedAt <= 61_000,
    `an automation no lease blocks lists its next run within a minute (${unblocked.nextRun})`);
  assert.ok(dead.nextRun === null || Date.parse(dead.nextRun) >= resumesAt,
    `the list named a next run before the killed run's lease lets the scheduler act (${dead.nextRun}, lease until ${
      new Date(resumesAt).toISOString()})`);
});

test("the list names no next run while a dead scanner's lease blocks every scan", async () => {
  await defineScheduled("stuck-app", "blocked");
  await makeDue("blocked");
  // A scanner that died two minutes into its scan, far longer than a scan takes, left this lease.
  const takenAt = Date.now() - 2 * 60_000;
  const resumesAt = takenAt + AUTOMATION_SCHEDULER_LEASE_MS;
  const deadOwner = randomBytes(16).toString("hex");
  await ensureHealthTable();
  await getDbExec().execute({
    sql: `INSERT INTO automation_scheduler_health (id, app_id, org_id, last_checked_at, last_dispatched_at, last_error,
      runtime, updated_at, lease_owner, lease_expires_at) VALUES (?, ?, NULL, ?, NULL, NULL, 'recurring-jobs', ?, ?, ?)`,
    args: ["stuck-app:global", "stuck-app", takenAt, takenAt, deadOwner, resumesAt],
  });
  await within(scheduler.processRecurringJobs(nextLaunch("stuck-app")), 30_000, "the tick");
  const afterTick = await leaseRow("stuck-app");
  assert.deepEqual([afterTick?.leaseOwner, afterTick?.lastCheckedAt], [deadOwner, takenAt],
    "the tick could not scan while the dead scanner's lease held");
  assert.deepEqual(await runsOf("stuck-app", "blocked"), [], "the tick started nothing");
  const blocked = (await listAutomations.default.run({ scope: "personal" }, { userEmail: owner, appId: "stuck-app" }))
    .find(row => row.name === "blocked");
  assert.deepEqual(await leaseRow("stuck-app"), afterTick, "listing left the lease alone");
  assert.ok(blocked.nextRun === null || Date.parse(blocked.nextRun) >= resumesAt,
    `the list named a next run while a dead scanner's lease blocks every scan (${blocked.nextRun}, lease until ${
      new Date(resumesAt).toISOString()})`);
});

const scheduleList = async appId => Object.fromEntries((await listAutomations.default.run({ scope: "personal" },
  { userEmail: owner, appId })).map(row => [row.name, row]));
// An hourly schedule whose occurrence is `minutes` from now, so a case never depends on the time of day.
const hourlyIn = minutes => `${(new Date().getUTCMinutes() + minutes) % 60} * * * *`;
const nextRunOf = row => [row.nextRun, row.schedulerWait];

test("a run lease that stopped renewing lists when scheduling resumes, and the reset lists its next run", async () => {
  await defineScheduled("stalled-app", "stalled", hourlyIn(5));
  const lastRun = Date.now() - 5 * 60_000;
  await patchStored("stalled", { lastStatus: "running", lastRun: new Date(lastRun).toISOString() });
  const key = runLeaseKey("stalled");
  assert.ok(await acquireAutomationRunLease({ key }), "this process holds the run lease");
  await getDbExec().execute({ sql: "UPDATE automation_scheduler_health SET updated_at = ? WHERE id = ?",
    args: [Date.now() - 3 * 60_000, `run:${key}`] });
  const { leaseExpiresAt } = await runLeaseRow("stalled");
  assert.deepEqual(nextRunOf((await scheduleList("stalled-app")).stalled), [null, { reason: "stalled-run",
    resumesAfter: new Date(Math.max(leaseExpiresAt, lastRun + 10 * 60_000)).toISOString() }],
  "a lease not written for 3 minutes lists when scheduling resumes");

  await getDbExec().execute({ sql: "UPDATE automation_scheduler_health SET lease_expires_at = ? WHERE id = ?",
    args: [Date.now() - 1, `run:${key}`] });
  await patchStored("stalled", { lastRun: minutesAgo(11) });
  await scheduler.processRecurringJobs(nextLaunch("stalled-app"));
  const reset = await stored("stalled");
  assert.equal(reset.lastStatus, "error", "a tick reset the mark once the lease and the time limit passed");
  assert.deepEqual(nextRunOf((await scheduleList("stalled-app")).stalled), [reset.nextRun, null],
    "after the reset the list names the stored next run");
});

test("a live run hides a next run it can delay and keeps a later one", async t => {
  await defineScheduled("live-list-app", "live-minute");
  await defineScheduled("live-list-app", "live-hourly", hourlyIn(30));
  await makeDue("live-minute");
  const { child, report, exited } = spawnChild("hold", "live-list-app");
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const { running } = await report;
  assert.equal(running, "live-minute");
  const key = runLeaseKey("live-hourly");
  const hourlyOwner = await acquireAutomationRunLease({ key });
  assert.ok(hourlyOwner, "this process holds the hourly automation's run lease");
  try {
    await patchStored("live-hourly", { lastStatus: "running", lastRun: new Date().toISOString() });
    const rows = await scheduleList("live-list-app");
    assert.deepEqual(nextRunOf(rows["live-minute"]), [null, { reason: "run", resumesAfter: null }],
      "a live run hides the next minute");
    assert.equal(rows["live-hourly"].schedulerWait, null, "a live run leaves an occurrence it cannot delay");
    assert.ok(Date.parse(rows["live-hourly"].nextRun) - Date.now() > 25 * 60_000,
      `the hourly automation keeps its hour (${rows["live-hourly"].nextRun})`);
  } finally {
    await releaseAutomationRunLease({ key, owner: hourlyOwner });
  }
});

test("a live scan's scheduler lease changes no listed row", async () => {
  await defineScheduled("scan-list-app", "scanned");
  await patchStored("scanned", { nextRun: new Date(Date.now() + 3 * 60_000).toISOString() });
  const before = await scheduleList("scan-list-app");
  const leaseOwner = await acquireAutomationSchedulerLease({ appId: "scan-list-app" });
  assert.ok(leaseOwner, "this process holds the scheduler lease, as a scan does");
  try {
    assert.deepEqual(await scheduleList("scan-list-app"), before, "a lease its holder still writes changes no row");
  } finally {
    await releaseAutomationSchedulerLease({ appId: "scan-list-app", owner: leaseOwner });
  }
});

test("a dead scanner's lease leaves paused and event automations as they were", async () => {
  await defineScheduled("stuck-controls-app", "stuck-due");
  await makeDue("stuck-due");
  await defineScheduled("stuck-controls-app", "stuck-paused");
  await updateAutomation({ userEmail: owner, appId: "stuck-controls-app" }, { scope: "personal", name: "stuck-paused",
    enabled: false });
  await defineAutomation({ userEmail: owner, appId: "stuck-controls-app" }, { scope: "personal", name: "stuck-event",
    body: "Summarize the event.", triggerType: "event", event: "test.event.fired" });
  const before = await scheduleList("stuck-controls-app");
  const takenAt = Date.now() - 2 * 60_000;
  await ensureHealthTable();
  await getDbExec().execute({
    sql: `INSERT INTO automation_scheduler_health (id, app_id, org_id, last_checked_at, last_dispatched_at, last_error,
      runtime, updated_at, lease_owner, lease_expires_at) VALUES (?, ?, NULL, ?, NULL, NULL, 'recurring-jobs', ?, ?, ?)`,
    args: ["stuck-controls-app:global", "stuck-controls-app", takenAt, takenAt, randomBytes(16).toString("hex"),
      takenAt + AUTOMATION_SCHEDULER_LEASE_MS],
  });
  const after = await scheduleList("stuck-controls-app");
  assert.deepEqual(nextRunOf(after["stuck-due"]), [null, { reason: "scheduler",
    resumesAfter: new Date(takenAt + AUTOMATION_SCHEDULER_LEASE_MS).toISOString() }], "the lease blocks a due automation");
  assert.deepEqual(nextRunOf(after["stuck-paused"]), [null, null], "a paused automation lists no next run and no wait");
  assert.deepEqual(after["stuck-event"], before["stuck-event"], "an event automation lists as before");
});

// Trigger runs at quit: an event run and webhook call A are in flight and call B waits behind A. The child exits as
// soon as the stop returns, as the CLI host does, so a write the stop did not wait for is lost.
const PLATFORM = "automation-webhook";
const defineTrigger = (appId, name, fields) => defineAutomation({ userEmail: owner, appId },
  { scope: "personal", name, body: "Summarize the event in one sentence.", ...fields });
const queueWebhookCall = async (name, eventId, id) => {
  const resource = await resourceGetByPath(owner, `jobs/${name}.md`);
  await insertPendingTask({ id, platform: PLATFORM, externalThreadId: `${resource.owner}:${resource.path}`,
    ownerEmail: owner, orgId: null, externalEventKey: `${resource.id}:${eventId}`,
    payload: JSON.stringify({ kind: "automation-webhook", automationId: resource.id, owner: resource.owner,
      path: resource.path, eventId, payload: { id: eventId } }) });
};
const taskRow = async id => (await getDbExec().execute({
  sql: "SELECT id, status, attempts, payload, error_message, created_at, updated_at FROM integration_pending_tasks WHERE id = ?",
  args: [id],
})).rows[0];
const webhookPayload = row => JSON.parse(row.payload);
let triggerQuitting;
const triggerQuit = () => {
  triggerQuitting ??= (async () => {
    await defineTrigger("trigger-app", "hook", { triggerType: "webhook" });
    await defineTrigger("trigger-app", "watcher", { triggerType: "event", event: "test.event.fired" });
    await queueWebhookCall("hook", "evt-a", "task-a");
    await queueWebhookCall("hook", "evt-b", "task-b");
    const { report, exited } = spawnChild("trigger-quit", "trigger-app");
    await report;
    await exited;
  })();
  return triggerQuitting;
};

test("a quit ends an event run as interrupted and records it before the stop returns", async () => {
  await triggerQuit();
  const runs = await runsOf("trigger-app", "watcher");
  assert.deepEqual(runs.map(run => run.status), ["interrupted"], "one run, interrupted");
  assert.equal(runs[0].error, INTERRUPTED_RUN_MESSAGE);
  assert.equal(runs[0].errorCode, INTERRUPTED_RUN_ERROR_CODE);
  const meta = await stored("watcher");
  assert.equal(meta.lastStatus, "error", "the dispatcher recorded the outcome before the process exited");
  assert.match(meta.lastError ?? "", /^The run stopped before it recorded a result/);
});

test("a quit waits for an event run's outcome when nothing else is in flight", async () => {
  await defineTrigger("event-app", "solo", { triggerType: "event", event: "test.event.fired" });
  const { report, exited } = spawnChild("event-quit", "event-app");
  await report;
  await exited;
  assert.deepEqual((await runsOf("event-app", "solo")).map(run => run.status), ["interrupted"]);
  const meta = await stored("solo");
  assert.equal(meta.lastStatus, "error", "the stop waited for the dispatcher's write");
  assert.match(meta.lastError ?? "", /^The run stopped before it recorded a result/);
});

test("a quit returns an interrupted webhook call and the call behind it to the queue", async () => {
  await triggerQuit();
  const a = await taskRow("task-a");
  const b = await taskRow("task-b");
  assert.equal(a.status, "pending", "the interrupted call is queued again");
  assert.equal(Number(a.attempts), 0, "the quit did not spend an attempt");
  assert.equal(webhookPayload(a).eventId, "evt-a", "its payload is kept");
  assert.equal(a.error_message, INTERRUPTED_RUN_MESSAGE);
  assert.equal(b.status, "pending", "the call behind it was not started");
  assert.equal(Number(b.attempts), 0);
  assert.equal(webhookPayload(b).eventId, "evt-b");
  assert.equal(b.error_message, null);
  const runs = await runsOf("trigger-app", "hook");
  assert.deepEqual(runs.map(run => run.status), ["interrupted"], "one history row, for call A only");

  // The next launch: the retry sweep delivers both calls, A then B, once each.
  const calls = [];
  const triggerEngine = { ...quickEngine, async *stream(options) {
    calls.push(JSON.stringify(options.messages).match(/Event ID: ([a-z0-9-]+)/)?.[1]);
    yield* quickEngine.stream(options);
  } };
  await initTriggerDispatcher({ ...nextLaunch("trigger-app"), engine: triggerEngine, apiKey: "synthetic-condition-key" });
  setInProcessIntegrationTaskRunner(webhookTask.runAutomationWebhookTaskInProcess, { platforms: [PLATFORM],
    appId: "trigger-app", acceptsTask: webhookTask.webhookTaskBelongsToApp,
    expireTask: webhookTask.expireAutomationWebhookTask, maxTaskAgeMs: webhookTask.AUTOMATION_WEBHOOK_MAX_TASK_AGE_MS });
  const agedAt = Date.now() - 90_000;
  for (const [id, at] of [["task-a", agedAt - 1], ["task-b", agedAt]]) {
    await getDbExec().execute({ sql: "UPDATE integration_pending_tasks SET created_at = ?, updated_at = ? WHERE id = ?",
      args: [at, at, id] });
  }
  assert.equal((await retryStuckPendingTasks()).selected, 2, "both calls are due 90 seconds after the quit");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await taskRow("task-b")).status !== "completed") {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await taskRow("task-a")).status, "completed");
  assert.equal((await taskRow("task-b")).status, "completed");
  assert.deepEqual(calls, ["evt-a", "evt-b"], "A ran, then B, once each");
  assert.deepEqual((await runsOf("trigger-app", "hook")).map(run => run.status), ["success", "success", "interrupted"]);
  assert.equal((await retryStuckPendingTasks()).selected, 0, "a finished call is not delivered again");
  assert.equal(calls.length, 2);
});

test("a quit waits for Core's process-task route to queue its interrupted webhook call again", async () => {
  // A host without the in-process runner runs a webhook call through the route. The child exits as soon as the stop
  // returns.
  await defineTrigger("route-app", "route-hook", { triggerType: "webhook" });
  await queueWebhookCall("route-hook", "evt-route", "task-route");
  const { report, exited } = spawnChild("route-quit", "route-app");
  await report;
  await exited;
  const task = await taskRow("task-route");
  assert.equal(task.status, "pending", "the stop waited for the route's task write");
  assert.equal(Number(task.attempts), 0, "the quit did not spend an attempt");
  assert.equal(webhookPayload(task).eventId, "evt-route", "its payload is kept");
  assert.equal(task.error_message, INTERRUPTED_RUN_MESSAGE);
  assert.deepEqual((await runsOf("route-app", "route-hook")).map(run => run.status), ["interrupted"]);
});

test("a quit that begins while Core's process-task route claims a webhook call waits for that call", async () => {
  // The stop begins while the route's claim is saving. The child exits as soon as the stop returned and the claim
  // saved.
  await defineTrigger("claim-app", "claim-hook", { triggerType: "webhook" });
  await queueWebhookCall("claim-hook", "evt-claim", "task-route-claim");
  const { report, exited } = spawnChild("route-claim", "claim-app");
  await report;
  await exited;
  const task = await taskRow("task-route-claim");
  assert.equal(task.status, "pending", "the stop waited for the call whose claim was saving");
  assert.equal(Number(task.attempts), 0, "the quit did not spend an attempt");
  assert.equal(webhookPayload(task).eventId, "evt-claim", "its payload is kept");
  assert.equal(task.error_message, INTERRUPTED_RUN_MESSAGE);
  assert.deepEqual((await runsOf("claim-app", "claim-hook")).map(run => run.status), ["interrupted"],
    "its run was stopped and recorded before the stop returned");
});

test("the stop waits for work tracked after it began, and ends at its bound", async () => {
  const { report, exited } = spawnChild("endless", "endless-app");
  const result = await report;
  await exited;
  assert.ok(result.elapsedMs >= 450 && result.elapsedMs < 3_000,
    `the stop waited for work tracked after it began, until its 500 ms bound (${result.elapsedMs} ms)`);
  assert.ok(result.linksAtStop > 3, `the stop waited for each new piece of work (${result.linksAtStop} settled)`);
  assert.equal(result.passesAfter, result.passesAtStop, "no pass of the wait started after the stop returned");
});

// Work that arrives while the process stops starts no run and writes nothing.
let lateStopping;
const lateStop = () => {
  lateStopping ??= (async () => {
    await defineScheduled("late-app", "late-job");
    await defineScheduled("late-app", "late-claimed", "0 0 1 1 *");
    await defineTrigger("late-app", "late-watcher", { triggerType: "event", event: "test.event.fired" });
    await defineTrigger("late-app", "late-hook", { triggerType: "webhook" });
    await defineTrigger("late-app", "late-route-hook", { triggerType: "webhook" });
    // Two event automations with a condition, each on its own event, so each handler sees one trigger.
    await defineTrigger("late-app", "late-gated", { triggerType: "event", event: "test.gate.fired",
      condition: "The event carries the gate marker." });
    await defineTrigger("late-app", "late-filter", { triggerType: "event", event: "test.filter.fired",
      condition: "The event carries the filter marker." });
    await queueWebhookCall("late-hook", "evt-late", "task-late");
    await queueWebhookCall("late-route-hook", "evt-route-late", "task-route-late");
    await makeDue("late-job");
    const before = { job: await stored("late-job"), claimed: await stored("late-claimed"),
      task: await taskRow("task-late"), routeTask: await taskRow("task-route-late"), filter: await stored("late-filter") };
    const { report, exited } = spawnChild("late", "late-app");
    const result = await report;
    await exited;
    return { before, result };
  })();
  return lateStopping;
};

test("a sweep scanning when the stop begins starts nothing, and a second stop returns the first", async () => {
  const { before, result } = await lateStop();
  assert.equal(result.sameStop, true, "a second call returns the first stop");
  assert.equal(result.lease.leaseOwner, null, "the sweep released the lease");
  assert.equal(result.lease.lastDispatchedAt, null, "the sweep dispatched nothing");
  const meta = await stored("late-job");
  assert.equal(meta.nextRun, before.job.nextRun, "the job is still due for the next launch");
  assert.equal(meta.lastStatus, undefined);
});

test("after the stop, an event, a Run now, and a webhook call start no run", async () => {
  const { before, result } = await lateStop();
  assert.deepEqual(result.starts, [], "no run reached the model");
  assert.equal(result.handlers.event, 1, "the dispatcher's handler finished with the event before the report");
  assert.deepEqual(await runsOf("late-app", "late-watcher"), [], "the event wrote no run");
  assert.equal((await stored("late-watcher")).lastStatus, undefined, "the event automation was not marked running");
  assert.equal(result.runNow.status, "skipped");
  assert.deepEqual(await runsOf("late-app", "late-job"), [], "Run now wrote no run");
  assert.equal((await stored("late-job")).lastStatus, undefined, "Run now did not mark the job running");
  assert.equal(result.webhook, "skipped");
  const task = await taskRow("task-late");
  assert.equal(task.status, "pending", "the webhook call stays queued");
  assert.equal(Number(task.attempts), 0, "it was not claimed");
  assert.equal(task.updated_at, before.task.updated_at);
  assert.deepEqual(await runsOf("late-app", "late-hook"), []);
});

test("after the stop, Core's process-task route leaves a webhook call queued, unclaimed", async () => {
  const { before, result } = await lateStop();
  assert.deepEqual(await runsOf("late-app", "late-route-hook"), [], "the route wrote no run");
  assert.equal((await stored("late-route-hook")).lastStatus, undefined, "the automation was not marked running");
  const task = await taskRow("task-route-late");
  assert.equal(task.status, "pending", "the webhook call stays queued");
  assert.equal(Number(task.attempts), 0, "it was not claimed");
  assert.equal(task.updated_at, before.routeTask.updated_at);
  assert.equal(result.route.status, 200);
  assert.equal(result.route.body.skipped, "app-quitting");
});

test("after the stop, an event with a condition writes nothing and is not classified", async () => {
  const { before, result } = await lateStop();
  assert.equal(result.handlers.filter, 1, "the dispatcher's handler finished with the event before the report");
  assert.deepEqual(result.classifierCalls, ["gate"], "only the check that began before the stop was classified");
  const meta = await stored("late-filter");
  assert.equal(meta.lastStatus, undefined, "the handler recorded no skip");
  assert.equal(meta.lastCheck, before.filter.lastCheck, "the handler wrote no check time");
});

test("an event whose condition check was in flight when the stop began starts no run", async () => {
  const { result } = await lateStop();
  assert.equal(result.handlers.gate, 1, "the dispatcher's handler finished with the event before the report");
  assert.ok(result.classifierCalls.includes("gate"), "its condition check began before the stop and matched");
  assert.deepEqual(await runsOf("late-app", "late-gated"), [], "the event wrote no run");
  assert.equal((await stored("late-gated")).lastStatus, undefined, "the automation was not marked running");
});

test("a Run now claimed before the stop reads interrupted without starting", async () => {
  const { before, result } = await lateStop();
  assert.equal(result.claimed, true);
  assert.equal(result.claimedRun.status, "skipped");
  const row = await getAutomationRun(result.claimedId);
  assert.equal(row.status, "interrupted");
  assert.equal(row.error, INTERRUPTED_RUN_MESSAGE);
  assert.equal(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  assert.equal(row.threadId, null, "no run thread was made");
  const meta = await stored("late-claimed");
  assert.equal(meta.lastStatus, undefined, "the automation was not marked running");
  assert.equal(meta.nextRun, before.claimed.nextRun);
});

test("a run still preparing when the stop begins is interrupted before the model", async () => {
  await defineScheduled("setup-app", "slow-setup");
  await makeDue("slow-setup");
  const { report, exited } = spawnChild("setup", "setup-app");
  const result = await report;
  await exited;
  assert.deepEqual(result.starts, [], "the run never reached the model");
  assert.ok(result.elapsedMs < 3_000, `the stop waited for the run, not its bound (${result.elapsedMs} ms)`);
  const [row] = await runsOf("setup-app", "slow-setup");
  assert.equal(row.status, "interrupted");
  assert.equal(row.error, INTERRUPTED_RUN_MESSAGE);
  assert.equal((await stored("slow-setup")).lastStatus, "error");
  assert.equal(result.lease.leaseOwner, null);
});

test("a run that completed before the stop is recorded as a success", async () => {
  await defineScheduled("finish-app", "finishing");
  await makeDue("finishing");
  const { report, exited } = spawnChild("finishing", "finish-app");
  const { runId } = await report;
  await exited;
  const [row] = await runsOf("finish-app", "finishing");
  assert.equal(row.status, "success", "the quit did not relabel a finished run");
  const { rows } = await getDbExec().execute({ sql: "SELECT status, abort_reason FROM agent_runs WHERE id = ?",
    args: [runId] });
  assert.equal(rows[0].status, "completed", "the stop did not abort a run that was no longer running");
  assert.equal(rows[0].abort_reason ?? null, null);
  assert.equal((await stored("finishing")).lastStatus, "success");
});

test("a quit after a soft-timeout boundary reads interrupted, not cut off", async () => {
  await defineScheduled("soft-app", "soft");
  await makeDue("soft");
  const { report, exited } = spawnChild("soft-cut", "soft-app");
  const { statusAtQuit } = await report;
  await exited;
  assert.equal(statusAtQuit, "running", "the quit landed while the run was still running");
  const [row] = await runsOf("soft-app", "soft");
  assert.equal(row.status, "interrupted");
  assert.equal(row.error, INTERRUPTED_RUN_MESSAGE);
  assert.equal(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  const meta = await stored("soft");
  assert.equal(meta.lastStatus, "error");
  assert.equal(meta.lastError, INTERRUPTED_RUN_MESSAGE);
});

test("a quit leaves a run the owner stopped just before it with its own reason", async () => {
  await defineScheduled("halt-app", "halted");
  await makeDue("halted");
  const { report, exited } = spawnChild("user-stop", "halt-app");
  const { runId, statusAtQuit } = await report;
  await exited;
  assert.equal(statusAtQuit, "aborted", "the quit landed while the stopped run was still in the runner's list");
  const [row] = await runsOf("halt-app", "halted");
  assert.equal(row.status, "error", "the quit did not relabel the stopped run");
  assert.notEqual(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  const { rows } = await getDbExec().execute({ sql: "SELECT status, abort_reason FROM agent_runs WHERE id = ?",
    args: [runId] });
  assert.equal(rows[0].abort_reason, "user", "the stop did not abort the run again");
});

// An automation with a paired execution host is queued on that host, and the stop cannot abort a run there.
test("a quit that begins while a remote run is marked running queues nothing on the paired host", async () => {
  const [{ createRemoteDevice }, { listRemoteCommandsForOwner }] = await Promise.all([
    load("integrations/remote-devices-store.js"),
    load("integrations/remote-commands-store.js"),
  ]);
  const { device } = await createRemoteDevice({ ownerEmail: owner, label: "Always-on test host" });
  const hostCommands = async () => (await listRemoteCommandsForOwner({ ownerEmail: owner }))
    .filter(command => command.deviceId === device.id);
  for (const [name, schedule] of [["remote-job", "* * * * *"], ["remote-manual", "0 0 1 1 *"]]) {
    await defineAutomation({ userEmail: owner, appId: "remote-app" }, { scope: "personal", name,
      body: "Summarize the project in one sentence.", triggerType: "schedule", schedule, timezone: "UTC",
      executionHostId: device.id });
  }
  await makeDue("remote-job");
  const before = { job: await stored("remote-job"), manual: await stored("remote-manual") };
  const { report, exited } = spawnChild("remote-mark", "remote-app");
  const result = await report;
  await exited;
  assert.deepEqual([...result.marking].sort(), ["jobs/remote-job.md", "jobs/remote-manual.md"],
    "the stop began while both runs were being marked");
  assert.equal((await hostCommands()).length, 0, "the quit queued nothing on the paired host");
  const job = await stored("remote-job");
  assert.equal(job.lastStatus, before.job.lastStatus, "the scheduled run is not left running");
  assert.equal(job.lastRun, before.job.lastRun);
  assert.equal(job.nextRun, before.job.nextRun, "the scheduled run stays due");
  assert.deepEqual(await runsOf("remote-app", "remote-job"), [], "the scheduled run wrote no history row");
  assert.deepEqual(result.manual, { skipped: false, error: "The app is quitting, so the run did not start." });
  const row = await getAutomationRun(result.manualId);
  assert.equal(row.status, "interrupted", "the claimed Run now row reads interrupted");
  assert.equal(row.errorCode, INTERRUPTED_RUN_ERROR_CODE);
  assert.equal(row.threadId, null, "no run thread was made");
  const manual = await stored("remote-manual");
  assert.equal(manual.lastStatus, before.manual.lastStatus, "the Run now is not left running");
  assert.equal(manual.nextRun, before.manual.nextRun);
  // The next launch sends the due run to the host.
  await scheduler.processRecurringJobs(nextLaunch("remote-app"));
  assert.equal((await hostCommands()).length, 1, "the next launch queued the due run on the paired host");
});

test("Vivary's shutdown owner stops automations within the Code host's wait", async () => {
  const lifecycle = await readFile(path.join(HERE, "..", "server", "plugins", "02-local-code-lifecycle.ts"), "utf8");
  assert.match(lifecycle, /import \{ stopRecurringJobs \} from "@agent-native\/core\/jobs";/);
  const stopLocalWork = lifecycle.slice(lifecycle.indexOf("const stopLocalWork"), lifecycle.indexOf("export default"));
  assert.match(stopLocalWork, /stopRecurringJobs\(\{ timeoutMs: 10_000 \}\)/, "stopLocalWork stops automations");
  const codeHost = await readFile(path.join(HERE, "..", "server", "local-code-agent.ts"), "utf8");
  assert.match(codeHost, /const SHUTDOWN_WAIT_MS = 10_000;/, "the bound matches the Code host's shutdown wait");
  const jobs = await import("@agent-native/core/jobs");
  assert.equal(typeof jobs.stopRecurringJobs, "function", "the package entry exports the stop");
  assert.equal(jobs.stopRecurringJobs, scheduler.stopRecurringJobs, "the package entry shares the scheduler's module");
});

// The shutdown owner, loaded with stand-ins for the stops it calls, so a case can make one fail. Only the lifecycle
// plugin's own imports resolve to the stand-ins, and each stand-in calls the current case's function.
const LIFECYCLE = pathToFileURL(path.join(HERE, "..", "server", "plugins", "02-local-code-lifecycle.ts")).href;
const lifecycleStandIns = {
  "@agent-native/core/jobs": "export const stopRecurringJobs = options => globalThis.__lifecycleStops.automations(options);",
  "@agent-native/core/server": "export const defineNitroPlugin = plugin => plugin;",
  "../local-code-agent.ts": "export const initializeVivaryCodeAgent = async () => {};\n"
    + "export const shutdownVivaryCodeAgent = () => globalThis.__lifecycleStops.code();",
  "../codex-session-process.ts": "export const shutdownCodexSessionReaders = () => globalThis.__lifecycleStops.reader();",
  "../original-runtime.ts": "export const shutdownOriginalCommands = () => globalThis.__lifecycleStops.commands();",
  "../project-preview.ts": "export const shutdownProjectPreviews = () => globalThis.__lifecycleStops.previews();",
};
let shutdownOwner;
const loadShutdownOwner = () => {
  shutdownOwner ??= (async () => {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === LIFECYCLE && Object.hasOwn(lifecycleStandIns, specifier)) {
          return { url: `data:text/javascript,${encodeURIComponent(lifecycleStandIns[specifier])}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    return (await import(LIFECYCLE)).default;
  })();
  return shutdownOwner;
};
// One case's stops. The automation stop settles when the case lets it. The Code host stop returns a rejected promise,
// marked handled so an owner that never waits for it cannot end this process. The command stop throws as it is
// called, as a plain function can.
const shutdownStops = () => {
  const events = [];
  let finishAutomations;
  const automationsStopping = new Promise(resolve => { finishAutomations = resolve; });
  globalThis.__lifecycleStops = {
    reader: () => { events.push("reader"); return Promise.resolve(); },
    automations: () => {
      events.push("automations");
      return automationsStopping.then(() => { events.push("automations settled"); });
    },
    code: () => {
      events.push("code");
      const failure = Promise.reject(new Error("The Code host stop failed."));
      failure.catch(() => {});
      return failure;
    },
    commands: () => {
      events.push("commands");
      throw new Error("The command stop failed.");
    },
    previews: () => {
      events.push("previews");
      return Promise.resolve();
    },
  };
  return { events, finishAutomations };
};
const fakeNitro = () => {
  const hooks = new Map();
  return {
    hooks: { hook: (name, handler) => { hooks.set(name, handler); }, callHook: async name => hooks.get(name)?.() },
    close: () => hooks.get("close")(),
  };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("the shutdown owner starts every stop and reports a failed one only after the automation stop settled", async () => {
  const stops = shutdownStops();
  const nitro = fakeNitro();
  await (await loadShutdownOwner())(nitro);
  const closing = nitro.close().then(() => { stops.events.push("closed"); },
    error => { stops.events.push(`failed: ${error.message}`); });
  await nextTurn();
  assert.deepEqual(stops.events, ["reader", "automations", "code", "commands", "previews"],
    "reader admission closes first and every owner starts, although one throws and one rejects");
  stops.finishAutomations();
  await closing;
  assert.equal(stops.events[5], "automations settled", "the close hook waited for the automation stop");
  assert.match(stops.events[6] ?? "", /^failed: The (Code host|command) stop failed\.$/, "the failure still reached the host");
});

test("a shutdown signal whose stop throws reports the failure only after the automation stop settled", async t => {
  const stops = shutdownStops();
  const before = process.listeners("SIGTERM");
  await (await loadShutdownOwner())(fakeNitro());
  const [onSignal] = process.listeners("SIGTERM").filter(listener => !before.includes(listener));
  const originalError = console.error;
  console.error = (...args) => { stops.events.push(`logged: ${args.map(String).join(" ")}`); };
  t.after(() => {
    console.error = originalError;
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  });
  // On the standalone CLI host, the handler exits with code 1 right after it logs the failure.
  assert.doesNotThrow(() => onSignal(), "the signal handler did not throw while the automation stop was running");
  await nextTurn();
  assert.deepEqual(stops.events, ["reader", "automations", "code", "commands", "previews"], "nothing was logged yet");
  stops.finishAutomations();
  for (let turn = 0; turn < 50 && stops.events.length < 7; turn += 1) await nextTurn();
  assert.deepEqual(stops.events.slice(5), ["automations settled", "logged: [vivary-local-host] Shutdown did not settle."],
    "the failure was logged after the automation stop settled");
});
