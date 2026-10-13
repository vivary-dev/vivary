import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
  appendCodeAgentTranscriptEvent,
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
  listCodeAgentTranscriptEvents,
  listCodeAgentRunRecords,
} from "@agent-native/core/code-agents";
import codeStateAction from "../actions/vivary-code-state.ts";
import codeApproveAction from "../actions/vivary-code-approve.ts";
import codeDenyAction from "../actions/vivary-code-deny.ts";
import codeCleanupAction from "../actions/vivary-code-cleanup.ts";

import {
  approveVivaryCodeMessage,
  buildVivaryCodeExecutionPrompt,
  buildVivaryCodeFollowUpPrompt,
  denyVivaryCodeMessage,
  getVivaryCodeFiles,
  getVivaryCodeHostState,
  getVivaryCodeState,
  hasOwnedVivaryCodeSubmit,
  linkedCodeDraftRuns,
  requireVivaryCodeUser,
  VIVARY_CODE_DEFAULT_MODEL,
  VIVARY_CODE_MODELS,
  resolveVivaryCodeModel,
  isVivaryAppRun,
  sendVivaryCodeMessage,
  stopVivaryCodeRun,
} from "../server/local-code-agent.ts";

import { claimProjectReconnection } from "../server/project-reconnection-admission.mjs";
import { renderUnavailableContext } from "../server/project-memory.ts";

