import { useChatThreads } from "@agent-native/core/client/agent-chat";
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
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ConversationInbox as InboxData, InboxAttention, InboxDraft, InboxRow } from "../../../server/conversation-inbox";
import type { VivaryChatIdentity } from "@/lib/chat-scope";
import { useNativeActionCaller, useNativeActionReader } from "@/lib/native-actions";
import { continueChatSearch } from "@/lib/chat-search-client";
import { chatSearchHref } from "@/lib/chat-search-location";
import { highlightedExcerpt } from "@/lib/chat-search-excerpt";
import type { ChatSearchHit, ChatSearchPage } from "@/lib/chat-search-schema";
import { focusAfterRemoval } from "@/lib/row-focus";
import { hasWorkspaceRoute, holdConversationRoute } from "@/lib/conversation-route-hold";
import { useAppStateWriter } from "@/lib/native-state";
import { CreateProjectForm } from "../projects/CreateProjectForm";
import { useOpenProjectFolder } from "../projects/open-project-folder";
import { useProjects } from "../projects/ProjectContext";
import { useVivaryChatIdentity } from "./use-vivary-chat-identity";
import "./conversation-inbox.css";

/** A row the inbox lists: a saved conversation from the server, or an unsent draft of the selected project. */
export type InboxListRow = Pick<InboxRow, "id" | "projectId" | "projectLabel" | "title" | "createdAt" | "pinned"
  | "archived" | "attention" | "runtime"> & { kind: InboxRow["kind"] | "draft"; draftLabel?: string;
  nativeScopeId: string | null; draft?: InboxRow["draft"] };

/**
 * `all`, `personal`, or a project ID. The filter only scopes the list and names where New conversation starts. It never
 * changes the open conversation or the selected project.
 */
export type InboxFilter = string;
const FILTER_KEY = "vivary-conversation-filter-v1";
const ALL_PROJECTS = "all";
const PERSONAL = "personal";
const filterProjectId = (filter: InboxFilter) => filter === PERSONAL ? null : filter;
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
export function visibleInboxRows(rows: readonly InboxListRow[], filter: InboxFilter,
  search: string): { active: InboxListRow[]; archived: InboxListRow[] } {
  const needle = search.trim().toLocaleLowerCase();
  const shown = rows.filter(row => (filter === ALL_PROJECTS || row.projectId === filterProjectId(filter))
    && (!needle || row.title.toLocaleLowerCase().includes(needle)));
  return { active: sortInboxRows(shown.filter(row => !row.archived)), archived: sortInboxRows(shown.filter(row => row.archived)) };
}

/** New conversations that exist only as unsent text. They are listed first, in their own Drafts block. */
export function inboxDraftRows(drafts: readonly InboxDraft[]): InboxListRow[] {
  return drafts.map(draft => ({
    id: draft.id, kind: "draft", projectId: draft.projectId, projectLabel: draft.projectLabel,
    title: draft.preview || "Untitled conversation", createdAt: draft.createdAt, pinned: false, archived: false,
    attention: "idle", runtime: null, nativeScopeId: null,
    draftLabel: draft.status === "pending" ? "Review send" : "Draft",
  }));
}

function useInboxFilter(scopeKey: string | null, projectIds: readonly string[]) {
  const queryClient = useQueryClient();
  const { writeAppState, ready } = useAppStateWriter();
  // Saves run one after another, so a slow earlier save never lands after a newer choice.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const saved = useQuery({
    queryKey: [FILTER_KEY, scopeKey], enabled: scopeKey !== null, retry: false, staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const value = await readClientAppState(FILTER_KEY, { signal }) as { scopeKey?: unknown; filter?: unknown } | null;
      return value?.scopeKey === scopeKey && typeof value?.filter === "string" ? value.filter : ALL_PROJECTS;
    },
  });
  // A saved project that has left the catalog lists every project rather than nothing.
  const stored = saved.data ?? ALL_PROJECTS;
  const filter: InboxFilter = stored === ALL_PROJECTS || stored === PERSONAL || projectIds.includes(stored)
    ? stored : ALL_PROJECTS;
  async function setFilter(next: InboxFilter) {
    // A choice made while the saved filter still loads wins, so the load is cancelled rather than applied after it.
    void queryClient.cancelQueries({ queryKey: [FILTER_KEY, scopeKey] });
    queryClient.setQueryData([FILTER_KEY, scopeKey], next);
    // The filter is a view preference. A failed save keeps the shown filter and retries on the next change.
    if (!ready || !scopeKey) return;
    const save = saving.current.then(() => writeAppState(FILTER_KEY, { scopeKey, filter: next })).catch(() => {});
    saving.current = save;
    await save;
  }
  return { filter, setFilter };
}

