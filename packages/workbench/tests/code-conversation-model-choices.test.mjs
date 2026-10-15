import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codeConversationModelChoices } from "../app/lib/code-conversation-model-choices.ts";
import { createLocalCodeChatAdapter } from "../app/lib/local-code-chat-adapter.ts";

// Execute the actual composer selection block to cover both picker options and Send admission.
const source = await readFile(new URL("../app/components/workspace/CodeConversation.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const availableModels = useMemo(");
const end = source.indexOf("  const runtime = selectedEngine?.runtime;", start);
assert.ok(start >= 0 && end > start);
const evaluate = new Function("props", "choice", "useMemo", "codeConversationModelChoices",
  source.slice(start, end) + "\nreturn { availableModels, selectedModelAvailable };\n");
const current = "claude-sonnet-5-5", historical = "claude-sonnet-4-20250514";
const claude = { engine: "claude-cli", models: [current, historical],
  claudeModels: [{ id: current, support: "supported" }], modelCatalog: null };
const codex = { engine: "codex-cli", models: ["gpt-current", "gpt-retired"],
  modelCatalog: { status: "ready", models: [{ id: "gpt-current" }] } };
function selection(engine, model, retained = false, engines = [claude, codex]) {
  const choice = { engine, model };
  const result = evaluate({ state: { engines }, selection: { runId: retained ? "saved" : null } },
    choice, callback => callback(), codeConversationModelChoices);
  assert.deepEqual(choice, { engine, model }, "catalog changes never replace the saved choice");
  return result;
}

test("new Claude choices exclude exact IDs supplied only by a historical conversation", () => {
  const result = selection("claude-cli", historical);
  assert.deepEqual(result.availableModels.find(engine => engine.engine === "claude-cli").models, [current]);
  assert.equal(result.selectedModelAvailable, false);
  assert.equal(selection("claude-cli", current).selectedModelAvailable, true);
});

test("retained Claude exact IDs remain available on their own route", () => {
  const result = selection("claude-cli", historical, true);
  assert.deepEqual(result.availableModels.map(engine => engine.engine), ["claude-cli"]);
  assert.ok(result.availableModels[0].models.includes(historical));
  assert.equal(result.selectedModelAvailable, true);
});

test("supported saved Claude aliases remain admissible without exposing unrelated historical IDs", () => {
  const result = selection("claude-cli", "sonnet");
  assert.deepEqual(result.availableModels[0].models, [current, "sonnet"]);
  assert.equal(result.selectedModelAvailable, true);
});

test("new Codex choices require its current catalog while retained IDs keep their route", () => {
  const result = selection("codex-cli", "gpt-retired");
  assert.deepEqual(result.availableModels.find(engine => engine.engine === "codex-cli").models, ["gpt-current"]);
  assert.equal(result.selectedModelAvailable, false);
  assert.equal(selection("codex-cli", "gpt-retired", true).selectedModelAvailable, true);
  assert.equal(selection("codex-cli", "gpt-current", false, [{ ...codex, modelCatalog: null }]).selectedModelAvailable, false);
});

test("Claude version support still controls Send for new and retained conversations", () => {
  for (const retained of [false, true]) for (const support of ["unverified", "upgrade-required"]) {
    assert.equal(selection("claude-cli", current, retained,
      [{ ...claude, claudeModels: [{ id: current, support }] }]).selectedModelAvailable, false);
  }
});

for (const [model, admitted] of [["sonnet", true], [historical, false]]) {
  test(`composer and actual adapter agree on new Claude model ${model}`, async () => {
    const choice = selection("claude-cli", model);
    assert.equal(choice.selectedModelAvailable, admitted);
    const actions = [], rejected = [];
    const adapter = createLocalCodeChatAdapter({
      context: { engineRef: { current: "claude-cli" }, modelRef: { current: model } },
      call: async (...args) => { actions.push(args); throw new Error("Reached owner fixture"); },
      projectId: "project-one", draftThreadId: "saved-draft", runIdRef: { current: null },
      engines: () => [claude, codex],
      onKnownRejected: async submitId => { rejected.push(submitId); },
      onStarted() {}, onStreaming() {}, onSettled() {},
    });
    await assert.rejects(async () => {
      for await (const _ of adapter.run({
        messages: [{ role: "user", content: [{ type: "text", text: "Read README" }] }],
        runConfig: { custom: { agentNativeQueuedMessageId: "saved-submit" } },
        abortSignal: new AbortController().signal,
      })) {}
    }, admitted ? /Reached owner fixture/ : /available runtime and model/);
    assert.equal(actions.length, admitted ? 1 : 0);
    assert.deepEqual(rejected, admitted ? [] : ["saved-submit"]);
    if (admitted) assert.equal(actions[0][1].model, model);
  });
}
