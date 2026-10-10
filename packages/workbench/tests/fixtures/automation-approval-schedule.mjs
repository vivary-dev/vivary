// The parent starts this child with its own database, so the real scheduler sweep
// sees only this job whatever the time of day. No provider or network.
import assert from "node:assert/strict";
const [role, name] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error("Schedule fixture forbids network calls."); };
const f = await import("./automation-approval-fixture.mjs");
const { database, resources, history, frontmatter, owner, appId, mcpName, makeApprovalCase, loadCore, until } = f;
const decision = role === "schedule-approve" ? "approve" : "decline";
try {
  const scheduler = await loadCore("jobs/scheduler.js");
  const fixture = await makeApprovalCase(name, { repeatLocal: false });
  const path = fixture.automation.resource.path;
  const meta = async () => frontmatter.parseJobResource((await resources.resourceGetByPath(owner, path)).content);
  const current = await meta();
  await resources.resourcePut(owner, path, frontmatter.buildJobResourceContent(
    { ...current.meta, enabled: true, nextRun: new Date(Date.now() - 60_000).toISOString() }, current.body));
  const runs = () => history.listAutomationRuns({ owners: [owner], automation: name, appId });
  // The real sweep passes no execution options, unlike the fixture's direct start.
  await scheduler.processRecurringJobs(fixture.deps);
  const [waiting] = await runs();
  assert.ok(waiting, "the sweep started the due job");
  await fixture.decide(waiting.id, await fixture.pending(waiting.id), decision);
  const terminal = decision === "approve" ? "success" : "declined";
  await until(async () => (await meta()).meta.lastStatus === terminal);
  const settled = (await meta()).meta;
  await scheduler.processRecurringJobs(fixture.deps);
  console.log("APPROVAL_RESULT " + JSON.stringify({ historyId: waiting.id, waitingStatus: waiting.status,
    lastStatus: settled.lastStatus, nextRunAdvanced: Date.parse(settled.nextRun) > Date.now(),
    runsAfterNextTick: (await runs()).map(run => run.id),
    configuredEffects: fixture.calls.filter(call => call.name === mcpName).length }));
} finally {
  await database.closeDbExec();
  f.restoreTimers();
}
// Deliberately no process.exit. The maintained child owner requires natural exit.
