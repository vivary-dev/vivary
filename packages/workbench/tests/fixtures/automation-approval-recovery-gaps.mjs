import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const normalized = statement => String(typeof statement === "string" ? statement : statement.sql).replace(/\s+/g, " ").trim();
// SIGKILL deliberately skips all runner error handling and process exit hooks.
function loseProcess(receipt) {
  writeSync(1, "APPROVAL_CRASH " + JSON.stringify(receipt) + "\n");
  process.kill(process.pid, "SIGKILL");
}

export async function runRecoveryGapFixture(role, name, historyId) {
  if (role.startsWith("gap-delete-")) return deletionCase(role.slice("gap-delete-".length), name);
  const f = await import("./automation-approval-fixture.mjs");
  const { makeApprovalCase, history, runner, database, runStore, resources, frontmatter, approvalStore,
    loadCore, owner, appId, mcpName, until } = f;
  const existing = role.includes("recover-");
  const fixture = await makeApprovalCase(name, { existing, repeatLocal: false,
    triggerType: role.includes("webhook") ? "webhook" : "schedule" });
  const db = database.getDbExec(), execute = db.execute.bind(db);
  const resource = fixture.automation.resource;
  if (role === "gap-retention-crash") {
    const ready = await fixture.start(), pending = await fixture.pending(ready.historyId);
    assert.equal(ready.status, "waiting_approval");
    let faultHits = 0;
    db.execute = async statement => {
      if (normalized(statement).startsWith("UPDATE agent_tool_approvals SET status = 'consumed'") && statement.args?.includes(pending.askId)) {
        faultHits++;
        const state = await history.getAutomationContinuation(ready.historyId);
        assert.equal(state.storedStatus, "resuming");
        assert.notEqual(state.run.runId, ready.runId);
        assert.equal(state.run.runId, state.resumeRunId, "mandatory continuation attachment committed");
        assert.equal((await runStore.getRunTurnRef(state.run.runId)).turnId, ready.turnId);
        assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
        loseProcess({ ...ready, pending, resumeRunId: state.resumeRunId, faultHits,
          configuredEffects: fixture.calls.filter(call => call.name === mcpName).length,
          modelCalls: fixture.modelCalls.length });
      }
      return execute(statement);
    };
    await fixture.decide(ready.historyId, pending);
    await until(() => false);
  }
  if (role === "gap-retention-recover-decline") {
    const before = await history.getAutomationContinuation(historyId), pending = before.context;
    assert.equal(before.storedStatus, "resuming");
    await assert.rejects(fixture.decide(historyId, pending, "decline"), /already in progress/);
    assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
    // The parent has observed the fault child die. Native's durable lifecycle
    // confirms that identified chunk ended, without stopping its logical turn.
    await runStore.updateRunStatus(before.resumeRunId, "aborted");
    await fixture.decide(historyId, pending, "decline");
    await assert.rejects(fixture.decide(historyId, pending), /no longer waiting/);
    return terminalReceipt(fixture, pending, f);
  }
  const tasks = await loadCore("integrations/pending-tasks-store.js");
  const dispatcher = await loadCore("triggers/dispatcher.js");
  const webhook = await loadCore("integrations/automation-webhook-task.js");
  const dispatch = await loadCore("integrations/integration-durable-dispatch.js");
  await dispatcher.initTriggerDispatcher(fixture.deps);
  const originalId = `gap-original-${name}`, followerId = `gap-follower-${name}`;
  const externalThreadId = `${owner}:${resource.path}`;
  const insert = id => tasks.insertPendingTask({ id, platform: "automation-webhook", externalThreadId,
    ownerEmail: owner, orgId: null, externalEventKey: `${resource.id}:${id}`,
    payload: JSON.stringify({ kind: "automation-webhook", automationId: resource.id, owner,
      path: resource.path, eventId: id, payload: { id } }) });
  if (role === "gap-webhook-crash" || role === "gap-webhook-normal") {
    await insert(originalId);
    let faultHits = 0;
    if (role.endsWith("crash")) db.execute = async statement => {
      if (normalized(statement).startsWith("UPDATE integration_pending_tasks SET status = 'waiting_approval'") && statement.args?.includes(originalId)) {
        faultHits++;
        const [run] = await history.listAutomationRuns({ owners: [owner], automation: name, appId });
        assert.equal(run.status, "waiting_approval"); assert.equal(run.finishedAt, null);
        assert.equal((await tasks.getPendingTask(originalId)).status, "processing");
        await insert(followerId);
        loseProcess({ historyId: run.id, runId: run.runId, threadId: run.threadId,
          pending: await fixture.pending(run.id), originalId, followerId, faultHits,
          taskStatus: "processing", configuredEffects: fixture.calls.filter(call => call.name === mcpName).length,
          modelCalls: fixture.modelCalls.length });
      }
      return execute(statement);
    };
    assert.equal(await webhook.runAutomationWebhookTaskInProcess(originalId, { appId }), "waiting_approval");
    await insert(followerId);
    const [run] = await history.listAutomationRuns({ owners: [owner], automation: name, appId });
    return { historyId: run.id, runId: run.runId, threadId: run.threadId, pending: await fixture.pending(run.id),
      originalId, followerId, faultHits, taskStatus: (await tasks.getPendingTask(originalId)).status };
  }
  const decision = role.endsWith("approve") ? "approve" : "decline";
  const pending = await fixture.pending(historyId);
  assert.equal(await webhook.runAutomationWebhookTaskInProcess(originalId, { appId }), "skipped",
    "the recorded history keeps custody before task redispatch");
  assert.equal((await tasks.getPendingTask(originalId)).status, "waiting_approval");
  assert.equal(await tasks.claimPendingTask(followerId), null);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.modelCalls.length, 0);
  const inspection = await runner.inspectAutomationRun(historyId, f.actor, fixture.deps);
  assert.equal(inspection.pending.askId, pending.askId);
  const dispatched = [], terminalAtDispatch = [];
  dispatch.setInProcessIntegrationTaskRunner(async (id, options) => {
    dispatched.push(id);
    terminalAtDispatch.push(frontmatter.parseJobResource((await resources.resourceGetByPath(owner, resource.path)).content).meta.lastStatus);
    assert.equal((await tasks.getPendingTask(originalId)).status, decision === "approve" ? "completed" : "failed");
    assert.equal(terminalAtDispatch.at(-1), decision === "approve" ? "success" : "declined");
    const stream = fixture.engine.stream;
    fixture.engine.stream = async function* (options) {
      fixture.modelCalls.push(structuredClone(options.messages));
      yield { type: "assistant-content", parts: [{ type: "text", text: "Recovered FIFO follower completed." }] };
      yield { type: "stop", reason: "end_turn" };
    };
    try { return await webhook.runAutomationWebhookTaskInProcess(id, options); }
    finally { fixture.engine.stream = stream; }
  }, { appId, platforms: ["automation-webhook"] });
  try {
    await fixture.decide(historyId, pending, decision);
    await until(async () => (await tasks.getPendingTask(followerId)).status === "completed");
    await assert.rejects(fixture.decide(historyId, pending, decision), /no longer waiting/);
    await runner.reconcileAutomationApprovalOutcomes(appId);
    assert.deepEqual(dispatched, [followerId]);
    assert.equal((await tasks.getPendingTask(originalId)).attempts, 1);
    assert.equal((await tasks.getPendingTask(followerId)).attempts, 1);
    assert.equal(fixture.calls.filter(call => call.name === "resources").length, 0);
    return { ...await terminalReceipt(fixture, pending, f), dispatched, terminalAtDispatch,
      taskStatus: (await tasks.getPendingTask(originalId)).status,
      followerStatus: (await tasks.getPendingTask(followerId)).status };
  } finally { dispatch.setInProcessIntegrationTaskRunner(null); }
}

