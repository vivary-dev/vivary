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
  /**
   * Whether the original conversation still exists for this owner. An unavailable source that is still reachable has a
   * frozen prefix that no longer verifies. One that is not was deleted, replaced or is no longer authorized.
   */
  sourceReachable: boolean;
  /**
   * Whether the original is a Native conversation archived after linking. Its frozen history still supplies, but the
   * notice does not open it, because an archived conversation is restored from Archived conversations before editing.
   */
  sourceArchived: boolean;
  /** False when the source is unavailable or the target's resumed provider session already holds the block. */
  nextSendSupplies: boolean;
  /** What the next send's block holds: the latest entries that fit, ending at the boundary. */
  nextSend: LinkedHistoryPortion;
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
