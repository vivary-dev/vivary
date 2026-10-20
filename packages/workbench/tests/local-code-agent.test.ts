import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
  appendCodeAgentTranscriptEvent,
  codeAgentRunsDir,
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
  listCodeAgentTranscriptEvents,
  listCodeAgentRunRecords,
  updateCodeAgentRunRecord,
  type CodeAgentTranscriptEvent,
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
  getVivaryCodeSessionDetails,
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
  switchVivaryCodeRuntime,
} from "../server/local-code-agent.ts";

import { claimProjectReconnection } from "../server/project-reconnection-admission.mjs";
import { codingRuntimeEnvironment, getVivaryRuntimeStatus } from "../server/local-runtime-setup.ts";
import { createProjectMemory, renderFactFile, renderUnavailableContext } from "../server/project-memory.ts";
import { setTimeout as delay } from "node:timers/promises";
import { changeChatDraft, createCodeDraftIdentity, reconcileCodeDraft } from "../server/chat-draft.ts";
import { runWithRequestContext } from "@agent-native/core/server";
import { getCodePermissionMode, setCodePermissionMode } from "../server/code-permissions.ts";

// Load Native's transcript builder the way codex-transcript.test.mjs does: its
// module imports client-only code, so only the pure functions are compiled.
async function coreTranscriptBuilder(): Promise<(events: CodeAgentTranscriptEvent[]) => { messages: { message: unknown }[] }> {
  const core = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@agent-native", "core");
  const { normalizeCodeAgentTranscript, isCredentialGapCodeAgentEvent } = await import(
    pathToFileURL(path.join(core, "dist/code-agents/transcript-normalizer.js")).href);
  const file = path.join(core, "dist/agent/thread-data-builder.js");
  const source = (await readFile(file, "utf8")).replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
  return compileFunction(`${source}\nreturn buildRepositoryFromCodeAgentTranscript;`,
    ["normalizeCodeAgentTranscript", "isCredentialGapCodeAgentEvent"], { filename: file })(
    normalizeCodeAgentTranscript, isCredentialGapCodeAgentEvent);
}

