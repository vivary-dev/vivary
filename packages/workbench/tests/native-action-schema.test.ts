import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defineAction } from "@agent-native/core/action";
import { actionsToEngineTools, autoDiscoverActions, loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext } from "@agent-native/core/server";
import { defineProjectEvaluateTool } from "../actions/vivary-project-evaluate.ts";
import { createProjectEvaluate } from "../server/project-evaluate.ts";
import type { GovernedCommand, ProjectEvaluateRun } from "../server/original-runtime.ts";

const root = await mkdtemp(path.join(tmpdir(), "vivary-native-action-schema-"));
const database = `file:${path.join(root, "native.sqlite")}`;
Object.assign(process.env, { APP_NAME: "Vivary", NODE_ENV: "production", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database });
after(() => rm(root, { recursive: true, force: true }));

type Actions = Parameters<typeof runAgentLoop>[0]["actions"];
async function call(actions: Actions, name: string, input: unknown) {
  const events: Parameters<Parameters<typeof runAgentLoop>[0]["send"]>[0][] = [];
  let streams = 0;
  const engine: Parameters<typeof runAgentLoop>[0]["engine"] = {
    name: "schema-regression", label: "Schema regression", defaultModel: "fake", supportedModels: ["fake"],
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
    async *stream() {
      if (streams++ === 0) {
        yield { type: "assistant-content", parts: [{ type: "tool-call", name, id: "schema-call", input }] };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "assistant-content", parts: [{ type: "text", text: "Done." }] };
        yield { type: "stop", reason: "end_turn" };
      }
    },
  };
  await runWithRequestContext({ userEmail: "owner@example.test", orgId: "org-a", run: {} }, () => runAgentLoop({
    engine, model: "fake", systemPrompt: "", tools: actionsToEngineTools(actions), actions,
    messages: [{ role: "user", content: [{ type: "text", text: "Run the regression action." }] }],
    signal: new AbortController().signal, maxIterations: 2, maxRunInputTokens: 10000,
    send: event => events.push(event),
  }));
  const done = events.find(event => event.type === "tool_done");
  assert.ok(done && done.type === "tool_done", "one actual Native tool completion");
  assert.equal(events.filter(event => event.type === "tool_done").length, 1);
  return done;
}

for (const exported of ["named", "default"] as const) {
  test(`Native ${exported} discovery preserves JSON scalar, nested record and array types`, async () => {
    const schema = z.object({ record: z.record(z.string(), z.unknown()) });
    const received: unknown[] = [];
    const action = defineAction({ description: "Echo a JSON record.", schema, agentTool: true, http: false,
      readOnly: true, run: async input => { received.push(input); return input; } });
    const actions = loadActionsFromStaticRegistry({ echo: exported === "named" ? action : { default: action } });
    const input = { record: { number: 0, boolean: false, nothing: null,
      nested: { number: 2, boolean: true, nothing: null }, array: [0, false, null, { number: 3 }] } };
    const before = structuredClone(input);
    const done = await call(actions, "echo", input);
    assert.equal(done.isError, undefined, done.result);
    assert.deepEqual(received, [before]);
    assert.deepEqual(input, before, "validation must not mutate already valid JSON values");
    assert.deepEqual(JSON.parse(done.result), before);
  });
}

test("Native filesystem discovery retains the action validator for both export forms", async () => {
  const directory = path.join(root, "actions");
  await mkdir(directory);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  const core = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
  const zod = await realpath(new URL("../node_modules/zod/index.js", import.meta.url));
  const source = `import { defineAction } from ${JSON.stringify(pathToFileURL(path.join(core, "dist/action.js")).href)};
import { z } from ${JSON.stringify(pathToFileURL(zod).href)};
const action = defineAction({ description: "Echo a discovered record.", schema: z.object({ record: z.record(z.string(), z.unknown()) }),
  agentTool: true, http: false, readOnly: true, run: async input => input });
`;
  await writeFile(path.join(directory, "named.js"), source + 'export const { tool, run, schema, agentTool, http, readOnly } = action;\n');
  await writeFile(path.join(directory, "default.js"), source + 'export default action;\n');
  const discovered = await autoDiscoverActions(directory);
  for (const name of ["named", "default"]) {
    const input = { record: { number: 0, boolean: false, nothing: null, nested: { number: 2 }, array: [0, false, null] } };
    const before = structuredClone(input);
    const done = await call({ [name]: discovered[name] }, name, input);
    assert.equal(done.isError, undefined, done.result);
    assert.deepEqual(JSON.parse(done.result), before);
    assert.deepEqual(input, before);
  }
});

