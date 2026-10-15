import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";

const source = await readFile(new URL("../server/local-code-agent.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function sendVivaryCodeMessage(");
const end = source.indexOf("\nexport type VivaryCodeSessionDetails", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end).replace("export ", ""), { loader: "ts" });

function fixture() {
  let runtime = { status: "ready" };
  const records = new Map(), events = [], launches = [], writes = [];
  const workspace = { root: "/fixture", label: "Fixture" };
  const owners = {
    resolveWorkspace: async () => workspace, ensureVivaryCodeHostInitialized: async () => {},
    hostState: { cleanup: null }, assertCodeHostAvailable() {},
    requireOwnedRun: id => records.get(id), engineFromRun: run => run.metadata.engine,
    modelFromRun: run => run.metadata.model, VIVARY_CODE_DEFAULT_ENGINE: "claude-cli",
    sameWorkspace: (a, b) => a.root === b.root,
    fail(message, options) { throw Object.assign(new Error(message), options); },
    getVivaryRuntimeStatus: async () => runtime,
    getCodexModels: async () => ({ status: "ready", models: [{ id: "gpt-fixture" }], defaultModel: "gpt-fixture" }),
    resolveVivaryCodeModel: (engine, model) => model ?? (engine === "claude-cli" ? "claude-sonnet-5-5" : "gpt-fixture"),
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
  return { send, records, events, launches, writes, workspace, setRuntime(value) { runtime = value; } };
}

for (const engine of ["claude-cli", "codex-cli"]) test(`${engine} new and resumed sends keep the selected route and model`, async () => {
  const value = fixture();
  const model = engine === "claude-cli" ? "claude-fable-5-1" : "gpt-fixture";
  const input = { ownerEmail: "fixture@example.test", engine, message: "First", model, workspace: value.workspace };
  const first = await value.send(input);
  assert.equal(first.run.metadata.engine, engine);
  assert.equal(first.run.metadata.model, model);
  assert.equal(first.run.metadata.subscriptionFundingBinding, undefined);
  // Retained historical funding metadata must neither gate nor redirect the turn.
  value.records.get(first.run.id).metadata.subscriptionFundingBinding = { obsolete: true };
  await value.send({ ...input, runId: first.run.id, message: "Resume", model: undefined });
  assert.equal(value.records.size, 1);
  assert.equal(value.events.length, 2);
  assert.deepEqual(value.launches.map(launch => [launch.engine, launch.model]), [[engine, model], [engine, model]]);
  assert.deepEqual(value.records.get(first.run.id).metadata.subscriptionFundingBinding, { obsolete: true });
});

test("sign-in, changed runtime, changed model, and changed project refuse before writes without fallback", async () => {
  const value = fixture();
  const input = { ownerEmail: "fixture@example.test", engine: "codex-cli", message: "First", model: "gpt-fixture", workspace: value.workspace };
  const first = await value.send(input);
  const before = JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]);
  for (const change of [{ engine: "claude-cli" }, { model: "other-model" }, {
    revalidateWorkspace: async () => ({ root: "/different-project" }),
  }]) await assert.rejects(value.send({ ...input, runId: first.run.id, ...change }), { statusCode: 409 });
  value.setRuntime({ status: "sign-in-required", message: "Codex needs sign-in" });
  for (const runId of [undefined, first.run.id]) await assert.rejects(value.send({ ...input, runId }), {
    message: "Codex needs sign-in", errorCode: "vivary_code_runtime_unavailable",
  });
  assert.equal(JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]), before);
});
