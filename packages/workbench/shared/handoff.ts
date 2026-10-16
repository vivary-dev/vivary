import type { ConversationReference } from "./linked-conversation";

/**
 * The project version a handoff covers. Git projects record HEAD, the branch,
 * and the dirty entries with each one's size and modified time. Other
 * projects record the bounded file listing. The designated document is
 * excluded from both, because its own version is compared separately.
 */
export type ProjectVersion = {
  kind: "git" | "plain" | "unknown";
  head: string | null;
  ref: string | null;
  /** null when Git could not establish the working tree state. */
  dirty: boolean | null;
  dirtyCount: number;
  dirtyDigest: string;
  filesDigest: string;
  /** The listing hit its cap, so an unlisted change cannot be seen. */
  truncated: boolean;
};
export type CoveredBoundary = { ref: ConversationReference; boundaryId: string | null; boundaryBytes: number | null; prefixDigest: string };
export type HandoffFacts = {
  requestId: string;
  path: string;
  documentVersion: string;
  project: ProjectVersion;
  conversation: CoveredBoundary;
  /** The link this conversation was opened from. Its boundary never changes, so it is recorded, not compared. */
  linked: { linkId: string; source: ConversationReference; boundaryId: string | null; boundaryDigest: string } | null;
};
export type HandoffCheck = { name: string; outcome: "passed" | "failed" | "not-run"; evidenceEventId: string | null };
export type HandoffProposal = {
  requestId: string; goal: string; decisions: string[]; changes: string[]; checks: HandoffCheck[];
  unfinished: string[]; risks: string[]; nextAction: string;
};
export type HandoffRecord = HandoffProposal & { facts: HandoffFacts; savedVersion: string; savedAt: string };
export type StaleReason = "document-edited" | "head-moved" | "tree-changed" | "files-changed" | "events-appended" | "history-changed";
export type HandoffUnavailable = {
  status: "unavailable";
  reason: "no-state-role" | "state-missing" | "state-private" | "settings-unavailable";
  message: string;
};
export type HandoffFreshness =
  | { status: "none"; path: string }
  | HandoffUnavailable
  | { status: "pending"; requestId: string; conversation: ConversationReference; covered: HandoffRecord | null }
  | { status: "failed"; requestId: string; conversation: ConversationReference; message: string; covered: HandoffRecord | null }
  | { status: "fresh" | "out-of-date" | "unverifiable"; covered: HandoffRecord; reasons: StaleReason[] };
export type HandoffInput = { projectId: string; conversation: ConversationReference };
export type HandoffPrepareResult = { code: "prepared"; requestId: string; facts: HandoffFacts; message: string } | HandoffUnavailable;
export type HandoffSaveInput = HandoffInput & { requestId: string };
export type HandoffSaveResult =
  | { code: "saved"; record: HandoffRecord }
  | { code: "refused"; problems: string[] }
  | { code: "conflict"; reason: "changed" | "renamed-or-deleted" | "project-changed"; message: string }
  | { code: "failed"; message: string }
  | HandoffUnavailable;

export const STALE_REASON_TEXT: Record<StaleReason, string> = {
  "document-edited": "STATE.md was edited",
  "head-moved": "the Git commit or branch changed",
  "tree-changed": "the set of changed files changed",
  "files-changed": "project files changed",
  "events-appended": "the conversation has newer completed work",
  "history-changed": "the covered conversation history changed or is unavailable",
};
