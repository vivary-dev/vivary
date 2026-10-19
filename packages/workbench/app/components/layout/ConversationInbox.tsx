import { useChatThreads } from "@agent-native/core/client/agent-chat";
import { agentNativePath } from "@agent-native/core/client/api-path";
import { actionErrorMessage, readClientAppState, useActionQuery } from "@agent-native/core/client/hooks";
import { ChatHistoryMenuItem } from "@agent-native/toolkit/chat-history";
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@agent-native/toolkit/ui";
import {
  IconAlertTriangle, IconArchive, IconArchiveOff, IconCheck, IconChevronDown, IconCircleDashed, IconDots,
  IconFolder, IconFolderPlus, IconHandStop, IconLoader2, IconPencil, IconPinned, IconPinnedOff, IconPlus,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ConversationInbox as InboxData, InboxAttention, InboxRow } from "../../../server/conversation-inbox";
import { codeDraftSelectionKey } from "../../../shared/code-draft";
import { useChatDraftList, type DraftListItem } from "@/lib/chat-draft";
import type { VivaryChatIdentity } from "@/lib/chat-scope";
import { useNativeActionCaller } from "@/lib/native-actions";
import { focusAfterRemoval } from "@/lib/row-focus";
import { useAppStateWriter } from "@/lib/native-state";
import { CreateProjectForm } from "../projects/CreateProjectForm";
import { useOpenProjectFolder } from "../projects/open-project-folder";
import { useProjects } from "../projects/ProjectContext";
import { useVivaryChatIdentity } from "./use-vivary-chat-identity";
import "./conversation-inbox.css";

/** A row the inbox lists: a saved conversation from the server, or an unsent draft of the selected project. */
export type InboxListRow = Pick<InboxRow, "id" | "projectId" | "projectLabel" | "title" | "createdAt" | "pinned"
  | "archived" | "attention" | "runtime"> & { kind: InboxRow["kind"] | "draft"; draftLabel?: string;
  nativeScopeId: string | null };

/** `all` lists every project. `project` follows the selected project, including Personal workspace. */
export type InboxFilterMode = "all" | "project";
const FILTER_KEY = "vivary-conversation-filter-v1";
const ALL_PROJECTS = "all";
const PERSONAL = "personal";
/** How long an opened conversation's route must hold before a later restore may replace it. */
const OPEN_SETTLE_MS = 750;
type PendingOpen = { projectId: string | null; href: string; from: string; landed: boolean };
/** The route keys `Workspace.tsx` clears when the selected project changes. */
const WORKSPACE_ROUTE_KEYS = ["panel", "path", "project", "runtime", "thread", "history", "run", "draft", "line", "message",
  "event", "eventOffset"];
/** Workspace renders only on the home route, so another page has no conversation route to clear. */
function hasWorkspaceRoute(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  return pathname === "/" && WORKSPACE_ROUTE_KEYS.some(key => params.has(key));
}

const ATTENTION: Record<InboxAttention, { label: string; icon: ReactNode } | null> = {
  "needs-approval": { label: "Needs approval", icon: <IconHandStop size={13} aria-hidden /> },
  stopping: { label: "Stopping", icon: <IconLoader2 size={13} aria-hidden /> },
  running: { label: "Running", icon: <IconLoader2 size={13} aria-hidden /> },
  failed: { label: "Failed", icon: <IconAlertTriangle size={13} aria-hidden /> },
  completed: { label: "Completed", icon: <IconCheck size={13} aria-hidden /> },
  idle: null,
};

/** The route that opens exactly this row. These are the same routes the Code and Native conversations read. */
export function inboxRowHref(row: Pick<InboxListRow, "id">): string {
  const [kind, ...parts] = row.id.split(":");
  const id = encodeURIComponent(parts.join(":"));
  if (kind === "native") return `/?runtime=native&history=project&thread=${id}`;
  if (kind === "code-draft") return `/?run=new&draft=${id}`;
  return `/?run=${id}`;
}

/** The row the current route opens, or null when the route names none. */
export function selectedInboxRowId(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("runtime") === "native") {
    const thread = params.get("thread");
    return params.get("history") === "unassigned" || !thread ? null : `native:${thread}`;
  }
  const run = params.get("run");
  if (run === "new") return params.get("draft") ? `code-draft:${params.get("draft")}` : null;
  return run ? `code:${run}` : null;
}

