import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const TOOLKIT = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "toolkit", "package.json")));
const proofSource = String.raw`
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SharedRichEditor } from "@proof/shared-editor";
import { TooltipProvider } from "@proof/tooltip";
import { ResourceEditor } from "@proof/resource-editor";
import { ResourceContent } from "@proof/resource-content";
const features = { tables: false, tasks: false, image: false };
// The existing linkedom harness cannot parse TipTap's HTML fragments reliably.
// Use SharedRichEditor's supported JSON value/serializer seam with the real
// installed TipTap document and transactions, rather than a fake editor.
const initialDocument = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this content" }] }] };
const value = JSON.stringify(initialDocument);
const getMarkdown = editor => JSON.stringify(editor.getJSON());
const setContent = (editor, raw, options) => editor.commands.setContent(JSON.parse(raw), { emitUpdate: options.emitUpdate });
export async function inspectEditor(how) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const changes = [];
  let editor;
  const onChange = markdown => changes.push(markdown);
  const onEditorReady = instance => { editor = instance; };
  const render = editable => root.render(<TooltipProvider><SharedRichEditor value={value} onChange={onChange}
    features={features} dragHandle={false} editable={editable} onEditorReady={onEditorReady}
    getMarkdown={getMarkdown} setContent={setContent} parseValue={false} /></TooltipProvider>);
  try {
    await act(async () => { render(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    if (!editor || editor.isDestroyed) throw new Error("Actual SharedRichEditor did not initialize its TipTap editor");
    const afterMount = changes.slice();
    const initialText = editor.getText();
    changes.length = 0;
    if (how === "editable prop") {
      await act(async () => { render(false); });
      await act(async () => { render(true); });
    } else if (how === "editable command") {
      await act(async () => { editor.setEditable(false); editor.setEditable(true); });
    } else if (how === "content edit") {
      await act(async () => { editor.view.dispatch(editor.state.tr.insertText("Owner changed this")); });
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    return { afterMount, changes: changes.slice(), initialText, finalText: editor.getText(), editable: editor.isEditable };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}
export async function inspectResourceViewChange() {
  const raw = "# Personal instructions\n\n| Name | Email | Notes |\n| --- | --- | --- |\n| Owner | owner@example.test | Keep this table |\n";
  const resource = { id: "fixture-resource", path: "memory/MEMORY.md", content: raw, mimeType: "text/markdown" };
  const saved = [];
  const onSave = value => saved.push(value);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = view => root.render(<TooltipProvider><ResourceEditor resource={resource} view={view} hideToolbar onSave={onSave} /></TooltipProvider>);
  try {
    await act(async () => { render("code"); });
    // React writes the controlled textarea value to defaultValue. linkedom does
    // not mirror that to its live value property, unlike a browser.
    const before = host.querySelector("textarea").defaultValue;
    await act(async () => { render("visual"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); });
    await act(async () => { render("code"); });
    return { raw, before, after: host.querySelector("textarea").defaultValue, saved };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}
export async function inspectSettingsViewport() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ResourceContent resource="memory" />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const panel = host.querySelector('[data-testid="panel"]');
    if (!panel) throw new Error("Settings resource panel placeholder did not render");
    return { height: panel.parentElement.style.height, overflow: panel.parentElement.style.overflow };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}

`;
async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: HERE, sourcefile: "shared-editor-proof.tsx", loader: "tsx" },
    absWorkingDir: WORKBENCH, bundle: true, write: false, platform: "node", format: "esm", target: "node22", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl" }, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: `import { createRequire as createProofRequire } from "node:module";
const require = createProofRequire(${JSON.stringify(join(WORKBENCH, "package.json"))});` },
    plugins: [{ name: "installed-shared-editor", setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.path === "@proof/shared-editor") return { path: join(TOOLKIT, "dist/editor/SharedRichEditor.js") };
        if (args.path === "@proof/tooltip") return { path: join(TOOLKIT, "dist/ui/tooltip.js") };
        if (args.path === "@proof/resource-editor") return { path: join(CORE, "dist/client/resources/ResourceEditor.js") };
        if (args.path === "@proof/resource-content") return { path: join(CORE, "dist/client/agent-page/AgentWorkspaceContent.js"), namespace: "settings-owner" };
        if (args.path.endsWith("resources/ResourcesPanel.js") && args.importer.includes("AgentWorkspaceContent")) return { path: "resource-panel", namespace: "panel-placeholder" };
      });
      // Only the panel's data-loading surface is replaced for the layout owner
      // check. ResourceEditor and SharedRichEditor use the actual installed code.
      build.onLoad({ filter: /.*/, namespace: "panel-placeholder" }, () => ({ contents: 'import { createElement } from "react"; export function ResourcesPanel() { return createElement("div", { "data-testid": "panel" }); }', loader: "js", resolveDir: WORKBENCH }));
      build.onLoad({ filter: /.*/, namespace: "settings-owner" }, args => ({ contents: readFileSync(args.path, "utf8") + "\nexport { ResourceContent };", loader: "js", resolveDir: dirname(args.path) }));
    } }],
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


test("installed SharedRichEditor saves only document changes", { timeout: 15000 }, async t => {
  const closeChannels = installDom();
  t.after(closeChannels);
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  await t.test("opening the editor does not emit a non-content mount write", async () => {
    const result = await proof.inspectEditor("mount");
    assert.match(result.initialText, /Keep this content/, "the real editor must initialize the supported document fixture");
    assert.equal(result.afterMount.length, 0, "mounting must not write the serialized editor snapshot");
  });
  await t.test("editable prop changes do not emit a resource write", async () => {
    const result = await proof.inspectEditor("editable prop");
    assert.equal(result.editable, true);
    assert.equal(result.changes.length, 0);
    assert.equal(result.finalText, result.initialText);
  });
  await t.test("non-content TipTap editable updates do not emit a resource write", async () => {
    const result = await proof.inspectEditor("editable command");
    assert.equal(result.changes.length, 0);
    assert.equal(result.finalText, result.initialText);
  });
  await t.test("switching resource views retains the controlled source and does not autosave", async () => {
    // linkedom does not establish Markdown display fidelity. This exercises the
    // real ResourceEditor state/autosave boundary; native rendering stays required.
    const result = await proof.inspectResourceViewChange();
    assert.equal(result.before, result.raw);
    assert.deepEqual(result.saved, []);
    assert.equal(result.after, result.raw);
  });
  await t.test("Settings gives the existing resource panel a definite responsive viewport", async () => {
    // Style ownership is checked in the rendered component. Pixel layout at
    // desktop and 390px widths remains a real-browser/native acceptance gate.
    const result = await proof.inspectSettingsViewport();
    assert.equal(result.height, "clamp(18rem, 50dvh, 40rem)");
  });
  await t.test("a real document edit still reaches the host callback", async () => {
    const result = await proof.inspectEditor("content edit");
    assert.equal(result.changes.length, 1);
    assert.match(result.changes[0], /Owner changed this/);
    assert.match(result.finalText, /Owner changed this/);
  });
});
