import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval108-"));
const url = `file:${path.join(root, "approval.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Approval tests forbid outward network calls."); };
const { runner, history, approvalStore, resources, frontmatter, threads, runStore, runManager, bus, database,
  surface, context, restoreTimers, loadCore, makeApprovalCase, actor, owner, appId, mcpName, toolInput, until } = await import("./fixtures/automation-approval-fixture.mjs");
after(async () => { globalThis.fetch = savedFetch; restoreTimers(); await rm(root, { recursive: true, force: true }); });
const configuredCalls = fixture => fixture.calls.filter(call => call.name === mcpName);
const wait = async fixture => { const result = await fixture.start(); assert.equal(result.status, "waiting_approval"); return result; };
const finished = [];
const subscription = bus.subscribe("automation.run.finished", payload => finished.push(payload));
after(() => bus.unsubscribe(subscription));

// The event-loop barrier drains completed admission microtasks without a timed sleep.
// A correctly owned connection keeps the outside write queued until custody ends.
async function sqliteCustodyAdmission(outcome) {
  const fixture = await makeApprovalCase(`sqlite-custody-${outcome}`);
  const resource = fixture.automation.resource;
  await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  const db = database.getDbExec();
  const execute = db.execute.bind(db);
  let releaseCustody;
  const gate = new Promise(resolve => { releaseCustody = resolve; });
  let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  let attempted;
  const admissionAttempt = new Promise(resolve => { attempted = resolve; });
  let admissionCompleted = false;
  let completedBeforeRelease = false;
  let released = false;
  let selectedInserts = 0;
  db.execute = async statement => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    if (/INSERT INTO automation_runs/.test(sql) && statement.args?.[2] === fixture.automation.name) {
      selectedInserts += 1;
      attempted();
    }
    return execute(statement);
  };
  let custody;
  let admission;
  try {
    if (outcome !== "outside") {
      custody = db.transaction(async tx => {
        await tx.execute({ sql: "UPDATE resources SET content = ? WHERE id = ?", args: ["SQLite custody control", resource.id] });
        entered();
        await gate;
        if (outcome === "rollback") throw new Error("selected custody rollback");
      }).then(() => "committed", error => {
        if (error.message !== "selected custody rollback") throw error;
        return "rolled_back";
      });
      await inside;
    }
    admission = history.startAutomationRun({ owner, automation: fixture.automation.name, path: resource.path,
      appId, scope: "personal", orgId: null }).then(id => {
      admissionCompleted = true;
      completedBeforeRelease = !released;
      return id;
    });
    await admissionAttempt;
    if (outcome !== "outside") {
      await new Promise(resolve => setImmediate(resolve));
      released = true;
      releaseCustody();
    }
    const custodyResult = custody ? await custody : "none";
    const id = await admission;
    const retained = await history.getAutomationRun(id);
    const persistedResource = await resources.resourceGetByPath(owner, resource.path);
    console.log("SQLITE_CUSTODY_OBSERVATION " + JSON.stringify({ outcome, custodyResult, selectedInserts,
      admissionCompleted, completedBeforeRelease, historyPresent: Boolean(retained), resourcePresent: Boolean(persistedResource),
      modelCalls: fixture.modelCalls.length, toolCalls: fixture.calls.length }));
    assert.equal(selectedInserts, 1);
    assert.equal(admissionCompleted, true);
    assert.ok(retained, "outside admission must survive the custody transaction");
    assert.equal(retained.status, "running");
    assert.equal(retained.path, resource.path);
    assert.equal(persistedResource.id, resource.id);
    assert.equal(fixture.modelCalls.length, 0);
    assert.equal(fixture.calls.length, 0);
    if (outcome !== "outside") {
      assert.equal(completedBeforeRelease, false, "ordinary admission must queue behind custody");
      assert.equal(custodyResult, outcome === "rollback" ? "rolled_back" : "committed");
      assert.equal(persistedResource.content, outcome === "rollback" ? resource.content : "SQLite custody control");
    }
    await history.finishAutomationRun(id, "error", "SQLite ownership control finished", "sqlite_control_complete");
  } finally {
    released = true;
    releaseCustody();
    await Promise.allSettled([custody, admission].filter(Boolean));
    db.execute = execute;
  }
}

for (const [label, outcome] of [
  ["custody rollback cannot erase unrelated automation admission", "rollback"],
  ["custody commit preserves and queues unrelated automation admission", "commit"],
  ["outside automation admission survives without custody", "outside"],
]) test(`SQLite ${label}`, () => sqliteCustodyAdmission(outcome));

test("SQLite custody transactions serialize healthy resource contention", async () => {
  const fixture = await makeApprovalCase("sqlite-two-custodies");
  const resource = fixture.automation.resource;
  const db = database.getDbExec();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const order = [];
  const first = db.transaction(async tx => {
    await tx.execute({ sql: "UPDATE resources SET content = ? WHERE id = ?", args: ["first custody", resource.id] });
    order.push("first"); entered(); await gate; order.push("first released");
  });
  let second;
  try {
    await firstEntered;
    second = db.transaction(async tx => {
      order.push("second");
      const { rows } = await tx.execute({ sql: "SELECT content FROM resources WHERE id = ?", args: [resource.id] });
      assert.equal(rows[0].content, "first custody");
      await tx.execute({ sql: "UPDATE resources SET content = ? WHERE id = ?", args: ["second custody", resource.id] });
    });
    // Observe a rejected old nested BEGIN immediately to avoid an unhandled rejection.
    const result = second.then(() => ({ ok: true }), error => ({ ok: false, error }));
    await new Promise(resolve => setImmediate(resolve));
    release();
    await first;
    const settled = await result;
    console.log("SQLITE_TWO_CUSTODIES " + JSON.stringify({ ok: settled.ok, order, modelCalls: fixture.modelCalls.length, toolCalls: fixture.calls.length }));
    assert.equal(settled.ok, true, settled.error?.message);
    assert.deepEqual(order, ["first", "first released", "second"]);
    assert.equal((await resources.resourceGetByPath(owner, resource.path)).content, "second custody");
    assert.equal(fixture.modelCalls.length, 0);
    assert.equal(fixture.calls.length, 0);
  } finally { release(); await Promise.allSettled([first, second].filter(Boolean)); }
});

test("approval resumes the same history, thread and logical turn once with the original tools", async () => {
  const fixture = await makeApprovalCase("approve");
  fixture.manager.config.servers.approval_fixture.headers = { Authorization: "Bearer fixture-private-connection" };
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  assert.equal(JSON.stringify(pending).includes("fixture-private-connection"), false);
  assert.doesNotMatch(JSON.stringify(pending), /https:\/\/fixture\.invalid\/original/);
  assert.equal(pending.threadId, result.threadId);
  assert.equal(pending.turnId, result.turnId);
  assert.deepEqual(pending.input, toolInput);
  assert.equal((await history.getAutomationRun(result.historyId)).finishedAt, null);
  assert.equal(configuredCalls(fixture).length, 0);
  assert.equal(finished.filter(event => event.automationRunId === result.historyId).length, 0);
  const inspection = await runner.inspectAutomationRun(result.historyId, actor, fixture.deps);
  assert.match(inspection.threadData, /local-write-result/);
  assert.equal(inspection.pending.askId, pending.askId);
  await fixture.decide(result.historyId, pending);
  const final = await fixture.terminal(result.historyId);
  assert.equal(final.status, "success");
  assert.equal(final.threadId, result.threadId);
  assert.notEqual(final.runId, result.runId, "fresh Native chunk retains event sequence");
  assert.equal((await runStore.getRunTurnRef(final.runId)).turnId, result.turnId);
  assert.equal(configuredCalls(fixture).length, 1);
  assert.deepEqual(configuredCalls(fixture)[0].input, toolInput);
  assert.equal(fixture.calls.filter(call => call.name === "resources").length, 1, "Native journal prevents the fake model repeating the local write");
  assert.equal(fixture.calls[0].caller, "automation");
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "consumed");
  const rows = await history.listAutomationRuns({ owners: [owner], automation: "approve", appId });
  assert.equal(rows.length, 1, "continuation creates no automation history row");
  const data = JSON.parse((await threads.getThread(result.threadId)).threadData);
  assert.equal(data.messages.filter(item => (item.message ?? item).role === "user").length, 1);
  assert.equal(data.messages.filter(item => (item.message ?? item).role === "assistant").length, 1, "Native fold retains one logical turn");
  assert.match(JSON.stringify(data), /configured-result/);
  assert.match(JSON.stringify(data.messages.at(-1).message.content), /Automation complete\./,
    "the shorter final answer survives the actual interim tool save and a fresh durable thread read");
  const finalInspection = await runner.inspectAutomationRun(result.historyId, actor, fixture.deps);
  assert.match(finalInspection.threadData, /Automation complete\./, "normal owner inspection returns the persisted final answer");
  assert.equal(JSON.stringify(data).includes('"askId"'), false, "unexecuted gate card is replaced by the result");
  assert.equal(finished.filter(event => event.automationRunId === result.historyId).length, 1);
  await assert.rejects(fixture.decide(result.historyId, pending), /no longer waiting/);
  assert.equal(configuredCalls(fixture).length, 1);
});

test("a later exact gate returns the same history and turn to waiting", async () => {
  const fixture = await makeApprovalCase("second-gate", { repeatLocal: false });
  const originalStream = fixture.engine.stream.bind(fixture.engine);
  fixture.engine.stream = async function* (options) {
    const messages = JSON.stringify(options.messages);
    if (messages.includes("configured-result") && !messages.includes("second exact input")) {
      yield { type: "assistant-content", parts: [{ type: "tool-call", name: mcpName, id: "configured-second", input: { value: "second exact input" } }] };
      yield { type: "stop", reason: "tool_use" };
    } else yield* originalStream(options);
  };
  const result = await wait(fixture);
  const first = await fixture.pending(result.historyId);
  await fixture.decide(result.historyId, first);
  const second = await until(async () => {
    const state = await history.getAutomationContinuation(result.historyId);
    return state.run.status === "waiting_approval" && state.run.approvalReady && state.context.askId !== first.askId ? state.context : null;
  });
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.turnId, first.turnId);
  assert.notEqual(second.runId, first.runId);
  assert.equal(configuredCalls(fixture).length, 1);
  assert.equal(finished.filter(event => event.automationRunId === result.historyId).length, 0);
  await assert.rejects(fixture.decide(result.historyId, first), /not the current pending/);
  await fixture.decide(result.historyId, second);
  assert.equal((await fixture.terminal(result.historyId)).status, "success");
  assert.deepEqual(configuredCalls(fixture).map(call => call.input), [toolInput, { value: "second exact input" }]);
});

test("decline is terminal without executing the pending action", async () => {
  const fixture = await makeApprovalCase("decline");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  const receipt = await fixture.decide(result.historyId, pending, "decline");
  assert.equal(receipt.status, "declined");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "declined");
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "declined");
  assert.equal(configuredCalls(fixture).length, 0);
  await assert.rejects(fixture.decide(result.historyId, pending), /no longer waiting/);
});

test("only one concurrent approve or decline decision wins", async () => {
  const fixture = await makeApprovalCase("race");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  const receipts = await Promise.allSettled([fixture.decide(result.historyId, pending), fixture.decide(result.historyId, pending, "decline"), fixture.decide(result.historyId, pending)]);
  assert.equal(receipts.filter(receipt => receipt.status === "fulfilled").length, 1);
  const terminal = await fixture.terminal(result.historyId);
  assert.ok(["success", "declined"].includes(terminal.status));
  assert.equal(configuredCalls(fixture).length, terminal.status === "success" ? 1 : 0);
});

test("wrong owner, app and fabricated ask cannot authorize or inspect", async () => {
  const fixture = await makeApprovalCase("identity");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  // Organization mismatch remains a refusal for an organization-bound wait.
  // The normal HTTP owner-scope suite covers it with real membership and scope.
  for (const who of [{ ...actor, userEmail: "another@example.test" }, { ...actor, appId: "other-app" }, {}]) {
    await assert.rejects(fixture.decide(result.historyId, pending, "approve", who), /not available/);
    await assert.rejects(runner.inspectAutomationRun(result.historyId, who, fixture.deps), /not available/);
  }
  assert.equal((await runner.inspectAutomationRun(result.historyId, { ...actor, orgId: "other-org" }, fixture.deps)).run.id,
    result.historyId, "an ambient organization does not change this personal run's owner");
  await assert.rejects(fixture.decide(result.historyId, { ...pending, askId: "model-supplied-key" }), /not the current pending/);
  assert.equal(await approvalStore.consumeAgentToolApproval({ ...pending, askId: "model-supplied-key" }), false);
  assert.equal((await history.getAutomationRun(result.historyId)).status, "waiting_approval");
  assert.equal(configuredCalls(fixture).length, 0);
  await fixture.decide(result.historyId, pending, "decline");
});

test("the real SQLite policy setter enables and disables the owner-wide policy", async () => {
  const binding = { ownerEmail: owner, toolName: "mcp__policy_fixture__write" };
  for (const enabled of [true, false]) {
    await approvalStore.setAgentToolApprovalPolicy({ binding, enabled });
    assert.equal(await approvalStore.isAgentToolAlwaysAllowed(binding), enabled);
    const { rows } = await database.getDbExec().execute({ sql: "SELECT enabled FROM agent_tool_approval_policies WHERE owner_email = ? AND tool_name = ?",
      args: [owner, binding.toolName] });
    assert.equal(rows[0].enabled, enabled ? 1 : 0);
  }
});

test("owner-wide always allow cannot skip an unattended gate", async () => {
  await approvalStore.setAgentToolApprovalPolicy({ binding: { ownerEmail: owner, toolName: mcpName }, enabled: true });
  assert.equal(await approvalStore.isAgentToolAlwaysAllowed({ ownerEmail: owner, toolName: mcpName }), true);
  const fixture = await makeApprovalCase("always-allow");
  const result = await wait(fixture);
  assert.equal(configuredCalls(fixture).length, 0);
  const registry = await context.runWithRequestContext({ userEmail: owner }, () => fixture.deps.getActions(fixture.automation));
  assert.equal(registry[mcpName].needsApproval, true);
  assert.equal(registry[mcpName].allowPersistentApproval, false);
  await fixture.decide(result.historyId, await fixture.pending(result.historyId), "decline");
  await approvalStore.setAgentToolApprovalPolicy({ binding: { ownerEmail: owner, toolName: mcpName }, enabled: false });
  assert.equal(await approvalStore.isAgentToolAlwaysAllowed({ ownerEmail: owner, toolName: mcpName }), false);
});

test("expired asks refuse approval and still permit exact owner cancellation", async () => {
  const fixture = await makeApprovalCase("expired");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  await database.getDbExec().execute({ sql: "UPDATE agent_tool_approvals SET expires_at = ? WHERE id = ?", args: [Date.now() - 1, pending.askId] });
  await assert.rejects(fixture.decide(result.historyId, pending), /expired/);
  assert.equal(configuredCalls(fixture).length, 0);
  await fixture.decide(result.historyId, pending, "decline");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "declined");
});

for (const change of ["definition", "endpoint", "hidden", "missing", "schema"]) test(`${change} changes refuse the retained approval before a side effect`, async () => {
  const fixture = await makeApprovalCase(`changed-${change}`);
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  if (change === "definition") {
    const current = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
    await resources.resourcePut(owner, current.path, current.content + "\nChanged owner instructions.\n");
  } else if (change === "endpoint") fixture.manager.config.servers.approval_fixture.url = "https://fixture.invalid/replaced";
  else if (change === "hidden") fixture.hidden = true;
  else if (change === "missing") fixture.manager.tool = null;
  else fixture.manager.tool.raw.inputSchema.properties.extra = { type: "string" };
  await assert.rejects(fixture.decide(result.historyId, pending), /changed|unavailable/);
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
  assert.equal(configuredCalls(fixture).length, 0);
  await fixture.decide(result.historyId, pending, "decline");
});

test("configuration is checked again after consumption and before the current entry runs", async () => {
  const fixture = await makeApprovalCase("changed-at-dispatch");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  const db = database.getDbExec();
  const execute = db.execute.bind(db);
  db.execute = async statement => {
    const written = await execute(statement);
    if (String(statement.sql).includes("SET status = 'consumed'") && written.rowsAffected === 1)
      fixture.manager.config.servers.approval_fixture.url = "https://fixture.invalid/changed-after-consume";
    return written;
  };
  try {
    await fixture.decide(result.historyId, pending);
    assert.equal((await fixture.terminal(result.historyId)).status, "interrupted");
    assert.equal(configuredCalls(fixture).length, 0);
    assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "consumed");
  } finally { db.execute = execute; }
  await assert.rejects(fixture.decide(result.historyId, pending), /no longer waiting/);
});

test("a consumed-ask crash becomes interrupted and never dispatches that ask again", async () => {
  const fixture = await makeApprovalCase("consumed-crash");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "crashed-native-chunk"), true);
  assert.equal(await approvalStore.consumeAgentToolApproval(pending), true);
  await runStore.insertRun("crashed-native-chunk", result.threadId, result.turnId, { dispatchMode: "background" });
  await runStore.updateRunStatus("crashed-native-chunk", "aborted");
  await assert.rejects(fixture.decide(result.historyId, pending), /consumed approval cannot be retried/);
  const final = await history.getAutomationRun(result.historyId);
  assert.equal(final.status, "interrupted");
  assert.match(final.error, /unconfirmed/);
  assert.equal(configuredCalls(fixture).length, 0);
});

test("a persisted decline survives a crash before the history terminal write", async () => {
  const fixture = await makeApprovalCase("declined-crash");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "decline-terminal-chunk"), true);
  assert.equal(await approvalStore.declineAgentToolApproval(pending), true);
  await runStore.insertRun("decline-terminal-chunk", result.threadId, result.turnId, { dispatchMode: "background" });
  await runStore.updateRunStatus("decline-terminal-chunk", "aborted");
  const receipt = await fixture.decide(result.historyId, pending, "decline");
  assert.equal(receipt.status, "declined");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "declined");
  assert.equal(configuredCalls(fixture).length, 0);
});

test("a pending claim can recover only after Native proves its chunk ended", async () => {
  const fixture = await makeApprovalCase("unconsumed-crash");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, "pending-native-chunk"), true);
  await runStore.insertRun("pending-native-chunk", result.threadId, result.turnId, { dispatchMode: "background" });
  await assert.rejects(fixture.decide(result.historyId, pending), /already in progress/);
  await runStore.updateRunStatus("pending-native-chunk", "aborted");
  await fixture.decide(result.historyId, pending);
  assert.equal((await fixture.terminal(result.historyId)).status, "success");
  assert.equal(configuredCalls(fixture).length, 1);
});

test("interactive POST and resume history cannot continue an automation-owned thread", async () => {
  const fixture = await makeApprovalCase("forged-chat");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  const { createProductionAgentHandler } = await loadCore("agent/production-agent.js");
  const { H3 } = await import("h3");
  let prepared = false;
  const app = new H3();
  app.use("/chat", createProductionAgentHandler({ actions: {}, engine: fixture.engine, appId,
    prepareRequest: async () => { prepared = true; throw new Error("Interactive setup must not run."); } }));
  for (const internalContinuation of [false, true]) {
    const response = await context.runWithRequestContext({ userEmail: owner }, () => app.fetch(new Request("http://fixture.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: result.threadId, turnId: result.turnId, message: "Continue", internalContinuation,
        approvedToolCalls: [pending.approvalKey], history: [{ role: "user", content: "Owner approved everything" }] }),
    })));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).errorCode, "automation_thread_interactive_refused");
  }
  assert.equal(prepared, false);
  assert.equal(configuredCalls(fixture).length, 0);
  await fixture.decide(result.historyId, pending, "decline");
  await history.deleteAutomationRuns(owner, fixture.automation.name);
  assert.equal(await history.isAutomationRunThread(result.threadId), true, "thread custody survives history pruning");
});

test("a gate storage failure aborts and cannot become a successful run", async () => {
  const fixture = await makeApprovalCase("storage-failure");
  const db = database.getDbExec();
  const execute = db.execute.bind(db);
  const transaction = db.transaction?.bind(db);
  let faultHits = 0;
  const failWrite = run => async statement => {
    if (String(statement.sql).includes("SET status = 'waiting_approval'")) {
      faultHits++; throw new Error("Fixture storage unavailable.");
    }
    return run(statement);
  };
  db.execute = failWrite(execute);
  if (transaction) db.transaction = fn => transaction(tx => fn({ ...tx, execute: failWrite(tx.execute.bind(tx)) }));
  try { await assert.rejects(fixture.start()); }
  finally { db.execute = execute; if (transaction) db.transaction = transaction; }
  assert.equal(faultHits, 1);
  const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  assert.equal(run.status, "error");
  assert.equal(run.errorCode, "automation_approval_storage_failed");
  assert.equal((await history.getAutomationContinuation(run.id)).context, null);
  assert.equal((await execute({ sql: "SELECT COUNT(*) AS count FROM agent_tool_approvals WHERE thread_id = ?", args: [run.threadId] })).rows[0].count, 0,
    "the failed history write rolls back its ask in the same transaction");
  assert.equal(configuredCalls(fixture).length, 0);
});

test("Run now preserves the schedule and blocks a second run while waiting", async () => {
  const fixture = await makeApprovalCase("scheduled-wait");
  const scheduler = await loadCore("jobs/scheduler.js");
  const before = frontmatter.parseJobResource((await resources.resourceGetByPath(owner, fixture.automation.resource.path)).content).meta.nextRun;
  const result = await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
  assert.equal(result.status, "waiting_approval");
  const resource = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
  const meta = frontmatter.parseJobResource(resource.content).meta;
  assert.equal(meta.lastStatus, "waiting_approval");
  assert.equal(meta.nextRun, before);
  assert.equal((await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps)).status, "skipped");
  const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  await fixture.decide(run.id, await fixture.pending(run.id), "decline");
});


test("waiting readiness and runner return await Native terminal SQL persistence", async () => {
  const fixture = await makeApprovalCase("native-finalization");
  const db = database.getDbExec();
  const execute = db.execute.bind(db);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let blocked = false;
  let settled = false;
  db.execute = async statement => {
    const sql = typeof statement === "string" ? statement : String(statement.sql);
    if (!blocked && sql.startsWith("UPDATE agent_runs SET status = ?") && statement.args?.[0] === "completed" &&
      String(statement.args[2]).startsWith("native-finalization-")) {
      blocked = true;
      await gate;
    }
    return execute(statement);
  };
  const work = fixture.start();
  void work.then(() => { settled = true; }, () => { settled = true; });
  try {
    await until(() => blocked);
    const [row] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    assert.equal(row.status, "waiting_approval");
    assert.equal(row.approvalReady, false);
    assert.equal(settled, false);
    assert.equal((await runner.inspectAutomationRun(row.id, actor, fixture.deps)).run.approvalReady, false);
    await assert.rejects(fixture.decide(row.id, await fixture.pending(row.id)), /still saving/);
    release();
    const result = await work;
    assert.equal(result.status, "waiting_approval");
    assert.notEqual(await runStore.getRunStatus(result.runId), "running");
    assert.equal((await history.getAutomationRun(result.historyId)).approvalReady, true);
    await fixture.decide(result.historyId, await fixture.pending(result.historyId), "decline");
  } finally {
    release();
    await work.catch(() => {});
    db.execute = execute;
  }
});

test("a crash before the waiting turn save recovers only a terminal Native chunk", async () => {
  const fixture = await makeApprovalCase("waiting-save-crash");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  await database.getDbExec().execute({ sql: "UPDATE automation_runs SET approval_ready = 0 WHERE id = ?", args: [result.historyId] });
  await runStore.updateRunStatus(result.runId, "running");
  await assert.rejects(fixture.decide(result.historyId, pending), /still saving/);
  assert.equal(configuredCalls(fixture).length, 0);
  await runStore.updateRunStatus(result.runId, "aborted");
  const inspection = await runner.inspectAutomationRun(result.historyId, actor, fixture.deps);
  assert.equal(inspection.run.approvalReady, true, "read-only inspection offers the recoverable owner decision");
  assert.equal((await history.getAutomationRun(result.historyId)).approvalReady, false, "inspection writes no authority");
  await fixture.decide(result.historyId, pending);
  assert.equal((await fixture.terminal(result.historyId)).status, "success");
  assert.equal(configuredCalls(fixture).length, 1);
});

for (const [name, reason, durableTurn, expectedStatus, expectedCode] of [
  ["ordinary-owner-stop", "user", false, "error", "background_automation_aborted"],
  ["ordinary-durable-stop", "user", true, "error", "background_automation_aborted"],
  ["ordinary-shutdown", "shutdown", false, "interrupted", history.INTERRUPTED_RUN_ERROR_CODE],
]) test(`${name} preserves its outcome without an approval continuation`, async () => {
  const fixture = await makeApprovalCase(name);
  let started = false;
  fixture.engine.stream = async function* (options) {
    started = true;
    await new Promise(resolve => {
      if (options.abortSignal.aborted) resolve();
      else options.abortSignal.addEventListener("abort", resolve, { once: true });
    });
    const error = new Error("The fixture model was stopped.");
    error.name = "AbortError";
    throw error;
  };
  const settled = fixture.start().then(() => assert.fail("the stopped run cannot succeed"), error => error);
  await until(() => started);
  const [running] = await history.listAutomationRuns({ owners: [owner], automation: name, appId });
  assert.equal(runManager.getRun(running.runId).status, "running");
  const turn = await runStore.getRunTurnRef(running.runId);
  if (durableTurn) await runManager.abortTurnDurably(running.runId, reason);
  await runManager.abortRunDurably(running.runId, reason);
  const error = await settled;
  assert.equal(error.errorCode, expectedCode);
  const final = await fixture.terminal(running.id);
  assert.equal(final.status, expectedStatus);
  assert.equal(final.errorCode, expectedCode);
  const { rows } = await database.getDbExec().execute({
    sql: "SELECT status, abort_reason FROM agent_runs WHERE id = ?", args: [running.runId],
  });
  assert.equal(rows[0].status, "aborted");
  assert.equal(rows[0].abort_reason, reason);
  if (durableTurn) assert.equal(await runStore.isTurnAborted(turn.threadId, turn.turnId), true);
  assert.equal(fixture.calls.length, 0);
  assert.equal(finished.filter(event => event.automationRunId === running.id && event.status === "success").length, 0);
});

test("owner Stop after an approved tool completes still interrupts its continuation", async () => {
  const fixture = await makeApprovalCase("stop-after-approved-tool");
  const originalStream = fixture.engine.stream.bind(fixture.engine);
  let resumedModelStarted = false;
  fixture.engine.stream = async function* (options) {
    if (!JSON.stringify(options.messages).includes("configured-result")) {
      yield* originalStream(options);
      return;
    }
    resumedModelStarted = true;
    await new Promise(resolve => {
      if (options.abortSignal.aborted) resolve();
      else options.abortSignal.addEventListener("abort", resolve, { once: true });
    });
    const error = new Error("The continuation model was stopped.");
    error.name = "AbortError";
    throw error;
  };
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  await fixture.decide(result.historyId, pending);
  await until(() => resumedModelStarted);
  const claimed = await history.getAutomationRun(result.historyId);
  await runManager.abortTurnDurably(claimed.runId);
  await runManager.abortRunDurably(claimed.runId);
  const final = await fixture.terminal(result.historyId);
  assert.equal(final.status, "interrupted");
  assert.equal(final.errorCode, history.INTERRUPTED_RUN_ERROR_CODE);
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "consumed");
  assert.equal(configuredCalls(fixture).length, 1);
  const { rows } = await database.getDbExec().execute({
    sql: "SELECT abort_reason FROM agent_runs WHERE id = ?", args: [claimed.runId],
  });
  assert.equal(rows[0].abort_reason, "user");
  await assert.rejects(fixture.decide(result.historyId, pending), /no longer waiting/);
  assert.equal(finished.filter(event => event.automationRunId === result.historyId && event.status === "success").length, 0);
});

test("a persisted stopped turn refuses the approved tool before any side effect", async () => {
  const fixture = await makeApprovalCase("stopped-waiting-turn");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  await runManager.abortTurnDurably(result.runId);
  assert.equal(await runStore.isTurnAborted(result.threadId, result.turnId), true);
  await assert.rejects(fixture.decide(result.historyId, pending), /This automation turn was stopped/);
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
  assert.equal(configuredCalls(fixture).length, 0);
  const retained = await history.getAutomationRun(result.historyId);
  assert.equal(retained.status, "waiting_approval");
  assert.equal(retained.finishedAt, null);
  assert.equal(retained.pendingAskId, pending.askId);
  assert.equal(retained.runId, result.runId);
  assert.equal(retained.threadId, result.threadId);
  assert.deepEqual(await fixture.pending(result.historyId), pending);
  // Decline ends this retained wait without resuming its stopped turn.
  await fixture.decide(result.historyId, pending, "decline");
  assert.equal((await history.getAutomationRun(result.historyId)).status, "declined");
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "declined");
  assert.equal(configuredCalls(fixture).length, 0);
});

test("Stop interrupts a consumed continuation without success or a second dispatch", async () => {
  const fixture = await makeApprovalCase("stop-consumed");
  const result = await wait(fixture);
  const pending = await fixture.pending(result.historyId);
  let release;
  fixture.toolGate = new Promise(resolve => { release = resolve; });
  await fixture.decide(result.historyId, pending);
  await until(() => configuredCalls(fixture).length === 1);
  const claimed = await history.getAutomationRun(result.historyId);
  await runManager.abortTurnDurably(claimed.runId);
  await runManager.abortRunDurably(claimed.runId);
  const final = await fixture.terminal(result.historyId);
  assert.equal(final.status, "interrupted");
  assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "consumed");
  await assert.rejects(fixture.decide(result.historyId, pending), /no longer waiting/);
  release();
  assert.equal(configuredCalls(fixture).length, 1);
  assert.equal(finished.filter(event => event.automationRunId === result.historyId && event.status === "success").length, 0);
});

test("waiting cannot send a delivery or emit a finished event", async () => {
  const fixture = await makeApprovalCase("delivery-wait");
  const current = fixture.automation.resource;
  await resources.resourcePut(owner, current.path, frontmatter.patchJobFrontmatterFields(current.content, {
    deliveryPlatform: "approval-fixture-no-adapter", deliveryDestination: "never-dispatch",
  }));
  fixture.automation.resource = await resources.resourceGetByPath(owner, current.path);
  Object.assign(fixture.automation, frontmatter.parseJobResource(fixture.automation.resource.content));
  const result = await wait(fixture);
  assert.equal((await history.getAutomationRun(result.historyId)).finishedAt, null);
  assert.equal(finished.filter(event => event.automationRunId === result.historyId).length, 0);
  await fixture.decide(result.historyId, await fixture.pending(result.historyId), "decline");
  assert.equal(configuredCalls(fixture).length, 0);
});

test("an event wait blocks another event and its continuation still finishes silently", async () => {
  const fixture = await makeApprovalCase("event-wait", { triggerType: "event" });
  const dispatcher = await loadCore("triggers/dispatcher.js");
  await dispatcher.initTriggerDispatcher(fixture.deps);
  await bus.emit("test.event.fired", { id: "approval-event" }, { owner });
  const run = await until(async () => {
    const [row] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    return row?.approvalReady ? row : null;
  });
  await bus.emit("test.event.fired", { id: "duplicate-event" }, { owner });
  assert.equal((await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId })).length, 1);
  await fixture.decide(run.id, await fixture.pending(run.id));
  assert.equal((await fixture.terminal(run.id)).status, "success");
  assert.equal(configuredCalls(fixture).length, 1);
  assert.equal(finished.filter(event => event.automationRunId === run.id).length, 0);
});

test("the Native webhook task retains waiting and restart recovery cannot redispatch it", async () => {
  const fixture = await makeApprovalCase("webhook-wait", { triggerType: "webhook" });
  const dispatcher = await loadCore("triggers/dispatcher.js");
  const tasks = await loadCore("integrations/pending-tasks-store.js");
  const webhook = await loadCore("integrations/automation-webhook-task.js");
  const retry = await loadCore("integrations/pending-tasks-retry-job.js");
  await dispatcher.initTriggerDispatcher(fixture.deps);
  const resource = fixture.automation.resource;
  const taskId = "approval-webhook-task";
  await tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
    ownerEmail: owner, orgId: null, externalEventKey: `${resource.id}:approval-event`,
    payload: JSON.stringify({ kind: "automation-webhook", automationId: resource.id, owner, path: resource.path,
      eventId: "approval-event", payload: { id: "approval-event" } }) });
  assert.equal(await webhook.runAutomationWebhookTaskInProcess(taskId, { appId }), "waiting_approval");
  const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  const pending = await fixture.pending(run.id);
  assert.equal(pending.options.webhookTaskId, taskId);
  assert.equal((await tasks.getPendingTask(taskId)).status, "waiting_approval");
  assert.equal(finished.filter(event => event.automationRunId === run.id).length, 0);
  const callsBefore = fixture.modelCalls.length;
  await database.getDbExec().execute({ sql: "UPDATE integration_pending_tasks SET updated_at = ?, created_at = ? WHERE id = ?",
    args: [Date.now() - 25 * 60 * 60_000, Date.now() - 25 * 60 * 60_000, taskId] });
  await retry.retryStuckPendingTasks();
  assert.equal(await webhook.runAutomationWebhookTaskInProcess(taskId, { appId }), "skipped");
  assert.equal((await tasks.getPendingTask(taskId)).status, "waiting_approval");
  assert.equal(fixture.modelCalls.length, callsBefore);
  await fixture.decide(run.id, pending);
  assert.equal((await fixture.terminal(run.id)).status, "success");
  await until(async () => (await tasks.getPendingTask(taskId)).status === "completed");
  assert.equal(configuredCalls(fixture).length, 1);
  assert.equal((await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId })).length, 1);
});

// Adapt the independently retained stale-wait reproduction at the real DB
// adapter seam. Delaying the latest SELECT preserves the resource CAS. Holding
// the UPDATE after its read also proves the history predicate must be atomic.
for (const caller of ["scheduler", "trigger"]) for (const decision of ["approve", "decline"])
  for (const ordering of ["normal", "late-read", "late-write"]) test(`${caller} ${decision} keeps terminal metadata after ${ordering} waiting publication`, async () => {
    const fixture = await makeApprovalCase(`monotonic-${caller}-${decision}-${ordering}`, { repeatLocal: false,
      triggerType: caller === "trigger" ? "webhook" : "schedule" });
    const scheduler = await loadCore("jobs/scheduler.js");
    const dispatcher = await loadCore("triggers/dispatcher.js");
    if (caller === "trigger") await dispatcher.initTriggerDispatcher(fixture.deps);
    const db = database.getDbExec();
    const execute = db.execute.bind(db);
    let armed = false;
    let blocked = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const resource = fixture.automation.resource;
    db.execute = async statement => {
      const sql = typeof statement === "string" ? statement : String(statement.sql);
      const sameResource = statement.args?.includes(resource.path);
      const latestRead = sql.trim() === "SELECT * FROM resources WHERE owner = ? AND path = ?" && sameResource;
      const waitingWrite = sql.startsWith("UPDATE resources SET content = ?") && sameResource &&
        frontmatter.parseJobResource(statement.args[0]).meta.lastStatus === "waiting_approval";
      if (armed && !blocked && ((ordering === "late-read" && latestRead) || (ordering === "late-write" && waitingWrite))) {
        blocked = true;
        await gate;
      }
      const result = await execute(statement);
      if (sql.includes("SET approval_ready = 1") && result.rowsAffected === 1) armed = true;
      return result;
    };
    const original = caller === "scheduler" ? scheduler.runJobNow(owner, fixture.automation.name, fixture.deps) :
      context.runWithRequestContext({ userEmail: owner }, () => dispatcher.dispatchAutomationWebhookTask({
        automationId: resource.id, owner, path: resource.path, eventId: "monotonic-event", payload: { id: "monotonic-event" },
      }));
    try {
      if (ordering === "normal") await original;
      else await until(() => blocked);
      const [row] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
      assert.equal(row.status, "waiting_approval");
      assert.equal(row.approvalReady, true);
      assert.equal(await history.hasUnresolvedAutomationApproval(owner, resource.path), true);
      assert.equal(configuredCalls(fixture).length, 0);
      // The genuine history wait blocks a competing run even before the first
      // caller has published its waiting metadata.
      assert.equal((await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps)).status, "skipped");
      const pending = await fixture.pending(row.id);
      await fixture.decide(row.id, pending, decision);
      const terminal = decision === "approve" ? "success" : "declined";
      await until(async () => frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta.lastStatus === terminal);
      release();
      const receipt = await original;
      assert.equal(caller === "scheduler" ? receipt.status : receipt, "waiting_approval");
      const final = await history.getAutomationRun(row.id);
      const meta = frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta;
      assert.equal(final.status, terminal);
      assert.notEqual(final.finishedAt, null);
      assert.equal(meta.lastStatus, terminal);
      assert.equal(runner.isBackgroundAutomationRunActive(meta), false);
      assert.equal(await history.hasUnresolvedAutomationApproval(owner, resource.path), false);
      assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
      const next = await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
      assert.equal(next.status, "waiting_approval", "terminal metadata permits fresh work");
      assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0, "fresh work still needs its own approval");
      const runs = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
      const waiting = runs.find(run => run.status === "waiting_approval");
      await fixture.decide(waiting.id, await fixture.pending(waiting.id), "decline");
    } finally {
      release();
      await original.catch(() => {});
      db.execute = execute;
    }
  });

const child = (role, name, id) => new Promise((resolve, reject) => {
  const script = fileURLToPath(new URL(role.startsWith("cold-") ? "./fixtures/automation-approval-cold-delete.mjs" : "./fixtures/automation-approval-restart.mjs", import.meta.url));
  const processHandle = spawn(process.execPath, [script, role, name, ...(id ? [id] : [])], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const timeout = setTimeout(() => { processHandle.kill("SIGKILL"); reject(new Error("Approval child exceeded 30 seconds.")); }, 30_000);
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on("data", data => { output += data; });
  processHandle.on("error", reject);
  processHandle.on("close", (code, signal) => {
    clearTimeout(timeout);
    const crash = role === "gap-webhook-crash" || role === "gap-retention-crash";
    if (crash ? code !== null || signal !== "SIGKILL" : code !== 0)
      return reject(new Error(`Approval child exited ${code}/${signal}: ${output.slice(-8000)}`));
    const prefix = crash ? "APPROVAL_CRASH " : "APPROVAL_RESULT ";
    const receipt = output.split("\n").find(line => line.startsWith(prefix));
    if (!receipt) return reject(new Error("Approval child did not report its result."));
    resolve(JSON.parse(receipt.slice(prefix.length)));
  });
});

test("the actual PostgreSQL policy setter retains boolean bindings", async () => {
  const result = await child("postgres-policy", "policy-contract");
  assert.deepEqual(result.enabledBindings, [true, false]);
  assert.deepEqual(result.readback, [true, false]);
});

test("a fresh process retains the wait then approves the same run and tools", async () => {
  const waiting = await child("wait", "fresh-restart");
  const resumed = await child("resume", "fresh-restart", waiting.historyId);
  assert.equal(resumed.result.status, "success");
  assert.equal(resumed.result.id, waiting.historyId);
  assert.equal(resumed.result.threadId, waiting.threadId);
  assert.equal(resumed.pending.turnId, waiting.turnId);
  assert.notEqual(resumed.result.runId, waiting.runId);
  assert.equal(resumed.calls.filter(call => call.name === mcpName).length, 1);
  assert.equal(resumed.calls.filter(call => call.name === "resources").length, 0, "preceding local write remains journaled across processes");
});

for (const mode of ["waiting", "waiting-decline", "resuming", "consumed"]) test(`legacy-null ${mode} retains admission origin through fresh-process recovery`, async () => {
  const name = `legacy-null-${mode}`;
  const waiting = await child(`legacy-null-${mode}`, name);
  assert.equal(waiting.admittedAt, null);
  assert.equal(waiting.status, mode === "resuming" || mode === "consumed" ? "resuming" : "waiting_approval");
  assert.equal(waiting.askStatus, mode === "consumed" ? "consumed" : "pending");
  const recovered = await child(`legacy-recover-${mode}`, name, waiting.historyId);
  const expected = mode === "consumed" ? "interrupted" : mode === "waiting-decline" ? "declined" : "success";
  assert.equal(recovered.result.id, waiting.historyId); assert.equal(recovered.result.status, expected);
  assert.equal(recovered.result.threadId, waiting.threadId);
  assert.equal(recovered.pending.threadId, waiting.threadId); assert.equal(recovered.pending.turnId, waiting.turnId);
  assert.equal(recovered.pending.askId, waiting.askId);
  assert.equal(recovered.turn.turnId, waiting.turnId);
  assert.equal(recovered.resourceStatus, expected); assert.equal(recovered.outcomeReconciled, true);
  assert.equal(recovered.calls.filter(call => call.name === mcpName).length, expected === "success" ? 1 : 0);
  assert.equal(recovered.calls.filter(call => call.name === "resources").length, 0, "the earlier durable tool result is not replayed");
  assert.equal(recovered.modelCalls.length, expected === "success" ? 1 : 0);
  assert.equal(recovered.askStatus, expected === "success" || mode === "consumed" ? "consumed" : "declined");
  if (expected === "success") {
    assert.notEqual(recovered.result.runId, waiting.runId);
    assert.equal(recovered.result.admittedAt, waiting.startedAt, "a resumed legacy row keeps its original admission order");
  } else assert.equal(recovered.result.admittedAt, null, "terminal recovery preserves the legacy start-time fallback");
  assert.equal((await history.listAutomationRuns({ owners: [owner], automation: name, appId })).length, 1);
});

test("shutdown keeps an idle wait and interrupts an active consumed continuation", async () => {
  const waiting = await child("shutdown-wait", "quit-wait");
  assert.equal((await history.getAutomationRun(waiting.historyId)).status, "waiting_approval");
  const resumed = await child("shutdown-resume", "quit-resume");
  assert.equal(resumed.result.status, "interrupted");
  assert.equal(resumed.calls.filter(call => call.name === mcpName).length, 1);
});


test("Native pruning retains an aged ready wait and prunes ordinary completion", async () => {
  const waiting = await makeApprovalCase("retained-aged-wait");
  const ready = await wait(waiting);
  const ordinary = await makeApprovalCase("ordinary-prune-control");
  ordinary.engine.stream = async function* () {
    yield { type: "assistant-content", parts: [{ type: "text", text: "Complete without a tool." }] };
    yield { type: "stop", reason: "end_turn" };
  };
  const completed = await ordinary.start();
  assert.equal(completed.status, "success");
  const old = Date.now() - 25 * 60 * 60_000;
  await database.getDbExec().execute({ sql: "UPDATE agent_runs SET completed_at = ? WHERE id IN (?, ?)",
    args: [old, ready.runId, completed.runId] });
  const events = await runStore.getRunEventsSince(ready.runId, -1);
  assert.ok(events.length > 0);
  await runStore.cleanupOldRuns(24 * 60 * 60_000);
  assert.equal(await runStore.getRunStatus(ready.runId), "completed");
  assert.deepEqual(await runStore.getRunEventsSince(ready.runId, -1), events);
  assert.equal(await runStore.getRunStatus(completed.runId), null);
  await waiting.decide(ready.historyId, await waiting.pending(ready.historyId), "decline");
  assert.equal((await history.getAutomationRun(ready.historyId)).status, "declined");
  assert.equal(configuredCalls(waiting).length, 0);
  await runStore.cleanupOldRuns(24 * 60 * 60_000);
  assert.equal(await runStore.getRunStatus(ready.runId), null, "settlement releases the terminal chunk for ordinary pruning");
  assert.deepEqual(await runStore.getRunEventsSince(ready.runId, -1), []);
});

for (const triggerType of ["schedule", "webhook"]) test(`${triggerType} deletion preserves an unresolved owner's route`, async () => {
  const service = await loadCore("automations/service.js");
  const fixture = await makeApprovalCase("delete-wait-" + triggerType, { triggerType });
  const ready = await wait(fixture);
  const before = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
  const tokensBefore = triggerType === "webhook" ? (await database.getDbExec().execute("SELECT * FROM automation_webhook_tokens")).rows : null;
  await assert.rejects(service.deleteAutomation(actor, "personal", fixture.automation.name), /Resolve the waiting approval/);
  assert.deepEqual(await resources.resourceGetByPath(owner, before.path), before);
  assert.equal((await history.getAutomationRun(ready.historyId)).status, "waiting_approval");
  assert.equal((await runner.inspectAutomationRun(ready.historyId, actor, fixture.deps)).pending.askId,
    (await fixture.pending(ready.historyId)).askId);
  if (tokensBefore) assert.deepEqual((await database.getDbExec().execute("SELECT * FROM automation_webhook_tokens")).rows, tokensBefore);
  await assert.rejects(service.deleteAutomation({ ...actor, userEmail: "different@example.test" }, "personal", fixture.automation.name));
  await fixture.decide(ready.historyId, await fixture.pending(ready.historyId), "decline");
  await service.deleteAutomation(actor, "personal", fixture.automation.name);
  assert.equal(await resources.resourceGetByPath(owner, before.path), null);
  const nonwaiting = await makeApprovalCase("delete-normal-" + triggerType, { triggerType });
  await service.deleteAutomation(actor, "personal", nonwaiting.automation.name);
  assert.equal(await resources.resourceGetByPath(owner, nonwaiting.automation.resource.path), null);
});

