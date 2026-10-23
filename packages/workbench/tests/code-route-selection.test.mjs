import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { withCodeConversationAdmission } from "../server/conversation-admission.ts";
import { codeSwitchIdentitySchema } from "../shared/code-switch-observation.ts";
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
const openConversation = compileFunction(
  await slice("function assertCodeConversationOpen(", "\n/** The same owned legacy-draft association")
    + "\nreturn assertCodeConversationOpen;", ["fail"])(fail);
// vivary-code-switch, its refusals, its model check, and the record change, as written.
const switchCode = await slice("export async function switchVivaryCodeRuntime(", "\nexport async function getVivaryCodeFiles(");
const sessionCode = await slice("export function providerSessionId(", "\nexport async function approveVivaryCodeMessage(");
const pendingCode = await slice("function pendingSwitchFromRun(", "\nexport function engineLabelFromRun(");
const observationCode = await slice("function codeSwitchObservation(", "\nexport async function sendVivaryCodeMessage(");
const resolveVivaryCodeModel = compileFunction(resolver.code + "\nreturn resolveVivaryCodeModel;",
  ["VIVARY_CODE_DEFAULT_MODEL", "VIVARY_CODE_MODELS", "CLAUDE_CODE_LEGACY_ALIASES", "fail"])(
  CLAUDE_CODE_DEFAULT_MODEL, CLAUDE_CODE_MODELS.map(model => model.id), CLAUDE_CODE_LEGACY_ALIASES, fail);

