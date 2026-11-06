import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

import { z } from "zod";

// Issue #97. Native chat surfaces in the patched Core, with Vivary's redactor registered as the
// Nitro plugin registers it. Every value is random and generated for this run. A failed
// comparison masks the generated values before it reports text.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-native-redaction-"));
const database = `file:${path.join(caseRoot, "native.sqlite")}`;
Object.assign(process.env, { APP_NAME: "Vivary", NODE_ENV: "production", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database });

// A finished run schedules a five-minute in-memory cleanup. Unref long timers so this file can exit.
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  const timer = originalSetTimeout(handler, delay, ...args);
  if ((delay ?? 0) >= 60_000) timer.unref();
  return timer;
}) as typeof setTimeout;
after(async () => {
  globalThis.setTimeout = originalSetTimeout;
  await rm(caseRoot, { recursive: true, force: true });
});

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = (relative: string) => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
const [audit, runs, credentialProvider, threads, automationRuns] = await Promise.all([
  load("audit/redact.js"), load("agent/run-manager.js"), load("server/credential-provider.js"),
  load("chat-threads/store.js"), load("jobs/run-history.js"),
]);
const { defineAction } = await import("@agent-native/core/action");
const { getDbExec } = await import("@agent-native/core/db");
const { MCP_ACTION_RESULT_MARKER } = await import("@agent-native/core/mcp-client");
const { actionsToEngineTools, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } = await import("@agent-native/core/server");
const { heldCredentialHoldback, redactCredentials, refreshHeldCredentials } = await import("../server/credential-redaction.ts");
type AgentEngine = import("@agent-native/core/agent/engine").AgentEngine;

audit.setTextRedactor?.(redactCredentials, { holdback: () => heldCredentialHoldback?.() ?? 256 });
const owner = "owner@example.test";
const generated: string[] = [];
const synthetic = (length = 40) => {
  const value = randomBytes(length * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, length - 2) + "4k";
  generated.push(value);
  return value;
};
const masked = (text: string) => generated.reduce((out, value) => out.split(value).join("<generated>"), text);
function assertMatch(text: string, pattern: RegExp, label = "") {
  if (!pattern.test(text)) assert.fail(`${label} ${masked(text).slice(0, 2_000)} does not match ${pattern}`);
}
function assertHidden(text: string, values: string[], label: string) {
  const shown = values.filter(value => text.includes(value)).length;
  assert.equal(shown, 0, `${label} showed ${shown} generated value(s)`);
}
function assertText(actual: string, expected: string, label = "") {
  if (actual !== expected) assert.fail(`${label} ${masked(actual)} !== ${masked(expected)}`);
}
async function holding(values: Record<string, string>) {
  assert.equal(typeof audit.setTextRedactor, "function", "Core has no text redactor hook");
  await refreshHeldCredentials({ environment: () => values, mcpConfig: () => null, storedSecrets: async () => [] });
}
async function rows(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await getDbExec().execute({ sql, args })).rows as Record<string, unknown>[];
}

