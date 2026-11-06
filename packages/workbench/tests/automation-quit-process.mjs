// One Vivary server process for automation-quit.test.mjs. The stop is process state, so each quit, hard kill, and
// second process in that test is a separate child. This file loads the installed, patched Core by path against the
// parent's disposable database, plays one role, and reports over IPC. Usage: node <file> <role> <appId>.
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [role, appId] = process.argv.slice(2);
// A one-second soft timeout makes a run reach a boundary that ends its turn, as a long run does.
if (role === "soft-cut") process.env.AGENT_RUN_SOFT_TIMEOUT_MS = "1000"; // guard:allow-env-mutation - A test-only timeout in a disposable child.
const owner = "owner@example.test";
const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = relative => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
const [scheduler, { claimAutomationRun, startAutomationRun }, { getDbExec }, { abortRun, getRun }, { withThreadDataLock },
  { initTriggerDispatcher }, { runAutomationWebhookTaskInProcess, webhookTaskBelongsToApp },
  { setInProcessIntegrationTaskRunner }, { emit }] = await Promise.all([
  load("jobs/scheduler.js"),
  load("jobs/run-history.js"),
  load("db/client.js"),
  load("agent/run-manager.js"),
  load("chat-threads/store.js"),
  load("triggers/dispatcher.js"),
  load("integrations/automation-webhook-task.js"),
  load("integrations/integration-durable-dispatch.js"),
  load("event-bus/index.js"),
]);

