// Real installed Native completion owners, isolated so shutdown can drain them.
import assert from "node:assert/strict";
const [role, name] = process.argv.slice(2);
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary",
  AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: "true", AGENT_NATIVE_DISABLE_RECURRING_JOBS: "true" });
globalThis.fetch = async () => { throw new Error("Completion fixture forbids outward network calls."); };
const f = await import("./automation-approval-fixture.mjs");
const waiting = role.includes("-wait-");
const inject = role.endsWith("-fault");
const fixture = await f.makeApprovalCase(name, { repeatLocal: false });
fixture.engine.stream = async function* (options) {
  fixture.modelCalls.push(structuredClone(options.messages));
  assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...f.surface.UNATTENDED_TOOLS, f.mcpName].sort());
  if (waiting) {
    yield { type: "assistant-content", parts: [{ type: "tool-call", name: f.mcpName, id: "completion-gate", input: f.toolInput }] };
    yield { type: "stop", reason: "tool_use" };
  } else {
    yield { type: "assistant-content", parts: [{ type: "text", text: "Selected completion text." }] };
    yield { type: "stop", reason: "end_turn" };
  }
};
const db = f.database.getDbExec();
assert.equal(db, f.database.getDbExec());
const originalExecute = db.execute;
const execute = originalExecute.bind(db);
const normalize = statement => String(typeof statement === "string" ? statement : statement.sql).replace(/\s+/g, " ").trim();
let saved = null, successfulThreadSaves = 0, markerReads = 0, faultHits = 0;
const selectedError = new Error("selected completion turn-abort lookup failed");
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within eight seconds`)), 8_000);
    })]);
  } finally { clearTimeout(timer); }
};
db.execute = async statement => {
  const sql = normalize(statement);
  if (saved && sql === "SELECT id FROM agent_runs WHERE id = ? AND thread_id = ? AND status = 'aborted' LIMIT 1" &&
    statement.args?.[0] === `turn-abort-${saved.run_id}` && statement.args?.[1] === saved.thread_id) {
    markerReads++;
    if (inject && faultHits === 0) {
      faultHits++;
      console.log("COMPLETION_MARKER_FAULT " + JSON.stringify({ faultHits, successfulThreadSaves, markerReads,
        historyId: saved.id, runId: saved.run_id, threadId: saved.thread_id }));
      throw selectedError;
    }
    const result = await execute(statement);
    assert.equal(result.rows.length, 0, "the matching no-fault marker read is healthy");
    return result;
  }
  const result = await execute(statement);
  if (sql.startsWith("UPDATE chat_threads SET thread_data = ?") && result.rowsAffected === 1) {
    const repo = JSON.parse(statement.args[0]);
    if (repo._automationRunId && repo.messages?.some(item => (item.message ?? item).role === "assistant")) {
      const { rows } = await execute({ sql: "SELECT id, run_id, thread_id FROM automation_runs WHERE id = ? AND owner = ? AND automation = ? AND app_id = ? AND path = ?",
        args: [repo._automationRunId, f.owner, name, f.appId, fixture.automation.resource.path] });
      if (rows.length === 1 && rows[0].thread_id === statement.args[5]) {
        saved = rows[0];
        successfulThreadSaves++;
      }
    }
  }
  return result;
};
let work;
try {
  work = fixture.start().then(result => ({ result }), error => ({ error }));
  const settled = await bounded(work, "automation completion");
  db.execute = originalExecute;
  assert.ok(saved, "selected completion saved actual assistant thread data before the marker read");
  assert.equal(faultHits, inject ? 1 : 0);
  assert.ok(markerReads >= 1);
  assert.equal(successfulThreadSaves, 1);
  const run = await f.history.getAutomationRun(saved.id);
  const { rows: nativeRows } = await execute({ sql: "SELECT status, error_code, error_detail FROM agent_runs WHERE id = ? AND thread_id = ? AND turn_id = ?",
    args: [saved.run_id, saved.thread_id, saved.run_id] });
  assert.equal(nativeRows.length, 1);
  const native = nativeRows[0];
  assert.notEqual(native.status, "running", "actual terminal SQL persisted before runner settlement");
  const data = JSON.parse((await f.threads.getThread(saved.thread_id)).threadData);
  assert.equal(data._automationRunId, saved.id);
  const assistants = data.messages.map(item => item.message ?? item).filter(message => message.role === "assistant");
  assert.equal(assistants.length, 1);
  const pending = await fixture.pending(saved.id);
  let askStatus = null;
  if (inject) {
    assert.equal(settled.error, selectedError, "primary callback error reaches the runner unchanged");
    assert.equal(settled.result, undefined);
    assert.equal(native.status, "errored");
    assert.equal(native.error_code, "completion_error");
    assert.equal(native.error_detail, "Agent response could not be saved.");
    assert.equal(run.status, "error");
    assert.equal(run.errorCode, "background_automation_failed");
    assert.ok(run.finishedAt);
    assert.match(run.error, /selected completion turn-abort lookup failed/);
    if (waiting) {
      assert.ok(pending);
      assert.equal(pending.historyId, run.id);
      assert.equal(pending.threadId, run.threadId);
      assert.equal(pending.turnId, saved.run_id);
      assert.equal(run.pendingAskId, pending.askId);
      assert.equal(run.approvalReady, false);
      askStatus = (await f.approvalStore.readAgentToolApproval(pending)).status;
      assert.equal(askStatus, "pending", "the failed completion did not consume the durable ask");
      assert.equal((await f.runner.inspectAutomationRun(run.id, f.actor, fixture.deps)).pending, null,
        "terminal completion error is not a recovered waiting approval");
      await assert.rejects(fixture.decide(run.id, pending), /no longer waiting/);
    } else {
      assert.equal(pending, null);
      assert.equal(run.pendingAskId, null);
    }
  } else {
    assert.equal(settled.error, undefined);
    assert.equal(settled.result.historyId, saved.id);
    if (waiting) {
      assert.equal(settled.result.status, "waiting_approval");
      assert.equal(run.status, "waiting_approval");
      assert.equal(run.finishedAt, null);
      assert.equal(run.approvalReady, true);
      askStatus = (await f.approvalStore.readAgentToolApproval(pending)).status;
      assert.equal(askStatus, "pending");
      await fixture.decide(run.id, pending, "decline");
      assert.equal((await f.history.getAutomationRun(run.id)).status, "declined");
    } else {
      assert.equal(native.status, "completed");
      assert.equal(run.status, "success");
      assert.ok(run.finishedAt);
      assert.match(JSON.stringify(assistants[0].content), /Selected completion text\./);
    }
  }
  db.execute = originalExecute;
  const drain = await bounded(f.runner.interruptBackgroundAutomations(new Promise(() => {})), "tracked completion drain");
  assert.ok(Array.isArray(drain));
  assert.equal(fixture.calls.length, 0, "neither path executes any configured or local tool");
  assert.equal(fixture.modelCalls.length, 1, "no model redispatch");
  console.log("APPROVAL_RESULT " + JSON.stringify({ waiting, inject, faultHits, markerReads, successfulThreadSaves,
    historyId: run.id, threadId: saved.thread_id, turnId: saved.run_id, nativeStatus: native.status,
    nativeErrorCode: native.error_code, historyStatus: run.status, historyErrorCode: run.errorCode,
    askId: pending?.askId ?? null, askStatus, configuredEffects: 0, modelCalls: fixture.modelCalls.length, drained: true }));
} finally {
  db.execute = originalExecute;
  f.restoreTimers();
}
// Natural exit. The maintained parent owns the child timeout and reaping.