/** Pinned first, then newest created. Live status never reorders rows. */
export function sortInboxRows<Row extends Pick<InboxListRow, "id" | "pinned" | "createdAt">>(rows: Row[]): Row[] {
  return [...rows].sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Applies the project filter and the title search, and splits archived conversations out. */
export function visibleInboxRows(rows: readonly InboxListRow[], filter: { mode: InboxFilterMode; projectId: string | null },
  search: string): { active: InboxListRow[]; archived: InboxListRow[] } {
  const needle = search.trim().toLocaleLowerCase();
  const shown = rows.filter(row => (filter.mode === "all" || row.projectId === filter.projectId)
    && (!needle || row.title.toLocaleLowerCase().includes(needle)));
  return { active: sortInboxRows(shown.filter(row => !row.archived)), archived: sortInboxRows(shown.filter(row => row.archived)) };
}

/**
 * Unsent conversations of the selected project that have no saved row yet. A Native draft shares its thread's id. A
 * Code draft without a run opens through its draft key.
 */
export function inboxDraftRows(input: { projectId: string | null; projectLabel: string; savedIds: ReadonlySet<string>;
  nativeDrafts: readonly DraftListItem[]; codeDrafts: readonly DraftListItem[] }): InboxListRow[] {
  const draft = (id: string, item: DraftListItem): InboxListRow => ({
    id, kind: "draft", projectId: input.projectId, projectLabel: input.projectLabel,
    title: item.preview || "Untitled conversation", createdAt: item.createdAt, pinned: false, archived: false,
    attention: "idle", runtime: null, nativeScopeId: null,
    draftLabel: item.status === "pending" ? "Review send" : "Draft",
  });
  const native = input.nativeDrafts.filter(item => !input.savedIds.has(`native:${item.threadId}`))
    .map(item => draft(`native:${item.threadId}`, item));
  const code = input.codeDrafts.filter(item => !item.run).flatMap(item => {
    const key = codeDraftSelectionKey(input.projectId, item.threadId);
    return key ? [draft(`code-draft:${key}`, item)] : [];
  });
  return [...native, ...code];
}

function useInboxFilter(scopeKey: string | null) {
  const queryClient = useQueryClient();
  const { writeAppState, ready } = useAppStateWriter();
  const saved = useQuery({
    queryKey: [FILTER_KEY, scopeKey], enabled: scopeKey !== null, retry: false, staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const value = await readClientAppState(FILTER_KEY, { signal }) as { scopeKey?: unknown; mode?: unknown } | null;
      return value?.scopeKey === scopeKey && (value?.mode === "all" || value?.mode === "project") ? value.mode : "project";
    },
  });
  const mode: InboxFilterMode = saved.data ?? "project";
  async function setMode(next: InboxFilterMode) {
    queryClient.setQueryData([FILTER_KEY, scopeKey], next);
    // The filter is a view preference. A failed save keeps the shown filter and retries on the next change.
    if (ready && scopeKey) await writeAppState(FILTER_KEY, { scopeKey, mode: next }).catch(() => {});
  }
  return { mode, setMode, ready: saved.isSuccess };
}

