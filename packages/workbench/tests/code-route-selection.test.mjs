import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { CLAUDE_CODE_DEFAULT_MODEL, CLAUDE_CODE_LEGACY_ALIASES, CLAUDE_CODE_MODELS, claudeCodeModelChoices }
  from "../shared/claude-models.ts";

// Compiles one slice of local-code-agent.ts, from the named start to the next named owner, with its dependencies injected.
async function slice(from, to) {
  const begin = source.indexOf(from);
  const finish = source.indexOf(to, begin);
  assert.ok(begin >= 0 && finish > begin, from);
  return (await transform(source.slice(begin, finish).replaceAll(/^export /gm, ""), { loader: "ts" })).code;
}

const source = await readFile(new URL("../server/local-code-agent.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function sendVivaryCodeMessage(");
const end = source.indexOf("\nexport type VivaryCodeSessionDetails", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end).replace("export ", ""), { loader: "ts" });
// The real resolver, so retained-ID and alias admission run instead of an accept-all stub.
const resolverStart = source.indexOf("export function resolveVivaryCodeModel(");
const resolverEnd = source.indexOf("\nfunction titleFromMessage", resolverStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
const resolver = await transform(source.slice(resolverStart, resolverEnd).replace("export ", ""), { loader: "ts" });
const fail = (message, options) => { throw Object.assign(new Error(message), options); };
// vivary-code-switch, its refusals, its model check, and the record change, as written.
const switchCode = await slice("export async function switchVivaryCodeRuntime(", "\nexport async function getVivaryCodeFiles(");
const sessionCode = await slice("export function providerSessionId(", "\nexport async function approveVivaryCodeMessage(");
const pendingCode = await slice("function pendingSwitchFromRun(", "\nexport function engineLabelFromRun(");
const resolveVivaryCodeModel = compileFunction(resolver.code + "\nreturn resolveVivaryCodeModel;",
  ["VIVARY_CODE_DEFAULT_MODEL", "VIVARY_CODE_MODELS", "CLAUDE_CODE_LEGACY_ALIASES", "fail"])(
  CLAUDE_CODE_DEFAULT_MODEL, CLAUDE_CODE_MODELS.map(model => model.id), CLAUDE_CODE_LEGACY_ALIASES, fail);

function fixture() {
  let runtime = { status: "ready", version: "2.1.300" };
  let codex = { status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }], defaultModel: "gpt-fixture" };
  let statusGate = null, reconnecting = false;
  const records = new Map(), events = [], launches = [], writes = [], prompts = [], stops = [];
  const activeRuns = new Map(), hostState = { cleanup: null, unsaved: new Map() };
  const workspace = { root: "/fixture", label: "Fixture" };
  const owners = {
    resolveWorkspace: async () => workspace, ensureVivaryCodeHostInitialized: async () => {},
    hostState, assertCodeHostAvailable() {}, assertConversationCanStart() {}, canonicalFolder: async folder => folder,
    requireOwnedRun: id => records.get(id) ?? fail("Local Vivary code run not found.", { statusCode: 404 }),
    getCodeAgentRunRecord: id => records.get(id) ?? null,
    engineFromRun: run => run.metadata.engine,
    modelFromRun: run => run.metadata.model, VIVARY_CODE_DEFAULT_ENGINE: "claude-cli",
    metadataString: (run, key) => typeof run.metadata?.[key] === "string" ? run.metadata[key] : null,
    sameWorkspace: (a, b) => a.root === b.root,
    fail,
    // A held gate pauses only the next status read, so a second caller can run past it.
    getVivaryRuntimeStatus: async () => { const gate = statusGate; statusGate = null; await gate?.(); return runtime; },
    getCodexModels: async () => codex,
    resolveVivaryCodeModel,
    claudeCodeModelChoices,
    getCodePermissionMode: async () => "normal", refreshHeldCredentials: async () => {},
    VIVARY_CODE_GOAL_ID: "vivary-local-code", VIVARY_CODE_APP_MARKER: "vivary-workbench-local-code",
    titleFromMessage: message => message,
    createCodeAgentRunRecord: input => { writes.push("create"); const run = { ...input, id: "new-run" }; records.set(run.id, run); return run; },
    buildVivaryCodeExecutionPrompt: (run, engine, message) => { prompts.push(run); return message; },
    appendCodeAgentTranscriptEvent: event => { writes.push("transcript"); events.push(event); },
    updateCodeAgentRunRecord: (id, change) => { writes.push("record"); const run = records.get(id); records.set(id, { ...run, ...change, metadata: { ...run.metadata, ...change.metadata } }); },
    startVivaryCodeRun: input => { launches.push(input); },
    getVivaryCodeState: async (owner, id) => ({ run: records.get(id) }),
    projectReconnectionPending: () => reconnecting,
    requestUserStop: (runId, active) => { stops.push(runId); active.stopReason ??= "user"; },
    recordProjectContextLoad() { writes.push("context"); },
    activeRuns, CLAUDE_CODE_MODELS, VIVARY_CODE_SWITCH_SOURCE: "vivary-runtime-switch", MAX_PREVIOUS_PROVIDER_SESSIONS: 20,
    cleanupRefusalMessage: refusal => `Cleanup for ${refusal.runId} is pending.`,
    // A stored refusal on the record, as cleanupRefusalFromRun reads it.
    cleanupRefusalFromRun: run => run.metadata?.cleanupRefusal ? { runId: run.id } : null,
    // A host with free slots. The capacity tests in code-concurrency cover queueing.
    codeRunSlotFree: () => true, queueVivaryCodeTurn: () => { throw new Error("No queue expected"); }, takeQueuedSlot() {},
    // No conversation here has a queued message, so the switch refusal for one does not apply.
    queuedTurnFor: () => undefined,
    engineLabelFromRun: run => run.metadata.engine === "claude-cli" ? "Claude Code" : "Codex CLI",
  };
  const send = compileFunction(code + "\nreturn sendVivaryCodeMessage;", Object.keys(owners))(...Object.values(owners));
  const { switchVivaryCodeRuntime: switchRoute, applyPendingSwitch } = compileFunction(sessionCode + "\n" + pendingCode + "\n"
    + switchCode + "\nreturn { switchVivaryCodeRuntime, applyPendingSwitch };", Object.keys(owners))(...Object.values(owners));
  const snapshot = () => JSON.stringify([Array.from(records), events, launches, writes]);
  return { send, switchRoute, applyPendingSwitch, records, events, launches, writes, prompts, stops, workspace, activeRuns, hostState,
    snapshot, setReconnecting(value) { reconnecting = value; },
    setRuntime(value) { runtime = value; }, setCodex(value) { codex = value; },
    holdStatus(gate) { statusGate = gate; } };
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

