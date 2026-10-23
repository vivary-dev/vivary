import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import fs, { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
const { changeCodeConversation, loadConversationInbox } = await import("../server/conversation-inbox.ts");
const { withCodeConversationAdmission } = await import("../server/conversation-admission.ts");
const { runWithRequestContext } = await import("@agent-native/core/server");
// The tests below that run several conversations at once are not about the limit, so it is above them all.
await agent.setVivaryCodeRunCapacity({ limit: 16, whenFull: "queue" });
const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
const { SHARED_FOLDER_WARNING } = await import("../shared/code-concurrency.ts");
const { getCodeAgentRunRecord, listCodeAgentRunRecords, listCodeAgentTranscriptEvents, updateCodeAgentRunRecord } =
  await import("@agent-native/core/code-agents");
const { appStateGet, appStateList, appStateCompareAndSet } = await import("@agent-native/core/application-state");
const { getDbExec } = await import("@agent-native/core/db");
const QUEUE_PAYLOAD_PREFIX = "vivary-code-queue-payload-v1:";
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

const changeArchive = (workspace: Workspace, runId: string, operation: "archive" | "restore") =>
  runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, () => changeCodeConversation({
    ...owner, runId, projectId: workspace.projectId ?? null, resolveScope: async () => workspace, change: { operation } }));

