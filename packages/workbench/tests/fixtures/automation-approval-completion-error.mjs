// Real installed Native completion owners, isolated so shutdown can drain them.
import assert from "node:assert/strict";
const [role, name] = process.argv.slice(2);
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary",
  AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: "true", AGENT_NATIVE_DISABLE_RECURRING_JOBS: "true" });
globalThis.fetch = async () => { throw new Error("Completion fixture forbids outward network calls."); };
const f = await import("./automation-approval-fixture.mjs");
const waiting = role.includes("-wait-");
const inject = role.endsWith("-fault");
const webhookMode = role.includes("-webhook-");
const deleteCase = role.includes("-delete-");
const lookupRace = role.includes("-lookup-race-");
const writeRace = role.includes("-write-settled-") ? "settled" : role.includes("-write-reclaimed-") ? "reclaimed" : null;
const taskId = `completion-webhook-${name}`;
const fixture = await f.makeApprovalCase(name, { repeatLocal: false, triggerType: webhookMode ? "webhook" : "schedule" });
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
let saved = null, successfulThreadSaves = 0, markerReads = 0, faultHits = 0, waitPublicationChecks = 0;
let lookupRaceHits = 0, completionWriteHits = 0;
let notifyRace, releaseRace;
const raceReached = new Promise(resolve => { notifyRace = resolve; });
const raceReleased = new Promise(resolve => { releaseRace = resolve; });
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
  if (lookupRace && saved && lookupRaceHits === 0 &&
    sql.startsWith("SELECT id FROM automation_runs WHERE approval_context IS NOT NULL") && statement.args?.[0] === taskId) {
    const { rows } = await execute({ sql: "SELECT status, finished_at FROM automation_runs WHERE id = ?", args: [saved.id] });
    assert.equal(rows[0]?.status, "error"); assert.ok(rows[0].finished_at);
    lookupRaceHits++;
    notifyRace();
    await raceReleased;
  }
  if (writeRace && saved && completionWriteHits === 0 &&
    sql.startsWith("UPDATE integration_pending_tasks SET status = ?, updated_at = ?, completed_at = ?, payload = ?") &&
    statement.args?.[0] === "completed" && statement.args?.[4] === taskId) {
    completionWriteHits++;
    notifyRace();
    await raceReleased;
  }
  if (saved && sql === "SELECT id FROM agent_runs WHERE id = ? AND thread_id = ? AND status = 'aborted' LIMIT 1" &&
    statement.args?.[0] === `turn-abort-${saved.run_id}` && statement.args?.[1] === saved.thread_id) {
    markerReads++;
    if (webhookMode && waiting) {
      const { rows: runs } = await execute({ sql: "SELECT status, pending_ask_id, approval_context FROM automation_runs WHERE id = ?", args: [saved.id] });
      const { rows: tasks } = await execute({ sql: "SELECT status FROM integration_pending_tasks WHERE id = ?", args: [taskId] });
      assert.equal(runs[0]?.status, "waiting_approval", "the selected fault follows durable history wait publication");
      assert.ok(runs[0].pending_ask_id);
      assert.equal(JSON.parse(runs[0].approval_context).options.webhookTaskId, taskId);
      assert.equal(tasks[0]?.status, "waiting_approval", "the actual task transferred to approval custody before completion");
      waitPublicationChecks++;
    }
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
if (webhookMode) {
  const tasks = await f.loadCore("integrations/pending-tasks-store.js");
  const dispatcher = await f.loadCore("triggers/dispatcher.js");
  const worker = await f.loadCore("integrations/automation-webhook-task.js");
  const resource = fixture.automation.resource;
  const payload = { kind: "automation-webhook", automationId: resource.id, owner: f.owner,
    path: resource.path, eventId: taskId, payload: { source: "completion-control" } };
  let receipt, competingClaim;
  try {
    await dispatcher.initTriggerDispatcher(fixture.deps);
    await tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${f.owner}:${resource.path}`,
      ownerEmail: f.owner, orgId: null, externalEventKey: taskId, payload: JSON.stringify(payload) });
    const work = worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId });
    if (lookupRace || writeRace) {
      try {
        await bounded(raceReached, "selected worker interleaving");
        if (lookupRace) {
          await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
          assert.equal((await tasks.getPendingTask(taskId)).status, "failed");
          assert.equal((await f.history.getAutomationContinuation(saved.id)).outcomeReconciled, true);
          assert.equal(f.frontmatter.parseJobResource((await f.resources.resourceGetByPath(f.owner, resource.path)).content).meta.lastStatus, "error");
        } else if (writeRace === "settled") {
          await tasks.markTaskFailed(taskId, "Selected overlapping settlement");
          competingClaim = await tasks.getPendingTask(taskId);
        } else {
          await tasks.markTaskRetryable(taskId, "Selected concurrent retry");
          competingClaim = await tasks.claimPendingTask(taskId, { appId: f.appId, dispatchOutcome: "in-process" });
          assert.equal(competingClaim.status, "processing"); assert.equal(competingClaim.attempts, 2);
        }
      } finally { releaseRace(); }
    }
    const workerResult = await bounded(work, "webhook completion");
    db.execute = originalExecute;
    const run = saved ? await f.history.getAutomationRun(saved.id) : null;
    const retained = run ? await f.history.getAutomationContinuation(run.id) : null;
    const task = await tasks.getPendingTask(taskId);
    const native = saved ? (await execute({ sql: "SELECT status, error_code, error_detail FROM agent_runs WHERE id = ? AND thread_id = ?",
      args: [saved.run_id, saved.thread_id] })).rows[0] : null;
    let deletionError, beforeDeletion, afterDeletion, tokenBefore, tokensAfter, secretBefore, secretAfter;
    if (deleteCase) {
      beforeDeletion = await f.resources.resourceGetByPath(f.owner, resource.path);
      tokenBefore = (await execute({ sql: "SELECT * FROM automation_webhook_tokens WHERE automation_id = ?", args: [resource.id] })).rows;
      const token = tokenBefore[0];
      const secretStatement = { sql: "SELECT id, scope, scope_id, key, created_at FROM app_secrets WHERE scope = ? AND scope_id = ? AND key = ?",
        args: [token.secret_scope, token.secret_scope_id, token.secret_key] };
      secretBefore = (await execute(secretStatement)).rows;
      try { await f.service.deleteAutomation(f.actor, "personal", name); }
      catch (error) { deletionError = error; }
      afterDeletion = await f.resources.resourceGetByPath(f.owner, resource.path);
      tokensAfter = (await execute({ sql: "SELECT * FROM automation_webhook_tokens WHERE automation_id = ?", args: [resource.id] })).rows;
      secretAfter = (await execute(secretStatement)).rows;
      const retainedAfter = await f.history.getAutomationContinuation(run.id);
      const listed = await f.history.listAutomationRuns({ owners: [f.owner], automation: name, appId: f.appId });
      // Safe evidence precedes the guard assertions on either matching runtime.
      console.log("TERMINAL_APPROVAL_DELETE_DIAGNOSTIC " + JSON.stringify({ faultHits, workerResult,
        deletionAllowed: !deletionError, resourcePresent: Boolean(afterDeletion), tokenPresent: tokensAfter.length === 1,
        secretPresent: secretAfter.length === 1, historyStatus: retainedAfter?.run.status ?? null,
        retainedContext: Boolean(retainedAfter?.context), outcomeReconciled: retainedAfter?.outcomeReconciled ?? null,
        listedRetainedHistory: listed.some(item => item.id === run.id), modelCalls: fixture.modelCalls.length,
        configuredEffects: fixture.calls.length }));
    }
    // The old matched runtime reaches actual reconciliation and exposes its
    // stranded marker before the same behavioral assertions fail below.
    let baselineReconciliationAttempted = false;
    if (waiting && inject && !lookupRace && !deleteCase && workerResult === "completed") {
      baselineReconciliationAttempted = true;
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
    }
    console.log("WEBHOOK_COMPLETION_DIAGNOSTIC " + JSON.stringify({ waiting, inject, faultHits,
      workerResult, lookupRaceHits, completionWriteHits, successfulThreadSaves, waitPublicationChecks, nativeStatus: native?.status ?? null,
      nativeErrorCode: native?.error_code ?? null, historyStatus: run?.status ?? null,
      historyErrorCode: run?.errorCode ?? null, historyFinished: Boolean(run?.finishedAt),
      taskStatus: task?.status ?? null, payloadEmpty: task?.payload === "{}", retainedContext: Boolean(retained?.context),
      baselineReconciliationAttempted, outcomeReconciled: run ? Boolean((await f.history.getAutomationContinuation(run.id)).outcomeReconciled) : null,
      configuredEffects: fixture.calls.length, modelCalls: fixture.modelCalls.length }));
    assert.ok(saved); assert.equal(successfulThreadSaves, 1);
    assert.equal(faultHits, inject ? 1 : 0); assert.ok(markerReads >= 1);
    assert.equal(fixture.modelCalls.length, 1); assert.equal(fixture.calls.length, 0);
    assert.notEqual(native.status, "running", "the worker settles only after Native terminal storage");
    if (inject) {
      assert.equal(native.status, "errored"); assert.equal(native.error_code, "completion_error");
      assert.equal(run.status, "error"); assert.equal(run.errorCode, "background_automation_failed");
      assert.match(run.error, /selected completion turn-abort lookup failed/);
    }
    assert.equal((await f.threads.getThread(saved.thread_id)).scope.id, run.id);
    const modelCount = fixture.modelCalls.length;
    if (deleteCase) {
      assert.equal(workerResult, "failed"); assert.ok(waitPublicationChecks >= 1);
      assert.equal(run.status, "error"); assert.ok(run.finishedAt); assert.equal(retained.outcomeReconciled, false);
      assert.ok(retained.context); assert.equal(retained.context.historyId, run.id);
      assert.equal(retained.context.resourceId, resource.id); assert.equal(retained.context.threadId, saved.thread_id);
      assert.equal(retained.context.turnId, saved.run_id); assert.equal(retained.context.askId, run.pendingAskId);
      assert.ok(deletionError, "terminal approval custody refuses service deletion before mutation");
      assert.match(deletionError.message, /approval outcome.*reconcile/);
      assert.deepEqual(afterDeletion, beforeDeletion); assert.deepEqual(tokensAfter, tokenBefore);
      assert.equal(tokenBefore.length, 1); assert.equal(secretBefore.length, 1); assert.deepEqual(secretAfter, secretBefore);
      assert.deepEqual(await f.history.getAutomationContinuation(run.id), retained);
      assert.equal((await tasks.getPendingTask(taskId)).status, "waiting_approval");
      assert.deepEqual(JSON.parse((await tasks.getPendingTask(taskId)).payload), payload);
      assert.equal((await f.approvalStore.readAgentToolApproval(retained.context)).status, "pending");
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
      assert.equal((await f.history.getAutomationContinuation(run.id)).outcomeReconciled, true);
      assert.equal((await tasks.getPendingTask(taskId)).status, "failed");
      await assert.rejects(fixture.decide(run.id, retained.context), /no longer waiting/);
      assert.equal(fixture.modelCalls.length, modelCount); assert.equal(fixture.calls.length, 0);
      await f.service.deleteAutomation(f.actor, "personal", name);
      assert.equal(await f.resources.resourceGetByPath(f.owner, resource.path), null);
      assert.equal(await f.history.getAutomationRun(run.id), null);
      assert.deepEqual((await execute({ sql: "SELECT automation_id FROM automation_webhook_tokens WHERE automation_id = ?", args: [resource.id] })).rows, []);
      const oldToken = tokenBefore[0];
      assert.deepEqual((await execute({ sql: "SELECT id FROM app_secrets WHERE scope = ? AND scope_id = ? AND key = ?",
        args: [oldToken.secret_scope, oldToken.secret_scope_id, oldToken.secret_key] })).rows, []);
      const replacement = await f.makeApprovalCase(name, { repeatLocal: false, triggerType: "webhook" });
      assert.notEqual(replacement.automation.resource.id, resource.id);
      assert.deepEqual(await f.history.listAutomationRuns({ owners: [f.owner], automation: name, appId: f.appId }), []);
      replacement.engine.stream = async function* (options) {
        replacement.modelCalls.push(structuredClone(options.messages));
        yield { type: "assistant-content", parts: [{ type: "text", text: "Replacement generation complete." }] };
        yield { type: "stop", reason: "end_turn" };
      };
      const scheduler = await f.loadCore("jobs/scheduler.js");
      await scheduler.runJobNow(f.owner, name, replacement.deps);
      const replacementHistory = await f.history.listAutomationRuns({ owners: [f.owner], automation: name, appId: f.appId });
      assert.equal(replacementHistory.length, 1); assert.notEqual(replacementHistory[0].id, run.id);
      assert.equal(replacementHistory[0].status, "success"); assert.ok(replacementHistory[0].threadId);
      const replacementResource = await f.resources.resourceGetByPath(f.owner, resource.path);
      assert.equal(replacementResource.id, replacement.automation.resource.id);
      assert.equal(f.frontmatter.parseJobResource(replacementResource.content).meta.lastStatus, "success");
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
      assert.deepEqual(await f.resources.resourceGetByPath(f.owner, resource.path), replacementResource);
      assert.deepEqual(await f.history.listAutomationRuns({ owners: [f.owner], automation: name, appId: f.appId }), replacementHistory);
      assert.equal(replacement.modelCalls.length, 1); assert.equal(replacement.calls.length, 0);
      assert.equal((await f.approvalStore.readAgentToolApproval(retained.context)).status, "pending");
    } else if (lookupRace) {
      assert.equal(lookupRaceHits, 1); assert.ok(waitPublicationChecks >= 1);
      assert.equal(workerResult, "failed"); assert.equal(task.status, "failed"); assert.equal(task.payload, "{}");
      assert.equal(run.status, "error"); assert.ok(run.finishedAt);
      assert.equal(retained.outcomeReconciled, true);
      assert.equal((await f.approvalStore.readAgentToolApproval(retained.context)).status, "pending");
      assert.equal((await f.runner.inspectAutomationRun(run.id, f.actor, fixture.deps)).pending, null);
      await assert.rejects(fixture.decide(run.id, retained.context), /no longer waiting/);
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
      assert.equal((await tasks.getPendingTask(taskId)).status, "failed");
      assert.equal(f.frontmatter.parseJobResource((await f.resources.resourceGetByPath(f.owner, resource.path)).content).meta.lastStatus, "error");
    } else if (writeRace) {
      assert.equal(completionWriteHits, 1); assert.equal(workerResult, "failed");
      assert.equal(run.status, "error"); assert.ok(run.finishedAt); assert.equal(retained.context, null);
      assert.deepEqual(task, competingClaim, "the completion write cannot replace a settled row or a later processing claim");
      assert.equal(task.status, writeRace === "settled" ? "failed" : "processing");
      if (writeRace === "reclaimed") await tasks.markTaskFailed(taskId, "Selected claim control cleanup");
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
    } else if (waiting && inject) {
      assert.ok(waitPublicationChecks >= 1);
      assert.equal(workerResult, "failed");
      assert.equal(native.status, "errored"); assert.equal(native.error_code, "completion_error");
      assert.equal(native.error_detail, "Agent response could not be saved.");
      assert.equal(run.status, "error"); assert.equal(run.errorCode, "background_automation_failed");
      assert.ok(run.finishedAt); assert.match(run.error, /selected completion turn-abort lookup failed/);
      assert.equal(task.status, "waiting_approval", "worker failure preserves the retained task custody");
      assert.deepEqual(JSON.parse(task.payload), payload);
      assert.equal(retained.context.historyId, run.id); assert.equal(retained.context.threadId, saved.thread_id);
      assert.equal(retained.context.turnId, saved.run_id); assert.equal(retained.context.options.webhookTaskId, taskId);
      assert.equal(retained.context.askId, run.pendingAskId);
      assert.equal((await f.approvalStore.readAgentToolApproval(retained.context)).status, "pending");
      assert.equal(retained.outcomeReconciled, false);
      assert.equal((await f.runner.inspectAutomationRun(run.id, f.actor, fixture.deps)).pending, null);
      assert.equal((await f.history.getAutomationContinuation(run.id)).outcomeReconciled, false,
        "the delivery precedes any decision or reconciliation");
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped",
        "a delivery before explicit reconciliation cannot redispatch the terminal history");
      assert.equal((await f.history.getAutomationContinuation(run.id)).outcomeReconciled, false);
      assert.equal(fixture.modelCalls.length, modelCount); assert.equal(fixture.calls.length, 0);
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
      assert.equal((await tasks.getPendingTask(taskId)).status, "failed");
      assert.equal((await tasks.getPendingTask(taskId)).payload, "{}");
      assert.equal((await f.history.getAutomationContinuation(run.id)).outcomeReconciled, true);
      assert.equal(f.frontmatter.parseJobResource((await f.resources.resourceGetByPath(f.owner, resource.path)).content).meta.lastStatus, "error");
      await f.runner.reconcileAutomationApprovalOutcomes(f.appId);
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
      await assert.rejects(fixture.decide(run.id, retained.context), /no longer waiting/);
      assert.equal((await f.approvalStore.readAgentToolApproval(retained.context)).status, "pending");
    } else if (waiting) {
      assert.equal(workerResult, "waiting_approval"); assert.equal(run.status, "waiting_approval");
      assert.equal(task.status, "waiting_approval"); assert.deepEqual(JSON.parse(task.payload), payload);
      assert.equal(run.finishedAt, null); assert.equal(run.approvalReady, true);
      assert.equal(native.status, "completed");
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
      await fixture.decide(run.id, retained.context, "decline");
      assert.equal((await f.history.getAutomationRun(run.id)).status, "declined");
      assert.equal((await tasks.getPendingTask(taskId)).status, "failed");
      assert.equal((await f.history.getAutomationContinuation(run.id)).outcomeReconciled, true);
    } else {
      assert.equal(workerResult, "completed", "ordinary no-context webhook errors retain their existing handling");
      assert.equal(task.status, "completed"); assert.equal(task.payload, "{}");
      assert.equal(run.status, "error"); assert.equal(run.errorCode, "background_automation_failed");
      assert.ok(run.finishedAt); assert.equal(retained.context, null);
      assert.equal(native.status, "errored"); assert.equal(native.error_code, "completion_error");
      assert.equal(await worker.runAutomationWebhookTaskInProcess(taskId, { appId: f.appId }), "skipped");
    }
    assert.equal(fixture.modelCalls.length, modelCount, "settlement, delivery and decisions cannot redispatch");
    assert.equal(fixture.calls.length, 0);
    receipt = { waiting, inject, deletionGuarded: deleteCase, faultHits, workerResult, lookupRaceHits, completionWriteHits, successfulThreadSaves,
      historyId: run.id, threadId: saved.thread_id, turnId: saved.run_id, historyStatus: run.status,
      initialTaskStatus: task.status, finalTaskStatus: (await tasks.getPendingTask(taskId)).status,
      configuredEffects: 0, modelCalls: modelCount };
  } finally {
    releaseRace();
    db.execute = originalExecute;
    const drain = await bounded(f.runner.interruptBackgroundAutomations(new Promise(() => {})), "webhook completion drain");
    assert.ok(Array.isArray(drain));
    f.restoreTimers();
  }
  console.log("APPROVAL_RESULT " + JSON.stringify({ ...receipt, drained: true }));
} else {
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
}
// Natural exit. The maintained parent owns the child timeout and reaping.