// A send names the conversation's route. Without a switch, another runtime or model still refuses, because only
// vivary-code-switch may change a retained conversation's route.
test("without a switch, sign-in, changed runtime, changed model, and changed project refuse before writes without fallback", async () => {
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

for (const version of ["2.1.289", undefined, "bad.version"]) {
  for (const resumed of [false, true]) test(`Claude ${version ?? "unverified"} refuses ${resumed ? "retained" : "new"} unsupported catalog model before writes`, async () => {
    const value = fixture();
    const input = { ownerEmail: "fixture@example.test", engine: "claude-cli", message: "First", model: "claude-haiku-5-5", workspace: value.workspace };
    const first = resumed ? await value.send(input) : undefined;
    const before = JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]);
    value.setRuntime({ status: "ready", version });
    await assert.rejects(value.send({ ...input, message: "After version change", runId: first?.run.id,
      model: resumed ? undefined : input.model }), { errorCode: "vivary_code_model_unsupported", statusCode: 400 });
    assert.equal(JSON.stringify([Array.from(value.records), value.events, value.launches, value.writes]), before);
  });
}

test("Claude minimum versions apply to the selected catalog model without replacing it", async () => {
  for (const [version, model] of [["2.1.289", "claude-sonnet-5-5"], ["2.1.293", "claude-haiku-5-5"]]) {
    const value = fixture();
    value.setRuntime({ status: "ready", version });
    const result = await value.send({ ownerEmail: "fixture@example.test", engine: "claude-cli", message: "Supported", model, workspace: value.workspace });
    assert.equal(result.run.metadata.model, model);
    assert.deepEqual(value.launches.map(launch => launch.model), [model]);
  }
});

