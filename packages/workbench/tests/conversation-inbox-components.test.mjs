import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// The production inbox, its row list, Router and query lifecycle run unchanged. Host services are fixtures: the project
// selection, the Native caller, the action reads, and the dropdown primitives (linkedom has no pointer or layout).
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event,
  CustomEvent: window.CustomEvent,
  requestAnimationFrame: callback => setTimeout(callback, 0), IS_REACT_ACT_ENVIRONMENT: true });
// linkedom tracks no focus. The proof records focus() calls, serves them as activeElement, and emits focusin for React.
let focused = null;
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused?.isConnected ? focused : document.body });
window.HTMLElement.prototype.focus = function focus() {
  focused = this;
  this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
};
const { createRoot } = await import("react-dom/client");
const fixture = `globalThis.inboxFixture`;
const stubs = new Map([
  ["@agent-native/core/client/navigation", `export const openCommandMenu = () => ${fixture}.calls.push({ name: "command-menu" });`],
  ["../projects/ProjectNavigation", `import { createElement } from "react";
    export const ProjectNavigation = () => createElement("nav", { "aria-label": "Project selection" }, "Projects");`],
  ["./ProjectHistory", `import { createElement } from "react";
    export const ProjectHistory = () => createElement("div", { "data-old-history": true }, "Old project history");`],
  ["./ChatHistory", `import { createElement } from "react";
    export const ChatHistory = ({ identity }) => createElement("div", { "data-legacy-scope": identity.storageKey }, "Legacy conversations");`],
  ["../projects/ProjectContext", `import { useSyncExternalStore } from "react";
    export function useProjects() {
      useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
      return ${fixture}.projects();
    }`],
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: (...args) => ${fixture}.call(...args) });
    const reader = (name, params) => ${fixture}.search(name, Object.fromEntries(params));
    export const useNativeActionReader = () => reader;`],
  ["@/lib/native-state", `export const useAppStateWriter = () => ({ ready: true,
    writeAppState: async (key, value) => { await ${fixture}.writeDelay?.(value);
      ${fixture}.state.set(key, value); return value; } });`],
  ["@/lib/chat-draft", `export const useChatDraftList = scope => ({ data: { drafts: ${fixture}.drafts[scope.kind] ?? [] } });`],
  ["./use-vivary-chat-identity", `export const useVivaryChatIdentity = kind => ({ identity:
    kind === "unassigned" ? ${fixture}.unassignedIdentity : ${fixture}.identity(),
    isError: kind !== "unassigned" && ${fixture}.identityError,
    refetch: () => { ${fixture}.calls.push({ name: "retry-identity" });
      ${fixture}.identityError = false; ${fixture}.identityBlocked = undefined; ${fixture}.notify(); } });`],
  ["@agent-native/core/client/agent-chat", `export const useChatThreads = () => ({ createThread: async () => "new-native",
    switchThread: id => ${fixture}.switched.push(id) });`],
  ["@agent-native/core/client/api-path", `export const agentNativePath = path => path;`],
  ["@agent-native/core/client/hooks", `import { useQuery } from "@tanstack/react-query";
    export const actionErrorMessage = failure => failure?.message;
    export const callAction = (name, input, options) => {
      if (options?.method !== "GET") throw new Error("Expected an action read");
      return ${fixture}.read(name, input);
    };
    export const readClientAppState = async key => { const value = ${fixture}.state.get(key) ?? null;
      await ${fixture}.readDelay; return value; };
    export function useActionQuery(name, input, options = {}) {
      return useQuery({ queryKey: ["action", name, input], queryFn: () => ${fixture}.read(name, input),
        enabled: options.enabled !== false, retry: false, staleTime: Infinity });
    }`],
  ["../projects/CreateProjectForm", `export const CreateProjectForm = () => null;`],
  ["../projects/open-project-folder", `export const useOpenProjectFolder = () => ({ available: true, choosing: false,
    openFolder: async () => ${fixture}.calls.push({ name: "open-folder" }) });`],
  ["@agent-native/toolkit/chat-history", `import { createElement } from "react";
    export const ChatHistoryMenuItem = ({ onSelect, children }) => createElement("button", { type: "button",
      role: "menuitem", onClick: event => onSelect?.(event) }, children);`],
  ["@agent-native/toolkit/ui", `import { createContext, createElement, cloneElement, useContext, useState, Fragment } from "react";
    const Menu = createContext(null);
    export const Button = ({ size, variant, ...props }) => createElement("button", { type: "button", ...props });
    export function DropdownMenu({ open, onOpenChange, children }) {
      const [own, setOwn] = useState(false);
      const value = open === undefined ? { open: own, set: setOwn } : { open, set: onOpenChange };
      return createElement(Menu.Provider, { value }, children);
    }
    export function DropdownMenuTrigger({ children }) {
      const menu = useContext(Menu);
      return cloneElement(children, { onClick: () => menu.set(!menu.open), "data-state": menu.open ? "open" : "closed" });
    }
    export function DropdownMenuContent({ children }) {
      const menu = useContext(Menu);
      return menu.open ? createElement("div", { role: "menu" }, children) : null;
    }
    export function DropdownMenuItem({ onSelect, disabled, children }) {
      const menu = useContext(Menu);
      return createElement("button", { type: "button", role: "menuitem", disabled,
        onClick: event => { menu.set(false); onSelect?.(event); } }, children);
    }
    export const Tooltip = ({ children }) => createElement(Fragment, null, children);
    export const TooltipProvider = Tooltip, TooltipTrigger = Tooltip;
    export const TooltipContent = ({ children }) => createElement("span", { role: "tooltip" }, children);`],
]);
const bundle = await build({ stdin: { contents: `
  import { createElement, useEffect, useState, useSyncExternalStore } from "react";
  import { MemoryRouter, useLocation, useSearchParams } from "react-router";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { ConversationInbox } from "./app/components/layout/ConversationInbox";
  import { Sidebar } from "./app/components/layout/Sidebar";
  import { useConversationRouteHold } from "./app/lib/conversation-route-hold";
  // The layout applies the page's route hold through CodeRunControl. The fixture applies it the same way.
  function HoldApplier() {
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    const projects = ${fixture}.projects();
    useConversationRouteHold({ activeProjectId: projects.activeProject?.projectId ?? null, checking: projects.checking });
    return null;
  }
  export { visibleInboxRows, inboxRowHref, selectedInboxRowId, sortInboxRows, messageSearchScopes } from "./app/components/layout/ConversationInbox";
  function Location() { return createElement("output", { id: "route" }, useLocation().search); }
  // The route reset Workspace.tsx applies when the project changes, copied so the inbox's open sequence meets it.
  function ProjectRouteReset() {
    const [params, setParams] = useSearchParams();
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    const current = ${fixture}.projects().activeProject?.projectId ?? "personal";
    const [ready, setReady] = useState(null);
    useEffect(() => {
      if (ready === null) { setReady(current); return; }
      if (ready === current) return;
      const routeKeys = ["panel", "path", "project", "runtime", "thread", "history", "run", "draft"];
      if (routeKeys.some(key => params.has(key))) {
        setParams(previous => { const next = new URLSearchParams(previous); for (const key of routeKeys) next.delete(key); return next; },
          { replace: true });
        return;
      }
      setReady(current);
    }, [ready, current, params.toString(), setParams]);
    // The ready project's conversation puts its saved selection back on a bare route, as CodeConversation's showInUrl
    // and Workspace's saved-surface restore do.
    useEffect(() => {
      if (ready !== current || [...params.keys()].length) return;
      const saved = ${fixture}.savedRoutes?.[current];
      if (saved) setParams(new URLSearchParams(saved), { replace: true });
    }, [ready, current, params.toString(), setParams]);
    return null;
  }
  export function view(route, sidebar = false) {
    const client = ${fixture}.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [route] },
      createElement(HoldApplier), createElement(sidebar ? Sidebar : ConversationInbox,
        sidebar ? { onCollapsedChange: value => ${fixture}.calls.push({ name: "collapse", value }) } : undefined),
      sidebar === 2 && createElement(Sidebar, { collapsible: false }),
      createElement(ProjectRouteReset), createElement(Location)));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", loader: { ".css": "empty" }, external: ["react", "react/*", "react-dom/*", "react-router", "@tanstack/react-query"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

const catalog = { scopeKey: "scope", projects: [{ projectId: "alpha", displayName: "Alpha", status: "available" },
  { projectId: "beta", displayName: "Beta", status: "available" }] };
const FILTER = "vivary-conversation-filter-v1";
const row = (id, projectId, title, createdAt, extra = {}) => ({ id, kind: id.split(":")[0], projectId,
  projectLabel: projectId === "alpha" ? "Alpha" : projectId === "beta" ? "Beta" : "Personal workspace", title, createdAt,
  updatedAt: createdAt, runtime: id.startsWith("code:") ? "Claude Code" : null, model: null, pinned: false, archived: false,
  attention: "idle", nativeScopeId: id.startsWith("native:") ? `scope-${projectId}` : null, ...extra });
const rows = () => [
  row("code:a1", "alpha", "Fix table wrapping", 50, { attention: "needs-approval" }),
  row("native:a2", "alpha", "Write launch notes", 40, { attention: "completed" }),
  row("code:a3", "alpha", "Old pinned plan", 10, { pinned: true }),
  row("code:b1", "beta", "Review onboarding", 45, { attention: "running" }),
  row("native:p1", null, "Personal question", 30, { attention: "failed" }),
  row("code:a4", "alpha", "Finished cleanup", 20, { archived: true }),
];
let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const listeners = new Set();
  let latestSelection = 0;
  globalThis.inboxFixture = {
    version: 0, active: "alpha", calls: [], switched: [], state: new Map(), drafts: {}, rows: rows(),
    selectionCommits: [], failedSelections: [],
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { inboxFixture.version++; for (const listener of listeners) listener(); },
    // A project named in identityBlocked has not loaded its Native identity yet.
    identity: () => inboxFixture.identityBlocked === inboxFixture.active ? null : ({ kind: "project",
      projectId: inboxFixture.active, storageKey: `key-${inboxFixture.active}`,
      scope: { type: "workspace-app", id: `scope-${inboxFixture.active}` } }),
    projects: () => ({ catalog: inboxFixture.catalog ?? catalog, checking: false, workspaceAvailable: true, historyAvailable: true, selecting: false,
      activeProject: catalog.projects.find(project => project.projectId === inboxFixture.active) ?? null,
      refresh: async () => {},
      selectProject: async projectId => {
        const attempt = ++latestSelection;
        inboxFixture.calls.push({ name: "selectProject", projectId });
        await (inboxFixture.selectionWait?.(projectId) ?? new Promise(resolve => setTimeout(resolve, 5)));
        // ProjectContext refuses stale requests before they can change the selected project.
        if (attempt !== latestSelection || inboxFixture.failedSelections.includes(projectId)) return false;
        inboxFixture.selectionCommits.push(projectId);
        inboxFixture.active = projectId; inboxFixture.notify(); return true;
      } }),
    read: async (name, input) => {
      if (name === "vivary-conversation-inbox") return { rows: inboxFixture.rows, drafts: inboxFixture.serverDrafts ?? [],
        unavailableProjects: [], limited: inboxFixture.limited ?? false };
      if (name === "vivary-project-location" && !input.projectId && inboxFixture.noPersonalFolder) {
        return null;
      }
      if (name === "vivary-project-location") return { folderName: `${input.projectId ?? "home"}-folder`,
        path: `/work/${input.projectId ?? "home"}-folder` };
      throw new Error("Unexpected read " + name);
    },
    call: async (name, input) => { inboxFixture.calls.push({ name, input }); return { changed: true }; },
    searches: [],
    search: async (name, params) => {
      inboxFixture.searches.push({ name, params });
      if (inboxFixture.searchFails || inboxFixture.failProjects?.includes(params.projectId ?? null)) {
        return new Response("{}", { status: 503 });
      }
      // pages, when set, answers by cursor and stops each request after one hit, as a long search would.
      const page = inboxFixture.pages?.[params.after ?? ""];
      const hits = (page?.results ?? inboxFixture.hits ?? []).filter(hit => hit.projectId === (params.projectId ?? null));
      return Response.json({ results: hits, continueAfter: page?.continueAfter ?? null, scannedSessions: 1,
        scannedMessages: 1, searchedSessions: 1, readBytes: 0, limited: false,
        limits: { sessions: 25, messages: 500, bytes: 1, results: page ? 1 : 25 } });
    },
  };
  // Most tests read the selected project's rows. The filter tests start from All projects.
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "alpha" });
});
test.afterEach(async () => {
  // A real pointer action releases the page-wide route hold; unmount alone deliberately does not.
  await act(async () => document.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  await act(async () => root.unmount()); inboxFixture.client?.clear(); host.remove(); focused = null;
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10)); });
async function render(route = "/", sidebar = false) { await act(async () => root.render(module.exports.view(route, sidebar))); await settle(); }
const rowButtons = (list = host.querySelector('ul[aria-label="Conversations"]')) =>
  [...list.querySelectorAll(".conversation-inbox__row-button")];
const titles = list => rowButtons(list).map(button => button.querySelector(".conversation-inbox__title").textContent);
const button = text => [...host.querySelectorAll("button")].find(candidate => candidate.textContent === text);
const key = (target, name, extra = {}) => act(async () => target.dispatchEvent(Object.assign(
  new window.Event("keydown", { bubbles: true, cancelable: true }), { key: name, ...extra })));
// linkedom dispatches no input event React reads, so typing calls the field's React change handler, as chat search does.
async function type(input, value) {
  await act(async () => {
    input.value = value;
    input[Object.keys(input).find(key => key.startsWith("__reactProps$"))].onChange({ target: input });
  });
}
// A deferred answer the test releases after the owner has moved on.
function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { wait, release: () => release() };
}
async function chooseFilter(value, surface = host) {
  const select = surface.querySelector(".conversation-inbox__filter select");
  Object.defineProperty(select, "value", { value, configurable: true });
  await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
  await settle();
}

test("the filter only scopes the list: it keeps the open conversation and the selected project, and is saved", async () => {
  inboxFixture.state.delete(FILTER);
  await render("/?run=a1");
  assert.deepEqual(titles(), ["Old pinned plan", "Fix table wrapping", "Review onboarding", "Write launch notes", "Personal question"],
    "All projects is the default");
  assert.match(host.querySelector('[data-row-id="code:b1"]').textContent, /Beta/);
  await chooseFilter("beta");
  assert.deepEqual(titles(), ["Review onboarding"]);
  assert.deepEqual(inboxFixture.state.get(FILTER), { scopeKey: "scope", filter: "beta" });
  assert.equal(inboxFixture.calls.some(call => call.name === "selectProject"), false, "the filter never selects a project");
  assert.equal(inboxFixture.active, "alpha");
  assert.equal(host.querySelector("#route").textContent, "?run=a1", "the open conversation stays open");
  assert.equal(host.querySelector(".conversation-inbox__detail")?.textContent, "Claude Code", "runtime shows on Code rows only");
  await chooseFilter("personal");
  assert.deepEqual(titles(), ["Personal question"]);
  await chooseFilter("all");
  assert.equal(titles().length, 5);
  assert.equal(host.querySelector("#route").textContent, "?run=a1");
});

test("New conversation starts in the filtered project, shown with its folder before anything is created", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "beta" });
  await render("/?run=a1");
  const destination = host.querySelector(".conversation-inbox__destination");
  assert.match(destination.textContent, /New conversations start in Beta/);
  assert.match(destination.textContent, /beta-folder, folder \/work\/beta-folder/);
  assert.equal(inboxFixture.calls.length, 0, "showing the destination creates nothing");
  await act(async () => button("New conversation").click());
  await settle();
  assert.deepEqual(inboxFixture.calls.filter(call => call.name === "selectProject"), [{ name: "selectProject", projectId: "beta" }]);
  assert.match(host.querySelector("#route").textContent, /^\?run=new&draft=[0-9a-f-]{36}$/);
  await chooseFilter("all");
  assert.match(host.querySelector(".conversation-inbox__destination").textContent, /start in Beta/,
    "with All projects, the open conversation's project is the destination");
});

for (const restores of [false, true]) test(`an API chat for another project is created in that project after it is selected${restores ? ", over a restored saved conversation" : ""}`, async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
  if (restores) inboxFixture.savedRoutes = { alpha: "run=a3", personal: "runtime=native&history=project&thread=saved" };
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    return { changed: true, record: { status: "cleared" } }; };
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  await act(async () => button("API chat (separate billing)").click());
  await settle();
  assert.equal(inboxFixture.active, null);
  const draft = inboxFixture.calls.find(call => call.name === "vivary-chat-draft");
  assert.equal(draft.input.projectId, null, "the draft is recorded in the destination's scope");
  assert.equal(host.querySelector("#route").textContent, "?runtime=native&history=project&thread=new-native");
});

test("a deferred API chat is dropped when the owner selects another project before it could be created", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "beta" });
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    return { changed: true, record: { status: "cleared" } }; };
  inboxFixture.identityBlocked = "beta";
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  await act(async () => button("API chat (separate billing)").click());
  await settle();
  assert.equal(inboxFixture.active, "beta");
  // While Beta's Native identity loads, the owner selects Alpha elsewhere in the app, then comes back to Beta.
  await act(async () => { inboxFixture.active = "alpha"; inboxFixture.notify(); });
  await settle();
  inboxFixture.identityBlocked = undefined;
  await act(async () => { inboxFixture.active = "beta"; inboxFixture.notify(); });
  await settle();
  assert.equal(inboxFixture.calls.some(call => call.name === "vivary-chat-draft"), false, "the old request created nothing");
  assert.doesNotMatch(host.querySelector("#route").textContent, /thread=new-native/);
});

test("a filter chosen while the saved one loads stays chosen, and the last choice is the one saved", async () => {
  const read = gate();
  inboxFixture.readDelay = read.wait;
  await render("/?run=a1");
  await chooseFilter("beta");
  await act(async () => read.release());
  await settle();
  assert.deepEqual(titles(), ["Review onboarding"], "the older saved filter does not come back");
  const write = gate();
  inboxFixture.writeDelay = value => value.filter === "personal" ? write.wait : undefined;
  await chooseFilter("personal");
  await chooseFilter("all");
  await act(async () => write.release());
  await settle();
  assert.deepEqual(inboxFixture.state.get(FILTER), { scopeKey: "scope", filter: "all" }, "the newest choice is saved last");
});

test("Personal workspace without a folder offers only API chat from another project", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
  inboxFixture.noPersonalFolder = true;
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    return { changed: true, record: { status: "cleared" } }; };
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  assert.equal(button("Code conversation").disabled, true, "Code needs Personal workspace's folder");
  assert.equal(button("API chat (separate billing)").disabled, false);
  await act(async () => button("New conversation").click());
  await settle();
  assert.equal(inboxFixture.active, null);
  assert.doesNotMatch(route(), /run=new/, "no Code draft that cannot run");
  assert.equal(route(), "?runtime=native&history=project&thread=new-native");
});

test("the active Personal workspace without a folder offers only API chat", async () => {
  inboxFixture.active = null;
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
  inboxFixture.noPersonalFolder = true;
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    return { changed: true, record: { status: "cleared" } }; };
  await render();
  await act(async () => document.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  assert.equal(button("Code conversation").disabled, true, "Code needs the active Personal workspace's folder");
  assert.equal(button("API chat (separate billing)").disabled, false);
  await act(async () => button("New conversation").click());
  await settle();
  assert.equal(inboxFixture.active, null);
  assert.equal(inboxFixture.calls.some(call => call.name === "selectProject"), false, "Personal is already selected");
  assert.doesNotMatch(route(), /run=new/, "no Code draft that cannot run");
  assert.equal(route(), "?runtime=native&history=project&thread=new-native");
});

for (const state of ["pending", "failed"]) {
  test(`Personal explicit API choice works while its folder is ${state}`, async () => {
    inboxFixture.active = null;
    inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
    const originalRead = inboxFixture.read;
    inboxFixture.read = (name, input) => name === "vivary-project-location" && !input.projectId
      ? state === "pending" ? new Promise(() => {}) : Promise.reject(new Error("Unavailable"))
      : originalRead(name, input);
    inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
      return { changed: true, record: { status: "cleared" } }; };
    await render();
    await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
    await act(async () => button("API chat (separate billing)").click());
    await settle();
    assert.equal(route(), "?runtime=native&history=project&thread=new-native");
  });
}

for (const active of [null, "alpha"]) {
  for (const state of ["pending", "failed"]) {
    test(`Personal ${state} folder blocks the default until resolved from ${active ?? "Personal"}`, async () => {
      inboxFixture.active = active;
      inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
      const originalRead = inboxFixture.read;
      let finishFolder, failed = state === "failed";
      inboxFixture.read = (name, input) => {
        if (name !== "vivary-project-location" || input.projectId) return originalRead(name, input);
        if (failed) return Promise.reject(new Error("Folder service unavailable"));
        return new Promise(resolve => { finishFolder = resolve; });
      };
      await render();
      assert.equal(button("New conversation").disabled, true);
      await act(async () => button("New conversation").click());
      assert.equal(inboxFixture.calls.length, 0, "an unknown folder creates neither conversation type");
      await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
      assert.equal(button("Code conversation").disabled, true);
      assert.equal(button("API chat (separate billing)").disabled, false);
      if (failed) {
        failed = false;
        await act(async () => button("Retry folder").click());
        assert.equal(button("New conversation").disabled, true);
      }
      await act(async () => finishFolder({ folderName: "personal", path: "/work/personal" }));
      await settle();
      assert.equal(button("New conversation").disabled, false);
      await act(async () => button("New conversation").click());
      await settle();
      assert.match(route(), /^\?run=new&draft=/);
      assert.equal(inboxFixture.calls.some(call => call.name === "vivary-chat-draft"), false);
    });
  }
}

test("the active Personal workspace with a folder keeps Code creation available", async () => {
  inboxFixture.active = null;
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "personal" });
  await render();
  assert.match(host.querySelector(".conversation-inbox__destination").textContent, /home-folder, folder \/work\/home-folder/);
  await act(async () => document.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  assert.equal(button("Code conversation").disabled, false);
  assert.equal(button("API chat (separate billing)").disabled, false);
  await act(async () => button("Code conversation").click());
  assert.match(route(), /^\?run=new&draft=[0-9a-f-]{36}$/);
  assert.equal(inboxFixture.calls.some(call => call.name === "selectProject"), false, "Personal is already selected");
  assert.equal(inboxFixture.calls.some(call => call.name === "vivary-chat-draft"), false, "Code starts without creating an API chat");
});

test("a saved project filter is restored after a restart, and a project that left the catalog lists everything", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "beta" });
  await render("/?run=b1");
  assert.deepEqual(titles(), ["Review onboarding"]);
  assert.equal(host.querySelector('[aria-current="true"]')?.dataset.rowId, "code:b1");
  await act(async () => root.unmount());
  inboxFixture.client.clear();
  root = createRoot(host);
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "gone" });
  await render();
  assert.equal(titles().length, 5);
});

test("search filters by title and archived conversations stay in a collapsed section", async () => {
  await render();
  const search = host.querySelector(".conversation-inbox__search");
  await type(search, "LAUNCH");
  assert.deepEqual(titles(), ["Write launch notes"]);
  await type(search, "");
  const archived = host.querySelector(".conversation-inbox__archived");
  assert.equal(archived.hasAttribute("open"), false);
  assert.match(archived.querySelector("summary").textContent, /Archived \(1\)/);
  assert.deepEqual(titles(archived.querySelector("ul")), ["Finished cleanup"]);
});

test("the empty message appears only when no section has a matching row, and never beside a load error", async () => {
  inboxFixture.rows = [row("code:a4", "alpha", "Finished cleanup", 20, { archived: true })];
  await render("/?run=a1");
  assert.ok(host.querySelector(".conversation-inbox__archived"), "the archived match is listed");
  assert.equal(host.querySelector(".conversation-inbox__empty")?.textContent, undefined, "so the inbox does not claim to be empty");
  await act(async () => root.unmount());
  inboxFixture.client.clear();
  root = createRoot(host);
  const read = inboxFixture.read;
  inboxFixture.read = async (name, input) => name === "vivary-conversation-inbox"
    ? Promise.reject(new Error("The server is down.")) : read(name, input);
  await render("/?run=a1");
  assert.match(host.querySelector('[role="alert"]').textContent, /could not be loaded/);
  assert.equal(host.querySelector(".conversation-inbox__empty")?.textContent, undefined,
    "the error is not followed by a claim of no history");
});

test("each state is text with an icon, idle shows none, and no state is a live region", async () => {
  await render();
  await chooseFilter("all");
  const states = [...host.querySelectorAll(".conversation-inbox__state")].map(state => [state.dataset.state, state.textContent]);
  assert.deepEqual(states, [["needs-approval", "Needs approval"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"]]);
  for (const state of host.querySelectorAll(".conversation-inbox__state")) assert.ok(state.querySelector("svg"));
  assert.equal(host.querySelector("[aria-live]"), null, "row state changes are never announced on their own");
});

test("queued, held and confirmation states show readable labels without reordering the inbox", async () => {
  inboxFixture.rows = [row("code:a1", "alpha", "Waiting for a slot", 50, { attention: "queued" }),
    row("code:a2", "alpha", "Waiting for me", 40, { attention: "held" }),
    row("code:a3", "alpha", "Confirm another worker", 30, { attention: "needs-confirmation" })];
  await render();
  assert.deepEqual([...host.querySelectorAll(".conversation-inbox__state")].map(state => [state.dataset.state, state.textContent]),
    [["queued", "Queued"], ["held", "Held"], ["needs-confirmation", "Needs confirmation"]]);
  assert.equal(host.querySelector("[aria-live]"), null);
  assert.deepEqual(titles(), ["Waiting for a slot", "Waiting for me", "Confirm another worker"]);
});

test("rows keep their order while their state changes", async () => {
  await render();
  const before = titles();
  inboxFixture.rows = rows().map(item => item.id === "native:a2" ? { ...item, attention: "running", updatedAt: 999 } : item);
  await act(async () => inboxFixture.client.invalidateQueries());
  await settle();
  assert.deepEqual(titles(), before);
  assert.equal(host.querySelector('[data-row-id="native:a2"] .conversation-inbox__state').textContent, "Running");
});

test("the selected row is current and holds the only Tab stop, and arrow keys, Home and End move between rows", async () => {
  await render("/?runtime=native&history=project&thread=a2");
  const [pinned, approval, notes] = rowButtons();
  assert.equal(notes.getAttribute("aria-current"), "true");
  assert.deepEqual(rowButtons().map(item => item.getAttribute("tabindex")), ["-1", "-1", "0"]);
  await key(notes, "ArrowUp");
  assert.equal(document.activeElement, approval);
  assert.deepEqual(rowButtons().map(item => item.getAttribute("tabindex")), ["-1", "0", "-1"]);
  await key(approval, "Home");
  assert.equal(document.activeElement, pinned);
  await key(pinned, "End");
  assert.equal(document.activeElement, notes);
  await key(notes, "ArrowDown");
  assert.equal(document.activeElement, notes, "the last row keeps focus");
  await act(async () => approval.click());
  assert.equal(host.querySelector("#route").textContent, "?run=a1");
  assert.equal(host.querySelector('[aria-current="true"]').dataset.rowId, "code:a1");
});

test("the menu key opens the row menu, and its actions call the owner of that row", async () => {
  await render();
  const approval = rowButtons()[1];
  await key(approval, "ContextMenu");
  const items = [...host.querySelectorAll('[role="menu"] [role="menuitem"]')].map(item => item.textContent);
  assert.deepEqual(items, ["Rename", "Pin", "Archive"]);
  await act(async () => button("Archive").click());
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-code-conversation-meta",
    input: { operation: "archive", runId: "a1", projectId: "alpha" } });
  await key(rowButtons()[0], "F10", { shiftKey: true });
  await act(async () => button("Unpin").click());
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1).input, { operation: "unpin", runId: "a3", projectId: "alpha" });
});

test("after Archive the row moves to Archived and focus moves to the row that took its place", async () => {
  inboxFixture.call = async (name, input) => {
    inboxFixture.calls.push({ name, input });
    inboxFixture.rows = inboxFixture.rows.map(item => item.id === `code:${input.runId}` ? { ...item, archived: true } : item);
    return { changed: true };
  };
  await render();
  const approval = rowButtons()[1];
  approval.focus();
  await key(approval, "ContextMenu");
  await act(async () => button("Archive").click());
  await settle();
  assert.deepEqual(titles(), ["Old pinned plan", "Write launch notes"]);
  assert.deepEqual(titles(host.querySelector(".conversation-inbox__archived ul")), ["Fix table wrapping", "Finished cleanup"]);
  assert.equal(document.activeElement?.dataset.rowId, "native:a2");
});

test("archiving the only row hands focus to New conversation instead of the page", async () => {
  inboxFixture.rows = [row("code:a1", "alpha", "Fix table wrapping", 50)];
  inboxFixture.call = async (name, input) => {
    inboxFixture.calls.push({ name, input });
    inboxFixture.rows = inboxFixture.rows.map(item => item.id === `code:${input.runId}` ? { ...item, archived: true } : item);
    return { changed: true };
  };
  await render();
  const only = rowButtons()[0];
  only.focus();
  await key(only, "ContextMenu");
  await act(async () => button("Archive").click());
  await settle();
  assert.equal(host.querySelector('ul[aria-label="Conversations"]')?.textContent, undefined, "the active list is empty");
  assert.equal(document.activeElement?.textContent, "New conversation");
});

test("an API chat is archived through the guarded action, and a refusal is shown without changing the row", async () => {
  inboxFixture.call = async (name, input) => {
    inboxFixture.calls.push({ name, input });
    throw new Error("This conversation is working. Stop it or let it finish, then archive it.");
  };
  await render();
  await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
  await act(async () => button("Archive").click());
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-conversation-archive",
    input: { operation: "archive", projectId: "alpha", threadId: "a2" } });
  assert.match(host.querySelector('[role="alert"]').textContent, /is working\. Stop it or let it finish/);
  assert.deepEqual(titles(), ["Old pinned plan", "Fix table wrapping", "Write launch notes"], "the row stays in place");
});

test("API chat rename and pin go through the owner action a private-proxy browser can reach, never a raw Native POST", async () => {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { posts.push(args); return new Response("{}"); };
  try {
    await render();
    await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
    await act(async () => button("Rename").click());
    await type(host.querySelector(".conversation-inbox__rename"), "Launch notes");
    await key(host.querySelector(".conversation-inbox__rename"), "Enter");
    await settle();
    assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-conversation-archive",
      input: { operation: "rename", projectId: "alpha", threadId: "a2", title: "Launch notes" } });
    await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
    await act(async () => button("Pin").click());
    await settle();
    assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-conversation-archive",
      input: { operation: "pin", projectId: "alpha", threadId: "a2" } });
    assert.equal(posts.length, 0, "no change reaches Native's thread routes");
  } finally { globalThis.fetch = realFetch; }
});

const route = () => host.querySelector("#route").textContent;
const openRow = id => act(async () => host.querySelector(`[data-row-id="${id}"]`).click());

test("a slow API chat archive closes its route only while that conversation is still open", async () => {
  const slow = gate();
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    if (input.operation === "archive") await slow.wait; return { changed: true }; };
  await render("/?runtime=native&history=project&thread=a2");
  await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
  await act(async () => button("Archive").click());
  await openRow("code:a1");
  await act(async () => slow.release());
  await settle();
  assert.equal(route(), "?run=a1", "the conversation opened meanwhile stays open");
});

for (const projectId of ["alpha", "beta"]) test(`a slow API chat creation does not replace a conversation opened meanwhile${projectId === "beta" ? " after selecting another project" : ""}`, async () => {
  const slow = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: projectId });
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    if (name === "vivary-chat-draft") await slow.wait; return { changed: true, record: { status: "cleared" } }; };
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  await act(async () => button("API chat (separate billing)").click());
  await settle();
  assert.equal(inboxFixture.active, projectId, "creation has reached its destination project");
  const drafts = inboxFixture.calls.filter(call => call.name === "vivary-chat-draft");
  assert.equal(drafts.length, 1, "draft initialization has started before the later click");
  assert.equal(drafts[0].input.projectId, projectId, "creation uses the destination's active Native identity");
  const expected = projectId === "beta" ? "?run=b1" : "?run=a3";
  await openRow(projectId === "beta" ? "code:b1" : "code:a3");
  assert.equal(route(), expected, "the later row is open before draft initialization finishes");
  await act(async () => slow.release());
  await settle();
  assert.equal(route(), expected, "the conversation opened meanwhile stays open after creation finishes");
});

test("a slow API chat creation cannot reopen its Native scope after an external project switch", async () => {
  const slow = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "beta" });
  inboxFixture.savedRoutes = { alpha: "run=a3", beta: "run=b-saved" };
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    if (name === "vivary-chat-draft") await slow.wait; return { changed: true, record: { status: "cleared" } }; };
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  await act(async () => button("API chat (separate billing)").click());
  await settle();
  assert.equal(inboxFixture.active, "beta");
  const drafts = inboxFixture.calls.filter(call => call.name === "vivary-chat-draft");
  assert.equal(drafts.length, 1, "draft initialization is already waiting in Beta's Native scope");
  assert.equal(drafts[0].input.projectId, "beta");
  // A project change elsewhere in the app unmounts Beta's Native scope without an inbox open.
  await act(async () => { inboxFixture.active = "alpha"; inboxFixture.notify(); });
  await settle();
  assert.equal(route(), "?run=a3", "Alpha restored its saved conversation before the old creation finished");
  await act(async () => slow.release());
  await settle();
  assert.equal(inboxFixture.active, "alpha");
  assert.equal(route(), "?run=a3", "the unmounted Native scope cannot replace the new project's route");
});

test("an archived API chat is restored through the owner action that does not need Code history", async () => {
  inboxFixture.rows = [...rows(), row("native:a5", "alpha", "Old API chat", 5, { archived: true })];
  await render("/?run=a1");
  await openRow("native:a5");
  await settle();
  assert.deepEqual(inboxFixture.calls[0], { name: "vivary-conversation-archive",
    input: { operation: "restore", projectId: "alpha", threadId: "a5" } });
  assert.equal(route(), "?runtime=native&history=project&thread=a5");
  await act(async () => host.querySelector('[aria-label="Actions for Old API chat"]').click());
  await act(async () => button("Restore").click());
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-conversation-archive",
    input: { operation: "restore", projectId: "alpha", threadId: "a5" } });
});

test("a slow restore of an archived API chat does not replace a conversation opened meanwhile", async () => {
  inboxFixture.rows = [...rows(), row("native:a5", "alpha", "Old API chat", 5, { archived: true })];
  const slow = gate();
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    if (input.operation === "restore") await slow.wait; return { changed: true }; };
  await render("/?run=a1");
  await openRow("native:a5");
  await openRow("code:a3");
  await act(async () => slow.release());
  await settle();
  assert.equal(route(), "?run=a3");
});

test("archiving the open Code conversation closes it, and opening an archived one restores it first", async () => {
  await render("/?run=a1");
  await act(async () => host.querySelector('[aria-label="Actions for Fix table wrapping"]').click());
  await act(async () => button("Archive").click());
  await settle();
  assert.equal(route(), "", "an archived conversation keeps no open composer");
  await openRow("code:a4");
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-code-conversation-meta",
    input: { operation: "restore", runId: "a4", projectId: "alpha" } });
  assert.equal(route(), "?run=a4");
});

test("rename edits the title in place and returns focus to the row", async () => {
  await render();
  await act(async () => host.querySelector('[aria-label="Actions for Fix table wrapping"]').click());
  await act(async () => button("Rename").click());
  const input = host.querySelector(".conversation-inbox__rename");
  assert.equal(input.value, "Fix table wrapping");
  await type(input, "  Wrap   tables  ");
  await key(input, "Enter");
  await settle();
  assert.deepEqual(inboxFixture.calls.at(-1), { name: "vivary-code-conversation-meta",
    input: { operation: "rename", runId: "a1", projectId: "alpha", title: "Wrap tables" } });
  assert.equal(document.activeElement?.dataset.rowId, "code:a1");
  await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
  await act(async () => button("Rename").click());
  await key(host.querySelector(".conversation-inbox__rename"), "Escape");
  await settle();
  assert.equal(inboxFixture.calls.at(-1).input.title, "Wrap tables", "Escape renames nothing");
  await act(async () => host.querySelector('[aria-label="Actions for Write launch notes"]').click());
  await act(async () => button("Rename").click());
  const field = host.querySelector(".conversation-inbox__rename");
  await type(field, "   ");
  await key(field, "Enter");
  await settle();
  assert.match(host.querySelector('[role="alert"]').textContent, /Enter a title/);
  assert.equal(field.getAttribute("aria-invalid"), "true");
  assert.ok(host.querySelector(".conversation-inbox__rename"), "an empty title keeps the field open");
  assert.equal(inboxFixture.calls.at(-1).input.title, "Wrap tables", "an empty title is not sent");
  await key(field, "Escape");
  await settle();
  assert.equal(host.querySelector(".conversation-inbox__rename"), null);
});

for (const restores of [false, true]) test(`a row in another project opens exactly that conversation after the project changes${restores ? ", over a restored saved conversation" : ""}`, async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  // Each project can restore its own saved conversation onto a bare route. The click must still land on its row.
  if (restores) inboxFixture.savedRoutes = { alpha: "run=a3", beta: "run=b-saved", personal: "runtime=native&history=project&thread=saved" };
  await render("/?run=a1");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "code:b1").click());
  await settle();
  assert.equal(inboxFixture.active, "beta");
  assert.equal(host.querySelector("#route").textContent, "?run=b1");
  assert.equal(host.querySelector('[aria-current="true"]').dataset.rowId, "code:b1");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "native:p1").click());
  await settle();
  assert.equal(inboxFixture.active, null);
  assert.equal(host.querySelector("#route").textContent, "?runtime=native&history=project&thread=p1");
});

test("a row in the open project clicked while another project is still opening wins", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  await render("/?run=a1");
  await act(async () => {
    rowButtons().find(item => item.dataset.rowId === "code:b1").click();
    rowButtons().find(item => item.dataset.rowId === "code:a3").click();
  });
  await settle();
  assert.equal(inboxFixture.active, "alpha", "the slower open of Beta does not take over");
  assert.deepEqual(inboxFixture.selectionCommits, ["alpha"], "a stale request never manufactures a project reset");
  assert.equal(host.querySelector("#route").textContent, "?run=a3", "the clicked row opens without a project reset");
  // The page-wide hold releases once its route has held, so the next test starts without it.
  await act(async () => new Promise(resolve => setTimeout(resolve, 900)));
});

test("a failed same-project selection keeps the clicked row and supersedes the earlier project open", async () => {
  const earlier = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.selectionWait = projectId => projectId === "beta" ? earlier.wait : undefined;
  inboxFixture.failedSelections = ["alpha"];
  await render("/?run=a1");
  await act(async () => {
    rowButtons().find(item => item.dataset.rowId === "code:b1").click();
    rowButtons().find(item => item.dataset.rowId === "code:a3").click();
  });
  await settle();
  assert.equal(route(), "?run=a3", "opening a row in the selected project needs no project change");
  assert.match(host.querySelector('[role="alert"]').textContent, /That project is unavailable/);
  await act(async () => earlier.release());
  await settle();
  assert.equal(inboxFixture.active, "alpha");
  assert.deepEqual(inboxFixture.selectionCommits, [], "neither a failed nor a superseded request changes the project");
  assert.equal(route(), "?run=a3", "the late earlier request cannot replace the clicked row");
});

test("older selection completions cannot replace a later row click or report over it", async () => {
  const beta = gate(), firstAlpha = gate();
  let alphaRequests = 0;
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.selectionWait = projectId => projectId === "beta" ? beta.wait
    : ++alphaRequests === 1 ? firstAlpha.wait : undefined;
  inboxFixture.failedSelections = ["beta"];
  await render("/?run=a1");
  await act(async () => {
    rowButtons().find(item => item.dataset.rowId === "code:b1").click();
    rowButtons().find(item => item.dataset.rowId === "code:a3").click();
  });
  assert.equal(route(), "?run=a3", "the selected-project row lands before its selection completes");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "code:a1").click());
  await settle();
  await act(async () => firstAlpha.release());
  await act(async () => beta.release());
  await settle();
  assert.equal(inboxFixture.active, "alpha");
  assert.deepEqual(inboxFixture.selectionCommits, ["alpha"], "only the latest request commits");
  assert.equal(route(), "?run=a1", "the later row keeps its route after both older requests finish");
  assert.equal(host.querySelector('[role="alert"]'), null, "a stale failure reports nothing over the newer click");
  await act(async () => document.dispatchEvent(new window.Event("keydown", { bubbles: true })));
});

test("a failed cross-project open releases its hold and keeps the selected project's route", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.failedSelections = ["beta"];
  await render("/?run=a1");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "code:b1").click());
  await settle();
  assert.equal(inboxFixture.active, "alpha");
  assert.equal(route(), "?run=a1");
  assert.match(host.querySelector('[role="alert"]').textContent, /That project is unavailable/);
  await act(async () => rowButtons().find(item => item.dataset.rowId === "code:a3").click());
  await settle();
  assert.equal(route(), "?run=a3", "the failed open leaves no hold over the next row");
  assert.equal(host.querySelector('[role="alert"]'), null);
});

test("a row in the selected project opens directly and Native rows select their thread", async () => {
  await render("/?run=a1");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "native:a2").click());
  assert.equal(host.querySelector("#route").textContent, "?runtime=native&history=project&thread=a2");
  assert.deepEqual(inboxFixture.switched, ["a2"]);
  assert.equal(inboxFixture.calls.some(call => call.name === "selectProject"), false);
});

test("drafts in every project are listed first in a Drafts block, labeled, and follow the filter", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.serverDrafts = [
    { id: "native:draft-native", kind: "native", projectId: "alpha", projectLabel: "Alpha", preview: "", createdAt: 60, status: "draft" },
    { id: "code-draft:fresh", kind: "code", projectId: "beta", projectLabel: "Beta", preview: "Plan the release", createdAt: 55, status: "pending" },
  ];
  inboxFixture.rows = rows().map(item => item.id === "code:a1" ? { ...item, draft: "draft" } : item);
  await render("/?run=new&draft=fresh");
  const block = host.querySelector(".conversation-inbox__drafts");
  assert.equal(block.querySelector("h3").textContent, "Drafts");
  assert.equal(host.querySelector(".conversation-inbox__drafts") === host.querySelector("section.conversation-inbox > section"), true,
    "the Drafts block comes before the conversation list");
  assert.deepEqual(titles(block.querySelector("ul")), ["Untitled conversation", "Plan the release"]);
  const draft = host.querySelector('[data-row-id="code-draft:fresh"]');
  assert.equal(draft.getAttribute("aria-current"), "true");
  assert.match(draft.textContent, /Review send/);
  assert.match(draft.textContent, /Beta/);
  assert.match(host.querySelector('[data-row-id="native:draft-native"]').textContent, /Draft/);
  assert.equal(host.querySelector('[aria-label="Actions for Plan the release"]'), null, "a draft has no saved conversation to change");
  assert.match(host.querySelector('[data-row-id="code:a1"]').textContent, /Draft/, "unsent text on a saved conversation is marked");
  await chooseFilter("alpha");
  assert.deepEqual(titles(host.querySelector(".conversation-inbox__drafts ul")), ["Untitled conversation"]);
  await chooseFilter("personal");
  assert.equal(host.querySelector(".conversation-inbox__drafts"), null);
});

test("the destination shows the selected project and its folder, and the add menu keeps creating and opening distinct", async () => {
  await render();
  const destination = host.querySelector(".conversation-inbox__destination");
  assert.match(destination.textContent, /New conversations start in Alpha/, "the filter names alpha");
  assert.equal(destination.querySelector(".conversation-inbox__folder").getAttribute("tabindex"), "0");
  assert.match(destination.textContent, /alpha-folder, folder \/work\/alpha-folder/);
  await act(async () => host.querySelector('[aria-label="Add project"]').click());
  assert.deepEqual([...host.querySelectorAll('[role="menuitem"]')].map(item => item.textContent),
    ["New project (creates a folder)", "Open existing folder"]);
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  assert.ok(button("Code conversation") && button("API chat (separate billing)"));
  await act(async () => button("Code conversation").click());
  assert.match(host.querySelector("#route").textContent, /^\?run=new&draft=[0-9a-f-]{36}$/);
});

const hit = (projectId, sessionId, excerpt, runtime = "code") => ({ projectId, projectLabel: projectId ?? "Personal workspace",
  sessionId, title: `Session ${sessionId}`, runtime, referenceId: `ref-${sessionId}`, eventOffset: 3, excerpt, match: "content",
  archived: false, sessionUpdatedAt: 10 });
const searchFor = async text => {
  await type(host.querySelector(".conversation-inbox__search"), text);
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  await settle();
};

test("search filters titles at once and also searches messages in the filtered project, with match context", async () => {
  inboxFixture.hits = [hit("alpha", "a1", "the table wraps inside each cell"), hit("beta", "b1", "table in beta")];
  await render("/?run=a1");
  await searchFor("table");
  assert.deepEqual(titles(), ["Fix table wrapping"], "the title filter is instant");
  assert.deepEqual(inboxFixture.searches.map(search => [search.name, search.params.projectId, search.params.query]),
    [["vivary-chat-search", "alpha", "table"]], "one search in the filtered project, reusing the existing action");
  const messages = host.querySelector(".conversation-inbox__messages");
  assert.match(messages.textContent, /1 matching message\./);
  assert.equal(messages.querySelector("mark").textContent, "table");
  assert.equal(host.querySelector('[aria-current="true"]').dataset.rowId, "code:a1", "selection stays while searching");
  await act(async () => messages.querySelector(".conversation-inbox__hit").click());
  assert.equal(host.querySelector("#route").textContent, "?history=project&run=a1&event=ref-a1&eventOffset=3");
});

const hitTitles = () => [...host.querySelectorAll(".conversation-inbox__messages .conversation-inbox__hit .conversation-inbox__title")]
  .map(node => node.textContent);

test("a title match is not repeated as a message, since the title filter already lists that conversation", async () => {
  inboxFixture.hits = [{ ...hit("alpha", "a1", "Fix table wrapping"), match: "title" }, hit("alpha", "a3", "a table in the plan")];
  await render("/?run=a1");
  await searchFor("table");
  assert.deepEqual(hitTitles(), ["Session a3"]);
  assert.match(host.querySelector(".conversation-inbox__messages").textContent, /1 matching message\./);
});

test("truncated Native history keeps older title-only hits through continuation and opens them", async () => {
  inboxFixture.limited = true;
  const older = { ...hit("alpha", "older-native", "Older table notes", "native"),
    title: "Older table notes", match: "title" };
  inboxFixture.pages = { "": { results: [{ ...hit("alpha", "a1", "Fix table wrapping"), match: "title" }], continueAfter: "older" },
    older: { results: [older], continueAfter: null } };
  await render("/?run=a1");
  await searchFor("table");
  assert.deepEqual(hitTitles(), [], "an already-listed title is not duplicated");
  await act(async () => button("Search more").click());
  await settle();
  assert.deepEqual(hitTitles(), ["Older table notes"]);
  await act(async () => host.querySelector(".conversation-inbox__hit").click());
  await settle();
  assert.match(host.querySelector("#route").textContent, /thread=older-native/);
  await act(async () => {
    inboxFixture.rows.push(row("native:older-native", "alpha", "Older table notes", 1));
    inboxFixture.client.setQueryData(["action", "vivary-conversation-inbox", {}],
      { rows: [...inboxFixture.rows], drafts: [], unavailableProjects: [], limited: true });
  });
  await settle();
  assert.deepEqual(hitTitles(), [], "a later inbox refresh deduplicates the retained title hit");
});

test("destination folder follows a same-ID rebind and hides unavailable bindings", async () => {
  const originalRead = inboxFixture.read;
  const requests = [];
  let releaseLocation;
  inboxFixture.read = async (name, input) => {
    if (name !== "vivary-project-location") return originalRead(name, input);
    requests.push(input);
    if (requests.length === 1) return { folderName: "old-folder", path: "/work/old-folder" };
    return new Promise(resolve => { releaseLocation = resolve; });
  };
  await render();
  assert.match(host.querySelector(".conversation-inbox__destination").textContent, /old-folder/);
  inboxFixture.catalog = { ...catalog, projects: catalog.projects.map(project => project.projectId === "alpha"
    ? { ...project, bindingRevision: 2 } : project) };
  await act(async () => inboxFixture.notify());
  await settle();
  assert.equal(requests.length, 2, "same ID with a new binding fetches its folder");
  assert.doesNotMatch(host.querySelector(".conversation-inbox__destination").textContent, /old-folder/);
  await act(async () => releaseLocation({ folderName: "new-folder", path: "/work/new-folder" }));
  await settle();
  assert.match(host.querySelector(".conversation-inbox__destination").textContent, /new-folder/);
  assert.deepEqual(requests, [{ projectId: "alpha" }, { projectId: "alpha" }], "binding identity is not an action parameter");
  inboxFixture.catalog = { ...inboxFixture.catalog, projects: inboxFixture.catalog.projects.map(project => project.projectId === "alpha"
    ? { ...project, status: "unavailable" } : project) };
  await act(async () => inboxFixture.notify());
  assert.equal(host.querySelector(".conversation-inbox__folder"), null);
  assert.equal(requests.length, 2, "an unavailable binding is not queried");
});

test("a delayed folder response from an old binding cannot replace the new destination", async () => {
  const originalRead = inboxFixture.read;
  let finishOld;
  let reads = 0;
  inboxFixture.read = async (name, input) => {
    if (name !== "vivary-project-location") return originalRead(name, input);
    if (++reads === 1) return new Promise(resolve => { finishOld = resolve; });
    return { folderName: "rebound-folder", path: "/work/rebound-folder" };
  };
  await render();
  inboxFixture.catalog = { ...catalog, projects: catalog.projects.map(project => project.projectId === "alpha"
    ? { ...project, bindingRevision: 2 } : project) };
  await act(async () => inboxFixture.notify());
  await settle();
  assert.match(host.querySelector(".conversation-inbox__destination").textContent, /rebound-folder/);
  await act(async () => finishOld({ folderName: "old-folder", path: "/work/old-folder" }));
  await settle();
  assert.doesNotMatch(host.querySelector(".conversation-inbox__destination").textContent, /old-folder/);
});

test("a list cut at the newest API chats says so and points to message search", async () => {
  await render("/?run=a1");
  assert.doesNotMatch(host.textContent, /Only the newest API chats are listed/);
  await act(async () => root.unmount());
  inboxFixture.client.clear();
  root = createRoot(host);
  inboxFixture.limited = true;
  await render("/?run=a1");
  assert.match(host.textContent, /Only the newest API chats are listed\. Message search still finds older ones\./);
});

test("message search leaves out a Code conversation the inbox lists as archived", async () => {
  inboxFixture.hits = [hit("alpha", "a4", "a table in the cleanup"), hit("alpha", "a3", "a table in the plan")];
  await render("/?run=a1");
  await searchFor("table");
  assert.deepEqual(hitTitles(), ["Session a3"]);
  assert.match(host.querySelector(".conversation-inbox__messages").textContent, /1 matching message\./);
});

test("message search reads past the first page and offers Search more while matches may remain", async () => {
  inboxFixture.pages = { "": { results: [hit("alpha", "a1", "table one")], continueAfter: "c1" },
    c1: { results: [hit("alpha", "a3", "table two")], continueAfter: "c2" },
    c2: { results: [hit("alpha", "n9", "table three")], continueAfter: null } };
  await render("/?run=a1");
  await searchFor("table");
  const messages = () => host.querySelector(".conversation-inbox__messages").textContent;
  assert.deepEqual(hitTitles(), ["Session a1"]);
  assert.match(messages(), /1 matching message so far\./);
  await act(async () => button("Search more").click());
  await settle();
  assert.deepEqual(hitTitles().sort(), ["Session a1", "Session a3"]);
  await act(async () => button("Search more").click());
  await settle();
  assert.deepEqual(hitTitles().sort(), ["Session a1", "Session a3", "Session n9"]);
  assert.match(messages(), /3 matching messages\./);
  assert.equal(button("Search more")?.textContent, undefined, "nothing remains to search");
  assert.deepEqual(inboxFixture.searches.map(search => search.params.after ?? null), [null, "c1", "c2"]);
});

test("message search starts again when a searched project is rebound, so old binding hits do not stay", async () => {
  inboxFixture.hits = [hit("alpha", "a1", "the table wraps")];
  await render("/?run=a1");
  await searchFor("table");
  assert.equal(inboxFixture.searches.length, 1);
  inboxFixture.hits = [];
  inboxFixture.catalog = { ...catalog, projects: catalog.projects.map(project => project.projectId === "alpha"
    ? { ...project, bindingRevision: 2 } : project) };
  await act(async () => inboxFixture.notify());
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  await settle();
  assert.equal(inboxFixture.searches.length, 2, "the rebound project is searched again");
  assert.deepEqual(hitTitles(), [], "the old binding's hit is gone");
});

test("a project whose search failed stays reported, and retried, across Search more", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.failProjects = ["alpha"];
  inboxFixture.pages = { "": { results: [hit("beta", "b1", "table one")], continueAfter: "c1" },
    c1: { results: [hit("beta", "b2", "table two")], continueAfter: null } };
  await render("/?run=a1");
  await searchFor("table");
  const messages = () => host.querySelector(".conversation-inbox__messages").textContent;
  assert.match(messages(), /One project could not be searched\./);
  await act(async () => button("Search more").click());
  await settle();
  assert.deepEqual(hitTitles().sort(), ["Session b1", "Session b2"]);
  assert.match(messages(), /One project could not be searched\./, "the failed project is still missing");
  assert.ok(inboxFixture.searches.filter(search => search.params.projectId === "alpha").length >= 2,
    "Search more retries the project that failed");
});

test("message search says when nothing matches and when search is unavailable, and keeps the selection", async () => {
  inboxFixture.hits = [];
  await render("/?run=a1");
  await searchFor("nothing here");
  assert.match(host.querySelector(".conversation-inbox__messages").textContent, /No messages match\./);
  inboxFixture.searchFails = true;
  await searchFor("table");
  assert.match(host.querySelector(".conversation-inbox__messages").textContent,
    /Message search is unavailable\. Titles are still filtered\./);
  assert.ok(button("Retry search"));
  assert.deepEqual(titles(), ["Fix table wrapping"]);
  assert.equal(host.querySelector('[aria-current="true"]').dataset.rowId, "code:a1");
  await type(host.querySelector(".conversation-inbox__search"), "t");
  assert.equal(host.querySelector(".conversation-inbox__messages"), null, "one character searches titles only");
});

test("All projects searches messages across projects and opens a hit in another project", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.hits = [hit("beta", "b1", "table in beta"), hit(null, "p1", "personal table", "native")];
  await render("/?run=a1");
  await searchFor("table");
  assert.deepEqual(inboxFixture.searches.map(search => search.params.projectId ?? null).sort(), ["alpha", "beta", null].sort());
  assert.equal(host.querySelector(".conversation-inbox__messages").textContent.includes("searched in"), false, "no cap below six");
  await act(async () => [...host.querySelectorAll(".conversation-inbox__hit")].find(item => /beta/.test(item.textContent)).click());
  await settle();
  assert.equal(inboxFixture.active, "beta");
  assert.equal(host.querySelector("#route").textContent, "?history=project&run=b1&event=ref-b1&eventOffset=3");
});

test("All projects message search is capped at six scopes, newest projects first, and says so", () => {
  const { messageSearchScopes } = module.exports;
  const projects = Array.from({ length: 8 }, (_, i) => ({ projectId: `p${i}`, displayName: `P${i}` }));
  const rows = [{ projectId: "p7", createdAt: 90 }, { projectId: "p3", createdAt: 80 }, { projectId: null, createdAt: 5 }];
  const { scopes, total } = messageSearchScopes("all", projects, rows);
  assert.equal(total, 9);
  assert.equal(scopes.length, 6);
  assert.deepEqual(scopes.slice(0, 3).map(scope => scope.projectId), ["p7", "p3", null]);
  assert.deepEqual(messageSearchScopes("p2", projects, rows), { scopes: [{ projectId: "p2", label: "P2" }], total: 1 });
});

test("route helpers name exactly one row", () => {
  const { inboxRowHref, selectedInboxRowId } = module.exports;
  for (const id of ["code:run-1", "native:thread:1", "code-draft:abc"]) {
    assert.equal(selectedInboxRowId(inboxRowHref({ id }).slice(1)), id);
  }
  assert.equal(selectedInboxRowId("?runtime=native&history=unassigned&thread=x"), null);
  assert.equal(selectedInboxRowId(""), null);
});

test("production Sidebar mounts the inbox and preserves project navigation and unassigned history", async () => {
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.unassignedIdentity = { kind: "unassigned", projectId: null, storageKey: "legacy-owner-scope",
    scope: { type: "workspace-app", id: "legacy-scope" } };
  await render("/", true);
  const sidebar = host.querySelector('aside[aria-label="Projects and conversations"]');
  assert.ok(sidebar.querySelector(".conversation-inbox"), "the production Sidebar must mount the real inbox");
  assert.equal(sidebar.querySelector("[data-old-history]"), null, "the old project list must not compete with the inbox");
  assert.ok(sidebar.querySelector('nav[aria-label="Project selection"]'));
  assert.equal(sidebar.querySelector(".workspace-saved-conversations summary").textContent, "Unassigned conversations");
  assert.equal(sidebar.querySelector("[data-legacy-scope]").dataset.legacyScope, "legacy-owner-scope");
  assert.ok(sidebar.querySelector('a[href="/settings"]'));
  assert.ok(sidebar.querySelector('a[href="/settings/architecture"]'));
  await act(async () => sidebar.querySelector('[data-row-id="code:b1"]').click());
  await settle();
  assert.equal(inboxFixture.active, "beta");
  assert.equal(new URLSearchParams(host.querySelector("#route").textContent).get("run"), "b1");
  assert.equal(sidebar.querySelector("[data-legacy-scope]").dataset.legacyScope, "legacy-owner-scope",
    "project navigation must not relabel unassigned history");
});

test("production Sidebar keeps inbox access without legacy history and retains utility controls", async () => {
  await render("/", true);
  const sidebar = host.querySelector("aside");
  assert.ok(sidebar.querySelector(".conversation-inbox"));
  assert.equal(sidebar.querySelector(".workspace-saved-conversations"), null);
  await act(async () => sidebar.querySelector('[aria-label="Search Vivary"]').click());
  await act(async () => sidebar.querySelector('[aria-label="Close project navigation"]').click());
  assert.ok(inboxFixture.calls.some(call => call.name === "command-menu"));
  assert.ok(inboxFixture.calls.some(call => call.name === "collapse" && call.value === true));
});

test("a row opened from the other Sidebar supersedes an in-flight project selection", async () => {
  const slow = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.selectionWait = projectId => projectId === "beta" ? slow.wait : Promise.resolve();
  await render("/", 2);
  const [desktop, narrow] = host.querySelectorAll("aside");
  try {
    await act(async () => desktop.querySelector('[data-row-id="code:b1"]').click());
    await act(async () => narrow.querySelector('[data-row-id="code:a1"]').click());
    await settle();
    assert.equal(new URLSearchParams(route()).get("run"), "a1");
  } finally {
    await act(async () => slow.release());
    await settle();
  }
  assert.equal(inboxFixture.active, "alpha", "the later click in either Sidebar owns project selection");
  assert.equal(new URLSearchParams(route()).get("run"), "a1", "the older selection must not replace the later row");
});

test("filter saves from both Sidebars retain the latest choice after a slow write", async () => {
  const slow = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.writeDelay = value => value.filter === "alpha" ? slow.wait : Promise.resolve();
  await render("/", 2);
  const [desktop, narrow] = host.querySelectorAll("aside");
  try {
    await chooseFilter("alpha", desktop);
    await chooseFilter("beta", narrow);
    assert.deepEqual(titles(narrow.querySelector('ul[aria-label="Conversations"]')), ["Review onboarding"]);
  } finally {
    await act(async () => slow.release());
    await settle();
  }
  assert.deepEqual(inboxFixture.state.get(FILTER), { scopeKey: "scope", filter: "beta" },
    "the earlier surface's delayed save must not overwrite the newer filter");
});

test("Sidebar exposes identity retry while keeping Code conversations usable", async () => {
  inboxFixture.identityError = true;
  inboxFixture.identityBlocked = "alpha";
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    return { changed: true, record: { status: "cleared" } }; };
  await render("/", true);
  assert.match(host.querySelector('[role="alert"]').textContent, /Native history could not be opened/);
  await act(async () => host.querySelector('[data-row-id="code:a1"]').click());
  await settle();
  assert.equal(new URLSearchParams(route()).get("run"), "a1");
  await act(async () => button("Retry history").click());
  await settle();
  assert.ok(inboxFixture.calls.some(call => call.name === "retry-identity"));
  assert.equal(host.querySelector('[role="alert"]'), null);
  await act(async () => host.querySelector('[aria-label="Choose conversation type"]').click());
  await act(async () => button("API chat (separate billing)").click());
  await settle();
  assert.equal(inboxFixture.calls.find(call => call.name === "vivary-chat-draft").input.projectId, "alpha");
  assert.equal(route(), "?runtime=native&history=project&thread=new-native");
});

test("a deferred API chat in one Sidebar cannot replace a newer row in the other", async () => {
  const slow = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "beta" });
  inboxFixture.call = async (name, input) => {
    inboxFixture.calls.push({ name, input });
    if (name === "vivary-chat-draft") await slow.wait;
    return { changed: true, record: { status: "cleared" } };
  };
  await render("/?run=a1", 2);
  const [desktop, narrow] = host.querySelectorAll("aside");
  try {
    await act(async () => desktop.querySelector('[aria-label="Choose conversation type"]').click());
    await act(async () => [...desktop.querySelectorAll("button")].find(item => item.textContent === "API chat (separate billing)").click());
    await settle();
    assert.equal(inboxFixture.active, "beta");
    assert.ok(inboxFixture.calls.some(call => call.name === "vivary-chat-draft"));
    await act(async () => narrow.querySelector('[data-row-id="code:b1"]').click());
    await settle();
  } finally {
    await act(async () => slow.release());
    await settle();
  }
  assert.equal(new URLSearchParams(route()).get("run"), "b1");
});

test("an older Sidebar restore cannot supersede a newer pending project open", async () => {
  const restore = gate(), selection = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.rows.push(row("native:a5", "alpha", "Archived API chat", 1, { archived: true }));
  inboxFixture.selectionWait = projectId => projectId === "beta" ? selection.wait : Promise.resolve();
  inboxFixture.call = async (name, input) => {
    inboxFixture.calls.push({ name, input });
    if (name === "vivary-conversation-archive") await restore.wait;
    return { changed: true };
  };
  await render("/?run=a1", 2);
  const [desktop, narrow] = host.querySelectorAll("aside");
  try {
    await act(async () => desktop.querySelector('[data-row-id="native:a5"]').click());
    await act(async () => narrow.querySelector('[data-row-id="code:b1"]').click());
    assert.equal(route(), "?run=a1", "the later project's selection is still pending");
    await act(async () => restore.release());
    await settle();
  } finally {
    await act(async () => { restore.release(); selection.release(); });
    await settle();
  }
  assert.equal(inboxFixture.active, "beta");
  assert.equal(new URLSearchParams(route()).get("run"), "b1");
});

for (const restore of [false, true]) test(`a later ${restore ? "archived row" : "API chat"} cancels the other Sidebar's pending project selection`, async () => {
  const slow = gate(), restored = gate();
  inboxFixture.state.set(FILTER, { scopeKey: "scope", filter: "all" });
  inboxFixture.rows.push(row("native:a5", "alpha", "Archived API chat", 1, { archived: true }));
  inboxFixture.selectionWait = projectId => projectId === "beta" ? slow.wait : Promise.resolve();
  inboxFixture.call = async (name, input) => { inboxFixture.calls.push({ name, input });
    if (name === "vivary-conversation-archive") await restored.wait;
    return { changed: true, record: { status: "cleared" } }; };
  await render("/?run=a1", 2);
  const [desktop, narrow] = host.querySelectorAll("aside");
  try {
    await act(async () => desktop.querySelector('[data-row-id="code:b1"]').click());
    if (restore) {
      await act(async () => narrow.querySelector('[data-row-id="native:a5"]').click());
    } else {
      await act(async () => narrow.querySelector('[aria-label="Choose conversation type"]').click());
      await act(async () => [...narrow.querySelectorAll("button")].find(item => item.textContent === "API chat (separate billing)").click());
    }
    await settle();
    await act(async () => slow.release());
    await settle();
  } finally {
    await act(async () => { slow.release(); restored.release(); });
    await settle();
  }
  assert.equal(inboxFixture.active, "alpha");
  assert.equal(new URLSearchParams(route()).get("thread"), restore ? "a5" : "new-native");
});