function fixture() {
  let runtime = { status: "ready", version: "2.1.300" };
  let codex = { status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }], defaultModel: "gpt-fixture" };
  let statusGate = null, initializationGate = null, reconnecting = false;
  let afterRecordPersist = null, writeFault = null;
  const allowWrite = () => { if (writeFault) throw writeFault; };
  const records = new Map(), events = [], launches = [], writes = [], prompts = [], stops = [], stoppedTurns = [];
  const activeRuns = new Map(), hostState = { cleanup: null, unsaved: new Map() };
  const workspace = { root: "/fixture", label: "Fixture" };
  const owners = {
    resolveWorkspace: async () => workspace,
    ensureVivaryCodeHostInitialized: async () => { const gate = initializationGate; initializationGate = null; await gate?.(); },
    hostState, assertCodeHostAvailable() {}, assertConversationCanStart() {}, canonicalFolder: async folder => folder,
    withCodeConversationAdmission, assertCodeConversationOpen: openConversation,
    requireOwnedRun: id => records.get(id) ?? fail("Local Vivary code run not found.", { statusCode: 404 }),
    getCodeAgentRunRecord: id => records.get(id) ?? null,
    engineFromRun: run => run.metadata.engine,
    modelFromRun: run => run.metadata.model, VIVARY_CODE_DEFAULT_ENGINE: "claude-cli",
    metadataString: (run, key) => typeof run.metadata?.[key] === "string" ? run.metadata[key] : null,
    sameWorkspace: (a, b) => a.root === b.root,
    fail, codeSwitchIdentitySchema,
    // A held gate pauses only the next status read, so a second caller can run past it.
    getVivaryRuntimeStatus: async () => { const gate = statusGate; statusGate = null; await gate?.(); return runtime; },
    getCodexModels: async () => codex,
    resolveVivaryCodeModel,
    claudeCodeModelChoices,
    getCodePermissionMode: async () => "normal", refreshHeldCredentials: async () => {},
    VIVARY_CODE_GOAL_ID: "vivary-local-code", VIVARY_CODE_APP_MARKER: "vivary-workbench-local-code",
    titleFromMessage: message => message,
    createCodeAgentRunRecord: input => { allowWrite(); writes.push("create"); const run = { ...input, id: "new-run" }; records.set(run.id, run); return run; },
    buildVivaryCodeExecutionPrompt: (run, engine, message) => { prompts.push(run); return message; },
    appendCodeAgentTranscriptEvent: event => {
      allowWrite(); writes.push("transcript"); events.push({ ...event, id: event.id ?? "fixture-event-" + events.length });
    },
    listCodeAgentTranscriptEvents: id => events.filter(event => event.runId === id),
    updateCodeAgentRunRecord: (id, change) => {
      allowWrite();
      writes.push("record");
      const run = records.get(id);
      records.set(id, { ...run, ...change, metadata: { ...run.metadata, ...change.metadata } });
      // The hook runs AFTER this logical record is persisted. Once it interrupts, all later writes fail too,
      // so a production catch cannot repair the boundary being inspected and conceal an unsafe intermediate state.
      try { afterRecordPersist?.(id, change, structuredClone(records.get(id))); }
      catch (error) { writeFault = error; throw error; }
      return records.get(id);
    },
    startVivaryCodeRun: input => { allowWrite(); launches.push(input); },
    getVivaryCodeState: async (owner, id) => ({ run: records.get(id) }),
    projectReconnectionPending: () => reconnecting,
    requestUserStop: (runId, active) => {
      allowWrite(); stops.push(runId);
      stoppedTurns.push({ runId, turnId: active.turnId ?? events.findLast(event => event.runId === runId && event.kind === "user")?.id ?? null });
      active.stopReason ??= "user";
    },
    recordProjectContextLoad() { allowWrite(); writes.push("context"); },
    activeRuns, randomUUID, CLAUDE_CODE_MODELS, VIVARY_CODE_SWITCH_SOURCE: "vivary-runtime-switch", MAX_PREVIOUS_PROVIDER_SESSIONS: 20,
    // This slice stubs the collection boundary; local-code-cleanup-refusal.test.ts exercises its real store and parser.
    cleanupRefusalsInForce: () => [
      ...(hostState.cleanup ? [hostState.cleanup] : []),
      ...[...records.values()].filter(run => run.metadata?.cleanupRefusal).map(run => ({ runId: run.id })),
    ],
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
  const { switchVivaryCodeRuntime: switchWithObservation, applyPendingSwitch, codeSwitchObservation } = compileFunction(observationCode
    + "\n" + sessionCode + "\n" + pendingCode + "\n"
    + switchCode + "\nreturn { switchVivaryCodeRuntime, applyPendingSwitch, codeSwitchObservation };", Object.keys(owners))(...Object.values(owners));
  // Existing setup calls deliberately observe their current fixture. Explicit stale, null or undefined inputs win.
  const switchRoute = input => {
    const run = records.get(input.runId);
    const observed = run ? codeSwitchObservation(run, owners.listCodeAgentTranscriptEvents(input.runId))
      : { switchGeneration: null, turnId: null };
    return switchWithObservation({ expectedSwitchGeneration: observed.switchGeneration,
      ...(input.stop === true ? { expectedTurnId: observed.turnId } : {}), ...input });
  };
  const snapshot = () => JSON.stringify([Array.from(records), events, launches, writes]);
  return { send, switchRoute, applyPendingSwitch, records, events, launches, writes, prompts, stops, stoppedTurns, workspace, activeRuns, hostState,
    transcript: owners.listCodeAgentTranscriptEvents, switchWithObservation,
    snapshot, setReconnecting(value) { reconnecting = value; },
    setRuntime(value) { runtime = value; }, setCodex(value) { codex = value; },
    onRecordPersist(callback) { afterRecordPersist = callback; },
    holdStatus(gate) { statusGate = gate; }, holdInitialization(gate) { initializationGate = gate; } };
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

test("an archived conversation refuses a resumed send before any transcript or launch mutation", async () => {
  const value = fixture();
  const input = { ownerEmail: "fixture@example.test", engine: "codex-cli", message: "First",
    model: "gpt-fixture", workspace: value.workspace };
  const first = await value.send(input);
  value.records.get(first.run.id).metadata.archivedAt = "2026-10-23T00:00:00.000Z";
  const before = value.snapshot();
  await assert.rejects(value.send({ ...input, runId: first.run.id, message: "Follow up" }), {
    errorCode: "vivary_conversation_archived", statusCode: 409,
  });
  assert.equal(value.snapshot(), before);
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
  const firstGeneration = run.metadata.switchGeneration;
  assert.equal(typeof firstGeneration, "string");
  assert.equal(note.metadata.switchGeneration, firstGeneration, "the note carries its durable route commit identity");
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
  assert.notEqual(run.metadata.switchGeneration, firstGeneration, "a later switch gets a different opaque generation");
  assert.equal(value.events.at(-1).metadata.switchGeneration, run.metadata.switchGeneration);
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

test("Stop and switch to the route a run already has still stops it", async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5", workspace: value.workspace });
  const runId = first.run.id;
  // Another window switched this conversation and started a turn. A stale window confirms Stop and switch to that route.
  value.activeRuns.set(runId, { stopReason: null });
  const before = value.records.get(runId);
  await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5", workspace: value.workspace, stop: true });
  assert.deepEqual(value.stops, [runId], "the confirmed Stop cancels the current request");
  assert.equal(value.activeRuns.get(runId).stopReason, "user");
  assert.equal(value.records.get(runId), before, "no switch is recorded for the current route");
  // Without Stop, choosing the current route still writes nothing and stops nothing.
  value.activeRuns.set(runId, { stopReason: null });
  await assert.rejects(value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5", workspace: value.workspace }),
    { errorCode: "vivary_code_switch_run_active" });
  assert.deepEqual(value.stops, [runId]);
});

for (const grant of ["revoked", "replaced"]) {
  test(`PR258 4330509896 source slice: same-route Stop revalidates a ${grant} workspace grant`, { timeout: 5_000 }, async () => {
    const value = fixture();
    const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5",
      workspace: value.workspace });
    const runId = first.run.id;
    value.activeRuns.set(runId, { stopReason: null });
    const before = value.snapshot();
    let revalidations = 0;
    await assert.rejects(value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5",
      workspace: value.workspace, stop: true, revalidateWorkspace: async () => {
        revalidations += 1;
        return grant === "revoked" ? undefined : { root: "/replacement-project", label: "Replacement" };
      } }), { errorCode: "vivary_code_project_changed", statusCode: 409 });
    assert.equal(revalidations, 1, "the final grant resolver ran even though the route already matched");
    assert.deepEqual(value.stops, [], "a rejected grant cannot stop the active turn");
    assert.equal(value.activeRuns.get(runId).stopReason, null);
    assert.equal(value.snapshot(), before, "no route, transcript, or other record write");
  });
}

