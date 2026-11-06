import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActionRunContext } from "@agent-native/core/action";
import { actionsToEngineTools, executeAgentToolCall, loadActionsFromStaticRegistry, runWithRequestContext } from "@agent-native/core/server";

import { defineProjectEvaluateTool } from "../actions/vivary-project-evaluate.ts";
import { returnedState } from "../app/lib/project-evaluate-form.ts";
import {
  AGENT_CONTROL_OPERATIONS, CONTROL_OPERATIONS, PROJECT_EVALUATE_MAX_RESULT_CHARS, SERVER_OWNED_FIELDS,
  type ProjectEvaluateResult,
} from "../app/lib/project-evaluate-schema.ts";
import {
  coreCanonicalPath, coreScopePath, decodeEvidence, encodeEvidence, EvidenceCodecError, governedDocument, PATH_POSITIONS,
  projectAgentActorId,
} from "../server/governed-request.ts";
import {
  createProjectEvaluateRunner, projectPathComponents, runOriginalProcess, type GovernedCommand, type ProjectEvaluateRun,
} from "../server/original-runtime.ts";
import { createProjectEvaluate } from "../server/project-evaluate.ts";

const owner: ActionRunContext = { caller: "http", userEmail: "owner@example.test", orgId: "org-a", appId: "workbench" };
const tool: ActionRunContext = { ...owner, caller: "tool" };
const project = { id: "project-a", label: "Project A" };
const clock = new Date("2026-09-26T12:00:00.000Z");
const agentId = projectAgentActorId("actor-owner", "project-a");
const packages = path.join(import.meta.dirname, "..", "..");

// Strato and Exo from this checkout, driven exactly as the bundled `vivary`
// front door drives them, so every result below is the real policy's answer.
const python = execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const components = [
  "import sys",
  "sys.path[:0] = [sys.argv[1] + '/core', sys.argv[1] + '/strato', sys.argv[1] + '/exo']",
  "args = sys.argv[2:]",
  "module = __import__('strato' if args[0] == 'decide' else 'exo')",
  "sys.exit(module.main(args))",
].join("\n");

