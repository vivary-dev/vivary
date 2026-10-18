import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Issue #101. OpenRouter ends a failed stream with an in-stream error chunk. The owner must see the
// provider's message and code, with no held credential, instead of "Engine stream error". The
// provider is a loopback fake that speaks OpenRouter's chat completions stream. Every value is
// random and generated for this run. A failed comparison masks the generated values.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-native-stream-errors-"));
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
const [audit, runs, agent, threads, translate] = await Promise.all([load("audit/redact.js"), load("agent/run-manager.js"),
  load("agent/production-agent.js"), load("agent/thread-data-builder.js"), load("agent/engine/translate-ai-sdk.js")]);
const { defineAction } = await import("@agent-native/core/action");
const { createAISDKEngine } = await import("@agent-native/core/agent/engine");
const { actionsToEngineTools, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } =
  await import("@agent-native/core/server");
const { heldCredentialHoldback, redactCredentials, refreshHeldCredentials } = await import("../server/credential-redaction.ts");

audit.setTextRedactor?.(redactCredentials, { holdback: () => heldCredentialHoldback?.() ?? 256 });
const generated: string[] = [];
const synthetic = (length = 40) => {
  const value = randomBytes(length * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, length - 2) + "4k";
  generated.push(value);
  return value;
};
const masked = (text: string) => generated.reduce((out, value) => out.split(value).join("<generated>"), text);
function assertText(actual: string, expected: string, label = "") {
  if (actual !== expected) assert.fail(`${label} ${masked(actual)} !== ${masked(expected)}`);
}
function assertHidden(text: string, values: string[], label: string) {
  const shown = values.filter(value => text.includes(value)).length;
  assert.equal(shown, 0, `${label} showed ${shown} generated value(s)`);
}

const METADATA_MARKER = "upstream-metadata-marker";
const RAW_CHUNK_MARKER = "raw-chunk-marker";
const UNREADABLE_CHUNK = "The model provider sent a response that could not be read";
const userTurn = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }];

// A string chunk is sent as written, so a stream can carry a chunk that is not JSON.
type Chunk = Record<string, unknown> | string;
const chunkOf = (choice: Record<string, unknown>) => ({ id: "gen-probe", object: "chat.completion.chunk", created: 0,
  model: "probe/model", choices: [{ index: 0, finish_reason: null, ...choice }] });
const text = (content: string) => chunkOf({ delta: { role: "assistant", content } });
const finish = chunkOf({ delta: {}, finish_reason: "stop" });
// An annotation type the OpenRouter provider does not know fails its chunk schema.
const unknownAnnotation = chunkOf({ delta: { content: "", annotations: [{ type: "probe_annotation", probe_annotation: RAW_CHUNK_MARKER }] } });
const providerError = (error: Record<string, unknown>) => ({ error });
const openRouterError = (message: string, metadata: Record<string, unknown> = {}) =>
  providerError({ code: 502, message, metadata: { provider_name: "Probe", raw: METADATA_MARKER, ...metadata } });

// `chunks` answers every request alike, or each request by its index.
async function fakeOpenRouter(chunks: Chunk[] | ((index: number) => Chunk[])) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const index = requests.length;
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of typeof chunks === "function" ? chunks(index) : chunks) {
      response.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const engine = createAISDKEngine("openrouter", { apiKey: synthetic(), baseUrl: `http://127.0.0.1:${port}/api/v1`,
    allowEnvFallback: false });
  return { engine, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

// The AI SDK logs the raw provider error. Vivary's server plugin redacts that log, and this file
// does not load the plugin, so the log is kept off the test output.
async function withoutErrorLog<T>(run: () => Promise<T>): Promise<T> {
  const log = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = log;
  }
}

async function streamToEnd(chunks: Chunk[]) {
  const provider = await fakeOpenRouter(chunks);
  try {
    const events = await withoutErrorLog(async () => {
      const seen: Array<Record<string, unknown>> = [];
      for await (const event of provider.engine.stream({ model: "probe/model", systemPrompt: "", tools: [],
        messages: userTurn, abortSignal: new AbortController().signal })) {
        seen.push(event as Record<string, unknown>);
      }
      return seen;
    });
    return { events, requests: provider.requests };
  } finally {
    await provider.close();
  }
}

type Actions = ReturnType<typeof loadActionsFromStaticRegistry>;
type Events = Array<Record<string, unknown>>;
const eventsOf = (runId: string) => (runs.getRun(runId).events as Array<{ event: Record<string, unknown> }>).map(entry => entry.event);

async function waitFor(condition: () => boolean, label: string) {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => originalSetTimeout(resolve, 5));
  }
}

