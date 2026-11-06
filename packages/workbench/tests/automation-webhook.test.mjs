import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

// The packaged app runs as a production server with no app URL and no A2A_SECRET, so Core cannot
// dispatch a webhook task back to itself over HTTP. The maintained Core patch lets the server that
// owns the recurring-jobs timer run the task in its own process. Core's package entries do not
// export these modules, so load the installed, patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-webhook-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
for (const name of ["DEPLOY_PRIME_URL", "DEPLOY_URL", "URL", "APP_URL", "BETTER_AUTH_URL", "A2A_SECRET",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes app URL, signing, and provider key names. No value is read.
}
// The webhook token is stored as an encrypted app secret, which needs a key in production.
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
const [dispatch, webhookTask, pendingTasks, retryJob, { initTriggerDispatcher }, { createAutomationsHandler },
  { defineAutomation }, { getDbExec }, { listAutomationRuns }, { getThread }, webhookUrl, { resourceGetByPath },
  webhookReach, { resolvePublicAppOriginConfig }] = await Promise.all([
  load("integrations/integration-durable-dispatch.js"),
  // A missing module fails each case below rather than the whole file.
  load("integrations/automation-webhook-task.js").catch(() => ({})),
  load("integrations/pending-tasks-store.js"),
  load("integrations/pending-tasks-retry-job.js"),
  load("triggers/dispatcher.js"),
  load("triggers/routes.js"),
  load("automations/service.js"),
  load("db/client.js"),
  load("jobs/run-history.js"),
  load("chat-threads/store.js"),
  load("client/integrations/webhook-url.js"),
  load("resources/store.js"),
  load("shared/automation-webhook-reach.js").catch(() => ({})),
  load("server/app-origin-config.js"),
]);
const { setInProcessIntegrationTaskRunner } = dispatch;
const { runAutomationWebhookTaskInProcess, webhookTaskBelongsToApp, expireAutomationWebhookTask } = webhookTask;
const { claimPendingTask, insertPendingTask } = pendingTasks;
const { retryStuckPendingTasks } = retryJob;
const { H3, toNodeHandler } = await import("h3");

const owner = "owner@example.test";
const appId = "workbench";
const PLATFORM = "automation-webhook";
const engineCalls = [];
// The engine is injected through the dispatcher's dependencies. No provider key is stored or set,
// which is how an owner with a launch-environment key or a keyless local model looks to Core.
const engine = {
  name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
  capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
  async *stream(options) {
    engineCalls.push(JSON.stringify(options.messages));
    yield { type: "assistant-content", parts: [{ type: "text", text: "Webhook handled." }] };
    yield { type: "stop", reason: "end_turn" };
  },
};
await initTriggerDispatcher({ appId, engine, model: "fake-model", getActions: () => ({}), getSystemPrompt: async () => "" });
// The same registration the plugin makes.
const registerRunner = (runnerAppId = appId) => runAutomationWebhookTaskInProcess &&
  setInProcessIntegrationTaskRunner?.(runAutomationWebhookTaskInProcess, { platforms: [PLATFORM], appId: runnerAppId,
    acceptsTask: webhookTaskBelongsToApp, expireTask: expireAutomationWebhookTask,
    maxTaskAgeMs: webhookTask.AUTOMATION_WEBHOOK_MAX_TASK_AGE_MS });

const defineWebhook = async (name, extra = {}, automationAppId = appId) => {
  const defined = await defineAutomation({ userEmail: owner, appId: automationAppId }, {
    scope: "personal", name, body: "Summarize the event in one sentence.", triggerType: "webhook", ...extra,
  });
  assert.match(defined.webhookPath, /^\/_agent-native\/automations\/webhook\/[A-Za-z0-9_-]{43}$/);
  return defined.webhookPath;
};
const hookPath = await defineWebhook("hook");
const conditionPath = await defineWebhook("conditional", { condition: "The event is about billing." });
await defineWebhook("other-hook", {}, "other-app");

const app = new H3().post("/_agent-native/automations/**", createAutomationsHandler());
const server = createServer(toNodeHandler(app));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  setInProcessIntegrationTaskRunner?.(null);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  globalThis.setTimeout = originalSetTimeout;
  await rm(caseRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of ["integration_pending_tasks", "automation_runs"]) {
    await getDbExec().execute({ sql: `DELETE FROM ${table}`, args: [] }).catch(() => {});
  }
  engineCalls.length = 0;
  registerRunner();
});