async function harness(options: { root?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-project-evaluate-"));
  const runtime = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const root = path.join(directory, "project");
  const interpreter = process.platform === "win32" ? "python/python.exe" : "python/bin/python3";
  await Promise.all([mkdir(path.join(runtime, path.dirname(interpreter)), { recursive: true }), mkdir(data), mkdir(root)]);
  await writeFile(path.join(runtime, interpreter), "fixture interpreter, not executable");
  await writeFile(path.join(runtime, "manifest.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform,
    arch: process.arch, pythonVersion: "3.12.14", pythonExecutable: interpreter }));
  await writeFile(path.join(root, "notes.md"), "# Notes\n");
  const workspace = { root: options.root ?? root, actorId: "actor-owner", label: "Project A", projectId: "project-a", rootId: "root-a", bindingId: "binding-a",
    bindingRevision: 1, policyRevision: 1, locationRef: "local:a", verificationKind: "local-stat-revalidated-v1" as const };
  let runs = 0;
  const run = createProjectEvaluateRunner({ parallelism: 4, now: () => clock,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
    resolveWorkspace: async () => workspace,
    execute: (_python, args, stdin, cwd, environment, signal) => {
      runs++;
      return runOriginalProcess(python, ["-X", "utf8", "-B", "-c", components, packages, ...args.slice(6)], stdin, cwd,
        environment, signal);
    } });
  const evaluations = createProjectEvaluate({ run, chatProject: async () => ({ projectId: "project-a", projectContext: tool }) });
  const receipts = path.join(data, "original-runtime", "receipts.jsonl");
  // Everything a refusal must leave untouched: the project's files and the receipt log.
  const records = async () => {
    const hash = createHash("sha256");
    for (const entry of (await readdir(root, { recursive: true })).map(String).sort()) {
      hash.update(entry + "\0" + await readFile(path.join(root, entry)).catch(() => ""));
    }
    return [hash.digest("hex"), await readFile(receipts, "utf8").catch(() => "")];
  };
  return { directory, root, data, run, evaluations, records, runs: () => runs, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function fake(output: (command: GovernedCommand) => Partial<ProjectEvaluateRun>) {
  const calls: GovernedCommand[] = [];
  const run = async (_projectId: string, command: GovernedCommand): Promise<ProjectEvaluateRun> => {
    calls.push(command);
    return { project, exitCode: 0, stderr: "", stdout: "{}", actor: { kind: "agent", id: agentId },
      hostPaths: { root: "/fixture/project", dataDir: "/fixture/app-data" }, ...output(command) } as ProjectEvaluateRun;
  };
  return { calls, evaluations: createProjectEvaluate({ run, chatProject: async () => ({ projectId: "project-a", projectContext: tool }) }) };
}

const evaluated = (result: ProjectEvaluateResult) => {
  assert.equal(result.status, "evaluated", JSON.stringify(result));
  if (result.status !== "evaluated") throw new Error("unreachable");
  return result as Extract<ProjectEvaluateResult, { status: "evaluated" }> & { output: Record<string, any> };
};
const expire = { operation: "expire_leases", state: { claims: [] } };
const observed = (seconds: number) => ({ task: { scope: ["."] }, workspace: { fingerprint: "capsule-print",
  observed_at: new Date(clock.getTime() - seconds * 1000).toISOString() } });

test("the owner's agent mode returns exactly the tool's result, and Me names the owner", async () => {
  const h = await harness();
  try {
    for (const input of [{ operation: "claim", state: { claims: [] }, paths: ["src/api"] }, expire,
      { operation: "decide", capsule: observed(10) }]) {
      const chat = await h.evaluations.forChat(tool, input);
      const agentMode = await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "agent", ...input } as never);
      assert.deepEqual(agentMode, chat, input.operation);
      assert.deepEqual(evaluated(chat).evaluatedAs, { kind: "agent", id: agentId, authorityClass: "contributor", role: "project-agent" });
      assert.equal(chat.status === "evaluated" && chat.persisted, false);
      assert.match(evaluated(chat).notice, /^Evaluation only\. Vivary did not save this result, and it does not authorize or start any work\./);
    }
    const me = evaluated(await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me", ...expire } as never));
    assert.deepEqual(me.evaluatedAs, { kind: "human", id: "actor-owner", authorityClass: "contributor", role: "owner" });
    assert.equal(me.evaluationKind, "caller-provided-evidence");
    assert.equal(JSON.stringify(me).includes(h.directory), false);
  } finally { await h.cleanup(); }
});

test("each server-owned field is refused by name before anything runs", async () => {
  const h = await harness();
  try {
    const before = await h.records();
    for (const field of SERVER_OWNED_FIELDS) {
      // The owner's projectId selects the project, so only the tool can be refused for naming one.
      const ownerResult = field === "projectId" ? []
        : [await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me", ...expire, [field]: "forged" } as never)];
      for (const result of [await h.evaluations.forChat(tool, { ...expire, [field]: "forged" }), ...ownerResult]) {
        assert.deepEqual(result, { status: "refused", project: null, operation: "expire_leases", reason: "server_owned_field",
          field, message: `Vivary sets ${field} itself. Remove ${field} and try again.` });
      }
    }
    assert.equal(h.runs(), 0);
    assert.deepEqual(await h.records(), before);
  } finally { await h.cleanup(); }
});

test("the agent cannot run an owner-only operation or submit execution evidence", async () => {
  const { calls, evaluations } = fake(() => ({}));
  const ownerOnly = CONTROL_OPERATIONS.filter(operation => !(AGENT_CONTROL_OPERATIONS as readonly string[]).includes(operation));
  assert.deepEqual(ownerOnly, ["task_view", "complete", "handoff", "record_execution"]);
  for (const operation of ownerOnly) {
    for (const result of [await evaluations.forChat(tool, { operation }),
      await evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "agent", operation } as never)]) {
      assert.ok(result.status === "refused" && result.reason === "owner_only_operation" && result.project === null, operation);
    }
  }
  for (const [input, field] of [[{ operation: "decide", capsule: {}, receipt: {} }, "receipt"],
    [{ operation: "decide", capsule: {}, verdict: "pass" }, "verdict"],
    [{ operation: "task_view", state: { task: {}, execution_log: [] } }, "execution_log"]] as const) {
    const result = await evaluations.forChat(tool, input);
    assert.ok(result.status === "refused" && result.reason === "agent_forbidden_evidence" && result.field === field, field);
  }
  assert.equal(calls.length, 0);
});

