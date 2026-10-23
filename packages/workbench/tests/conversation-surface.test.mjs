import assert from "node:assert/strict";
import test from "node:test";
import { conversationSurfaceStateKey, defaultConversationSurface, newConversationSurface, requestedConversationSurface, restoredConversationSurface, savedNativeHistoryKind } from "../app/lib/conversation-surface.ts";
import { WORKSPACE_KIND_PRESET, workspaceKind, workspaceKindLabel } from "../shared/workspace-kind.ts";
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

test("the project kind picks the first surface only when nothing is requested or saved", () => {
  assert.equal(defaultConversationSurface("coding"), "code");
  assert.equal(defaultConversationSurface("personal"), "native");
  // Not set and the Personal workspace (no project) keep the earlier Code default.
  assert.equal(defaultConversationSurface(null), "code");
  assert.equal(defaultConversationSurface(undefined), "code");
  // A request or a saved surface still wins over the kind.
  assert.equal(restoredConversationSurface(requestedConversationSurface(new URLSearchParams("runtime=code")), null)
    ?? defaultConversationSurface("personal"), "code");
  assert.equal(restoredConversationSurface(null, "code") ?? defaultConversationSurface("personal"), "code");
  assert.equal(restoredConversationSurface(null, null) ?? defaultConversationSurface("personal"), "native");
});

test("New conversation follows a chosen kind and keeps the open surface when the kind is Not set", () => {
  for (const current of ["code", "native"]) {
    assert.equal(newConversationSurface("coding", current), "code");
    assert.equal(newConversationSurface("personal", current), "native");
    assert.equal(newConversationSurface(null, current), current);
    assert.equal(newConversationSurface(undefined, current), current);
  }
});

test("the two project kinds name their presets and labels, and other values are refused", () => {
  assert.deepEqual(workspaceKind.options, ["coding", "personal"]);
  assert.deepEqual({ ...WORKSPACE_KIND_PRESET }, { coding: "coding", personal: "knowledge-work" });
  assert.deepEqual([workspaceKindLabel("coding"), workspaceKindLabel("personal"), workspaceKindLabel(null)],
    ["Coding", "Personal", "Not set"]);
  for (const value of ["Coding", "work", "", null, "second-brain"]) assert.equal(workspaceKind.safeParse(value).success, false);
});