const post = (webhookPath, eventId, body = { id: eventId, kind: "ping" }) => fetch(origin + webhookPath, {
  method: "POST",
  headers: { "content-type": "application/json", ...(eventId ? { "x-webhook-event-id": eventId } : {}) },
  body: JSON.stringify(body),
});
const tasks = async () => (await getDbExec().execute({
  sql: "SELECT id, status, attempts, last_dispatch_outcome, error_message, created_at, updated_at FROM integration_pending_tasks ORDER BY created_at",
  args: [],
})).rows;
const runsOf = automation => listAutomationRuns({ owners: [owner], automation, appId, limit: 20 });
const finished = rows => rows.length > 0 && rows.every(row => row.status !== "processing" && row.status !== "pending");
async function settled(done = finished, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await tasks();
    if (done(rows) || Date.now() > deadline) return rows;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const age = async (id, status, outcome, agoMs) => getDbExec().execute({
  sql: "UPDATE integration_pending_tasks SET status = ?, last_dispatch_outcome = ?, created_at = ?, updated_at = ? WHERE id = ?",
  args: [status, outcome, Date.now() - agoMs, Date.now() - agoMs, id],
});
// The row a call leaves when its process quits before running it: queued, never dispatched.
const queuedTask = async (eventId, name = "hook") => {
  const resource = await resourceGetByPath(owner, `jobs/${name}.md`);
  const id = `task-${eventId}`;
  await insertPendingTask({
    id, platform: PLATFORM, externalThreadId: `${resource.owner}:${resource.path}`, ownerEmail: owner, orgId: null,
    externalEventKey: `${resource.id}:${eventId}`,
    payload: JSON.stringify({ kind: "automation-webhook", automationId: resource.id, owner: resource.owner,
      path: resource.path, eventId, payload: { id: eventId } }),
  });
  return id;
};

test("an accepted call runs once in process, with one history row and its thread", async () => {
  assert.equal(typeof setInProcessIntegrationTaskRunner, "function", "Core exports setInProcessIntegrationTaskRunner");
  const response = await post(hookPath, "evt-1");
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, eventId: "evt-1" });
  const [row] = await settled();
  assert.equal(row.status, "completed", `the task completed (${row.error_message ?? "no error"})`);
  assert.equal(row.last_dispatch_outcome, "in-process");
  assert.equal(engineCalls.length, 1, "one model run");
  assert.match(engineCalls[0], /evt-1/, "the run saw the event id");
  const runs = await runsOf("hook");
  assert.equal(runs.length, 1, "one history row");
  assert.equal(runs[0].status, "success");
  assert.ok(runs[0].threadId, "the history row names its thread");
  assert.ok(await getThread(runs[0].threadId), "the thread exists");
});

test("a wrong token gets 404 and queues nothing", async () => {
  const wrong = hookPath.replace(/[A-Za-z0-9_-]{43}$/, "A".repeat(43));
  for (const target of [wrong, "/_agent-native/automations/webhook/not-a-token"]) {
    const response = await post(target, "evt-wrong");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Webhook not found" });
  }
  assert.equal((await tasks()).length, 0);
  assert.equal(engineCalls.length, 0);
});

test("the same event id twice runs once and answers the repeat as a duplicate", async () => {
  assert.equal((await post(hookPath, "evt-dup")).status, 202);
  await settled();
  const repeat = await post(hookPath, "evt-dup");
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { accepted: true, duplicate: true, eventId: "evt-dup" });
  await settled();
  assert.equal((await tasks()).length, 1);
  assert.equal(engineCalls.length, 1);
  assert.equal((await runsOf("hook")).length, 1);
});