async function changeNativeThread(row: InboxListRow, operation: "rename" | "pin" | "archive", body: unknown) {
  const threadId = row.id.slice("native:".length);
  const params = new URLSearchParams({ scopeType: "workspace-app", scopeId: row.nativeScopeId ?? "" });
  const response = await fetch(`${agentNativePath(`/_agent-native/agent-chat/threads/${encodeURIComponent(threadId)}/${operation}`)}?${params}`,
    { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("Native refused the change.");
}

type NativeScope = {
  identity: VivaryChatIdentity;
  createThread: () => Promise<string | null>;
  switchThread: (threadId: string) => void;
  nativeDrafts: DraftListItem[];
  codeDrafts: DraftListItem[];
};

type Shared = {
  inbox: { data?: InboxData; isPending: boolean; isError: boolean };
  filter: ReturnType<typeof useInboxFilter>;
  search: string;
  setSearch: (value: string) => void;
  notice: string | undefined;
  setNotice: (value: string | undefined) => void;
  openRow: (row: InboxListRow, scope: NativeScope | null) => Promise<void>;
  change: (row: InboxListRow, operation: RowOperation, title?: string) => Promise<void>;
  chooseFilter: (value: string) => Promise<void>;
  refetchInbox: () => unknown;
};

/**
 * The cross-project conversation list. State that must survive a project change (search, a pending open, notices)
 * lives here, because the selected project's Native scope below remounts on every change.
 */
export function ConversationInbox() {
  const { catalog, activeProject, checking, selectProject } = useProjects();
  const activeProjectId = activeProject?.projectId ?? null;
  const navigate = useNavigate();
  const { call } = useNativeActionCaller();
  const filter = useInboxFilter(catalog?.scopeKey ?? null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string>();
  const inbox = useActionQuery<InboxData>("vivary-conversation-inbox", {}, {
    enabled: catalog !== null, refetchInterval: 2000, retry: false,
  });
  const refetchInbox = inbox.refetch;
  useEffect(() => {
    const refresh = () => void refetchInbox();
    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", refresh);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", refresh);
    };
  }, [refetchInbox]);

  // A conversation in another project opens after its project is selected. Workspace.tsx clears the old conversation
  // route when the project changes, then the new project restores its saved conversation onto the bare route. Either
  // can land after this navigation, so the target is held: applied once the old route is gone, applied again if a
  // restore replaces it, and released once it has held for a moment or the owner presses a key or the pointer.
  const location = useLocation();
  const [pendingOpen, setPendingOpen] = useState<PendingOpen>();
  const route = location.pathname + location.search;
  useEffect(() => {
    if (!pendingOpen || checking || activeProjectId !== pendingOpen.projectId) return;
    if (route === pendingOpen.href) {
      if (!pendingOpen.landed) { setPendingOpen({ ...pendingOpen, landed: true }); return; }
      const release = setTimeout(() => setPendingOpen(current => current === pendingOpen ? undefined : current),
        OPEN_SETTLE_MS);
      return () => clearTimeout(release);
    }
    // Workspace would clear a target that lands before the old route, so wait for the old route to go.
    if (!pendingOpen.landed && route === pendingOpen.from && hasWorkspaceRoute(location.pathname, location.search)) return;
    navigate(pendingOpen.href, { replace: pendingOpen.landed });
  }, [pendingOpen, checking, activeProjectId, route, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!pendingOpen) return;
    const ownerActed = () => setPendingOpen(undefined);
    document.addEventListener("keydown", ownerActed, true);
    document.addEventListener("pointerdown", ownerActed, true);
    return () => {
      document.removeEventListener("keydown", ownerActed, true);
      document.removeEventListener("pointerdown", ownerActed, true);
    };
  }, [pendingOpen !== undefined]);

  async function openRow(row: InboxListRow, scope: NativeScope | null) {
    setNotice(undefined);
    if (row.kind === "native" && row.archived) {
      // Native cannot open an archived conversation, so opening one restores it first, as the archive list did.
      try {
        await call("vivary-native-archive", { operation: "restore", projectId: row.projectId,
          threadId: row.id.slice("native:".length) });
        window.dispatchEvent(new CustomEvent("agent-chat:threads-updated"));
      } catch (failure) {
        setNotice(actionErrorMessage(failure) ?? "The conversation could not be restored. Try again.");
        return;
      }
    }
    const href = inboxRowHref(row);
    if (row.projectId === activeProjectId) {
      if (row.id.startsWith("native:")) scope?.switchThread(row.id.slice("native:".length));
      navigate(href);
      return;
    }
    setPendingOpen({ projectId: row.projectId, href, from: route, landed: false });
    if (!await selectProject(row.projectId)) {
      setPendingOpen(undefined);
      setNotice("That project is unavailable. Its conversations are retained.");
    }
  }

  async function change(row: InboxListRow, operation: RowOperation, title?: string) {
    setNotice(undefined);
    try {
      if (row.kind === "code") {
        await call("vivary-code-conversation-meta", { operation, runId: row.id.slice("code:".length),
          projectId: row.projectId, ...(operation === "rename" ? { title } : {}) });
      } else if (row.kind === "native") {
        if (operation === "restore") {
          await call("vivary-native-archive", { operation: "restore", projectId: row.projectId,
            threadId: row.id.slice("native:".length) });
        } else if (operation === "rename") await changeNativeThread(row, "rename", { title });
        else if (operation === "archive") {
          await changeNativeThread(row, "archive", { archived: true });
          // Native cannot show an archived conversation, so its open route closes, as in the project history.
          if (selectedInboxRowId(location.search) === row.id) navigate("/");
        } else await changeNativeThread(row, "pin", { pinned: operation === "pin" });
        window.dispatchEvent(new CustomEvent("agent-chat:threads-updated"));
      }
    } catch (failure) {
      setNotice(actionErrorMessage(failure) ?? "The conversation could not be changed. Try again.");
    } finally {
      await refetchInbox();
    }
  }

  async function chooseFilter(value: string) {
    if (value === ALL_PROJECTS) return filter.setMode("all");
    await filter.setMode("project");
    const projectId = value === PERSONAL ? null : value;
    if (projectId !== activeProjectId) await selectProject(projectId);
  }

  const shared: Shared = { inbox, filter, search, setSearch, notice, setNotice, openRow, change, chooseFilter, refetchInbox };
  return <ScopedInbox shared={shared} />;
}

