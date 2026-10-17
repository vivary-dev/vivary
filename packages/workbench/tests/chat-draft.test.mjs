import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporary = await mkdtemp(path.join(os.tmpdir(), "vivary-chat-draft-"));
const database = "file:" + path.join(temporary, "draft.sqlite");
Object.assign(process.env, {
  APP_NAME: "VivaryChatDraftTest", AGENT_USER_EMAIL: "owner@example.test",
  DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARYCHATDRAFTTEST_DATABASE_URL: database,
  VIVARYCHATDRAFTTEST_DATABASE_URL_UNPOOLED: database,
});
const { withMigrationRuntime, closeDbExec } = await import("@agent-native/core/db");
const { listAppState } = await import("@agent-native/core/application-state");
const { createThread, setThreadArchived, updateThreadData, ensureChatThreadTables } = await import(
  new URL("../../chat-threads/store.js", import.meta.resolve("@agent-native/core/client/agent-chat")),
);
const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
const { assertChatDraftThread, changeChatDraft, changeIndexedChatDraft, chatDraftKey, chatDraftNextSchema,
  createCodeDraftIdentity, listChatDrafts, listNativeChatDrafts, readChatDraft,
  reconcileChatDraft, savedThreadHasSubmit } = await import("../server/chat-draft.ts");
const { draftObservation, applyReconciledDraft, drainDraftChanges, draftNeedsCloseAttention, acceptLoadedDraft,
  flushChatDraftsForClose, registerSelectionCloseFlush, trackSelectionWrite,
  needsUnmountedDraftRecovery, settleDraftForLink } = await import("../app/lib/chat-draft.ts");
const owner = "owner@example.test";
const orgId = "org1";
const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p1", label: "P" });