for (const decision of ["approve", "decline"]) for (const boundary of ["normal", "task", "resource"])
  test(`${decision} terminal bookkeeping converges after ${boundary} boundary in a fresh process`, async () => {
    const name = `reconcile-${decision}-${boundary}`;
    const fixture = await makeApprovalCase(name, { triggerType: "webhook" });
    const dispatcher = await loadCore("triggers/dispatcher.js");
    const tasks = await loadCore("integrations/pending-tasks-store.js");
    const webhook = await loadCore("integrations/automation-webhook-task.js");
    await dispatcher.initTriggerDispatcher(fixture.deps);
    const resource = fixture.automation.resource;
    const taskId = "task-" + name;
    await tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
      ownerEmail: owner, orgId: null, externalEventKey: resource.id + ":" + name,
      payload: JSON.stringify({ kind: "automation-webhook", automationId: resource.id, owner,
        path: resource.path, eventId: name, payload: { id: name } }) });
    assert.equal(await webhook.runAutomationWebhookTaskInProcess(taskId, { appId }), "waiting_approval");
    const [run] = await history.listAutomationRuns({ owners: [owner], automation: name, appId });
    const pending = await fixture.pending(run.id);
    const db = database.getDbExec();
    const execute = db.execute.bind(db);
    let failures = 0;
    db.execute = async statement => {
      const sql = String(typeof statement === "string" ? statement : statement.sql).replace(/\s+/g, " ").trim();
      const taskWrite = sql.startsWith("UPDATE integration_pending_tasks SET status = ?") && statement.args?.includes(taskId);
      const resourceWrite = sql.startsWith("UPDATE resources SET content = ?") && statement.args?.includes(resource.path) &&
        ["success", "declined"].includes(frontmatter.parseJobResource(statement.args[0]).meta.lastStatus);
      if ((boundary === "task" && taskWrite) || (boundary === "resource" && resourceWrite)) {
        const committed = await execute({ sql: "SELECT status, finished_at FROM automation_runs WHERE id = ?", args: [run.id] });
        assert.ok(committed.rows[0].finished_at, "the selected fault follows the terminal history commit");
        assert.equal(committed.rows[0].status, decision === "approve" ? "success" : "declined");
        failures++;
        throw new Error("Retained fixture outcome write failure.");
      }
      return execute(statement);
    };
    try {
      if (decision === "decline" && boundary !== "normal")
        await assert.rejects(fixture.decide(run.id, pending, decision), /outcome write failure/);
      else await fixture.decide(run.id, pending, decision);
      const terminal = await fixture.terminal(run.id);
      assert.equal(terminal.status, decision === "approve" ? "success" : "declined");
      if (boundary !== "normal") {
        await until(() => failures > 0);
        assert.ok(failures > 0, `the selected ${boundary} write fault was actually hit`);
      } else assert.equal(failures, 0);
      if (boundary === "task") assert.equal((await tasks.getPendingTask(taskId)).status, "waiting_approval");
      if (boundary === "resource") assert.equal((await tasks.getPendingTask(taskId)).status, decision === "approve" ? "completed" : "failed");
      if (boundary !== "normal") assert.equal(frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta.lastStatus, "waiting_approval");
      assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
    } finally { db.execute = execute; }
    const recovered = await child("reconcile", name, run.id);
    assert.equal(recovered.result.status, decision === "approve" ? "success" : "declined");
    assert.equal(recovered.taskStatus, decision === "approve" ? "completed" : "failed");
    assert.equal(recovered.resourceStatus, recovered.result.status);
    assert.deepEqual(recovered.calls, [], "storage recovery starts no tool");
    assert.deepEqual(recovered.modelCalls, [], "storage recovery starts no model");
    assert.equal(recovered.recovery.selected, 0, "the synthetic cursor excludes unrelated task dispatch");
    assert.equal(recovered.recovery.dispatched, 0);
    if (recovered.outcomeMarkerAvailable) assert.equal(recovered.outcomeReconciled, 1);
    else assert.equal(recovered.outcomeReconciled, null, "the old runtime has no reconciliation column");
    await assert.rejects(fixture.decide(run.id, pending), /no longer waiting/);
    assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
  });

