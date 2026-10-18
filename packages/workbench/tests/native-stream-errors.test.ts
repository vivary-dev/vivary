import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

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
const { createAISDKEngine } = await import("@agent-native/core/agent/engine");
const { loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } = await import("@agent-native/core/server");
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

async function fakeOpenRouter(chunks: Chunk[]) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) response.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
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

// One turn through startRun and the agent loop, as the chat runs it. `thrown` is what the loop threw,
// which the main chat's in-process continuation reads.
async function runTurn(chunks: Chunk[]) {
  const provider = await fakeOpenRouter(chunks);
  const runId = `run-${randomUUID()}`;
  let thrown: unknown;
  try {
    await withoutErrorLog(async () => {
      let finished: Promise<unknown> | undefined;
      runs.startRun(runId, `thread-${randomUUID()}`, async (send: (event: Record<string, unknown>) => void, signal: AbortSignal) => {
        try {
          await runWithRequestContext({ userEmail: "owner@example.test", orgId: "org-a", run: {} }, () => runAgentLoop({
            engine: provider.engine, model: "probe/model", systemPrompt: "", tools: [], actions: loadActionsFromStaticRegistry({}),
            messages: userTurn, signal, send }));
        } catch (error) {
          thrown = error;
          throw error;
        }
      }, async () => undefined, { waitUntil: (promise: Promise<unknown>) => { finished = promise; } });
      await finished?.catch(() => undefined);
    });
    const entries = runs.getRun(runId).events as Array<{ event: Record<string, unknown> }>;
    return { runId, entries, events: entries.map(entry => entry.event), thrown, requests: provider.requests };
  } finally {
    await provider.close();
  }
}

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
      assert.deepEqual({
        errorCode: error?.errorCode,
        requests: requests.length,
        savedErrorCode: saved?.metadata?.custom?.runError?.errorCode,
        continuesInBackground: agent.isRecoverableContinuationError(error),
        resumesInProcess: agent.isResumableEngineError(thrown),
      }, {
        errorCode: "provider_stream_error",
        requests: 1,
        savedErrorCode: "provider_stream_error",
        continuesInBackground: false,
        resumesInProcess: false,
      });
    });
  }
});