type NativeScope = {
  identity: VivaryChatIdentity;
  createThread: () => Promise<string | null>;
  switchThread: (threadId: string) => void;
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
  /** Opens a route in the selected project, held against the route restores that follow a project change. */
  hold: (href: string) => void;
  /** Opens a route in any project, selecting that project first when it is not the selected one. */
  openHref: (projectId: string | null, href: string) => Promise<void>;
  /** Starts a conversation in another project: selects it, then creates the conversation there. */
  startIn: (projectId: string | null, kind: "code" | "native") => Promise<void>;
  /** A Native conversation waiting for its project's Native scope. */
  pendingNative: string | null | undefined;
  clearPendingNative: () => void;
  refetchInbox: () => unknown;
  /** The route as it is now. A step that finishes after an await compares it with the route it started from. */
  currentRoute: () => string;
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
  const filter = useInboxFilter(catalog?.scopeKey ?? null, catalog?.projects.map(project => project.projectId) ?? []);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string>();
  const inbox = useActionQuery<InboxData>("vivary-conversation-inbox", {}, {
    // React Query pauses the interval while the window is hidden, so a background window reads nothing.
    enabled: catalog !== null, refetchInterval: 2000, refetchIntervalInBackground: false, retry: false,
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

  // A conversation in another project opens through the page's route hold, which outlasts the project change's route
  // reset and the new project's saved-view restore. CodeRunControl in the layout applies it.
  const location = useLocation();
  // An API chat is created after an await, so it reads the route as it is then, not as it was when creation began.
  const latestRoute = useRef(location);
  latestRoute.current = location;
  const currentRoute = () => latestRoute.current.pathname + latestRoute.current.search;
  const startedFrom = useRef<string | null>(null);
  // New conversation in another project is the explicit action that selects it. The API chat waits for that project's
  // Native scope.
  const [pendingNative, setPendingNative] = useState<string | null>();
  // Once the requested project was selected, any later project change drops the request, so returning to that project
  // later never creates an API chat the owner stopped waiting for.
  const pendingReached = useRef(false);
  useEffect(() => {
    if (pendingNative === undefined) { pendingReached.current = false; return; }
    if (checking) return;
    if (activeProjectId === pendingNative) pendingReached.current = true;
    else if (pendingReached.current) setPendingNative(undefined);
  }, [pendingNative, activeProjectId, checking]);

  async function openRow(row: InboxListRow, scope: NativeScope | null) {
    setNotice(undefined);
    if (row.archived) {
      // An archived conversation is restored before it opens. Native cannot open one, and a Code send never checks
      // archive, so a run could otherwise start hidden in the Archived section.
      const from = currentRoute();
      try {
        if (row.kind === "native") {
          await call("vivary-conversation-archive", { operation: "restore", projectId: row.projectId,
            threadId: row.id.slice("native:".length) });
          window.dispatchEvent(new CustomEvent("agent-chat:threads-updated"));
        } else {
          await call("vivary-code-conversation-meta", { operation: "restore", runId: row.id.slice("code:".length),
            projectId: row.projectId });
        }
      } catch (failure) {
        setNotice(actionErrorMessage(failure) ?? "The conversation could not be restored. Try again.");
        return;
      }
      void refetchInbox();
      // A conversation the owner opened while the restore ran keeps the route.
      if (currentRoute() !== from) return;
    }
    if (row.projectId === activeProjectId && row.id.startsWith("native:")) scope?.switchThread(row.id.slice("native:".length));
    await openHref(row.projectId, inboxRowHref(row));
  }

  // Project selections this inbox started that have not finished. While one runs, an open in the selected project also
  // goes through a hold and a selection, so it supersedes the pending one instead of losing to its later hold.
  const selectionsPending = useRef(0);
  async function select(projectId: string | null): Promise<boolean> {
    selectionsPending.current++;
    try { return await selectProject(projectId); } finally { selectionsPending.current--; }
  }

  async function openHref(projectId: string | null, href: string) {
    // Opening a conversation replaces a deferred API chat request.
    setPendingNative(undefined);
    if (projectId === activeProjectId && selectionsPending.current === 0) {
      navigate(href);
      return;
    }
    const release = holdConversationRoute(projectId, href);
    // A newer open owns the route by now, so a slow failure here neither releases it nor reports over it.
    if (!await select(projectId) && release()) {
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
          await call("vivary-conversation-archive", { operation: "restore", projectId: row.projectId,
            threadId: row.id.slice("native:".length) });
        } else {
          // One owner action, which a private-proxy browser can reach. Archive refuses while a turn runs, messages are
          // queued or a send is pending.
          await call("vivary-conversation-archive", { operation, projectId: row.projectId,
            threadId: row.id.slice("native:".length), ...(operation === "rename" ? { title } : {}) });
        }
        window.dispatchEvent(new CustomEvent("agent-chat:threads-updated"));
      }
      // An archived conversation's route closes: Native cannot show one, and an open Code composer could start a run
      // hidden in the Archived section. The route is read after the await, so a conversation opened meanwhile stays.
      if (operation === "archive" && selectedInboxRowId(latestRoute.current.search) === row.id) navigate("/");
    } catch (failure) {
      setNotice(actionErrorMessage(failure) ?? "The conversation could not be changed. Try again.");
    } finally {
      await refetchInbox();
    }
  }

  // A conversation created right after a project change. The route left behind and a bare route are held: Workspace
  // still clears the first, and the new project's restore can still fill the second. A route the restore already filled
  // stays put, so it is replaced directly.
  function hold(href: string) {
    const { pathname, search } = latestRoute.current;
    const route = pathname + search;
    if (route !== startedFrom.current && hasWorkspaceRoute(pathname, search)) navigate(href, { replace: true });
    else holdConversationRoute(activeProjectId, href);
    startedFrom.current = null;
  }
  async function startIn(projectId: string | null, kind: "code" | "native") {
    setNotice(undefined);
    const release = kind === "code" ? holdConversationRoute(projectId, "/?run=new&draft=" + crypto.randomUUID()) : null;
    if (kind === "native") {
      startedFrom.current = location.pathname + location.search;
      setPendingNative(projectId);
    }
    if (!await select(projectId)) {
      if (release && !release()) return;
      setPendingNative(current => current === projectId ? undefined : current);
      setNotice("That project is unavailable. Choose another destination.");
    }
  }

  const shared: Shared = { inbox, filter, search, setSearch, notice, setNotice, openRow, change, hold, openHref, startIn,
    pendingNative, clearPendingNative: () => setPendingNative(undefined), refetchInbox, currentRoute };
  return <ScopedInbox shared={shared} />;
}