test("a call accepted before a quit runs once when the sweep recovers it", async () => {
  // A call accepted by a process that quit before running it stays pending in SQLite.
  const id = await queuedTask("evt-quit");
  await age(id, "pending", null, 2 * 60_000);
  const first = await retryStuckPendingTasks();
  assert.equal(first.selected, 1);
  const [row] = await settled();
  assert.equal(row.status, "completed");
  assert.equal(engineCalls.length, 1);
  assert.equal((await retryStuckPendingTasks()).selected, 0, "a finished call is not delivered again");
  assert.equal(engineCalls.length, 1);
  assert.equal((await runsOf("hook")).length, 1);
});

test("the sweep leaves a live in-process run alone and recovers one past the claim lease", async () => {
  setInProcessIntegrationTaskRunner?.(null);
  const live = await queuedTask("evt-live");
  await age(live, "processing", "in-process", 6 * 60_000);
  const portable = await queuedTask("evt-portable");
  await age(portable, "processing", "portable-unconfirmed", 6 * 60_000);
  const first = await retryStuckPendingTasks();
  assert.equal(first.selected, 1, "only the portable row is past its 5-minute cutoff");
  const byId = Object.fromEntries((await tasks()).map(row => [row.id, row]));
  assert.equal(byId[live].status, "processing", "a 6-minute-old in-process run is not reset");

  registerRunner();
  await getDbExec().execute({ sql: "DELETE FROM integration_pending_tasks WHERE id = ?", args: [portable] });
  await age(live, "processing", "in-process", 16 * 60_000);
  assert.equal((await retryStuckPendingTasks()).selected, 1, "a run older than the claim lease was interrupted");
  const [row] = await settled();
  assert.equal(row.status, "completed");
  assert.equal(engineCalls.length, 1, "the interrupted call runs once");
});

test("a second delivery of a claimed task is skipped", async () => {
  setInProcessIntegrationTaskRunner?.(null);
  const id = await queuedTask("evt-claimed");
  assert.ok(await claimPendingTask(id, { dispatchOutcome: "in-process" }));
  assert.equal(await runAutomationWebhookTaskInProcess(id, { appId }), "skipped");
  assert.equal(engineCalls.length, 0);
});

test("another app's task is left pending for that app", async () => {
  setInProcessIntegrationTaskRunner?.(null);
  const id = await queuedTask("evt-other-app");
  assert.equal(await runAutomationWebhookTaskInProcess(id, { appId: "other-app" }), "skipped");
  const [row] = await tasks();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0, "the task was not claimed");
  assert.equal(engineCalls.length, 0);
});

// The condition classifier calls Anthropic directly. Count those calls and answer them without a network.
async function withAnthropicStub(status, run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    calls.push(url);
    return new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}
const conditionAutomation = async () => (await resourceGetByPath(owner, "jobs/conditional.md"))?.content ?? "";

test("a condition without an Anthropic key fails at once with a visible error", async () => {
  // An OpenRouter key alone cannot check a condition, because the check calls Anthropic's API.
  Object.assign(process.env, { OPENROUTER_API_KEY: `sk-or-v1-${randomBytes(24).toString("hex")}` }); // guard:allow-env-credential - A random fake key for a disposable run.
  try {
    await withAnthropicStub(401, async anthropicCalls => {
      assert.equal((await post(conditionPath, "evt-condition-openrouter")).status, 202);
      const [row] = await settled();
      assert.equal(row.status, "failed", "retrying cannot help, so the call fails at once");
      assert.equal(row.attempts, 1);
      assert.match(row.error_message ?? "", /Conditions are checked with Anthropic's API, which needs an Anthropic API key/);
      assert.equal(anthropicCalls.length, 0, "no key was sent to Anthropic");
    });
  } finally {
    for (const name of ["OPENROUTER_API_KEY"]) delete process.env[name]; // guard:allow-env-credential - Removes the fake key set above.
  }
  const [run] = await runsOf("conditional");
  assert.equal(run?.status, "error", "the history shows the refused call");
  assert.equal(run.errorCode, "automation_condition_key_missing");
  assert.match(run.error, /Add an Anthropic key, or remove the condition\. The webhook call did not run\.$/);
  assert.match(await conditionAutomation(), /lastStatus: "?error/);
  assert.equal(engineCalls.length, 0);
});

test("a condition whose Anthropic key is rejected fails at once with a visible error", async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: `sk-ant-${randomBytes(24).toString("hex")}` }); // guard:allow-env-credential - A random fake key for a disposable run.
  try {
    await withAnthropicStub(401, async anthropicCalls => {
      assert.equal((await post(conditionPath, "evt-condition-rejected")).status, 202);
      const [row] = await settled();
      assert.equal(row.status, "failed");
      assert.equal(row.attempts, 1);
      assert.equal(anthropicCalls.length, 1);
    });
  } finally {
    for (const name of ["ANTHROPIC_API_KEY"]) delete process.env[name]; // guard:allow-env-credential - Removes the fake key set above.
  }
  const [run] = await runsOf("conditional");
  assert.equal(run?.errorCode, "automation_condition_key_rejected");
  assert.match(run.error, /^Anthropic rejected the API key used to check this automation's condition \(HTTP 401\)/);
  assert.equal(engineCalls.length, 0);
});