test("archive refuses a real Code send without draft IDs until Restore, and a working send refuses archive", {
  timeout: 60_000, skip: process.platform === "win32",
}, async () => {
  const { fixture, folder } = await ipcFixture("archive-send-orders");
  const workspace = project(folder, "archive_send_orders");
  const runId = (await send(workspace, "Finish the original turn")).run!.id;
  await waitFor(() => !host().activeRuns.has(runId), "the original turn to finish");
  const before = listCodeAgentTranscriptEvents(runId);
  const startsBefore = await readFile(path.join(fixture, "starts.jsonl"), "utf8");
  try {
    await changeArchive(workspace, runId, "archive");
    const archived = getCodeAgentRunRecord(runId);
    // Neither optional draftThreadId nor draftSubmitId is supplied by this real send.
    await assert.rejects(send(workspace, "A refused archived turn", { runId }),
      { statusCode: 409, errorCode: "vivary_conversation_archived" });
    assert.deepEqual(getCodeAgentRunRecord(runId), archived, "a refused send leaves the durable run untouched");
    assert.deepEqual(listCodeAgentTranscriptEvents(runId), before, "no refused user message enters the transcript");
    assert.equal(host().activeRuns.has(runId), false, "no worker slot is claimed");
    assert.equal(await readFile(path.join(fixture, "starts.jsonl"), "utf8"), startsBefore, "no worker starts");

    await changeArchive(workspace, runId, "restore");
    const accepted = await send(workspace, "Work after Restore", { runId });
    assert.equal(accepted.run?.id, runId);
    await waitFor(async () => (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n").length === 2,
      "the restored turn's worker");
    const working = listCodeAgentTranscriptEvents(runId);
    await assert.rejects(changeArchive(workspace, runId, "archive"),
      (error: { statusCode?: number; errorCode?: string; message: string }) => error.statusCode === 409
        && error.errorCode === "vivary_conversation_archive_pending" && /is working/.test(error.message));
    assert.equal(getCodeAgentRunRecord(runId)?.metadata?.archivedAt ?? null, null, "send first keeps the conversation open");
    assert.equal(host().activeRuns.has(runId), true, "archive never stops the admitted worker");
    assert.deepEqual(listCodeAgentTranscriptEvents(runId), working);
    assert.deepEqual(working.filter(event => event.kind === "user").map(event => event.message),
      ["Finish the original turn", "Work after Restore"]);
  } finally { await settle(runId); }
});

for (const change of ["revoke", "replace-binding"] as const) {
  test(`Code send rechecks a live ${change} after waiting for archive admission`, {
    timeout: 60_000, skip: process.platform === "win32",
  }, async () => {
    const { fixture, folder } = await ipcFixture(`archive-wait-${change}`);
    const workspace = project(folder, `archive_wait_${change.replaceAll("-", "_")}`);
    const runId = (await send(workspace, "Finish before the grant changes")).run!.id;
    await waitFor(() => !host().activeRuns.has(runId), "the first turn to finish");
    const before = listCodeAgentTranscriptEvents(runId);
    const startsBefore = await readFile(path.join(fixture, "starts.jsonl"), "utf8");
    let releaseAdmission = () => {}, reachedRuntime = () => {};
    const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const runtimeReady = new Promise<void>(resolve => { reachedRuntime = resolve; });
    let enteredAdmission = () => {};
    const held = new Promise<void>(resolve => { enteredAdmission = resolve; });
    const blocker = withCodeConversationAdmission(owner.ownerEmail, owner.orgId, workspace.projectId ?? null, async () => {
      enteredAdmission();
      await admissionGate;
    });
    let live: Workspace | undefined = workspace;
    let pending: ReturnType<typeof send> | undefined;
    try {
      await held;
      pending = send(workspace, "A turn whose grant changed while waiting", { runId,
        revalidateWorkspace: async () => live,
        loadLinkedContext: async () => { reachedRuntime(); return null; } });
      const refused = assert.rejects(pending, { statusCode: 409, errorCode: "vivary_code_project_changed" });
      await runtimeReady;
      // Runtime/credential awaits have finished. Drain the remaining resolved callbacks so the send is waiting on
      // the held scope admission; no actor is injected into an archive or storage callback.
      await new Promise<void>(resolve => setImmediate(resolve));
      live = change === "revoke" ? undefined : { ...workspace, bindingId: "replacement-binding", bindingRevision: 2 };
      releaseAdmission();
      await blocker;
      await refused;
      assert.deepEqual(listCodeAgentTranscriptEvents(runId), before, "a stale live grant appends no user message");
      assert.equal(host().activeRuns.has(runId), false, "a stale live grant starts no worker");
      assert.equal(await readFile(path.join(fixture, "starts.jsonl"), "utf8"), startsBefore);
      live = workspace;
      await send(workspace, "Finish after the live grant returns", { runId, revalidateWorkspace: async () => live });
      await waitFor(() => !host().activeRuns.has(runId), "the admitted recovery turn to finish");
      assert.deepEqual(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").map(event => event.message),
        ["Finish before the grant changes", "Finish after the live grant returns"], "refusal releases the scope lock");
    } finally {
      releaseAdmission();
      await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
      await settle(runId);
    }
  });
}

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
    const expectedStarts = [[claude, "Claude works here", "claude-sonnet-5-5"],
      [first, "Ask from Codex first", "gpt-6-astra"], [second, "Ask from Codex second", "gpt-6-astra"]];
    // Independent workers receive IPC in any order; host admission order is asserted above.
    const byRunId = (left: string[], right: string[]) => left[0]!.localeCompare(right[0]!);
    assert.deepEqual(starts.map(start => [start.runId, start.prompt, start.model]).sort(byRunId), expectedStarts.sort(byRunId));
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
      // Hold signal delivery while checking the real Stop transition. The worker cannot exit between Stop and Send.
      const running = host().activeRuns.get(runId);
      assert.ok(running);
      const controller: unknown = Reflect.get(running, "controller");
      assert.ok(controller instanceof AbortController);
      const abort = controller.abort;
      let abortRequests = 0;
      controller.abort = () => { abortRequests += 1; };
      try {
        await agent.stopVivaryCodeRun({ ...owner, runId, projectId: workspace.projectId });
        assert.equal(abortRequests, 1, "Stop requests signal delivery once");
        assert.equal(Reflect.get(running, "stopReason"), "user");
        assert.equal(getCodeAgentRunRecord(runId)?.phase, "stopping");
        assert.equal(host().activeRuns.get(runId), running, "the stopping worker still owns its conversation");
        await assert.rejects(send(workspace, "While stopping", { runId }),
          { errorCode: "vivary_code_conversation_active", message: /still stopping/ });
      } finally {
        controller.abort = abort;
        controller.abort();
        await running.execution;
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

async function withQueueRedaction(work: (secret: string) => Promise<void>) {
  const redaction = await import("../server/credential-redaction.ts");
  const { setTextRedactor } = await import("@agent-native/core/audit");
  const previousToken = process.env.VIVARY_PROBE_TOKEN; // guard:allow-env-credential - Preserve the generated test-token slot.
  const generated = randomBytes(24).toString("hex");
  process.env.VIVARY_PROBE_TOKEN = generated; // guard:allow-env-credential - Synthetic credential proves the real redactor runs.
  setTextRedactor(redaction.redactCredentials);
  try {
    await redaction.refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: generated }),
      mcpConfig: () => null, storedSecrets: async () => [] });
    await work(generated);
  } finally {
    // Keep the production redactor installed and restore the fixture's prior environment.
    setTextRedactor(redaction.redactCredentials);
    if (previousToken === undefined) delete process.env.VIVARY_PROBE_TOKEN; // guard:allow-env-credential - Restore the prior slot.
    else process.env.VIVARY_PROBE_TOKEN = previousToken; // guard:allow-env-credential - Restore without printing a value.
  }
}

for (const mode of ["save", "timeout"]) {
  test(`shutdown ${mode === "timeout" ? "refuses a timed-out save and can retry" : "waits for the initial payload save"}; a new process resumes exact bytes`, {
    timeout: 90_000, skip: process.platform === "win32",
  }, async () => {
    const { fixture } = await ipcFixture(`queue-lifecycle-${mode}`);
    await folders(fixture, "running", "queued");
    const token = randomBytes(24).toString("hex");
    const database = `file:${path.join(fixture, "restart.sqlite")}`;
    const child = promisify(execFile);
    for (const stage of [mode, "resume"]) {
      const { stdout } = await child(process.execPath, ["--import", import.meta.resolve("tsx"),
        path.join(workbench, "tests", "fixtures", "code-queue-lifecycle.ts"), stage, fixture, token], {
        cwd: fixture, timeout: 40_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, DATABASE_URL: database, DATABASE_URL_UNPOOLED: database, // guard:allow-env-credential - Disposable child database, never a user's store.
          AGENT_NATIVE_CODE_AGENTS_HOME: path.join(fixture, "code-store") },
      });
      assert.match(stdout, new RegExp(`QUEUE_LIFECYCLE_OK ${stage}`));
    }
  });
}

