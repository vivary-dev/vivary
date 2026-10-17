import { LINKED_TARGET_SOURCE_URL } from "../../shared/linked-conversation";

/** The Native history rows a project history shows: saved threads, then drafts of conversations not yet listed. */
export function nativeHistoryRows<
  Thread extends { id: string; title: string; messageCount: number; archivedAt?: unknown; source?: { url?: string | null } | null },
  Draft extends { threadId: string },
>(threads: Thread[], drafts: Draft[]): { threads: Thread[]; drafts: Draft[] } {
  // An empty linked target is listed before its first send, so it can be found again. Its durable thread source,
  // not its renameable title, identifies it.
  const listed = threads.filter(thread => (thread.messageCount > 0 || thread.source?.url === LINKED_TARGET_SOURCE_URL) && !thread.archivedAt);
  // A draft row stands for a conversation with no row of its own. Both kinds share the key native:<threadId>.
  // An archived thread keeps its draft out of the active rows, so archiving never recreates it as a draft.
  return { threads: listed, drafts: drafts.filter(draft => !threads.some(thread => thread.id === draft.threadId
    && (thread.messageCount > 0 || Boolean(thread.archivedAt) || listed.includes(thread)))) };
}