test("an absolute or parent-relative path is a foreign path, before or after the runner resolves it", async () => {
  const h = await harness();
  try {
    const before = await h.records();
    for (const bad of ["/etc", "../outside", "src/../../outside", "C:/outside", "src\\api", "src/\0"]) {
      assert.deepEqual(await h.evaluations.forChat(tool, { operation: "claim", state: { claims: [] }, paths: [bad] }),
        { status: "refused", project: null, operation: "claim", reason: "foreign_path", field: "paths",
          message: "Use paths inside this project, such as src/api. Absolute and parent-relative paths are not accepted." }, bad);
    }
    const outside = { scope: { project: "project-a", paths: [path.dirname(h.root)] }, authority_class: "contributor" };
    for (const input of [{ ...expire, state: { claims: [outside] } }, { operation: "decide", capsule: { task: { scope: ["./../x"] } } }]) {
      const result = await h.evaluations.forChat(tool, input);
      assert.ok(result.status === "refused" && result.reason === "foreign_path", JSON.stringify(result));
      assert.deepEqual(result.project, project);
    }
    assert.equal(h.runs(), 0);
    assert.deepEqual(await h.records(), before);
  } finally { await h.cleanup(); }
});

test("Strato measures capsule age against the server clock", async () => {
  const h = await harness();
  try {
    const stale = evaluated(await h.evaluations.forChat(tool, { operation: "decide", capsule: observed(301) }));
    assert.equal(stale.refusedBy, "strato");
    assert.ok(stale.output.reason_codes.includes("stale_capsule"), stale.output.reason_codes.join());
    const fresh = evaluated(await h.evaluations.forChat(tool, { operation: "decide", capsule: observed(299) }));
    assert.equal(fresh.output.reason_codes.includes("stale_capsule"), false);
    assert.match(fresh.notice, /copied the workspace fingerprint from the capsule/);
  } finally { await h.cleanup(); }
});

test("a verdict without a receipt is Strato's refusal as Me and a named refusal for the agent", async () => {
  const h = await harness();
  try {
    const me = evaluated(await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me",
      operation: "decide", capsule: observed(10), verdict: "pass" } as never));
    assert.equal(me.refusedBy, "strato");
    assert.ok(me.output.reason_codes.includes("verdict_requires_receipt"));
    const agent = await h.evaluations.forChat(tool, { operation: "decide", capsule: observed(10), verdict: "pass" });
    assert.ok(agent.status === "refused" && agent.reason === "agent_forbidden_evidence" && agent.field === "verdict");
  } finally { await h.cleanup(); }
});

test("Exo's refusals and Core's reason codes pass through verbatim", async () => {
  const refusal = { schema: "vivary.exo-control-refusal/v0", reason_codes: ["invalid_request_document"] };
  const { evaluations } = fake(() => ({ exitCode: 1, stdout: JSON.stringify(refusal) }));
  const result = evaluated(await evaluations.forChat(tool, expire));
  assert.equal(result.refusedBy, "exo");
  assert.deepEqual(result.output, refusal);
  const h = await harness();
  try {
    const malformed = evaluated(await h.evaluations.forChat(tool, { operation: "dependencies", state: { tasks: [42] }, task_id: "t" }));
    assert.equal(malformed.refusedBy, null);
    assert.ok(malformed.output.result.reason_codes.length > 0, JSON.stringify(malformed.output));
  } finally { await h.cleanup(); }
});

test("a claim's returned state releases the same claim, and no host path reaches the result", async () => {
  const h = await harness();
  try {
    const claimed = evaluated(await h.evaluations.forChat(tool, { operation: "claim", state: { claims: [] }, paths: ["src/api"] }));
    const { claim, claims } = claimed.output.result;
    assert.equal(claimed.output.result.decision, "granted", JSON.stringify(claimed.output));
    assert.deepEqual(claim.scope, { project: "project-a", paths: ["./src/api"] });
    assert.deepEqual(claim.actor, { kind: "agent", id: agentId });
    assert.equal(JSON.stringify(claimed).includes(h.directory), false);
    const released = evaluated(await h.evaluations.forChat(tool, { operation: "release", state: { claims }, claim_id: claim.claim_id }));
    assert.equal(released.output.result.decision, "released", JSON.stringify(released.output));
    assert.deepEqual(released.output.result.claims, []);
    assert.match(claimed.notice, /Vivary did not record this claim\. No one else can see it\./);
    const foreign = evaluated(await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me",
      operation: "release", state: { claims }, claim_id: claim.claim_id } as never));
    assert.equal(foreign.output.result.decision, "refused", "the owner cannot release the agent's claim");
    assert.equal(foreign.refusedBy, "exo");
  } finally { await h.cleanup(); }
});

