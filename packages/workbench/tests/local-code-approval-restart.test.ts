import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
} from "@agent-native/core/code-agents";

test("a legacy pending launch is interrupted without replay when a fresh host initializes", async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-restart-test-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  const previousWorkspace = process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store;
  process.env.VIVARY_LOCAL_AGENT_WORKSPACE = store; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
  const requestId = "11111111-1111-4111-8111-111111111111";
  const workspace = {
    root: path.join(store, "missing-project"),
    label: "Restart project",
    projectId: "project_restart",
    bindingId: "binding_restart",
    rootId: "root_restart",
    bindingRevision: 7,
  };
  try {
    const run = createCodeAgentRunRecord({
      id: "pending-restart-run",
      goalId: "vivary-local-code",
      title: "Pending through restart",
      status: "needs-approval",
      phase: "launch-approval",
      needsApproval: true,
      permissionMode: "auto-edit",
      cwd: workspace.root,
      metadata: {
        app: "vivary-workbench-local-code",
        engine: "claude-cli",
        model: "sonnet",
        ownerEmail: "owner@example.com",
        workspaceRoot: workspace.root,
        projectId: workspace.projectId,
        bindingId: workspace.bindingId,
        rootId: workspace.rootId,
        bindingRevision: workspace.bindingRevision,
        pendingLaunch: {
          requestId,
          message: "Start only after I approve.",
          engine: "claude-cli",
          model: "sonnet",
          ownerEmail: "owner@example.com",
          isFollowUp: false,
          workspace,
          timeoutMs: 120_000,
          continuesAfterBrowserClose: true,
        },
      },
    });

    const native = createCodeAgentRunRecord({ id: "native-request-restart-run", goalId: "vivary-local-code",
      title: "Native request interrupted by restart", cwd: workspace.root,
      status: "needs-approval", phase: "action-approval", needsApproval: true,
      metadata: { ...run.metadata, engine: "codex-cli", pendingLaunch: undefined } });

    const {
      getVivaryCodeHostState,
      initializeVivaryCodeAgent,
    } = await import("../server/local-code-agent.ts");
    await initializeVivaryCodeAgent();
    const retained = getCodeAgentRunRecord(run.id);
    assert.equal(retained?.status, "paused");
    assert.equal(retained?.phase, "interrupted");
    assert.equal(retained?.needsApproval, false);
    assert.equal(retained?.metadata?.pendingLaunch, undefined);
    const host = await getVivaryCodeHostState("owner@example.com");
    assert.equal(host.activeRun, null);
    assert.equal(host.busy, false);
    assert.equal(host.pendingApproval, null);
    assert.equal(getCodeAgentRunRecord(native.id)?.status, "paused");
    assert.equal(getCodeAgentRunRecord(native.id)?.phase, "interrupted");
    assert.equal(getCodeAgentRunRecord(native.id)?.needsApproval, false);
  } finally {
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    if (previousWorkspace === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = previousWorkspace; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    await rm(store, { recursive: true, force: true });
  }
});
