import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { assessClaudeSubscription, assessCodexSubscription, refuseCodeSubscriptionFunding } from "../server/code-subscription-funding.ts";
import { claudeAccount, includedClaudeUsage } from "./fixtures/claude-subscription.ts";

const source = await readFile(new URL("../server/local-code-agent.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function sendVivaryCodeMessage(");
const end = source.indexOf("\nexport type VivaryCodeSessionDetails", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end).replace("export ", ""), { loader: "ts" });

function fixture() {
  const records = new Map(), events = [], launches = [], writes = [];
  let usage = includedClaudeUsage();
  const workspace = { root: "/fixture", label: "Fixture" };
  const owners = {
    resolveWorkspace: async () => workspace, ensureVivaryCodeHostInitialized: async () => {},
    hostState: { cleanup: null }, assertCodeHostAvailable() {},
    requireOwnedRun: id => records.get(id), engineFromRun: run => run.metadata.engine,
    modelFromRun: run => run.metadata.model, VIVARY_CODE_DEFAULT_ENGINE: "claude-cli",
    sameWorkspace: (a, b) => a.root === b.root,
    fail(message, options) { throw Object.assign(new Error(message), options); },
    getVivaryRuntimeStatus: async () => ({ status: "ready" }),
    getCodexModels: async () => ({ status: "ready", models: [{ id: "gpt-fixture" }], defaultModel: "gpt-fixture", funding: assessCodexSubscription({ ordinaryUsageAllowed: true, rateLimits: { credits: { hasCredits: true, unlimited: false } } }) }),
    resolveVivaryCodeModel: (engine, model) => model ?? (engine === "claude-cli" ? "claude-sonnet-5-5" : "gpt-fixture"),
    resolveVivaryRuntimeCommand: async () => null,
    getClaudeSubscriptionFunding: async (cwd, model, launch, options) => {
      assert.equal(options.refresh, true, "each send must request fresh provider metadata");
      return { funding: assessClaudeSubscription({ account: claudeAccount, usage }, model),
        binding: { version: "2.1.289", account: "fixture-account", runtime: "fixture-runtime" } };
    },
    assessCodexSubscription, refuseCodeSubscriptionFunding,
    getCodePermissionMode: async () => "normal", refreshHeldCredentials: async () => {},
    VIVARY_CODE_GOAL_ID: "vivary-local-code", VIVARY_CODE_APP_MARKER: "vivary-workbench-local-code",
    titleFromMessage: message => message,
    createCodeAgentRunRecord: input => { writes.push("create"); const run = { ...input, id: "new-run" }; records.set(run.id, run); return run; },
    buildVivaryCodeExecutionPrompt: (run, engine, message) => message,
    appendCodeAgentTranscriptEvent: event => { writes.push("transcript"); events.push(event); },
    updateCodeAgentRunRecord: (id, change) => { writes.push("record"); const run = records.get(id); records.set(id, { ...run, ...change, metadata: { ...run.metadata, ...change.metadata } }); },
    startVivaryCodeRun: input => { launches.push(input); },
    getVivaryCodeState: async (owner, id) => ({ run: records.get(id) }),
    recordProjectContextLoad() { writes.push("context"); },
  };
  const send = compileFunction(code + "\nreturn sendVivaryCodeMessage;", Object.keys(owners))(...Object.values(owners));
  return { send, records, events, launches, writes, workspace, setUsage(value) { usage = value; } };
}

test("new and resumed Claude sends admit real evaluator fixtures and retain the selected model", async () => {
  const value = fixture();
  const input = { ownerEmail: "fixture@example.test", message: "First", model: "claude-fable-5-1", workspace: value.workspace };
  const first = await value.send(input);
  assert.equal(first.run.metadata.engine, "claude-cli");
  assert.equal(first.run.metadata.model, "claude-fable-5-1");
  assert.equal(value.events.length, 1);
  assert.equal(value.launches.length, 1);
  await value.send({ ...input, runId: first.run.id, message: "Resume", model: undefined });
  assert.equal(value.records.size, 1);
  assert.equal(value.records.get(first.run.id).metadata.model, "claude-fable-5-1");
  assert.equal(value.events.length, 2);
  assert.equal(value.launches[1].model, "claude-fable-5-1");
  assert.ok(value.records.get(first.run.id).metadata.subscriptionFundingBinding);
});

test("exhausted, paid-enabled, and unavailable states refuse new and resumed sends before writes", async () => {
  for (const scenario of ["exhausted", "paid-enabled", "unknown"]) {
    const value = fixture();
    const first = await value.send({ ownerEmail: "fixture@example.test", message: "Earlier", workspace: value.workspace });
    const usage = includedClaudeUsage();
    if (scenario === "exhausted") usage.rate_limits.seven_day.utilization = 100;
    if (scenario === "paid-enabled") usage.rate_limits.extra_usage.user_disabled = false;
    if (scenario === "unknown") usage.rate_limits.model_scoped = undefined;
    value.setUsage(usage);
    const before = JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]);
    for (const runId of [undefined, first.run.id]) await assert.rejects(value.send({
      ownerEmail: "fixture@example.test", message: "Refuse", workspace: value.workspace, runId,
    }), { statusCode: 409 });
    assert.equal(JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]), before);
  }
});

test("Codex with available included quota and credits cannot fall back to any paid executor", async () => {
  const value = fixture();
  await assert.rejects(value.send({ ownerEmail: "fixture@example.test", engine: "codex-cli", message: "Refuse",
    workspace: value.workspace }), { errorCode: "vivary_code_subscription_funding_paid_funding_enabled" });
  assert.deepEqual(value.writes, []);
  assert.deepEqual(value.launches, []);
});
