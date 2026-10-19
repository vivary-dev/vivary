import { useEffect } from "react";
import { useChatThreads, type ChatThreadScope } from "@agent-native/core/client/agent-chat";
import "../../local-agent.css";

/**
 * The API chat's compact header, matching the Code conversation header: the thread title over a muted line. The title
 * is Core's own thread title, which already prefers a manual rename (`_titleOverride`). It refreshes on the same events
 * the history list uses (thread updates, run changes and window focus), so a rename or a newly generated title shows here too.
 */
export function NativeConversationHeader({ storageKey, scope, threadId, detail }: {
  storageKey: string; scope: ChatThreadScope | null; threadId: string | null; detail: string;
}) {
  const native = useChatThreads(undefined, storageKey, scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  const refreshThreads = native.refreshThreads;
  useEffect(() => {
    window.addEventListener("agent-chat:threads-updated", refreshThreads);
    window.addEventListener("agentNative.chatRunning", refreshThreads);
    // A rename in another window reaches this one when it regains focus, as in the history list.
    window.addEventListener("focus", refreshThreads);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refreshThreads);
      window.removeEventListener("agentNative.chatRunning", refreshThreads);
      window.removeEventListener("focus", refreshThreads);
    };
  }, [refreshThreads]);
  const thread = threadId ? native.threads.find(item => item.id === threadId) : undefined;
  const title = thread?.title || thread?.preview || "New conversation";
  return <header className="local-agent-header">
    <div className="local-agent-heading">
      {/* Focusable so a keyboard user can show the full title, which hover shows through the title attribute. */}
      <h2 title={title} tabIndex={0}>{title}</h2>
      <p>{detail}</p>
    </div>
  </header>;
}
