import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Issue #103. A Native turn records the provider's reported cost, including 0. A model with no price
// and no reported cost records an unknown cost, never a guess. The provider is a loopback fake that
// speaks OpenRouter's chat completions stream and reports usage in its last chunk, as OpenRouter does.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-native-usage-cost-"));
const database = `file:${path.join(caseRoot, "usage.sqlite")}`;
Object.assign(process.env, { APP_NAME: "Vivary", NODE_ENV: "production", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database });
after(() => rm(caseRoot, { recursive: true, force: true }));

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const coreUrl = (relative: string) => pathToFileURL(path.join(coreRoot, "dist", relative)).href;
const load = (relative: string) => import(coreUrl(relative));
const [agent, store, metrics, alerts, budgets, webhooks, tasks] = await Promise.all([load("agent/production-agent.js"),
  load("usage/store.js"), load("usage/metrics-store.js"), load("usage/alerts-store.js"),
  load("integrations/usage-budget-store.js"), load("integrations/webhook-handler.js"),
  load("integrations/pending-tasks-store.js")]);
const { defineAction } = await import("@agent-native/core/action");
const { createAISDKEngine } = await import("@agent-native/core/agent/engine");
const { getDbExec } = await import("@agent-native/core/db");
const { actionsToEngineTools, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } =
  await import("@agent-native/core/server");

const INPUT_TOKENS = 1_000;
const OUTPUT_TOKENS = 200;
// At Sonnet's $3 input and $15 output per million tokens, 1,000 and 200 tokens cost 60 centicents.
const SONNET_CENTICENTS = 60;
const userTurn = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }];
const actions = loadActionsFromStaticRegistry({ "probe-read": { default: defineAction({ description: "Read the project.",
  schema: z.object({}), agentTool: true, http: false, readOnly: true, dedupe: false, run: async () => "read" }) } });

const chunkOf = (fields: Record<string, unknown>) => ({ id: "gen-probe", object: "chat.completion.chunk", created: 0,
  model: "probe/model", ...fields });
const usageChunk = (cost?: number) => chunkOf({ choices: [], usage: { prompt_tokens: INPUT_TOKENS,
  completion_tokens: OUTPUT_TOKENS, total_tokens: INPUT_TOKENS + OUTPUT_TOKENS, ...(cost === undefined ? {} : { cost }) } });
const send = (response: ServerResponse, chunk: Record<string, unknown>) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);

// `Respond` answers the provider request with that index.
type Respond = (response: ServerResponse, index: number) => void;
const answer = (cost?: number): Respond => response => {
  send(response, chunkOf({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }));
  send(response, chunkOf({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  send(response, usageChunk(cost));
  response.end("data: [DONE]\n\n");
};
const callTool = (cost?: number): Respond => response => {
  send(response, chunkOf({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0,
    id: "call-read", type: "function", function: { name: "probe-read", arguments: "{}" } }] }, finish_reason: null }] }));
  send(response, chunkOf({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
  send(response, usageChunk(cost));
  response.end("data: [DONE]\n\n");
};
// OpenRouter's in-stream error, as a free model returns it when it is rate limited.
const rateLimited: Respond = response => {
  send(response, { error: { code: 429, message: "Rate limit exceeded" } });
  response.end("data: [DONE]\n\n");
};
const holdReply: Respond = response => {
  send(response, chunkOf({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] }));
};
// OpenRouter's in-stream error after streamed text, which the loop does not retry.
const cutByProviderError: Respond = response => {
  send(response, chunkOf({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] }));
  send(response, { error: { code: 502, message: "Upstream provider failed" } });
  response.end("data: [DONE]\n\n");
};
const answerWithoutUsage: Respond = response => {
  send(response, chunkOf({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }));
  send(response, chunkOf({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  response.end("data: [DONE]\n\n");
};

async function fakeOpenRouter(respond: Respond) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    respond(response, requests++);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const engine = createAISDKEngine("openrouter", { apiKey: randomBytes(24).toString("hex"),
    baseUrl: `http://127.0.0.1:${port}/api/v1`, allowEnvFallback: false });
  const close = () => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { engine, requests: () => requests, close };
}

async function usageEvent(cost?: number) {
  const provider = await fakeOpenRouter(answer(cost));
  try {
    for await (const event of provider.engine.stream({ model: "probe/model", systemPrompt: "", tools: [], messages: userTurn,
      abortSignal: new AbortController().signal })) {
      if (event.type === "usage") return event as Record<string, unknown>;
    }
    return undefined;
  } finally {
    await provider.close();
  }
}

const usageRows = async (column: "run_id" | "task_id", id: string) => (await getDbExec().execute({
  sql: `SELECT input_tokens, output_tokens, cost_cents_x100, cost_source FROM token_usage WHERE ${column} = ?`, args: [id] }))
  .rows.map(row => ({ tokens: Number(row.input_tokens) + Number(row.output_tokens), centicents: Number(row.cost_cents_x100),
    source: String(row.cost_source) }));

// Collects what `action` logs through console.warn and console.error, so an expected failure leaves no trace in the output.
async function capturingLogs<T>(action: () => Promise<T>) {
  const lines: string[] = [];
  const { warn, error } = console;
  console.warn = console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await action(), lines };
  } finally {
    Object.assign(console, { warn, error });
  }
}

