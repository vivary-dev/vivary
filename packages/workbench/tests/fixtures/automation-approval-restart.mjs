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
const { makeApprovalCase, runner, history, until } = await import("./automation-approval-fixture.mjs");
const fixture = await makeApprovalCase(name, { existing: role === "resume" });
if (role === "wait") {
  const result = await fixture.start();
  console.log("APPROVAL_RESULT " + JSON.stringify({ ...result, calls: fixture.calls }));
} else if (role === "resume") {
  const before = await history.getAutomationRun(historyId);
  assert.equal(before.status, "waiting_approval");
  const pending = await fixture.pending(historyId);
  await fixture.decide(historyId, pending);
  const result = await fixture.terminal(historyId);
  console.log("APPROVAL_RESULT " + JSON.stringify({ result, pending, calls: fixture.calls, modelCalls: fixture.modelCalls }));
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
