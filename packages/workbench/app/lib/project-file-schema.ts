import { z } from "zod";

export const projectFileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const projectFilePathSchema = z.string().min(1).max(1_000);
export const projectFileVersionSchema = z.string().regex(/^pf_[0-9a-f]{64}$/);

export const projectFileKindSchema = z.enum(["markdown", "text", "toml", "source"]);
export const projectFileBlockedReasonSchema = z.enum([
  "binary",
  "too-large",
  "unsupported",
  "linked",
]);

export const projectFileIdentitySchema = z.strictObject({
  projectId: projectFileIdSchema,
  label: z.string().min(1).max(200),
  rootId: projectFileIdSchema,
  bindingId: projectFileIdSchema,
  bindingRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
});

const projectFileSummaryFields = {
  path: projectFilePathSchema,
  name: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
};

export const projectFileSummarySchema = z.discriminatedUnion("access", [
  z.strictObject({
    ...projectFileSummaryFields,
    access: z.literal("editable"),
    kind: projectFileKindSchema,
  }),
  z.strictObject({
    ...projectFileSummaryFields,
    access: z.literal("blocked"),
    kind: z.literal("unknown"),
    reason: projectFileBlockedReasonSchema,
  }),
]);

export const projectFileSchema = z.strictObject({
  ...projectFileSummaryFields,
  access: z.literal("editable"),
  kind: projectFileKindSchema,
  content: z.string(),
  version: projectFileVersionSchema,
});

export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileSummary = z.infer<typeof projectFileSummarySchema>;
export type ProjectFileIdentity = z.infer<typeof projectFileIdentitySchema>;
export type ProjectFileBlockedReason = z.infer<typeof projectFileBlockedReasonSchema>;

export type ProjectFilesResult =
  | { code: "listing"; project: ProjectFileIdentity; files: ProjectFileSummary[]; truncated: boolean }
  | { code: "file"; project: ProjectFileIdentity; file: ProjectFile }
  | { code: "blocked"; path: string; reason: ProjectFileBlockedReason };

export type ProjectFileSaveResult =
  | { code: "saved"; project: ProjectFileIdentity; file: ProjectFile }
  | {
      code: "conflict";
      operation: "save";
      reason: "changed" | "renamed-or-deleted" | "project-changed";
      path: string;
      current?: ProjectFile;
    };

export type ProjectFileRenameResult =
  | {
      code: "renamed";
      project: ProjectFileIdentity;
      previousPath: string;
      file: ProjectFile;
    }
  | {
      code: "conflict";
      operation: "rename";
      reason: "changed" | "renamed-or-deleted" | "target-exists" | "project-changed";
      path: string;
      targetPath?: string;
      current?: ProjectFile;
    };

export type ProjectFileCreateResult =
  | { code: "created"; project: ProjectFileIdentity; file: ProjectFile }
  | {
      code: "conflict";
      operation: "create";
      reason: "target-exists" | "project-changed";
      path: string;
      current?: ProjectFile;
    };

export type ProjectFileRemoveResult =
  | { code: "removed"; project: ProjectFileIdentity; path: string }
  | {
      code: "conflict";
      operation: "remove";
      reason: "changed" | "renamed-or-deleted" | "project-changed";
      path: string;
      current?: ProjectFile;
    };

export const projectFilesInputSchema = z.strictObject({
  projectId: projectFileIdSchema,
  path: projectFilePathSchema.optional(),
});

export const projectFileSaveInputSchema = z.strictObject({
  projectId: projectFileIdSchema,
  path: projectFilePathSchema,
  expectedVersion: projectFileVersionSchema,
  content: z.string().max(262_144),
});

export const projectFileRenameInputSchema = z.strictObject({
  projectId: projectFileIdSchema,
  path: projectFilePathSchema,
  name: z.string().min(1).max(255),
  expectedVersion: projectFileVersionSchema,
});
