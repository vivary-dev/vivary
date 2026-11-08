import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
  listCodeAgentTranscriptEvents,
} from "@agent-native/core/code-agents";

// Beta ticket 05. A Codex request that was waiting when the previous host ended is recorded on its run. A fresh host
// marks it Expired with the reason, says so in the conversation, and shows it in the host strip. It cannot be answered.
// The host initializes once per process, so this file seeds one run and starts one host.
test("a pending Codex request expires visibly when a fresh host initializes", async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), "vivary-code-expiry-test-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  const previousWorkspace = process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = store;
  process.env.VIVARY_LOCAL_AGENT_WORKSPACE = store; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
  const requestId = "22222222-2222-4222-8222-222222222222";
  const requestedAt = "2026-10-24T09:00:00.000Z";
  try {
    const run = createCodeAgentRunRecord({ id: "codex-request-restart-run", goalId: "vivary-local-code",
      title: "Run the tests", cwd: path.join(store, "project"),
      status: "needs-approval", phase: "action-approval", needsApproval: true,
      metadata: { app: "vivary-workbench-local-code", engine: "codex-cli", model: "default",
        ownerEmail: "owner@example.com", projectId: "project_expiry",
        pendingApprovals: [{ requestId, method: "item/commandExecution/requestApproval",
          summary: "pnpm test", requestedAt }] } });

    const {
      denyVivaryCodeMessage,
      getVivaryCodeHostState,
      initializeVivaryCodeAgent,
    } = await import("../server/local-code-agent.ts");
    await initializeVivaryCodeAgent();

    const retained = getCodeAgentRunRecord(run.id);
    assert.equal(retained?.status, "paused");
    assert.equal(retained?.phase, "interrupted");
    assert.equal(retained?.needsApproval, false);
    const [expired] = retained?.metadata?.pendingApprovals as Record<string, unknown>[];
    assert.equal(expired.requestId, requestId);
    assert.equal(expired.requestedAt, requestedAt);
    assert.equal(expired.reason, "host-restart");
    assert.equal(typeof expired.expiredAt, "string");

    const notices = listCodeAgentTranscriptEvents(run.id).filter(event => event.metadata?.requestId === requestId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].message, "Codex request expired. Vivary restarted before this request was answered.");
    assert.equal(notices[0].metadata?.reason, "host-restart");

    const host = await getVivaryCodeHostState("owner@example.com");
    assert.equal(host.pendingApproval, null, "an expired request is never offered for an answer");
    assert.equal(host.recentRun?.id, run.id);
    assert.equal(host.recentRun?.phase, "interrupted");
    assert.deepEqual(host.recentRun?.expiredApproval, { method: "item/commandExecution/requestApproval",
      summary: "pnpm test", reason: "Vivary restarted before this request was answered." });

    await assert.rejects(denyVivaryCodeMessage({ ownerEmail: "owner@example.com", runId: run.id, requestId,
      projectId: "project_expiry" }), { errorCode: "vivary_code_approval_stale", statusCode: 409 });
  } finally {
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    if (previousWorkspace === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = previousWorkspace; // guard:allow-env-credential - Isolated test runtime configuration, not user credentials.
    await rm(store, { recursive: true, force: true });
  }
});