test("terminal recovery leaves a genuinely newer admitted owner's metadata untouched", async () => {
  const fixture = await makeApprovalCase("reconcile-newer", { repeatLocal: false });
  const scheduler = await loadCore("jobs/scheduler.js");
  await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
  const [first] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  await fixture.decide(first.id, await fixture.pending(first.id), "decline");
  assert.equal((await fixture.terminal(first.id)).status, "declined");
  // A real later run is admitted only after the original wait has settled.
  await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
  const second = (await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId })).find(run => run.id !== first.id);
  assert.equal(second.status, "waiting_approval"); assert.ok(second.threadId); assert.ok(second.runId);
  const before = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
  assert.equal(await history.hasNewerAutomationRun(await history.getAutomationRun(first.id)), true);
  // Reopen only the terminal bookkeeping fault seam, never the consumed action or history state.
  await database.getDbExec().execute({ sql: "UPDATE automation_runs SET approval_outcome_reconciled = 0 WHERE id = ?", args: [first.id] });
  await runner.reconcileAutomationApprovalOutcomes(appId);
  assert.deepEqual(await resources.resourceGetByPath(owner, before.path), before);
  assert.equal(Boolean((await history.getAutomationContinuation(first.id)).outcomeReconciled), true);
  assert.equal(configuredCalls(fixture).length, 0);
  await fixture.decide(second.id, await fixture.pending(second.id), "decline");
});