// One turn through startRun and the agent loop, as the chat runs it. `thrown` is what the loop threw,
// which the main chat's in-process continuation reads. `actions` become the turn's tools. `stopWhen`
// presses Stop, the run route's own `abortRunDurably(runId, "user")`, once the run's events satisfy it.
async function runTurn(chunks: Chunk[] | ((index: number) => Chunk[]),
  options: { actions?: Actions; stopWhen?: (events: Events) => boolean } = {}) {
  const provider = await fakeOpenRouter(chunks);
  const runId = `run-${randomUUID()}`;
  const turnId = `turn-${randomUUID()}`;
  const actions = options.actions ?? loadActionsFromStaticRegistry({});
  let thrown: unknown;
  try {
    await withoutErrorLog(async () => {
      let finished: Promise<unknown> | undefined;
      runs.startRun(runId, `thread-${randomUUID()}`, async (send: (event: Record<string, unknown>) => void, signal: AbortSignal) => {
        try {
          await runWithRequestContext({ userEmail: "owner@example.test", orgId: "org-a", run: {} }, () => runAgentLoop({
            engine: provider.engine, model: "probe/model", systemPrompt: "", tools: options.actions ? actionsToEngineTools(actions) : [],
            actions, messages: userTurn, signal, send }));
        } catch (error) {
          thrown = error;
          throw error;
        }
      }, async () => undefined, { waitUntil: (promise: Promise<unknown>) => { finished = promise; } });
      if (options.stopWhen) {
        const stopWhen = options.stopWhen;
        try {
          await waitFor(() => stopWhen(eventsOf(runId)), "the moment to press Stop");
        } finally {
          await runs.abortRunDurably(runId, "user");
        }
      }
      await finished?.catch(() => undefined);
    });
    const entries = runs.getRun(runId).events as Array<{ event: Record<string, unknown> }>;
    return { runId, turnId, entries, events: entries.map(entry => entry.event), thrown, requests: provider.requests };
  } finally {
    await provider.close();
  }
}
type Turn = Awaited<ReturnType<typeof runTurn>>;

// The chat plugin's onRunComplete saves a finished run this way. `continuationFollows` is true only
// when the server chains its own continuation of the turn, which Vivary never does (issue #246).
const savedTurnOf = (turn: Turn, continuationFollows: boolean) => threads.buildAssistantMessage(turn.entries, turn.runId,
  { suppressInternalContinuation: true, continuationFollows, turnId: turn.turnId });

