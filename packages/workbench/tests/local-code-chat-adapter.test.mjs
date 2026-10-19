import assert from "node:assert/strict";
import test from "node:test";
import { createLocalCodeChatAdapter } from "../app/lib/local-code-chat-adapter.ts";

function adapterForTest(rejections, actions, engine = "codex-cli", actionError = new Error("No owner action expected"),
  acknowledged = false) {
  return createLocalCodeChatAdapter({
    context: { engineRef: { current: engine }, modelRef: { current: "fixture-model" } },
    call: async (...args) => { actions.push(args); throw actionError; },
    projectId: "project-one",
    draftThreadId: "original-draft-id",
    runIdRef: { current: null },
    engines: () => [{ engine: "codex-cli", models: ["fixture-model"],
      modelCatalog: { status: "ready", models: [{ id: "fixture-model" }] } }],
    onKnownRejected: async submitId => { rejections.push(submitId); },
    acknowledgeSharedFolder: () => acknowledged,
    onStarted: () => {},
    onStreaming: () => {},
    onSettled: () => {},
  });
}

test("a shared-folder refusal restores the draft and asks the warning again", async () => {
  const rejections = [], actions = [];
  let refused = 0;
  const refusal = Object.assign(new Error("Other agents are working in this folder."),
    { errorCode: "vivary_code_shared_folder_active", statusCode: 409 });
  const adapter = createLocalCodeChatAdapter({
    context: { engineRef: { current: "codex-cli" }, modelRef: { current: "fixture-model" } },
    call: async (...args) => { actions.push(args); throw refusal; },
    projectId: "project-one", draftThreadId: "original-draft-id", runIdRef: { current: null },
    engines: () => [{ engine: "codex-cli", models: ["fixture-model"],
      modelCatalog: { status: "ready", models: [{ id: "fixture-model" }] } }],
    onKnownRejected: async submitId => { rejections.push(submitId); },
    acknowledgeSharedFolder: () => false, onSharedFolderRefused: () => { refused += 1; },
    onStarted: () => {}, onStreaming: () => {}, onSettled: () => {},
  });
  await assert.rejects(async () => {
    for await (const _ of adapter.run({ messages: [{ role: "user", content: [{ type: "text", text: "Edit the parser" }] }],
      runConfig: { custom: { agentNativeQueuedMessageId: "submit-shared" } }, abortSignal: new AbortController().signal })) {}
  }, /Other agents are working in this folder/);
  assert.equal(actions.length, 1);
  assert.equal(actions[0][1].acknowledgeSharedFolder, false);
  assert.deepEqual(rejections, ["submit-shared"], "the draft is restored");
  assert.equal(refused, 1, "the warning asks again");
});

test("Code local validation restores a known rejected draft before any owner action", async () => {
  const rejections = [], actions = [];
  const adapter = adapterForTest(rejections, actions);
  const input = {
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(8_001) }] }],
    runConfig: { custom: { agentNativeQueuedMessageId: "submit-one" } },
    abortSignal: new AbortController().signal,
  };
  await assert.rejects(async () => {
    for await (const _ of adapter.run(input)) {}
  }, /under 8,000 characters/);
  assert.deepEqual(rejections, ["submit-one"]);
  assert.deepEqual(actions, []);
});

test("Code unavailable runtime rejection retains the original submit identity", async () => {
  const rejections = [], actions = [];
  const adapter = adapterForTest(rejections, actions, "missing-runtime");
  await assert.rejects(async () => {
    for await (const _ of adapter.run({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      runConfig: { custom: { agentNativeQueuedMessageId: "submit-two" } },
      abortSignal: new AbortController().signal,
    })) {}
  }, /available runtime/);
  assert.deepEqual(rejections, ["submit-two"]);
  assert.deepEqual(actions, []);
});

