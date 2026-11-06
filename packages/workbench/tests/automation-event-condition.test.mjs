import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

// An event automation's condition is checked by Core's trigger dispatcher, which calls Anthropic's API directly
// whatever provider runs the automation. Core's package entries do not export these modules, so load the installed,
// patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-event-condition-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes provider key names. No value is read.
}
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
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
const [{ initTriggerDispatcher, parseTriggerFrontmatter, refreshEventSubscriptions }, { defineAutomation },
  { emit, listSubscriptions, registerEvent, subscribe, unsubscribe }, { putSetting, deleteSetting }, { listAutomationRuns }, { resourceGetByPath, resourceDeleteByPath },
  { getDbExec }] = await Promise.all([
  load("triggers/dispatcher.js"),
  load("automations/service.js"),
  load("event-bus/index.js"),
  load("settings/store.js"),
  load("jobs/run-history.js"),
  load("resources/store.js"),
  load("db/client.js"),
]);

const owner = "owner@example.test";
const appId = "workbench";
const engineCalls = [];
// The engine is injected through the dispatcher's dependencies, so a run never reaches a real provider.
const engine = {
  name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
  capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
  async *stream(options) {
    engineCalls.push(JSON.stringify(options.messages));
    yield { type: "assistant-content", parts: [{ type: "text", text: "Event handled." }] };
    yield { type: "stop", reason: "end_turn" };
  },
};

const defineEventAutomation = (name, event, condition) => defineAutomation({ userEmail: owner, appId }, {
  scope: "personal", name, body: "Summarize the event in one sentence.", triggerType: "event", event, condition,
});
// One event per automation, so each event reaches only its own automation.
const eventFor = name => `vivary.test.${name}`;
const anyPayload = { "~standard": { version: 1, vendor: "vivary-test", validate: value => ({ value }) } };
for (const [name, condition] of [["openrouter-only", "The event is about billing."],
  ["rejected-key", "The event is about billing."], ["anthropic-condition", "The event is about billing."],
  ["no-condition", undefined]]) {
  registerEvent({ name: eventFor(name), description: `Test event for ${name}.`, payloadSchema: anyPayload });
  await defineEventAutomation(name, eventFor(name), condition);
}
await initTriggerDispatcher({ appId, engine, model: "fake-model", getActions: () => ({}), getSystemPrompt: async () => "" });

