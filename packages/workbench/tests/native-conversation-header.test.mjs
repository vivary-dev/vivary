import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// The API chat header, mounted on linkedom with Core's thread list hook stubbed by a fixture. The header's own
// event listeners and title choice run unchanged.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event,
  IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
// The stub keeps the list in state and rereads the fixture on refreshThreads, as Core's hook refetches the server.
const stubs = new Map([["@agent-native/core/client/agent-chat", `import { useCallback, useState } from "react";
  export function useChatThreads(apiUrl, storageKey, scope, options) {
    globalThis.headerFixture.calls.push({ storageKey, scope, options });
    const [threads, setThreads] = useState(() => globalThis.headerFixture.threads);
    const refreshThreads = useCallback(() => setThreads(globalThis.headerFixture.threads), []);
    return { threads, refreshThreads };
  }`]]);
const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { NativeConversationHeader } from "./app/components/workspace/NativeConversationHeader";
  export const view = threadId => createElement(NativeConversationHeader, { storageKey: "owner:alpha",
    scope: { type: "workspace-app", id: "alpha" }, threadId, detail: "API chat / Alpha" });`,
  loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*"], loader: { ".css": "empty" },
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  globalThis.headerFixture = { calls: [], threads: [
    { id: "tide", title: "Tide pools survey", preview: "Count the sea stars" },
    { id: "kelp", title: "", preview: "Kelp forest notes" }] };
});
test.afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = threadId => act(async () => root.render(module.exports.view(threadId)));
const heading = () => host.querySelector("h2");

test("the header shows the open thread's title, its detail line, and the full title on hover and focus", async () => {
  await render("tide");
  assert.equal(heading().textContent, "Tide pools survey");
  assert.equal(heading().getAttribute("title"), "Tide pools survey");
  assert.equal(heading().getAttribute("tabindex"), "0");
  assert.equal(host.querySelector("p").textContent, "API chat / Alpha");
  assert.deepEqual(globalThis.headerFixture.calls[0].options,
    { autoCreate: false, restoreActiveThread: false, isolateHistoryByScope: true, includeExternal: false },
    "the header reads the same scoped list as the history and never creates or restores a thread");
});

test("a rename elsewhere updates the header on the threads-updated event", async () => {
  await render("tide");
  globalThis.headerFixture.threads = [{ ...globalThis.headerFixture.threads[0], title: "Renamed survey" },
    globalThis.headerFixture.threads[1]];
  assert.equal(heading().textContent, "Tide pools survey", "nothing changes before the event");
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated")));
  assert.equal(heading().textContent, "Renamed survey");
  assert.equal(heading().getAttribute("title"), "Renamed survey");
});

test("switching threads changes the title, an untitled thread shows its preview, and a new one says so", async () => {
  await render("tide");
  await render("kelp");
  assert.equal(heading().textContent, "Kelp forest notes");
  await render(null);
  assert.equal(heading().textContent, "New conversation");
  await render("unsaved-thread");
  assert.equal(heading().textContent, "New conversation");
});

test("a rename in another window shows when this window regains focus, and an unmounted header stops listening", async () => {
  await render("tide");
  globalThis.headerFixture.threads = [{ ...globalThis.headerFixture.threads[0], title: "Renamed elsewhere" },
    globalThis.headerFixture.threads[1]];
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.equal(heading().textContent, "Renamed elsewhere");
  const refreshes = globalThis.headerFixture.calls.length;
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.equal(globalThis.headerFixture.calls.length, refreshes, "no render after the header unmounts");
});