// One turn: the agent loop's usage events go into the turn's usage, as the chat handler and the
// integration handler wire it. `stopOnText` presses Stop at the turn's first streamed text. `throws`
// expects the loop to throw.
async function runTurn(model: string, respond: Respond, { stopOnText = false, throws = false } = {}) {
  const owner = `owner-${randomUUID()}@example.test`;
  const runId = `run-${randomUUID()}`;
  const turn = agent.createTurnUsage(model);
  const provider = await fakeOpenRouter(respond);
  const stop = new AbortController();
  let threw = false;
  try {
    await runWithRequestContext({ userEmail: owner, run: {} }, () => runAgentLoop({ engine: provider.engine, model,
      systemPrompt: "", tools: actionsToEngineTools(actions), actions, messages: userTurn, signal: stop.signal,
      send: (event: { type: string }) => { if (stopOnText && event.type === "text") stop.abort(); },
      onUsage: turn.add, onModelCall: turn.startCall })).catch((error: unknown) => {
      if (stop.signal.aborted) return;
      if (!throws) throw error;
      threw = true;
    });
  } finally {
    await provider.close();
  }
  return { owner, runId, turn, requests: provider.requests(), threw };
}

// The chat handler records the turn's usage when the turn ends, also after a Stop or a thrown loop.
async function recordTurn(model: string, respond: Respond, options: { stopOnText?: boolean; throws?: boolean } = {}) {
  const { owner, runId, turn, requests, threw } = await runTurn(model, respond, options);
  await store.recordUsage({ ownerEmail: owner, ...turn.usageRecord(), label: "chat", runId });
  return { requests, threw, rows: await usageRows("run_id", runId) };
}

test("the engine's usage event carries the cost the provider reports", async t => {
  await t.test("a reported cost of 0", async () => {
    const event = await usageEvent(0);
    assert.deepEqual({ inputTokens: event?.inputTokens, outputTokens: event?.outputTokens, costUsd: event?.costUsd },
      { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, costUsd: 0 });
  });
  await t.test("a reported positive cost", async () => {
    assert.equal((await usageEvent(0.0123))?.costUsd, 0.0123);
  });
  await t.test("no reported cost", async () => {
    const event = await usageEvent();
    assert.equal(event?.inputTokens, INPUT_TOKENS);
    assert.equal("costUsd" in (event ?? {}), false);
  });
});

