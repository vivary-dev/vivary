import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const temporary = await mkdtemp(path.join(os.tmpdir(), "vivary-native-archive-"));
const database = "file:" + path.join(temporary, "archive.sqlite");
Object.assign(process.env, {
  APP_NAME: "VivaryNativeArchiveTest", AGENT_USER_EMAIL: "owner@example.test",
  DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARYNATIVEARCHIVETEST_DATABASE_URL: database,
  VIVARYNATIVEARCHIVETEST_DATABASE_URL_UNPOOLED: database,
});
const { withMigrationRuntime, closeDbExec } = await import("@agent-native/core/db");
const { createThread, getThread, listThreads, setThreadArchived, setThreadPinned, updateThreadData,
  ensureChatThreadTables } = await import(
  new URL("../../chat-threads/store.js", import.meta.resolve("@agent-native/core/client/agent-chat")),
);
const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
const { listArchivedNativeChats, restoreArchivedNativeChat } = await import("../server/native-archive.ts");
const { default: archiveAction } = await import("../actions/vivary-native-archive.ts");
const owner = "owner@example.test";
const orgId = "org1";

function repositoryWith(text) {
  return { headId: text + "-user", messages: [{
    message: { id: text + "-user", role: "user", content: [{ type: "text", text }] }, parentId: null,
  }] };
}

test.before(() => withMigrationRuntime(() => ensureChatThreadTables()));
test.after(async () => { await closeDbExec(); await rm(temporary, { recursive: true, force: true }); });

test("the archive action is owner-only and its schema admits only a project and a well-formed thread id", () => {
  assert.deepEqual([archiveAction.requiresAuth, archiveAction.agentTool, archiveAction.mcpTool,
    archiveAction.toolCallable], [true, false, false, false]);
  for (const input of [{ operation: "list", projectId: "p1" }, { operation: "list", projectId: null },
    { operation: "restore", projectId: "p1", threadId: "gone" },
    { operation: "restore", projectId: null, threadId: "a".repeat(200) }]) {
    assert.equal(archiveAction.schema.safeParse(input).success, true, `accepts ${JSON.stringify(input)}`);
  }
  for (const input of [{ operation: "list", projectId: "p1", ownerEmail: "other@example.test" },
    { operation: "restore", projectId: "p1", threadId: "gone", orgId: "another-org" },
    ...["../escape", "has space", "", "a".repeat(201)].map(threadId => ({ operation: "restore", projectId: "p1",
      threadId }))]) {
    assert.equal(archiveAction.schema.safeParse(input).success, false, `rejects ${JSON.stringify(input)}`);
  }
});

test("a project's archived Native chats are listed and restored with history and scope", async () => {
  const p1 = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p1", label: "P1" });
  const p2 = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p2", label: "P2" });
  for (const [id, title, identity] of [["kept", "Kept", p1], ["gone", "Gone", p1], ["later", "Later", p1],
    ["other", "Other", p2]]) {
    await createThread(owner, { id, orgId, scope: identity.scope });
    await updateThreadData(id, JSON.stringify(repositoryWith(title)), title, title, 1);
  }
  assert.deepEqual(await listArchivedNativeChats(p1, owner, orgId), []);
  assert.equal(await setThreadPinned("gone", true, { ownerEmail: owner }), true);
  const before = await getThread("gone");
  for (const id of ["gone", "other", "later"]) {
    assert.equal(await setThreadArchived(id, true, { ownerEmail: owner }), true);
    await delay(5);
  }

  const archived = await listArchivedNativeChats(p1, owner, orgId);
  assert.deepEqual(archived.map(chat => [chat.id, chat.title]), [["later", "Later"], ["gone", "Gone"]]);
  assert.ok(archived.every(chat => Number.isInteger(chat.archivedAt) && chat.archivedAt > 0));
  assert.deepEqual(await listArchivedNativeChats(p1, "other@example.test", orgId), []);
  for (const [identity, threadId, actor, actorOrg] of [[p1, "other", owner, orgId], [p1, "missing", owner, orgId],
    [p1, "gone", "other@example.test", orgId], [p1, "gone", owner, "another-org"], [p2, "gone", owner, orgId]]) {
    await assert.rejects(restoreArchivedNativeChat(identity, threadId, actor, actorOrg), { statusCode: 404 });
  }
  assert.notEqual((await getThread("gone")).archivedAt, null);

  await restoreArchivedNativeChat(p1, "gone", owner, orgId);
  await restoreArchivedNativeChat(p1, "gone", owner, orgId);
  assert.deepEqual((await listArchivedNativeChats(p1, owner, orgId)).map(chat => chat.id), ["later"]);
  const after = await getThread("gone");
  assert.equal(after.archivedAt, null);
  assert.deepEqual(after.scope, before.scope);
  assert.equal(after.threadData, before.threadData);
  assert.equal(after.title, "Gone");
  assert.notEqual(after.pinnedAt, null, "the chat was pinned before it was archived");
  assert.equal(after.pinnedAt, before.pinnedAt, "the pin survives restore");
  assert.deepEqual((await listThreads(owner, { scope: p1.scope, orgId })).map(chat => chat.id).sort(), ["gone", "kept"]);
  assert.notEqual((await getThread("other")).archivedAt, null);
});

test("a chat stored with a mixed-case owner or no organization restores in its project", async () => {
  const p3 = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p3", label: "P3" });
  for (const [id, threadOwner, threadOrg] of [["mixed-case", "Owner@Example.Test", orgId], ["no-org", owner, null]]) {
    await createThread(threadOwner, { id, orgId: threadOrg, scope: p3.scope });
    await updateThreadData(id, JSON.stringify(repositoryWith(id)), id, id, 1);
    assert.equal(await setThreadArchived(id, true, { ownerEmail: threadOwner }), true);
  }
  assert.equal((await getThread("mixed-case")).ownerEmail, "Owner@Example.Test", "the stored owner keeps its case");
  assert.equal((await getThread("no-org")).orgId, null, "the legacy chat is stored without an organization");
  assert.deepEqual((await listArchivedNativeChats(p3, owner, orgId)).map(chat => chat.id).sort(),
    ["mixed-case", "no-org"]);

  for (const id of ["mixed-case", "no-org"]) {
    await restoreArchivedNativeChat(p3, id, owner, orgId);
    assert.equal((await getThread(id)).archivedAt, null, `${id} is restored`);
  }
  assert.deepEqual(await listArchivedNativeChats(p3, owner, orgId), []);
});

test("the archived list reads past one page and returns every chat newest archive first", async () => {
  const p4 = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "p4", label: "P4" });
  const ids = Array.from({ length: 201 }, (_, index) => `paged-${index}`);
  for (const id of ids) {
    await createThread(owner, { id, orgId, scope: p4.scope });
    await updateThreadData(id, JSON.stringify(repositoryWith(id)), id, id, 1);
  }
  for (const id of ids) {
    assert.equal(await setThreadArchived(id, true, { ownerEmail: owner }), true);
    const now = Date.now();
    while (Date.now() === now) await delay(1);
  }

  const archived = await listArchivedNativeChats(p4, owner, orgId);
  assert.equal(new Set(archived.map(chat => chat.archivedAt)).size, 201, "every chat has its own archive time");
  assert.deepEqual(archived.map(chat => chat.id), ids.toReversed());
});
