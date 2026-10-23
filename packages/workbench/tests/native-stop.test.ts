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
import { H3Event, getResponseStatus } from "h3";
import type { AgentEngine } from "@agent-native/core/agent/engine";
import type { ProductionAgentOptions } from "@agent-native/core/server";

// Issue #106. Stop ends the model request and a tool step that honors its signal at once, and the
// saved reply says the owner stopped it. The provider is a loopback fake that speaks OpenRouter's
// chat completions stream. Stop is the run route's own call, `abortRunDurably(runId, "user")`.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-native-stop-"));
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
const [runs, threads] = await Promise.all([load("agent/run-manager.js"), load("agent/thread-data-builder.js")]);
const { defineAction } = await import("@agent-native/core/action");
const { createAISDKEngine } = await import("@agent-native/core/agent/engine");
const { actionsToEngineTools, createProductionAgentHandler, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } =
  await import("@agent-native/core/server");

// Upper bounds from Stop to each outcome. In 13 runs on Zo the run ended 68 to 206 ms and the model
// connection closed 85 to 216 ms after Stop, most of it while the engine's AI SDK stream settled, and a
// tool's signal fired 0 to 1 ms after Stop.
const RUN_END_MS = 500;
const CONNECTION_CLOSE_MS = 500;
const TOOL_SIGNAL_MS = 50;
const userTurn = [{ role: "user" as const, content: [{ type: "text" as const, text: "Read the project." }] }];
// The run keeps back the last 256 characters of streamed text for redaction, so the reply is longer.
const PARTIAL_REPLY = "Partial answer. ".repeat(24);
const TERMINAL_TYPES = new Set(["done", "error", "missing_api_key", "loop_limit", "auto_continue"]);

const chunkOf = (delta: Record<string, unknown>, finishReason: string | null = null) => ({ id: "gen-probe",
  object: "chat.completion.chunk", created: 0, model: "probe/model", choices: [{ index: 0, delta, finish_reason: finishReason }] });
const send = (response: ServerResponse, chunk: Record<string, unknown>) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);

