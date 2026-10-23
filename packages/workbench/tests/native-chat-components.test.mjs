import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { SHARED_FOLDER_WARNING } from "../shared/code-concurrency.ts";

// Another conversation's run in the same folder, as the Code state lists it.
const OTHER_RUN = { id: "other-run", title: "Write the parser tests", projectId: null, turnId: "turn-other-1" };

// Native chat controls rendered from Core's and Toolkit's installed, patched modules, bundled with
// esbuild and mounted on linkedom as builder-offers-component.test.mjs does.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const CLIENT = join(CORE, "dist", "client");
const TOOLKIT = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "toolkit", "package.json")));
const COMPOSER = join(TOOLKIT, "dist", "composer");
const translate = await import(pathToFileURL(join(CORE, "dist", "agent", "engine", "translate-ai-sdk.js")).href);
const threads = await import(pathToFileURL(join(CORE, "dist", "agent", "thread-data-builder.js")).href);

// Host action, draft and project/session boundaries are inert; the controls and Native thread hook
// are real. The Builder connect flow is also stubbed to avoid its status polling.
const stubs = new Map([
  [join(WORKBENCH, "app", "lib", "native-actions.ts"), `
    export function useNativeActionCaller() { return { ready: !!globalThis.codeWorkspaceFixture, call: async (name, params) => {
      if (globalThis.codeWorkspaceFixture?.call) return globalThis.codeWorkspaceFixture.call(name, params);
      if (!globalThis.codeActionFixture) throw new Error("No Code action expected");
      return globalThis.codeActionFixture(name, params);
    } }; }
    export function folderConnectionErrorMessage() { return "The folder could not be connected."; }`],
  [join(WORKBENCH, "app", "lib", "native-state.ts"), `
    export function useAppStateWriter() { return { ready: true, sessionStatus: "authenticated", retrySession() {},
      writeAppState: globalThis.codeWorkspaceFixture?.writeAppState ?? (async () => {}) }; }`],
  [join(WORKBENCH, "app", "components", "projects", "ProjectContext.tsx"), `
    export function useProjects() { return globalThis.codeWorkspaceFixture?.projects ?? { activeProject: null }; }`],
  [join(WORKBENCH, "app", "components", "layout", "use-vivary-chat-identity.ts"), `
    export function useVivaryChatIdentity() { return { identity: globalThis.codeWorkspaceFixture?.identity ?? null,
      waiting: false, isError: false, refetch: async () => {} }; }`],
  [join(WORKBENCH, "app", "components", "layout", "ChatSessionSearch.tsx"), `
    export function ChatSessionSearch() { return null; }`],
  [join(WORKBENCH, "app", "lib", "chat-draft.ts"), `
    export function useNativeChatDraft() { return { statusForThread: () => null, draftSaveStatusForThread: () => null,
      rejectKnownSubmission: async () => {}, hostComposerDraft: undefined }; }
    export function registerSelectionCloseFlush() { return () => {}; }
    export function trackSelectionWrite(write) { return write; }
    export async function flushChatDraftsForClose() {}
    export function useChatDraftList() { return { data: [] }; }`],
  // The real conversation owner is mounted below; opening a project folder is outside these replay/Stop cases.
  [join(WORKBENCH, "app", "components", "projects", "open-project-folder.ts"), `
    export function useOpenProjectFolder() { return { available: false, choosing: false, error: undefined,
      async openFolder() { throw new Error("No folder selection expected"); } }; }`],
  [join(CLIENT, "settings", "useBuilderStatus.js"), `
    export function useBuilderConnectFlow() {
      return { configured: false, connecting: false, error: null, orgName: null, statusResolved: true, start() {} };
    }
    export function useBuilderStatus() { return { status: null, refetch() {} }; }
    export function withBuilderConnectTrackingParams(url) { return url; }
    export function openBuilderConnectPopup() { throw new Error("No account connection expected"); }`],
  // Radix's positioned popover never settles on linkedom, so opening one exhausts the heap. This keeps the open state
  // and renders open content in place, which is all Session details needs. No other proof opens a popover.
  [join(TOOLKIT, "dist", "ui", "popover.js"), `
    import { cloneElement, createContext, createElement, forwardRef, useContext } from "react";
    const State = createContext({ open: false, toggle() {} });
    export function Popover({ open = false, onOpenChange = () => {}, children }) {
      return createElement(State.Provider, { value: { open, toggle: () => onOpenChange(!open) } }, children);
    }
    export function PopoverTrigger({ children }) {
      const state = useContext(State);
      return cloneElement(children, { onClick: state.toggle, "aria-expanded": state.open });
    }
    export function PopoverAnchor({ children }) { return children; }
    export const PopoverContent = forwardRef(({ align, sideOffset, portalled, container, ...props }, ref) =>
      useContext(State).open ? createElement("div", { ref, ...props }) : null);`],
]);

