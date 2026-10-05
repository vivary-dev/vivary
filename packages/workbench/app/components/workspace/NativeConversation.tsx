import { AgentChatSurface } from "@agent-native/core/client/agent-chat";
import { Skeleton } from "@agent-native/toolkit/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readClientAppState } from "@agent-native/core/client/hooks";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useVivaryChatIdentity } from "@/components/layout/use-vivary-chat-identity";
import { resolveNativeHistoryKind } from "@/lib/native-history-route";
import { registerSelectionCloseFlush, trackSelectionWrite, useNativeChatDraft } from "@/lib/chat-draft";
import { nativeChatSelectionKey, savedNativeThreadIsAvailable } from "@/lib/native-chat-selection";
import { useNativeActionCaller } from "@/lib/native-actions";
import { useAppStateWriter } from "@/lib/native-state";
import { useProjects } from "../projects/ProjectContext";

export default function NativeConversation() {
  const [params] = useSearchParams();
  const history = params.get("history");
  if (history !== "project" && history !== "unassigned") return <ResolveHistory params={params} />;
  return <ScopedConversation unassigned={history === "unassigned"} />;
}

function OpeningConversation() {
  return <div className="flex h-full min-h-0 flex-col gap-4 p-4" role="status">
    <span className="sr-only">Opening the conversation</span><Skeleton className="h-9 w-48" />
    <Skeleton className="min-h-0 flex-1" /><Skeleton className="h-24 w-full" />
  </div>;
}

function ResolveHistory({ params }: { params: URLSearchParams }) {
  const threadId = params.get("thread");
  const legacy = useVivaryChatIdentity("unassigned");
  const identity = legacy.identity;
  const probe = useQuery({
    queryKey: ["native-history-route", identity?.storageKey, threadId],
    queryFn: ({ signal }) => {
      if (!threadId || !identity) throw new Error("The conversation owner could not be verified.");
      return resolveNativeHistoryKind(threadId, identity.scope, signal);
    },
    enabled: Boolean(threadId && identity), retry: false,
  });
  const kind = threadId ? probe.data : "project";
  if (kind && (!threadId || identity)) {
    const next = new URLSearchParams(params);
    next.set("history", kind);
    return <Navigate to={{ search: next.toString() }} replace />;
  }
  if (legacy.isError || probe.isError || (!identity && !legacy.waiting)) return <div className="panel-empty" role="alert">
    <h1>Conversation could not open</h1>
    <p>Vivary could not verify this conversation's history. Its messages are preserved.</p>
    <Button variant="outline" onClick={() => { void legacy.refetch(); void probe.refetch(); }}>Retry history</Button>
  </div>;
  return <OpeningConversation />;
}

function ScopedConversation({ unassigned }: { unassigned: boolean }) {
  const query = useVivaryChatIdentity(unassigned ? "unassigned" : "project");
  const { workspaceAvailable, checking, catalog } = useProjects();
  if (!query.identity) {
    if (checking || query.waiting) return <OpeningConversation />;
    return <div className="panel-empty" role="alert"><h1>Conversation could not open</h1>
      <p>Vivary could not verify this conversation's project. Its history is preserved.</p>
      <Button variant="outline" onClick={() => void query.refetch()}>Retry history</Button></div>;
  }
  return <DraftedConversation key={query.identity.storageKey} identity={query.identity} unassigned={unassigned}
    workspaceAvailable={workspaceAvailable} ownerKey={catalog?.scopeKey ?? ""} />;
}

