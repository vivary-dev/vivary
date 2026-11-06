import assert from "node:assert/strict";
import test from "node:test";
import { conversationSurfaceStateKey, requestedConversationSurface, restoredConversationSurface, savedNativeHistoryKind } from "../app/lib/conversation-surface.ts";
import { codeDraftSelectionKey, codeDraftThreadId } from "../shared/code-draft.ts";

test("bare root restores the last Native or Code surface while explicit routes win", () => {
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams()), "native"), "native");
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams()), "code"), "code");
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams("runtime=code")), "native"), "code");
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams("run=new")), "native"), "code");
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams("runtime=native")), "code"), "native");
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams()), null), null);
});


test("a saved unassigned Native scope survives a bare-root reopen", () => {
  assert.equal(savedNativeHistoryKind("unassigned"), "unassigned");
  assert.equal(savedNativeHistoryKind("project"), "project");
  assert.equal(savedNativeHistoryKind(undefined), "project");
  assert.equal(savedNativeHistoryKind("unknown"), "project");
});

test("active surface keys stay separate by organization and project", () => {
  assert.notEqual(conversationSurfaceStateKey("org-a", "project-a"),
    conversationSurfaceStateKey("org-a", "project-b"));
  assert.notEqual(conversationSurfaceStateKey("org-a", "project-a"),
    conversationSurfaceStateKey("org-b", "project-a"));
  assert.notEqual(conversationSurfaceStateKey("org-a", null),
    conversationSurfaceStateKey("org-a", "project-a"));
});


test("Code draft-only IDs stay separate from run and project identities", () => {
  const original = codeDraftThreadId("project-a", "new-draft");
  assert.equal(codeDraftSelectionKey("project-a", original), "new-draft");
  assert.equal(codeDraftSelectionKey("project-b", original), null);
  assert.equal(codeDraftSelectionKey(null, original), null);
  assert.equal(codeDraftSelectionKey("project-a", codeDraftThreadId("project-a", "")), null);
  assert.equal(codeDraftThreadId("project-a", "run-1"), "vivary-code:project:project-a:run-1");
});