test("an agent's claim and decide read an existing private file or link exactly like a missing name", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.root, ".gitignore"), "private-roadmap.md\n");
    await writeFile(path.join(h.root, "private-roadmap.md"), "# Private\n");
    await symlink(h.data, path.join(h.root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const inputs = (name: string) => [
      { operation: "claim", state: { claims: [] }, paths: [`${name}/x`] },
      { operation: "decide", capsule: { ...observed(10), task: { scope: [`./${name}/x`] } } },
    ];
    // Only the name itself and the claim id derived from it may differ.
    const shape = (result: ProjectEvaluateResult, name: string) =>
      JSON.parse(JSON.stringify(result).replaceAll(name, "NAME").replace(/"claim_id":"[^"]+"/g, "\"claim_id\":\"ID\""));
    const absent = "absent-" + randomUUID();
    for (const existing of ["private-roadmap.md", "linked"]) {
      for (const [index, input] of inputs(existing).entries()) {
        const seen = await h.evaluations.forChat(tool, input);
        assert.equal(seen.status, "evaluated", JSON.stringify(seen));
        assert.deepEqual(shape(seen, existing), shape(await h.evaluations.forChat(tool, inputs(absent)[index]), absent), existing);
      }
    }
    const mine = await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me", ...inputs("private-roadmap.md")[0] } as never);
    assert.ok(mine.status === "refused" && mine.reason === "foreign_path", "the owner's own evaluation keeps the disk walk");
  } finally { await h.cleanup(); }
});

test("a Core refusal inside a result names its refuser, and a granted claim says it was not recorded", async () => {
  const decisions = [
    ["decide", { schema: "vivary.strato-decision/v0", decision: "blocked", reason_codes: ["blocked_by_gate"] }, "strato"],
    ["decide", { schema: "vivary.strato-decision/v0", decision: "request_gate", reason_codes: ["gate_required"] }, null],
    ["claim", { schema: "vivary.exo-control-result/v0", operation: "claim", result: { decision: "refused", reason_codes: ["scope_conflict"] } }, "exo"],
    ["claim", { schema: "vivary.exo-control-result/v0", operation: "claim", result: { decision: "granted", reason_codes: [] } }, null],
  ] as const;
  for (const [operation, output, refusedBy] of decisions) {
    const input = operation === "decide" ? { operation, capsule: {} } : { operation, state: { claims: [] }, paths: ["src"] };
    const result = evaluated(await fake(() => ({ stdout: JSON.stringify(output) })).evaluations.forChat(tool, input));
    assert.equal(result.refusedBy, refusedBy, JSON.stringify(output));
    assert.deepEqual(result.output, output, "output stays verbatim");
    assert.equal(result.notice.includes("Vivary did not record this claim. No one else can see it."),
      operation === "claim" && output.result.decision === "granted", JSON.stringify(output));
  }
  const h = await harness();
  try {
    const claimed = evaluated(await h.evaluations.forChat(tool, { operation: "claim", state: { claims: [] }, paths: ["src"] }));
    const conflict = evaluated(await h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me",
      operation: "claim", state: { claims: claimed.output.result.claims }, paths: ["src/api"] } as never));
    assert.equal(conflict.output.result.decision, "refused", JSON.stringify(conflict.output));
    assert.equal(conflict.refusedBy, "exo");
    // These four answer without a decision and name a refusal only by its reason codes.
    const me = (input: Record<string, unknown>) =>
      h.evaluations.forOwner(owner, { projectId: "project-a", evaluateAs: "me", ...input } as never);
    const shapeless = [
      ["expire_leases", await h.evaluations.forChat(tool, { operation: "expire_leases",
        state: { claims: [{ scope: { project: "project-a", paths: ["./src"] }, authority_class: "contributor" }] } })],
      ["record_execution", await me({ operation: "record_execution", state: { execution_log: [] }, receipt: {}, capsule: {} })],
      ["complete", await me({ operation: "complete", state: { task: {}, execution_log: [] } })],
      ["task_view", await me({ operation: "task_view", state: { task: {}, execution_log: [] } })],
    ] as const;
    for (const [operation, seen] of shapeless) {
      const result = evaluated(seen);
      assert.equal(result.output.result.decision, undefined, JSON.stringify(result.output));
      assert.ok(result.output.result.reason_codes.length > 0, JSON.stringify(result.output));
      assert.equal(result.refusedBy, "exo", operation);
      assert.equal(returnedState(result), null, `${operation} offers no state to use`);
    }
  } finally { await h.cleanup(); }
});