for (const failAdmission of [false, true]) test(`later scheduler admission ${failAdmission ? "fails closed on selected attachment fault" : "protects its completed outcome"}`, async () => {
  const fixture = await makeApprovalCase(`admission-persist-${failAdmission}`, { repeatLocal: false });
  const scheduler = await loadCore("jobs/scheduler.js");
  await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
  const [original] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  await fixture.decide(original.id, await fixture.pending(original.id), "decline");
  assert.equal((await fixture.terminal(original.id)).status, "declined");
  // Reopen only already-terminal bookkeeping. The next run is ordinary and is
  // genuinely admitted after the original wait, without changing its definition.
  await database.getDbExec().execute({ sql: "UPDATE automation_runs SET approval_outcome_reconciled = 0 WHERE id = ?", args: [original.id] });
  fixture.engine.stream = async function* (options) {
    fixture.modelCalls.push(structuredClone(options.messages));
    assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...surface.UNATTENDED_TOOLS, mcpName].sort());
    if (!JSON.stringify(options.messages).includes("local-write-result")) {
      yield { type: "assistant-content", parts: [{ type: "tool-call", name: "resources", id: "later-local",
        input: { action: "write", path: "notes/later.md", content: "later ordinary execution" } }] };
      yield { type: "stop", reason: "tool_use" };
    } else {
      yield { type: "assistant-content", parts: [{ type: "text", text: "Later ordinary execution completed." }] };
      yield { type: "stop", reason: "end_turn" };
    }
  };
  const models = fixture.modelCalls.length, calls = fixture.calls.length;
  const db = database.getDbExec(), execute = db.execute.bind(db);
  const nativeRows = (await execute({ sql: "SELECT COUNT(*) AS count FROM agent_runs", args: [] })).rows[0].count;
  let laterId, faults = 0;
  db.execute = async statement => {
    const sql = String(typeof statement === "string" ? statement : statement.sql).replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO automation_runs (") && statement.args?.[1] === owner && statement.args[2] === fixture.automation.name)
      laterId = statement.args[0];
    if (failAdmission && sql.startsWith("UPDATE automation_runs SET thread_id = ?") && laterId && statement.args?.at(-1) === laterId) {
      faults++;
      throw new Error("Selected later-history attachment persistence failure.");
    }
    return execute(statement);
  };
  try { await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps); }
  finally { db.execute = execute; }
  assert.ok(laterId, "the real scheduler created the selected later history");
  const later = await history.getAutomationRun(laterId);
  const resource = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
  assert.equal(faults, failAdmission ? 1 : 0, "only the selected history attachment was faulted");
  assert.equal(fixture.modelCalls.length - models, failAdmission ? 0 : 2, "admission failure must precede model work");
  assert.equal(fixture.calls.length - calls, failAdmission ? 0 : 1, "admission failure must precede tool work");
  assert.equal(frontmatter.parseJobResource(resource.content).meta.lastStatus, failAdmission ? "error" : "success");
  if (failAdmission) {
    assert.equal(later.status, "error"); assert.equal(later.errorCode, "automation_execution_admission_failed");
    assert.match(later.error, /attachment persistence failure/);
    assert.equal(later.runId, null); assert.equal(later.threadId, null); assert.equal(later.admittedAt, null);
    assert.equal(fixture.modelCalls.length, models); assert.equal(fixture.calls.length, calls);
    assert.equal((await execute({ sql: "SELECT COUNT(*) AS count FROM agent_runs", args: [] })).rows[0].count, nativeRows,
      "failed authority persistence stops before Native insertion or start");
    assert.equal(await history.hasNewerAutomationRun(await history.getAutomationRun(original.id)), false);
  } else {
    assert.equal(later.status, "success"); assert.ok(later.runId); assert.ok(later.threadId); assert.ok(later.admittedAt);
    assert.equal(fixture.modelCalls.length - models, 2); assert.equal(fixture.calls.length - calls, 1);
    assert.equal(await history.hasNewerAutomationRun(await history.getAutomationRun(original.id)), true);
  }
  await runner.reconcileAutomationApprovalOutcomes(appId);
  if (!failAdmission) assert.deepEqual(await resources.resourceGetByPath(owner, resource.path), resource,
    "older terminal reconciliation cannot replace a genuinely admitted completed outcome");
  // An admission failure is retained as an explicit failed history, not a new
  // execution owner. Reconciliation may publish the original admitted outcome.
  assert.equal((await history.getAutomationRun(laterId)).status, failAdmission ? "error" : "success");
  assert.equal(Boolean((await history.getAutomationContinuation(original.id)).outcomeReconciled), true);
  assert.equal(await history.hasUnresolvedAutomationApproval(owner, resource.path), false);
  assert.equal(configuredCalls(fixture).length, 0);
  assert.equal(fixture.modelCalls.length - models, failAdmission ? 0 : 2);
  assert.equal(fixture.calls.length - calls, failAdmission ? 0 : 1);
});

