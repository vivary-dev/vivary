import {
  createCodeAgentRunRecord,
  updateCodeAgentRunRecord,
  type CodeAgentRunRecord,
  type CodeAgentRunStatus,
} from "@agent-native/core/code-agents";

/**
 * Beta ticket 06. Every Code run status and phase that the workbench server writes goes through this table. Core's
 * executor writes its own pairs inside the worker process (`running/executing`, `running/follow-up`,
 * `completed/complete`, `errored/error` and others), so a rule names the statuses it accepts, and names a phase only
 * where the phase decides. A write the table refuses changes nothing and logs one line.
 */
export const CODE_RUN_TRANSITIONS = {
  /** A send claims the host for a new turn. Creation starts here too. */
  queue: { to: { status: "queued", phase: "queued" }, from: ["queued", "paused", "completed", "errored"], create: true },
  /** A linked conversation creates its Code target without starting it. */
  linkInactive: { to: { status: "paused", phase: "linked-inactive" }, from: [], create: true },
  /** Codex asks for an answer. */
  awaitApproval: { to: { status: "needs-approval", phase: "action-approval" },
    from: ["queued", "running", "needs-approval"] },
  /** The last request Vivary showed is answered or withdrawn, so the turn goes on. */
  resumeAfterApproval: { to: { status: "running", phase: "running" },
    from: [{ status: "needs-approval", phase: "action-approval" }] },
  /** Stop or shutdown asked the worker to end. */
  stop: { to: { status: "running", phase: "stopping" }, from: ["queued", "running", "needs-approval"] },
  /** The worker ended after Stop or shutdown. Core may have written its own end first. */
  pause: { to: { status: "paused", phase: "paused" },
    from: ["queued", "running", "needs-approval", "paused", "completed", "errored"] },
  /** A fresh host found a run that the previous host left active. */
  interrupt: { to: { status: "paused", phase: "interrupted" }, from: ["running", "needs-approval"] },
  /** Beta ticket 27. A quit expired the request a run waited on. Core may have paused the run first. */
  interruptOnQuit: { to: { status: "paused", phase: "interrupted" }, from: ["running", "needs-approval", "paused"] },
  /** The worker failed outside a stop. */
  fail: { to: { status: "errored", phase: "error" }, from: ["queued", "running", "needs-approval", "paused", "errored"] },
  /** A stop could not confirm that the run's processes ended. Any run can end this way. */
  cleanupUnverified: { to: { status: "errored", phase: "cleanup-unverified" },
    from: ["queued", "running", "needs-approval", "paused", "completed", "errored"] },
} as const satisfies Record<string, CodeRunRule>;

export type CodeRunEdge = keyof typeof CODE_RUN_TRANSITIONS;

type CodeRunState = { status: CodeAgentRunStatus; phase: string };
type CodeRunRule = {
  to: CodeRunState;
  from: readonly (CodeAgentRunStatus | CodeRunState)[];
  create?: boolean;
};
type CodeRunPatch = Omit<Partial<CodeAgentRunRecord>, "status" | "phase">;
type CodeRunCreate = Omit<Parameters<typeof createCodeAgentRunRecord>[0], "status" | "phase">;

/** Whether the table lets a run in `from` take this edge. */
export function codeRunTransitionAllowed(edge: CodeRunEdge, from: { status: CodeAgentRunStatus; phase?: string }): boolean {
  const rule: CodeRunRule = CODE_RUN_TRANSITIONS[edge];
  return rule.from.some(allowed => typeof allowed === "string"
    ? allowed === from.status : allowed.status === from.status && allowed.phase === from.phase);
}

/** Creates a run record at the first state of an edge that allows creation. */
export function createCodeRun(edge: "queue" | "linkInactive", input: CodeRunCreate): CodeAgentRunRecord {
  return createCodeAgentRunRecord({ ...input, ...CODE_RUN_TRANSITIONS[edge].to });
}

/**
 * Moves a run along an edge in one atomic read and write. A refused move writes nothing, logs the run, both states and
 * the edge, and returns null, because several callers run in `finally` blocks and IPC callbacks where a throw would
 * change what happens next. A missing record also returns null.
 */
export function transitionCodeRun(runId: string, edge: CodeRunEdge,
  patch: CodeRunPatch | ((record: CodeAgentRunRecord) => CodeRunPatch) = {}): CodeAgentRunRecord | null {
  const to = CODE_RUN_TRANSITIONS[edge].to;
  const seen: { refused?: { status: CodeAgentRunStatus; phase?: string } } = {};
  const written = updateCodeAgentRunRecord(runId, record => {
    if (!codeRunTransitionAllowed(edge, record)) {
      seen.refused = { status: record.status, phase: record.phase };
      return { updatedAt: record.updatedAt };
    }
    return { ...(typeof patch === "function" ? patch(record) : patch), ...to };
  });
  if (!seen.refused) return written;
  // The line names the run, the edge and both states, and nothing else from the record.
  console.error(`[vivary-code-host] transition-refused run=${runId} edge=${edge} `
    + `from=${seen.refused.status}/${seen.refused.phase ?? "none"} to=${to.status}/${to.phase}`);
  return null;
}
