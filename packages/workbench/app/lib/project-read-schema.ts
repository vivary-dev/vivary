import { z } from "zod";

import { workspacePreset, type WorkspacePreset } from "../../shared/workspace-patterns.ts";
import { projectFileIdSchema } from "./project-file-schema.ts";

// Shared by the agent tool, the owner action, the server read, and the Details panel.
export const PROJECT_READ_OPERATIONS = ["doctor", "check", "find", "capabilities", "receipts",
  "review", "impact"] as const;
// context-budget reads files from disk rather than the filtered graph, so it has no public form.
export const PUBLIC_REVIEW_PACKS = ["structure", "editorial"] as const;
// Every rule the public structure and editorial packs emit. The panel words each one from a closed table.
export const PUBLIC_REVIEW_RULES = ["change-unverified", "change-ungated", "module-unverified", "orphan",
  "broken-edge", "draft-unreviewed", "draft-unedited", "draft-structure-missing", "review-unlinked",
  "edit-unlinked"] as const;
export const READ_BOUNDS = { items: 40, text: 300 } as const;
export const PROJECT_READ_MAX_RESULT_CHARS = 40_000;

export type ProjectReadOperation = typeof PROJECT_READ_OPERATIONS[number];
export type PublicReviewPack = typeof PUBLIC_REVIEW_PACKS[number];
export type PublicReviewRule = typeof PUBLIC_REVIEW_RULES[number];
// A broken link reads the same whether its target is private or missing, so the sentence names neither.
export const REVIEW_RULE_SENTENCES = {
  "change-unverified": "This change has no verification note linked.",
  "change-ungated": "This change has no gate linked.",
  "module-unverified": "This module has no verification note linked.",
  orphan: "This note has no links to or from other shared notes.",
  "broken-edge": "A link in this note points to an id that no shared note has.",
  "draft-unreviewed": "This draft or manuscript has no review linked.",
  "draft-unedited": "This draft or manuscript has no edit or revision linked.",
  "draft-structure-missing": "This draft or manuscript has no outline, beat sheet, or structure note linked.",
  "review-unlinked": "This review is not linked to a draft or manuscript.",
  "edit-unlinked": "This edit is not linked to a draft, manuscript, or review.",
} as const satisfies Record<PublicReviewRule, string>;

export const projectReadQuerySchema = z.string().trim().min(1).max(4_000)
  // The original CLI reads its query right after the verb and refuses `--`.
  .refine(value => !value.startsWith("-"), { message: "The question must not start with a dash" });
export const projectReadKSchema = z.number().int().min(1).max(20);
export const projectReadBudgetSchema = z.number().int().min(64).max(4_000);
export const projectReadPackSchema = z.enum(PUBLIC_REVIEW_PACKS);
export const projectReadNodeIdSchema = z.string().trim().min(1).max(256)
  // The original CLI reads the node id right after the verb and refuses `--`.
  .refine(value => !value.startsWith("-"), { message: "The node id must not start with a dash" });

const OPTIONS = {
  doctor: [], check: [], find: ["query", "k", "budget"], capabilities: ["preset"], receipts: ["failedOnly"],
  review: ["pack"], impact: ["nodeId"],
} as const satisfies Record<ProjectReadOperation, readonly string[]>;
type OptionName = typeof OPTIONS[ProjectReadOperation][number];
const OPTION_NAMES: readonly OptionName[] = ["query", "k", "budget", "preset", "failedOnly", "pack", "nodeId"];

const fields = {
  operation: z.enum(PROJECT_READ_OPERATIONS).describe("The report to read."),
  query: projectReadQuerySchema.optional().describe("find only, required: the question to rank project context for."),
  k: projectReadKSchema.optional().describe("find only: how many results to return, 1 to 20. Default 5."),
  budget: projectReadBudgetSchema.optional().describe("find only: approximate token budget for snippets, 64 to 4000. Default 1200."),
  preset: workspacePreset.optional().describe("capabilities only: the Vivary preset whose optional features to list. Default coding."),
  failedOnly: z.boolean().optional().describe("receipts only: list only failed commands. Default false."),
  pack: projectReadPackSchema.optional().describe("review only: structure or editorial. Default structure."),
  nodeId: projectReadNodeIdSchema.optional().describe("impact only, required: the id of the note whose dependents to list."),
};