for (const decision of ["approve", "decline"]) test(`admission-refused queue cannot suppress original ${decision} outcome`, async () => {
  const fixture = await makeApprovalCase(`refused-queue-${decision}`, { repeatLocal: false });
  const scheduler = await loadCore("jobs/scheduler.js"), runNow = await loadCore("jobs/run-now.js");
  await scheduler.runJobNow(owner, fixture.automation.name, fixture.deps);
  const [original] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  assert.equal(original.status, "waiting_approval");
  const models = fixture.modelCalls.length, calls = fixture.calls.length;
  runNow.setInProcessAutomationRunner(id => scheduler.runQueuedAutomation(id, fixture.deps), { appId });
  try {
    const queued = await runNow.queueAutomationRunNow({ userEmail: owner, appId, scope: "personal", name: fixture.automation.name });
    const refused = await until(async () => { const run = await history.getAutomationRun(queued.automationRunId); return run.finishedAt ? run : null; });
    assert.equal(refused.status, "error"); assert.match(refused.error, /already running|approval/i);
    assert.ok(refused.claimedAt); assert.equal(refused.threadId, null); assert.equal(refused.runId, null);
    assert.equal(fixture.modelCalls.length, models); assert.equal(fixture.calls.length, calls);
    await fixture.decide(original.id, await fixture.pending(original.id), decision);
    const terminal = await fixture.terminal(original.id);
    assert.equal(terminal.status, decision === "approve" ? "success" : "declined");
    const resource = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
    const meta = frontmatter.parseJobResource(resource.content).meta;
    assert.equal(meta.lastStatus, terminal.status);
    assert.equal(runner.isBackgroundAutomationRunActive(meta), false);
    assert.equal(await history.hasUnresolvedAutomationApproval(owner, resource.path), false);
    assert.equal(Boolean((await history.getAutomationContinuation(original.id)).outcomeReconciled), true);
    assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
    await assert.rejects(fixture.decide(original.id, await fixture.pending(original.id), decision), /no longer waiting/);
    assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
  } finally { runNow.setInProcessAutomationRunner(null); }
});

