import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AssistantChat,
  removeAgentChatContextItem,
  ChatHistoryList,
  isCodeAgentRunActive,
  type AssistantChatHandle,
  type AssistantChatProps,
} from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, readClientAppState, useActionQuery } from "@agent-native/core/client/hooks";
import { useNativeActionCaller } from "@/lib/native-actions";
import { useAppStateWriter } from "@/lib/native-state";
import { registerSelectionCloseFlush, trackSelectionWrite, useChatDraftList, useNativeChatDraft } from "@/lib/chat-draft";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@agent-native/toolkit/ui";
import { IconHistory, IconPlus, IconSettings, IconSquare } from "@tabler/icons-react";
import type { VivaryCodeRunState, VivaryCodeSessionDetails, VivaryCodeState } from "../../../server/local-code-agent";
import { codeDraftSelectionKey, codeDraftThreadId } from "../../../shared/code-draft";
import { createLocalCodeChatAdapter } from "../../lib/local-code-chat-adapter";
import { useProjects } from "../projects/ProjectContext";
import "@agent-native/toolkit/chat-history.css";
import "../../local-agent.css";
import mascotUrl from "../../assets/vivary-mascot.svg";
import { ConversationMatch } from "./ConversationMatch";
import { createHistoryReadAdapter } from "@/lib/history-read-adapter";
import { codeMatchRepository, codeMatchMessageId } from "@/lib/code-match-repository";
import "../../chat-search.css";

import { previewInspectionContext, type PreviewChatTarget } from "@/lib/workbench-preview";

type PreviewChatProps = { previewScope: string; onPreviewChatTarget?: (target: PreviewChatTarget | null) => void };

