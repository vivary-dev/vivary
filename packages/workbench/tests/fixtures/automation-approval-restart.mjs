// Separate process for restart and shutdown behavior. No provider or network.
import assert from "node:assert/strict";
const [role, name, historyId] = process.argv.slice(2);
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary" });
globalThis.fetch = async () => { throw new Error("Approval fixture forbids network calls."); };
if (role === "postgres-policy") {
  const { registerHooks } = await import("node:module");
  const { realpath } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const stub = await import("./automation-approval-policy-postgres.mjs");
  Object.assign(process.env, { DATABASE_URL: stub.databaseUrl, DATABASE_URL_UNPOOLED: stub.databaseUrl });
  const stubUrl = new URL("./automation-approval-policy-postgres.mjs", import.meta.url).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === "postgres" ? { url: stubUrl, shortCircuit: true } : nextResolve(specifier, context);
  } });
  const core = await realpath(new URL("../../node_modules/@agent-native/core", import.meta.url));
  const store = await import(pathToFileURL(path.join(core, "dist/agent/tool-approval-store.js")).href);
  const binding = { ownerEmail: "policy-owner@example.test", toolName: "mcp__policy__write" };
  const readback = [];
  for (const enabled of [true, false]) {
    await store.setAgentToolApprovalPolicy({ binding, enabled });
    readback.push(await store.isAgentToolAlwaysAllowed(binding));
  }
  console.log("APPROVAL_RESULT " + JSON.stringify({ enabledBindings: stub.enabledBindings, readback }));
  process.exit(0);
}
if (role.startsWith("identity-")) {
  const { runIdentityRecoveryCase } = await import("./automation-approval-identity-recovery.mjs");
  console.log("APPROVAL_RESULT " + JSON.stringify(await runIdentityRecoveryCase(role.slice("identity-".length), name)));
  process.exit(0);
}
const { makeApprovalCase, runner, history, until } = await import("./automation-approval-fixture.mjs");
const fixture = await makeApprovalCase(name, { existing: ["resume", "reconcile"].includes(role) || role.startsWith("legacy-recover-"), repeatLocal: !role.startsWith("legacy-") });
if (role.startsWith("legacy-null-")) {
  const { database, runStore, approvalStore } = await import("./automation-approval-fixture.mjs");
  const result = await fixture.start();
  const before = await history.getAutomationRun(result.historyId);
  const pending = await fixture.pending(result.historyId);
  // An attached pre-upgrade history has no admission marker. Its actual Native
  // wait, identity and exact ask remain intact, not a fabricated overlapping run.
  await database.getDbExec().execute({ sql: "UPDATE automation_runs SET admitted_at = NULL WHERE id = ?", args: [result.historyId] });
  if (["legacy-null-resuming", "legacy-null-consumed"].includes(role)) {
    const chunk = `legacy-claim-${result.historyId}`;
    assert.equal(await history.claimAutomationApprovalDecision(result.historyId, pending.askId, chunk), true);
    await runStore.insertRun(chunk, result.threadId, result.turnId, { dispatchMode: "background" });
    if (role === "legacy-null-consumed") assert.equal(await approvalStore.consumeAgentToolApproval(pending), true);
    await runStore.updateRunStatus(chunk, "aborted");
  }
  const retained = await history.getAutomationRun(result.historyId);
  console.log("APPROVAL_RESULT " + JSON.stringify({ ...result, startedAt: before.startedAt, admittedAt: retained.admittedAt,
    status: retained.status, askId: pending.askId, askStatus: (await approvalStore.readAgentToolApproval(pending)).status }));
} else if (role.startsWith("legacy-recover-")) {
  const { approvalStore, resources, frontmatter, runStore } = await import("./automation-approval-fixture.mjs");
  const pending = await fixture.pending(historyId);
  if (role === "legacy-recover-consumed") await assert.rejects(fixture.decide(historyId, pending), /consumed approval cannot be retried/);
  else await fixture.decide(historyId, pending, role === "legacy-recover-waiting-decline" ? "decline" : "approve");
  const result = await fixture.terminal(historyId);
  const calls = fixture.calls.length, models = fixture.modelCalls.length;
  await assert.rejects(fixture.decide(historyId, pending), /no longer waiting/);
  assert.equal(fixture.calls.length, calls); assert.equal(fixture.modelCalls.length, models);
  console.log("APPROVAL_RESULT " + JSON.stringify({ result, pending, calls: fixture.calls, modelCalls: fixture.modelCalls,
    turn: await runStore.getRunTurnRef(result.runId), askStatus: (await approvalStore.readAgentToolApproval(pending)).status,
    outcomeReconciled: Boolean((await history.getAutomationContinuation(historyId)).outcomeReconciled),
    resourceStatus: frontmatter.parseJobResource((await resources.resourceGetByPath(pending.resourceOwner, pending.resourcePath)).content).meta.lastStatus }));
} else if (role === "wait") {
  const result = await fixture.start();
  console.log("APPROVAL_RESULT " + JSON.stringify({ ...result, calls: fixture.calls }));
} else if (role === "resume") {
  const before = await history.getAutomationRun(historyId);
  assert.equal(before.status, "waiting_approval");
  const pending = await fixture.pending(historyId);
  await fixture.decide(historyId, pending);
  const result = await fixture.terminal(historyId);
  console.log("APPROVAL_RESULT " + JSON.stringify({ result, pending, calls: fixture.calls, modelCalls: fixture.modelCalls }));
} else if (role === "reconcile") {
  const { loadCore, resources, frontmatter } = await import("./automation-approval-fixture.mjs");
  const { database } = await import("./automation-approval-fixture.mjs");
  const tasks = await loadCore("integrations/pending-tasks-store.js");
  const retry = await loadCore("integrations/pending-tasks-retry-job.js");
  const durable = await loadCore("integrations/integration-durable-dispatch.js");
  durable.setInProcessIntegrationTaskRunner(() => assert.fail("Recovery fixture must never dispatch a task"), {
    platforms: ["automation-webhook"], appId: fixture.deps.appId, acceptsTask: async () => false,
  });
  const recovery = await retry.retryStuckPendingTasks({ after: { updatedAt: Number.MAX_SAFE_INTEGER, id: "fixture-end" }, limit: 1, pagesLeft: 1 });
  assert.equal(recovery.selected, 0);
  assert.equal(recovery.dispatched, 0);
  const { rows } = await database.getDbExec().execute({ sql: "SELECT * FROM automation_runs WHERE id = ?", args: [historyId] });
  const outcomeMarkerAvailable = Object.hasOwn(rows[0], "approval_outcome_reconciled");
  const pending = await fixture.pending(historyId);
  console.log("APPROVAL_RESULT " + JSON.stringify({ result: await history.getAutomationRun(historyId),
    taskStatus: pending.options.webhookTaskId ? (await tasks.getPendingTask(pending.options.webhookTaskId)).status : null,
    resourceStatus: frontmatter.parseJobResource((await resources.resourceGetByPath(pending.resourceOwner, pending.resourcePath)).content).meta.lastStatus,
    calls: fixture.calls, modelCalls: fixture.modelCalls, recovery, outcomeMarkerAvailable,
    outcomeReconciled: outcomeMarkerAvailable ? Number(rows[0].approval_outcome_reconciled) : null }));
} else if (role === "shutdown-wait") {
  const result = await fixture.start();
  await runner.interruptBackgroundAutomations(Promise.resolve());
  assert.equal((await history.getAutomationRun(result.historyId)).status, "waiting_approval");
  await assert.rejects(fixture.decide(result.historyId, await fixture.pending(result.historyId)), /quitting/);
  console.log("APPROVAL_RESULT " + JSON.stringify(result));
} else if (role === "shutdown-resume") {
  const result = await fixture.start();
  let release;
  fixture.toolGate = new Promise(resolve => { release = resolve; });
  await fixture.decide(result.historyId, await fixture.pending(result.historyId));
  await until(() => fixture.calls.some(call => call.name.startsWith("mcp__")));
  await runner.interruptBackgroundAutomations(new Promise(resolve => setTimeout(resolve, 2_000)));
  const final = await fixture.terminal(result.historyId);
  assert.equal(final.status, "interrupted");
  release();
  console.log("APPROVAL_RESULT " + JSON.stringify({ result: final, calls: fixture.calls }));
} else throw new Error("Unknown fixture role.");
process.exit(0);