test("Claude aliases and retained historical IDs keep their existing admission behavior", async () => {
  for (const model of ["sonnet", "claude-sonnet-4-20250514"]) {
    const value = fixture();
    const first = await value.send({ ownerEmail: "fixture@example.test", engine: "claude-cli", message: "First", model: "sonnet", workspace: value.workspace });
    value.records.get(first.run.id).metadata.model = model;
    value.setRuntime({ status: "ready" });
    await value.send({ ownerEmail: "fixture@example.test", runId: first.run.id, message: "Resume", workspace: value.workspace });
    assert.equal(value.launches.at(-1).model, model);
  }
  // A historical ID is admitted only for the conversation that retained it.
  const value = fixture();
  await assert.rejects(value.send({ ownerEmail: "fixture@example.test", engine: "claude-cli", message: "New",
    model: "claude-sonnet-4-20250514", workspace: value.workspace }), { errorCode: "vivary_code_model_unsupported", statusCode: 400 });
  assert.equal(value.launches.length, 0);
});

const owner = "fixture@example.test";
const claudeSession = "00000000-0000-4000-8000-000000000011";

test("a switch moves Claude to Codex and back in place, clears both sessions, and the next sends use the new route", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-fable-5-1",
    workspace: value.workspace });
  const runId = first.run.id;
  // A stale Codex ID beside the Claude one is the case Core's Claude adapter would resume without a runtime check.
  Object.assign(value.records.get(runId).metadata, { claudeSessionId: claudeSession, codexSessionId: "stale-thread",
    providerSessionMode: "native-resume" });
  const toCodex = await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture",
    workspace: value.workspace });
  let run = value.records.get(runId);
  assert.equal(toCodex.run, run);
  assert.equal(run.metadata.engine, "codex-cli");
  assert.equal(run.metadata.model, "gpt-fixture");
  for (const key of ["claudeSessionId", "codexSessionId", "providerSessionMode"]) assert.equal(run.metadata[key], undefined, key);
  assert.equal(JSON.parse(JSON.stringify(run)).metadata.claudeSessionId, undefined, "the stored record drops the key");
  assert.deepEqual(run.metadata.previousProviderSessions.map(item => [item.engine, item.model, item.sessionId]),
    [["claude-cli", "claude-fable-5-1", claudeSession]]);
  const note = value.events.at(-1);
  assert.equal(note.kind, "note");
  assert.equal(note.runId, runId);
  assert.equal(note.metadata.source, "vivary-runtime-switch");
  assert.deepEqual([note.metadata.from, note.metadata.to], [{ engine: "claude-cli", model: "claude-fable-5-1" },
    { engine: "codex-cli", model: "gpt-fixture" }]);
  assert.match(note.metadata.switchedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(note.message, "Switched from Claude Code Fable 5.1 to Codex GPT Fixture. "
    + "The next message starts a new Codex session with the visible conversation text.");

  await value.send({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", message: "Second", workspace: value.workspace });
  run = value.records.get(runId);
  run.metadata.codexSessionId = "fixture-thread";
  await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-opus-5-5", workspace: value.workspace });
  run = value.records.get(runId);
  assert.equal(run.metadata.claudeSessionId, undefined);
  assert.equal(run.metadata.codexSessionId, undefined);
  assert.deepEqual(run.metadata.previousProviderSessions.map(item => item.sessionId), [claudeSession, "fixture-thread"]);
  await value.send({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-opus-5-5", message: "Third", workspace: value.workspace });
  assert.deepEqual(value.launches.map(launch => [launch.runId, launch.engine, launch.model]), [
    [runId, "claude-cli", "claude-fable-5-1"], [runId, "codex-cli", "gpt-fixture"], [runId, "claude-cli", "claude-opus-5-5"]]);
  assert.equal(value.records.size, 1, "the conversation keeps one run");
  assert.deepEqual(value.events.map(event => event.kind), ["user", "note", "user", "note", "user"]);
});

test("a same-runtime model switch also clears the session, and choosing the current route writes nothing", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "codex-cli", message: "First", model: "gpt-fixture", workspace: value.workspace });
  value.setCodex({ status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }, { id: "gpt-other", label: "GPT Other" }],
    defaultModel: "gpt-fixture" });
  value.records.get(first.run.id).metadata.codexSessionId = "fixture-thread";
  const before = value.snapshot();
  await value.switchRoute({ ownerEmail: owner, runId: first.run.id, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace });
  assert.equal(value.snapshot(), before);
  await value.switchRoute({ ownerEmail: owner, runId: first.run.id, engine: "codex-cli", model: "gpt-other", workspace: value.workspace });
  assert.equal(value.records.get(first.run.id).metadata.model, "gpt-other");
  assert.equal(value.records.get(first.run.id).metadata.codexSessionId, undefined, "Codex refuses to resume a thread under another model");
});