type ModelChoice = { engine: VivaryCodeState["defaultEngine"]; model: string };
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

  async function openActiveConversation(active: NonNullable<VivaryCodeState["activeRun"]>) {
    if (active.projectId !== projectId && !await selectProject(active.projectId)) return false;
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

function ProjectCodeWorkspace({ projectId, draftScopeKey, ownerKey, projectLabel, workspaceAvailable, selection, setSelection, onOpenActive, previewScope, onPreviewChatTarget }: PreviewChatProps & {
  projectId: string | null;
  draftScopeKey: string;
  ownerKey: string;
  projectLabel?: string;
  workspaceAvailable: boolean;
  selection: ConversationSelection | null;
  setSelection: Dispatch<SetStateAction<ConversationSelection | null>>;
  onOpenActive: (active: NonNullable<VivaryCodeState["activeRun"]>) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const activeRun = codeState?.activeRun;
  const error = notice ?? codeState?.error
    ?? (selectedState.isError && (anchor || selection?.runId !== codeState?.run?.id) ? "This conversation could not be loaded. Choose a conversation from history or retry." : undefined)
    ?? (state.data && !codeState ? "The project changed. Refresh this workspace before continuing." : undefined)
    ?? actionErrorMessage(state.error)
    ?? (state.error ? "The workspace could not be loaded." : undefined);

  const showInUrl = useCallback((next: ConversationSelection) => {
    if (!mounted.current) return;
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
  const newConversation = () => {
    const next = { key: crypto.randomUUID(), runId: null };
    setSelection(next);
    showInUrl(next);
    setNotice(undefined);
  };
  const onStarted = useCallback((key: string, runId: string) => {
    setSelection(current => current?.key === key ? { ...current, runId } : current);
    if (currentSelection.current?.key === key) showInUrl({ key, runId });
  }, [setSelection, showInUrl]);

  async function stopRun() {
    if (!activeRun) return false;
    setNotice(undefined);
    try {
      const result = await stop.mutateAsync({ projectId: activeRun.projectId ?? undefined, runId: activeRun.id });
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

  const conversationNotices = <>
    {error && <div className="local-agent-notice" role="alert">
      <span>{error}</span><Button variant="ghost" size="sm" onClick={() => { void state.refetch(); if (selection?.runId) void selectedState.refetch(); }}>Retry</Button>
    </div>}
    {activeRun && activeRun.id !== selection?.runId && <div className="local-agent-notice" role="status">
      <span>An agent is working in another conversation.</span>
      <Button variant="ghost" size="sm" onClick={() => {
        if (activeRun.projectId === projectId) selectConversation(activeRun.id);
        else void onOpenActive(activeRun).then(opened => {
          if (!opened) setNotice("The active conversation's project could not be opened. You can still stop the agent here.");
        });
      }}>Open conversation</Button>
    </div>}
  </>;

  return <section ref={matchContainer} className="local-agent-page" aria-label="Vivary agent">
    <ConversationMatch key={requestedRun + ":" + requestedEvent} container={matchContainer} messageId={matchMessageId} />
    <header className="local-agent-header">
      <div className="local-agent-heading">
        <h2>{run?.title ?? "New conversation"}</h2>
        <p>{run ? run.engineLabel + " / " + run.model : projectLabel ?? "Personal workspace"}</p>
      </div>
      <div className="local-agent-header-actions">
        {run && !unassigned && <CodeSessionDetails key={run.id} runId={run.id} projectId={projectId} />}
        {activeRun && <Badge variant="secondary" role="status" title={activeRun.title}>Working{activeRun.projectId !== projectId ? " in another project" : ""}</Badge>}
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
          disabled={!workspaceAvailable || !codeState || (streaming && !selection?.runId)}><IconPlus size={18} /></Button>
        <Button variant="ghost" size="icon" aria-label="Runtime settings" onClick={() => navigate("/settings/runtimes")}><IconSettings size={18} /></Button>

      </div>
    </header>
    {(!selection || !codeState || openingSavedRun) && conversationNotices}
    <div className="local-agent-layout">
      <div className="local-agent-chat">
        {selection && codeState && !openingSavedRun ? <LocalCodeConversation key={selection.key}
          notices={conversationNotices} projectId={projectId} ownerKey={ownerKey} selection={selection} run={run ?? null} previewScope={previewScope} onPreviewChatTarget={onPreviewChatTarget}
          state={run && selectedState.data?.projectId === projectId && selectedState.data.run?.id === run.id
            ? { ...codeState, engines: selectedState.data.engines } : codeState}
          workspaceAvailable={workspaceAvailable}
          viewingMatch={!!requestedEvent || unassigned}
          matchedEventId={requestedEvent}
          active={codeState.busy} streaming={streaming} onStreaming={setStreaming}
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

function CodeSessionDetails({ runId, projectId }: { runId: string; projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const details = useActionQuery<VivaryCodeSessionDetails>("vivary-code-state", {
    projectId: projectId ?? undefined, runId, details: true,
  }, { enabled: open, retry: false, refetchInterval: open ? 2_000 : false });
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="ghost" size="sm">Session details</Button></PopoverTrigger>
    <PopoverContent align="end" className="w-[min(32rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto space-y-3 text-sm"
      aria-label="Session details">
      <h3 className="font-medium">Session details</h3>
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
        <p className="text-xs text-muted-foreground">Provider-native log files remain with the runtime. They are unavailable in this view.</p>
      </>}
    </PopoverContent>
  </Popover>;
}

type LocalCodeConversationProps = PreviewChatProps & {
  viewingMatch?: boolean;
  matchedEventId?: string | null;
  notices: ReactNode;
  ownerKey: string;
  projectId: string | null;
  workspaceAvailable: boolean;
  selection: ConversationSelection;
  run: VivaryCodeRunState | null;
  state: VivaryCodeState;
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

function LocalCodeConversation(props: LocalCodeConversationProps) {
  const chatRef = useRef<AssistantChatHandle>(null);
  const { call } = useNativeActionCaller();
  const latest = useRef(props);
  latest.current = props;
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
  const [choice, setChoice] = useState(props.selection.choice ?? {
    engine: props.run?.engine ?? props.state.defaultEngine,
    model: props.run?.model ?? props.state.defaultModel,
  });
  useEffect(() => {
    if (props.run && !props.selection.choice) setChoice({ engine: props.run.engine, model: props.run.model });
  }, [props.run?.id, props.run?.engine, props.run?.model, props.selection.choice]);

  const createAdapter = useCallback<NonNullable<AssistantChatProps["createAdapter"]>>(context =>
    createLocalCodeChatAdapter({
      context, call, runIdRef, projectId: props.projectId, draftThreadId,
      onKnownRejected: submitId => draft.rejectKnownSubmission(draftThreadId, submitId),
      engines: () => latest.current.state.engines,
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
    .map(engine => ({ ...engine, models: [...engine.models] })),
  [props.state.engines, props.selection.runId, choice.engine]);
  const selectedEngine = props.state.engines.find(engine => engine.engine === choice.engine);
  const modelChoices = !props.selection.runId && choice.engine === "codex-cli"
    ? selectedEngine?.modelCatalog?.status === "ready" ? selectedEngine.modelCatalog.models.map(model => model.id) : []
    : selectedEngine?.models ?? [];
  const availableDraftModel = !props.selection.runId && selectedEngine?.configured
    && !modelChoices.includes(choice.model) ? modelChoices[0] : undefined;
  useEffect(() => {
    if (!availableDraftModel) return;
    const next = { engine: choice.engine, model: availableDraftModel };
    setChoice(next);
    latest.current.onChoice(next);
  }, [availableDraftModel, choice.engine]);
  const runtime = selectedEngine?.runtime;
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
  const disabled = props.viewingMatch || !props.workspaceAvailable || props.active || props.streaming || !runtimeReady
    || (!!props.selection.runId && !props.run) || !!props.state.cleanup;

  function chooseRuntime(engineName: string) {
    const engine = props.state.engines.find(item => item.engine === engineName);
    if (!engine || props.selection.runId || props.active || props.streaming) return;
    const model = engine.modelCatalog?.status === "ready" ? engine.modelCatalog.defaultModel
      : engine.engine === "claude-cli" ? engine.models[0] ?? "sonnet" : "default";
    const next = { engine: engine.engine, model };
    setChoice(next);
    props.onChoice(next);
  }

  return <AssistantChat key={viewKey.current} ref={chatRef}
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
      await props.onStop();
      // Code polling settles this response. Skip Native's unrelated global SSE abort.
      return false;
    }}
    composerDisabled={disabled}
    composerDisabledPlaceholder={props.viewingMatch ? "Reading saved history. Return to the latest project conversation to continue." : props.state.cleanup ? props.state.cleanup.composer : props.selection.runId && !props.run ? "Opening conversation…" : !props.workspaceAvailable ? "This folder is unavailable. You can read this conversation, but project work cannot start." : props.state.pendingApproval ? "Review the pending request above. Approve or deny before sending another message." : !runtimeReady ? "Connect a runtime in Settings to start." : "The agent is working. Stop it before sending another message."}
    selectedEngine={choice.engine} selectedModel={choice.model} defaultModel={props.state.defaultModel}
    availableModels={availableModels} onModelChange={(model, engine) => {
      const selected = props.state.engines.find(item => item.engine === engine);
      if (selected && (!props.selection.runId || selected.engine === props.run?.engine)) {
        const choice = { engine: selected.engine, model };
        setChoice(choice);
        props.onChoice(choice);
      }
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
      {!props.selection.runId && <div className="local-agent-notice">
        <label className="flex items-center gap-2 text-sm">
          Runtime
          <select aria-label="Conversation runtime" value={choice.engine}
            className="rounded-md border bg-background px-2 py-1 text-foreground"
            disabled={!props.workspaceAvailable || props.active || props.streaming}
            onChange={event => chooseRuntime(event.target.value)}>
            {props.state.engines.map(engine => <option key={engine.engine} value={engine.engine}>
              {engine.label}{engine.runtime.status === "ready" ? "" : ` (${engine.runtime.status.replaceAll("-", " ")})`}
            </option>)}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          Model
          <select aria-label="Conversation model" value={choice.model}
            className="min-w-0 max-w-full rounded-md border bg-background px-2 py-1 text-foreground"
            disabled={!props.workspaceAvailable || props.active || props.streaming || !modelChoices.length}
            onChange={event => {
              const model = event.target.value;
              if (!selectedEngine || !modelChoices.includes(model)) return;
              const next = { engine: selectedEngine.engine, model };
              setChoice(next);
              props.onChoice(next);
            }}>
            {!modelChoices.length && <option value={choice.model}>Models unavailable</option>}
            {modelChoices.map(model => <option key={model} value={model}>
              {selectedEngine?.modelCatalog?.status === "ready"
                ? selectedEngine.modelCatalog.models.find(item => item.id === model)?.label ?? model : model}
            </option>)}
          </select>
        </label>
      </div>}
      {props.workspaceAvailable && !runtimeReady ? <div className="local-agent-runtime-setup" role="status">
      <div><h3>Set up {selectedEngine?.label ?? "a runtime"}</h3><p>{selectedEngine?.modelCatalog?.status === "unavailable"
        ? selectedEngine.modelCatalog.message : runtime?.message ?? "Choose a local runtime in Settings."}</p></div>
      <Button variant="outline" size="sm" onClick={props.onSettings}>Open runtime settings</Button>
      </div> : null}
    </div>}
    composerExtraActionButton={props.active && !props.streaming ?
      <Button variant="outline" size="sm" disabled={props.stopping} onClick={() => void props.onStop()} aria-label="Stop response">
        <IconSquare size={14} /> Stop
      </Button> : undefined}
    threadFooterSlot={<p className="local-agent-limits"><span>{selectedEngine?.label ?? choice.engine} · {choice.model}</span>. {choice.engine === "codex-cli" ? "Codex uses the permissions selected in Runtime settings." : "Claude Code uses file tools."} Work continues if you leave this page. Use Stop to end the active turn.</p>}
  />;
}
