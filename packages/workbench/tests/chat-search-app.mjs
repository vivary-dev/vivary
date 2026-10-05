// Seed and exercise the normal built app without a model or provider call.
// Run: node tests/chat-search-app.mjs --data-dir /tmp/vivary-chat-search-gui --keep-data
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createCodeAgentRunRecord, updateCodeAgentRunRecord, codeAgentRunTranscriptPath } from "@agent-native/core/code-agents";
import { OWNER, send, startBuiltApp } from "./built-app.mjs";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "keep-data": { type: "boolean" } } });
const data = values["data-dir"] ? path.resolve(values["data-dir"]) : await mkdtemp(path.join(os.tmpdir(), "vivary-chat-search-app-"));
await mkdir(data, { recursive: true });
let server;
try {
  server = await startBuiltApp([], data);
  const origin = `http://127.0.0.1:${server.port}`;
  const secret = new URL((await readFile(path.join(data, "owner-sign-in.txt"), "utf8")).trim()).hash.slice(1);
  const auth = await send(server.port, "GET", "/_agent-native/auth/session", { "x-vivary-owner-sign-in": secret });
  assert.equal(auth.status, 200, auth.body);
  assert.equal(JSON.parse(auth.body).email, OWNER);
  const cookie = [auth.headers["set-cookie"] ?? []].flat().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  const request = async (method, route, body) => {
    const response = await send(server.port, method, route, { cookie, origin,
      "sec-fetch-site": "same-origin", "x-agent-native-frontend": "1", "content-type": "application/json" },
    body === undefined ? undefined : JSON.stringify(body));
    assert.equal(response.status, 200, `${method} ${route}: ${response.body}`);
    return JSON.parse(response.body);
  };
  const getAction = (name, input = {}) => request("GET", "/_agent-native/actions/" + name + "?" +
    new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])));
  const catalog = await getAction("vivary-project-catalog");
  assert.equal(catalog.code, "catalog");
  const registration = await request("POST", "/_agent-native/actions/vivary-register-project", {
    operationId: randomUUID().replaceAll("-", ""), expectedPolicyRevision: catalog.policyRevision,
    expectedRegistryRevision: catalog.registryRevision, locationRef: catalog.locations[0].locationRef,
    displayName: "Chat search fixture", contentIdentity: null, attachProjectId: null,
  });
  assert.ok(["registered", "already-registered"].includes(registration.code), JSON.stringify(registration));
  const projectId = registration.projectId;
  const identity = await getAction("vivary-chat-identity", { kind: "project", projectId });
  const unassigned = await getAction("vivary-chat-identity", { kind: "unassigned" });
  assert.equal(unassigned.kind, "unassigned");
  assert.equal(unassigned.scope?.type, "workspace-app");
  // Local Native thread rows may have a null orgId; this authenticated identity carries the signed-in organization.
  const orgId = /^vivary-workbench-chat-v1:([A-Za-z0-9_-]{1,128})$/.exec(unassigned.scope?.id ?? "")?.[1];
  assert.ok(orgId, "The signed-in unassigned identity must identify an organization.");
  const scopeParams = scope => "?" + new URLSearchParams({ scopeType: scope.type, scopeId: scope.id });
  const native = async (id, text, scope = identity.scope) => {
    const thread = await request("POST", "/_agent-native/agent-chat/threads" + scopeParams(scope), { id, title: "Duplicate title", scope });
    assert.equal(thread.id, id);
    const threadData = JSON.stringify({ headId: `${id}-new`, messages: [
      { message: { id: `${id}-old`, role: "user", createdAt: "2023-11-14T22:13:20.000Z", content: [{ type: "text", text }] }, parentId: null },
      { message: { id: `${id}-new`, role: "assistant", content: [{ type: "text", text: "Recent reply" }], status: { type: "complete", reason: "stop" } }, parentId: `${id}-old` },
      { message: { id: `${id}-branch`, role: "assistant", content: [{ type: "text", text: "branchneedle retained alternative" }], status: { type: "complete", reason: "stop" } }, parentId: `${id}-old` },
      { message: { id: `${id}-branch-reply`, role: "user", content: [{ type: "text", text: "Follow-up on the saved alternative" }] }, parentId: `${id}-branch` },
    ] });
    await request("PUT", `/_agent-native/agent-chat/threads/${id}` + scopeParams(scope), {
      threadData, title: "Duplicate title", preview: "Recent reply", messageCount: 4, scope,
    });
    return thread;
  };
  for (let i = 0; i < 61; i++) await native(`search-filler-${String(i).padStart(3, "0")}`, "Ordinary saved text");
  await native("zz-native-old", "A forgotten old fact says searchneedle, only in this old message.");
  await native("zz-native-duplicate", "A duplicate title also has searchneedle.");
  await native("zz-native-unassigned", "Unassigned searchneedle", unassigned.scope);
  await native("zz-native-archived", "Archived searchneedle");
  await request("POST", "/_agent-native/agent-chat/threads/zz-native-archived/archive" + scopeParams(identity.scope), { archived: true });
  // The launcher uses this exact private Native Code store; no transcripts go into the project folder.
  // guard:allow-env-mutation - This CLI fixture selects its disposable synthetic store, never a request handler.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = path.join(data, "code-runs");
  for (let i = 0; i < 25; i++) createCodeAgentRunRecord({ id: `search-run-${String(i).padStart(3, "0")}`,
    goalId: "vivary-local-code", title: "Duplicate title", status: "completed", cwd: path.join(data, "workspace"),
    metadata: { app: "vivary-workbench-local-code", ownerEmail: OWNER, orgId, projectId,
      bindingId: registration.bindingId, workspaceRoot: path.join(data, "workspace"), engine: "claude-cli", model: "sonnet" } });
  updateCodeAgentRunRecord("search-run-000", { updatedAt: "2000-01-01T00:00:00.000Z" });
  await mkdir(path.dirname(codeAgentRunTranscriptPath("search-run-000")), { recursive: true });
  const events = Array.from({ length: 450 }, (_, i) => ({ schemaVersion: 1, id: `evt-search-${i}`, runId: "search-run-000",
    kind: i === 0 ? "user" : "system", metadata: { role: "assistant" },
    message: i === 0 ? "searchneedle in a Code event beyond the display window" : i === 30 ? "contextneedle in an old Code reply" : `Saved response ${i}`,
    createdAt: new Date(1700000000000 + i).toISOString() }));
  await writeFile(codeAgentRunTranscriptPath("search-run-000"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(codeAgentRunTranscriptPath("search-run-001"), JSON.stringify({ schemaVersion: 1, id: "evt-search-recent", runId: "search-run-001",
    kind: "user", message: "Recent Code searchneedle", createdAt: new Date().toISOString() }) + "\n");
  const search = async (input = {}) => {
    let after, results = [];
    for (let i = 0; i < 12; i++) {
      const page = await getAction("vivary-chat-search", { projectId, query: "searchneedle", ...input, after });
      assert.ok(Number.isSafeInteger(page.searchedSessions));
      assert.ok(page.scannedSessions <= 25 && page.scannedMessages <= 500 && page.readBytes <= page.limits.bytes);
      results.push(...page.results);
      if (!page.continueAfter) return results;
      after = page.continueAfter;
    }
    assert.fail("Search did not finish within its bounded pages");
  };
  const results = await search();
  const nativeHit = results.find(hit => hit.sessionId === "zz-native-old");
  const codeHit = results.find(hit => hit.sessionId === "search-run-000");
  assert.equal(nativeHit?.referenceId, "zz-native-old-old");
  assert.equal(codeHit?.referenceId, "evt-search-0");
  assert.ok(results.every(hit => !hit.archived));
  const nativeResults = results.filter(hit => hit.runtime === "native");
  assert.ok(nativeResults.every((hit, i) => !i || nativeResults[i - 1].sessionUpdatedAt >= hit.sessionUpdatedAt));
  assert.deepEqual(results.filter(hit => hit.runtime === "code").map(hit => hit.sessionId), ["search-run-001", "search-run-000"]);
  assert.ok((await search({ includeArchived: true })).some(hit => hit.sessionId === "zz-native-archived"));
  assert.deepEqual((await search({ projectId: null, unassigned: true })).map(hit => hit.sessionId), ["zz-native-unassigned"]);
  const restored = await getAction("vivary-chat-match", { projectId, threadId: nativeHit.sessionId, referenceId: nativeHit.referenceId });
  assert.ok(JSON.parse(restored.threadData).messages.some(entry => entry.message.id === nativeHit.referenceId));
  assert.equal(restored.archived, false);
  const archivedMatch = { projectId, threadId: "zz-native-archived", referenceId: "zz-native-archived-old" };
  assert.equal((await getAction("vivary-chat-match", archivedMatch)).archived, true);
  assert.equal((await getAction("vivary-chat-match", archivedMatch)).archived, true, "reading a match never restores it");
  await request("POST", "/_agent-native/actions/vivary-native-archive", {
    operation: "restore", projectId, threadId: archivedMatch.threadId,
  });
  assert.equal((await getAction("vivary-chat-match", archivedMatch)).archived, false);
  await request("POST", "/_agent-native/agent-chat/threads/zz-native-archived/archive" + scopeParams(identity.scope), { archived: true });
  const usual = await getAction("vivary-code-state", { projectId });
  assert.equal(usual.runs.length, 20);
  assert.ok(!usual.runs.some(run => run.id === codeHit.sessionId));
  const recent = await getAction("vivary-code-state", { projectId, runId: codeHit.sessionId });
  assert.equal(recent.run.events.length, 400);
  assert.ok(!recent.run.events.some(event => event.id === codeHit.referenceId));
  const anchored = await getAction("vivary-code-state", { projectId, runId: codeHit.sessionId,
    eventId: codeHit.referenceId, eventOffset: codeHit.eventOffset });
  assert.equal(anchored.run.events[0].id, codeHit.referenceId);
  const contextHit = (await search({ query: "contextneedle" }))[0];
  assert.equal(contextHit.referenceId, "evt-search-30");
  const context = await getAction("vivary-code-state", { projectId, runId: contextHit.sessionId,
    eventId: contextHit.referenceId, eventOffset: contextHit.eventOffset });
  const contextIndex = context.run.events.findIndex(event => event.id === contextHit.referenceId);
  assert.ok(contextIndex > 0 && contextIndex < context.run.events.length - 1);
  assert.ok(context.run.events.length <= 400);
  // Corrupt a retained row after its hit was returned, as can happen to legacy
  // data. Use the launcher's disposable database; the production HTTP read owns
  // the stale-result response. Restore the fixture for subsequent browser QA.
  const staleHit = results.find(hit => hit.sessionId === "zz-native-duplicate");
  assert.ok(staleHit);
  const db = new DatabaseSync(path.join(data, "auth.sqlite"));
  const saved = db.prepare("SELECT thread_data FROM chat_threads WHERE id=?").get(staleHit.sessionId).thread_data;
  try {
    for (const threadData of ["{broken", "null", '{"messages":{}}', '{"messages":[null]}']) {
      db.prepare("UPDATE chat_threads SET thread_data=? WHERE id=?").run(threadData, staleHit.sessionId);
      const route = "/_agent-native/actions/vivary-chat-match?" + new URLSearchParams({ projectId,
        threadId: staleHit.sessionId, referenceId: staleHit.referenceId });
      const response = await send(server.port, "GET", route, { cookie, origin, "sec-fetch-site": "same-origin" });
      assert.equal(response.status, 404, `Malformed retained match (${threadData}): ${response.body}`);
      assert.match(response.body, /no longer available\. Search again/);
    }
  } finally {
    db.prepare("UPDATE chat_threads SET thread_data=? WHERE id=?").run(saved, staleHit.sessionId);
    db.close();
  }
  const nativePath = `/?runtime=native&history=project&thread=${nativeHit.sessionId}&message=${nativeHit.referenceId}`;
  const codePath = `/?history=project&run=${codeHit.sessionId}&event=${codeHit.referenceId}&eventOffset=${codeHit.eventOffset}`;
  for (const route of [nativePath, codePath]) assert.equal((await send(server.port, "GET", route, { cookie })).status, 200);
  await writeFile(path.join(data, "chat-search-fixture.json"), JSON.stringify({ projectId, nativePath, codePath,
    codeContextPath: `/?history=project&run=${contextHit.sessionId}&event=${contextHit.referenceId}&eventOffset=${contextHit.eventOffset}`,
    nativeBranchPath: "/?runtime=native&history=project&thread=zz-native-old&message=zz-native-old-branch" }, null, 2) + "\n");
  console.log("PASS: real built-app owner search, archive/unassigned filters, authoritative archive state, stale-match 404s, retained Native match, and anchored Code event beyond 20/400.");
  console.log("GUI fixture data:", data, "(select Chat search fixture in Projects)");
  console.log("Native route:", nativePath); console.log("Code route:", codePath);
} finally {
  await server?.stop();
  if (!values["keep-data"]) await rm(data, { recursive: true, force: true });
}
