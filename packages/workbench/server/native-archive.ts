import { fail } from "@agent-native/core/action";
import { getThread, listThreads, setThreadArchived } from "@agent-native/core/server";
import type { VivaryChatIdentity } from "../app/lib/chat-scope";
import { threadBelongsToChatIdentity } from "./chat-identity";

export type ArchivedNativeChat = { id: string; title: string; archivedAt: number };

const PAGE_SIZE = 200;

// Core has no archived-only filter, so read every page of this scope.
export async function listArchivedNativeChats(identity: VivaryChatIdentity, ownerEmail: string,
  orgId: string): Promise<ArchivedNativeChat[]> {
  const archived = new Map<string, ArchivedNativeChat>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await listThreads(ownerEmail, { scope: identity.scope, orgId, includeArchived: true,
      includeExternal: false, limit: PAGE_SIZE, offset });
    for (const thread of page) {
      if (thread.archivedAt !== null) {
        archived.set(thread.id, { id: thread.id, title: thread.title || thread.preview, archivedAt: thread.archivedAt });
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return [...archived.values()].sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function restoreArchivedNativeChat(identity: VivaryChatIdentity, threadId: string,
  ownerEmail: string, orgId: string): Promise<void> {
  const thread = await getThread(threadId);
  // Core's owner filter is case-sensitive, so pass the stored owner after the case-insensitive check.
  if (!thread || !threadBelongsToChatIdentity(identity, thread, ownerEmail, orgId)
    || !await setThreadArchived(threadId, false, { ownerEmail: thread.ownerEmail })) {
    fail("This conversation does not belong to the selected workspace.", { statusCode: 404 });
  }
}
