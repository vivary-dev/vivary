import assert from "node:assert/strict";
import { test } from "node:test";

import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";

import { withCodeHost } from "./fixtures/code-shutdown.ts";

// Beta ticket 05. Quitting the app shuts the host down while Codex waits for an answer. The answer channel ends with
// the host, so the request expires visibly instead of vanishing, even though the executor's teardown reports it
// resolved first. Shutdown closes the host for this process, so the test has a file of its own.
test("a Codex request pending at shutdown expires visibly", () => withCodeHost({ request: true }, async ({ host, ownerEmail, send, listed, waitForRequest }) => {
  const runId = await send("Run the tests");
  await waitForRequest(runId);
  assert.equal(listed(runId)?.length, 1);

  await host.shutdownVivaryCodeAgent();

  const [expired] = listed(runId) ?? [];
  assert.equal(expired?.requestId, "request-quit");
  assert.equal(expired?.reason, "host-restart");
  assert.equal(typeof expired?.expiredAt, "string");
  assert.equal(getCodeAgentRunRecord(runId)?.status, "paused");
  // Beta ticket 27. A quit with a request waiting is a restart from the owner's view, so the strip says Interrupted.
  assert.equal(getCodeAgentRunRecord(runId)?.phase, "interrupted");
  assert.equal(getCodeAgentRunRecord(runId)?.needsApproval, false);
  assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.metadata?.requestId === "request-quit"
    && event.message === "Codex request expired. Vivary restarted before this request was answered.").length, 1);
  const state = await host.getVivaryCodeHostState(ownerEmail);
  assert.equal(state.pendingApproval, null);
  assert.equal(state.recentRun?.phase, "interrupted");
  assert.deepEqual(state.recentRun?.expiredApproval, { method: "item/commandExecution/requestApproval",
    summary: "pnpm test", reason: "Vivary restarted before this request was answered." });
}));