const proofSource = String.raw`
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { AssistantChat } from "@proof/assistant-chat";
import CodeConversation, { CodeSessionDetails, LocalCodeConversation, ProjectCodeWorkspace } from "@proof/workbench-code";
import { ProjectHistory } from "@proof/project-history";
import { claudeCodeModelChoices } from "../shared/claude-models.ts";
import { MultiTabAssistantChat } from "@proof/multi-tab-chat";
import { useEffect, useState } from "react";
import { getRunErrorMetadata, RunErrorRecoveryCard } from "@proof/run-recovery";
import * as messages from "@proof/message-components";
import { processEvent } from "@proof/sse-event-processor";
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { isCodeAgentRunActive } from "@agent-native/core/client/agent-chat";
import { isCancelledError, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { TiptapComposer } from "@proof/tiptap-composer";
import { TooltipProvider } from "@proof/tooltip";
import { UsageSection } from "@proof/usage-section";
import * as chatHistory from "@proof/chat-history";

export async function renderWorkbenchComposer({ model = "claude-sonnet-5-5", active = false, history = false, version = "2.1.296", prefill = false,
  folderRuns = [], viewingMatch = false }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const choices = [];
  const engine = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version }, modelCatalog: null,
    models: claudeCodeModelChoices(version).map(model => model.id),
    claudeModels: claudeCodeModelChoices(version) };
  const state = { engines: [engine], defaultEngine: "claude-cli", defaultModel: "claude-sonnet-5-5", cleanup: null,
    workspaceLabel: "Fixture project" };
  const selection = { key: "composer-review", runId: history ? "retained-run" : null, choice: { engine: "claude-cli", model } };
  const notices = <div data-testid="preserved-notice">Existing notice</div>;
  const props = { state, selection, ownerKey: "fixture-owner", projectId: null, workspaceAvailable: true,
    folderRuns, folderIsolation: FOLDER_ISOLATION, onOpenRun() {}, pendingApprovals: 0,
    previewScope: "fixture", viewingMatch, notices, active, streaming: false,
    stopping: false, run: history ? { id: "retained-run", engine: "claude-cli", engineLabel: "Claude Code", model, events: [], status: "completed" } : null,
    onChoice: choice => choices.push(choice), onStarted() {}, onStreaming() {}, onSettled() {},
    onStop: async () => false, onSettings() {} };
  const view = await mount(<QueryClientProvider client={client}><MemoryRouter><LocalCodeConversation {...props} /></MemoryRouter></QueryClientProvider>);
  if (prefill) {
    const example = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Try a file change");
    if (!example || example.disabled) throw new Error("native runtime did not enable the composer");
    await act(async () => { example.dispatchEvent(new window.Event("click", { bubbles: true })); });
  }
  const picker = view.host.querySelector(PICKER);
  const toolbar = view.host.querySelector('[data-agent-composer-slot="toolbar"]');
  const send = view.host.querySelector('[data-agent-composer-slot="send-button"]');
  const nodes = toolbar ? [...toolbar.querySelectorAll("select,button")] : [];
  const describedBy = picker?.getAttribute("aria-describedby") ?? null;
  const snapshot = { embedded: !!toolbar?.contains(picker), beforeSend: nodes.indexOf(picker) < nodes.indexOf(send),
    selects: toolbar?.querySelectorAll("select").length ?? 0,
    noticesOutsideToolbar: !toolbar?.contains(view.host.querySelector('[data-testid="preserved-notice"]')),
    model: picker?.querySelector(".local-agent-model-name")?.textContent, label: picker?.getAttribute("aria-label"),
    disabled: [picker?.disabled, send?.disabled], choices,
    exampleDisabled: [...view.host.querySelectorAll("button")].find(button => button.textContent === "Try a file change")?.disabled,
    describedBy, text: view.host.textContent };
  await view.unmount(); client.clear();
  return snapshot;
}

// Raw fixtures supply the selected-run identities the server derives before transcript windowing.
function fixtureRunSnapshot(run) {
  return { ...run, turnId: run.events.findLast(event => event.kind === "user")?.id ?? null,
    switchGeneration: run.switchGeneration
      ?? run.events.findLast(event => event.kind === "note" && event.metadata?.source === "vivary-runtime-switch")?.id ?? null };
}

// The Code workspace that owns the conversation, rendered from the Code state the host returns. activeRuns lists the
// caller's running conversations and folderRuns those in this conversation's folder, so the composer's lock comes
// from the workspace's own rule rather than a prop the test sets.
export async function renderCodeWorkspace({ selection, activeRuns = [], folderRuns = [] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const version = "2.1.296";
  const engine = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version }, modelCatalog: null,
    models: claudeCodeModelChoices(version).map(model => model.id), claudeModels: claudeCodeModelChoices(version) };
  const own = selection.runId ? { id: selection.runId, title: "This conversation", projectId: null, engine: "claude-cli",
    engineLabel: "Claude Code", model: "claude-sonnet-5-5", events: [], status: "running", phase: "running" } : null;
  const state = { engines: [engine], defaultEngine: "claude-cli", defaultModel: "claude-sonnet-5-5", cleanup: null,
    workspaceLabel: "Fixture project", projectId: null, runs: own ? [own] : [], run: own, recentRun: null,
    busy: activeRuns.some(item => item.id === selection.runId), activeRuns, folderRuns };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/_agent-native/actions/vivary-code-state")) return Response.json(state);
    return previousFetch(input, init);
  };
  const view = await mount(<QueryClientProvider client={client}><MemoryRouter><ProjectCodeWorkspace projectId={null}
    draftScopeKey="fixture" ownerKey="fixture-owner" workspaceAvailable selection={selection} setSelection={() => {}}
    onOpenActive={async () => false} previewScope="fixture" /></MemoryRouter></QueryClientProvider>);
  try {
    const control = label => view.host.querySelector('[aria-label="' + label + '"]');
    await until(() => !!view.host.querySelector(PICKER), "the conversation composer");
    const shared = view.host.querySelector('[aria-label="Shared folder"]');
    return {
      disabled: view.host.querySelector(PICKER)?.disabled,
      badges: [...view.host.querySelectorAll(".local-agent-header-actions [role=status]")].map(item => item.textContent),
      sharedRuns: [...(shared?.querySelectorAll("li") ?? [])].map(item => item.textContent),
      stop: !!control("Stop response"),
      composerLocked: [...view.host.querySelectorAll("button")].find(button => button.textContent === "Try a file change")?.disabled,
    };
  } finally {
    await view.unmount(); client.clear();
    globalThis.fetch = previousFetch;
  }
}

// A retained Code conversation with both runtimes ready, driven through its selectors and switch panel.
// The Code composer's one runtime and model picker, found by its accessible name.
const PICKER = '[aria-label^="Runtime and model:"]';
const FOLDER_ISOLATION = { available: false, choosing: false, error: undefined, async openFolder() {} };

// A Code conversation with both runtimes ready, driven through its picker, switch panel, and shared-folder warning.
// folderRuns lists other conversations working in its folder. retained: false opens a new conversation instead.
// codexReady: false leaves Codex signed out.
export async function renderCodeSwitch({ running = false, folderRuns = [], viewingMatch = false, events = [], refuse,
  folderPicker = false, retained = true, codexReady = true, pendingSwitch = null, recordSend = false, switchReply = null, switchGeneration = null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const version = "2.1.300";
  const claude = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version }, modelCatalog: null,
    models: claudeCodeModelChoices(version).map(model => model.id), claudeModels: claudeCodeModelChoices(version) };
  const codex = codexReady ? { engine: "codex-cli", label: "Codex", configured: true, runtime: { status: "ready", message: "Signed in" },
    modelCatalog: { status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }, { id: "gpt-other", label: "GPT Other" }],
      defaultModel: "gpt-fixture", connections: [], message: "" },
    models: ["gpt-fixture", "gpt-other"], claudeModels: null }
    : { engine: "codex-cli", label: "Codex", configured: false, runtime: { status: "sign-in-required", message: "Sign in to Codex" },
      modelCatalog: null, models: [], claudeModels: null };
  const state = { engines: [claude, codex], defaultEngine: "claude-cli", defaultModel: "claude-sonnet-5-5", cleanup: null,
    workspaceLabel: "Fixture project" };
  const calls = [], choices = [];
  let settled = 0;
  let run = retained ? { id: "retained-run", engine: "claude-cli", engineLabel: "Claude Code", model: "claude-sonnet-5-5", events,
    status: running ? "running" : "completed", phase: running ? "running" : "complete", pendingSwitch, switchGeneration } : null;
  let repliedRun = null;
  let ownerSnapshot = null;
  const originalFetch = globalThis.fetch;
  if (recordSend) globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    // The real Code adapter reads the retained run before sending a follow-up. Answer only that read here.
    if (url.pathname.endsWith("/vivary-code-state")) return Response.json({ projectId: null, run: fixtureRunSnapshot(repliedRun ?? run) });
    return originalFetch(input, init);
  };
  globalThis.codeActionFixture = async (name, params) => {
    // Linked history and handoff controls read their own actions on mount. They stay refused, as in the other cases.
    if (name !== "vivary-code-switch" && name !== "vivary-code-stop" && !(recordSend && name === "vivary-code-send")) {
      throw new Error("No Code action expected");
    }
    calls.push({ name, params });
    // Record the actual component/composer/adapter submission. A returned refusal gives Native a terminal error
    // result without throwing into the async composer callback, appending a transcript, or doing provider work.
    if (name === "vivary-code-send") return { projectId: null, run: null, error: "Synthetic recorded-send refusal" };
    if (refuse && name === "vivary-code-switch") throw Object.assign(new Error(refuse), { errorCode: "vivary_code_switch_run_stopping" });
    if (name === "vivary-code-switch") {
      // The action may return another window's newer route. Parent polling deliberately still supplies the old run.
      repliedRun = switchReply ? { ...run, switchGeneration: "fixture-accepted-switch", ...switchReply }
        : params.stop && isCodeAgentRunActive(run) ? { ...run, pendingSwitch: { engine: params.engine, model: params.model } }
        : { ...run, engine: params.engine, engineLabel: params.engine === "codex-cli" ? "Codex" : "Claude Code",
          model: params.model, switchGeneration: "fixture-accepted-switch" };
      return { projectId: null, run: fixtureRunSnapshot(repliedRun) };
    }
    return { projectId: null, run: fixtureRunSnapshot(run) };
  };
  const opened = [];
  let currentFolderRuns = folderRuns;
  const folderIsolation = { ...FOLDER_ISOLATION, available: folderPicker, async openFolder() { opened.push("open-folder"); } };
  const element = () => <QueryClientProvider client={client}><MemoryRouter><LocalCodeConversation state={state}
    selection={retained ? { key: "retained-run", runId: "retained-run" } : { key: "new-draft", runId: null }}
    ownerKey="fixture-owner" projectId={null} workspaceAvailable
    previewScope="fixture" viewingMatch={viewingMatch} notices={null} folderRuns={currentFolderRuns} folderIsolation={folderIsolation}
    onOpenRun={target => opened.push(target.id)} pendingApprovals={0}
    active={!!run && isCodeAgentRunActive(run)} streaming={false} stopping={run?.phase === "stopping"} run={run ? ownerSnapshot ?? fixtureRunSnapshot(run) : null}
    onChoice={choice => choices.push(choice)} onStarted={() => {}} onStreaming={() => {}} onSettled={() => { settled += 1; }}
    onStop={async () => false} onSettings={() => {}} /></MemoryRouter></QueryClientProvider>;
  const view = await mount(element());
  const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
  await settle();
  const picker = () => view.host.querySelector(PICKER);
  const routeLabels = { "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5",
    "gpt-fixture": "GPT Fixture", "gpt-other": "GPT Other" };
  const readRoute = () => {
    const engine = picker()?.querySelector(".local-agent-model-runtime")?.textContent === "Codex" ? "codex-cli" : "claude-cli";
    const label = picker()?.querySelector(".local-agent-model-name")?.textContent;
    return { engine, model: Object.keys(routeLabels).find(model => routeLabels[model] === label) ?? label?.replace(" (saved, unavailable)", "") };
  };
  const key = (target, name) => act(async () => {
    target.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: name }));
  });
  // Radix renders the open menu in a portal on the document body. Enter on the trigger toggles it, as a keyboard does.
  const menu = () => document.body.querySelector(".local-agent-model-menu");
  const groups = () => [...(menu()?.querySelectorAll('[role="group"][aria-labelledby]') ?? [])].map(group => ({
    heading: document.getElementById(group.getAttribute("aria-labelledby"))?.textContent ?? "",
    items: [...group.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')] }));
  async function withMenu(read) {
    await key(picker(), "Enter"); await settle();
    if (!menu()) throw new Error("The runtime and model menu did not open");
    try { return await read(); } finally { if (menu()) { await key(picker(), "Enter"); await settle(); } }
  }
  const item = (heading, label) => groups().find(group => group.heading.startsWith(heading))?.items
    .find(entry => entry.querySelector(".local-agent-model-item-label")?.textContent === label);
  const panel = () => view.host.querySelector('[aria-label="Switch runtime or model"]');
  const shared = () => view.host.querySelector('[aria-label="Shared folder"]');
  const sendButton = () => view.host.querySelector('[data-agent-composer-slot="send-button"]');
  return {
    calls, choices, opened, get settled() { return settled; },
    text: () => view.host.textContent,
    warning: () => shared()?.querySelector("p")?.textContent ?? null,
    sharedButtons: () => [...(shared()?.querySelectorAll("button") ?? [])].map(button => button.textContent),
    sharedRuns: () => [...(shared()?.querySelectorAll("li") ?? [])].map(item => item.textContent),
    command: () => shared()?.querySelector("code")?.textContent ?? null,
    composerText: () => view.host.querySelector(".ProseMirror")?.textContent ?? null,
    async escape() {
      await act(async () => { shared().dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }),
        { key: "Escape" })); });
      await settle();
    },
    async setFolderRuns(next) {
      currentFolderRuns = next;
      await act(async () => { view.root.render(element()); });
      await settle();
    },
    composerLocked: () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Try a file change")?.disabled,
    panel: () => panel()?.textContent ?? null,
    panelMessage: () => panel()?.querySelector("span")?.textContent ?? null,
    buttons: () => [...(panel()?.querySelectorAll("button") ?? [])].map(button => button.textContent),
    disabled: () => picker()?.disabled,
    describedBy: () => picker()?.getAttribute("aria-describedby") ?? null,
    pickerLabel: () => picker()?.getAttribute("aria-label") ?? null,
    // Each runtime heading with its items: label, whether Radix can reach it, and whether it is disabled or checked.
    groups: () => withMenu(() => groups().map(group => ({ heading: group.heading, items: group.items.map(entry => ({
      label: entry.querySelector(".local-agent-model-item-label")?.textContent ?? entry.textContent.trim(),
      reachable: entry.hasAttribute("data-radix-collection-item"),
      disabled: entry.hasAttribute("data-disabled"), checked: entry.getAttribute("aria-checked") === "true" })) }))),
    options: heading => withMenu(() => groups().find(group => group.heading.startsWith(heading))?.items
      .map(entry => entry.querySelector(".local-agent-model-item-label")?.textContent ?? null) ?? []),
    route: readRoute,
    draft: () => view.host.querySelector(".ProseMirror")?.textContent ?? null,
    sendDisabled: () => sendButton()?.disabled ?? null,
    canPrefill: () => [...view.host.querySelectorAll("button")].some(button => button.textContent === "Try a file change" && !button.disabled),
    async prefill() {
      const example = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Try a file change");
      if (!example || example.disabled) throw new Error("native runtime did not enable the composer");
      await act(async () => { example.dispatchEvent(new window.Event("click", { bubbles: true })); });
      await settle();
    },
    async send() {
      const button = sendButton();
      if (!button || button.disabled) throw new Error("No enabled native Send button");
      const before = settled;
      await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
      await act(async () => {
        for (let i = 0; i < 100 && settled === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
      });
      if (settled === before || !calls.some(call => call.name === "vivary-code-send")) {
        throw new Error("enabled native Send did not reach and settle the real Code adapter within one second");
      }
    },
    // Opens the menu from the keyboard and chooses a model with Enter (keyboard) or a click.
    async choose(heading, label, { keyboard = false } = {}) {
      // Earlier route-consent cases name their intent by field. Exercise that intent through the real grouped menu.
      if (heading === "Conversation runtime") {
        heading = label === "codex-cli" ? "Codex" : "Claude Code";
        label = heading === "Codex" ? "GPT Fixture" : "Sonnet 5.5";
      } else if (heading === "Conversation model") {
        heading = readRoute().engine === "codex-cli" ? "Codex" : "Claude Code";
        label = routeLabels[label] ?? label;
      }
      await key(picker(), "Enter"); await settle();
      const entry = item(heading, label);
      if (!entry) throw new Error("No " + heading + " item " + label);
      if (keyboard) await key(entry, "Enter");
      else await act(async () => { entry.dispatchEvent(new window.Event("click", { bubbles: true })); });
      await settle();
    },
    menuOpen: () => Boolean(menu()),
    async open() { await key(picker(), "Enter"); await settle(); },
    async escapeMenu() { await key(menu(), "Escape"); await settle(); },
    async click(name) {
      const button = [...view.host.querySelectorAll("button")].find(item => item.textContent.trim() === name);
      if (!button) throw new Error("No button named " + name);
      await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
      await settle();
    },
    async update(patch) {
      run = { ...run, ...patch };
      ownerSnapshot = null;
      await act(async () => { view.root.render(element()); });
      await settle();
    },
    async ownerPoll(patch) {
      run = { ...run, ...patch };
      repliedRun = run;
      const queryKey = ["action", "vivary-code-state", { projectId: undefined }];
      await act(async () => {
        client.setQueryData(queryKey, { projectId: null, run: fixtureRunSnapshot(run) });
        ownerSnapshot = client.getQueryData(queryKey).run;
        view.root.render(element());
      });
      await settle();
    },
    holdOwnerRead() {
      const queryKey = ["action", "vivary-code-state", { projectId: undefined }];
      const stale = { projectId: null, run: fixtureRunSnapshot(run) };
      let release;
      const result = client.fetchQuery({ queryKey, queryFn: () => new Promise(resolve => { release = resolve; }) })
        .then(() => "resolved", error => { if (!isCancelledError(error)) throw error; return "cancelled"; });
      return async () => {
        release(stale);
        const outcome = await result;
        await settle();
        return { outcome, model: client.getQueryData(queryKey)?.run?.model ?? null };
      };
    },
    async unmount() {
      try { await view.unmount(); } finally {
        client.clear(); delete globalThis.codeActionFixture;
        if (recordSend) globalThis.fetch = originalFetch;
      }
    },
  };
}

// Exercise replay through the actual owner/router without a loading unmount discarding pending consent for us.
export async function renderReplayOwner({ running = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const version = "2.1.300";
  const claude = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version }, modelCatalog: null,
    models: claudeCodeModelChoices(version).map(model => model.id), claudeModels: claudeCodeModelChoices(version) };
  const codex = { engine: "codex-cli", label: "Codex", configured: true,
    runtime: { status: "ready", message: "Signed in" }, models: ["gpt-fixture"], claudeModels: null,
    modelCatalog: { status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }],
      defaultModel: "gpt-fixture", connections: [], message: "" } };
  let run = { id: "retained-run", title: "Retained conversation", projectId: null, engine: "claude-cli",
    engineLabel: "Claude Code", model: "claude-sonnet-5-5", status: running ? "running" : "completed",
    phase: running ? "running" : "complete", pendingSwitch: null, turnId: "replay-turn-a", switchGeneration: null, pendingApprovals: [],
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:01:00.000Z", events: [
      { id: "replay-turn-a", runId: "retained-run", kind: "user", message: "Keep working on turn A.",
        createdAt: "2026-10-20T00:00:00.000Z", metadata: { seq: 0 } },
      { id: "replay-answer-a", runId: "retained-run", kind: "system", message: "Turn A has visible output.",
        createdAt: "2026-10-20T00:00:01.000Z", metadata: { seq: 1, role: "assistant", source: "claude-cli" } },
    ] };
  const other = { ...run, id: "other-active-run", title: "Another conversation", status: "running", phase: "running",
    turnId: "other-turn", events: [] };
  const snapshot = () => ({ projectId: null, engines: [claude, codex], defaultEngine: "claude-cli",
    defaultModel: "claude-sonnet-5-5", runtime: claude.runtime, workspaceLabel: "Personal workspace",
    busy: run.status === "running", cleanup: null, pendingApproval: null, folderRuns: [],
    activeRuns: [...(run.status === "running" ? [run] : []), other], run, runs: [run, other] });
  const key = ["action", "vivary-code-state", { projectId: undefined }];
  const anchorKey = ["action", "vivary-code-state", { projectId: undefined, runId: run.id,
    eventId: "replay-turn-a", eventOffset: 0 }];
  const calls = [];
  const originalAction = globalThis.codeActionFixture, originalFetch = globalThis.fetch;
  globalThis.codeActionFixture = async (name, params) => {
    if (name !== "vivary-code-switch" && name !== "vivary-code-stop") throw new Error("No Code action expected: " + name);
    calls.push({ name, params });
    if (params.runId !== run.id || params.projectId != null) throw new Error("Wrong conversation selected");
    if (name === "vivary-code-stop" || params.stop) run = { ...run, status: "paused", phase: "paused",
      pendingSwitch: name === "vivary-code-switch" ? { engine: params.engine, model: params.model } : null };
    else run = { ...run, engine: params.engine, model: params.model, pendingSwitch: null };
    return snapshot();
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    if (url.pathname.endsWith("/vivary-code-state")) return Response.json(snapshot());
    return originalFetch(input, init);
  };
  client.setQueryData(key, snapshot());
  client.setQueryData(anchorKey, snapshot());
  let location = "", choice = null, setAvailable;
  function Owner() {
    const [selection, setSelection] = useState({ key: run.id, runId: run.id });
    const [available, changeAvailable] = useState(true);
    const navigate = useNavigate();
    location = useLocation().search; choice = selection.choice ?? null; setAvailable = changeAvailable;
    return <><button type="button" onClick={() => navigate("/?run=retained-run&event=replay-turn-a&eventOffset=0")}>Open history replay</button>
      <ProjectCodeWorkspace projectId={null} draftScopeKey="fixture" ownerKey="fixture-owner" previewScope="fixture"
        workspaceAvailable={available} selection={selection} setSelection={setSelection} onOpenActive={async () => false} /></>;
  }
  const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)); });
  let view;
  const dispose = async () => {
    try { await view?.unmount(); } finally {
      client.clear(); globalThis.fetch = originalFetch;
      if (originalAction === undefined) delete globalThis.codeActionFixture;
      else globalThis.codeActionFixture = originalAction;
    }
  };
  try {
    view = await mount(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/?run=retained-run"]}>
      <Owner /></MemoryRouter></QueryClientProvider>);
    await settle();
    const available = button => !!button && view.host.contains(button) && !button.disabled
      && !button.closest('[hidden], [inert], [aria-hidden="true"]');
    const control = label => view.host.querySelector('[aria-label="' + label + '"]');
    const click = async button => {
      if (!available(button)) throw new Error("No enabled fixture control");
      await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
      await settle();
    };
    return { calls, location: () => location, rememberedChoice: () => choice,
      authoritative: () => ({ engine: run.engine, model: run.model, status: run.status, phase: run.phase,
        pendingSwitch: run.pendingSwitch, otherStatus: other.status }),
      panel: () => control("Switch runtime or model")?.textContent ?? null,
      selectorsDisabled: () => view.host.querySelector(PICKER)?.disabled,
      async choose() {
        const trigger = view.host.querySelector(PICKER);
        if (!available(trigger)) throw new Error("No enabled runtime picker");
        await act(async () => trigger.dispatchEvent(Object.assign(
          new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" })));
        await settle();
        const target = [...document.body.querySelectorAll('.local-agent-model-menu [role="menuitemradio"]')]
          .find(item => item.querySelector('.local-agent-model-item-label')?.textContent === "GPT Fixture");
        if (!target) throw new Error("No Codex model in the current picker");
        await act(async () => target.dispatchEvent(new window.Event("click", { bubbles: true })));
        await settle();
      },
      async click(name) { await click([...view.host.querySelectorAll("button")].find(button => button.textContent.trim() === name)); },
      async clickReplayActions() {
        for (const button of [...view.host.querySelectorAll("button")]) {
          if (available(button) && (["Switch", "Stop and switch"].includes(button.textContent.trim())
            || button.getAttribute("aria-label") === "Stop response")) await click(button);
        }
      },
      async setWorkspaceAvailable(value) { await act(async () => { setAvailable(value); }); await settle(); },
      async stop() { await click(control("Stop response")); },
      stopAvailable: () => available(control("Stop response")),
      ownerActiveIds: () => client.getQueryData(key)?.activeRuns.map(item => item.id),
      unmount: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

// PR #260: mount the actual parent and retained-run composer. Only the API route destination is
// a placeholder, matching Workspace's unmount of CodeConversation when runtime=native is selected.
export async function startWorkbenchConversation({ control, workspaceKind = "personal", projectId = "project-personal",
  outcome = "success", repeatControls = false, transition, retry = false, identityReady = true,
  withHistory = false, secondControl, initialRoute = "/?run=retained-run", resolveHistoryIdentity = false }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const ownerKey = "kind-fixture-owner";
  const selectionKey = "vivary-code-selection-v1:" + ownerKey + ":" + (projectId ?? "personal");
  const selection = { key: "retained-run", runId: "retained-run" };
  const model = "claude-sonnet-5-5";
  const engine = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version: "2.1.296" }, modelCatalog: null,
    models: claudeCodeModelChoices("2.1.296").map(model => model.id), claudeModels: claudeCodeModelChoices("2.1.296") };
  const run = { id: "retained-run", title: "Retained Code conversation", engine: engine.engine,
    engineLabel: engine.label, model, events: [], status: "completed", draftThreadId: null };
  const state = { projectId, engines: [engine], defaultEngine: engine.engine, defaultModel: model,
    busy: false, activeRun: null, pendingApproval: null, cleanup: null, runs: [run], run };
  client.setQueryData([selectionKey], selection);
  client.setQueryData(["action", "vivary-code-state", { projectId: projectId ?? undefined }], state);
  client.setQueryData(["action", "vivary-code-state", { projectId: projectId ?? undefined, runId: run.id }], state);
  const draftChanges = [], initialized = [], writes = [];
  const originalFixture = globalThis.codeWorkspaceFixture;
  const resolvedIdentity = { kind: "project", projectId, storageKey: "kind-fixture-native",
    scope: { type: "workspace-app", id: "kind-fixture-project-scope" } };
  const activeThreadKey = "agent-chat-active-thread:kind-fixture-native:scope:workspace-app:kind-fixture-project-scope";
  const activeThreadWrites = [], unexpectedFetches = [];
  const originalSetItem = localStorage.setItem;
  const originalActiveThread = localStorage.getItem(activeThreadKey);
  const originalSeen = localStorage.getItem(activeThreadKey + ":seen");
  let finishInitialization;
  const initialization = new Promise(resolve => { finishInitialization = resolve; });
  globalThis.codeWorkspaceFixture = {
    projects: { activeProject: projectId ? { projectId, displayName: "Kind fixture", workspaceKind } : null,
      catalog: { scopeKey: ownerKey }, checking: false, workspaceAvailable: true, historyAvailable: true,
      refresh: async () => {}, selectProject: async () => true },
    identity: resolvedIdentity,
    writeAppState: async (key, value) => { writes.push({ key, value }); return value; },
    call: async (name, input) => {
      if (name === "vivary-chat-draft") {
        draftChanges.push(input);
        await initialization;
        if (draftChanges.length === 1) {
          if (outcome === "reject") throw new Error("Fixture draft write failed");
          if (outcome === "unchanged") return { changed: false, record: { ...input.next } };
          if (outcome === "not-cleared") return { changed: true, record: { ...input.next, status: "draft" } };
        }
        initialized.push(input);
        return { changed: true, record: { ...input.next } };
      }
      if (name === "vivary-linked-history") return input.operation === "source" ? { available: false } : null;
      if (name === "vivary-handoff-freshness") return { status: "none", path: "STATE.md" };
      throw new Error("Unexpected parent fixture action: " + name);
    },
  };
  if (!identityReady) globalThis.codeWorkspaceFixture.identity = null;
  // Native's real createThread is optimistic. Its history read is inert; the existing draft action,
  // rather than a POST that would invent an empty thread row, must acknowledge the new ID.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET" && url.pathname.endsWith("/agent-chat/threads") && (!withHistory
      || (url.searchParams.get("scopeType") === resolvedIdentity.scope.type
        && url.searchParams.get("scopeId") === resolvedIdentity.scope.id))) {
      return Response.json({ threads: [] });
    }
    // Ancillary controls use installChatServer's 404 absence boundary for these observed probes.
    // The context PUT also returns 404, so the fixture acknowledges no ancillary persistence.
    if (withHistory && [
      "GET /_agent-native/mcp/servers",
      "GET /_agent-native/application-state/pending-selection-context",
      "GET /_agent-native/voice-providers/status",
      "GET /_agent-native/application-state?keys=agent-chat-context,voice-input-preference,guided-questions",
      "GET /_agent-native/application-state?keys=voice-input-preference",
      "GET /_agent-native/application-state?keys=voice-input-preference,agent-chat-context",
      "PUT /_agent-native/application-state/agent-chat-context",
    ].includes(method + " " + url.pathname + url.search)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (withHistory) {
      const request = method + " " + url.pathname + url.search;
      unexpectedFetches.push(request);
      throw new Error("Unexpected history fixture fetch: " + request);
    }
    return originalFetch(input, init);
  };
  let route, navigateRoute, routerMounts = 0;
  function Route() {
    const location = useLocation();
    navigateRoute = useNavigate();
    route = location.pathname + location.search;
    useEffect(() => { routerMounts++; }, []);
    return <>
      {withHistory && <aside data-testid="project-history"><ProjectHistory /></aside>}
      {new URLSearchParams(location.search).get("runtime") === "native"
        ? <div data-testid="api-route" /> : <CodeConversation previewScope="kind-fixture" />}
    </>;
  }
  const render = () => <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[initialRoute]}><Route /></MemoryRouter>
  </QueryClientProvider>;
  let view;
  try {
    // Forward every write, including repeat persistence of the same ID by Core's effect.
    // Distinct allocations are checked from these raw observations in the tests.
    if (withHistory) localStorage.setItem = function (key, value) {
      if (key === activeThreadKey) activeThreadWrites.push(String(value));
      return originalSetItem.call(this, key, value);
    };
    view = await mount(render());
    const before = { route, title: view.host.querySelector(".local-agent-heading h2")?.textContent ?? null,
      keptRoute: !!view.host.querySelector(".local-agent-route-note") };
    const controlButton = name => view.host.querySelector(name === "sidebar"
      ? '[data-testid="project-history"] .an-chat-history-rail__new-chat'
      : name === "header" ? '.local-agent-header button[aria-label="New conversation"]' : ".local-agent-route-note button");
    const controlState = name => {
      const button = controlButton(name);
      const disabledProperty = button?.disabled === true;
      const disabledAttribute = button?.hasAttribute("disabled") ?? false;
      const ariaDisabled = button?.getAttribute("aria-disabled") ?? null;
      return { present: !!button, tag: button?.tagName ?? null, disabledProperty, disabledAttribute, ariaDisabled,
        unavailable: !button || disabledProperty || disabledAttribute || ariaDisabled === "true" };
    };
    const click = name => {
      const button = controlButton(name);
      if (!button || button.disabled) throw new Error(name + " New conversation control is missing or disabled");
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    };
    const reading = () => ({ route, routerMounts,
      selectionKey: client.getQueryData([selectionKey])?.key ?? null,
      selectionRunId: client.getQueryData([selectionKey])?.runId ?? null,
      selectionWrites: writes.filter(write => write.key === selectionKey).length,
      draftChanges: draftChanges.slice(), initialized: initialized.length,
      activeThreadWrites: activeThreadWrites.slice() });
    const controlsDisabled = ["header", "kept-route"].map(name => controlButton(name)?.disabled ?? null);
    let identityPending, firstPending, otherControl, resolvedControl;
    if (identityReady) await act(async () => {
      click(control);
      if (repeatControls) { click("header"); click("kept-route"); }
    });
    if (secondControl) {
      await until(() => draftChanges.length > 0, "the first owner's cleared-draft acknowledgement");
      firstPending = reading();
      otherControl = controlState(secondControl);
      if (!otherControl.unavailable) await act(async () => { click(secondControl); });
      await act(async () => { await sleep(0); });
    }
    if (withHistory && !identityReady) {
      const fallback = controlState("sidebar");
      const fallbackRendered = !!view.host.querySelector('[aria-label="Code conversations"]');
      // Do not dispatch to an unavailable control. An enabled old fallback may navigate,
      // and that route and any real Code selection writes are captured before recovery.
      const clicked = !fallback.unavailable;
      if (clicked) await act(async () => { click("sidebar"); });
      await act(async () => { await sleep(0); });
      identityPending = { ...reading(), fallback, fallbackRendered, clicked };
      if (resolveHistoryIdentity) {
        // Restore the requested surface only for the independent positive control if the
        // old fallback left it. Keep the same mounted router and retain the failure snapshot.
        if (route !== initialRoute) await act(async () => { navigateRoute(initialRoute); });
        globalThis.codeWorkspaceFixture.identity = resolvedIdentity;
        await act(async () => { view.root.render(render()); });
        await until(() => !!view.host.querySelector('[aria-label="Project conversations"]'), "resolved SessionHistory");
        resolvedControl = { ...controlState("sidebar"), routerMounts };
        await act(async () => { click("sidebar"); });
        await until(() => draftChanges.length > 0, "resolved history's cleared-draft acknowledgement");
      }
    }
    const ownerPending = reading();
    const pendingRoute = route;
    const initializedBeforeAck = initialized.length;
    if (transition === "route") await act(async () => { navigateRoute("/?run=new&draft=owner-chosen"); });
    if (transition === "project") {
      const fixture = globalThis.codeWorkspaceFixture;
      fixture.projects = { ...fixture.projects, activeProject: { projectId: "other-project", displayName: "Other project", workspaceKind: "personal" } };
      fixture.identity = { ...fixture.identity, projectId: "other-project", storageKey: "other-project-native",
        scope: { type: "workspace-app", id: "other-project-scope" } };
      const otherRun = { ...run, id: "other-run" };
      const otherState = { ...state, projectId: "other-project", run: otherRun, runs: [otherRun] };
      client.setQueryData(["vivary-code-selection-v1:" + ownerKey + ":other-project"], { key: "other-run", runId: "other-run" });
      client.setQueryData(["action", "vivary-code-state", { projectId: "other-project" }], otherState);
      client.setQueryData(["action", "vivary-code-state", { projectId: "other-project", runId: "other-run" }], otherState);
      await act(async () => { navigateRoute("/?run=other-run"); view.root.render(render()); });
    }
    if (transition === "unmount") { await view.unmount(); view = null; }
    const departedRoute = route;
    await act(async () => { finishInitialization(); });
    const afterInitialization = { route, saveFailure: !!view?.host.textContent.includes("The conversation could not be saved. Try again.") };
    if (retry) await act(async () => { click(control === "header" ? "kept-route" : "header"); });
    return { before, controlsDisabled, pendingRoute, initializedBeforeAck, departedRoute, afterInitialization, route, draftChanges, initialized,
      identityPending, firstPending, otherControl, resolvedControl, ownerPending, routerMounts,
      activeThreadWrites: activeThreadWrites.slice(), unexpectedFetches: unexpectedFetches.slice(),
      nativeActiveThread: localStorage.getItem("agent-chat-active-thread:kind-fixture-native:scope:workspace-app:kind-fixture-project-scope"),
      codeSelection: client.getQueryData([selectionKey]), codeSelectionWrites: writes.filter(write => write.key === selectionKey) };
  } finally {
    finishInitialization();
    try {
      if (view) await view.unmount();
    } finally {
      try { client.clear(); } finally {
        globalThis.fetch = originalFetch;
        if (withHistory) {
          localStorage.setItem = originalSetItem;
          for (const [key, value] of [[activeThreadKey, originalActiveThread], [activeThreadKey + ":seen", originalSeen]]) {
            if (value === null) localStorage.removeItem(key);
            else originalSetItem.call(localStorage, key, value);
          }
        }
        if (originalFixture === undefined) delete globalThis.codeWorkspaceFixture;
        else globalThis.codeWorkspaceFixture = originalFixture;
      }
    }
  }
}

async function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, root, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
}

// Issue #131. A sidebar row menu opened from the keyboard, with the Toolkit's Rename and Pin and Vivary's Archive,
// which Vivary adds through renderAdditionalRowActions. Radix's arrow keys, typeahead, and Enter reach only entries
// registered as Radix menu items, which carry data-radix-collection-item.
// Session details for one run, open, while its route changes as a switch changes it.
export async function renderSessionDetails() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let route = { engine: "claude-cli", model: "claude-sonnet-5-5", label: "Claude Code", sessionId: "claude-session-before" };
  const reads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    if (!url.pathname.endsWith("/vivary-code-state")) return originalFetch(input);
    reads.push(route.engine);
    return Response.json({ runId: "retained-run", engineLabel: route.label, continuity: "not-recorded", sessionId: route.sessionId,
      nextTurn: "reconstruct", log: { reference: "native:retained-run", status: "available", excerpt: "", truncated: false },
      providerLog: { reference: null, status: "unavailable", excerpt: "", truncated: false } });
  };
  const element = () => <QueryClientProvider client={client}><CodeSessionDetails runId="retained-run" projectId={null}
    engine={route.engine} model={route.model} active={false} /></QueryClientProvider>;
  const view = await mount(element());
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 5)); });
  const panel = () => view.host.querySelector('[aria-label="Session details"]')?.textContent ?? null;
  const trigger = [...view.host.querySelectorAll("button")].find(item => item.textContent.trim() === "Session details");
  await act(async () => { trigger.dispatchEvent(new window.Event("click", { bubbles: true })); });
  await settle();
  return {
    reads, panel,
    async switchTo(next) {
      route = next;
      await act(async () => { view.root.render(element()); });
      await settle();
    },
    async unmount() { await view.unmount(); client.clear(); globalThis.fetch = originalFetch; },
  };
}

// Mount the real query owner, not just CodeSessionDetails. Only its normal code-state cache entry is updated.
export async function renderWorkspaceSessionDetails(events) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const queryKey = ["action", "vivary-code-state", { projectId: undefined }];
  const version = "2.1.300";
  const engine = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version }, modelCatalog: null,
    models: claudeCodeModelChoices(version).map(model => model.id), claudeModels: claudeCodeModelChoices(version) };
  const codex = { engine: "codex-cli", label: "Codex", configured: true, runtime: { status: "ready", message: "Signed in" },
    models: ["gpt-fixture"], claudeModels: null,
    modelCatalog: { status: "ready", models: [{ id: "gpt-fixture", label: "GPT Fixture" }], defaultModel: "gpt-fixture",
      connections: [], message: "" } };
  let run = { id: "retained-run", title: "Retained conversation", projectId: null, engine: "claude-cli",
    engineLabel: "Claude Code", model: "claude-sonnet-5-5", status: "completed", phase: "complete", pendingSwitch: null,
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:01:00.000Z", events };
  const snapshot = () => ({ projectId: null, engines: [engine, codex], defaultEngine: "claude-cli", defaultModel: "claude-sonnet-5-5",
    runtime: engine.runtime, activeRuns: [], folderRuns: [], busy: false, cleanup: null,
    run: fixtureRunSnapshot(run), runs: [run] });
  let details = { runId: run.id, engineLabel: "Claude Code", continuity: "native-resume", sessionId: "obsolete-claude-session",
    nextTurn: "native-resume", log: { reference: "native:retained-run", status: "available", excerpt: "", truncated: false },
    providerLog: { reference: null, status: "unavailable", excerpt: "", truncated: false } };
  const reads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    if (!url.pathname.endsWith("/vivary-code-state")) return originalFetch(input, init);
    if (url.searchParams.get("details") === "true") {
      reads.push({ sessionId: details.sessionId, nextTurn: details.nextTurn });
      return Response.json(details);
    }
    return Response.json(snapshot());
  };
  client.setQueryData(queryKey, snapshot());
  function Owner() {
    const [selection, setSelection] = useState({ key: "retained-run", runId: "retained-run" });
    return <ProjectCodeWorkspace projectId={null} draftScopeKey="fixture" ownerKey="fixture-owner"
      workspaceAvailable selection={selection} setSelection={setSelection} onOpenActive={async () => false} previewScope="fixture" />;
  }
  const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)); });
  let view;
  const dispose = async () => {
    try { await view?.unmount(); } finally { client.clear(); globalThis.fetch = originalFetch; }
  };
  try {
    view = await mount(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/?run=retained-run"]}>
      <Owner /></MemoryRouter></QueryClientProvider>);
    await settle();
    const trigger = [...view.host.querySelectorAll("button")].find(button => button.textContent.trim() === "Session details");
    if (!trigger) throw new Error("the real ProjectCodeWorkspace owner did not render Session details");
    await act(async () => { trigger.dispatchEvent(new window.Event("click", { bubbles: true })); });
    await settle();
    return {
      reads,
      panel: () => view.host.querySelector('[aria-label="Session details"]')?.textContent ?? null,
      async poll(patch, detailsPatch = {}) {
        run = { ...run, ...patch };
        details = { ...details, ...detailsPatch };
        // No details invalidation, child props override, or manual refetch. This is the owner's real polling input.
        await act(async () => { client.setQueryData(queryKey, snapshot()); });
        await settle();
      },
      unmount: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

export async function renderRowMenu() {
  const { ChatHistoryList, ChatHistoryMenuItem } = chatHistory;
  const archive = ChatHistoryMenuItem
    ? (_item, closeMenu) => <ChatHistoryMenuItem onSelect={closeMenu}><span>Archive</span></ChatHistoryMenuItem>
    : (_item, closeMenu) => <button type="button" role="menuitem" className="an-chat-history-row__menu-item"
      onClick={closeMenu}><span>Archive</span></button>;
  const view = await mount(<ChatHistoryList variant="rail" items={[{ id: "thread-1", title: "Tide pools" }]}
    onSelect={() => {}} onRename={() => {}} onTogglePin={() => {}} renderAdditionalRowActions={archive} />);
  const trigger = view.host.querySelector(".an-chat-history-row__menu-trigger");
  await act(async () => {
    trigger.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
  });
  const entries = [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')].map(entry =>
    ({ name: entry.textContent, reachable: entry.hasAttribute("data-radix-collection-item") }));
  await view.unmount();
  return entries;
}

// The run's terminal error event goes through the client's own event handling, and the card
// renders the metadata that handling stores on the message.
export async function renderRunError(event) {
  const outcome = processEvent(event, [], { value: 0 }, "probe-tab");
  const info = getRunErrorMetadata({ metadata: outcome.result?.metadata });
  if (!info) return { action: outcome.action };
  let retries = 0;
  const view = await mount(<RunErrorRecoveryCard info={info} onContinue={() => {}} onRetry={() => { retries += 1; }}
    onDismiss={() => {}} />);
  const retry = view.host.querySelector('button[aria-label="Retry"]');
  if (retry) await act(async () => { retry.dispatchEvent(new window.Event("click", { bubbles: true })); });
  const snapshot = { action: outcome.action, text: view.host.textContent, retry: Boolean(retry), retries };
  await view.unmount();
  return snapshot;
}

// Two clicks land before the chat re-renders, and a third after it. The chat's retry swaps the live
// error for the same error read back from the message, a new object with the same key, and the
// control stays mounted until the next render. One retry turn must be queued. A different error gets
// a fresh Retry.
async function retryTwiceThenAgain(info, control) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let retries = 0;
  let shown = info;
  const render = () => root.render(control.render(shown, () => { retries += 1; shown = { ...shown }; render(); }));
  const click = () => control.retry(host).dispatchEvent(new window.Event("click", { bubbles: true }));
  await act(async () => { render(); });
  if (control.open) await act(async () => { control.open(host).dispatchEvent(new window.Event("click", { bubbles: true })); });
  await act(async () => { click(); click(); });
  await act(async () => { click(); });
  const afterDoubleClick = retries;
  shown = { ...info, runId: "probe-next-run" };
  await act(async () => { render(); });
  await act(async () => { click(); });
  await act(async () => { root.unmount(); });
  host.remove();
  return { afterDoubleClick, afterNextError: retries };
}

export function retryCardTwiceThenAgain(event) {
  const info = getRunErrorMetadata({ metadata: processEvent(event, [], { value: 0 }, "probe-tab").result?.metadata });
  return retryTwiceThenAgain(info, {
    render: (shown, onRetry) => <RunErrorRecoveryCard info={shown} onContinue={() => {}} onRetry={onRetry} onDismiss={() => {}} />,
    retry: host => host.querySelector('button[aria-label="Retry"]'),
  });
}

export function retryInlineTwiceThenAgain(info) {
  return retryTwiceThenAgain(info, {
    render: (shown, onRetry) => <messages.InlineRunErrorNotice info={shown} onRetry={onRetry} />,
    open: host => host.querySelector("button[aria-expanded]"),
    retry: host => [...host.querySelectorAll("button")].find(button => button.textContent.trim() === "Retry"),
  });
}

// A saved reply's error after a reload, read from its metadata as the chat reads it, on the error card
// and by the inline notice's Retry rule for the last message.
export async function renderSavedRunError(message) {
  const info = getRunErrorMetadata(message);
  if (!info) return null;
  const view = await mount(<RunErrorRecoveryCard info={info} onContinue={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
  const snapshot = { errorCode: info.errorCode, recoverable: info.recoverable === true,
    cardRetry: Boolean(view.host.querySelector('button[aria-label="Retry"]')),
    inlineRetry: messages.shouldOfferInlineRunErrorRetry({ runError: info, isLast: true }) };
  await view.unmount();
  return snapshot;
}

// The inline notice under a failed message, with the Retry that the message's own rule allows.
export const shouldOfferInlineRunErrorRetry = messages.shouldOfferInlineRunErrorRetry;
export async function renderInlineNotice(info, isLast) {
  let retries = 0;
  const offered = typeof shouldOfferInlineRunErrorRetry === "function" && shouldOfferInlineRunErrorRetry({ runError: info, isLast });
  const view = await mount(<messages.InlineRunErrorNotice info={info} onRetry={offered ? () => { retries += 1; } : undefined} />);
  const toggle = view.host.querySelector("button[aria-expanded]");
  await act(async () => { toggle.dispatchEvent(new window.Event("click", { bubbles: true })); });
  const retry = [...view.host.querySelectorAll("button")].find(button => button.textContent.trim() === "Retry");
  if (retry) await act(async () => { retry.dispatchEvent(new window.Event("click", { bubbles: true })); });
  const snapshot = { text: view.host.textContent, retry: Boolean(retry), retries };
  await view.unmount();
  return snapshot;
}

// The name a screen reader announces for a control, in the order the accessible name computation
// reads it for a button: labelledby, aria-label, content, then title.
function accessibleName(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) return labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  return (element.getAttribute("aria-label") ?? "").trim() || element.textContent.trim() || (element.getAttribute("title") ?? "").trim();
}

const idleModel = { async *run() {} };
function Composer({ willQueue }) {
  const runtime = useLocalRuntime(idleModel);
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider>
    <TiptapComposer willQueue={willQueue} plusMenuMode="hidden" voiceEnabled={false} includeDefaultSlashSkills={false} />
  </TooltipProvider></AssistantRuntimeProvider>;
}

export async function renderComposer(willQueue) {
  const view = await mount(<Composer willQueue={willQueue} />);
  const button = view.host.querySelector('[data-agent-composer-slot="send-button"]');
  const snapshot = { editor: Boolean(view.host.querySelector(".ProseMirror")), sendName: button ? accessibleName(button) : null };
  await view.unmount();
  return snapshot;
}

// Issue #147. The host hands the composer new text, as Vivary's draft owner does when a send is refused and the text
// comes back. linkedom tracks no focus, so the proof records focus() calls and serves them as document.activeElement.
function Restoring({ text, focusRef }) {
  const runtime = useLocalRuntime(idleModel);
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider>
    <TiptapComposer initialText={text} initialTextKey={text} focusRef={focusRef} plusMenuMode="hidden" voiceEnabled={false}
      includeDefaultSlashSkills={false} />
  </TooltipProvider></AssistantRuntimeProvider>;
}

// how: "initial text" hands text through props, "setText" and "focus" call the composer's imperative handle.
// "field before the frame" hands text while nothing has focus, then focuses the other field before the next frame.
export async function restoreComposerText(ownerTypingElsewhere, how = "initial text") {
  const originalFocus = window.HTMLElement.prototype.focus;
  let focused = document.body;
  window.HTMLElement.prototype.focus = function focus() { focused = this; };
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
  const field = document.createElement("input");
  document.body.appendChild(field);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const focusRef = createRef();
  try {
    await act(async () => { root.render(<Restoring text={undefined} focusRef={focusRef} />); });
    focused = ownerTypingElsewhere ? field : document.body;
    // The composer focuses on the next animation frame. The proof holds frames, so the owner can focus the other
    // field after the composer asked for focus and before the frame runs.
    const frames = [];
    const originalFrame = { global: globalThis.requestAnimationFrame, window: window.requestAnimationFrame };
    if (how === "field before the frame") {
      globalThis.requestAnimationFrame = window.requestAnimationFrame = callback => frames.push(callback);
    }
    await act(async () => {
      if (how === "initial text" || how === "field before the frame") {
        root.render(<Restoring text="One more question" focusRef={focusRef} />);
      }
      else if (how === "setText") focusRef.current.setText("One more question");
      else { focusRef.current.setText("One more question"); focused = ownerTypingElsewhere ? field : document.body; focusRef.current.focus(); }
    });
    if (how === "field before the frame") {
      globalThis.requestAnimationFrame = originalFrame.global;
      window.requestAnimationFrame = originalFrame.window;
      focused = field;
      await act(async () => { for (const frame of frames.splice(0)) frame(performance.now()); });
    }
    // Tiptap runs its focus command on the next animation frame.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    return { text: host.querySelector(".ProseMirror")?.textContent,
      focus: focused === field ? "other field" : focused.classList?.contains("ProseMirror") ? "composer" : "page" };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    field.remove();
    window.HTMLElement.prototype.focus = originalFocus;
    delete document.activeElement;
  }
}

// A thread loaded from its saved messages, with Core's own assistant message.
function SavedThread({ messages: initialMessages }) {
  const runtime = useLocalRuntime(idleModel, { initialMessages });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider>
    <ThreadPrimitive.Messages components={{ UserMessage: () => null, AssistantMessage: messages.AssistantMessage }} />
  </TooltipProvider></AssistantRuntimeProvider>;
}

export async function renderSavedThread(initialMessages) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(<QueryClientProvider client={client}><SavedThread messages={initialMessages} /></QueryClientProvider>);
  const snapshot = {
    text: view.host.textContent,
    notices: [...view.host.querySelectorAll('[data-testid="missing-final-response"]')].map(notice => notice.textContent.trim()),
  };
  await view.unmount();
  client.clear();
  return snapshot;
}

// Core's whole chat against the fake chat server in the test. Replies and notices are read in page order.
const CHAT_API = "http://chat.test/_agent-native/agent-chat";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    await act(async () => { await sleep(20); });
  }
}

async function mountChat(threadId, isNewThread) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const chat = createRef();
  const view = await mount(<QueryClientProvider client={client}><AssistantChat ref={chat} apiUrl={CHAT_API} threadId={threadId}
    tabId={"tab-" + threadId} isNewThread={isNewThread} showHeader={false} showModelSelector={false} providerStatusChecksEnabled={false} />
  </QueryClientProvider>);
  const reading = texts => {
    const notices = [...view.host.querySelectorAll('[data-testid="missing-final-response"]')].map(notice => notice.textContent.trim());
    return { notices, order: [...texts, ...new Set(notices)].map(text => [text, view.host.textContent.indexOf(text)])
      .filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1]).map(([text]) => text) };
  };
  const stop = async () => {
    const button = view.host.querySelector('[data-agent-composer-slot="stop-button"]');
    if (!button) throw new Error("no Stop button");
    await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
    await act(async () => { await sleep(300); });
  };
  const send = async text => { await act(async () => { chat.current.sendMessage(text); }); };
  const waitForText = text => until(() => view.host.textContent.includes(text), JSON.stringify(text));
  return { reading, stop, send, waitForText, host: view.host, async unmount() { await view.unmount(); client.clear(); } };
}

// The owner stops a reply that has text, then sends another message.
export async function stopThenSendAnother() {
  const chat = await mountChat("thread-live", true);
  await chat.send("First question");
  await chat.waitForText("Partial first answer");
  await chat.stop();
  const afterStop = chat.reading(["Partial first answer"]);
  await chat.send("Second question");
  await chat.waitForText("Finished second answer");
  await act(async () => { await sleep(300); });
  const afterNextTurn = chat.reading(["Partial first answer", "Finished second answer"]);
  await chat.unmount();
  return { afterStop, afterNextTurn };
}

// A reloaded chat follows a live run whose reply is not saved yet, and the owner stops it.
export async function stopWhileFollowingRun() {
  const chat = await mountChat("thread-follow", false);
  await chat.waitForText("Live partial answer");
  await chat.stop();
  const snapshot = chat.reading(["Finished old answer", "Live partial answer"]);
  await chat.unmount();
  return snapshot;
}

// A reload of a saved thread with no run in progress. The chat has loaded once the last of the texts shows.
// A reloaded chat whose last reply may hold only a saved error. The error card's Retry is reported with
// the texts and notices in page order.
export async function reloadThreadWithError(threadId, texts) {
  const chat = await mountChat(threadId, false);
  await chat.waitForText(texts.at(-1));
  await until(() => chat.host.querySelector('button[aria-label="Retry"]'), "the error card's Retry").catch(() => undefined);
  await act(async () => { await sleep(300); });
  const snapshot = { ...chat.reading(texts), cardRetry: Boolean(chat.host.querySelector('button[aria-label="Retry"]')) };
  await chat.unmount();
  return snapshot;
}

export async function reloadThread(threadId, texts) {
  const chat = await mountChat(threadId, false);
  await chat.waitForText(texts.at(-1));
  await act(async () => { await sleep(300); });
  const snapshot = chat.reading(texts);
  await chat.unmount();
  return snapshot;
}

// The real multi-tab component and thread hook load an old saved conversation.
// Only HTTP responses and the host draft adapter are inert test boundaries.
export async function inspectInitialSelection({ threadId, scope, explicit = true, transition }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigations = [];
  const draft = { isReady: () => true, ensureThread: async () => {}, resetKeyForThread: () => "ready",
    textForThread: () => "", hasDraftStateForThread: () => false, onChange() {} };
  function Surface({ selected, currentScope }) {
    const [route, setRoute] = useState(selected);
    return <MultiTabAssistantChat apiUrl={CHAT_API} scope={currentScope} isolateHistoryByScope
      storageKey={"selection-" + currentScope.id} restoreActiveThread={!explicit} hostComposerDraft={draft}
      showTabBar={false} showHeader={false} availableModels={[]} modelListLoading={false}
      providerStatusChecksEnabled={false} agentTeamPollMs={60000}
      threadUrlSync={explicit ? { routeThreadId: route, getPath: id => "/native?thread=" + encodeURIComponent(id ?? ""),
        navigate: next => { const url = new URL(next, window.location.href); window.location = url;
          navigations.push(url.searchParams.get("thread")); setRoute(url.searchParams.get("thread")); } } : false} />;
  }
  const render = (selected, currentScope) => <QueryClientProvider client={client}>
    <Surface key={currentScope.id} selected={selected} currentScope={currentScope} />
  </QueryClientProvider>;
  const initial = transition ?? { threadId, scope };
  window.location = new URL("http://127.0.0.1/native" + (explicit ? "?thread=" + initial.threadId : ""));
  if (!explicit) localStorage.setItem("agent-chat-active-thread:selection-" + scope.id + ":scope:" + scope.type + ":" + scope.id, threadId);
  const view = await mount(render(initial.threadId, initial.scope));
  try {
    await act(async () => { await sleep(300); });
    if (transition) {
      window.location = new URL("http://127.0.0.1/native?thread=" + threadId);
      await act(async () => { view.root.render(render(threadId, scope)); await sleep(300); });
      await act(async () => { await sleep(300); });
    }
    return { route: window.location.searchParams.get("thread"), navigations,
      text: view.host.textContent, active: localStorage.getItem("agent-chat-active-thread:selection-" + scope.id + ":scope:" + scope.type + ":" + scope.id) };
  } finally { await view.unmount(); client.clear(); }
}

// The Settings Usage tab reads its metrics and alert rules through the action query cache. The
// cache holds what the server returns, so the tab renders without a request.
export async function renderUsage(metrics, alertRules = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["action", "get-usage-metrics", { sinceDays: 30, scope: "me", appId: "vivary" }], metrics);
  client.setQueryData(["action", "get-usage-alerts", { scope: "user", appId: "vivary" }], { rules: alertRules });
  const view = await mount(<QueryClientProvider client={client}><UsageSection appId="vivary" /></QueryClientProvider>);
  const driverCost = label => view.host.querySelector('span[title="' + label + '"]')?.nextElementSibling?.textContent ?? null;
  const snapshot = { text: view.host.textContent, models: Object.fromEntries(metrics.byModel.map(row => [row.label, driverCost(row.label)])),
    alerts: [...view.host.querySelectorAll("p")].map(line => line.textContent).filter(text => text.includes(" · per ")) };
  await view.unmount();
  client.clear();
  return snapshot;
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: HERE, sourcefile: "native-chat-proof.tsx", loader: "tsx" },
    absWorkingDir: WORKBENCH,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl" },
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    // Core's assistant message loads react-dom/server, whose CommonJS build requires Node built-ins.
    banner: { js: `import { createRequire as createProofRequire } from "node:module";
