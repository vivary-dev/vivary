// Issue #205: outcomes of an approved continuation. Each case failed against the
// Core patch before the fix. This file owns its database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval205c-"));
const url = `file:${path.join(root, "continuation.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Continuation tests forbid outward network calls."); };
const { runner, history, runStore, database, restoreTimers, makeApprovalCase, appId, mcpName, until } =
  await import("./fixtures/automation-approval-fixture.mjs");
after(async () => {
  globalThis.fetch = savedFetch;
  restoreTimers();
  await database.closeDbExec();
  await rm(root, { recursive: true, force: true });
});

const db = () => database.getDbExec();
const sqlOf = statement => String(statement?.sql ?? statement);
const configuredCalls = fixture => fixture.calls.filter(call => call.name === mcpName).length;
const asksFor = async threadId => (await db().execute({ sql: "SELECT id, status FROM agent_tool_approvals WHERE thread_id = ? ORDER BY created_at",
  args: [threadId] })).rows.map(row => ({ id: String(row.id), status: String(row.status) }));

async function waitingCase(name, options) {
  const fixture = await makeApprovalCase(name, { repeatLocal: false, ...options });
  const result = await fixture.start();
  assert.equal(result.status, "waiting_approval");
  await until(async () => (await history.getAutomationRun(result.historyId)).approvalReady);
  return { fixture, result, pending: await fixture.pending(result.historyId) };
}
// Route statements through `fault` while it returns true for them.
function faultStatements(fault) {
  const client = db(), execute = client.execute;
  client.execute = async statement => {
    if (await fault(sqlOf(statement), statement?.args ?? [], statement => execute.call(client, statement)))
      throw new Error("selected storage failure");
    return execute.call(client, statement);
  };
  return () => { client.execute = execute; };
}
async function quietly(work) {
  const error = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = error; }
}

test("a grant that expires before its consumption ends the run as not executed and writes no new ask", async () => {
  const { fixture, result, pending } = await waitingCase("unconsumed-grant");
  // The ask expires after the owner's decision and before the continuation consumes it.
  const restore = faultStatements(async (sql, args, execute) => {
    if (sql.includes("UPDATE agent_tool_approvals") && sql.includes("SET status = 'consumed'") && args[3] === pending.askId)
      await execute({ sql: "UPDATE agent_tool_approvals SET expires_at = ? WHERE id = ?", args: [Date.now() - 1000, pending.askId] });
    return false;
  });
  let run;
  try {
    await fixture.decide(result.historyId, pending, "approve");
    run = await quietly(() => fixture.terminal(result.historyId));
  } finally { restore(); }
  assert.equal(run.status, "error", "the action is known not to have run");
  assert.equal(run.errorCode, "automation_approval_unconsumed");
  assert.equal(configuredCalls(fixture), 0);
  const asks = await asksFor(result.threadId);
  assert.deepEqual(asks.map(ask => ask.id), [pending.askId], "the continuation wrote no second ask");
  assert.equal((await history.getAutomationContinuation(result.historyId)).context.askId, pending.askId);
});

test("an approved tool that returns an error is a failure the model sees, not an unconfirmed outcome", async () => {
  const { fixture, result, pending } = await waitingCase("approved-tool-error");
  fixture.manager.callTool = async (name, input) => {
    fixture.calls.push({ name, input: structuredClone(input) });
    throw new Error("fixture configured tool failure");
  };
  const stream = fixture.engine.stream.bind(fixture.engine);
  fixture.engine.stream = async function* (options) {
    if (JSON.stringify(options.messages).includes("fixture configured tool failure")) {
      fixture.modelCalls.push(structuredClone(options.messages));
      yield { type: "assistant-content", parts: [{ type: "text", text: "The configured step failed." }] };
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    yield* stream(options);
  };
  await fixture.decide(result.historyId, pending, "approve");
  const run = await fixture.terminal(result.historyId);
  assert.equal(run.status, "success", `the model handled the tool error (${run.errorCode}: ${run.error})`);
  assert.equal(configuredCalls(fixture), 1, "the approved action ran once");
  assert.ok(JSON.stringify(fixture.modelCalls.at(-1)).includes("fixture configured tool failure"), "the model saw the tool error");
});

test("a failed readiness write keeps the saved wait, and the owner's decision recovers it", async () => {
  const fixture = await makeApprovalCase("readiness-write-failure", { repeatLocal: false });
  let faults = 0;
  const restore = faultStatements(async sql => sql.includes("SET approval_ready = 1") && faults++ === 0);
  let result;
  try {
    result = await quietly(() => fixture.start().catch(error => ({ status: "rejected", error })));
  } finally { restore(); }
  assert.equal(faults, 1);
  assert.equal(result.status, "waiting_approval", `the run returned waiting (${result.error?.message})`);
  const waiting = await history.getAutomationRun(result.historyId);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.approvalReady, false);
  assert.equal(waiting.finishedAt, null);
  await fixture.decide(result.historyId, await fixture.pending(result.historyId), "approve");
  const run = await fixture.terminal(result.historyId);
  assert.equal(run.status, "success");
  assert.equal(configuredCalls(fixture), 1);
});

test("a continuation whose Native finalization rejected still settles its known outcome", async () => {
  const { fixture, result, pending } = await waitingCase("finalization-rejected");
  let terminalFaults = 0, finishFaults = 0, faulting = true;
  const restore = faultStatements(async (sql, args) => {
    if (!faulting) return false;
    // Native cannot store the continuation's terminal event, so its finalization rejects.
    if (sql.includes("INSERT INTO agent_run_events") && String(args[0]).startsWith("automation-approval-") &&
      String(args[3]).includes('"type":"done"')) return ++terminalFaults > 0;
    // Every history finish fails, so only the retained known outcome survives.
    if (sql.startsWith("UPDATE automation_runs SET status = ?, finished_at = ?") && args[4] === result.historyId)
      return ++finishFaults > 0;
    return false;
  });
  let continuation;
  try {
    await fixture.decide(result.historyId, pending, "approve");
    continuation = await quietly(() => until(async () => {
      const state = await history.getAutomationContinuation(result.historyId);
      return finishFaults >= 3 && state.context?.terminalOutcome ? state : null;
    }));
  } finally {
    faulting = false;
    restore();
  }
  assert.ok(terminalFaults > 0, "the terminal event write was faulted");
  const resumeRunId = continuation.context.terminalOutcome.runId;
  assert.equal(continuation.run.finishedAt, null);
  assert.equal(configuredCalls(fixture), 1);
  // The stale-run reaper later ends the Native row that finalization left running.
  await runStore.updateRunStatus(resumeRunId, "errored");
  await quietly(() => runner.reconcileAutomationApprovalOutcomes(appId));
  const run = await history.getAutomationRun(result.historyId);
  assert.ok(run.finishedAt, "the known outcome settled once Native ended the run");
  assert.equal(run.status, continuation.context.terminalOutcome.status);
  assert.equal(configuredCalls(fixture), 1, "settlement ran nothing again");
});