function ScopedInbox({ shared }: { shared: Shared }) {
  const { identity } = useVivaryChatIdentity();
  return identity ? <NativeScoped key={identity.storageKey} identity={identity} shared={shared} />
    : <InboxView shared={shared} scope={null} />;
}

/** The selected project's Native history owner, which creates and selects its API chats. */
function NativeScoped({ identity, shared }: { identity: VivaryChatIdentity; shared: Shared }) {
  const native = useChatThreads(undefined, identity.storageKey, identity.scope, {
    autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false,
  });
  const scope: NativeScope = { identity, createThread: native.createThread, switchThread: native.switchThread };
  return <InboxView shared={shared} scope={scope} />;
}

function InboxView({ shared, scope }: { shared: Shared; scope: NativeScope | null }) {
  const { catalog, activeProject, checking, workspaceAvailable, selecting, selectProject, refresh } = useProjects();
  const { inbox, search, setSearch, notice, setNotice } = shared;
  const { filter } = shared.filter;
  const activeProjectId = activeProject?.projectId ?? null;
  // New conversation starts in the filtered project, or with All projects in the open conversation's project.
  const destinationId = filter === ALL_PROJECTS ? activeProjectId : filterProjectId(filter);
  const destinationProject = destinationId === null ? null
    : catalog?.projects.find(project => project.projectId === destinationId) ?? null;
  const destinationLabel = destinationProject?.displayName ?? "Personal workspace";
  const elsewhere = destinationId !== activeProjectId;
  const location = useLocation();
  const navigate = useNavigate();
  const { call } = useNativeActionCaller();
  const [creatingProject, setCreatingProject] = useState(false);
  const folderPicker = useOpenProjectFolder();
  const folder = useActionQuery<{ folderName: string; path: string }>("vivary-project-location",
    destinationId ? { projectId: destinationId } : {}, {
      enabled: elsewhere ? destinationProject?.status === "available" || destinationId === null : workspaceAvailable,
      retry: false, staleTime: 30_000 });
  const visible = visibleInboxRows(inbox.data?.rows ?? [], filter, search);
  const drafts = visibleInboxRows(inboxDraftRows(inbox.data?.drafts ?? []), filter, search).active;
  const selectedId = selectedInboxRowId(location.search);
  const draftsHeading = useId();

  const creatingNative = useRef(false);
  function newCode() {
    if (!codeReady) return;
    if (elsewhere) return void shared.startIn(destinationId, "code");
    navigate("/?run=new&draft=" + crypto.randomUUID());
  }
  // A Native conversation for another project is created once that project's Native scope has mounted.
  useEffect(() => {
    if (shared.pendingNative === undefined || checking || !scope || activeProjectId !== shared.pendingNative
      || scope.identity.projectId !== shared.pendingNative) return;
    shared.clearPendingNative();
    void newNative(true);
  }, [shared.pendingNative, checking, scope?.identity.projectId, activeProjectId]);
  async function newNative(afterProjectChange = false) {
    if (!afterProjectChange && elsewhere) return void shared.startIn(destinationId, "native");
    if (creatingNative.current || !scope) return;
    creatingNative.current = true;
    setNotice(undefined);
    const from = shared.currentRoute();
    try {
      const threadId = await scope.createThread();
      if (!threadId) throw new Error("No conversation ID was created.");
      // An empty Native conversation has no server thread row. Record its exact ID with the draft owner first.
      const initialized = await call<{ changed: boolean; record: { status: string } | null }>("vivary-chat-draft", {
        operation: "change", kind: scope.identity.kind, projectId: scope.identity.projectId, threadId, expected: null,
        next: { status: "cleared", text: "", submitId: null } });
      if (!initialized.changed || initialized.record?.status !== "cleared") throw new Error("Draft initialization failed.");
      const href = `/?runtime=native&history=project&thread=${encodeURIComponent(threadId)}`;
      if (afterProjectChange) shared.hold(href);
      // A conversation the owner opened while the chat was created keeps the route.
      else if (shared.currentRoute() === from) navigate(href);
    } catch {
      setNotice("The conversation could not be saved. Try again.");
    } finally {
      creatingNative.current = false;
    }
  }
  const params = new URLSearchParams(location.search);
  const startDefault = () => !codeReady || (params.get("runtime") === "native" && params.get("history") !== "unassigned")
    ? void newNative() : newCode();

  const loading = checking || inbox.isPending;
  // The empty message speaks for the whole inbox, so it waits while drafts or archived rows match, and the load error
  // already says why nothing is listed.
  const emptyLabel = inbox.isError || drafts.length || visible.archived.length ? ""
    : search ? "No conversations match this search." : "No conversations yet. Start one with New conversation.";
  const unavailable = inbox.data?.unavailableProjects.length ?? 0;
  const canStart = elsewhere ? destinationId === null || destinationProject?.status === "available" : workspaceAvailable;
  // Code runs in a folder. Personal workspace may have none, and then only its API chats exist, as the server lists.
  const codeReady = canStart && (!elsewhere || destinationId !== null || folder.data !== undefined);
  const section = useRef<HTMLElement>(null);
  const listProps = { selectedId, showProject: filter === ALL_PROJECTS,
    // A section that loses its last row hands focus to New conversation, as the project history does.
    fallbackFocus: () => section.current?.querySelector<HTMLElement>(".conversation-inbox__new-button") ?? null,
    onOpen: (row: InboxListRow) => void shared.openRow(row, scope),
    onChange: (row: InboxListRow, operation: RowOperation, title?: string) => void shared.change(row, operation, title) };
  return <section ref={section} className="conversation-inbox" aria-label="Conversations">
    <div className="conversation-inbox__header">
      <div className="conversation-inbox__new">
        <Button size="sm" className="conversation-inbox__new-button" disabled={!canStart} onClick={startDefault}>
          <IconPlus size={14} aria-hidden />New conversation</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Choose conversation type" disabled={!canStart}>
              <IconChevronDown size={14} aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!codeReady} onSelect={newCode}>Code conversation</DropdownMenuItem>
            <DropdownMenuItem disabled={!elsewhere && !scope} onSelect={() => void newNative()}>API chat (separate billing)</DropdownMenuItem>
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
        <span className="conversation-inbox__project">{destinationLabel}</span>
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
        <select value={filter} disabled={!catalog} onChange={event => void shared.filter.setFilter(event.target.value)}>
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
    {inbox.data?.limited && <p className="conversation-inbox__notice">
      Only the newest API chats are listed. Message search still finds older ones.</p>}
    {unavailable > 0 && <p className="conversation-inbox__notice">
      Code conversations of {unavailable === 1 ? "one project" : `${unavailable} projects`} are hidden until the
      project's folder is reconnected.</p>}
    {!loading && drafts.length > 0 && <section className="conversation-inbox__drafts" aria-labelledby={draftsHeading}>
      <h3 id={draftsHeading}>Drafts</h3>
      <InboxList label="Drafts" rows={drafts} {...listProps} emptyLabel="" />
    </section>}
    {loading ? <div className="vivary-history-skeleton" role="status"><span className="sr-only">Opening conversations</span>
      <span /><span /><span /></div>
      : <InboxList label="Conversations" rows={visible.active} {...listProps} emptyLabel={emptyLabel} />}
    {visible.archived.length > 0 && <details className="conversation-inbox__archived">
      <summary>Archived ({visible.archived.length})</summary>
      <InboxList label="Archived conversations" rows={visible.archived} {...listProps} emptyLabel="" />
    </details>}
    <InboxMessageSearch term={search.trim()} {...messageSearchScopes(filter, catalog?.projects ?? [], inbox.data?.rows ?? [])}
      rows={inbox.data?.rows ?? []} access={searchAccessKey(catalog)} onOpen={hit => void shared.openHref(hit.projectId, chatSearchHref(hit, false, ""))} />
  </section>;
}