test("Native draft CAS retains pending evidence and a tombstone across stale writes", async t => {
  t.after(async () => { await closeDbExec(); await rm(temporary, { recursive: true, force: true }); });
  await withMigrationRuntime(() => ensureChatThreadTables());
  const threadId = "draft-thread-1";
  assert.equal(await assertChatDraftThread(identity, threadId, owner, orgId), null);
  const otherIdentity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p2", label: "Other" });
  assert.notEqual(chatDraftKey(identity, threadId), chatDraftKey(otherIdentity, threadId));
  const codeIdentity = createCodeDraftIdentity(owner, orgId, "p1");
  assert.notEqual(chatDraftKey(identity, threadId), chatDraftKey(codeIdentity, threadId));
  assert.notEqual(chatDraftKey(codeIdentity, threadId),
    chatDraftKey(createCodeDraftIdentity(owner, orgId, "p2"), threadId));
  assert.deepEqual(await listChatDrafts(identity), []);
  const draftA = await changeIndexedChatDraft(identity, "unsent-a", null,
    { status: "draft", text: "Unsent A", submitId: null });
  const draftB = await changeIndexedChatDraft(identity, "unsent-b", null,
    { status: "draft", text: "Unsent B", submitId: null });
  assert.equal(draftA.changed && draftB.changed, true);
  assert.deepEqual(new Set((await listChatDrafts(identity)).map(item => item.threadId)),
    new Set(["unsent-a", "unsent-b"]));
  assert.equal((await listChatDrafts(identity)).find(item => item.threadId === "unsent-a")?.preview, "Unsent A");
  const marker = (await listAppState("vivary-chat-draft-index-v1:"))
    .find(entry => entry.value.threadId === "unsent-a");
  assert.deepEqual(Object.keys(marker.value).sort(), ["createdAt", "generation", "threadId"]);
  const pendingB = await changeIndexedChatDraft(identity, "unsent-b", draftB.record,
    { status: "pending", text: "Unsent B", submitId: "29cf865b-641d-4415-a42d-df12113e6e0c" });
  assert.equal(pendingB.changed, true);
  assert.equal((await listChatDrafts(identity)).find(item => item.threadId === "unsent-b")?.status, "pending");
  assert.deepEqual(await listChatDrafts(otherIdentity), []);
  assert.deepEqual(await listChatDrafts(createVivaryChatIdentity("other@example.test", orgId,
    { kind: "project", projectId: "p1", label: "P" })), []);
  assert.deepEqual(await listChatDrafts(createVivaryChatIdentity(owner, "another-org",
    { kind: "project", projectId: "p1", label: "P" })), []);
  const codeOnly = await changeIndexedChatDraft(codeIdentity, "vivary-code:project:p1:only", null,
    { status: "draft", text: "Code unsent", submitId: null });
  assert.equal(codeOnly.changed, true);
  assert.deepEqual((await listChatDrafts(codeIdentity)).map(item => item.threadId),
    ["vivary-code:project:p1:only"]);
  assert.equal((await changeIndexedChatDraft(identity, "unsent-a", draftA.record,
    { status: "cleared", text: "", submitId: null })).changed, true);
  assert.deepEqual((await listChatDrafts(identity)).map(item => item.threadId), ["unsent-b"]);
  assert.equal((await listAppState("vivary-chat-draft-index-v1:"))
    .some(entry => entry.value.threadId === "unsent-a"), false);
  const stale = await changeIndexedChatDraft(identity, "unsent-a", draftA.record,
    { status: "draft", text: "Stale", submitId: null });
  assert.equal(stale.changed, false);
  assert.deepEqual((await listChatDrafts(identity)).map(item => item.threadId), ["unsent-b"]);
  const revived = await changeIndexedChatDraft(identity, "unsent-a", stale.record,
    { status: "draft", text: "Revived", submitId: null });
  assert.equal(revived.changed, true);
  assert.equal((await listChatDrafts(identity)).find(item => item.threadId === "unsent-a")?.preview, "Revived");
  assert.equal((await listChatDrafts(identity)).find(item => item.threadId === "unsent-a")?.createdAt >= marker.value.createdAt, true);
  assert.deepEqual(new Set((await listNativeChatDrafts(identity, owner, orgId)).map(item => item.threadId)),
    new Set(["unsent-a", "unsent-b"]));
  await createThread(owner, { id: "unsent-b", orgId, scope: otherIdentity.scope });
  assert.deepEqual((await listNativeChatDrafts(identity, owner, orgId)).map(item => item.threadId), ["unsent-a"]);
  const archived = await changeIndexedChatDraft(identity, "archived-draft", null,
    { status: "draft", text: "Later archived", submitId: null });
  assert.equal(archived.changed, true);
  await createThread(owner, { id: "archived-draft", orgId, scope: identity.scope });
  assert.equal(await setThreadArchived("archived-draft", true, { ownerEmail: owner }), true);
  assert.deepEqual((await listNativeChatDrafts(identity, owner, orgId)).map(item => item.threadId), ["unsent-a"]);
  const first = await changeChatDraft(identity, threadId, null,
    { status: "draft", text: "Alpha", submitId: null });
  assert.equal(first.changed, true);
  const submitId = "29cf865b-641d-4415-a42d-df12113e6e0c";
  const firstPending = await changeChatDraft(identity, threadId, first.record,
    { status: "pending", text: "Alpha", submitId });
  assert.equal(firstPending.changed, true);
  assert.equal((await reconcileChatDraft(identity, threadId, owner, orgId)).saved, false);
  const restored = await changeChatDraft(identity, threadId, firstPending.record,
    { status: "draft", text: "Alpha", submitId: null });
  assert.equal(restored.changed, true);
  const pending = await changeChatDraft(identity, threadId, restored.record,
    { status: "pending", text: "Alpha", submitId });
  assert.equal(pending.changed, true);
  const staleEdit = await changeChatDraft(identity, threadId, first.record,
    { status: "draft", text: "Older", submitId: null });
  assert.equal(staleEdit.changed, false);
  assert.deepEqual(staleEdit.record, pending.record);
  assert.deepEqual(await reconcileChatDraft(identity, threadId, owner, orgId),
    { record: pending.record, saved: false });

  await createThread(owner, { id: threadId, orgId, scope: identity.scope });
  await assert.rejects(assertChatDraftThread(otherIdentity, threadId, owner, orgId), { statusCode: 404 });
  await assert.rejects(assertChatDraftThread(identity, threadId, "other@example.test", orgId), { statusCode: 404 });
  const repository = { headId: "user-1", messages: [{
    message: { id: "user-1", role: "user", content: [{ type: "text", text: "Alpha" }],
      metadata: { custom: { agentNativeQueuedMessageId: submitId } } },
    runConfig: { custom: { agentNativeQueuedMessageId: submitId } },
    parentId: null,
  }] };
  assert.equal(savedThreadHasSubmit(JSON.stringify(repository), submitId), true);
  assert.equal(savedThreadHasSubmit(JSON.stringify({ messages: [], queuedMessages: [{ id: submitId, text: "Alpha" }] }), submitId), true);
  await updateThreadData(threadId, JSON.stringify(repository), "Alpha", "Alpha", 1);
  const settled = await reconcileChatDraft(identity, threadId, owner, orgId);
  assert.equal(settled.saved, true);
  assert.equal(settled.record.status, "cleared");
  assert.equal(settled.record.text, "");
  assert.equal((await readChatDraft(identity, threadId)).revision, settled.record.revision);
  const delayedClear = await changeChatDraft(identity, threadId, pending.record,
    { status: "cleared", text: "", submitId: null });
  assert.equal(delayedClear.changed, false);
  const delayedEdit = await changeChatDraft(identity, threadId, first.record,
    { status: "draft", text: "Resurrect", submitId: null });
  assert.equal(delayedEdit.changed, false);
  assert.equal((await readChatDraft(identity, threadId)).status, "cleared");
});

