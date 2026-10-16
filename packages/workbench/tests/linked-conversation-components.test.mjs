import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// Same DOM and bundling composition as the maintained conversation/search tests.
// The production link controls, Router and query lifecycle run unchanged.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: globalThis.linkFixture.call });`],
  ["@agent-native/toolkit/ui", `import { createElement } from "react";
    export const Button = ({ size, variant, ...props }) => createElement("button", props);`],
]);
const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { MemoryRouter, useLocation } from "react-router";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { LinkedConversationChooser, LinkedHistoryNotice, useLinkSourceEligibility } from "./app/components/workspace/LinkedConversation";
  function Location() { return createElement("output", { id: "route" }, useLocation().search); }
  function Eligibility() {
    const source = useLinkSourceEligibility({ projectId: "alpha", storageKey: "alpha", threadId: "new-thread", enabled: true });
    return createElement("output", { id: "eligible" }, String(source.data?.available));
  }
  export function view(kind) {
    const props = { projectId: "alpha", source: { kind: "code", id: "source" }, sourceEngine: "claude-cli",
      engines: [{ engine: "claude-cli", label: "Claude Code", configured: true, models: ["sonnet"] },
        { engine: "codex-cli", label: "Codex", configured: true, models: ["fixture"], modelCatalog: { status: "ready", defaultModel: "fixture" } }],
      saveDraft: globalThis.linkFixture.saveDraft };
    const client = globalThis.linkFixture.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: ["/?run=source"] },
      kind === "eligibility" ? createElement(Eligibility) : kind === "chooser" ? createElement(LinkedConversationChooser, props)
        : createElement(LinkedHistoryNotice, { projectId: "alpha", target: { kind: kind === "native-notice" ? "native" : "code", id: "target" } }), createElement(Location)));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*", "react-router"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);
let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  // One ordered log of every host effect the chooser can cause: draft saves and Native actions.
  globalThis.linkFixture = { calls: [], effects: [],
    saveDraft: async (...args) => { linkFixture.effects.push({ effect: "saveDraft", args }); },
    call: async (name, input) => { linkFixture.calls.push({ name, input }); linkFixture.effects.push({ effect: name });
      throw new Error("Selected creation failure"); } };
});
test.afterEach(async () => { await act(async () => root.unmount()); linkFixture.client?.clear(); host.remove(); });
const render = kind => act(async () => root.render(module.exports.view(kind)));
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function choose(engine) {
  const select = host.querySelector("select");
  Object.defineProperty(select, "value", { value: engine, configurable: true });
  await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
  await settle();
}

test("a failed link saves the draft first, calls only the link action, keeps the source selected, and Retry works", async () => {
  await render("chooser");
  assert.equal(host.querySelector('option[value="claude-cli"]'), null, "same-harness follow-up is not a link choice");
  assert.ok(host.querySelector('option[value="native"]'));
  await choose("codex-cli");
  assert.equal(host.querySelector("#route").textContent, "?run=source");
  // The draft is saved through its owner before creation, and the failed link causes no other effect.
  assert.deepEqual(linkFixture.effects, [{ effect: "saveDraft", args: [] }, { effect: "vivary-conversation-link" }]);
  assert.deepEqual(linkFixture.calls, [{ name: "vivary-conversation-link", input: { projectId: "alpha",
    source: { kind: "code", id: "source" }, target: { engine: "codex-cli", model: "fixture" } } }]);
  assert.match(host.textContent, /Retry link|Nothing is sent/);
  linkFixture.call = async (name, input) => { linkFixture.calls.push({ name, input }); linkFixture.effects.push({ effect: name });
    return { target: { kind: "code", id: "target" }, route: "/?run=target" }; };
  // Rerender updates the host transport, just as the real session caller does.
  await render("chooser");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry link").click());
  await settle();
  assert.equal(host.querySelector("#route").textContent, "?run=target");
  assert.deepEqual(linkFixture.effects, [{ effect: "saveDraft", args: [] }, { effect: "vivary-conversation-link" },
    { effect: "saveDraft", args: [] }, { effect: "vivary-conversation-link" }]);
  assert.equal(linkFixture.calls.some(call => /send|start|approve|draft|discard/.test(call.name)), false);
});

test("a draft save failure prevents creation and keeps the original selected", async () => {
  linkFixture.saveDraft = async () => { throw new Error("Draft save failed"); };
  await render("chooser"); await choose("native");
  assert.deepEqual(linkFixture.calls, []);
  assert.equal(host.querySelector("#route").textContent, "?run=source");
  assert.match(host.textContent, /Retry link/);
});