type RowOperation = "rename" | "archive" | "restore" | "pin" | "unpin";

/** At most this many projects are searched for messages at once. A project filter searches exactly one. */
export const MAX_MESSAGE_SEARCH_SCOPES = 6;
type SearchScope = { projectId: string | null; label: string };

/**
 * The scopes message search reads. A project filter names one. All projects takes Personal workspace and the projects,
 * those with the newest conversations first, up to MAX_MESSAGE_SEARCH_SCOPES, and reports how many were left out.
 */
export function messageSearchScopes(filter: InboxFilter, projects: readonly { projectId: string; displayName: string }[],
  rows: readonly Pick<InboxRow, "projectId" | "createdAt">[]): { scopes: SearchScope[]; total: number } {
  const label = (projectId: string | null) => projectId === null ? "Personal workspace"
    : projects.find(project => project.projectId === projectId)?.displayName ?? projectId;
  if (filter !== ALL_PROJECTS) return { scopes: [{ projectId: filterProjectId(filter), label: label(filterProjectId(filter)) }], total: 1 };
  const newest = new Map<string | null, number>();
  for (const row of rows) newest.set(row.projectId, Math.max(newest.get(row.projectId) ?? 0, row.createdAt));
  const all = [null, ...projects.map(project => project.projectId)];
  const ordered = [...all].sort((left, right) => (newest.get(right) ?? -1) - (newest.get(left) ?? -1));
  return { scopes: ordered.slice(0, MAX_MESSAGE_SEARCH_SCOPES).map(projectId => ({ projectId, label: label(projectId) })),
    total: all.length };
}

