import { z } from "zod";

export const workspacePatternId = z.enum([
  "capture", "source-reference", "navigation", "project-brief",
]);
const codePointLength = (value: string) => Array.from(value).length;
export const workspacePatternChoice = z.strictObject({
  id: workspacePatternId,
  name: z.string().min(1).refine(value => codePointLength(value) <= 80),
  path: z.string().min(1).refine(value => codePointLength(value) <= 240),
});
export const workspacePatternChoices = z.array(workspacePatternChoice).max(4);
export const workspacePatternCatalog = z.strictObject({
  code: z.literal("catalog"),
  patterns: z.array(z.strictObject({
    id: workspacePatternId,
    label: z.string(),
    description: z.string(),
    defaultName: z.string(),
    defaultPath: z.string(),
  })),
});
export type WorkspacePatternChoice = z.infer<typeof workspacePatternChoice>;
export type WorkspacePatternDefinition = z.infer<typeof workspacePatternCatalog>["patterns"][number];
export type WorkspacePatternCatalog = z.infer<typeof workspacePatternCatalog>;

export const workspacePatternState = z.strictObject({
  ok: z.literal(true),
  catalog: workspacePatternCatalog.shape.patterns,
  choices: workspacePatternChoices,
});
export type WorkspacePatternState = z.infer<typeof workspacePatternState>;

export const workspacePreset = z.enum(["coding", "second-brain", "knowledge-work", "writing"]);
export type WorkspacePreset = z.infer<typeof workspacePreset>;
