import { z } from "zod";

import { projectFileIdSchema } from "./project-file-schema.ts";
import type { ProjectRef, UnavailableReason } from "./project-read-schema.ts";

// Shared by the agent tool, the owner action, the server adapter, and the evaluate panel.
export const CONTROL_OPERATIONS = ["claim", "release", "expire_leases", "dependencies",
  "task_view", "complete", "handoff", "record_execution"] as const;
// The agent runs only operations whose every input the server can supply or verify.
export const AGENT_CONTROL_OPERATIONS = ["claim", "release", "expire_leases", "dependencies"] as const;
export const EVALUATE_OPERATIONS = ["decide", ...CONTROL_OPERATIONS] as const;
export const AGENT_EVALUATE_OPERATIONS = ["decide", ...AGENT_CONTROL_OPERATIONS] as const;
export const SERVER_OWNED_FIELDS = ["schema", "policy_version", "actor", "authority_class", "project",
  "projectId", "scope", "workspace", "requested_at", "decision_at", "now", "created_at",
  "from_actor", "to_authority_class"] as const;
export const AGENT_FORBIDDEN_EVIDENCE = ["receipt", "verdict", "execution_log"] as const;
export const PROJECT_EVALUATE_MAX_RESULT_CHARS = 40_000;

export type ControlOperation = typeof CONTROL_OPERATIONS[number];
export type EvaluateOperation = typeof EVALUATE_OPERATIONS[number];
export type EvaluateAs = "me" | "agent";

/** "." or POSIX segments inside the project: no leading "/", drive, "\\", "..", or NUL. */
export const projectRelativePath = z.string().min(1).max(1_000).refine(value => value === "."
  || (!value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.includes("\0")
    && !value.split("/").includes("..")), { message: "Use a path inside this project, such as src/api." });

const record = z.record(z.string(), z.unknown());
const ledger = z.array(z.unknown()).max(10_000);
const identifier = z.string().min(1).max(512);
const count = z.number().int().nonnegative();
const capsule = record.describe("The Task Capsule JSON exactly as it was handed over.");
const budgetState = z.strictObject({ turns_used: count.optional(), actions_used: count.optional() })
  .describe("Optional loop budget used so far.");
const budgetLimits = z.strictObject({ max_turns: count.optional(), max_actions: count.optional() })
  .describe("Optional loop budget limits.");
const claimsState = z.strictObject({ claims: ledger.describe("The active claims, as returned by an earlier call.") });

const decide = { operation: z.literal("decide"), capsule, state: budgetState.optional(), limits: budgetLimits.optional() };
const claim = { operation: z.literal("claim"), state: claimsState,
  paths: z.array(projectRelativePath).min(1).max(64).describe("Project-relative paths to claim. Use . for the whole project."),
  lease: record.optional().describe("Optional lease with granted_at and expires_at.") };
const release = { operation: z.literal("release"), state: claimsState, claim_id: identifier };
const expireLeases = { operation: z.literal("expire_leases"), state: claimsState };
const dependencies = { operation: z.literal("dependencies"), state: z.strictObject({ tasks: ledger }), task_id: identifier };

/** What a tool call may ask. The owner's agent mode uses the same schema. */
export const projectEvaluateToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject(decide), z.strictObject(claim), z.strictObject(release), z.strictObject(expireLeases),
  z.strictObject(dependencies),
]);

const taskState = z.strictObject({ task: record, execution_log: ledger });
/** What the owner may ask as themself: all nine operations and caller-provided receipts and verdicts. */
export const projectEvaluateOwnInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...decide, receipt: record.optional(), verdict: z.unknown().optional() }),
  z.strictObject(claim), z.strictObject(release), z.strictObject(expireLeases), z.strictObject(dependencies),
  z.strictObject({ operation: z.literal("task_view"), state: taskState }),
  z.strictObject({ operation: z.literal("complete"), state: taskState }),
  z.strictObject({ operation: z.literal("handoff"), state: claimsState, claim_id: identifier, receipt: record, capsule,
    to_actor: z.enum(["me", "agent"]).describe("The owner or this project's agent. Vivary fills in the actor id."),
    workspace_revision: z.string() }),
  z.strictObject({ operation: z.literal("record_execution"), state: z.strictObject({ execution_log: ledger }),
    receipt: record, capsule }),
]);

export type ProjectEvaluateToolInput = z.infer<typeof projectEvaluateToolInputSchema>;
export type GovernedInput = z.infer<typeof projectEvaluateOwnInputSchema>;

// What the model sees: one flat object, because Native lists only object
// schemas as tools, and Native checks a call against it before the action
// runs. It lists the agent's fields without refusing others, so a
// server-owned field reaches the server and is refused by name.
export const projectEvaluateToolAdvertisedSchema = z.looseObject({
  operation: z.enum(AGENT_EVALUATE_OPERATIONS).describe("The evaluation to run."),
  capsule: capsule.optional().describe("decide only, required: the Task Capsule JSON exactly as the owner handed it over."),
  state: record.optional().describe("claim, release, expire_leases: { claims } from an earlier call, or { claims: [] }. dependencies: { tasks }. decide: optional { turns_used, actions_used }."),
  limits: budgetLimits.optional().describe("decide only: optional { max_turns, max_actions }."),
  paths: z.array(z.string()).optional().describe("claim only, required: project-relative paths such as src/api. Use . for the whole project."),
  lease: record.optional().describe("claim only: optional { granted_at, expires_at }."),
  claim_id: identifier.optional().describe("release only, required: the claim_id of your claim."),
  task_id: identifier.optional().describe("dependencies only, required: the task whose dependencies to check."),
});

// The actions accept any named field so the server can refuse a server-owned
// one by name instead of by a generic schema error. The adapter then parses
// the strict schema above for the chosen actor.
export const projectEvaluateToolBoundarySchema = z.looseObject({ operation: z.enum(EVALUATE_OPERATIONS) });
export const projectEvaluateOwnerInputSchema = z.looseObject({
  projectId: projectFileIdSchema,
  evaluateAs: z.enum(["me", "agent"]),
  operation: z.enum(EVALUATE_OPERATIONS),
});
export type ProjectEvaluateOwnerInput = z.infer<typeof projectEvaluateOwnerInputSchema>;

export type EvaluatedAs = { kind: "human" | "agent"; id: string; authorityClass: "contributor"; role: "owner" | "project-agent" };
export type BoundaryRefusal = "server_owned_field" | "agent_forbidden_evidence" | "owner_only_operation"
  | "foreign_path" | "identity" | "request_invalid" | "unsupported_root" | "unencodable_evidence" | "result_too_large";
/** Refusals the runner returns after it resolved the project and before any child starts. */
export type GovernedRefusalReason = Extract<BoundaryRefusal, "foreign_path" | "identity" | "request_invalid" | "unsupported_root">;
/** Refusals that happen after Strato or Exo ran, so the run and its receipt exist. */
export const POST_RUN_REFUSALS = ["unencodable_evidence", "result_too_large"] as const satisfies readonly BoundaryRefusal[];
export type ProjectEvaluateResult =
  | { status: "evaluated"; project: ProjectRef; operation: EvaluateOperation; evaluatedAs: EvaluatedAs;
      persisted: false; evaluationKind: "caller-provided-evidence"; notice: string;
      refusedBy: "strato" | "exo" | null; output: unknown }
  | { status: "refused"; project: ProjectRef | null; operation: string; reason: BoundaryRefusal; field?: string; message: string }
  | { status: "unavailable"; project: ProjectRef; operation: EvaluateOperation; reason: UnavailableReason; message: string };
