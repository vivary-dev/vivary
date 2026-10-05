import { isCodeAgentRunActive, useChatThreads } from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, useActionQuery } from "@agent-native/core/client/hooks";
import { ChatHistoryList, ChatHistoryMenuItem, useChatHistoryRailController } from "@agent-native/toolkit/chat-history";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@agent-native/toolkit/ui";
import { IconArchive, IconArchiveOff, IconChevronDown, IconDots, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import type { VivaryCodeState } from "../../../server/local-code-agent";
import type { ArchivedNativeChat } from "../../../server/native-archive";
import { codeDraftSelectionKey } from "../../../shared/code-draft";
import { useChatDraftList } from "@/lib/chat-draft";
import type { VivaryChatIdentity } from "@/lib/chat-scope";
import { useNativeActionCaller } from "@/lib/native-actions";
import { focusAfterRemoval } from "@/lib/row-focus";
import { useProjects } from "../projects/ProjectContext";
import { useVivaryChatIdentity } from "./use-vivary-chat-identity";
import { CodeHistory } from "./CodeHistory";

// One navigation token for every mounted sidebar. The hidden desktop sidebar stays mounted beside the narrow sheet,
// so the latest navigation from either one must cancel a pending navigation in the other.
const sharedNavigationGeneration = { current: 0 };

export function ProjectHistory() {
  const query = useVivaryChatIdentity();
  if (!query.identity) return <>
    <CodeHistory />
    {query.isError && <p role="alert">Native history could not be opened.
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry history</Button></p>}
  </>;
  return <SessionHistory key={query.identity.storageKey} identity={query.identity} />;
}

function SessionHistory({ identity }: { identity: VivaryChatIdentity }) {
  const { activeProject, checking, workspaceAvailable, historyAvailable } = useProjects();
  const projectId = activeProject?.projectId ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const { call } = useNativeActionCaller();
  const creationGeneration = sharedNavigationGeneration;
  const latestLocationKey = useRef(location.key);
  latestLocationKey.current = location.key;
  const creatingNative = useRef(false);
  useEffect(() => () => { creationGeneration.current++; }, [identity.storageKey]);
  const params = new URLSearchParams(location.search);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [failedAction, setFailedAction] = useState<{ message: string; retry: () => Promise<boolean> }>();
  const native = useChatThreads(undefined, identity.storageKey, identity.scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  const state = useActionQuery<VivaryCodeState>("vivary-code-state", { projectId: projectId ?? undefined }, {
    enabled: historyAvailable, refetchInterval: 1000,
    placeholderData: previous => previous?.projectId === projectId ? previous : undefined,
  });
  const code = historyAvailable && state.data?.projectId === projectId ? state.data : undefined;
  const draftList = useChatDraftList({ kind: identity.kind, projectId: identity.projectId },
    identity.storageKey, historyAvailable);
  const codeDraftList = useChatDraftList({ kind: "code", projectId },
    identity.storageKey + ":code", historyAvailable);
  const recentCodeRunIds = new Set(code?.runs.map(run => run.id));
  const refreshThreads = native.refreshThreads;
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
  const sessions = [
    ...(code?.runs ?? []).map(run => ({ id: `code:${run.id}`, title: run.title || "Untitled conversation",
      subtitle: run.engineLabel, timestamp: isCodeAgentRunActive(run) ? "Working" : undefined,
      updatedAt: Date.parse(run.updatedAt), pinned: false })),
    ...native.threads.filter(thread => thread.messageCount > 0 && !thread.archivedAt).map(thread => ({
      id: `native:${thread.id}`, title: thread.title || thread.preview || "Untitled conversation",
      titleText: thread.title || thread.preview || "Untitled conversation",
      subtitle: "Native chat", timestamp: undefined, updatedAt: thread.updatedAt, pinned: Boolean(thread.pinnedAt),
    })),
    ...(draftList.data?.drafts ?? []).filter(draft => !native.threads.some(thread =>
      thread.id === draft.threadId && thread.messageCount > 0)).map(draft => ({
      id: `native:${draft.threadId}`, title: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
      titleText: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
      subtitle: "Native chat", timestamp: draft.status === "pending" ? "Review send" : "Draft", updatedAt: draft.createdAt, pinned: false,
    })),
    ...(codeDraftList.data?.drafts ?? []).filter(draft => draft.run && !recentCodeRunIds.has(draft.run.id))
      .map(draft => ({ id: `code:${draft.run!.id}`, title: draft.run!.title, titleText: draft.run!.title,
        subtitle: draft.run!.engineLabel, timestamp: "Saved follow-up", updatedAt: Date.parse(draft.run!.updatedAt), pinned: false })),
    ...(codeDraftList.data?.drafts ?? []).filter(draft => !draft.run)
      .flatMap(draft => {
        const key = codeDraftSelectionKey(projectId, draft.threadId);
        return key ? [{ id: `code-draft:${key}`, title: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
          titleText: draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft"),
          subtitle: "Code conversation", timestamp: draft.status === "pending" ? "Review send" : "Draft", updatedAt: draft.createdAt, pinned: false }] : [];
      }),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const isNative = params.get("runtime") === "native";
  const selected = isNative
    ? params.get("history") === "unassigned" ? null : `native:${params.get("thread") ?? native.activeThreadId}`
    : params.get("run") === "new" ? (params.get("draft") ? `code-draft:${params.get("draft")}` : null)
      : `code:${params.get("run") ?? code?.runs.find(isCodeAgentRunActive)?.id ?? code?.run?.id}`;
  function newCode() {
    creationGeneration.current++;
    setMenuOpen(false);
    navigate("/?run=new&draft=" + crypto.randomUUID());
  }
  async function newNative() {
    if (creatingNative.current) return;
    creatingNative.current = true;
    const generation = ++creationGeneration.current;
    const locationKey = location.key;
    const stillCurrent = () => generation === creationGeneration.current
      && latestLocationKey.current === locationKey;
    setMenuOpen(false);
    setError(undefined);
    try {
      const threadId = await native.createThread();
      if (!stillCurrent()) return;
      if (!threadId) throw new Error("No conversation ID was created.");
      const scope = { kind: identity.kind, projectId: identity.projectId, threadId };
      // An empty Native conversation has no server thread row. Record its exact
      // optimistic ID with the existing draft owner before opening the route.
      const initialized = await call<{ changed: boolean; record: { status: string } | null }>(
        "vivary-chat-draft", { operation: "change", ...scope, expected: null,
          next: { status: "cleared", text: "", submitId: null } });
      if (!stillCurrent()) return;
      if (!initialized.changed || initialized.record?.status !== "cleared") throw new Error("Draft initialization failed.");
      navigate(`/?runtime=native&history=project&thread=${encodeURIComponent(threadId)}`);
    } catch {
      if (stillCurrent()) setError("The conversation could not be saved. Try again.");
    } finally {
      creatingNative.current = false;
    }
  }
  const history = useChatHistoryRailController({ items: sessions,
    onNewChat: () => { if (isNative && params.get("history") !== "unassigned") void newNative(); else newCode(); },
    labels: { newChat: "New conversation", showMore: "More conversations", showLess: "Fewer conversations" },
  });
  const codeFailed = state.isError || code?.error || (state.data && !code);
  // Issue #131. Archive removes its row, and the menu trigger that focus would return to. After a confirmed archive,
  // once the row is gone, focus moves to the row that took its place, else the row before it, else New conversation.
  // Archiving the open chat opens a new one, whose composer takes focus instead. A key or pointer press after Archive
  // was chosen means the owner has moved on, and then focus stays where it is.
  const historySection = useRef<HTMLElement>(null);
  const [archivedRow, setArchivedRow] = useState<{ id: string; index: number; claim: ArchiveFocusClaim }>();
  const archiveFocusClaim = useRef<ArchiveFocusClaim | null>(null);
  useEffect(() => {
    // Capture runs before the menu item's own handlers, so the press that chooses Archive is not counted.
    const ownerActed = () => { if (archiveFocusClaim.current) archiveFocusClaim.current.moveFocus = false; };
    document.addEventListener("keydown", ownerActed, true);
    document.addEventListener("pointerdown", ownerActed, true);
    return () => {
      document.removeEventListener("keydown", ownerActed, true);
      document.removeEventListener("pointerdown", ownerActed, true);
    };
  }, []);
  useEffect(() => {
    if (!archivedRow || history.visibleItems.some(item => item.id === archivedRow.id)) return;
    setArchivedRow(undefined);
    if (archiveFocusClaim.current === archivedRow.claim) archiveFocusClaim.current = null;
    if (!archivedRow.claim.moveFocus) return;
    const section = historySection.current;
    focusAfterRemoval([...(section?.querySelectorAll<HTMLElement>(".an-chat-history-row__button") ?? [])], archivedRow.index,
      section?.querySelector<HTMLElement>(".an-chat-history-rail__new-chat") ?? null)?.focus();
  }, [archivedRow, history.visibleItems]);
  async function updateNative(action: () => Promise<boolean>, message: string) {
    setFailedAction(undefined);
    try {
      if (await action()) return;
    } catch {
      // Native restores its optimistic state; retain the action for retry.
    }
    setFailedAction({ message, retry: action });
  }
  function isOpenNativeChat(threadId: string) {
    const route = new URLSearchParams(window.location.search);
    return route.get("runtime") === "native" && route.get("history") !== "unassigned" && route.get("thread") === threadId;
  }
  async function archiveNative(threadId: string) {
    const archived = await native.archiveThread(threadId);
    if (archived && isOpenNativeChat(threadId)) navigate("/");
    return archived;
  }
  function openNative(threadId: string) {
    creationGeneration.current++;
    native.switchThread(threadId);
    navigate(`/?runtime=native&history=project&thread=${encodeURIComponent(threadId)}`);
  }
  async function restoreNative(threadId: string, open: boolean) {
    // Every restore takes the navigation token, so a later restore cancels an earlier restore and open still in flight.
    const generation = ++creationGeneration.current;
    const locationKey = latestLocationKey.current;
    await call<{ restored: true }>("vivary-native-archive", { operation: "restore", projectId: identity.projectId, threadId });
    window.dispatchEvent(new CustomEvent("agent-chat:threads-updated"));
    if (!open || generation !== creationGeneration.current || latestLocationKey.current !== locationKey) return false;
    openNative(threadId);
    return true;
  }
  function selectSession(id: string) {
    if (!sessions.some(item => item.id === id)) return;
    const [runtime, ...parts] = id.split(":");
    const recordId = parts.join(":");
    if (runtime === "native") return openNative(recordId);
    creationGeneration.current++;
    if (runtime === "code-draft") navigate(`/?run=new&draft=${encodeURIComponent(recordId)}`);
    else navigate(`/?run=${encodeURIComponent(recordId)}`);
  }
  const loading = checking || (state.isLoading && native.isLoading);
  return <section ref={historySection} className="vivary-chat-history" aria-label="Project conversations">
    {failedAction && <div role="alert">
      <p>{failedAction.message}</p>
      <Button variant="ghost" size="sm" onClick={() => void updateNative(failedAction.retry, failedAction.message)}>Retry change</Button>
    </div>}
    {(error || codeFailed || native.threadsLoadError || draftList.isError || codeDraftList.isError) && <div role="alert">
      <p>{error ?? "Some conversations could not be loaded. Your history is preserved."}</p>
      <Button variant="ghost" size="sm" onClick={() => { setError(undefined); void state.refetch(); void draftList.refetch(); void codeDraftList.refetch(); refreshThreads(); }}>Retry history</Button>
    </div>}
    {loading || history.visibleItems.length === 0 ? <ChatHistoryList items={[]} onSelect={selectSession} variant="rail" className="an-chat-history-rail"
      loading={loading}
      loadingLabel={<div className="vivary-history-skeleton" role="status"><span className="sr-only">Opening conversations</span><span /><span /><span /></div>}
      emptyLabel="No conversations yet." /> : history.visibleItems.map(item => {
        const thread = native.threads.find(thread => item.id === `native:${thread.id}`);
        return <ChatHistoryList key={item.id} items={[item]} activeId={selected} onSelect={selectSession}
          variant="rail" className="an-chat-history-rail [&_.an-chat-history__list]:py-0"
          renameMaxLength={160}
          onRename={thread ? (_id, title) => void updateNative(() => native.renameThread(thread.id, title), "The conversation could not be renamed. Try again.") : undefined}
          onTogglePin={thread ? () => void updateNative(() => native.pinThread(thread.id, !thread.pinnedAt), "The conversation pin could not be changed. Try again.") : undefined}
          renderAdditionalRowActions={thread ? (row, closeMenu) => <ChatHistoryMenuItem onSelect={() => {
            closeMenu();
            const index = history.visibleItems.findIndex(visible => visible.id === row.id);
            const claim = { moveFocus: !isOpenNativeChat(thread.id) };
            archiveFocusClaim.current = claim;
            void updateNative(async () => {
              const archived = await archiveNative(thread.id);
              // Only a confirmed archive asks to move focus, so a failed one leaves no request behind.
              if (archived) setArchivedRow({ id: row.id, index, claim });
              return archived;
            }, "The conversation could not be archived. Try again.");
          }}><IconArchive size={13} aria-hidden /><span>Archive</span></ChatHistoryMenuItem> : undefined} />;
      })}
      <div className="an-chat-history-rail__footer">
        <Button variant="ghost" size="sm" className="an-chat-history-rail__new-chat" disabled={!workspaceAvailable} onClick={history.onNewChat}>
          <IconPlus size={14} aria-hidden />New conversation</Button>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}><PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Choose conversation runtime" disabled={!workspaceAvailable}><IconChevronDown size={14} /></Button>
        </PopoverTrigger><PopoverContent className="w-60 p-2" align="start">
          <Button variant="ghost" className="w-full justify-start" onClick={newCode}>Code conversation</Button>
          <Button variant="ghost" className="w-full justify-start" onClick={() => void newNative()}>Native chat</Button>
        </PopoverContent></Popover>
        {history.canExpand && <Button variant="ghost" size="icon" aria-label={history.disclosureLabel} aria-expanded={history.expanded} onClick={history.toggleExpanded}><IconDots size={14} /></Button>}
      </div>
      <ArchivedConversations storageKey={identity.storageKey} projectId={identity.projectId}
        onRestore={restoreNative} onOpen={openNative} />
  </section>;
}

/**
 * Set when Archive is chosen. `moveFocus` starts false for the open chat, whose replacement takes focus, and turns false
 * on the owner's next key or pointer press.
 */
type ArchiveFocusClaim = { moveFocus: boolean };

type RestoreNotice =
  | { kind: "restored"; threadId: string; title: string }
  | { kind: "failed"; message: string; retry?: () => void };

// Restores run one at a time across every mounted sidebar. The hidden desktop sidebar stays mounted beside the narrow
// sheet, so a lock per instance would let two restores overlap.
// Every instance reads the same pending state, so each shows busy while any restore runs.
let restoreInFlight = false;
const restoreListeners = new Set<() => void>();
function setRestoreInFlight(value: boolean) {
  restoreInFlight = value;
  for (const listener of restoreListeners) listener();
}
function subscribeRestore(listener: () => void) {
  restoreListeners.add(listener);
  return () => { restoreListeners.delete(listener); };
}
const readRestoreInFlight = () => restoreInFlight;

function ArchivedConversations({ storageKey, projectId, onRestore, onOpen }: { storageKey: string; projectId: string | null;
  onRestore: (threadId: string, open: boolean) => Promise<boolean>; onOpen: (threadId: string) => void }) {
  const { call, ready } = useNativeActionCaller();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<RestoreNotice>();
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  // An earlier restore can never navigate, set the notice, or strand focus after a later one. A click while one is in
  // flight is ignored, and every mounted section reads as busy.
  const busy = useSyncExternalStore(subscribeRestore, readRestoreInFlight, readRestoreInFlight);
  const enabled = open && ready;
  const archived = useQuery({
    queryKey: ["vivary-native-archive", storageKey],
    queryFn: () => call<{ threads: ArchivedNativeChat[] }>("vivary-native-archive", { operation: "list", projectId }),
    enabled, retry: false, staleTime: 0,
  });
  const refetch = archived.refetch;
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void refetch();
    window.addEventListener("agent-chat:threads-updated", refresh);
    return () => window.removeEventListener("agent-chat:threads-updated", refresh);
  }, [enabled, refetch]);
  const threads = archived.data?.threads ?? [];
  // A chat archived again after its restore is listed below, so its old Restored line would contradict the list.
  const restored = notice?.kind === "restored" && !threads.some(thread => thread.id === notice.threadId)
    ? notice : undefined;
  async function restore(threadId: string, title: string, openChat: boolean, focusId: string | undefined) {
    if (restoreInFlight) return;
    setRestoreInFlight(true);
    setNotice(undefined);
    const origin = document.activeElement;
    let opened: boolean;
    try {
      opened = await onRestore(threadId, openChat);
      if (!opened) setNotice({ kind: "restored", threadId, title });
    } catch (failure) {
      // Only the action's own 404 message is a refusal. A proxy's 404 page is a transport fault a retry can clear.
      const refusal = failure instanceof Error && "status" in failure && failure.status === 404
        ? actionErrorMessage(failure) : undefined;
      setNotice(refusal ? { kind: "failed", message: refusal }
        : { kind: "failed", message: "The conversation could not be restored. Try again.",
          retry: () => void restore(threadId, title, openChat, focusId) });
      return;
    } finally {
      setRestoreInFlight(false);
    }
    // Only a Restore-only action moves focus. An opened chat takes focus through navigation, and a restore and open
    // that another navigation superseded must not pull focus back into the sidebar.
    if (openChat) return;
    const section = details.current;
    const focused = document.activeElement;
    // A slow restore must not pull focus back from wherever the owner moved it, inside the section or out of it.
    if (!section?.isConnected || (focused && focused !== document.body && focused !== origin)) return;
    // A section hidden by the responsive layout cannot take focus, so leave focus to the visible sidebar.
    if (section.getClientRects().length === 0) return;
    const next = [...section.querySelectorAll<HTMLElement>("[data-restore]")].find(button => button.dataset.restore === focusId);
    (next ?? summary.current)?.focus();
  }
  return <details ref={details} className="workspace-saved-conversations" aria-busy={busy || undefined}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary ref={summary}>Archived conversations</summary>
    <div role="status">{restored && <>
      <p>Restored: {restored.title}</p>
      <Button variant="ghost" size="sm" aria-label={`Open ${restored.title}`} onClick={() => onOpen(restored.threadId)}>Open</Button>
    </>}</div>
    {notice?.kind === "failed" && <div role="alert">
      <p>{notice.message}</p>
      {notice.retry && <Button variant="ghost" size="sm" onClick={notice.retry}>Retry restore</Button>}
    </div>}
    {archived.isError ? <div role="alert">
      <p>Archived conversations could not be loaded.</p>
      <Button variant="ghost" size="sm" onClick={() => void refetch()}>Retry history</Button>
    </div> : archived.isPending ? <div className="vivary-history-skeleton" role="status">
      <span className="sr-only">Opening archived conversations</span><span /><span /><span />
    </div> : threads.length === 0 ? <p>No archived conversations.</p>
      : <div className="an-chat-history an-chat-history--rail an-chat-history-rail"><div className="an-chat-history__list an-chat-history__section">
        {threads.map((thread, index) => {
          const title = thread.title || "Untitled conversation";
          const focusId = (threads[index + 1] ?? threads[index - 1])?.id;
          return <div key={thread.id} className="an-chat-history-row flex items-center">
            <button type="button" className="an-chat-history-row__button min-w-0 flex-1" aria-label={`Restore and open ${title}`}
              onClick={() => void restore(thread.id, title, true, focusId)}>
              <div className="an-chat-history-row__topline"><span className="an-chat-history-row__title">{title}</span></div>
              <div className="an-chat-history-row__subtitle">Native chat</div>
            </button>
            <Button variant="ghost" size="sm" data-restore={thread.id} aria-label={`Restore ${title}`}
              onClick={() => void restore(thread.id, title, false, focusId)}><IconArchiveOff size={13} aria-hidden />Restore</Button>
          </div>;
        })}
      </div></div>}
  </details>;
}