const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-code-test-state-"));
const previousDatabase = process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
process.env.DATABASE_URL = "file:" + path.join(stateRoot, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
after(async () => {
  if (previousDatabase === undefined) delete process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  else process.env.DATABASE_URL = previousDatabase; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  await rm(stateRoot, { recursive: true, force: true });
});
const temporaryRoots: string[] = [];

afterEach(async () => {
  // guard:allow-env-credential - Isolated test workspace path.
  delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local Vivary code agent boundaries", () => {
  it("links a saved follow-up to an older run without expanding the 20-run state page", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-old-draft-"));
    temporaryRoots.push(store);
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    try {
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store;
      for (let index = 0; index < 21; index++) {
        createCodeAgentRunRecord({ id: `older-draft-run-${index}`, goalId: "vivary-local-code",
          title: `Conversation ${index}`, status: "completed", cwd: store,
          metadata: { app: "vivary-workbench-local-code", ownerEmail: "older@example.test",
            orgId: "older-org", engine: "claude-cli", model: "sonnet", workspaceRoot: store,
            draftThreadId: `vivary-code:older-draft-${index}` } });
      }
      const state = await getVivaryCodeState("older@example.test", undefined,
        { root: store, label: "Fixture" }, "older-org");
      assert.equal(state.runs.length, 20);
      const linked = linkedCodeDraftRuns("older@example.test", "older-org",
        { root: store, label: "Fixture" }, ["vivary-code:older-draft-0"]);
      assert.equal(linked.get("vivary-code:older-draft-0")?.id, "older-draft-run-0");
      assert.equal(linked.size, 1);
    } finally {
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    }
  });

  it("offers precise current Claude IDs and keeps the new default distinct from history", () => {
    assert.deepEqual(VIVARY_CODE_MODELS, ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
    assert.equal(VIVARY_CODE_DEFAULT_MODEL, "claude-sonnet-5-5");
  });

  it("refuses Code admission while a project reconnection owns the root transition", async () => {
    const release = claimProjectReconnection();
    assert.ok(release);
    try {
      await assert.rejects(sendVivaryCodeMessage({
        ownerEmail: "owner@example.com", message: "Inspect files",
        workspace: { root: stateRoot, label: "Fixture" },
      }), { errorCode: "vivary_code_project_reconnecting", statusCode: 409 });
    } finally {
      release();
    }
  });

  it("keeps each runtime's model selection in its own model family", () => {
    assert.equal(resolveVivaryCodeModel("claude-cli"), "claude-sonnet-5-5");
    assert.equal(resolveVivaryCodeModel("codex-cli"), "default");
    assert.equal(resolveVivaryCodeModel("codex-cli", "gpt-example", ["gpt-example"]), "gpt-example");
    assert.throws(() => resolveVivaryCodeModel("codex-cli", "unreported", ["gpt-example"]), { errorCode: "vivary_code_model_unsupported" });
    assert.equal(resolveVivaryCodeModel("claude-cli", "opus"), "opus");
    assert.throws(() => resolveVivaryCodeModel("claude-cli", "gpt-example", ["gpt-example"]), { errorCode: "vivary_code_model_unsupported" });
    assert.equal(resolveVivaryCodeModel("claude-cli", "claude-sonnet-4-20250514", [], "claude-sonnet-4-20250514"), "claude-sonnet-4-20250514");
    assert.throws(() => resolveVivaryCodeModel("claude-cli", "default"), { errorCode: "vivary_code_model_unsupported" });
    assert.throws(() => resolveVivaryCodeModel("codex-cli", "opus"), { errorCode: "vivary_code_model_unsupported" });
  });

  it("requires an authenticated owner and reads only bounded workspace files", async () => {
    assert.throws(
      () => requireVivaryCodeUser(),
      /could not confirm access to this local workspace/,
    );
    assert.equal(
      requireVivaryCodeUser({ caller: "frontend", userEmail: "OWNER@Example.com" }),
      "owner@example.com",
    );

    const workspace = await mkdtemp(path.join(os.tmpdir(), "vivary-code-test-"));
    temporaryRoots.push(workspace);
    // guard:allow-env-credential - Isolated test workspace path.
    process.env.VIVARY_LOCAL_AGENT_WORKSPACE = workspace; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    await writeFile(path.join(workspace, "result.md"), "# Visible result\n", "utf8");
    await writeFile(path.join(workspace, "blocked.js"), "export {};\n", "utf8");

    const listing = await getVivaryCodeFiles();
    assert.deepEqual(listing.files.map((file) => file.path), ["result.md"]);

    const result = await getVivaryCodeFiles("result.md");
    assert.deepEqual(result.file, {
      path: "result.md",
      name: "result.md",
      sizeBytes: 17,
      updatedAt: result.file?.updatedAt,
      content: "# Visible result\n",
    });

    await assert.rejects(getVivaryCodeFiles("../outside.md"), {
      errorCode: "vivary_code_file_path_blocked",
    });
    await assert.rejects(getVivaryCodeFiles("blocked.js"), {
      errorCode: "vivary_code_file_type_blocked",
    });
  });

  it("keeps project history bound to the registered root even when paths match", () => {
    const workspace = { root: "/workspace/alpha", label: "Alpha", projectId: "project_alpha",
      bindingId: "binding_alpha", rootId: "root_alpha" };
    const run = { goalId: "vivary-local-code", cwd: workspace.root, metadata: {
      app: "vivary-workbench-local-code", workspaceRoot: workspace.root,
      projectId: workspace.projectId, bindingId: workspace.bindingId, rootId: workspace.rootId,
    } };
    assert.equal(isVivaryAppRun(run, workspace), true);
    assert.equal(isVivaryAppRun(run, { ...workspace, projectId: "project_beta" }), false);
    assert.equal(isVivaryAppRun(run, { ...workspace, rootId: "root_replaced" }), false);
    assert.equal(isVivaryAppRun(run, { root: workspace.root, label: "Default workspace" }), false);
    assert.equal(isVivaryAppRun(run, { ...workspace, root: "/workspace/beta" }), false);
  });

  it("reads retained project history from stable binding identity without opening the folder", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-history-test-"));
    temporaryRoots.push(store);
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store; // guard:allow-env-credential - Isolated synthetic Native record store.
    const history = {
      label: "Unavailable project",
      projectId: "project_history",
      bindingId: "binding_history",
      rootId: "root_history",
      bindingRevision: 4,
    };
    const runId = "retained-history";
    try {
      createCodeAgentRunRecord({
        id: runId,
        goalId: "vivary-local-code",
        title: "Retained conversation",
        status: "completed",
        cwd: path.join(store, "missing-project"),
        metadata: {
          app: "vivary-workbench-local-code",
          ownerEmail: "owner@example.com",
          orgId: "org-history",
          workspaceRoot: path.join(store, "missing-project"),
          projectId: history.projectId,
          bindingId: history.bindingId,
          rootId: history.rootId,
          bindingRevision: history.bindingRevision,
          engine: "claude-cli",
          model: "sonnet",
        },
      });
      const state = await getVivaryCodeState("owner@example.com", runId, history, "org-history");
      assert.equal(state.projectId, history.projectId);
      assert.equal(state.workspaceLabel, history.label);
      assert.deepEqual(state.runs.map(run => run.id), [runId]);
      assert.equal(state.run?.id, runId);
      await assert.rejects(
        getVivaryCodeState("other@example.com", runId, history, "org-history"),
        { errorCode: "vivary_code_run_not_found" },
      );
      await assert.rejects(
        getVivaryCodeState("owner@example.com", runId, history, "other-org"),
        { errorCode: "vivary_code_run_not_found" },
      );
      const reconnected = await getVivaryCodeState("owner@example.com", runId, {
        ...history, rootId: "root_reconnected", bindingRevision: 5,
      }, "org-history");
      assert.equal(reconnected.run?.id, runId);
      const moved = await getVivaryCodeState("owner@example.com", runId, history, "org-history", store);
      assert.equal(moved.run?.id, runId);
      assert.deepEqual(moved.runs.map(run => run.id), [runId]);
      await assert.rejects(
        getVivaryCodeState("owner@example.com", runId, { ...history, bindingId: "binding_other" }, "org-history"),
        { errorCode: "vivary_code_run_not_found" },
      );
    } finally {
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Restore prior nonsecret record path.
    }
  });

  it("reopens a Native transcript after reconnection and revalidates follow-up custody", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-reconnected-store-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-code-reconnected-root-"));
    const bin = await mkdtemp(path.join(os.tmpdir(), "vivary-code-reconnected-bin-"));
    temporaryRoots.push(store, workspaceRoot, bin);
    const executable = path.join(bin, "claude");
    await writeFile(executable, `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true}');
`, { mode: 0o755 });
    const previous = {
      store: process.env.AGENT_NATIVE_CODE_AGENTS_HOME, // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      path: process.env.PATH, // guard:allow-env-credential - Isolated test runtime configuration.
      mode: process.env.VIVARY_ACCESS_MODE, // guard:allow-env-credential - Isolated test runtime configuration.
    };
    const ownerEmail = "owner@example.com";
    const orgId = "org-reconnected";
    const oldWorkspace = { root: workspaceRoot, label: "Alpha", projectId: "project_reconnected",
      bindingId: "binding_stable", rootId: "root_old", bindingRevision: 1 };
    const freshWorkspace = { ...oldWorkspace, rootId: "root_new", bindingRevision: 2 };
    const runId = "retained-reconnect-native-run";
    try {
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store; // guard:allow-env-credential - Isolated Native test record directory.
      process.env.PATH = bin + path.delimiter + (previous.path ?? ""); // guard:allow-env-credential - Isolated test runtime configuration.
      process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated test runtime configuration.
      createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code",
        title: "Retained Alpha conversation", status: "completed", cwd: workspaceRoot,
        metadata: { app: "vivary-workbench-local-code", ownerEmail, orgId,
          engine: "claude-cli", model: "sonnet", workspaceRoot,
          projectId: oldWorkspace.projectId, bindingId: oldWorkspace.bindingId,
          rootId: oldWorkspace.rootId, bindingRevision: oldWorkspace.bindingRevision },
      });
      appendCodeAgentTranscriptEvent({ runId, kind: "system", message: "BETA-READY retained marker",
        metadata: { role: "assistant" } });
      const reopened = await getVivaryCodeState(ownerEmail, runId, {
        label: "Alpha", projectId: freshWorkspace.projectId,
        bindingId: freshWorkspace.bindingId, rootId: freshWorkspace.rootId,
        bindingRevision: freshWorkspace.bindingRevision,
      }, orgId);
      assert.deepEqual(reopened.runs.map(run => run.id), [runId]);
      assert.equal(reopened.run?.events.some(event => event.message.includes("BETA-READY")), true);
      await assert.rejects(getVivaryCodeState(ownerEmail, runId,
        { ...freshWorkspace, projectId: "project_foreign" }, orgId),
      { errorCode: "vivary_code_run_not_found" });
      await assert.rejects(sendVivaryCodeMessage({
        ownerEmail, orgId, runId, message: "A moved path must not continue this run.",
        workspace: { ...freshWorkspace, root: path.join(store, "different-location") },
      }), { errorCode: "vivary_code_run_not_found" });
      await assert.rejects(sendVivaryCodeMessage({
        ownerEmail, orgId, runId, message: "Do not continue across a changed binding.",
        workspace: freshWorkspace, revalidateWorkspace: async () => oldWorkspace,
      }), { errorCode: "vivary_code_project_changed" });
      assert.equal(listCodeAgentTranscriptEvents(runId).some(event => event.kind === "user"), false);
      const legacyRunId = "legacy-draft-run";
      createCodeAgentRunRecord({ id: legacyRunId, goalId: "vivary-local-code",
        title: "Legacy draft conversation", status: "completed", cwd: workspaceRoot,
        metadata: { app: "vivary-workbench-local-code", ownerEmail, orgId,
          engine: "claude-cli", model: "sonnet", workspaceRoot,
          projectId: oldWorkspace.projectId, bindingId: oldWorkspace.bindingId,
          rootId: oldWorkspace.rootId, bindingRevision: oldWorkspace.bindingRevision },
      });
      appendCodeAgentTranscriptEvent({ runId: legacyRunId, kind: "user", message: "Earlier accepted user message",
        metadata: { draftThreadId: "vivary-code:project:project_reconnected:legacy-draft",
          draftSubmitId: "29cf865b-641d-4415-a42d-df12113e6e0c" } });
      const legacy = await getVivaryCodeState(ownerEmail, legacyRunId, {
        label: "Alpha", projectId: freshWorkspace.projectId,
        bindingId: freshWorkspace.bindingId, rootId: freshWorkspace.rootId,
        bindingRevision: freshWorkspace.bindingRevision,
      }, orgId);
      assert.equal(legacy.run?.draftThreadId, "vivary-code:project:project_reconnected:legacy-draft");
      assert.equal(legacy.runs.find(item => item.id === legacyRunId)?.draftThreadId, legacy.run?.draftThreadId);
      assert.equal(getCodeAgentRunRecord(runId)?.metadata?.rootId, oldWorkspace.rootId);
    } finally {
      if (previous.store === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous.store; // guard:allow-env-credential - Restore prior nonsecret Native directory.
      // guard:allow-env-credential - Restore the prior nonsecret runtime path from this test.
      if (previous.path === undefined) delete process.env.PATH; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      // guard:allow-env-credential - Restore the prior nonsecret runtime path from this test.
      else process.env.PATH = previous.path; // guard:allow-env-credential - Restore prior runtime path.
      // guard:allow-env-credential - Restore the prior nonsecret runtime mode from this test.
      if (previous.mode === undefined) delete process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      // guard:allow-env-credential - Restore the prior nonsecret runtime mode from this test.
      else process.env.VIVARY_ACCESS_MODE = previous.mode; // guard:allow-env-credential - Restore prior runtime mode.
    }
  });

  it("keeps host status separate from project and transcript requests", () => {
    assert.deepEqual(codeStateAction.schema.parse({ scope: "host" }), { scope: "host" });
    assert.deepEqual(codeStateAction.schema.parse({}), {});
    assert.deepEqual(codeStateAction.schema.parse({ projectId: "project_alpha", runId: "run_alpha" }),
      { projectId: "project_alpha", runId: "run_alpha" });
    assert.equal(codeStateAction.schema.safeParse({ scope: "host", projectId: "project_alpha" }).success, false);
    assert.equal(codeStateAction.schema.safeParse({ scope: "host", runId: "run_alpha" }).success, false);
    assert.equal(codeStateAction.schema.safeParse({ scope: "project" }).success, false);
  });

  it("binds approval controls to strict run, request, and project identifiers", () => {
    const input = {
      projectId: "project_alpha",
      runId: "run_alpha",
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    assert.deepEqual(codeApproveAction.schema.parse(input), input);
    assert.deepEqual(codeDenyAction.schema.parse(input), input);
    assert.equal(codeApproveAction.schema.safeParse({ ...input, requestId: "stale" }).success, false);
    assert.equal(codeDenyAction.schema.safeParse({ ...input, unexpected: true }).success, false);
    assert.equal(codeApproveAction.agentTool, false);
    assert.equal(codeDenyAction.agentTool, false);
  });

  // Issue #121. No agent or tool may lift the refusal that its own run's leftover processes caused.
  it("keeps the cleanup decision to a signed-in person with a strict decision on a named list", () => {
    const version = "0123456789abcdef";
    for (const decision of ["end", "continue"]) {
      assert.deepEqual(codeCleanupAction.schema.parse({ decision, version }), { decision, version });
    }
    for (const input of [{}, { decision: "end" }, { decision: "lift", version }, { decision: "end", version: "stale" },
      { decision: "continue", version, runId: "run_alpha" }]) {
      assert.equal(codeCleanupAction.schema.safeParse(input).success, false, JSON.stringify(input));
    }
    assert.equal(codeCleanupAction.agentTool, false);
    assert.equal(codeCleanupAction.mcpTool, false);
    assert.equal(codeCleanupAction.toolCallable, false);
    assert.equal(codeCleanupAction.requiresAuth, true);
  });

  it("retains owner-only Stop metadata when a project and Personal workspace are unavailable", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-host-test-"));
    temporaryRoots.push(store);
    // guard:allow-env-credential - Preserve the Native record-store directory around this isolated test.
    const originalStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    // guard:allow-env-credential - Isolated Native record-store directory, containing synthetic records only.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    // guard:allow-env-credential - Deliberately missing local workspace verifies that host state never resolves it.
    process.env.VIVARY_LOCAL_AGENT_WORKSPACE = path.join(store, "missing-personal"); // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    const host: unknown = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host"));
    assert.ok(host && typeof host === "object" && "activeRuns" in host && host.activeRuns instanceof Map);
    const controller = new AbortController();

    const runId = "host-state-test";
    try {
      assert.deepEqual(await getVivaryCodeHostState("owner@example.com"), {
        activeRun: null, pendingApproval: null, recentRun: null, busy: false, cleanup: null,
      });
      createCodeAgentRunRecord({
        id: runId, goalId: "vivary-local-code", title: "Disconnected project", status: "running",
        cwd: path.join(store, "missing-project"),
        metadata: { app: "vivary-workbench-local-code", ownerEmail: "owner@example.com", projectId: "project_alpha" },
      });
      host.activeRuns.set(runId, { controller, ownerEmail: "owner@example.com", execution: null, stopReason: null, requests: new Map() });
      assert.deepEqual(await codeStateAction.run({ scope: "host" }, { caller: "frontend", userEmail: "owner@example.com" }), {
        activeRun: { id: runId, title: "Disconnected project", projectId: "project_alpha" },
        pendingApproval: null, recentRun: null, busy: true, cleanup: null,
      });
      assert.deepEqual(await getVivaryCodeHostState("other@example.com"), {
        activeRun: null, pendingApproval: null, recentRun: null, busy: true, cleanup: null,
      });
    } finally {
      host.activeRuns.delete(runId);
      // guard:allow-env-credential - Restore the previous nonsecret Native store path exactly.
      if (originalStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      // guard:allow-env-credential - Restore the previous nonsecret Native store path exactly.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = originalStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("refuses new and resumed turns before any auth, model discovery, worker launch, or transcript write", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-funding-"));
    temporaryRoots.push(fixture);
    const bin = path.join(fixture, "bin");
    const server = path.join(fixture, ".output", "server");
    const probe = path.join(fixture, "runtime-started");
    const workerProbe = path.join(fixture, "worker-started");
    await mkdir(bin);
    await mkdir(server, { recursive: true });
    for (const command of ["claude", "codex"]) {
      await writeFile(path.join(bin, command), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(probe)}, "started");
process.exit(2);
`, { mode: 0o755 });
    }
    await writeFile(path.join(server, "vivary-code-worker.mjs"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(workerProbe)}, "started");`);
    // guard:allow-env-credential - Capture nonsecret executable path and local-mode test state for restoration after the disposable fixture.
    const previous = { cwd: process.cwd(), path: process.env.PATH, mode: process.env.VIVARY_ACCESS_MODE,
      store: process.env.AGENT_NATIVE_CODE_AGENTS_HOME };
    const workspace = { root: fixture, label: "Funding fixture", projectId: "funding-project",
      bindingId: "funding-binding", rootId: "funding-root", bindingRevision: 1, policyRevision: 1 };
    const ownerEmail = "funding@example.test";
    try {
      process.chdir(fixture);
      // guard:allow-env-credential - Select only disposable runtime fixtures and a temporary Native store.
      Object.assign(process.env, { PATH: bin + path.delimiter + (previous.path ?? ""),
        VIVARY_ACCESS_MODE: "local", AGENT_NATIVE_CODE_AGENTS_HOME: fixture });
      for (const engine of ["claude-cli", "codex-cli"] as const) {
        const runId = `funding-retained-${engine}`;
        const model = engine === "claude-cli" ? "claude-sonnet-4-20250514" : "retained-codex-model";
        createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code", title: "Retained conversation",
          status: "completed", cwd: fixture, metadata: { app: "vivary-workbench-local-code", ownerEmail,
            engine, model, workspaceRoot: fixture, projectId: workspace.projectId, bindingId: workspace.bindingId,
            rootId: workspace.rootId, bindingRevision: 1, providerSessionId: "retained-provider-session" } });
        appendCodeAgentTranscriptEvent({ runId, kind: "user", message: "Earlier message" });
        const record = getCodeAgentRunRecord(runId);
        const events = listCodeAgentTranscriptEvents(runId);
        const count = listCodeAgentRunRecords("vivary-local-code").length;
        let contextsRecorded = 0;
        for (const selectedRunId of [undefined, runId]) {
          await assert.rejects(sendVivaryCodeMessage({ ownerEmail, engine, runId: selectedRunId, model,
            message: "Refuse before any execution", workspace,
            revalidateWorkspace: async () => workspace, recordProjectContext: () => { contextsRecorded++; } }),
          { errorCode: "vivary_code_subscription_funding_unverified", statusCode: 409 });
        }
        assert.equal(listCodeAgentRunRecords("vivary-local-code").length, count);
        assert.deepEqual(getCodeAgentRunRecord(runId), record);
        assert.deepEqual(listCodeAgentTranscriptEvents(runId), events);
        assert.equal(contextsRecorded, 0);
        assert.equal((await getVivaryCodeHostState(ownerEmail)).busy, false);
      }
      await assert.rejects(readFile(probe), { code: "ENOENT" });
      await assert.rejects(readFile(workerProbe), { code: "ENOENT" });
      await assert.rejects(sendVivaryCodeMessage({ ownerEmail, message: "Changed binding", workspace,
        revalidateWorkspace: async () => ({ ...workspace, bindingRevision: 2 }) }),
      { errorCode: "vivary_code_project_changed" });
    } finally {
      process.chdir(previous.cwd);
      for (const [name, value] of [["PATH", previous.path], ["VIVARY_ACCESS_MODE", previous.mode],
        ["AGENT_NATIVE_CODE_AGENTS_HOME", previous.store]]) {
        // guard:allow-env-credential - Restore only the nonsecret test configuration changed above.
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("keeps a missing historical Claude model as legacy sonnet without rewriting metadata", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-legacy-model-"));
    temporaryRoots.push(store);
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    try {
      // guard:allow-env-credential - Isolated Native record path, restored below.
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store;
      createCodeAgentRunRecord({ id: "missing-model-history", goalId: "vivary-local-code", title: "Legacy",
        status: "completed", cwd: store, metadata: { app: "vivary-workbench-local-code",
          ownerEmail: "legacy@example.test", engine: "claude-cli", workspaceRoot: store } });
      const state = await getVivaryCodeState("legacy@example.test", "missing-model-history", { root: store, label: "Fixture" });
      assert.equal(state.run?.model, "sonnet");
      assert.equal(getCodeAgentRunRecord("missing-model-history")?.metadata?.model, undefined);
      assert.ok(state.engines.find(engine => engine.engine === "claude-cli")?.models.includes("sonnet"));
      assert.equal(state.defaultModel, "claude-sonnet-5-5");
      assert.equal(state.engines.every(engine => engine.funding.status === "unverified"), true);
    } finally {
      // guard:allow-env-credential - Restore only the temporary Native store setting.
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    }
  });

  it("gives every turn the full block, saved provider sessions without quoting, and a personal run no block", async () => {
    const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-context-codex-"));
    temporaryRoots.push(store);
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    try {
      const block = renderUnavailableContext("Relay", "Test block.", "code");
      // The previous turn saw the same revision. A resumed thread still gets the full block,
      // because Codex may have compacted the earlier one away.
      const codex = createCodeAgentRunRecord({ id: "codex-resumed", goalId: "vivary-local-code", title: "Codex",
        status: "completed", cwd: store, metadata: { app: "vivary-workbench-local-code", engine: "codex-cli",
          codexSessionId: "thread-1", projectContextRevision: "ctx-000000000001" } });
      appendCodeAgentTranscriptEvent({ runId: codex.id, kind: "user", message: "Earlier question" });
      assert.equal(buildVivaryCodeExecutionPrompt(codex, "codex-cli", "Next question", block),
        `${block}\n\nNext question`);
      const claude = createCodeAgentRunRecord({ id: "claude-follow-up", goalId: "vivary-local-code", title: "Claude",
        status: "completed", cwd: store, metadata: { app: "vivary-workbench-local-code", engine: "claude-cli",
          projectContextRevision: "ctx-000000000001" } });
      appendCodeAgentTranscriptEvent({ runId: claude.id, kind: "user", message: "Earlier question" });
      assert.match(buildVivaryCodeExecutionPrompt(claude, "claude-cli", "Next question", block),
        /^<project-context>[\s\S]*<\/project-context>\n\n# Previous conversation\n/);
      const resumedClaude = createCodeAgentRunRecord({ id: "claude-native-resume", goalId: "vivary-local-code", title: "Claude",
        status: "paused", cwd: store, metadata: { app: "vivary-workbench-local-code", engine: "claude-cli",
          claudeSessionId: "00000000-0000-4000-8000-000000000010" } });
      appendCodeAgentTranscriptEvent({ runId: resumedClaude.id, kind: "user", message: "Earlier question" });
      assert.equal(buildVivaryCodeExecutionPrompt(resumedClaude, "claude-cli", "Next question", block), `${block}\n\nNext question`);
      assert.match(buildVivaryCodeExecutionPrompt(resumedClaude, "codex-cli", "Next question", block), /# Previous conversation/);
      assert.equal(buildVivaryCodeExecutionPrompt(null, "claude-cli", "Personal question"), "Personal question");
    } finally {
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("adds bounded run context without repeated final assistant text", () => {
    const events = [
      {
        schemaVersion: 1,
        id: "event-user",
        runId: "run-1",
        kind: "user",
        message: "Create result.md",
        createdAt: "2026-09-12T00:00:00.000Z",
      },
      {
        schemaVersion: 1,
        id: "event-assistant-stream",
        runId: "run-1",
        kind: "system",
        message: "I created result.md.",
        createdAt: "2026-09-12T00:00:01.000Z",
        metadata: { role: "assistant", source: "claude-cli" },
      },
      {
        schemaVersion: 1,
        id: "event-assistant-final",
        runId: "run-1",
        kind: "system",
        message: "I created result.md.",
        createdAt: "2026-09-12T00:00:02.000Z",
        metadata: { role: "assistant", engine: "claude-cli" },
      },
    ] satisfies CodeAgentTranscriptEvent[];

    const prompt = buildVivaryCodeFollowUpPrompt(events, "Add a summary.");
    assert.match(prompt, /# Previous conversation/);
    assert.match(prompt, /# Current request\nAdd a summary\./);
    assert.equal(prompt.match(/Assistant: I created result\.md\./g)?.length, 1);
    assert.ok(prompt.length < 12_500);
  });
});