// `respond` answers the provider request with that index. `closedAt` records when each request's
// connection closed.
async function fakeOpenRouter(respond: (index: number, response: ServerResponse) => void) {
  const closedAt: number[] = [];
  const server = createServer((request, response) => {
    const index = closedAt.length;
    closedAt.push(Number.NaN);
    request.resume();
    response.on("close", () => { closedAt[index] = performance.now(); });
    response.writeHead(200, { "content-type": "text/event-stream" });
    respond(index, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const engine = createAISDKEngine("openrouter", { apiKey: randomBytes(24).toString("hex"),
    baseUrl: `http://127.0.0.1:${port}/api/v1`, allowEnvFallback: false });
  const close = () => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { engine, closedAt, close };
}

async function waitFor(condition: () => boolean, label: () => string) {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${label()}`);
    await new Promise(resolve => originalSetTimeout(resolve, 5));
  }
}

type Provider = Awaited<ReturnType<typeof fakeOpenRouter>>;
type Actions = ReturnType<typeof loadActionsFromStaticRegistry>;
const entriesOf = (runId: string) => runs.getRun(runId).events as Array<{ event: Record<string, unknown> }>;
const eventsOf = (runId: string) => entriesOf(runId).map(entry => entry.event);
// The server saves a finished run's turn from its stored entries, as the chat plugin's onRunComplete does.
const savedTurnOf = (runId: string, turnId: string) =>
  threads.buildAssistantMessage(entriesOf(runId), runId, { suppressInternalContinuation: true, turnId });

// Starts a turn as the chat does. `finished` settles when the run's work ends.
function startTurn(provider: Provider, actions: Actions, threadId = `thread-${randomUUID()}`) {
  const turn = { runId: `run-${randomUUID()}`, turnId: `turn-${randomUUID()}`, loopEndedAt: Number.NaN,
    finished: undefined as Promise<unknown> | undefined };
  runs.startRun(turn.runId, threadId, async (sendEvent: (event: Record<string, unknown>) => void, signal: AbortSignal) => {
    try {
      await runWithRequestContext({ userEmail: "owner@example.test", orgId: "org-a", run: {} }, () => runAgentLoop({
        engine: provider.engine, model: "probe/model", systemPrompt: "", tools: actionsToEngineTools(actions), actions,
        messages: userTurn, signal, send: sendEvent }));
    } finally {
      turn.loopEndedAt = performance.now();
    }
  }, async () => undefined, { waitUntil: (promise: Promise<unknown>) => { turn.finished = promise; } });
  return turn;
}

// Presses Stop once `ready` holds and waits for the run to settle.
async function stopTurn(provider: Provider, actions: Actions, ready: (events: Array<Record<string, unknown>>) => boolean) {
  const turn = startTurn(provider, actions);
  const events = () => eventsOf(turn.runId);
  let stoppedAt = Number.NaN;
  try {
    await waitFor(() => ready(events()), () => `the moment to press Stop, after ${events().map(event => event.type).join(", ")}`);
  } finally {
    stoppedAt = performance.now();
    await runs.abortRunDurably(turn.runId, "user");
    await turn.finished?.catch(() => undefined);
  }
  return { runId: turn.runId, turnId: turn.turnId, stoppedAt, loopEndedAt: turn.loopEndedAt, events: events(),
    saved: savedTurnOf(turn.runId, turn.turnId) };
}

const since = (start: number, end: number) => Math.round(end - start);
// A run that never ends fails its test at this deadline. The script's --test-force-exit then ends the file, which the
// run's own timers would otherwise keep open.
const RUN_TEST = { timeout: 10_000 };

test("Stop while the model streams its reply", RUN_TEST, async t => {
  const provider = await fakeOpenRouter((_index, response) => {
    send(response, chunkOf({ role: "assistant", content: PARTIAL_REPLY }));
  });
  try {
    const turn = await stopTurn(provider, loadActionsFromStaticRegistry({}), events => events.some(event => event.type === "text"));
    await waitFor(() => !Number.isNaN(provider.closedAt[0]), () => "the model connection to close");
    const timing = { runEndMs: since(turn.stoppedAt, turn.loopEndedAt), connectionClosedMs: since(turn.stoppedAt, provider.closedAt[0]) };
    t.diagnostic(`run ended ${timing.runEndMs} ms and the model connection closed ${timing.connectionClosedMs} ms after Stop`);

    await t.test("the run ends and the model connection closes at once", () => {
      assert.deepEqual({
        runEndsInTime: timing.runEndMs < RUN_END_MS,
        connectionClosesInTime: timing.connectionClosedMs < CONNECTION_CLOSE_MS,
        requests: provider.closedAt.length,
        terminal: turn.events.filter(event => TERMINAL_TYPES.has(String(event.type))),
      }, { runEndsInTime: true, connectionClosesInTime: true, requests: 1, terminal: [{ type: "done", reason: "user" }] });
    });

    await t.test("the saved turn keeps its text and says the owner stopped it", () => {
      assert.deepEqual({ content: turn.saved?.content, userStopped: turn.saved?.metadata?.custom?.userStopped },
        { content: [{ type: "text", text: PARTIAL_REPLY }], userStopped: true });
    });

    const question = { id: "user-1", role: "user", content: userTurn[0].content };
    const serverRepo = threads.foldAssistantTurn({ messages: [{ message: question, parentId: null }], headId: "user-1" },
      turn.saved, { runId: turn.runId, turnId: turn.turnId, parentId: "user-1" });
    const clientSave = (clientCopy: Record<string, unknown>) => {
      const merged = threads.mergeThreadDataForClientSave(serverRepo, { messages: [{ message: question, parentId: null },
        { message: clientCopy, parentId: "user-1" }], headId: "client-reply" });
      const reply = merged.messages.at(-1)?.message;
      return { messages: merged.messages.length, content: reply?.content, userStopped: reply?.metadata?.custom?.userStopped };
    };

    // The client saves its own copy of the turn. When assistant-ui cancels the run, that copy can be
    // heavier than the server's and carry no stopped flag, as the #50 turn's saved copy did.
    await t.test("a client save of a heavier copy without the flag keeps the stop and the history", () => {
      const clientCopy = { id: "client-reply", role: "assistant", status: { type: "incomplete", reason: "cancelled" },
        content: [{ type: "reasoning", text: "Reading the project." }, { type: "text", text: `${PARTIAL_REPLY}And more.` }],
        metadata: { runId: turn.runId, custom: { runId: turn.runId, turnId: turn.turnId, agentNativeRunDurationMs: 1_000 } } };
      assert.deepEqual(clientSave(clientCopy), { messages: 2, content: clientCopy.content, userStopped: true });
    });

    // A later run can continue the same turn, as a reconnect recovery does. It finishes, so its reply is not the
    // stopped one.
    const laterRunId = `run-${randomUUID()}`;
    const later = threads.buildAssistantMessage([{ seq: 0, event: { type: "text", text: "Finished answer." } },
      { seq: 1, event: { type: "done" } }], laterRunId, { suppressInternalContinuation: true, turnId: turn.turnId });

    await t.test("a later run that finishes the same turn does not keep the stop", () => {
      const folded = threads.foldAssistantTurn(serverRepo, later, { runId: laterRunId, turnId: turn.turnId, parentId: "user-1" });
      const reply = folded.messages.at(-1)?.message;
      assert.deepEqual({ messages: folded.messages.length, foldedRunIds: reply?.metadata?.custom?.foldedRunIds,
        userStopped: reply?.metadata?.custom?.userStopped }, { messages: 2, foldedRunIds: [turn.runId, laterRunId], userStopped: undefined });
    });

    await t.test("a client save of a later run in the same turn does not take the stop", () => {
      const clientCopy = { id: "client-reply", role: "assistant", status: { type: "complete", reason: "stop" },
        content: [{ type: "text", text: `${PARTIAL_REPLY}Finished answer.` }],
        metadata: { runId: laterRunId, custom: { runId: laterRunId, turnId: turn.turnId } } };
      assert.deepEqual(clientSave(clientCopy), { messages: 2, content: clientCopy.content, userStopped: undefined });
    });
  } finally {
    await provider.close();
  }
});

test("Stop during a tool step that honors its signal", RUN_TEST, async t => {
  const tool = { startedAt: Number.NaN, signalAt: Number.NaN };
  const actions = loadActionsFromStaticRegistry({ "probe-read": { default: defineAction({ description: "Read the project slowly.",
    schema: z.object({}), agentTool: true, http: false, readOnly: true, dedupe: false,
    run: async (_args: unknown, context: { signal?: AbortSignal }) => {
      tool.startedAt = performance.now();
      await new Promise<void>(resolve => {
        const timer = originalSetTimeout(resolve, 5_000);
        context.signal?.addEventListener("abort", () => {
          tool.signalAt = performance.now();
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return "read";
    } }) } });
  const provider = await fakeOpenRouter((index, response) => {
    if (index === 0) {
      send(response, chunkOf({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-read", type: "function",
        function: { name: "probe-read", arguments: "{}" } }] }));
      send(response, chunkOf({}, "tool_calls"));
    } else {
      send(response, chunkOf({ role: "assistant", content: "Read it." }));
      send(response, chunkOf({}, "stop"));
    }
    response.end("data: [DONE]\n\n");
  });
  try {
    const turn = await stopTurn(provider, actions, () => performance.now() - tool.startedAt >= 200);
    const timing = { runEndMs: since(turn.stoppedAt, turn.loopEndedAt), toolSignalMs: since(turn.stoppedAt, tool.signalAt) };
    t.diagnostic(`run ended ${timing.runEndMs} ms and the tool's signal fired ${timing.toolSignalMs} ms after Stop`);

    await t.test("the run ends and the tool's signal fires at once", () => {
      assert.deepEqual({
        runEndsInTime: timing.runEndMs < RUN_END_MS,
        toolSignalInTime: timing.toolSignalMs < TOOL_SIGNAL_MS,
        requests: provider.closedAt.length,
        terminal: turn.events.filter(event => TERMINAL_TYPES.has(String(event.type))),
      }, { runEndsInTime: true, toolSignalInTime: true, requests: 1, terminal: [{ type: "done", reason: "user" }] });
    });

    await t.test("the saved turn with no text keeps its tool call and says the owner stopped it", () => {
      assert.deepEqual({ parts: turn.saved?.content?.map((part: { type: string; toolName?: string }) => [part.type, part.toolName]),
        userStopped: turn.saved?.metadata?.custom?.userStopped }, { parts: [["tool-call", "probe-read"]], userStopped: true });
    });
  } finally {
    await provider.close();
  }
});

// The owner stops the turn while OpenRouter still sends only its keep-alive comments, before any text, reasoning, or
// tool call.
test("Stop before the model sends anything", RUN_TEST, async t => {
  const provider = await fakeOpenRouter((_index, response) => { response.write(": OPENROUTER PROCESSING\n\n"); });
  try {
    const turn = await stopTurn(provider, loadActionsFromStaticRegistry({}), () => provider.closedAt.length > 0);
    const runEndMs = since(turn.stoppedAt, turn.loopEndedAt);
    t.diagnostic(`run ended ${runEndMs} ms after Stop`);

    await t.test("the run ends at once and the saved turn says the owner stopped it", () => {
      assert.deepEqual({
        runEndsInTime: runEndMs < RUN_END_MS,
        terminal: turn.events.filter(event => TERMINAL_TYPES.has(String(event.type))),
        content: turn.saved?.content,
        userStopped: turn.saved?.metadata?.custom?.userStopped,
      }, { runEndsInTime: true, terminal: [{ type: "done", reason: "user" }], content: [], userStopped: true });
    });

    // The server saves a finished run's turn only when it builds one, as onRunComplete does.
    const question = { id: "user-1", role: "user", content: userTurn[0].content };
    const questionRepo = { messages: [{ message: question, parentId: null }], headId: "user-1" };
    const serverRepo = turn.saved
      ? threads.foldAssistantTurn(questionRepo, turn.saved, { runId: turn.runId, turnId: turn.turnId, parentId: "user-1" })
      : questionRepo;
    const clientSave = (existing: Record<string, unknown>, clientCopy: Record<string, unknown>) => {
      const merged = threads.mergeThreadDataForClientSave(existing, { messages: [{ message: question, parentId: null },
        { message: clientCopy, parentId: "user-1" }], headId: "client-reply" });
      return {
        roles: merged.messages.map((entry: { message: { role: string } }) => entry.message.role),
        userStopped: merged.messages.at(-1)?.message?.metadata?.custom?.userStopped,
        nextRequestRoles: threads.threadDataToEngineMessages(merged).map((message: { role: string }) => message.role),
      };
    };
    const clientCopy = (custom: Record<string, unknown>) => ({ id: "client-reply", role: "assistant", content: [],
      status: { type: "incomplete", reason: "cancelled" }, metadata: { runId: turn.runId, custom: { runId: turn.runId,
        turnId: turn.turnId, ...custom } } });
    // The next request's history leaves the empty reply out, as the live chat's history does.
    const kept = { roles: ["user", "assistant"], userStopped: true, nextRequestRoles: ["user"] };

    await t.test("a client save of the cancelled copy without the flag keeps the question and the stopped reply", () => {
      assert.deepEqual(clientSave(serverRepo, clientCopy({})), kept);
    });

    await t.test("a client save of the flagged copy before the server's save keeps the stopped reply", () => {
      assert.deepEqual(clientSave(questionRepo, clientCopy({ userStopped: true })), kept);
    });
  } finally {
    await provider.close();
  }
});

// A new turn that arrives while the thread's older run is still in memory displaces that run. The owner did not stop it.
test("a run that a newer turn displaces is not labeled as stopped", RUN_TEST, async () => {
  const provider = await fakeOpenRouter((_index, response) => {
    send(response, chunkOf({ role: "assistant", content: PARTIAL_REPLY }));
  });
  try {
    const threadId = `thread-${randomUUID()}`;
    const older = startTurn(provider, loadActionsFromStaticRegistry({}), threadId);
    await waitFor(() => eventsOf(older.runId).some(event => event.type === "text"), () => "the older run to stream its reply");
    runs.startRun(`run-${randomUUID()}`, threadId, async () => undefined, async () => undefined, { waitUntil: () => undefined });
    await older.finished?.catch(() => undefined);
    const saved = savedTurnOf(older.runId, older.turnId);
    assert.deepEqual({
      terminal: eventsOf(older.runId).filter(event => TERMINAL_TYPES.has(String(event.type))),
      content: saved?.content,
      userStopped: saved?.metadata?.custom?.userStopped,
    }, { terminal: [{ type: "done" }], content: [{ type: "text", text: PARTIAL_REPLY }], userStopped: undefined });
  } finally {
    await provider.close();
  }
});

// Admission controls call the actual production handler with a real H3 Request and SQLite stores.
// The custom engine is the public provider seam; none of these pre-launch outcomes may call its stream.
const nativeStore = await load("chat-threads/store.js"), runStore = await load("agent/run-store.js");
const sharingRegistry = await load("sharing/registry.js");
// The registry skips test-file registrations outside a supported test runtime. Keep this synchronous window narrow;
// the handler and the existing Stop controls continue to use their original production environment.
const registrationNodeEnv = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = "test";
  nativeStore.registerChatThreadsShareable();
} finally {
  if (registrationNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = registrationNodeEnv;
}
assert.equal(process.env.NODE_ENV, "production");
const chatThreadResource = sharingRegistry.getShareableResource("chat_thread");
assert.ok(chatThreadResource, "Native admission setup must register the real chat_thread resource");
assert.equal(chatThreadResource.type, "chat_thread");
assert.equal(sharingRegistry.requireShareableResource("chat_thread"), chatThreadResource);
const { isAgentChatForegroundSelfChainEnabled } = await load("agent/durable-background.js");
const { getDbExec, withMigrationRuntime } = await import("@agent-native/core/db");
type PreparedNativeRun = Parameters<NonNullable<ProductionAgentOptions["onRunPrepared"]>>[0];
const admissionOwner = "native-admission@example.test", admissionOrg = "native-admission-org";

async function nativeAdmissionFixture(prepare?: (details: PreparedNativeRun) => Promise<void>) {
  await withMigrationRuntime(async () => { await nativeStore.ensureChatThreadTables(); await runStore.ensureRunTables(); });
  const threadId = `native-admission-${randomUUID()}`, turnId = `turn-${randomUUID()}`;
  const scope = { type: "workspace-app", id: `scope-${randomUUID()}` };
  await nativeStore.createThread(admissionOwner, { id: threadId, orgId: admissionOrg, scope });
  const saved = { headId: "existing", messages: [{ message: { id: "existing", role: "user",
    content: [{ type: "text", text: "Keep the saved history" }] }, parentId: null }] };
  await nativeStore.updateThreadData(threadId, JSON.stringify(saved), "Admission fixture", "Keep the saved history", 1);
  const before = await nativeStore.getThread(threadId);
  const prepared: PreparedNativeRun[] = [];
  let streams = 0;
  const engine: AgentEngine = { name: "native-admission-fixture", label: "Admission fixture", defaultModel: "fixture-model",
    supportedModels: ["fixture-model"], capabilities: { thinking: false, promptCaching: false, vision: false,
      computerUse: false, parallelToolCalls: false },
    async *stream() { streams++; yield { type: "assistant-content", parts: [] }; yield { type: "stop", reason: "end_turn" }; } };
  const handler = createProductionAgentHandler({ engine, model: "fixture-model", actions: {}, systemPrompt: "",
    skipFilesContext: true, durableBackgroundRuns: false,
    onRunPrepared: async details => { prepared.push(details); await prepare?.(details); } });
  const request = async () => {
    const event = new H3Event(new Request("http://localhost/_agent-native/agent-chat", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnId, scope, message: "A new admitted question" }) }));
    const result = await runWithRequestContext({ userEmail: admissionOwner, orgId: admissionOrg, run: { chatScope: scope } },
      () => handler(event));
    return { result, status: getResponseStatus(event) };
  };
  const initialMode = isAgentChatForegroundSelfChainEnabled() ? "foreground-self-chain" : "foreground";
  return { threadId, turnId, scope, saved, before, prepared, request, initialMode, streams: () => streams };
}