test("an uncertain Code owner failure keeps its pending submission for reconciliation", async () => {
  const rejections = [], actions = [];
  const adapter = adapterForTest(rejections, actions);
  await assert.rejects(async () => {
    for await (const _ of adapter.run({
      messages: [{ role: "user", content: [{ type: "text", text: "send to owner" }] }],
      runConfig: { custom: { agentNativeQueuedMessageId: "submit-uncertain" } },
      abortSignal: new AbortController().signal,
    })) {}
  }, /No owner action expected/);
  assert.equal(actions.length, 1);
  assert.equal(actions[0][0], "vivary-code-send");
  assert.equal(actions[0][1].acknowledgeSharedFolder, false);
  assert.deepEqual(rejections, []);
});

test("a send carries the owner's Proceed on the shared-folder warning", async () => {
  const actions = [];
  const adapter = adapterForTest([], actions, "codex-cli", new Error("No owner action expected"), true);
  await assert.rejects(async () => {
    for await (const _ of adapter.run({ messages: [{ role: "user", content: [{ type: "text", text: "work here" }] }],
      abortSignal: new AbortController().signal })) {}
  }, /No owner action expected/);
  assert.equal(actions[0][1].acknowledgeSharedFolder, true);
});


test("an explicit pre-append owner rejection restores the same Code draft", async () => {
  // Issue #121. Leftover coding processes refuse a send before it is appended, so the draft comes back too.
  // A busy conversation and an unacknowledged shared folder refuse before the append as well.
  for (const [status, errorCode] of [[503, "vivary_code_runtime_unavailable"], [409, "vivary_code_cleanup_required"],
    [409, "vivary_code_conversation_active"], [409, "vivary_code_shared_folder_active"]]) {
    const rejections = [], actions = [];
    const error = Object.assign(new Error(`Refused with ${errorCode}`), { status, errorCode });
    const adapter = adapterForTest(rejections, actions, "codex-cli", error);
    await assert.rejects(async () => {
      for await (const _ of adapter.run({
        messages: [{ role: "user", content: [{ type: "text", text: "try runtime" }] }],
        runConfig: { custom: { agentNativeQueuedMessageId: "submit-rejected" } },
        abortSignal: new AbortController().signal,
      })) {}
    }, new RegExp(`Refused with ${errorCode}`));
    assert.deepEqual(rejections, ["submit-rejected"], errorCode);
    assert.equal(actions.length, 1);
  }
});

test("accepted owner sends refresh linked history while refused sends emit no accepted lifecycle update", async t => {
  const previousWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: event => { events.push(event.type); return true; } };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const controller = new AbortController(), runIdRef = { current: null };
  const adapter = createLocalCodeChatAdapter({
    context: { engineRef: { current: "codex-cli" }, modelRef: { current: "fixture-model" } },
    call: async name => {
      assert.equal(name, "vivary-code-send");
      return { projectId: "project-one", run: { id: "accepted-target", engine: "codex-cli", status: "completed", events: [] }, error: null };
    },
    projectId: "project-one", draftThreadId: "retained-draft", runIdRef,
    engines: () => [{ engine: "codex-cli", models: ["fixture-model"],
      modelCatalog: { status: "ready", models: [{ id: "fixture-model" }] } }],
    onKnownRejected: async () => {}, acknowledgeSharedFolder: () => false,
    onStarted: () => controller.abort(), onStreaming: () => {}, onSettled: () => {},
  });
  for await (const _ of adapter.run({ messages: [{ role: "user", content: [{ type: "text", text: "Explicit send" }] }],
    abortSignal: controller.signal })) {}
  assert.deepEqual(events, ["agent-chat:threads-updated"]);
  assert.equal(runIdRef.current, "accepted-target");
  const refused = adapterForTest([], [], "codex-cli", Object.assign(new Error("Final owner refusal"), { errorCode: "vivary_code_project_changed" }));
  await assert.rejects(async () => { for await (const _ of refused.run({
    messages: [{ role: "user", content: [{ type: "text", text: "Refused send" }] }], abortSignal: new AbortController().signal,
  })) {} }, /Final owner refusal/);
  // A refusal after linked preparation refreshes only the linked-history notice. No accepted lifecycle update is sent.
  assert.deepEqual(events, ["agent-chat:threads-updated", "vivary:linked-history-updated"]);
});
