import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AssistantChat,
  removeAgentChatContextItem,
  ChatHistoryList,
  isCodeAgentRunActive,
  useChatThreads,
  type AssistantChatHandle,
  type AssistantChatProps,
} from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, readClientAppState, useActionQuery } from "@agent-native/core/client/hooks";
import { useNativeActionCaller } from "@/lib/native-actions";
import { useAppStateWriter } from "@/lib/native-state";
import type { VivaryChatIdentity } from "@/lib/chat-scope";
import { newConversationSurface } from "@/lib/conversation-surface";
import { claimNativeConversationCreation } from "@/lib/native-conversation-creation";
import { registerSelectionCloseFlush, trackSelectionWrite, useChatDraftList, useNativeChatDraft } from "@/lib/chat-draft";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@agent-native/toolkit/ui";
import { IconHistory, IconPlus, IconSettings, IconSquare } from "@tabler/icons-react";
import type { VivaryCodeRunState, VivaryCodeSessionDetails, VivaryCodeState } from "../../../server/local-code-agent";
import { codeDraftSelectionKey, codeDraftThreadId } from "../../../shared/code-draft";
import { createLocalCodeChatAdapter } from "../../lib/local-code-chat-adapter";
import { codeConversationModelChoices } from "../../lib/code-conversation-model-choices";
import { useProjects } from "../projects/ProjectContext";
import { useOpenProjectFolder } from "../projects/open-project-folder";
import { folderRunTargets, type FolderRun } from "../../lib/code-folder-runs";
import { holdConversationRoute } from "../../lib/conversation-route-hold";
import { SHARED_FOLDER_WARNING } from "../../../shared/code-concurrency";
import { useVivaryChatIdentity } from "../layout/use-vivary-chat-identity";
import "@agent-native/toolkit/chat-history.css";
import "../../local-agent.css";
import mascotUrl from "../../assets/vivary-mascot.svg";
import { ConversationMatch } from "./ConversationMatch";
import { CodeLinkOptions, LinkedHistoryNotice, sourceDraftSaver } from "./LinkedConversation";
import { HandoffControl } from "./HandoffControl";
import "./HandoffDisplay";
import { HandoffStatusContext, createHandoffStatusHub } from "./handoff-status";
import { createHistoryReadAdapter } from "@/lib/history-read-adapter";
import { codeMatchRepository, codeMatchMessageId } from "@/lib/code-match-repository";
import "../../chat-search.css";

import { previewInspectionContext, type PreviewChatTarget } from "@/lib/workbench-preview";

type PreviewChatProps = { previewScope: string; onPreviewChatTarget?: (target: PreviewChatTarget | null) => void };

type ModelChoice = { engine: VivaryCodeState["defaultEngine"]; model: string };
/** A conversation to open, possibly in another project. */
type RunTarget = { id: string; projectId: string | null };
/** Another conversation working in this conversation's folder. Another owner's has no title and cannot be opened. */
const conversationSelectionSchema = z.object({
  key: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).nullable(),
  choice: z.object({ engine: z.enum(["claude-cli", "codex-cli"]), model: z.string().min(1).max(200) }).optional(),
});
type ConversationSelection = z.infer<typeof conversationSelectionSchema>;
const SELECTION_PREFIX = "vivary-code-selection-v1:";
const example = "Read README.md, then create hello-vivary.txt containing a short greeting. Read the file back and tell me what you changed.";

export default function CodeConversation({ previewScope, onPreviewChatTarget }: PreviewChatProps) {
  const { activeProject, catalog, checking, workspaceAvailable, historyAvailable, refresh, selectProject } = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { ready: stateWriterReady, retrySession, sessionStatus, writeAppState } = useAppStateWriter();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const unassigned = searchParams.get("history") === "unassigned";
  const canReadHistory = unassigned || historyAvailable;
  const projectId = unassigned ? null : activeProject?.projectId ?? null;
  const projectScope = [catalog?.scopeKey, unassigned ? "unassigned" : projectId ?? "personal"].join(":");
  const selectionKey = SELECTION_PREFIX + projectScope;
  const selection = useQuery({
    queryKey: [selectionKey], enabled: canReadHistory && !checking,
    staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const parsed = conversationSelectionSchema.safeParse(await readClientAppState(selectionKey, { signal }));
      return parsed.success ? parsed.data : null;
    },
  });
  const saveSelection = useMutation({
    scope: { id: SELECTION_PREFIX },
    mutationFn: ({ key, value }: { key: string; value: ConversationSelection | null }) =>
      writeAppState(key, value, { keepalive: true }),
  });
  const pendingCodeSelections = useRef(new Map<string, ConversationSelection | null>());
  const savingCodeSelections = useRef<Promise<void> | null>(null);
  const codeSelectionFailed = useRef(false);
  const writerReadyRef = useRef(stateWriterReady);
  writerReadyRef.current = stateWriterReady;
  const saveRef = useRef(saveSelection.mutateAsync);
  saveRef.current = saveSelection.mutateAsync;
  const drainCodeSelections = useCallback((): Promise<void> => {
    if (savingCodeSelections.current) return savingCodeSelections.current;
    if (pendingCodeSelections.current.size === 0) return Promise.resolve();
    if (!writerReadyRef.current) return Promise.reject(new Error("The Native session is not ready to save the Code selection."));
    const write = (async () => {
      try {
        while (pendingCodeSelections.current.size) {
          const [key, value] = pendingCodeSelections.current.entries().next().value!;
          await saveRef.current({ key, value });
          if (pendingCodeSelections.current.get(key) === value) pendingCodeSelections.current.delete(key);
        }
        codeSelectionFailed.current = false;
      } catch (error) {
        codeSelectionFailed.current = true;
        throw error;
      }
    })();
    const tracked = trackSelectionWrite(write);
    savingCodeSelections.current = tracked;
    void tracked.finally(() => { if (savingCodeSelections.current === tracked) savingCodeSelections.current = null; }).catch(() => {});
    return tracked;
  }, []);
  const queueCodeSelection = useCallback((key: string, value: ConversationSelection | null) => {
    pendingCodeSelections.current.set(key, value);
    return drainCodeSelections();
  }, [drainCodeSelections]);
  useEffect(() => registerSelectionCloseFlush(drainCodeSelections,
    () => pendingCodeSelections.current.size > 0 || savingCodeSelections.current !== null || codeSelectionFailed.current),
  [drainCodeSelections]);
  const setSelection = useCallback<Dispatch<SetStateAction<ConversationSelection | null>>>(update => {
    const previous = queryClient.getQueryData<ConversationSelection | null>([selectionKey]) ?? null;
    const next = typeof update === "function" ? update(previous) : update;
    if (next === previous) return;
    queryClient.setQueryData([selectionKey], next);
    void queueCodeSelection(selectionKey, next).catch(() => {});
  }, [queryClient, selectionKey, queueCodeSelection, stateWriterReady]);

  async function openActiveConversation(active: RunTarget) {
    // A run in another project: the project change unmounts this view, then Workspace clears the route and the new
    // project restores its saved view. The page's route hold lives outside this view and keeps the clicked run's route.
    if (active.projectId !== projectId) {
      const release = holdConversationRoute(active.projectId, "/?run=" + encodeURIComponent(active.id));
      if (!await selectProject(active.projectId)) {
        release();
        return false;
      }
    }
    const key = SELECTION_PREFIX + [catalog?.scopeKey, active.projectId ?? "personal"].join(":");
    const next = { key: active.id, runId: active.id };
    await queryClient.cancelQueries({ queryKey: [key], exact: true });
    queryClient.setQueryData([key], next);
    void queueCodeSelection(key, next).catch(() => {});
    if (mounted.current) setSearchParams({ run: active.id }, { replace: true });
    return true;
  }

  if (checking || sessionStatus === "loading" || (canReadHistory && selection.isPending)) {
    return <div className="local-agent-chat-skeleton" aria-busy="true">
      <Skeleton className="h-8 w-48" /><Skeleton className="h-5 w-3/4" />
      <Skeleton className="mt-auto h-28 w-full" />
    </div>;
  }
  if (!stateWriterReady) return <section className="local-agent-page" aria-label="Vivary agent">
    <div className="local-agent-notice" role="alert">
      <span>{sessionStatus === "signing-out"
        ? "Signing out. Conversation selection is no longer being saved."
        : sessionStatus === "unauthenticated"
          ? "Sign in before using the Vivary agent."
          : "Your Native session could not be verified."}</span>
      {(sessionStatus === "unavailable" || sessionStatus === "authenticated")
        && <Button variant="ghost" size="sm" onClick={retrySession}>Retry session</Button>}
    </div>
  </section>;
  if (!canReadHistory) return null;
  if (selection.isError) return <section className="local-agent-page" aria-label="Vivary agent">
    <div className="local-agent-notice" role="alert">
      <span>Your conversation selection could not be loaded.</span>
      <Button variant="ghost" size="sm" onClick={() => void selection.refetch()}>Retry</Button>
    </div>
  </section>;

  return <>
    {saveSelection.isError && <div className="local-agent-notice" role="alert">
      <span>Your conversation selection could not be saved.</span>
      <Button variant="ghost" size="sm" onClick={() => void drainCodeSelections().catch(() => {})}>Retry</Button>
    </div>}
    <ProjectCodeWorkspace key={projectScope} projectId={projectId} draftScopeKey={projectScope}
      ownerKey={catalog?.scopeKey ?? ""}
      projectLabel={activeProject?.displayName} workspaceAvailable={workspaceAvailable} onOpenActive={openActiveConversation}
      selection={selection.data ?? null} setSelection={setSelection} previewScope={previewScope} onPreviewChatTarget={onPreviewChatTarget} />
  </>;
}

