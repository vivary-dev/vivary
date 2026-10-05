import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodeAgentRunRecord, codeAgentRunTranscriptPath, codeAgentRunsDir, updateCodeAgentRunRecord } from "@agent-native/core/code-agents";

const temporary = await mkdtemp(path.join(os.tmpdir(), "vivary-chat-search-"));
const database = "file:" + path.join(temporary, "history.sqlite");
Object.assign(process.env, { APP_NAME: "VivaryChatSearchTest", DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database, VIVARYCHATSEARCHTEST_DATABASE_URL: database,
  AGENT_NATIVE_CODE_AGENTS_HOME: path.join(temporary, "code") });
const { getDbExec, withMigrationRuntime, closeDbExec } = await import("@agent-native/core/db");
const { createThread, updateThreadData, setThreadArchived, ensureChatThreadTables } = await import(
  new URL("../../chat-threads/store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
const owner = "owner@example.test", orgId = "org-a";
const scope = { label: "Alpha", projectId: "alpha", bindingId: "binding-alpha", rootId: "root-alpha", bindingRevision: 1 };
const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "alpha", label: "Alpha" });
const legacy = createVivaryChatIdentity(owner, orgId, { kind: "unassigned" });
async function search(input: Record<string, unknown> = {}, target = identity, actor = owner, org = orgId) {
  // Kept dynamic so the pre-implementation run reports each missing behavior by name.
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  return searchChatContent({ ownerEmail: actor, orgId: org, identity: target,
    codeScope: target.kind === "unassigned" ? { kind: "unassigned", label: "Unassigned" } : scope },
    { projectId: "alpha", unassigned: false, includeArchived: false, query: "needle", ...input } as never);
}
async function native(id: string, text: string, opts: Record<string, unknown> = {}, create = true) {
  if (create) await createThread(owner, { id, orgId, scope: identity.scope, ...opts });
  await updateThreadData(id, JSON.stringify({ headId: `${id}-new`, messages: [
    { message: { id: `${id}-old`, role: "user", content: [{ type: "text", text }] }, parentId: null },
    { message: { id: `${id}-new`, role: "assistant", content: [{ type: "text", text: "Recent reply" }] }, parentId: `${id}-old` },
  ] }), "Duplicate title", "Recent reply", 2);
}
function run(id: string, metadata: Record<string, unknown> = {}) {
  return createCodeAgentRunRecord({ id, goalId: "vivary-local-code", title: "Duplicate title", status: "completed", cwd: temporary,
    metadata: { app: "vivary-workbench-local-code", ownerEmail: owner, orgId, engine: "claude-cli", model: "sonnet",
      projectId: "alpha", bindingId: "binding-alpha", ...metadata } });
}
test.before(async () => {
  await withMigrationRuntime(() => ensureChatThreadTables());
  await native("native-old", "An old forgotten fact: needle is here.");
  await native("native-duplicate", "Another needle");
  await native("native-archived", "Archived needle");
  await setThreadArchived("native-archived", true, { ownerEmail: owner });
  await native("native-unassigned", "Unassigned needle", { scope: legacy.scope });
  // Invalid private blobs make accidental content reads fail visibly rather than quietly filtering excerpts afterward.
  for (const [id, actor, org, scopeId] of [["deny-owner", "other@example.test", orgId, identity.scope.id],
    ["deny-org", owner, "other-org", identity.scope.id], ["deny-project", owner, orgId, "another-project"]]) {
    await native(id, "Private needle");
    await getDbExec().execute({ sql: "UPDATE chat_threads SET owner_email=?, org_id=?, scope_id=?, thread_data=? WHERE id=?",
      args: [actor, org, scopeId, "INVALID PRIVATE CONTENT", id] });
  }
  for (let i = 0; i < 61; i++) await native(`filler-${String(i).padStart(3, "0")}`, "No match");
  for (let i = 0; i < 25; i++) run(`run-${String(i).padStart(3, "0")}`);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(codeAgentRunTranscriptPath("run-000")), { recursive: true });
  for (let i = 1; i < 25; i++) {
    const runId = `run-${String(i).padStart(3, "0")}`;
    await writeFile(codeAgentRunTranscriptPath(runId), JSON.stringify({ id: `evt-${i}`, runId, kind: "user",
      message: "Unmatched message", createdAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  }
  const events = Array.from({ length: 450 }, (_, i) => ({ schemaVersion: 1, id: `evt-old-${i}`, runId: "run-000",
    kind: i === 0 ? "user" : "system", metadata: { role: "assistant" }, message: i === 0 ? "A retained needle beyond four hundred" : `Reply ${i}`,
    createdAt: new Date(1700000000000 + i).toISOString() }));
  await writeFile(codeAgentRunTranscriptPath("run-000"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  for (const [id, metadata] of [["code-owner", { ownerEmail: "other@example.test" }], ["code-org", { orgId: "other-org" }],
    ["code-project", { projectId: "beta" }]] as const) {
    run(id, metadata);
    await writeFile(codeAgentRunTranscriptPath(id), "INVALID PRIVATE CONTENT\n");
  }
});
test.after(async () => { await closeDbExec(); await rm(temporary, { recursive: true, force: true }); });

test("Native match parse and shape failures return the same stale-result 404", async () => {
  const action = (await import("../actions/vivary-chat-match.ts")).default;
  await native("stale-match", "Saved match", { scope: legacy.scope });
  for (const threadData of ["{broken", "null", "[]", '{"messages":{}}', '{"messages":[null]}',
    '{"messages":[{"message":null}]}', '{"messages":[{"message":{"id":"stale-match-old"}},null]}']) {
    await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data=? WHERE id=?", args: [threadData, "stale-match"] });
    await assert.rejects(action.run({ projectId: null, unassigned: true, threadId: "stale-match",
      referenceId: "stale-match-old" }, { caller: "frontend", userEmail: owner, orgId }), error => {
      assert.equal((error as { statusCode?: number }).statusCode, 404, threadData);
      assert.match((error as Error).message, /no longer available\. Search again/);
      return true;
    });
  }
});

test("Native match reports authoritative archive state and does not restore the thread", async () => {
  const action = (await import("../actions/vivary-chat-match.ts")).default;
  await native("archive-state-match", "Saved match", { scope: legacy.scope });
  const input = { projectId: null, unassigned: true, threadId: "archive-state-match", referenceId: "archive-state-match-old" };
  const ctx = { caller: "frontend" as const, userEmail: owner, orgId };
  await setThreadArchived(input.threadId, true, { ownerEmail: owner });
  assert.equal((await action.run(input, ctx)).archived, true);
  assert.equal((await action.run(input, ctx)).archived, true, "reading history must not clear archive state");
  await setThreadArchived(input.threadId, false, { ownerEmail: owner });
  assert.equal((await action.run(input, ctx)).archived, false);
});

test("Native match rejects incomplete message shapes found by title search", async t => {
  const action = (await import("../actions/vivary-chat-match.ts")).default;
  const id = "incomplete-match", referenceId = `${id}-old`;
  await native(id, "Saved match", { scope: legacy.scope });
  t.after(async () => { await getDbExec().execute({ sql: "DELETE FROM chat_threads WHERE id=?", args: [id] }); });
  const input = { projectId: null, unassigned: true, threadId: id, referenceId };
  const ctx = { caller: "frontend" as const, userEmail: owner, orgId };
  for (const [name, message] of [
    ["missing role and content", { id: referenceId }],
    ["missing role", { id: referenceId, content: [] }],
    ["missing content", { id: referenceId, role: "user" }],
    ["invalid role", { id: referenceId, role: "invalid", content: [] }],
    ["null content", { id: referenceId, role: "user", content: null }],
    ["object content", { id: referenceId, role: "user", content: {} }],
  ] as const) await t.test(name, async () => {
    const threadData = JSON.stringify({ headId: referenceId, messages: [{ message, parentId: null }] });
    await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data=?, title=? WHERE id=?",
      args: [threadData, "incompleteneedle", id] });
    const hit = (await search({ projectId: null, unassigned: true, query: "incompleteneedle" }, legacy)).results[0];
    assert.equal(hit?.referenceId, referenceId, "a title hit can refer to an incomplete saved message");
    await assert.rejects(action.run(input, ctx), { statusCode: 404, message: "This matching message is no longer available. Search again." });
  });
  // Older retained messages can lack timestamps or assistant status. Their
  // required role/content fields still make them readable.
  for (const role of ["user", "assistant", "system"]) {
    const threadData = JSON.stringify({ headId: referenceId, messages: [
      { message: { id: referenceId, role, content: [] }, parentId: null },
    ] });
    await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data=? WHERE id=?", args: [threadData, id] });
    assert.equal((await action.run(input, ctx)).threadData, threadData);
  }
});

test("Native match enforces the repository cap in UTF-8 bytes before parsing", async t => {
  const action = (await import("../actions/vivary-chat-match.ts")).default;
  const id = "byte-capped-match", referenceId = `${id}-old`, cap = 8 * 1024 * 1024;
  await native(id, "Saved match", { scope: legacy.scope });
  t.after(async () => { await getDbExec().execute({ sql: "DELETE FROM chat_threads WHERE id=?", args: [id] }); });
  const input = { projectId: null, unassigned: true, threadId: id, referenceId };
  const ctx = { caller: "frontend" as const, userEmail: owner, orgId };
  const repository = (text: string) => JSON.stringify({ headId: referenceId, messages: [
    { message: { id: referenceId, role: "user", content: [{ type: "text", text }] }, parentId: null },
  ] });
  const overhead = Buffer.byteLength(repository(""));
  for (const [name, text, accepted] of [
    ["emoji over cap despite fewer characters", "😀".repeat(Math.ceil(cap / 4)), false],
    ["CJK over cap despite fewer characters", "界".repeat(Math.ceil(cap / 3)), false],
    ["exact byte cap", "界".repeat(Math.floor((cap - overhead) / 3)) + "x".repeat((cap - overhead) % 3), true],
    ["one byte over cap", "x".repeat(cap - overhead + 1), false],
  ] as const) await t.test(name, async () => {
    const threadData = repository(text);
    await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data=? WHERE id=?", args: [threadData, id] });
    const sizes = await getDbExec().execute({ sql: "SELECT length(thread_data) AS chars, length(CAST(thread_data AS BLOB)) AS bytes FROM chat_threads WHERE id=?", args: [id] });
    assert.equal(Number(sizes.rows[0].bytes), Buffer.byteLength(threadData));
    if (name.includes("despite")) assert.ok(Number(sizes.rows[0].chars) < cap && Number(sizes.rows[0].bytes) > cap);
    if (accepted) assert.equal((await action.run(input, ctx)).threadData, threadData);
    else {
      const parse = JSON.parse;
      let parses = 0;
      JSON.parse = ((data: string, ...args: []) => { if (data === threadData) parses++; return parse(data, ...args); }) as typeof JSON.parse;
      try { await assert.rejects(action.run(input, ctx), { statusCode: 404 }); }
      finally { JSON.parse = parse; }
      assert.equal(parses, 0, "oversized content must be rejected by the database predicate before parsing");
    }
  });
});

async function all(input: Record<string, unknown> = {}, target = identity) {
  let after: string | undefined, results: Awaited<ReturnType<typeof search>>["results"] = [];
  for (let page = 0; page < 100; page++) {
    const response = await search({ ...input, after }, target);
    results.push(...response.results);
    assert.ok(response.scannedSessions <= response.limits.sessions);
    assert.ok(response.scannedMessages <= response.limits.messages);
    assert.ok(response.results.length <= response.limits.results);
    assert.ok(response.readBytes <= response.limits.bytes);
    if (!response.continueAfter) return results;
    assert.notEqual(response.continueAfter, after);
    after = response.continueAfter;
  }
  assert.fail("Pagination did not finish");
}
test("scope and owner checks precede content; duplicate titles retain exact old Native references beyond the first page", async () => {
  const results = await all();
  assert.deepEqual(results.filter(hit => hit.runtime === "native").map(hit => hit.sessionId).sort(), ["native-duplicate", "native-old"]);
  const old = results.find(hit => hit.sessionId === "native-old")!;
  assert.equal(old.referenceId, "native-old-old");
  assert.equal(old.projectId, "alpha");
  assert.match(old.excerpt, /needle/);
  assert.equal(old.title, "Duplicate title");
  assert.ok(results.every(hit => hit.excerpt.length <= 240));
  assert.deepEqual(await all({}, identity).then(hits => hits.filter(hit => hit.sessionId.startsWith("deny") || hit.sessionId.startsWith("code-"))), []);
  assert.deepEqual((await search({}, identity, "other@example.test")).results, []);
  assert.deepEqual((await search({}, identity, owner, "wrong-org")).results, []);
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const emptyIdentity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: "empty", label: "Empty" });
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await searchChatContent({ ownerEmail: owner, orgId, identity: emptyIdentity,
      codeScope: { ...scope, projectId: "empty", bindingId: "empty-binding" } },
    { projectId: "empty", query: "needle", includeArchived: false, unassigned: false, after });
    assert.deepEqual([page.results, page.scannedSessions, page.scannedMessages, page.readBytes], [[], 0, 0, 0], "foreign runs contribute no public counts");
    assert.equal(page.limited, false, "private malformed transcripts are never read");
    if (!page.continueAfter) break;
    after = page.continueAfter;
  }
});
test("retained Code matches beyond twenty runs and four hundred events open an anchored transcript page", async () => {
  const hit = (await all()).find(hit => hit.runtime === "code")!;
  assert.equal(hit.sessionId, "run-000");
  assert.equal(hit.referenceId, "evt-old-0");
  assert.equal(hit.eventOffset, 0);
  const { getVivaryCodeState } = await import("../server/local-code-agent.ts");
  const usual = await getVivaryCodeState(owner, undefined, scope, orgId);
  assert.equal(usual.runs.length, 20);
  assert.ok(!usual.runs.some(item => item.id === hit.sessionId));
  const recent = await getVivaryCodeState(owner, hit.sessionId, scope, orgId);
  assert.equal(recent.run?.events.length, 400);
  assert.ok(!recent.run?.events.some(event => event.id === hit.referenceId));
  const anchored = await getVivaryCodeState(owner, hit.sessionId, scope, orgId, undefined,
    { eventId: hit.referenceId, eventOffset: hit.eventOffset! });
  assert.equal(anchored.run?.events[0]?.id, hit.referenceId);
  assert.ok(anchored.run!.events.length <= 400);
});
test("archive and unassigned filters are explicit; authoritative edits and titles are searchable", async () => {
  assert.ok((await all({ includeArchived: true })).some(hit => hit.sessionId === "native-archived" && hit.archived));
  const unassigned = await all({ projectId: null, unassigned: true }, legacy);
  assert.deepEqual(unassigned.map(hit => hit.sessionId), ["native-unassigned"]);
  await native("native-old", "Edited fact now says replacement", {}, false);
  assert.ok(!(await all()).some(hit => hit.sessionId === "native-old"));
  assert.ok((await all({ query: "replacement" })).some(hit => hit.referenceId === "native-old-old"));
  updateCodeAgentRunRecord("run-024", { title: "Changed title needle" });
  assert.ok((await all()).some(hit => hit.sessionId === "run-024" && hit.match === "title"));
  const titles = await all({ query: "duplicate" });
  assert.ok(titles.some(hit => hit.runtime === "native" && hit.match === "title" && hit.referenceId));
  const oldEvents = (await readFile(codeAgentRunTranscriptPath("run-000"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  oldEvents[0].message = "The saved Code text was edited to codereplacement.";
  await writeFile(codeAgentRunTranscriptPath("run-000"), oldEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
  assert.ok(!(await all()).some(hit => hit.sessionId === "run-000"));
  assert.ok((await all({ query: "codereplacement" })).some(hit => hit.referenceId === "evt-old-0"));
});
test("continuation is bound to actor, scope and query, caps and cancellation are enforced", async () => {
  const first = await search();
  assert.ok(first.continueAfter);
  await assert.rejects(search({ after: first.continueAfter, query: "changed" }), /Search changed/);
  await assert.rejects(search({ after: "not-a-cursor" }), /Search changed/);
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(searchChatContent({ ownerEmail: owner, orgId, identity, codeScope: scope },
    { projectId: "alpha", query: "needle", unassigned: false, includeArchived: false }, controller.signal), { name: "AbortError" });
  const action = (await import("../actions/vivary-chat-search.ts")).default;
  assert.equal(action.http?.method, "GET");
  assert.deepEqual([action.readOnly, action.requiresAuth, action.agentTool, action.mcpTool, action.toolCallable], [true, true, false, false, false]);
  assert.equal(action.schema.safeParse({ query: "needle", projectId: "alpha", ownerEmail: "other" }).success, false);
  await assert.rejects(action.run({ query: "needle", projectId: null, unassigned: false, includeArchived: false }, undefined));
  const viaGet = await action.run({ query: "needle", unassigned: "true", includeArchived: "false" } as never,
    { caller: "frontend", userEmail: owner, orgId });
  assert.deepEqual(viaGet.results.map(hit => hit.sessionId), ["native-unassigned"]);
});

test("continuation after an oversized Code line and a full result page keeps the next complete event", async () => {
  const id = "oversized-code-line";
  const projectId = "oversized-code-project";
  const isolated = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Oversized" });
  run(id, { projectId });
  const events = Array.from({ length: 27 }, (_, i) => ({ schemaVersion: 1, id: `evt-discard-${i}`, runId: id,
    kind: "user", message: i === 0 ? "x".repeat(300_000) : "discardneedle", createdAt: "2026-01-01T00:00:00.000Z" }));
  await writeFile(codeAgentRunTranscriptPath(id), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  let after: string | undefined, limited = false;
  const references: string[] = [];
  for (let i = 0; i < 20; i++) {
    const page = await searchChatContent({ ownerEmail: owner, orgId, identity: isolated, codeScope: { ...scope, projectId } },
      { projectId, query: "discardneedle", includeArchived: false, unassigned: false, after });
    references.push(...page.results.map(hit => hit.referenceId)); limited ||= page.limited;
    assert.ok(page.readBytes <= page.limits.bytes);
    if (!page.continueAfter) break;
    after = page.continueAfter;
  }
  assert.equal(limited, true);
  assert.deepEqual(references, events.slice(1).map(event => event.id));
});

test("the twenty-fifth session in either store is searched and oversized sources report incomplete coverage", async () => {
  const boundaryIdentity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: null, label: "Boundary" });
  const boundaryScope = { root: temporary, label: "Boundary" };
  for (let i = 0; i < 26; i++) await native(`boundary-${String(i).padStart(2, "0")}`,
    i === 24 ? "boundaryneedle" : "No match", { scope: boundaryIdentity.scope });
  for (let i = 0; i < 50; i++) {
    const id = `boundary-run-${String(i).padStart(2, "0")}`;
    run(id, { projectId: null, bindingId: null, workspaceRoot: temporary });
    await writeFile(codeAgentRunTranscriptPath(id), JSON.stringify({ schemaVersion: 1, id: `evt-boundary-${i}`, runId: id,
      kind: "user", message: "boundaryneedle", createdAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  }
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  let after: string | undefined;
  const hits = [];
  for (let i = 0; i < 20; i++) {
    const page = await searchChatContent({ ownerEmail: owner, orgId, identity: boundaryIdentity, codeScope: boundaryScope },
      { projectId: null, query: "boundaryneedle", includeArchived: false, unassigned: false, after });
    assert.ok(page.scannedSessions <= 25 && page.results.length <= 25);
    hits.push(...page.results);
    if (!page.continueAfter) break;
    after = page.continueAfter;
  }
  assert.ok(hits.some(hit => hit.sessionId === "boundary-24"));
  assert.equal(new Set(hits.filter(hit => hit.runtime === "code").map(hit => hit.sessionId)).size, 50);
  const unassignedCode = await all({ projectId: null, unassigned: true, query: "boundaryneedle" }, legacy);
  assert.equal(unassignedCode.length, 0, "Personal Code runs never enter Unassigned history");
  await native("oversized", "x".repeat(70_000) + " needle");
  assert.ok((await search({ includeArchived: true, query: "needle" })).continueAfter);
  let limited = false;
  after = undefined;
  for (let i = 0; i < 20; i++) {
    const page = await search({ after }); limited ||= page.limited;
    if (!page.continueAfter) break;
    after = page.continueAfter;
  }
  assert.equal(limited, true);
  const nativeMatch = (await import("../actions/vivary-chat-match.ts")).default;
  const personal = { projectId: null, unassigned: false, threadId: "boundary-24", referenceId: "boundary-24-old" };
  const ctx = { caller: "frontend" as const, userEmail: owner, orgId };
  const before = await getDbExec().execute({ sql: "SELECT thread_data FROM chat_threads WHERE id=?", args: [personal.threadId] });
  assert.equal((await nativeMatch.run(personal, ctx)).threadData, before.rows[0].thread_data);
  assert.deepEqual((await getDbExec().execute({ sql: "SELECT thread_data FROM chat_threads WHERE id=?", args: [personal.threadId] })).rows, before.rows);
  for (const id of ["native-old", "deny-owner", "deny-org", "deny-project"]) {
    await assert.rejects(nativeMatch.run({ ...personal, threadId: id }, ctx), { statusCode: 404 });
  }
  const codeState = (await import("../actions/vivary-code-state.ts")).default;
  assert.equal(codeState.schema.safeParse({ unassigned: "false" }).success, true);
  assert.equal(codeState.schema.safeParse({ unassigned: "maybe" }).success, false);
  await assert.rejects(codeState.run({ unassigned: "true", runId: "boundary-run-00", eventId: "evt-boundary-0", eventOffset: "0" } as never, ctx), { statusCode: 404 });
  const { getVivaryCodeState } = await import("../server/local-code-agent.ts");
  const opened = await getVivaryCodeState(owner, "boundary-run-00", boundaryScope, orgId, undefined,
    { eventId: "evt-boundary-0", eventOffset: 0 });
  assert.equal(opened.run?.events[0]?.id, "evt-boundary-0");
  await assert.rejects(getVivaryCodeState(owner, "boundary-run-00", boundaryScope, orgId, undefined,
    { eventId: "evt-boundary-0", eventOffset: 1 }), /matching event/);
});


test("large Native repositories parse once per session page and resume after five hundred messages", async () => {
  const projectId = "large-thread";
  const target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Large" });
  const id = "large-native";
  await createThread(owner, { id, orgId, scope: target.scope });
  const messages = Array.from({ length: 2000 }, (_, i) => ({ parentId: i ? `large-${i - 1}` : null,
    message: { id: `large-${i}`, role: "user", content: [{ type: "text", text: "Ordinary retained conversation text. ".repeat(62) + (i === 400 ? " largeneedle" : "") }] } }));
  const data = JSON.stringify({ headId: "large-1999", messages });
  assert.ok(Buffer.byteLength(data) > 4 * 1024 * 1024);
  await updateThreadData(id, data, "Large", "Recent", messages.length);
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const stored = String((await getDbExec().execute({ sql: "SELECT thread_data FROM chat_threads WHERE id=?", args: [id] })).rows[0].thread_data);
  assert.ok(Buffer.byteLength(stored) > 4 * 1024 * 1024);
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = ((text: string, ...args: []) => { if (text === stored) parses++; return parse(text, ...args); }) as typeof JSON.parse;
  const started = performance.now();
  let page;
  try {
    page = await searchChatContent({ ownerEmail: owner, orgId, identity: target, codeScope: { ...scope, projectId } },
      { projectId, query: "largeneedle", unassigned: false, includeArchived: false });
  } finally { JSON.parse = parse; }
  assert.equal(parses, 1);
  assert.ok(performance.now() - started < 2000, "A capped 4.2 MB repository page must finish within two seconds");
  assert.equal(page.scannedMessages, 500);
  assert.equal(page.results[0]?.referenceId, "large-400");
  assert.ok(page.continueAfter);
});

test("foreign Code runs do not consume the session cap or public counts", async () => {
  const projectId = "small-owned-project";
  const target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Small" });
  for (let i = 0; i < 80; i++) {
    const id = `aa-foreign-${i}`;
    run(id, { projectId: "foreign-project" });
    await writeFile(codeAgentRunTranscriptPath(id), "PRIVATE MALFORMED TRANSCRIPT\n");
  }
  run("zz-only-owned", { projectId });
  await writeFile(codeAgentRunTranscriptPath("zz-only-owned"), JSON.stringify({ id: "evt-only-owned", runId: "zz-only-owned",
    kind: "user", message: "smallneedle", createdAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const page = await searchChatContent({ ownerEmail: owner, orgId, identity: target, codeScope: { ...scope, projectId } },
    { projectId, query: "smallneedle", unassigned: false, includeArchived: false });
  assert.equal(page.results[0]?.referenceId, "evt-only-owned");
  assert.equal(page.scannedSessions, 1); assert.equal(page.totalSessions, 1);
  assert.equal(page.limited, false); assert.equal(page.continueAfter, null);
});

test("Code metadata cap retains recent timestamp runs and stable continuation", async () => {
  const projectId = "metadata-budget-project";
  const target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Metadata budget" });
  const ids: string[] = [];
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const actor = { ownerEmail: owner, orgId, identity: target, codeScope: { ...scope, projectId } };
  const input = { projectId, query: "metadataneedle", unassigned: false, includeArchived: false };
  let metadataBytes = 0;
  try {
    for (let i = 0; i < 81; i++) {
      const time = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
      const id = `vivary-local-code-${time.replace(/[^0-9]/g, "")}-fixture`;
      ids.push(id);
      run(id, { projectId: i === 80 ? "foreign-project" : projectId, padding: "x".repeat(60_000) });
      updateCodeAgentRunRecord(id, { updatedAt: time });
      const bytes = Buffer.byteLength(await readFile(path.join(codeAgentRunsDir(), id + ".json")));
      assert.ok(bytes < 64 * 1024); metadataBytes += bytes;
      const events = Array.from({ length: i === 79 ? 27 : 1 }, (_, index) => ({
        id: `evt-metadata-${i}-${index}`, runId: id, kind: "user",
        message: i >= 78 ? "metadataneedle" : "Ordinary old conversation",
      }));
      await writeFile(codeAgentRunTranscriptPath(id), i === 80 ? "INVALID PRIVATE TRANSCRIPT\n"
        : events.map(event => JSON.stringify(event) + "\n").join(""));
    }
    assert.ok(metadataBytes > 4 * 1024 * 1024, "the fixture must exhaust the real metadata budget");
    const first = await searchChatContent(actor, input);
    assert.deepEqual(first.results.map(hit => hit.referenceId), Array.from({ length: 25 }, (_, i) => `evt-metadata-79-${i}`));
    assert.equal(first.limited, true); assert.ok(first.continueAfter);
    assert.ok(first.readBytes <= first.limits.bytes && first.scannedSessions <= first.limits.sessions);
    const second = await searchChatContent(actor, { ...input, after: first.continueAfter });
    const retry = await searchChatContent(actor, { ...input, after: first.continueAfter });
    assert.deepEqual(retry.results, second.results, "retry retains the exact message position");
    assert.deepEqual(second.results.map(hit => hit.referenceId), ["evt-metadata-79-25", "evt-metadata-79-26", "evt-metadata-78-0"]);
    const hits = [...first.results, ...second.results];
    let after = second.continueAfter;
    for (let i = 0; after && i < 10; i++) {
      const page = await searchChatContent(actor, { ...input, after });
      assert.equal(page.limited, true);
      assert.ok(page.readBytes <= page.limits.bytes && page.scannedSessions <= page.limits.sessions);
      hits.push(...page.results); after = page.continueAfter;
    }
    assert.equal(after, null);
    assert.equal(hits.length, 28);
    assert.ok(hits.every(hit => hit.sessionId === ids[79] || hit.sessionId === ids[78]), "foreign metadata admits no transcript or hit");
    assert.equal(new Set(hits.map(hit => hit.referenceId)).size, 28);
  } finally {
    for (const id of ids) {
      await rm(path.join(codeAgentRunsDir(), id + ".json"), { force: true });
      await rm(codeAgentRunTranscriptPath(id), { force: true });
    }
  }
});

test("Personal Native search survives an unavailable Code workspace", async () => {
  const target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: null, label: "Personal workspace" });
  await native("personal-workspace-missing", "personalneedle", { scope: target.scope });
  const action = (await import("../actions/vivary-chat-search.ts")).default;
  const configured = process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Workspace path fixture, not a credential; saved and restored around the case.
  // guard:allow-env-mutation - Socket-free fixture makes the Personal workspace explicitly unavailable.
  delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Workspace path fixture, not a credential; saved and restored around the case.
  try {
    const page = await action.run({ projectId: null, query: "personalneedle", unassigned: false, includeArchived: false },
      { caller: "frontend", userEmail: owner, orgId });
    assert.ok(page.results.some(hit => hit.sessionId === "personal-workspace-missing"));
    assert.equal(page.codeUnavailable, true);
  } finally {
    // guard:allow-env-mutation - Restore this test process's prior deployment fixture.
    if (configured === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Workspace path fixture, not a credential; saved and restored around the case.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = configured; // guard:allow-env-credential - Workspace path fixture, not a credential; saved and restored around the case.
  }
});

test("malformed Native repositories are skipped per session and continuation advances", async () => {
  const projectId = "malformed-project", target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Malformed" });
  await native("malformed-good", "malformedneedle", { scope: target.scope });
  await native("malformed-bad", "malformedneedle", { scope: target.scope });
  await getDbExec().execute({ sql: "UPDATE chat_threads SET thread_data=?, updated_at=? WHERE id=?", args: ["INVALID JSON", Date.now() - 5, "malformed-bad"] });
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const page = await searchChatContent({ ownerEmail: owner, orgId, identity: target, codeScope: { ...scope, projectId } },
    { projectId, query: "malformedneedle", unassigned: false, includeArchived: false });
  assert.deepEqual(page.results.map(hit => hit.sessionId), ["malformed-good"]);
  assert.equal(page.limited, true); assert.equal(page.continueAfter, null);
});

test("recency cursors keep tie order, exact retry position and a fixed search snapshot", async () => {
  const projectId = "recency-project", target = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId, label: "Recent" });
  const timestamp = Date.now() - 10_000;
  for (let i = 0; i < 30; i++) {
    const id = `recency-${String(i).padStart(2, "0")}`;
    await native(id, "recencyneedle", { scope: target.scope });
    await getDbExec().execute({ sql: "UPDATE chat_threads SET updated_at=? WHERE id=?", args: [timestamp + i, id] });
  }
  await getDbExec().execute({ sql: "UPDATE chat_threads SET updated_at=? WHERE id=?", args: [timestamp + 1, "recency-00"] });
  const { searchChatContent } = await import("../server/chat-content-search.ts");
  const actor = { ownerEmail: owner, orgId, identity: target, codeScope: { ...scope, projectId } };
  const input = { projectId, query: "recencyneedle", unassigned: false, includeArchived: false };
  const first = await searchChatContent(actor, input);
  assert.deepEqual(first.results.map(hit => hit.sessionId), Array.from({ length: 25 }, (_, i) => `recency-${String(29 - i).padStart(2, "0")}`));
  assert.equal(first.searchedSessions, 25);
  const after = first.continueAfter!;
  const second = await searchChatContent(actor, { ...input, after });
  const retry = await searchChatContent(actor, { ...input, after });
  assert.deepEqual(retry.results, second.results);
  assert.equal(second.searchedSessions, 30);
  assert.deepEqual(second.results.map(hit => hit.sessionId), ["recency-04", "recency-03", "recency-02", "recency-00", "recency-01"]);
  await native("recency-newer", "recencyneedle", { scope: target.scope });
  await getDbExec().execute({ sql: "UPDATE chat_threads SET updated_at=? WHERE id=?", args: [Date.now() + 1000, "recency-newer"] });
  assert.deepEqual((await searchChatContent(actor, { ...input, after })).results, second.results, "New sessions wait for a fresh search");
  for (const [id, time] of [["recent-code-a", timestamp], ["recent-code-b", timestamp], ["recent-code-z", timestamp + 1]] as const) {
    run(id, { projectId }); updateCodeAgentRunRecord(id, { updatedAt: new Date(time).toISOString() });
    await writeFile(codeAgentRunTranscriptPath(id), JSON.stringify({ id: `evt-${id}`, runId: id, kind: "user", message: "codeorderneedle" }) + "\n");
  }
  let cursor: string | undefined, codeHits: string[] = [];
  for (let i = 0; i < 5; i++) {
    const page = await searchChatContent(actor, { ...input, query: "codeorderneedle", after: cursor });
    codeHits.push(...page.results.map(hit => hit.sessionId)); if (!page.continueAfter) break; cursor = page.continueAfter;
  }
  assert.deepEqual(codeHits, ["recent-code-z", "recent-code-a", "recent-code-b"]);
});


test("anchored Code replay applies normal assistant dedupe while retaining the matching stable event", async () => {
  const projectId = "context-project", id = "context-code";
  run(id, { projectId });
  const events = [
    { id: "evt-context-user", kind: "user", message: "Earlier question" },
    { id: "evt-context-match", kind: "system", message: "Context reply", metadata: { role: "assistant", itemId: "reply" } },
    { id: "evt-context-duplicate", kind: "system", message: "Context reply", metadata: { role: "assistant", itemId: "reply" } },
    { id: "evt-context-later", kind: "user", message: "Later follow-up" },
  ].map(event => ({ schemaVersion: 1, runId: id, createdAt: "2026-01-01T00:00:00Z", ...event }));
  const lines = events.map(event => JSON.stringify(event) + "\n");
  await writeFile(codeAgentRunTranscriptPath(id), lines.join(""));
  const { getVivaryCodeState } = await import("../server/local-code-agent.ts");
  const opened = await getVivaryCodeState(owner, id, { ...scope, projectId }, orgId, undefined,
    { eventId: "evt-context-match", eventOffset: Buffer.byteLength(lines[0]) });
  assert.deepEqual(opened.run?.events.map(event => event.id), ["evt-context-user", "evt-context-match", "evt-context-later"]);
  const latest = await getVivaryCodeState(owner, id, { ...scope, projectId }, orgId);
  assert.deepEqual(latest.run?.events.map(event => event.id), ["evt-context-user", "evt-context-duplicate", "evt-context-later"]);
});