/**
 * What a search result depends on besides its term: the owner's catalog scope, its policy, and each project's binding.
 * A change restarts message search, so hits from a revoked grant or an old binding are not kept on screen.
 */
function searchAccessKey(catalog: { scopeKey: string; policyRevision?: unknown;
  projects: readonly { projectId: string; bindingRevision?: unknown }[] } | null | undefined): string {
  return JSON.stringify([catalog?.scopeKey ?? null, catalog?.policyRevision ?? null,
    catalog?.projects.map(project => [project.projectId, project.bindingRevision ?? null]) ?? []]);
}

/** A scope whose search stopped with more to read, and the cursor to read from. */
type MoreToSearch = { scope: SearchScope; after: string };
type MessageSearchState = { key: string; status: "loading" | "ready" | "unavailable"; hits: ChatSearchHit[];
  /** Scopes whose last request failed. Search more retries them, so a missing project stays reported until it answers. */
  failed: SearchScope[]; more: MoreToSearch[] };
type SearchTarget = { scope: SearchScope; after?: string };
type ScopeResult = PromiseSettledResult<{ scope: SearchScope; hits: ChatSearchHit[]; after?: string }>;
const hitKey = (hit: ChatSearchHit) => JSON.stringify([hit.runtime, hit.sessionId, hit.referenceId]);