const require = createProofRequire(${JSON.stringify(join(WORKBENCH, "package.json"))});` },
    plugins: [{
      name: "native-chat-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/workbench-code") return { path: join(WORKBENCH, "app", "components", "workspace", "CodeConversation.tsx"), namespace: "workbench-code" };
          if (args.path === "@proof/project-history") return { path: join(WORKBENCH, "app", "components", "layout", "ProjectHistory.tsx") };
          const candidate = args.path.startsWith("@/") ? join(WORKBENCH, "app", args.path.slice(2) + ".ts")
            : args.path.startsWith(".") ? resolve(args.resolveDir, args.path) + (args.path.endsWith(".ts") ? "" : ".ts") : null;
          if (candidate && stubs.has(candidate)) return { path: candidate, namespace: "stub" };
          if (candidate && stubs.has(candidate + "x")) return { path: candidate + "x", namespace: "stub" };
          if (args.path === "@proof/assistant-chat") return { path: join(CLIENT, "AssistantChat.js") };
          if (args.path === "@proof/multi-tab-chat") return { path: join(CLIENT, "MultiTabAssistantChat.js") };
          if (args.path === "@proof/run-recovery") return { path: join(CLIENT, "chat", "run-recovery.js") };
          if (args.path === "@proof/message-components") return { path: join(CLIENT, "chat", "message-components.js") };
          if (args.path === "@proof/sse-event-processor") return { path: join(CLIENT, "sse-event-processor.js") };
          if (args.path === "@proof/tiptap-composer") return { path: join(COMPOSER, "TiptapComposer.js") };
          if (args.path === "@proof/tooltip") return { path: join(TOOLKIT, "dist", "ui", "tooltip.js") };
          if (args.path === "@proof/usage-section") return { path: join(CLIENT, "settings", "UsageSection.js") };
          if (args.path === "@proof/chat-history") return { path: join(TOOLKIT, "dist", "chat-history", "index.js") };
          // The query cache must be the copy Core's action hooks read.
          if (args.path === "@tanstack/react-query" && args.resolveDir === HERE) {
            return build.resolve(args.path, { kind: args.kind, resolveDir: CLIENT });
          }
          // The workbench does not list the assistant runtime, so the proof takes the Toolkit's copy.
          if (args.path === "@assistant-ui/react" && args.resolveDir !== COMPOSER) {
            return build.resolve(args.path, { kind: args.kind, resolveDir: COMPOSER });
          }
          if (args.path.startsWith(".") && (args.importer.startsWith(CORE) || args.importer.startsWith(TOOLKIT))) {
            const target = resolve(dirname(args.importer), args.path);
            if (stubs.has(target)) return { path: target, namespace: "stub" };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "workbench-code" }, args => ({
          contents: readFileSync(args.path, "utf8") + "\nexport { CodeSessionDetails, LocalCodeConversation, ProjectCodeWorkspace };",
          loader: "tsx", resolveDir: dirname(args.path),
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

function installDom() {
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const view = linkedom.parseHTML("<!doctype html><html><body></body></html>");
  // React schedules through MessageChannel. Open ports keep Node alive, so the proof closes them.
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  class IntersectionObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  // Radix's menu watches its content for changes. linkedom has no MutationObserver.
  class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } }
  class WheelEvent extends view.Event { constructor(type, init = {}) { super(type, init); this.deltaY = init.deltaY ?? 0; } }
  // linkedom has no text selection. An unfocused editor only needs an empty one.
  const selection = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, isCollapsed: true,
    removeAllRanges() {}, addRange() {}, collapse() {}, extend() {} };
  view.getSelection = () => selection;
  view.document.getSelection = () => selection;
  const getComputedStyle = () => new Proxy({ getPropertyValue: () => "" }, { get: (style, name) => style[name] ?? "" });
  // linkedom has no location. Core's action paths read the page's path when they load.
  view.location = new URL("http://127.0.0.1/settings");
  view.location.reload = () => {};
  // Core publishes chat navigation to its enclosing window. There is no enclosing app in this DOM.
  view.parent = view;
  view.postMessage = () => {};
  view.history = { state: null, length: 1, go() {}, back() {}, forward() {},
    pushState(_state, _title, url) { view.location = new URL(url, view.location.href); },
    replaceState(_state, _title, url) { view.location = new URL(url, view.location.href); } };
  // The whole chat also keeps state in storage, watches media queries, and scrolls its messages.
  const memoryStorage = () => {
    const items = new Map();
    return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)),
      removeItem: key => items.delete(key), clear: () => items.clear(), key: index => [...items.keys()][index] ?? null,
      get length() { return items.size; } };
  };
  view.sessionStorage = memoryStorage();
  view.localStorage = memoryStorage();
  view.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  view.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
  view.cancelAnimationFrame = id => clearTimeout(id);
  view.HTMLElement.prototype.scrollTo = function scrollTo() {};
  view.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel, WheelEvent,
    ResizeObserver, IntersectionObserver, MutationObserver, getComputedStyle, innerHeight: 800, innerWidth: 1200,
    sessionStorage: view.sessionStorage, localStorage: view.localStorage, matchMedia: view.matchMedia,
    requestAnimationFrame: view.requestAnimationFrame, cancelAnimationFrame: view.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
}

// The chat server for the whole-chat cases. A run's stream stays open until Stop, which ends it as the run
// route does, with `done` and reason `user`. `savedThreads` maps a thread id to its saved thread data, which
// has no run in progress. Every other route answers 404.
const CHAT_API = "http://chat.test/_agent-native/agent-chat";
function installChatServer(savedThreads = {}) {
  const encoder = new TextEncoder();
  const frame = event => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  const openStreams = new Map();
  const stream = (runId, events, hold) => new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(frame(event));
    if (hold) openStreams.set(runId, controller);
    else controller.close();
  } });
  const replies = [
    { runId: "run-first", events: [{ type: "text", text: "Partial first answer", seq: 0 }], hold: true },
    { runId: "run-second", events: [{ type: "text", text: "Finished second answer", seq: 0 }, { type: "done", seq: 1 }], hold: false },
  ];
  const createdAt = new Date("2026-09-28T00:00:00Z").toISOString();
  const message = (id, role, text, extra = {}) => ({ id, role, content: [{ type: "text", text }], createdAt, ...extra });
  const followThread = { headId: "user-live", messages: [
    { parentId: null, message: message("user-old", "user", "Old question") },
    { parentId: "user-old", message: message("reply-old", "assistant", "Finished old answer", { status: { type: "complete", reason: "stop" },
      metadata: { runId: "run-old", custom: { runId: "run-old", turnId: "turn-old" } } }) },
    { parentId: "reply-old", message: message("user-live", "user", "Live question") },
  ] };
  let followed = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url === CHAT_API) {
      const reply = replies.shift();
      return new Response(stream(reply.runId, reply.events, reply.hold),
        { headers: { "content-type": "text/event-stream", "X-Run-Id": reply.runId } });
    }
    const abort = url.match(/\/runs\/([^/]+)\/abort$/);
    if (method === "POST" && abort) {
      const runId = decodeURIComponent(abort[1]);
      openStreams.get(runId)?.enqueue(frame({ type: "done", reason: "user", seq: 1 }));
      openStreams.get(runId)?.close();
      openStreams.delete(runId);
      return Response.json({ ok: true });
    }
    const saved = Object.keys(savedThreads).find(threadId => url.startsWith(`${CHAT_API}/threads/${threadId}`));
    if (method === "GET" && saved) return Response.json({ id: saved, title: "Saved", threadData: savedThreads[saved] });
    if (method === "GET" && Object.keys(savedThreads).some(threadId => url.startsWith(`${CHAT_API}/runs/active?threadId=${threadId}`))) {
      return Response.json({ active: false });
    }
    if (method === "GET" && url.startsWith(`${CHAT_API}/threads/thread-follow`)) {
      return Response.json({ id: "thread-follow", title: "Follow", threadData: JSON.stringify(followThread) });
    }
    if (method === "GET" && url.startsWith(`${CHAT_API}/runs/active?threadId=thread-follow`)) {
      const now = Date.now();
      return Response.json(openStreams.has("run-live") || !followed ? { active: true, runId: "run-live", threadId: "thread-follow",
        turnId: "turn-live", status: "running", lastProgressAt: now, heartbeatAt: now, serverNow: now } : { active: false });
    }
    if (method === "GET" && url.startsWith(`${CHAT_API}/runs/run-live/events`)) {
      followed = true;
      return new Response(stream("run-live", [{ type: "text", text: "Live partial answer", seq: 0 }], true),
        { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return () => { globalThis.fetch = originalFetch; };
}

function installSelectionServer(rows) {
  const saved = Object.fromEntries(rows.map(row => [row.id, row.threadData]));
  const restore = installChatServer(saved);
  const contentFetch = globalThis.fetch;
  let modelSubmits = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://chat.test");
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/agent-chat")) { modelSubmits++; throw new Error("selection must not submit a model request"); }
    if (method === "GET" && url.pathname.endsWith("/threads")) {
      await new Promise(resolve => setTimeout(resolve, 30));
      return Response.json({ threads: rows.filter(row => row.scope.type === url.searchParams.get("scopeType") && row.scope.id === url.searchParams.get("scopeId")) });
    }
    const selected = rows.find(row => url.pathname.endsWith("/threads/" + row.id));
    if (method === "GET" && selected) {
      if (selected.scope.type !== url.searchParams.get("scopeType") || selected.scope.id !== url.searchParams.get("scopeId")) return new Response(null, { status: 404 });
      return Response.json(selected);
    }
    return contentFetch(input, init);
  };
  return { close() { restore(); }, get modelSubmits() { return modelSubmits; } };
}

// Canonical fixtures use durable event IDs. fixtureRunSnapshot transports their server-derived identities.
// Full-history cap and anchor behavior is exercised by code-state-snapshot.test.mjs, not by the UI fixture.
function codeTranscriptEvent(id, kind, message, seq, metadata = {}) {
  return { id, runId: "retained-run", kind, message, createdAt: new Date(Date.UTC(2026, 9, 20, 0, seq)).toISOString(),
    metadata: { seq, ...metadata } };
}

test("Native chat controls", async t => {
  // Tiptap reads the DOM when its module loads, so the DOM goes in first.
  const closeChannels = installDom();
  t.after(() => closeChannels());
  const proofDirectory = await mkdtemp(join(tmpdir(), "vivary-native-chat-proof-"));
  t.after(() => rm(proofDirectory, { recursive: true, force: true }));
  const proofFile = join(proofDirectory, "native-chat-proof.mjs");
  await writeFile(proofFile, await buildProof(), "utf8");
  // The same bundle gets an ordinary filename, so unexpected error stacks cannot include its entire data URL.
  const proof = await import(pathToFileURL(proofFile).href);

  for (const control of ["header", "kept-route"]) {
    await t.test("a Personal project's Code " + control + " New conversation saves a new API route", async () => {
      localStorage.clear(); sessionStorage.clear();
      const server = installChatServer();
      try {
        const snapshot = await proof.startWorkbenchConversation({ control });
        assert.deepEqual(snapshot.before, { route: "/?run=retained-run", title: "Retained Code conversation", keptRoute: true },
          "an explicit retained Code conversation stays open in a Personal project");
        assert.equal(snapshot.draftChanges.length, 1, "generic New conversation must initialize one durable API draft");
        const change = snapshot.draftChanges[0];
        assert.equal(typeof change.threadId, "string");
        assert.ok(change.threadId.length > 0 && change.threadId !== "retained-run", "the API conversation gets a fresh ID");
        assert.deepEqual(change, { operation: "change", kind: "project", projectId: "project-personal", threadId: change.threadId,
          expected: null, next: { status: "cleared", text: "", submitId: null } });
        assert.equal(snapshot.initializedBeforeAck, 0);
        assert.equal(snapshot.pendingRoute, "/?run=retained-run", "keep the Code route until the draft is acknowledged");
        assert.deepEqual(snapshot.initialized, [change]);
        assert.equal(snapshot.nativeActiveThread, change.threadId, "the acknowledged ID is Native's optimistic thread");
        assert.equal(snapshot.route, "/?runtime=native&history=project&thread=" + encodeURIComponent(change.threadId));
        assert.deepEqual(snapshot.codeSelection, { key: "retained-run", runId: "retained-run" });
        assert.equal(snapshot.codeSelectionWrites.length, 0, "creating API chat must not replace the retained Code selection");
      } finally { server(); }
    });
  }
  for (const outcome of ["reject", "unchanged", "not-cleared"]) {
    await t.test("a " + outcome + " API draft write keeps Code selected and another control can retry", async () => {
      localStorage.clear(); sessionStorage.clear();
      const server = installChatServer();
      try {
        const snapshot = await proof.startWorkbenchConversation({ control: "header", outcome, retry: true });
        assert.equal(snapshot.afterInitialization.route, "/?run=retained-run", "a failed save keeps the retained route");
        assert.equal(snapshot.afterInitialization.saveFailure, true, "an unacknowledged save reports failure");
        assert.equal(snapshot.draftChanges.length, 2, "the other generic control can retry after failure");
        assert.equal(snapshot.initialized.length, 1);
        assert.notEqual(snapshot.draftChanges[0].threadId, snapshot.draftChanges[1].threadId);
        assert.equal(snapshot.route, "/?runtime=native&history=project&thread=" + encodeURIComponent(snapshot.draftChanges[1].threadId));
        assert.equal(snapshot.codeSelection.runId, "retained-run");
        assert.equal(snapshot.codeSelectionWrites.length, 0);
      } finally { server(); }
    });
  }
  await t.test("repeated header and kept-route clicks share one pending API creation", async () => {
    localStorage.clear(); sessionStorage.clear();
    const server = installChatServer();
    try {
      const snapshot = await proof.startWorkbenchConversation({ control: "header", repeatControls: true });
      assert.equal(snapshot.draftChanges.length, 1);
      assert.equal(snapshot.initialized.length, 1);
      assert.equal(snapshot.pendingRoute, "/?run=retained-run");
      assert.equal(snapshot.route, "/?runtime=native&history=project&thread=" + encodeURIComponent(snapshot.draftChanges[0].threadId));
      assert.equal(snapshot.codeSelectionWrites.length, 0);
    } finally { server(); }
  });
  for (const [transition, outcome] of [["route", "success"], ["project", "success"], ["unmount", "success"], ["route", "reject"]]) {
    await t.test("a late " + outcome + " API save cannot take over after " + transition, async () => {
      localStorage.clear(); sessionStorage.clear();
      const server = installChatServer();
      try {
        const snapshot = await proof.startWorkbenchConversation({ control: "kept-route", transition, outcome });
        assert.equal(snapshot.draftChanges.length, 1, "the test leaves a real parent creation in flight");
        assert.equal(snapshot.initialized.length, outcome === "success" ? 1 : 0);
        assert.equal(snapshot.route, snapshot.departedRoute, "the late completion must not navigate");
        assert.equal(snapshot.afterInitialization.saveFailure, false, "a stale failure must not appear in the destination");
        if (transition === "route") {
          assert.equal(snapshot.route, "/?run=new&draft=owner-chosen");
          assert.equal(snapshot.codeSelection.key, "owner-chosen");
          assert.equal(snapshot.codeSelection.runId, null);
        } else {
          assert.equal(snapshot.route, transition === "project" ? "/?run=other-run" : "/?run=retained-run");
          assert.equal(snapshot.codeSelection.runId, "retained-run");
          assert.equal(snapshot.codeSelectionWrites.length, 0);
        }
      } finally { server(); }
    });
  }
  await t.test("a Personal Code view waits for Native identity before either generic control can create", async () => {
    localStorage.clear(); sessionStorage.clear();
    const server = installChatServer();
    try {
      const snapshot = await proof.startWorkbenchConversation({ control: "header", identityReady: false });
      assert.equal(snapshot.controlsDisabled[0], true);
      assert.equal(snapshot.controlsDisabled[1], true);
      assert.equal(snapshot.route, "/?run=retained-run");
      assert.equal(snapshot.draftChanges.length, 0);
      assert.equal(snapshot.codeSelectionWrites.length, 0);
    } finally { server(); }
  });
  for (const input of [{ label: "Coding", workspaceKind: "coding" }, { label: "Not set", workspaceKind: null },
    { label: "Personal workspace", projectId: null }]) {
    await t.test(input.label + " keeps Code for the header New conversation", async () => {
      localStorage.clear(); sessionStorage.clear();
      const server = installChatServer();
      try {
        const snapshot = await proof.startWorkbenchConversation({ ...input, control: "header" });
        const params = new URL(snapshot.route, "http://chat.test").searchParams;
        assert.equal(params.get("runtime"), null);
        assert.equal(params.get("run"), "new");
        assert.ok(params.get("draft"), "a fresh Code draft is selected");
        assert.deepEqual(snapshot.codeSelection, { key: params.get("draft"), runId: null });
        assert.equal(snapshot.codeSelectionWrites.length, 1);
        assert.equal(snapshot.draftChanges.length, 0, "Code creation must not initialize API chat");
      } finally { server(); }
    });
  }

  // Claims 4331832605 and 4331832608. These use the actual sidebar, parent and Native owners.
  // Only host identity/actions and scoped history reads are fixture responses.
  for (const first of ["header", "sidebar"]) {
    const second = first === "header" ? "sidebar" : "header";
    await t.test("Code view " + first + " then " + second + " shares one pending Native creation", async () => {
      localStorage.clear(); sessionStorage.clear();
      const snapshot = await proof.startWorkbenchConversation({ control: first, secondControl: second, withHistory: true });
      if (snapshot.unexpectedFetches.length) console.error(snapshot.unexpectedFetches);
      assert.equal(snapshot.unexpectedFetches.length, 0, "the combined owner fixture must make only scoped history reads");
      assert.equal(snapshot.firstPending.draftChanges.length, 1, "the first owner reaches the real draft acknowledgement gate");
      assert.equal(snapshot.firstPending.initialized, 0);
      assert.equal(snapshot.firstPending.route, "/?run=retained-run");
      assert.equal(snapshot.firstPending.selectionKey, "retained-run");
      assert.equal(snapshot.firstPending.selectionRunId, "retained-run");
      assert.equal(snapshot.firstPending.selectionWrites, 0);
      assert.equal(snapshot.otherControl.present, true, "the other owner's actual control is mounted");
      assert.equal(snapshot.otherControl.tag, "BUTTON");
      const id = snapshot.firstPending.draftChanges[0].threadId;
      assert.equal(typeof id, "string");
      assert.notEqual(id, "retained-run");
      assert.equal(new Set(snapshot.firstPending.activeThreadWrites).size, 1);
      const pending = snapshot.ownerPending;
      assert.equal(new Set(pending.activeThreadWrites).size, 1,
        "the two owners must not allocate distinct optimistic IDs before acknowledgement");
      assert.equal(pending.activeThreadWrites.every(value => value === id), true);
      assert.equal(pending.draftChanges.length, 1, "the two owners must initialize only one cleared Native draft");
      assert.equal(pending.draftChanges[0].threadId, id);
      assert.equal(pending.draftChanges[0].operation, "change");
      assert.equal(pending.draftChanges[0].kind, "project");
      assert.equal(pending.draftChanges[0].projectId, "project-personal");
      assert.equal(pending.draftChanges[0].expected, null);
      assert.equal(pending.draftChanges[0].next.status, "cleared");
      assert.equal(pending.draftChanges[0].next.text, "");
      assert.equal(pending.draftChanges[0].next.submitId, null);
      assert.equal(pending.initialized, 0);
      assert.equal(pending.route, "/?run=retained-run", "acknowledgement still gates navigation after the other control");
      assert.equal(pending.selectionKey, "retained-run");
      assert.equal(pending.selectionRunId, "retained-run");
      assert.equal(pending.selectionWrites, 0);
      assert.equal(snapshot.initialized.length, 1);
      assert.equal(snapshot.initialized[0].threadId, id);
      assert.equal(snapshot.route, "/?runtime=native&history=project&thread=" + encodeURIComponent(id));
      assert.equal(snapshot.nativeActiveThread, id);
      assert.equal(snapshot.codeSelection.key, "retained-run");
      assert.equal(snapshot.codeSelection.runId, "retained-run");
      assert.equal(snapshot.codeSelectionWrites.length, 0);
      assert.equal(snapshot.routerMounts, 1);
    });
  }
  for (const input of [{ label: "Not set project", workspaceKind: null },
    { label: "Personal workspace", workspaceKind: null, projectId: null }]) {
    await t.test(input.label + " on Native waits for identity in the real fallback rail, then creates Native", async () => {
      localStorage.clear(); sessionStorage.clear();
      const nativeRoute = "/?runtime=native&history=project&thread=retained-native";
      const snapshot = await proof.startWorkbenchConversation({ ...input, control: "sidebar", withHistory: true,
        identityReady: false, initialRoute: nativeRoute, resolveHistoryIdentity: true });
      if (snapshot.unexpectedFetches.length) console.error(snapshot.unexpectedFetches);
      assert.equal(snapshot.unexpectedFetches.length, 0);
      const pending = snapshot.identityPending;
      assert.equal(pending.fallbackRendered, true, "ProjectHistory actually rendered CodeHistory while identity was unresolved");
      assert.equal(pending.fallback.present, true);
      assert.equal(pending.fallback.tag, "BUTTON");
      assert.equal(snapshot.resolvedControl.present, true);
      assert.equal(snapshot.resolvedControl.unavailable, false, "the resolved SessionHistory control must allow creation");
      assert.equal(snapshot.resolvedControl.routerMounts, 1, "identity resolution preserves the mounted router");
      assert.equal(snapshot.ownerPending.route, nativeRoute, "the resolved owner waits for its draft acknowledgement");
      assert.equal(snapshot.ownerPending.initialized, 0);
      assert.equal(snapshot.ownerPending.draftChanges.length, 1);
      const change = snapshot.ownerPending.draftChanges[0];
      assert.equal(change.operation, "change");
      assert.equal(change.kind, "project");
      assert.equal(change.projectId, input.projectId === undefined ? "project-personal" : input.projectId);
      assert.equal(change.next.status, "cleared");
      assert.equal(snapshot.initialized.length, 1);
      assert.equal(snapshot.initialized[0].threadId, change.threadId);
      assert.equal(snapshot.route, "/?runtime=native&history=project&thread=" + encodeURIComponent(change.threadId));
      assert.equal(snapshot.nativeActiveThread, change.threadId);
      assert.equal(snapshot.routerMounts, 1);
      assert.equal(pending.route, nativeRoute, "a human-available fallback click must not replace the open Native route");
      assert.equal(pending.fallback.disabledProperty || pending.fallback.disabledAttribute
        || pending.fallback.ariaDisabled === "true", true, "actual DOM disabled semantics must gate the Code-only fallback");
      assert.equal(pending.clicked, false);
      assert.equal(pending.selectionKey, "retained-run");
      assert.equal(pending.selectionRunId, "retained-run");
      assert.equal(pending.selectionWrites, 0);
      assert.equal(pending.draftChanges.length, 0);
      assert.equal(pending.activeThreadWrites.length, 0);
      assert.equal(snapshot.codeSelectionWrites.length, 0);
    });
  }
  for (const input of [
    { label: "Not set on Code", workspaceKind: null, initialRoute: "/?run=retained-run" },
    { label: "Coding on Native", workspaceKind: "coding", initialRoute: "/?runtime=native&history=project&thread=retained-native" },
  ]) {
    await t.test(input.label + " keeps the real identity-loading fallback available for Code creation", async () => {
      localStorage.clear(); sessionStorage.clear();
      const snapshot = await proof.startWorkbenchConversation({ ...input, control: "sidebar", withHistory: true, identityReady: false });
      if (snapshot.unexpectedFetches.length) console.error(snapshot.unexpectedFetches);
      assert.equal(snapshot.unexpectedFetches.length, 0);
      assert.equal(snapshot.identityPending.fallbackRendered, true);
      assert.equal(snapshot.identityPending.fallback.unavailable, false);
      assert.equal(snapshot.identityPending.clicked, true);
      const params = new URL(snapshot.route, "http://chat.test").searchParams;
      assert.equal(params.get("runtime"), null);
      assert.equal(params.get("run"), "new");
      assert.equal(typeof params.get("draft"), "string");
      assert.notEqual(params.get("draft"), "retained-run");
      assert.equal(snapshot.codeSelection.key, params.get("draft"));
      assert.equal(snapshot.codeSelection.runId, null);
      assert.equal(snapshot.codeSelectionWrites.length, 1);
      assert.equal(snapshot.draftChanges.length, 0);
      assert.equal(snapshot.activeThreadWrites.length, 0);
    });
  }

  await t.test("the Workbench picker renders inside the actual composer before Send, with notices outside", async () => {
    const server = installChatServer();
    try {
      const snapshot = await proof.renderWorkbenchComposer({});
      assert.equal(snapshot.embedded, true);
      assert.equal(snapshot.beforeSend, true);
      assert.equal(snapshot.noticesOutsideToolbar, true);
      assert.equal(snapshot.label, "Runtime and model: Claude Code Sonnet 5.5");
      assert.equal(snapshot.selects, 0, "one picker replaces the two native selects");
      assert.deepEqual(snapshot.disabled, [false, true]);
      assert.doesNotMatch(snapshot.text, /Subscription controls|funding|Usage credits/);
      assert.doesNotMatch(snapshot.text, /API list price/);
    } finally { server(); }
  });
  await t.test("the Workbench retains a saved legacy choice, locks a new conversation while its own turn runs, and leaves a retained one open", async () => {
    const server = installChatServer();
    try {
      const saved = await proof.renderWorkbenchComposer({ model: "sonnet" });
      assert.equal(saved.model, "sonnet");
      assert.deepEqual(saved.choices, []);
      assert.match(saved.text, /legacy or unavailable/);
      const busy = await proof.renderWorkbenchComposer({ active: true });
      assert.equal(busy.embedded, true);
      assert.equal(busy.disabled[0], true);
      const retained = await proof.renderWorkbenchComposer({ history: true });
      assert.equal(retained.embedded, true);
      assert.equal(retained.disabled[0], false, "a retained conversation can switch in place");
      assert.doesNotMatch(retained.text, /This conversation keeps|Start a new conversation/);
    } finally { server(); }
  });

  await t.test("a read-only history view keeps the picker locked without a reason line", async () => {
    const server = installChatServer();
    try {
      const snapshot = await proof.renderWorkbenchComposer({ history: true, viewingMatch: true });
      assert.equal(snapshot.disabled[0], true);
      assert.doesNotMatch(snapshot.text, /This conversation keeps/);
      assert.equal(snapshot.describedBy, null);
    } finally { server(); }
  });

  await t.test("a new conversation's picker is open and carries no reason", async () => {
    const server = installChatServer();
    try {
      const snapshot = await proof.renderWorkbenchComposer({});
      assert.equal(snapshot.disabled[0], false);
      assert.doesNotMatch(snapshot.text, /This conversation keeps/);
      assert.equal(snapshot.describedBy, null);
    } finally { server(); }
  });

  await t.test("another conversation's run does not lock a retained conversation", async () => {
    const server = installChatServer();
    try {
      const snapshot = await proof.renderWorkbenchComposer({ history: true, folderRuns: [OTHER_RUN] });
      assert.equal(snapshot.disabled[0], false);
      assert.equal(snapshot.describedBy, null);
      const view = await proof.renderCodeSwitch({ folderRuns: [OTHER_RUN] });
      try {
        assert.equal(view.disabled(), false);
        await view.choose("Codex", "GPT Fixture");
        assert.match(view.panel(), /^Switch this conversation from Claude Code Sonnet 5\.5 to Codex GPT Fixture\?/);
      } finally { await view.unmount(); }
    } finally { server(); }
  });

  const transfer = "The new session gets the visible conversation text, up to the last 24 messages. "
    + "Tool output and the previous runtime's private session do not transfer.";

  await t.test("an idle retained conversation asks what transfers, then switches in place", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch();
    try {
      assert.equal(view.disabled(), false);
      assert.deepEqual((await view.groups()).map(group => group.heading), ["Claude Code", "Codex"]);
      await view.choose("Codex", "GPT Fixture");
      assert.equal(view.panel(), "Switch this conversation from Claude Code Sonnet 5.5 to Codex GPT Fixture? " + transfer + "SwitchCancel");
      assert.deepEqual(await view.options("Codex"), ["GPT Fixture", "GPT Other"], "the target runtime's models");
      assert.equal(view.pickerLabel(), "Runtime and model: Codex GPT Fixture", "the picker shows the pending target");
      assert.ok(view.describedBy(), "the picker points at the confirm");
      await view.choose("Codex", "GPT Other");
      assert.match(view.panel(), /to Codex GPT Other\?/);
      assert.deepEqual(view.calls, [], "nothing is sent before the confirm");
      await view.click("Switch");
      assert.deepEqual(view.calls, [{ name: "vivary-code-switch",
        params: { projectId: undefined, runId: "retained-run", engine: "codex-cli", model: "gpt-other", expectedSwitchGeneration: null } }]);
      assert.deepEqual(view.choices, [{ engine: "codex-cli", model: "gpt-other" }]);
      assert.equal(view.panel(), null);
      assert.equal(view.settled, 1, "the parent reloads the conversation");
    } finally { await view.unmount(); server(); }
  });

  await t.test("open Session details reload after a switch changes the run's runtime and model", async () => {
    const view = await proof.renderSessionDetails();
    try {
      assert.deepEqual(view.reads, ["claude-cli"]);
      assert.match(view.panel(), /Claude Code · retained-run/);
      assert.match(view.panel(), /Provider session: claude-session-before/);
      // A switch clears both provider sessions. The open panel must not keep the previous runtime's session.
      await view.switchTo({ engine: "codex-cli", model: "gpt-fixture", label: "Codex", sessionId: null });
      assert.deepEqual(view.reads, ["claude-cli", "codex-cli"]);
      assert.match(view.panel(), /Codex · retained-run/);
      assert.match(view.panel(), /Provider session: Not reported/);
      // A model change inside one runtime also clears the session, so it reloads too.
      await view.switchTo({ engine: "codex-cli", model: "gpt-other", label: "Codex", sessionId: null });
      assert.deepEqual(view.reads, ["claude-cli", "codex-cli", "codex-cli"]);
    } finally { await view.unmount(); }
  });

  await t.test("PR258 4330509923: the real workspace owner refreshes open details after an away-and-back switch", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const user = codeTranscriptEvent("details-user", "user", "Keep this conversation.", 0);
    const answer = codeTranscriptEvent("details-answer", "assistant", "Earlier answer.", 1);
    let view;
    try {
      view = await proof.renderWorkspaceSessionDetails([user, answer]);
      assert.deepEqual(view.reads, [{ sessionId: "obsolete-claude-session", nextTurn: "native-resume" }]);
      assert.match(view.panel() ?? "", /Provider session: obsolete-claude-session/);
      assert.match(view.panel() ?? "", /The next message will request resume of this provider session\./);
      await view.poll({ status: "paused", phase: "paused", updatedAt: "2026-10-20T00:01:30.000Z" });
      assert.equal(view.reads.length, 1, "same switch generation status and timestamp changes do not refetch details");
      const claude = { engine: "claude-cli", model: "claude-sonnet-5-5" };
      const codex = { engine: "codex-cli", model: "gpt-fixture" };
      const away = codeTranscriptEvent("details-switch-away", "note", "Switched from Claude Code to Codex.", 2,
        { source: "vivary-runtime-switch", switchedAt: "2026-10-20T00:02:00.000Z", from: claude, to: codex });
      const back = codeTranscriptEvent("details-switch-back", "note", "Switched from Codex to Claude Code.", 3,
        { source: "vivary-runtime-switch", switchedAt: "2026-10-20T00:03:00.000Z", from: codex, to: claude });
      // One observed snapshot has the same engine/model and two new canonical switch notes. Only the parent's
      // actual code-state query is updated. No child props are supplied and no details query is invalidated.
      await view.poll({ events: [user, answer, away, back], updatedAt: "2026-10-20T00:03:00.000Z" },
        { continuity: "not-recorded", sessionId: null, nextTurn: "reconstructed-context" });
      assert.equal(view.reads.length, 2, "a new switch generation must reach the child through ProjectCodeWorkspace");
      assert.deepEqual(view.reads.at(-1), { sessionId: null, nextTurn: "reconstructed-context" });
      assert.match(view.panel() ?? "", /Provider session: Not reported/);
      assert.match(view.panel() ?? "", /The next message will reconstruct context from the saved conversation\./);
      assert.doesNotMatch(view.panel() ?? "", /obsolete-claude-session|will request resume|confirmed native resume/);
      await view.poll({ status: "completed", phase: "complete", updatedAt: "2026-10-20T00:03:30.000Z" });
      assert.equal(view.reads.length, 2, "another status-only poll in the same generation does not refetch");
      await view.poll({ switchGeneration: "committed-before-note", updatedAt: "2026-10-20T00:04:00.000Z" });
      assert.equal(view.reads.length, 3, "a durable route commit refreshes details even before its note exists");
      const committedNote = codeTranscriptEvent("committed-note", "note", "The committed switch note.", 4,
        { source: "vivary-runtime-switch", switchGeneration: "committed-before-note", from: claude, to: claude });
      await view.poll({ events: [user, answer, away, back, committedNote], updatedAt: "2026-10-20T00:04:30.000Z" });
      assert.equal(view.reads.length, 3, "appending the committed generation's note does not refetch again");
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("Cancel, or choosing the current route again, sends nothing", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch();
    try {
      await view.choose("Codex", "GPT Fixture");
      await view.click("Cancel");
      assert.equal(view.panel(), null);
      await view.choose("Claude Code", "Opus 5.5");
      assert.match(view.panel(), /to Claude Code Opus 5\.5\?/);
      await view.choose("Claude Code", "Sonnet 5.5");
      assert.equal(view.panel(), null);
      assert.deepEqual([view.calls, view.choices], [[], []]);
    } finally { await view.unmount(); server(); }
  });

  await t.test("cancelling a route choice preserves the native draft and Send submits the current route", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ recordSend: true });
    try {
      await view.prefill();
      const draft = view.draft();
      assert.match(draft ?? "", /Read README\.md/);
      assert.equal(view.sendDisabled(), false, "a real draft enables the installed composer");
      const current = view.route();
      assert.deepEqual(current, { engine: "claude-cli", model: "claude-sonnet-5-5" });
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Cancel");
      assert.equal(view.panel(), null);
      assert.deepEqual(view.route(), current);
      assert.equal(view.draft(), draft, "Cancel preserves the composed text");
      await view.choose("Conversation model", "claude-opus-5-5");
      await view.choose("Conversation model", current.model);
      assert.equal(view.panel(), null);
      assert.equal(view.draft(), draft, "returning to the current model preserves the draft");
      assert.deepEqual([view.calls, view.choices], [[], []], "unconfirmed choices perform no action or saved choice change");
      await view.send();
      assert.equal(view.calls.length, 1, "one real adapter submission");
      assert.equal(view.calls[0].name, "vivary-code-send");
      assert.deepEqual({ engine: view.calls[0].params.engine, model: view.calls[0].params.model }, current);
      assert.equal(view.calls[0].params.runId, "retained-run");
      assert.equal(view.calls[0].params.message, draft);
    } finally { await view.unmount(); server(); }
  });

  for (const change of [
    { label: "runtime", control: "Conversation runtime", value: "codex-cli", target: { engine: "codex-cli", model: "gpt-fixture" } },
    { label: "model", control: "Conversation model", value: "claude-opus-5-5", target: { engine: "claude-cli", model: "claude-opus-5-5" } },
  ]) {
    await t.test(`a pending ${change.label} choice cannot leave enabled Send using the previous route`, { timeout: 10_000 }, async () => {
      const server = installChatServer();
      const view = await proof.renderCodeSwitch({ recordSend: true });
      try {
        await view.prefill();
        const draft = view.draft();
        assert.match(draft ?? "", /Read README\.md/);
        assert.equal(view.sendDisabled(), false, "the composer starts enabled with a real draft");
        await view.choose(change.control, change.value);
        assert.match(view.panel() ?? "", /^Switch this conversation from /);
        assert.deepEqual(view.route(), change.target, "the selectors visibly show the target");
        assert.equal(view.draft(), draft, "choosing a route preserves the draft");
        assert.deepEqual([view.calls, view.choices], [[], []], "showing a target authorizes no action");
        assert.equal(typeof view.sendDisabled(), "boolean", "the real native Send control exists");
        if (view.sendDisabled()) {
          // A confirmation may disable Send. Cancelling must restore it with the same draft and original choice.
          await view.click("Cancel");
          assert.equal(view.panel(), null);
          assert.deepEqual(view.route(), { engine: "claude-cli", model: "claude-sonnet-5-5" });
          assert.equal(view.draft(), draft);
          assert.equal(view.sendDisabled(), false);
          assert.deepEqual([view.calls, view.choices], [[], []]);
        }
        const visibleAtSend = view.route();
        // Click the installed composer's Send. The actual local adapter reaches the recorder and gets an inert
        // returned refusal. This exercises route submission, not thrown pre-append rejection handling.
        await view.send();
        assert.equal(view.calls.length, 1, "one real adapter submission and no premature switch");
        assert.equal(view.calls[0].name, "vivary-code-send");
        const submitted = view.calls[0].params;
        assert.deepEqual({ engine: submitted.engine, model: submitted.model }, visibleAtSend,
          "enabled Send must use the runtime and model the selectors show");
        assert.equal(submitted.runId, "retained-run");
        assert.equal(submitted.message, draft);
      } finally { await view.unmount(); server(); }
    });
  }

  for (const replyModel of ["gpt-fixture", "gpt-other"]) {
    await t.test(`PR258 4330509916: the returned ${replyModel} route governs selectors, saved choice and real Send`, { timeout: 10_000 }, async () => {
      const server = installChatServer();
      const authoritative = { engine: "codex-cli", model: replyModel };
      let view;
      try {
        view = await proof.renderCodeSwitch({ recordSend: true,
          switchReply: { ...authoritative, engineLabel: "Codex" } });
        await view.prefill();
        const draft = view.draft();
        assert.match(draft ?? "", /Read README\.md/);
        await view.choose("Conversation runtime", "codex-cli");
        assert.deepEqual(view.route(), { engine: "codex-cli", model: "gpt-fixture" });
        assert.match(view.panelMessage() ?? "", /^Switch this conversation from Claude Code Sonnet 5\.5 to Codex GPT Fixture\?/);
        assert.deepEqual([view.calls, view.choices], [[], []], "a displayed target authorizes no submission");
        await view.click("Switch");
        assert.deepEqual(view.calls, [{ name: "vivary-code-switch",
          params: { projectId: undefined, runId: "retained-run", engine: "codex-cli", model: "gpt-fixture", expectedSwitchGeneration: null } }]);
        // An older polling request may arrive after the action reply. An opaque different ID alone proves no freshness.
        await view.update({ engine: "claude-cli", model: "claude-sonnet-5-5", switchGeneration: "fixture-older-switch",
          updatedAt: "2026-10-20T00:00:00.000Z" });
        assert.equal(typeof view.sendDisabled(), "boolean", "the installed composer still owns Send");
        if (view.sendDisabled()) {
          // Gating until parent polling catches up is also safe. Never send an unconfirmed or stale route.
          assert.equal(view.draft(), draft);
          await view.update({ ...authoritative, engineLabel: "Codex", switchGeneration: "fixture-accepted-switch" });
          assert.equal(view.sendDisabled(), false, "authoritative parent state restores Send");
        }
        const visibleAtSend = view.route();
        assert.equal(view.draft(), draft, "the confirmed switch preserves the composed text");
        // Send through the installed composer and real adapter even on old source, before route assertions fail.
        await view.send();
        assert.equal(view.calls.length, 2, "one confirmed switch and one real adapter submission");
        assert.equal(view.calls[1].name, "vivary-code-send");
        const submitted = view.calls[1].params;
        assert.deepEqual({ engine: submitted.engine, model: submitted.model }, authoritative,
          "the returned route governs enabled Send before parent polling catches up");
        assert.deepEqual(visibleAtSend, authoritative, "selectors agree with the authoritative route at submission");
        for (const choice of view.choices) assert.deepEqual(choice, authoritative, "remembered choices use the returned route");
        assert.equal(submitted.runId, "retained-run");
        assert.equal(submitted.message, draft);
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  await t.test("an accepted switch yields to a later owner query even if its generation never rendered in parent props", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    let view;
    try {
      view = await proof.renderCodeSwitch({ recordSend: true,
        switchReply: { engine: "codex-cli", engineLabel: "Codex", model: "gpt-other" } });
      await view.prefill();
      const draft = view.draft();
      const releaseOlderRead = view.holdOwnerRead();
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Switch");
      assert.deepEqual(view.route(), { engine: "codex-cli", model: "gpt-other" });
      assert.deepEqual(await releaseOlderRead(), { outcome: "cancelled", model: "gpt-other" },
        "a pre-action owner request cannot replace the accepted cache when its old reply arrives");
      // The normal owner cache supplies a newer snapshot after the action cancels earlier queries. The parent
      // never renders fixture-accepted-switch, so waiting for that exact generation would freeze the old route.
      await view.ownerPoll({ engine: "codex-cli", engineLabel: "Codex", model: "gpt-fixture",
        switchGeneration: "another-window-switch", updatedAt: "2026-10-20T00:05:00.000Z" });
      assert.deepEqual(view.route(), { engine: "codex-cli", model: "gpt-fixture" });
      assert.equal(view.draft(), draft);
      assert.equal(view.sendDisabled(), false);
      await view.send();
      assert.deepEqual(view.calls.map(call => call.name), ["vivary-code-switch", "vivary-code-send"]);
      assert.deepEqual({ engine: view.calls[1].params.engine, model: view.calls[1].params.model },
        { engine: "codex-cli", model: "gpt-fixture" });
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("PR258 4331141807: an applied Stop-and-switch reply governs real Send before selected-run polling catches up", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const target = { engine: "codex-cli", model: "gpt-fixture" };
    const reply = { ...target, engineLabel: "Codex", status: "paused", phase: "paused", pendingSwitch: null };
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true, recordSend: true, switchReply: reply });
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Stop and switch");
      assert.deepEqual(view.calls, [], "the working turn needs the owner's second confirmation");
      await view.click("Stop and switch");
      assert.equal(view.calls.length, 1);
      assert.equal(view.calls[0].params.stop, true, "exercise stopThenSwitch, not plain Switch");
      // The workspace is idle now, but its selected-run snapshot is late and still carries the previous route.
      // Do not retain the fixture's running flag and mistake its disabled composer for response adoption.
      await view.update({ status: "completed", phase: "complete", pendingSwitch: null });
      // An empty draft also disables Send. Fill it first when editing is enabled so that cannot masquerade as a gate.
      if (view.canPrefill()) await view.prefill();
      const gatedUntilSelectedState = view.sendDisabled() !== false;
      if (gatedUntilSelectedState) {
        await view.ownerPoll({ ...reply, switchGeneration: "fixture-accepted-switch" });
        await view.prefill();
      }
      assert.equal(view.sendDisabled(), false, "a real draft can send once the authoritative selected-run gate is resolved");
      const visibleAtSend = view.route();
      const draft = view.draft();
      await view.send();
      assert.deepEqual(view.calls.map(call => call.name), ["vivary-code-switch", "vivary-code-send"]);
      const submitted = view.calls[1].params;
      assert.deepEqual({ engine: submitted.engine, model: submitted.model }, target,
        "an enabled real Send must use the applied Stop-and-switch reply, not the stale selected-run route");
      assert.deepEqual(visibleAtSend, target);
      if (!gatedUntilSelectedState) assert.deepEqual(view.choices.at(-1), target, "the accepted reply updates the remembered choice");
      for (const choice of view.choices) assert.deepEqual(choice, target);
      assert.equal(submitted.message, draft);
      assert.equal(submitted.runId, "retained-run");
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("PR258 4331141807 control: a genuinely pending Stop reply remains gated with its recorded target", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const pendingSwitch = { engine: "codex-cli", model: "gpt-fixture" };
    const reply = { status: "running", phase: "stopping", pendingSwitch, switchGeneration: null };
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true, recordSend: true, switchReply: reply });
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Stop and switch");
      await view.click("Stop and switch");
      assert.notEqual(view.sendDisabled(), false, "a genuinely active Stop reply cannot enable Send");
      await view.ownerPoll(reply);
      assert.equal(view.panelMessage(), "Stopping the current request. This conversation then switches to Codex GPT Fixture.");
      assert.equal(view.disabled(), true);
      assert.notEqual(view.sendDisabled(), false);
      assert.deepEqual(view.calls.map(call => call.name), ["vivary-code-switch"]);
      assert.deepEqual(view.choices, [], "recording a pending target does not yet accept a route");
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("PR258 4331141807 control: a later owner query supersedes an applied Stop reply without freezing real Send", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const reply = { engine: "codex-cli", engineLabel: "Codex", model: "gpt-fixture", status: "paused", phase: "paused", pendingSwitch: null };
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true, recordSend: true, switchReply: reply });
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Stop and switch");
      await view.click("Stop and switch");
      // The next owner query can already be newer. Do not require an intermediate render of the accepted generation.
      const later = { engine: "claude-cli", engineLabel: "Claude Code", model: "claude-opus-5-5", status: "completed", phase: "complete",
        pendingSwitch: null, switchGeneration: "another-window-after-stop" };
      await view.ownerPoll(later);
      await view.prefill();
      assert.deepEqual(view.route(), { engine: later.engine, model: later.model });
      await view.send();
      assert.deepEqual(view.calls.map(call => call.name), ["vivary-code-switch", "vivary-code-send"]);
      assert.deepEqual({ engine: view.calls[1].params.engine, model: view.calls[1].params.model },
        { engine: later.engine, model: later.model });
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  for (const stop of [false, true]) for (const observation of [null, "displayed-durable-generation"]) {
    await t.test(`PR258 4331141822 UI contract: ${stop ? "Stop-and-switch" : "plain Switch"} submits ${observation === null ? "explicit null" : "the displayed generation"}`,
    { timeout: 10_000 }, async () => {
      const server = installChatServer();
      let view;
      try {
        const turn = codeTranscriptEvent("confirmed-switch-turn", "user", "The turn whose Stop is confirmed.", 0);
        view = await proof.renderCodeSwitch({ running: stop, switchGeneration: observation, events: stop ? [turn] : [] });
        await view.choose("Conversation runtime", "codex-cli");
        if (stop) { await view.click("Stop and switch"); await view.click("Stop and switch"); }
        else await view.click("Switch");
        assert.equal(view.calls.length, 1);
        assert.equal(view.calls[0].name, "vivary-code-switch");
        assert.equal(Object.hasOwn(view.calls[0].params, "expectedSwitchGeneration"), true,
          "the action must carry an observation even for a legacy null generation");
        assert.equal(view.calls[0].params.expectedSwitchGeneration, observation);
        if (stop) assert.equal(view.calls[0].params.expectedTurnId, turn.id, "Stop carries the canonical confirmed turn");
        else assert.equal(Object.hasOwn(view.calls[0].params, "expectedTurnId"), false);
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  for (const running of [false, true]) {
    await t.test(`a same-route ABA invalidates an open ${running ? "Stop" : "idle"} confirmation until a fresh choice`, { timeout: 10_000 }, async () => {
      const server = installChatServer();
      let view;
      try {
        const turn = codeTranscriptEvent("aba-current-turn", "user", "Current turn", 0);
        view = await proof.renderCodeSwitch({ running, switchGeneration: "shown-before-aba", events: [turn] });
        await view.choose("Conversation runtime", "codex-cli");
        if (running) await view.click("Stop and switch");
        const confirmation = view.panelMessage();
        const output = codeTranscriptEvent("aba-unrelated-output", "assistant", "Same turn output", 1);
        await view.ownerPoll({ events: [turn, output], updatedAt: "2026-10-20T23:00:01.000Z" });
        assert.equal(view.panelMessage(), confirmation, "output and timestamps retain the observed confirmation");
        assert.deepEqual([view.calls, view.choices], [[], []]);
        const away = codeTranscriptEvent("aba-switch-away", "note", "Switched away", 2,
          { source: "vivary-runtime-switch" });
        const back = codeTranscriptEvent("aba-switch-back", "note", "Switched back", 3,
          { source: "vivary-runtime-switch" });
        // One actual owner snapshot has the same route and a different committed identity.
        await view.ownerPoll({ switchGeneration: "committed-after-aba", events: [turn, output, away, back] });
        assert.equal(view.panel(), null, "old consent cannot be silently rebound to the new generation");
        assert.deepEqual(view.route(), { engine: "claude-cli", model: "claude-sonnet-5-5" });
        assert.deepEqual([view.calls, view.choices], [[], []]);
        await view.choose("Conversation runtime", "codex-cli");
        if (running) { await view.click("Stop and switch"); await view.click("Stop and switch"); }
        else await view.click("Switch");
        assert.equal(view.calls.length, 1);
        assert.equal(view.calls[0].params.expectedSwitchGeneration, "committed-after-aba");
        if (running) assert.equal(view.calls[0].params.expectedTurnId, turn.id);
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  await t.test("while this conversation works, Wait does nothing and Stop and switch confirms, then hands the switch to the host", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ running: true });
    try {
      assert.equal(view.disabled(), false, "the picker stays open so Stop and switch is reachable");
      await view.choose("Claude Code", "Opus 5.5");
      assert.equal(view.panel(), "This conversation is working. Wait for the current request to finish, or stop it and switch to "
        + "Claude Code Opus 5.5.WaitStop and switch");
      await view.click("Wait");
      assert.equal(view.panel(), null);
      await view.choose("Claude Code", "Opus 5.5");
      await view.click("Stop and switch");
      assert.equal(view.panel(), "Stop and switch to Claude Code Opus 5.5? The current request will be cancelled. "
        + "Completed work stays in this conversation and the workspace. " + transfer + "Stop and switchKeep working");
      assert.deepEqual(view.calls, []);
      await view.click("Stop and switch");
      // One request. The host records the target, stops the run, and applies the switch when the run leaves it.
      assert.deepEqual(view.calls, [{ name: "vivary-code-switch",
        params: { projectId: undefined, runId: "retained-run", engine: "claude-cli", model: "claude-opus-5-5", stop: true, expectedSwitchGeneration: null, expectedTurnId: null } }]);
      assert.equal(view.settled, 1, "the parent reloads the run, which now carries the recorded target");
      await view.ownerPoll({ status: "running", phase: "stopping", pendingSwitch: { engine: "claude-cli", model: "claude-opus-5-5" } });
      assert.equal(view.panel(), "Stopping the current request. This conversation then switches to Claude Code Opus 5.5.");
      assert.equal(view.disabled(), true);
      await view.ownerPoll({ status: "paused", phase: "paused", model: "claude-opus-5-5", pendingSwitch: null, switchGeneration: "fixture-applied-pending" });
      assert.equal(view.panel(), null);
      assert.equal(view.disabled(), false);
      assert.equal(view.calls.length, 1, "the view sends nothing more after the stop");
    } finally { await view.unmount(); server(); }
  });

  await t.test("a recorded Stop and switch shows again after a reload, before the run stops", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ running: true, pendingSwitch: { engine: "codex-cli", model: "gpt-other" } });
    try {
      assert.equal(view.panel(), "Stopping the current request. This conversation then switches to Codex GPT Other.");
      assert.equal(view.disabled(), true);
      assert.deepEqual(view.calls, []);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a reloaded pending model remains visible as a disabled retained option after catalog drift", async () => {
    const server = installChatServer();
    const target = { engine: "codex-cli", model: "gpt-retired-recorded-target" };
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true, pendingSwitch: target });
      assert.deepEqual(view.route(), target);
      assert.equal(view.disabled(), true);
      assert.match(view.pickerLabel(), /gpt-retired-recorded-target/);
      assert.equal(view.panelMessage(), "Stopping the current request. This conversation then switches to Codex gpt-retired-recorded-target.");
      assert.notEqual(view.sendDisabled(), false);
      assert.deepEqual([view.calls, view.choices], [[], []]);
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  for (const pending of [
    { name: "runtime", target: { engine: "codex-cli", model: "gpt-other" }, label: "Codex GPT Other" },
    { name: "same-engine model", target: { engine: "claude-cli", model: "claude-opus-5-5" }, label: "Claude Code Opus 5.5" },
  ]) {
    await t.test(`PR258 4331141818: reopening a durable ${pending.name} target displays it in the disabled picker`, { timeout: 10_000 }, async () => {
      const server = installChatServer();
      let view;
      try {
        // Only the server pending marker names the target. The recorded current route stays Claude Sonnet.
        view = await proof.renderCodeSwitch({ running: true, pendingSwitch: pending.target });
        assert.deepEqual(view.route(), pending.target, "the picker must show the durable target after reopen");
        assert.equal(view.pickerLabel(), "Runtime and model: " + pending.label);
        assert.equal(view.disabled(), true);
        assert.equal(view.panelMessage(), "Stopping the current request. This conversation then switches to " + pending.label + ".");
        assert.deepEqual([view.calls, view.choices], [[], []], "mounting neither switches nor saves an unaccepted route");
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  await t.test("PR258 4331141818 control: reopening without a pending target displays the unchanged current route", async () => {
    const server = installChatServer();
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true });
      assert.deepEqual(view.route(), { engine: "claude-cli", model: "claude-sonnet-5-5" });
      assert.equal((await view.options("Claude Code")).includes("GPT Other"), false);
      assert.equal(view.disabled(), false);
      assert.equal(view.panel(), null);
      assert.deepEqual([view.calls, view.choices], [[], []]);
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("a turn that finishes during the choice needs only the plain confirm", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ running: true });
    try {
      await view.choose("Codex", "GPT Fixture");
      assert.match(view.panel(), /^This conversation is working\./);
      await view.update({ status: "completed", phase: "complete" });
      assert.match(view.panel(), /^Switch this conversation from Claude Code Sonnet 5\.5 to Codex GPT Fixture\?/);
      assert.deepEqual(view.calls, []);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a finished turn clears its Stop confirmation before another turn starts", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ running: true });
    try {
      await view.choose("Conversation model", "claude-opus-5-5");
      await view.click("Stop and switch");
      assert.match(view.panel() ?? "", /^Stop and switch to Claude Code Opus 5\.5\?/);
      await view.update({ status: "completed", phase: "complete" });
      assert.match(view.panel() ?? "", /^Switch this conversation from Claude Code Sonnet 5\.5 to Claude Code Opus 5\.5\?/);
      assert.deepEqual(view.buttons(), ["Switch", "Cancel"]);
      await view.update({ status: "running", phase: "running" });
      assert.match(view.panel() ?? "", /^This conversation is working\./);
      assert.deepEqual(view.buttons(), ["Wait", "Stop and switch"], "the next turn needs a new Stop choice");
      assert.deepEqual([view.calls, view.choices], [[], []], "polling never confirms a switch");
      await view.click("Wait");
      assert.equal(view.panel(), null);
      assert.deepEqual([view.calls, view.choices], [[], []], "Wait leaves the current route alone");
    } finally { await view.unmount(); server(); }
  });

  await t.test("PR258 4330509930: a new canonical turn demotes an earlier Stop confirmation without an idle poll", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const turnA = codeTranscriptEvent("turn-a-user", "user", "Work on turn A.", 0);
    const answerA = codeTranscriptEvent("turn-a-answer", "assistant", "Starting turn A.", 1);
    let view;
    try {
      view = await proof.renderCodeSwitch({ running: true, events: [turnA, answerA] });
      await view.choose("Conversation model", "claude-opus-5-5");
      await view.click("Stop and switch");
      const confirmation = view.panelMessage();
      assert.equal(confirmation, "Stop and switch to Claude Code Opus 5.5? The current request will be cancelled. "
        + "Completed work stays in this conversation and the workspace. " + transfer);
      assert.deepEqual(view.buttons(), ["Stop and switch", "Keep working"]);
      const tokenA = codeTranscriptEvent("turn-a-token", "assistant", "More output from turn A.", 2);
      const statusA = codeTranscriptEvent("turn-a-status", "status", "Still working on turn A.", 3);
      await view.update({ status: "running", phase: "running", updatedAt: "2026-10-20T00:03:30.000Z",
        events: [turnA, answerA, tokenA, statusA] });
      assert.equal(view.panelMessage(), confirmation, "same-turn output and status do not revoke the Stop choice");
      assert.deepEqual(view.buttons(), ["Stop and switch", "Keep working"]);
      assert.deepEqual([view.calls, view.choices], [[], []]);
      const turnB = codeTranscriptEvent("turn-b-user", "user", "Work on turn B.", 4);
      // A single poll crosses the turn boundary. Status and phase remain working throughout the observed frames.
      await view.update({ status: "running", phase: "running", updatedAt: "2026-10-20T00:04:00.000Z",
        events: [turnA, answerA, tokenA, statusA, turnB] });
      assert.equal(view.panelMessage(), "This conversation is working. Wait for the current request to finish, or stop it and switch to "
        + "Claude Code Opus 5.5.");
      assert.deepEqual(view.buttons(), ["Wait", "Stop and switch"], "turn B requires a fresh Stop choice");
      assert.deepEqual([view.calls, view.choices], [[], []], "the stale confirmation cannot stop turn B");
      await view.click("Stop and switch");
      assert.equal(view.panelMessage(), confirmation);
      assert.deepEqual(view.calls, [], "the new turn still needs its own confirmation");
      await view.click("Stop and switch");
      assert.deepEqual(view.calls, [{ name: "vivary-code-switch",
        params: { projectId: undefined, runId: "retained-run", engine: "claude-cli", model: "claude-opus-5-5", stop: true, expectedSwitchGeneration: null, expectedTurnId: turnB.id } }]);
    } finally { try { await view?.unmount(); } finally { server(); } }
  });

  await t.test("a turn that starts during an idle choice changes the legal confirmation actions", { timeout: 10_000 }, async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch();
    try {
      await view.choose("Conversation runtime", "codex-cli");
      assert.match(view.panel() ?? "", /^Switch this conversation from Claude Code Sonnet 5\.5 to Codex GPT Fixture\?/);
      assert.deepEqual(view.buttons(), ["Switch", "Cancel"]);
      // Polling can reveal a turn started by another window after the owner made this choice.
      await view.update({ status: "running", phase: "running" });
      assert.equal(view.panelMessage(), "This conversation is working. Wait for the current request to finish, or stop it and switch to "
        + "Codex GPT Fixture.");
      assert.deepEqual(view.buttons(), ["Wait", "Stop and switch"], "an idle Switch is no longer legal");
      assert.deepEqual([view.calls, view.choices], [[], []], "polling changes disclosure without issuing an action");
      await view.click("Wait");
      assert.equal(view.panel(), null);
      assert.deepEqual(view.route(), { engine: "claude-cli", model: "claude-sonnet-5-5" });
      assert.deepEqual([view.calls, view.choices], [[], []], "Wait leaves the running route alone");
      await view.choose("Conversation runtime", "codex-cli");
      await view.click("Stop and switch");
      assert.match(view.panel() ?? "", /^Stop and switch to Codex GPT Fixture\? The current request will be cancelled\./);
      assert.deepEqual(view.calls, [], "stopping requires its own confirmation");
      await view.click("Stop and switch");
      assert.deepEqual(view.calls, [{ name: "vivary-code-switch",
        params: { projectId: undefined, runId: "retained-run", engine: "codex-cli", model: "gpt-fixture", stop: true, expectedSwitchGeneration: null, expectedTurnId: null } }]);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a refused switch keeps the route and shows the server's reason", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ refuse: "This conversation is still stopping. Switch after it stops." });
    try {
      await view.choose("Codex", "GPT Fixture");
      await view.click("Switch");
      assert.match(view.text(), /This conversation is still stopping\. Switch after it stops\./);
      assert.deepEqual(view.choices, []);
      assert.equal(view.panel(), null);
      await view.click("Dismiss");
      assert.doesNotMatch(view.text(), /still stopping/);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a read-only history view cannot switch", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ viewingMatch: true });
    try {
      assert.equal(view.disabled(), true);
    } finally { await view.unmount(); server(); }
  });

  await t.test("the picker lists models grouped by runtime, with the current route checked", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch();
    try {
      const groups = await view.groups();
      assert.deepEqual(groups.map(group => group.heading), ["Claude Code", "Codex"]);
      assert.deepEqual(groups[0].items.map(item => item.label), ["Sonnet 5.5", "Haiku 5.5", "Opus 5.5", "Fable 5.1"]);
      assert.deepEqual(groups[0].items.filter(item => item.checked).map(item => item.label), ["Sonnet 5.5"]);
      assert.deepEqual(groups[1].items.map(item => [item.label, item.checked, item.disabled]),
        [["GPT Fixture", false, false], ["GPT Other", false, false]]);
      assert.ok(groups.every(group => group.items.every(item => item.reachable)), "arrow keys and typeahead reach every model");
      assert.equal(view.menuOpen(), false, "Enter on the trigger closes the menu again");
    } finally { await view.unmount(); server(); }
  });

  await t.test("on a new conversation a choice selects that runtime and model without a switch", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ retained: false });
    try {
      await view.choose("Codex", "GPT Other");
      assert.deepEqual(view.choices, [{ engine: "codex-cli", model: "gpt-other" }]);
      assert.equal(view.panel(), null, "no switch confirm for a conversation that has not started");
      assert.deepEqual(view.calls, []);
      assert.equal(view.pickerLabel(), "Runtime and model: Codex GPT Other");
      assert.equal(view.menuOpen(), false, "choosing closes the menu");
    } finally { await view.unmount(); server(); }
  });

  await t.test("an unavailable runtime keeps its heading and reason, and offers nothing to choose", async () => {
    const server = installChatServer();
    for (const retained of [false, true]) {
      const view = await proof.renderCodeSwitch({ retained, codexReady: false });
      try {
        const codex = (await view.groups()).find(group => group.heading.startsWith("Codex"));
        assert.equal(codex.heading, "CodexSign in required");
        assert.deepEqual(codex.items.map(item => [item.label, item.disabled]), [["No models available", true]]);
      } finally { await view.unmount(); }
    }
    server();
  });

  await t.test("the keyboard opens the picker, Escape closes it, and Enter on a model asks to switch", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch();
    try {
      await view.open();
      assert.equal(view.menuOpen(), true);
      await view.escapeMenu();
      assert.equal(view.menuOpen(), false);
      await view.choose("Codex", "GPT Fixture", { keyboard: true });
      assert.equal(view.menuOpen(), false);
      assert.match(view.panel(), /^Switch this conversation from Claude Code Sonnet 5\.5 to Codex GPT Fixture\?/);
      assert.deepEqual(view.calls, [], "nothing is sent before the confirm");
    } finally { await view.unmount(); server(); }
  });

  for (const [label, running] of [["Switch", false], ["Stop and switch", true]]) {
    const consent = async view => { await view.choose(); if (running) await view.click("Stop and switch"); };
    await t.test("replay authority: entering history blocks existing " + label + " consent", async () => {
      const server = installChatServer();
      let view;
      try {
        view = await proof.renderReplayOwner({ running });
        await consent(view);
        const before = view.authoritative();
        assert.ok(view.panel(), "consent exists before the router transition");
        await view.click("Open history replay");
        assert.equal(new URLSearchParams(view.location()).get("event"), "replay-turn-a");
        assert.equal(view.selectorsDisabled(), true);
        await view.clickReplayActions();
        assert.deepEqual(view.calls, [], "visible replay controls must not mutate the live conversation");
        assert.deepEqual(view.authoritative(), before);
        assert.equal(view.rememberedChoice(), null);
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
    await t.test("replay authority: returning to latest discards " + label + " consent", async () => {
      const server = installChatServer();
      let view;
      try {
        view = await proof.renderReplayOwner({ running });
        await consent(view);
        const before = view.authoritative();
        await view.click("Open history replay");
        await view.click("Return to latest conversation");
        assert.equal(new URLSearchParams(view.location()).get("event"), null);
        assert.equal(view.panel(), null, "leaving replay must not revive unsubmitted consent");
        assert.deepEqual(view.calls, []);
        assert.deepEqual(view.authoritative(), before);
        await consent(view);
        assert.ok(view.panel(), "a fresh choice remains possible");
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
    await t.test("replay authority: fresh latest-view " + label + " reaches the current action", async () => {
      const server = installChatServer();
      let view;
      try {
        view = await proof.renderReplayOwner({ running });
        await consent(view);
        await view.click(label);
        assert.deepEqual(view.calls, [{ name: "vivary-code-switch", params: {
          projectId: undefined, runId: "retained-run", engine: "codex-cli", model: "gpt-fixture",
          expectedSwitchGeneration: null, ...(running ? { stop: true, expectedTurnId: "replay-turn-a" } : {}),
        } }]);
        assert.equal(view.authoritative().otherStatus, "running");
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  for (const workspaceAvailable of [true, false]) {
    await t.test("replay authority: latest-view Stop keeps its selected owner with folder " + workspaceAvailable, async () => {
      const server = installChatServer();
      let view;
      try {
        view = await proof.renderReplayOwner({ running: true });
        await view.setWorkspaceAvailable(workspaceAvailable);
        assert.equal(view.stopAvailable(), true);
        await view.stop();
        assert.deepEqual(view.calls, [{ name: "vivary-code-stop", params: { projectId: undefined, runId: "retained-run" } }]);
        assert.equal(view.authoritative().status, "paused");
        assert.equal(view.authoritative().otherStatus, "running");
        assert.deepEqual(view.ownerActiveIds(), ["other-active-run"], "the owner refetch keeps the unrelated worker active");
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
    await t.test("replay authority: history never stops a live run with folder " + workspaceAvailable, async () => {
      const server = installChatServer();
      let view;
      try {
        view = await proof.renderReplayOwner({ running: true });
        await view.setWorkspaceAvailable(workspaceAvailable);
        const before = view.authoritative();
        await view.click("Open history replay");
        await view.clickReplayActions();
        assert.deepEqual(view.calls, []);
        assert.deepEqual(view.authoritative(), before);
      } finally { try { await view?.unmount(); } finally { server(); } }
    });
  }

  await t.test("another conversation's run, in this folder or elsewhere, locks nothing in a new conversation", async () => {
    const server = installChatServer();
    // The caller's runs as the Code state lists them: one in this folder, one in another project's folder.
    const here = { id: "other-run", title: "Write the parser tests", status: "running", phase: "running", projectId: null,
      workspaceLabel: "Fixture project", engineLabel: "Claude Code", model: "claude-sonnet-5-5", stopping: false, pendingApprovals: [] };
    const elsewhere = { ...here, id: "far-run", title: "Tidy the docs", projectId: "project-far", workspaceLabel: "Far project" };
    try {
      const fresh = await proof.renderCodeWorkspace({ selection: { key: "new-draft", runId: null },
        activeRuns: [here, elsewhere], folderRuns: [OTHER_RUN] });
      assert.equal(fresh.disabled, false, "the runtime and model stay open");
      assert.equal(fresh.stop, false, "no Stop for another conversation's run");
      assert.deepEqual(fresh.badges, ["2 other conversations working"]);
      assert.deepEqual(fresh.sharedRuns, ["Write the parser testsOpen"], "the same-folder run shows the warning, not a lock");
      const apart = await proof.renderCodeWorkspace({ selection: { key: "new-draft", runId: null }, activeRuns: [elsewhere] });
      assert.equal(apart.disabled, false);
      assert.equal(apart.stop, false);
      assert.equal(apart.composerLocked, false, "Send is open");
      assert.deepEqual(apart.badges, ["1 other conversation working"]);
      assert.deepEqual(apart.sharedRuns, []);
      // The conversation's own run locks its composer, beside the same other runs.
      const mine = { ...here, id: "own-run", title: "This conversation" };
      const own = await proof.renderCodeWorkspace({ selection: { key: "own-draft", runId: "own-run" },
        activeRuns: [here, mine, elsewhere], folderRuns: [OTHER_RUN, { id: "own-run", title: "This conversation", turnId: "turn-own-1" }] });
      assert.equal(own.stop, true, "its own turn holds the composer behind its Stop");
      assert.deepEqual(own.badges, ["Working"]);
      assert.deepEqual(own.sharedRuns, [], "a working conversation shows no shared-folder warning");
    } finally { server(); }
  });

  await t.test("beside another agent in this folder, the owner's warning holds Send until Proceed", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ folderRuns: [OTHER_RUN], folderPicker: true });
    try {
      assert.equal(view.warning(), SHARED_FOLDER_WARNING, "the warning is the owner's text");
      assert.equal(view.composerLocked(), true, "Send waits for a choice");
      assert.equal(view.disabled(), false, "the runtime and model stay open");
      assert.deepEqual(view.sharedRuns(), ["Write the parser testsOpen"]);
      assert.deepEqual(view.sharedButtons(), ["Open", "Proceed", "Use another folder", "Cancel", "Copy"]);
      assert.equal(view.command(), "git worktree add ../Fixture-project-worktree");
      await view.click("Use another folder");
      await view.click("Open");
      assert.deepEqual(view.opened, ["open-folder", OTHER_RUN.id], "isolation and Open use their own handlers");
      await view.click("Proceed");
      assert.equal(view.composerLocked(), false, "Proceed lets the owner send in this folder");
      assert.match(view.text(), /You chose to work in this folder beside them\./);
      assert.equal(view.warning(), SHARED_FOLDER_WARNING, "the warning stays while the other agent works");
      assert.deepEqual(view.calls, [], "the warning sends nothing by itself");
    } finally { await view.unmount(); server(); }
  });

  await t.test("Cancel or Escape closes the warning, sends nothing, keeps the draft, and returns focus to the composer", async () => {
    const server = installChatServer();
    const originalFocus = window.HTMLElement.prototype.focus;
    let focused = null;
    window.HTMLElement.prototype.focus = function focus() { focused = this; };
    const inComposer = () => !!focused && (focused.classList?.contains("ProseMirror") || !!focused.closest?.(".ProseMirror"));
    const view = await proof.renderCodeSwitch({ folderRuns: [OTHER_RUN] });
    try {
      assert.deepEqual(view.sharedButtons(), ["Open", "Proceed", "Cancel", "Copy"]);
      assert.equal(view.composerLocked(), true);
      await view.click("Cancel");
      assert.equal(view.warning(), null, "Cancel closes the warning");
      assert.equal(view.composerLocked(), false, "the composer is usable again");
      assert.ok(inComposer(), "Cancel returns focus to the composer");
      await view.click("Try a file change");
      const draft = view.composerText();
      assert.ok(draft, "the composer holds a draft");
      focused = null;
      await view.setFolderRuns([OTHER_RUN, { id: "later-run", title: "Update the changelog", projectId: null, turnId: "turn-later-1" }]);
      assert.equal(view.warning(), SHARED_FOLDER_WARNING, "a conversation that starts later asks again");
      assert.equal(view.composerLocked(), true);
      await view.escape();
      assert.equal(view.warning(), null, "Escape closes the warning");
      assert.equal(view.composerText(), draft, "the draft stays");
      assert.ok(inComposer(), "Escape returns focus to the composer");
      assert.deepEqual(view.calls, [], "Cancel and Escape send nothing");
    } finally {
      window.HTMLElement.prototype.focus = originalFocus;
      await view.unmount(); server();
    }
  });

  await t.test("a later turn of a conversation that was acknowledged asks again", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ folderRuns: [OTHER_RUN] });
    try {
      await view.click("Proceed");
      assert.equal(view.composerLocked(), false, "Proceed covers the first turn");
      await view.setFolderRuns([]);
      assert.equal(view.warning(), null, "the other conversation finished");
      await view.setFolderRuns([{ ...OTHER_RUN, turnId: "turn-other-2" }]);
      assert.equal(view.warning(), SHARED_FOLDER_WARNING, "its next turn asks again");
      assert.equal(view.composerLocked(), true);
      assert.ok(view.sharedButtons().includes("Proceed"));
    } finally { await view.unmount(); server(); }
  });

  await t.test("the warning names no title for another owner's run and offers only the worktree hint without a folder picker", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ folderRuns: [{ id: "foreign-run", title: null, projectId: null, turnId: "turn-foreign-1" }] });
    try {
      assert.deepEqual(view.sharedRuns(), ["A conversation of another user"]);
      assert.deepEqual(view.sharedButtons(), ["Proceed", "Cancel", "Copy"]);
      assert.match(view.text(), /connect the new folder as a project/);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a conversation that is itself working shows no shared-folder warning", async () => {
    const server = installChatServer();
    const view = await proof.renderCodeSwitch({ running: true, folderRuns: [OTHER_RUN] });
    try {
      assert.equal(view.warning(), null);
    } finally { await view.unmount(); server(); }
  });

  await t.test("a discovered native Claude version enables Send for current models", async () => {
    const server = installChatServer();
    try {
      const unknown = await proof.renderWorkbenchComposer({ model: "claude-haiku-5-5", version: null });
      assert.equal(unknown.disabled[1], true);
      assert.equal(unknown.exampleDisabled, true, "unknown version refuses work independently of the empty draft");
      const supported = await proof.renderWorkbenchComposer({ model: "claude-haiku-5-5", version: "2.1.300", prefill: true });
      assert.equal(supported.disabled[1], false);
      assert.equal(supported.model, "Haiku 5.5");
      assert.deepEqual(supported.choices, [], "version discovery preserves the selected model");
    } finally { server(); }
  });

  const scope = { type: "workspace-app", id: "unassigned-owner" };
  const projectScope = { type: "workspace-app", id: "project-owner" };
  const old = Date.now() - 13 * 60 * 60 * 1000;
  const savedRow = (id, currentScope, text) => ({ id, title: "Saved selection", createdAt: old, updatedAt: old,
    scope: currentScope, messageCount: 1, threadData: JSON.stringify({ headId: id + "-message", messages: [
      { parentId: null, message: { id: id + "-message", role: "user", content: [{ type: "text", text }] } },
    ] }) });
  const rows = [savedRow("old-unassigned", scope, "Retained Unassigned selection"),
    savedRow("old-project", projectScope, "Retained project selection")];
  for (const selected of rows) for (const transition of [false, true]) {
    const other = rows.find(row => row.id !== selected.id);
    await t.test("an explicit old " + selected.id + " selection survives initial list completion" + (transition ? " after a scope transition" : ""), async () => {
      localStorage.clear(); sessionStorage.clear();
      const server = installSelectionServer(rows);
      try {
        const snapshot = await proof.inspectInitialSelection({ threadId: selected.id, scope: selected.scope,
          ...(transition ? { transition: { threadId: other.id, scope: other.scope } } : {}) });
        assert.equal(snapshot.route, selected.id, "initialization must not replace the selected ID with an empty UUID");
        assert.equal(snapshot.active, selected.id);
        assert.match(snapshot.text, new RegExp(selected.id === "old-unassigned" ? "Retained Unassigned selection" : "Retained project selection"));
        assert.doesNotMatch(snapshot.text, new RegExp(selected.id === "old-unassigned" ? "Retained project selection" : "Retained Unassigned selection"));
        assert.deepEqual(snapshot.navigations, [], "selected history must not create or navigate to a replacement");
        assert.equal(server.modelSubmits, 0);
      } finally { server.close(); }
    });
  }
  for (const selected of rows) await t.test("without explicit selection the ordinary stale " + selected.id + " chat still starts fresh", async () => {
    localStorage.clear(); sessionStorage.clear();
    const server = installSelectionServer(rows);
    try {
      const snapshot = await proof.inspectInitialSelection({ threadId: selected.id, scope: selected.scope, explicit: false });
      assert.ok(snapshot.active && snapshot.active !== selected.id);
      assert.equal(snapshot.route, null);
      assert.doesNotMatch(snapshot.text, /Retained (?:Unassigned|project) selection/);
      assert.equal(server.modelSubmits, 0);
    } finally { server.close(); }
  });

  // Issue #101.
  await t.test("a provider stream error shows its message and a Retry, and does not continue on its own", async () => {
    const card = await proof.renderRunError({ type: "error", error: "Provider returned error (code 502)",
      errorCode: "provider_stream_error" });
    assert.equal(card.action, "error", "the client ends the turn instead of continuing it");
    assert.match(card.text, /Provider returned error \(code 502\)/);
    assert.equal(card.retry, true, "Retry is offered");
    assert.equal(card.retries, 1, "Retry reaches the chat's retry handler");
  });

  await t.test("two quick clicks on Retry queue one retry turn, and the next error offers Retry again", async () => {
    const clicks = await proof.retryCardTwiceThenAgain({ type: "error", error: "Provider returned error (code 502)",
      errorCode: "provider_stream_error" });
    assert.deepEqual(clicks, { afterDoubleClick: 1, afterNextError: 2 });
  });

  await t.test("the inline notice offers Retry for a provider stream error on the last message only", async () => {
    const info = { message: "Provider returned error (code 502)", errorCode: "provider_stream_error" };
    assert.equal(typeof proof.shouldOfferInlineRunErrorRetry, "function", "the message's inline Retry rule is exported");
    const last = await proof.renderInlineNotice(info, true);
    assert.match(last.text, /Provider returned error \(code 502\)/);
    assert.deepEqual({ retry: last.retry, retries: last.retries }, { retry: true, retries: 1 });
    assert.equal((await proof.renderInlineNotice(info, false)).retry, false, "an earlier message keeps no Retry");
    const unclassified = await proof.renderInlineNotice({ message: "The request was refused.", errorCode: "probe_unclassified" }, true);
    assert.equal(unclassified.retry, false, "an unclassified error keeps no Retry");
  });

  await t.test("two quick clicks on the inline notice's Retry queue one retry turn, and the next error offers Retry again", async () => {
    const clicks = await proof.retryInlineTwiceThenAgain({ message: "Provider returned error (code 502)", errorCode: "provider_stream_error" });
    assert.deepEqual(clicks, { afterDoubleClick: 1, afterNextError: 2 });
  });

  // A provider name that reads as a rejected key would swap the error card for the provider setup card.
  await t.test("a provider name that reads as an HTTP status is left out, and the error card stays", async () => {
    const [stop] = translate.aiSdkPartToEngineEvents({ type: "error", error: { code: 502, message: "Provider returned error",
      metadata: { provider_name: "401 unauthorized" } } }, new Map());
    const card = await proof.renderRunError({ type: "error", error: stop.error, errorCode: stop.errorCode });
    assert.deepEqual({ error: stop.error, errorCard: card.text.includes(stop.error), retry: card.retry },
      { error: "Provider returned error (code 502)", errorCard: true, retry: true });
  });

  // Issue #246. The server saves a partial reply whose in-stream 429 exhausted the engine's retries,
  // from the run's events as the chat plugin does when no server continuation follows. A client save
  // of a copy with no error follows, then a reload reads the saved reply.
  await t.test("a saved reply that ended in an exhausted 429 shows its error with a Retry after a reload", async () => {
    const runId = "run-246";
    const turnId = "turn-246";
    const attempt = [{ type: "text", text: "Partial" }];
    const events = [...attempt, { type: "clear" }, ...attempt, { type: "clear" }, ...attempt, { type: "clear" }, ...attempt,
      { type: "error", error: "Rate limit exceeded (code 429)", errorCode: "http_429" }].map((event, seq) => ({ seq, event }));
    const saved = threads.buildAssistantMessage(events, runId, { suppressInternalContinuation: true, continuationFollows: false, turnId });
    const question = { id: "user-1", role: "user", content: [{ type: "text", text: "Hello" }] };
    const serverRepo = threads.foldAssistantTurn({ messages: [{ message: question, parentId: null }], headId: "user-1" }, saved,
      { runId, turnId, parentId: "user-1" });
    const clientCopy = { id: "client-reply", role: "assistant", status: { type: "complete", reason: "stop" },
      content: [{ type: "reasoning", text: "Thinking." }, { type: "text", text: "Partial" }], metadata: { runId, custom: { runId, turnId } } };
    const merged = threads.mergeThreadDataForClientSave(serverRepo, { messages: [{ message: question, parentId: null },
      { message: clientCopy, parentId: "user-1" }], headId: "client-reply" });
    const reply = merged.messages.at(-1)?.message;
    assert.deepEqual({ status: reply?.status, shown: await proof.renderSavedRunError(reply) }, {
      status: { type: "incomplete", reason: "error" },
      shown: { errorCode: "http_429", recoverable: true, cardRetry: true, inlineRetry: true },
    });
    // The whole chat reloads that thread and shows the partial reply with the error card's Retry.
    const restoreFetch = installChatServer({ "thread-partial-limited": JSON.stringify(merged) });
    try {
      assert.deepEqual(await proof.reloadThreadWithError("thread-partial-limited", ["Hello", "Partial"]),
        { notices: [], order: ["Hello", "Partial"], cardRetry: true });
    } finally {
      restoreFetch();
    }
  });

  // Issue #246 follow-up. The 429 arrived before any text, so the saved reply holds only its error. A client
  // save of the cancelled empty copy follows, then the chat reloads the thread.
  await t.test("a saved reply with no text that ended in an exhausted 429 shows its error card with a Retry after a reload", async () => {
    const createdAt = new Date("2026-10-18T00:00:00Z").toISOString();
    const earlier = [
      { parentId: null, message: { id: "user-earlier", role: "user", content: [{ type: "text", text: "Earlier question" }], createdAt } },
      { parentId: "user-earlier", message: { id: "reply-earlier", role: "assistant", createdAt,
        content: [{ type: "text", text: "Finished earlier answer" }], status: { type: "complete", reason: "stop" },
        metadata: { runId: "run-earlier", custom: { runId: "run-earlier", turnId: "turn-earlier" } } } },
      { parentId: "reply-earlier", message: { id: "user-limited", role: "user", content: [{ type: "text", text: "Rate limited question" }],
        createdAt } },
    ];
    const limited = { runId: "run-limited", turnId: "turn-limited" };
    const events = [{ type: "clear" }, { type: "clear" }, { type: "clear" },
      { type: "error", error: "Rate limit exceeded (code 429)", errorCode: "http_429" }].map((event, seq) => ({ seq, event }));
    const serverTurn = threads.buildAssistantMessage(events, limited.runId,
      { suppressInternalContinuation: true, continuationFollows: false, turnId: limited.turnId });
    const serverRepo = serverTurn
      ? threads.foldAssistantTurn({ headId: "user-limited", messages: earlier }, serverTurn, { ...limited, parentId: "user-limited" })
      : { headId: "user-limited", messages: earlier };
    const saved = threads.mergeThreadDataForClientSave(serverRepo, { headId: "client-reply", messages: [...earlier,
      { parentId: "user-limited", message: { id: "client-reply", role: "assistant", content: [], createdAt,
        status: { type: "incomplete", reason: "error" }, metadata: { runId: limited.runId, custom: { ...limited } } } }] });
    const reply = saved.messages.at(-1)?.message;
    const restoreFetch = installChatServer({ "thread-limited": JSON.stringify(saved) });
    try {
      const shown = await proof.renderSavedRunError(reply);
      assert.deepEqual({
        reply: { role: reply?.role, status: reply?.status },
        gates: shown && { recoverable: shown.recoverable, cardRetry: shown.cardRetry, inlineRetry: shown.inlineRetry },
        reloaded: await proof.reloadThreadWithError("thread-limited", ["Earlier question", "Finished earlier answer", "Rate limited question"]),
      }, {
        reply: { role: "assistant", status: { type: "incomplete", reason: "error" } },
        gates: { recoverable: true, cardRetry: true, inlineRetry: true },
        reloaded: { notices: [], order: ["Earlier question", "Finished earlier answer", "Rate limited question"], cardRetry: true },
      });
    } finally {
      restoreFetch();
    }
  });

  await t.test("an unclassified error still has no Retry", async () => {
    const card = await proof.renderRunError({ type: "error", error: "The request was refused.",
      errorCode: "probe_unclassified" });
    assert.equal(card.action, "error");
    assert.match(card.text, /The request was refused\./);
    assert.equal(card.retry, false);
  });

  // Issue #131.
  await t.test("every entry in a sidebar row menu opened from the keyboard is a Radix menu item", async () => {
    assert.deepEqual(await proof.renderRowMenu(), [
      { name: "Rename", reachable: true }, { name: "Pin to top", reachable: true }, { name: "Archive", reachable: true }]);
  });

  // Issue #147.
  await t.test("text handed back to the composer does not pull focus out of another field", async () => {
    assert.deepEqual(await proof.restoreComposerText(false, "field before the frame"),
      { text: "One more question", focus: "other field" }, "a field focused before the composer's frame keeps focus");
    for (const how of ["initial text", "setText", "focus"]) {
      assert.deepEqual(await proof.restoreComposerText(true, how), { text: "One more question", focus: "other field" }, how);
      assert.deepEqual(await proof.restoreComposerText(false, how), { text: "One more question", focus: "composer" },
        `${how}: with no field in use, the composer still takes focus`);
    }
  });

  // Issue #102.
  await t.test("the composer's send button is named for its action", async () => {
    const idle = await proof.renderComposer(false);
    assert.equal(idle.editor, true, "the Tiptap editor mounts");
    assert.equal(idle.sendName, "Send message");
    assert.equal((await proof.renderComposer(true)).sendName, "Queue message");
  });

  // Issue #106. A reloaded thread holds a stopped reply with text, a finished reply, and a stopped
  // reply with text as the last message.
  await t.test("a stopped reply with text is labeled as stopped, also after a later turn", async () => {
    const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });
    const reply = (id, text, custom = {}) => ({ id, role: "assistant", content: [{ type: "text", text }],
      status: { type: "complete", reason: "stop" }, metadata: { custom } });
    const thread = await proof.renderSavedThread([
      user("user-1", "First question"), reply("reply-1", "Partial first answer", { userStopped: true }),
      user("user-2", "Second question"), reply("reply-2", "Finished second answer"),
      user("user-3", "Third question"), reply("reply-3", "Partial third answer", { userStopped: true }),
    ]);
    assert.deepEqual({
      replies: ["Partial first answer", "Finished second answer", "Partial third answer"].filter(text => thread.text.includes(text)),
      notices: thread.notices,
    }, {
      replies: ["Partial first answer", "Finished second answer", "Partial third answer"],
      notices: ["The agent stopped before finishing", "The agent stopped before finishing"],
    });
  });

  await t.test("a stopped reply that holds a missing-response warning shows the stopped notice instead", async () => {
    const thread = await proof.renderSavedThread([
      { id: "user-1", role: "user", content: [{ type: "text", text: "First question" }] },
      { id: "reply-1", role: "assistant", status: { type: "incomplete", reason: "cancelled" }, metadata: { custom: { userStopped: true } },
        content: [{ type: "text", text: "Partial first answer" },
          { type: "text", text: "The agent stopped without sending a final message. Ask the agent to continue or retry." }] },
    ]);
    assert.deepEqual({ warning: thread.text.includes("without sending a final message"), notices: thread.notices },
      { warning: false, notices: ["The agent stopped before finishing"] });
  });

  // The live chat keeps its own copy of a stopped reply. assistant-ui writes the cancelled run back over it
  // without the flag, so the notice rests on the chat's record of the runs the owner stopped.
  const notice = "The agent stopped before finishing";
  await t.test("a stopped live reply keeps its notice after the owner sends the next message", async () => {
    const restoreFetch = installChatServer();
    try {
      assert.deepEqual(await proof.stopThenSendAnother(), {
        afterStop: { notices: [notice], order: ["Partial first answer", notice] },
        afterNextTurn: { notices: [notice], order: ["Partial first answer", notice, "Finished second answer"] },
      });
    } finally {
      restoreFetch();
    }
  });

  // A reloaded chat renders a run it follows outside the saved messages until the run is saved.
  await t.test("a Stop while following a run leaves the previous finished reply unlabeled", async () => {
    const restoreFetch = installChatServer();
    try {
      assert.deepEqual(await proof.stopWhileFollowingRun(), { notices: [], order: ["Finished old answer", "Live partial answer"] });
    } finally {
      restoreFetch();
    }
  });

  // The owner stopped the second turn before the model sent anything. The server saves the turn from the run's
  // entries as onRunComplete does, only when it builds one, and the client then saves its cancelled copy of the
  // reply, which has no content and no flag. The reload reads the thread that results.
  await t.test("a reply stopped before any content shows its notice after a reload, and the history stays", async () => {
    const createdAt = new Date("2026-09-28T00:00:00Z").toISOString();
    const earlier = [
      { parentId: null, message: { id: "user-earlier", role: "user", content: [{ type: "text", text: "Earlier question" }], createdAt } },
      { parentId: "user-earlier", message: { id: "reply-earlier", role: "assistant", createdAt,
        content: [{ type: "text", text: "Finished earlier answer" }], status: { type: "complete", reason: "stop" },
        metadata: { runId: "run-earlier", custom: { runId: "run-earlier", turnId: "turn-earlier" } } } },
      { parentId: "reply-earlier", message: { id: "user-stopped", role: "user", content: [{ type: "text", text: "Stopped question" }],
        createdAt } },
    ];
    const stopped = { runId: "run-stopped", turnId: "turn-stopped" };
    const serverTurn = threads.buildAssistantMessage([{ seq: 0, event: { type: "done", reason: "user" } }], stopped.runId,
      { suppressInternalContinuation: true, turnId: stopped.turnId });
    const serverRepo = serverTurn
      ? threads.foldAssistantTurn({ headId: "user-stopped", messages: earlier }, serverTurn, { ...stopped, parentId: "user-stopped" })
      : { headId: "user-stopped", messages: earlier };
    const saved = threads.mergeThreadDataForClientSave(serverRepo, { headId: "client-reply", messages: [...earlier,
      { parentId: "user-stopped", message: { id: "client-reply", role: "assistant", content: [], createdAt,
        status: { type: "incomplete", reason: "cancelled" }, metadata: { runId: stopped.runId, custom: { ...stopped } } } }] });
    const restoreFetch = installChatServer({ "thread-stopped": JSON.stringify(saved) });
    try {
      assert.deepEqual(await proof.reloadThread("thread-stopped", ["Earlier question", "Finished earlier answer", "Stopped question"]),
        { notices: [notice], order: ["Earlier question", "Finished earlier answer", "Stopped question", notice] });
    } finally {
      restoreFetch();
    }
  });

  // Issue #103. Yesterday a paid model cost 12.30¢. Today a free model reported $0 and a model with no
  // price reported no cost.
  const figure = (costCents, calls, unknownCostCalls) => ({ costCents, calls, unknownCostCalls });
  const tokens = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const bucket = (key, ...cost) => ({ key, label: key, ...figure(...cost), ...tokens, activeUsers: 1, lastActiveAt: 0 });
  const usageMetrics = {
    billing: { unit: "usd", label: "Estimated spend", source: "estimated-provider-cost" },
    app: "vivary", appKey: "vivary", viewScope: "me", selectedUserEmail: null, availableUsers: [],
    sinceMs: 0, sinceDays: 30, generatedAt: 0,
    access: { viewerEmail: "owner@example.test", orgId: null, role: null, canViewWorkspace: false, totalUsers: 1 },
    totals: { ...figure(12.3, 3, 1), ...tokens, activeUsers: 1 },
    currentDay: { ...figure(0, 2, 1), credits: 0, tokens: 2400 },
    byLabel: [bucket("chat", 12.3, 3, 1)],
    byModel: [bucket("probe/paid-model", 12.3, 1, 0), bucket("probe/free-model", 0, 1, 0), bucket("probe/unpriced-model", 0, 1, 1)],
    daily: [{ date: "2026-09-26", ...figure(12.3, 1, 0), tokens: 1200 }, { date: "2026-09-27", ...figure(0, 2, 1), tokens: 2400 }],
    recent: [],
  };

  await t.test("the Usage tab shows an unknown cost as Unknown and adds only known costs", async () => {
    const usage = await proof.renderUsage(usageMetrics);
    assert.deepEqual({
      total: usage.text.match(/Estimated spend(.*?)30 day lookback/)?.[1],
      today: usage.text.match(/Daily trend(.*?) used today/)?.[1],
      models: usage.models,
    }, {
      total: "12.30¢ + 1 unknown",
      today: "0.00¢ + 1 unknown",
      models: { "probe/paid-model": "12.30¢", "probe/free-model": "0.00¢", "probe/unpriced-model": "Unknown" },
    });
  });

  // Today's only priced call was free. A token alert counts tokens, which are known for every call.
  await t.test("a cost alert shows the calls whose cost is unknown beside its figure", async () => {
    const rule = (id, unit, limit, current) => ({ id, appId: null, scope: "user", unit, period: "day", limit, channels: ["in-app"],
      enabled: true, isDefault: false, status: "ok", current, unknownCostCalls: 1, percent: 0, windowStart: 0, windowEnd: 0,
      dismissedAt: null, updatedAt: 0 });
    const usage = await proof.renderUsage(usageMetrics, [rule("probe-usd", "usd", 5, 0), rule("probe-tokens", "tokens", 1_000_000, 2400)]);
    assert.deepEqual(usage.alerts, ["$0.00 + 1 unknown of $5.00 · per day", "2,400 tokens of 1,000,000 tokens · per day"]);
  });
});

test.after(() => esbuild.stop());
