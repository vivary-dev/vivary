import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const APP = join(WORKBENCH, "app");
const LAYOUT = join(APP, "components", "layout", "Layout.tsx");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
// The public agent-chat entry also re-exports the chat UI. Bundle the module
// that owns sendToAgentChat and parseSubmitChatMessage instead, so the proof
// runs Core's real transport without its panels.
const CORE_AGENT_CHAT = join(CORE, "dist", "client", "agent-chat.js");
const ORIGIN = "http://vivary.test";
const SETTINGS_PATH = "/settings/agent/automations";

// Layout's own children and chrome are replaced. The handoff hook, React,
// React Router, and Core's chat transport stay real.
const layoutStubs = new Map([
  ["./Header", `export function Header() { return null; }`],
  ["./CodeRunControl", `export function CodeRunControl() { return null; }`],
  ["./Sidebar", `export function Sidebar() { return null; }`],
  ["../workspace/Workspace", `export function Workspace() { return <p>Workspace</p>; }`],
  ["./use-workspace-layout", `
    export function useNarrowLayout() { return false; }
    export function readPanelWidth(_key, fallback) { return fallback; }
    export function savePanelWidth() {}`],
]);
const stubs = new Map([
  ["@agent-native/toolkit/app-shell", `
    export function HeaderActionsProvider({ children }) { return children; }`],
  ["@agent-native/toolkit/ui", `
    import { forwardRef } from "react";
    export const Button = forwardRef(function Button({ size, variant, ...props }, ref) {
      return <button ref={ref} type="button" {...props} />;
    });
    export function ResizablePanelGroup({ children }) { return <div>{children}</div>; }
    export function ResizablePanel({ children }) { return <div>{children}</div>; }
    export function ResizableHandle() { return null; }`],
  ["@tabler/icons-react", `export function IconMenu2() { return null; }`],
  ["@/components/ui/sheet", `
    export function Sheet() { return null; }
    export function SheetContent() { return null; }
    export function SheetDescription() { return null; }
    export function SheetTitle() { return null; }`],
  // Analytics is unrelated to delivery and would start network reporting.
  ["./analytics.js", `export function trackEvent() {}`],
  ["@/components/projects/ProjectContext", `
    import { useSyncExternalStore } from "react";
    let state = { activeProject: null, checking: false, historyAvailable: true };
    const listeners = new Set();
    export const projectProof = { selectResult: true, selectGate: null, selections: [], path: "",
      set(next) { state = { ...state, ...next }; for (const listener of listeners) listener(); } };
    export function useProjects() {
      const current = useSyncExternalStore(listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, () => state);
      return { ...current, async selectProject(projectId) {
        projectProof.selections.push({ projectId, path: projectProof.path });
        if (projectProof.selectGate) await projectProof.selectGate;
        return projectProof.selectResult;
      } };
    }`],
]);

