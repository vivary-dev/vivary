// Separate processes preserve cold Native owner memos. No provider or network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const [role, name, historyId] = process.argv.slice(2);
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary",
  AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: "true", AGENT_NATIVE_DISABLE_RECURRING_JOBS: "true" });
globalThis.fetch = async () => { throw new Error("Cold approval fixture forbids network calls."); };
const f = await import("./automation-approval-fixture.mjs");
const { database, resources, history, runner, service, owner, actor, appId, makeApprovalCase, approvalStore } = f;
const digest = row => createHash("sha256").update(JSON.stringify(row)).digest("hex");
const tokenRow = async (db, id) => (await db.execute({ sql: "SELECT * FROM automation_webhook_tokens WHERE automation_id = ?", args: [id] })).rows[0];
// No secret ciphertext or value is selected or printed.
const secretRow = async (db, token) => (await db.execute({ sql: "SELECT id, scope, scope_id, key, created_at FROM app_secrets WHERE scope = ? AND scope_id = ? AND key = ?",
  args: [token.secret_scope, token.secret_scope_id, token.secret_key] })).rows[0];
let receipt;
try {
  if (role === "cold-close") {
    const fixture = await makeApprovalCase(name);
    const resource = fixture.automation.resource;
    // Retain the normal lazy proxy, which must not adopt a reopened connection.
    await database.closeDbExec();
    const old = database.getDbExec();
    await old.execute("SELECT 1");
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const inside = new Promise(resolve => { entered = resolve; });
    let closed = false;
    let closure, repeatedClosure;
    const transaction = old.transaction(async tx => {
      await tx.execute({ sql: "UPDATE resources SET content = ? WHERE id = ?", args: ["queued close committed", resource.id] });
      entered(); await gate;
      const { rows } = await tx.execute({ sql: "SELECT content FROM resources WHERE id = ?", args: [resource.id] });
      assert.equal(rows[0].content, "queued close committed");
    });
    // Observe a baseline transaction rejection even before finally drains it.
    const transactionResult = transaction.then(() => ({ ok: true }), error => ({ ok: false, error }));
    try {
      await inside;
      closure = database.closeDbExec().then(() => { closed = true; });
      repeatedClosure = database.closeDbExec();
      await new Promise(resolve => setImmediate(resolve));
      console.log("SQLITE_PUBLIC_CLOSE_OBSERVATION " + JSON.stringify({ closedBeforeRelease: closed }));
      assert.equal(closed, false, "public close must wait behind the held transaction");
      release();
      const settled = await transactionResult;
      assert.equal(settled.ok, true, settled.error?.message);
      await Promise.all([closure, repeatedClosure]);
      await assert.rejects(old.execute("SELECT 1"), /not open|closed/i);
      const fresh = database.getDbExec();
      const { rows } = await fresh.execute({ sql: "SELECT content FROM resources WHERE id = ?", args: [resource.id] });
      assert.equal(rows[0].content, "queued close committed");
      assert.notEqual(database.getDbExec(), old);
      await assert.rejects(old.execute("SELECT 1"), /not open|closed/i);
      receipt = { closedAfterRelease: closed, reopened: true, oldExecutorRejected: true,
        modelCalls: fixture.modelCalls.length, toolCalls: fixture.calls.length };
      assert.equal(receipt.modelCalls, 0); assert.equal(receipt.toolCalls, 0);
    } finally {
      release();
      await Promise.allSettled([transactionResult, closure, repeatedClosure].filter(Boolean));
    }
  } else {
    const seed = role.startsWith("cold-webhook-seed-");
    const waiting = role.endsWith("wait") && !role.endsWith("no-wait");
    const fixture = await makeApprovalCase(name, { existing: !seed, triggerType: "webhook", repeatLocal: false });
    const resource = fixture.automation.resource;
    const db = database.getDbExec();
    const token = await tokenRow(db, resource.id);
    assert.ok(token, "seeded real webhook token exists");
    const secret = await secretRow(db, token);
    assert.ok(secret, "seeded real webhook secret exists");
    if (seed) {
      const result = waiting ? await fixture.start() : null;
      const pending = result ? await fixture.pending(result.historyId) : null;
      if (result) assert.equal(result.status, "waiting_approval");
      receipt = { resourceId: resource.id, tokenDigest: digest(token), secretDigest: digest(secret),
        result, askId: pending?.askId ?? null, configuredEffects: fixture.calls.filter(call => call.name === f.mcpName).length,
        modelCalls: fixture.modelCalls.length, toolCalls: fixture.calls.length };
      assert.equal(receipt.configuredEffects, 0);
      if (!waiting) { assert.equal(receipt.modelCalls, 0); assert.equal(receipt.toolCalls, 0); }
    } else {
      const execute = db.execute.bind(db), transact = db.transaction.bind(db);
      let inCustody = false, tokenInitializations = 0, secretInitializations = 0;
      const initializationInsideCustody = [];
      db.execute = async statement => {
        const sql = String(typeof statement === "string" ? statement : statement.sql).replace(/\s+/g, " ").trim();
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS automation_webhook_tokens")) {
          tokenInitializations++; if (inCustody) initializationInsideCustody.push("token");
        }
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS app_secrets")) {
          secretInitializations++; if (inCustody) initializationInsideCustody.push("secret");
        }
        return execute(statement);
      };
      db.transaction = callback => transact(async tx => {
        inCustody = true;
        try { return await callback(tx); } finally { inCustody = false; }
      });
      try {
        if (waiting) {
          const before = await history.getAutomationRun(historyId);
          const pending = await fixture.pending(historyId);
          await assert.rejects(service.deleteAutomation(actor, "personal", name), /Resolve the waiting approval/);
          assert.deepEqual(await resources.resourceGetByPath(owner, resource.path), resource);
          assert.deepEqual(await tokenRow(db, resource.id), token);
          assert.deepEqual(await secretRow(db, token), secret);
          assert.deepEqual(await history.getAutomationRun(historyId), before);
          assert.equal((await approvalStore.readAgentToolApproval(pending)).status, "pending");
          assert.equal((await runner.inspectAutomationRun(historyId, actor, fixture.deps)).pending.askId, pending.askId);
          assert.equal(fixture.modelCalls.length, 0); assert.equal(fixture.calls.length, 0);
          receipt = { resourceId: resource.id, tokenDigest: digest(token), secretDigest: digest(secret),
            historyId, threadId: before.threadId, turnId: pending.turnId, askId: pending.askId,
            preserved: true, modelCalls: 0, toolCalls: 0 };
          await fixture.decide(historyId, pending, "decline");
        }
        await service.deleteAutomation(actor, "personal", name);
        assert.equal(await resources.resourceGetByPath(owner, resource.path), null);
        assert.equal(await tokenRow(db, resource.id), undefined);
        assert.equal(await secretRow(db, token), undefined);
        assert.deepEqual(await history.listAutomationRuns({ owners: [owner], automation: name, appId }), []);
        assert.equal(tokenInitializations, 1, "cold token memo initialized before custody");
        assert.equal(secretInitializations, 1, "cold secret memo initialized before custody");
        assert.deepEqual(initializationInsideCustody, []);
        assert.equal(fixture.modelCalls.length, 0); assert.equal(fixture.calls.length, 0);
        receipt = { ...receipt, resourceId: resource.id, deleted: true, tokenInitializations, secretInitializations,
          initializationInsideCustody, modelCalls: 0, toolCalls: 0 };
      } finally { db.execute = execute; db.transaction = transact; }
    }
  }
  console.log("APPROVAL_RESULT " + JSON.stringify(receipt));
} finally {
  await database.closeDbExec();
  f.restoreTimers();
}
// Deliberately no process.exit. The maintained child owner requires natural exit.
