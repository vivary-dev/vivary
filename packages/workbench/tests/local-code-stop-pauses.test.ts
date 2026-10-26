import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";

import { withCodeHost } from "./fixtures/code-shutdown.ts";

const QUIT_NOTICE = "The Vivary code host shut down while this run waited on a Codex request.";

// Beta ticket 27 (#306 review). Only a quit with an unanswered Codex request ends a run Interrupted. A user Stop with a
// request waiting, and a quit with no request waiting, still pause the run, as J05 says.
test("a user Stop and a quit with no request waiting both leave the run paused", () => withCodeHost({ request: true }, async ({ host, ownerEmail, workspace, send, listed, waitForRequest }) => {
  const stopped = await send("Run the tests");
  await waitForRequest(stopped);
  await host.stopVivaryCodeRun({ ownerEmail, runId: stopped, projectId: workspace.projectId });
  // The worker writes paused first. The host has settled the run once it forgets the request, which a Stop cancels.
  for (let attempt = 0; attempt < 150 && listed(stopped) !== undefined; attempt++) await delay(100);
  assert.equal(listed(stopped), undefined, "Stop cancels its request instead of expiring it");
  assert.equal(getCodeAgentRunRecord(stopped)?.status, "paused");
  assert.equal(getCodeAgentRunRecord(stopped)?.phase, "paused", "a user Stop is not a restart");

  // The fake worker asks nothing for this prompt, so no request is waiting when the app quits.
  const quit = await send("Run the tests again [no request]");
  for (let attempt = 0; attempt < 50 && getCodeAgentRunRecord(quit)?.status === "queued"; attempt++) await delay(20);
  await delay(100);
  assert.equal(listed(quit)?.length ?? 0, 0);

  await host.shutdownVivaryCodeAgent();

  assert.equal(getCodeAgentRunRecord(quit)?.status, "paused");
  assert.equal(getCodeAgentRunRecord(quit)?.phase, "paused", "a quit with nothing waiting is not a restart");
  assert.equal(listCodeAgentTranscriptEvents(quit).filter(event => event.message === QUIT_NOTICE).length, 0);
}));
