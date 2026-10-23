// The conversation inbox against the normal built app, with no model or provider call.
// Run after a build: node tests/conversation-inbox-app.mjs [--data-dir <dir> --keep-data] [--seed <count>]
// It proves a manual API chat name survives a later generated title, before and after a server restart, and that the
// inbox's archive refuses queued work. With --seed it also leaves that many conversations for a browser check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createCodeAgentRunRecord } from "@agent-native/core/code-agents";
import { OWNER, send, startBuiltApp } from "./built-app.mjs";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "keep-data": { type: "boolean" },
  seed: { type: "string" } } });
const data = values["data-dir"] ? path.resolve(values["data-dir"]) : await mkdtemp(path.join(os.tmpdir(), "vivary-inbox-app-"));
await mkdir(data, { recursive: true });
let server;

async function signIn() {
  const secret = new URL((await readFile(path.join(data, "owner-sign-in.txt"), "utf8")).trim()).hash.slice(1);
  const auth = await send(server.port, "GET", "/_agent-native/auth/session", { "x-vivary-owner-sign-in": secret });
  assert.equal(auth.status, 200, auth.body);
  assert.equal(JSON.parse(auth.body).email, OWNER);
  const cookie = [auth.headers["set-cookie"] ?? []].flat().map(value => value.split(";")[0]).join("; ");
  const origin = `http://127.0.0.1:${server.port}`;
  const raw = (method, route, body) => send(server.port, method, route, { cookie, origin, "sec-fetch-site": "same-origin",
    "x-agent-native-frontend": "1", "content-type": "application/json" }, body === undefined ? undefined : JSON.stringify(body));
  const request = async (method, route, body) => {
    const response = await raw(method, route, body);
    assert.equal(response.status, 200, `${method} ${route}: ${response.body}`);
    return JSON.parse(response.body);
  };
  const getAction = (name, input = {}) => request("GET", "/_agent-native/actions/" + name + "?" + new URLSearchParams(input));
  return { raw, request, getAction };
}

// The app keeps Native threads in one of the SQLite files in its data folder.
async function threadDatabase() {
  for (const name of await readdir(data)) {
    if (!name.endsWith(".sqlite")) continue;
    const db = new DatabaseSync(path.join(data, name));
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_threads'").get()) return db;
    } catch { /* not an app database */ }
    db.close();
  }
  throw new Error("No chat_threads table in the app data folder.");
}

