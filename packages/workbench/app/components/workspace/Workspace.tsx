import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readClientAppState } from "@agent-native/core/client/hooks";
import { useAppStateWriter } from "@/lib/native-state";
import { registerSelectionCloseFlush, trackSelectionWrite, useOrphanedDrafts } from "@/lib/chat-draft";
import { conversationSurfaceStateKey, requestedConversationSurface, restoredConversationSurface, savedNativeHistoryKind, type NativeHistoryKind } from "@/lib/conversation-surface";
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
import FilesView from "../../routes/files";
import CodeConversation from "./CodeConversation";
import NativeConversation from "./NativeConversation";
import { BrowserPreview } from "../workbench/BrowserPreview";
import type { PreviewChatTarget } from "@/lib/workbench-preview";
import { readPanelWidth, savePanelWidth, useNarrowLayout, type PanelHandle } from "../layout/use-workspace-layout";
import "../../workspace.css";

type Surface = "files" | "details" | "preview" | "search";
function surface(value: string | null): Surface | null {
  return value === "files" || value === "details" || value === "preview" || value === "search" ? value : null;
}
const WIDTH_KEY = "vivary.surface.width";

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
  useEffect(() => {
    if (explicitSurface || !surfaceKey || !catalog?.scopeKey || !projectRouteReady
      || !surfaceQuery.isSuccess || restoredSurface) return;
    pendingSurfaces.current.set(surfaceKey, { key: surfaceKey, scopeKey: catalog.scopeKey,
      projectId, surface: "code", historyKind: "project" });
    void saveSurface().catch(() => {});
  }, [explicitSurface, surfaceKey, catalog?.scopeKey, projectId, projectRouteReady,
    surfaceQuery.isSuccess, restoredSurface, saveSurface]);
  const openingSurface = !projectRouteReady || !surfaceKey || (!explicitSurface &&
    (surfaceQuery.isPending || (surfaceQuery.isSuccess && restoredSurface === "native")));
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
  const fullPage = opened === "preview" && maximized;
  const showOnlySurface = Boolean(opened) && (narrow || maximized || (splitWidth > 0 && splitWidth < 620));

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
    if (!panel.current || !conversation.current) return;
    if (!opened) { conversation.current.expand(); panel.current.collapse(); return; }
    if (showOnlySurface) { conversation.current.collapse(); panel.current.resize("100%"); }
    else {
      conversation.current.expand();
      const available = split.current?.clientWidth ?? window.innerWidth;
      panel.current.resize(Math.min(width, Math.max(260, available - 360)));
    }
  }, [opened, showOnlySurface, width, splitWidth]);

  return <section className="workspace-page" aria-label="Project workspace">
    <header className="workspace-header">
      <div className="workspace-identity">
        <h1>{checking ? "Opening project" : unassigned ? "Unassigned conversations" : activeProject?.displayName ?? "Personal workspace"}</h1>
        <p>{unassigned ? "No project assigned" : native ? "Native chat" : "Project conversation"} / Connected host</p>
      </div>
      <div className="workspace-tools">
        <Button ref={detailsTrigger} size="sm" variant={opened === "details" ? "secondary" : "ghost"} aria-label="Project details"
          aria-pressed={opened === "details"} onClick={e => changeSurface(opened === "details" ? null : "details", e.currentTarget)}>
          <IconInfoCircle size={17} aria-hidden /><span>Details</span></Button>
        <Button ref={filesTrigger} size="sm" variant={opened === "files" ? "secondary" : "ghost"} aria-label="Open project files"
          aria-pressed={opened === "files"} onClick={e => changeSurface(opened === "files" ? null : "files", e.currentTarget)}>
          <IconFiles size={17} aria-hidden /><span>Files</span></Button>
        <Button ref={previewTrigger} size="sm" variant={opened === "preview" ? "secondary" : "ghost"} aria-label="Open page preview"
          aria-pressed={opened === "preview"} onClick={e => changeSurface(opened === "preview" ? null : "preview", e.currentTarget)}>
          <IconWorld size={17} aria-hidden /><span>Preview</span></Button>
        <Button ref={searchTrigger} size="sm" variant={opened === "search" ? "secondary" : "ghost"} aria-label="Search project files"
          aria-pressed={opened === "search"} onClick={e => changeSurface(opened === "search" ? null : "search", e.currentTarget)}>
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
    <div ref={split} className="workspace-split">
      <ResizablePanelGroup orientation="horizontal" onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction && !showOnlySurface && opened && panel.current && conversation.current) {
          // Keyboard callbacks precede DOM sizing. Apply the new layout to the stable panel total.
          const available = panel.current.getSize().inPixels + conversation.current.getSize().inPixels;
          const pixels = layout.surface / 100 * available;
          if (pixels >= 260) { savePanelWidth(WIDTH_KEY, pixels); setWidth(pixels); }
          if (panel.current.isCollapsed()) changeSurface(null);
        }
      }}>
        <ResizablePanel id="conversation" panelRef={conversation} minSize={showOnlySurface ? 0 : narrow ? 0 : 360}
          collapsible collapsedSize={0}>
          <div className="workspace-conversation" hidden={showOnlySurface}>
            {changingProject || openingSurface || (!explicitSurface && surfaceQuery.isError) ? <div className="local-agent-chat-skeleton" aria-busy="true">
              <Skeleton className="h-8 w-48" /><Skeleton className="h-5 w-3/4" />
              <Skeleton className="mt-auto h-28 w-full" />
            </div> : native ? <NativeConversation /> : <CodeConversation previewScope={previewScope} onPreviewChatTarget={setPreviewChatTarget} />}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle title="Drag to resize the work panel, or use the arrow keys" disabled={!opened || showOnlySurface} hidden={!opened || showOnlySurface}
          className="workspace-resize-handle workspace-work-panel-resize-handle" aria-label="Resize work panel" />
        <ResizablePanel id="surface" panelRef={panel} defaultSize={opened ? width : 0}
          minSize={showOnlySurface ? 0 : 260} collapsible collapsedSize={0}>
          <aside ref={surfaceElement} className={`workspace-surface${fullPage ? " workspace-surface-fullpage" : ""}`} hidden={!opened} aria-label="Work panel">
            <header className="workspace-surface-toolbar">
              <h2>{opened === "files" ? "Files" : opened === "preview" ? `Preview · ${activeProject?.displayName ?? "Personal workspace"}` : opened === "search" ? "Search" : "Project details"}</h2>
              {opened === "files" && <Button variant="ghost" size="sm" aria-expanded={fileTreeOpen}
                onClick={() => setFileTreeOpen(value => !value)}>{fileTreeOpen ? "Hide file list" : "Show file list"}</Button>}
              {opened === "preview" && <Button size="sm" variant="outline" aria-expanded={fullPage}
                onClick={() => setMaximized(value => !value)}>{fullPage ? <IconArrowsMinimize size={17} aria-hidden /> : <IconArrowsMaximize size={17} aria-hidden />}{fullPage ? "Back to workspace" : "Full page"}</Button>}
              {opened !== "preview" && !narrow && splitWidth >= 620 && <Button size="icon" variant="ghost" aria-label={maximized ? "Restore panel" : "Maximize panel"}
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
                <dt>Files and history</dt><dd>Stay on this host. Opening a file does not send it to a model.</dd></dl>
              {activeProject && <ProjectMemoryPanel projectId={activeProject.projectId} disabled={!workspaceAvailable}
                visible={opened === "details"} />}
              {activeProject && <ProjectReadPanel projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              {activeProject && <ProjectEvaluatePanel projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              {activeProject && <ProjectAdoption key={activeProject.projectId} projectId={activeProject.projectId} disabled={!workspaceAvailable} />}
              <p>Open Files to read a document. Choose Edit when you want to change it.</p>
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/runtimes")}>Runtime settings</Button>
              {!catalog && <p>Project details could not be loaded. Use Retry project.</p>}
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </section>;
}
