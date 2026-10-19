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
  ["../projects/ProjectContext", `import { useSyncExternalStore } from "react";
    export function useProjects() {
      useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
      return ${fixture}.projects();
    }`],
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: (...args) => ${fixture}.call(...args) });`],
  ["@/lib/native-state", `export const useAppStateWriter = () => ({ ready: true,
    writeAppState: async (key, value) => { ${fixture}.state.set(key, value); return value; } });`],
  ["@/lib/chat-draft", `export const useChatDraftList = scope => ({ data: { drafts: ${fixture}.drafts[scope.kind] ?? [] } });`],
  ["./use-vivary-chat-identity", `export const useVivaryChatIdentity = () => ({ identity: ${fixture}.identity() });`],
  ["@agent-native/core/client/agent-chat", `export const useChatThreads = () => ({ createThread: async () => "new-native",
    switchThread: id => ${fixture}.switched.push(id) });`],
  ["@agent-native/core/client/api-path", `export const agentNativePath = path => path;`],
  ["@agent-native/core/client/hooks", `import { useQuery } from "@tanstack/react-query";
    export const actionErrorMessage = failure => failure?.message;
    export const readClientAppState = async key => ${fixture}.state.get(key) ?? null;
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
  export { visibleInboxRows, inboxRowHref, selectedInboxRowId, sortInboxRows } from "./app/components/layout/ConversationInbox";
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
  export function view(route) {
    const client = ${fixture}.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [route] },
      createElement(ConversationInbox), createElement(ProjectRouteReset), createElement(Location)));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", loader: { ".css": "empty" }, external: ["react", "react/*", "react-dom/*", "react-router", "@tanstack/react-query"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

const catalog = { scopeKey: "scope", projects: [{ projectId: "alpha", displayName: "Alpha" }, { projectId: "beta", displayName: "Beta" }] };
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
  globalThis.inboxFixture = {
    version: 0, active: "alpha", calls: [], switched: [], state: new Map(), drafts: {}, rows: rows(),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { inboxFixture.version++; for (const listener of listeners) listener(); },
    identity: () => ({ kind: "project", projectId: inboxFixture.active, storageKey: `key-${inboxFixture.active}`,
      scope: { type: "workspace-app", id: `scope-${inboxFixture.active}` } }),
    projects: () => ({ catalog, checking: false, workspaceAvailable: true, historyAvailable: true, selecting: false,
      activeProject: catalog.projects.find(project => project.projectId === inboxFixture.active) ?? null,
      refresh: async () => {},
      selectProject: async projectId => {
        inboxFixture.calls.push({ name: "selectProject", projectId });
        await new Promise(resolve => setTimeout(resolve, 5));
        inboxFixture.active = projectId; inboxFixture.notify(); return true;
      } }),
    read: async (name, input) => {
      if (name === "vivary-conversation-inbox") return { rows: inboxFixture.rows, unavailableProjects: [], limited: false };
      if (name === "vivary-project-location") return { folderName: `${input.projectId ?? "home"}-folder`,
        path: `/work/${input.projectId ?? "home"}-folder` };
      throw new Error("Unexpected read " + name);
    },
    call: async (name, input) => { inboxFixture.calls.push({ name, input }); return { changed: true }; },
  };
});
test.afterEach(async () => { await act(async () => root.unmount()); inboxFixture.client?.clear(); host.remove(); focused = null; });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10)); });
async function render(route = "/") { await act(async () => root.render(module.exports.view(route))); await settle(); }
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
async function chooseFilter(value) {
  const select = host.querySelector(".conversation-inbox__filter select");
  Object.defineProperty(select, "value", { value, configurable: true });
  await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
  await settle();
}

test("the filter lists the selected project by default, every project in All projects, and saves the choice", async () => {
  await render();
  assert.deepEqual(titles(), ["Old pinned plan", "Fix table wrapping", "Write launch notes"]);
  assert.equal(host.querySelector(".conversation-inbox__detail")?.textContent, "Claude Code", "runtime shows on Code rows only");
  await chooseFilter("all");
  assert.deepEqual(titles(), ["Old pinned plan", "Fix table wrapping", "Review onboarding", "Write launch notes", "Personal question"]);
  assert.match(host.textContent, /Beta/);
  assert.deepEqual(inboxFixture.state.get("vivary-conversation-filter-v1"), { scopeKey: "scope", mode: "all" });
  await chooseFilter("beta");
  assert.deepEqual(inboxFixture.calls.filter(call => call.name === "selectProject"), [{ name: "selectProject", projectId: "beta" }]);
  assert.deepEqual(titles(), ["Review onboarding"]);
  assert.deepEqual(inboxFixture.state.get("vivary-conversation-filter-v1"), { scopeKey: "scope", mode: "project" });
  await chooseFilter("personal");
  assert.equal(inboxFixture.active, null);
  assert.deepEqual(titles(), ["Personal question"]);
});

test("a saved All projects filter is restored after a restart", async () => {
  inboxFixture.state.set("vivary-conversation-filter-v1", { scopeKey: "scope", mode: "all" });
  await render("/?run=b1");
  assert.equal(host.querySelector(".conversation-inbox__filter select").getAttribute("value") ?? host.querySelector("option[selected]")?.value ?? "all", "all");
  assert.equal(titles().length, 5);
  assert.equal(host.querySelector('[aria-current="true"]')?.dataset.rowId, "code:b1");
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

test("each state is text with an icon, idle shows none, and no state is a live region", async () => {
  await render();
  await chooseFilter("all");
  const states = [...host.querySelectorAll(".conversation-inbox__state")].map(state => [state.dataset.state, state.textContent]);
  assert.deepEqual(states, [["needs-approval", "Needs approval"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"]]);
  for (const state of host.querySelectorAll(".conversation-inbox__state")) assert.ok(state.querySelector("svg"));
  assert.equal(host.querySelector("[aria-live]"), null, "row state changes are never announced on their own");
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
});

for (const restores of [false, true]) test(`a row in another project opens exactly that conversation after the project changes${restores ? ", over a restored saved conversation" : ""}`, async () => {
  inboxFixture.state.set("vivary-conversation-filter-v1", { scopeKey: "scope", mode: "all" });
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

test("a row in the selected project opens directly and Native rows select their thread", async () => {
  await render("/?run=a1");
  await act(async () => rowButtons().find(item => item.dataset.rowId === "native:a2").click());
  assert.equal(host.querySelector("#route").textContent, "?runtime=native&history=project&thread=a2");
  assert.deepEqual(inboxFixture.switched, ["a2"]);
  assert.equal(inboxFixture.calls.some(call => call.name === "selectProject"), false);
});

test("unsent drafts of the selected project are listed and labeled", async () => {
  inboxFixture.drafts = { project: [{ threadId: "draft-native", createdAt: 60, preview: "", status: "draft" }],
    code: [{ threadId: "vivary-code:project:alpha:fresh", createdAt: 55, preview: "Plan the release", status: "pending" }] };
  await render("/?run=new&draft=fresh");
  assert.deepEqual(titles().slice(0, 3), ["Old pinned plan", "Untitled conversation", "Plan the release"]);
  const draft = host.querySelector('[data-row-id="code-draft:fresh"]');
  assert.equal(draft.getAttribute("aria-current"), "true");
  assert.match(draft.textContent, /Review send/);
  assert.match(host.querySelector('[data-row-id="native:draft-native"]').textContent, /Draft/);
  assert.equal(host.querySelector('[aria-label="Actions for Plan the release"]'), null, "a draft has no saved conversation to change");
});

test("the destination shows the selected project and its folder, and the add menu keeps creating and opening distinct", async () => {
  await render();
  const destination = host.querySelector(".conversation-inbox__destination");
  assert.match(destination.textContent, /New conversations start in Alpha/);
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

test("route helpers name exactly one row", () => {
  const { inboxRowHref, selectedInboxRowId } = module.exports;
  for (const id of ["code:run-1", "native:thread:1", "code-draft:abc"]) {
    assert.equal(selectedInboxRowId(inboxRowHref({ id }).slice(1)), id);
  }
  assert.equal(selectedInboxRowId("?runtime=native&history=unassigned&thread=x"), null);
  assert.equal(selectedInboxRowId(""), null);
});
