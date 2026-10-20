import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Concurrent Code conversations. Several conversations run at once, in one project or many, with Claude Code and
// Codex side by side. One conversation runs one turn at a time. A send beside another agent in an overlapping folder
// needs the owner's acknowledgement of the shared-folder warning. The first tests use an IPC-only worker. The last one
// runs the real coding worker with fake Claude Code and Codex executables, so no provider is reached.
const workbench = path.join(import.meta.dirname, "..");
const root = await mkdtemp(path.join(tmpdir(), "vivary-code-concurrency-"));
const database = `file:${path.join(root, "state.sqlite")}`;
const original = { // guard:allow-env-credential - Saved fixture names, restored after the suite.
  DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  // guard:allow-env-credential - Saved test mode flag and fixture store path, restored after the suite.
  VIVARY_ACCESS_MODE: process.env.VIVARY_ACCESS_MODE, AGENT_NATIVE_CODE_AGENTS_HOME: process.env.AGENT_NATIVE_CODE_AGENTS_HOME,
  // guard:allow-env-credential - Saved search path, restored after the suite.
  PATH: process.env.PATH,
};
Object.assign(process.env, { DATABASE_URL: database, DATABASE_URL_UNPOOLED: database, // guard:allow-env-credential - Disposable fixture store.
  VIVARY_ACCESS_MODE: "local", AGENT_NATIVE_CODE_AGENTS_HOME: path.join(root, "runs") });
const previousCwd = process.cwd();
after(async () => {
  process.chdir(previousCwd);
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value; // guard:allow-env-credential - Restores the names saved above.
  }
  await rm(root, { recursive: true, force: true });
});

const agent = await import("../server/local-code-agent.ts");
// The tests below that run several conversations at once are not about the limit, so it is above them all.
await agent.setVivaryCodeRunCapacity({ limit: 16, whenFull: "queue" });
const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
const { SHARED_FOLDER_WARNING } = await import("../shared/code-concurrency.ts");
const { getCodeAgentRunRecord, listCodeAgentRunRecords, listCodeAgentTranscriptEvents, updateCodeAgentRunRecord } =
  await import("@agent-native/core/code-agents");
type Workspace = { root: string; label: string; projectId?: string; bindingId?: string; rootId?: string; bindingRevision?: number };
const host = () => Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")) as {
  activeRuns: Map<string, { execution: Promise<void> | null }> };
const owner = { ownerEmail: "concurrent@example.test", orgId: "concurrent-org" };

function project(folder: string, id: string): Workspace {
  return { root: folder, label: path.basename(folder), projectId: id, bindingId: `${id}-binding`, rootId: `${id}-root`,
    bindingRevision: 1 };
}

async function waitFor<T>(read: () => Promise<T> | T, label: string, attempts = 400): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function hostRuns() {
  return (await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).activeRuns;
}

async function settle(runId: string) {
  const execution = host().activeRuns.get(runId)?.execution;
  if (execution) {
    await agent.stopVivaryCodeRun({ ...owner, runId, projectId: getCodeAgentRunRecord(runId)?.metadata?.projectId as string })
      .catch(() => undefined);
    await execution;
  }
}

// Ready runtimes for both engines. The fake Codex answers discovery only. The IPC worker never starts a CLI.
async function readyBin(bin: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "claude"), `#!${process.execPath}
const args = JSON.stringify(process.argv.slice(2));
if (args === '["--version"]') { process.stdout.write("2.1.300 (Claude Code)\\n"); process.exit(0); }
if (args === '["auth","status","--json"]') {
  process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  await writeFile(path.join(bin, "codex"), `#!${process.execPath}
