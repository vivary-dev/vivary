import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

// Vivary #110. A finished automation run can emit automation.run.finished, so an event automation subscribed to it
// must not start itself, or another such automation, again. Core's package entries do not export these modules, so load
// the installed, patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-event-loop-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
// Core's engine code read these 16 names on 2026-10-01 to pick a run's engine, credential, or endpoint.
for (const name of ["AGENT_BUILT_IN_ENGINES", "AGENT_ENGINE", "AGENT_NATIVE_BUILD_ENGINE_PACKAGES",
  "ANTHROPIC_API_KEY", "BUILDER_GATEWAY_SPACE_ID", "BUILDER_GATEWAY_TOKEN", "BUILDER_PRIVATE_KEY",
  "BUILDER_PUBLIC_KEY", "COHERE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
  "OLLAMA_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes the names above. No value is read.
}
// A webhook automation's token is stored as an encrypted app secret, which needs a key in production.
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
const [{ initTriggerDispatcher, isOwnAutomationRun, parseTriggerFrontmatter, refreshEventSubscriptions },
  { defineAutomation },
  { emit, listSubscriptions, registerEvent, subscribe, unsubscribe },
  { finishAutomationRun, listAutomationRuns, startAutomationRun },
  { organizationResourceOwner, resourceDeleteByPath, resourceGetByPath }, { getThread }, { insertPendingTask },
  { runAutomationWebhookTaskInProcess },
  { queueAutomationRunNow, redispatchUnclaimedAutomationRuns, setInProcessAutomationRunner },
  { runQueuedAutomation }, { getDbExec }] = await Promise.all([
  load("triggers/dispatcher.js"),
  load("automations/service.js"),
  load("event-bus/index.js"),
  load("jobs/run-history.js"),
  load("resources/store.js"),
  load("chat-threads/store.js"),
  load("integrations/pending-tasks-store.js"),
  load("integrations/automation-webhook-task.js"),
  load("jobs/run-now.js"),
  load("jobs/scheduler.js"),
  load("db/client.js"),
]);

const owner = "owner@example.test";
const appId = "workbench";
const FAIL = "This run must fail.";
const engineRuns = [];
// The engine is injected through the dispatcher's dependencies, so a run never reaches a real provider. A run whose
// instructions carry FAIL throws, which records a failed run.
const engine = {
  name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
  capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
  async *stream(options) {
    const messages = JSON.stringify(options.messages);
    engineRuns.push(/\[(?:Automation Trigger|Manual Automation Run): ([^\]]+)\]/.exec(messages)?.[1] ?? "unknown");
    if (messages.includes(FAIL)) throw new Error("The fake engine failed this run.");
    yield { type: "assistant-content", parts: [{ type: "text", text: "Event handled." }] };
    yield { type: "stop", reason: "end_turn" };
  },
};
const dispatcherDeps = { appId, engine, model: "fake-model", getActions: () => ({}), getSystemPrompt: async () => "" };
await initTriggerDispatcher(dispatcherDeps);

after(async () => {
  globalThis.setTimeout = originalSetTimeout;
  await rm(caseRoot, { recursive: true, force: true });
});

beforeEach(() => {
  engineRuns.length = 0;
});

// The network is closed, so a run that resolves its own engine cannot reach a provider.
const realFetch = globalThis.fetch;
const fetchedUrls = [];
globalThis.fetch = async input => {
  fetchedUrls.push(String(input?.url ?? input));
  throw new Error("The test closed the network.");
};
after(() => {
  globalThis.fetch = realFetch;
});

// A loop of finished runs never goes quiet. Past the cap, this listener drops every listener for the event, which ends
// such a loop and lets the case fail instead of running until the process is killed. It also counts the events, so a
// case can check which runs announced their finish.
function capRunFinishedEvents(cap = 30) {
  let seen = 0;
  const id = subscribe("automation.run.finished", () => {
    seen += 1;
    if (seen <= cap) return;
    for (const subscription of listSubscriptions("automation.run.finished")) unsubscribe(subscription.id);
  });
  return { seen: () => seen, remove: () => unsubscribe(id) };
}

