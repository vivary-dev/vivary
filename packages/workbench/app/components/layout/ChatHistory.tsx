import { useChatThreads } from "@agent-native/core/client/agent-chat";
import { ChatHistoryList } from "@agent-native/toolkit/chat-history";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import type { VivaryChatIdentity as ChatIdentity } from "@/lib/chat-scope";
import { useChatDraftList } from "@/lib/chat-draft";

export function ChatHistory({ identity }: { identity: ChatIdentity }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const {
    threads,
    activeThreadId,
    switchThread,
    pinThread,
    archiveThread,
    renameThread,
    refreshThreads,
    isLoading,
    threadsLoadError,
  } = useChatThreads(undefined, identity.storageKey, identity.scope, {
    autoCreate: false,
    restoreActiveThread: false,
    isolateHistoryByScope: true,
    includeExternal: false,
  });
  const draftList = useChatDraftList({ kind: "unassigned", projectId: null }, identity.storageKey, true);
  const visibleThreads = threads
    .filter((thread) => thread.messageCount > 0 && !thread.archivedAt)
    .sort(
      (a, b) =>
        (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt,
    )
    .slice(0, 15);
  const savedIds = new Set(visibleThreads.map(thread => thread.id));
  const items = [
    ...visibleThreads.map(thread => ({
      id: thread.id, title: thread.title || thread.preview || "Untitled chat",
      titleText: thread.title || thread.preview || "Untitled chat",
      pinned: Boolean(thread.pinnedAt), updatedAt: thread.updatedAt, saved: true,
    })),
    ...(draftList.data?.drafts ?? []).filter(draft => !savedIds.has(draft.threadId)).map(draft => ({
      id: draft.threadId, title: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
      titleText: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
      subtitle: draft.status === "pending" ? "Review send" : "Draft",
      pinned: false, updatedAt: draft.createdAt, saved: false,
    })),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, 15);
  const routeThread =
    new URLSearchParams(location.search).get("runtime") === "native"
      && new URLSearchParams(location.search).get("history") === "unassigned"
      ? new URLSearchParams(location.search).get("thread")
      : null;

  useEffect(() => {
    window.addEventListener("agent-chat:threads-updated", refreshThreads);
    window.addEventListener("agentNative.chatRunning", refreshThreads);
    window.addEventListener("focus", refreshThreads);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refreshThreads);
      window.removeEventListener("agentNative.chatRunning", refreshThreads);
      window.removeEventListener("focus", refreshThreads);
    };
  }, [refreshThreads]);

  function openThread(threadId: string) {
    switchThread(threadId);
    navigate(`/?runtime=native&history=unassigned&thread=${encodeURIComponent(threadId)}`);
  }

  async function archive(threadId: string) {
    setError(undefined);
    if (!(await archiveThread(threadId))) {
      setError("The conversation could not be archived. Try again.");
      return;
    }
    const current = new URLSearchParams(window.location.search);
    if (current.get("runtime") === "native" && current.get("history") === "unassigned"
      && current.get("thread") === threadId) navigate("/");
  }

  async function rename(threadId: string, title: string) {
    setError(undefined);
    if (!(await renameThread(threadId, title)))
      setError("The conversation could not be renamed. Try again.");
  }

  async function togglePin(threadId: string) {
    setError(undefined);
    const thread = visibleThreads.find((item) => item.id === threadId);
    if (thread && !(await pinThread(threadId, !thread.pinnedAt))) {
      setError("The conversation could not be pinned. Try again.");
    }
  }

  return (
    <section className="vivary-chat-history" aria-label="Chat history">
      {(threadsLoadError || draftList.isError) && <div role="alert">
        <p>Some conversations could not be loaded. Your history is preserved.</p>
        <Button variant="ghost" size="sm" onClick={() => {
          refreshThreads(); void draftList.refetch();
        }}>Try again</Button>
      </div>}
      {(isLoading || draftList.isLoading || items.length === 0)
        ? <ChatHistoryList
          items={[]}
          activeId={routeThread ?? activeThreadId}
          onSelect={openThread}
          loading={isLoading || draftList.isLoading}
          loadingLabel={<div className="vivary-history-skeleton" role="status">
            <span className="sr-only">Opening chat history</span><span /><span /><span />
          </div>}
          emptyLabel="No conversations yet."
          variant="rail" className="an-chat-history-rail" />
        : items.map(item => <ChatHistoryList
          key={item.id}
          items={[item]}
          activeId={routeThread ?? activeThreadId}
          onSelect={openThread}
          onTogglePin={item.saved ? threadId => void togglePin(threadId) : undefined}
          onRename={item.saved ? (threadId, title) => void rename(threadId, title) : undefined}
          onDelete={item.saved ? threadId => void archive(threadId) : undefined}
          renameMaxLength={160}
          variant="rail"
          className="an-chat-history-rail"
          labels={{
            options: row => `Options for ${row.titleText}`,
            renameInput: row => `Rename ${row.titleText}`,
            rename: "Rename",
            pin: "Pin",
            unpin: "Unpin",
            delete: "Archive",
          }} />)}
      {error && (
        <p className="px-2 py-2 text-xs text-destructive" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