const proofSource = String.raw`
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { Layout } from "@proof/Layout";
import { projectProof } from "@/components/projects/ProjectContext";
import { _resetAgentChatSubmitBufferForTests, drainBufferedAgentChatSubmits, reportAgentChatSubmitResult,
  reportAgentChatSubmitTarget, sendToAgentChat } from "@agent-native/core/client/agent-chat";

const PROMPT = "Create an automation that summarizes new files every morning.";
const CONTEXT = "The user wants to create a new personal automation. Use manage-automations with action=define to create it.";
const PERSONAL_CHAT = "/?runtime=native&history=project";
const ALPHA = { projectId: "project-a", displayName: "Project Alpha" };
let path = "";

function Where() {
  const location = useLocation();
  path = location.pathname + location.search;
  projectProof.path = path;
  return null;
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

async function mount({ selectResult = true, projects = { activeProject: ALPHA, checking: false } } = {}) {
  _resetAgentChatSubmitBufferForTests();
  projectProof.set({ historyAvailable: true, ...projects });
  projectProof.selectResult = selectResult;
  projectProof.selectGate = null;
  projectProof.selections = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["${SETTINGS_PATH}"]}>
      <Where /><Layout><p>Automations</p></Layout>
    </MemoryRouter>);
  });
  assert.equal(path, "${SETTINGS_PATH}");
  return { container, dispose: async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    _resetAgentChatSubmitBufferForTests();
  } };
}

// The same call Core's AgentAskPopover makes for "New automation".
async function submitFromSettings(tick, times = 1) {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      sendToAgentChat({ message: PROMPT, context: CONTEXT, submit: true, newTab: true });
    }
  });
  await act(async () => { tick(0); });
  await flush();
}

// React writes a textarea's initial text through defaultValue. linkedom keeps
// that property but does not mirror it into value.
function promptShown(container) {
  return container.querySelector("[role=alert] textarea")?.defaultValue ?? null;
}

function alertText(container) {
  return container.querySelector("[role=alert]")?.textContent ?? null;
}

function button(container, name) {
  const found = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === name);
  assert.ok(found, "missing button " + name);
  return found;
}

export async function handsOffToPersonalNativeChat(tick) {
  const mounted = await mount();
  try {
    await submitFromSettings(tick);
    assert.deepEqual(projectProof.selections, [{ projectId: null, path: "${SETTINGS_PATH}" }]);
    assert.equal(path, PERSONAL_CHAT);
    // Core keeps the submit unclaimed for the Native chat to replay. The
    // context travels separately, so the chat appends it exactly once.
    const buffered = drainBufferedAgentChatSubmits();
    assert.equal(buffered.length, 1);
    assert.equal(buffered[0].message, PROMPT);
    assert.equal(buffered[0].context, CONTEXT);
    assert.equal(alertText(mounted.container), null);
  } finally { await mounted.dispose(); }
}

export async function undeliveredPromptShowsAlert(tick) {
  const mounted = await mount();
  try {
    await submitFromSettings(tick);
    assert.equal(alertText(mounted.container), null);
    await act(async () => { tick(9_000); });
    await flush();
    assert.match(alertText(mounted.container) ?? "", /did not reach a chat/);
    assert.equal(promptShown(mounted.container), PROMPT);
    assert.ok(document.activeElement === mounted.container.querySelector("[role=alert] textarea"),
      "the alert moves focus to the prompt");
    // linkedom has no clipboard, like a page the browser denies it to.
    assert.equal(navigator.clipboard, undefined);
    await act(async () => { button(mounted.container, "Copy prompt").click(); });
    await flush();
    assert.match(alertText(mounted.container) ?? "", /Copy failed\. The text is selected/);
    await act(async () => { button(mounted.container, "Dismiss").click(); });
    assert.equal(alertText(mounted.container), null);
    // Focus was on the page body when the alert appeared, so it returns to the content region.
    assert.ok(document.activeElement === document.getElementById("workbench-content"),
      "dismissing the alert returns focus to the content region");
  } finally { await mounted.dispose(); }
}

export async function deliveredPromptShowsNoAlert(tick) {
  const mounted = await mount();
  try {
    await submitFromSettings(tick);
    const [submit] = drainBufferedAgentChatSubmits();
    await act(async () => { reportAgentChatSubmitTarget(submit.submitMessageId, "thread-personal"); });
    await act(async () => { tick(9_000); });
    await flush();
    assert.equal(alertText(mounted.container), null);
  } finally { await mounted.dispose(); }
}

export async function failedSwitchKeepsPrompt(tick) {
  const mounted = await mount({ selectResult: false });
  try {
    await submitFromSettings(tick);
    assert.deepEqual(projectProof.selections, [{ projectId: null, path: "${SETTINGS_PATH}" }]);
    assert.equal(path, "${SETTINGS_PATH}");
    assert.match(alertText(mounted.container) ?? "", /could not switch to Personal workspace/);
    assert.equal(promptShown(mounted.container), PROMPT);
  } finally { await mounted.dispose(); }
}

export async function loadingProjectsAreWaitedFor(tick) {
  const mounted = await mount({ projects: { activeProject: null, checking: true } });
  try {
    await submitFromSettings(tick);
    assert.deepEqual(projectProof.selections, []);
    assert.equal(path, "${SETTINGS_PATH}");
    // The saved project loads. It must be left before the Native chat opens.
    await act(async () => { projectProof.set({ activeProject: ALPHA, checking: false }); });
    await flush();
    assert.deepEqual(projectProof.selections, [{ projectId: null, path: "${SETTINGS_PATH}" }]);
    assert.equal(path, PERSONAL_CHAT);
    assert.equal(alertText(mounted.container), null);
  } finally { await mounted.dispose(); }
}

export async function projectsThatNeverLoadFailClosed(tick) {
  const mounted = await mount({ projects: { activeProject: null, checking: true } });
  try {
    await submitFromSettings(tick);
    await act(async () => { tick(9_000); });
    await flush();
    assert.deepEqual(projectProof.selections, []);
    assert.equal(path, "${SETTINGS_PATH}");
    assert.match(alertText(mounted.container) ?? "", /could not switch to Personal workspace/);
    // A late load must not switch projects after the owner saw the alert.
    await act(async () => { projectProof.set({ activeProject: ALPHA, checking: false }); });
    await flush();
    assert.deepEqual(projectProof.selections, []);
    assert.equal(path, "${SETTINGS_PATH}");
  } finally { await mounted.dispose(); }
}

export async function immediateRejectionShowsAlert(tick) {
  const mounted = await mount();
  try {
    await submitFromSettings(tick);
    const [submit] = drainBufferedAgentChatSubmits();
    await act(async () => { reportAgentChatSubmitResult(submit.submitMessageId, false, "thread-create-failed"); });
    assert.match(alertText(mounted.container) ?? "", /did not reach a chat/);
    assert.equal(promptShown(mounted.container), PROMPT);
  } finally { await mounted.dispose(); }
}

export async function quickSubmitsShareOneSwitch(tick) {
  const mounted = await mount();
  let release = () => {};
  projectProof.selectGate = new Promise(resolve => { release = resolve; });
  try {
    await submitFromSettings(tick, 2);
    assert.equal(projectProof.selections.length, 1);
    await act(async () => { release(); });
    await flush();
    assert.equal(path, PERSONAL_CHAT);
    assert.equal(projectProof.selections.length, 1);
    assert.equal(alertText(mounted.container), null);
  } finally { release(); await mounted.dispose(); }
}
`;

