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
    getVivaryCodeHostState: async () => ({ activeRun: null, busy: false, cleanup: { scan: "unavailable" } }),
    readVivaryCodeHostState: () => ({ activeRun: null, busy: false, cleanup: { scan: "unavailable" } }),
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
  assert.equal(state.activeRun, null);
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
    VIVARY_CODE_DEFAULT_MODEL: "fixture-model",
    getVivaryRuntimeStatus: async engine => ({ status: "ready", message: engine }),
    getCodexModels: async () => ({ status: "ready", models: [{ id: "fixture-model" }] }),
    engineFromRun: run => run.engine,
    modelFromRun: run => run.model,
    engineLabelFromRun: run => run.engine,
    getVivaryCodeHostState: async () => ({ activeRun: null, busy: false, cleanup: null }),
    readVivaryCodeHostState: () => ({ activeRun: null, busy: false, cleanup: null }),
    getCodePermissionMode: async () => "auto-edit",
    toRunSummary: value => ({ ...value }),
    listCodeAgentTranscriptEvents: () => [],
    dedupeAdjacentAssistantEvents: events => events,
    MAX_RUNS: 20,
    MAX_TRANSCRIPT_EVENTS: 100,
    ...overrides,
  };
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

test("host activity matches a run that finishes during awaited state work", async () => {
  let record = { id: "run-one", title: "Fixture", engine: "codex-cli", model: "fixture-model",
    status: "running", phase: "running" };
  let discoveryFinished = false;
  const finishRun = () => { record = { ...record, status: "errored", phase: "cleanup-unverified" }; };
  const readHost = () => {
    const busy = record.status === "running";
    return { busy, activeRun: busy ? { id: record.id, title: record.title, projectId: null } : null,
      pendingApproval: busy ? { runId: record.id } : null,
      recentRun: busy ? null : { ...record }, cleanup: { scan: "unavailable" } };
  };
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
    listCodeAgentTranscriptEvents: () => [{ kind: "status", metadata: { status: record.status, phase: record.phase } }],
  });
  const state = await getState("owner@example.test", "run-one");
  assert.equal(state.run.status, "errored");
  assert.equal(state.runs[0].status, "errored");
  assert.equal(state.run.events[0].metadata.status, "errored");
  assert.equal(state.busy, false, "a finished host must not remain busy in the terminal snapshot");
  assert.equal(state.activeRun, null, "the terminal run must not remain the host's active run");
  assert.equal(state.pendingApproval, null);
  assert.equal(state.recentRun.status, "errored");
  assert.equal(state.cleanup.scan, "unavailable", "cleanup refusals remain visible");
});