test("an identity refusal is a named value, never a thrown error", async () => {
  const h = await harness();
  try {
    const ledger = { claims: [{ scope: { project: "project-a", paths: [h.root] }, authority_class: "owner" }] };
    assert.deepEqual(await h.evaluations.forChat(tool, { operation: "expire_leases", state: ledger }),
      { status: "refused", project, operation: "expire_leases", reason: "identity",
        message: "Every claim in the state must belong to this project and hold contributor authority." });
    assert.equal(h.runs(), 0);
  } finally { await h.cleanup(); }
});

test("a state the runner cannot check is request_invalid, never an identity claim", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.evaluations.forChat(tool, { operation: "expire_leases", state: { claims: [42] } }),
      { status: "refused", project, operation: "expire_leases", reason: "request_invalid",
        message: "Vivary could not check this request's state and paths against this project, so it did not run." });
    assert.equal(h.runs(), 0);
  } finally { await h.cleanup(); }
});

test("the codec rewrites only path positions, redacts host paths in text, and never decodes text", () => {
  const hostPaths = { root: "/host/project", dataDir: "/host/app-data" };
  const result = { schema: "vivary.exo-control-result/v0", operation: "claim", result: { decision: "granted",
    claims: [{ claim_id: "claim-1", scope: { project: "project-a", paths: ["/host/project", "/host/project/src/api"] } }],
    note: "saved in /host/app-data/logs from /host/project/src", ["/host/project/key"]: "./kept as text" } };
  const encoded = encodeEvidence(result, hostPaths) as { result: { claims: unknown[]; note: string } };
  assert.deepEqual(encoded, { schema: result.schema, operation: "claim", result: { decision: "granted",
    claims: [{ claim_id: "claim-1", scope: { project: "project-a", paths: [".", "./src/api"] } }],
    note: "saved in <app data>/logs from ./src", ["./key"]: "./kept as text" } });
  assert.deepEqual(decodeEvidence({ claims: encoded.result.claims, note: encoded.result.note }, hostPaths.root, "state"),
    { claims: result.result.claims, note: "saved in <app data>/logs from ./src" }, "text is never decoded");
  for (const lookalike of ["./not-a-host-path", ".", "/HOST/project/x", "/host/app-data/x"]) {
    assert.throws(() => encodeEvidence({ scope: { paths: [lookalike] } }, hostPaths),
      (error: unknown) => error instanceof EvidenceCodecError && error.reason === "unencodable_evidence", lookalike);
  }
  assert.throws(() => decodeEvidence(["./../outside"], hostPaths.root, "capsule.task.scope"),
    (error: unknown) => error instanceof EvidenceCodecError && error.reason === "foreign_path");
  assert.deepEqual(PATH_POSITIONS.filter(position => position.spelling === "scope").map(position => position.at).sort(),
    ["result.claim.scope.paths.*", "result.claims.*.scope.paths.*", "result.conflicts.*.scope.paths.*",
      "result.expired.*.claim.scope.paths.*", "result.handoff.scope.paths.*", "state.claims.*.scope.paths.*"]);
});

