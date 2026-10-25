import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents, updateCodeAgentRunRecord } from "@agent-native/core/code-agents";

import { withCodeHost } from "./fixtures/code-shutdown.ts";

const QUIT_NOTICE = "The Vivary code host shut down while this run waited on a Codex request.";

// Beta ticket 27 (#306 review). Only a quit with an unanswered Codex request ends a run Interrupted. A user Stop, and
// a quit whose only request already expired in an earlier turn, still pause the run.
test("a user Stop and a quit after an expired request both leave the run paused", () => withCodeHost({ request: true }, async ({ host, ownerEmail, workspace, send, listed, waitForRequest }) => {
  const stopped = await send("Run the tests");
  await waitForRequest(stopped);
  await host.stopVivaryCodeRun({ ownerEmail, runId: stopped, projectId: workspace.projectId });
  // The worker writes paused first. The host has settled the run once it forgets the request, which a Stop cancels.
  for (let attempt = 0; attempt < 150 && listed(stopped) !== undefined; attempt++) await delay(100);
  assert.equal(listed(stopped), undefined, "Stop cancels its request instead of expiring it");
  assert.equal(getCodeAgentRunRecord(stopped)?.status, "paused");
  assert.equal(getCodeAgentRunRecord(stopped)?.phase, "paused", "a user Stop is not a restart");

  const quit = await send("Run the tests again");
  await waitForRequest(quit);
  // The request expired in an earlier turn, so nothing waits when the app quits.
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  updateCodeAgentRunRecord(quit, record => ({ metadata: { pendingApprovals: (record.metadata?.pendingApprovals as Record<string, unknown>[])
    .map(approval => ({ ...approval, expiredAt, reason: "host-restart" })) } }));

  await host.shutdownVivaryCodeAgent();

  assert.equal(getCodeAgentRunRecord(quit)?.status, "paused");
  assert.equal(getCodeAgentRunRecord(quit)?.phase, "paused", "an already expired request does not make the quit a restart");
  assert.equal(listCodeAgentTranscriptEvents(quit).filter(event => event.message === QUIT_NOTICE).length, 0);
}));