test("admitted-owner tie has one consistent history and atomic resource CAS winner", async () => {
  const fixture = await makeApprovalCase("admitted-order");
  const path = fixture.automation.resource.path, now = Date.now(), clock = Date.now;
  const ids = [];
  try {
    // Only history insertion uses the fixed clock. These completed storage owners do not create overlapping waits.
    Date.now = () => now;
    for (const suffix of ["first", "second"]) ids.push(await history.startAutomationRun({ owner, automation: fixture.automation.name,
      path, appId, threadId: `order-thread-${suffix}`, runId: `order-run-${suffix}` }));
  } finally { Date.now = clock; }
  for (const id of ids) await history.finishAutomationRun(id, "success");
  const runs = await Promise.all(ids.map(id => history.getAutomationRun(id)));
  assert.equal(runs[0].startedAt, runs[1].startedAt);
  const newer = await Promise.all(runs.map(run => history.hasNewerAutomationRun(run)));
  assert.equal(newer.filter(Boolean).length, 1, "equal-time admitted owners must not each supersede the other");
  const winner = runs.find((_, index) => !newer[index]), loser = runs.find((_, index) => newer[index]);
  assert.equal(winner.id, [...ids].sort().at(-1));
  const current = await resources.resourceGetByPath(owner, path);
  const input = run => ({ owner, path, expectedId: current.id, expectedUpdatedAt: current.updatedAt, expectedContent: current.content,
    content: frontmatter.patchJobFrontmatterFields(current.content, { lastStatus: "success" }),
    automationTerminal: { historyId: run.id, runId: run.runId } });
  assert.equal(await resources.resourcePutIfCurrent(input(loser)), null);
  assert.ok(await resources.resourcePutIfCurrent(input(winner)), "CAS uses the same admitted-owner order");
});



test("deletion also refuses an actively resuming approval", async () => {
  const service = await loadCore("automations/service.js");
  const fixture = await makeApprovalCase("delete-resuming");
  const ready = await wait(fixture);
  let release;
  fixture.toolGate = new Promise(resolve => { release = resolve; });
  await fixture.decide(ready.historyId, await fixture.pending(ready.historyId));
  await until(() => configuredCalls(fixture).length === 1);
  try {
    const active = await history.getAutomationRun(ready.historyId);
    assert.equal(active.status, "resuming");
    const before = await resources.resourceGetByPath(owner, fixture.automation.resource.path);
    await assert.rejects(service.deleteAutomation(actor, "personal", fixture.automation.name), /Resolve the waiting approval/);
    assert.deepEqual(await resources.resourceGetByPath(owner, before.path), before);
    await runManager.abortTurnDurably(active.runId);
    await runManager.abortRunDurably(active.runId);
    assert.equal((await fixture.terminal(ready.historyId)).status, "interrupted");
    assert.equal(configuredCalls(fixture).length, 1);
  } finally { release(); }
  await service.deleteAutomation(actor, "personal", fixture.automation.name);
  assert.equal(await resources.resourceGetByPath(owner, fixture.automation.resource.path), null);
});


for (const kind of ["legacy-shared", "legacy-personal-org", "scoped-personal", "scoped-organization", "forged-retained-creator"])
  test(`${kind} terminal recovery preserves the retained execution identity`, async () => {
    const result = await child("identity-" + kind, "identity-" + kind);
    assert.equal(result.status, "declined");
    assert.equal(result.outcomeReconciled, kind === "forged-retained-creator" ? 0 : 1);
    assert.equal(result.resourceStatus, kind === "forged-retained-creator" ? "waiting_approval" : "declined");
    assert.equal(result.additionalEffects, 0);
    assert.equal(result.additionalModelCalls, 0);
  });