test("draft states reject malformed pending and cleared values", () => {
  assert.equal(chatDraftNextSchema.safeParse({ status: "pending", text: "A", submitId: null }).success, false);
  assert.equal(chatDraftNextSchema.safeParse({ status: "cleared", text: "A", submitId: null }).success, false);
  assert.equal(savedThreadHasSubmit(JSON.stringify({ messages: [{ message: {
    role: "user", content: [{ type: "text", text: "Alpha" }] }, parentId: null }] }),
  "29cf865b-641d-4415-a42d-df12113e6e0c"), false);
});


test("late reconciliation cannot overwrite a newer draft or discard", async () => {
  const pending = { revision: "9f93cd89-54ad-469f-882a-530498a606a6",
    status: "pending", text: "Sent", submitId: "29cf865b-641d-4415-a42d-df12113e6e0c" };
  const newer = { revision: "d50e148d-6913-4715-9025-b553b0d92b89",
    status: "draft", text: "New text", submitId: null };
  const entry = { generation: 0, record: pending, text: "", reset: 1, error: null };
  const observed = draftObservation(entry);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const arriving = delayed.then(result => applyReconciledDraft(entry, observed, result));
  entry.record = newer;
  entry.text = "New text";
  release({ record: { revision: "61eeb502-4113-4fa7-845c-08e434de6d46",
    status: "cleared", text: "", submitId: null }, saved: true });
  assert.equal(await arriving, false);
  assert.deepEqual(entry.record, newer);
  assert.equal(entry.text, "New text");

  const discardObservation = draftObservation(entry);
  entry.generation++;
  entry.record = { revision: "535c0746-2d58-4c15-8eb8-b130b26a2cd3",
    status: "cleared", text: "", submitId: null };
  assert.equal(applyReconciledDraft(entry, discardObservation,
    { record: pending, saved: false }), false);
  assert.equal(entry.record.status, "cleared");
});

test("concurrent flush requests drain each draft edit once", async () => {
  const firstWrite = Promise.withResolvers();
  const current = { loaded: true, record: { revision: "r0", text: "", status: "draft", submitId: null },
    text: "A", generation: 0, saving: null, error: null };
  const writes = [];
  const write = async (expected, next) => {
    writes.push({ expected: expected.revision, text: next.text });
    if (next.text === "A") await firstWrite.promise;
    current.record = { ...next, revision: `r${writes.length}` };
  };
  const first = drainDraftChanges(current, write, () => undefined);
  current.text = "B";
  const close = drainDraftChanges(current, write, () => undefined);
  const anotherWaiter = drainDraftChanges(current, write, () => undefined);
  assert.equal(close, first);
  assert.equal(anotherWaiter, first);
  firstWrite.resolve();
  await Promise.all([first, close, anotherWaiter]);
  assert.deepEqual(writes, [{ expected: "r0", text: "A" }, { expected: "r1", text: "B" }]);
  assert.equal(current.record.text, "B");
  assert.equal(current.saving, null);
});

test("a verified saved reload resolves a failed discard before close", () => {
  const saved = { revision: "saved-after-refusal", text: "Retained draft", status: "draft", submitId: null };
  const current = { loaded: true, record: saved, text: "Retained draft", timer: null,
    saving: null, discardPromise: null, discardFailed: true, error: "The draft could not be discarded. Retry.", reset: 0 };
  assert.equal(draftNeedsCloseAttention(current), true);
  acceptLoadedDraft(current, saved);
  assert.equal(current.discardFailed, false);
  assert.equal(current.error, null);
  assert.equal(current.text, saved.text);
  assert.equal(draftNeedsCloseAttention(current), false);
});

