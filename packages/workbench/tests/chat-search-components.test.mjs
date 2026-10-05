import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { compileFunction } from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { act } from "react";

// Mount the production route/search components; stub only their host services and
// Core's transcript renderer. Router navigation and the owner transport stay real.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
class Observer { observe() {} disconnect() {} }
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  MutationObserver: Observer, ResizeObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout });
window.location = new URL("http://localhost/");
const { createRoot } = await import("react-dom/client");
const ui = `import { createElement } from "react";
  export const Button = ({ children, ref, onClick, ...props }) => createElement("button", { ref, onClick }, children);
  export const Skeleton = () => null;
  export const ResizablePanel = ({ children }) => children;
  export const ResizablePanelGroup = ResizablePanel;
  export const ResizableHandle = () => null;`;
const stubs = new Map([
  ["@agent-native/core/client/hooks", `export const useSession = () => globalThis.searchFixture.session;
    export const notifySessionInvalidated = () => { globalThis.searchFixture.invalidations++; };
    export const readClientAppState = async key => key.startsWith("vivary-chat-selection-v1:")
      ? globalThis.searchFixture.savedSelection ?? null : null;
    export const writeClientAppState = async (key, value) => { globalThis.searchFixture.writes.push({ key, value }); return value; };
    export const actionErrorMessage = () => null;
    export const callAction = async () => null;
    export const tryCallActionKeepalive = () => ({ accepted: false });`],
  ["@agent-native/core/client/api-path", `export const agentNativePath = path => path;`],
  ["@agent-native/core/client/agent-chat", `import { createElement, useEffect } from "react";
    export const clearChatStorage = () => {};
    export function AssistantChat(props) {
      useEffect(() => {
        props.loadHistoryRepository().catch(() => {});
      }, [props.loadHistoryRepository]);
      return createElement("div", { "data-replay": "true", "data-disabled": String(props.composerDisabled),
        "data-placeholder": props.composerDisabledPlaceholder });
    }
    export const AgentChatSurface = props => createElement("div", { "data-editable-thread": props.threadUrlSync.routeThreadId });`],
  ["@agent-native/toolkit/ui", ui], ["@/components/ui/button", ui],
  ["@/components/layout/use-vivary-chat-identity", `export const useVivaryChatIdentity = () => ({ identity: globalThis.searchFixture.identity });`],
  ["../projects/ProjectContext", `export const useProjects = () => globalThis.searchFixture.projects;`],
  ["@/lib/chat-draft", `export const registerSelectionCloseFlush = () => () => {};
    export const trackSelectionWrite = promise => promise;
    export const useOrphanedDrafts = () => [];
    export const useNativeChatDraft = () => ({ statusForThread: () => null, draftSaveStatusForThread: () => null });`],
  ["../layout/use-workspace-layout", `export const readPanelWidth = () => 480;
    export const savePanelWidth = () => {}; export const useNarrowLayout = () => false;`],
  ["@tabler/icons-react", `export const IconArrowsMaximize = () => null;
    export const IconArrowsMinimize = IconArrowsMaximize, IconFiles = IconArrowsMaximize, IconInfoCircle = IconArrowsMaximize,
      IconSearch = IconArrowsMaximize, IconWorld = IconArrowsMaximize, IconX = IconArrowsMaximize;`],
]);
for (const [path, name] of [["../projects/ProjectFiles", "ProjectFiles"], ["../projects/ProjectSearch", "ProjectSearch"],
  ["../projects/ProjectAdoption", "ProjectAdoption"], ["../projects/ProjectMemoryPanel", "ProjectMemoryPanel"],
  ["../projects/ProjectReadPanel", "ProjectReadPanel"], ["../projects/ProjectEvaluatePanel", "ProjectEvaluatePanel"],
  ["../workbench/BrowserPreview", "BrowserPreview"]]) stubs.set(path, `export const ${name} = () => null;`);