const streams: Array<{ name: string; chunks: Chunk[]; stop: Record<string, unknown> }> = [
  { name: "an OpenRouter error chunk names its code and upstream provider",
    chunks: [text("Partial"), openRouterError("Provider returned error")],
    stop: { reason: "error", error: "Provider returned error (code 502, from Probe)", errorCode: "provider_stream_error" } },
  { name: "an error chunk with no message still reads as the provider's error (Opus S2)",
    chunks: [text("Partial"), providerError({ code: 502, metadata: { provider_name: "Probe", raw: METADATA_MARKER } })],
    stop: { reason: "error", error: "The model provider returned an error (code 502, from Probe)", errorCode: "provider_stream_error" } },
  { name: "OpenRouter's documented mid-stream error shape (Opus S4)",
    chunks: [text("Partial"), { id: "cmpl-probe", object: "chat.completion.chunk", created: 0, model: "probe/model", provider: "probe",
      error: { code: "server_error", message: "Provider disconnected unexpectedly" },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }],
    stop: { reason: "error", error: "Provider disconnected unexpectedly (code server_error)", errorCode: "provider_stream_error" } },
  { name: "an error with a type and no code shows the type (Fable 6)",
    chunks: [text("Partial"), providerError({ type: "api_error", message: "Internal server error" })],
    stop: { reason: "error", error: "Internal server error (code api_error)", errorCode: "provider_stream_error" } },
  { name: "a provider name with other characters is left out",
    chunks: [text("Partial"), openRouterError("Provider returned error", { provider_name: `Probe <${METADATA_MARKER}>` })],
    stop: { reason: "error", error: "Provider returned error (code 502)", errorCode: "provider_stream_error" } },
  { name: "a provider name over 64 characters is left out",
    chunks: [text("Partial"), openRouterError("Provider returned error", { provider_name: `Probe ${"x".repeat(59)}` })],
    stop: { reason: "error", error: "Provider returned error (code 502)", errorCode: "provider_stream_error" } },
  { name: "an unknown chunk mid-stream, then a normal finish, ends the turn normally (Opus S3)",
    chunks: [text("Partial"), unknownAnnotation, text(" answer"), finish],
    stop: { reason: "end_turn", error: undefined, errorCode: undefined } },
  { name: "an unreadable chunk, then the provider's error, ends with the provider's error",
    chunks: [text("Partial"), unknownAnnotation, openRouterError("Provider returned error")],
    stop: { reason: "error", error: "Provider returned error (code 502, from Probe)", errorCode: "provider_stream_error" } },
  { name: "the provider's error, then an unreadable chunk, ends with the provider's error",
    chunks: [text("Partial"), openRouterError("Provider returned error"), unknownAnnotation],
    stop: { reason: "error", error: "Provider returned error (code 502, from Probe)", errorCode: "provider_stream_error" } },
  { name: "an unreadable last chunk ends with a fixed sentence, not the chunk",
    chunks: [text("Partial"), unknownAnnotation],
    stop: { reason: "error", error: UNREADABLE_CHUNK, errorCode: undefined } },
  { name: "a last chunk that is not JSON ends with the fixed sentence, not the chunk",
    chunks: [text("Partial"), `{"choices":[{"delta":{"content":"${RAW_CHUNK_MARKER}"`],
    stop: { reason: "error", error: UNREADABLE_CHUNK, errorCode: undefined } },
];

test("the engine's final stop for each in-stream shape", async t => {
  for (const stream of streams) {
    await t.test(stream.name, async () => {
      const { events, requests } = await streamToEnd(stream.chunks);
      const stop = events.at(-1);
      assert.deepEqual({ type: stop?.type, reason: stop?.reason, error: stop?.error, errorCode: stop?.errorCode },
        { type: "stop", ...stream.stop });
      const shown = JSON.stringify(events);
      assert.equal(shown.includes(METADATA_MARKER), false, "provider metadata stays out of the stream");
      assert.equal(shown.includes(RAW_CHUNK_MARKER), false, "a raw chunk stays out of the stream");
      assert.deepEqual(requests, ["POST /api/v1/chat/completions"]);
    });
  }
});

// OpenAI's Responses stream reports an in-stream error as a plain object with the HTTP status its SDK
// derived and the raw frame under `data`. The status still decides the code, and the frame is not shown.
test("a provider error that carries its own HTTP status keeps its status code", () => {
  const [stop] = translate.aiSdkPartToEngineEvents({ type: "error", error: { message: "Rate limit reached for requests",
    type: "requests", code: "rate_limit_exceeded", statusCode: 429, isRetryable: true, data: { raw: METADATA_MARKER } } }, new Map());
  assert.deepEqual({ error: stop.error, errorCode: stop.errorCode, statusCode: stop.statusCode, providerRetryable: stop.providerRetryable },
    { error: "Rate limit reached for requests (code rate_limit_exceeded)", errorCode: "http_429", statusCode: 429, providerRetryable: true });
});

