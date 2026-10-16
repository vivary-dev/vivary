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
  import { LinkedConversationChooser, LinkedHistoryNotice, NativeLinkOptions, useLinkSourceEligibility } from "./app/components/workspace/LinkedConversation";
  export { nativeHistoryRows } from "./app/lib/native-history-rows";
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
        : kind === "native-options" ? createElement(NativeLinkOptions, { projectId: "alpha", threadId: "native-source",
          saveDraft: globalThis.linkFixture.saveDraft, ...globalThis.linkFixture.options })
        : kind === "chooser-from-codex" ? createElement(LinkedConversationChooser, { ...props, sourceEngine: "codex-cli",
          engines: [{ engine: "claude-cli", label: "Claude Code", configured: true, models: ["claude-sonnet-5-5", "claude-opus-5-5"],
            claudeModels: globalThis.linkFixture.claudeModels }] })
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

test("an empty linked Native target with an unsent draft is listed once, under one row key", () => {
  const threads = [{ id: "linked-target", title: "Linked: Source", messageCount: 0, archivedAt: null },
    { id: "empty-plain", title: "", messageCount: 0, archivedAt: null }, { id: "saved", title: "Saved", messageCount: 2, archivedAt: null }];
  const drafts = [{ threadId: "linked-target", preview: "Typed in the target" }, { threadId: "empty-plain", preview: "Optimistic draft" },
    { threadId: "saved", preview: "Follow-up" }];
  const rows = module.exports.nativeHistoryRows(threads, drafts);
  // ProjectHistory keys both kinds of row as native:<threadId>.
  const keys = [...rows.threads.map(thread => "native:" + thread.id), ...rows.drafts.map(draft => "native:" + draft.threadId)].sort();
  assert.deepEqual(keys, ["native:empty-plain", "native:linked-target", "native:saved"]);
  assert.deepEqual(rows.drafts.map(draft => draft.threadId), ["empty-plain"], "only an unlisted conversation keeps its draft row");
});

test("linking to Claude Code picks the first model the installed CLI supports, and offers none when no model is supported", async () => {
  // claudeCodeModelChoices("2.1.281"): Opus 5.5 needs 2.1.280, Sonnet 5.5 needs 2.1.284.
  linkFixture.claudeModels = [{ id: "claude-sonnet-5-5", support: "upgrade-required" }, { id: "claude-opus-5-5", support: "supported" }];
  await render("chooser-from-codex"); await choose("claude-cli");
  assert.deepEqual(linkFixture.calls.at(-1).input.target, { engine: "claude-cli", model: "claude-opus-5-5" });
  linkFixture.claudeModels = [{ id: "claude-sonnet-5-5", support: "upgrade-required" }, { id: "claude-opus-5-5", support: "unverified" }];
  await render("chooser-from-codex");
  assert.equal(host.querySelector('option[value="claude-cli"]'), null, "a harness with no supported model is not offered");
});

test("a failed Native link prerequisite shows an explicit retry instead of hiding the chooser", async () => {
  const refetches = [];
  const probe = (name, result) => ({ ...result, refetch: async () => { refetches.push(name); } });
  const engines = { engines: [{ engine: "codex-cli", label: "Codex", configured: true, models: ["fixture"],
    modelCatalog: { status: "ready", defaultModel: "fixture" } }] };
  // The eligibility probe failed.
  linkFixture.options = { source: probe("source", { isError: true }), engines: probe("engines", { isError: false }) };
  await render("native-options");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry linked conversation").click());
  assert.match(host.querySelector('[role="alert"]').textContent, /Linked conversation options could not load/);
  assert.deepEqual(refetches, ["source"]);
  // The source is eligible, but runtime state failed to load.
  refetches.length = 0;
  linkFixture.options = { source: probe("source", { isError: false, data: { available: true } }), engines: probe("engines", { isError: true }) };
  await render("native-options");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry linked conversation").click());
  assert.deepEqual(refetches, ["source", "engines"]);
  // Both loaded: the chooser itself renders.
  linkFixture.options = { source: probe("source", { isError: false, data: { available: true } }), engines: probe("engines", { isError: false, data: engines }) };
  await render("native-options");
  assert.ok(host.querySelector('select[aria-label="Open linked conversation in another harness"]'));
  assert.equal(host.querySelector('[role="alert"]'), null);
});

test("a refetched first history page replaces every page read before it", async () => {
  let secret = "OLD-UNREDACTED-TOKEN";
  linkFixture.call = async (name, input) => input.cursor
    ? { ...noticePage(), excerpt: "Second page " + secret, nextCursor: null }
    : { ...noticePage(), excerpt: "First page", nextCursor: "cursor-1" };
  await render("notice"); await settle(); await notify();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect linked history").click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "More recorded history").click());
  await settle(); await notify();
  assert.equal(host.querySelector("pre").textContent.includes("OLD-UNREDACTED-TOKEN"), true);
  // A newly held credential is now redacted by the server, and the ordinary lifecycle refetches the first page.
  secret = "[REDACTED]";
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated")));
  await settle(); await notify();
  assert.equal(host.querySelector("pre")?.textContent.includes("OLD-UNREDACTED-TOKEN") ?? false, false, "no page read before the refetch stays shown");
});
