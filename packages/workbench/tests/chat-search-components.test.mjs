import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
    export const readClientAppState = async () => null;
    export const writeClientAppState = async () => null;
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
      return createElement("div", { "data-replay": "true", "data-disabled": String(props.composerDisabled) });
    }
    export const AgentChatSurface = props => createElement("div", { "data-editable-thread": props.threadUrlSync.routeThreadId });`],
  ["@agent-native/toolkit/ui", ui], ["@/components/ui/button", ui],
  ["@tanstack/react-query", `const client = { setQueryData() {} };
    export const useQueryClient = () => client;
    export const useQuery = () => ({ data: null, isSuccess: true, isPending: false, refetch() {} });`],
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
    import { MemoryRouter, useLocation } from "react-router";
    import NativeConversation from "./app/components/workspace/NativeConversation";
    import { Workspace } from "./app/components/workspace/Workspace";
    import { ChatSessionSearch } from "./app/components/layout/ChatSessionSearch";
    function Location() { return createElement("output", { id: "route" }, useLocation().search); }
    export function view(kind, route) {
      const child = kind === "native" ? createElement(NativeConversation) : kind === "workspace" ? createElement(Workspace)
        : createElement(ChatSessionSearch, { identity: globalThis.searchFixture.identity });
      return createElement(MemoryRouter, { initialEntries: [route] }, child, createElement(Location));
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
  globalThis.searchFixture = { invalidations: 0,
    session: { status: "authenticated", session: { email: "owner@example.test", token: undefined }, retry() {} },
    identity: { kind: "project", projectId: "alpha", storageKey: "alpha", scope: { type: "project", id: "alpha" } },
    projects: { activeProject: { projectId: "alpha", displayName: "Alpha" }, catalog: { scopeKey: "owner" },
      checking: false, workspaceAvailable: true },
  };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
test.afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
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