import { createInterface } from "node:readline";
if (process.argv[2] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") emit({ id: message.id, result: {} });
  if (message.method === "account/read") emit({ id: message.id, result: { account: { type: "chatgpt" } } });
  if (message.method === "config/read") emit({ id: message.id, result: { config: { model_provider: "openai" } } });
  if (message.method === "model/list") emit({ id: message.id, result: { data: [
    { model: "gpt-6-astra", displayName: "Astra", isDefault: true }], nextCursor: null } });
});
`, { mode: 0o755 });
}

// The IPC worker. A request that starts with "Ask" sends Codex request 17, as every Codex session numbers its first
// request, then finishes once answered. One that starts with "Finish" finishes at once. Anything else works until
// stopped. A follow-up prompt quotes earlier messages, so only its last line is the current request.
const IPC_WORKER = `
import { appendFileSync, writeFileSync } from "node:fs";
let runId;
process.on("message", message => {
  if (message.type === "vivary:code-worker:abort") process.exit(0);
  if (message.type === "vivary:code-worker:start") {
    runId = message.runId;
    appendFileSync("starts.jsonl", JSON.stringify({ runId, prompt: message.prompt, model: message.model }) + "\\n");
    const request = message.prompt.split("\\n").at(-1);
    if (request.startsWith("Finish")) process.send({ type: "vivary:code-worker:done", runId });
    if (request.startsWith("Ask")) process.send({ type: "vivary:code-worker:request", runId,
      request: { requestId: "17", method: "item/commandExecution/requestApproval", params: { command: "read " + runId } } });
  }
  if (message.type === "vivary:code-worker:response") {
    writeFileSync("response-" + runId + ".json", JSON.stringify(message));
    process.send({ type: "vivary:code-worker:resolved", runId, requestId: message.requestId });
    process.send({ type: "vivary:code-worker:done", runId });
  }
});
process.send({ type: "vivary:code-worker:ready" });
`;

async function ipcFixture(name: string) {
  const fixture = await mkdtemp(path.join(root, `${name}-`));
  await mkdir(path.join(fixture, ".output", "server"), { recursive: true });
  await writeFile(path.join(fixture, ".output", "server", "vivary-code-worker.mjs"), IPC_WORKER);
  await readyBin(path.join(fixture, "bin"));
  process.chdir(fixture);
  process.env.PATH = path.join(fixture, "bin") + path.delimiter + (original.PATH ?? ""); // guard:allow-env-credential - Fixture CLIs first.
  assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
  assert.equal((await getVivaryRuntimeStatus("codex-cli", { refresh: true })).status, "ready");
  const folder = path.join(fixture, "project");
  await mkdir(folder);
  return { fixture, folder };
}

const send = (workspace: Workspace, message: string, extra: Partial<Parameters<typeof agent.sendVivaryCodeMessage>[0]> = {}) =>
  agent.sendVivaryCodeMessage({ ...owner, workspace, message, engine: "claude-cli", model: "claude-sonnet-5-5",
    revalidateWorkspace: async () => workspace, ...extra });
const codex = { engine: "codex-cli" as const, model: "gpt-6-astra" };

test("Claude Code and Codex conversations run in one project with their own approvals, routing, and Stop", { timeout: 120_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture, folder } = await ipcFixture("same-project");
  const workspace = project(folder, "same_project");
  const started: string[] = [];
  try {
    const claude = (await send(workspace, "Claude works here")).run!.id;
    started.push(claude);
    const records = listCodeAgentRunRecords("vivary-local-code").length;
    await assert.rejects(send(workspace, "Ask from Codex first", codex), (error: Error & { errorCode?: string; statusCode?: number }) => {
      assert.equal(error.errorCode, "vivary_code_shared_folder_active");
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, `${SHARED_FOLDER_WARNING} Working in this folder: "Claude works here".`);
      return true;
    });
    assert.equal(listCodeAgentRunRecords("vivary-local-code").length, records, "a refused send writes no run");
    const first = (await send(workspace, "Ask from Codex first", { ...codex, acknowledgeSharedFolder: true })).run!.id;
    started.push(first);
    const second = (await send(workspace, "Ask from Codex second", { ...codex, acknowledgeSharedFolder: true })).run!.id;
    started.push(second);

    const runs = await waitFor(async () => {
      const current = await hostRuns();
      return current.filter(run => run.pendingApprovals.length).length === 2 && current;
    }, "both Codex requests");
    assert.deepEqual(runs.map(run => [run.id, run.engineLabel, run.model, run.pendingApprovals.map(item => item.requestId)]), [
      [claude, "Claude Code", "claude-sonnet-5-5", []], [first, "Codex CLI", "gpt-6-astra", ["17"]],
      [second, "Codex CLI", "gpt-6-astra", ["17"]]], "each run lists only its own request, in start order");
    const state = await agent.getVivaryCodeState(owner.ownerEmail, first, workspace, owner.orgId);
    assert.equal(state.busy, true, "busy is the selected conversation's");
    assert.deepEqual(state.folderRuns.map(run => run.title), ["Claude works here", "Ask from Codex first", "Ask from Codex second"]);

    // Approving request 17 of one run answers that run only.
    await agent.approveVivaryCodeMessage({ ...owner, runId: second, requestId: "17", workspace,
      revalidateWorkspace: async () => workspace });
    await waitFor(() => !host().activeRuns.has(second), "the approved run to finish");
    const answered = JSON.parse(await readFile(path.join(fixture, `response-${second}.json`), "utf8"));
    assert.equal(answered.result.decision, "accept");
    assert.equal(existsSync(path.join(fixture, `response-${first}.json`)), false, "the other run's worker got no answer");
    assert.deepEqual((await hostRuns()).map(run => [run.id, run.pendingApprovals.length]), [[claude, 0], [first, 1]]);

    // A stale route never answers: the finished run's request, or a run that has no such request.
    await assert.rejects(agent.approveVivaryCodeMessage({ ...owner, runId: second, requestId: "17", workspace }),
      { statusCode: 409 });
    await assert.rejects(agent.denyVivaryCodeMessage({ ...owner, runId: claude, requestId: "17", projectId: workspace.projectId }),
      { errorCode: "vivary_code_approval_stale" });

    // Stopping one conversation leaves the others running, with the other request still pending.
    await agent.stopVivaryCodeRun({ ...owner, runId: claude, projectId: workspace.projectId });
    await host().activeRuns.get(claude)?.execution;
    assert.equal(getCodeAgentRunRecord(claude)?.status, "paused");
    assert.deepEqual((await hostRuns()).map(run => [run.id, run.pendingApprovals.length]), [[first, 1]]);

    await agent.denyVivaryCodeMessage({ ...owner, runId: first, requestId: "17", projectId: workspace.projectId });
    await waitFor(() => !host().activeRuns.has(first), "the declined run to finish");
    assert.equal(JSON.parse(await readFile(path.join(fixture, `response-${first}.json`), "utf8")).result.decision, "decline");

    // Each worker received its own conversation's request, and each transcript holds only its own messages.
    const starts = (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(starts.map(start => [start.runId, start.prompt, start.model]), [[claude, "Claude works here", "claude-sonnet-5-5"],
      [first, "Ask from Codex first", "gpt-6-astra"], [second, "Ask from Codex second", "gpt-6-astra"]]);
    for (const [runId, message] of [[claude, "Claude works here"], [first, "Ask from Codex first"], [second, "Ask from Codex second"]]) {
      assert.deepEqual(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").map(event => event.message), [message]);
    }
    assert.deepEqual(await hostRuns(), []);
  } finally {
    for (const runId of started) await settle(runId);
  }
});

test("two simultaneous sends into one conversation start one turn", { timeout: 60_000, skip: process.platform === "win32" },
  async () => {
    const { fixture, folder } = await ipcFixture("race");
    const workspace = project(folder, "race_project");
    const runId = (await send(workspace, "Finish the first turn")).run!.id;
    await waitFor(() => !host().activeRuns.has(runId), "the first turn to finish");
    try {
      const results = await Promise.allSettled([send(workspace, "Next turn one", { runId }), send(workspace, "Next turn two", { runId })]);
      assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
      const refused = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      assert.equal(refused.reason.errorCode, "vivary_code_conversation_active");
      assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").length, 2,
        "only the turn that started was appended");
      const starts = async () => (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n").length;
      await waitFor(async () => await starts() >= 2, "the started turn's worker");
      await delay(250);
      assert.equal(await starts(), 2, "one worker started for the two sends");
      // A stopping turn still holds its conversation.
      await agent.stopVivaryCodeRun({ ...owner, runId, projectId: workspace.projectId });
      if (host().activeRuns.has(runId)) {
        await assert.rejects(send(workspace, "While stopping", { runId }),
          { errorCode: "vivary_code_conversation_active", message: /still stopping/ });
      }
    } finally { await settle(runId); }
  });

test("another owner's run in the folder shows no run ID, and its ID refuses as an unowned run", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { folder } = await ipcFixture("foreign");
  const workspace = project(folder, "foreign_project");
  const other = { ownerEmail: "other-owner@example.test", orgId: owner.orgId };
  const foreign = (await send(workspace, "Another owner works here", other)).run!.id;
  try {
    const state = await agent.getVivaryCodeState(owner.ownerEmail, undefined, workspace, owner.orgId);
    assert.equal(state.folderRuns.length, 1);
    assert.equal(state.folderRuns[0].title, null);
    assert.notEqual(state.folderRuns[0].id, foreign);
    assert.equal(JSON.stringify(state).includes(foreign), false, "the state payload names no foreign run ID");
    const again = await agent.getVivaryCodeState(owner.ownerEmail, undefined, workspace, owner.orgId);
    assert.equal(again.folderRuns[0].id, state.folderRuns[0].id, "the placeholder stays the same, so Proceed still covers it");
    const records = listCodeAgentRunRecords("vivary-local-code").length;
    for (const extra of [{}, { acknowledgeSharedFolder: true }]) {
      await assert.rejects(send(workspace, "Into their conversation", { runId: foreign, ...extra }),
        { errorCode: "vivary_code_run_not_found", statusCode: 404 });
    }
    assert.equal(listCodeAgentRunRecords("vivary-local-code").length, records, "a refused send writes no run");
    assert.equal(listCodeAgentTranscriptEvents(foreign).filter(event => event.kind === "user").length, 1);
  } finally {
    await agent.stopVivaryCodeRun({ ...other, runId: foreign, projectId: workspace.projectId }).catch(() => undefined);
    await host().activeRuns.get(foreign)?.execution;
  }
});

test("listOwnedVivaryCodeRuns lists the caller's runs in every project, most recently updated first", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { folder } = await ipcFixture("owned-list");
  const other = { ownerEmail: "list-other@example.test", orgId: owner.orgId };
  const finished = async (state: Awaited<ReturnType<typeof send>>) => {
    const runId = state.run!.id;
    await waitFor(() => !host().activeRuns.has(runId), "the turn to finish");
    return runId;
  };
  const first = await finished(await send(project(folder, "owned_one"), "Finish in one project"));
  const second = await finished(await send(project(folder, "owned_two"), "Finish in another", codex));
  const theirs = await finished(await send(project(folder, "owned_one"), "Finish as another owner", other));
  const listed = agent.listOwnedVivaryCodeRuns(owner.ownerEmail, owner.orgId);
  const ids = listed.map(run => run.id);
  assert.ok(ids.includes(first) && ids.includes(second), "runs from both projects");
  assert.equal(ids.includes(theirs), false, "another owner's run is not listed");
  assert.ok(listed.every(run => run.metadata?.ownerEmail === owner.ownerEmail && run.metadata?.orgId === owner.orgId));
  assert.deepEqual(listed.map(run => run.updatedAt), listed.map(run => run.updatedAt).sort().reverse());
  assert.equal(agent.listOwnedVivaryCodeRuns(owner.ownerEmail, "another-org").some(run => ids.includes(run.id)), false);
  assert.deepEqual(agent.listOwnedVivaryCodeRuns(other.ownerEmail, other.orgId).map(run => run.id), [theirs]);
  const codexRun = listed.find(run => run.id === second)!;
  assert.deepEqual([agent.engineLabelFromRun(codexRun), agent.modelFromRun(codexRun)], ["Codex CLI", "gpt-6-astra"]);
});

test("a second send into a working conversation is refused, with or without the shared-folder acknowledgement",
  { timeout: 60_000, skip: process.platform === "win32" }, async () => {
    const { fixture, folder } = await ipcFixture("second-send");
    const workspace = project(folder, "second_send_project");
    const runId = (await send(workspace, "Work until stopped")).run!.id;
    try {
      const starts = async () => (await readFile(path.join(fixture, "starts.jsonl"), "utf8").catch(() => "")).trim().split("\n")
        .filter(Boolean).length;
      await waitFor(async () => await starts() >= 1, "the first turn's worker");
      for (const extra of [{}, { acknowledgeSharedFolder: true }]) {
        await assert.rejects(send(workspace, "Overlapping send", { runId, ...extra }),
          { errorCode: "vivary_code_conversation_active", statusCode: 409 });
      }
      assert.ok(host().activeRuns.has(runId), "the first turn keeps working");
      const turnOf = async () => (await agent.getVivaryCodeState(owner.ownerEmail, undefined, workspace, owner.orgId))
        .folderRuns.find(run => run.id === runId)?.turnId;
      const firstTurn = await turnOf();
      assert.ok(firstTurn);
      assert.equal(await turnOf(), firstTurn, "a turn keeps its identity while it works");
      assert.deepEqual(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").map(event => event.message),
        ["Work until stopped"]);
      await delay(250);
      assert.equal(await starts(), 1, "no second worker started");
      await settle(runId);
      await send(workspace, "Work again until stopped", { runId });
      const secondTurn = await turnOf();
      assert.ok(secondTurn && secondTurn !== firstTurn, "the next turn of the same conversation has a new turn identity");
    } finally { await settle(runId); }
  });

test("Stop leaves alone a run whose own cleanup refusal is in force while an older refusal is the host's", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { folder } = await ipcFixture("refusals");
  const older = (await send(project(folder, "refusal_one"), "Work one")).run!.id;
  const newer = (await send(project(folder, "refusal_two"), "Work two", { acknowledgeSharedFolder: true })).run!.id;
  const refusal = (refusedAt: string) => ({ target: null, remaining: [], total: 0, fingerprint: null, hidden: false,
    scan: "unavailable", step: null, refusedAt, checkedAt: refusedAt, ends: [] });
  const state = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")) as { cleanup: unknown;
    activeRuns: Map<string, { stopReason: string | null }> };
  try {
    updateCodeAgentRunRecord(older, { metadata: { cleanupRefusal: refusal("2026-01-01T00:00:00.000Z") } });
    updateCodeAgentRunRecord(newer, { metadata: { cleanupRefusal: refusal("2026-01-02T00:00:00.000Z") } });
    // The host holds the oldest refusal only, as reloadCleanup sets it.
    state.cleanup = { runId: older, ...refusal("2026-01-01T00:00:00.000Z") };
    await agent.stopVivaryCodeRun({ ...owner, runId: newer, projectId: "refusal_two" });
    assert.equal(state.activeRuns.get(newer)?.stopReason, null, "the newer run's own refusal holds its Stop");
    assert.notEqual(getCodeAgentRunRecord(newer)?.phase, "stopping");
  } finally {
    for (const runId of [older, newer]) updateCodeAgentRunRecord(runId, { metadata: { cleanupRefusal: undefined } });
    state.cleanup = null;
    await settle(older);
    await settle(newer);
  }
});


// Capacity. A host-wide limit on running turns, with a first in, first out queue or a refusal beyond it.
const capacityHost = () => Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")) as {
  activeRuns: Map<string, unknown>; queue: unknown[]; reserved: number; initialization: Promise<void> | null };

async function folders(fixture: string, ...names: string[]) {
  const made: string[] = [];
  for (const name of names) {
    const folder = path.join(fixture, name);
    await mkdir(folder, { recursive: true });
    made.push(folder);
  }
  return made;
}

/** Cancels whatever still waits, so nothing starts behind the test, then stops whatever runs. */
async function endAll(runIds: string[]) {
  for (const runId of runIds) {
    const projectId = getCodeAgentRunRecord(runId)?.metadata?.projectId as string | undefined;
    await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId, projectId }).catch(() => undefined);
  }
  await waitFor(() => capacityHost().reserved === 0, "queued starts to settle");
  for (const runId of runIds) await settle(runId);
  await agent.setVivaryCodeRunCapacity({ limit: 16, whenFull: "queue" });
}

const userMessages = (runId: string) => listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user")
  .map(event => event.message);
const startedRuns = async (fixture: string) => (await readFile(path.join(fixture, "starts.jsonl"), "utf8").catch(() => ""))
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line).runId as string);

test("a full host queues sends and starts them first in, first out as slots free", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-fifo");
  const [a, b, c, d] = await folders(fixture, "a", "b", "c", "d");
  await agent.setVivaryCodeRunCapacity({ limit: 2, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "cap_a"), "Work in a")).run!.id);
    runs.push((await send(project(b, "cap_b"), "Work in b", codex)).run!.id);
    const queued = await send(project(c, "cap_c"), "Work in c");
    runs.push(queued.run!.id);
    assert.deepEqual([queued.run!.status, queued.run!.queue], ["queued", { state: "queued", position: 1, reason: null }]);
    runs.push((await send(project(d, "cap_d"), "Work in d", codex)).run!.id);
    const [runA, runB, runC, runD] = runs;
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual(state.capacity, { limit: 2, whenFull: "queue", running: 2, queued: 2, held: 0 });
    assert.deepEqual(state.queuedRuns.map(run => [run.id, run.state, run.position]), [[runC, "queued", 1], [runD, "queued", 2]]);
    assert.deepEqual(userMessages(runC), [], "a queued turn writes no transcript entry before it starts");

    await settle(runA);
    await waitFor(() => capacityHost().activeRuns.has(runC), "the first queued turn to start");
    assert.equal(capacityHost().activeRuns.has(runD), false, "the second still waits");
    assert.equal((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns[0].position, 1);
    await settle(runB);
    await waitFor(() => capacityHost().activeRuns.has(runD), "the second queued turn to start");
    await waitFor(async () => (await startedRuns(fixture)).length === 4, "four workers");
    assert.deepEqual(await startedRuns(fixture), [runA, runB, runC, runD], "workers start in send order");
    assert.deepEqual(userMessages(runC), ["Work in c"]);
  } finally { await endAll(runs); }
});

test("Cancel removes a queued message, starts nothing, and puts the message back in its draft", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-cancel");
  const [a, b] = await folders(fixture, "a", "b");
  const { runWithRequestContext } = await import("@agent-native/core/server");
  const { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } = await import("../server/chat-draft.ts");
  const { restoreQueuedCodeDraft } = await import("../server/code-queue-draft.ts");
  const asOwner = <T>(work: () => Promise<T>) => runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, work);
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const identity = createCodeDraftIdentity(owner.ownerEmail, owner.orgId, "cap_draft");
  const threadId = "vivary-code:project:cap_draft:queued-draft";
  const submitId = "5c0d6d1e-6a8e-4f62-9a53-2f8f6f1b4a10";
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "cap_running"), "Work in a")).run!.id);
    await asOwner(() => changeIndexedChatDraft(identity, threadId, null, { text: "Queued words", status: "pending", submitId }));
    const queued = (await send(project(b, "cap_draft"), "Queued words", { draftSubmitId: submitId, draftThreadId: threadId })).run!.id;
    runs.push(queued);
    const cancelled = await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "cap_draft" });
    assert.equal(await asOwner(() => restoreQueuedCodeDraft(owner.ownerEmail, owner.orgId, cancelled)), true);
    const draft = await asOwner(() => readChatDraft(identity, threadId));
    assert.deepEqual([draft?.status, draft?.text, draft?.submitId], ["draft", "Queued words", null]);
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual([state.queuedRuns, state.capacity.queued], [[], 0]);
    assert.equal(agent.listOwnedVivaryCodeRuns(owner.ownerEmail, owner.orgId).some(run => run.id === queued), false,
      "a conversation that never started is not listed");
    await settle(runs[0]);
    await delay(250);
    assert.deepEqual(await startedRuns(fixture), [runs[0]], "the cancelled message never started");
    assert.deepEqual(userMessages(queued), []);
  } finally { await endAll(runs); }
});

test("Refuse names the limit and writes nothing, and a queued conversation refuses another send and stops by cancelling",
  { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-refuse");
  const [a, b] = await folders(fixture, "a", "b");
  const runs: string[] = [];
  try {
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "refuse" });
    runs.push((await send(project(a, "refuse_a"), "Work in a")).run!.id);
    const records = listCodeAgentRunRecords("vivary-local-code").length;
    await assert.rejects(send(project(b, "refuse_b"), "Beyond the limit"), (error: Error & { errorCode?: string; statusCode?: number }) => {
      assert.equal(error.errorCode, "vivary_code_capacity_full");
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /limit of 1 coding conversation at once/);
      return true;
    });
    assert.equal(listCodeAgentRunRecords("vivary-local-code").length, records, "a refused send writes no run");

    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    const queued = (await send(project(b, "refuse_b"), "Queued in b")).run!.id;
    runs.push(queued);
    await assert.rejects(send(project(b, "refuse_b"), "A second message", { runId: queued }),
      { errorCode: "vivary_code_conversation_queued", statusCode: 409 });
    await agent.stopVivaryCodeRun({ ...owner, runId: queued, projectId: "refuse_b" });
    assert.equal((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns.length, 0, "Stop cancelled it");
  } finally { await endAll(runs); }
});

test("a restart holds the queue until the owner starts it", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-restart");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "restart_b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "restart_a"), "Work in a")).run!.id);
    const queued = (await send(workspace, "Queued before the restart")).run!.id;
    runs.push(queued);
    // A new host process: the in-memory queue is gone and the host initializes again from the records.
    const state = capacityHost();
    state.queue.length = 0;
    state.initialization = null;
    const restarted = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual(restarted.queuedRuns.map(run => [run.id, run.state, run.position, run.reason]),
      [[queued, "held", null, null]]);
    assert.notEqual(restarted.recentRun?.id, queued, "a held conversation is listed under the queue, not as the recent run");
    assert.deepEqual([getCodeAgentRunRecord(queued)?.status, getCodeAgentRunRecord(queued)?.phase], ["paused", "held"]);
    await settle(runs[0]);
    await delay(250);
    assert.equal(capacityHost().activeRuns.has(queued), false, "a restart starts nothing on its own");

    await agent.resumeQueuedVivaryCodeTurn({ ...owner, workspace, revalidateWorkspace: async () => workspace,
      message: "Queued before the restart", engine: "claude-cli", model: "claude-sonnet-5-5", runId: queued, proceed: false });
    await waitFor(() => capacityHost().activeRuns.has(queued), "the owner's Start");
    assert.deepEqual(userMessages(queued), ["Queued before the restart"]);
  } finally { await endAll(runs); }
});

test("a queued turn whose folder gained an agent since it queued waits for confirmation, then Proceed starts it",
  { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-confirm");
  const [x, w, shared] = await folders(fixture, "x", "w", "shared");
  const later = project(shared, "confirm_later");
  await agent.setVivaryCodeRunCapacity({ limit: 2, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(x, "confirm_x"), "Work in x")).run!.id);
    runs.push((await send(project(w, "confirm_w"), "Work in w")).run!.id);
    // Neither queued turn overlaps a running one when it queues, so neither needs an acknowledgement then.
    runs.push((await send(project(shared, "confirm_first"), "First in the shared folder")).run!.id);
    const waiting = (await send(later, "Second in the shared folder", codex)).run!.id;
    runs.push(waiting);
    await settle(runs[0]);
    await waitFor(() => capacityHost().activeRuns.has(runs[2]), "the first shared-folder turn to start");
    await settle(runs[1]);
    const confirm = await waitFor(async () => (await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns
      .find(run => run.id === waiting && run.state === "needs-confirmation"), "the fresh check to ask");
    assert.equal(confirm.reason, SHARED_FOLDER_WARNING);
    assert.equal(getCodeAgentRunRecord(waiting)?.phase, "needs-confirmation");
    assert.equal(capacityHost().activeRuns.has(waiting), false, "it did not start beside the new agent");
    await agent.resumeQueuedVivaryCodeTurn({ ...owner, workspace: later, revalidateWorkspace: async () => later,
      message: "Second in the shared folder", ...codex, runId: waiting, proceed: true });
    await waitFor(() => capacityHost().activeRuns.has(waiting), "Proceed to start it");
  } finally { await endAll(runs); }
});

test("Stop on a queued message that is starting stops it before it claims its slot", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-stop-starting");
  const [a, b] = await folders(fixture, "a", "b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const workspace = project(b, "starting_b");
  // The queued turn's fresh checks wait here, so the test can press Stop while it is starting.
  let gate: Promise<void> | null = null;
  let open = () => {};
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "starting_a"), "Work in a")).run!.id);
    const queued = (await send(workspace, "Queued in b", { revalidateWorkspace: async () => { await gate; return workspace; } })).run!.id;
    runs.push(queued);
    gate = new Promise(resolve => { open = resolve; });
    const queue = () => capacityHost().queue as { runId: string; state: string }[];
    await settle(runs[0]);
    await waitFor(() => queue().find(item => item.runId === queued)?.state === "starting", "the queued turn to start its checks");
    const stopping = agent.stopVivaryCodeRun({ ...owner, runId: queued, projectId: "starting_b" });
    open();
    await stopping;
    await delay(250);
    assert.equal(capacityHost().activeRuns.has(queued), false, "the stopped turn did not start");
    assert.deepEqual(await startedRuns(fixture), [runs[0]]);
    assert.deepEqual(userMessages(queued), []);
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual([state.queuedRuns, capacityHost().reserved], [[], 0], "the message left the queue and freed its slot");
  } finally { open(); await endAll(runs); }
});

test("Cancel keeps a queued message queued when its draft cannot be restored", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-restore-fails");
  const [a, b] = await folders(fixture, "a", "b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "restore_a"), "Work in a")).run!.id);
    const queued = (await send(project(b, "restore_b"), "Keep these words")).run!.id;
    runs.push(queued);
    await assert.rejects(agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "restore_b",
      restore: async () => { throw new Error("The draft could not be saved."); } }), /draft could not be saved/);
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual(state.queuedRuns.map(run => [run.id, run.state]), [[queued, "queued"]], "the message is still queued");
    const stored = getCodeAgentRunRecord(queued)?.metadata?.queuedTurn as { message?: string } | undefined;
    assert.equal(stored?.message, "Keep these words", "the record still holds the message");
    assert.equal(agent.listOwnedVivaryCodeRuns(owner.ownerEmail, owner.orgId).some(run => run.id === queued), true);
    const cancelled = await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "restore_b",
      restore: async () => true });
    assert.deepEqual([cancelled.message, cancelled.restored], ["Keep these words", true]);
    assert.deepEqual((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns, []);
  } finally { await endAll(runs); }
});

test("a runtime switch, with or without Stop, is refused while the conversation has a queued message", {
  timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-switch-queued");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "switchq_b");
  const runs: string[] = [];
  try {
    const idle = (await send(workspace, "Finish this one")).run!.id;
    runs.push(idle);
    await waitFor(() => !capacityHost().activeRuns.has(idle), "the first turn to finish");
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    runs.push((await send(project(a, "switchq_a"), "Work in a")).run!.id);
    assert.equal((await send(workspace, "Queued follow-up", { runId: idle })).run?.queue?.state, "queued");
    for (const stop of [false, true]) {
      await assert.rejects(agent.switchVivaryCodeRuntime({ ...owner, runId: idle, engine: "codex-cli", model: "gpt-6-astra",
        workspace, stop }), (error: Error & { errorCode?: string; statusCode?: number }) => {
        assert.deepEqual([error.errorCode, error.statusCode], ["vivary_code_switch_queued", 409]);
        assert.match(error.message, /queued message\. Cancel it/);
        return true;
      });
    }
    assert.deepEqual([getCodeAgentRunRecord(idle)?.metadata?.engine, getCodeAgentRunRecord(idle)?.metadata?.model],
      ["claude-cli", "claude-sonnet-5-5"], "the queued turn keeps the route it queued with");
  } finally { await endAll(runs); }
});

test("a send into a conversation whose only queued message was cancelled lists it again", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-discarded");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "discard_b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const listed = (runId: string) => agent.listOwnedVivaryCodeRuns(owner.ownerEmail, owner.orgId).some(run => run.id === runId);
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "discard_a"), "Work in a")).run!.id);
    const queued = (await send(workspace, "First words")).run!.id;
    runs.push(queued);
    await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "discard_b" });
    assert.equal(listed(queued), false, "a conversation that never started is not listed");
    // The view stays on the conversation, so the next send names it. While the host is full, it queues and is listed.
    await send(workspace, "Second words", { runId: queued });
    assert.deepEqual((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns.map(run => run.id), [queued]);
    assert.equal(listed(queued), true);
    // It still never started, so Cancel discards it again.
    await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "discard_b" });
    assert.equal(listed(queued), false);
    await settle(runs[0]);
    await send(workspace, "Third words", { runId: queued });
    await waitFor(() => capacityHost().activeRuns.has(queued), "the conversation to start");
    assert.equal(listed(queued), true, "a started conversation is listed in history");
    assert.deepEqual(userMessages(queued), ["Third words"]);
  } finally { await endAll(runs); }
});

test("Claude Code and Codex in one folder run together under the limit", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { folder } = await ipcFixture("capacity-mixed");
  const workspace = project(folder, "mixed_project");
  await agent.setVivaryCodeRunCapacity({ limit: 3, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(workspace, "Claude here")).run!.id);
    runs.push((await send(workspace, "Codex here", { ...codex, acknowledgeSharedFolder: true })).run!.id);
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual([state.capacity.running, state.capacity.queued], [2, 0]);
    assert.deepEqual(state.activeRuns.map(run => run.engineLabel), ["Claude Code", "Codex CLI"]);
  } finally { await endAll(runs); }
});

test("folders that overlap warn, while separate projects and Git worktrees run without a warning", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture, folder } = await ipcFixture("folders");
  const started: string[] = [];
  try {
    execFileSync("git", ["init", "-q", folder]);
    await writeFile(path.join(folder, "README.md"), "fixture\n");
    execFileSync("git", ["-C", folder, "add", "README.md"]);
    execFileSync("git", ["-C", folder, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", "fixture"]);
    const worktree = path.join(fixture, "project-worktree");
    execFileSync("git", ["-C", folder, "worktree", "add", "-q", worktree]);
    const nested = path.join(folder, "packages", "app");
    await mkdir(nested, { recursive: true });
    const linked = path.join(fixture, "linked-project");
    await symlink(folder, linked);
    const separate = path.join(fixture, "separate");
    await mkdir(separate);

    started.push((await send(project(folder, "main_project"), "Work in the main checkout")).run!.id);
    for (const [label, workspace] of [["a nested folder", project(nested, "nested_project")],
      ["a symbolic link to the folder", project(linked, "linked_project")]] as const) {
      await assert.rejects(send(workspace, "Beside it", codex), { errorCode: "vivary_code_shared_folder_active" }, label);
    }
    for (const [label, workspace] of [["a separate project", project(separate, "separate_project")],
      ["a Git worktree of the same repository", project(worktree, "worktree_project")]] as const) {
      const state = await send(workspace, `Work in ${label}`, codex);
      started.push(state.run!.id);
      assert.deepEqual(state.folderRuns.map(run => run.id), [state.run!.id], `${label} shares no folder`);
    }
    // The containing folder overlaps a run in a nested folder too.
    await settle(started[0]);
    started.push((await send(project(nested, "nested_project"), "Work in the package")).run!.id);
    await assert.rejects(send(project(folder, "main_project"), "Around it"), { errorCode: "vivary_code_shared_folder_active" });
    assert.equal((await hostRuns()).length, 3);
  } finally {
    for (const runId of started) await settle(runId);
  }
});

test("switching one conversation's runtime leaves another running conversation unchanged", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { folder } = await ipcFixture("switch");
  const workspace = project(folder, "switch_project");
  const idle = (await send(workspace, "Finish this one")).run!.id;
  await waitFor(() => !host().activeRuns.has(idle), "the idle conversation's turn");
  const running = (await send(workspace, "Keep working", { acknowledgeSharedFolder: true })).run!.id;
  try {
    const switched = await agent.switchVivaryCodeRuntime({ ...owner, runId: idle, engine: "codex-cli", model: "gpt-6-astra",
      workspace });
    assert.equal(switched.run?.engine, "codex-cli");
    await assert.rejects(agent.switchVivaryCodeRuntime({ ...owner, runId: running, engine: "codex-cli", model: "gpt-6-astra",
      workspace }), { errorCode: "vivary_code_switch_run_active" });
    assert.deepEqual((await hostRuns()).map(run => [run.id, run.engineLabel, run.model]),
      [[running, "Claude Code", "claude-sonnet-5-5"]], "the running conversation keeps its route and keeps running");
    assert.equal(getCodeAgentRunRecord(running)?.metadata?.engine, "claude-cli");
  } finally { await settle(running); }
});

// The real coding worker, with fake Claude Code and Codex executables in the same project folder at the same time.
test("the real worker runs Claude Code and Codex together in one folder with separate output, approvals, and Stop", {
  timeout: 180_000, skip: process.platform === "win32" }, async () => {
  const fixture = await mkdtemp(path.join(root, "real-worker-"));
  const bin = path.join(fixture, "bin");
  const server = path.join(fixture, ".output", "server");
  const folder = path.join(fixture, "project");
  const calls = path.join(fixture, "calls.jsonl");
  const release = path.join(fixture, "release-claude");
  await mkdir(bin, { recursive: true });
  await mkdir(server, { recursive: true });
  await mkdir(folder);
  const prelude = `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const record = value => appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, ...value }) + "\\n");
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
`;
  await writeFile(path.join(bin, "claude"), prelude + `