test("inbox reflects the host queue lifecycle and refuses archive until a retained message is cancelled", {
  timeout: 60_000, skip: process.platform === "win32",
}, async () => {
  const { fixture } = await ipcFixture("queue-inbox");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "queue_inbox_b");
  const coreClient = import.meta.resolve("@agent-native/core/client/agent-chat");
  const { ensureChatThreadTables } = await import(new URL("../../chat-threads/store.js", coreClient).href);
  const { withMigrationRuntime } = await import("@agent-native/core/db");
  await withMigrationRuntime(ensureChatThreadTables);
  const projects = [project(a, "queue_inbox_a"), workspace].map(code => ({ projectId: code.projectId!, label: code.label, code }));
  const inbox = (scope = projects, identity = owner) => runWithRequestContext({ userEmail: identity.ownerEmail, orgId: identity.orgId },
    () => loadConversationInbox({ ...identity, projects: scope, personal: null }));
  const runs: string[] = [];
  let granted = true;
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  try {
    const retained = (await send(workspace, "Finish the initial turn")).run!.id;
    runs.push(retained);
    await waitFor(() => !capacityHost().activeRuns.has(retained), "the retained turn to finish");
    runs.push((await send(project(a, "queue_inbox_a"), "Keep the host full")).run!.id);
    await send(workspace, "Exact queued follow-up", { runId: retained,
      revalidateWorkspace: async () => granted ? workspace : undefined });
    const assertWaiting = async (state: "queued" | "held" | "needs-confirmation") => {
      assert.equal((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns
        .find(run => run.id === retained)?.state, state, "fixture state comes from the real host queue");
      assert.equal((await inbox()).rows.find(row => row.id === `code:${retained}`)?.attention, state);
      await assert.rejects(changeArchive(workspace, retained, "archive"),
        (error: { statusCode?: number; message: string }) => error.statusCode === 409 && /queued messages/.test(error.message));
      assert.equal(getCodeAgentRunRecord(retained)?.metadata?.archivedAt, undefined);
    };
    await assertWaiting("queued");
    assert.equal((await inbox(projects.filter(item => item.projectId !== workspace.projectId))).rows
      .some(row => row.id === `code:${retained}`), false, "an unlisted project reveals no queued row");
    assert.deepEqual((await inbox(projects, { ...owner, ownerEmail: "other@example.test" })).rows, [],
      "another owner sees neither this queued row nor its state");

    granted = false;
    await agent.setVivaryCodeRunCapacity({ limit: 2, whenFull: "queue" });
    await waitFor(async () => (await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns
      .some(run => run.id === retained && run.state === "held"), "failed fresh grant holds the queued turn");
    await assertWaiting("held");
    granted = true;
    runs.push((await send(workspace, "Work beside the waiting conversation")).run!.id);
    await agent.resumeQueuedVivaryCodeTurn({ ...owner, workspace, runId: retained, message: "unused replacement",
      proceed: false, revalidateWorkspace: async () => workspace });
    await agent.setVivaryCodeRunCapacity({ limit: 3, whenFull: "queue" });
    await waitFor(async () => (await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns
      .some(run => run.id === retained && run.state === "needs-confirmation"), "new same-folder worker requires consent");
    await assertWaiting("needs-confirmation");
    const cancelled = await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: retained, projectId: workspace.projectId });
    assert.equal(cancelled.message, "Exact queued follow-up");
    assert.equal((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns.some(run => run.id === retained), false);
    assert.deepEqual(await changeArchive(workspace, retained, "archive"), { changed: true });
    assert.equal((await inbox()).rows.find(row => row.id === `code:${retained}`)?.archived, true,
      "cancellation permits archive even while another conversation in its folder works");
    assert.deepEqual(userMessages(retained), ["Finish the initial turn"], "the waiting message never executed");
  } finally { await endAll(runs); }
});

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

for (const sameFolder of [false, true]) {
  test(`queued admission stays FIFO through asynchronous checks in ${sameFolder ? "one folder" : "separate folders"}`, {
    timeout: 60_000, skip: process.platform === "win32",
  }, async () => {
    const label = sameFolder ? "async-fifo-shared" : "async-fifo-separate";
    const { fixture } = await ipcFixture(label);
    const [runningFolder, olderFolder, newerFolder] = await folders(fixture, "running", "older", "newer");
    const olderWorkspace = project(olderFolder, `${label}_older`);
    const newerWorkspace = sameFolder ? olderWorkspace : project(newerFolder, `${label}_newer`);
    let holdOlder = false;
    let olderEntered = false;
    let releaseOlder = () => {};
    const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
    const runs: string[] = [];
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    try {
      const running = await send(project(runningFolder, `${label}_running`), "Keep working");
      assert.ok(running.run);
      runs.push(running.run.id);
      const first = await send(olderWorkspace, "Older queued request", {
        revalidateWorkspace: async () => {
          if (holdOlder) {
            olderEntered = true;
            await olderGate;
          }
          return olderWorkspace;
        },
      });
      assert.ok(first.run);
      const older = first.run.id;
      runs.push(older);
      const second = await send(newerWorkspace, "Newer queued request");
      assert.ok(second.run);
      const newer = second.run.id;
      runs.push(newer);

      holdOlder = true;
      await agent.setVivaryCodeRunCapacity({ limit: 3, whenFull: "queue" });
      await waitFor(() => olderEntered, "the older queued turn to enter its fresh checks");
      const later = capacityHost().queue.find(item => item !== null && typeof item === "object"
        && "runId" in item && item.runId === newer);
      assert.ok(later !== null && typeof later === "object" && "state" in later,
        "the later turn remains in the queue while the older turn is admitted");
      assert.equal(later.state, "queued", "later admission waits for the older turn to claim or be held");
      assert.equal(capacityHost().activeRuns.has(newer), false);

      releaseOlder();
      await waitFor(() => capacityHost().activeRuns.has(older), "the older queued turn to claim first");
      if (sameFolder) {
        const waiting = await waitFor(async () =>
          (await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns
            .find(item => item.id === newer && item.state === "needs-confirmation"),
        "the newer turn to confirm sharing the older turn's folder");
        assert.equal(waiting.reason, SHARED_FOLDER_WARNING);
        assert.equal(capacityHost().activeRuns.has(newer), false);
        assert.equal(capacityHost().activeRuns.size, 2);
      } else {
        await waitFor(() => capacityHost().activeRuns.has(newer), "the newer queued turn to claim its slot");
        assert.deepEqual([...capacityHost().activeRuns.keys()].filter(id => id === older || id === newer),
          [older, newer], "fresh admission preserves queue order");
        assert.equal(capacityHost().activeRuns.size, 3, "serial admission keeps running workers concurrent");
      }
    } finally {
      releaseOlder();
      await endAll(runs);
    }
  });
}

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

    const stored = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
    await agent.resumeQueuedVivaryCodeTurn({ ...owner, ...stored, workspace, revalidateWorkspace: async () => workspace,
      runId: queued, proceed: false });
    await waitFor(() => capacityHost().activeRuns.has(queued), "the owner's Start");
    assert.deepEqual(userMessages(queued), ["Queued before the restart"]);
  } finally { await endAll(runs); }
});