test("PR258 4330509896 source slice: reconnection during same-route final revalidation refuses Stop", { timeout: 5_000 }, async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5",
    workspace: value.workspace });
  const runId = first.run.id;
  value.activeRuns.set(runId, { stopReason: null });
  const before = value.snapshot();
  let revalidations = 0;
  await assert.rejects(value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5",
    workspace: value.workspace, stop: true, revalidateWorkspace: async () => {
      revalidations += 1;
      // Reconnection starts inside the awaited final resolver, after admission's initial reconnection check.
      await Promise.resolve();
      value.setReconnecting(true);
      return value.workspace;
    } }), { errorCode: "vivary_code_project_reconnecting", statusCode: 409 });
  assert.equal(revalidations, 1);
  assert.deepEqual(value.stops, [], "a newly reconnecting project cannot be stopped through the stale route");
  assert.equal(value.activeRuns.get(runId).stopReason, null);
  assert.equal(value.snapshot(), before);
});

test("PR258 4330509909 source slice: pending application retains a recoverable after-persist boundary", { timeout: 5_000 }, async () => {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", message: "First", model: "claude-sonnet-5-5",
    workspace: value.workspace });
  const runId = first.run.id;
  value.records.get(runId).metadata.claudeSessionId = claudeSession;
  value.activeRuns.set(runId, { stopReason: null });
  await value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture",
    workspace: value.workspace, stop: true });
  value.activeRuns.delete(runId);
  const pending = structuredClone(value.records.get(runId).metadata.pendingSwitch);
  const interruption = new Error("Synthetic after-persist interruption");
  let boundary = null;
  value.onRecordPersist((id, change, persisted) => {
    if (id === runId && Object.hasOwn(change.metadata ?? {}, "pendingSwitch") && change.metadata.pendingSwitch === undefined) {
      boundary = persisted;
      throw interruption;
    }
  });
  // This is a fault at a real function's injected record-write boundary, not a killed host or filesystem test.
  assert.throws(() => value.applyPendingSwitch(runId), error => error === interruption);
  assert.ok(boundary !== null, "the interruption follows the record that clears the pending marker");
  assert.deepEqual(value.records.get(runId), boundary, "fail-stop policy prevents post-interruption repair writes");
  const metadata = boundary.metadata;
  const oldRoute = metadata.engine === "claude-cli" && metadata.model === "claude-sonnet-5-5";
  const newRoute = metadata.engine === "codex-cli" && metadata.model === "gpt-fixture";
  assert.ok((oldRoute && metadata.pendingSwitch !== undefined) || (newRoute && metadata.pendingSwitch === undefined),
    "persisted boundary must retain the old route's target or atomically commit the new route without it: "
      + JSON.stringify({ engine: metadata.engine, model: metadata.model, pendingSwitch: metadata.pendingSwitch ?? null }));
  if (oldRoute) {
    assert.deepEqual(metadata.pendingSwitch, pending);
    assert.equal(metadata.claudeSessionId, claudeSession);
  } else {
    assert.equal(metadata.claudeSessionId, undefined);
    assert.equal(typeof metadata.switchGeneration, "string", "the route commit persists its opaque switch generation");
    assert.ok(metadata.switchGeneration.length > 0);
    assert.equal(value.events.filter(event => event.metadata?.source === "vivary-runtime-switch").length, 0,
      "the committed generation is observable before a later switch note can append");
  }
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