/** Adds one round of scope results, in the order of its targets, to the hits found so far. */
function mergeMessageSearch(key: string, previous: ChatSearchHit[], targets: SearchTarget[],
  results: ScopeResult[]): MessageSearchState {
  const found = new Map(previous.map(hit => [hitKey(hit), hit]));
  const more: MoreToSearch[] = [];
  const failed: SearchScope[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") { failed.push(targets[index].scope); return; }
    for (const hit of result.value.hits) found.set(hitKey(hit), hit);
    if (result.value.after) more.push({ scope: result.value.scope, after: result.value.after });
  });
  return { key, status: failed.length === results.length && !found.size ? "unavailable" : "ready", failed, more,
    hits: [...found.values()].sort((a, b) => (b.sessionUpdatedAt ?? 0) - (a.sessionUpdatedAt ?? 0)) };
}

/**
 * Searches user messages and agent replies through the existing `vivary-chat-search` owner action. Each scope reads
 * pages as `ChatSessionSearch` does, within `continueChatSearch`'s page and time budget, and Search more continues a
 * scope that stopped early. The title filter above stays instant. Selection and the list stay as they are while
 * results load.
 */
function InboxMessageSearch({ term, scopes, total, rows, access, onOpen }: { term: string; scopes: SearchScope[];
  total: number; rows: readonly Pick<InboxRow, "id" | "archived">[]; access: string; onOpen: (hit: ChatSearchHit) => void }) {
  const readAction = useNativeActionReader();
  const headingId = useId();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([term, scopes.map(scope => scope.projectId), access, retry]);
  const [state, setState] = useState<MessageSearchState>();
  // The current search's abort, which a later term or scope change aborts, Search more included.
  const running = useRef<AbortController | null>(null);
  function searchScopes(targets: SearchTarget[], signal: AbortSignal): Promise<ScopeResult[]> {
    return Promise.allSettled(targets.map(async ({ scope, after }) => {
      const hits: ChatSearchHit[] = [];
      let next = after;
      await continueChatSearch({ after, signal, onRequest: () => {},
        fetchPage: async from => {
          const params = new URLSearchParams({ query: term, unassigned: "false", includeArchived: "false" });
          if (scope.projectId) params.set("projectId", scope.projectId);
          if (from) params.set("after", from);
          const response = await readAction("vivary-chat-search", params, signal);
          if (!response.ok) throw new Error("Search could not finish.");
          return await response.json() as ChatSearchPage;
        },
        onPage: page => {
          // A title match is already a row in the list above, so Messages holds message matches only.
          hits.push(...page.results.filter(hit => hit.match === "content"));
          next = page.continueAfter ?? undefined;
        } });
      return { scope, hits, after: next };
    }));
  }
  useEffect(() => {
    if (term.length < 2) return;
    const abort = new AbortController();
    running.current = abort;
    setState({ key, status: "loading", hits: [], failed: [], more: [] });
    const timer = setTimeout(async () => {
      const targets = scopes.map(scope => ({ scope }));
      const results = await searchScopes(targets, abort.signal);
      if (!abort.signal.aborted) setState(mergeMessageSearch(key, [], targets, results));
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [key, readAction]);
  async function searchMore(from: MessageSearchState) {
    const abort = running.current;
    if (!abort || abort.signal.aborted) return;
    setState({ ...from, status: "loading" });
    // Continue the scopes that stopped early, and try the failed ones again from their start.
    const targets: SearchTarget[] = [...from.more, ...from.failed.map(scope => ({ scope }))];
    const results = await searchScopes(targets, abort.signal);
    if (!abort.signal.aborted) setState(mergeMessageSearch(key, from.hits, targets, results));
  }
  if (term.length < 2) return null;
  const current = state?.key === key ? state : undefined;
  const status = current?.status ?? "loading";
  // The search action does not know Code archive, so a Code conversation the list holds as archived is left out here,
  // as the search leaves out archived API chats.
  const archived = new Set(rows.filter(row => row.archived).map(row => row.id));
  const hits = (current?.hits ?? []).filter(hit => !archived.has(`${hit.runtime}:${hit.sessionId}`));
  return <section className="conversation-inbox__messages" aria-labelledby={headingId}>
    <h3 id={headingId}>Messages</h3>
    <p role="status" className="conversation-inbox__notice">
      {status === "loading" ? "Searching messages…"
        : status === "unavailable" ? "Message search is unavailable. Titles are still filtered."
          : `${hits.length ? `${hits.length} matching message${hits.length === 1 ? "" : "s"}` : "No messages match"}${
            current?.more.length || current?.failed.length ? " so far" : ""}.`}
    </p>
    {current?.status === "ready" && current.more.length + current.failed.length > 0 && <Button size="sm" variant="ghost"
      onClick={() => void searchMore(current)}>Search more</Button>}
    {status === "unavailable" && <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry search</Button>}
    {current?.status === "ready" && current.failed.length > 0 && <p className="conversation-inbox__notice">
      {current.failed.length === 1 ? "One project" : `${current.failed.length} projects`} could not be searched.</p>}
    {total > scopes.length && <p className="conversation-inbox__notice">
      Messages were searched in {scopes.length} of {total} projects. Choose a project in Show to search the rest.</p>}
    {hits.length > 0 && <ul className="conversation-inbox__list">{hits.map(hit =>
      <li key={JSON.stringify([hit.runtime, hit.sessionId, hit.referenceId])} className="conversation-inbox__row">
        <button type="button" className="conversation-inbox__row-button conversation-inbox__hit" onClick={() => onOpen(hit)}>
          <span className="conversation-inbox__title">{hit.title}</span>
          <span className="conversation-inbox__excerpt">{highlightedExcerpt(hit.excerpt, term)}</span>
          <span className="conversation-inbox__meta">
            <span className="conversation-inbox__detail">{hit.projectLabel}</span>
            <span className="conversation-inbox__detail">{hit.runtime === "native" ? "API chat" : "Code"}</span>
          </span>
        </button>
      </li>)}</ul>}
  </section>;
}

/**
 * The rows. One row takes Tab focus, the selected one or else the first. Arrow keys move between rows, Home and End
 * jump, Enter opens, and the Menu key, Shift+F10 or the row's menu button opens its actions.
 */
export function InboxList({ label, rows, selectedId, showProject, emptyLabel, fallbackFocus, onOpen, onChange }: {
  label: string; rows: InboxListRow[]; selectedId: string | null; showProject: boolean; emptyLabel: string;
  fallbackFocus?: () => HTMLElement | null;
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
    focusAfterRemoval<HTMLElement>(rowButtons(), pending.index, fallbackFocus?.() ?? null)?.focus();
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
            {row.draft && <span className="conversation-inbox__detail" data-draft={row.draft}>
              {row.draft === "pending" ? "Review send" : "Draft"}</span>}
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
            <ChatHistoryMenuItem onSelect={() => { setMenuId(null); setRenamingId(row.id); }}>
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

/**
 * Enter commits and Escape cancels. An empty title is refused with a message and the field stays open. Leaving the
 * field commits a changed title and cancels an empty one.
 */
function RenameField({ row, onDone }: { row: InboxListRow; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(row.title);
  const [empty, setEmpty] = useState(false);
  const errorId = useId();
  const done = useRef(false);
  const normalized = () => value.replace(/\s+/g, " ").trim().slice(0, 160);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return <div className="conversation-inbox__rename-field">
    <input className="conversation-inbox__rename" aria-label={`Rename ${row.title}`} value={value} maxLength={160}
      aria-invalid={empty || undefined} aria-describedby={empty ? errorId : undefined}
      autoFocus onChange={event => { setValue(event.target.value); setEmpty(false); }}
      onBlur={() => finish(normalized() || null)}
      onKeyDown={event => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (normalized()) finish(normalized());
          else setEmpty(true);
        }
        if (event.key === "Escape") { event.preventDefault(); finish(null); }
      }} />
    {empty && <p id={errorId} role="alert" className="conversation-inbox__notice">Enter a title, or press Escape to keep the current one.</p>}
  </div>;
}