function appImport(specifier) {
  const base = resolve(APP, specifier.slice(2));
  const found = [`${base}.ts`, `${base}.tsx`, base].find(candidate => existsSync(candidate));
  if (!found) throw new Error(`unresolved app import: ${specifier}`);
  return found;
}

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: HERE, sourcefile: "settings-chat-handoff-proof.tsx", loader: "tsx" },
    absWorkingDir: WORKBENCH,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "settings-chat-handoff-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/Layout") return { path: LAYOUT };
          if (args.path === "@agent-native/core/client/agent-chat") return { path: CORE_AGENT_CHAT };
          if (args.importer === LAYOUT && layoutStubs.has(args.path)) return { path: args.path, namespace: "layout-stub" };
          if (stubs.has(args.path)) return { path: args.path, namespace: "stub" };
          if (args.path.startsWith("@/")) return { path: appImport(args.path) };
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: APP }));
        build.onLoad({ filter: /.*/, namespace: "layout-stub" }, args => (
          { contents: layoutStubs.get(args.path), loader: "tsx", resolveDir: APP }));
      },
    }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => resolve(WORKBENCH, input));
  for (const source of [LAYOUT, join(APP, "lib", "settings-chat-handoff.ts"),
    join(APP, "components", "layout", "SettingsPromptAlert.tsx"), CORE_AGENT_CHAT]) {
    assert.ok(inputs.includes(source), `proof did not bundle ${source}`);
  }
  return result.outputFiles[0].text;
}

function installDom() {
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const view = linkedom.parseHTML("<!doctype html><html><body></body></html>");
  // linkedom has no location or postMessage. A browser delivers a same-window
  // post as a message event carrying the sender's origin.
  view.location = new URL(`${ORIGIN}${SETTINGS_PATH}`);
  view.parent = view;
  view.postMessage = data => {
    const event = new view.Event("message");
    Object.defineProperties(event, { data: { value: data }, origin: { value: ORIGIN } });
    view.dispatchEvent(event);
  };
  class ResizeObserver { observe() {} disconnect() {} }
  // linkedom has no text selection or focus tracking. The alert selects its
  // prompt and moves focus, so the proof records both.
  view.HTMLTextAreaElement.prototype.select ??= function select() {};
  let focused = null;
  view.HTMLElement.prototype.focus = function focus() { focused = this; };
  Object.defineProperty(view.document, "activeElement", { configurable: true, get: () => focused ?? view.document.body });
  // React schedules through MessageChannel. Open ports keep Node alive, so the
  // proof closes every port it created.
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, MessageEvent: view.MessageEvent, EventTarget: view.EventTarget,
    ResizeObserver, MessageChannel: TrackedMessageChannel, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    return channels.length;
  };
}

test("Settings agent prompts reach a Personal Native chat or come back as an alert", async t => {
  const bundle = await buildProof();
  const closeChannels = installDom();
  t.after(() => { closeChannels(); });
  const proof = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
  const cases = [
    ["a project is switched to Personal and a Native chat opens", proof.handsOffToPersonalNativeChat],
    ["a prompt no chat claims within 8 s shows an alert", proof.undeliveredPromptShowsAlert],
    ["a delivered prompt shows no alert", proof.deliveredPromptShowsNoAlert],
    ["a failed switch keeps the prompt in an alert", proof.failedSwitchKeepsPrompt],
    ["a prompt sent while projects load waits for them", proof.loadingProjectsAreWaitedFor],
    ["projects that never load fail closed", proof.projectsThatNeverLoadFailClosed],
    ["an immediate Core rejection shows the alert at once", proof.immediateRejectionShowsAlert],
    ["quick submits share one project switch", proof.quickSubmitsShareOneSwitch],
  ];
  for (const [name, run] of cases) {
    await t.test(name, async sub => {
      sub.mock.timers.enable({ apis: ["setTimeout"] });
      await run(ms => sub.mock.timers.tick(ms));
    });
  }
});

test.after(() => esbuild.stop());
