import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readClientAppState, useActionQuery } from "@agent-native/core/client/hooks";
import { useAppStateWriter } from "@/lib/native-state";
import { registerSelectionCloseFlush, trackSelectionWrite, useOrphanedDrafts } from "@/lib/chat-draft";
import { conversationSurfaceStateKey, defaultConversationSurface, requestedConversationSurface, restoredConversationSurface, savedNativeHistoryKind, type NativeHistoryKind } from "@/lib/conversation-surface";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup, Skeleton } from "@agent-native/toolkit/ui";
import { IconArrowsMaximize, IconArrowsMinimize, IconFiles, IconInfoCircle, IconSearch, IconWorld, IconX } from "@tabler/icons-react";
import { useProjects } from "../projects/ProjectContext";
import { ProjectFiles } from "../projects/ProjectFiles";
import { ProjectSearch } from "../projects/ProjectSearch";
import { ProjectAdoption } from "../projects/ProjectAdoption";
import { ProjectMemoryPanel } from "../projects/ProjectMemoryPanel";
import { ProjectReadPanel } from "../projects/ProjectReadPanel";
import { ProjectEvaluatePanel } from "../projects/ProjectEvaluatePanel";
import { ProjectKindDetail, WorkspaceKindDialog, useSaveProjectKind } from "../projects/WorkspaceKindDialog";
import FilesView from "../../routes/files";
import CodeConversation from "./CodeConversation";
import NativeConversation from "./NativeConversation";
import { BrowserPreview } from "../workbench/BrowserPreview";
import type { PreviewChatTarget } from "@/lib/workbench-preview";
import type { VivaryCodeState } from "../../../server/local-code-agent";
import { readPanelWidth, savePanelWidth, useNarrowLayout, type PanelHandle } from "../layout/use-workspace-layout";
import "../../workspace.css";

type Surface = "files" | "details" | "preview" | "search";
function surface(value: string | null): Surface | null {
  return value === "files" || value === "details" || value === "preview" || value === "search" ? value : null;
}
const WIDTH_KEY = "vivary.surface.width";
const SURFACE_NAMES: Record<Surface, string> = { files: "Files", details: "Details", preview: "Preview", search: "Search" };
// Side by side needs room for both minimum widths in CSS pixels. Below it the conversation and the panel switch views.
const CONVERSATION_MIN_WIDTH = 360;
const PANEL_MIN_WIDTH = 260;
const SIDE_BY_SIDE_MIN = CONVERSATION_MIN_WIDTH + PANEL_MIN_WIDTH;

