import {
  POST_RUN_REFUSALS, type BoundaryRefusal, type ControlOperation, type EvaluateAs, type EvaluatedAs, type ProjectEvaluateResult,
} from "./project-evaluate-schema.ts";

// Pure helpers behind the owner's Evaluate panel. Every JSON field the owner
// types is parsed here, so malformed JSON is reported in the panel and never sent.

export const OPERATION_LABELS: Record<ControlOperation, string> = {
  claim: "Claim", release: "Release", expire_leases: "Expire leases", dependencies: "Dependencies",
  task_view: "Task view", complete: "Complete", handoff: "Handoff", record_execution: "Record execution",
};

// Operations that read the same kind of state share one draft, so a claim
// ledger carries over from claim to release without retyping.
export type StateShape = "claims" | "tasks" | "task" | "log";
export const STATE_SHAPE: Record<ControlOperation, StateShape> = {
  claim: "claims", release: "claims", expire_leases: "claims", handoff: "claims",
  dependencies: "tasks", task_view: "task", complete: "task", record_execution: "log",
};
export const STATE_TEMPLATES: Record<StateShape, string> = {
  claims: "{\"claims\": []}", tasks: "{\"tasks\": []}",
  task: "{\"task\": {}, \"execution_log\": []}", log: "{\"execution_log\": []}",
};

export type ControlField = "paths" | "lease" | "claim_id" | "task_id" | "receipt" | "capsule" | "to_actor" | "workspace_revision";
export const CONTROL_FIELDS: Record<ControlOperation, readonly ControlField[]> = {
  claim: ["paths", "lease"], release: ["claim_id"], expire_leases: [], dependencies: ["task_id"],
  task_view: [], complete: [], handoff: ["claim_id", "receipt", "capsule", "to_actor", "workspace_revision"],
  record_execution: ["receipt", "capsule"],
};

export type DecideDraft = {
  capsule: string; turns_used: string; actions_used: string; max_turns: string; max_actions: string;
  receipt: string; verdict: string;
};
export type ControlDraft = {
  operation: ControlOperation; states: Record<StateShape, string>;
  paths: string; lease: string; claim_id: string; task_id: string; receipt: string; capsule: string;
  to_actor: EvaluateAs; workspace_revision: string;
};
export type Built = { ok: true; input: Record<string, unknown> } | { ok: false; message: string };

export const emptyDecideDraft = (): DecideDraft =>
  ({ capsule: "", turns_used: "", actions_used: "", max_turns: "", max_actions: "", receipt: "", verdict: "" });
export const emptyControlDraft = (): ControlDraft => ({
  operation: "claim", states: { ...STATE_TEMPLATES }, paths: "", lease: "", claim_id: "", task_id: "",
  receipt: "", capsule: "", to_actor: "agent", workspace_revision: "",
});

class FieldError extends Error {}

function json(noun: string, text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new FieldError(`The ${noun} is not valid JSON. Check for a missing quote, comma, or bracket.`); }
}

function object(noun: string, text: string): Record<string, unknown> {
  if (!text.trim()) throw new FieldError(`Enter the ${noun} as JSON.`);
  const value = json(noun, text);
  if (!isRecord(value)) throw new FieldError(`The ${noun} must be a JSON object in braces.`);
  return value;
}

function count(label: string, text: string): number | undefined {
  if (!text.trim()) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new FieldError(`${label} must be a whole number of 0 or more.`);
  return value;
}

function required(label: string, text: string): string {
  const value = text.trim();
  if (!value) throw new FieldError(`Enter ${label}.`);
  return value;
}

