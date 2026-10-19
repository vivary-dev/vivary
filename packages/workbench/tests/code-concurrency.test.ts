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
const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
const { SHARED_FOLDER_WARNING } = await import("../shared/code-concurrency.ts");
const { getCodeAgentRunRecord, listCodeAgentRunRecords, listCodeAgentTranscriptEvents } = await import("@agent-native/core/code-agents");
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
