// Issue #205: approval cleanup outside the custody transaction. CI has no live
// PostgreSQL, so a driver adapter over SQLite rejects every statement after a
// failed one and rolls the transaction back, as PostgreSQL does. The finding
// cases failed against the Core patch before the fix. This file owns its database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-approval205c-"));
const url = `file:${path.join(root, "cleanup.sqlite")}`;
Object.assign(process.env, { NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Approval cleanup tests forbid outward network calls."); };
const { history, approvalStore, database, restoreTimers, makeApprovalCase, owner, mcpName, until } =
  await import("./fixtures/automation-approval-fixture.mjs");
after(async () => {
  globalThis.fetch = savedFetch;
  restoreTimers();
  await database.closeDbExec();
  await rm(root, { recursive: true, force: true });
});

// Before its first statement, getDbExec returns a lazy proxy, so start the live executor before wrapping it.
await database.getDbExec().execute("SELECT 1");
await approvalStore.ensureAgentToolApprovalTable();
const db = () => database.getDbExec();
assert.equal(db(), db());
const DAY = 24 * 60 * 60_000;
const isCleanup = statement => /^DELETE FROM agent_tool_approvals\b/.test(String(statement?.sql ?? statement).replace(/\s+/g, " ").trim());
const ABORTED = "current transaction is aborted, commands ignored until end of transaction block";

// PostgreSQL semantics over the SQLite executor: after any failed statement in a
// transaction, every later statement fails, and the transaction rolls back even
// when the callback caught the error. `failCleanup` makes approval cleanup fail.
async function withPostgresTransactions(failCleanup, work) {
  const client = db(), execute = client.execute, transaction = client.transaction;
  const seen = { inTransaction: 0, outside: 0 };
  const fail = () => Object.assign(new Error("simulated approval cleanup failure"), { code: "57014" });
  client.execute = async statement => {
    if (isCleanup(statement)) { seen.outside++; if (failCleanup) throw fail(); }
    return execute.call(client, statement);
  };
  client.transaction = callback => transaction.call(client, async tx => {
    let aborted = false;
    const run = tx.execute.bind(tx);
    const result = await callback({ ...tx, execute: async statement => {
      if (aborted) throw Object.assign(new Error(ABORTED), { code: "25P02" });
      try {
        if (isCleanup(statement)) { seen.inTransaction++; if (failCleanup) throw fail(); }
        return await run(statement);
      } catch (error) { aborted = true; throw error; }
    } });
    if (aborted) throw Object.assign(new Error(`ROLLBACK: ${ABORTED}`), { code: "25P02" });
    return result;
  });
  const warn = console.warn, error = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return { seen, value: await work() }; } finally {
    client.execute = execute; client.transaction = transaction;
    console.warn = warn; console.error = error;
  }
}
async function seedExpiredDecidedAsk(id) {
  const old = Date.now() - 2 * DAY;
  await db().execute({ sql: `INSERT INTO agent_tool_approvals (id, owner_email, org_id, thread_id, turn_id, tool_name, call_id,
      approval_key_hash, status, expires_at, consumed_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, 'consumed', ?, ?, ?, ?)`,
  args: [id, owner, mcpName, `call-${id}`, `hash-${id}`, old, old, old, old] });
}
const exists = async id => (await db().execute({ sql: "SELECT id FROM agent_tool_approvals WHERE id = ?", args: [id] })).rows.length === 1;
async function startWait(name) {
  const fixture = await makeApprovalCase(name, { repeatLocal: false });
  const result = await fixture.start();
  return { fixture, result };
}

test("the adapter rejects every statement after a failed one and rolls the transaction back", async () => {
  await seedExpiredDecidedAsk("adapter-control-kept");
  const { value } = await withPostgresTransactions(true, () => db().transaction(async tx => {
    await assert.rejects(tx.execute({ sql: "DELETE FROM agent_tool_approvals WHERE id = ?", args: ["adapter-control-kept"] }), /simulated approval cleanup failure/);
    await assert.rejects(tx.execute("SELECT 1"), { code: "25P02" });
    return "caught";
  }).then(() => "committed", error => error.code));
  assert.equal(value, "25P02", "a caught failure still rolls the transaction back");
  assert.equal(await exists("adapter-control-kept"), true);
});

test("a failed approval cleanup on a PostgreSQL transaction does not abort the wait write", async () => {
  const { seen, value: { result } } = await withPostgresTransactions(true, () => startWait("cleanup-fails-in-custody"));
  assert.equal(result.status, "waiting_approval", "the run waits for its owner instead of failing approval storage");
  const run = await until(async () => { const current = await history.getAutomationRun(result.historyId); return current.approvalReady ? current : null; });
  assert.equal(run.status, "waiting_approval");
  assert.equal(run.errorCode ?? null, null);
  const state = await history.getAutomationContinuation(result.historyId);
  assert.equal((await approvalStore.readAgentToolApproval(state.context)).status, "pending");
  assert.equal(seen.inTransaction, 0, "no cleanup ran on the custody transaction");
  assert.equal(seen.outside, 1, "the cleanup ran once after custody committed and its failure was only logged");
});

test("expired decided asks are still cleaned after the custody transaction commits", async () => {
  await seedExpiredDecidedAsk("cleanup-after-commit-old");
  const { seen, value: { result } } = await withPostgresTransactions(false, () => startWait("cleanup-after-commit"));
  assert.equal(result.status, "waiting_approval");
  assert.equal(seen.inTransaction, 0, "no cleanup ran on the custody transaction");
  assert.equal(await exists("cleanup-after-commit-old"), false);
});

test("an ask created without a transaction still cleans expired decided asks", async () => {
  await seedExpiredDecidedAsk("direct-ask-old");
  const binding = { ownerEmail: owner, threadId: "direct-thread", turnId: "direct-turn", toolName: mcpName, callId: "direct-call", approvalKey: "direct-key" };
  const askId = await approvalStore.createAgentToolApproval(binding);
  assert.equal((await approvalStore.readAgentToolApproval({ ...binding, askId }))?.status, "pending");
  assert.equal(await exists("direct-ask-old"), false);
});