const turns: Array<{ name: string; model: string; respond: Respond; stopOnText?: boolean; throws?: boolean;
  requests?: number; row: { centicents: number; source: string } }> = [
  { name: "a stream that reports a cost of 0 records $0", model: "probe/free-model", respond: answer(0),
    row: { centicents: 0, source: "reported" } },
  { name: "a stream that reports a positive cost records it", model: "probe/paid-model", respond: answer(0.0123),
    row: { centicents: 123, source: "reported" } },
  { name: "a reported cost wins over the price table", model: "anthropic/claude-sonnet-5", respond: answer(0.0123),
    row: { centicents: 123, source: "reported" } },
  { name: "a model with no price and no reported cost records an unknown cost", model: "probe/unpriced-model",
    respond: answer(), row: { centicents: 0, source: "unavailable" } },
  { name: "a priced model with no reported cost keeps its table price", model: "anthropic/claude-sonnet-5",
    respond: answer(), row: { centicents: SONNET_CENTICENTS, source: "estimated" } },
  // The retry replaces the failed attempt, which costs nothing.
  { name: "a rate-limited attempt and a retry that reports a cost of 0 record $0", model: "probe/free-model",
    respond: (response, index) => (index === 0 ? rateLimited : answer(0))(response, index), requests: 2,
    row: { centicents: 0, source: "reported" } },
  // The stopped call reports no usage, so the reported cost of the first call is not the turn's cost.
  { name: "a turn stopped during its second call records no reported cost", model: "probe/paid-model",
    respond: (response, index) => (index === 0 ? callTool(0.0123) : holdReply)(response, index), stopOnText: true,
    requests: 2, row: { centicents: 0, source: "unavailable" } },
  // A call that ends with empty usage reports no cost, whether an error cut it off or its stream
  // carried no usage chunk.
  { name: "a turn whose second call a provider error cuts off records no reported cost", model: "probe/paid-model",
    respond: (response, index) => (index === 0 ? callTool(0.0123) : cutByProviderError)(response, index), throws: true,
    requests: 2, row: { centicents: 0, source: "unavailable" } },
  { name: "a turn whose second call reports no usage records no reported cost", model: "probe/paid-model",
    respond: (response, index) => (index === 0 ? callTool(0.0123) : answerWithoutUsage)(response, index), requests: 2,
    row: { centicents: 0, source: "unavailable" } },
];

test("a main chat turn records its cost", async t => {
  for (const turn of turns) {
    await t.test(turn.name, async () => {
      assert.deepEqual(await recordTurn(turn.model, turn.respond, { stopOnText: turn.stopOnText, throws: turn.throws }), {
        requests: turn.requests ?? 1, threw: turn.throws ?? false,
        rows: [{ tokens: INPUT_TOKENS + OUTPUT_TOKENS, ...turn.row }] });
    });
  }
});

// Traces and integration budgets price tokens with calculateCost too.
test("the price table has no catch-all price and still prices Sonnet", () => {
  assert.deepEqual({
    unpriced: store.calculateCost(INPUT_TOKENS, OUTPUT_TOKENS, "probe/unpriced-model"),
    sonnet: store.calculateCost(INPUT_TOKENS, OUTPUT_TOKENS, "claude-sonnet-5"),
    routedSonnet: store.calculateCost(INPUT_TOKENS, OUTPUT_TOKENS, "anthropic/claude-sonnet-5"),
  }, { unpriced: 0, sonnet: SONNET_CENTICENTS, routedSonnet: SONNET_CENTICENTS });
});

const figure = (value: { costCents: number; calls: number; unknownCostCalls?: number }) =>
  ({ costCents: value.costCents, calls: value.calls, unknownCostCalls: value.unknownCostCalls });
const usageFor = (owner: string) =>
  metrics.listAppUsageMetrics({ scope: "me", sinceDays: 30 }, { ownerEmail: owner, orgId: null, app: "vivary" });

test("the Usage tab's metrics count the calls whose cost is unknown", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  const call = { ownerEmail: owner, inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, label: "chat" };
  await store.recordUsage({ ...call, model: "probe/free-model", costCentsX100: 0, costSource: "reported" });
  await store.recordUsage({ ...call, model: "probe/unpriced-model" });
  await store.recordUsage({ ...call, model: "anthropic/claude-sonnet-5" });
  const usage = await usageFor(owner);
  const known = { costCents: SONNET_CENTICENTS / 100, calls: 3, unknownCostCalls: 1 };
  assert.deepEqual({
    totals: figure(usage.totals),
    currentDay: figure(usage.currentDay),
    daily: usage.daily.map(figure),
    byLabel: usage.byLabel.map(figure),
    byModel: Object.fromEntries(usage.byModel.map((row: { key: string; costCents: number; calls: number }) => [row.key, figure(row)])),
    recent: Object.fromEntries(usage.recent.map((row: { model: string; costSource?: string }) => [row.model, row.costSource])),
  }, {
    totals: known,
    currentDay: known,
    daily: [known],
    byLabel: [known],
    byModel: {
      "anthropic/claude-sonnet-5": { costCents: SONNET_CENTICENTS / 100, calls: 1, unknownCostCalls: 0 },
      "probe/free-model": { costCents: 0, calls: 1, unknownCostCalls: 0 },
      "probe/unpriced-model": { costCents: 0, calls: 1, unknownCostCalls: 1 },
    },
    recent: { "anthropic/claude-sonnet-5": "estimated", "probe/free-model": "reported", "probe/unpriced-model": "unavailable" },
  });
});

