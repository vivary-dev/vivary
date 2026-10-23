import { changeIndexedChatDraft, createCodeDraftIdentity, readChatDraft } from "./chat-draft";
import type { CancelledQueuedTurn } from "./local-code-agent.ts";

/**
 * Puts a cancelled queued message back in its conversation's draft. The queued turn wrote no transcript entry, so a
 * draft that still waits on its submit becomes a plain draft again. An empty or cleared draft takes the message. A draft
 * the owner has typed since stays as it is, and the result says nothing was restored. An unavailable original message
 * never replaces a draft with legacy metadata placeholders. A send without a draft thread, such as one from the API,
 * has no draft to restore.
 */
export async function restoreQueuedCodeDraft(ownerEmail: string, orgId: string | undefined,
  cancelled: CancelledQueuedTurn): Promise<boolean> {
  if (!orgId || !cancelled.draftThreadId) return false;
  const identity = createCodeDraftIdentity(ownerEmail, orgId, cancelled.projectId);
  const current = await readChatDraft(identity, cancelled.draftThreadId);
  const text = current?.status === "pending" && current.submitId === cancelled.draftSubmitId ? current.text
    : !current || current.status === "cleared" || !current.text.trim() ? cancelled.message : null;
  if (text === null) return false;
  const result = await changeIndexedChatDraft(identity, cancelled.draftThreadId, current,
    { text, status: "draft", submitId: null });
  return result.changed;
}
