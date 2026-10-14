import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

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

// Only the Builder connect flow, which polls a status route, is stubbed. It is matched by the file
// it resolves to, so every importer gets the same stub.
const stubs = new Map([
  [join(WORKBENCH, "app", "lib", "native-actions.ts"), `
    export function useNativeActionCaller() { return { call: async () => { throw new Error("No Code action expected"); } }; }`],
  [join(WORKBENCH, "app", "lib", "chat-draft.ts"), `
    export function useNativeChatDraft() { return { statusForThread: () => null, draftSaveStatusForThread: () => null,
      rejectKnownSubmission: async () => {}, hostComposerDraft: undefined }; }
    export function registerSelectionCloseFlush() { return () => {}; }
    export function trackSelectionWrite() {}
    export async function flushChatDraftsForClose() {}
    export function useChatDraftList() { return { data: [] }; }`],
  [join(CLIENT, "settings", "useBuilderStatus.js"), `
    export function useBuilderConnectFlow() {
      return { configured: false, connecting: false, error: null, orgName: null, statusResolved: true, start() {} };
    }
    export function useBuilderStatus() { return { status: null, refetch() {} }; }
    export function withBuilderConnectTrackingParams(url) { return url; }
    export function openBuilderConnectPopup() { throw new Error("No account connection expected"); }`],
]);

const proofSource = String.raw`
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { AssistantChat } from "@proof/assistant-chat";
import { LocalCodeConversation } from "@proof/workbench-code";
import { claudeCodeModelChoices } from "../shared/claude-models.ts";
import { MultiTabAssistantChat } from "@proof/multi-tab-chat";
import { useState } from "react";
import { getRunErrorMetadata, RunErrorRecoveryCard } from "@proof/run-recovery";
import * as messages from "@proof/message-components";
import { processEvent } from "@proof/sse-event-processor";
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TiptapComposer } from "@proof/tiptap-composer";
import { TooltipProvider } from "@proof/tooltip";
import { UsageSection } from "@proof/usage-section";
import * as chatHistory from "@proof/chat-history";

export async function renderWorkbenchComposer({ model = "claude-sonnet-5-5", active = false, history = false, funding }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const choices = [];
  const engine = { engine: "claude-cli", label: "Claude Code", configured: true,
    runtime: { status: "ready", message: "Signed in", version: "2.1.296" }, modelCatalog: null,
    models: claudeCodeModelChoices("2.1.296").map(model => model.id),
    claudeModels: claudeCodeModelChoices("2.1.296"),
    funding: funding ?? { policy: "included-only", status: "unavailable", message: "Subscription controls need verification" } };
  const state = { engines: [engine], defaultEngine: "claude-cli", defaultModel: "claude-sonnet-5-5", cleanup: null };
  const selection = { key: "composer-review", runId: history ? "retained-run" : null, choice: { engine: "claude-cli", model } };
  const props = { state, selection, ownerKey: "fixture-owner", projectId: null, workspaceAvailable: true,
    previewScope: "fixture", notices: <div data-testid="preserved-notice">Existing notice</div>, active, streaming: false,
    stopping: false, run: history ? { id: "retained-run", engine: "claude-cli", model, events: [], status: "completed" } : null,
    onChoice: choice => choices.push(choice), onStarted() {}, onStreaming() {}, onSettled() {},
    onStop: async () => false, onSettings() {} };
  const view = await mount(<QueryClientProvider client={client}><LocalCodeConversation {...props} /></QueryClientProvider>);
  const runtime = view.host.querySelector('[aria-label="Conversation runtime"]');
  const select = view.host.querySelector('[aria-label="Conversation model"]');
  const toolbar = view.host.querySelector('[data-agent-composer-slot="toolbar"]');
  const send = view.host.querySelector('[data-agent-composer-slot="send-button"]');
  const nodes = toolbar ? [...toolbar.querySelectorAll("select,button")] : [];
  const snapshot = { embedded: !!toolbar?.contains(runtime) && !!toolbar?.contains(select),
    beforeSend: nodes.indexOf(runtime) < nodes.indexOf(send) && nodes.indexOf(select) < nodes.indexOf(send),
    noticesOutsideToolbar: !toolbar?.contains(view.host.querySelector('[data-testid="preserved-notice"]')),
    model: select?.value, labels: [runtime?.getAttribute("aria-label"), select?.getAttribute("aria-label")],
    disabled: [runtime?.disabled, select?.disabled, send?.disabled], choices,
    text: view.host.textContent };
  await view.unmount(); client.clear();
  return snapshot;
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
  return { reading, stop, send, waitForText, async unmount() { await view.unmount(); client.clear(); } };
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
          const candidate = args.path.startsWith("@/") ? join(WORKBENCH, "app", args.path.slice(2) + ".ts")
            : args.path.startsWith(".") ? resolve(args.resolveDir, args.path) + (args.path.endsWith(".ts") ? "" : ".ts") : null;
          if (candidate && stubs.has(candidate)) return { path: candidate, namespace: "stub" };
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
          if (args.path.startsWith(".") && args.importer.startsWith(CORE)) {
            const target = resolve(dirname(args.importer), args.path);
            if (stubs.has(target)) return { path: target, namespace: "stub" };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "workbench-code" }, args => ({
          contents: readFileSync(args.path, "utf8") + "\nexport { LocalCodeConversation };",
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
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
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

test("Native chat controls", async t => {
  // Tiptap reads the DOM when its module loads, so the DOM goes in first.
  const closeChannels = installDom();
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  t.after(() => closeChannels());

  await t.test("the Workbench selectors render inside the actual composer before Send, with notices outside", async () => {
    const server = installChatServer();
    try {
      const snapshot = await proof.renderWorkbenchComposer({});
      assert.equal(snapshot.embedded, true);
      assert.equal(snapshot.beforeSend, true);
      assert.equal(snapshot.noticesOutsideToolbar, true);
      assert.deepEqual(snapshot.labels, ["Conversation runtime", "Conversation model"]);
      assert.deepEqual(snapshot.disabled, [false, false, true]);
      assert.match(snapshot.text, /Subscription controls need verification/);
      assert.doesNotMatch(snapshot.text, /API list price/);
    } finally { server(); }
  });
  await t.test("the Workbench shows the selected model's funding refusal", async () => {
    const server = installChatServer();
    try {
      const funding = { policy: "included-only", status: "ready", message: "Included allowance ready", models: {
        "claude-fable-5-1": { status: "exhausted", message: "Fable's included weekly allowance is exhausted" },
      } };
      const selected = await proof.renderWorkbenchComposer({ model: "claude-fable-5-1", funding });
      assert.match(selected.text, /Fable's included weekly allowance is exhausted/);
      assert.equal(selected.disabled[2], true);
      const ready = await proof.renderWorkbenchComposer({ funding });
      assert.doesNotMatch(ready.text, /Subscription controls need verification|Fable's included weekly/);
    } finally { server(); }
  });
  await t.test("the Workbench retains a saved legacy choice and locks active and retained conversations", async () => {
    const server = installChatServer();
    try {
      const saved = await proof.renderWorkbenchComposer({ model: "sonnet" });
      assert.equal(saved.model, "sonnet");
      assert.deepEqual(saved.choices, []);
      assert.match(saved.text, /legacy or unavailable/);
      for (const input of [{ active: true }, { history: true }]) {
        const snapshot = await proof.renderWorkbenchComposer(input);
        assert.equal(snapshot.embedded, true);
        assert.deepEqual(snapshot.disabled.slice(0, 2), [true, true]);
      }
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
