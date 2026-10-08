export type ConversationReference = { kind: "code" | "native"; id: string };
export type LinkedHistoryPortion = { entries: number; characters: number; truncated: boolean };
export type PreparedLinkedContext = {
  block: string;
  portion: LinkedHistoryPortion & { linkId: string; boundaryDigest: string };
};
export type LinkedHistoryPage = {
  source: ConversationReference;
  sourceTitle: string;
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
