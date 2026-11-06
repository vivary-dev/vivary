import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

const workbench = fileURLToPath(new URL("../", import.meta.url));
// guard:allow-env-credential - Disposable test dependency path, not credentials.
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, "node_modules/@agent-native/core");
const order = await import(pathToFileURL(path.join(core, "dist/code-agents/transcript-order.js")));
const transcript = await import(pathToFileURL(path.join(core, "dist/code-agents/transcript-normalizer.js")));
const adapterSource = (await readFile(path.join(core, "dist/client/code-agent-chat-adapter.js"), "utf8"))
  .replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const dependencies = { ...order, ...transcript };
const createAdapter = compileFunction(`${adapterSource}\nreturn createCodeAgentChatAdapter;`,
  Object.keys(dependencies))(...Object.values(dependencies));
const pending = { id: "native-run", status: "needs-approval", phase: "action-approval", needsApproval: true };

test("native action approval stays active while legacy launch gates and terminal workers do not", () => {
  assert.equal(order.isCodeAgentRunActive(pending), true);
  for (const phase of [undefined, "approval-required"]) {
    assert.equal(order.isCodeAgentRunActive({ ...pending, phase }), false);
  }
  for (const runnerState of ["exited", "failed", "interrupted", "stopped"]) {
    assert.equal(order.isCodeAgentRunActive({ ...pending, metadata: { runnerState } }), false);
  }
  for (const status of ["completed", "errored", "paused"]) {
    assert.equal(order.isCodeAgentRunActive({ ...pending, status }), false);
  }
});

test("polling remains attached through native approval and receives the eventual final answer", async () => {
  let polls = 0;
  const finalEvent = { id: "final", runId: pending.id, kind: "system", message: "Approved work completed.",
    createdAt: "2026-09-16T00:00:00.000Z", metadata: { role: "assistant", phase: "final_answer" } };
  const adapter = createAdapter({
    controller: {
      get: async () => ++polls <= 3 ? pending : { ...pending, status: "completed", phase: "complete", needsApproval: false },
      transcript: async () => polls >= 4 ? [finalEvent] : [],
    },
    runIdRef: { current: pending.id }, attachOnlyRef: { current: true },
    pollIntervalMs: 1, idlePollIntervalMs: 1, terminalIdlePolls: 2,
  });
  const results = [];
  for await (const result of adapter.run({ messages: [{ role: "user", content: [{ type: "text", text: "Work" }] }],
    abortSignal: new AbortController().signal })) results.push(result);
  assert.ok(polls >= 5, "the adapter must not settle while a native request is pending");
  assert.ok(results.some(result => result.content?.some(part => part.text === finalEvent.message)));
});

test("reopened pending Code runs suppress the missing-final warning while terminal runs retain it", async () => {
  const conversation = await readFile(path.join(workbench, "app/components/workspace/CodeConversation.tsx"), "utf8");
  const externalExpression = conversation.match(/externalStreaming=\{([^}]+)\}/)?.[1];
  assert.ok(externalExpression);
  const externalState = compileFunction(`return ${externalExpression};`, ["props", "isCodeAgentRunActive"]);
  const chat = await readFile(path.join(core, "dist/client/AssistantChat.js"), "utf8");
  const providerExpression = chat.match(/_jsx\(ServerRunActiveContext.Provider, \{ value: ([^,]+),/)?.[1];
  assert.ok(providerExpression);
  const providerState = compileFunction(`return ${providerExpression};`, ["serverRunActive", "externalStreaming"]);
  const renderer = await readFile(path.join(core, "dist/client/chat/message-components.js"), "utf8");
  const warningSource = renderer.slice(renderer.indexOf("export function shouldShowMissingFinalResponse("),
    renderer.indexOf("export const MISSING_FINAL_RESPONSE_SETTLE_MS"));
  const warning = compileFunction(`${warningSource.replace(/^export /, "")}\nreturn shouldShowMissingFinalResponse;`)();
  for (const [run, expected] of [[pending, false], [{ ...pending, status: "completed", phase: "complete", needsApproval: false }, true]]) {
    const externalStreaming = externalState({ run }, order.isCodeAgentRunActive);
    assert.equal(warning({ isCurrentTurnRunning: false, serverRunActive: providerState(false, externalStreaming),
      statusIsTerminal: true, hasAssistantText: false, hasUnresolvedTool: false,
      hasCompletedCustomUi: false, hasActiveTool: false, userStoppedRun: false }), expected);
  }
});
