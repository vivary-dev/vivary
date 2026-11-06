import { z } from "zod";
import { workspacePatternChoices } from "./workspace-patterns.ts";

export const adoptionPreset = z.enum(["auto", "coding", "second-brain", "knowledge-work", "writing"]);
export const adoptionDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const approved = { projectId, operationId: z.string().uuid(), acceptedPlanHash: adoptionDigest };
export const adoptionInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("preview"), projectId, preset: adoptionPreset,
    patternChoices: workspacePatternChoices.optional() }),
  z.strictObject({ operation: z.literal("resume"), projectId }),
  z.strictObject({ operation: z.literal("cancel"), ...approved }),
  z.strictObject({ operation: z.literal("apply"), ...approved }),
  z.strictObject({ operation: z.literal("prepare-privacy"), ...approved }),
  z.strictObject({ operation: z.literal("preview-recovery"), ...approved }),
  z.strictObject({ operation: z.literal("recover"), ...approved, acceptedRecoveryHash: adoptionDigest }),
]);

const relativePath = z.string().min(1).refine(value => !value.startsWith("/")
  && !value.includes("\\") && !value.split("/").some(part => part === ".." || part === "." || part === ""));
const file = z.object({ path: relativePath, content: z.string(), content_hash: adoptionDigest,
  bytes: z.number().int().nonnegative() });
export const adoptionPrivacyRequest = z.strictObject({
  schema: z.literal("vivary.adopt-privacy-request.v1"),
  root_hash: adoptionDigest, before_hash: adoptionDigest.nullable(), after_hash: adoptionDigest,
});
const privacyPreparation = z.object({
  required: z.boolean(), ready: z.boolean(), reason: z.string().nullable(),
  root_hash: adoptionDigest.nullable(), before_hash: adoptionDigest.nullable(),
  after_hash: adoptionDigest.nullable(),
});
export const adoptionReport = z.object({
  mode: z.literal("dry-run"), root: z.string(),
  preset: adoptionPreset.exclude(["auto"]), preset_reason: z.string(), plan_hash: adoptionDigest,
  conflicts: z.array(z.object({ path: relativePath, reason: z.string() })),
  validation_findings: z.array(z.object({ path: relativePath, line: z.number().int().nonnegative(),
    level: z.enum(["error", "warning"]), code: z.string(), message: z.string() })).default([]),
  pattern_choices: workspacePatternChoices.optional(),
  retired_kept: z.array(relativePath).optional(),
  content_inventory: z.object({ existing_markdown: z.number().int().nonnegative(),
    existing_non_markdown: z.number().int().nonnegative() }).optional(),
  request_replay: z.object({ ready: z.boolean(), reason: z.string().nullable() }),
  privacy_preparation: privacyPreparation.optional(),
  content_plan: z.object({ schema: z.literal("vivary.adopt-content-plan.v1"),
    files: z.array(z.discriminatedUnion("operation", [
      file.extend({ operation: z.literal("create") }),
      file.extend({ operation: z.literal("patch"), before_hash: adoptionDigest }),
      file.extend({ operation: z.literal("replace"), before_hash: adoptionDigest }),
    ])), kept: z.array(z.object({ path: relativePath, content_hash: adoptionDigest })),
  }),
});
export const adoptionRecoveryReport = z.object({
  mode: z.literal("recovery-dry-run"), root: z.string(), plan_hash: adoptionDigest,
  recovery_plan_hash: adoptionDigest,
  recovery_actions: z.array(z.object({ path: relativePath,
    operation: z.enum(["no-op", "restore", "delete-created"]),
    current_hash: adoptionDigest.nullable(), restore_hash: adoptionDigest.nullable() })),
});
const review = { projectId, operationId: z.string().uuid(), planHash: adoptionDigest,
  displayName: z.string(), folder: z.string(), preset: adoptionPreset,
  patternChoices: workspacePatternChoices.optional(), report: adoptionReport };
export const adoptionResult = z.discriminatedUnion("code", [
  z.object({ code: z.literal("idle") }),
  z.object({ code: z.literal("preview"), ...review }),
  z.object({ code: z.literal("pending"), ...review, message: z.string() }),
  z.object({ code: z.literal("privacy-pending"), ...review, message: z.string() }),
  z.object({ code: z.literal("privacy-prepared"), projectId, replayed: z.boolean() }),
  z.object({ code: z.literal("recovery-preview"), ...review, recovery: adoptionRecoveryReport, approved: z.boolean() }),
  z.object({ code: z.literal("applied"), projectId, replayed: z.boolean() }),
  z.object({ code: z.literal("recovered"), projectId }),
  z.object({ code: z.literal("refused"), message: z.string() }),
]);
export type AdoptionInput = z.infer<typeof adoptionInput>;
export type AdoptionResult = z.infer<typeof adoptionResult>;
export type AdoptionPreset = z.infer<typeof adoptionPreset>;