for (const source of ["api", "pending-draft"]) {
  test(`a ${source} queue reload keeps exact private bytes while Core redacts its audit record`, { timeout: 60_000,
    skip: process.platform === "win32" }, async () => {
    await withQueueRedaction(async secret => {
      const { fixture } = await ipcFixture(`capacity-exact-${source}`);
      const [a, b] = await folders(fixture, "a", "b");
      const workspace = project(b, `exact_${source}_b`);
      const { runWithRequestContext } = await import("@agent-native/core/server");
      const { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } = await import("../server/chat-draft.ts");
      const asOwner = <T>(work: () => Promise<T>) => runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, work);
      const identity = createCodeDraftIdentity(owner.ownerEmail, owner.orgId, workspace.projectId ?? null);
      const threadId = `vivary-code:project:${workspace.projectId}:exact-queued-draft`;
      const submitId = "d6a615ac-26db-492b-8262-82ee357d4cb6";
      const message = `Use ${secret}\r\nKeep  the tabs\tand trailing spaces.  `;
      await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
      const runs: string[] = [];
      try {
        runs.push((await send(project(a, `exact_${source}_a`), "Work in a")).run!.id);
        if (source === "pending-draft") {
          await asOwner(() => changeIndexedChatDraft(identity, threadId, null, { text: message, status: "pending", submitId }));
        }
        const queued = (await send(workspace, message, source === "pending-draft"
          ? { draftSubmitId: submitId, draftThreadId: threadId } : {})).run!.id;
        runs.push(queued);
        const record = getCodeAgentRunRecord(queued);
        assert.ok(record);
        assert.equal(JSON.stringify(record).includes(secret), false, "Core still redacts the queued run record");
        capacityHost().queue.length = 0;
        capacityHost().initialization = null;
        const restarted = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
        assert.equal(restarted.queuedRuns.find(value => value.id === queued)?.state, "held");
        await settle(runs[0]);
        assert.equal(capacityHost().activeRuns.has(queued), false, "reload does not start the queued turn");
        assert.equal((await startedRuns(fixture)).includes(queued), false);
        const stored = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
        assert.equal(stored.message === message, true, "the action reads the original private payload after reload");
        const queuedMetadata = record?.metadata?.queuedTurn;
        assert.ok(queuedMetadata && typeof queuedMetadata === "object" && !Array.isArray(queuedMetadata));
        assert.equal("message" in queuedMetadata, false, "audit metadata stores no original prompt");
        const revision = Reflect.get(queuedMetadata, "payloadRevision");
        assert.ok(typeof revision === "string");
        assert.match(revision, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        const row = (await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX)).find(value => value.value.runId === queued);
        assert.ok(row, "the queue acknowledgement has a durable private payload");
        assert.deepEqual(Object.keys(row.value).sort(),
          ["version", "revision", "runId", "ownerEmail", "orgId", "projectId", "message"].sort());
        assert.deepEqual([row.value.version, row.value.revision, row.value.runId, row.value.ownerEmail,
          row.value.orgId, row.value.projectId], [1, revision, queued, owner.ownerEmail.toLowerCase(), owner.orgId, workspace.projectId]);
        assert.equal(row.value.message === message, true, "private storage preserves the submitted bytes");
        if (source === "pending-draft") {
          const pending = await asOwner(() => readChatDraft(identity, threadId));
          assert.equal(pending?.text === message, true);
          await asOwner(() => changeIndexedChatDraft(identity, threadId, pending,
            { text: "A newer composer draft must not execute", status: "draft", submitId: null }));
        }
        await agent.resumeQueuedVivaryCodeTurn({ ...owner, ...stored, workspace,
          revalidateWorkspace: async () => workspace, runId: queued, proceed: false });
        await waitFor(async () => (await startedRuns(fixture)).includes(queued), "the exact payload to reach the worker");
        const starts: unknown[] = (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n")
          .map(line => JSON.parse(line));
        const started = starts.find(value => value !== null && typeof value === "object" && "runId" in value && value.runId === queued);
        assert.ok(started && typeof started === "object" && "prompt" in started);
        assert.equal(started.prompt === message, true, "the worker receives the original exact bytes");
        assert.equal(JSON.stringify(listCodeAgentTranscriptEvents(queued)).includes(secret), false,
          "executing the private payload does not disable transcript redaction");
        await waitFor(async () => await appStateGet(owner.ownerEmail, row.key) === null, "consumed exact payload cleanup");
      } finally { await endAll(runs); }
    });
  });
}

