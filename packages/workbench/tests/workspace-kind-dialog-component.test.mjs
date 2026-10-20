import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// The Coding or Personal dialog. The component, its keyboard handling and the save hook are real. The toolkit dialog
// is stubbed to plain elements: its stub passes Escape to onOpenChange(false) and calls onOpenAutoFocus on mount, the
// two Radix behaviors the component relies on. Radix's own focus trap and portal are not exercised here.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom tracks no focus, so focus() calls are recorded and served as document.activeElement.
let focused = null;
window.HTMLElement.prototype.focus = function focus() { focused = this; };
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused ?? document.body });
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: globalThis.kindFixture.call });`],
  ["./ProjectContext", `export const useProjects = () => ({ refresh: globalThis.kindFixture.refresh });`],
  ["@tabler/icons-react", `export const IconCode = () => null; export const IconNotes = () => null;`],
  ["@agent-native/toolkit/ui", `import { createContext, createElement, useContext, useEffect } from "react";
    const Open = createContext(() => {});
    export const Button = ({ size, variant, ...props }) => createElement("button", props);
    export const Dialog = ({ open, onOpenChange, children }) => open
      ? createElement(Open.Provider, { value: onOpenChange }, children) : null;
    export function DialogContent({ children, onOpenAutoFocus, closeLabel, className }) {
      const onOpenChange = useContext(Open);
      useEffect(() => { onOpenAutoFocus?.({ preventDefault() {} }); }, []);
      return createElement("div", { role: "dialog", className,
        onKeyDown: event => { if (event.key === "Escape") onOpenChange(false); } },
        children, createElement("button", { type: "button", "data-close": "", onClick: () => onOpenChange(false) }, closeLabel));
    }
    export const DialogHeader = props => createElement("div", props);
    export const DialogFooter = props => createElement("div", props);
    export const DialogTitle = props => createElement("h2", props);
    export const DialogDescription = props => createElement("p", props);`],
]);
const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { ProjectKindDetail, WorkspaceKindDialog, useSaveProjectKind } from "./app/components/projects/WorkspaceKindDialog";
  export { CATALOG_QUERY_KEY, openedFolderNeedsKind, withProjectKind } from "./app/lib/project-catalog-schema";
  export { QueryClient };
  export function view(props) { return createElement(WorkspaceKindDialog, props); }
  export function detailView(props) { return createElement("dl", null, createElement(ProjectKindDetail, props)); }
  function Saver() {
    const save = useSaveProjectKind();
    globalThis.kindFixture.save = save;
    return null;
  }
  export function saverView() {
    return createElement(QueryClientProvider, { client: globalThis.kindFixture.queryClient }, createElement(Saver));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

let host, root;
test.beforeEach(() => {
  focused = null;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  globalThis.kindFixture = { events: [],
    call: async (name, input) => { kindFixture.events.push(["call", name, input]); return { ok: true }; },
    refresh: async () => { kindFixture.events.push(["refresh"]); } };
  kindFixture.queryClient = new module.exports.QueryClient();
});
test.afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
const cards = () => [...host.querySelectorAll(".workspace-kind-card")];
const props = (patch = {}) => ({ open: true, description: "Fixture description.",
  onChoose: kind => { kindFixture.events.push(["choose", kind]); }, onCancel: () => { kindFixture.events.push(["cancel"]); },
  ...patch });
const render = patch => act(async () => root.render(module.exports.view(props(patch))));
const key = (target, name) => act(async () => {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: name });
  target.dispatchEvent(event);
});

test("shows both choices with their defaults and the shared line, and focuses the first card", async () => {
  await render();
  assert.equal(host.querySelector("h2").textContent, "What kind of project is this?");
  assert.equal(host.querySelector("[role=dialog] p").textContent, "Fixture description.");
  assert.deepEqual(cards().map(card => card.querySelector(".workspace-kind-card-title").textContent), ["Coding", "Personal"]);
  assert.deepEqual(cards().map(card => card.querySelector(".workspace-kind-card-body").textContent), [
    "New conversations start with a coding agent (Claude Code or Codex). Handoff uses STATE.md.",
    "New conversations start as API chat for notes, research and writing.",
  ]);
  assert.equal(host.querySelector(".workspace-kind-note").textContent, "You can start either kind of conversation in any project.");
  assert.ok(cards().every(card => card.tagName === "BUTTON" && card.getAttribute("type") === "button"),
    "native buttons take Enter and Space");
  assert.ok(cards().every(card => card.getAttribute("aria-pressed") === "false"), "nothing is preselected");
  assert.equal(document.activeElement, cards()[0]);
});

test("each card chooses its kind", async () => {
  await render();
  await act(async () => cards()[0].click());
  await settle();
  await act(async () => cards()[1].click());
  await settle();
  assert.deepEqual(kindFixture.events, [["choose", "coding"], ["choose", "personal"]]);
});

test("the current kind is marked and focused, and the arrow keys move between the cards", async () => {
  await render({ current: "personal" });
  assert.deepEqual(cards().map(card => card.getAttribute("aria-pressed")), ["false", "true"]);
  assert.equal(document.activeElement, cards()[1]);
  const group = host.querySelector("[role=group]");
  await key(cards()[1], "ArrowRight");
  assert.equal(document.activeElement, cards()[0], "the arrows wrap");
  await key(cards()[0], "ArrowDown");
  assert.equal(document.activeElement, cards()[1]);
  await key(cards()[1], "ArrowUp");
  assert.equal(document.activeElement, cards()[0]);
  await key(cards()[0], "ArrowLeft");
  assert.equal(document.activeElement, cards()[1]);
  await key(group, "Tab");
  assert.equal(document.activeElement, cards()[1], "other keys keep the browser's behavior");
  assert.deepEqual(kindFixture.events, [], "moving focus chooses nothing");
});

test("Cancel, the close button and Escape cancel without choosing", async () => {
  await render();
  const cancel = [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel" && !button.hasAttribute("data-close"));
  await act(async () => cancel.click());
  await act(async () => host.querySelector("[data-close]").click());
  await key(cards()[0], "Escape");
  assert.deepEqual(kindFixture.events, [["cancel"], ["cancel"], ["cancel"]]);
  await render({ open: false });
  assert.equal(host.querySelector("[role=dialog]"), null);
});

test("a failed save keeps the dialog open with the reason, and Escape waits while a save runs", async () => {
  let finish;
  await render({ onChoose: kind => new Promise((resolve, reject) => {
    kindFixture.events.push(["choose", kind]);
    finish = () => reject(new Error("Project folder access changed."));
  }) });
  await act(async () => cards()[1].click());
  assert.equal(cards()[1].querySelector(".workspace-kind-card-title").textContent, "Saving…");
  assert.ok(cards().every(card => card.disabled));
  await key(cards()[1], "Escape");
  await act(async () => finish());
  await settle();
  assert.equal(host.querySelector("[role=alert]").textContent, "Project folder access changed.");
  assert.ok(cards().every(card => !card.disabled));
  assert.deepEqual(kindFixture.events, [["choose", "personal"]], "Escape during the save did not cancel");
});

test("saving calls only the owner action with the project and kind, then refreshes the project list", async () => {
  await act(async () => root.render(module.exports.saverView()));
  await act(async () => kindFixture.save("project_beta", "personal"));
  assert.deepEqual(kindFixture.events, [
    ["call", "vivary-set-project-kind", { projectId: "project_beta", workspaceKind: "personal" }], ["refresh"]]);
});

const catalogFixture = (patch = {}) => ({ code: "catalog", scopeKey: "scope_a", policyRevision: 1, registryRevision: 4,
  kindEditable: true, locations: [], projects: [
    { projectId: "project_alpha", displayName: "Alpha", bindingRevision: 1, status: "available", reconnectEligible: false,
      workspaceKind: "coding" },
    { projectId: "project_beta", displayName: "Beta", bindingRevision: 1, status: "available", reconnectEligible: false,
      workspaceKind: null }], ...patch });

// Review of #260. The project list refetch does not reject when it fails, and it keeps the cached list.
test("a saved kind is written into the cached project list, so a failed refetch cannot leave Not set", async () => {
  const { CATALOG_QUERY_KEY } = module.exports;
  kindFixture.queryClient.setQueryData(CATALOG_QUERY_KEY, catalogFixture());
  // The fixture refresh changes nothing, the way a failed refetch leaves the cached data in place.
  await act(async () => root.render(module.exports.saverView()));
  await act(async () => kindFixture.save("project_beta", "personal"));
  assert.deepEqual(kindFixture.queryClient.getQueryData(CATALOG_QUERY_KEY).projects.map(project => project.workspaceKind),
    ["coding", "personal"]);
  assert.deepEqual(kindFixture.events.at(-1), ["refresh"]);
  // A refused save changes nothing in the cache.
  kindFixture.call = async () => { throw new Error("Project folder access changed."); };
  await act(async () => root.render(module.exports.saverView()));
  await assert.rejects(kindFixture.save("project_alpha", "personal"), /access changed/);
  assert.equal(kindFixture.queryClient.getQueryData(CATALOG_QUERY_KEY).projects[0].workspaceKind, "coding");
  assert.deepEqual(module.exports.withProjectKind({ code: "denied" }, "project_beta", "coding"), { code: "denied" });
});

test("Project details shows the kind everywhere and its button only where the host can save a kind", async () => {
  const changes = [];
  const detail = patch => act(async () => root.render(module.exports.detailView({ kind: null, editable: true,
    onChange: () => changes.push("change"), ...patch })));
  await detail();
  assert.equal(host.querySelector("dd span").textContent, "Not set");
  assert.equal(host.querySelector("dd button").textContent, "Set kind");
  await act(async () => host.querySelector("dd button").click());
  await detail({ kind: "personal" });
  assert.equal(host.querySelector("dd button").textContent, "Change kind");
  // A configured installation: the catalog says kindEditable false and no control is offered.
  await detail({ kind: "personal", editable: false });
  assert.equal(host.querySelector("dd span").textContent, "Personal");
  assert.equal(host.querySelector("dd button"), null);
  assert.deepEqual(changes, ["change"]);
});

test("Open folder asks for the kind of a new or repeated registration only while it is Not set and savable", () => {
  const { openedFolderNeedsKind } = module.exports;
  const catalog = catalogFixture();
  assert.equal(openedFolderNeedsKind("registered", "project_beta", catalog), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_beta", catalog), true,
    "a retry that finds the folder registered still asks while the kind is Not set");
  assert.equal(openedFolderNeedsKind("already-registered", "project_alpha", catalog), false);
  assert.equal(openedFolderNeedsKind("registered", "project_new", catalog), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_new", catalog), false);
  assert.equal(openedFolderNeedsKind("registered", "project_beta", catalogFixture({ kindEditable: false })), false);
  assert.equal(openedFolderNeedsKind("registered", "project_beta", undefined), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_beta", { code: "denied" }), false);
});

// The Code rail shows while chat identity loads, and it can start only a Code conversation.
const codeRailStubs = new Map([
  ["@agent-native/core/client/agent-chat", `export const isCodeAgentRunActive = () => false;`],
  ["@agent-native/core/client/hooks", `export const useActionQuery = () => ({ data: undefined, isLoading: false,
    error: null, refetch: async () => {} });`],
  ["@agent-native/toolkit/chat-history", `import { createElement } from "react";
    export const useChatHistoryRailController = ({ onNewChat, labels }) => ({ visibleItems: [], onNewChat,
      newChatLabel: labels.newChat, canExpand: false });
    export const ChatHistoryList = ({ footer }) => createElement("div", null, footer);`],
  ["@agent-native/toolkit/design-system", `import { createElement } from "react";
    export const ActionButton = ({ onPress, disabled, children, className }) =>
      createElement("button", { type: "button", className, disabled, onClick: onPress }, children);
    export const IconButton = () => null;`],
  ["@tabler/icons-react", `export const IconDots = () => null; export const IconPlus = () => null;`],
  ["react-router", `export const useLocation = () => ({ search: "" });
    export const useNavigate = () => to => globalThis.kindFixture.events.push(["navigate", to]);`],
  ["@/components/projects/ProjectContext", `export const useProjects = () => globalThis.kindFixture.projects;`],
  ["@/components/ui/button", `import { createElement } from "react"; export const Button = props => createElement("button", props);`],
]);
const codeRailBundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { CodeHistory } from "./app/components/layout/CodeHistory";
  export function railView() { return createElement(CodeHistory); }`, loader: "tsx", resolveDir: workbench },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "code-rail-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => codeRailStubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: codeRailStubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const codeRail = { exports: {} };
compileFunction(codeRailBundle.outputFiles[0].text, ["require", "module", "exports"])(require, codeRail, codeRail.exports);

test("while chat identity loads, the Code rail cannot start a conversation in a Personal project", async () => {
  const newConversation = () => host.querySelector(".an-chat-history-rail__new-chat");
  for (const [kind, disabled] of [["personal", true], ["coding", false], [null, false]]) {
    kindFixture.projects = { activeProject: { projectId: "project_beta", workspaceKind: kind }, checking: false,
      workspaceAvailable: true, historyAvailable: true };
    await act(async () => root.render(codeRail.exports.railView()));
    assert.equal(newConversation().disabled, disabled, String(kind));
  }
  await act(async () => newConversation().click());
  assert.match(kindFixture.events.at(-1)[1], /^\/\?run=new&draft=/, "Not set keeps opening a Code draft");
});