// These automations subscribe to the event that finished runs emit, so they exist only inside their own case.
async function withRunFinishedAutomations(automations, run) {
  for (const [name, definition] of Object.entries(automations)) {
    await defineAutomation({ userEmail: owner, appId }, {
      scope: "personal", name, triggerType: "event", event: "automation.run.finished",
      ...(typeof definition === "string" ? { body: definition } : definition),
    });
  }
  await refreshEventSubscriptions();
  const cap = capRunFinishedEvents();
  try {
    await run(cap.seen);
  } finally {
    cap.remove();
    for (const name of Object.keys(automations)) await resourceDeleteByPath(owner, `jobs/${name}.md`);
    await refreshEventSubscriptions();
  }
}

// A scheduled or manual run records its history row this way, and its finish emits the event once.
async function finishRunOf(name) {
  const id = await startAutomationRun({ owner, automation: name, path: `jobs/${name}.md`, appId });
  await finishAutomationRun(id, "success");
}
const finishOutsideRun = () => finishRunOf("outside");

// Run now through its in-process runner hook, with the scheduler's runQueuedAutomation, and wait for the run to end.
async function runNow(name) {
  const ended = Promise.withResolvers();
  const runner = id => runQueuedAutomation(id, dispatcherDeps).then(ended.resolve, ended.reject);
  setInProcessAutomationRunner(runner, { appId });
  try {
    await queueAutomationRunNow({ userEmail: owner, appId, scope: "personal", name });
    return await ended.promise;
  } finally {
    setInProcessAutomationRunner(null);
  }
}

