import assert from "node:assert/strict";
import test from "node:test";
import { createLocalCodeChatAdapter } from "../app/lib/local-code-chat-adapter.ts";

function adapterForTest(rejections, actions, engine = "codex-cli", actionError = new Error("No owner action expected")) {
  return createLocalCodeChatAdapter({
    context: { engineRef: { current: engine }, modelRef: { current: "fixture-model" } },
    call: async (...args) => { actions.push(args); throw actionError; },
    projectId: "project-one",
    draftThreadId: "original-draft-id",
    runIdRef: { current: null },
    engines: () => [{ engine: "codex-cli", models: ["fixture-model"],
      modelCatalog: { status: "ready", models: [{ id: "fixture-model" }] } }],
    onKnownRejected: async submitId => { rejections.push(submitId); },
    onStarted: () => {},
    onStreaming: () => {},
    onSettled: () => {},
  });
}

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
  assert.deepEqual(rejections, []);
});


test("an explicit pre-append owner rejection restores the same Code draft", async () => {
  // Issue #121. Leftover coding processes refuse a send before it is appended, so the draft comes back too.
  for (const [status, errorCode] of [[503, "vivary_code_runtime_unavailable"], [409, "vivary_code_cleanup_required"]]) {
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
    onKnownRejected: async () => {}, onStarted: () => controller.abort(), onStreaming: () => {}, onSettled: () => {},
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