for (const path of ["../../routes/files", "./CodeConversation"]) stubs.set(path, "export default function Empty() { return null; }");
const bundle = await build({ stdin: { contents: `
    import { createElement } from "react";
    import { MemoryRouter, useLocation, useNavigate } from "react-router";
    import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
    notifyManager.setScheduler(callback => queueMicrotask(callback));
    import NativeConversation from "./app/components/workspace/NativeConversation";
    import { Workspace } from "./app/components/workspace/Workspace";
    import { ChatSessionSearch } from "./app/components/layout/ChatSessionSearch";
    function Location() {
      globalThis.searchFixture.navigate = useNavigate();
      return createElement("output", { id: "route" }, useLocation().search);
    }
    export function view(kind, route) {
      const child = kind === "native" ? createElement(NativeConversation) : kind === "workspace" ? createElement(Workspace)
        : createElement(ChatSessionSearch, { identity: globalThis.searchFixture.identity });
      const client = globalThis.searchFixture.queryClient ??= new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      return createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: [route] }, child, createElement(Location)));
    }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*", "react-router"], loader: { ".css": "empty" },
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);
let root, host;
const threadData = JSON.stringify({ headId: "match", messages: [
  { message: { id: "match", role: "user", content: [{ type: "text", text: "Saved match" }] }, parentId: null },
] });
test.beforeEach(() => {
  globalThis.searchFixture = { invalidations: 0, writes: [],
    session: { status: "authenticated", session: { email: "owner@example.test", token: undefined }, retry() {} },
    identity: { kind: "project", projectId: "alpha", storageKey: "alpha", scope: { type: "project", id: "alpha" } },
    projects: { activeProject: { projectId: "alpha", displayName: "Alpha" }, catalog: { scopeKey: "owner" },
      checking: false, workspaceAvailable: true },
  };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
test.afterEach(async () => { await act(async () => root.unmount()); searchFixture.queryClient?.clear(); host.remove(); });
const render = (kind, route = "/") => act(async () => { root.render(module.exports.view(kind, route)); });
const button = name => [...host.querySelectorAll("button")].find(item => item.textContent === name);

test("archived Native match cannot leave replay for an editable archived thread", async () => {
  globalThis.fetch = async () => Response.json({ threadData, archived: true });
  await render("native", "/?runtime=native&history=project&thread=archived&message=match");
  assert.ok(host.querySelector("[data-replay]"));
  const latest = button("Return to latest conversation");
  if (latest && !latest.disabled) await act(async () => latest.click());
  assert.equal(Boolean(host.querySelector('[data-editable-thread="archived"]')), false);
  assert.ok(host.querySelector("[data-replay]"), "archived history remains readable until explicit restoration");
  assert.match(host.textContent, /Restore.*Archived conversations/);
  assert.match(host.querySelector("[data-replay]").dataset.placeholder, /Restore.*Archived conversations/);
});
test("archived Unassigned match describes read-only history without an unavailable restore path", async () => {
  searchFixture.identity = { kind: "unassigned", projectId: null, storageKey: "unassigned",
    scope: { type: "workspace-app", id: "unassigned" } };
  globalThis.fetch = async () => Response.json({ threadData, archived: true });
  await render("native", "/?runtime=native&history=unassigned&thread=archived&message=match");
  assert.equal(button("Return to latest conversation").disabled, true);
  const placeholder = host.querySelector("[data-replay]").dataset.placeholder;
  for (const text of [host.textContent, placeholder]) {
    assert.match(text, /archived.*read-only here/i);
    assert.doesNotMatch(text, /Restore|Archived conversations/);
  }
});
test("archived Personal match retains the available Archived conversations restore guidance", async () => {
  searchFixture.identity = { ...searchFixture.identity, projectId: null, storageKey: "personal" };
  globalThis.fetch = async () => Response.json({ threadData, archived: true });
  await render("native", "/?runtime=native&history=project&thread=archived&message=match");
  assert.equal(button("Return to latest conversation").disabled, true);
  assert.match(host.textContent, /Restore.*Archived conversations/);
  assert.match(host.querySelector("[data-replay]").dataset.placeholder, /Restore.*Archived conversations/);
});
test("active Native match can still return to the latest editable conversation", async () => {
  globalThis.fetch = async () => Response.json({ threadData, archived: false });
  await render("native", "/?runtime=native&history=project&thread=active&message=match");
  assert.equal(button("Return to latest conversation").disabled, false);
  await act(async () => button("Return to latest conversation").click());
  assert.ok(host.querySelector('[data-editable-thread="active"]'));
  assert.equal(new URLSearchParams(host.querySelector("#route").textContent).has("message"), false);
});
test("Native return stays disabled while authoritative archive state is loading", async () => {
  let finish;
  globalThis.fetch = async (input, init) => init?.method === "PUT" ? Response.json(null)
    : await new Promise(resolve => { finish = resolve; });
  await render("native", "/?runtime=native&history=project&thread=unknown&message=match");
  assert.equal(button("Return to latest conversation").disabled, true);
  await act(async () => { finish(Response.json({ threadData, archived: false })); });
  assert.equal(button("Return to latest conversation").disabled, false);
});
for (const sameThread of [false, true]) for (const outcome of ["active", "archived", "failure"])
  test(`superseded Native match ${outcome} cannot replace current status (same thread=${sameThread})`, async () => {
    const pending = [];
    // Deliberately ignore cancellation: even a response already being decoded
    // when navigation occurs must not change the current match's status.
    globalThis.fetch = async () => await new Promise((resolve, reject) => pending.push({ resolve, reject }));
    await render("native", "/?runtime=native&history=project&thread=first&message=match");
    assert.equal(pending.length, 1);
    const currentThread = sameThread ? "first" : "second";
    await act(async () => searchFixture.navigate(`/?runtime=native&history=project&thread=${currentThread}&message=new-match`));
    assert.equal(pending.length, 2);
    assert.equal(button("Return to latest conversation").disabled, true);
    const currentData = JSON.stringify({ headId: "new-match", messages: [
      { message: { id: "new-match", role: "user", content: [{ type: "text", text: "Current match" }] }, parentId: null },
    ] });
    await act(async () => pending[1].resolve(Response.json({ threadData: currentData, archived: false })));
    assert.equal(button("Return to latest conversation").disabled, false);
    await act(async () => {
      if (outcome === "failure") pending[0].reject(new TypeError("Old request failed"));
      else pending[0].resolve(Response.json({ threadData, archived: outcome === "archived" }));
    });
    assert.equal(button("Return to latest conversation").disabled, false, "late reply must preserve current loaded status");
    assert.doesNotMatch(host.textContent, /could not be opened|Restore.*Archived conversations/);
    await act(async () => button("Return to latest conversation").click());
    assert.ok(host.querySelector(`[data-editable-thread="${currentThread}"]`));
  });
for (const outcome of ["active", "archived", "failure"])
  test(`returning to the same Native match ignores its older ${outcome} reply`, async () => {
    const pending = [];
    globalThis.fetch = async () => await new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const route = "/?runtime=native&history=project&thread=first&message=match";
    await render("native", route);
    await act(async () => searchFixture.navigate("/?runtime=native&history=project&thread=second&message=match"));
    await act(async () => searchFixture.navigate(route));
    assert.equal(pending.length, 3, "A to B to A starts a new read for the same match key");
    const archived = outcome === "active";
    await act(async () => pending[2].resolve(Response.json({ threadData, archived })));
    assert.equal(button("Return to latest conversation").disabled, archived);
    await act(async () => pending[1].resolve(Response.json({ threadData, archived: false })));
    await act(async () => {
      if (outcome === "failure") pending[0].reject(new TypeError("First A request failed"));
      else pending[0].resolve(Response.json({ threadData, archived: outcome === "archived" }));
    });
    assert.equal(button("Return to latest conversation").disabled, archived, "the second A read owns Return status");
    assert.doesNotMatch(host.textContent, /matching conversation could not be opened/i);
    if (archived) assert.match(host.textContent, /Restore.*Archived conversations/);
    else assert.doesNotMatch(host.textContent, /Restore.*Archived conversations/);
  });
for (const failure of ["404", "401", "network"]) test(`failed Native match (${failure}) can return without retaining the unread thread`, async () => {
  globalThis.fetch = async () => {
    if (failure === "network") throw new TypeError("Network unavailable");
    return Response.json({ message: "Unavailable" }, { status: Number(failure) });
  };
  await render("native", "/?runtime=native&history=project&thread=unread&message=match&event=stale&eventOffset=123&panel=files");
  assert.equal(button("Return to latest conversation").disabled, false);
  assert.match(host.textContent, /matching conversation could not be opened/i);
  await act(async () => button("Return to latest conversation").click());
  const params = new URLSearchParams(host.querySelector("#route").textContent);
  for (const key of ["thread", "message", "event", "eventOffset"]) assert.equal(params.has(key), false, key);
  assert.equal(params.get("runtime"), "native");
  assert.equal(params.get("history"), "project");
  assert.equal(params.get("panel"), "files");
  assert.equal(Boolean(host.querySelector("[data-replay]")), false);
});
for (const archived of [false, true]) test(`failed Native match preserves saved selection and restores only active threads (archived=${archived})`, async () => {
  searchFixture.savedSelection = { storageKey: "alpha", threadId: "saved" };
  let selectionReads = 0;
  globalThis.fetch = async input => {
    if (String(input).includes("/agent-chat/threads/saved")) {
      selectionReads++;
      return Response.json({ id: "saved", archivedAt: archived ? 123 : null });
    }
    return Response.json({ message: "Match no longer available" }, { status: 404 });
  };
  await render("native", "/?runtime=native&history=project&thread=unread&message=match");
  assert.equal(searchFixture.writes.length, 0, "read-only replay must preserve the saved latest conversation");
  assert.equal(button("Return to latest conversation").disabled, false);
  await act(async () => button("Return to latest conversation").click());
  assert.equal(selectionReads, 1, "Return reuses the authoritative saved-selection check");
  const params = new URLSearchParams(host.querySelector("#route").textContent);
  assert.equal(params.get("thread"), archived ? null : "saved");
  assert.equal(params.has("message"), false);
  assert.equal(Boolean(host.querySelector('[data-editable-thread="unread"]')), false);
  assert.equal(Boolean(host.querySelector('[data-editable-thread="saved"]')), !archived);
});
test("maintained chat-search tests have a 60-second timeout", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(scripts["test:chat-search"].split(/\s+/).includes("--test-timeout=60000"));
});
test("project switch clears Native and Code match anchors before admitting the next conversation", async () => {
  globalThis.fetch = async () => Response.json({ threadData, archived: false });
  await render("workspace", "/?runtime=native&history=project&thread=old&message=match&event=old-event&eventOffset=234&unrelated=keep");
  searchFixture.projects.activeProject = { projectId: "beta", displayName: "Beta" };
  searchFixture.identity = { ...searchFixture.identity, projectId: "beta", storageKey: "beta" };
  await render("workspace");
  const params = new URLSearchParams(host.querySelector("#route").textContent);
  for (const key of ["runtime", "history", "thread", "message", "event", "eventOffset"]) assert.equal(params.has(key), false, key);
  assert.equal(params.get("unrelated"), "keep");
});
test("limited search coverage explains changed conversations and starting again", async () => {
  globalThis.fetch = async () => Response.json({ results: [], continueAfter: null, searchedSessions: 1,
    limited: true, limits: { results: 25 } });
  await render("search");
  const input = host.querySelector("input[type=search]");
  await act(async () => {
    input.value = "needle";
    const props = input[Object.keys(input).find(key => key.startsWith("__reactProps$"))];
    props.onChange({ target: input });
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  assert.match(host.textContent, /conversations changed during this search/i);
  assert.match(host.textContent, /start the search again/i);
});
for (const kind of ["search", "native"]) test(`${kind} GET invalidates a rejected owner session`, async () => {
  searchFixture.session.session.token = `rejected-${kind}-component-token`;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") return Response.json(null);
    requests++;
    return Response.json({ message: "Sign in." }, { status: 401 });
  };
  await render(kind, "/?runtime=native&history=project&thread=old&message=match");
  if (kind === "search") {
    const input = host.querySelector("input[type=search]");
    // linkedom has no native input-value tracker. Invoke React's registered
    // change handler with the same target a browser input event supplies.
    await act(async () => {
      input.value = "needle";
      const props = input[Object.keys(input).find(key => key.startsWith("__reactProps$"))];
      props.onChange({ target: input });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  }
  assert.equal(searchFixture.invalidations, 1);
  assert.equal(requests, 1);
  if (kind === "search") {
    await act(async () => button("Retry search").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    assert.equal(requests, 1, "Retry must not resend the rejected token");
  }
});