export function Workspace() {
  const { activeProject, catalog, checking, workspaceAvailable, error: projectError, refresh } = useProjects();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const projectId = activeProject?.projectId ?? null;
  const currentProjectKey = catalog?.scopeKey
    ? JSON.stringify([catalog.scopeKey, projectId ?? "personal"]) : null;
  const [readyProjectKey, setReadyProjectKey] = useState<string | null>(null);
  const changingProject = !checking && readyProjectKey !== null
    && readyProjectKey !== currentProjectKey;
  const projectRouteReady = !checking && currentProjectKey !== null
    && readyProjectKey === currentProjectKey;
  const native = params.get("runtime") === "native";
  const explicitSurface = requestedConversationSurface(params);
  const historyKind: NativeHistoryKind = params.get("history") === "unassigned" ? "unassigned" : "project";
  const surfaceKey = catalog?.scopeKey
    ? conversationSurfaceStateKey(catalog.scopeKey, projectId) : null;
  const surfaceQuery = useQuery({
    queryKey: ["vivary-active-conversation", surfaceKey],
    queryFn: ({ signal }) => {
      if (!surfaceKey) throw new Error("The project identity is still loading.");
      return readClientAppState(surfaceKey, { signal });
    },
    enabled: Boolean(surfaceKey && projectRouteReady),
    retry: false, staleTime: Infinity,
  });
  const stored = surfaceQuery.data as { surface?: unknown; historyKind?: unknown; scopeKey?: unknown; projectId?: unknown } | null;
  const savedSurface = stored?.scopeKey === catalog?.scopeKey && stored?.projectId === projectId
    ? stored?.surface : null;
  const restoredSurface = restoredConversationSurface(explicitSurface, savedSurface);
  const { ready: surfaceWriterReady, writeAppState } = useAppStateWriter();
  const queryClient = useQueryClient();
  type SurfaceSelection = { key: string; scopeKey: string; projectId: string | null;
    surface: "native" | "code"; historyKind: NativeHistoryKind };
  const pendingSurfaces = useRef(new Map<string, SurfaceSelection>());
  const savingSurface = useRef<Promise<void> | null>(null);
  const [surfaceSaveError, setSurfaceSaveError] = useState(false);
  const surfaceSaveFailed = useRef(false);
  const orphanedDrafts = useOrphanedDrafts(catalog?.scopeKey ?? null);
  const saveSurface = useCallback((): Promise<void> => {
    if (savingSurface.current) return savingSurface.current;
    if (pendingSurfaces.current.size === 0) return Promise.resolve();
    if (!surfaceWriterReady) return Promise.reject(new Error("The Native session is not ready to save the surface."));
    const write = (async () => {
      try {
        while (pendingSurfaces.current.size) {
          const [key, value] = pendingSurfaces.current.entries().next().value!;
          await writeAppState(value.key, {
            scopeKey: value.scopeKey, projectId: value.projectId, surface: value.surface, historyKind: value.historyKind,
          }, { keepalive: true });
          queryClient.setQueryData(["vivary-active-conversation", value.key], {
            scopeKey: value.scopeKey, projectId: value.projectId, surface: value.surface, historyKind: value.historyKind,
          });
          surfaceSaveFailed.current = false;
          setSurfaceSaveError(false);
          if (pendingSurfaces.current.get(key) === value) pendingSurfaces.current.delete(key);
        }
      } catch (error) {
        surfaceSaveFailed.current = true;
        setSurfaceSaveError(true);
        throw error;
      }
    })();
    const tracked = trackSelectionWrite(write);
    savingSurface.current = tracked;
    void tracked.finally(() => { if (savingSurface.current === tracked) savingSurface.current = null; }).catch(() => {});
    return tracked;
  }, [queryClient, surfaceWriterReady, writeAppState]);
  useEffect(() => registerSelectionCloseFlush(saveSurface,
    () => pendingSurfaces.current.size > 0 || savingSurface.current !== null || surfaceSaveFailed.current), [saveSurface]);
  useEffect(() => {
    if (!explicitSurface || !surfaceKey || !catalog?.scopeKey || !projectRouteReady) return;
    pendingSurfaces.current.set(surfaceKey, { key: surfaceKey, scopeKey: catalog.scopeKey,
      projectId, surface: explicitSurface, historyKind });
    void saveSurface().catch(() => {});
  }, [explicitSurface, surfaceKey, catalog?.scopeKey, projectId, projectRouteReady, historyKind, saveSurface]);
  useEffect(() => {
    if (explicitSurface || !projectRouteReady || !surfaceQuery.isSuccess || savedSurface !== "native") return;
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set("runtime", "native");
      next.set("history", savedNativeHistoryKind(stored?.historyKind));
      return next;
    }, { replace: true });
  }, [explicitSurface, projectRouteReady, surfaceQuery.isSuccess, savedSurface, stored?.historyKind, setParams]);
  // Nothing requested or saved: the project's kind picks the first surface. Personal opens API chat through the
  // same route a request uses, which then saves it. Coding, Not set and the Personal workspace save Code.
  const defaultSurface = defaultConversationSurface(activeProject?.workspaceKind);
  useEffect(() => {
    if (explicitSurface || !surfaceKey || !catalog?.scopeKey || !projectRouteReady
      || !surfaceQuery.isSuccess || restoredSurface) return;
    if (defaultSurface === "native") {
      setParams(current => {
        const next = new URLSearchParams(current);
        next.set("runtime", "native");
        next.set("history", "project");
        return next;
      }, { replace: true });
      return;
    }
    pendingSurfaces.current.set(surfaceKey, { key: surfaceKey, scopeKey: catalog.scopeKey,
      projectId, surface: "code", historyKind: "project" });
    void saveSurface().catch(() => {});
  }, [explicitSurface, surfaceKey, catalog?.scopeKey, projectId, projectRouteReady,
    surfaceQuery.isSuccess, restoredSurface, saveSurface, defaultSurface, setParams]);
  const openingSurface = !projectRouteReady || !surfaceKey || (!explicitSurface &&
    (surfaceQuery.isPending || (surfaceQuery.isSuccess && (restoredSurface ?? defaultSurface) === "native")));
  const unassigned = native && params.get("history") === "unassigned";
  const opened = surface(params.get("panel"));
  const narrow = useNarrowLayout();
  const [maximized, setMaximized] = useState(false);
  const [previewChatTarget, setPreviewChatTarget] = useState<PreviewChatTarget | null>(null);
  const panel = useRef<PanelHandle>(null);
  const surfaceElement = useRef<HTMLElement>(null);
  const conversation = useRef<PanelHandle>(null);
  const split = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const filesTrigger = useRef<HTMLButtonElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const triggers = { details: detailsTrigger, files: filesTrigger, preview: previewTrigger, search: searchTrigger };
  const [splitWidth, setSplitWidth] = useState(0);
  useEffect(() => {
    const element = split.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSplitWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [width, setWidth] = useState(() => readPanelWidth(WIDTH_KEY, 480, 260, 1200));
  const [filesVisited, setFilesVisited] = useState(opened === "files");
  const [previewVisited, setPreviewVisited] = useState(opened === "preview");
  const previewScope = JSON.stringify([
    catalog?.scopeKey, activeProject?.projectId, activeProject?.bindingRevision,
  ]);
  const [searchVisited, setSearchVisited] = useState(opened === "search");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [choosingKind, setChoosingKind] = useState(false);
  const saveProjectKind = useSaveProjectKind();
  const fullPage = opened === "preview" && maximized;
  // Where the conversation and the panel cannot both be usable side by side (a narrow window, or a split under
  // 360 + 260 pixels), each takes the full area in turn. A visible Conversation and panel switch above them chooses
  // the view, so reading and sending stay one click away. Opening a panel shows it, and closing it shows the conversation.
  const switchable = narrow || (splitWidth > 0 && splitWidth < SIDE_BY_SIDE_MIN);
  const switched = Boolean(opened) && !maximized && switchable;
  // The panels' limits follow the window, not the open panel or the chosen view. A limit change registers a panel
  // again and can undo a resize made in the same render, so opening a panel or switching views changes no limit.
  const unconstrained = switchable || maximized;
  const [view, setView] = useState<"conversation" | "panel">(opened ? "panel" : "conversation");
  useEffect(() => { if (opened) setView("panel"); }, [opened]);
  const showOnlySurface = Boolean(opened) && (maximized || (switched && view === "panel"));
  const showOnlyConversation = switched && view === "conversation";
  // The switch names the conversation's state while the panel covers it, so a working agent or a pending approval
  // is never silent. The query shares the Code conversation's cache entry.
  const watchActivity = switched && view === "panel" && !native && !changingProject;
  const activity = useActionQuery<VivaryCodeState>("vivary-code-state", { projectId: activeProject?.projectId ?? undefined },
    { enabled: watchActivity, refetchInterval: 1000 });
  const activeRuns = watchActivity && activity.data?.projectId === (activeProject?.projectId ?? null) ? activity.data.activeRuns ?? [] : [];
  const conversationActivity = activeRuns.some(run => run.pendingApprovals.length > 0) ? "Needs approval"
    : activeRuns.length > 0 ? "Working" : null;

  useEffect(() => {
    if (!fullPage || !surfaceElement.current) return;
    // Expand in place: moving the frame into a portal would restart its browsing session.
    // Keep the covered workspace out of keyboard navigation while the preview fills the page.
    const covered: { element: HTMLElement; inert: boolean }[] = [];
    let current: HTMLElement = surfaceElement.current;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== current) {
          covered.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    return () => { for (const { element, inert } of covered) element.inert = inert; };
  }, [fullPage]);

  function changeSurface(next: Surface | null, trigger?: HTMLButtonElement) {
    if (trigger) opener.current = trigger;
    setMaximized(false);
    setView(next ? "panel" : "conversation");
    setParams(current => {
      const nextParams = new URLSearchParams(current);
      if (next) nextParams.set("panel", next);
      else nextParams.delete("panel");
      return nextParams;
    });
    if (!next) {
      const target = opener.current?.getAttribute("aria-pressed") === "true"
        ? opener.current : opened ? triggers[opened].current : null;
      requestAnimationFrame(() => target?.focus());
    }
  }

  useEffect(() => {
    if (location.pathname !== "/") return;
    if (opened === "files") setFilesVisited(true);
    if (opened === "preview") setPreviewVisited(true);
    if (opened === "search") setSearchVisited(true);
  }, [opened, location.pathname]);
  useEffect(() => {
    if (checking || currentProjectKey === null) return;
    if (readyProjectKey === null) {
      setReadyProjectKey(currentProjectKey);
      return;
    }
    if (readyProjectKey === currentProjectKey) return;
    const routeKeys = ["panel", "path", "project", "runtime", "thread", "history",
      "run", "draft", "line", "message", "event", "eventOffset"];
    if (routeKeys.some(key => params.has(key))) {
      setMaximized(false);
      setParams(current => {
        const next = new URLSearchParams(current);
        for (const key of routeKeys) next.delete(key);
        return next;
      }, { replace: true });
      return;
    }
    // Only admit the new project's conversation after the old URL is gone.
    setReadyProjectKey(currentProjectKey);
  }, [checking, readyProjectKey, currentProjectKey, params.toString(), setParams]);

  useEffect(() => {
    const apply = () => {
      if (!panel.current || !conversation.current) return;
      if (!opened) { conversation.current.expand(); panel.current.collapse(); return; }
      if (showOnlySurface) { conversation.current.collapse(); panel.current.resize("100%"); }
      else if (showOnlyConversation) { conversation.current.expand(); panel.current.collapse(); }
      else {
        conversation.current.expand();
        const available = split.current?.clientWidth ?? window.innerWidth;
        panel.current.resize(Math.min(width, Math.max(PANEL_MIN_WIDTH, available - CONVERSATION_MIN_WIDTH)));
      }
    };
    apply();
    // A change to a panel's limits or default size registers it again, and the group can lay out once more after
    // this effect, such as when a side-by-side window first switches views. Apply the view again on the next frame.
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [opened, showOnlySurface, showOnlyConversation, width, splitWidth]);

  /** A header tool opens its panel, shows it again from the Conversation view, or closes it. */
  function toggleSurface(next: Surface, trigger: HTMLButtonElement) {
    if (opened !== next) changeSurface(next, trigger);
    else if (showOnlyConversation) setView("panel");
    else changeSurface(null, trigger);
  }
  /** The Conversation and panel switch: Left and Right arrow keys move between its two options, as in a tab list. */
  function switchKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? "conversation" : event.key === "End" ? "panel" : view === "panel" ? "conversation" : "panel";
    setView(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }

  return <section className="workspace-page" aria-label="Project workspace">
    <header className="workspace-header">
      <div className="workspace-identity">
        <h1>{checking ? "Opening project" : unassigned ? "Unassigned conversations" : activeProject?.displayName ?? "Personal workspace"}</h1>
        <p>{unassigned ? "No project assigned" : native ? "Native chat" : "Project conversation"} / Connected host</p>
      </div>
      <div className="workspace-tools">
        <Button ref={detailsTrigger} size="sm" variant={opened === "details" ? "secondary" : "ghost"} aria-label="Project details" title="Project details"
          aria-pressed={opened === "details"} onClick={e => toggleSurface("details", e.currentTarget)}>
          <IconInfoCircle size={17} aria-hidden /><span>Details</span></Button>
        <Button ref={filesTrigger} size="sm" variant={opened === "files" ? "secondary" : "ghost"} aria-label="Open project files" title="Open project files"
          aria-pressed={opened === "files"} onClick={e => toggleSurface("files", e.currentTarget)}>
          <IconFiles size={17} aria-hidden /><span>Files</span></Button>
        <Button ref={previewTrigger} size="sm" variant={opened === "preview" ? "secondary" : "ghost"} aria-label="Open page preview" title="Open page preview"
          aria-pressed={opened === "preview"} onClick={e => toggleSurface("preview", e.currentTarget)}>
          <IconWorld size={17} aria-hidden /><span>Preview</span></Button>
        <Button ref={searchTrigger} size="sm" variant={opened === "search" ? "secondary" : "ghost"} aria-label="Search project files" title="Search project files"
          aria-pressed={opened === "search"} onClick={e => toggleSurface("search", e.currentTarget)}>
          <IconSearch size={17} aria-hidden /><span>Search</span></Button>
      </div>
    </header>
    {surfaceSaveError && <div className="workspace-recovery" role="alert">
      <span>Your active conversation could not be saved.</span>
      <Button size="sm" variant="outline" onClick={() => void saveSurface().catch(() => {})}>Retry selection</Button>
    </div>}
    {orphanedDrafts.map(draft => <div key={`${draft.kind}:${draft.projectId}:${draft.threadId}`}
      className="workspace-recovery" role="alert">
      <span>{draft.saving ? "Saving an edit from a previous" : "An edit in a previous"} {draft.kind === "code" ? "Code" : "Native"} conversation{draft.saving ? ". Keep Vivary open until it finishes." : " did not save. Copy the text or retry its save."}</span>
      <textarea readOnly aria-label="Unsaved conversation text" value={draft.text} />
      <Button size="sm" variant="outline" onClick={() => void draft.retry().catch(() => {})}>{draft.discardFailed ? "Retry discard" : "Retry draft"}</Button>
      <Button size="sm" variant="ghost" onClick={() => void draft.abandon()}>Discard unsaved local edit</Button>
      {draft.error && <span>{draft.error}</span>}
    </div>)}
    {!explicitSurface && !checking && !changingProject && surfaceQuery.isError && <div className="workspace-recovery" role="alert">
      <span>Your last conversation could not be loaded.</span>
      <Button size="sm" variant="outline" onClick={() => void surfaceQuery.refetch()}>Retry conversation</Button>
    </div>}
    {!checking && !workspaceAvailable && <div className="workspace-recovery" role="alert">
      <span>{projectError ?? "This project folder is unavailable. Saved conversations remain separate from folder access."}</span>
      <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry project</Button>
    </div>}
    {switched && opened && <div className="workspace-view-switch" role="tablist" aria-label="Workspace view" onKeyDown={switchKey}>
      <button type="button" role="tab" data-view="conversation" aria-selected={view === "conversation"} aria-controls="workspace-conversation-view"
        onClick={() => setView("conversation")}>
        Conversation
        {view === "panel" && conversationActivity && <span className="workspace-view-activity" role="status"
          data-attention={conversationActivity === "Needs approval" || undefined}>{conversationActivity}</span>}
      </button>
      <button type="button" role="tab" data-view="panel" aria-selected={view === "panel"} aria-controls="workspace-panel-view"
        onClick={() => setView("panel")}>{SURFACE_NAMES[opened]}</button>
    </div>}
    <div ref={split} className="workspace-split">
      <ResizablePanelGroup orientation="horizontal" onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction && !showOnlySurface && !showOnlyConversation && opened && panel.current && conversation.current) {
          // Keyboard callbacks precede DOM sizing. Apply the new layout to the stable panel total.
          const available = panel.current.getSize().inPixels + conversation.current.getSize().inPixels;
          const pixels = layout.surface / 100 * available;
          if (pixels >= PANEL_MIN_WIDTH) { savePanelWidth(WIDTH_KEY, pixels); setWidth(pixels); }
          if (panel.current.isCollapsed()) changeSurface(null);
        }
      }}>
        <ResizablePanel id="conversation" panelRef={conversation}
          minSize={unconstrained ? 0 : CONVERSATION_MIN_WIDTH}
          collapsible={unconstrained} collapsedSize={0}>
          <div id="workspace-conversation-view" className="workspace-conversation" hidden={showOnlySurface}>
            {changingProject || openingSurface || (!explicitSurface && surfaceQuery.isError) ? <div className="local-agent-chat-skeleton" aria-busy="true">
              <Skeleton className="h-8 w-48" /><Skeleton className="h-5 w-3/4" />
              <Skeleton className="mt-auto h-28 w-full" />
            </div> : native ? <NativeConversation /> : <CodeConversation previewScope={previewScope} onPreviewChatTarget={setPreviewChatTarget} />}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle title="Drag to resize the work panel, or use the arrow keys" disabled={!opened || showOnlySurface || switched} hidden={!opened || showOnlySurface || switched}
          className="workspace-resize-handle workspace-work-panel-resize-handle" aria-label="Resize work panel" />
        <ResizablePanel id="surface" panelRef={panel} defaultSize={opened ? Math.min(width, Math.max(PANEL_MIN_WIDTH, (splitWidth || window.innerWidth) - CONVERSATION_MIN_WIDTH)) : 0}
          minSize={unconstrained ? 0 : PANEL_MIN_WIDTH} collapsible collapsedSize={0}>
          <aside ref={surfaceElement} id="workspace-panel-view" className={`workspace-surface${fullPage ? " workspace-surface-fullpage" : ""}`}
            hidden={!opened || showOnlyConversation} aria-label="Work panel">
            <header className="workspace-surface-toolbar">
              <h2>{opened === "files" ? "Files" : opened === "preview" ? `Preview · ${activeProject?.displayName ?? "Personal workspace"}` : opened === "search" ? "Search" : "Project details"}</h2>
              {opened === "files" && <Button variant="ghost" size="sm" aria-expanded={fileTreeOpen}
                onClick={() => setFileTreeOpen(value => !value)}>{fileTreeOpen ? "Hide file list" : "Show file list"}</Button>}
              {opened === "preview" && <Button size="sm" variant="outline" aria-expanded={fullPage}
                onClick={() => setMaximized(value => !value)}>{fullPage ? <IconArrowsMinimize size={17} aria-hidden /> : <IconArrowsMaximize size={17} aria-hidden />}{fullPage ? "Back to workspace" : "Full page"}</Button>}
              {opened !== "preview" && !narrow && splitWidth >= SIDE_BY_SIDE_MIN && <Button size="icon" variant="ghost" aria-label={maximized ? "Restore panel" : "Maximize panel"}
                onClick={() => setMaximized(value => !value)}>{maximized ? <IconArrowsMinimize size={17} /> : <IconArrowsMaximize size={17} />}</Button>}
              <Button size="icon" variant="ghost" aria-label="Close work panel" onClick={() => changeSurface(null)}><IconX size={18} /></Button>
            </header>
            {filesVisited && <div className="workspace-file-surface" hidden={opened !== "files"}>
              <div className="workspace-file-tree" hidden={!fileTreeOpen}><ProjectFiles /></div>
              <div className="workspace-file-document"><FilesView /></div>
            </div>}
            {previewVisited && <div className="workspace-preview" hidden={opened !== "preview"}><BrowserPreview key={previewScope} projectId={activeProject?.projectId ?? null} projectName={activeProject?.displayName ?? "Personal workspace"} chatTarget={previewChatTarget?.scope === previewScope && previewChatTarget.projectId === activeProject?.projectId && !native ? previewChatTarget : null} /></div>}
            {searchVisited && <div className="workspace-search" hidden={opened !== "search"}><ProjectSearch /></div>}
            <div className="workspace-details" hidden={opened !== "details"}>
              <h3>{activeProject?.displayName ?? "Personal workspace"}</h3>
              <dl><dt>Execution</dt><dd>The connected Vivary host</dd>
                <dt>Project folder</dt><dd>{activeProject ? workspaceAvailable ? "Connected and available" : "Unavailable" : "Personal host workspace"}</dd>
                {activeProject && <ProjectKindDetail kind={activeProject.workspaceKind}
                  editable={catalog?.kindEditable === true} onChange={() => setChoosingKind(true)} />}
                <dt>Files and history</dt><dd>Stay on this host. Opening a file does not send it to a model.</dd></dl>
              {activeProject && <ProjectMemoryPanel projectId={activeProject.projectId} disabled={!workspaceAvailable}
                visible={opened === "details"} />}
              {activeProject && <ProjectReadPanel projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              {activeProject && <ProjectEvaluatePanel projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              {activeProject && <ProjectAdoption key={activeProject.projectId} projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              <p>Open Files to read a document. Choose Edit when you want to change it.</p>
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/runtimes")}>Runtime settings</Button>
              {!catalog && <p>Project details could not be loaded. Use Retry project.</p>}
              {activeProject && <WorkspaceKindDialog open={choosingKind} current={activeProject.workspaceKind}
                description="This changes the defaults for new conversations in this project. Existing conversations and files stay as they are."
                onChoose={async kind => { await saveProjectKind(activeProject.projectId, kind); setChoosingKind(false); }}
                onCancel={() => setChoosingKind(false)} />}
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </section>;
}