test("a capsule's text keeps its bytes, so a ./ command and a . excerpt survive the round trip", () => {
  const root = "/host/project";
  const capsule = { schema: "vivary.task-capsule/v0", capsule_id: "capsule-1", fingerprint: "sha256:print",
    task: { question: "Does it build?", scope: ["/host/project"],
      required_checks: [{ name: "build", command: "./gradlew build", cwd: "/host/project/app" }] },
    required_checks: [{ name: "verify", command: "./scripts/verify.sh", cwd: "/host/project" }],
    claims: [{ id: "c", subject_path: "/host/project", evidence: [{ excerpt: "." }, { excerpt: "./x and ./../y" }] }],
    workspace: { fingerprint: "sha256:print", observed_at: "2026-09-26T11:59:00Z" } };
  const encoded = encodeEvidence({ capsule }, { root, dataDir: "/host/app-data" }) as { capsule: typeof capsule };
  assert.deepEqual(encoded.capsule.task.scope, ["."]);
  assert.deepEqual(encoded.capsule.required_checks, [{ name: "verify", command: "./scripts/verify.sh", cwd: "." }]);
  assert.deepEqual(encoded.capsule.claims[0].evidence, capsule.claims[0].evidence);
  assert.deepEqual(decodeEvidence(encoded.capsule, root, "capsule", path.posix), capsule);
  const workspace = { ...windowsWorkspace, root };
  for (const handed of [capsule, encoded.capsule]) {
    const decision = JSON.parse(governedDocument({ operation: "decide", capsule: handed }, workspace, agent, clock, path.posix));
    assert.equal(JSON.stringify(decision.capsule), JSON.stringify(capsule), "byte for byte");
  }
});

test("output that cannot be encoded, is unreadable, or is too large is refused, never cut", async () => {
  const exoResult = (result: unknown) => JSON.stringify({ schema: "vivary.exo-control-result/v0", operation: "expire_leases", result });
  for (const [stdout, expected] of [
    [exoResult({ claims: [{ scope: { paths: ["./looks-like-a-path"] } }] }), "unencodable_evidence"],
    [exoResult({ claims: ["x".repeat(PROJECT_EVALUATE_MAX_RESULT_CHARS)] }), "result_too_large"],
  ] as const) {
    const result = await fake(() => ({ stdout })).evaluations.forChat(tool, expire);
    assert.ok(result.status === "refused" && result.reason === expected && result.project?.id === "project-a", JSON.stringify(result).slice(0, 200));
  }
  for (const stdout of ["not json", exoResult({}).replace("expire_leases", "claim"), "{\"schema\":\"other\"}"]) {
    const result = await fake(() => ({ stdout })).evaluations.forChat(tool, expire);
    assert.ok(result.status === "unavailable" && result.reason === "unreadable_output", stdout);
  }
});

test("the Native tool refuses a server-owned field by name and offers only the agent's operations", async () => {
  const { calls, evaluations } = fake(() => ({ stdout: JSON.stringify({ schema: "vivary.exo-control-result/v0",
    operation: "expire_leases", result: { claims: [], expired: [], reason_codes: [] } }) }));
  const actions = loadActionsFromStaticRegistry({ "vivary-project-evaluate": { default: defineProjectEvaluateTool(evaluations) } });
  const call = (input: unknown) => runWithRequestContext({ userEmail: owner.userEmail, orgId: owner.orgId, run: {} },
    () => executeAgentToolCall({ actions, name: "vivary-project-evaluate", input, callId: "call-evaluate",
      ownerEmail: owner.userEmail!, orgId: owner.orgId! }));
  const forged = await call({ ...expire, actor: { kind: "human", id: "actor-owner" } });
  assert.equal(forged.status, "completed", forged.output);
  assert.deepEqual(JSON.parse(forged.output), { status: "refused", project: null, operation: "expire_leases",
    reason: "server_owned_field", field: "actor", message: "Vivary sets actor itself. Remove actor and try again." });
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse((await call({ ...expire, evaluateAs: "me" })).output), { status: "refused", project: null,
    operation: "expire_leases", reason: "server_owned_field", field: "evaluateAs",
    message: "Vivary sets evaluateAs itself. Remove evaluateAs and try again." });
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse((await call(expire)).output).status, "evaluated");
  assert.equal(calls.length, 1);
  const [advertised] = actionsToEngineTools(actions);
  const schema = JSON.stringify(advertised.inputSchema);
  for (const operation of ["decide", ...AGENT_CONTROL_OPERATIONS]) assert.ok(schema.includes(`"${operation}"`), operation);
  for (const hidden of ["task_view", "record_execution", "\"actor\"", "\"receipt\"", "\"verdict\"", "\"now\""]) {
    assert.equal(schema.includes(hidden), false, hidden);
  }
  assert.match(advertised.description, /not permission to run/);
  assert.match(advertised.description, /cannot build a capsule/);
});

