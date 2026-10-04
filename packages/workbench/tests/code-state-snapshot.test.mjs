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
  const owners = {
    resolveWorkspace: async () => ({ root: "/fixture", label: "Fixture" }),
    ensureVivaryCodeHostInitialized: async () => {},
    ownedRuns: () => [record],
    requireOwnedRun: () => record,
    VIVARY_CODE_ENGINES: ["claude-cli", "codex-cli"],
    VIVARY_CODE_DEFAULT_ENGINE: "codex-cli",
    VIVARY_CODE_MODELS: [],
    VIVARY_CODE_DEFAULT_MODEL: "fixture-model",
    getVivaryRuntimeStatus: async engine => ({ status: "ready", message: engine }),
    getCodexModels: async () => { discovered(); await held;
      return { status: "ready", models: [{ id: "fixture-model" }] }; },
    engineFromRun: run => run.engine,
    modelFromRun: run => run.model,
    engineLabelFromRun: run => run.engine,
    getVivaryCodeHostState: async () => ({ activeRun: null, busy: false, cleanup: { scan: "unavailable" } }),
    getCodePermissionMode: async () => "auto-edit",
    toRunSummary: value => ({ ...value }),
    listCodeAgentTranscriptEvents: () => [{ kind: "status", metadata: { status: "errored", phase: "cleanup-unverified" } }],
    dedupeAdjacentAssistantEvents: events => events,
    MAX_RUNS: 20,
    MAX_TRANSCRIPT_EVENTS: 100,
  };
  const getState = compileFunction(code + "\nreturn getVivaryCodeState;", Object.keys(owners))(...Object.values(owners));
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
