import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Some providers reached through OpenRouter keep only the first nine characters of a tool-call id.
// The maintained Core patch makes replayed ids nine alphanumeric characters. Core's package entries
// do not export replayToolCallId or assistantUiMessagesToStructuredHistory, so load the installed,
// patched module by path.
const clientDir = path.dirname(fileURLToPath(import.meta.resolve("@agent-native/core/client")));
const { assistantUiMessagesToStructuredHistory, replayToolCallId } =
  await import(pathToFileURL(path.join(clientDir, "agent-chat-adapter.js")).href);
const { buildAssistantMessage, foldAssistantTurn, threadDataToEngineMessages } =
  await import(pathToFileURL(path.join(clientDir, "..", "agent", "thread-data-builder.js")).href);

const idsIn = (value, found = []) => {
  if (Array.isArray(value)) value.forEach(item => idsIn(item, found));
  else if (value && typeof value === "object") {
    if (typeof value.toolCallId === "string") found.push({ type: value.type, id: value.toolCallId });
    Object.values(value).forEach(item => idsIn(item, found));
  }
  return found;
};

test("replay ids are nine alphanumeric characters with a history or continuation prefix", () => {
  assert.equal(replayToolCallId("h", 1), "h00000001");
  assert.equal(replayToolCallId("c", 36), "c00000010");
  for (const id of [replayToolCallId("h", 1), replayToolCallId("c", 2 ** 31)]) assert.match(id, /^[a-z0-9]{9}$/);
});

test("a turn with several tool calls replays ids that stay distinct in their first nine characters", () => {
  const calls = [1, 2, 3, 4, 5].map(n => ({ type: "tool-call", toolCallId: `provider-${n}`, toolName: "vivary-project-read",
    args: { report: "find" }, argsText: "{\"report\":\"find\"}", result: `{"matches":${n}}` }));
  const history = assistantUiMessagesToStructuredHistory([
    { role: "user", content: [{ type: "text", text: "Search this project for relay." }] },
    { role: "assistant", content: [{ type: "text", text: "Searching." }, ...calls, { type: "text", text: "The gamma relay." }] },
    { role: "user", content: [{ type: "text", text: "Remind me which relay." }] },
  ]);
  const ids = idsIn(history);
  const callIds = ids.filter(entry => entry.type === "tool-call").map(entry => entry.id);
  const resultIds = ids.filter(entry => entry.type === "tool-result").map(entry => entry.id);
  assert.equal(callIds.length, 5, "every tool call is replayed");
  for (const id of callIds) assert.match(id, /^[a-z0-9]{9}$/);
  assert.equal(new Set(callIds.map(id => id.slice(0, 9))).size, callIds.length, "ids differ within their first nine characters");
  assert.deepEqual([...resultIds].sort(), [...callIds].sort(), "each result pairs with its call");
});

// Issue #107. A server-side resume, the chained background continuation or a sub-agent's continue mode, replays
// stored tool calls from thread data. A call saved without a provider id is stored as `${runId}:tc_<n>`, and run
// ids created within about a day share their first nine characters.
const toolTurn = (runId, turnId, calls) => buildAssistantMessage([
  ...calls.flatMap(({ id, n }, index) => [
    { seq: index * 2, event: { type: "tool_start", tool: "vivary-project-read", input: { report: "find", n }, ...(id && { id }) } },
    { seq: index * 2 + 1, event: { type: "tool_done", tool: "vivary-project-read", result: `{"matches":${n}}`, ...(id && { id }) } },
  ]),
  { seq: calls.length * 2, event: { type: "text", text: "Found them." } },
  { seq: calls.length * 2 + 1, event: { type: "done" } },
], runId, { turnId });

const askedAfter = (repo, id, text) => {
  const parentId = repo.messages.at(-1).message.id;
  return { messages: [...repo.messages, { message: { id, role: "user", content: [{ type: "text", text }] }, parentId }], headId: id };
};

const replayedToolIds = repo => {
  const parts = threadDataToEngineMessages(repo, { includeToolCalls: true }).flatMap(message => message.content);
  return {
    calls: parts.filter(part => part.type === "tool-call").map(part => part.id),
    results: parts.filter(part => part.type === "tool-result").map(part => part.toolCallId),
  };
};

test("a server replay gives every stored tool call a distinct nine-character id and leaves thread data alone", () => {
  const first = "run-1790553600000-aaaaaa", second = "run-1790553600001-bbbbbb";
  let repo = { messages: [{ message: { id: "user-1", role: "user", content: [{ type: "text", text: "Find the relays." }] },
    parentId: null }], headId: "user-1" };
  repo = foldAssistantTurn(repo, toolTurn("run-1790553500000-cccccc", "turn-1",
    [{ id: "toolu_01AAAA", n: 1 }, { id: "toolu_01AAAB", n: 2 }]), { runId: "run-1790553500000-cccccc", turnId: "turn-1", parentId: "user-1" });
  repo = askedAfter(repo, "user-2", "Find the rest.");
  // Two chunks of one turn fold into one saved message, and each chunk counts its calls from 1.
  for (const runId of [first, second]) {
    repo = foldAssistantTurn(repo, toolTurn(runId, "turn-2", [{ n: 3 }, { n: 4 }, { n: 5 }]), { runId, turnId: "turn-2", parentId: "user-2" });
  }
  const stored = repo.messages.at(-1).message.content.filter(part => part.type === "tool-call").map(part => part.toolCallId);
  assert.deepEqual(stored, [1, 2, 3].map(n => `${first}:tc_${n}`).concat([1, 2, 3].map(n => `${second}:tc_${n}`)));
  const saved = structuredClone(repo);

  const { calls, results } = replayedToolIds(repo);
  assert.equal(calls.length, 8, "every stored tool call is replayed");
  assert.equal(new Set(calls.map(id => id.slice(0, 9))).size, calls.length, "ids differ within their first nine characters");
  for (const id of calls) assert.match(id, /^r[0-9a-z]{8}$/);
  assert.deepEqual(results, calls, "each result carries its call's id");
  assert.deepEqual(repo, saved, "stored thread data keeps its ids");
});

test("two turns that stored the same tool-call id replay with different ids", () => {
  let repo = { messages: [{ message: { id: "user-1", role: "user", content: [{ type: "text", text: "Find a relay." }] },
    parentId: null }], headId: "user-1" };
  repo = foldAssistantTurn(repo, toolTurn(undefined, "turn-1", [{ n: 1 }]), { turnId: "turn-1", parentId: "user-1" });
  repo = askedAfter(repo, "user-2", "Find another.");
  repo = foldAssistantTurn(repo, toolTurn(undefined, "turn-2", [{ n: 2 }]), { turnId: "turn-2", parentId: "user-2" });
  const stored = repo.messages.filter(entry => entry.message.role === "assistant")
    .flatMap(entry => entry.message.content.filter(part => part.type === "tool-call").map(part => part.toolCallId));
  assert.deepEqual(stored, ["tc_1", "tc_1"]);

  const { calls, results } = replayedToolIds(repo);
  assert.equal(new Set(calls).size, 2, "each replayed call has its own id");
  assert.deepEqual(results, calls, "each result carries its call's id");
});