test("a call that waited more than 24 hours is expired with a history record instead of run", async () => {
  const id = await queuedTask("evt-stale");
  await age(id, "pending", null, 25 * 60 * 60_000);
  const sweep = await retryStuckPendingTasks();
  assert.equal(sweep.markedFailed, 1);
  const [row] = await tasks();
  assert.equal(row.status, "failed");
  assert.match(row.error_message ?? "", /^This webhook call waited more than 24 hours/);
  const [run] = await runsOf("hook");
  assert.equal(run?.status, "error");
  assert.equal(run.errorCode, "automation_webhook_expired");
  await settled();
  assert.equal(engineCalls.length, 0, "the old payload never reached a run");
});

test("an expiry leaves a call that was claimed after the sweep read it", async () => {
  setInProcessIntegrationTaskRunner?.(null);
  const id = await queuedTask("evt-stale-claimed");
  await age(id, "pending", null, 25 * 60 * 60_000);
  const [read] = await tasks();
  // A chained dispatch claims the row between the sweep's read and its expiry.
  await getDbExec().execute({ sql: "UPDATE integration_pending_tasks SET status = 'processing', updated_at = ? WHERE id = ?",
    args: [Date.now(), id] });
  assert.equal(await expireAutomationWebhookTask?.(id, Number(read.updated_at)), false);
  const [row] = await tasks();
  assert.equal(row.status, "processing", "the claimed row is not failed");
  assert.deepEqual(await runsOf("hook"), [], "no expired history row");
});

test("another app's rows cannot keep this app's rows out of the sweep", async () => {
  for (let index = 0; index < 3; index += 1) {
    await age(await queuedTask(`evt-foreign-${index}`, "other-hook"), "pending", null, 3 * 60_000 + index);
  }
  const own = await queuedTask("evt-own-behind-foreign");
  await age(own, "pending", null, 2 * 60_000);
  const sweep = await retryStuckPendingTasks({ limit: 2 });
  assert.equal(sweep.skipped, 3, "the other app's rows are skipped");
  assert.equal(sweep.dispatched, 1, "this app's row, behind a full page of them, is delivered");
  await settled(rows => rows.find(row => row.id === own)?.status === "completed");
  assert.equal(engineCalls.length, 1);
});

test("an automation with 20 calls waiting answers new calls with 429", async () => {
  setInProcessIntegrationTaskRunner?.(null);
  for (let index = 0; index < 20; index += 1) await queuedTask(`evt-queued-${index}`);
  const refused = await post(hookPath, "evt-over-cap");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.match((await refused.json()).error, /already has 20 calls waiting/);
  const repeat = await post(hookPath, "evt-queued-3");
  assert.equal(repeat.status, 200, "a repeated event is still a duplicate");
  assert.equal((await tasks()).length, 20, "nothing was queued");
});

test("the sweep leaves another app's task untouched", async () => {
  const id = await queuedTask("evt-other-app-sweep");
  await age(id, "pending", null, 2 * 60_000);
  const before = (await tasks())[0];
  registerRunner("other-app");
  const sweep = await retryStuckPendingTasks();
  assert.equal(sweep.skipped, 1);
  const after = (await tasks())[0];
  assert.equal(after.status, "pending");
  assert.equal(after.attempts, 0);
  assert.equal(after.updated_at, before.updated_at, "updated_at did not move ahead of the owning app's sweep");
  assert.equal(engineCalls.length, 0);
});