test("a switch refuses unsupported models, unavailable runtimes, and this run's active, stopping, or cleanup state before writes", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  const attempt = change => value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture",
    workspace: value.workspace, ...change });
  const before = value.snapshot();
  for (const [change, errorCode] of [
    [{ model: "gpt-unlisted" }, "vivary_code_model_unsupported"],
    [{ model: "default" }, "vivary_code_model_unsupported"],
    [{ engine: "claude-cli", model: "sonnet" }, "vivary_code_model_unsupported"],
    [{ engine: "claude-cli", model: "claude-sonnet-4-20250514" }, "vivary_code_model_unsupported"],
  ]) await assert.rejects(attempt(change), { errorCode }, JSON.stringify(change));
  value.setRuntime({ status: "ready", version: "2.1.289" });
  await assert.rejects(attempt({ engine: "claude-cli", model: "claude-haiku-5-5" }),
    { errorCode: "vivary_code_model_unsupported", message: /Requires Claude Code 2\.1\.293/ });
  value.setRuntime({ status: "sign-in-required", message: "Codex needs sign-in" });
  await assert.rejects(attempt({}), { errorCode: "vivary_code_runtime_unavailable", message: "Codex needs sign-in" });
  value.setRuntime({ status: "ready", version: "2.1.300" });
  value.setCodex({ status: "unavailable", message: "Codex models are unavailable.", models: [] });
  await assert.rejects(attempt({}), { errorCode: "vivary_code_models_unavailable" });
  value.setCodex({ status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }], defaultModel: "gpt-fixture" });

  value.activeRuns.set(runId, { stopReason: null });
  await assert.rejects(attempt({}), { errorCode: "vivary_code_switch_run_active", statusCode: 409 });
  value.activeRuns.set(runId, { stopReason: "user" });
  await assert.rejects(attempt({}), { errorCode: "vivary_code_switch_run_stopping", statusCode: 409 });
  value.activeRuns.delete(runId);
  value.hostState.cleanup = { runId };
  await assert.rejects(attempt({}), { errorCode: "vivary_code_cleanup_required", message: `Cleanup for ${runId} is pending.` });
  value.hostState.cleanup = null;
  value.records.get(runId).metadata.cleanupRefusal = { refusedAt: "2026-10-19T00:00:00.000Z" };
  await assert.rejects(attempt({}), { errorCode: "vivary_code_cleanup_required" });
  delete value.records.get(runId).metadata.cleanupRefusal;
  value.records.get(runId).metadata.linkedCreationPending = true;
  await assert.rejects(attempt({}), { errorCode: "vivary_linked_history_unavailable" });
  delete value.records.get(runId).metadata.linkedCreationPending;
  await assert.rejects(attempt({ runId: "missing-run" }), { statusCode: 404 });
  assert.equal(value.snapshot(), before);

  // Another conversation's active run or cleanup does not hold this one.
  value.activeRuns.set("other-run", { stopReason: null });
  value.hostState.cleanup = { runId: "other-run" };
  await attempt({});
  assert.equal(value.records.get(runId).metadata.engine, "codex-cli");
});

test("a run that starts while a switch checks its runtime keeps its route, and a switch during a send's checks refuses that send", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  let release;
  value.holdStatus(() => new Promise(resolve => { release = resolve; }));
  const switching = value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace });
  await new Promise(resolve => setImmediate(resolve));
  value.activeRuns.set(runId, { stopReason: null });
  release();
  await assert.rejects(switching, { errorCode: "vivary_code_switch_run_active" });
  assert.equal(value.records.get(runId).metadata.engine, "claude-cli");
  value.activeRuns.delete(runId);

  const launched = value.launches.length;
  value.holdStatus(() => new Promise(resolve => { release = resolve; }));
  const sending = value.send({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5", message: "Late",
    workspace: value.workspace });
  await new Promise(resolve => setImmediate(resolve));
  // The send waits on its runtime check. The switch's own status read is not held, so it lands first.
  await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace });
  release();
  await assert.rejects(sending, { errorCode: "vivary_code_engine_changed", statusCode: 409 });
  assert.equal(value.launches.length, launched);
  assert.deepEqual(value.events.filter(event => event.kind === "user").map(event => event.message), ["First"]);
});