// CI exposed a real primary-key collision when consecutive calls shared a millisecond.
// Separate store modules also cover an existing ID left by another store instance.
test("simultaneous usage calls with the same generated ID both retain their costs", async (t) => {
  const owner = `owner-${randomUUID()}@example.test`;
  const otherStore = await import(`${coreUrl("usage/store.js")}?collision=${randomUUID()}`);
  await store.ensureUsageTable();
  await otherStore.ensureUsageTable();
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  const random = t.mock.method(Math, "random", () => 0);
  try {
    const call = { ownerEmail: owner, inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS,
      label: "chat", model: "probe/reported", costSource: "reported" };
    await Promise.all([
      store.recordUsage({ ...call, costCentsX100: 60 }),
      otherStore.recordUsage({ ...call, costCentsX100: 50 }),
    ]);
  } finally {
    clock.mock.restore();
    random.mock.restore();
  }
  const usage = await usageFor(owner);
  assert.deepEqual(figure(usage.totals), { costCents: 1.1, calls: 2, unknownCostCalls: 0 });
  assert.equal(usage.recent.length, 2);
  assert.equal(new Set(usage.recent.map((row: { id: number }) => row.id)).size, 2);
  assert.deepEqual(usage.recent.map((row: { costCents: number }) => row.costCents).sort((a: number, b: number) => a - b), [0.5, 0.6]);
});

test("usage ID collision exhaustion is bounded and preserves existing costs", async (t) => {
  const owner = `owner-${randomUUID()}@example.test`;
  await store.ensureUsageTable();
  const now = Date.now() + 2_000;
  const clock = t.mock.method(Date, "now", () => now);
  const random = t.mock.method(Math, "random", () => 0);
  const call = { ownerEmail: owner, inputTokens: 1, outputTokens: 0, label: "chat",
    model: "probe/reported", costCentsX100: 10, costSource: "reported" };
  try {
    for (let i = 0; i < 16; i++) await store.recordUsage(call);
    await assert.rejects(store.recordUsage(call), /Usage ID allocation exhausted after 16 conflicts/);
  } finally {
    clock.mock.restore();
    random.mock.restore();
  }
  const usage = await usageFor(owner);
  assert.deepEqual(figure(usage.totals), { costCents: 1.6, calls: 16, unknownCostCalls: 0 });
  const summary = await store.getUsageSummary({ ownerEmail: owner, sinceMs: now - 1_000 });
  assert.equal(new Set(summary.recent.map((row: { id: number }) => row.id)).size, 16);
});

test("a refused usage insert still rejects without recording a charge", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  await store.ensureUsageTable();
  const trigger = `refuse_usage_${randomBytes(4).toString("hex")}`;
  await getDbExec().execute(`CREATE TRIGGER ${trigger} BEFORE INSERT ON token_usage WHEN NEW.owner_email = '${owner}'
    BEGIN SELECT RAISE(ABORT, 'usage refused'); END`);
  try {
    await assert.rejects(store.recordUsage({ ownerEmail: owner, inputTokens: 1, outputTokens: 0,
      model: "probe/reported", costCentsX100: 10, costSource: "reported" }), /usage refused/);
  } finally {
    await getDbExec().execute(`DROP TRIGGER ${trigger}`);
  }
  const usage = await usageFor(owner);
  assert.deepEqual(figure(usage.totals), { costCents: 0, calls: 0, unknownCostCalls: 0 });
});

// The tab lists four models. Five priced models cost more than the unpriced one's known cost of 0.
test("the Usage tab's model list keeps a model whose cost is unknown", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  for (const model of ["probe/unpriced-model", "anthropic/claude-sonnet-5", "mistral-large-latest", "anthropic/claude-haiku-5",
    "openai/gpt-5.6-luna", "google/gemini-3.5-flash"]) {
    await store.recordUsage({ ownerEmail: owner, inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, label: "chat", model });
  }
  const usage = await usageFor(owner);
  assert.deepEqual(usage.byModel.map((row: { key: string }) => row.key),
    ["probe/unpriced-model", "anthropic/claude-sonnet-5", "mistral-large-latest", "anthropic/claude-haiku-5"]);
});