test("the run's error event carries the provider's message and code once, with held values as placeholders", async () => {
  const held = synthetic();
  await refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: held }), mcpConfig: () => null, storedSecrets: async () => [] });
  const turn = await runTurn([text("Partial"), openRouterError(`Provider returned error for ${held}`)]);
  const shown = JSON.stringify(turn.events);
  assertHidden(shown, [held], "run events");
  assert.equal(shown.includes(METADATA_MARKER), false, "provider metadata stays out of the run");
  const error = turn.events.find(event => event.type === "error");
  assertText(String(error?.error), "Provider returned error for [redacted VIVARY_PROBE_TOKEN] (code 502, from Probe)", "error text");
  assert.equal(error?.errorCode, "provider_stream_error");
  // A transient-looking code in the message must not buy silent retries that hide it.
  assert.deepEqual(turn.requests, ["POST /api/v1/chat/completions"]);
});

// Every server check reads the code first. A message or metadata that names 502, a timeout, an
// overload, a closed stream, or an unavailable service must not turn the error into silent retries,
// a continuation, or a saved turn with no error.
const finalTurns: Array<{ name: string; chunks: Chunk[] }> = [
  { name: "streamed text, then the error (Opus 1)", chunks: [text("Partial"), openRouterError("Provider returned error")] },
  { name: "the error with no streamed text (Opus 1)", chunks: [openRouterError("Provider returned error")] },
  { name: "a message naming a temporarily unavailable service (Opus S6)",
    chunks: [text("Partial"), providerError({ code: 503, message: "Service temporarily unavailable" })] },
  { name: "a message naming a closed stream (Fable 2)", chunks: [text("Partial"), openRouterError("Upstream stream closed")] },
  { name: "metadata naming an overload (Fable 1)", chunks: [text("Partial"), openRouterError("Provider returned error",
    { raw: `{"error":{"code":503,"message":"The model is overloaded. ${METADATA_MARKER}"}}` })] },
  { name: "metadata naming a timeout (Opus S5)", chunks: [text("Partial"), openRouterError("Provider returned error",
    { raw: `Request timed out ${METADATA_MARKER}` })] },
  // The provider's message itself must not be classified either. Before 2026-10-18 each of these
  // was retried three times, classified as continuable, and saved with no error.
  { name: "a message naming a timeout", chunks: [text("Partial"), openRouterError("Upstream request timed out")] },
  { name: "a message naming an overload", chunks: [text("Partial"), openRouterError("The model is overloaded. Please try again later.")] },
  { name: "a message naming 429", chunks: [text("Partial"), openRouterError("Rate limited (429): too many requests")] },
  { name: "a message naming SSL", chunks: [text("Partial"), openRouterError("Upstream SSL handshake failed")] },
];

test("an in-stream provider error is final in every server check", async t => {
  for (const turn of finalTurns) {
    await t.test(turn.name, async () => {
      const { runId, entries, events, thrown, requests } = await runTurn(turn.chunks);
      const error = events.find(event => event.type === "error");
      assert.ok(thrown instanceof Error, "the agent loop throws the provider's error");
      // The server saves a turn from the run's stored entries, as the chat plugin's onRunComplete does.
      const saved = threads.buildAssistantMessage(entries, runId, { suppressInternalContinuation: true });
      // Issue #246 changes only continuation-class errors. A final error saves the same turn whether or
      // not a server continuation follows.
      const savedWithoutContinuation = threads.buildAssistantMessage(entries, runId,
        { suppressInternalContinuation: true, continuationFollows: false });
      const shape = (message: typeof saved) => ({ content: message?.content, status: message?.status, metadata: message?.metadata });
      assert.deepEqual({
        errorCode: error?.errorCode,
        requests: requests.length,
        savedErrorCode: saved?.metadata?.custom?.runError?.errorCode,
        continuesInBackground: agent.isRecoverableContinuationError(error),
        resumesInProcess: agent.isResumableEngineError(thrown),
        sameWithoutContinuation: JSON.stringify(shape(savedWithoutContinuation)) === JSON.stringify(shape(saved)),
      }, {
        errorCode: "provider_stream_error",
        requests: 1,
        savedErrorCode: "provider_stream_error",
        continuesInBackground: false,
        resumesInProcess: false,
        sameWithoutContinuation: true,
      });
    });
  }
});

