import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { CodeAgentRunStatus } from "@agent-native/core/code-agents";

import { CODE_RUN_TRANSITIONS, codeRunTransitionAllowed, type CodeRunEdge } from "../server/code-run-transitions.ts";

// Beta ticket 06. The expected table is written out here on its own, so a change to the module's table fails until
// this list agrees with it.
const STATUSES: CodeAgentRunStatus[] = ["queued", "running", "paused", "needs-approval", "completed", "errored", "unknown"];
const EXPECTED: Record<CodeRunEdge, { to: string; from: CodeAgentRunStatus[] }> = {
  queue: { to: "queued/queued", from: ["queued", "paused", "completed", "errored"] },
  linkInactive: { to: "paused/linked-inactive", from: [] },
  awaitApproval: { to: "needs-approval/action-approval", from: ["queued", "running", "needs-approval"] },
  resumeAfterApproval: { to: "running/running", from: [] },
  stop: { to: "running/stopping", from: ["queued", "running", "needs-approval"] },
  pause: { to: "paused/paused", from: ["queued", "running", "needs-approval", "paused", "completed", "errored"] },
  interrupt: { to: "paused/interrupted", from: ["running", "needs-approval"] },
  fail: { to: "errored/error", from: ["queued", "running", "needs-approval", "paused", "errored"] },
  cleanupUnverified: { to: "errored/cleanup-unverified",
    from: ["queued", "running", "needs-approval", "paused", "completed", "errored"] },
};

test("the table names every edge the host writes, and each one's target", () => {
  assert.deepEqual(Object.keys(CODE_RUN_TRANSITIONS).sort(), Object.keys(EXPECTED).sort());
  for (const [edge, rule] of Object.entries(CODE_RUN_TRANSITIONS)) {
    assert.equal(`${rule.to.status}/${rule.to.phase}`, EXPECTED[edge as CodeRunEdge].to, edge);
  }
});

for (const edge of Object.keys(EXPECTED) as CodeRunEdge[]) {
  for (const status of STATUSES) {
    const allowed = EXPECTED[edge].from.includes(status);
    // Core leaves its own phases on a record, so a status-only rule must hold whatever the phase is.
    for (const phase of [undefined, "executing", "follow-up", "action-approval", "interrupted"]) {
      test(`${edge} ${allowed ? "allows" : "refuses"} ${status}/${phase ?? "none"}`, () => {
        assert.equal(codeRunTransitionAllowed(edge, { status, phase }),
          allowed || (edge === "resumeAfterApproval" && status === "needs-approval" && phase === "action-approval"));
      });
    }
  }
}

test("resumeAfterApproval needs the phase Vivary wrote, not Core's own approval phase", () => {
  assert.equal(codeRunTransitionAllowed("resumeAfterApproval", { status: "needs-approval", phase: "action-approval" }), true);
  assert.equal(codeRunTransitionAllowed("resumeAfterApproval", { status: "needs-approval", phase: "approval-required" }), false);
  assert.equal(codeRunTransitionAllowed("resumeAfterApproval", { status: "running", phase: "stopping" }), false);
});

test("a refused move writes nothing and logs one line, and an allowed move writes its pair", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-transitions-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const logged: string[] = [];
  const originalError = console.error;
  try {
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const { getCodeAgentRunRecord } = await import("@agent-native/core/code-agents");
    const { createCodeRun, transitionCodeRun } = await import("../server/code-run-transitions.ts");
    const run = createCodeRun("queue", { goalId: "vivary-local-code", title: "Table", cwd: fixture,
      metadata: { app: "vivary-workbench-local-code" } });
    assert.equal(run.status, "queued");
    assert.equal(run.phase, "queued");

    const before = getCodeAgentRunRecord(run.id);
    assert.equal(transitionCodeRun(run.id, "resumeAfterApproval", { needsApproval: false, metadata: { marker: 1 } }), null);
    assert.deepEqual(getCodeAgentRunRecord(run.id), before);
    assert.deepEqual(logged, [`[vivary-code-host] transition-refused run=${run.id} edge=resumeAfterApproval `
      + "from=queued/queued to=running/running"]);

    const stopped = transitionCodeRun(run.id, "stop", record => ({ metadata: { seen: record.phase } }));
    assert.equal(stopped?.status, "running");
    assert.equal(stopped?.phase, "stopping");
    assert.equal(stopped?.metadata?.seen, "queued");
    assert.equal(logged.length, 1);
    assert.equal(transitionCodeRun("missing-run", "stop"), null);
    assert.equal(logged.length, 1);
  } finally {
    console.error = originalError;
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    await rm(fixture, { recursive: true, force: true });
  }
});
