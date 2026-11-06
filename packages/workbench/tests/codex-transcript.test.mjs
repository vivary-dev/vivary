import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

const workbench = fileURLToPath(new URL("../", import.meta.url));
// guard:allow-env-credential - Disposable test paths and fixture behavior, not credentials.
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, "node_modules/@agent-native/core");
const { normalizeCodeAgentTranscript, isCredentialGapCodeAgentEvent } = await import(
  pathToFileURL(path.join(core, "dist/code-agents/transcript-normalizer.js")));
async function loadFunctions(file, names, dependencies) {
  const source = (await readFile(path.join(core, file), "utf8"))
    .replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
  return compileFunction(`${source}\nreturn {${names.join(",")}};`, Object.keys(dependencies), {
    filename: path.join(core, file),
  })(...Object.values(dependencies));
}
const dependencies = { normalizeCodeAgentTranscript, isCredentialGapCodeAgentEvent };
const { codeAgentTranscriptEventsToContent } = await loadFunctions("dist/client/code-agent-chat-adapter.js",
  ["codeAgentTranscriptEventsToContent"], dependencies);
const { buildRepositoryFromCodeAgentTranscript } = await loadFunctions("dist/agent/thread-data-builder.js",
  ["buildRepositoryFromCodeAgentTranscript"], dependencies);
const require = createRequire(path.join(workbench, "package.json"));
const { jsx, jsxs } = require("react/jsx-runtime");
const { renderToStaticMarkup } = require("react-dom/server");
const renderer = await readFile(path.join(core, "dist/client/chat/message-components.js"), "utf8");
const cardSource = renderer.slice(renderer.indexOf("export function CodeAgentActivityCard("),
  renderer.indexOf("export function AssistantMessage(")).replace(/^export /, "");
assert.ok(cardSource.startsWith("function CodeAgentActivityCard("));
const Card = compileFunction(`${cardSource}\nreturn CodeAgentActivityCard;`, ["_jsx", "_jsxs", "codeActivityOpen"])(jsx, jsxs, new Set());
let sequence = 0;
function event(message, metadata, kind = "system") {
  const id = `event-${++sequence}`;
  return { schemaVersion: 1, id, runId: "run-main", kind, message,
    createdAt: "2026-09-16T00:00:00.000Z", metadata: { source: "codex-app-server", ...metadata } };
}
const assistant = (text, itemId, phase) => event(text, { role: "assistant", itemId, phase });
function restoredContent(events) {
  return buildRepositoryFromCodeAgentTranscript(events).messages
    .filter(entry => entry.message.role === "assistant").flatMap(entry => entry.message.content);
}

test("commentary is progress, final and unknown phases remain normal answers, live and reopened match", () => {
  const events = [event("Work", {}, "user"), assistant("Inspecting the file.", "a", "commentary"),
    assistant("Verifying the edit.", "b", "commentary"), assistant("The file is updated.", "c", "final_answer")];
  const content = codeAgentTranscriptEventsToContent(events);
  assert.deepEqual(content.map(part => part.type), ["data", "data", "text"]);
  assert.deepEqual(content.filter(part => part.type === "data").map(part => part.data.kind), ["progress", "progress"]);
  assert.deepEqual(restoredContent(events), content);
  assert.deepEqual(codeAgentTranscriptEventsToContent([assistant("Legacy answer", "old", undefined)]),
    [{ type: "text", text: "Legacy answer" }]);
  assert.equal(content.some(part => part.data?.kind === "subagent"), false);
});

test("actual collab events update one card by native identity without losing other agents", () => {
  const metadata = { type: "subagent", itemId: "collab-1", senderThreadId: "main-thread",
    receiverThreadIds: ["child-a", "child-b"], tool: "spawnAgent", status: "inProgress",
    agentsStates: { "child-a": { status: "running" }, "child-b": { status: "running" } } };
  const events = [event("Delegating checks", metadata, "status"),
    assistant("I am checking the result.", "comment", "commentary"),
    event("Checks finished", { ...metadata, status: "completed", agentsStates: {
      "child-a": { status: "completed", message: "Read succeeded" }, "child-b": { status: "errored", message: "Missing fixture" },
    } }, "status")];
  const normalized = normalizeCodeAgentTranscript(events);
  assert.equal(normalized.items.filter(item => item.type === "activity" && item.activity.kind === "subagent").length, 1);
  const content = codeAgentTranscriptEventsToContent(events);
  const activity = content[0].data;
  assert.equal(activity.senderThreadId, "main-thread");
  assert.deepEqual(activity.agents.map(agent => [agent.id, agent.status]), [["child-a", "completed"], ["child-b", "errored"]]);
  assert.deepEqual(restoredContent(events), content);
});