const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-code-test-state-"));
const previousPath = codingRuntimeEnvironment(process.env).PATH;
const isolatedBin = path.join(stateRoot, "bin");
await mkdir(isolatedBin);
for (const command of ["claude", "codex"]) await writeFile(path.join(isolatedBin, command), "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
process.env.PATH = isolatedBin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Prevent tests from reaching installed account runtimes.
const previousDatabase = process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
process.env.DATABASE_URL = "file:" + path.join(stateRoot, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
after(async () => {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Restore disposable search path.

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
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
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
      assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
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
        activeRuns: [], recentRun: null, busy: false, cleanup: null,
      });
      createCodeAgentRunRecord({
        id: runId, goalId: "vivary-local-code", title: "Disconnected project", status: "running",
        cwd: path.join(store, "missing-project"),
        metadata: { app: "vivary-workbench-local-code", ownerEmail: "owner@example.com", projectId: "project_alpha" },
      });
      const missingProject = path.join(store, "missing-project");
      host.activeRuns.set(runId, { controller, ownerEmail: "owner@example.com", execution: null, stopReason: null,
        workspace: { root: missingProject, label: "Disconnected project" }, canonicalRoot: missingProject, requests: new Map() });
      const shown = await codeStateAction.run({ scope: "host" }, { caller: "frontend", userEmail: "owner@example.com" });
      assert.deepEqual(shown.activeRuns.map(({ id, title, projectId, status, workspaceLabel, stopping, pendingApprovals }) =>
        ({ id, title, projectId, status, workspaceLabel, stopping, pendingApprovals })), [{ id: runId,
        title: "Disconnected project", projectId: "project_alpha", status: "running", workspaceLabel: "Disconnected project",
        stopping: false, pendingApprovals: [] }]);
      assert.deepEqual({ recentRun: shown.recentRun, busy: shown.busy, cleanup: shown.cleanup },
        { recentRun: null, busy: true, cleanup: null });
      // Busy and the run list are the caller's own. Another user's run never locks this user's conversations.
      assert.deepEqual(await getVivaryCodeHostState("other@example.com"), {
        activeRuns: [], recentRun: null, busy: false, cleanup: null,
      });
    } finally {
      host.activeRuns.delete(runId);
      // guard:allow-env-credential - Restore the previous nonsecret Native store path exactly.
      if (originalStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      // guard:allow-env-credential - Restore the previous nonsecret Native store path exactly.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = originalStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("Send starts immediately, refuses a second turn in the same conversation, snapshots settings, and Stop remains available", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-send-"));
    temporaryRoots.push(fixture);
    const server = path.join(fixture, ".output", "server");
    const bin = path.join(fixture, "bin");
    await mkdir(server, { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
    await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import {writeFileSync} from "node:fs";
process.on("message", message => {
 if(message.type === "vivary:code-worker:start") writeFileSync("started.json", JSON.stringify(message));
});
process.send({type:"vivary:code-worker:ready"});
`);
    const previousCwd = process.cwd();
    const previousMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const previousPath = process.env.PATH; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    let runId: string | undefined;
    const workspace = { root: fixture, label: "Immediate project", projectId: "immediate",
      bindingId: "immediate-binding", rootId: "immediate-root", bindingRevision: 1 };
    try {
      process.chdir(fixture);
      process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
      await setCodePermissionMode("immediate@example.com", "read-only", "immediate-org");
      const state = await sendVivaryCodeMessage({ ownerEmail: "immediate@example.com", orgId: "immediate-org",
        message: "Inspect this fixture", engine: "claude-cli", model: "sonnet", workspace,
        draftSubmitId: "29cf865b-641d-4415-a42d-df12113e6e0c",
        draftThreadId: "vivary-code:project:immediate:draft-1",
        revalidateWorkspace: async () => workspace });
      runId = state.run!.id;
      assert.equal(state.run?.draftThreadId, "vivary-code:project:immediate:draft-1");
      assert.equal(state.runs.find(item => item.id === runId)?.draftThreadId,
        "vivary-code:project:immediate:draft-1");
      assert.equal((await getVivaryCodeState("immediate@example.com", runId, workspace, "immediate-org"))
        .run?.draftThreadId, "vivary-code:project:immediate:draft-1");
      assert.deepEqual(state.activeRuns.map(run => [run.id, run.pendingApprovals.length]), [[runId, 0]]);
      assert.equal(state.busy, true);
      assert.deepEqual(state.folderRuns.map(({ id, title }) => ({ id, title })), [{ id: runId, title: "Inspect this fixture" }]);
      assert.match(state.folderRuns[0].turnId, /^[0-9a-f-]{36}$/, "a random turn identity, not the run ID");
      assert.equal(getCodeAgentRunRecord(runId)?.metadata?.pendingLaunch, undefined);
      assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").length, 1);
      assert.equal(hasOwnedVivaryCodeSubmit("immediate@example.com", "immediate-org", workspace,
        "vivary-code:project:immediate:draft-1", "29cf865b-641d-4415-a42d-df12113e6e0c"), true);
      assert.equal(hasOwnedVivaryCodeSubmit("different@example.com", "immediate-org", workspace,
        "vivary-code:project:immediate:draft-1", "29cf865b-641d-4415-a42d-df12113e6e0c"), false);
      assert.equal(hasOwnedVivaryCodeSubmit("immediate@example.com", "immediate-org", workspace,
        "vivary-code:project:immediate:other", "29cf865b-641d-4415-a42d-df12113e6e0c"), false);
      const draftIdentity = createCodeDraftIdentity("immediate@example.com", "immediate-org", "immediate");
      await runWithRequestContext({ userEmail: "immediate@example.com", orgId: "immediate-org" }, async () => {
        const pendingDraft = await changeChatDraft(draftIdentity, "vivary-code:project:immediate:draft-1", null,
          { status: "pending", text: "Inspect this fixture",
            submitId: "29cf865b-641d-4415-a42d-df12113e6e0c" });
        assert.equal(pendingDraft.changed, true);
        const settledDraft = await reconcileCodeDraft(draftIdentity, "vivary-code:project:immediate:draft-1",
          "immediate@example.com", "immediate-org", workspace);
        assert.equal(settledDraft.saved, true);
        assert.equal(settledDraft.record?.status, "cleared");
      });
      await setCodePermissionMode("immediate@example.com", "yolo", "immediate-org");
      let invocation;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { invocation = JSON.parse(await readFile(path.join(fixture, "started.json"), "utf8")); break; }
        catch { await delay(20); }
      }
      assert.equal(invocation?.permissionMode, "read-only");
      assert.equal(await getCodePermissionMode("immediate@example.com", "immediate-org"), "yolo");
      assert.equal(await getCodePermissionMode("different@example.com", "immediate-org"), "normal");
      await assert.rejects(sendVivaryCodeMessage({ ownerEmail: "immediate@example.com", orgId: "immediate-org", runId,
        message: "Second", workspace }), { errorCode: "vivary_code_conversation_active", statusCode: 409 });
      // Another owner in the same folder sees the warning, and no title of this owner's conversation.
      await assert.rejects(sendVivaryCodeMessage({ ownerEmail: "immediate@example.com", message: "Elsewhere", workspace }),
        { errorCode: "vivary_code_shared_folder_active", statusCode: 409,
          message: /^Other agents are working in this folder\. .* Working in this folder: 1 conversation of another user\.$/ });
      await assert.rejects(stopVivaryCodeRun({ ownerEmail: "different@example.com", runId, projectId: workspace.projectId }),
        { statusCode: 404 });
      await stopVivaryCodeRun({ ownerEmail: "immediate@example.com", orgId: "immediate-org", runId, projectId: workspace.projectId });
      await Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")).activeRuns.get(runId)?.execution;
      assert.equal((await getVivaryCodeHostState("immediate@example.com", "immediate-org")).busy, false);
      assert.equal(getCodeAgentRunRecord(runId)?.status, "paused");
      runId = undefined;
    } finally {
      if (runId) {
        const execution = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")).activeRuns.get(runId)?.execution;
        await stopVivaryCodeRun({ ownerEmail: "immediate@example.com", orgId: "immediate-org", runId, projectId: workspace.projectId }).catch(() => undefined);
        await execution;
      }
      process.chdir(previousCwd);
      if (previousMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previousMode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("Stop and switch keeps one run, is owned by the host, and routes the next approval by run ID", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-switch-"));
    temporaryRoots.push(fixture);
    const server = path.join(fixture, ".output", "server");
    const bin = path.join(fixture, "bin");
    await mkdir(server, { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
    // The first turn works until it is stopped. The turn after the switch asks for one approval, then finishes.
    await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import {appendFileSync, writeFileSync} from "node:fs";
let runId;
process.on("message", message => {
 if(message.type === "vivary:code-worker:start") {
  runId = message.runId;
  appendFileSync("starts.jsonl", JSON.stringify({ runId, model: message.model, prompt: message.prompt }) + "\\n");
  if (message.prompt.includes("Needs approval")) process.send({type:"vivary:code-worker:request",runId,
    request:{requestId:"switch-request",method:"item/commandExecution/requestApproval",params:{command:"read fixture"}}});
 }
 if(message.type === "vivary:code-worker:response") {
  writeFileSync("response.json", JSON.stringify(message));
  process.send({type:"vivary:code-worker:resolved",runId,requestId:message.requestId});
  process.send({type:"vivary:code-worker:done",runId});
 }
});
process.send({type:"vivary:code-worker:ready"});
`);
    const previousCwd = process.cwd();
    const previousMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const previousPath = process.env.PATH; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const host = () => Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host"));
    const owner = { ownerEmail: "switch@example.com", orgId: "switch-org" };
    const workspace = { root: fixture, label: "Switch project", projectId: "switch",
      bindingId: "switch-binding", rootId: "switch-root", bindingRevision: 1 };
    let runId: string | undefined;
    try {
      process.chdir(fixture);
      process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
      const started = await sendVivaryCodeMessage({ ...owner, message: "Keep working", engine: "claude-cli",
        model: "claude-sonnet-5-5", workspace, revalidateWorkspace: async () => workspace });
      runId = started.run!.id;
      // Stop must reach a turn the worker received. A Stop before the worker is ready withholds the turn entirely.
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await readFile(path.join(fixture, "starts.jsonl"), "utf8").catch(() => "")) break;
        await delay(20);
      }
      const target = { ...owner, runId, engine: "claude-cli" as const, model: "claude-opus-5-5", workspace,
        revalidateWorkspace: async () => workspace };
      await assert.rejects(switchVivaryCodeRuntime(target), { errorCode: "vivary_code_switch_run_active", statusCode: 409 });

      // A stale ID for each runtime, as a conversation that already moved between them could hold.
      updateCodeAgentRunRecord(runId, { metadata: { claudeSessionId: "00000000-0000-4000-8000-000000000012",
        codexSessionId: "stale-thread", providerSessionMode: "native-resume" } });
      // Stop and switch is one request. The host records the target, stops the run, and applies it when the run leaves,
      // so no open window has to finish the switch.
      const stopping = await switchVivaryCodeRuntime({ ...target, stop: true });
      assert.deepEqual(stopping.run?.pendingSwitch, { engine: "claude-cli", model: "claude-opus-5-5" });
      assert.equal(stopping.run?.model, "claude-sonnet-5-5", "the route changes only after the run stops");
      await assert.rejects(switchVivaryCodeRuntime(target), { errorCode: "vivary_code_switch_run_stopping", statusCode: 409 });
      await host().activeRuns.get(runId)?.execution;
      assert.equal(getCodeAgentRunRecord(runId)?.status, "paused");
      const switched = await getVivaryCodeState(owner.ownerEmail, runId, workspace, owner.orgId);
      assert.equal(switched.run?.id, runId);
      assert.equal(switched.run?.model, "claude-opus-5-5");
      assert.equal(switched.run?.pendingSwitch, null);
      const stored = JSON.parse(await readFile(path.join(codeAgentRunsDir(), `${runId}.json`), "utf8")).metadata;
      assert.equal("claudeSessionId" in stored || "codexSessionId" in stored || "providerSessionMode" in stored, false);
      assert.equal(stored.previousProviderSessions.length, 1);
      const details = await getVivaryCodeSessionDetails(owner.ownerEmail, runId, workspace, owner.orgId);
      assert.deepEqual([details.sessionId, details.continuity, details.nextTurn], [null, "not-recorded", "reconstructed-context"]);
      assert.match(details.log.excerpt, /note: Switched from Claude Code Sonnet 5\.5 to Claude Code Opus 5\.5\./);
      const transcript = listCodeAgentTranscriptEvents(runId);
      assert.deepEqual(transcript.filter(event => event.kind === "user").map(event => event.message), ["Keep working"]);
      assert.equal(transcript.at(-1)?.metadata?.source, "vivary-runtime-switch");

      // A send that names the earlier model, without a switch, still refuses before any write.
      for (const change of [{ model: "claude-sonnet-5-5" }, { engine: "codex-cli" as const, model: "gpt-fixture" }]) {
        await assert.rejects(sendVivaryCodeMessage({ ...owner, runId, message: "Wrong route", engine: "claude-cli",
          model: "claude-opus-5-5", workspace, ...change }), { statusCode: 409 });
      }
      assert.equal(listCodeAgentTranscriptEvents(runId).length, transcript.length);

      await sendVivaryCodeMessage({ ...owner, runId, message: "Needs approval", engine: "claude-cli", model: "claude-opus-5-5",
        workspace, revalidateWorkspace: async () => workspace });
      let pending;
      for (let attempt = 0; attempt < 200 && !pending; attempt++) {
        pending = (await getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).activeRuns
          .find(run => run.id === runId)?.pendingApprovals[0];
        if (!pending) await delay(20);
      }
      assert.equal(pending?.runId, runId, "the approval belongs to the switched conversation");
      assert.equal(pending?.requestId, "switch-request");
      await approveVivaryCodeMessage({ ...owner, runId, requestId: "switch-request", workspace,
        revalidateWorkspace: async () => workspace });
      await host().activeRuns.get(runId)?.execution;
      const response = JSON.parse(await readFile(path.join(fixture, "response.json"), "utf8"));
      assert.equal(response.requestId, "switch-request");
      const starts = (await readFile(path.join(fixture, "starts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(starts.map(start => [start.runId, start.model]), [[runId, "claude-sonnet-5-5"], [runId, "claude-opus-5-5"]]);
      assert.equal(starts[0].prompt, "Keep working");
      assert.match(starts[1].prompt, /^# Previous conversation\nThese are quoted earlier messages from this Vivary conversation\./);
      assert.match(starts[1].prompt, /\nUser: Keep working\n\n# Current request\nNeeds approval$/);
      assert.equal(listCodeAgentRunRecords("vivary-local-code").filter(run => run.metadata?.ownerEmail === owner.ownerEmail).length, 1);
      await host().activeRuns.get(runId)?.execution;
      runId = undefined;

      // A host that ended while a run was stopping toward a switch applies it when the next host starts.
      const interrupted = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Interrupted switch", status: "running",
        phase: "stopping", needsApproval: false, permissionMode: "auto-edit", cwd: fixture,
        metadata: { app: "vivary-workbench-local-code", engine: "claude-cli", model: "claude-sonnet-5-5", ...owner,
          workspaceRoot: fixture, projectId: workspace.projectId, bindingId: workspace.bindingId, rootId: workspace.rootId,
          bindingRevision: workspace.bindingRevision,
          pendingSwitch: { engine: "claude-cli", model: "claude-opus-5-5", label: "Opus 5.5", requestedAt: "2026-10-19T00:00:00.000Z" } } });
      Reflect.set(host(), "initialization", undefined);
      await getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
      const restarted = getCodeAgentRunRecord(interrupted.id);
      assert.deepEqual([restarted?.status, restarted?.phase, restarted?.metadata?.model, restarted?.metadata?.pendingSwitch],
        ["paused", "interrupted", "claude-opus-5-5", undefined]);
      assert.equal(listCodeAgentTranscriptEvents(interrupted.id).at(-1)?.metadata?.source, "vivary-runtime-switch");
    } finally {
      if (runId) {
        const execution = host().activeRuns.get(runId)?.execution;
        await stopVivaryCodeRun({ ...owner, runId, projectId: workspace.projectId }).catch(() => undefined);
        await execution;
      }
      process.chdir(previousCwd);
      if (previousMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previousMode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("sends each project turn's context block to the engine and keeps the transcript raw", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-context-"));
    temporaryRoots.push(fixture);
    const server = path.join(fixture, ".output", "server");
    const bin = path.join(fixture, "bin");
    const root = path.join(fixture, "project");
    await mkdir(server, { recursive: true });
    await mkdir(bin);
    await mkdir(path.join(root, ".vivary", "knowledge"), { recursive: true });
    await writeFile(path.join(root, ".vivary", "workspace.toml"), "version = 1\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Agents\n");
    await writeFile(path.join(root, "STATE.md"), "# State\n");
    const factFile = path.join(root, ".vivary", "knowledge", "relay-budget.md");
    const fact = (amount: number) => renderFactFile({ title: "Relay budget", source: "Jeff, planning call",
      text: `The relay budget is ${amount} dollars per month.`, confirmed: "2026-09-25" });
    await writeFile(factFile, fact(40));
    await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
    await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import {writeFileSync} from "node:fs";
process.on("message", message => {
 if(message.type === "vivary:code-worker:start") writeFileSync("started.json", JSON.stringify(message));
});
process.send({type:"vivary:code-worker:ready"});
`);
    const memory = createProjectMemory({
      readWorkspaceContext: async () => ({ status: "thin", roles: { law: ["AGENTS.md"], map: [], record: [],
        memory: [], boundary: [".gitignore"] }, state: "STATE.md", memory: [".vivary/knowledge"],
        memoryAssigned: false, protected: [],
        privacy: { policy: "none", private: [], privateFiles: [], ignoreFiles: [".gitignore"], privateCandidates: [],
          checkedFiles: [".vivary/knowledge/relay-budget.md"] } }),
    });
    const workspace = { root, label: "Relay", projectId: "relay", bindingId: "relay-binding", rootId: "relay-root",
      bindingRevision: 1, policyRevision: 1, actorId: "actor", locationRef: "loc",
      verificationKind: "local-stat-revalidated-v1" as const };
    const ownerEmail = "context@example.com";
    const orgId = "context-org";
    const previous = { cwd: process.cwd(), mode: process.env.VIVARY_ACCESS_MODE, // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      path: process.env.PATH, store: process.env.AGENT_NATIVE_CODE_AGENTS_HOME }; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const host = () => Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")).activeRuns;
    // Send, read what the fake worker received, then stop so the next turn can start.
    const recorded: string[] = [];
    const turn = async (message: string, runId?: string) => {
      await rm(path.join(fixture, "started.json"), { force: true });
      const state = await sendVivaryCodeMessage({ ownerEmail, orgId, message, engine: "claude-cli", model: "sonnet",
        runId, workspace, projectContext: await memory.renderForRun(workspace, "code"),
        recordProjectContext: load => recorded.push(load.revision) });
      const id = state.run!.id;
      let started: { prompt: string } | undefined;
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        try { started = JSON.parse(await readFile(path.join(fixture, "started.json"), "utf8")); }
        catch { await delay(20); }
      }
      const execution = host().get(id)?.execution;
      await stopVivaryCodeRun({ ownerEmail, orgId, runId: id, projectId: workspace.projectId });
      await execution;
      return { id, prompt: started?.prompt ?? "" };
    };
    try {
      process.chdir(fixture);
      process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.PATH = bin + path.delimiter + (previous.path ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");

      // A refused send records no load, so the panel's last load stays true.
      await assert.rejects(sendVivaryCodeMessage({ ownerEmail, orgId, message: "Refused", engine: "claude-cli",
        model: "sonnet", workspace, revalidateWorkspace: async () => ({ ...workspace, bindingRevision: 2 }),
        projectContext: await memory.renderForRun(workspace, "code"), recordProjectContext: load => recorded.push(load.revision) }),
      { errorCode: "vivary_code_project_changed" });
      await assert.rejects(sendVivaryCodeMessage({ ownerEmail, orgId, message: "Refused", engine: "claude-cli",
        model: "sonnet", workspace, revalidateWorkspace: async () => ({ ...workspace, policyRevision: 2 }),
        projectContext: await memory.renderForRun(workspace, "code"), recordProjectContext: load => recorded.push(load.revision) }),
      { errorCode: "vivary_code_project_changed" });
      assert.deepEqual(recorded, []);

      const first = await turn("What is the relay budget?");
      assert.ok(first.prompt.startsWith("<project-context>\nProject: Relay\n"), first.prompt.slice(0, 80));
      assert.match(first.prompt, /The relay budget is 40 dollars per month\.[\s\S]*<\/project-context>\n\nWhat is the relay budget\?$/);
      const users = () => listCodeAgentTranscriptEvents(first.id).filter(event => event.kind === "user");
      assert.deepEqual(users().map(event => event.message), ["What is the relay budget?"]);
      const [firstRevision] = recorded;
      assert.match(firstRevision, /^ctx-[0-9a-f]{12}$/);
      assert.equal(getCodeAgentRunRecord(first.id)?.metadata?.projectContextRevision, firstRevision);

      await writeFile(factFile, fact(55));
      const second = await turn("Ask again.", first.id);
      const [block, quoted] = second.prompt.split("</project-context>\n\n");
      assert.match(block, /55 dollars/);
      assert.doesNotMatch(block, /40 dollars/);
      assert.match(quoted, /^# Previous conversation\n[\s\S]*User: What is the relay budget\?[\s\S]*# Current request\nAsk again\.$/);
      assert.doesNotMatch(quoted, /project-context|dollars/);
      assert.deepEqual(users().map(event => event.message), ["What is the relay budget?", "Ask again."]);
      const loads = listCodeAgentTranscriptEvents(first.id)
        .filter(event => event.metadata?.source === "vivary-project-context");
      assert.equal(loads.length, 2);
      assert.equal(loads[0].message, `Loaded project context ${firstRevision}: 1 fact from .vivary/knowledge, `
        + "instructions from AGENTS.md, state from STATE.md.");
      assert.match(loads[1].message, /The project context changed since the last turn\.$/);
      assert.deepEqual(loads.map(event => event.kind), ["note", "note"]);
      assert.equal(getCodeAgentRunRecord(first.id)?.metadata?.projectContextRevision, recorded[1]);
      assert.notEqual(recorded[1], firstRevision);
      assert.equal(recorded.length, 2);
      // Native's transcript builder, which the Code view uses, shows the note.
      const repository = (await coreTranscriptBuilder())(listCodeAgentTranscriptEvents(first.id));
      const shown = JSON.stringify(repository.messages.map((entry: { message: unknown }) => entry.message));
      assert.ok(shown.includes(`Loaded project context ${firstRevision}`), shown.slice(0, 400));
    } finally {
      process.chdir(previous.cwd);
      if (previous.mode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previous.mode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      if (previous.store === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
      else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous.store; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    }
  });

  it("refuses unavailable runtimes before new or resumed run and transcript writes", async () => {
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
        assert.equal((await getVivaryRuntimeStatus(engine, { refresh: true })).status, "unavailable");
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
          { errorCode: "vivary_code_runtime_unavailable", statusCode: 503 });
        }
        assert.equal(listCodeAgentRunRecords("vivary-local-code").length, count);
        assert.deepEqual(getCodeAgentRunRecord(runId), record);
        assert.deepEqual(listCodeAgentTranscriptEvents(runId), events);
        assert.equal(contextsRecorded, 0);
        assert.equal((await getVivaryCodeHostState(ownerEmail)).busy, false);
      }
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
