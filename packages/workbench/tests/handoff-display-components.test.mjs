import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// Same DOM and bundling composition as the handoff control test. Core's registration functions are recorded,
// so the test renders the registered components exactly as Core's chat would receive them.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: globalThis.handoffFixture.call });`],
  ["@agent-native/toolkit/ui", `import { createElement } from "react";
    export const Button = ({ size, variant, ...props }) => createElement("button", props);`],
  ["@agent-native/core/client/chat", `export const registerMarkdownFenceRenderer = (lang, Component) => { globalThis.registered.fences.set(lang, Component); return () => {}; };
    export const registerUserMessageTextRenderer = renderer => { globalThis.registered.userText.push(renderer); return () => {}; };`],
]);
globalThis.registered = { fences: new Map(), userText: [] };
const bundle = await build({ stdin: { contents: `
  import { createElement, Fragment, useState } from "react";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import "./app/components/workspace/HandoffDisplay";
  import { HandoffControl } from "./app/components/workspace/HandoffControl";
  import { HandoffStatusContext, createHandoffStatusHub } from "./app/components/workspace/handoff-status";
  export { createHandoffStatusHub };
  // The conversation provides one hub. The control publishes to it, and the reply preview reads it.
  export function view({ hub, content, control = true }) {
    const client = globalThis.handoffFixture.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return createElement(QueryClientProvider, { client }, createElement(HandoffStatusContext.Provider, { value: hub },
      createElement(Fragment, null, content, control ? createElement(HandoffControl, { projectId: "alpha",
        conversation: { kind: "code", id: "run-a" }, disabled: false, submit: async () => true }) : null)));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);
const { createElement } = await import("react");

const proposal = { requestId: "req-1", goal: "Finish the relay beta", decisions: ["Keep SQLite"], changes: ["Edited dirty.txt"],
  checks: [{ name: "unit tests", outcome: "passed", evidenceEventId: "check-output" }, { name: "lint", outcome: "not-run", evidenceEventId: null }],
  unfinished: ["Write the operator guide"], risks: ["The relay budget is unconfirmed"], nextAction: "Run the integration suite" };
const code = JSON.stringify(proposal, null, 2);
const covered = { ...proposal, savedVersion: "pf_saved", savedAt: "2026-10-19T12:00:00.000Z",
  facts: { requestId: "req-1", path: "STATE.md", documentVersion: "pf_before",
    project: { kind: "git", head: "a".repeat(40), ref: "main", dirty: false, dirtyCount: 0, dirtyDigest: "d", filesDigest: "f", truncated: false },
    conversation: { ref: { kind: "code", id: "run-a" }, boundaryId: "done", boundaryBytes: 10, prefixDigest: "p" }, linked: null } };
const pending = { status: "pending", requestId: "req-1", conversation: { kind: "code", id: "run-a" }, covered: null };

let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  globalThis.handoffFixture = { status: pending,
    saveResult: { code: "refused", replyRefused: true, problems: ["risks: Too small: expected array to have >=1 items"] },
    call: async name => {
      if (name === "vivary-handoff-freshness") return handoffFixture.status;
      if (name === "vivary-handoff-save") return handoffFixture.saveResult;
      throw new Error("Unexpected action " + name);
    } };
});
test.afterEach(async () => { await act(async () => root.unmount()); handoffFixture.client?.clear(); host.remove(); });
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); });
const Preview = () => globalThis.registered.fences.get("vivary-handoff");
const render = async (props) => { await act(async () => root.render(module.exports.view(props))); await settle(); };
const reply = (body = code) => createElement(Preview(), { code: body, lang: "vivary-handoff" });
const status = () => host.querySelector(".vivary-handoff-status")?.textContent ?? null;
const button = label => [...host.querySelectorAll("button")].find(item => item.textContent === label);

test("the reply block reads as a handoff, with the raw JSON in a closed Raw details disclosure", async () => {
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply() });
  const preview = host.querySelector(".vivary-handoff-preview");
  assert.equal(preview.querySelector("h3").textContent, "Handoff");
  assert.match(preview.textContent, /Goal: Finish the relay beta/);
  assert.deepEqual([...preview.querySelectorAll("h4")].map(item => item.textContent), ["Decisions", "Changes", "Checks", "Unfinished work", "Risks"]);
  assert.deepEqual([...preview.querySelectorAll("section li")].map(item => item.textContent), ["Keep SQLite", "Edited dirty.txt",
    "passed: unit tests (event check-output)", "not-run: lint", "Write the operator guide", "The relay budget is unconfirmed"]);
  assert.match(preview.textContent, /Next action: Run the integration suite/);
  const raw = preview.querySelector("details");
  assert.equal(raw.querySelector("summary").textContent, "Raw details");
  assert.equal(raw.hasAttribute("open"), false);
  assert.equal(raw.querySelector("pre").textContent, code);
});

test("a check that cites a tool call from the reply turn is labeled as a tool call, not an event", async () => {
  const cited = JSON.stringify({ ...proposal, checks: [{ name: "state read", outcome: "passed", evidenceEventId: "tool:call_1" }] });
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply(cited) });
  assert.deepEqual([...host.querySelectorAll(".vivary-handoff-preview section li")].map(item => item.textContent)
    .filter(text => text.includes("state read")), ["passed: state read (tool call call_1)"]);
});

test("a reply that is not valid JSON, such as one still streaming, keeps its text under Raw details", async () => {
  const partial = code.slice(0, 40);
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply(partial) });
  assert.match(host.textContent, /incomplete or is not valid JSON/);
  assert.equal(host.querySelector("details pre").textContent, partial);
  assert.equal(status(), null);
});

test("each save status is explicit: not saved yet, refused with the parser's reasons, then saved and Fresh", async () => {
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply() });
  assert.equal(status(), "Not saved yet. Click Save handoff to write it to the state document.");
  await act(async () => button("Save handoff").click()); await settle();
  assert.match(status(), /^Refused\. Vivary did not save this reply\./);
  assert.deepEqual([...host.querySelectorAll(".vivary-handoff-status li")].map(item => item.textContent),
    ["risks: Too small: expected array to have >=1 items"]);
  handoffFixture.saveResult = { code: "saved", record: covered };
  handoffFixture.status = { status: "fresh", covered, reasons: [] };
  await act(async () => button("Save handoff").click()); await settle();
  assert.equal(status(), "Saved to STATE.md. Fresh.");
});

test("a Save clicked before the reply finished shows its reason in the control and does not mark the reply refused", async () => {
  const early = "The agent has not finished replying to this handoff request in this conversation. Wait for its reply, then click Save handoff.";
  handoffFixture.saveResult = { code: "refused", problems: [early] };
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply() });
  await act(async () => button("Save handoff").click()); await settle();
  assert.equal(status(), "Not saved yet. Click Save handoff to write it to the state document.");
  assert.ok([...host.querySelectorAll("[role=alert] li")].some(item => item.textContent === early));
});

test("a failed freshness check clears the preview status instead of keeping the older one", async () => {
  handoffFixture.status = { status: "fresh", covered, reasons: [] };
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply() });
  assert.equal(status(), "Saved to STATE.md. Fresh.");
  handoffFixture.status = Promise.reject(new Error("offline"));
  handoffFixture.status.catch(() => {});
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated"))); await settle();
  assert.match(host.textContent, /Handoff freshness could not be checked/);
  assert.equal(status(), null);
  assert.match(host.textContent, /Goal: Finish the relay beta/);
});

test("out of date, failed, superseded and unreported states each say so", async () => {
  const cases = [
    [{ status: "out-of-date", covered, reasons: ["head-moved"] }, "Saved to STATE.md. Out of date."],
    [{ ...pending, status: "failed", message: "The write failed.", retryable: true }, "Not saved. The write failed."],
    [{ ...pending, requestId: "req-2", covered }, "Saved to STATE.md. A newer handoff request is pending."],
    [{ ...pending, requestId: "req-2" }, "Not the latest handoff request. Save handoff applies only to the latest one."],
    [{ status: "none", path: "STATE.md" }, "Not the latest handoff request. Save handoff applies only to the latest one."],
    // An earlier reply that was saved, then replaced by a newer saved handoff, is not called unsaved.
    [{ status: "fresh", covered: { ...covered, requestId: "req-2" }, reasons: [] }, "Not the latest handoff request. Save handoff applies only to the latest one."],
  ];
  for (const [freshness, expected] of cases) {
    handoffFixture.status = freshness;
    await act(async () => root.unmount()); handoffFixture.client?.clear(); root = createRoot(host);
    await render({ hub: module.exports.createHandoffStatusHub(), content: reply() });
    assert.equal(status(), expected, JSON.stringify(freshness));
  }
  // A read-only view has no handoff control, so the preview claims no status.
  await act(async () => root.unmount()); root = createRoot(host);
  await render({ hub: module.exports.createHandoffStatusHub(), content: reply(), control: false });
  assert.equal(status(), null);
  assert.match(host.textContent, /Goal: Finish the relay beta/);
});

test("the Prepare handoff request is one line, with the full prompt in a closed disclosure", async () => {
  const [renderer] = globalThis.registered.userText;
  const request = "Prepare handoff (vivary-handoff-request:9b2f4c1e-0d3a-4e5f-8a6b-7c8d9e0f1a2b)\n\nReview the actual project and this conversation.";
  assert.equal(renderer.matches(request), true);
  assert.equal(renderer.matches("Please prepare handoff notes"), false);
  assert.equal(renderer.matches("Prepare handoff (vivary-handoff-request:)"), false);
  await render({ hub: null, content: createElement(renderer.Component, { text: request }), control: false });
  const message = host.querySelector(".vivary-handoff-request");
  assert.equal(message.querySelector("p").textContent, "Handoff requested");
  const details = message.querySelector("details");
  assert.equal(details.hasAttribute("open"), false);
  assert.equal(details.querySelector("summary").textContent, "Full request");
  assert.equal(details.querySelector("div").textContent, request);
});