test("Native keeps strict action validation and authorization after preserving its schema", async () => {
  let authorized = 0, runs = 0;
  const action = defineAction({ description: "Check a typed count.", schema: z.object({ count: z.number().int().nonnegative() }),
    agentTool: true, http: false, readOnly: true, authorize: () => { authorized++; },
    run: async input => { runs++; return input; } });
  const actions = loadActionsFromStaticRegistry({ count: { default: action } });
  for (const count of ["wrong", -1, 0.5]) {
    const done = await call(actions, "count", { count });
    assert.equal(done.isError, true);
    assert.match(done.result, /Invalid action parameters/);
  }
  assert.deepEqual([authorized, runs], [0, 0]);
  const done = await call(actions, "count", { count: 0 });
  assert.equal(done.isError, undefined, done.result);
  assert.deepEqual([authorized, runs], [1, 1]);
});

test("Native raw JSON-schema tools preserve valid JSON records before attempting coercion", async () => {
  const action = defineAction({ description: "Echo a JSON record.",
    schema: z.object({ record: z.record(z.string(), z.unknown()) }), agentTool: true, http: false,
    readOnly: true, run: async input => input });
  // A manually declared JSON-schema tool has no wrapped Standard Schema validator.
  const { schema: _schema, ...rawAction } = action;
  const actions = loadActionsFromStaticRegistry({ echo: rawAction });
  const input = { record: { number: 0, boolean: false, nothing: null, nested: { number: 2 }, array: [0, false, null] } };
  const before = structuredClone(input);
  const done = await call(actions, "echo", input);
  assert.equal(done.isError, undefined, done.result);
  assert.deepEqual(JSON.parse(done.result), before);
  assert.deepEqual(input, before);
});

test("Native raw JSON-schema tools retain compatible coercion and reject invalid values", async () => {
  let runs = 0;
  const actions: Actions = { count: { tool: { name: "count", description: "Read a count.",
    parameters: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false } },
    agentTool: true, http: false, readOnly: true, run: async input => { runs++; return input; } } };
  const compatible = await call(actions, "count", { count: "2" });
  assert.equal(compatible.isError, undefined, compatible.result);
  assert.deepEqual(JSON.parse(compatible.result), { count: 2 });
  for (const count of ["wrong", -1, 0.5]) {
    const invalid = await call(actions, "count", { count });
    assert.equal(invalid.isError, true);
  }
  assert.equal(runs, 1);
});

test("Native Decide passes numeric budgets intact and retains the server authority boundary", async () => {
  const calls: GovernedCommand[] = [];
  const evaluations = createProjectEvaluate({
    chatProject: async () => ({ projectId: "project-a", projectContext: { caller: "tool", userEmail: "owner@example.test", orgId: "org-a", appId: "workbench" } }),
    run: async (_projectId, command): Promise<ProjectEvaluateRun> => {
      calls.push(command);
      return { project: { id: "project-a", label: "Project A" }, exitCode: 0, stderr: "",
        stdout: JSON.stringify({ schema: "vivary.strato-decision/v0", decision: "request_gate", reason_codes: ["gate_required"] }),
        actor: { kind: "agent", id: "project-agent-a" }, hostPaths: { root: "/fixture/project", dataDir: "/fixture/data" } } as ProjectEvaluateRun;
    },
  });
  const actions = loadActionsFromStaticRegistry({ "vivary-project-evaluate": { default: defineProjectEvaluateTool(evaluations) } });
  const input = { operation: "decide", capsule: { task: { scope: ["."] }, count: 0, flag: false, empty: null },
    state: { turns_used: 0, actions_used: 0 }, limits: { max_turns: 3, max_actions: 3 } };
  const done = await call(actions, "vivary-project-evaluate", input);
  assert.equal(done.isError, undefined, done.result);
  assert.equal(JSON.parse(done.result).status, "evaluated");
  assert.deepEqual(calls.map(command => command.input), [input]);
  for (const [extra, reason, field] of [
    [{ actor: { kind: "human", id: "forged" } }, "server_owned_field", "actor"],
    [{ receipt: {} }, "agent_forbidden_evidence", "receipt"],
    [{ operation: "complete" }, "owner_only_operation", undefined],
    [{ operation: "claim", paths: ["../other"], state: { claims: [] } }, "foreign_path", "paths"],
  ] as const) {
    const refused = await call(actions, "vivary-project-evaluate", { ...input, ...extra });
    const result = JSON.parse(refused.result);
    assert.equal(result.status, "refused");
    assert.equal(result.reason, reason);
    assert.equal(result.field, field);
  }
  const invalid = await call(actions, "vivary-project-evaluate", { ...input, state: { turns_used: "0" } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.result, /expected number, received string/);
  assert.equal(calls.length, 1, "all authority and invalid-input refusals happen before a child runner");
});
