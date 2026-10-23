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

// Every bundle is built before the first test is declared. A test declared after a build awaited between tests
// was silently left out of the run here, so the builds stay above every test.
const catalogFixture = (patch = {}) => ({ code: "catalog", scopeKey: "scope_a", policyRevision: 1, registryRevision: 4,
  kindEditable: true, locations: [], projects: [
    { projectId: "project_alpha", displayName: "Alpha", bindingRevision: 1, status: "available", reconnectEligible: false,
      workspaceKind: "coding" },
    { projectId: "project_beta", displayName: "Beta", bindingRevision: 1, status: "available", reconnectEligible: false,
      workspaceKind: null }], ...patch });

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

// Project navigation and its selection owner are real, including React Query's refetch/error semantics.
// The dialog uses the same inert toolkit shell as the isolated cases above. Host actions and saved state are mocked.
const navigationStubs = new Map([
  ["react-router", `export const useLocation = () => ({ pathname: "/" }); export const useNavigate = () => () => {};`],
  ["@agent-native/core/client/hooks", `import { useQuery } from "@tanstack/react-query";
    export function useActionQuery(name, input, options = {}) {
      return useQuery({ ...options, queryKey: ["action", name, input],
        queryFn: () => globalThis.kindFixture.readAction(name, input) });
    }
    export const readClientAppState = async () => globalThis.kindFixture.selection;`],
  ["@/lib/native-state", `export const useAppStateWriter = () => ({ ready: true, sessionStatus: "authenticated",
    retrySession() {}, writeAppState: globalThis.kindFixture.writeAppState });`],
  ["@agent-native/toolkit/ui", stubs.get("@agent-native/toolkit/ui") + `
    export const Skeleton = () => null;`],
  ["@tabler/icons-react", `export const IconCode = () => null; export const IconNotes = () => null;
    export const IconFolderPlus = () => null;`],
  ["@/components/ui/button", `import { createElement } from "react";
    export const Button = ({ size, variant, ...props }) => createElement("button", props);`],
  ["@/components/ui/input", `import { createElement } from "react"; export const Input = props => createElement("input", props);`],
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: globalThis.kindFixture.call });
    export const folderConnectionErrorMessage = () => "Folder failed.";`],
  ["./ReconnectProjectForm", `export const ReconnectProjectForm = () => null;`],
  ["./CreateProjectForm", `import { createElement } from "react";
    export const CreateProjectForm = ({ workspaceKind, onClose }) => createElement("div", { "data-create-kind": workspaceKind },
      createElement("button", { type: "button", "data-create-close": "", onClick: onClose }, "Close form"));`],
]);
const navigationSource = `
  import { createElement, useEffect } from "react";
  import { QueryClientProvider } from "@tanstack/react-query";
  import { ProjectNavigation } from "./app/components/projects/ProjectNavigation";
  import { ProjectProvider, useProjects } from "./app/components/projects/ProjectContext";
  function Navigation() {
    const projects = useProjects();
    globalThis.kindFixture.observedProjects = projects;
    useEffect(() => {
      if (projects.workspaceAvailable && projects.activeProject) {
        globalThis.kindFixture.entries.push({ projectId: projects.activeProject.projectId,
          kind: projects.activeProject.workspaceKind });
      }
    }, [projects.workspaceAvailable, projects.activeProject]);
    return createElement(ProjectNavigation);
  }
  export function navigationView() {
    return createElement(QueryClientProvider, { client: globalThis.kindFixture.queryClient },
      createElement(ProjectProvider, null, createElement(Navigation)));
  }`;
const navigationBundle = await build({ stdin: { contents: navigationSource, loader: "tsx", resolveDir: workbench },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "navigation-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => navigationStubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: navigationStubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const navigation = { exports: {} };
compileFunction(navigationBundle.outputFiles[0].text, ["require", "module", "exports"])(require, navigation, navigation.exports);

// This separate bundle removes only the form substitute and adds the icon required by the real form.
// Its Input remains the plain input above, with no fixture autofocus or replacement node.
const realFormStubs = new Map(navigationStubs);
realFormStubs.delete("./CreateProjectForm");
realFormStubs.set("@tabler/icons-react", navigationStubs.get("@tabler/icons-react") + `
  export const IconFileText = () => null;`);
const realFormBundle = await build({ stdin: { contents: navigationSource, loader: "tsx", resolveDir: workbench },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "real-form-navigation-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => realFormStubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: realFormStubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const realFormNavigation = { exports: {} };
compileFunction(realFormBundle.outputFiles[0].text, ["require", "module", "exports"])(require, realFormNavigation, realFormNavigation.exports);

let host, root;
test.beforeEach(() => {
  focused = null;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  globalThis.kindFixture = { events: [],
    call: async (name, input) => { kindFixture.events.push(["call", name, input]); return { ok: true }; },
    refresh: async () => { kindFixture.events.push(["refresh"]); },
    catalog: catalogFixture(), selection: null, entries: [], folderPicker: false,
    readCatalog: async () => kindFixture.catalog,
    readAction: async name => {
      if (name === "vivary-project-catalog") return kindFixture.readCatalog();
      if (name === "vivary-desktop-status") return { folderPicker: kindFixture.folderPicker };
      throw new Error("Unexpected navigation query: " + name);
    },
    writeAppState: async (name, value) => {
      kindFixture.events.push(["state-write", name, value]);
      kindFixture.selection = value;
      return value;
    } };
  kindFixture.queryClient = new module.exports.QueryClient();
});
// Clearing the client removes its queries and their five-minute garbage collection timers, which
// otherwise keep the test process running after the last test.
test.afterEach(async () => { await act(async () => root.unmount()); host.remove(); kindFixture.queryClient.clear(); });
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function waitForNavigation(check, message) {
  const expires = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < expires, "Navigation did not settle: " + message);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}
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

test("Open folder asks for an unset or unknown kind where the catalog permits saving", () => {
  const { openedFolderNeedsKind } = module.exports;
  const catalog = catalogFixture();
  assert.equal(openedFolderNeedsKind("registered", "project_beta", catalog), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_beta", catalog), true,
    "a retry that finds the folder registered still asks while the kind is Not set");
  assert.equal(openedFolderNeedsKind("already-registered", "project_alpha", catalog), false);
  assert.equal(openedFolderNeedsKind("registered", "project_new", catalog), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_new", catalog), true,
    "a missing retry entry leaves the kind uncertain in the retained editable catalog");
  assert.equal(openedFolderNeedsKind("registered", "project_beta", catalogFixture({ kindEditable: false })), false);
  assert.equal(openedFolderNeedsKind("registered", "project_beta", undefined), true);
  assert.equal(openedFolderNeedsKind("already-registered", "project_beta", { code: "denied" }), false);
});

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

// Review of #260. The kind chosen for one new project must not carry into the next New project.
test("New project starts with no kind chosen after an earlier project chose Personal", async () => {
  await act(async () => root.render(navigation.exports.navigationView()));
  const newProject = () => [...host.querySelectorAll("button")].find(button => button.textContent === "New project");
  await waitForNavigation(() => !!newProject(), "initial project catalog");
  await act(async () => newProject().click());
  assert.deepEqual(cards().map(card => card.getAttribute("aria-pressed")), ["false", "false"]);
  await act(async () => cards()[1].click());
  await settle();
  assert.equal(host.querySelector("[data-create-kind]").getAttribute("data-create-kind"), "personal");
  assert.equal(newProject(), undefined, "New project is hidden while its form is open");
  await act(async () => host.querySelector("[data-create-close]").click());
  await act(async () => newProject().click());
  assert.deepEqual(cards().map(card => card.getAttribute("aria-pressed")), ["false", "false"], "nothing is preselected");
  assert.equal(document.activeElement, cards()[0], "the first card takes focus, not the earlier choice");
});

for (const [kind, label, index, activation, keyLabel] of [
  ["coding", "Coding", 0, "Enter", "Enter"],
  ["personal", "Personal", 1, " ", "Space"],
]) {
  test(`New project focuses the real name field after ${label} is chosen with ${keyLabel}`, async () => {
    kindFixture.call = async (name, input) => {
      kindFixture.events.push(["call", name, input]);
      if (name === "vivary-workspace-pattern-catalog") return { code: "catalog", patterns: [] };
      throw new Error("Unexpected real-form action: " + name);
    };
    await act(async () => root.render(realFormNavigation.exports.navigationView()));
    const newProject = () => [...host.querySelectorAll("button")].find(button => button.textContent === "New project");
    await waitForNavigation(() => !!newProject(), "real-form project catalog");
    const trigger = newProject();
    await act(async () => trigger.focus());
    assert.equal(document.activeElement === trigger, true, "New project starts with keyboard focus");
    // Linkedom does not synthesize a native click from a key event, so model that activation explicitly.
    await key(trigger, "Enter");
    await act(async () => trigger.click());
    assert.deepEqual(cards().map(card => card.getAttribute("aria-pressed")), ["false", "false"]);
    assert.equal(document.activeElement === cards()[0], true, "the first card receives focus");
    if (index === 1) await key(cards()[0], "ArrowRight");
    const choice = cards()[index];
    assert.equal(document.activeElement === choice, true, "keyboard focus reaches the chosen card");
    assert.equal(choice.disabled, false);
    await key(choice, activation);
    await act(async () => choice.click());
    await waitForNavigation(() => {
      const input = host.querySelector("#new-project-name");
      return !!input && !input.disabled && !host.querySelector("[role=dialog]");
    }, "enabled real form after " + kind + " choice");
    assert.equal(host.querySelector(".project-kind-summary strong").textContent, label);
    assert.deepEqual(kindFixture.events.filter(event => event[0] === "call"),
      [["call", "vivary-workspace-pattern-catalog", {}]]);
    assert.equal(document.querySelector("#new-project-name").isConnected, true);
    assert.equal(document.activeElement === document.querySelector("#new-project-name"), true,
      "focus must move from the closed kind dialog into the enabled real form");
    const change = [...host.querySelectorAll("button")].find(button => button.textContent === "Change");
    await act(async () => change.focus());
    await key(change, "Enter");
    await act(async () => change.click());
    assert.deepEqual(cards().map(card => card.getAttribute("aria-pressed")),
      index === 0 ? ["true", "false"] : ["false", "true"]);
    assert.equal(document.activeElement === cards()[index], true, "Change focuses the current kind");
  });
}

// Claim 4330742974. Registration is in-memory fixture state. The lost-response trace is a mocked
// host reply, not a real remote registration, filesystem operation, or network failure experiment.
function openFolderHost({ alreadyRegistered = false, kind = null, loseFirstReply = false } = {}) {
  const projectId = "project_gamma";
  let registered = alreadyRegistered, workspaceKind = kind, connects = 0, catalogReads = 0;
  let failNextCatalog = false;
  const trace = [], failedCatalogs = [];
  const selectionWrites = () => kindFixture.events.filter(event => event[0] === "state-write"
    && event[1] === "vivary-project-selection-v1" && event[2].projectId === projectId);
  const unsubscribe = kindFixture.queryClient.getQueryCache().subscribe(event => {
    if (event.type === "updated" && event.action.type === "error"
      && event.query.queryKey[1] === "vivary-project-catalog") {
      const data = event.query.state.data;
      failedCatalogs.push({ code: data?.code ?? null,
        projectIds: data?.projects?.map(project => project.projectId) ?? [] });
    }
  });
  kindFixture.folderPicker = true;
  kindFixture.readCatalog = async () => {
    catalogReads++;
    if (failNextCatalog) {
      failNextCatalog = false;
      trace.push("mocked catalog refresh rejected");
      throw new Error("Mocked catalog read unavailable");
    }
    const current = catalogFixture();
    if (registered) current.projects.push({ projectId, displayName: "Gamma", bindingRevision: 1,
      status: "available", reconnectEligible: false, workspaceKind });
    trace.push("mocked catalog reply: " + (registered ? "Gamma present" : "Gamma absent"));
    return current;
  };
  kindFixture.call = async (name, input) => {
    kindFixture.events.push(["call", name, input]);
    if (name === "vivary-connect-project-folder") {
      connects++;
      const code = registered ? "already-registered" : "registered";
      registered = true;
      if (loseFirstReply && connects === 1) {
        trace.push("mocked host reply lost after Gamma registration state changed");
        throw new Error("Mocked host reply lost");
      }
      if (loseFirstReply && connects === 2) failNextCatalog = true;
      trace.push("mocked host reply: " + code);
      return { code, projectId, displayName: "Gamma", bindingId: "binding_gamma", bindingRevision: 1, replayed: connects > 1 };
    }
    if (name === "vivary-set-project-kind") {
      assert.equal(input.projectId, projectId);
      workspaceKind = input.workspaceKind;
      return { projectId, workspaceKind };
    }
    throw new Error("Unexpected mocked host action: " + name);
  };
  return { projectId, trace, failedCatalogs, selectionWrites, close: unsubscribe,
    get registered() { return registered; }, get connects() { return connects; }, get catalogReads() { return catalogReads; } };
}

const openFolderButton = () => [...host.querySelectorAll("button")].find(button => button.textContent === "Open folder");
async function mountOpenFolder() {
  await act(async () => root.render(navigation.exports.navigationView()));
  await waitForNavigation(() => !!openFolderButton() && !openFolderButton().disabled, "Open folder available");
}
async function clickOpenFolder() {
  assert.equal(openFolderButton()?.disabled, false, "the actual Open folder control is enabled");
  await act(async () => openFolderButton().click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await waitForNavigation(() => !!openFolderButton() && !openFolderButton().disabled
    && !kindFixture.observedProjects.selecting, "Open folder completion");
}

test("Open folder retry after a mocked lost host reply cannot enter an unseen Not-set project", async () => {
  const fixture = openFolderHost({ loseFirstReply: true });
  try {
    await mountOpenFolder();
    await clickOpenFolder();
    assert.equal(fixture.registered, true, "the mocked host changed registration state before losing its reply");
    assert.equal(fixture.trace.includes("mocked host reply lost after Gamma registration state changed"), true);
    assert.equal(fixture.connects, 1);
    assert.equal(fixture.catalogReads, 1, "the lost mocked reply leaves the pre-registration catalog cached");
    assert.equal(fixture.selectionWrites().length, 0);
    await clickOpenFolder();
    assert.equal(fixture.connects, 2);
    assert.equal(fixture.trace.includes("mocked host reply: already-registered"), true);
    assert.equal(fixture.failedCatalogs.length, 1, "React Query observed the rejected refresh");
    assert.equal(fixture.failedCatalogs[0].code, "catalog", "the refresh failure retained the cached catalog");
    assert.equal(fixture.failedCatalogs[0].projectIds.includes("project_alpha"), true);
    assert.equal(fixture.failedCatalogs[0].projectIds.includes(fixture.projectId), false, "the retained catalog lacks Gamma");
    assert.equal(fixture.selectionWrites().length, 0, "retry must not persist entry into an unseen Not-set project before a kind choice");
    assert.equal(kindFixture.entries.some(entry => entry.projectId === fixture.projectId), false,
      "the real selection owner must not make Gamma's Code workspace available before the kind choice");
    const dialog = host.querySelectorAll('[role="dialog"]').length;
    const safeRetry = [...host.querySelectorAll('[role="status"], [role="alert"]')]
      .some(element => /refresh|retry|try again/i.test(element.textContent));
    assert.equal(dialog > 0 || safeRetry, true, "a kind dialog or explicit safe retry must gate project entry");
    if (dialog === 0) await clickOpenFolder();
    assert.equal(host.querySelectorAll('[role="dialog"]').length, 1, "a later successful refresh still requires the kind choice");
    assert.equal(fixture.selectionWrites().length, 0);
    await act(async () => cards()[1].click());
    await waitForNavigation(() => kindFixture.observedProjects.activeProject?.projectId === fixture.projectId
      && !kindFixture.observedProjects.selecting, "retried project selection after choosing Personal");
    assert.equal(fixture.selectionWrites().length, 1);
    assert.equal(kindFixture.observedProjects.activeProject.workspaceKind, "personal");
    const save = kindFixture.events.findIndex(event => event[0] === "call" && event[1] === "vivary-set-project-kind"
      && event[2].projectId === fixture.projectId && event[2].workspaceKind === "personal");
    assert.equal(save >= 0 && save < kindFixture.events.indexOf(fixture.selectionWrites()[0]), true,
      "the Personal save precedes persisted project selection");
    assert.equal(host.querySelectorAll('[role="dialog"]').length, 0, "the kind dialog closes after choosing Personal");
    assert.equal(kindFixture.entries.some(entry => entry.projectId === fixture.projectId && entry.kind === null), false,
      "Gamma is never made available with the default Code kind before the choice");
  } finally { fixture.close(); }
});

for (const [kind, label] of [["coding", "Coding"], ["personal", "Personal"]]) {
  test("Open folder reuses a present " + label + " project without another kind choice", async () => {
    const fixture = openFolderHost({ alreadyRegistered: true, kind });
    try {
      await mountOpenFolder();
      await clickOpenFolder();
      assert.equal(fixture.trace.includes("mocked host reply: already-registered"), true);
      assert.equal(host.querySelectorAll('[role="dialog"]').length, 0);
      assert.equal(fixture.selectionWrites().length, 1);
      assert.equal(kindFixture.observedProjects.activeProject?.projectId ?? null, fixture.projectId);
      assert.equal(kindFixture.observedProjects.activeProject?.workspaceKind ?? null, kind);
    } finally { fixture.close(); }
  });
}

test("Open folder asks before selecting an ordinarily registered Not-set project", async () => {
  const fixture = openFolderHost();
  try {
    await mountOpenFolder();
    await clickOpenFolder();
    assert.equal(fixture.trace.includes("mocked host reply: registered"), true);
    assert.equal(host.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(fixture.selectionWrites().length, 0);
    assert.equal(kindFixture.entries.some(entry => entry.projectId === fixture.projectId), false);
    await act(async () => cards()[1].click());
    await waitForNavigation(() => kindFixture.observedProjects.activeProject?.projectId === fixture.projectId
      && !kindFixture.observedProjects.selecting, "chosen Personal project selection");
    assert.equal(fixture.selectionWrites().length, 1);
    assert.equal(kindFixture.observedProjects.activeProject.workspaceKind, "personal");
  } finally { fixture.close(); }
});
