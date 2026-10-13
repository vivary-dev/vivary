import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Fail closed at the transport seam. No request reaches an actual provider.
const requests = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(new URL(request.url).pathname, "/v1/messages");
  const body = await request.json();
  requests.push(body);
  const usage = { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } };
  const events = [
    { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Offline reply" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream" } });
};
const core = await realpath(new URL("../../node_modules/@agent-native/core", import.meta.url));
const { createAnthropicEngine } = await import(pathToFileURL(path.join(core, "dist/agent/engine/anthropic-engine.js")).href);
const engine = createAnthropicEngine({ apiKey: "synthetic-offline-only", allowEnvFallback: false });
const base = { systemPrompt: "Offline fixture", tools: [], maxOutputTokens: 200_000, temperature: 0,
  reasoningEffort: "medium", abortSignal: new AbortController().signal,
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] };
const collect = async options => { const events = []; for await (const event of engine.stream(options)) events.push(event); return events; };
const current = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"];
for (const model of current) {
  const events = await collect({ ...base, model });
  const request = requests.at(-1);
  assert.equal(request.model, model);
  assert.equal(request.max_tokens, 128_000);
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.deepEqual(request.output_config, { effort: "medium" });
  assert.equal("temperature" in request, false);
  assert.equal("top_k" in request, false);
  assert.equal("tool_choice" in request, false);
  const usage = events.find(event => event.type === "usage");
  assert.equal(usage.inputTokens, 70);
  assert.equal(usage.cacheWrite1hTokens, 6);
  assert.equal(usage.engineName, "anthropic");
  const before = requests.length;
  await assert.rejects(collect({ ...base, model, providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } } }), /requires adaptive/);
  assert.equal(requests.length, before);
}
for (const effort of ["low", "medium", "high"]) {
  await collect({ ...base, model: "claude-haiku-5-5", reasoningEffort: effort,
    providerOptions: { anthropic: { thinking: { type: "disabled" } } } });
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" });
  assert.deepEqual(requests.at(-1).output_config, { effort });
}
await collect({ ...base, model: "claude-sonnet-5-5", reasoningEffort: "high",
  providerOptions: { anthropic: { thinking: { type: "between_tools" } } } });
assert.deepEqual(requests.at(-1).thinking, { type: "between_tools" });
assert.deepEqual(requests.at(-1).output_config, { effort: "high" });
const before = requests.length;
await assert.rejects(collect({ ...base, model: "claude-sonnet-5-5", reasoningEffort: "max",
  providerOptions: { anthropic: { thinking: { type: "between_tools" } } } }), /budget or effort/);
await assert.rejects(collect({ ...base, model: "claude-haiku-5-5", reasoningEffort: "xhigh",
  providerOptions: { anthropic: { thinking: { type: "disabled" } } } }), /budget or effort/);
await assert.rejects(collect({ ...base, model: "claude-opus-5-5",
  providerOptions: { anthropic: { thinking: { type: "disabled" } } } }), /requires adaptive/);
assert.equal(requests.length, before);
await collect({ ...base, model: "claude-sonnet-5-5", messages: [
  ...base.messages, { role: "assistant", content: [{ type: "thinking", text: "", signature: "offline-signature" },
    { type: "text", text: "Prior reply" }] }, { role: "user", content: [{ type: "text", text: "Continue" }] },
] });
assert.deepEqual(requests.at(-1).messages[1].content[0], { type: "thinking", thinking: "", signature: "offline-signature" });
await collect({ ...base, model: "claude-haiku-4-5-20251001",
  providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } } });
assert.equal(requests.at(-1).model, "claude-haiku-4-5-20251001");
assert.equal(requests.at(-1).max_tokens, 64_000);
assert.deepEqual(requests.at(-1).thinking, { type: "enabled", budget_tokens: 8000 });
// The already-pinned optional adapter is hidden in Workbench, but its Core path
// shares this metadata. Exercise its actual transport without enabling a route.
const { createAISDKEngine } = await import(pathToFileURL(path.join(core, "dist/agent/engine/ai-sdk-engine.js")).href);
const adapter = createAISDKEngine("anthropic", { apiKey: "synthetic-offline-only", allowEnvFallback: false });
const collectAdapter = async options => { const events = []; for await (const event of adapter.stream(options)) events.push(event); return events; };
for (const model of current) {
  const count = requests.length;
  const effort = model === "claude-opus-5-5" ? "xhigh" : model === "claude-fable-5-1" ? "max" : "medium";
  const events = await collectAdapter({ ...base, model, reasoningEffort: effort });
  assert.equal(requests.length, count + 1);
  assert.equal(requests.at(-1).model, model);
  assert.equal(requests.at(-1).max_tokens, 128_000);
  assert.deepEqual(requests.at(-1).thinking, { type: "adaptive" });
  assert.deepEqual(requests.at(-1).output_config, { effort });
  assert.equal("temperature" in requests.at(-1), false);
  assert.equal(events.some(event => event.type === "text-delta" && event.text === "Offline reply"), true);
}
await collectAdapter({ ...base, model: "claude-haiku-5-5", reasoningEffort: "high",
  providerOptions: { anthropic: { thinking: { type: "disabled" } } } });
assert.deepEqual(requests.at(-1).thinking, { type: "disabled" });
assert.deepEqual(requests.at(-1).output_config, { effort: "high" });
const count = requests.length;
await assert.rejects(collectAdapter({ ...base, model: "claude-sonnet-5-5",
  providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } } }), /requires adaptive/);
const unsupported = await collectAdapter({ ...base, model: "claude-sonnet-5-5", reasoningEffort: "high",
  providerOptions: { anthropic: { thinking: { type: "between_tools" } } } });
const stopped = unsupported.find(event => event.type === "stop");
assert.equal(stopped?.reason, "error");
assert.match(stopped.error, /thinking|providerOptions|Invalid/);
assert.equal(requests.length, count);

console.log("OFFLINE_ANTHROPIC_REQUESTS_VERIFIED", requests.length);