test("Start uses the stored queued payload instead of replacement caller text", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-stored-source");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "stored_source_b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "stored_source_a"), "Work in a")).run!.id);
    const message = "The original queued request\nKeep its final line.";
    const queued = (await send(workspace, message)).run!.id;
    runs.push(queued);
    capacityHost().queue.length = 0;
    capacityHost().initialization = null;
    await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    await settle(runs[0]);
    const stored = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
    await agent.resumeQueuedVivaryCodeTurn({ ...owner, ...stored, workspace, revalidateWorkspace: async () => workspace,
      message: "A stale or forged replacement request", runId: queued, proceed: false });
    await waitFor(async () => (await startedRuns(fixture)).includes(queued), "the stored request to reach the worker");
    const starts: unknown[] = (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line));
    const started = starts.find(value => value !== null && typeof value === "object" && "runId" in value && value.runId === queued);
    assert.ok(started && typeof started === "object" && "prompt" in started);
    assert.equal(started.prompt, message);
    assert.deepEqual(userMessages(queued), [message]);
  } finally { await endAll(runs); }
});

test("missing, invalid, or differently scoped queued payloads cannot start a worker", { timeout: 120_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-unavailable-payload");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "unavailable_b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "unavailable_a"), "Work in a")).run!.id);
    for (const mode of ["missing", "message", "ownerEmail", "orgId", "projectId", "revision", "runId"]) {
      const queued = (await send(workspace, `Original request for ${mode}`)).run!.id;
      runs.push(queued);
      const row = (await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX)).find(value => value.value.runId === queued);
      assert.ok(row, "the accepted queue has a private payload");
      const damaged = mode === "missing" ? null : { ...row.value,
        [mode]: mode === "message" ? 19 : `different-${mode}` };
      assert.equal(await appStateCompareAndSet(owner.ownerEmail, row.key, row.value, damaged), true);
      try {
        capacityHost().queue.length = 0;
        capacityHost().initialization = null;
        await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
        await assert.rejects(agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId }),
          { errorCode: "vivary_code_queue_payload_unavailable", statusCode: 409 }, mode);
        await assert.rejects(agent.resumeQueuedVivaryCodeTurn({ ...owner, workspace,
          revalidateWorkspace: async () => workspace, message: `Original request for ${mode}`,
          engine: "claude-cli", model: "claude-sonnet-5-5", runId: queued, proceed: false }),
        { errorCode: "vivary_code_queue_payload_unavailable", statusCode: 409 }, mode);
        assert.equal(capacityHost().activeRuns.has(queued), false);
        assert.equal((await startedRuns(fixture)).includes(queued), false, `${mode} starts no worker`);
        assert.deepEqual(userMessages(queued), []);
      } finally {
        assert.equal(await appStateCompareAndSet(owner.ownerEmail, row.key, damaged, row.value), true);
        await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
      }
    }
  } finally { await endAll(runs); }
});

