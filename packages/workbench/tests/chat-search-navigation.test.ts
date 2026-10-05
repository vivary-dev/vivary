import assert from "node:assert/strict";
import test from "node:test";
import { nativeMatchRepository } from "../app/lib/native-match-repository.ts";
import { chatSearchHref } from "../app/lib/chat-search-location.ts";
import { createHistoryReadAdapter } from "../app/lib/history-read-adapter.ts";
import type { ChatSearchHit } from "../app/lib/chat-search-schema.ts";

test("Native match replay keeps the saved head for ancestors and selects a retained branch without editing history", () => {
  const repository = { headId: "latest", queuedMessages: [{ id: "queued", text: "Do not run this saved follow-up" }], messages: [
    { message: { id: "old", role: "user", content: [{ type: "text", text: "Original" }] }, parentId: null },
    { message: { id: "latest", role: "assistant", content: [{ type: "text", text: "Current" }] }, parentId: "old" },
    { message: { id: "branch", role: "assistant", content: [{ type: "text", text: "Earlier alternative" }] }, parentId: "old" },
  ] };
  const persisted = JSON.stringify(repository);
  assert.equal(nativeMatchRepository(persisted, "old").headId, "latest");
  assert.equal(nativeMatchRepository(persisted, "branch").headId, "branch");
  assert.deepEqual(nativeMatchRepository(persisted, "old").messages.map(entry => entry.message.id), ["old", "latest"]);
  assert.deepEqual(nativeMatchRepository(persisted, "old").queuedMessages, []);
  assert.equal(JSON.stringify(repository), persisted);
  assert.throws(() => nativeMatchRepository(persisted, "deleted"), /no longer available/);
});

test("saved match replay refuses execution even if a retry or edit bypasses the disabled composer", async () => {
  const adapter = createHistoryReadAdapter({} as never);
  await assert.rejects(async () => {
    for await (const _ of adapter.run({} as never)) assert.fail("A read view emitted a model response");
  }, /Reading saved history/);
});

test("exact match links replace previous conversation anchors while preserving project panel context", () => {
  const hit: ChatSearchHit = { projectId: "alpha", projectLabel: "Alpha", sessionId: "thread:duplicate", title: "Duplicate",
    runtime: "native", referenceId: "message:a&b", excerpt: "Matched", match: "content", archived: true };
  const native = new URL(chatSearchHref(hit, false, "?run=old&event=old&eventOffset=5&panel=files&path=README.md"), "http://localhost");
  assert.equal(native.searchParams.get("thread"), hit.sessionId);
  assert.equal(native.searchParams.get("message"), hit.referenceId);
  assert.equal(native.searchParams.get("history"), "project");
  assert.equal(native.searchParams.get("panel"), "files");
  assert.equal(native.searchParams.has("run"), false);
  const code = new URL(chatSearchHref({ ...hit, runtime: "code", referenceId: "evt-123", eventOffset: 54321 }, true,
    native.search), "http://localhost");
  assert.equal(code.searchParams.get("run"), hit.sessionId);
  assert.equal(code.searchParams.get("eventOffset"), "54321");
  assert.equal(code.searchParams.get("history"), "unassigned");
  assert.equal(code.searchParams.has("thread"), false);
  assert.equal(code.searchParams.has("message"), false);
});


test("Native match selects the newest leaf through an off-head branch and keeps all its context", () => {
  const data = JSON.stringify({ headId: "live", messages: [
    { message: { id: "root" }, parentId: null }, { message: { id: "live" }, parentId: "root" },
    { message: { id: "match" }, parentId: "root" },
    { message: { id: "newest", createdAt: "2026-02-01" }, parentId: "match" },
    { message: { id: "earlier", createdAt: "2026-01-01" }, parentId: "match" },
  ] });
  const repository = nativeMatchRepository(data, "match");
  assert.equal(repository.headId, "newest");
  assert.deepEqual(repository.messages.map(entry => entry.message.id), ["root", "match", "newest"]);
});