const gate = () => {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
};
// The engine reports each run it starts by the automation name in the prompt, and by the event id for a trigger run.
// A cooperative run ends when its abort signal fires, as a real provider request does. A stubborn run never ends, like
// a tool call that ignores the signal. A finishing run completes and then holds its thread save, and a soft-cut run
// waits after its abort, so a quit can land in each window.
const starts = new Map();
const started = key => {
  if (!starts.has(key)) starts.set(key, gate());
  return starts.get(key);
};
const runKey = prompt => {
  const name = prompt.match(/(?:Recurring Job|Manual Automation Run|Automation Trigger): ([a-z-]+)/)?.[1] ?? "unknown";
  const eventId = prompt.match(/Event ID: ([a-z0-9-]+)/)?.[1];
  return eventId ? `${name}:${eventId}` : name;
};
const threadSave = gate();
const threadHeld = gate();
const aborted = gate();
const afterAbort = gate();
const historyOf = async name => (await getDbExec().execute({
  sql: "SELECT id, run_id, thread_id FROM automation_runs WHERE app_id = ? AND automation = ? ORDER BY started_at DESC",
  args: [appId, name],
})).rows[0];
const engine = mode => ({
  name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
  capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
  async *stream(options) {
    const key = runKey(JSON.stringify(options.messages));
    started(key).open(Date.now());
    if (mode === "stubborn") await new Promise(() => {});
    if (mode === "finishing") {
      // Hold this run's thread save, which its completion callback waits for.
      const history = await historyOf(key);
      void withThreadDataLock(history.thread_id, () => threadSave.promise);
      threadHeld.open(history.run_id);
      yield { type: "assistant-content", parts: [{ type: "text", text: "Done." }] };
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    await new Promise(resolve => {
      if (options.abortSignal?.aborted) resolve();
      options.abortSignal?.addEventListener("abort", resolve, { once: true });
    });
    if (mode === "soft-cut") {
      aborted.open();
      await afterAbort.promise;
    }
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  },
});
const deps = (mode, extra = {}) => ({ appId, engine: engine(mode), model: "fake-model", getActions: () => ({}),
  getSystemPrompt: async () => "", ...extra });
// An event condition needs an Anthropic key, and the dispatcher falls back to `deps.apiKey` when none is stored. A
// synthetic value, never sent anywhere.
const triggerDeps = mode => deps(mode, { apiKey: "synthetic-condition-key" });
const registerWebhookRunner = () => setInProcessIntegrationTaskRunner(runAutomationWebhookTaskInProcess,
  { platforms: ["automation-webhook"], appId, acceptsTask: webhookTaskBelongsToApp });
// Core's process-task route, as a host without the in-process runner reaches a webhook task. The route needs a
// signing secret in production, so this child gets a random one. The marker keeps the plugin's retry jobs from
// starting here. Every default plugin slot is marked as provided, because Core otherwise mounts its defaults on the
// first route, and the default agent chat plugin would replace this child's trigger dispatcher and webhook runner.
// Call it after any Run now row is queued, so the secret cannot change how that row is dispatched.
const mountProcessTaskRoute = async () => {
  process.env.A2A_SECRET = randomBytes(32).toString("hex"); // guard:allow-env-mutation - A random signing secret in a disposable child.
  globalThis.__AGENT_NATIVE_INTEGRATION_RECOVERY_RUNTIME__ = true;
  const [{ createIntegrationsPlugin }, { signInternalToken }, { markDefaultPluginProvided },
    { DEFAULT_PLUGIN_REGISTRY }, { H3 }] = await Promise.all([
    load("integrations/plugin.js"), load("integrations/internal-token.js"), load("server/framework-request-handler.js"),
    load("deploy/route-discovery.js"), import("h3")]);
  const nitro = { h3: new H3() };
  for (const slot of Object.keys(DEFAULT_PLUGIN_REGISTRY)) markDefaultPluginProvided(nitro, slot);
  await createIntegrationsPlugin({ adapters: [] })(nitro);
  return async taskId => {
    const response = await nitro.h3.fetch(new Request("http://127.0.0.1/_agent-native/integrations/process-task", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signInternalToken(taskId)}` },
      body: JSON.stringify({ taskId }),
    }));
    return { status: response.status, body: await response.json() };
  };
};
// The bus does not hand back its handlers' promises. Call each handler of the event as `emit` does and wait for it,
// so a case reads the database only after the dispatcher finished with the event, however slow the host.
const emitAndSettle = async (event, eventId) => {
  const handlers = globalThis[Symbol.for("@agent-native/core/event-bus.bus")]?.emitter.listeners(event) ?? [];
  const meta = { owner, eventId, emittedAt: new Date().toISOString() };
  await Promise.all(handlers.map(handler => handler({ data: { id: eventId } }, meta)));
  return handlers.length;
};
// The condition classifier calls Anthropic directly. Answer it here, never over the network. The gate condition
// holds its check until the case opens it, then matches. Any other condition does not match.
const classifierCalls = [];
const classifierCalled = gate();
const classifierGate = gate();
const stubClassifier = () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const gated = String(init?.body ?? "").includes("gate marker");
    classifierCalls.push(gated ? "gate" : "other");
    if (gated) {
      classifierCalled.open();
      await classifierGate.promise;
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: gated ? "yes" : "no" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
};

const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms).unref();
})]);
const until = async (check, ms, what) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const healthRow = async id => {
  const { rows } = await getDbExec().execute({
    sql: "SELECT lease_owner, lease_expires_at, last_checked_at, last_dispatched_at, updated_at FROM automation_scheduler_health WHERE id = ?",
    args: [id],
  });
  const row = rows?.[0];
  return row ? {
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    lastCheckedAt: row.last_checked_at == null ? null : Number(row.last_checked_at),
    lastDispatchedAt: row.last_dispatched_at == null ? null : Number(row.last_dispatched_at),
    updatedAt: Number(row.updated_at),
  } : null;
};
const leaseRow = () => healthRow(`${appId}:global`);
const runLeaseRow = name => healthRow(`run:${owner}:jobs/${name}.md`);
const runCount = async () => Number((await getDbExec().execute({
  sql: "SELECT COUNT(*) AS n FROM automation_runs WHERE app_id = ?", args: [appId],
})).rows[0].n);
const queueRunNow = name => startAutomationRun({ owner, automation: name, path: `jobs/${name}.md`, scope: "personal",
  appId, dispatchPending: true });
const stopExported = typeof scheduler.stopRecurringJobs === "function";
const report = message => new Promise(resolve => process.send(message, resolve));

if (role === "quit") {
  // A scheduled run and a Run now are in flight when the owner quits.
  const cooperative = deps("cooperative");
  const manualId = await queueRunNow("manual");
  const settledAt = {};
  const manual = scheduler.runQueuedAutomation(manualId, cooperative).finally(() => { settledAt.manual = Date.now(); });
  const sweep = scheduler.processRecurringJobs(cooperative).finally(() => { settledAt.sweep = Date.now(); });
  await within(Promise.all([started("nightly").promise, started("manual").promise]), 30_000, "both runs starting");
  if (!stopExported) {
    // Today a normal quit does nothing for automations, and the desktop ends the process 15 seconds later.
    await report({ stopExported, manualId });
    process.exit(0);
  }
  const quitAt = Date.now();
  await scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  const stoppedAt = Date.now();
  const outcomes = await Promise.allSettled([sweep, manual]);
  // After the stop, a timer tick and a Run now delivery start nothing.
  const leaseBefore = await leaseRow();
  const runsBefore = await runCount();
  await scheduler.processRecurringJobs(cooperative);
  const leaseAfter = await leaseRow();
  const runsAfter = await runCount();
  const lateId = await queueRunNow("manual");
  const late = await scheduler.runQueuedAutomation(lateId, cooperative);
  await report({ stopExported, manualId, lateId, late, quitAt, stoppedAt, settledAt,
    outcomes: outcomes.map(outcome => outcome.status), leaseBefore, leaseAfter, runsBefore, runsAfter });
  process.exit(0);
} else if (role === "trigger-quit") {
  // An event run and a webhook call A are in flight, and call B waits behind A, when the owner quits. The process
  // then exits as soon as the stop returns, as the CLI host does, so only writes the stop waited for are kept.
  await initTriggerDispatcher(triggerDeps("cooperative"));
  registerWebhookRunner();
  emit("test.event.fired", { data: { id: "evt-watch" } }, { owner, eventId: "evt-watch" });
  void runAutomationWebhookTaskInProcess("task-a", { appId });
  await within(Promise.all([started("watcher:evt-watch").promise, started("hook:evt-a").promise]), 30_000,
    "the event run and webhook call A starting");
  await report({ ready: true });
  await scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  process.exit(0);
} else if (role === "event-quit") {
  // Only an event run is in flight when the owner quits, so no other work holds the stop open for its write.
  await initTriggerDispatcher(triggerDeps("cooperative"));
  emit("test.event.fired", { data: { id: "evt-solo" } }, { owner, eventId: "evt-solo" });
  await within(started("solo:evt-solo").promise, 30_000, "the event run starting");
  await report({ ready: true });
  await scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  process.exit(0);
} else if (role === "late") {
  // Work that arrives while the process stops: a sweep scanning when the stop begins, then an event, a direct Run
  // now, a Run now whose row was claimed before the stop, a queued webhook call through the in-process runner and
  // through Core's process-task route, and an event whose condition would be checked. An event whose condition check
  // began before the stop gets its answer after the stop begins.
  stubClassifier();
  await initTriggerDispatcher(triggerDeps("cooperative"));
  registerWebhookRunner();
  const cooperative = deps("cooperative");
  const claimedId = await queueRunNow("late-claimed");
  const claimed = await claimAutomationRun(claimedId);
  const postProcessTask = await mountProcessTaskRoute();
  const gated = emitAndSettle("test.gate.fired", "evt-gate");
  await within(classifierCalled.promise, 30_000, "the condition check starting");
  const sweep = scheduler.processRecurringJobs(cooperative);
  const first = scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  const second = scheduler.stopRecurringJobs({ timeoutMs: 1 });
  classifierGate.open();
  await first;
  await sweep;
  const handlers = { gate: await gated, event: await emitAndSettle("test.event.fired", "evt-late") };
  const runNow = await scheduler.runJobNow(owner, "late-job", cooperative);
  const claimedRun = await scheduler.runJobNow(owner, "late-claimed", cooperative, { historyId: claimedId });
  const webhook = await runAutomationWebhookTaskInProcess("task-late", { appId });
  const route = await postProcessTask("task-route-late");
  handlers.filter = await emitAndSettle("test.filter.fired", "evt-filter");
  await report({ sameStop: first === second, claimed, claimedId, runNow, claimedRun, webhook, route, handlers,
    classifierCalls, starts: [...starts.keys()], lease: await leaseRow() });
  process.exit(0);
} else if (role === "route-quit") {
  // A webhook call's run is in flight through Core's process-task route when the owner quits. The process then exits
  // as soon as the stop returns, as the CLI host does, so only writes the stop waited for are kept.
  await initTriggerDispatcher(triggerDeps("cooperative"));
  const postProcessTask = await mountProcessTaskRoute();
  void postProcessTask("task-route").catch(() => {});
  await within(started("route-hook:evt-route").promise, 30_000, "the routed webhook call starting");
  await report({ ready: true });
  await scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  process.exit(0);
} else if (role === "route-claim") {
  // The owner quits while Core's process-task route is saving its claim of a webhook call. The claim is held until
  // the parent has the report, so the stop has begun before it saves. The process exits as soon as the stop returned
  // and the claim saved, as the CLI host does, so only writes the stop waited for are kept.
  await initTriggerDispatcher(triggerDeps("cooperative"));
  const postProcessTask = await mountProcessTaskRoute();
  await getDbExec().execute("SELECT 1");
  const db = getDbExec();
  const execute = db.execute.bind(db);
  const claimSaving = gate();
  const saveClaim = gate();
  const claimSaved = gate();
  let stop;
  db.execute = async query => {
    if (stop || !/UPDATE integration_pending_tasks\s+SET status = \?, attempts = attempts \+ 1/.test(query?.sql ?? "")) {
      return execute(query);
    }
    stop = scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
    claimSaving.open();
    await saveClaim.promise;
    const result = await execute(query);
    claimSaved.open();
    return result;
  };
  void postProcessTask("task-route-claim").catch(() => {});
  await within(claimSaving.promise, 30_000, "the route's claim starting");
  await report({ ready: true });
  saveClaim.open();
  await stop;
  await claimSaved.promise;
  process.exit(0);
} else if (role === "remote-mark") {
  // A scheduled run and a Run now of two automations on a paired execution host are being marked running when the
  // owner quits. Each mark is held until both are saving, then the stop begins and both save.
  await getDbExec().execute("SELECT 1");
  const db = getDbExec();
  const execute = db.execute.bind(db);
  const marking = [];
  const bothMarking = gate();
  const saveMarks = gate();
  let stopping = false;
  db.execute = async query => {
    if (stopping || !/^UPDATE resources SET content = \?/.test(query?.sql ?? "")
      || !/^lastStatus: running$/m.test(String(query.args?.[0] ?? ""))) {
      return execute(query);
    }
    marking.push(query.args[5]);
    if (marking.length === 2) bothMarking.open();
    await saveMarks.promise;
    return execute(query);
  };
  const cooperative = deps("cooperative");
  const manualId = await queueRunNow("remote-manual");
  const manual = scheduler.runQueuedAutomation(manualId, cooperative);
  const sweep = scheduler.processRecurringJobs(cooperative);
  await within(bothMarking.promise, 30_000, "both runs being marked running");
  stopping = true;
  const stop = scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  saveMarks.open();
  await stop;
  const [swept, ran] = await Promise.allSettled([sweep, manual]);
  await report({ manualId, marking, sweep: swept.status,
    manual: ran.status === "fulfilled" ? ran.value : String(ran.reason) });
  process.exit(0);
} else if (role === "endless") {
  // Work keeps arriving while the process stops: each tracked piece of work tracks the next one as it settles. The
  // stop waits for each until its bound. Each pass of its wait calls Promise.allSettled, so the count shows whether a
  // pass started after the stop returned.
  const { trackBackgroundAutomationWork } = await load("jobs/background-automation-runner.js");
  const allSettled = Promise.allSettled;
  let passes = 0;
  Promise.allSettled = function (values) {
    passes += 1;
    return allSettled.call(this, values);
  };
  let links = 0;
  const link = () => trackBackgroundAutomationWork(new Promise(resolve => setTimeout(resolve, 20)))
    .then(() => { links += 1; link(); });
  link();
  const quitAt = Date.now();
  await scheduler.stopRecurringJobs({ timeoutMs: 500 });
  const elapsedMs = Date.now() - quitAt;
  const passesAtStop = passes;
  const linksAtStop = links;
  await new Promise(resolve => setTimeout(resolve, 300));
  await report({ elapsedMs, linksAtStop, passesAtStop, passesAfter: passes });
  process.exit(0);
} else if (role === "user-stop") {
  // The owner stops a run just before the quit, so the run is still in the runner's list, aborted for its own reason.
  const sweep = scheduler.processRecurringJobs(deps("cooperative"));
  await within(started("halted").promise, 30_000, "the run starting");
  const { run_id: runId } = await historyOf("halted");
  abortRun(runId, "user");
  const statusAtQuit = getRun(runId)?.status;
  await scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  await sweep.catch(() => {});
  await report({ runId, statusAtQuit });
  process.exit(0);
} else if (role === "setup") {
  // The stop begins while a scheduled run is still preparing, before it reaches the run manager.
  const systemPrompt = gate();
  const preparing = gate();
  const sweep = scheduler.processRecurringJobs(deps("cooperative", {
    getSystemPrompt: () => { preparing.open(); return systemPrompt.promise.then(() => ""); },
  }));
  await within(preparing.promise, 30_000, "the run preparing");
  const stop = scheduler.stopRecurringJobs({ timeoutMs: 3_000 });
  systemPrompt.open();
  const quitAt = Date.now();
  await stop;
  const elapsedMs = Date.now() - quitAt;
  // A run that reached the model is never aborted here, so do not wait on its sweep for long.
  await Promise.race([sweep.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000).unref())]);
  await report({ elapsedMs, starts: [...starts.keys()], lease: await leaseRow() });
  process.exit(0);
} else if (role === "finishing") {
  // The stop begins after a run completed, while its completion callback waits for the thread save.
  const sweep = scheduler.processRecurringJobs(deps("finishing"));
  const runId = await within(threadHeld.promise, 30_000, "the run finishing");
  await until(() => getRun(runId)?.status === "completed", 10_000, "the run completing");
  const stop = scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  threadSave.open();
  await stop;
  await sweep.catch(() => {});
  await report({ runId });
  process.exit(0);
} else if (role === "soft-cut") {
  // The stop begins after a soft-timeout boundary ended the run's turn, before its engine call returned.
  const sweep = scheduler.processRecurringJobs(deps("soft-cut"));
  await within(aborted.promise, 30_000, "the soft-timeout boundary");
  const { run_id: runId } = await historyOf("soft");
  const statusAtQuit = getRun(runId)?.status;
  const stop = scheduler.stopRecurringJobs({ timeoutMs: 10_000 });
  afterAbort.open();
  await stop;
  await sweep.catch(() => {});
  await report({ runId, statusAtQuit });
  process.exit(0);
} else if (role === "hold") {
  // A process whose long run holds its run lease until the parent ends it.
  const sweep = scheduler.processRecurringJobs(deps("cooperative"));
  void sweep.catch(() => {});
  const name = await within(new Promise(resolve => {
    const poll = setInterval(() => {
      const first = [...starts.keys()][0];
      if (first) { clearInterval(poll); resolve(first); }
    }, 20);
  }), 30_000, "a run starting");
  await report({ running: name, lease: await leaseRow(), runLease: await runLeaseRow(name) });
} else if (role === "scan-hold") {
  // A sweep held in its resource scan, which runs under the lease, until the parent ends this process.
  await getDbExec().execute("SELECT 1");
  const db = getDbExec();
  const execute = db.execute.bind(db);
  const scanning = gate();
  db.execute = async query => {
    if (!/^SELECT \* FROM resources WHERE path LIKE \? ESCAPE '!'$/.test(query?.sql ?? "")) return execute(query);
    scanning.open(await leaseRow());
    return new Promise(() => {});
  };
  void scheduler.processRecurringJobs(deps("cooperative"));
  await report({ lease: await within(scanning.promise, 30_000, "the sweep's scan starting") });
} else if (role === "stop-only") {
  // A second process on the same database ticks while the first one's run is in progress, then quits.
  await scheduler.processRecurringJobs(deps("cooperative"));
  if (stopExported) await scheduler.stopRecurringJobs({ timeoutMs: 2_000 });
  await report({ stopExported });
  process.exit(0);
} else if (role === "stubborn") {
  // A run that ignores its abort signal holds the stop only until the bound.
  void scheduler.processRecurringJobs(deps("stubborn")).catch(() => {});
  await within(started("stuck").promise, 30_000, "the run starting");
  if (!stopExported) {
    await report({ stopExported });
    process.exit(0);
  }
  const quitAt = Date.now();
  await scheduler.stopRecurringJobs({ timeoutMs: 1_000 });
  const elapsedMs = Date.now() - quitAt;
  const { rows } = await getDbExec().execute({
    sql: "SELECT status FROM automation_runs WHERE app_id = ? AND automation = 'stuck'", args: [appId],
  });
  await report({ stopExported, elapsedMs, statuses: rows.map(row => row.status), lease: await leaseRow(),
    runLease: await runLeaseRow("stuck") });
  process.exit(0);
} else {
  throw new Error(`Unknown role ${role}`);
}