// One flat object so the model sees every field, with per-operation rules
// the validator enforces.
function optionsMatchOperation(input: { operation: ProjectReadOperation } & Partial<Record<OptionName, unknown>>,
  context: z.RefinementCtx) {
  const allowed: readonly string[] = OPTIONS[input.operation];
  for (const name of OPTION_NAMES) {
    if (input[name] !== undefined && !allowed.includes(name)) {
      context.addIssue({ code: "custom", path: [name], message: `${name} does not apply to ${input.operation}` });
    }
  }
  if (input.operation === "find" && input.query === undefined) {
    context.addIssue({ code: "custom", path: ["query"], message: "find needs a query" });
  }
  if (input.operation === "impact" && input.nodeId === undefined) {
    context.addIssue({ code: "custom", path: ["nodeId"], message: "impact needs a nodeId" });
  }
}

export const projectReadToolInputSchema = z.strictObject(fields).superRefine(optionsMatchOperation);
export const projectReadOwnerInputSchema = z.strictObject({ projectId: projectFileIdSchema, ...fields })
  .superRefine(optionsMatchOperation);

export type ProjectReadToolInput = z.infer<typeof projectReadToolInputSchema>;
export type ProjectReadOwnerInput = z.infer<typeof projectReadOwnerInputSchema>;

export type Bounded<T> = { items: T[]; total: number };
export type ProjectRef = { id: string; label: string };
export type Omission = { kind: string; reason: string; count: number };
// `line` is 0 when a finding covers the whole file.
export type CheckFinding = { path: string; line: number; level: "error" | "warning"; code: string; message: string };
// `snippet` is null when Tropo withheld text that looked like a path or a credential.
export type FindResult = { id: string; type: string | null; path: string; reason: string; snippet: string | null };
export type CapabilityStatus = "installed" | "not-installed" | "incompatible" | "probe-failed";
// `network` is a description when the answer depends on configuration.
export type Capability = { id: string; label: string; isDefault: boolean; requiresApproval: boolean; network: boolean | string;
  installStatus: CapabilityStatus; missing: string[] };
export type Receipt = { timestamp: string; tool: string; command: string; ok: boolean; exitCode: number | null;
  durationMs: number | null; source: string | null; errorType?: string };
// A broken-edge finding names its source note and the `field` holding the broken reference, never the target.
// Only a broken-edge finding has a `field`.
export type ReviewFinding = { severity: "warn" | "info"; rule: PublicReviewRule; id: string; type: string | null; path: string;
  field?: string };
export type ImpactNode = { id: string; distance: number; via: string; type: string | null; path: string };

export type ProjectReadReport =
  | { operation: "doctor"; ok: boolean; errors: Bounded<string>; warnings: Bounded<string> }
  | { operation: "check"; checked: number; clean: number; errorCount: number; warningCount: number;
      strict: boolean; complete: boolean; findings: Bounded<CheckFinding>; omissions: Omission[] }
  | { operation: "find"; query: string; k: number; budget: number; estimatedTokens: number; complete: boolean;
      results: Bounded<FindResult>; omissions: Omission[] }
  | { operation: "capabilities"; preset: WorkspacePreset; defaults: string[]; capabilities: Bounded<Capability> }
  | { operation: "receipts"; scope: "application"; failedOnly: boolean; logPresent: boolean; total: number; failed: number;
      invalidLines: number; records: Bounded<Receipt> }
  | { operation: "review"; pack: PublicReviewPack; reviewed: number; warnings: number; notes: number; complete: boolean;
      findings: Bounded<ReviewFinding>; omissions: Omission[] }
  // `impacted` counts dependents reached through public notes only, so it is a lower bound.
  | { operation: "impact"; target: string; impacted: number; complete: boolean; nodes: Bounded<ImpactNode>;
      omissions: Omission[] };

export type UnavailableReason = "privacy_policy_unavailable" | "path_refused" | "work_limit_exceeded"
  | "producer_unavailable" | "timeout" | "queue_timeout" | "output_limit" | "runtime_unavailable" | "app_data_unavailable"
  | "unreadable_output" | "target_unavailable";

export type ProjectReadResult =
  | { status: "reported"; project: ProjectRef; notice: string; report: ProjectReadReport }
  | { status: "unavailable"; project: ProjectRef; operation: ProjectReadOperation; reason: UnavailableReason; message: string };
