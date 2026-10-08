import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The optional path permits a pure source-overlay check before the controller
// refreshes Core. Normal CI always uses the actual installed Native owner.
const source = process.env.VIVARY_TEST_THREAD_DATA_BUILDER
  ? pathToFileURL(process.env.VIVARY_TEST_THREAD_DATA_BUILDER)
  : new URL("../../agent/thread-data-builder.js", import.meta.resolve("@agent-native/core/client/agent-chat"));
const { buildAssistantMessage, foldAssistantTurn, threadDataToEngineMessages } = await import(source);
const turnId = "logical-automation-turn";
const waiting = "Waiting for your approval of the configured action before this automation can continue.";
const finalText = "Completed.";
const freshRead = value => JSON.parse(JSON.stringify(value));
const text = repo => repo.messages.at(-1).message.content.filter(part => part.type === "text").map(part => part.text).join("");
const tools = repo => repo.messages.at(-1).message.content.filter(part => part.type === "tool-call");
const user = () => ({ messages: [{ message: { id: "user", role: "user", content: [{ type: "text", text: "Perform this automation." }] }, parentId: null }], headId: "user" });
const message = (runId, value, id = turnId) => buildAssistantMessage([
  { seq: 0, event: { type: "text", text: value } }, { seq: 1, event: { type: "done" } },
], runId, { turnId: id, suppressInternalContinuation: true });
const save = (repo, incoming, runId, seq, extra = {}) => freshRead(foldAssistantTurn(repo, incoming,
  { runId, turnId, chunkEventSeq: seq, ...extra }));
function waitingRepo(progressive) {
  const incoming = message("waiting-chunk", waiting);
  incoming.content.unshift({ type: "tool-call", toolCallId: "approved-call", toolName: "configured-write", args: { value: 1 },
    argsText: '{"value":1}', approval: { askId: "exact-ask" }, result: "Not executed. Awaiting approval." });
  return freshRead(foldAssistantTurn(user(), incoming, { runId: "waiting-chunk", turnId,
    ...(progressive ? { chunkEventSeq: 3 } : {}) }));
}
const continuationEvents = [
  { seq: 0, event: { type: "tool_start", id: "approved-call", tool: "configured-write", input: { value: 1 } } },
  { seq: 1, event: { type: "tool_done", id: "approved-call", tool: "configured-write", result: "one confirmed effect", completedSideEffect: true } },
  { seq: 2, event: { type: "text", text: finalText } },
  { seq: 3, event: { type: "done" } },
];
const interim = buildAssistantMessage(continuationEvents.slice(0, 2), "approved-chunk", { turnId, suppressInternalContinuation: true });
const terminal = buildAssistantMessage(continuationEvents, "approved-chunk", { turnId, suppressInternalContinuation: true });

for (const progressive of [false, true]) test(`interim tool result then shorter final text survives a fresh fold read (${progressive ? "new" : "legacy"} wait)`, () => {
  assert.ok(waiting.length > finalText.length);
  const afterTool = save(waitingRepo(progressive), interim, "approved-chunk", 1, { resolvedAskId: "exact-ask" });
  assert.match(text(afterTool), /Waiting for your approval/);
  assert.equal(tools(afterTool).length, 1);
  assert.equal(tools(afterTool)[0].result, "one confirmed effect", "intermediate result is already durable");
  const complete = save(afterTool, terminal, "approved-chunk", 3, { resolvedAskId: "exact-ask" });
  assert.equal(text(complete), waiting + finalText);
  assert.equal(complete.messages.filter(item => item.message.role === "assistant").length, 1);
  assert.deepEqual(complete.messages.at(-1).message.metadata.custom.foldedRunIds, ["waiting-chunk", "approved-chunk"]);
  assert.equal(tools(complete).length, 1);
  assert.equal(tools(complete)[0].completedSideEffect, true);
  assert.equal(JSON.stringify(complete).includes('"askId"'), false, "resolved card cannot return from chunk metadata");
  const replay = threadDataToEngineMessages(complete, { includeToolCalls: true });
  assert.equal(replay.flatMap(item => item.content).filter(part => part.type === "tool-result").length, 1);
  assert.deepEqual(save(complete, terminal, "approved-chunk", 3), complete, "equivalent final saves are idempotent");
  assert.deepEqual(save(complete, interim, "approved-chunk", 1), complete, "stale intermediate saves cannot erase text or duplicate cards");
});

test("a later authoritative shorter snapshot replaces its own chunk without deleting prior chunks", () => {
  let repo = save(user(), message("first", "Earlier content. "), "first", 1);
  repo = save(repo, message("second", "A longer answer that must be corrected."), "second", 4);
  repo = save(repo, message("second", "Fixed."), "second", 5);
  assert.equal(text(repo), "Earlier content. Fixed.");
  assert.deepEqual(repo.messages.at(-1).message.metadata.custom.foldedRunIds, ["first", "second"]);
  assert.deepEqual(save(repo, message("second", "Old, longer partial answer."), "second", 4), repo);
});

test("several completed chunks and results stay retained while the latest chunk progresses", () => {
  let repo = save(user(), message("first", "First. "), "first", 2);
  repo = save(repo, message("second", "Second. "), "second", 2);
  repo = save(repo, interim, "approved-chunk", 1);
  repo = save(repo, terminal, "approved-chunk", 3);
  assert.equal(text(repo), "First. Second. " + finalText);
  assert.equal(tools(repo).length, 1);
  const complete = freshRead(repo);
  assert.deepEqual(save(repo, message("first", "Stale first chunk."), "first", 1), complete);
  assert.deepEqual(save(repo, terminal, "approved-chunk", 3), complete);
});

test("a new logical turn never borrows the previous turn's chunk snapshots", () => {
  const repo = save(user(), message("first", "Previous answer."), "first", 2);
  const next = foldAssistantTurn(repo, message("new-run", "New answer.", "new-turn"),
    { runId: "new-run", turnId: "new-turn", chunkEventSeq: 2 });
  assert.equal(text(next), "New answer.");
  assert.deepEqual(next.messages.at(-1).message.metadata.custom.foldedRunIds, ["new-run"]);
});

test("default Native continuation folds retain their existing append and repeat behavior", () => {
  let repo = foldAssistantTurn(user(), message("first", "First. "), { runId: "first", turnId });
  repo = foldAssistantTurn(repo, message("second", "Second."), { runId: "second", turnId });
  assert.equal(text(repo), "First. Second.");
  assert.deepEqual(foldAssistantTurn(repo, message("second", "Second."), { runId: "second", turnId }), repo);
  assert.equal(repo.messages.at(-1).message.metadata.custom.automationChunkSnapshots, undefined);
});