test("queued payload reads and Start preserve request owner, organization, and project boundaries", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-payload-request-scope");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "payload_scope_b");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "payload_scope_a"), "Work in a")).run!.id);
    const queued = (await send(workspace, "Private queued words")).run!.id;
    runs.push(queued);
    capacityHost().queue.length = 0;
    capacityHost().initialization = null;
    await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    const requests = [
      { ...owner, ownerEmail: "other@example.test", projectId: workspace.projectId },
      { ...owner, orgId: "other-org", projectId: workspace.projectId },
      { ...owner, projectId: "other-project" },
    ];
    for (const request of requests) {
      await assert.rejects(agent.readQueuedVivaryCodeTurn({ ...request, runId: queued }), { statusCode: 404 });
      await assert.rejects(agent.resumeQueuedVivaryCodeTurn({ ...request,
        workspace: { ...workspace, projectId: request.projectId }, revalidateWorkspace: async () => workspace,
        message: "Private queued words", engine: "claude-cli", model: "claude-sonnet-5-5", runId: queued, proceed: false }),
      { statusCode: 404 });
    }
    assert.equal(capacityHost().activeRuns.has(queued), false);
    assert.equal((await startedRuns(fixture)).includes(queued), false);
    assert.deepEqual(userMessages(queued), []);
    const stored = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
    assert.equal(stored.message, "Private queued words", "rejected requests leave the original payload intact");
  } finally { await endAll(runs); }
});

test("Cancel and successful Start remove only their matching private payload rows", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-payload-cleanup");
  const [a, b, c] = await folders(fixture, "a", "b", "c");
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  try {
    runs.push((await send(project(a, "payload_cleanup_a"), "Work in a")).run!.id);
    const cancelled = (await send(project(b, "payload_cleanup_b"), "Cancel these words")).run!.id;
    const started = (await send(project(c, "payload_cleanup_c"), "Start these words")).run!.id;
    runs.push(cancelled, started);
    const rows = await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX);
    const cancelledRow = rows.find(value => value.value.runId === cancelled);
    const startedRow = rows.find(value => value.value.runId === started);
    assert.ok(cancelledRow);
    assert.ok(startedRow);
    const result = await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: cancelled, projectId: "payload_cleanup_b" });
    assert.equal(result.message, "Cancel these words");
    assert.equal(await appStateGet(owner.ownerEmail, cancelledRow.key), null);
    assert.deepEqual(await appStateGet(owner.ownerEmail, startedRow.key), startedRow.value,
      "Cancel preserves another queued turn's exact payload");
    await settle(runs[0]);
    await waitFor(async () => (await startedRuns(fixture)).includes(started), "the remaining turn to start");
    await waitFor(async () => await appStateGet(owner.ownerEmail, startedRow.key) === null, "consumed payload cleanup");
    assert.deepEqual(userMessages(started), ["Start these words"]);
  } finally { await endAll(runs); }
});

test("a failed durable queue save rejects admission and preserves the pending draft", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-payload-save-fails");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "durable_save_b");
  const { runWithRequestContext } = await import("@agent-native/core/server");
  const { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } = await import("../server/chat-draft.ts");
  const asOwner = <T>(work: () => Promise<T>) => runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, work);
  const identity = createCodeDraftIdentity(owner.ownerEmail, owner.orgId, workspace.projectId ?? null);
  const threadId = "vivary-code:project:durable_save_b:queued-draft";
  const submitId = "126f8168-4d72-46e2-b447-c5a33c5e3d42";
  const runs: string[] = [];
  const databaseExecutor = getDbExec();
  let triggerInstalled = false;
  try {
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    runs.push((await send(project(a, "durable_save_a"), "Work in a")).run!.id);
    await waitFor(async () => (await startedRuns(fixture)).includes(runs[0]), "the occupying worker to start");
    await asOwner(() => changeIndexedChatDraft(identity, threadId, null,
      { text: "Keep the pending draft if storage fails", status: "pending", submitId }));
    const before = await asOwner(() => readChatDraft(identity, threadId));
    const payloadsBefore = await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX);
    await databaseExecutor.execute(`CREATE TRIGGER vivary_queue_payload_save_failure BEFORE INSERT ON application_state
      WHEN NEW.key GLOB 'vivary-code-queue-payload-v1:*'
      BEGIN SELECT RAISE(FAIL, 'fixture queue payload write refused'); END`);
    triggerInstalled = true;
    await assert.rejects(send(workspace, "Keep the pending draft if storage fails",
      { draftSubmitId: submitId, draftThreadId: threadId }),
    { errorCode: "vivary_code_queue_save_failed", statusCode: 503 });
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual(state.queuedRuns, [], "a failed durable write acknowledges no queued turn");
    assert.equal(capacityHost().reserved, 0);
    assert.deepEqual(await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX), payloadsBefore);
    assert.deepEqual(await asOwner(() => readChatDraft(identity, threadId)), before);
    assert.deepEqual(await startedRuns(fixture), [runs[0]], "the failed queued send starts no worker");
    assert.equal(listCodeAgentRunRecords("vivary-local-code").some(run => run.metadata?.projectId === workspace.projectId
      && run.metadata?.queuedTurn !== undefined), false, "no run record claims a durable queued payload");
  } finally {
    if (triggerInstalled) await databaseExecutor.execute("DROP TRIGGER vivary_queue_payload_save_failure");
    await endAll(runs);
  }
});

