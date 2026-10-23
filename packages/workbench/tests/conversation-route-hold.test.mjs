import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// The route hold in app/lib/conversation-route-hold.ts and its caller in CodeRunControl. React, the router, the hook,
// and the strip are real. The project selection, the host-state read, the owner action caller, and the toolkit button
// are fixtures. ProjectRouteReset copies the route reset Workspace.tsx applies when the project changes, and then
// restores the ready project's saved route onto a bare route, as CodeConversation's showInUrl and Workspace's
// saved-surface restore do. The hold first appeared in the conversation inbox.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event,
  requestAnimationFrame: callback => setTimeout(callback, 0), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const fixture = "globalThis.routeHoldFixture";
const stubs = new Map([
  ["../projects/ProjectContext", `import { useSyncExternalStore } from "react";
    export function useProjects() {
      useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
      return ${fixture}.projects();
    }`],
  ["../../lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, retrySession() {},
    call: async (...args) => { ${fixture}.calls.push(args); return {}; } });`],
  ["@agent-native/core/client/hooks", `
    export const actionErrorMessage = failure => failure?.message;
    export const useActionQuery = () => ({ data: ${fixture}.host, error: null, refetch: async () => ({}) });`],
  ["../projects/open-project-folder", `export const useOpenProjectFolder = () => ({ available: false, choosing: false,
    async openFolder() {} });`],
  ["@agent-native/toolkit/ui", `import { createElement } from "react";
    export const Button = ({ size, variant, ...props }) => createElement("button", { type: "button", ...props });`],
]);
const bundle = await build({ stdin: { contents: `
  import { createElement, useEffect, useState, useSyncExternalStore } from "react";
  import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
  import { CodeRunControl } from "./app/components/layout/CodeRunControl";
  import { holdConversationRoute, useConversationRouteHold, WORKSPACE_ROUTE_KEYS } from "./app/lib/conversation-route-hold";
  function Location() { return createElement("output", { id: "route" }, useLocation().search); }
  function ProjectRouteReset() {
    const [params, setParams] = useSearchParams();
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    const current = ${fixture}.active ?? "personal";
    const [ready, setReady] = useState(null);
    useEffect(() => {
      if (ready === null) { setReady(current); return; }
      if (ready === current) return;
      if (WORKSPACE_ROUTE_KEYS.some(key => params.has(key))) {
        setParams(previous => { const next = new URLSearchParams(previous); for (const key of WORKSPACE_ROUTE_KEYS) next.delete(key); return next; },
          { replace: true });
        return;
      }
      setReady(current);
    }, [ready, current, params.toString(), setParams]);
    useEffect(() => {
      if (ready !== current || [...params.keys()].length) return;
      const saved = ${fixture}.savedRoutes?.[current];
      if (saved) setParams(new URLSearchParams(saved), { replace: true });
    }, [ready, current, params.toString(), setParams]);
    return null;
  }
  // A plain caller of the hook: Open holds the target and selects its project, Elsewhere navigates without a press.
  function Opener() {
    const projects = ${fixture}.projects();
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    const routeHold = useConversationRouteHold({ activeProjectId: ${fixture}.active, checking: false });
    const navigate = useNavigate();
    return createElement("div", null,
      createElement("button", { id: "open", onClick: async () => {
        const release = routeHold.hold(${fixture}.target.projectId, ${fixture}.target.href);
        if (!await projects.selectProject(${fixture}.target.projectId)) release();
      } }),
      createElement("button", { id: "elsewhere", onClick: () => navigate("/?run=elsewhere", { replace: true }) }));
  }
  // The layout's driver, mounted for the whole page, as CodeRunControl mounts it.
  function Driver() {
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    useConversationRouteHold({ activeProjectId: ${fixture}.active, checking: false });
    return null;
  }
  // A view that exists only in its own project, as the Code conversation does, and opens a run in another one.
  function TransientOpener() {
    useSyncExternalStore(${fixture}.subscribe, () => ${fixture}.version);
    if (${fixture}.active !== "alpha") return null;
    return createElement("button", { id: "transient-open", onClick: async () => {
      const release = holdConversationRoute(${fixture}.target.projectId, ${fixture}.target.href);
      if (!await ${fixture}.projects().selectProject(${fixture}.target.projectId)) release();
    } });
  }
  export function view(route, mode) {
    const opener = mode === "strip" ? [createElement(CodeRunControl, { key: "strip" })]
      : mode === "transient" ? [createElement(Driver, { key: "driver" }), createElement(TransientOpener, { key: "transient" })]
        : [createElement(Opener, { key: "opener" })];
    return createElement(MemoryRouter, { initialEntries: [route] },
      ...opener, createElement(ProjectRouteReset), createElement(Location));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", loader: { ".css": "empty" }, external: ["react", "react/*", "react-dom/*", "react-router"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

const catalog = { scopeKey: "scope", projects: [{ projectId: "alpha", displayName: "Alpha" },
  { projectId: "beta", displayName: "Beta" }, { projectId: "gamma", displayName: "Gamma" }] };
const activeRun = (id, projectId, title) => ({ id, projectId, title, status: "running", phase: "running",
  workspaceLabel: projectId ?? "home", engineLabel: "Claude Code", model: "claude-sonnet-5-5", stopping: false, pendingApprovals: [] });
let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const listeners = new Set();
  globalThis.routeHoldFixture = {
    version: 0, active: "alpha", calls: [], savedRoutes: {}, target: { projectId: "beta", href: "/?run=b1" },
    host: { activeRuns: [activeRun("b1", "beta", "Review onboarding")], recentRun: null, busy: true, cleanup: null },
    selectResult: true, delays: {}, failing: [],
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { routeHoldFixture.version++; for (const listener of listeners) listener(); },
    projects: () => ({ catalog, checking: false,
      activeProject: catalog.projects.find(project => project.projectId === routeHoldFixture.active) ?? null,
      selectProject: async projectId => {
        routeHoldFixture.calls.push(["selectProject", projectId]);
        await new Promise(resolve => setTimeout(resolve, routeHoldFixture.delays[projectId] ?? 5));
        if (!routeHoldFixture.selectResult || routeHoldFixture.failing.includes(projectId)) return false;
        routeHoldFixture.active = projectId; routeHoldFixture.notify(); return true;
      } }),
  };
});
// The hold belongs to the page, so a test ends it with a key press before the next test's page starts.
test.afterEach(async () => {
  await act(async () => document.dispatchEvent(new window.Event("keydown", { bubbles: true })));
  await act(async () => root.unmount());
  host.remove();
});
const settle = (ms = 50) => act(async () => { for (let i = 0; i < ms / 10; i++) await new Promise(resolve => setTimeout(resolve, 10)); });
async function render(route, mode = "opener") {
  await act(async () => root.render(module.exports.view(route, mode === true ? "strip" : mode)));
  await settle();
}
const route = () => host.querySelector("#route").textContent;
const click = element => act(async () => element.click());
const openInStrip = () => click([...host.querySelectorAll("button")].find(item => item.textContent === "Open conversation"));

// The saved view of the target project: none, another Code conversation, or Native chat.
const RESTORES = [["no saved view", undefined], ["a saved Code conversation", "run=b-saved"],
  ["a saved Native chat", "runtime=native&history=project&thread=saved"]];

for (const [label, saved] of RESTORES) {
  test(`the hook opens the held route in another project over ${label}`, async () => {
    routeHoldFixture.savedRoutes = { beta: saved };
    await render("/?run=a1");
    await click(host.querySelector("#open"));
    await settle();
    assert.equal(routeHoldFixture.active, "beta");
    assert.equal(route(), "?run=b1");
  });

  test(`Open conversation in the strip opens the clicked run in another project over ${label}`, async () => {
    routeHoldFixture.savedRoutes = { beta: saved };
    await render("/?run=a1", true);
    await openInStrip();
    await settle();
    assert.deepEqual(routeHoldFixture.calls, [["selectProject", "beta"]]);
    assert.equal(route(), "?run=b1");
  });
}

for (const [label, saved] of RESTORES) {
  test(`a view that unmounts during the project change still opens the held run over ${label}`, async () => {
    routeHoldFixture.savedRoutes = { beta: saved };
    await render("/?run=a1", "transient");
    await click(host.querySelector("#transient-open"));
    await settle();
    assert.equal(host.querySelector("#transient-open"), null, "the view that asked is gone");
    assert.equal(routeHoldFixture.active, "beta");
    assert.equal(route(), "?run=b1");
  });
}

test("the strip opens a run in the selected project directly", async () => {
  routeHoldFixture.host.activeRuns = [activeRun("a2", "alpha", "Fix tables")];
  await render("/?run=a1", true);
  await openInStrip();
  await settle();
  assert.deepEqual(routeHoldFixture.calls, [], "no project change");
  assert.equal(route(), "?run=a2");
});

test("a slow failed open neither releases a newer open's hold nor shows its error", async () => {
  routeHoldFixture.host.activeRuns = [activeRun("b1", "beta", "Review onboarding"), activeRun("g1", "gamma", "Ship gamma")];
  routeHoldFixture.failing = ["beta"];
  routeHoldFixture.delays = { beta: 5, gamma: 40 };
  routeHoldFixture.savedRoutes = { gamma: "run=g-saved" };
  await render("/?run=a1", true);
  const openRun = title => host.querySelector(`li[aria-label="${title}"] button`);
  await act(async () => { openRun("Review onboarding").click(); openRun("Ship gamma").click(); });
  await settle(150);
  assert.equal(routeHoldFixture.active, "gamma");
  assert.equal(route(), "?run=g1", "the newer click lands");
  assert.equal(host.querySelector('[role="alert"]'), null, "the older failure says nothing");
});

test("an unavailable project releases the hold and keeps the route", async () => {
  routeHoldFixture.selectResult = false;
  await render("/?run=a1", true);
  await openInStrip();
  await settle();
  assert.equal(route(), "?run=a1");
  assert.match(host.querySelector('[role="alert"]').textContent, /The project is unavailable/);
});

test("a replacement inside the settle time is undone, and a key press or the settle time releases the hold", async () => {
  await render("/?run=a1");
  await click(host.querySelector("#open"));
  await settle();
  assert.equal(route(), "?run=b1");
  await click(host.querySelector("#elsewhere"));
  await settle();
  assert.equal(route(), "?run=b1", "a replacement without a press is put back");
  await act(async () => document.dispatchEvent(new window.Event("keydown", { bubbles: true })));
  await click(host.querySelector("#elsewhere"));
  await settle();
  assert.equal(route(), "?run=elsewhere", "a key press releases the hold");

  routeHoldFixture.active = "alpha"; routeHoldFixture.notify();
  await settle();
  await click(host.querySelector("#open"));
  await settle();
  assert.equal(route(), "?run=b1");
  await settle(800);
  await click(host.querySelector("#elsewhere"));
  await settle();
  assert.equal(route(), "?run=elsewhere", "the hold ends after the settle time");
});
