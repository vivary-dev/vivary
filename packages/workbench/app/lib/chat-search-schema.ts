import { z } from "zod";

export const chatSearchInputSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().default(null),
  unassigned: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  query: z.string().trim().min(2).max(160),
  after: z.string().max(4096).optional(),
}).strict().refine(input => !input.unassigned || input.projectId === null, "Unassigned history has no project.");
export type ChatSearchInput = z.infer<typeof chatSearchInputSchema>;
export type ChatSearchHit = {
  projectId: string | null;
  projectLabel: string;
  sessionId: string;
  title: string;
  runtime: "native" | "code";
  referenceId: string;
  eventOffset?: number;
  sessionUpdatedAt?: number;
  matchedAt?: string;
  excerpt: string;
  match: "content" | "title";
  archived: boolean;
};
export type ChatSearchPage = {
  results: ChatSearchHit[];
  continueAfter: string | null;
  scannedSessions: number;
  scannedMessages: number;
  searchedSessions: number;
  totalSessions?: number;
  codeUnavailable?: boolean;
  readBytes: number;
  limited: boolean;
  limits: { sessions: number; messages: number; bytes: number; results: number };
};