const windowsRoot = "C:\\Users\\Jeff\\Proj";
const windowsPaths = { root: windowsRoot, dataDir: "C:\\Users\\Jeff\\AppData\\Roaming\\Vivary" };
const windowsWorkspace = { root: windowsRoot, actorId: "actor-owner", label: "Project A", projectId: "project-a", rootId: "root-a",
  bindingId: "binding-a", bindingRevision: 1, policyRevision: 1, locationRef: "local:a", verificationKind: "local-stat-revalidated-v1" as const };
const agent = { kind: "agent" as const, id: agentId };

test("a Windows claim round-trips through Core's scope spelling, and a release gets it back byte for byte", () => {
  const claimRequest = JSON.parse(governedDocument({ operation: "claim", state: { claims: [] }, paths: ["src/api"] },
    windowsWorkspace, agent, clock, path.win32));
  assert.deepEqual(claimRequest.input.scope.paths, ["C:\\Users\\Jeff\\Proj\\src\\api"], "a new claim path is joined natively");
  // Core answers with the scope spelling, casefolded with forward slashes.
  const claim = { claim_id: "claim_0123456789abcdef", scope: { project: "project-a", paths: ["c:/users/jeff/proj/src/api"] },
    actor: agent, authority_class: "contributor", status: "active", lease: null, created_at: "2026-09-26T12:00:00.000Z" };
  const encoded = encodeEvidence({ schema: "vivary.exo-control-result/v0", operation: "claim",
    result: { decision: "granted", claim, claims: [claim], conflicts: [] } }, windowsPaths) as { result: { claims: unknown[] } };
  assert.deepEqual((encoded.result.claims[0] as typeof claim).scope.paths, ["./src/api"]);
  const release = JSON.parse(governedDocument({ operation: "release", state: { claims: encoded.result.claims }, claim_id: claim.claim_id },
    windowsWorkspace, agent, clock, path.win32));
  assert.deepEqual(release.state.claims, [claim]);
  assert.equal(JSON.stringify(encoded).toLowerCase().includes("users"), false);
});

test("a Windows capsule in Core's canonical spelling round-trips byte for byte, and another spelling fails closed", () => {
  const capsule = { task: { scope: ["c:/Users/Jeff/Proj/notes", "c:/Users/Jeff/Proj"] },
    required_checks: [{ name: "test", command: "pnpm test", cwd: "c:/Users/Jeff/Proj" }],
    workspace: { fingerprint: "sha256:print", observed_at: "2026-09-26T11:59:00Z" } };
  const encoded = (encodeEvidence({ capsule }, windowsPaths) as { capsule: typeof capsule }).capsule;
  assert.deepEqual(encoded.task.scope, ["./notes", "."]);
  assert.deepEqual(decodeEvidence(encoded, windowsRoot, "capsule", path.win32), capsule);
  const decision = JSON.parse(governedDocument({ operation: "decide", capsule: encoded }, windowsWorkspace, agent, clock, path.win32));
  assert.deepEqual(decision.capsule, capsule);
  assert.deepEqual(decision.scope.paths, capsule.task.scope);
  // A capsule compiled from a lowercase cwd keeps its own spelling, which is not the root's on disk.
  const lowercase = { ...capsule, task: { scope: ["c:/users/jeff/proj/notes"] } };
  const unencodable = (error: unknown) => error instanceof EvidenceCodecError && error.reason === "unencodable_evidence";
  assert.throws(() => encodeEvidence({ capsule: lowercase }, windowsPaths), unencodable);
  assert.throws(() => encodeEvidence({ schema: "vivary.strato-decision/v0", decision: "blocked", reason_codes: [],
    scope: { project: "project-a", paths: lowercase.task.scope } }, windowsPaths), unencodable, "the decision's scope echo");
  assert.throws(() => encodeEvidence({ result: { claims: [{ scope: { paths: ["c:/Users/Jeff/Proj/src"] } }] } }, windowsPaths),
    unencodable, "a canonical spelling at a scope position");
  assert.throws(() => encodeEvidence({ capsule: { task: { scope: ["C:\\Users\\Jeff\\Proj\\notes"] } } }, windowsPaths),
    unencodable, "the host spelling at a canonical position");
});

