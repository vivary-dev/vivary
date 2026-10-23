import { claudeCodeModelChoices } from "../shared/claude-models.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";

// Execute the production state function with a held catalog and a changing run store.
// This isolates response ordering without launching a model or changing host-global state.
const source = await readFile(new URL("../server/local-code-agent.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function getVivaryCodeState(");
const end = source.indexOf("\nexport async function sendVivaryCodeMessage(", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end).replace("export ", ""), { loader: "ts" });
const summaryStart = source.indexOf("function toRunSummary(");
const summaryEnd = source.indexOf("\nfunction pendingSwitchFromRun(", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
const summary = await transform(source.slice(summaryStart, summaryEnd), { loader: "ts" });

for (const scenario of ["terminal", "engine", "model"]) test(scenario === "model"
  ? "default selection retains a newer run model missing from the discovered catalog"
  : scenario === "engine" ? "default selection keeps runtime metadata with a newer run after discovery"
  : "a state response reads terminal status after model discovery finishes", async () => {
  const changedSelection = scenario !== "terminal";
  let release;
  let discovered;
  const held = new Promise(resolve => { release = resolve; });
  const discoveryStarted = new Promise(resolve => { discovered = resolve; });
  let record = { id: "run-one", title: "Fixture", status: "running", phase: "running",
    engine: scenario === "engine" ? "claude-cli" : "codex-cli", model: "fixture-model" };
  const getState = stateFixture({
    ownedRuns: () => [record],
    requireOwnedRun: () => record,
    getCodexModels: async () => { discovered(); await held;
      return { status: "ready", models: [{ id: "fixture-model" }] }; },
    getVivaryCodeHostState: async () => ({ activeRuns: [], busy: false, cleanup: { scan: "unavailable" } }),
    readVivaryCodeHostState: () => ({ activeRuns: [], busy: false, cleanup: { scan: "unavailable" } }),
    listCodeAgentTranscriptEvents: () => [{ kind: "status", metadata: { status: "errored", phase: "cleanup-unverified" } }],
  });
  const response = getState("owner@example.test", changedSelection ? undefined : "run-one");
  await discoveryStarted;
  record = { ...record, id: changedSelection ? "run-two" : "run-one", engine: "codex-cli",
    status: "errored", phase: "cleanup-unverified", model: scenario === "model" ? "retained-model" : "fixture-model" };
  release();
  const state = await response;
  assert.equal(state.run.status, "errored", "selected status must agree with the terminal transcript");
  assert.equal(state.run.phase, "cleanup-unverified");
  assert.equal(state.runs[0].status, "errored", "history must use the same fresh store snapshot");
  assert.deepEqual(state.activeRuns, []);
  assert.equal(state.runtime.message, state.run.engine, "runtime belongs to the selected run's engine");
  assert.equal(state.engineLabel, state.run.engine);
  assert.ok(state.engines.find(engine => engine.engine === state.run.engine).models.includes(state.run.model),
    "the selected run's recorded model remains available for follow-up");
  assert.equal(state.run.id, changedSelection ? "run-two" : "run-one");
  assert.equal(state.cleanup.scan, "unavailable", "the response retains the cleanup refusal");
});

function stateFixture(overrides = {}) {
  const owners = {
    resolveWorkspace: async () => ({ root: "/fixture", label: "Fixture" }),
    ensureVivaryCodeHostInitialized: async () => {},
    ownedRuns: () => [],
    requireOwnedRun: () => { throw new Error("No run in fixture"); },
    VIVARY_CODE_ENGINES: ["claude-cli", "codex-cli"],
    VIVARY_CODE_DEFAULT_ENGINE: "codex-cli",
    VIVARY_CODE_MODELS: [],
    claudeCodeModelChoices,
    VIVARY_CODE_DEFAULT_MODEL: "fixture-model",
    getVivaryRuntimeStatus: async engine => ({ status: "ready", message: engine }),
    getCodexModels: async () => ({ status: "ready", models: [{ id: "fixture-model" }] }),
    engineFromRun: run => run.engine,
    modelFromRun: run => run.model,
    metadataString: (run, key) => typeof run.metadata?.[key] === "string" ? run.metadata[key] : null,
    VIVARY_CODE_SWITCH_SOURCE: "vivary-runtime-switch",
    engineLabelFromRun: run => run.engine,
    getVivaryCodeHostState: async () => ({ activeRuns: [], busy: false, cleanup: null }),
    readVivaryCodeHostState: () => ({ activeRuns: [], busy: false, cleanup: null }),
    activeRuns: new Map(),
    canonicalFolder: async folder => folder,
    runsInFolder: () => [],
    getCodePermissionMode: async () => "auto-edit",
    listCodeAgentTranscriptEvents: () => [],
    dedupeAdjacentAssistantEvents: events => events,
    readCodeTranscriptWindow: async () => null,
    MAX_RUNS: 20,
    MAX_TRANSCRIPT_EVENTS: 100,
    ...overrides,
  };
  // Keep the actual summary owner too, so identity assertions cannot hide new sidebar work behind a fake mapper.
  owners.toRunSummary = compileFunction(summary.code + "\nreturn toRunSummary;",
    ["activeRuns", "isActiveCodeAgentRun", "engineFromRun", "engineLabelFromRun", "modelFromRun", "runDraftThreadId", "pendingSwitchFromRun"])(
    new Map(), run => run.status === "running", owners.engineFromRun, owners.engineLabelFromRun, owners.modelFromRun,
    () => null, () => null);
  return compileFunction(code + "\nreturn getVivaryCodeState;", Object.keys(owners))(...Object.values(owners));
}

test("runtime readiness is re-probed after awaited model discovery", async () => {
  let release;
  let discovered;
  const held = new Promise(resolve => { release = resolve; });
  const discoveryStarted = new Promise(resolve => { discovered = resolve; });
  const signedIn = { status: "ready", message: "Codex ready", checkedAt: "before-discovery" };
  const signedOut = { status: "sign-in-required", message: "Sign in to Codex", checkedAt: "after-discovery" };
  let codexRuntime = signedIn;
  const getState = stateFixture({
    getVivaryRuntimeStatus: async engine => engine === "codex-cli" ? codexRuntime : signedIn,
    getCodexModels: async () => { discovered(); await held;
      return { status: "ready", models: [{ id: "fixture-model" }] }; },
  });
  const response = getState("owner@example.test");
  await discoveryStarted;
  codexRuntime = signedOut;
  release();
  const state = await response;
  assert.deepEqual(state.runtime, signedOut, "runtime must reflect the post-discovery probe");
  const selectedEngine = state.engines.find(engine => engine.engine === "codex-cli");
  assert.deepEqual(selectedEngine.runtime, signedOut, "the engine entry must share the fresh readiness");
  assert.equal(selectedEngine.configured, false, "a signed-out runtime cannot remain configured");
  assert.deepEqual(selectedEngine.models, ["fixture-model"], "model discovery remains available");
});

for (const anchored of [false, true]) for (const durable of [false, true]) {
  test(`selected-run identities survive ${anchored ? "an anchored window" : "the 400-event cap"} with ${durable ? "a durable generation" : "legacy switch notes"}`, async () => {
    const event = (id, kind, metadata = {}) => ({ id, runId: "run-one", kind, message: id, metadata });
    const oldUser = event("old-user", "user");
    const currentUser = event("accepted-user", "user");
    const oldSwitch = event("old-switch", "note", { source: "vivary-runtime-switch" });
    const lastSwitch = event("last-switch", "note", { source: "vivary-runtime-switch" });
    let events = [oldUser, oldSwitch, currentUser, lastSwitch,
      ...Array.from({ length: 405 }, (_, index) => event("output-" + index, "assistant"))];
    let record = { id: "run-one", title: "Selected", engine: "codex-cli", model: "fixture-model",
      status: "running", phase: "running", metadata: durable ? { switchGeneration: "committed-generation" } : {} };
    const reads = [];
    const getState = stateFixture({
      ownedRuns: () => [record, { id: "sidebar-only", title: "Other conversation" }],
      requireOwnedRun: () => record,
      listCodeAgentTranscriptEvents: id => { reads.push(id); return events; },
      readCodeTranscriptWindow: async () => ({ anchor: oldUser, entries: [{ event: oldUser }] }),
      MAX_TRANSCRIPT_EVENTS: 400,
    });
    const anchor = anchored ? { eventId: oldUser.id, eventOffset: 0 } : undefined;
    const read = () => getState("owner@example.test", record.id, undefined, undefined, undefined, anchor);
    const first = await read();
    assert.equal(first.run.turnId, currentUser.id, "the latest accepted turn comes from full canonical history");
    const generation = durable ? "committed-generation" : lastSwitch.id;
    assert.equal(first.run.switchGeneration, generation);
    assert.equal(first.run.events.length, anchored ? 1 : 400);
    assert.equal(first.run.events.some(item => item.id === currentUser.id || item.id === lastSwitch.id), false,
      "the identity events are outside the returned transcript window");
    assert.deepEqual(reads, [record.id], "no full-history identity scan is added for sidebar summaries");
    for (const summary of first.runs) {
      assert.equal(Object.hasOwn(summary, "turnId"), false);
      assert.equal(Object.hasOwn(summary, "switchGeneration"), false);
    }
    events = [...events, event("token", "assistant"), event("status", "status"),
      event("unrelated-note", "note"), event("refused-switch", "note", { source: "vivary-runtime-switch-dropped" })];
    record = { ...record, status: "paused", phase: "paused", updatedAt: "2026-10-20T22:00:00.000Z" };
    const later = await read();
    assert.deepEqual([later.run.turnId, later.run.switchGeneration], [currentUser.id, generation],
      "output, status, timestamps and dropped switches advance neither semantic identity");
    const nextUser = event("next-accepted-user", "user");
    events.push(nextUser);
    assert.equal((await read()).run.turnId, nextUser.id, "an accepted user event advances the turn identity");
    if (!durable) {
      events.push(event("next-legacy-switch", "note", { source: "vivary-runtime-switch" }));
      assert.equal((await read()).run.switchGeneration, "next-legacy-switch", "a canonical legacy switch advances its identity");
    }
  });
}

test("a durable route generation is visible before its switch note and unchanged by that note", async () => {
  let record = { id: "run-one", title: "Fixture", engine: "codex-cli", model: "fixture-model", status: "paused", phase: "paused",
    metadata: { switchGeneration: "persisted-before-note" } };
  const events = [{ id: "prior-switch", kind: "note", metadata: { source: "vivary-runtime-switch" } }];
  const getState = stateFixture({ ownedRuns: () => [record], requireOwnedRun: () => record,
    listCodeAgentTranscriptEvents: () => events });
  assert.equal((await getState("owner@example.test", record.id)).run.switchGeneration, "persisted-before-note");
  events.push({ id: "new-switch-note", kind: "note",
    metadata: { source: "vivary-runtime-switch", switchGeneration: "persisted-before-note" } });
  record = { ...record, updatedAt: "2026-10-20T22:01:00.000Z" };
  assert.equal((await getState("owner@example.test", record.id)).run.switchGeneration, "persisted-before-note");
});

test("host activity matches a run that finishes during awaited state work", async () => {
  let record = { id: "run-one", title: "Fixture", engine: "codex-cli", model: "fixture-model",
    status: "running", phase: "running" };
  let discoveryFinished = false;
  const finishRun = () => { record = { ...record, status: "errored", phase: "cleanup-unverified" }; };
  const readHost = () => {
    const busy = record.status === "running";
    return { busy, activeRuns: busy ? [{ id: record.id, title: record.title, projectId: null,
      pendingApprovals: [{ runId: record.id }] }] : [],
      recentRun: busy ? null : { ...record }, cleanup: { scan: "unavailable" } };
  };
  // The host's run map, which reads the same record, so a finished run leaves it in the same turn.
  const activeRuns = { has: id => id === record.id && record.status === "running" };
  // A dependency can capture activity, yield, then return after execution has ended.
  // Exercise that window for the host read and for a post-discovery runtime probe.
  const getState = stateFixture({
    ownedRuns: () => [record],
    requireOwnedRun: () => record,
    getCodexModels: async () => { discoveryFinished = true;
      return { status: "ready", models: [{ id: "fixture-model" }] }; },
    getVivaryRuntimeStatus: async engine => {
      if (discoveryFinished) { await Promise.resolve(); finishRun(); }
      return { status: "ready", message: engine };
    },
    getVivaryCodeHostState: async () => {
      const snapshot = readHost();
      await Promise.resolve();
      finishRun();
      return snapshot;
    },
    readVivaryCodeHostState: readHost,
    activeRuns,
    listCodeAgentTranscriptEvents: () => [{ kind: "status", metadata: { status: record.status, phase: record.phase } }],
  });
  const state = await getState("owner@example.test", "run-one");
  assert.equal(state.run.status, "errored");
  assert.equal(state.runs[0].status, "errored");
  assert.equal(state.run.events[0].metadata.status, "errored");
  assert.equal(state.busy, false, "a finished run must not remain busy in the terminal snapshot");
  assert.deepEqual(state.activeRuns, [], "the terminal run must not remain among the host's active runs");
  assert.equal(state.recentRun.status, "errored");
  assert.equal(state.cleanup.scan, "unavailable", "cleanup refusals remain visible");
});