test("Cancel with a missing, corrupt, or legacy payload restores only the matching intact pending draft", { timeout: 120_000,
  skip: process.platform === "win32" }, async () => {
  await withQueueRedaction(async secret => {
    const { fixture } = await ipcFixture("capacity-unavailable-draft-cancel");
    const [a, b] = await folders(fixture, "a", "b");
    const workspace = project(b, "safe_cancel_b");
    const { runWithRequestContext } = await import("@agent-native/core/server");
    const { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } = await import("../server/chat-draft.ts");
    const { restoreQueuedCodeDraft } = await import("../server/code-queue-draft.ts");
    const asOwner = <T>(work: () => Promise<T>) => runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, work);
    const identity = createCodeDraftIdentity(owner.ownerEmail, owner.orgId, workspace.projectId ?? null);
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    const runs: string[] = [];
    try {
      runs.push((await send(project(a, "safe_cancel_a"), "Work in a")).run!.id);
      for (const mode of ["missing", "corrupt", "legacy"]) {
        const message = `Keep ${secret} for ${mode}\nOriginal draft text.`;
        const threadId = `vivary-code:project:safe_cancel_b:${mode}-queued-draft`;
        const submitId = "a34d9825-7cef-43dc-988b-90bd5b8b1161";
        await asOwner(() => changeIndexedChatDraft(identity, threadId, null, { text: message, status: "pending", submitId }));
        const queued = (await send(workspace, message, { draftSubmitId: submitId, draftThreadId: threadId })).run!.id;
        runs.push(queued);
        const row = (await appStateList(owner.ownerEmail, QUEUE_PAYLOAD_PREFIX)).find(value => value.value.runId === queued);
        assert.ok(row);
        if (mode === "legacy") {
          const queuedMetadata = getCodeAgentRunRecord(queued)?.metadata?.queuedTurn;
          assert.ok(queuedMetadata && typeof queuedMetadata === "object" && !Array.isArray(queuedMetadata));
          updateCodeAgentRunRecord(queued, { metadata: { queuedTurn: { ...queuedMetadata,
            payloadRevision: undefined, message: "[redacted VIVARY_PROBE_TOKEN]" } } });
        } else {
          const damaged = mode === "missing" ? null : { ...row.value, message: 19 };
          assert.equal(await appStateCompareAndSet(owner.ownerEmail, row.key, row.value, damaged), true);
        }
        capacityHost().queue.length = 0;
        capacityHost().initialization = null;
        const restarted = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
        assert.equal(restarted.queuedRuns.find(value => value.id === queued)?.state, "held");
        await assert.rejects(agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId }),
          { errorCode: "vivary_code_queue_payload_unavailable", statusCode: 409 }, mode);
        const cancelled = await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId,
          restore: value => asOwner(() => restoreQueuedCodeDraft(owner.ownerEmail, owner.orgId, value)) });
        assert.equal(cancelled.restored, true);
        const restored = await asOwner(() => readChatDraft(identity, threadId));
        assert.deepEqual([restored?.status, restored?.submitId], ["draft", null]);
        assert.equal(restored?.text === message, true, `${mode} never replaces the good draft with a placeholder`);
        assert.equal(capacityHost().activeRuns.has(queued), false);
        assert.equal((await startedRuns(fixture)).includes(queued), false);
        assert.deepEqual(userMessages(queued), []);
      }
    } finally { await endAll(runs); }
  });
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