test("the Automations page shows the full URL and who can call it", async () => {
  assert.equal(typeof webhookUrl.automationWebhookUrl, "function");
  const full = webhookUrl.automationWebhookUrl(hookPath, "http://127.0.0.1:4777");
  assert.equal(full, `http://127.0.0.1:4777${hookPath}`);
  assert.equal(webhookUrl.isLoopbackWebhookUrl(full), true);
  assert.equal(webhookUrl.isLoopbackWebhookUrl("http://[::1]:4777/x"), true);
  assert.equal(webhookUrl.isLoopbackWebhookUrl("http://192.168.1.4:4777/x"), false);
  assert.equal(webhookUrl.isLoopbackWebhookUrl("https://vivary.example.com/x"), false);
  const tab = await readFile(path.join(coreRoot, "dist", "client", "agent-page", "AgentJobsTab.js"), "utf8");
  assert.match(tab, /automationWebhookUrl\(entry\.resource\.webhookPath\)/);
  assert.match(tab, /Reachable only from this computer while Vivary is open\./);
  assert.match(tab, /Anyone with this URL can start this automation\./);
  assert.match(tab, /Reachable only through your private Zo access\./);
  assert.match(tab, /automationWebhookReach\(\) \?\?/);
});

test("the page config carries the webhook reach that Vivary sets from its access mode", async () => {
  assert.equal(typeof webhookReach.setAutomationWebhookReach, "function", "Core exports the reach switch");
  try {
    assert.equal(resolvePublicAppOriginConfig()?.automationWebhookReach, undefined, "unset by default");
    for (const reach of ["local", "owner-proxy", "public"]) {
      webhookReach.setAutomationWebhookReach(reach);
      assert.equal(resolvePublicAppOriginConfig()?.automationWebhookReach, reach);
    }
  } finally {
    webhookReach.setAutomationWebhookReach(undefined);
  }
  const plugin = await readFile(new URL("../server/plugins/00-webhook-reach.ts", import.meta.url), "utf8").catch(() => "");
  assert.match(plugin, /local: "local"/);
  assert.match(plugin, /"private-proxy": "owner-proxy"/);
  assert.match(plugin, /hosted: "public"/);
});

test("the plugin registers the webhook runner, with its app, where the timer runs and after the dispatcher", async () => {
  const plugin = await readFile(path.join(coreRoot, "dist", "server", "agent-chat-plugin.js"), "utf8");
  assert.equal(plugin.split("setInProcessIntegrationTaskRunner(").length - 1, 1, "one registration");
  const registration = plugin.indexOf("setInProcessIntegrationTaskRunner(runAutomationWebhookTaskInProcess, {");
  const dispatcherInit = plugin.indexOf("await initTriggerDispatcher({");
  assert.ok(dispatcherInit > 0 && registration > dispatcherInit, "the runner registers after initTriggerDispatcher");
  assert.match(plugin.slice(registration, registration + 200), /platforms: \[AUTOMATION_WEBHOOK_PLATFORM\],\s+appId: options\?\.appId,/);
  const guard = plugin.lastIndexOf("if (ownsInProcessScheduler) {", registration);
  assert.ok(guard > dispatcherInit, "the registration is guarded by the timer flag");
  assert.equal(plugin.split("ownsInProcessScheduler = true;").length - 1, 1, "one place sets the flag");
  const timerBranch = plugin.indexOf("else if (isNetlifyRecurringJobsRuntime()) {");
  const flag = plugin.indexOf("ownsInProcessScheduler = true;");
  const timerStart = plugin.indexOf("processRecurringJobs(schedulerDeps)", flag);
  assert.ok(flag > timerBranch && timerStart > flag, "only the in-process timer branch sets the flag");
  const tracked = plugin.slice(plugin.lastIndexOf("trackPluginInit(nitroApp, initPromise"));
  assert.ok(tracked.includes('"/_agent-native/automations/webhook"'), "the readiness gate holds webhook calls until the runner registers");
});