for (const decision of ["approve", "decline"]) for (const dispatchFailure of [false, true])
  test(`fresh webhook follower wakes after ${decision}${dispatchFailure ? " with dispatch recovery" : ""}`, async () => {
    const fixture = await makeApprovalCase(`fifo-${decision}-${dispatchFailure}`, { triggerType: "webhook", repeatLocal: false });
    const dispatcher = await loadCore("triggers/dispatcher.js"), tasks = await loadCore("integrations/pending-tasks-store.js");
    const webhook = await loadCore("integrations/automation-webhook-task.js"), dispatch = await loadCore("integrations/integration-durable-dispatch.js");
    await dispatcher.initTriggerDispatcher(fixture.deps);
    const resource = fixture.automation.resource, externalThreadId = `${owner}:${resource.path}`;
    const originalId = `fifo-original-${decision}-${dispatchFailure}`, followerId = `fifo-follower-${decision}-${dispatchFailure}`;
    const differentId = `fifo-different-${decision}-${dispatchFailure}`;
    const insert = (id, thread = externalThreadId) => tasks.insertPendingTask({ id, platform: "automation-webhook", externalThreadId: thread,
      ownerEmail: owner, orgId: null, externalEventKey: `${resource.id}:${id}`, payload: JSON.stringify({ kind: "automation-webhook",
        automationId: resource.id, owner, path: resource.path, eventId: id, payload: { id } }) });
    await insert(originalId);
    assert.equal(await webhook.runAutomationWebhookTaskInProcess(originalId, { appId }), "waiting_approval");
    const [original] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    await insert(followerId); await insert(differentId, externalThreadId + ":different");
    assert.equal(await tasks.claimPendingTask(followerId), null, "the real waiting task excludes a fresh follower claim");
    const beforeModels = fixture.modelCalls.length;
    assert.equal((await tasks.getPendingTask(followerId)).status, "pending");
    const dispatched = [], resourceAtDispatch = [];
    const register = () => dispatch.setInProcessIntegrationTaskRunner(async (id, options) => {
      dispatched.push(id);
      const meta = frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta;
      resourceAtDispatch.push(meta.lastStatus);
      assert.ok(["success", "declined"].includes(meta.lastStatus), "terminal resource precedes follower dispatch");
      assert.equal((await tasks.getPendingTask(originalId)).status, decision === "approve" ? "completed" : "failed");
      const previous = fixture.engine.stream;
      // The follower completes through the same Native task/runner, with no configured action.
      fixture.engine.stream = async function* (options) {
        fixture.modelCalls.push(structuredClone(options.messages));
        assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...surface.UNATTENDED_TOOLS, mcpName].sort());
        yield { type: "assistant-content", parts: [{ type: "text", text: "Follower complete." }] };
        yield { type: "stop", reason: "end_turn" };
      };
      try { return await webhook.runAutomationWebhookTaskInProcess(id, options); }
      finally { fixture.engine.stream = previous; }
    }, { appId, platforms: ["automation-webhook"] });
    const pending = await fixture.pending(original.id);
    try {
      if (!dispatchFailure) register();
      if (dispatchFailure) {
        dispatch.setInProcessIntegrationTaskRunner(null);
        if (decision === "decline") await assert.rejects(fixture.decide(original.id, pending, decision), /dispatch must be retried/);
        else {
          await fixture.decide(original.id, pending, decision);
          await until(async () => (await tasks.getPendingTask(followerId)).lastDispatchOutcome === "failed");
        }
        assert.equal(Boolean((await history.getAutomationContinuation(original.id)).outcomeReconciled), false);
        assert.equal((await tasks.getPendingTask(followerId)).status, "pending");
        assert.equal((await tasks.getPendingTask(followerId)).lastDispatchOutcome, "failed");
        register();
        await runner.reconcileAutomationApprovalOutcomes(appId);
      } else await fixture.decide(original.id, pending, decision);
      if (decision === "decline") assert.deepEqual(dispatched, [followerId], "settled decline immediately schedules its fresh follower");
      await until(async () => (await tasks.getPendingTask(followerId)).status === "completed");
      assert.deepEqual(dispatched, [followerId]);
      assert.deepEqual(resourceAtDispatch, [decision === "approve" ? "success" : "declined"]);
      assert.equal((await tasks.getPendingTask(followerId)).attempts, 1);
      assert.ok(Date.now() - (await tasks.getPendingTask(followerId)).createdAt < 90_000, "no aging or generic sweep");
      assert.equal((await tasks.getPendingTask(differentId)).status, "pending");
      assert.equal((await tasks.getPendingTask(differentId)).attempts, 0);
      assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
      assert.equal(Boolean((await history.getAutomationContinuation(original.id)).outcomeReconciled), true);
      await runner.reconcileAutomationApprovalOutcomes(appId);
      await assert.rejects(fixture.decide(original.id, pending, decision), /no longer waiting/);
      assert.deepEqual(dispatched, [followerId]);
      assert.equal(configuredCalls(fixture).length, decision === "approve" ? 1 : 0);
      assert.ok(fixture.modelCalls.length > beforeModels);
      assert.equal(await tasks.claimPendingTask(followerId), null);
    } finally {
      dispatch.setInProcessIntegrationTaskRunner(null);
      await tasks.markTaskFailed(differentId, "Fixture ended without dispatch.");
    }
  });


for (const decision of ["approve", "decline"]) for (const boundary of ["normal", "crash"])
  test(`webhook history/task ${boundary} wait converges through fresh-process ${decision}`, async () => {
    const name = `split-wait-${boundary}-${decision}`;
    const waiting = await child(`gap-webhook-${boundary}`, name);
    assert.equal(waiting.faultHits, boundary === "crash" ? 1 : 0);
    assert.equal(waiting.taskStatus, boundary === "crash" ? "processing" : "waiting_approval");
    if (boundary === "crash") {
      assert.equal(waiting.configuredEffects, 0); assert.equal(waiting.modelCalls, 2);
      const state = await history.getAutomationContinuation(waiting.historyId);
      assert.equal(state.storedStatus, "waiting_approval"); assert.equal(state.run.finishedAt, null);
      assert.equal(state.run.approvalReady, false, "SIGKILL skipped normal error handling and finalization");
      assert.equal(state.context.askId, waiting.pending.askId);
      await runStore.updateRunStatus(waiting.runId, "aborted");
    }
    const result = await child(`gap-webhook-recover-${decision}`, name, waiting.historyId);
    const expected = decision === "approve" ? "success" : "declined";
    assert.equal(result.result.id, waiting.historyId); assert.equal(result.result.threadId, waiting.threadId);
    assert.equal(result.turn.turnId, waiting.pending.turnId); assert.equal(result.pending.askId, waiting.pending.askId);
    assert.equal(result.result.status, expected); assert.equal(result.outcomeReconciled, true);
    assert.equal(result.configuredEffects, decision === "approve" ? 1 : 0);
    assert.equal(result.modelCalls, decision === "approve" ? 2 : 1, "only the explicit continuation and one FIFO follower use a model");
    assert.equal(result.askStatus, decision === "approve" ? "consumed" : "declined");
    assert.equal(result.taskStatus, decision === "approve" ? "completed" : "failed");
    assert.equal(result.followerStatus, "completed");
    assert.deepEqual(result.dispatched, [waiting.followerId]);
    assert.deepEqual(result.terminalAtDispatch, [expected], "original terminal bookkeeping precedes the immediate follower");
    assert.equal(result.resourceStatus, "success", "the newer admitted follower owns the final resource");
  });

for (const reason of ["owner", "shutdown"])
  test(`Stop during the real approval predicate preserves ${reason} classification`, async () => {
    const result = await child(`predicate-stop-${reason}`, `predicate-${reason}`);
    assert.equal(result.barrierHit, 1);
    assert.equal(result.selectedStorageFaults, 0);
    assert.equal(result.configuredEffects, 0);
    assert.equal(result.historyStatus, reason === "shutdown" ? "interrupted" : "error");
    assert.equal(result.errorCode, reason === "shutdown" ? history.INTERRUPTED_RUN_ERROR_CODE : "background_automation_aborted");
    assert.equal(result.abortReason, reason === "shutdown" ? "shutdown" : "user");
    if (reason === "shutdown") {
      assert.equal(result.workerResult, "retry");
      assert.equal(result.taskStatus, "pending");
      assert.equal(result.taskAttempts, 0);
    }
  });

test("a thrown task-wait write fails the worker rather than simulating a hard process loss", async () => {
  const fixture = await makeApprovalCase("split-wait-thrown", { triggerType: "webhook", repeatLocal: false });
  const tasks = await loadCore("integrations/pending-tasks-store.js"), dispatcher = await loadCore("triggers/dispatcher.js");
  const webhook = await loadCore("integrations/automation-webhook-task.js");
  await dispatcher.initTriggerDispatcher(fixture.deps);
  const resource = fixture.automation.resource, id = "split-wait-thrown-task";
  await tasks.insertPendingTask({ id, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
    ownerEmail: owner, orgId: null, externalEventKey: id, payload: JSON.stringify({ kind: "automation-webhook",
      automationId: resource.id, owner, path: resource.path, eventId: id, payload: {} }) });
  const db = database.getDbExec(), execute = db.execute.bind(db); let hits = 0;
  db.execute = async statement => {
    const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
    if (sql.startsWith("UPDATE integration_pending_tasks SET status = 'waiting_approval'") && statement.args?.includes(id)) {
      hits++; throw new Error("Selected task wait write error.");
    }
    return execute(statement);
  };
  let workerResult;
  try { workerResult = await webhook.runAutomationWebhookTaskInProcess(id, { appId }); }
  finally { db.execute = execute; }
  const [run] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
  const diagnostic = {
    faultHits: hits,
    workerResult,
    historyStatus: run?.status ?? null,
    historyErrorCode: run?.errorCode ?? null,
    historyFinished: Boolean(run?.finishedAt),
    taskStatus: (await tasks.getPendingTask(id))?.status ?? null,
    configuredEffectCount: configuredCalls(fixture).length,
  };
  console.log("[approval108 thrown task-wait diagnostic] " + JSON.stringify(diagnostic));
  assert.equal(hits, 1);
  assert.equal(workerResult, "failed");
  assert.ok(run.finishedAt); assert.equal(run.status, "error"); assert.equal(configuredCalls(fixture).length, 0);
  assert.equal(run.errorCode, "automation_approval_storage_failed");
  const retained = await history.getAutomationContinuation(run.id);
  const retryTask = await tasks.getPendingTask(id);
  assert.equal(retryTask.status, "pending", "ordinary worker failure retains custody for terminal reconciliation");
  assert.deepEqual(JSON.parse(retryTask.payload), { kind: "automation-webhook", automationId: resource.id,
    owner, path: resource.path, eventId: id, payload: {} });
  assert.equal(retained.context.options.webhookTaskId, id);
  assert.equal(retained.context.historyId, run.id);
  assert.equal(retained.context.threadId, run.threadId);
  assert.equal((await approvalStore.readAgentToolApproval(retained.context)).status, "pending");
  const modelCount = fixture.modelCalls.length;
  assert.equal(await webhook.runAutomationWebhookTaskInProcess(id, { appId }), "skipped",
    "a retry delivery restores retained custody instead of starting another Native run");
  assert.equal(fixture.modelCalls.length, modelCount);
  assert.equal(configuredCalls(fixture).length, 0);
  await runner.reconcileAutomationApprovalOutcomes(appId);
  assert.equal((await tasks.getPendingTask(id)).status, "failed");
  assert.equal(Boolean((await history.getAutomationContinuation(run.id)).outcomeReconciled), true);
  assert.equal(frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta.lastStatus, "error");
  await runner.reconcileAutomationApprovalOutcomes(appId);
  assert.equal(await webhook.runAutomationWebhookTaskInProcess(id, { appId }), "skipped");
  await assert.rejects(fixture.decide(run.id, retained.context), /no longer waiting/);
  assert.equal(fixture.modelCalls.length, modelCount, "reconciliation, duplicate delivery and decision do not redispatch");
  assert.equal(configuredCalls(fixture).length, 0);
});

test("a generic event execution error keeps ordinary event handling", async () => {
  const fixture = await makeApprovalCase("ordinary-event-error", { triggerType: "event", repeatLocal: false });
  const dispatcher = await loadCore("triggers/dispatcher.js");
  fixture.engine.stream = async function* (options) {
    fixture.modelCalls.push(structuredClone(options.messages));
    throw new Error("Ordinary fixture event failure.");
  };
  await dispatcher.initTriggerDispatcher(fixture.deps);
  await bus.emit("test.event.fired", { id: "ordinary-error-event" }, { owner });
  const run = await until(async () => {
    const [row] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    return row?.finishedAt ? row : null;
  });
  assert.equal(run.status, "error");
  assert.notEqual(run.errorCode, "automation_approval_storage_failed");
  assert.notEqual(run.errorCode, history.INTERRUPTED_RUN_ERROR_CODE);
  assert.ok(fixture.modelCalls.length > 0);
  assert.equal(configuredCalls(fixture).length, 0);
  assert.equal((await history.getAutomationContinuation(run.id)).context, null);
});

