import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCodeAgentRunRecord, getCodeAgentRunRecord } from "@agent-native/core/code-agents";
import { codexApprovalResponse, supportsCodexRequest } from "../server/codex-approval.ts";
import { approveVivaryCodeMessage, denyVivaryCodeMessage, getVivaryCodeHostState, getVivaryCodeState } from "../server/local-code-agent.ts";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CodexActionRequest } from "../server/code-execution-protocol.ts";

const coreAgents = path.dirname(createRequire(import.meta.url).resolve("@agent-native/core/code-agents"));
const { isCodeAgentRunActive } = await import(pathToFileURL(path.join(coreAgents, "transcript-order.js")).href);

function request(method: string, params = {}): CodexActionRequest {
  return { requestId: "11111111-1111-4111-8111-111111111111", method, params };
}

test("native action decisions retain exact requested scope and never grant session persistence", () => {
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    assert.deepEqual(codexApprovalResponse(request(method), { allow: true }), { decision: "accept" });
    assert.deepEqual(codexApprovalResponse(request(method), { allow: false }), { decision: "decline" });
  }
  const permissions = { fileSystem: { write: ["/fixture"] }, network: { enabled: true } };
  const native = request("item/permissions/requestApproval", { permissions });
  assert.deepEqual(codexApprovalResponse(native, { allow: true }), { permissions, scope: "turn" });
  assert.deepEqual(codexApprovalResponse(native, { allow: false }), { permissions: {}, scope: "turn" });
  assert.equal(supportsCodexRequest(request("unknown/native/method")), false);
  assert.throws(() => codexApprovalResponse(request("unknown/native/method"), { allow: true }), /not supported/);
});

test("native questions require answers and elicitation validates its requested schema", () => {
  const question = request("item/tool/requestUserInput", { questions: [{ id: "choice", question: "Which file?" }] });
  assert.throws(() => codexApprovalResponse(question, { allow: true }), /Answer each question/);
  assert.deepEqual(codexApprovalResponse(question, { allow: true, answers: { choice: ["README.md"], ignored: ["other"] } }),
    { answers: { choice: { answers: ["README.md"] } } });
  assert.deepEqual(codexApprovalResponse(question, { allow: false }), { answers: {} });
  const form = request("mcpServer/elicitation/request", { mode: "form", requestedSchema: {
    type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false,
  } });
  assert.throws(() => codexApprovalResponse(form, { allow: true, content: {} }));
  assert.deepEqual(codexApprovalResponse(form, { allow: true, content: { name: "fixture" } }),
    { action: "accept", content: { name: "fixture" } });
  assert.deepEqual(codexApprovalResponse(form, { allow: false }), { action: "decline" });
  for (const mode of ["openai/form", "openaiForm"]) {
    assert.equal(supportsCodexRequest(request("mcpServer/elicitation/request", { ...form.params, mode })), false);
  }
  assert.equal(supportsCodexRequest(request("mcpServer/elicitation/request", { mode: "form", requestedSchema: {
    type: "object", properties: { hidden: { type: "object", default: { grant: true } } },
  } })), false);
  const defaulted = request("mcpServer/elicitation/request", { mode: "form", requestedSchema: {
    type: "object", properties: { grant: { type: "boolean", default: true } }, required: ["grant"], additionalProperties: false,
  } });
  assert.throws(() => codexApprovalResponse(defaulted, { allow: true, content: {} }));
  for (const grant of [false, true]) {
    assert.deepEqual(codexApprovalResponse(defaulted, { allow: true, content: { grant } }),
      { action: "accept", content: { grant } });
  }
});

test("native approval rejects cross-owner, cross-org, cross-project, stale and changed-binding requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-native-approval-"));
  const oldStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const oldMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const oldDatabase = process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = directory; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  process.env.VIVARY_ACCESS_MODE = "hosted"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  process.env.DATABASE_URL = "file:" + path.join(directory, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const ownerEmail = "owner@example.test", orgId = "approval-org", runId = "native-approval-test";
  const workspace = { root: directory, label: "Fixture", projectId: "approval-project",
    bindingId: "approval-binding", rootId: "approval-root", bindingRevision: 1 };
  await getVivaryCodeHostState(ownerEmail, orgId);
  const host = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host"));
  const native = request("item/commandExecution/requestApproval", { command: "read fixture", cwd: directory });
  let resolved: unknown;
  const pending = new Map([[native.requestId, { request: native, resolve: (value: unknown) => { resolved = value; } }]]);
  const active = { ownerEmail, orgId, workspace, controller: new AbortController(), execution: null,
    stopReason: null, permissionMode: "normal", requests: pending };
  try {
    createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code", title: "Native action", cwd: directory,
      status: "needs-approval", phase: "action-approval", needsApproval: true,
      metadata: { app: "vivary-workbench-local-code", ownerEmail, orgId, engine: "codex-cli", model: "gpt-example",
        workspaceRoot: directory, projectId: workspace.projectId, bindingId: workspace.bindingId,
        rootId: workspace.rootId, bindingRevision: workspace.bindingRevision } });
    host.activeRuns.set(runId, active);
    const visible = await getVivaryCodeState(ownerEmail, runId, workspace, orgId);
    assert.equal(visible.run?.status, "needs-approval");
    assert.equal(visible.run?.phase, "action-approval");
    assert.equal(visible.runs.find(run => run.id === runId)?.phase, "action-approval");
    assert.ok(visible.run);
    assert.equal(isCodeAgentRunActive(visible.run), true);
    const input = { ownerEmail, orgId, runId, requestId: native.requestId, projectId: workspace.projectId };
    for (const patch of [{ ownerEmail: "other@example.test" }, { orgId: "other-org" },
      { projectId: "other-project" }, { runId: "other-run" }, { requestId: "22222222-2222-4222-8222-222222222222" }]) {
      await assert.rejects(denyVivaryCodeMessage({ ...input, ...patch }), { errorCode: "vivary_code_approval_stale" });
    }
    assert.equal(resolved, undefined);
    const changed = { ...workspace, rootId: "reconnected-root", bindingRevision: 2 };
    await assert.rejects(approveVivaryCodeMessage({ ...input, workspace: changed, revalidateWorkspace: async () => changed }),
      { statusCode: 409 });
    assert.equal(resolved, undefined);
    await approveVivaryCodeMessage({ ...input, workspace, revalidateWorkspace: async () => workspace });
    assert.deepEqual(resolved, { decision: "accept" });
    assert.equal(getCodeAgentRunRecord(runId)?.needsApproval, false);
    await assert.rejects(approveVivaryCodeMessage({ ...input, workspace }), { errorCode: "vivary_code_approval_stale" });
    const next = { ...native, requestId: "33333333-3333-4333-8333-333333333333" };
    pending.set(next.requestId, { request: next, resolve: value => { resolved = value; } });
    await assert.rejects(denyVivaryCodeMessage(input), { errorCode: "vivary_code_approval_stale" });
    active.controller.abort();
    Object.assign(active, { stopReason: "user" });
    await assert.rejects(denyVivaryCodeMessage({ ...input, requestId: next.requestId }), { errorCode: "vivary_code_approval_stale" });
  } finally {
    host.activeRuns.delete(runId);
    if (oldStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = oldStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (oldMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = oldMode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    await rm(directory, { recursive: true, force: true });
  }
});