async function terminalReceipt(fixture, pending, f) {
  const result = await fixture.terminal(pending.historyId);
  return { result, pending, turn: await f.runStore.getRunTurnRef(result.runId),
    askStatus: (await f.approvalStore.readAgentToolApproval(pending)).status,
    resourceStatus: f.frontmatter.parseJobResource((await f.resources.resourceGetByPath(pending.resourceOwner, pending.resourcePath)).content).meta.lastStatus,
    outcomeReconciled: Boolean((await f.history.getAutomationContinuation(result.id)).outcomeReconciled),
    configuredEffects: fixture.calls.filter(call => call.name === f.mcpName).length,
    modelCalls: fixture.modelCalls.length };
}

async function deletionCase(kind, name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-legacy-delete-"));
  const url = `file:${path.join(directory, "fixture.sqlite")}`;
  Object.assign(process.env, { DATABASE_URL: url, DATABASE_URL_UNPOOLED: url });
  try {
    const f = await import("./automation-approval-fixture.mjs");
    const { database, loadCore, owner, appId, mcpName, context, history, runner, resources, runStore, approvalStore } = f;
    const { H3 } = await import("h3");
    const { runBetterAuthMigrations } = await loadCore("server/better-auth-migrations.js");
    const { runMigrations } = await loadCore("db/migrations.js");
    const { ORG_MIGRATIONS } = await loadCore("org/migrations.js");
    const app = { h3: new H3() };
    await runBetterAuthMigrations(app);
    await runMigrations(ORG_MIGRATIONS, { table: "_org_migrations" })(app);
    const db = database.getDbExec(), orgId = kind.includes("org") ? `delete-org-${name}` : undefined;
    const admin = "delete-admin@example.test", foreign = "delete-foreign@example.test";
    for (const email of [owner, admin, foreign]) await db.execute({
      sql: 'INSERT INTO "user" (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [email, email, "Fixture owner", Date.now(), Date.now()] });
    if (orgId) {
      await db.execute({ sql: "INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", args: [orgId, orgId, owner, Date.now()] });
      for (const [email, role] of [[owner, "owner"], [admin, "admin"], [foreign, "member"]]) await db.execute({
        sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
        args: [email + orgId, orgId, email, role, Date.now()] });
    }
    const shared = kind === "shared" || kind.startsWith("org-");
    const scope = shared ? "shared" : "personal", resourceOwner = shared ? resources.sharedResourceOwner(orgId) : owner;
    const { createJobTools } = await loadCore("jobs/tools.js"), scheduler = await loadCore("jobs/scheduler.js");
    const tool = createJobTools(appId)["manage-jobs"];
    const identity = { userEmail: owner, ...(orgId ? { orgId } : {}) };
    const invoke = (action, who = identity, selectedTool = tool, selectedName = name) => context.runWithRequestContext(who,
      async () => JSON.parse(await selectedTool.run({ action, name: selectedName, scope,
        ...(action === "create" ? { instructions: "Perform the fixture steps.", schedule: "0 * * * *", timezone: "UTC", mcpTools: [mcpName] } : {}) }, { caller: "human" })));
    const modernRace = kind.startsWith("race-modern-");
    if (modernRace) await f.service.defineAutomation({ ...identity, appId }, { scope: "personal", name,
      body: "Perform the fixture steps.", triggerType: kind.includes("webhook") ? "webhook" : "schedule",
      schedule: "0 * * * *", timezone: "UTC", mcpTools: [mcpName] });
    else assert.equal((await invoke("create")).created, true);
    const deletingActor = kind.startsWith("org-") ? { userEmail: admin, orgId } : identity;
    const readTokens = async () => {
      const exists = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_webhook_tokens'")).rows.length;
      return exists ? (await db.execute("SELECT * FROM automation_webhook_tokens ORDER BY rowid")).rows : null;
    };
    const created = await resources.resourceGetByPath(resourceOwner, `jobs/${name}.md`);
    let tokenState = await readTokens();
    const member = orgId ? (await db.execute({ sql: "SELECT * FROM org_members WHERE org_id = ? AND email = ?", args: [orgId, owner] })).rows[0] : null;
    const depart = () => db.execute({ sql: "DELETE FROM org_members WHERE org_id = ? AND email = ?", args: [orgId, owner] });
    const restore = () => db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      args: [member.id, member.org_id, member.email, member.role, member.joined_at] });
    const assertResourceUnchanged = async expected => {
      assert.deepEqual(await resources.resourceGetByPath(resourceOwner, created.path), expected);
      assert.deepEqual(await readTokens(), tokenState, "refusal precedes any token mutation");
    };
    if (kind === "org-departed-no-wait") {
      await depart();
      const eligibility = await runner.resolveBackgroundAutomationIdentity({ name, resource: created, ...f.frontmatter.parseJobResource(created.content) });
      assert.equal(eligibility.ok, false, "execution still refuses the departed creator");
      for (const [who, selectedTool] of [[deletingActor, createJobTools("foreign-app")["manage-jobs"]],
        [{ userEmail: admin, orgId: "foreign-org" }, tool], [{ userEmail: foreign, orgId }, tool]]) {
        assert.ok((await invoke("delete", who, selectedTool)).error);
        await assertResourceUnchanged(created);
      }
      assert.equal((await invoke("delete", deletingActor)).deleted, true);
      assert.equal(await resources.resourceGetByPath(resourceOwner, created.path), null);
      assert.deepEqual(await readTokens(), tokenState);
      assert.equal((await history.listAutomationRuns({ owners: [resources.organizationResourceOwner(orgId)], automation: name, appId })).length, 0,
        "ordinary management created no automation execution");
      return { kind, executionRefused: true, deleted: true, configuredEffects: 0 };
    }
    const fixture = await f.makeApprovalCase(name, { existing: true, resourceOwner, repeatLocal: false });
    if (kind.startsWith("race-")) return deletionRaceCase(kind, fixture, f,
      modernRace ? async () => { await f.service.deleteAutomation({ ...identity, appId }, "personal", name); return { deleted: true }; } : () => invoke("delete"),
      readTokens);
    assert.equal(await context.runWithRequestContext(identity, () => scheduler.runJobNow(resourceOwner, name, fixture.deps)).then(x => x.status), "waiting_approval");
    const resolved = await runner.resolveBackgroundAutomationIdentity(fixture.automation);
    assert.equal(resolved.ok, true);
    const historyOwner = history.automationHistoryOwner(resourceOwner, { userEmail: resolved.identity.userEmail, orgId: resolved.identity.orgId });
    const [run] = await history.listAutomationRuns({ owners: [historyOwner], automation: name, appId });
    const pending = await fixture.pending(run.id), before = await resources.resourceGetByPath(resourceOwner, run.path);
    tokenState = await readTokens();
    const originalThread = await f.threads.getThread(run.threadId);
    const originalTurn = await runStore.getRunTurnRef(pending.runId);
    const historySnapshot = async () => (await db.execute({ sql: "SELECT * FROM automation_runs WHERE id = ?", args: [run.id] })).rows[0];
    const assertCustodyUnchanged = async snapshot => {
      assert.deepEqual(await historySnapshot(), snapshot);
      assert.deepEqual(await f.threads.getThread(run.threadId), originalThread);
      assert.deepEqual(await runStore.getRunTurnRef(pending.runId), originalTurn);
      assert.deepEqual(await fixture.pending(run.id), pending);
      assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
      await assertResourceUnchanged(before);
    };
    if (["org-scope-missing", "org-scope-conflict"].includes(kind)) {
      const saved = await historySnapshot();
      if (kind === "org-scope-missing") await db.execute({ sql: "UPDATE automation_runs SET org_id = NULL WHERE id = ?", args: [run.id] });
      else await db.execute({ sql: "UPDATE automation_runs SET owner = ?, org_id = ? WHERE id = ?",
        args: [resources.organizationResourceOwner("conflicting-persisted-org"), "conflicting-persisted-org", run.id] });
      const ambiguous = await historySnapshot();
      assert.match((await invoke("delete", deletingActor)).error, /approval history scope.*missing or conflicting/);
      await assertCustodyUnchanged(ambiguous);
      await db.execute({ sql: "UPDATE automation_runs SET owner = ?, org_id = ? WHERE id = ?", args: [saved.owner, saved.org_id, run.id] });
    }
    if (kind === "org-departed-wait") {
      await depart();
      assert.equal((await runner.resolveBackgroundAutomationIdentity(fixture.automation)).ok, false);
      const snapshot = await historySnapshot();
      await assert.rejects(fixture.decide(run.id, pending, "decline", { ...identity, appId }), /not available to this owner/);
      assert.match((await invoke("delete", deletingActor)).error, /Resolve the waiting approval/);
      await assertCustodyUnchanged(snapshot);
    } else assert.match((await invoke("delete")).error, /Resolve the waiting approval/);
    assert.deepEqual(await resources.resourceGetByPath(resourceOwner, run.path), before);
    assert.ok((await invoke("delete", identity, createJobTools("foreign-app")["manage-jobs"])).error);
    assert.ok((await invoke("delete", { userEmail: foreign, ...(orgId ? { orgId } : {}) })).error);
    if (kind === "org-admin") assert.ok((await invoke("delete", { userEmail: admin, orgId: "foreign-org" })).error);
    const chunk = `delete-claim-${run.id}`;
    assert.equal(await history.claimAutomationApprovalDecision(run.id, pending.askId, chunk), true);
    await history.attachAutomationRunThread(run.id, run.threadId, chunk);
    await runStore.insertRun(chunk, run.threadId, pending.turnId, { dispatchMode: "background" });
    const resuming = await historySnapshot();
    assert.match((await invoke("delete", deletingActor)).error, /Resolve the waiting approval/);
    await assertCustodyUnchanged(resuming);
    assert.equal((await history.getAutomationRun(run.id)).status, "resuming");
    assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
    assert.deepEqual(await fixture.pending(run.id), pending);
    assert.deepEqual(await resources.resourceGetByPath(resourceOwner, run.path), before);
    await runStore.updateRunStatus(chunk, "aborted");
    if (kind === "org-departed-wait") await restore();
    await fixture.decide(run.id, pending, "decline", { ...identity, appId });
    assert.equal((await invoke("delete", deletingActor)).deleted, true);
    assert.equal(await resources.resourceGetByPath(resourceOwner, run.path), null);
    assert.equal((await history.getAutomationRun(run.id)).status, "declined");
    assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "declined");
    assert.equal(fixture.calls.filter(call => call.name === mcpName).length, 0);
    assert.equal((await invoke("create", identity, tool, name + "-ordinary")).created, true);
    assert.equal((await invoke("delete", deletingActor, tool, name + "-ordinary")).deleted, true);
    return { kind, historyOwner, waitingRefused: true, resumingRefused: true, deleted: true, configuredEffects: 0,
      membershipRestoredForDecline: kind === "org-departed-wait", scopeRefused: kind.startsWith("org-scope-") };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Same resource and owner APIs on old and repaired packages. The selected
// resource read is inside the repaired transaction and outside it on old Core.
async function deletionRaceCase(kind, fixture, f, remove, readTokens) {
  const { history, runner, database, resources, frontmatter, approvalStore, runStore, owner, appId, mcpName, until } = f;
  const resource = fixture.automation.resource, db = database.getDbExec();
  let releasePredicate, releaseDelete;
  const predicateGate = new Promise(resolve => { releasePredicate = resolve; });
  const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  let predicateHit = 0, deleteBarrierHit = 0, heldTransaction = false;
  const actions = fixture.deps.getActions;
  fixture.deps.getActions = async current => {
    const entries = await actions(current);
    return { ...entries, [mcpName]: { ...entries[mcpName], needsApproval: async () => {
      predicateHit++; await predicateGate; return true;
    } } };
  };
  const execute = db.execute.bind(db), transaction = db.transaction?.bind(db);
  const work = fixture.start().then(result => ({ result }), error => ({ error }));
  let deletion, ready, replacement;
  try {
    await until(() => predicateHit === 1);
    const [original] = await history.listAutomationRuns({ owners: [owner], automation: fixture.automation.name, appId });
    assert.ok(original.threadId); assert.ok(original.runId);
    const turn = await runStore.getRunTurnRef(original.runId);
    const tokens = await readTokens();
    if (kind.endsWith("delete")) {
      assert.equal((await remove()).deleted, true);
      assert.equal(await resources.resourceGetByPath(owner, resource.path), null);
      // Same name, new definition and ID. The old run cannot bind its ask to it.
      replacement = await resources.resourcePut(owner, resource.path, resource.content);
      assert.notEqual(replacement.id, resource.id);
      releasePredicate();
      const settled = await work;
      assert.equal(settled.result, undefined);
      assert.equal(settled.error?.errorCode, "automation_approval_changed");
      const terminal = await fixture.terminal(original.id);
      assert.equal(terminal.status, "error"); assert.equal(terminal.errorCode, "automation_approval_changed");
      assert.equal(terminal.threadId, original.threadId);
      assert.equal((await history.getAutomationContinuation(original.id)).context, null);
      assert.equal(terminal.pendingAskId, null);
      assert.deepEqual(await resources.resourceGetByPath(owner, resource.path), replacement);
      assert.equal(fixture.calls.filter(call => call.name === mcpName).length, 0);
      return { kind, winner: "delete", predicateHit, deleteBarrierHit, configuredEffects: 0, originalHistoryId: original.id,
        threadId: original.threadId, turnId: turn.turnId, terminalCode: terminal.errorCode, replacementId: replacement.id };
    }
    const intercept = (executeStatement, inTransaction) => async statement => {
      const sql = normalized(statement), result = await executeStatement(statement);
      if (!deleteBarrierHit && sql.startsWith("SELECT") && sql.includes("FROM resources WHERE id = ?") && statement.args?.[0] === resource.id) {
        deleteBarrierHit++; heldTransaction = inTransaction; await deleteGate;
      }
      return result;
    };
    db.execute = intercept(execute, false);
    if (transaction) db.transaction = callback => transaction(tx => callback({ ...tx, execute: intercept(tx.execute.bind(tx), true) }));
    deletion = remove().then(result => ({ result }), error => ({ error }));
    await until(() => deleteBarrierHit === 1);
    releasePredicate();
    // Old Core must reach the actual bad ordering. The repair may serialize
    // either winner, so release the transaction before awaiting Native readiness.
    if (!heldTransaction) {
      ready = (await work).result;
      assert.equal(ready.status, "waiting_approval");
    }
    releaseDelete();
    const [settled, deleted] = await Promise.all([work, deletion]);
    assert.equal(predicateHit, 1); assert.equal(deleteBarrierHit, 1);
    assert.equal(fixture.calls.filter(call => call.name === mcpName).length, 0);
    if (settled.result?.status === "waiting_approval") {
      ready = settled.result;
      assert.ok(deleted.error || deleted.result?.error, "Delete must refuse after the real run established waiting custody");
      assert.deepEqual(await resources.resourceGetByPath(owner, resource.path), resource);
      assert.deepEqual(await readTokens(), tokens, "refusal precedes token deletion");
      const pending = await fixture.pending(original.id);
      assert.equal(pending.historyId, original.id); assert.equal(pending.threadId, original.threadId);
      assert.equal(pending.turnId, turn.turnId); assert.equal(pending.resourceId, resource.id);
      assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
      assert.equal((await runner.inspectAutomationRun(original.id, f.actor, fixture.deps)).pending.askId, pending.askId);
      await fixture.decide(original.id, pending, "decline");
      await assert.rejects(fixture.decide(original.id, pending), /no longer waiting/);
      return { kind, winner: "wait", predicateHit, deleteBarrierHit, heldTransaction, configuredEffects: 0,
        historyId: original.id, threadId: original.threadId, turnId: turn.turnId, askId: pending.askId };
    }
    assert.equal(deleted.result?.deleted, true, "a deletion winner commits before waiting can be established");
    assert.equal(await resources.resourceGetByPath(owner, resource.path), null);
    const terminal = await fixture.terminal(original.id);
    assert.equal(terminal.status, "error");
    assert.equal(terminal.errorCode, "automation_approval_changed", "healthy deletion contention is a changed resource, not a storage failure");
    assert.equal((await history.getAutomationContinuation(original.id)).context, null);
    assert.equal(terminal.pendingAskId, null);
    return { kind, winner: "delete", predicateHit, deleteBarrierHit, heldTransaction, configuredEffects: 0, terminalCode: terminal.errorCode };
  } finally {
    releasePredicate(); releaseDelete();
    if (deletion) await deletion;
    await work;
    db.execute = execute; if (transaction) db.transaction = transaction;
  }
}