function defined(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const kept = Object.entries(entries).filter(([, value]) => value !== undefined);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

function build(make: () => Record<string, unknown>): Built {
  try { return { ok: true, input: make() }; }
  catch (error) {
    if (error instanceof FieldError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The decide request. Receipt and verdict are sent only when the owner evaluates as themself. */
export const decideRequest = (draft: DecideDraft, evaluateAs: EvaluateAs): Built => build(() => {
  const input: Record<string, unknown> = { operation: "decide", capsule: object("Task Capsule", draft.capsule) };
  const state = defined({ turns_used: count("Turns used", draft.turns_used), actions_used: count("Actions used", draft.actions_used) });
  const limits = defined({ max_turns: count("Max turns", draft.max_turns), max_actions: count("Max actions", draft.max_actions) });
  if (state) input.state = state;
  if (limits) input.limits = limits;
  if (evaluateAs === "me") {
    if (draft.receipt.trim()) input.receipt = object("receipt", draft.receipt);
    if (draft.verdict.trim()) input.verdict = json("verdict", draft.verdict);
  }
  return input;
});

/** The control request for the selected operation, with only that operation's fields. */
export const controlRequest = (draft: ControlDraft): Built => build(() => {
  const { operation } = draft;
  const input: Record<string, unknown> = { operation, state: object("state", draft.states[STATE_SHAPE[operation]]) };
  for (const field of CONTROL_FIELDS[operation]) {
    if (field === "paths") {
      const paths = draft.paths.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (paths.length === 0) throw new FieldError("Enter at least one path, such as src/api.");
      input.paths = paths;
    } else if (field === "lease") {
      if (draft.lease.trim()) input.lease = object("lease", draft.lease);
    } else if (field === "claim_id") {
      input.claim_id = required("a claim id", draft.claim_id);
    } else if (field === "task_id") {
      input.task_id = required("a task id", draft.task_id);
    } else if (field === "receipt" || field === "capsule") {
      input[field] = object(field === "receipt" ? "receipt" : "Task Capsule", draft[field]);
    } else if (field === "to_actor") {
      input.to_actor = draft.to_actor;
    } else {
      input.workspace_revision = draft.workspace_revision;
    }
  }
  return input;
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exo wraps a control result in `result`. Decide and every refusal are shown whole. */
export const shownOutput = (output: unknown): unknown => isRecord(output) && "result" in output ? output.result : output;

/** Strato's or Exo's own refusal, which holds nothing but reason codes. */
export const isRefusalDocument = (output: unknown): boolean =>
  isRecord(output) && typeof output.schema === "string" && output.schema.endsWith("-refusal/v0");

const codesIn = (value: unknown): string[] | null =>
  isRecord(value) && Array.isArray(value.reason_codes) && value.reason_codes.every(code => typeof code === "string")
    ? value.reason_codes as string[] : null;

export const reasonCodes = (output: unknown): string[] => codesIn(shownOutput(output)) ?? codesIn(output) ?? [];

/** Strato's decision, or the decision inside an Exo result, or null when the result has none. */
export function decisionOf(output: unknown): string | null {
  const decision = isRecord(output) && "result" in output
    ? isRecord(output.result) ? output.result.decision : undefined
    : isRecord(output) ? output.decision : undefined;
  return typeof decision === "string" ? decision : null;
}

// Each operation's success decision. Any other decision is announced as an alert.
const SUCCESS_DECISIONS: ReadonlySet<string> = new Set(["act", "granted", "released", "bound", "ready"]);
export const isSuccessDecision = (decision: string) => SUCCESS_DECISIONS.has(decision);

export const refusalTitle = (reason: BoundaryRefusal): string =>
  (POST_RUN_REFUSALS as readonly string[]).includes(reason) ? "Vivary could not return this result" : "Vivary refused before running";

export function actorLine(actor: EvaluatedAs): string {
  const who = actor.kind === "human" ? "you" : "this project's agent";
  return `Evaluated as ${who} (${actor.kind}, ${actor.authorityClass})`;
}

export type ReturnedState = { shape: StateShape; text: string; claimId?: string };

/**
 * The state a control result hands back, ready to paste into the state field,
 * or null. A Core refusal hands back the ledger it refused, which is not new state.
 */
export function returnedState(evaluation: ProjectEvaluateResult): ReturnedState | null {
  if (evaluation.status !== "evaluated" || evaluation.refusedBy || evaluation.operation === "decide") return null;
  const { operation, output } = evaluation;
  const result = isRecord(output) && output.operation === operation ? output.result : null;
  if (!isRecord(result)) return null;
  const shape = STATE_SHAPE[operation];
  if (shape === "claims" && Array.isArray(result.claims)) {
    const claimId = isRecord(result.claim) && typeof result.claim.claim_id === "string" ? result.claim.claim_id : undefined;
    return { shape, text: JSON.stringify({ claims: result.claims }, null, 2), ...(claimId ? { claimId } : {}) };
  }
  if (operation === "record_execution" && Array.isArray(result.edges)) {
    return { shape, text: JSON.stringify({ execution_log: result.edges }, null, 2) };
  }
  return null;
}