const noticePage = () => ({ source: { kind: "native", id: "original" }, sourceTitle: "Original history", sourceStatus: "available",
  boundaryId: "opaque-completed-message", availableEntries: 211, suppliedEntries: 100, excerpt: "Quoted history",
  truncated: true, nextCursor: null, nativeContinuity: false,
  lastPrepared: { entries: 100, characters: 12_000, truncated: true }, lastAccepted: null });
const notify = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));
test("collapsed history is readable and expanded inspection distinguishes preparation, acceptance and continuity", async () => {
  linkFixture.call = async () => noticePage();
  await render("notice"); await settle(); await notify();
  assert.match(host.textContent, /211 completed-history entries available/);
  assert.match(host.textContent, /Last request prepared: 100 entries/);
  assert.match(host.textContent, /No accepted Code send recorded|Separate harness session/);
  assert.match(host.textContent, /truncated/);
  assert.doesNotMatch(host.textContent, /opaque-completed-message|provider ingestion|source provider session/);
  assert.equal(host.querySelector("pre"), null);
  assert.match(host.querySelector("a").getAttribute("href"), /runtime=native.*thread=original/);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect linked history").click());
  assert.match(host.textContent, /opaque-completed-message|provider ingestion|source provider session is not transferred/);
  assert.equal(host.querySelector("pre").textContent, "Quoted history");
});

test("a mounted notice refreshes accepted-send disclosure through the ordinary thread update lifecycle", async () => {
  let page = noticePage(), reads = 0;
  linkFixture.call = async () => { reads++; return page; };
  await render("notice"); await settle(); await notify();
  assert.match(host.textContent, /No accepted Code send recorded/);
  page = { ...page, lastAccepted: { entries: 100, characters: 12_000, truncated: true, userEventId: "accepted-user" } };
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated")));
  await settle(); await notify();
  assert.ok(reads >= 2); assert.match(host.textContent, /Last accepted Code send: 100 entries/);
  assert.equal(host.querySelector("#route").textContent, "?run=source", "no navigation or focus is needed");
});

test("a mounted Native notice refreshes preparation through Native request completion with a separate tab identity", async () => {
  let page = { ...noticePage(), lastPrepared: null };
  linkFixture.call = async () => page;
  await render("native-notice"); await settle(); await notify();
  assert.match(host.textContent, /No linked history prepared yet/);
  page = noticePage();
  const completion = new window.Event("agentNative.chatRunning");
  Object.defineProperty(completion, "detail", { value: { tabId: "native-ui-tab", isRunning: false } });
  await act(async () => window.dispatchEvent(completion)); await settle(); await notify();
  assert.match(host.textContent, /Last request prepared: 100 entries/);
  assert.match(host.textContent, /Delivery not observed/);
  assert.doesNotMatch(host.textContent, /Last accepted Code send/);
});

test("an unavailable source keeps the notice truthful and claims no prepared or supplied context for later sends", async () => {
  linkFixture.call = async () => ({ ...noticePage(), sourceStatus: "unavailable", availableEntries: 0, suppliedEntries: 0,
    excerpt: "", truncated: false, lastAccepted: { entries: 3, characters: 120, truncated: false, userEventId: "earlier-user" } });
  await render("notice"); await settle(); await notify();
  assert.match(host.textContent, /Original history, which is unavailable\. Sends continue without its history\./);
  assert.match(host.textContent, /Earlier, the last accepted Code send included 3 linked entries/);
  assert.doesNotMatch(host.textContent, /Next send can prepare|Last request prepared|completed-history entries available|could not be verified/);
  assert.equal(host.querySelector("a"), null, "the unavailable original is not offered as a readable link");
  assert.equal([...host.querySelectorAll("button")].some(button => /Inspect linked history|Retry history/.test(button.textContent)), false);
});

test("a new Native conversation becomes a link source when its first request saves it", async () => {
  let saved = false, reads = 0;
  linkFixture.call = async (name, input) => { reads++; linkFixture.calls.push({ name, input }); return { available: saved }; };
  await render("eligibility"); await settle(); await notify();
  // The optimistic thread is not saved before its first request, so it is not a source yet.
  assert.equal(host.querySelector("#eligible").textContent, "false");
  saved = true;
  const completion = new window.Event("agentNative.chatRunning");
  Object.defineProperty(completion, "detail", { value: { tabId: "native-ui-tab", isRunning: false } });
  await act(async () => window.dispatchEvent(completion)); await settle(); await notify();
  assert.equal(host.querySelector("#eligible").textContent, "true");
  assert.deepEqual(linkFixture.calls.at(-1), { name: "vivary-linked-history",
    input: { operation: "source", projectId: "alpha", target: { kind: "native", id: "new-thread" } } });
  // Once the conversation is a source, later requests cause no further eligibility reads.
  const settled = reads;
  await act(async () => window.dispatchEvent(completion)); await settle(); await notify();
  assert.equal(reads, settled);
});
