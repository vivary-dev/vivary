import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Each identity control gets its own SQLite and auth rows. Recovery is entered
// through the maintained retry sweep, with no eligible dispatch candidates.
export async function runIdentityRecoveryCase(kind, name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-approval-identity-"));
  const url = `file:${path.join(directory, "identity.sqlite")}`;
  Object.assign(process.env, { DATABASE_URL: url, DATABASE_URL_UNPOOLED: url });
  try {
    const { makeApprovalCase, owner, appId, runner, history, resources, frontmatter, database,
      approvalStore, mcpName, loadCore } = await import("./automation-approval-fixture.mjs");
    const db = database.getDbExec();
    await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT)');
    await db.execute({ sql: 'INSERT INTO "user" (id, email, name) VALUES (?, ?, ?)', args: ["identity-user", owner, "Fixture owner"] });
    await db.execute('CREATE TABLE org_members (org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL)');
    const orgId = ["legacy-personal-org", "scoped-organization"].includes(kind) ? "identity-org" : null;
    if (orgId) await db.execute({ sql: "INSERT INTO org_members (org_id, email, role) VALUES (?, ?, ?)", args: [orgId, owner, "owner"] });
    const fixture = await makeApprovalCase(name);
    const shared = ["legacy-shared", "forged-retained-creator"].includes(kind);
    const resourceOwner = shared ? "__shared__" : kind === "scoped-organization" ? resources.organizationResourceOwner(orgId) : owner;
    const legacy = shared || kind === "legacy-personal-org";
    const meta = { ...fixture.automation.meta, createdBy: owner, runAs: "creator", orgId: orgId ?? undefined };
    if (legacy) delete meta.triggerType;
    if (orgId) meta.scope = "organization";
    await resources.resourcePut(resourceOwner, fixture.automation.resource.path,
      frontmatter.buildJobResourceContent(meta, fixture.automation.body));
    const resource = await resources.resourceGetByPath(resourceOwner, fixture.automation.resource.path);
    fixture.automation = { name, resource, ...frontmatter.parseJobResource(resource.content) };
    const resolved = await runner.resolveBackgroundAutomationIdentity(fixture.automation);
    assert.equal(resolved.ok, true, "the existing owner supports this execution identity");
    assert.equal(resolved.identity.userEmail, owner);
    assert.equal(resolved.identity.orgId ?? null, orgId);
    Object.assign(fixture.options, { automation: fixture.automation, ownerEmail: resolved.identity.userEmail,
      orgId: resolved.identity.orgId, requestContext: { userEmail: owner, orgId: orgId ?? undefined } });
    const ready = await fixture.start();
    assert.equal(ready.status, "waiting_approval");
    const pending = await fixture.pending(ready.historyId);
    const expectedHistoryOwner = orgId ? resources.organizationResourceOwner(orgId) : owner;
    assert.equal((await history.getAutomationRun(ready.historyId)).owner, expectedHistoryOwner);
    const scheduler = await loadCore("jobs/scheduler.js");
    await scheduler.recordExecutionOutcome(resource, { lastStatus: "waiting_approval", advanceSchedule: false },
      { historyId: ready.historyId, runId: ready.runId });
    // These are the real decision storage operations before the simulated crash
    // boundary. No action or delivery occurs and terminal history stays immutable.
    assert.equal(await history.claimAutomationApprovalDecision(ready.historyId, pending.askId, "identity-decline-" + name), true);
    assert.equal(await approvalStore.declineAgentToolApproval(pending), true);
    await history.finishAutomationRun(ready.historyId, "declined", "The owner declined.", "automation_approval_declined");
    if (kind === "forged-retained-creator") {
      await db.execute({ sql: "UPDATE automation_runs SET approval_context = ? WHERE id = ?",
        args: [JSON.stringify({ ...pending, ownerEmail: "forged@example.test" }), ready.historyId] });
    }
    const before = { calls: fixture.calls.length, models: fixture.modelCalls.length };
    const durable = await loadCore("integrations/integration-durable-dispatch.js");
    durable.setInProcessIntegrationTaskRunner(() => assert.fail("Identity recovery must not dispatch"), {
      platforms: ["automation-webhook"], appId, acceptsTask: async () => false,
    });
    const retry = await loadCore("integrations/pending-tasks-retry-job.js");
    const recovery = await retry.retryStuckPendingTasks({ after: { updatedAt: Number.MAX_SAFE_INTEGER, id: "fixture-end" }, limit: 1, pagesLeft: 1 });
    assert.equal(recovery.selected, 0);
    assert.equal(recovery.dispatched, 0);
    const { rows } = await db.execute({ sql: "SELECT * FROM automation_runs WHERE id = ?", args: [ready.historyId] });
    const final = await history.getAutomationRun(ready.historyId);
    const resourceStatus = frontmatter.parseJobResource((await resources.resourceGetByPath(resourceOwner, resource.path)).content).meta.lastStatus;
    const refused = kind === "forged-retained-creator";
    assert.equal(final.owner, expectedHistoryOwner);
    assert.equal(final.status, "declined");
    assert.equal(Number(rows[0].approval_outcome_reconciled), refused ? 0 : 1);
    assert.equal(resourceStatus, refused ? "waiting_approval" : "declined");
    assert.equal(fixture.calls.length, before.calls);
    assert.equal(fixture.modelCalls.length, before.models);
    assert.equal(fixture.calls.filter(call => call.name === mcpName).length, 0);
    return { kind, historyOwner: final.owner, status: final.status, outcomeReconciled: Number(rows[0].approval_outcome_reconciled),
      resourceStatus, additionalEffects: fixture.calls.length - before.calls, additionalModelCalls: fixture.modelCalls.length - before.models };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