// The observation is the selected-state contract, not a simulated admission guard. switchRoute remains the real
// production slice. Canonical transcript reads are available to its eventual guard, including beyond the UI cap.
function observedSwitchGeneration(value, runId) {
  const generation = value.records.get(runId).metadata?.switchGeneration;
  return typeof generation === "string" ? generation : value.transcript(runId)
    .findLast(event => event.kind === "note" && event.metadata?.source === "vivary-runtime-switch")?.id ?? null;
}

async function observedRouteFixture(form) {
  const value = fixture();
  const first = await value.send({ ownerEmail: owner, engine: "claude-cli", model: "claude-sonnet-5-5",
    message: "Accepted turn A", workspace: value.workspace });
  const runId = first.run.id;
  const switchTo = (engine, model, extra = {}) => value.switchRoute({ ownerEmail: owner, runId, engine, model,
    workspace: value.workspace, expectedSwitchGeneration: observedSwitchGeneration(value, runId), ...extra });
  if (form === "durable" || form === "away-back") {
    await switchTo("codex-cli", "gpt-fixture");
    await switchTo("claude-cli", "claude-sonnet-5-5");
  } else if (form === "legacy-note") {
    value.events.push({ id: "legacy-switch-note", runId, kind: "note", message: "Earlier switch",
      metadata: { source: "vivary-runtime-switch" } });
    for (let index = 0; index < 405; index++) value.events.push({ id: "legacy-output-" + index, runId,
      kind: "assistant", message: "Ordinary later output" });
  }
  return { value, runId, switchTo };
}