test("a tool result, an MCP result, and a tool error reach the model and the screen with placeholders", async () => {
  const [held, keyValue] = [synthetic(), synthetic(48)];
  await holding({ VIVARY_PROBE_TOKEN: held });
  const probe = (run: () => Promise<unknown>) => ({ default: defineAction({ description: "Read the probe.", schema: z.object({}),
    agentTool: true, http: false, readOnly: true, dedupe: false, run }) });
  const actions = loadActionsFromStaticRegistry({
    "probe-read": probe(async () => ({ contents: `token ${held}\nOPENROUTER_API_KEY=${keyValue}` })),
    "probe-mcp": probe(async () => ({ [MCP_ACTION_RESULT_MARKER]: true, text: `mcp ${held}` })),
    "probe-fail": probe(async () => { throw new Error(`could not use ${held}`); }),
  });
  const requests: string[] = [];
  const engine: AgentEngine = { name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
    async *stream(options) {
      requests.push(JSON.stringify(options.messages));
      if (requests.length === 1) {
        const calls = ["probe-read", "probe-mcp", "probe-fail"].map((name, index) =>
          ({ type: "tool-call" as const, id: `call-${index}`, name, input: {} }));
        for (const call of calls) yield call;
        yield { type: "assistant-content", parts: calls };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "assistant-content", parts: [{ type: "text", text: "Done." }] };
        yield { type: "stop", reason: "end_turn" };
      }
    } };
  const events: Array<{ type: string; id?: string; result?: string }> = [];
  await runWithRequestContext({ userEmail: owner, orgId: "org-a", run: {} }, () => runAgentLoop({ engine, model: "fake-model",
    systemPrompt: "", tools: actionsToEngineTools(actions), actions, signal: new AbortController().signal,
    messages: [{ role: "user", content: [{ type: "text", text: "Read the probe." }] }],
    send: event => { events.push(event as { type: string; id?: string; result?: string }); } }));
  assert.equal(requests.length, 2);
  assertHidden(requests[1] + JSON.stringify(events), [held, keyValue], "model input and events");
  // Read-only tools run as one parallel batch, so results are matched by call id.
  const result = (id: string) => events.find(event => event.type === "tool_done" && event.id === id)?.result ?? "";
  const results = ["call-0", "call-1", "call-2"].map(result);
  assertMatch(results[0], /token \[redacted VIVARY_PROBE_TOKEN\]\\nOPENROUTER_API_KEY=\[redacted credential\]/);
  assertMatch(results[1], /mcp \[redacted VIVARY_PROBE_TOKEN\]/);
  assertMatch(results[2], /could not use \[redacted VIVARY_PROBE_TOKEN\]/);
  assert.equal(requests[1].match(/\[redacted VIVARY_PROBE_TOKEN\]/g)?.length, 3, "the model reads each result with its placeholder");
});

