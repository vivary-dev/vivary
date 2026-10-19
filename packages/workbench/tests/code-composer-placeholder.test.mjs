import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Execute the actual JSX prop expression. No model, server or browser is needed.
const source = await readFile(new URL("../app/components/workspace/CodeConversation.tsx", import.meta.url), "utf8");
const expression = source.match(/composerDisabledPlaceholder=\{([^\n]+)\}/)?.[1];
assert.ok(expression, "the Code composer exposes its disabled reason");
const evaluate = new Function("props", "runtimeReady", "selectedModelAvailable", "selectedClaudeModel", "otherModelAvailable",
  "sharedFolderHeld", `return (${expression});`);
const props = { viewingMatch: false, state: {}, selection: {}, workspaceAvailable: true, pendingApprovals: 0 };

test("review regression: unavailable models explain the refusal without claiming an active run", () => {
  for (const [model, expected] of [
    [undefined, /selected model is unavailable.*Choose another model/i],
    [{ support: "upgrade-required", minimumVersion: "2.1.296" }, /Update Claude Code.*2\.1\.296.*choose another model/i],
    [{ support: "unverified", minimumVersion: "2.1.296" }, /Verify.*version.*choose another model/i],
  ]) {
    const message = evaluate(props, true, false, model, true);
    assert.match(message, expected);
    assert.doesNotMatch(message, /agent is working|Stop it/i);
  }
});

test("review regression: without another usable model the refusal does not offer one", () => {
  for (const [model, expected] of [
    [undefined, /selected model is unavailable.*Check Runtime settings/i],
    [{ support: "upgrade-required", minimumVersion: "2.1.296" }, /Update Claude Code.*2\.1\.296/i],
    [{ support: "unverified", minimumVersion: "2.1.296" }, /Verify.*version/i],
  ]) {
    const message = evaluate(props, true, false, model, false);
    assert.match(message, expected);
    assert.doesNotMatch(message, /another model/i);
  }
});

test("existing disabled reasons retain priority over unavailable models", () => {
  assert.match(evaluate({ ...props, viewingMatch: true }, true, false), /Reading saved history/);
  assert.equal(evaluate({ ...props, state: { cleanup: { composer: "Clean up first" } } }, true, false), "Clean up first");
  assert.match(evaluate({ ...props, selection: { runId: "saved" } }, true, false), /Opening conversation/);
  assert.match(evaluate({ ...props, workspaceAvailable: false }, true, false), /folder is unavailable/);
  assert.match(evaluate({ ...props, pendingApprovals: 1 }, true, false), /Review the pending request/);
  assert.match(evaluate({ ...props, pendingApprovals: 1 }, true, true, undefined, false, true), /Review the pending request/);
  assert.equal(evaluate(props, true, true, undefined, false, true),
    "Other agents are working in this folder. Choose Proceed or use another folder before sending.");
  assert.match(evaluate(props, false, false), /Connect a runtime/);
  assert.match(evaluate(props, true, true), /agent is working/);
});