test("a failed conflict reload retains the in-memory draft behind the close fence", () => {
  const current = { loaded: false, record: { revision: "stale", text: "Old", status: "draft", submitId: null },
    text: "Unwritten edit", timer: null, saving: null, discardPromise: null, discardFailed: false,
    error: "The saved draft could not be loaded. Retry before typing." };
  assert.equal(draftNeedsCloseAttention(current), true);
  acceptLoadedDraft(current, { revision: "fresh", text: "Saved elsewhere", status: "draft", submitId: null });
  assert.equal(draftNeedsCloseAttention(current), false);
});


test("desktop close waits for queued selection writes and retries an unmounted failure", async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let dirty = true;
  const unregister = registerSelectionCloseFlush(async () => {
    await trackSelectionWrite(second.promise);
  }, () => dirty);
  trackSelectionWrite(first.promise);
  const close = flushChatDraftsForClose();
  first.resolve();
  await Promise.resolve();
  dirty = false;
  second.resolve();
  assert.equal(await close, true);
  unregister();

  let fails = true;
  const unmount = registerSelectionCloseFlush(async () => {
    if (fails) throw new Error("selection save refused");
  }, () => fails);
  unmount();
  assert.equal(await flushChatDraftsForClose(), false);
  fails = false;
  assert.equal(await flushChatDraftsForClose(), true);
});


test("a pending review entry is not shown as a failed unsaved edit beside another dirty draft", () => {
  const pending = { loaded: true, record: { status: "pending", text: "Sent", submitId: "submit" },
    text: "", timer: null, saving: null, discardPromise: null, discardFailed: false,
    error: "Review the send before restoring." };
  const dirty = { ...pending, record: { status: "draft", text: "Old", submitId: null },
    text: "New", error: null };
  assert.equal(needsUnmountedDraftRecovery(pending), false);
  assert.equal(needsUnmountedDraftRecovery(dirty), true);
});

test('preview refresh waits for the existing close flush and does not revoke or reload after a failed save', async () => {
  const { refreshPreviewDocument } = await import('../app/lib/workbench-preview.ts');
  let failing = true, dirty = true;
  const steps = [];
  const unregister = registerSelectionCloseFlush(async () => {
    steps.push('flush'); if (failing) throw new Error('save failed'); dirty = false;
  }, () => dirty);
  try {
    assert.equal(await refreshPreviewDocument(async () => { steps.push('revoke'); }, () => steps.push('reload')), false);
    assert.deepEqual(steps, ['flush']);
    failing = false;
    assert.equal(await refreshPreviewDocument(async () => { steps.push('revoke'); }, () => steps.push('reload')), true);
    assert.deepEqual(steps, ['flush','flush','revoke','reload']);
  } finally { failing = false; dirty = false; unregister(); }
});

test("linking waits for the source draft to settle and refuses a draft that failed to load, conflicted or failed to discard", async () => {
  const entry = overrides => ({ loaded: true, record: { revision: "r0", text: "Draft", status: "draft", submitId: null },
    text: "Draft", generation: 0, saving: null, timer: null, error: null, conflict: false, discarding: false,
    discardPromise: null, discardFailed: false, ...overrides });
  const drainFor = current => () => drainDraftChanges(current, async () => undefined, () => undefined);
  // The initial read is still in flight and then fails, recording the error, as ensureThread does.
  const loading = entry({ loaded: false, record: null, text: "" });
  loading.saving = (async () => { await Promise.resolve(); loading.error = "The saved draft could not be loaded."; })()
    .finally(() => { loading.saving = null; });
  await assert.rejects(settleDraftForLink(loading, drainFor(loading)), /needs attention/);
  // A discard in flight that fails.
  const discarding = entry({ discarding: true });
  discarding.discardPromise = (async () => { await Promise.resolve(); discarding.discardFailed = true; discarding.discarding = false; })()
    .finally(() => { discarding.discardPromise = null; });
  await assert.rejects(settleDraftForLink(discarding, drainFor(discarding)), /needs attention/);
  const conflicted = entry({ conflict: true, error: "The draft changed in another window." });
  await assert.rejects(settleDraftForLink(conflicted, drainFor(conflicted)));
  // A send waiting for review stays in the source and does not block linking. A settled ordinary draft links.
  const pending = entry({ record: { revision: "r1", text: "Review", status: "pending", submitId: "s1" }, text: "Review" });
  await settleDraftForLink(pending, drainFor(pending));
  const settled = entry({});
  await settleDraftForLink(settled, drainFor(settled));
});