function DraftedConversation({ identity, unassigned, workspaceAvailable, ownerKey }: {
  ownerKey: string;
  identity: NonNullable<ReturnType<typeof useVivaryChatIdentity>["identity"]>;
  unassigned: boolean;
  workspaceAvailable: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedThread = params.get("thread");
  const selectionKey = nativeChatSelectionKey(identity.storageKey);
  const queryClient = useQueryClient();
  const selection = useQuery({
    queryKey: ["vivary-chat-selection", selectionKey],
    queryFn: ({ signal }) => readClientAppState(selectionKey, { signal }),
    retry: false, staleTime: Infinity,
  });
  const savedSelection = selection.data as { storageKey?: unknown; threadId?: unknown } | null;
  const savedThread = savedSelection?.storageKey === identity.storageKey
    && typeof savedSelection.threadId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(savedSelection.threadId)
      ? savedSelection.threadId : null;
  const { call, ready: draftOwnerReady, sessionStatus, retrySession } = useNativeActionCaller();
  const savedThreadCheck = useQuery({
    queryKey: ["vivary-chat-saved-thread", selectionKey, savedThread],
    queryFn: ({ signal }) => savedNativeThreadIsAvailable(identity, savedThread!, call, signal),
    enabled: !selectedThread && !!savedThread && draftOwnerReady,
    retry: false,
  });
  const threadUrlSync = useMemo(() => ({
    routeThreadId: selectedThread,
    getPath: (threadId: string | null) => {
      const next = new URLSearchParams(params);
      if (threadId) next.set("thread", threadId);
      else next.delete("thread");
      const search = next.toString();
      return location.pathname + (search ? "?" + search : "");
    },
    navigate: (path: string, options?: { replace?: boolean }) =>
      navigate(path, { replace: options?.replace }),
  }), [selectedThread, params.toString(), location.pathname, navigate]);
  const { ready: selectionWriterReady, writeAppState } = useAppStateWriter();
  const [selectionSaveError, setSelectionSaveError] = useState(false);
  const selectionSaveFailed = useRef(false);
  const latestThread = useRef<string | null>(null);
  const savingThread = useRef<Promise<void> | null>(null);
  const saveLatestThread = useCallback((): Promise<void> => {
    if (savingThread.current) return savingThread.current;
    if (!latestThread.current) return Promise.resolve();
    if (!selectionWriterReady) return Promise.reject(new Error("The Native session is not ready to save the selection."));
    const write = (async () => {
      try {
        while (latestThread.current) {
          const threadId = latestThread.current;
          const value = { storageKey: identity.storageKey, threadId };
          await writeAppState(selectionKey, value, { keepalive: true });
          queryClient.setQueryData(["vivary-chat-selection", selectionKey], value);
          selectionSaveFailed.current = false;
          setSelectionSaveError(false);
          if (latestThread.current === threadId) latestThread.current = null;
        }
      } catch (error) {
        selectionSaveFailed.current = true;
        setSelectionSaveError(true);
        throw error;
      }
    })();
    const tracked = trackSelectionWrite(write);
    savingThread.current = tracked;
    void tracked.finally(() => { if (savingThread.current === tracked) savingThread.current = null; }).catch(() => {});
    return tracked;
  }, [identity.storageKey, queryClient, selectionKey, selectionWriterReady, writeAppState]);
  useEffect(() => registerSelectionCloseFlush(saveLatestThread,
    () => latestThread.current !== null || savingThread.current !== null || selectionSaveFailed.current), [saveLatestThread]);
  useEffect(() => {
    if (selectedThread || !selection.isSuccess || !savedThread
      || !savedThreadCheck.isSuccess || savedThreadCheck.isFetching || !savedThreadCheck.data) return;
    setParams(current => { const next = new URLSearchParams(current); next.set("thread", savedThread); return next; }, { replace: true });
  }, [selectedThread, selection.isSuccess, savedThread,
    savedThreadCheck.isSuccess, savedThreadCheck.isFetching, savedThreadCheck.data, setParams]);
  useLayoutEffect(() => {
    if (!selectedThread) return;
    latestThread.current = selectedThread;
    void saveLatestThread().catch(() => {});
  }, [selectedThread, saveLatestThread]);
  const draft = useNativeChatDraft({ kind: identity.kind, projectId: identity.projectId }, ownerKey);
  const [restoreReview, setRestoreReview] = useState<string | null>(null);
  useEffect(() => { setRestoreReview(null); }, [selectedThread]);
  const error = selectedThread ? draft.statusForThread(selectedThread) : null;
  const draftSaveStatus = selectedThread ? draft.draftSaveStatusForThread(selectedThread) : null;
  if (!selectedThread && savedThread && !draftOwnerReady && sessionStatus !== "loading")
    return <div className="panel-empty" role="alert">
      <h1>Conversation could not open</h1>
      <p>The Native session could not be verified. Your saved conversation is preserved.</p>
      <Button variant="outline" onClick={retrySession}>Retry session</Button>
    </div>;
  if (!selectedThread && (selection.isPending || (selection.isSuccess && savedThread
    && (!draftOwnerReady || savedThreadCheck.isPending || savedThreadCheck.isFetching
      || (savedThreadCheck.isSuccess && savedThreadCheck.data))))) return <OpeningConversation />;
  if (!selectedThread && (selection.isError || savedThreadCheck.isError)) return <div className="panel-empty" role="alert">
    <h1>Conversation could not open</h1>
    <p>Vivary could not load your last conversation. Its history is preserved.</p>
    <Button variant="outline" onClick={() => {
      void selection.refetch(); void savedThreadCheck.refetch();
    }}>Retry history</Button>
  </div>;
  return <section aria-label="Native chat" className="flex h-full min-h-0 w-full flex-col">
    {selectionSaveError && <div className="local-agent-notice" role="alert">
      <span>Your conversation selection could not be saved.</span>
      <Button variant="outline" size="sm" onClick={() => void saveLatestThread().catch(() => {})}>Retry selection</Button>
    </div>}
    {!error && selectedThread && draftSaveStatus && <div className="local-agent-notice" role="status">
      <span>{draftSaveStatus === "saved" ? "Draft saved for this conversation." : "Saving draft…"}</span>
      <Button variant="ghost" size="sm" onClick={() => void draft.discard(selectedThread)}>Discard draft</Button>
    </div>}
    {error && selectedThread && <div className="local-agent-notice" role="alert">
      <span>{error}</span>
      <Button variant="outline" size="sm" onClick={() => draft.retry(selectedThread)}>{draft.hasConflictForThread(selectedThread)
        ? "Reload saved draft" : draft.hasFailedDiscardForThread(selectedThread) ? "Retry discard" : "Retry draft"}</Button>
      {draft.hasPendingForThread(selectedThread) && (restoreReview === selectedThread
        ? <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="I checked this conversation and queued follow-ups"
            onChange={event => { if (event.target.checked) setRestoreReview(selectedThread + ":checked");
              else setRestoreReview(selectedThread); }} />
          I checked this conversation and queued follow-ups. The message could still appear later, so sending this draft again could duplicate it.
        </label>
        : restoreReview === selectedThread + ":checked"
          ? <Button variant="outline" size="sm" onClick={() => {
            setRestoreReview(null);
            void draft.restorePending(selectedThread);
          }}>Restore draft for editing</Button>
          : <Button variant="outline" size="sm" onClick={() => setRestoreReview(selectedThread)}>
            Review before restoring
          </Button>)}
      <Button variant="ghost" size="sm" onClick={() => void draft.discard(selectedThread)}>Discard draft</Button>
    </div>}
    <AgentChatSurface key={identity.storageKey} mode="page" className="min-h-0 flex-1"
      storageKey={identity.storageKey} scope={identity.scope} isolateHistoryByScope
      contextNamespace={`vivary-native:${identity.storageKey}`}
      agentChatSurface="app" chatOnly codeAccess={{ enabled: false }}
      hostComposerDraft={draft.hostComposerDraft}
      composerDisabled={!unassigned && !workspaceAvailable}
      composerDisabledPlaceholder="Reconnect this project before continuing. Saved history remains available."
      showHeader={false} showTabBar={false} restoreActiveThread={false}
      threadUrlSync={threadUrlSync} />
  </section>;
}