// Issue #246. A provider's in-stream code 429, or an error type that names a timeout or an overload,
// classifies as a retryable code. The engine retries it three times, then the agent loop throws. Vivary
// chains no server continuation, so the saved turn is the turn's final state. It keeps its partial text
// and saves the error as failed and recoverable, so a reload shows the error with a Retry. Before
// 2026-10-18 the saved turn read as complete with no error. Each exhausted turn waits through about
// 14 seconds of retry backoff.
const exhaustedTurns = [
  { name: "an in-stream code 429", error: { code: 429, message: "Rate limit exceeded" }, errorCode: "http_429" },
  { name: "an in-stream timeout type", error: { type: "timeout_error", message: "Provider returned error" }, errorCode: "timeout" },
  { name: "an in-stream overload type", error: { type: "overloaded_error", message: "Provider returned error" },
    errorCode: "overloaded_error" },
];
type Saved = ReturnType<typeof savedTurnOf>;
const COMPLETE = { type: "complete", reason: "stop" };
const FAILED = { type: "incomplete", reason: "error" };
const PARTIAL = [{ type: "text", text: "Partial" }];
const savedState = (message: Saved) => {
  const runError = message?.metadata?.custom?.runError;
  return { status: message?.status, content: message?.content, continued: message?.metadata?.custom?.continued,
    runError: runError && { errorCode: runError.errorCode, recoverable: runError.recoverable, runId: runError.runId,
      hasMessage: typeof runError.message === "string" && runError.message.length > 0 } };
};
const failedState = (errorCode: string, runId: string, content: unknown[] = PARTIAL) =>
  ({ status: FAILED, content, continued: undefined, runError: { errorCode, recoverable: true, runId, hasMessage: true } });

const question = { id: "user-1", role: "user", content: userTurn[0].content };
const questionRepo = () => ({ messages: [{ message: question, parentId: null }], headId: "user-1" });
const replyOf = (repo: { messages: Array<{ message: Saved }> }) => repo.messages.at(-1)?.message;
// The client saves its own copy of the reply. A client that continued on its own after the live error
// holds a copy with no error.
const clientCopy = (runId: string, turnId: string, reply: string) => ({ id: "client-reply", role: "assistant", status: COMPLETE,
  content: [{ type: "reasoning", text: "Thinking." }, { type: "text", text: reply }], metadata: { runId, custom: { runId, turnId } } });
const clientSave = (repo: unknown, copy: unknown) => threads.mergeThreadDataForClientSave(repo,
  { messages: [{ message: question, parentId: null }, { message: copy, parentId: "user-1" }], headId: "client-reply" });
const foldOnto = (repo: unknown, message: unknown, runId: string, turnId: string) =>
  threads.foldAssistantTurn(repo, message, { runId, turnId, parentId: "user-1" });