test("reused native IDs in separate turns do not overwrite earlier activity", () => {
  const events = [event("First", {}, "user"), assistant("First progress", "same", "commentary"),
    event("Second", {}, "user"), assistant("Second progress", "same", "commentary")];
  const content = codeAgentTranscriptEventsToContent(events);
  assert.deepEqual(content.map(part => part.data.text), ["First progress", "Second progress"]);
});

test("native activity display is bounded, expandable, and escapes text", () => {
  const events = [assistant("<script>bad()</script> " + "x".repeat(20000), "long", "commentary")];
  const part = codeAgentTranscriptEventsToContent(events)[0];
  assert.ok(part.data.text.length < 12100);
  assert.match(part.data.text, /Display truncated/);
  const html = renderToStaticMarkup(jsx(Card, { part }));
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  assert.match(html, /aria-label="Progress"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /data-code-activity="progress"/);
  assert.match(html, /max-height:16rem/);
  assert.equal(html.toLowerCase().includes("<script"), false);
  assert.equal(Card({ part: { type: "data", name: "unrelated", data: {} } }), null);
});

test("subagent card identifies actual native agent and its status", () => {
  const part = codeAgentTranscriptEventsToContent([event("Check complete", { type: "subagent", itemId: "collab",
    senderThreadId: "main", receiverThreadIds: ["real-child"], tool: "wait", status: "completed",
    agentsStates: { "real-child": { status: "completed", message: "No failure" } } }, "status")])[0];
  const html = renderToStaticMarkup(jsx(Card, { part }));
  assert.match(html, /data-code-activity="subagent"/);
  assert.match(html, /real-child/);
  assert.match(html, /Completed/);
  assert.match(html, /Checked subagent status/);
  assert.match(renderer, /case "data":[\s\S]*?CodeAgentActivityCard/);
});


test("subagent operation labels use plain language and preserve unknown details", () => {
  const make = tool => ({ type: "data", name: "code-agent-activity", data: { kind: "subagent", itemId: "native",
    tool, status: "completed", text: `Codex agent operation: ${tool}.`, agents: [] } });
  const html = renderToStaticMarkup(jsx(Card, { part: make("spawnAgent") }));
  assert.match(html, /Started subagent/);
  assert.doesNotMatch(html, /spawnAgent|Codex agent operation/);
  const unknown = renderToStaticMarkup(jsx(Card, { part: make("futureOperation") }));
  assert.match(unknown, /Subagent activity/);
  assert.match(unknown, /Operation:.*futureOperation/);
});


test("native v2 subagent start and completion merge by child identity within the parent turn", () => {
  const metadata = { type: "subagent", activityType: "subAgentActivity", agentThreadId: "native-child-42",
    agentPath: "/root/file_reviewer", senderThreadId: "main-thread" };
  const started = event("Subagent started.", { ...metadata, itemId: "start-item", activityKind: "started", status: "running" }, "status");
  const completed = event("Subagent completed.", { ...metadata, itemId: "completion-item", activityKind: "completed", status: "completed",
    agentsStates: { "native-child-42": { status: "completed", message: "Public result: fixture file verified." } } }, "status");
  const events = [event("First turn", {}, "user"), started, completed];
  const content = codeAgentTranscriptEventsToContent(events);
  assert.equal(content.length, 1);
  assert.equal(content[0].data.agentThreadId, "native-child-42");
  assert.equal(content[0].data.status, "completed");
  assert.equal(content[0].data.agents[0].text, "Public result: fixture file verified.");
  assert.deepEqual(restoredContent(events), content);
  const html = renderToStaticMarkup(jsx(Card, { part: content[0] }));
  assert.match(html, /Subagent · file reviewer/);
  assert.match(html, /Completed/);
  assert.match(html, /Public result: fixture file verified/);
  const nextTurn = [...events, event("Next turn", {}, "user"), { ...started, id: "restart-event" }];
  assert.equal(codeAgentTranscriptEventsToContent(nextTurn).length, 2);
  const replayed = [...events, event("Subagent completed.", { ...metadata, itemId: "completion-replay", activityKind: "completed", status: "completed" }, "status")];
  assert.equal(codeAgentTranscriptEventsToContent(replayed)[0].data.agents[0].text, "Public result: fixture file verified.");
});

