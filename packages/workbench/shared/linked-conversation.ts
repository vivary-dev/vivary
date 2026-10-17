/** Thread source URL that marks a Native link target. Core never overwrites a thread's source, and rename changes only the title. */
export const LINKED_TARGET_SOURCE_URL = "vivary:linked-conversation";
export type ConversationReference = { kind: "code" | "native"; id: string };
export type LinkedHistoryPortion = { entries: number; characters: number; truncated: boolean };
/** A null block means the source is unavailable and the send proceeds without linked context. */
export type PreparedLinkedContext = {
  block: string;
  portion: LinkedHistoryPortion & { linkId: string; boundaryDigest: string };
} | { block: null; portion: null };
export type LinkedHistoryPage = {
  source: ConversationReference;
  sourceTitle: string;
  /** Unavailable means the source was deleted, revoked or no longer verifies. Nothing is supplied. */
  sourceStatus: "available" | "unavailable";
  boundaryId: string | null;
  availableEntries: number;
  suppliedEntries: number;
  excerpt: string;
  truncated: boolean;
  nextCursor: string | null;
  nativeContinuity: false;
  lastPrepared: LinkedHistoryPortion | null;
  lastAccepted: (LinkedHistoryPortion & { userEventId: string }) | null;
};
export type LinkedConversationResult = { target: ConversationReference; route: string };