const runsOf = name => listAutomationRuns({ owners: [owner], automation: name, appId, limit: 100 });
// Wait until every automation has a finished row and no row is added or finished for a quiet window.
async function settledRuns(names, { quietMs = 500, capMs = 10_000 } = {}) {
  const deadline = Date.now() + capMs;
  let snapshot = "";
  let changedAt = Date.now();
  for (;;) {
    const runs = await Promise.all(names.map(runsOf));
    const next = JSON.stringify(runs.map(list => list.map(run => run.status)));
    if (next !== snapshot) [snapshot, changedAt] = [next, Date.now()];
    const finished = runs.every(list => list.length > 0 && list.every(run => run.status !== "running"));
    if ((finished && Date.now() - changedAt >= quietMs) || Date.now() > deadline) return runs;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const statuses = runs => runs.map(list => list.map(run => run.status));

// On SQLite the "running" guard drops both finishes before the own-run check. The case that pins the own-run
// rule is "a Run now row that ends late does not start its own automation".
test("a self-subscribed automation that finishes twice is not started by its own runs", async () => {
  await withRunFinishedAutomations({ "self-subscribed": "Summarize the finished run in one sentence." }, async () => {
    await runNow("self-subscribed");
    await runNow("self-subscribed");
    assert.deepEqual(statuses(await settledRuns(["self-subscribed"])), [["success", "success"]],
      "only the two finished runs, and neither started another");
  });
  assert.deepEqual(engineRuns, ["self-subscribed", "self-subscribed"], "one model run for each Run now");
});

test("a Run now row that ends late does not start its own automation", async () => {
  await withRunFinishedAutomations({ "late-self": "Summarize the finished run in one sentence." }, async finishedEvents => {
    // The runner drops the delivery, as when the app quits before the run starts, so the row stays queued.
    setInProcessAutomationRunner(async () => {}, { appId });
    try {
      const { runId } = await queueAutomationRunNow({ userEmail: owner, appId, scope: "personal", name: "late-self" });
      await getDbExec().execute({
        sql: "UPDATE automation_runs SET started_at = ? WHERE id = ?", args: [Date.now() - 60 * 60_000, runId],
      });
      await redispatchUnclaimedAutomationRuns({ appId });
    } finally {
      setInProcessAutomationRunner(null);
    }
    const [runs] = await settledRuns(["late-self"]);
    assert.deepEqual(runs.map(run => [run.status, run.errorCode]), [["error", "automation_run_not_started"]],
      "only the late row, and its end started nothing");
    assert.equal(finishedEvents(), 1, "the late row announced its end");
  });
  assert.deepEqual(engineRuns, [], "no model run");
});

test("a self-subscribed automation runs once for each outside run", async () => {
  await withRunFinishedAutomations({ "self-after-outside": "Summarize the finished run in one sentence." }, async finishedEvents => {
    await finishOutsideRun();
    assert.deepEqual(statuses(await settledRuns(["self-after-outside"])), [["success"]],
      "one outside run starts one run, and that run's own finish starts nothing");
    await finishOutsideRun();
    assert.deepEqual(statuses(await settledRuns(["self-after-outside"])), [["success", "success"]],
      "a second outside run starts one more run, and its finish starts nothing either");
    assert.equal(finishedEvents(), 2, "only the two outside runs announced their finish");
  });
  assert.deepEqual(engineRuns, ["self-after-outside", "self-after-outside"], "two model runs");
});

test("two automations subscribed to automation.run.finished do not start each other", async () => {
  await withRunFinishedAutomations({
    "pair-a": "Summarize the finished run in one sentence.",
    "pair-b": "Summarize the finished run in one sentence.",
  }, async finishedEvents => {
    await finishOutsideRun();
    assert.deepEqual(statuses(await settledRuns(["pair-a", "pair-b"])), [["success"], ["success"]],
      "one outside run starts each automation once");
    assert.equal(finishedEvents(), 1, "only the outside run announced its finish");
  });
  assert.deepEqual(engineRuns.toSorted(), ["pair-a", "pair-b"], "two model runs");
});

test("two failing automations subscribed to automation.run.finished do not start each other", async () => {
  await withRunFinishedAutomations({ "failing-a": FAIL, "failing-b": FAIL }, async finishedEvents => {
    await finishOutsideRun();
    assert.deepEqual(statuses(await settledRuns(["failing-a", "failing-b"])), [["error"], ["error"]],
      "one outside run starts each automation once, and each failed run starts nothing");
    assert.equal(finishedEvents(), 1, "only the outside run announced its finish");
  });
  assert.deepEqual(engineRuns.toSorted(), ["failing-a", "failing-b"], "two model runs");
});

test("two automations without a usable credential do not trade failed runs", async () => {
  // Without an injected engine, a run resolves its own engine and credential as a scheduled run does. The file clears
  // the 16 names at its top, the new database stores no key, and the network is closed, so each run fails.
  const { engine: _engine, model: _model, ...keylessDeps } = dispatcherDeps;
  await initTriggerDispatcher(keylessDeps);
  try {
    await withRunFinishedAutomations({
      "keyless-a": "Summarize the finished run in one sentence.",
      "keyless-b": "Summarize the finished run in one sentence.",
    }, async finishedEvents => {
      await finishOutsideRun();
      const runs = await settledRuns(["keyless-a", "keyless-b"]);
      assert.deepEqual(statuses(runs), [["error"], ["error"]],
        "one outside run starts each automation once, and each failed run starts nothing");
      assert.equal(finishedEvents(), 1, "only the outside run announced its finish");
      for (const [run] of runs) {
        const thread = JSON.parse((await getThread(run.threadId)).threadData);
        assert.equal(thread.messages.at(-1).message.metadata.custom.runError.errorCode, "missing_credentials",
          `${run.automation} failed for want of a credential`);
      }
    });
  } finally {
    await initTriggerDispatcher(dispatcherDeps);
  }
  assert.deepEqual(engineRuns, [], "the fake engine was not used");
  assert.deepEqual(fetchedUrls, [], "no run reached the network");
});

test("a run another event started does not start an automation.run.finished subscriber", async () => {
  const relayEvent = "vivary.test.relay";
  const anyPayload = { "~standard": { version: 1, vendor: "vivary-test", validate: value => ({ value }) } };
  registerEvent({ name: relayEvent, description: "Test event for the relay automation.", payloadSchema: anyPayload });
  await defineAutomation({ userEmail: owner, appId }, {
    scope: "personal", name: "relay", body: "Summarize the event in one sentence.", triggerType: "event",
    event: relayEvent,
  });
  try {
    await withRunFinishedAutomations({ watcher: "Summarize the finished run in one sentence." }, async finishedEvents => {
      emit(relayEvent, { topic: "relay" }, { owner });
      assert.deepEqual(statuses(await settledRuns(["relay"])), [["success"]], "the event starts the relay once");
      assert.equal(finishedEvents(), 0, "the relay's finish is not announced");
      assert.deepEqual(await runsOf("watcher"), [], "the relay's finish starts no watcher run");
    });
  } finally {
    await resourceDeleteByPath(owner, "jobs/relay.md");
    await refreshEventSubscriptions();
  }
  assert.deepEqual(engineRuns, ["relay"], "one model run");
});

test("a self-subscribed automation with a condition skips its own runs before the condition key refusal", async () => {
  await withRunFinishedAutomations({
    "self-conditioned": { body: "Summarize the finished run in one sentence.", condition: "The run succeeded." },
  }, async () => {
    await finishRunOf("self-conditioned");
    await finishRunOf("self-conditioned");
    assert.deepEqual(statuses(await settledRuns(["self-conditioned"])), [["success", "success"]],
      "only the two finished runs, and no condition key refusal");
    const { meta } = parseTriggerFrontmatter((await resourceGetByPath(owner, "jobs/self-conditioned.md")).content);
    assert.equal(meta.lastStatus, undefined, "no refusal on the automation's last status");
  });
  assert.deepEqual(engineRuns, [], "no model run");
  assert.deepEqual(fetchedUrls, [], "nothing reached the network");
});

test("a webhook-started run still announces its finish", async () => {
  await defineAutomation({ userEmail: owner, appId }, {
    scope: "personal", name: "hook", body: "Summarize the call in one sentence.", triggerType: "webhook",
  });
  try {
    await withRunFinishedAutomations({ "after-hook": "Summarize the finished run in one sentence." }, async finishedEvents => {
      // A call as the webhook route queues it, run by the in-process runner that the plugin registers.
      const hook = await resourceGetByPath(owner, "jobs/hook.md");
      await insertPendingTask({
        id: "task-hook", platform: "automation-webhook", externalThreadId: `${hook.owner}:${hook.path}`,
        ownerEmail: owner, orgId: null, externalEventKey: `${hook.id}:evt-hook`,
        payload: JSON.stringify({ kind: "automation-webhook", automationId: hook.id, owner: hook.owner,
          path: hook.path, eventId: "evt-hook", payload: { id: "evt-hook" } }),
      });
      assert.equal(await runAutomationWebhookTaskInProcess("task-hook", { appId }), "completed");
      assert.deepEqual(statuses(await settledRuns(["hook", "after-hook"])), [["success"], ["success"]],
        "the call runs the webhook automation once, and its finish starts the subscriber once");
      assert.equal(finishedEvents(), 1, "only the webhook run announced its finish");
    });
  } finally {
    await resourceDeleteByPath(owner, "jobs/hook.md");
  }
  assert.deepEqual(engineRuns.toSorted(), ["after-hook", "hook"], "two model runs");
});

test("an automation's own run is judged by its path and its history owner", () => {
  const run = { path: "jobs/digest.md", owner };
  const automation = resourceOwner => ({ owner: resourceOwner, path: run.path });
  assert.equal(isOwnAutomationRun(run, automation(owner), { userEmail: owner }), true,
    "a personal automation's own run");
  assert.equal(isOwnAutomationRun(run, automation(organizationResourceOwner("acme")), { userEmail: owner, orgId: "acme" }),
    false, "an organization automation and its creator's personal run at the same path");
  assert.equal(isOwnAutomationRun(run, automation("__shared__"), { userEmail: owner }), true,
    "a legacy shared automation and a run recorded under its creator");
});