test("retention preserves the original ask chunk after actual continuation attachment and process loss", async () => {
  const name = "retained-attachment-crash", waiting = await child("gap-retention-crash", name);
  assert.equal(waiting.faultHits, 1); assert.equal(waiting.configuredEffects, 0); assert.equal(waiting.modelCalls, 2);
  assert.notEqual(waiting.resumeRunId, waiting.runId);
  const state = await history.getAutomationContinuation(waiting.historyId);
  assert.equal(state.storedStatus, "resuming"); assert.equal(state.run.runId, waiting.resumeRunId);
  assert.equal(state.context.runId, waiting.runId); assert.equal(state.context.askId, waiting.pending.askId);
  assert.equal((await approvalStore.readAgentToolApproval(waiting.pending)).status, "pending");
  const events = await runStore.getRunEventsSince(waiting.runId, -1); assert.ok(events.length);
  await database.getDbExec().execute({ sql: "UPDATE agent_runs SET completed_at = ? WHERE id = ?",
    args: [Date.now() - 25 * 60 * 60_000, waiting.runId] });
  await runStore.cleanupOldRuns(24 * 60 * 60_000);
  assert.equal(await runStore.getRunStatus(waiting.runId), "completed", "pending original gate evidence survives mandatory attachment");
  assert.deepEqual(await runStore.getRunEventsSince(waiting.runId, -1), events);
  const recovered = await child("gap-retention-recover-decline", name, waiting.historyId);
  assert.equal(recovered.result.id, waiting.historyId); assert.equal(recovered.result.threadId, waiting.threadId);
  assert.equal(recovered.turn.turnId, waiting.pending.turnId); assert.equal(recovered.pending.askId, waiting.pending.askId);
  assert.equal(recovered.result.status, "declined"); assert.equal(recovered.resourceStatus, "declined");
  assert.equal(recovered.outcomeReconciled, true); assert.equal(recovered.askStatus, "declined");
  assert.equal(recovered.configuredEffects, 0); assert.equal(recovered.modelCalls, 0);
  await runStore.cleanupOldRuns(24 * 60 * 60_000);
  assert.equal(await runStore.getRunStatus(waiting.runId), null, "ordinary pruning resumes after settlement");
  assert.deepEqual(await runStore.getRunEventsSince(waiting.runId, -1), []);
});

for (const kind of ["personal", "shared", "personal-org", "org-admin"])
  test(`supported legacy ${kind} deletion retains waiting and resuming approvals`, async () => {
    const result = await child("gap-delete-" + kind, "legacy-delete-" + kind);
    assert.equal(result.waitingRefused, true); assert.equal(result.resumingRefused, true);
    assert.equal(result.deleted, true); assert.equal(result.configuredEffects, 0);
    assert.equal(result.historyOwner, kind.includes("org") ? resources.organizationResourceOwner("delete-org-legacy-delete-" + kind) : owner);
  });

test("PostgreSQL pruning SQL adapter/query contract retains the original pending-context selector", async () => {
  const result = await child("postgres-retention", "postgres-retention");
  assert.equal(result.pruneQueries.length, 1);
  assert.match(result.pruneQueries[0], /approval_history\.approval_context::jsonb ->> 'runId'/);
});


test("authorized org-admin deletes an ordinary job after its creator leaves without execution", async () => {
  const result = await child("gap-delete-org-departed-no-wait", "legacy-delete-departed-no-wait");
  assert.equal(result.executionRefused, true); assert.equal(result.deleted, true); assert.equal(result.configuredEffects, 0);
});

for (const kind of ["org-departed-wait", "org-scope-missing", "org-scope-conflict"])
  test(`legacy deletion refuses ${kind} before definition or token mutation`, async () => {
    const result = await child("gap-delete-" + kind, "legacy-delete-" + kind);
    assert.equal(result.waitingRefused, true); assert.equal(result.resumingRefused, true);
    assert.equal(result.deleted, true); assert.equal(result.configuredEffects, 0);
    assert.equal(result.membershipRestoredForDecline, kind === "org-departed-wait");
    assert.equal(result.scopeRefused, kind.startsWith("org-scope-"));
  });

test("a webhook encountering another ready wait after its initial check returns retry with exact FIFO custody", async () => {
  const fixture = await makeApprovalCase("webhook-late-contention", { triggerType: "webhook", repeatLocal: false });
  const tasks = await loadCore("integrations/pending-tasks-store.js"), dispatcher = await loadCore("triggers/dispatcher.js");
  const webhook = await loadCore("integrations/automation-webhook-task.js");
  await dispatcher.initTriggerDispatcher(fixture.deps);
  const resource = fixture.automation.resource, id = "late-contention-0-task", follower = "late-contention-1-follower";
  const insert = taskId => tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
    ownerEmail: owner, orgId: null, externalEventKey: taskId, payload: JSON.stringify({ kind: "automation-webhook",
      automationId: resource.id, owner, path: resource.path, eventId: taskId, payload: {} }) });
  await insert(id);
  const db = database.getDbExec(), execute = db.execute.bind(db);
  let initialClear = false, barrierHit = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  db.execute = async statement => {
    const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
    const result = await execute(statement);
    if (sql.startsWith("SELECT 1 FROM automation_runs WHERE owner = ? AND path = ?") &&
        statement.args?.includes(resource.path) && !initialClear) {
      assert.equal(result.rows.length, 0); initialClear = true;
    } else if (initialClear && !barrierHit && sql.startsWith("SELECT") && sql.includes("FROM resources") &&
        statement.args?.includes(owner) && statement.args?.includes(resource.path)) {
      barrierHit++; await gate;
    }
    return result;
  };
  const work = webhook.runAutomationWebhookTaskInProcess(id, { appId });
  let unrelated;
  try {
    await until(() => barrierHit === 1);
    await insert(follower);
    unrelated = await wait(fixture);
    const pending = await fixture.pending(unrelated.historyId);
    assert.equal(pending.options.webhookTaskId, undefined, "this wait belongs to another real execution");
    const models = fixture.modelCalls.length, calls = fixture.calls.length;
    release();
    assert.equal(await work, "retry");
    assert.equal(barrierHit, 1);
    const task = await tasks.getPendingTask(id);
    assert.equal(task.status, "pending"); assert.equal(task.attempts, 0);
    assert.equal(task.ownerEmail, owner); assert.equal(task.externalThreadId, `${owner}:${resource.path}`);
    assert.equal(JSON.parse(task.payload).eventId, id);
    assert.equal((await tasks.getPendingTask(follower)).status, "pending");
    assert.equal(await tasks.claimPendingTask(follower), null);
    assert.equal(fixture.modelCalls.length, models); assert.equal(fixture.calls.length, calls);
    assert.equal(configuredCalls(fixture).length, 0);
    await fixture.decide(unrelated.historyId, pending, "decline");
    assert.equal(await webhook.runAutomationWebhookTaskInProcess(id, { appId }), "waiting_approval");
    const current = (await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId })).find(run => run.id !== unrelated.historyId);
    const currentPending = await fixture.pending(current.id);
    assert.equal(currentPending.options.webhookTaskId, id);
    assert.equal((await tasks.getPendingTask(id)).status, "waiting_approval");
    const waitingModels = fixture.modelCalls.length;
    assert.equal(await webhook.runAutomationWebhookTaskInProcess(id, { appId }), "skipped");
    assert.equal(fixture.modelCalls.length, waitingModels); assert.equal(configuredCalls(fixture).length, 0);
    await tasks.markTaskFailed(follower, "Fixture cleanup after FIFO custody assertions.");
    await fixture.decide(current.id, currentPending, "decline");
    assert.equal((await tasks.getPendingTask(id)).status, "failed");
  } finally { release(); db.execute = execute; await work; }
});

for (const surface of ["modern-schedule", "modern-webhook", "legacy"]) for (const order of ["lock", "delete"])
  test(`${surface} deletion and real wait serialize ${order} custody without replacing a definition`, async () => {
    const result = await child(`gap-delete-race-${surface}-${order}`, `delete-race-${surface}-${order}`);
    assert.equal(result.predicateHit, 1); assert.equal(result.configuredEffects, 0);
    assert.ok(["wait", "delete"].includes(result.winner));
    assert.equal(result.deleteBarrierHit, order === "lock" ? 1 : 0);
    if (order === "delete") { assert.equal(result.winner, "delete"); assert.equal(result.terminalCode, "automation_approval_changed"); }
  });


test("fresh-process webhook deletion initializes both cold stores before custody and exits naturally", async () => {
  const name = "cold-webhook-delete";
  const seeded = await child("cold-webhook-seed-no-wait", name);
  assert.equal(seeded.modelCalls, 0); assert.equal(seeded.toolCalls, 0);
  const deleted = await child("cold-webhook-delete-no-wait", name);
  assert.equal(deleted.resourceId, seeded.resourceId);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.tokenInitializations, 1); assert.equal(deleted.secretInitializations, 1);
  assert.deepEqual(deleted.initializationInsideCustody, []);
  assert.equal(deleted.modelCalls, 0); assert.equal(deleted.toolCalls, 0);
});

test("fresh-process webhook deletion refuses an existing wait without changing custody", async () => {
  const name = "cold-webhook-wait";
  const seeded = await child("cold-webhook-seed-wait", name);
  const preserved = await child("cold-webhook-delete-wait", name, seeded.result.historyId);
  assert.equal(preserved.preserved, true);
  assert.equal(preserved.resourceId, seeded.resourceId);
  assert.equal(preserved.historyId, seeded.result.historyId);
  assert.equal(preserved.threadId, seeded.result.threadId);
  assert.equal(preserved.turnId, seeded.result.turnId);
  assert.equal(preserved.askId, seeded.askId);
  assert.equal(preserved.tokenDigest, seeded.tokenDigest);
  assert.equal(preserved.secretDigest, seeded.secretDigest);
  assert.equal(preserved.modelCalls, 0); assert.equal(preserved.toolCalls, 0);
  assert.equal(preserved.deleted, true, "supported owner decline permits subsequent deletion");
});

test("public SQLite close queues behind custody and permits a fresh singleton", async () => {
  const receipt = await child("cold-close", "queued-public-close");
  assert.equal(receipt.closedAfterRelease, true);
  assert.equal(receipt.reopened, true); assert.equal(receipt.oldExecutorRejected, true);
  assert.equal(receipt.modelCalls, 0); assert.equal(receipt.toolCalls, 0);
});