async function nativeAdmissionRow(runId: string) {
  const result = await getDbExec().execute({ sql: "SELECT * FROM agent_runs WHERE id = ?", args: [runId] });
  return result.rows.at(0);
}

async function nativeAdmissionReleased(threadId: string) {
  let entered = false;
  await nativeStore.withThreadAdmissionLock(threadId, async () => { entered = true; });
  assert.equal(entered, true, "the completed refusal or failure releases thread admission");
}

test("Native admission insert failure precedes preparation and leaves saved history intact", RUN_TEST, async () => {
  const fixture = await nativeAdmissionFixture();
  const db = getDbExec(), execute = db.execute, failure = new Error("fixture run INSERT failure");
  let failedRunId: string | undefined;
  db.execute = async statement => {
    if (typeof statement !== "string" && /^INSERT INTO agent_runs \(id, thread_id, status, started_at,/i.test(statement.sql)) {
      const args = Array.isArray(statement.args) ? statement.args : [];
      if (args[1] === fixture.threadId) {
        const runId = args[0];
        assert.ok(typeof runId === "string");
        failedRunId = runId;
        throw failure;
      }
    }
    return execute.call(db, statement);
  };
  try { await assert.rejects(fixture.request(), failure); }
  finally { db.execute = execute; }
  assert.ok(failedRunId, "the real handler reached its durable INSERT");
  assert.equal(await nativeAdmissionRow(failedRunId), undefined);
  assert.equal(fixture.prepared.length, 0, "the user's message is not prepared before a successful durable INSERT");
  assert.equal((await nativeStore.getThread(fixture.threadId)).threadData, fixture.before.threadData);
  assert.equal(fixture.streams(), 0);
  assert.equal(runs.getRun(failedRunId), null, "no in-memory worker was started");
  await nativeAdmissionReleased(fixture.threadId);
});

test("Native admission duplicate run ID neither prepares a message nor cleans up another row", RUN_TEST, async () => {
  const fixture = await nativeAdmissionFixture();
  const otherThreadId = `other-${fixture.threadId}`;
  await nativeStore.createThread("another-native-owner@example.test", { id: otherThreadId, orgId: admissionOrg });
  const db = getDbExec(), execute = db.execute;
  let collidedRunId: string | undefined, competingRow: Awaited<ReturnType<typeof nativeAdmissionRow>>;
  db.execute = async statement => {
    if (!collidedRunId && typeof statement !== "string"
      && /^INSERT INTO agent_runs \(id, thread_id, status, started_at,/i.test(statement.sql)) {
      const args = Array.isArray(statement.args) ? statement.args : [];
      if (args[1] === fixture.threadId) {
        const runId = args[0];
        assert.ok(typeof runId === "string");
        collidedRunId = runId;
        // A valid competing row already owns this generated ID. Use Core's real store, not a fake INSERT result.
        assert.equal(await runStore.insertRun(runId, otherThreadId, "other-turn", { dispatchMode: "background",
          dispatchPayload: JSON.stringify({ threadId: otherThreadId, turnId: "other-turn", message: "The other request's payload" }) }), true);
        competingRow = await nativeAdmissionRow(runId);
      }
    }
    return execute.call(db, statement);
  };
  let response: Awaited<ReturnType<typeof fixture.request>>;
  try { response = await fixture.request(); }
  finally { db.execute = execute; }
  assert.ok(collidedRunId);
  assert.deepEqual(response, { status: 409, result: { error: "Run already exists", activeRunId: collidedRunId } });
  assert.deepEqual(await nativeAdmissionRow(collidedRunId), competingRow, "the losing request owns neither cleanup nor payload changes");
  assert.equal(fixture.prepared.length, 0);
  assert.equal((await nativeStore.getThread(fixture.threadId)).threadData, fixture.before.threadData);
  assert.equal(fixture.streams(), 0);
  assert.equal(runs.getRun(collidedRunId), null);
  await nativeAdmissionReleased(fixture.threadId);
});

test("Native admission preparation failure terminalizes only its inserted row and releases admission", RUN_TEST, async () => {
  const failure = new Error("fixture message preparation failure");
  const fixture = await nativeAdmissionFixture(async details => {
    const row = await nativeAdmissionRow(details.runId);
    assert.equal(row?.status, "running", "preparation sees its already durable row");
    assert.equal(row?.thread_id, details.threadId);
    assert.equal(row?.turn_id, fixture.turnId);
    assert.equal(row?.dispatch_mode, fixture.initialMode, "the actual foreground INSERT uses its initial dispatch mode");
    assert.equal(row?.dispatch_payload, null);
    throw failure;
  });
  await assert.rejects(fixture.request(), failure);
  assert.equal(fixture.prepared.length, 1);
  const runId = fixture.prepared[0].runId, row = await nativeAdmissionRow(runId);
  assert.equal(row?.status, "errored");
  assert.equal(row?.terminal_reason, "error:run_preparation_failed");
  assert.equal(row?.error_code, "run_preparation_failed");
  assert.equal((await nativeStore.getThread(fixture.threadId)).threadData, fixture.before.threadData);
  assert.equal(fixture.streams(), 0);
  assert.equal(runs.getRun(runId), null);
  await nativeAdmissionReleased(fixture.threadId);
});

test("Native admission honors durable Stop while onRunPrepared waits, before worker launch", RUN_TEST, async () => {
  let entered = () => {}, release = () => {};
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const fixture = await nativeAdmissionFixture(async details => {
    const message = { message: { id: details.runId, role: "user", content: [{ type: "text", text: details.message }] },
      parentId: fixture.saved.headId };
    await nativeStore.withThreadDataLock(fixture.threadId, () => nativeStore.updateThreadData(fixture.threadId,
      JSON.stringify({ headId: details.runId, messages: [...fixture.saved.messages, message] }), "Admission fixture", details.message, 2));
    entered();
    await proceed;
  });
  const request = fixture.request();
  try {
    const endedBeforePreparation = await Promise.race([preparing.then(() => null), request]);
    assert.equal(endedBeforePreparation, null, "the handler terminated before onRunPrepared was reached");
    const runId = fixture.prepared[0].runId;
    assert.equal((await nativeAdmissionRow(runId))?.dispatch_mode, fixture.initialMode);
    assert.equal(runs.getRun(runId), null, "preparation holds admission before in-memory startRun");
    await runs.abortTurnDurably(runId, "user");
    assert.equal(await runStore.isTurnAborted(fixture.threadId, fixture.turnId), true);
    release();
    assert.deepEqual(await request, { status: 200, result: { ok: true, stopped: true } });
    const row = await nativeAdmissionRow(runId);
    assert.equal(row?.status, "aborted");
    assert.equal(row?.terminal_reason, "aborted:user");
    assert.equal(row?.dispatch_mode, fixture.initialMode);
    assert.equal(row?.dispatch_payload, null);
    assert.equal(fixture.prepared.length, 1);
    const saved = JSON.parse((await nativeStore.getThread(fixture.threadId)).threadData);
    assert.deepEqual(saved.messages.map((entry: { message: { content: Array<{ text: string }> } }) => entry.message.content),
      [[{ type: "text", text: "Keep the saved history" }], [{ type: "text", text: "A new admitted question" }]]);
    assert.equal(fixture.streams(), 0, "Stop prevents the provider loop from starting");
    assert.equal(runs.getRun(runId), null);
    await nativeAdmissionReleased(fixture.threadId);
  } finally { release(); await request.catch(() => undefined); }
});