// Rows written before this change hold the catch-all Sonnet price for models the table does not
// price. The table setup runs once per process, so a fresh copy of the store module stands in for
// the first start after an upgrade.
type OldRow = { model: string; centicents: number; source: string };
const insertOldRow = (owner: string, row: OldRow, index: number) => getDbExec().execute({
  sql: `INSERT INTO token_usage (id, owner_email, input_tokens, output_tokens, cost_cents_x100, cost_source, model, label,
    app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 'Vivary', ?)`,
  args: [Date.now() * 1000 + index, owner, INPUT_TOKENS, OUTPUT_TOKENS, row.centicents, row.source, row.model, Date.now()],
});
const rowsOf = async (owner: string, order: "id" | "model"): Promise<OldRow[]> => (await getDbExec().execute({
  sql: `SELECT model, cost_cents_x100, cost_source FROM token_usage WHERE owner_email = ? ORDER BY ${order}`, args: [owner] }))
  .rows.map(row => ({ model: String(row.model), centicents: Number(row.cost_cents_x100), source: String(row.cost_source) }));
const startStore = async (start: string) => import(`${coreUrl("usage/store.js")}?start=${start}-${randomUUID()}`);

test("setup marks the old guesses for unpriced models unknown and keeps every other row", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  await store.ensureUsageTable();
  const oldRows = [
    { model: "stealth/space-bunny-alpha", centicents: 930, source: "estimated" },
    { model: "anthropic/claude-sonnet-5", centicents: SONNET_CENTICENTS, source: "estimated" },
    { model: "probe/free-model", centicents: 0, source: "reported" },
    { model: "probe/paid-model", centicents: 123, source: "reported" },
  ];
  for (const [index, row] of oldRows.entries()) await insertOldRow(owner, row, index);
  for (const start of ["first", "second"]) await (await startStore(start)).ensureUsageTable();
  const usage = await usageFor(owner);
  assert.deepEqual({
    rows: await rowsOf(owner, "id"),
    unknownModel: figure(usage.byModel.find((row: { key: string }) => row.key === "stealth/space-bunny-alpha")),
  }, {
    rows: [{ model: "stealth/space-bunny-alpha", centicents: 0, source: "unavailable" }, ...oldRows.slice(1)],
    unknownModel: { costCents: 0, calls: 1, unknownCostCalls: 1 },
  });
});