test("a switch away and back during a send's checks gives the send the current record, so it quotes the conversation", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  value.records.get(runId).metadata.claudeSessionId = claudeSession;
  const before = value.records.get(runId);
  let release;
  value.holdStatus(() => new Promise(resolve => { release = resolve; }));
  const sending = value.send({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5", message: "Second",
    workspace: value.workspace });
  await new Promise(resolve => setImmediate(resolve));
  await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace });
  await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5", workspace: value.workspace });
  release();
  await sending;
  const used = value.prompts.at(-1);
  assert.notEqual(used, before, "the prompt is not built from the record read before the awaits");
  assert.equal(used.metadata.previousProviderSessions.length, 1, "the record after both switches");
  assert.equal(used.metadata.claudeSessionId, undefined, "the builder sees no session, so it quotes the conversation");
  assert.deepEqual(value.launches.map(launch => [launch.engine, launch.model]), [["claude-cli", "claude-sonnet-5-5"], ["claude-cli", "claude-sonnet-5-5"]]);
});

test("a switch rechecks the project grant and reconnection right before its write", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  const input = { ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace };
  const before = value.snapshot();
  for (const revalidated of [undefined, { root: "/different-project", label: "Other" }]) {
    await assert.rejects(value.switchRoute({ ...input, revalidateWorkspace: async () => revalidated }),
      { errorCode: "vivary_code_project_changed", statusCode: 409 });
  }
  value.setReconnecting(true);
  await assert.rejects(value.switchRoute(input), { errorCode: "vivary_code_project_reconnecting", statusCode: 409 });
  value.setReconnecting(false);
  // Reconnection that starts while the switch checks its runtime refuses the write.
  let release;
  value.holdStatus(() => new Promise(resolve => { release = resolve; }));
  const switching = value.switchRoute(input);
  await new Promise(resolve => setImmediate(resolve));
  value.setReconnecting(true);
  release();
  await assert.rejects(switching, { errorCode: "vivary_code_project_reconnecting" });
  value.setReconnecting(false);
  assert.equal(value.snapshot(), before);
  await value.switchRoute({ ...input, revalidateWorkspace: async () => value.workspace });
  assert.equal(value.records.get(runId).metadata.engine, "codex-cli");
});

test("Stop and switch records the target on the run, stops it, and the host applies it when the run leaves", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  value.records.get(runId).metadata.claudeSessionId = claudeSession;
  value.activeRuns.set(runId, { stopReason: null });
  const state = await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture",
    workspace: value.workspace, stop: true });
  let run = value.records.get(runId);
  assert.deepEqual(value.stops, [runId]);
  assert.equal(state.run, run);
  assert.equal(run.metadata.engine, "claude-cli", "the route changes only after the run stops");
  assert.deepEqual([run.metadata.pendingSwitch.engine, run.metadata.pendingSwitch.model, run.metadata.pendingSwitch.label],
    ["codex-cli", "gpt-fixture", "GPT Fixture"]);
  // A second choice while it stops replaces the target and does not stop twice.
  await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-opus-5-5", workspace: value.workspace, stop: true });
  assert.equal(value.records.get(runId).metadata.pendingSwitch.model, "claude-opus-5-5");
  assert.deepEqual(value.stops, [runId, runId]);
  assert.equal(value.activeRuns.get(runId).stopReason, "user");
  value.activeRuns.delete(runId);
  value.applyPendingSwitch(runId);
  run = value.records.get(runId);
  assert.equal(run.metadata.pendingSwitch, undefined);
  assert.deepEqual([run.metadata.engine, run.metadata.model, run.metadata.claudeSessionId], ["claude-cli", "claude-opus-5-5", undefined]);
  assert.equal(value.events.at(-1).metadata.source, "vivary-runtime-switch");
  value.applyPendingSwitch(runId);
  assert.equal(value.events.filter(event => event.kind === "note").length, 1, "applying twice changes nothing");
  // A run that is no longer active switches at once even when Stop and switch was asked.
  await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace, stop: true });
  assert.equal(value.records.get(runId).metadata.engine, "codex-cli");
  assert.deepEqual(value.stops, [runId, runId]);
});

test("a recorded switch is dropped with a visible note when the run ends under a cleanup refusal", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  value.activeRuns.set(runId, { stopReason: null });
  await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace, stop: true });
  value.activeRuns.delete(runId);
  value.hostState.cleanup = { runId };
  value.applyPendingSwitch(runId);
  const run = value.records.get(runId);
  assert.deepEqual([run.metadata.engine, run.metadata.pendingSwitch], ["claude-cli", undefined]);
  const note = value.events.at(-1);
  assert.equal(note.metadata.source, "vivary-runtime-switch-dropped");
  assert.match(note.message, /^The runtime switch did not happen/);
});