try {
  server = await startBuiltApp([], data);
  let api = await signIn();
  const catalog = await api.getAction("vivary-project-catalog");
  assert.equal(catalog.code, "catalog");
  const registration = await api.request("POST", "/_agent-native/actions/vivary-register-project", {
    operationId: randomUUID().replaceAll("-", ""), expectedPolicyRevision: catalog.policyRevision,
    expectedRegistryRevision: catalog.registryRevision, locationRef: catalog.locations[0].locationRef,
    displayName: "Inbox fixture", contentIdentity: null, attachProjectId: null,
  });
  assert.ok(["registered", "already-registered"].includes(registration.code), JSON.stringify(registration));
  const projectId = registration.projectId;
  await api.request("POST", "/_agent-native/actions/vivary-set-project-kind", { projectId, workspaceKind: "personal" });
  const savedKind = async () => (await api.getAction("vivary-project-catalog")).projects
    .find(project => project.projectId === projectId)?.workspaceKind;
  assert.equal(await savedKind(), "personal", "the normal app catalog exposes its saved project default");
  const identity = await api.getAction("vivary-chat-identity", { kind: "project", projectId });
  const scopeParams = "?" + new URLSearchParams({ scopeType: identity.scope.type, scopeId: identity.scope.id });
  const thread = (id, text) => ({ headId: `${id}-reply`, messages: [
    { message: { id: `${id}-ask`, role: "user", content: [{ type: "text", text }] }, parentId: null },
    { message: { id: `${id}-reply`, role: "assistant", content: [{ type: "text", text: "Reply" }],
      status: { type: "complete", reason: "stop" } }, parentId: `${id}-ask` },
  ] });
  const native = async (id, text, title = text) => {
    await api.request("POST", "/_agent-native/agent-chat/threads" + scopeParams, { id, title, scope: identity.scope });
    await api.request("PUT", `/_agent-native/agent-chat/threads/${id}` + scopeParams,
      { threadData: JSON.stringify(thread(id, text)), title, preview: "Reply", messageCount: 2, scope: identity.scope });
  };

  // A5: the sidebar renames, then the open conversation saves with a generated title it computed earlier.
  await native("inbox-a5", "Explain the release plan");
  await api.request("POST", `/_agent-native/agent-chat/threads/inbox-a5/rename` + scopeParams, { title: "Manual name" });
  await api.request("PUT", `/_agent-native/agent-chat/threads/inbox-a5` + scopeParams, {
    threadData: JSON.stringify(thread("inbox-a5", "Explain the release plan")), title: "Generated release title",
    preview: "Reply", messageCount: 2, scope: identity.scope });
  const titleNow = async () => (await api.request("GET", "/_agent-native/agent-chat/threads/inbox-a5" + scopeParams)).title;
  const inboxTitle = async () => (await api.getAction("vivary-conversation-inbox")).rows
    .find(row => row.id === "native:inbox-a5")?.title;
  assert.equal(await titleNow(), "Manual name");
  assert.equal(await inboxTitle(), "Manual name");
  await server.stop();
  server = await startBuiltApp([], data);
  api = await signIn();
  assert.equal(await savedKind(), "personal", "the project kind survives a server restart");
  console.log("PASS: owner project-kind action and normal local catalog preserve Personal across restart.");
  assert.equal(await titleNow(), "Manual name", "the manual name survives a server restart");
  assert.equal(await inboxTitle(), "Manual name");
  console.log("PASS: A5, a manual API chat name survives a later generated title, before and after a restart.");

  // Archive refuses queued messages through the guarded action, then archives once they are gone.
  await native("inbox-queued", "Queue a follow-up");
  const db = await threadDatabase();
  const saved = JSON.parse(db.prepare("SELECT thread_data FROM chat_threads WHERE id = ?").get("inbox-queued").thread_data);
  db.prepare("UPDATE chat_threads SET thread_data = ? WHERE id = ?")
    .run(JSON.stringify({ ...saved, queuedMessages: [{ id: "q1", text: "Next" }] }), "inbox-queued");
  const refused = await api.raw("POST", "/_agent-native/actions/vivary-conversation-archive",
    { operation: "archive", projectId, threadId: "inbox-queued" });
  assert.equal(refused.status, 409, refused.body);
  assert.match(refused.body, /queued messages/);
  db.prepare("UPDATE chat_threads SET thread_data = ? WHERE id = ?")
    .run(JSON.stringify({ ...saved, queuedMessages: [] }), "inbox-queued");
  db.close();
  await api.request("POST", "/_agent-native/actions/vivary-conversation-archive",
    { operation: "archive", projectId, threadId: "inbox-queued" });
  assert.equal((await api.getAction("vivary-conversation-inbox")).rows.find(row => row.id === "native:inbox-queued")?.archived, true);
  console.log("PASS: archive refuses queued messages and archives once they are gone.");

  // Rename and pin reach the same owner action, which a private-proxy browser can authenticate on a POST.
  await api.request("POST", "/_agent-native/actions/vivary-conversation-archive",
    { operation: "rename", projectId, threadId: "inbox-a5", title: "Owner action name" });
  await api.request("POST", "/_agent-native/actions/vivary-conversation-archive",
    { operation: "pin", projectId, threadId: "inbox-a5" });
  const renamed = (await api.getAction("vivary-conversation-inbox")).rows.find(row => row.id === "native:inbox-a5");
  assert.deepEqual([renamed?.title, renamed?.pinned], ["Owner action name", true]);
  assert.equal(await titleNow(), "Owner action name");
  // A project that is not in the owner's catalog is not writable, whatever its derived scope.
  const outside = await api.raw("POST", "/_agent-native/actions/vivary-conversation-archive",
    { operation: "pin", projectId: "not-in-catalog", threadId: "inbox-a5" });
  assert.equal(outside.status, 403, outside.body);
  console.log("PASS: API chat rename and pin go through the owner action, which checks the current catalog.");

  const seed = Number(values.seed ?? 0);
  if (seed > 0) {
    // The signed-in unassigned identity names the organization a Code record must carry.
    const unassigned = await api.getAction("vivary-chat-identity", { kind: "unassigned" });
    const orgId = /^vivary-workbench-chat-v1:([A-Za-z0-9_-]{1,128})$/.exec(unassigned.scope?.id ?? "")?.[1];
    assert.ok(orgId, "The signed-in identity must name an organization.");
    // guard:allow-env-mutation - This CLI fixture selects its disposable synthetic store, never a request handler.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = path.join(data, "code-runs");
    for (let i = 0; i < seed; i++) {
      if (i % 2) await native(`seed-native-${i}`, `Seeded API chat ${i} with a longer title that wraps in a narrow sidebar`);
      else createCodeAgentRunRecord({ id: `seed-run-${i}`, goalId: "vivary-local-code", title: `Seeded Code conversation ${i}`,
        status: i % 6 === 0 ? "errored" : "completed", cwd: path.join(data, "workspace"),
        metadata: { app: "vivary-workbench-local-code", ownerEmail: OWNER, orgId, projectId, bindingId: registration.bindingId,
          workspaceRoot: path.join(data, "workspace"), engine: i % 4 ? "claude-cli" : "codex-cli", model: "sonnet" } });
    }
    console.log(`Seeded ${seed} conversations in ${data} (project Inbox fixture).`);
  }
} catch (error) {
  // The server log names the cause of a 500, which the response body hides.
  console.error(server?.output().slice(-6000));
  throw error;
} finally {
  await server?.stop();
  if (!values["keep-data"]) await rm(data, { recursive: true, force: true });
}