test("a Windows device root fails closed with a named refusal", async () => {
  for (const root of ["\\\\?\\C:\\Users\\Jeff\\Proj", "\\\\.\\UNC\\Server\\Share\\Proj"]) {
    const refusedRoot = (error: unknown) => error instanceof EvidenceCodecError && error.reason === "unsupported_root";
    assert.throws(() => governedDocument(expire as never, { ...windowsWorkspace, root }, agent, clock, path.win32), refusedRoot, root);
    assert.throws(() => encodeEvidence({ note: "x" }, { root, dataDir: windowsPaths.dataDir }), refusedRoot, root);
    const h = await harness({ root });
    try {
      assert.deepEqual(await h.evaluations.forChat(tool, { operation: "claim", state: { claims: [] }, paths: ["src"] }),
        { status: "refused", project, operation: "claim", reason: "unsupported_root", message: "This project's folder is open through a Windows device path, which Vivary cannot evaluate. Reconnect the folder by its drive letter or share name." });
      assert.equal(h.runs(), 0);
    } finally { await h.cleanup(); }
  }
});

test("a Linux root keeps one spelling, and a spelling the codec cannot reproduce fails closed", () => {
  const linux = { root: "/Home/Jeff/Proj", dataDir: "/Home/Jeff/.vivary" };
  assert.equal(coreCanonicalPath(linux.root), linux.root);
  assert.equal(coreScopePath(linux.root), linux.root, "Core folds case only for Windows paths");
  const evidence = { state: { claims: [{ scope: { paths: ["/Home/Jeff/Proj/src"] } }] }, capsule: { task: { scope: ["/Home/Jeff/Proj"] } } };
  const encoded = encodeEvidence(evidence, linux) as typeof evidence;
  assert.deepEqual(encoded, { state: { claims: [{ scope: { paths: ["./src"] } }] }, capsule: { task: { scope: ["."] } } });
  assert.deepEqual(decodeEvidence(encoded.state, linux.root, "state", path.posix), evidence.state);
  assert.deepEqual(decodeEvidence(encoded.capsule, linux.root, "capsule", path.posix), evidence.capsule);
  // Python casefolds U+00DF to "ss", which toLowerCase does not reproduce.
  const german = { root: "C:\\Users\\Straße\\Proj", dataDir: "C:\\Data" };
  assert.throws(() => encodeEvidence({ path: "c:/users/strasse/proj/src" }, german),
    (error: unknown) => error instanceof EvidenceCodecError && error.reason === "unencodable_evidence");
});

test("Windows capsule and claim spellings of a path count as inside the project", () => {
  for (const [entry, expected] of [["c:/Users/Jeff/Proj/src/api", ["src", "api"]], ["c:/users/jeff/proj/src/api", ["src", "api"]],
    ["C:\\Users\\Jeff\\Proj", []], ["c:/users/jeff/proj", []], ["c:/users/jeff/project2", null], ["c:/users/jeff/proj/../x", null],
    ["d:/users/jeff/proj/src", null], ["src/api", null]] as const) {
    assert.deepEqual(projectPathComponents(windowsRoot, entry, path.win32), expected, entry);
  }
});

test("the root spellings match Core's own normalizers on Windows roots", () => {
  const roots = ["C:\\Users\\Jeff\\Proj", "c:\\Users\\JEFF\\Proj\\", "D:\\", "C:\\Users\\Ünïcode\\Ǆ Proj",
    "\\\\Server\\Share\\Proj", "\\\\?\\C:\\Users\\Jeff\\Proj"];
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1] + '/core')",
    "from vivary_core.canonical import normalize_path",
    "from vivary_core.control_scope import _normalize_scope_path",
    "print(json.dumps([[normalize_path(root), _normalize_scope_path(root)] for root in json.loads(sys.argv[2])]))",
  ].join("\n");
  const core = JSON.parse(execFileSync(python, ["-c", script, packages, JSON.stringify(roots)], { encoding: "utf8" }));
  assert.deepEqual(roots.map(root => [coreCanonicalPath(root), coreScopePath(root)]), core);
  const [, scopeOfGerman] = JSON.parse(execFileSync(python, ["-c", script, packages, JSON.stringify(["C:\\Straße"])],
    { encoding: "utf8" }))[0];
  assert.notEqual(coreScopePath("C:\\Straße"), scopeOfGerman, "the known casefold gap, which encodeEvidence refuses");
});