type NativeThreadCreatorHandle = Pick<ReturnType<typeof useChatThreads>, "createThread">;

// useChatThreads has no enabled option. Mount its owner only with a resolved project identity,
// keeping an unavailable identity from loading unscoped history or remounting the Code composer.
function NativeThreadCreator({ identity, creatorRef }: { identity: VivaryChatIdentity; creatorRef: RefObject<NativeThreadCreatorHandle | null> }) {
  const { createThread } = useChatThreads(undefined, identity.storageKey, identity.scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  useImperativeHandle(creatorRef, () => ({ createThread }), [createThread]);
  return null;
}

function ProjectCodeWorkspace({ projectId, draftScopeKey, ownerKey, projectLabel, workspaceAvailable, selection, setSelection, onOpenActive, previewScope, onPreviewChatTarget }: PreviewChatProps & {
  projectId: string | null;
  draftScopeKey: string;
  ownerKey: string;
  projectLabel?: string;
  workspaceAvailable: boolean;
  selection: ConversationSelection | null;
  setSelection: Dispatch<SetStateAction<ConversationSelection | null>>;
  onOpenActive: (active: RunTarget) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeProject } = useProjects();
  const chatIdentity = useVivaryChatIdentity();
  const newSurface = newConversationSurface(activeProject?.projectId === projectId ? activeProject.workspaceKind : null, "code");
  const identity = chatIdentity.identity?.kind === "project" && chatIdentity.identity.projectId === projectId
    ? chatIdentity.identity : null;
  const nativeCreator = useRef<NativeThreadCreatorHandle | null>(null);
  const creatingNative = useRef(false);
  const creationGeneration = useRef(0);
  const latestLocationKey = useRef(location.key);
  latestLocationKey.current = location.key;
  useEffect(() => () => { creationGeneration.current++; }, [location.key, identity?.storageKey, newSurface, workspaceAvailable]);
  const requestedRun = searchParams.get("run");
  const requestedDraft = searchParams.get("draft");
  const unassigned = searchParams.get("history") === "unassigned";
  const requestedEvent = searchParams.get("event");
  const requestedOffset = searchParams.get("eventOffset");
  const matchContainer = useRef<HTMLElement>(null);
  const anchor = requestedEvent && requestedOffset !== null && /^\d+$/.test(requestedOffset)
    ? { eventId: requestedEvent, eventOffset: Number(requestedOffset) } : undefined;
  const requestKey = requestedRun === "new" ? "new:" + requestedDraft : requestedRun;
  const handledRequest = useRef<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [notice, setNotice] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const mounted = useRef(false);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const state = useActionQuery<VivaryCodeState>("vivary-code-state", { projectId: projectId ?? undefined, ...(unassigned ? { unassigned: true } : {}) }, {
    refetchInterval: 1000,
    placeholderData: previous => previous?.projectId === projectId ? previous : undefined,
  });
  const codeState = state.data?.projectId === projectId ? state.data : undefined;
  const draftList = useChatDraftList({ kind: "code", projectId }, draftScopeKey, !!codeState);
  const runToLoad = requestedRun === "new" ? null : requestedRun ?? selection?.runId;
  const selectedState = useActionQuery<VivaryCodeState>("vivary-code-state", { projectId: projectId ?? undefined, runId: runToLoad ?? undefined,
    ...(unassigned ? { unassigned: true } : {}), ...anchor }, {
    enabled: !!runToLoad && (runToLoad !== codeState?.run?.id || !!anchor),
    refetchInterval: 1000,
  });
  const selectedRun = selectedState.data?.projectId === projectId ? selectedState.data.run : null;
  const { call } = useNativeActionCaller();
  const stop = useMutation({ mutationFn: (params: {runId: string; projectId?: string}) => call<VivaryCodeState>("vivary-code-stop", params) });
  const run = anchor && selection?.runId === selectedRun?.id ? selectedRun
    : !anchor && selection?.runId === codeState?.run?.id ? codeState?.run
    : selection?.runId === selectedRun?.id ? selectedRun : null;
  const matchMessageId = useMemo(() => {
    if (!requestedEvent || !run) return null;
    return codeMatchMessageId(codeMatchRepository(run.events, requestedEvent), requestedEvent);
  }, [requestedEvent, run?.events]);
  // A saved run selected from history uses its run ID as the temporary
  // selection key. Wait for its detail before mounting a draft owner with
  // that fallback ID. A newly started run keeps its original draft UUID
  // mounted while the accepted send settles.
  const openingSavedRun = !!selection?.runId && selection.key === selection.runId && !run;
  // Conversations run concurrently. Only this conversation's own run locks its composer and owns its Stop.
  const activeRuns = codeState?.activeRuns ?? [];
  const ownActiveRun = activeRuns.find(item => item.id === selection?.runId) ?? null;
  const stopAuthority = useRef({ requestedEvent, unassigned, ownActiveRun });
  stopAuthority.current = { requestedEvent, unassigned, ownActiveRun };
  const otherWorking = activeRuns.filter(item => item.id !== selection?.runId).length;
  const folderRuns = folderRunTargets(codeState?.folderRuns ?? [], activeRuns, selection?.runId, projectId);
  const folderIsolation = useOpenProjectFolder();
  const error = notice ?? codeState?.error
    ?? (newSurface === "native" && chatIdentity.isError ? "Native chat identity could not be loaded. Try again." : undefined)
    ?? (selectedState.isError && (anchor || selection?.runId !== codeState?.run?.id) ? "This conversation could not be loaded. Choose a conversation from history or retry." : undefined)
    ?? (state.data && !codeState ? "The project changed. Refresh this workspace before continuing." : undefined)
    ?? actionErrorMessage(state.error)
    ?? (state.error ? "The workspace could not be loaded." : undefined);

  const showInUrl = useCallback((next: ConversationSelection) => {
    if (!mounted.current) return;
    creationGeneration.current++;
    handledRequest.current = next.runId ?? "new:" + next.key;
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      if (params.get("run") !== next.runId) { params.delete("event"); params.delete("eventOffset"); }
      params.set("run", next.runId ?? "new");
      if (next.runId) params.delete("draft");
      else params.set("draft", next.key);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (!codeState) return;
    if (requestKey && handledRequest.current !== requestKey) {
      if (requestedRun === "new") {
        handledRequest.current = requestKey;
        setNotice(undefined);
        const key = requestedDraft && /^[A-Za-z0-9_-]{1,128}$/.test(requestedDraft)
          ? requestedDraft : crypto.randomUUID();
        if (selection?.key !== key) setSelection({ key, runId: null });
        if (requestedDraft !== key) showInUrl({ key, runId: null });
        return;
      }
      if (requestedRun && (selection?.runId === requestedRun || selectedRun?.id === requestedRun || codeState.runs.some(item => item.id === requestedRun))) {
        handledRequest.current = requestKey;
        setNotice(undefined);
        if (selection?.runId !== requestedRun) setSelection({ key: requestedRun, runId: requestedRun });
        return;
      }
      if (selectedState.isPending || selectedState.isFetching) return;
      handledRequest.current = requestKey;
      setNotice("This conversation is not available in the selected workspace.");
      if (selection) {
        showInUrl(selection);
        return;
      }
    }
    if (selection) {
      if (!requestedRun) showInUrl(selection);
      return;
    }
    const current = codeState.runs.find(isCodeAgentRunActive) ?? codeState.run;
    const next = { key: current?.id ?? crypto.randomUUID(), runId: current?.id ?? null };
    setSelection(next);
    showInUrl(next);
  }, [selection, codeState, selectedRun, selectedState.isPending, selectedState.isFetching, setSelection, requestKey, requestedRun, requestedDraft, showInUrl]);

  const selectConversation = (id: string) => {
    const draftKey = id.startsWith("draft:") ? id.slice("draft:".length) : null;
    const next = draftKey ? { key: draftKey, runId: null } : { key: id, runId: id };
    setSelection(next);
    showInUrl(next);
    setNotice(undefined);
    setHistoryOpen(false);
  };
  const newConversation = async () => {
    if (newSurface === "native") {
      const creator = nativeCreator.current;
      if (creatingNative.current || !identity || !creator || !workspaceAvailable) return;
      const releaseCreation = claimNativeConversationCreation(identity.storageKey);
      if (!releaseCreation) return;
      creatingNative.current = true;
      const generation = ++creationGeneration.current;
      const locationKey = location.key;
      const stillCurrent = () => mounted.current && generation === creationGeneration.current
        && latestLocationKey.current === locationKey;
      setNotice(undefined);
      try {
        const threadId = await creator.createThread();
        if (!stillCurrent()) return;
        if (!threadId) throw new Error("No conversation ID was created.");
        // Match ProjectHistory: an optimistic Native ID has no thread row yet. Acknowledge its
        // cleared draft through the existing owner before opening the route, keeping Code selected.
        const initialized = await call<{ changed: boolean; record: { status: string } | null }>(
          "vivary-chat-draft", { operation: "change", kind: identity.kind, projectId: identity.projectId, threadId,
            expected: null, next: { status: "cleared", text: "", submitId: null } });
        if (!stillCurrent()) return;
        if (!initialized.changed || initialized.record?.status !== "cleared") throw new Error("Draft initialization failed.");
        navigate(`/?runtime=native&history=project&thread=${encodeURIComponent(threadId)}`);
      } catch {
        if (stillCurrent()) setNotice("The conversation could not be saved. Try again.");
      } finally {
        creatingNative.current = false;
        releaseCreation();
      }
      return;
    }
    const next = { key: crypto.randomUUID(), runId: null };
    setSelection(next);
    showInUrl(next);
    setNotice(undefined);
  };
  const onStarted = useCallback((key: string, runId: string) => {
    setSelection(current => current?.key === key ? { ...current, runId } : current);
    if (currentSelection.current?.key === key) showInUrl({ key, runId });
  }, [setSelection, showInUrl]);

  // Stops the selected conversation's run, never another conversation's.
  async function stopRun() {
    // A retained streaming callback must use current view authority. Folder loss does not revoke Stop.
    const { requestedEvent, unassigned, ownActiveRun } = stopAuthority.current;
    if (requestedEvent || unassigned || !ownActiveRun) return false;
    setNotice(undefined);
    try {
      const result = await stop.mutateAsync({ projectId: ownActiveRun.projectId ?? undefined, runId: ownActiveRun.id });
      if (result.error) throw new Error(result.error);
      await state.refetch();
      return true;
    } catch (failure) {
      setNotice(actionErrorMessage(failure) ?? (failure instanceof Error ? failure.message : "The agent could not stop."));
      return false;
    }
  }

  const history = (codeState?.runs ?? [])
    .filter(item => item.title.toLowerCase().includes(historySearch.trim().toLowerCase()))
    .map(item => ({
      id: item.id,
      title: item.title,
      subtitle: item.engineLabel + (item.model ? " · " + item.model : ""),
      timestamp: isCodeAgentRunActive(item) ? "Working" : item.status,
    }));
  const recentRunIds = new Set(codeState?.runs.map(item => item.id));
  for (const draft of draftList.data?.drafts ?? []) {
    if (!draft.run || recentRunIds.has(draft.run.id)) continue;
    if (draft.run.title.toLowerCase().includes(historySearch.trim().toLowerCase())) {
      history.push({ id: draft.run.id, title: draft.run.title, subtitle: draft.run.engineLabel,
        timestamp: "Saved follow-up" });
    }
  }
  for (const draft of draftList.data?.drafts ?? []) {
    if (draft.run) continue;
    const key = codeDraftSelectionKey(projectId, draft.threadId);
    const title = draft.preview || (draft.status === "pending" ? "Review send" : "Unsent draft");
    if (key && title.toLowerCase().includes(historySearch.trim().toLowerCase())) {
      history.push({ id: "draft:" + key, title,
        subtitle: "Code conversation", timestamp: draft.status === "pending" ? "Review send" : "Draft" });
    }
  }

  const openRun = (target: RunTarget) => {
    if (target.projectId === projectId) selectConversation(target.id);
    else void onOpenActive(target).then(opened => {
      if (!opened) setNotice("That conversation's project could not be opened. You can still stop its agent from the top of Vivary.");
    });
  };
  const conversationNotices = <>
    {error && <div className="local-agent-notice" role="alert">
      <span>{error}</span><Button variant="ghost" size="sm" onClick={() => {
        void state.refetch();
        if (selection?.runId) void selectedState.refetch();
        if (newSurface === "native" && !identity) void chatIdentity.refetch();
      }}>Retry</Button>
    </div>}
  </>;

  return <section ref={matchContainer} className="local-agent-page" aria-label="Vivary agent">
    {folderIsolation.kindDialog}
    {newSurface === "native" && identity && <NativeThreadCreator key={identity.storageKey} identity={identity} creatorRef={nativeCreator} />}
    <ConversationMatch key={requestedRun + ":" + requestedEvent} container={matchContainer} messageId={matchMessageId} />
    <header className="local-agent-header">
      <div className="local-agent-heading">
        <h2>{run?.title ?? "New conversation"}</h2>
        <p>{run ? run.engineLabel + " / " + run.model : projectLabel ?? "Personal workspace"}</p>
      </div>
      <div className="local-agent-header-actions">
        {run && !unassigned && <CodeSessionDetails key={run.id} runId={run.id} projectId={projectId} engine={run.engine} model={run.model} switchGeneration={run.switchGeneration} active={isCodeAgentRunActive(run)} />}
        {ownActiveRun ? <Badge variant="secondary" role="status">Working</Badge>
          : otherWorking > 0 && <Badge variant="secondary" role="status">
            {otherWorking === 1 ? "1 other conversation working" : `${otherWorking} other conversations working`}</Badge>}
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Conversation history"><IconHistory size={18} /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="local-agent-history">
            <ChatHistoryList items={history} activeId={selection?.runId ?? (selection ? "draft:" + selection.key : undefined)}
              onSelect={selectConversation} searchValue={historySearch}
              onSearchChange={setHistorySearch} searchPlaceholder="Search conversations"
              loading={state.isLoading}
              loadingLabel={<div className="p-3 space-y-3"><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-full" /></div>}
              error={state.error ? "Conversations could not be loaded." : undefined}
              emptyLabel="Your conversations will appear here." emptySearchLabel="No matching conversations." />
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon" aria-label="New conversation" onClick={newConversation}
          disabled={!workspaceAvailable || !codeState || (streaming && !selection?.runId) || (newSurface === "native" && !identity)}><IconPlus size={18} /></Button>
        <Button variant="ghost" size="icon" aria-label="Runtime settings" onClick={() => navigate("/settings/runtimes")}><IconSettings size={18} /></Button>

      </div>
    </header>
    {(!selection || !codeState || openingSavedRun) && conversationNotices}
    <div className="local-agent-layout">
      <div className="local-agent-chat">
        {selection && codeState && !openingSavedRun ? <LocalCodeConversation key={selection.key}
          notices={conversationNotices} folderRuns={folderRuns} folderIsolation={folderIsolation} onOpenRun={openRun}
          pendingApprovals={ownActiveRun?.pendingApprovals.length ?? 0}
          projectId={projectId} ownerKey={ownerKey} selection={selection} run={run ?? null} previewScope={previewScope} onPreviewChatTarget={onPreviewChatTarget}
          onNewConversation={newConversation} newConversationAvailable={newSurface !== "native" || !!identity}
          state={run && selectedState.data?.projectId === projectId && selectedState.data.run?.id === run.id
            ? { ...codeState, engines: selectedState.data.engines } : codeState}
          workspaceAvailable={workspaceAvailable}
          viewingMatch={!!requestedEvent || unassigned}
          matchedEventId={requestedEvent}
          active={!!ownActiveRun} streaming={streaming} onStreaming={setStreaming}
          onStarted={runId => onStarted(selection.key, runId)}
          onChoice={choice => setSelection(current => current ? { ...current, choice } : current)}
          onSettled={() => { void state.refetch(); }}
          onStop={stopRun} stopping={stop.isPending}
          onSettings={() => navigate("/settings/runtimes")} /> :
          <div className="local-agent-chat-skeleton" aria-busy="true">
            <Skeleton className="h-8 w-48 self-end" /><Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" /><Skeleton className="mt-auto h-28 w-full" />
          </div>}
      </div>

    </div>
  </section>;
}

const continuityLabels: Record<VivaryCodeSessionDetails["continuity"], string> = {
  "new-session": "This turn requested a new provider session.",
  "reconstructed-context": "This turn reconstructed context from the saved conversation.",
  "resume-requested": "This turn requested native resume; the runtime has not confirmed it.",
  "native-resume": "The runtime confirmed native resume for this turn.",
  "not-recorded": "Continuity for the last turn was not recorded.",
};

function CodeSessionDetails({ runId, projectId, engine, model, switchGeneration, active }: {
  runId: string; projectId: string | null; engine: VivaryCodeRunState["engine"]; model: string;
  switchGeneration?: string | null; active: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Completed output may arrive while closed; reopening must revalidate the cached snapshot.
  const details = useActionQuery<VivaryCodeSessionDetails>("vivary-code-state", {
    projectId: projectId ?? undefined, runId, details: true,
  }, { enabled: open, retry: false, staleTime: 0, refetchInterval: open && active && engine === "claude-cli" ? 2_000 : false });
  const route = JSON.stringify([engine, model, switchGeneration ?? null]);
  const finalRefresh = useRef({ runId, projectId, route, wasActive: active, pending: false });
  useEffect(() => {
    const refresh = finalRefresh.current;
    const scopeChanged = refresh.runId !== runId || refresh.projectId !== projectId;
    // A committed switch clears the provider session even when two switches return to the same route between polls.
    const settled = !scopeChanged && ((refresh.wasActive && !active) || refresh.route !== route);
    refresh.runId = runId;
    refresh.projectId = projectId;
    refresh.route = route;
    refresh.wasActive = active;
    if (!open || scopeChanged || active) refresh.pending = false;
    else if (settled) refresh.pending = true;
    // Refetch during the first request can deduplicate into its older snapshot.
    // Retain the final update until it can start a fresh request, then consume it once.
    if (refresh.pending && !details.isFetching) {
      refresh.pending = false;
      void details.refetch();
    }
  }, [active, open, runId, projectId, route, details.isFetching, details.refetch]);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="ghost" size="sm">Session details</Button></PopoverTrigger>
    <PopoverContent align="end" className="w-[min(32rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto space-y-3 text-sm"
      aria-label="Session details">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Session details</h3>
        <Button variant="ghost" size="sm" disabled={details.isFetching}
          onClick={() => { void details.refetch(); }}>Refresh</Button>
      </div>
      {engine === "codex-cli" && active && <p className="text-xs text-muted-foreground">
        Use Refresh to update Codex session details while this run is active.
      </p>}
      {details.isLoading && <p role="status">Loading session details…</p>}
      {details.isError && <div role="alert"><p>Session details could not be loaded.</p>
        <Button variant="ghost" size="sm" onClick={() => { void details.refetch(); }}>Retry</Button></div>}
      {details.data && !details.isError && <>
        <p>{details.data.engineLabel} · <span className="font-mono break-all">{details.data.runId}</span></p>
        <p>{continuityLabels[details.data.continuity]}</p>
        <p>Provider session: {details.data.sessionId ? <code className="break-all">{details.data.sessionId}</code> : "Not reported"}</p>
        <p>{details.data.nextTurn === "native-resume"
          ? "The next message will request resume of this provider session."
          : "The next message will reconstruct context from the saved conversation."}</p>
        <h4 className="font-medium">Native transcript</h4>
        <p className="text-xs font-mono break-all">{details.data.log.reference}</p>
        {details.data.log.status === "missing" ? <p>The transcript log is missing.</p>
          : details.data.log.status === "unavailable" ? <p>The transcript log is unavailable.</p>
          : details.data.log.excerpt ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
            tabIndex={0} aria-label="Native transcript excerpt">{details.data.log.excerpt}</pre>
          : <p>No complete transcript entries are available.</p>}
        {details.data.log.truncated && <p className="text-xs">Showing a bounded excerpt. Some entries or text were omitted.</p>}
        <h4 className="font-medium">Provider session log</h4>
        {details.data.providerLog.reference?.startsWith("codex-thread:") && <p className="text-xs text-muted-foreground">
          Recent turn summaries show the first user and last assistant message per turn. Messages in between are omitted.
        </p>}
        {details.data.providerLog.reference && <p className="text-xs font-mono break-all">{details.data.providerLog.reference}</p>}
        {details.data.providerLog.status === "available"
          ? details.data.providerLog.excerpt ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
            tabIndex={0} aria-label="Provider session excerpt">{details.data.providerLog.excerpt}</pre>
            : <p>No user or assistant text is available.</p>
          : <p>{({ missing: "The provider session log is missing.", unavailable: "The provider session log is unavailable.",
            unsupported: "This provider log location or format is not supported.", malformed: "The provider session log could not be safely interpreted.",
            "too-large": "The provider session log exceeds the inspection limit." })[details.data.providerLog.status]}</p>}
        {details.data.providerLog.truncated && <p className="text-xs">Showing a bounded excerpt. Some messages or text were omitted.</p>}
        <p className="text-xs text-muted-foreground">Provider logs remain with the runtime. Tools, thinking, and private metadata are omitted.</p>
      </>}
    </PopoverContent>
  </Popover>;
}

/** A worktree folder name beside the project folder, from its label, safe to paste into a shell. */
function worktreeCommand(folderLabel: string): string {
  const name = folderLabel.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "project";
  return `git worktree add ../${name}-worktree`;
}

/**
 * The owner's warning before sending in a folder where other conversations' agents work. Proceed sends here anyway.
 * Use another folder opens a separate folder or a Git worktree the owner made. Vivary does not manage worktrees.
 */
function SharedFolderNotice({ runs, acknowledged, folderLabel, isolation, onProceed, onCancel, onOpen }: {
  runs: FolderRun[];
  acknowledged: boolean;
  folderLabel: string;
  isolation: ReturnType<typeof useOpenProjectFolder>;
  onProceed: () => void;
  /** Closes the warning without sending. The draft stays and focus returns to the composer. */
  onCancel: () => void;
  onOpen: (target: RunTarget) => void;
}) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const command = worktreeCommand(folderLabel);
  return <div className="local-agent-notice local-agent-shared-folder" role="group" aria-label="Shared folder"
    onKeyDown={event => {
      if (event.key !== "Escape" || acknowledged) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }}>
    <p role={acknowledged ? undefined : "alert"}>{SHARED_FOLDER_WARNING}</p>
    <ul>
      {runs.map(item => <li key={item.id}>
        {item.title ?? "A conversation of another user"}
        {item.title !== null && <Button variant="ghost" size="sm" onClick={() => onOpen(item)}>Open</Button>}
      </li>)}
    </ul>
    <div className="local-agent-shared-folder-actions">
      {acknowledged ? <span role="status">You chose to work in this folder beside them.</span>
        : <Button size="sm" onClick={onProceed}>Proceed</Button>}
      {isolation.available && <Button size="sm" variant="outline" disabled={isolation.choosing}
        onClick={() => void isolation.openFolder()}>{isolation.choosing ? "Choosing folder…" : "Use another folder"}</Button>}
      {!acknowledged && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
    </div>
    <p className="local-agent-shared-folder-hint">To work in a Git worktree, run this in the project folder, then {isolation.available
      ? "choose Use another folder and pick the new folder" : "connect the new folder as a project"}:</p>
    <div className="local-agent-shared-folder-actions">
      <code>{command}</code>
      <Button variant="ghost" size="sm" onClick={() => {
        // A Remote access page served over plain HTTP has no clipboard API, so a missing one reads as a failed copy.
        void Promise.resolve().then(() => navigator.clipboard.writeText(command))
          .then(() => setCopied("copied"), () => setCopied("failed"));
      }}>Copy</Button>
      {copied && <span role="status">{copied === "copied" ? "Copied." : "Copy failed. Select the command to copy it."}</span>}
    </div>
    {isolation.error && <p role="alert">{isolation.error}</p>}
  </div>;
}

function modelLabel(engine: VivaryCodeState["engines"][number] | undefined, model: string) {
  return engine?.modelCatalog?.status === "ready"
    ? engine.modelCatalog.models.find(item => item.id === model)?.label ?? model
    : engine?.claudeModels?.find(item => item.id === model)?.label ?? model;
}

/** A runtime or model the owner chose for a retained conversation, waiting on a confirm or on its run to stop. */
type PendingSwitch = ModelChoice & {
  step: "confirm" | "confirm-stop" | "stopping" | "switching";
  expectedSwitchGeneration: string | null;
  turnId?: string | null;
};

const SWITCH_TRANSFER = "The new session gets the visible conversation text, up to the last 24 messages. "
  + "Tool output and the previous runtime's private session do not transfer.";

function defaultModelFor(engine: VivaryCodeState["engines"][number]): string {
  return engine.modelCatalog?.status === "ready" ? engine.modelCatalog.defaultModel
    : engine.engine === "claude-cli"
      ? engine.claudeModels?.find(model => model.support === "supported")?.id ?? engine.models[0] ?? "sonnet"
      : "default";
}

type LocalCodeConversationProps = PreviewChatProps & {
  viewingMatch?: boolean;
  matchedEventId?: string | null;
  notices: ReactNode;
  /** Other conversations working in this folder. Sending beside them needs the shared-folder warning's Proceed. */
  folderRuns: FolderRun[];
  /** Open folder, offered by the warning for a separate folder or a Git worktree. */
  folderIsolation: ReturnType<typeof useOpenProjectFolder>;
  onOpenRun: (target: RunTarget) => void;
  /** This conversation's pending Codex requests, answered from the host strip. */
  pendingApprovals: number;
  onNewConversation?: () => void;
  newConversationAvailable?: boolean;
  ownerKey: string;
  projectId: string | null;
  workspaceAvailable: boolean;
  selection: ConversationSelection;
  run: VivaryCodeRunState | null;
  state: VivaryCodeState;
  /** This conversation's own run is working. Another conversation's run never sets it. */
  active: boolean;
  streaming: boolean;
  stopping: boolean;
  onStarted: (runId: string) => void;
  onChoice: (choice: ModelChoice) => void;
  onStreaming: (streaming: boolean) => void;
  onSettled: () => void;
  onStop: () => Promise<boolean>;
  onSettings: () => void;
};

function LocalCodeConversation(observed: LocalCodeConversationProps) {
  const queryClient = useQueryClient();
  const [acceptedRun, setAcceptedRun] = useState<VivaryCodeRunState | null>(null);
  const stateQueryKeys = [
    ["action", "vivary-code-state", { projectId: observed.projectId ?? undefined }],
    ["action", "vivary-code-state", { projectId: observed.projectId ?? undefined, runId: observed.selection.runId ?? undefined }],
  ];
  // After acceptance, both caches contain the reply and all earlier requests have been cancelled. A later snapshot
  // read from those caches is fresh even if another switch happened before the parent could render our generation.
  const observedFromCache = stateQueryKeys.some(queryKey =>
    queryClient.getQueryData<VivaryCodeState>(queryKey)?.run === observed.run);
  const caughtUp = !!acceptedRun && observed.run?.id === acceptedRun.id
    && observedFromCache;
  // Keep the action's full run while parent polling still presents a previous route generation.
  // Its old query requests are cancelled before the accepted state enters either owner cache below.
  const props = acceptedRun && observed.selection.runId === acceptedRun.id && !caughtUp
    ? { ...observed, run: acceptedRun } : observed;
  useEffect(() => {
    if (caughtUp || observed.selection.runId !== acceptedRun?.id) setAcceptedRun(null);
  }, [caughtUp, observed.selection.runId, acceptedRun?.id]);
  const chatRef = useRef<AssistantChatHandle>(null);
  const [handoffStatus] = useState(createHandoffStatusHub);
  const { call } = useNativeActionCaller();
  const latest = useRef(props);
  latest.current = props;
  const readOnly = !!props.viewingMatch || !props.workspaceAvailable;
  const previewContextKey = JSON.stringify(["vivary-preview", props.previewScope, props.selection.key]);
  useEffect(() => {
    const projectId = props.projectId;
    if (!projectId || !props.workspaceAvailable) {
      props.onPreviewChatTarget?.(null);
      return;
    }
    let active = true;
    const contextKey = previewContextKey;
    props.onPreviewChatTarget?.({ projectId, scope: props.previewScope, attach: preview => {
      if (!active || preview.projectId !== projectId || latest.current.previewScope !== props.previewScope || !latest.current.workspaceAvailable || !chatRef.current) return false;
      chatRef.current.setComposerContextItem({
        key: contextKey, title: "Project preview",
        contextNamespace: contextKey,
        context: previewInspectionContext(preview),
      }, { focus: false });
      return true;
    } });
    return () => { active = false; removeAgentChatContextItem(contextKey); props.onPreviewChatTarget?.(null); };
  }, [props.projectId, props.previewScope, previewContextKey, props.workspaceAvailable, props.onPreviewChatTarget]);
  const draftThreadId = props.run?.draftThreadId ?? codeDraftThreadId(props.projectId, props.selection.key);
  const draft = useNativeChatDraft({ kind: "code", projectId: props.projectId }, props.ownerKey);
  const draftError = draft.statusForThread(draftThreadId);
  const [restoreReview, setRestoreReview] = useState(false);
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const runIdRef = useRef(props.selection.runId);
  runIdRef.current = props.selection.runId;
  const adapterOwnsMessages = useRef(false);
  const [choice, setChoice] = useState(props.run ? { engine: props.run.engine, model: props.run.model }
    : props.selection.choice ?? { engine: props.state.defaultEngine, model: props.state.defaultModel });
  // A retained conversation's route is the run's. Only vivary-code-switch changes it, from here or another window.
  useEffect(() => {
    if (props.run) setChoice({ engine: props.run.engine, model: props.run.model });
  }, [props.run?.id, props.run?.engine, props.run?.model]);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const [switchError, setSwitchError] = useState<string>();
  const switchInFlight = pendingSwitch?.step === "stopping" || pendingSwitch?.step === "switching";
  useEffect(() => {
    if (!readOnly) return;
    // Discard unsubmitted consent; an operation already accepted by the host keeps settling.
    setPendingSwitch(current => current?.step === "stopping" || current?.step === "switching" ? current : null);
  }, [readOnly, pendingSwitch?.step]);
  // A recorded target is a display choice, never an accepted Send route or a remembered choice.
  const serverPending = props.run?.pendingSwitch ?? null;
  const shown = (readOnly && !switchInFlight ? null : pendingSwitch) ?? serverPending ?? choice;
  const observationChanged = !!pendingSwitch
    && pendingSwitch.expectedSwitchGeneration !== props.run?.switchGeneration;
  // This conversation's own turn, never another conversation's. A switch waits only for this one.
  const runWorking = props.streaming || (!!props.run && (isCodeAgentRunActive(props.run) || props.run.phase === "stopping"));
  // Polling can start or settle a turn while a choice is open. Derive its legal actions on every render.
  const switchStep = observationChanged ? undefined
    : pendingSwitch?.step === "confirm" ? (runWorking ? "working" : "confirm")
    : pendingSwitch?.step === "confirm-stop" && (!runWorking || pendingSwitch.turnId !== props.run?.turnId)
      ? (runWorking ? "working" : "confirm") : pendingSwitch?.step;
  // Proceed acknowledges the turns working in this folder now, keyed by turn. One that starts later asks again, including
  // a later turn of a conversation that was acknowledged before.
  const [acknowledgedRuns, setAcknowledgedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const unacknowledged = props.folderRuns.filter(item => !acknowledgedRuns.has(item.turnId));
  // Cancel and Escape close the warning for these conversations without acknowledging it. Nothing is sent and the draft
  // stays. A later send meets the server's shared-folder refusal, which opens the warning again.
  const [cancelledRuns, setCancelledRuns] = useState<ReadonlySet<string>>(() => new Set());
  const undecided = unacknowledged.filter(item => !cancelledRuns.has(item.turnId));
  const sharedFolderHeld = undecided.length > 0 && !runWorking;
  const focusComposerAfterCancel = useRef(false);
  const sharedFolderAcknowledged = useRef(false);
  sharedFolderAcknowledged.current = props.folderRuns.length > 0 && unacknowledged.length === 0;

  const createAdapter = useCallback<NonNullable<AssistantChatProps["createAdapter"]>>(context =>
    createLocalCodeChatAdapter({
      context, call, runIdRef, projectId: props.projectId, draftThreadId,
      onKnownRejected: submitId => draft.rejectKnownSubmission(draftThreadId, submitId),
      engines: () => latest.current.state.engines,
      acknowledgeSharedFolder: () => sharedFolderAcknowledged.current,
      onSharedFolderRefused: () => setCancelledRuns(new Set()),
      onStarted: runId => latest.current.onStarted(runId),
      onStreaming: value => {
        if (value) adapterOwnsMessages.current = true;
        latest.current.onStreaming(value);
      },
      onSettled: () => {
        adapterOwnsMessages.current = false;
        latest.current.onSettled();
      },
    }), [props.projectId, call, draftThreadId, draft.rejectKnownSubmission]);
  const loadHistoryRepository = useCallback<NonNullable<AssistantChatProps["loadHistoryRepository"]>>(async () => {
    // Canonical replay uses different message IDs. Import only while history owns
    // this view; replacing live IDs invalidates mounted assistant-ui bindings.
    if (adapterOwnsMessages.current) return null;
    return codeMatchRepository(latest.current.run?.events ?? [], latest.current.matchedEventId);
  }, []);
  const availableModels = useMemo(() => props.state.engines
    .filter(engine => !props.selection.runId || engine.engine === choice.engine)
    .map(engine => ({ ...engine, models: codeConversationModelChoices(engine, Boolean(props.selection.runId),
      engine.engine === choice.engine ? choice.model : undefined) })),
  [props.state.engines, props.selection.runId, choice.engine, choice.model]);
  const selectedEngine = props.state.engines.find(engine => engine.engine === choice.engine);
  const modelChoices = availableModels.find(engine => engine.engine === choice.engine)?.models ?? [];
  // Keep a saved choice even when the catalog changes. Only a deliberate selection replaces it.
  const selectedClaudeModel = selectedEngine?.claudeModels?.find(model => model.id === choice.model);
  const selectedModelAvailable = modelChoices.includes(choice.model)
    && (!selectedClaudeModel || selectedClaudeModel.support === "supported");
  // A retained conversation keeps its model. A new one can switch only to a listed
  // choice that a configured runtime can send.
  const otherModelAvailable = !props.selection.runId && availableModels.some(engine => engine.configured && engine.models.some(model =>
    !(engine.engine === choice.engine && model === choice.model)
    && (engine.claudeModels?.find(item => item.id === model)?.support ?? "supported") === "supported"));
  const runtime = selectedEngine?.runtime;
  // The selectors show a pending switch's target. A switch target lists only what that runtime supports now.
  const shownEngine = props.state.engines.find(engine => engine.engine === shown.engine);
  const shownModelChoices = !pendingSwitch && !serverPending ? modelChoices
    : shownEngine ? codeConversationModelChoices(shownEngine, false) : [];
  // A retained conversation switches in place (vivary-code-switch). Another conversation's run never locks either kind.
  const retained = !!props.selection.runId;
  const selectorsDisabled = retained
    ? props.viewingMatch || !props.workspaceAvailable || !props.run || !!serverPending
      || (!!pendingSwitch && ["stopping", "switching"].includes(pendingSwitch.step))
    : !props.workspaceAvailable || props.active || props.streaming;
  const switchPanelId = useId();
  // The server refuses a switch to a Claude model the installed version cannot confirm, so only listed,
  // supported models are offered as switch targets. The current model stays selectable.
  const modelOptionDisabled = (model: string) => {
    const support = shownEngine?.claudeModels?.find(item => item.id === model)?.support;
    return support === "upgrade-required"
      || (retained && support === "unverified" && !(shown.engine === props.run?.engine && model === props.run?.model));
  };
  const routeLabel = (route: ModelChoice) => {
    const engine = props.state.engines.find(item => item.engine === route.engine);
    return `${engine?.label ?? route.engine} ${modelLabel(engine, route.model)}`;
  };
  const events = props.run?.events ?? [];
  const snapshotKey = events.length + ":" + (events.at(-1)?.id ?? "") + ":" + (props.run?.status ?? "") + ":" + (props.matchedEventId ?? "");
  const viewKey = useRef(snapshotKey);
  // A live turn and its canonical transcript use different message IDs. Replace
  // the view at that ownership boundary, never the repository beneath mounted rows.
  if (!adapterOwnsMessages.current) viewKey.current = snapshotKey;
  const stoppedByUser = props.run?.status === "paused"
    && events.findLast(event => event.kind === "status")?.metadata?.reason === "user";
  const runtimeReady = selectedEngine?.configured === true;
  // Issue #121. Leftover coding processes refuse every send, so the composer waits for the host strip's choice.
  // Selectors show the unconfirmed target. Keep the draft, but pause the composer until the choice is resolved.
  const disabled = props.viewingMatch || !props.workspaceAvailable || props.active || props.streaming || !runtimeReady
    || (!!props.selection.runId && !props.run) || !!props.state.cleanup || !selectedModelAvailable
    || !!pendingSwitch || !!serverPending || sharedFolderHeld;

  function chooseRuntime(engineName: string) {
    const engine = props.state.engines.find(item => item.engine === engineName);
    if (!engine) return;
    if (retained) {
      requestSwitch({ engine: engine.engine,
        model: engine.engine === props.run?.engine ? props.run.model : defaultModelFor(engine) });
      return;
    }
    if (props.active || props.streaming) return;
    const model = engine.modelCatalog?.status === "ready" ? engine.modelCatalog.defaultModel
      : engine.engine === "claude-cli" ? engine.models[0] ?? "sonnet" : "default";
    const next = { engine: engine.engine, model };
    setChoice(next);
    props.onChoice(next);
  }

  function canMutateConversation() {
    return !latest.current.viewingMatch && latest.current.workspaceAvailable;
  }

  function canStopConversation() {
    return !latest.current.viewingMatch;
  }

  // Choosing a retained conversation's current route cancels a pending switch. Anything else asks first.
  function requestSwitch(target: ModelChoice) {
    if (!canMutateConversation()) return;
    const run = props.run;
    setSwitchError(undefined);
    if (!run || (target.engine === run.engine && target.model === run.model)) {
      setPendingSwitch(null);
      return;
    }
    setPendingSwitch(current => ({ ...target,
      expectedSwitchGeneration: run.switchGeneration,
      step: current?.step === "confirm-stop" && !observationChanged && runWorking
        && current.turnId === run.turnId ? "confirm-stop" : "confirm",
      turnId: run.turnId }));
  }

  async function acceptSwitchReply(state: VivaryCodeState, runId: string) {
    if (state.error) throw new Error(state.error);
    if (!state.run || state.run.id !== runId || state.projectId !== props.projectId) {
      throw new Error("The switched conversation could not be loaded. Refresh before continuing.");
    }
    // Cancel pre-action polling before seeding these exact owner queries. Opaque generations have no order.
    // Only a subsequent owner-cache snapshot may supersede the reply while parent props lag behind it.
    await Promise.all(stateQueryKeys.map(queryKey => queryClient.cancelQueries({ queryKey, exact: true })));
    setAcceptedRun(state.run);
    for (const queryKey of stateQueryKeys) queryClient.setQueryData(queryKey, state);
    const accepted = { engine: state.run.engine, model: state.run.model };
    setChoice(accepted);
    if (!state.run.pendingSwitch) props.onChoice(accepted);
    setPendingSwitch(null);
    props.onSettled();
  }

  async function completeSwitch(target: PendingSwitch) {
    const runId = props.run?.id;
    if (!canMutateConversation() || !runId || observationChanged || switchStep !== "confirm") return;
    // The pending step stays out of the saved conversation choice.
    setPendingSwitch({ ...target, step: "switching" });
    try {
      const state = await call<VivaryCodeState>("vivary-code-switch", {
        projectId: props.projectId ?? undefined, runId, engine: target.engine, model: target.model,
        expectedSwitchGeneration: target.expectedSwitchGeneration });
      await acceptSwitchReply(state, runId);
    } catch (failure) {
      setPendingSwitch(null);
      setSwitchError(actionErrorMessage(failure) ?? (failure instanceof Error ? failure.message : "The runtime could not be switched."));
    }
  }

  // Stop and switch. The host records the target on the run, stops it, and applies the switch when the run leaves the
  // host, so leaving or reloading this view does not lose it. A run that already ended switches at once.
  async function stopThenSwitch(target: PendingSwitch) {
    const runId = props.run?.id;
    if (!canMutateConversation() || !runId || observationChanged || switchStep !== "confirm-stop"
      || target.turnId === undefined || target.turnId !== props.run?.turnId) return;
    setPendingSwitch({ ...target, step: "stopping" });
    try {
      const state = await call<VivaryCodeState>("vivary-code-switch", {
        projectId: props.projectId ?? undefined, runId, engine: target.engine, model: target.model, stop: true,
        expectedSwitchGeneration: target.expectedSwitchGeneration, expectedTurnId: target.turnId });
      await acceptSwitchReply(state, runId);
    } catch (failure) {
      setPendingSwitch(null);
      setSwitchError(actionErrorMessage(failure) ?? (failure instanceof Error ? failure.message : "The runtime could not be switched."));
    }
  }

  function cancelSharedFolder() {
    setCancelledRuns(new Set(unacknowledged.map(item => item.turnId)));
    focusComposerAfterCancel.current = true;
  }
  // The composer is disabled while the warning asks, so focus moves once Cancel has enabled it.
  useEffect(() => {
    if (!focusComposerAfterCancel.current || sharedFolderHeld) return;
    focusComposerAfterCancel.current = false;
    chatRef.current?.focusComposer();
  }, [sharedFolderHeld]);

  useEffect(() => {
    if (observationChanged && (pendingSwitch?.step === "confirm" || pendingSwitch?.step === "confirm-stop")) {
      setPendingSwitch(null);
      setSwitchError("This conversation changed. Choose its runtime and confirm again.");
    }
  }, [observationChanged, pendingSwitch?.step]);

  useEffect(() => {
    // A Stop confirmation belongs to the current turn. A later turn needs the owner's Stop choice again.
    if (pendingSwitch?.step === "confirm-stop" && (!runWorking || pendingSwitch.turnId !== props.run?.turnId)) {
      setPendingSwitch(current => current?.step === "confirm-stop" ? { ...current, step: "confirm" } : current);
    }
  }, [pendingSwitch?.step, pendingSwitch?.turnId, runWorking, props.run?.turnId]);

  return <HandoffStatusContext.Provider value={handoffStatus}><AssistantChat key={viewKey.current} ref={chatRef}
    tabId={draftThreadId}
    hostComposerDraft={draft.hostComposerDraft}
    contextNamespace={previewContextKey}
    showHeader={false} className="local-agent-transcript"
    createAdapter={props.viewingMatch ? createHistoryReadAdapter : createAdapter} loadHistoryRepository={loadHistoryRepository}
    approvalActions={props.viewingMatch ? { alwaysAllowScope: "exact-command" } : undefined}
    isThreadStateLoading={!!props.selection.runId && !props.run && !props.streaming}
    externalStreaming={!!props.run && isCodeAgentRunActive(props.run)}
    externalUserStopped={stoppedByUser}
    onStop={async () => {
      if (!canStopConversation()) return false;
      await latest.current.onStop();
      // Code polling settles this response. Skip Native's unrelated global SSE abort.
      return false;
    }}
    composerDisabled={disabled}
    composerDisabledPlaceholder={props.viewingMatch ? "Reading saved history. Return to the latest project conversation to continue." : props.state.cleanup ? props.state.cleanup.composer : props.selection.runId && !props.run ? "Opening conversation…" : !props.workspaceAvailable ? "This folder is unavailable. You can read this conversation, but project work cannot start." : props.pendingApprovals > 0 ? "Review the pending request above. Approve or deny before sending another message." : sharedFolderHeld ? "Other agents are working in this folder. Choose Proceed or use another folder before sending." : !runtimeReady ? "Connect a runtime in Settings to start." : !selectedModelAvailable ? selectedClaudeModel?.support === "upgrade-required" ? `Update Claude Code to ${selectedClaudeModel.minimumVersion} or later${otherModelAvailable ? ", or choose another model" : ""}.` : selectedClaudeModel?.support === "unverified" ? `Verify the installed Claude Code version in Settings${otherModelAvailable ? ", or choose another model" : ""}.` : otherModelAvailable ? "The selected model is unavailable. Choose another model." : "The selected model is unavailable. Check Runtime settings." : pendingSwitch ? "Resolve the runtime or model choice above before sending another message." : "The agent is working. Stop it before sending another message."}
    selectedEngine={choice.engine} selectedModel={choice.model} defaultModel={props.state.defaultModel}
    availableModels={availableModels} onModelChange={(model, engine) => {
      const selected = props.state.engines.find(item => item.engine === engine);
      if (!selected) return;
      if (retained) {
        requestSwitch({ engine: selected.engine, model });
        return;
      }
      const choice = { engine: selected.engine, model };
      setChoice(choice);
      props.onChoice(choice);
    }}
    providerStatusChecksEnabled={false}
    showModelSelector={false}
    plusMenuMode="hidden" dynamicSuggestions={false} suggestions={[]}
    composerPlaceholder="Ask the agent to work in this workspace…"
    emptyStateAddon={<div className="local-agent-intro">
      <img className="local-agent-mascot" src={mascotUrl} width={48} height={48} alt="" aria-hidden="true" />
      <h2>What are we working on?</h2>
      <p>Read files, make changes, and inspect the results in your workspace.</p>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => chatRef.current?.prefillMessage(example)}>Try a file change</Button>
    </div>}
    composerSlot={<div className="min-h-0 overflow-auto">
      {props.notices}
      {props.folderRuns.length > 0 && !runWorking && !props.viewingMatch && (undecided.length > 0 || !unacknowledged.length)
        && <SharedFolderNotice runs={props.folderRuns} onCancel={cancelSharedFolder}
        acknowledged={!sharedFolderHeld} folderLabel={props.state.workspaceLabel} isolation={props.folderIsolation}
        onProceed={() => setAcknowledgedRuns(new Set(props.folderRuns.map(item => item.turnId)))} onOpen={props.onOpenRun} />}
      {!props.viewingMatch && props.run && <>
        <LinkedHistoryNotice key={props.run.id} projectId={props.projectId} target={{ kind: "code", id: props.run.id }} />
        <CodeLinkOptions key={"link:" + props.run.id} projectId={props.projectId} runId={props.run.id}
          sourceEngine={props.run.engine} engines={props.state.engines} storageKey={props.ownerKey}
          workspaceAvailable={props.workspaceAvailable}
          saveDraft={sourceDraftSaver(draft, draftThreadId)} />
        {props.projectId && <HandoffControl key={"handoff:" + props.run.id} projectId={props.projectId}
          conversation={{ kind: "code", id: props.run.id }} disabled={disabled}
          submit={async message => {
            // Core's window submit reaches only Native chats. This chat's own handle
            // sends through the Code adapter and leaves the composer draft alone.
            if (!chatRef.current) return false;
            chatRef.current.sendMessage(message);
            return true;
          }} />}
      </>}
      {!draftError && draft.draftSaveStatusForThread(draftThreadId) && <div className="local-agent-notice" role="status">
        <span>{draft.draftSaveStatusForThread(draftThreadId) === "saved"
          ? "Draft saved for this conversation." : "Saving draft…"}</span>
        <Button variant="ghost" size="sm" onClick={() => void draft.discard(draftThreadId)}>Discard draft</Button>
      </div>}
      {draftError && <div className="local-agent-notice" role="alert">
        <span>{draftError}</span>
        <Button variant="outline" size="sm" onClick={() => draft.retry(draftThreadId)}>{draft.hasConflictForThread(draftThreadId)
          ? "Reload saved draft" : draft.hasFailedDiscardForThread(draftThreadId) ? "Retry discard" : "Retry draft"}</Button>
        {draft.hasPendingForThread(draftThreadId) && (!restoreReview
          ? <Button variant="outline" size="sm" onClick={() => setRestoreReview(true)}>Review before restoring</Button>
          : !restoreAcknowledged
            ? <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" aria-label="I checked this conversation and queued follow-ups"
                onChange={event => setRestoreAcknowledged(event.target.checked)} />
              I checked this conversation and queued follow-ups. The message could still appear later, so sending this draft again could duplicate it.
            </label>
            : <Button variant="outline" size="sm" onClick={() => {
              setRestoreReview(false);
              setRestoreAcknowledged(false);
              void draft.restorePending(draftThreadId);
            }}>Restore draft for editing</Button>)}
        <Button variant="ghost" size="sm" onClick={() => void draft.discard(draftThreadId)}>Discard draft</Button>
      </div>}
      {selectedClaudeModel && selectedClaudeModel.support !== "supported" && <div className="local-agent-notice" role="status">
        <span>{selectedClaudeModel.message} Check Runtime settings.</span>
      </div>}
      {!selectedClaudeModel && choice.engine === "claude-cli" && <div className="local-agent-notice" role="status">
        <span>Saved model {choice.model} is a legacy or unavailable choice. It has been kept. Choose a listed model to replace it.</span>
      </div>}
      {switchError && <div className="local-agent-notice" role="alert">
        <span>{switchError}</span>
        <Button variant="ghost" size="sm" onClick={() => setSwitchError(undefined)}>Dismiss</Button>
      </div>}
      {pendingSwitch && props.run && (!readOnly || switchInFlight) && <div className="local-agent-notice local-agent-switch" id={switchPanelId}
        role={switchStep === "stopping" || switchStep === "switching" ? "status" : "group"}
        aria-label="Switch runtime or model">
        {switchStep === "confirm" && <>
          <span>Switch this conversation from {routeLabel(props.run)} to {routeLabel(pendingSwitch)}? {SWITCH_TRANSFER}</span>
          <Button variant="outline" size="sm" onClick={() => void completeSwitch(pendingSwitch)}>Switch</Button>
          <Button variant="ghost" size="sm" onClick={() => setPendingSwitch(null)}>Cancel</Button>
        </>}
        {switchStep === "working" && <>
          <span>This conversation is working. Wait for the current request to finish, or stop it and switch to {routeLabel(pendingSwitch)}.</span>
          <Button variant="ghost" size="sm" onClick={() => setPendingSwitch(null)}>Wait</Button>
          <Button variant="outline" size="sm" onClick={() => {
            if (canMutateConversation()) setPendingSwitch({ ...pendingSwitch, step: "confirm-stop", turnId: props.run?.turnId });
          }}>Stop and switch</Button>
        </>}
        {switchStep === "confirm-stop" && <>
          <span>Stop and switch to {routeLabel(pendingSwitch)}? The current request will be cancelled. Completed work stays in this conversation and the workspace. {SWITCH_TRANSFER}</span>
          <Button variant="outline" size="sm" onClick={() => void stopThenSwitch(pendingSwitch)}>Stop and switch</Button>
          <Button variant="ghost" size="sm" onClick={() => setPendingSwitch(null)}>Keep working</Button>
        </>}
        {switchStep === "stopping" && <span>Stopping the current request. The switch follows once it stops.</span>}
        {switchStep === "switching" && <span>Switching to {routeLabel(pendingSwitch)}.</span>}
      </div>}
      {!pendingSwitch && serverPending && props.run && <div className="local-agent-notice local-agent-switch" id={switchPanelId}
        role="status" aria-label="Switch runtime or model">
        <span>Stopping the current request. This conversation then switches to {routeLabel(serverPending)}.</span>
      </div>}
      {props.run && !props.viewingMatch && props.onNewConversation && <p className="local-agent-route-note">
        <span>Start another conversation using this project's default.</span>
        <Button variant="link" size="sm" disabled={!props.workspaceAvailable || props.newConversationAvailable === false} onClick={props.onNewConversation}>New conversation</Button>
      </p>}
      {props.workspaceAvailable && !runtimeReady ? <div className="local-agent-runtime-setup" role="status">
      <div><h3>Set up {selectedEngine?.label ?? "a runtime"}</h3><p>{selectedEngine?.modelCatalog?.status === "unavailable"
        ? selectedEngine.modelCatalog.message : runtime?.message ?? "Choose a local runtime in Settings."}</p></div>
      <Button variant="outline" size="sm" onClick={props.onSettings}>Open runtime settings</Button>
      </div> : null}
    </div>}
    composerToolbarSlot={<div className="local-agent-composer-controls">
        <label className="local-agent-composer-runtime">
          Runtime
          <select aria-label="Conversation runtime" value={shown.engine}
            aria-describedby={pendingSwitch || serverPending ? switchPanelId : undefined}
            className="local-agent-composer-select"
            disabled={selectorsDisabled}
            onChange={event => chooseRuntime(event.target.value)}>
            {props.state.engines.map(engine => <option key={engine.engine} value={engine.engine}
              disabled={retained && engine.engine !== props.run?.engine && !engine.configured}>
              {engine.label}{engine.runtime.status === "ready" ? "" : ` (${engine.runtime.status.replaceAll("-", " ")})`}
            </option>)}
          </select>
        </label>
        <label className="local-agent-composer-model">
          Model
          <select aria-label="Conversation model" value={shown.model}
            aria-describedby={pendingSwitch || serverPending ? switchPanelId : undefined}
            className="local-agent-composer-select"
            disabled={selectorsDisabled || !shownModelChoices.length}
            onChange={event => {
              const model = event.target.value;
              if (!shownEngine || !shownModelChoices.includes(model)) return;
              const next = { engine: shownEngine.engine, model };
              if (retained) {
                requestSwitch(next);
                return;
              }
              setChoice(next);
              props.onChoice(next);
            }}>
            {!shownModelChoices.includes(shown.model) && <option value={shown.model} disabled>{shown.model} (saved, unavailable)</option>}
            {shownModelChoices.map(model => <option key={model} value={model}
              disabled={modelOptionDisabled(model)}>
              {modelLabel(shownEngine, model)}
            </option>)}
          </select>
        </label>
      </div>}
    composerExtraActionButton={!props.viewingMatch && props.active && !props.streaming ?
      <Button variant="outline" size="sm" disabled={props.stopping} onClick={() => {
        if (canStopConversation()) void latest.current.onStop();
      }} aria-label="Stop response">
        <IconSquare size={14} /> Stop
      </Button> : undefined}
    threadFooterSlot={<p className="local-agent-limits"><span>{selectedEngine?.label ?? choice.engine} · {choice.model}</span>. {choice.engine === "codex-cli" ? "Codex uses the permissions selected in Runtime settings." : "Claude Code uses file tools."} Work continues if you leave this page. Use Stop to end the active turn.</p>}
  /></HandoffStatusContext.Provider>;
}