test("a partial reply that ends in an exhausted retryable in-stream error saves as failed (#246)", async t => {
  for (const exhausted of exhaustedTurns) {
    const turn = await runTurn([text("Partial"), providerError(exhausted.error)]);
    const error = turn.events.find(event => event.type === "error");
    const saved = savedTurnOf(turn, false);
    await t.test(`${exhausted.name}, with no server continuation`, () => {
      assert.deepEqual({ requests: turn.requests.length, errorCode: error?.errorCode, liveRecoverable: error?.recoverable,
        saved: savedState(saved) },
      { requests: 4, errorCode: exhausted.errorCode, liveRecoverable: undefined, saved: failedState(exhausted.errorCode, turn.runId) });
    });
    await t.test(`${exhausted.name}, after a client save of the same run`, () => {
      const serverRepo = foldOnto(questionRepo(), saved, turn.runId, turn.turnId);
      const reply = replyOf(clientSave(serverRepo, clientCopy(turn.runId, turn.turnId, "Partial")));
      assert.deepEqual({ status: reply?.status, errorCode: reply?.metadata?.custom?.runError?.errorCode },
        { status: FAILED, errorCode: exhausted.errorCode });
    });
    // A server-chained continuation still picks the turn up, as before.
    await t.test(`${exhausted.name}, when the server chains a continuation`, () => {
      assert.deepEqual(savedState(savedTurnOf(turn, true)), { status: COMPLETE, content: PARTIAL, continued: true, runError: undefined });
    });
  }
});

// The server's saved copy of a failed run, as the fix writes it.
const erroredTurn = (runId: string, turnId: string) => ({ id: `server-${runId}`, role: "assistant", createdAt: new Date(0),
  status: FAILED, content: PARTIAL, metadata: { runId, custom: { turnId, foldedRunIds: [runId],
    runError: { message: "Rate limit exceeded", errorCode: "http_429", recoverable: true, runId } } } });
const finishedRun = (runId: string, turnId: string) => threads.buildAssistantMessage([{ seq: 0, event: { type: "text", text: " and the rest." } },
  { seq: 1, event: { type: "done" } }], runId, { suppressInternalContinuation: true, continuationFollows: false, turnId });

test("a saved error survives a client save of its run, and a finished continuation clears it (#246)", async t => {
  const runId = `run-${randomUUID()}`;
  const turnId = `turn-${randomUUID()}`;
  const serverRepo = foldOnto(questionRepo(), erroredTurn(runId, turnId), runId, turnId);
  const state = (reply: Saved) => ({ status: reply?.status, errorCode: reply?.metadata?.custom?.runError?.errorCode });

  await t.test("a heavier client copy of the failed run without the error keeps the error", () => {
    const reply = replyOf(clientSave(serverRepo, clientCopy(runId, turnId, "Partial")));
    assert.deepEqual({ ...state(reply), parts: reply?.content?.length }, { status: FAILED, errorCode: "http_429", parts: 2 });
  });

  await t.test("a client copy of a later run in the same turn does not take the error", () => {
    const laterRunId = `run-${randomUUID()}`;
    assert.deepEqual(state(replyOf(clientSave(serverRepo, clientCopy(laterRunId, turnId, "Partial and the rest.")))),
      { status: COMPLETE, errorCode: undefined });
  });

  await t.test("a later run that finishes the same turn clears the error", () => {
    const laterRunId = `run-${randomUUID()}`;
    const reply = replyOf(foldOnto(serverRepo, finishedRun(laterRunId, turnId), laterRunId, turnId));
    assert.deepEqual({ ...state(reply), content: reply?.content, foldedRunIds: reply?.metadata?.custom?.foldedRunIds },
      { status: COMPLETE, errorCode: undefined, content: [{ type: "text", text: "Partial and the rest." }],
        foldedRunIds: [runId, laterRunId] });
  });

  await t.test("saving the failed run again keeps the error", () => {
    assert.deepEqual(state(replyOf(foldOnto(serverRepo, erroredTurn(runId, turnId), runId, turnId))),
      { status: FAILED, errorCode: "http_429" });
  });
});

const TERMINAL_TYPES = new Set(["done", "error", "missing_api_key", "loop_limit", "auto_continue"]);

