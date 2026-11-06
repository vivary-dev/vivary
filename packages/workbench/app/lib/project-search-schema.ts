import { z } from "zod";

import {
  projectFileIdSchema,
  projectFilePathSchema,
  type ProjectFileIdentity,
} from "./project-file-schema.ts";

// Shared by the search action, the server service, and the panel.
export const projectSearchModeSchema = z.enum(["filename", "text", "regex"]);
export const projectSearchQuerySchema = z.string().trim().min(2).max(200);

export const projectSearchInputSchema = z.strictObject({
  projectId: projectFileIdSchema,
  query: projectSearchQuerySchema,
  mode: projectSearchModeSchema.default("text"),
  // Continue a bounded search after this project-relative path (the
  // `continueAfter` value of the previous page).
  after: projectFilePathSchema.optional(),
});

export const projectSearchTruncationSchema = z.enum(["entries", "files", "matches", "time"]);

export type ProjectSearchMode = z.infer<typeof projectSearchModeSchema>;
export type ProjectSearchInput = z.infer<typeof projectSearchInputSchema>;
export type ProjectSearchTruncation = z.infer<typeof projectSearchTruncationSchema>;

export type ProjectSearchFileMatch = { path: string; name: string };

export type ProjectSearchTextMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
  // Set on a file's last returned match when the per-file cap cut it.
  more?: true;
};

export type ProjectSearchResult =
  | {
      code: "results";
      project: ProjectFileIdentity;
      query: string;
      mode: ProjectSearchMode;
      files: ProjectSearchFileMatch[];
      matches: ProjectSearchTextMatch[];
      scannedEntries: number;
      readFiles: number;
      // Files whose regex scan exceeded its time limit and were skipped.
      regexTimeouts: number;
      truncated: ProjectSearchTruncation | null;
      continueAfter: string | null;
      elapsedMs: number;
    }
  | { code: "invalid-pattern"; project: ProjectFileIdentity; query: string; mode: "regex"; reason: string };