const args = process.argv.slice(2);
if (JSON.stringify(args) === '["--version"]') { process.stdout.write("2.1.300 (Claude Code)\\n"); process.exit(0); }
if (args[0] === "auth") { emit({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => { prompt += value; });
process.stdin.on("end", () => {
  record({ engine: "claude", cwd: process.cwd() });
  const session_id = "00000000-0000-4000-8000-000000000077";
  emit({ type: "system", subtype: "init", session_id });
  // Works until the test releases it, so the Codex conversation runs beside it.
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(wait);
    emit({ type: "result", subtype: "success", session_id, result: "Claude fixture answer." });
  }, 25);
});
`, { mode: 0o755 });
  await writeFile(path.join(bin, "codex"), prelude + `
import { createInterface } from "node:readline";
if (process.argv[2] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
const threadId = "concurrent-codex-thread";
let turn = 0, turnId;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") emit({ id: message.id, result: {} });
  if (message.method === "account/read") emit({ id: message.id, result: { account: { type: "chatgpt" } } });
  if (message.method === "config/read") emit({ id: message.id, result: { config: { model_provider: "openai" } } });
  if (message.method === "model/list") emit({ id: message.id, result: { data: [
    { model: "gpt-6-astra", displayName: "Astra", isDefault: true }], nextCursor: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    record({ engine: "codex", method: message.method, cwd: message.params.cwd });
    emit({ id: message.id, result: { thread: { id: threadId }, cwd: message.params.cwd, model: "gpt-6-astra",
      modelProvider: "openai", approvalPolicy: message.params.approvalPolicy, approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } } });
  }
  if (message.method === "turn/start") {
    turnId = "concurrent-codex-turn-" + (++turn);
    emit({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    emit({ id: 17, method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "command-" + turn, command: "list files", cwd: process.cwd(), reason: "Fixture" } });
  }
  if (message.id === 17 && message.result) {
    record({ engine: "codex", decision: message.result.decision });
    emit({ method: "serverRequest/resolved", params: { threadId, requestId: 17 } });
    emit({ method: "item/completed", params: { threadId, turnId,
      item: { id: "answer-" + turn, type: "agentMessage", phase: "final_answer", text: "Codex fixture answer." } } });
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
  if (message.method === "turn/interrupt") {
    emit({ id: message.id, result: {} });
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
  }
});
`, { mode: 0o755 });
  const coreModules = ["server", "code-agents", "audit", "db", "mcp-client", "secrets", "settings", "terminal/server"]
    .map(entry => import.meta.resolve(`@agent-native/core/${entry}`));
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
await Promise.all(${JSON.stringify(coreModules)}.map(entry => import(entry)));
register();
await import(${JSON.stringify(pathToFileURL(path.join(workbench, "server", "code-execution-worker.ts")).href)});
`);
  process.chdir(fixture);
  process.env.PATH = bin + path.delimiter + (original.PATH ?? ""); // guard:allow-env-credential - Fixture CLIs first.
  assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
  assert.equal((await getVivaryRuntimeStatus("codex-cli", { refresh: true })).status, "ready");
  const workspace = project(folder, "real_project");
  const transcript = (runId: string) => listCodeAgentTranscriptEvents(runId).map(event => event.message).join("\n");
  const started: string[] = [];
  try {
    const claude = (await send(workspace, "Claude, review the parser")).run!.id;
    started.push(claude);
    const codexRun = (await send(workspace, "Codex, list the files", { ...codex, acknowledgeSharedFolder: true })).run!.id;
    started.push(codexRun);
    let runs = await waitFor(async () => {
      const current = await hostRuns();
      return current.find(run => run.id === codexRun)?.pendingApprovals.length === 1 && current;
    }, "the Codex request", 600);
    assert.deepEqual(runs.map(run => [run.id, run.engineLabel, run.pendingApprovals.length]),
      [[claude, "Claude Code", 0], [codexRun, "Codex CLI", 1]]);

    // Approving the Codex request finishes Codex only. Claude Code keeps working.
    await agent.approveVivaryCodeMessage({ ...owner, runId: codexRun, requestId: runs[1].pendingApprovals[0].requestId,
      workspace, revalidateWorkspace: async () => workspace });
    await waitFor(() => !host().activeRuns.has(codexRun), "the Codex turn to finish", 600);
    assert.equal(getCodeAgentRunRecord(codexRun)?.status, "completed", String(getCodeAgentRunRecord(codexRun)?.metadata?.executionError));
    assert.match(transcript(codexRun), /Codex fixture answer\./);
    assert.deepEqual((await hostRuns()).map(run => run.id), [claude], "Claude Code is still working");

    // A second Codex turn waits for approval, and Stop ends it while Claude Code keeps working.
    await send(workspace, "Codex, one more look", { ...codex, runId: codexRun, acknowledgeSharedFolder: true });
    runs = await waitFor(async () => {
      const current = await hostRuns();
      return current.find(run => run.id === codexRun)?.pendingApprovals.length === 1 && current;
    }, "the second Codex request", 600);
    await agent.stopVivaryCodeRun({ ...owner, runId: codexRun, projectId: workspace.projectId });
    await host().activeRuns.get(codexRun)?.execution;
    assert.equal(getCodeAgentRunRecord(codexRun)?.status, "paused");
    assert.deepEqual((await hostRuns()).map(run => run.id), [claude], "stopping Codex left Claude Code running");

    await writeFile(release, "");
    await waitFor(() => !host().activeRuns.has(claude), "the Claude Code turn to finish", 600);
    assert.equal(getCodeAgentRunRecord(claude)?.status, "completed", String(getCodeAgentRunRecord(claude)?.metadata?.executionError));
    assert.match(transcript(claude), /Claude fixture answer\./);
    assert.doesNotMatch(transcript(claude), /Codex/, "Claude Code's transcript holds none of the Codex output");
    assert.doesNotMatch(transcript(codexRun), /Claude fixture answer|review the parser/);

    const recorded = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(recorded.filter(call => call.decision).map(call => call.decision), ["accept"], "one approval reached Codex");
    assert.ok(recorded.filter(call => call.cwd).every(call => call.cwd === folder), "both runtimes worked in the same folder");
    for (const pid of new Set<number>(recorded.map(call => call.pid))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await writeFile(release, "").catch(() => undefined);
    for (const runId of started) await settle(runId);
  }
});