// A database can refuse the conversion, for example a role without UPDATE on the table. Setup logs the
// failure and finishes, so usage still records, and the next start converts the rows.
test("a failed conversion of old rows logs and still lets usage record", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  await store.ensureUsageTable();
  await insertOldRow(owner, { model: "stealth/space-bunny-alpha", centicents: 930, source: "estimated" }, 0);
  const trigger = `refuse_conversion_${randomBytes(4).toString("hex")}`;
  await getDbExec().execute(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON token_usage WHEN OLD.owner_email = '${owner}'
    BEGIN SELECT RAISE(ABORT, 'conversion refused'); END`);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let recorded: string;
  try {
    recorded = await (await startStore("refused")).recordUsage({ ownerEmail: owner, inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS, label: "chat", model: "probe/free-model", costCentsX100: 0, costSource: "reported" })
      .then(() => "recorded", (error: Error) => error.message);
  } finally {
    console.warn = warn;
    await getDbExec().execute(`DROP TRIGGER ${trigger}`);
  }
  const afterRefusal = await rowsOf(owner, "model");
  await (await startStore("next")).ensureUsageTable();
  assert.deepEqual({ recorded, warned: warnings.some(line => line.includes("conversion refused")), afterRefusal,
    afterNextStart: await rowsOf(owner, "model") }, {
    recorded: "recorded",
    warned: true,
    afterRefusal: [{ model: "probe/free-model", centicents: 0, source: "reported" },
      { model: "stealth/space-bunny-alpha", centicents: 930, source: "estimated" }],
    afterNextStart: [{ model: "probe/free-model", centicents: 0, source: "reported" },
      { model: "stealth/space-bunny-alpha", centicents: 0, source: "unavailable" }],
  });
});

test("a cost alert counts the calls whose cost is unknown", async () => {
  const owner = `owner-${randomUUID()}@example.test`;
  const call = { ownerEmail: owner, inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, label: "chat" };
  await store.recordUsage({ ...call, model: "probe/unpriced-model" });
  await store.recordUsage({ ...call, model: "anthropic/claude-sonnet-5" });
  const rules = await alerts.listUsageAlerts({ scope: "user", appId: "vivary" }, { ownerEmail: owner, orgId: null });
  const daily = rules.find((rule: { unit: string; period: string }) => rule.unit === "usd" && rule.period === "day");
  assert.deepEqual({ centicents: Math.round(daily.current * 10_000), unknownCostCalls: daily.unknownCostCalls },
    { centicents: SONNET_CENTICENTS, unknownCostCalls: 1 });
});

// An integration run sums its usage with `createTurnUsage`, as the webhook handler does. The handler
// passes the run's usage record to `recordAndSettleIntegrationUsage`, which writes the usage row and
// settles the budget reservations from that one record. A reported cost wins. Without one, a priced
// model settles at its table price and a run with no tokens at 0. An unpriced model that used tokens
// settles at its reservation, so a budget cap still fills, and its row reads Unknown.
const RESERVATION_MICROS = 5_000_000;
async function userBudget(owner: string) {
  const access = { ownerEmail: owner, orgId: null };
  const budget = await budgets.saveIntegrationUsageBudget({ subject: { type: "user", userEmail: owner }, period: "day",
    limitMicros: 4 * RESERVATION_MICROS }, access);
  const settled = async () => {
    const snapshot = await budgets.getIntegrationBudgetSnapshot(budget.id, access);
    return { usedMicros: snapshot.usedMicros, reservedMicros: snapshot.reservedMicros };
  };
  return { budget, access, settled };
}

// `refuseRow` makes the database refuse the run's usage row, as a failed insert would.
async function integrationRun(model: string, respond: Respond, { refuseRow = false } = {}) {
  const { owner, runId, turn } = await runTurn(model, respond);
  const { budget, access, settled } = await userBudget(owner);
  const reservation = { budgetId: budget.id, reservationId: runId, estimatedCostMicros: RESERVATION_MICROS };
  await budgets.reserveIntegrationUsageBudget(reservation, access);
  const trigger = `refuse_usage_row_${randomBytes(4).toString("hex")}`;
  if (refuseRow) {
    await store.ensureUsageTable();
    await getDbExec().execute(`CREATE TRIGGER ${trigger} BEFORE INSERT ON token_usage WHEN NEW.run_id = '${runId}'
      BEGIN SELECT RAISE(ABORT, 'usage row refused'); END`);
  }
  let logged: string[];
  try {
    ({ lines: logged } = await capturingLogs(() => webhooks.recordAndSettleIntegrationUsage([{ ...reservation, access }], {
      usage: turn.usageRecord(), ownerEmail: owner, appId: "vivary", runId, threadId: `thread-${runId}`,
      incoming: { platform: "slack", platformContext: {}, replyRef: `message-${runId}` } })));
  } finally {
    if (refuseRow) await getDbExec().execute(`DROP TRIGGER ${trigger}`);
  }
  return { ...await settled(), rows: await usageRows("run_id", runId),
    ...(refuseRow ? { refusalLogged: logged.some(line => line.includes("usage row refused")) } : {}) };
}

const unpriced = "probe/unpriced-model";
const sonnet = "anthropic/claude-sonnet-5";
// One centicent is 100 currency micros. A run with no tokens records no row.
const integrationRuns: Array<{ name: string; model: string; respond: Respond; usedMicros: number;
  row?: { centicents: number; source: string } }> = [
  { name: "a reported cost", model: unpriced, respond: answer(0.0123), usedMicros: 12_300,
    row: { centicents: 123, source: "reported" } },
  { name: "a reported cost of 0", model: unpriced, respond: answer(0), usedMicros: 0,
    row: { centicents: 0, source: "reported" } },
  { name: "a reported cost for a priced model", model: sonnet, respond: answer(0.0123), usedMicros: 12_300,
    row: { centicents: 123, source: "reported" } },
  { name: "a priced model with no reported cost", model: sonnet, respond: answer(), usedMicros: SONNET_CENTICENTS * 100,
    row: { centicents: SONNET_CENTICENTS, source: "estimated" } },
  { name: "an unpriced model with zero tokens", model: unpriced, respond: answerWithoutUsage, usedMicros: 0 },
  { name: "an unpriced model with tokens and no reported cost", model: unpriced, respond: answer(),
    usedMicros: RESERVATION_MICROS, row: { centicents: 0, source: "unavailable" } },
];

test("an integration run records its usage row and settles its budget from one usage record", async t => {
  for (const run of integrationRuns) {
    await t.test(run.name, async () => {
      assert.deepEqual(await integrationRun(run.model, run.respond), { usedMicros: run.usedMicros, reservedMicros: 0,
        rows: run.row ? [{ tokens: INPUT_TOKENS + OUTPUT_TOKENS, ...run.row }] : [] });
    });
  }
});

// The usage row and the settlement do not depend on each other. A row the database refuses is logged, and
// the budget still settles.
test("a refused usage row is logged and the integration budget still settles", async () => {
  assert.deepEqual(await integrationRun(sonnet, answer(0.0123), { refuseRow: true }),
    { usedMicros: 12_300, reservedMicros: 0, rows: [], refusalLogged: true });
});

// The webhook handler runs a claimed integration task end to end. Its agent loop's first call uses a tool
// and reports usage, and an in-stream provider error cuts off its second call, so the loop throws after it
// used tokens. The handler then posts a fallback reply. The run's usage has no reported cost, because the
// cut call reported none, so it settles at Sonnet's table price. `engine` names an engine instead of
// passing the fake, and `deliver` says whether the platform accepts the reply.
const loopThatThrows: Respond = (response, index) => (index === 0 ? callTool(0.0123) : cutByProviderError)(response, index);
async function integrationTask({ engine, deliver }: { engine?: string; deliver: boolean }) {
  const owner = `owner-${randomUUID()}@example.test`;
  const { settled } = await userBudget(owner);
  const taskId = `task-${randomUUID()}`;
  const incoming = { platform: "probe", externalThreadId: `probe-thread-${taskId}`, text: "Hello", senderId: "probe-user",
    senderEmail: owner, platformContext: {}, timestamp: Date.now() };
  await tasks.insertPendingTask({ id: taskId, platform: incoming.platform, externalThreadId: incoming.externalThreadId,
    payload: JSON.stringify({ incoming }), ownerEmail: owner });
  await tasks.claimPendingTask(taskId);
  const adapter = { platform: incoming.platform, label: "Probe", formatAgentResponse: (text: string) => ({ text }),
    sendResponse: async () => {
      if (!deliver) throw new Error("probe delivery failed");
      return { status: "delivered" };
    } };
  const provider = await fakeOpenRouter(loopThatThrows);
  try {
    const { result: outcome } = await capturingLogs(async () => webhooks.processIntegrationTask(await tasks.getPendingTask(taskId),
      { adapter, systemPrompt: "", actions, model: sonnet, engine: engine ?? provider.engine, ownerEmail: owner, appId: "vivary" }));
    return { status: outcome.status, ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      requests: provider.requests(), ...await settled(), rows: await usageRows("task_id", taskId) };
  } finally {
    await provider.close();
  }
}

const cutRunRow = { tokens: INPUT_TOKENS + OUTPUT_TOKENS, centicents: SONNET_CENTICENTS, source: "estimated" };
test("the webhook handler records and settles a failed integration run", async t => {
  await t.test("a loop that throws after it used tokens, with the reply delivered", async () => {
    assert.deepEqual(await integrationTask({ deliver: true }), { status: "completed", requests: 2,
      usedMicros: SONNET_CENTICENTS * 100, reservedMicros: 0, rows: [cutRunRow] });
  });
  await t.test("a loop that throws after it used tokens, with a reply that fails to deliver", async () => {
    assert.deepEqual(await integrationTask({ deliver: false }), { status: "delivery-pending",
      errorMessage: "probe delivery failed", requests: 2,
      usedMicros: SONNET_CENTICENTS * 100, reservedMicros: 0, rows: [cutRunRow] });
  });
  // An engine that fails to resolve, as one whose package is not installed does, ends the run before its first call.
  await t.test("a run that fails before its first model call", async () => {
    assert.deepEqual(await integrationTask({ engine: "probe-missing-engine", deliver: true }), { status: "completed",
      requests: 0, usedMicros: 0, reservedMicros: 0, rows: [] });
  });
});