async function runToEnd(runFn: (send: (event: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>,
  whileRunning?: (runId: string) => void) {
  const runId = `run-${randomUUID()}`;
  let finished: Promise<unknown> | undefined;
  runs.startRun(runId, `thread-${randomUUID()}`, runFn, async () => undefined, { waitUntil: (promise: Promise<unknown>) => { finished = promise; } });
  whileRunning?.(runId);
  await finished?.catch(() => undefined);
  const shown = runs.getRun(runId).events.map((entry: { event: Record<string, unknown> }) => entry.event) as Array<Record<string, unknown>>;
  const stored = (await rows("SELECT event_data FROM agent_run_events WHERE run_id = ? ORDER BY seq", [runId]))
    .map(row => String(row.event_data));
  return { shown, stored: stored.join("\n") };
}

test("run events are shown and stored with placeholders, and a value split across deltas is redacted whole", async () => {
  const [held, token] = [synthetic(), `ghp_${synthetic(36)}`];
  await holding({ VIVARY_PROBE_TOKEN: held });
  const { shown, stored } = await runToEnd(async send => {
    send({ type: "text", text: `Here is the key: ${held.slice(0, 7)}` });
    send({ type: "text", text: held.slice(7, 25) });
    send({ type: "text", text: `${held.slice(25)} and a pattern ${token.slice(0, 10)}` });
    send({ type: "text", text: `${token.slice(10)}.\n` });
    send({ type: "thinking", text: `Thinking about ${held}` });
    send({ type: "tool_start", tool: "probe", id: "tool-1", input: { note: held } });
    send({ type: "tool_done", tool: "probe", id: "tool-1", input: {}, result: `result ${held}` });
    send({ type: "text", text: `Final ${held.slice(0, 20)}` });
    send({ type: "text", text: held.slice(20) });
    send({ type: "done" });
  });
  assertHidden(JSON.stringify(shown) + stored, [held, token], "run events");
  const text = shown.filter(event => event.type === "text").map(event => String(event.text)).join("");
  assertText(text, "Here is the key: [redacted VIVARY_PROBE_TOKEN] and a pattern [redacted credential].\nFinal [redacted VIVARY_PROBE_TOKEN]");
  assertMatch(stored, /result \[redacted VIVARY_PROBE_TOKEN\]/);
  assertText(shown.filter(event => event.type === "thinking").map(event => String(event.text)).join(""),
    "Thinking about [redacted VIVARY_PROBE_TOKEN]");
});

test("a provider error is shown and stored with placeholders", async () => {
  const held = synthetic();
  await holding({ OPENROUTER_API_KEY: held });
  const { shown, stored } = await runToEnd(async send => {
    send({ type: "text", text: "Working" });
    throw new Error(`401 Unauthorized: the key ${held} was rejected`);
  });
  assertHidden(JSON.stringify(shown) + stored, [held], "error events");
  const error = shown.find(event => event.type === "error");
  assertText(String(error?.error), "401 Unauthorized: the key [redacted OPENROUTER_API_KEY] was rejected");
  assertText(shown.filter(event => event.type === "text").map(event => String(event.text)).join(""), "Working");

  await runWithRequestContext({ userEmail: owner }, () => credentialProvider.recordProviderCredentialAuthFailure({
    key: "OPENROUTER_API_KEY", value: held, status: 401, code: "http_401", message: `401 Unauthorized: the key ${held} was rejected` }));
  const settings = (await rows("SELECT value FROM settings")).map(row => String(row.value)).filter(value => value.includes("http_401"));
  assert.equal(settings.length, 1, "the rejected key is recorded once");
  assertHidden(settings[0], [held], "stored provider failure");
  assertMatch(settings[0], /the key \[redacted OPENROUTER_API_KEY\] was rejected/);
});

test("text kept back when a run is stopped is still shown", async () => {
  await holding({});
  const { shown } = await runToEnd(async (send, signal) => {
    send({ type: "text", text: "partial answer" });
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  }, runId => { setImmediate(() => runs.abortRun(runId)); });
  assertText(shown.filter(event => event.type === "text").map(event => String(event.text)).join(""), "partial answer");
});

test("a saved thread and an automation run error keep placeholders only", async () => {
  const [held, token] = [synthetic(), `sk-proj-${synthetic(48)}`];
  await holding({ VIVARY_PROBE_TOKEN: held });
  const threadId = `thread-${randomUUID()}`;
  await threads.createThread(owner, { id: threadId, title: "Probe" });
  const message = (id: string, role: string, text: string, parentId: string | null) =>
    ({ parentId, message: { id, role, content: [{ type: "text", text }], createdAt: new Date().toISOString(), metadata: {} } });
  const repository = { headId: "m2", messages: [message("m1", "user", `my key is ${held}`, null),
    message("m2", "assistant", `and a pattern ${token}`, "m1")] };
  await threads.updateThreadData(threadId, JSON.stringify(repository), `Key ${held}`, `my key is ${held}`, 2);
  const [saved] = await rows("SELECT thread_data, title, preview FROM chat_threads WHERE id = ?", [threadId]);
  const savedText = `${saved.thread_data}\n${saved.title}\n${saved.preview}`;
  assertHidden(savedText, [held, token], "saved thread");
  assertMatch(String(saved.thread_data), /my key is \[redacted VIVARY_PROBE_TOKEN\]/);
  assertMatch(String(saved.thread_data), /and a pattern \[redacted credential\]/);

  const runId = await automationRuns.startAutomationRun({ owner, automation: "probe", path: "jobs/probe.md" });
  await automationRuns.finishAutomationRun(runId, "error", `step failed with ${held}`, "probe_failed");
  const run = await automationRuns.getAutomationRun(runId);
  assertText(String(run?.error), "step failed with [redacted VIVARY_PROBE_TOKEN]");
});

const joinedText = (events: Array<Record<string, unknown>>, type: string, id?: string) => events
  .filter(event => event.type === type && (id === undefined || event.id === id)).map(event => String(event.text)).join("");

async function probeTurn(actions: ReturnType<typeof loadActionsFromStaticRegistry>, names: string[]) {
  const requests: string[] = [];
  const engine: AgentEngine = { name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
    async *stream(options) {
      requests.push(JSON.stringify(options.messages));
      if (requests.length === 1) {
        const calls = names.map((name, index) => ({ type: "tool-call" as const, id: `call-${index}`, name, input: {} }));
        for (const call of calls) yield call;
        yield { type: "assistant-content", parts: calls };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "assistant-content", parts: [{ type: "text", text: "Done." }] };
        yield { type: "stop", reason: "end_turn" };
      }
    } };
  const events: Array<{ type: string; id?: string; result?: string }> = [];
  await runWithRequestContext({ userEmail: owner, orgId: "org-a", run: {} }, () => runAgentLoop({ engine, model: "fake-model",
    systemPrompt: "", tools: actionsToEngineTools(actions), actions, signal: new AbortController().signal,
    messages: [{ role: "user", content: [{ type: "text", text: "Read the probe." }] }],
    send: event => { events.push(event as { type: string; id?: string; result?: string }); } }));
  return { requests, events };
}
const probeAction = (run: () => Promise<unknown>) => ({ default: defineAction({ description: "Read the probe.",
  schema: z.object({}), agentTool: true, http: false, readOnly: true, dedupe: false, run }) });
const pieces = (value: string) => Array.from({ length: Math.floor(value.length / 64) }, (_, index) => value.slice(index * 64, index * 64 + 32));

test("a held value that crosses the tool result limit is redacted whole", async () => {
  const long = synthetic(6_000);
  await holding({ LONG_PROBE_TOKEN: long });
  const actions = loadActionsFromStaticRegistry({
    "probe-large": probeAction(async () => `${"x".repeat(49_000)}${long}${"y".repeat(2_000)}`) });
  const { requests, events } = await probeTurn(actions, ["probe-large"]);
  const result = events.find(event => event.type === "tool_done")?.result ?? "";
  assertHidden(result + requests.join("\n"), pieces(long), "tool result");
  assertMatch(result, /x\[redacted LONG_PROBE_TOKEN\]y/);
});

test("a recovered tool result is stored and replayed with placeholders", async () => {
  const held = synthetic();
  await holding({ VIVARY_PROBE_TOKEN: held });
  const runStore = await load("agent/run-store.js");
  const threadId = `thread-${randomUUID()}`;
  await runStore.writeLedgerEntry(threadId, "probe:write", `wrote ${held}`);
  const [row] = await rows("SELECT result_summary FROM agent_tool_ledger WHERE thread_id = ?", [threadId]);
  assertText(String(row?.result_summary), "wrote [redacted VIVARY_PROBE_TOKEN]");
  // A row stored before redaction is redacted when it is replayed to the model.
  await getDbExec().execute({ sql: "UPDATE agent_tool_ledger SET result_summary = ? WHERE thread_id = ?", args: [`old ${held}`, threadId] });
  const replayed = await runStore.readLedgerEntry(threadId, "probe:write");
  assertText(String(replayed?.result), "old [redacted VIVARY_PROBE_TOKEN]");
});

test("tool input streamed for two calls at once is redacted whole", async () => {
  const [first, second] = [synthetic(), synthetic()];
  await holding({ VIVARY_PROBE_TOKEN: first, OTHER_PROBE_TOKEN: second });
  const { shown, stored } = await runToEnd(async send => {
    send({ type: "tool_input_delta", tool: "probe", id: "call-a", text: `{"note":"${first.slice(0, 15)}` });
    send({ type: "tool_input_delta", tool: "probe", id: "call-b", text: `{"note":"${second.slice(0, 9)}` });
    send({ type: "tool_input_delta", tool: "probe", id: "call-a", text: `${first.slice(15)}"}` });
    send({ type: "tool_input_delta", tool: "probe", id: "call-b", text: `${second.slice(9)}"}` });
    send({ type: "tool_start", tool: "probe", id: "call-a", input: { note: first } });
    send({ type: "done" });
  });
  const [inputA, inputB] = [joinedText(shown, "tool_input_delta", "call-a"), joinedText(shown, "tool_input_delta", "call-b")];
  assertHidden(`${inputA}\n${inputB}\n${stored}`, [first, second], "tool input");
  assertText(inputA, '{"note":"[redacted VIVARY_PROBE_TOKEN]"}');
  assertText(inputB, '{"note":"[redacted OTHER_PROBE_TOKEN]"}');
});

test("a held value longer than 256 characters is redacted whole across text deltas", async () => {
  const long = synthetic(403);
  await holding({ REFRESH_TOKEN: long });
  const { shown } = await runToEnd(async send => {
    send({ type: "text", text: `token: ${long.slice(0, 150)}` });
    send({ type: "text", text: long.slice(150, 300) });
    send({ type: "text", text: `${long.slice(300)} end` });
    send({ type: "done" });
  });
  const text = joinedText(shown, "text");
  assertHidden(text, pieces(long), "streamed text");
  assertText(text, "token: [redacted REFRESH_TOKEN] end");
});

test("an automation's last error keeps placeholders only", async () => {
  const held = synthetic();
  await holding({ VIVARY_PROBE_TOKEN: held });
  const [scheduler, resources] = await Promise.all([load("jobs/scheduler.js"), load("resources/store.js")]);
  await resources.resourcePut(owner, "jobs/probe97.md", scheduler.buildJobContent({ schedule: "0 0 1 1 *" }, "Say hello."));
  // The run fails with the provider's message. The scheduler logs it, so this test keeps its console quiet.
  const deps = new Proxy({}, { get() { throw new Error(`the provider rejected ${held}`); } });
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  Object.assign(console, { log: () => undefined, error: () => undefined, warn: () => undefined });
  let outcome: unknown;
  try {
    outcome = await runWithRequestContext({ userEmail: owner }, () => scheduler.runJobNow(owner, "probe97", deps));
  } finally {
    Object.assign(console, quiet);
  }
  const saved = await resources.resourceGetByPath(owner, "jobs/probe97.md");
  assertHidden(`${JSON.stringify(outcome)}\n${saved?.content ?? ""}`, [held], "automation last error");
  assertMatch(String(saved?.content), /the provider rejected \[redacted VIVARY_PROBE_TOKEN\]/);
});

test("a fork of a thread saved before redaction keeps placeholders only", async () => {
  const held = synthetic();
  await holding({ VIVARY_PROBE_TOKEN: held });
  const sourceId = `thread-${randomUUID()}`;
  await threads.createThread(owner, { id: sourceId, title: "Source" });
  const repository = { headId: "m1", messages: [{ parentId: null, message: { id: "m1", role: "user",
    content: [{ type: "text", text: `my key is ${held}` }], createdAt: new Date().toISOString(), metadata: {} } }] };
  // Written directly, as a row saved before this change would be.
  await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data = ?, title = ?, preview = ?, message_count = 1 WHERE id = ?",
    args: [JSON.stringify(repository), `Key ${held}`, `my key is ${held}`, sourceId] });
  const fork = await runWithRequestContext({ userEmail: owner }, () => threads.forkThread(sourceId, owner));
  const [row] = await rows("SELECT thread_data, title, preview FROM chat_threads WHERE id = ?", [fork.id]);
  assertHidden(`${row?.thread_data}\n${row?.title}\n${row?.preview}`, [held], "forked thread");
  assertMatch(String(row?.thread_data), /my key is \[redacted VIVARY_PROBE_TOKEN\]/);
});

test("earlier turns sent back by the browser reach the model with placeholders", async () => {
  const held = synthetic();
  await holding({ VIVARY_PROBE_TOKEN: held });
  const { structuredHistoryToEngineMessages } = await load("agent/production-agent.js");
  const messages = JSON.stringify(structuredHistoryToEngineMessages([
    { role: "user", content: [{ type: "text", text: `my key is ${held}` }] },
    { role: "assistant", content: [{ type: "text", text: "Saved." }] },
  ]));
  assertHidden(messages, [held], "history");
  assertMatch(messages, /my key is \[redacted VIVARY_PROBE_TOKEN\]/);
});
