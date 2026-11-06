import { z } from "zod";

// One `vivary-original-command` run as the action returns it: the child's raw output.
export type OriginalCommandOutput = { exitCode: number | null; stdout: string; stderr: string };

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const relativePath = z.string().min(1).refine(value => !value.startsWith("/")
  && !value.includes("\\") && !value.split("/").some(part => part === ".." || part === "." || part === ""));
const file = z.object({
  path: relativePath, content: z.string(), content_hash: digest, bytes: z.number().int().nonnegative(),
});
const plannedFile = z.discriminatedUnion("operation", [
  file.extend({ operation: z.literal("create") }),
  file.extend({ operation: z.literal("patch"), before_hash: digest }),
  file.extend({ operation: z.literal("replace"), before_hash: digest }),
]);
const report = z.object({
  mode: z.literal("dry-run"),
  preset: z.enum(["coding", "second-brain", "knowledge-work", "writing"]),
  preset_reason: z.string(),
  plan_hash: digest,
  conflicts: z.array(z.object({ path: relativePath, reason: z.string() })),
  validation_findings: z.array(z.object({ path: relativePath, line: z.number().int().nonnegative(),
    level: z.enum(["error", "warning"]), code: z.string(), message: z.string() })).default([]),
  content_inventory: z.object({ existing_markdown: z.number().int().nonnegative(),
    existing_non_markdown: z.number().int().nonnegative() }).optional(),
  content_plan: z.object({
    schema: z.literal("vivary.adopt-content-plan.v1"),
    files: z.array(plannedFile),
    kept: z.array(z.object({ path: relativePath, content_hash: digest })),
  }),
});

type AdoptionReport = z.infer<typeof report>;
export type AdoptionPreview =
  | { kind: "report"; preset: AdoptionReport["preset"]; presetReason: string; planHash: string;
      files: AdoptionReport["content_plan"]["files"]; kept: AdoptionReport["content_plan"]["kept"];
      conflicts: AdoptionReport["conflicts"];
      validationFindings: AdoptionReport["validation_findings"];
      contentInventory: AdoptionReport["content_inventory"] }
  | { kind: "unreadable"; message: string };

export function summarizeAdoptionOutput(output: OriginalCommandOutput): AdoptionPreview {
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); } catch { parsed = undefined; }
  const result = report.safeParse(parsed);
  if (result.success && (output.exitCode === 0 || output.exitCode === 1)) {
    const value = result.data;
    return { kind: "report", preset: value.preset, presetReason: value.preset_reason,
      planHash: value.plan_hash, files: value.content_plan.files, kept: value.content_plan.kept,
      conflicts: value.conflicts, validationFindings: value.validation_findings,
      contentInventory: value.content_inventory };
  }
  const failure = z.object({ error: z.string().min(1) }).safeParse(parsed);
  return { kind: "unreadable", message: failure.success
    ? `Setup preview could not be prepared: ${failure.data.error.slice(0, 400)}`
    : "The local runtime did not return a complete setup preview. Update the runtime and try again." };
}