for (const form of ["legacy-null", "durable", "legacy-note", "away-back"]) {
  test(`PR258 4331141822 source slice: stale ${form} observation refuses before any mutation`, { timeout: 5_000 }, async () => {
    const { value, runId, switchTo } = await observedRouteFixture(form);
    const displayed = observedSwitchGeneration(value, runId);
    await switchTo("codex-cli", "gpt-fixture");
    if (form === "away-back") await switchTo("claude-cli", "claude-sonnet-5-5");
    const run = value.records.get(runId);
    run.metadata[run.metadata.engine === "codex-cli" ? "codexSessionId" : "claudeSessionId"] = "00000000-0000-4000-8000-000000000022";
    const before = value.snapshot();
    const result = await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-opus-5-5",
      workspace: value.workspace, expectedSwitchGeneration: displayed }).then(() => null, error => error);
    assert.equal(value.snapshot() === before, true,
      "the stale idle confirmation must preserve the competing route, provider session, record and transcript");
    assert.deepEqual(value.stops, []);
    assert.equal(result?.statusCode, 409, "a stale displayed observation must conflict even before this request's own awaits");
  });
}

for (const form of ["legacy-null", "durable", "legacy-note"]) {
  test(`PR258 4331141822 control: matching ${form} observation really switches after unrelated updates`, { timeout: 5_000 }, async () => {
    const { value, runId } = await observedRouteFixture(form);
    const displayed = observedSwitchGeneration(value, runId);
    await value.send({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-sonnet-5-5",
      message: "An ordinary new turn", workspace: value.workspace });
    value.events.push({ id: "ordinary-status", runId, kind: "status", message: "Settled" });
    Object.assign(value.records.get(runId), { status: "paused", phase: "paused", updatedAt: "2026-10-20T23:00:00.000Z" });
    assert.equal(observedSwitchGeneration(value, runId), displayed, "ordinary turns and timestamps invent no route generation");
    await value.switchRoute({ ownerEmail: owner, runId, engine: "claude-cli", model: "claude-opus-5-5",
      workspace: value.workspace, expectedSwitchGeneration: displayed });
    assert.equal(value.records.get(runId).metadata.model, "claude-opus-5-5");
    assert.equal(value.events.at(-1).metadata.source, "vivary-runtime-switch");
    assert.notEqual(observedSwitchGeneration(value, runId), displayed);
    assert.deepEqual(value.stops, []);
  });
}

test("PR258 4331141822 control: a matching current-route observation preserves no-op and confirmed Stop semantics", async () => {
  const { value, runId, switchTo } = await observedRouteFixture("durable");
  const before = value.snapshot();
  await switchTo("claude-cli", "claude-sonnet-5-5");
  assert.equal(value.snapshot(), before);
  const turnId = value.transcript(runId).findLast(event => event.kind === "user").id;
  value.activeRuns.set(runId, { stopReason: null, turnId });
  await switchTo("claude-cli", "claude-sonnet-5-5", { stop: true, expectedTurnId: turnId });
  assert.deepEqual(value.stoppedTurns, [{ runId, turnId }]);
  assert.equal(value.snapshot(), before, "a same-route Stop writes no switch or pending target");
});

for (const nextTurn of [true, false]) {
  test(nextTurn
    ? "PR258 4330509930 admission source slice: delayed turn-A consent cannot stop turn B"
    : "PR258 4330509930 admission control: delayed turn-A consent still stops A after token and status updates",
  { timeout: 5_000 }, async () => {
    const { value, runId } = await observedRouteFixture("legacy-null");
    const turnA = value.transcript(runId).findLast(event => event.kind === "user").id;
    value.activeRuns.set(runId, { stopReason: null, turnId: turnA });
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const admission = new Promise(resolve => { entered = resolve; });
    value.holdInitialization(async () => { entered(); await held; });
    const request = value.switchRoute({ ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture",
      workspace: value.workspace, stop: true, expectedSwitchGeneration: null, expectedTurnId: turnA })
      .then(state => ({ state }), error => ({ error }));
    try {
      await admission;
      value.events.push({ id: "turn-a-later-token", runId, kind: "assistant", message: "More of A" },
        { id: "turn-a-later-status", runId, kind: "status", message: "Still working" });
      Object.assign(value.records.get(runId), { status: "running", phase: "running", updatedAt: "2026-10-20T23:01:00.000Z" });
      if (nextTurn) {
        // Canonical acceptance precedes worker activation. No idle frame is delivered to a client here.
        value.events.push({ id: "turn-b-user", runId, kind: "user", message: "Accepted turn B" });
        value.activeRuns.set(runId, { stopReason: null, turnId: "turn-b-user" });
      }
      const before = value.snapshot();
      release();
      const result = await request;
      if (nextTurn) {
        assert.deepEqual(value.stoppedTurns, [], "the delayed request must not stop the replacement active turn B");
        assert.equal(value.snapshot() === before, true, "installing B is excluded from the no-mutation boundary");
        assert.equal(value.activeRuns.get(runId).stopReason, null);
        assert.equal(result.error?.statusCode, 409, "old turn consent must refuse at admission");
      } else {
        assert.equal(result.error, undefined);
        assert.deepEqual(value.stoppedTurns, [{ runId, turnId: turnA }]);
        assert.deepEqual(value.stops, [runId]);
        const pending = value.records.get(runId).metadata.pendingSwitch;
        assert.deepEqual({ engine: pending.engine, model: pending.model }, { engine: "codex-cli", model: "gpt-fixture" });
        assert.equal(value.records.get(runId).metadata.engine, "claude-cli", "Stop records the target before changing routes");
      }
    } finally { release(); await request; }
  });
}

