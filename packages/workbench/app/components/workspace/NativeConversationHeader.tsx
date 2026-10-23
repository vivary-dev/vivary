import { useEffect, useState } from "react";
import { useChatThreads, type ChatThreadScope } from "@agent-native/core/client/agent-chat";
import { agentNativePath } from "@agent-native/core/client/api-path";
import "../../local-agent.css";

type ThreadTitle = { id: string; title: string; preview: string };

/** Core's thread read for one thread by ID, scoped as the history list is. Null when it is missing or unreadable. */
async function readThreadTitle(threadId: string, scope: ChatThreadScope | null): Promise<ThreadTitle | null> {
  const params = new URLSearchParams();
  if (scope) { params.set("scopeType", scope.type); params.set("scopeId", scope.id); }
  const query = params.toString();
  try {
    const response = await fetch(`${agentNativePath("/_agent-native/agent-chat")}/threads/${encodeURIComponent(threadId)}${query ? "?" + query : ""}`);
    if (!response.ok) return null;
    const data = await response.json() as { title?: unknown; preview?: unknown };
    return { id: threadId, title: typeof data.title === "string" ? data.title : "", preview: typeof data.preview === "string" ? data.preview : "" };
  } catch {
    return null;
  }
}

/**
 * The API chat's compact header, matching the Code conversation header: the thread title over a muted line. The title
 * is Core's own thread title, which already prefers a manual rename (`_titleOverride`). It refreshes on the same events
 * the history list uses (thread updates, run changes and window focus), so a rename or a newly generated title shows here too.
 * A thread outside the list's loaded page, such as one opened from search or a link, is read directly by its ID.
 */
export function NativeConversationHeader({ storageKey, scope, threadId, detail }: {
  storageKey: string; scope: ChatThreadScope | null; threadId: string | null; detail: string;
}) {
  const native = useChatThreads(undefined, storageKey, scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  const refreshThreads = native.refreshThreads;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { refreshThreads(); setRevision(value => value + 1); };
    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", refresh);
    // A rename in another window reaches this one when it regains focus, as in the history list.
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshThreads]);
  const listed = threadId ? native.threads.find(item => item.id === threadId) : undefined;
  const listedFound = !!listed;
  const [direct, setDirect] = useState<ThreadTitle | null>(null);
  const scopeKey = scope ? scope.type + ":" + scope.id : "";
  useEffect(() => {
    if (!threadId || listedFound) return;
    let current = true;
    void readThreadTitle(threadId, scope).then(thread => { if (current) setDirect(thread); });
    return () => { current = false; };
  }, [threadId, listedFound, scopeKey, revision]);
  const thread = listed ?? (direct?.id === threadId ? direct : undefined);
  const title = thread?.title || thread?.preview || "New conversation";
  return <header className="local-agent-header">
    <div className="local-agent-heading">
      {/* Focusable so a keyboard user can show the full title, which hover shows through the title attribute. */}
      <h2 title={title} tabIndex={0}>{title}</h2>
      <p>{detail}</p>
    </div>
  </header>;
}