test("unidentified wait and early spawn do not invent a subagent card", () => {
  for (const tool of ["wait", "spawnAgent"]) {
    const events = [event("Codex agent operation: " + tool + ".", { type: "subagent", itemId: "empty-" + tool,
      senderThreadId: "main-thread", receiverThreadIds: [], agentsStates: {}, tool, status: "completed" }, "status")];
    assert.deepEqual(codeAgentTranscriptEventsToContent(events), []);
    assert.deepEqual(restoredContent(events), []);
  }
});


test("an opened activity stays open across live-to-history remount and remains run-scoped", () => {
  const part = { type: "data", name: "code-agent-activity", data: { kind: "progress", itemId: "stable-item", text: "Working" } };
  const initial = Card({ part, scopeKey: "run-live" });
  assert.equal(initial.props.open, false);
  initial.props.onToggle({ currentTarget: { open: true } });
  const remounted = Card({ part: { ...part, data: { ...part.data, text: "Completed" } }, scopeKey: "run-live" });
  assert.equal(remounted.props.open, true);
  assert.match(renderToStaticMarkup(remounted), /<details open=""/);
  assert.equal(Card({ part, scopeKey: "different-run" }).props.open, false);
  remounted.props.onToggle({ currentTarget: { open: false } });
  assert.equal(Card({ part, scopeKey: "run-live" }).props.open, false);
  assert.match(renderer, /CodeAgentActivityCard, \{ part, scopeKey: messageRunId \}/);
});

test("native subagent boilerplate is omitted while public result stays visible", () => {
  const part = { type: "data", name: "code-agent-activity", data: { kind: "subagent", itemId: "child", activityType: "subAgentActivity",
    agentPath: "/root/integration_check", status: "completed", tool: "", text: "Codex subagent /root/integration_check: completed.",
    agents: [{ id: "real-child", status: "completed", text: "The public result." }] } };
  const html = renderToStaticMarkup(jsx(Card, { part }));
  assert.match(html, /Subagent · integration check/);
  assert.match(html, /The public result/);
  assert.doesNotMatch(html, /Codex subagent/);
});


test("overlapping same-name native tools retain each call's input and result live and restored", () => {
  const tool = (type, toolCallId, value) => event(type, { type, tool: "js", toolCallId,
    ...(type === "tool_start" ? { input: { code: value } } : { result: value }) }, "status");
  const events = [event("Run both", {}, "user"), tool("tool_start", "call-a", "first"),
    tool("tool_start", "call-b", "second"), tool("tool_done", "call-a", "4"),
    tool("tool_done", "call-b", "8")];
  const tools = normalizeCodeAgentTranscript(events).items.filter(item => item.type === "tool");
  assert.deepEqual(tools.map(item => [item.input, item.result, item.state]), [
    [{ code: "first" }, "4", "completed"], [{ code: "second" }, "8", "completed"],
  ]);
  const content = codeAgentTranscriptEventsToContent(events);
  assert.deepEqual(content.map(part => [part.args, part.result]), [
    [{ code: "first" }, "4"], [{ code: "second" }, "8"],
  ]);
  assert.deepEqual(restoredContent(events), content);
});

test("native tool identity stays turn-scoped and missing historical IDs still pair", () => {
  const tool = (type, toolCallId, extra = {}) => event(type, { type, tool: "js", toolCallId, ...extra }, "status");
  const events = [event("First", {}, "user"), tool("tool_start", "reused", { input: { code: "old" } }),
    event("Second", {}, "user"), tool("tool_done", "reused", { result: "new" })];
  const tools = normalizeCodeAgentTranscript(events).items.filter(item => item.type === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].result, undefined);
  assert.equal(tools[1].result, "new");
  for (const [startId, doneId] of [[undefined, undefined], [undefined, "native"], ["native", undefined]]) {
    const legacy = normalizeCodeAgentTranscript([tool("tool_start", startId, { input: { code: "legacy" } }),
      tool("tool_done", doneId, { result: "4" })]).items.filter(item => item.type === "tool");
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].result, "4");
  }
});
