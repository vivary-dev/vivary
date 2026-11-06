import { agentNativePath } from "@agent-native/core/client/api-path";
import type { VivaryChatIdentity } from "./chat-scope";
import type { NativeActionCaller } from "./native-actions";

export function nativeChatSelectionKey(storageKey: string): string {
  return "vivary-chat-selection-v1:" + btoa(storageKey)
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function savedNativeThreadIsAvailable(
  identity: VivaryChatIdentity,
  threadId: string,
  call: NativeActionCaller,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const params = new URLSearchParams({ scopeType: identity.scope.type, scopeId: identity.scope.id });
  const response = await request(
    `${agentNativePath(`/_agent-native/agent-chat/threads/${encodeURIComponent(threadId)}`)}?${params}`,
    { credentials: "same-origin", signal },
  );
  if (response.ok) {
    const thread: unknown = await response.json();
    if (!thread || typeof thread !== "object" || !("id" in thread) || thread.id !== threadId)
      throw new Error("The saved conversation could not be verified.");
    return !("archivedAt" in thread && thread.archivedAt != null);
  }
  if (response.status !== 404) throw new Error("The saved conversation could not be verified.");
  // Optimistic empty threads have no Native row. The existing draft owner
  // records their ID before navigation, including cleared empty drafts.
  const draft = await call<{ record: unknown }>("vivary-chat-draft", {
    operation: "read", kind: identity.kind, projectId: identity.projectId, threadId,
  });
  return draft.record != null;
}