test("Stop during the retry wait saves a stopped reply with no error (#246)", async () => {
  // The engine sends `clear` and then waits about two seconds before its first retry.
  const turn = await runTurn([text("Partial"), providerError({ code: 429, message: "Rate limit exceeded" })],
    { stopWhen: events => events.some(event => event.type === "clear") });
  const saved = savedTurnOf(turn, false);
  assert.deepEqual({ requests: turn.requests.length, terminal: turn.events.filter(event => TERMINAL_TYPES.has(String(event.type))),
    userStopped: saved?.metadata?.custom?.userStopped, runError: saved?.metadata?.custom?.runError },
  { requests: 1, terminal: [{ type: "done", reason: "user" }], userStopped: true, runError: undefined });
});

test("a reply that finishes saves as complete with no error (#246)", async () => {
  const turn = await runTurn([text("Whole answer"), finish]);
  assert.deepEqual(savedState(savedTurnOf(turn, false)),
    { status: COMPLETE, content: [{ type: "text", text: "Whole answer" }], continued: undefined, runError: undefined });
});

// Engine retries repeat only the model call. A tool that finished before the failing call runs once,
// and its card stays in the saved turn with the error.
test("a tool step, then an exhausted in-stream 429, keeps the tool's single run and its card (#246)", async () => {
  let runsOfTool = 0;
  const actions = loadActionsFromStaticRegistry({ "probe-count": { default: defineAction({ description: "Count one call.",
    schema: z.object({}), agentTool: true, http: false, readOnly: true, dedupe: false,
    run: async () => { runsOfTool += 1; return "counted"; } }) } });
  const toolStep = [chunkOf({ delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-count", type: "function",
    function: { name: "probe-count", arguments: "{}" } }] } }), chunkOf({ delta: {}, finish_reason: "tool_calls" })];
  const failing = [text("Partial"), providerError({ code: 429, message: "Rate limit exceeded" })];
  const turn = await runTurn(index => index === 0 ? toolStep : failing, { actions });
  const saved = savedTurnOf(turn, false);
  const parts = (saved?.content ?? []).map((part: { type: string; toolName?: string; result?: unknown }) =>
    part.type === "tool-call"
      ? { type: part.type, toolName: part.toolName, counted: JSON.stringify(part.result ?? null).includes("counted") }
      : part);
  assert.deepEqual({ requests: turn.requests.length, runsOfTool, saved: { ...savedState(saved), content: parts } },
    { requests: 5, runsOfTool: 1, saved: failedState("http_429", turn.runId,
      [{ type: "tool-call", toolName: "probe-count", counted: true }, { type: "text", text: "Partial" }]) });
});

// The chat plugin saves a run with whether the server chains its continuation, and Native records that on
// the run before the plugin saves it. Read from the installed, patched source, as
// native-chat-project.test.ts reads the plugin.
test("the chat plugin saves a run with whether a server continuation follows it (#246)", async () => {
  const plugin = await readFile(path.join(coreRoot, "dist", "server", "agent-chat-plugin.js"), "utf8");
  const production = await readFile(path.join(coreRoot, "dist", "agent", "production-agent.js"), "utf8");
  assert.match(plugin, /suppressInternalContinuation: true,\s*(?:\/\/[^\n]*\s*)*continuationFollows: run\.serverContinuationFollows === true,/);
  assert.match(production,
    /run\.serverContinuationFollows =\s*!noProgressRepeat\.tripped && willChainBackgroundContinuation\(run\);\s*(?:\/\/[^\n]*\s*)*await baseHandleRunComplete\?\.\(run\);/);
});

// Issue #246 follow-up. The common rate-limit shape fails before any text streams. The saved turn then holds
// no content, and it must still be saved with its error, so a reload shows the error and a Retry instead of a
// question with no reply. A client save of an empty copy of the same run must keep it, and the next request's
// history leaves the empty reply out.
const clientEmptyCopy = (runId: string, turnId: string) => ({ id: "client-reply", role: "assistant", content: [],
  status: { type: "incomplete", reason: "error" }, metadata: { runId, custom: { runId, turnId } } });