function ScopedInbox({ shared }: { shared: Shared }) {
  const { identity } = useVivaryChatIdentity();
  return identity ? <NativeScoped key={identity.storageKey} identity={identity} shared={shared} />
    : <InboxView shared={shared} scope={null} />;
}

/** The selected project's Native history owner and its drafts, as in the project history this list replaces. */
function NativeScoped({ identity, shared }: { identity: VivaryChatIdentity; shared: Shared }) {
  const { historyAvailable } = useProjects();
  const native = useChatThreads(undefined, identity.storageKey, identity.scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  const nativeDrafts = useChatDraftList({ kind: identity.kind, projectId: identity.projectId }, identity.storageKey,
    historyAvailable);
  const codeDrafts = useChatDraftList({ kind: "code", projectId: identity.projectId }, identity.storageKey + ":code",
    historyAvailable);
  const scope: NativeScope = { identity, createThread: native.createThread, switchThread: native.switchThread,
    nativeDrafts: nativeDrafts.data?.drafts ?? [], codeDrafts: codeDrafts.data?.drafts ?? [] };
  return <InboxView shared={shared} scope={scope} />;
}

function InboxView({ shared, scope }: { shared: Shared; scope: NativeScope | null }) {
  const { catalog, activeProject, checking, workspaceAvailable, selecting, selectProject, refresh } = useProjects();
  const { inbox, filter, search, setSearch, notice, setNotice } = shared;
  const activeProjectId = activeProject?.projectId ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const { call } = useNativeActionCaller();
  const [creatingProject, setCreatingProject] = useState(false);
  const folderPicker = useOpenProjectFolder();
  const folder = useActionQuery<{ folderName: string; path: string }>("vivary-project-location",
    activeProjectId ? { projectId: activeProjectId } : {}, { enabled: workspaceAvailable, retry: false, staleTime: 30_000 });
  const projectLabel = activeProject?.displayName ?? "Personal workspace";
  const saved: InboxListRow[] = inbox.data?.rows ?? [];
  const rows = [...saved, ...inboxDraftRows({ projectId: activeProjectId, projectLabel,
    savedIds: new Set(saved.map(row => row.id)), nativeDrafts: scope?.nativeDrafts ?? [],
    codeDrafts: scope?.codeDrafts ?? [] })];
  const visible = visibleInboxRows(rows, { mode: filter.mode, projectId: activeProjectId }, search);
  const selectedId = selectedInboxRowId(location.search);

  const creatingNative = useRef(false);
  function newCode() {
    navigate("/?run=new&draft=" + crypto.randomUUID());
  }
  async function newNative() {
    if (creatingNative.current || !scope) return;
    creatingNative.current = true;
    setNotice(undefined);
    try {
      const threadId = await scope.createThread();
      if (!threadId) throw new Error("No conversation ID was created.");
      // An empty Native conversation has no server thread row. Record its exact ID with the draft owner first.
      const initialized = await call<{ changed: boolean; record: { status: string } | null }>("vivary-chat-draft", {
        operation: "change", kind: scope.identity.kind, projectId: scope.identity.projectId, threadId, expected: null,
        next: { status: "cleared", text: "", submitId: null } });
      if (!initialized.changed || initialized.record?.status !== "cleared") throw new Error("Draft initialization failed.");
      navigate(`/?runtime=native&history=project&thread=${encodeURIComponent(threadId)}`);
    } catch {
      setNotice("The conversation could not be saved. Try again.");
    } finally {
      creatingNative.current = false;
    }
  }
  const params = new URLSearchParams(location.search);
  const startDefault = () => params.get("runtime") === "native" && params.get("history") !== "unassigned"
    ? void newNative() : newCode();

  const filterValue = filter.mode === "all" ? ALL_PROJECTS : activeProjectId ?? PERSONAL;
  const loading = checking || inbox.isPending;
  const unavailable = inbox.data?.unavailableProjects.length ?? 0;
  const listProps = { selectedId, showProject: filter.mode === "all",
    onOpen: (row: InboxListRow) => void shared.openRow(row, scope),
    onChange: (row: InboxListRow, operation: RowOperation, title?: string) => void shared.change(row, operation, title) };
  return <section className="conversation-inbox" aria-label="Conversations">
    <div className="conversation-inbox__header">
      <div className="conversation-inbox__new">
        <Button size="sm" className="conversation-inbox__new-button" disabled={!workspaceAvailable} onClick={startDefault}>
          <IconPlus size={14} aria-hidden />New conversation</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Choose conversation type" disabled={!workspaceAvailable}>
              <IconChevronDown size={14} aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={newCode}>Code conversation</DropdownMenuItem>
            <DropdownMenuItem disabled={!scope} onSelect={() => void newNative()}>API chat (separate billing)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Add project" disabled={checking || selecting}>
              <IconFolderPlus size={15} aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setCreatingProject(true)}>New project (creates a folder)</DropdownMenuItem>
            {folderPicker.available && <DropdownMenuItem disabled={folderPicker.choosing}
              onSelect={() => void folderPicker.openFolder()}>Open existing folder</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="conversation-inbox__destination">
        <span className="sr-only">New conversations start in </span>
        <span className="conversation-inbox__project">{projectLabel}</span>
        {folder.data && <TooltipProvider><Tooltip>
          <TooltipTrigger asChild>
            <span className="conversation-inbox__folder" tabIndex={0}>
              <IconFolder size={13} aria-hidden />{folder.data.folderName}
              <span className="sr-only">, folder {folder.data.path}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{folder.data.path}</TooltipContent>
        </Tooltip></TooltipProvider>}
      </p>
      {folderPicker.error && <p role="status">{folderPicker.error}</p>}
      {creatingProject && <CreateProjectForm disabled={checking || selecting} onClose={() => setCreatingProject(false)}
        onCreated={async projectId => { await refresh(); return selectProject(projectId); }} />}
      <label className="conversation-inbox__filter">
        <span>Show</span>
        <select value={filterValue} disabled={!catalog || selecting}
          onChange={event => void shared.chooseFilter(event.target.value)}>
          <option value={ALL_PROJECTS}>All projects</option>
          <option value={PERSONAL}>Personal workspace</option>
          {catalog?.projects.map(project => <option key={project.projectId} value={project.projectId}>
            {project.displayName}</option>)}
        </select>
      </label>
      <input type="search" className="conversation-inbox__search" placeholder="Search conversations"
        aria-label="Search conversations by title" value={search} onChange={event => setSearch(event.target.value)} />
    </div>
    {notice && <p role="alert" className="conversation-inbox__notice">{notice}</p>}
    {inbox.isError && <div role="alert" className="conversation-inbox__notice">
      <p>Conversations could not be loaded. Your history is preserved.</p>
      <Button size="sm" variant="ghost" onClick={() => void shared.refetchInbox()}>Retry</Button>
    </div>}
    {unavailable > 0 && <p className="conversation-inbox__notice">
      Code conversations of {unavailable === 1 ? "one project" : `${unavailable} projects`} are hidden until the
      project's folder is reconnected.</p>}
    {loading ? <div className="vivary-history-skeleton" role="status"><span className="sr-only">Opening conversations</span>
      <span /><span /><span /></div>
      : <InboxList label="Conversations" rows={visible.active} {...listProps}
        emptyLabel={search ? "No conversations match this search." : "No conversations yet. Start one with New conversation."} />}
    {visible.archived.length > 0 && <details className="conversation-inbox__archived">
      <summary>Archived ({visible.archived.length})</summary>
      <InboxList label="Archived conversations" rows={visible.archived} {...listProps} emptyLabel="" />
    </details>}
  </section>;
}

type RowOperation = "rename" | "archive" | "restore" | "pin" | "unpin";

/**
 * The rows. One row takes Tab focus, the selected one or else the first. Arrow keys move between rows, Home and End
 * jump, Enter opens, and the Menu key, Shift+F10 or the row's menu button opens its actions.
 */
export function InboxList({ label, rows, selectedId, showProject, emptyLabel, onOpen, onChange }: {
  label: string; rows: InboxListRow[]; selectedId: string | null; showProject: boolean; emptyLabel: string;
  onOpen: (row: InboxListRow) => void; onChange: (row: InboxListRow, operation: RowOperation, title?: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Issue #131. Archive or Restore moves the row to the other section and removes the control that held focus. Once it
  // leaves, focus moves to the row that took its place, unless the owner has already moved focus elsewhere.
  const removed = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const pending = removed.current;
    if (!pending || rows.some(row => row.id === pending.id)) return;
    removed.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !list.current?.contains(active)) return;
    focusAfterRemoval(rowButtons(), pending.index, null)?.focus();
  }, [rows]);
  const tabStop = rows.some(row => row.id === focusId) ? focusId
    : rows.some(row => row.id === selectedId) ? selectedId : rows[0]?.id ?? null;
  if (!rows.length) return emptyLabel ? <p className="conversation-inbox__empty">{emptyLabel}</p> : null;
  function rowButtons() {
    return [...list.current?.querySelectorAll<HTMLButtonElement>(".conversation-inbox__row-button") ?? []];
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, row: InboxListRow, index: number) {
    const buttons = rowButtons();
    const move = (next: number) => {
      event.preventDefault();
      const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
      target?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      setMenuId(row.id);
    }
  }
  return <ul ref={list} className="conversation-inbox__list" aria-label={label}>
    {rows.map((row, index) => {
      const state = ATTENTION[row.attention];
      const selected = row.id === selectedId;
      const menu = row.kind !== "draft";
      return <li key={row.id} className="conversation-inbox__row" data-selected={selected || undefined}>
        {renamingId === row.id ? <RenameField row={row} onDone={title => {
          setRenamingId(null);
          if (title && title !== row.title) onChange(row, "rename", title);
          requestAnimationFrame(() => rowButtons().find(button => button.dataset.rowId === row.id)?.focus());
        }} /> : <button type="button" className="conversation-inbox__row-button" data-row-id={row.id}
          tabIndex={row.id === tabStop ? 0 : -1} aria-current={selected ? "true" : undefined}
          onFocus={() => setFocusId(row.id)} onClick={() => onOpen(row)} onKeyDown={event => onKeyDown(event, row, index)}>
          <span className="conversation-inbox__title">
            {row.pinned && <IconPinned size={12} aria-label="Pinned" />}{row.title}
          </span>
          <span className="conversation-inbox__meta">
            {row.draftLabel ? <span className="conversation-inbox__state" data-state="draft">
              <IconCircleDashed size={13} aria-hidden />{row.draftLabel}</span>
              : state && <span className="conversation-inbox__state" data-state={row.attention}>{state.icon}{state.label}</span>}
            {showProject && <span className="conversation-inbox__detail">{row.projectLabel}</span>}
            {row.runtime && <span className="conversation-inbox__detail">{row.runtime}</span>}
          </span>
        </button>}
        {menu && renamingId !== row.id && <DropdownMenu open={menuId === row.id}
          onOpenChange={open => setMenuId(open ? row.id : null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="conversation-inbox__menu-trigger" tabIndex={-1}
              aria-label={`Actions for ${row.title}`}><IconDots size={14} aria-hidden /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => {
            // Focus returns to the row, which holds the list's Tab stop, rather than to the hidden menu button.
            event.preventDefault();
            if (renamingId !== row.id) rowButtons().find(button => button.dataset.rowId === row.id)?.focus();
          }}>
            <ChatHistoryMenuItem onSelect={() => setRenamingId(row.id)}>
              <IconPencil size={13} aria-hidden /><span>Rename</span></ChatHistoryMenuItem>
            {!row.archived && <ChatHistoryMenuItem onSelect={() => onChange(row, row.pinned ? "unpin" : "pin")}>
              {row.pinned ? <IconPinnedOff size={13} aria-hidden /> : <IconPinned size={13} aria-hidden />}
              <span>{row.pinned ? "Unpin" : "Pin"}</span></ChatHistoryMenuItem>}
            <ChatHistoryMenuItem onSelect={() => {
              removed.current = { id: row.id, index };
              onChange(row, row.archived ? "restore" : "archive");
            }}>
              {row.archived ? <IconArchiveOff size={13} aria-hidden /> : <IconArchive size={13} aria-hidden />}
              <span>{row.archived ? "Restore" : "Archive"}</span></ChatHistoryMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </li>;
    })}
  </ul>;
}

function RenameField({ row, onDone }: { row: InboxListRow; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(row.title);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title === null ? null : title.replace(/\s+/g, " ").trim().slice(0, 160) || null);
  };
  return <input className="conversation-inbox__rename" aria-label={`Rename ${row.title}`} value={value} maxLength={160}
    autoFocus onChange={event => setValue(event.target.value)} onBlur={() => finish(value)}
    onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); finish(value); }
      if (event.key === "Escape") { event.preventDefault(); finish(null); }
    }} />;
}