test("switch admission requires explicit observations at the backend boundary too", { timeout: 5_000 }, async () => {
  const { value, runId } = await observedRouteFixture("legacy-null");
  const base = { ownerEmail: owner, runId, engine: "codex-cli", model: "gpt-fixture", workspace: value.workspace };
  const before = value.snapshot();
  await assert.rejects(value.switchWithObservation(base), { statusCode: 400 });
  await assert.rejects(value.switchWithObservation({ ...base, stop: true, expectedSwitchGeneration: null }), { statusCode: 400 });
  assert.equal(value.snapshot(), before);
  assert.deepEqual(value.stoppedTurns, []);
});

for (const sameRoute of [false, true]) test(`Stop rechecks turn consent after final grant validation on a ${sameRoute ? "matching" : "changed"} route`, { timeout: 5_000 }, async () => {
  const { value, runId } = await observedRouteFixture("legacy-null");
  const turnA = value.transcript(runId).findLast(event => event.kind === "user").id;
  value.activeRuns.set(runId, { stopReason: null, turnId: turnA });
  let before;
  await assert.rejects(value.switchRoute({ ownerEmail: owner, runId, workspace: value.workspace,
    engine: sameRoute ? "claude-cli" : "codex-cli", model: sameRoute ? "claude-sonnet-5-5" : "gpt-fixture",
    stop: true, expectedSwitchGeneration: null, expectedTurnId: turnA,
    revalidateWorkspace: async () => {
      value.events.push({ id: "turn-b-after-checks", runId, kind: "user", message: "Accepted B" });
      value.activeRuns.set(runId, { stopReason: null, turnId: "turn-b-after-checks" });
      before = value.snapshot();
      return value.workspace;
    } }), { statusCode: 409 });
  assert.equal(value.snapshot(), before);
  assert.deepEqual(value.stoppedTurns, []);
});

test("switch rechecks a same-route ABA generation after awaited runtime discovery", { timeout: 5_000 }, async () => {
  const { value, runId, switchTo } = await observedRouteFixture("durable");
  const displayed = observedSwitchGeneration(value, runId);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const discovery = new Promise(resolve => { entered = resolve; });
  value.holdStatus(async () => { entered(); await held; });
  const request = value.switchRoute({ ownerEmail: owner, runId, workspace: value.workspace,
    engine: "claude-cli", model: "claude-opus-5-5", expectedSwitchGeneration: displayed })
    .then(() => null, error => error);
  try {
    await discovery;
    await switchTo("codex-cli", "gpt-fixture");
    await switchTo("claude-cli", "claude-sonnet-5-5");
    const before = value.snapshot();
    release();
    assert.equal((await request)?.statusCode, 409);
    assert.equal(value.snapshot(), before);
    assert.deepEqual(value.stops, []);
  } finally { release(); await request; }
});