test("an exhausted retryable in-stream error before any text saves an empty failed reply (#246)", async t => {
  for (const exhausted of exhaustedTurns) {
    const turn = await runTurn([providerError(exhausted.error)]);
    const saved = savedTurnOf(turn, false);
    const serverRepo = saved ? foldOnto(questionRepo(), saved, turn.runId, turn.turnId) : questionRepo();
    await t.test(`${exhausted.name}, with no server continuation`, () => {
      assert.deepEqual({ requests: turn.requests.length, saved: savedState(saved) },
        { requests: 4, saved: failedState(exhausted.errorCode, turn.runId, []) });
    });
    await t.test(`${exhausted.name}, after a client save of an empty copy of the same run`, () => {
      const merged = clientSave(serverRepo, clientEmptyCopy(turn.runId, turn.turnId));
      const reply = replyOf(merged);
      assert.deepEqual({
        roles: merged.messages.map((entry: { message: { role: string } }) => entry.message.role),
        status: reply?.status,
        errorCode: reply?.metadata?.custom?.runError?.errorCode,
        recoverable: reply?.metadata?.custom?.runError?.recoverable,
        nextRequestRoles: threads.threadDataToEngineMessages(merged).map((message: { role: string }) => message.role),
      }, { roles: ["user", "assistant"], status: FAILED, errorCode: exhausted.errorCode, recoverable: true, nextRequestRoles: ["user"] });
    });
    await t.test(`${exhausted.name}, then a later run that finishes the same turn`, () => {
      const laterRunId = `run-${randomUUID()}`;
      const folded = foldOnto(serverRepo, finishedRun(laterRunId, turn.turnId), laterRunId, turn.turnId);
      const reply = replyOf(folded);
      assert.deepEqual({
        roles: folded.messages.map((entry: { message: { role: string } }) => entry.message.role),
        status: reply?.status,
        errorCode: reply?.metadata?.custom?.runError?.errorCode,
        content: reply?.content,
        foldedRunIds: reply?.metadata?.custom?.foldedRunIds,
      }, { roles: ["user", "assistant"], status: COMPLETE, errorCode: undefined, content: [{ type: "text", text: " and the rest." }],
        foldedRunIds: [turn.runId, laterRunId] });
    });
    // A server-chained continuation still picks the turn up, as before.
    await t.test(`${exhausted.name}, when the server chains a continuation`, () => {
      assert.equal(savedTurnOf(turn, true), null);
    });
  }
});

test("Stop during the retry wait before any text saves a stopped reply with no error (#246)", async () => {
  const turn = await runTurn([providerError({ code: 429, message: "Rate limit exceeded" })],
    { stopWhen: events => events.some(event => event.type === "clear") });
  const saved = savedTurnOf(turn, false);
  assert.deepEqual({ requests: turn.requests.length, terminal: turn.events.filter(event => TERMINAL_TYPES.has(String(event.type))),
    content: saved?.content, userStopped: saved?.metadata?.custom?.userStopped, runError: saved?.metadata?.custom?.runError },
  { requests: 1, terminal: [{ type: "done", reason: "user" }], content: [], userStopped: true, runError: undefined });
});

test("a clean run with no text saves the same whether or not a continuation follows (#246)", async () => {
  const turn = await runTurn([finish]);
  const shape = (message: Saved) => JSON.stringify(message && { content: message.content, status: message.status, metadata: message.metadata });
  const plain = threads.buildAssistantMessage(turn.entries, turn.runId, { suppressInternalContinuation: true, turnId: turn.turnId });
  assert.deepEqual({ withoutContinuation: shape(savedTurnOf(turn, false)), withContinuation: shape(savedTurnOf(turn, true)) },
    { withoutContinuation: shape(plain), withContinuation: shape(plain) });
});
