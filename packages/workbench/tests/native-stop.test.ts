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
const { actionsToEngineTools, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } =
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