after(async () => {
  globalThis.setTimeout = originalSetTimeout;
  await rm(caseRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await deleteSetting("agent-engine");
  engineCalls.length = 0;
});

const metaOf = async name => parseTriggerFrontmatter((await resourceGetByPath(owner, `jobs/${name}.md`))?.content ?? "").meta;
const runsOf = automation => listAutomationRuns({ owners: [owner], automation, appId, limit: 20 });
// The bus does not wait for its handlers, so wait for the automation to record an outcome.
async function fire(name, timeoutMs = 10_000) {
  emit(eventFor(name), { automation: name, topic: "billing" }, { owner });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await metaOf(name);
    if ((meta.lastStatus && meta.lastStatus !== "running") || Date.now() > deadline) return meta;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const fakeKey = prefix => `${prefix}${randomBytes(24).toString("hex")}`;
async function withKeys(keys, run) {
  Object.assign(process.env, keys); // guard:allow-env-credential - Random fake keys for a disposable run.
  try {
    await run();
  } finally {
    for (const name of Object.keys(keys)) delete process.env[name]; // guard:allow-env-credential - Removes the fake keys set above.
  }
}

// The condition classifier calls Anthropic directly. Record the key each call sends, and answer without a network:
// "yes" for the accepted key, 401 for any other.
async function withAnthropicStub(acceptedKey, run) {
  const realFetch = globalThis.fetch;
  const sentKeys = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const key = new Headers(init?.headers).get("x-api-key");
    sentKeys.push(key);
    return acceptedKey && key === acceptedKey
      ? Response.json({ content: [{ type: "text", text: "yes" }] })
      : Response.json({ error: { type: "authentication_error" } }, { status: 401 });
  };
  try {
    await run(sentKeys);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a condition with only an OpenRouter key sends nothing to Anthropic and records an error", async () => {
  await putSetting("agent-engine", { engine: "ai-sdk:openrouter" });
  await withKeys({ OPENROUTER_API_KEY: fakeKey("sk-or-v1-") }, () => withAnthropicStub(undefined, async sentKeys => {
    const meta = await fire("openrouter-only");
    assert.equal(sentKeys.length, 0, "no key was sent to Anthropic");
    assert.equal(meta.lastStatus, "error", "the automation's last status reads as an error");
  }));
  const runs = await runsOf("openrouter-only");
  assert.equal(runs.length, 1, "one history row");
  assert.equal(runs[0].status, "error");
  assert.equal(runs[0].errorCode, "automation_condition_key_missing");
  assert.match(runs[0].error, /Add an Anthropic key, or remove the condition\. The event did not start a run\.$/);
  assert.equal(engineCalls.length, 0, "no run started");
});

test("a condition whose Anthropic key is rejected records an error and starts no run", async () => {
  await withKeys({ ANTHROPIC_API_KEY: fakeKey("sk-ant-") }, () => withAnthropicStub(undefined, async sentKeys => {
    const meta = await fire("rejected-key");
    assert.equal(sentKeys.length, 1, "one condition check reached Anthropic");
    assert.equal(meta.lastStatus, "error", "the automation's last status reads as an error");
  }));
  const runs = await runsOf("rejected-key");
  assert.equal(runs.length, 1, "one history row");
  assert.equal(runs[0].errorCode, "automation_condition_key_rejected");
  assert.match(runs[0].error, /^Anthropic rejected the API key used to check this automation's condition \(HTTP 401\)\./);
  assert.match(runs[0].error, /The event did not start a run\.$/);
  assert.equal(engineCalls.length, 0, "no run started");
});

test("with OpenRouter active, a condition is checked with the Anthropic key and the run starts", async () => {
  await putSetting("agent-engine", { engine: "ai-sdk:openrouter" });
  const anthropicKey = fakeKey("sk-ant-");
  const openRouterKey = fakeKey("sk-or-v1-");
  await withKeys({ ANTHROPIC_API_KEY: anthropicKey, OPENROUTER_API_KEY: openRouterKey },
    () => withAnthropicStub(anthropicKey, async sentKeys => {
      const meta = await fire("anthropic-condition");
      assert.ok(!sentKeys.includes(openRouterKey), "the OpenRouter key never reached Anthropic");
      assert.ok(sentKeys.length === 1 && sentKeys[0] === anthropicKey, "one condition check sent the Anthropic key");
      assert.equal(meta.lastStatus, "success", `the run finished (${meta.lastError ?? "no error"})`);
    }));
  assert.equal(engineCalls.length, 1, "one model run");
});

test("an automation without a condition runs with no stored key", async () => {
  const meta = await fire("no-condition");
  assert.equal(meta.lastStatus, "success", `the event was not refused (${meta.lastError ?? "no error"})`);
  assert.equal(engineCalls.length, 1, "one model run");
});

// better-sqlite3 answers synchronously, so a refusal loop runs on microtasks alone and no timer can stop it. Past the
// cap, this listener drops every listener for the event, which ends such a loop and lets the case fail.
function capRunFinishedEvents(cap = 50) {
  let seen = 0;
  const id = subscribe("automation.run.finished", () => {
    seen += 1;
    if (seen <= cap) return;
    for (const subscription of listSubscriptions("automation.run.finished")) unsubscribe(subscription.id);
  });
  return () => unsubscribe(id);
}
// These automations subscribe to the event that every finished history row emits, so they exist only inside their
// own case, where no other row is written.
async function withRunFinishedAutomations(names, run) {
  for (const name of names) await defineEventAutomation(name, "automation.run.finished", "The run failed.");
  await refreshEventSubscriptions();
  const removeCap = capRunFinishedEvents();
  try {
    await run();
  } finally {
    removeCap();
    for (const name of names) await resourceDeleteByPath(owner, `jobs/${name}.md`);
    await refreshEventSubscriptions();
  }
}
const emitExternalRunFinished = () => emit("automation.run.finished", {
  automationRunId: "external-run", owner, automation: "external", path: "jobs/external.md", orgId: null, runId: null,
  threadId: null, status: "success", error: null, errorCode: null, durationMs: 1,
}, { owner });
const historyCount = async name => Number((await getDbExec().execute({
  sql: "SELECT COUNT(*) AS count FROM automation_runs WHERE automation = ?", args: [name],
})).rows[0].count);
// Wait until every automation has a row and no row is added for a short window, for at most two seconds.
async function settledHistoryCounts(names, { quietMs = 300, capMs = 2_000 } = {}) {
  const deadline = Date.now() + capMs;
  let counts = [];
  let changedAt = Date.now();
  for (;;) {
    const next = await Promise.all(names.map(historyCount));
    if (String(next) !== String(counts)) [counts, changedAt] = [next, Date.now()];
    const quiet = counts.every(count => count > 0) && Date.now() - changedAt >= quietMs;
    if (quiet || Date.now() > deadline) return counts;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a refused condition on automation.run.finished does not retrigger itself through its own history row", async () => {
  await withRunFinishedAutomations(["after-run"], () => withAnthropicStub(undefined, async sentKeys => {
    emitExternalRunFinished();
    assert.deepEqual(await settledHistoryCounts(["after-run"]), [1], "one external event gives one refusal row");
    assert.equal(sentKeys.length, 0, "no key was sent to Anthropic");
    const [run] = await runsOf("after-run");
    assert.equal(run?.errorCode, "automation_condition_key_missing");
  }));
  assert.equal(engineCalls.length, 0, "no run started");
});

test("two refused conditions on automation.run.finished do not retrigger each other", async () => {
  await withRunFinishedAutomations(["after-run-a", "after-run-b"], () => withAnthropicStub(undefined, async sentKeys => {
    emitExternalRunFinished();
    assert.deepEqual(await settledHistoryCounts(["after-run-a", "after-run-b"]), [1, 1],
      "one external event gives one refusal row for each automation");
    assert.equal(sentKeys.length, 0, "no key was sent to Anthropic");
  }));
  assert.equal(engineCalls.length, 0, "no run started");
});

test("a rejected condition key on automation.run.finished does not retrigger itself", async () => {
  await withKeys({ ANTHROPIC_API_KEY: fakeKey("sk-ant-") }, () => withRunFinishedAutomations(["after-run-rejected"],
    () => withAnthropicStub(undefined, async sentKeys => {
      emitExternalRunFinished();
      assert.deepEqual(await settledHistoryCounts(["after-run-rejected"]), [1], "one external event gives one refusal row");
      assert.equal(sentKeys.length, 1, "one condition check reached Anthropic");
      const [run] = await runsOf("after-run-rejected");
      assert.equal(run?.errorCode, "automation_condition_key_rejected");
    })));
  assert.equal(engineCalls.length, 0, "no run started");
});