test("Cancel holds a restored message when the cancellation record cannot be saved", { timeout: 60_000,
  skip: process.platform === "win32" }, async t => {
  const { fixture } = await ipcFixture("capacity-cancel-save-fails");
  const [a, b] = await folders(fixture, "a", "b");
  const workspace = project(b, "cancel_save_b");
  const { runWithRequestContext } = await import("@agent-native/core/server");
  const { codeAgentRunsDir } = await import("@agent-native/core/code-agents");
  const { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } = await import("../server/chat-draft.ts");
  const { restoreQueuedCodeDraft } = await import("../server/code-queue-draft.ts");
  const asOwner = <T>(work: () => Promise<T>) => runWithRequestContext({ userEmail: owner.ownerEmail, orgId: owner.orgId }, work);
  const identity = createCodeDraftIdentity(owner.ownerEmail, owner.orgId, workspace.projectId ?? null);
  const threadId = "vivary-code:project:cancel_save_b:queued-draft";
  const submitId = "520d14cd-c9a6-42ec-b368-1ac7880962b5";
  const message = "Keep these words for an explicit retry";
  const runs: string[] = [];
  let refuseCancellation = false;
  let refusedWrites = 0;
  try {
    await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
    runs.push((await send(project(a, "cancel_save_a"), "Work in a")).run!.id);
    await waitFor(async () => (await startedRuns(fixture)).includes(runs[0]), "the occupying worker to start");
    await asOwner(() => changeIndexedChatDraft(identity, threadId, null, { text: message, status: "pending", submitId }));
    const queued = (await send(workspace, message, { draftSubmitId: submitId, draftThreadId: threadId })).run!.id;
    runs.push(queued);
    const recordPath = path.join(codeAgentRunsDir(), `${queued}.json`);
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (refuseCancellation && to === recordPath) {
        refuseCancellation = false;
        refusedWrites += 1;
        throw new Error("Fixture cancellation record write refused");
      }
      return rename(from, to);
    });
    await assert.rejects(agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId,
      restore: cancelled => asOwner(async () => {
        const restored = await restoreQueuedCodeDraft(owner.ownerEmail, owner.orgId, cancelled);
        assert.equal(restored, true);
        refuseCancellation = true;
        return restored;
      }) }), /cancellation record write refused/);
    assert.equal(refusedWrites, 1);
    assert.equal((await asOwner(() => readChatDraft(identity, threadId)))?.status, "draft");
    assert.equal((await asOwner(() => readChatDraft(identity, threadId)))?.text, message);
    await settle(runs[0]);
    const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual(state.queuedRuns.map(run => [run.id, run.state]), [[queued, "held"]],
      "a restored message waits for an explicit decision after cancellation fails");
    assert.equal(capacityHost().activeRuns.has(queued), false);
    assert.deepEqual(await startedRuns(fixture), [runs[0]], "free capacity cannot launch the restored message");
    assert.equal((await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId })).message, message);
    assert.equal((getCodeAgentRunRecord(queued)?.metadata?.queuedTurn as { state: string }).state, "held");
    await agent.cancelQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: workspace.projectId });
    assert.deepEqual((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).queuedRuns, []);
  } finally { t.mock.restoreAll(); await endAll(runs); }
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
    const stored = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: queued, projectId: "restore_b" });
    assert.equal(stored.message, "Keep these words", "the exact queued payload remains available");
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
    const observed = (await agent.getVivaryCodeState(owner.ownerEmail, idle, workspace, owner.orgId)).run!;
    for (const stop of [false, true]) {
      await assert.rejects(agent.switchVivaryCodeRuntime({ ...owner, runId: idle, engine: "codex-cli", model: "gpt-6-astra",
        workspace, stop, expectedSwitchGeneration: observed.switchGeneration,
        ...(stop ? { expectedTurnId: observed.turnId } : {}) }), (error: Error & { errorCode?: string; statusCode?: number }) => {
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

test("waiting for you counts only the caller's held turns", { timeout: 60_000,
  skip: process.platform === "win32" }, async () => {
  const { fixture } = await ipcFixture("capacity-held-owner");
  const [a, b] = await folders(fixture, "a", "b");
  const other = { ownerEmail: "someone-else@example.test", orgId: owner.orgId };
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runs: string[] = [];
  let theirs: string | undefined;
  try {
    runs.push((await send(project(a, "held_a"), "Work in a")).run!.id);
    theirs = (await send(project(b, "held_b"), "Their words", other)).run!.id;
    // A restart holds the other owner's queued turn.
    const state = capacityHost();
    state.queue.length = 0;
    state.initialization = null;
    const mine = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
    assert.deepEqual([mine.queuedRuns, mine.capacity.held], [[], 0], "the caller has nothing waiting");
    assert.equal((await agent.getVivaryCodeRunCapacity(owner)).held, 0);
    assert.equal((await agent.getVivaryCodeHostState(other.ownerEmail, other.orgId)).capacity.held, 1);
    assert.equal((await agent.getVivaryCodeRunCapacity(other)).held, 1);
  } finally {
    if (theirs) await agent.cancelQueuedVivaryCodeTurn({ ...other, runId: theirs, projectId: "held_b" }).catch(() => undefined);
    await endAll(runs);
  }
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
      workspace, expectedSwitchGeneration: null });
    assert.equal(switched.run?.engine, "codex-cli");
    await assert.rejects(agent.switchVivaryCodeRuntime({ ...owner, runId: running, engine: "codex-cli", model: "gpt-6-astra",
      workspace, expectedSwitchGeneration: null }), { errorCode: "vivary_code_switch_run_active" });
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
