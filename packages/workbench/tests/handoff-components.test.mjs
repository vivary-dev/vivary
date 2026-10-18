import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// Same DOM and bundling composition as the linked conversation component test.
// The production handoff control and its query lifecycle run unchanged.
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
]);
const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { HandoffControl } from "./app/components/workspace/HandoffControl";
  export function view(props) {
    const client = globalThis.handoffFixture.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    return createElement(QueryClientProvider, { client }, createElement(HandoffControl, { projectId: "alpha",
      conversation: { kind: "code", id: "run-a" }, disabled: false, submit: globalThis.handoffFixture.submit, ...props }));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);

const covered = { requestId: "req-0", goal: "Finish the relay beta", decisions: ["Keep SQLite"], changes: ["Edited dirty.txt"],
  checks: [{ name: "unit tests", outcome: "passed", evidenceEventId: "check-output" }], unfinished: ["Docs"], risks: ["Budget"],
  nextAction: "Run the integration suite", savedVersion: "pf_saved", savedAt: "2026-10-16T12:00:00.000Z",
  facts: { requestId: "req-0", path: "STATE.md", documentVersion: "pf_before",
    project: { kind: "git", head: "a".repeat(40), ref: "main", dirty: true, dirtyCount: 1, dirtyDigest: "d", filesDigest: "f", truncated: false },
    conversation: { ref: { kind: "code", id: "run-a" }, boundaryId: "work-done", boundaryBytes: 10, prefixDigest: "p" }, linked: null } };
let host, root;
test.beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  globalThis.handoffFixture = { calls: [], submitted: [], status: { status: "fresh", covered, reasons: [] },
    submit: async message => { handoffFixture.submitted.push(message); return true; },
    call: async (name, input) => {
      handoffFixture.calls.push({ name, input });
      if (name === "vivary-handoff-freshness") return handoffFixture.status;
      if (name === "vivary-handoff-prepare") {
        handoffFixture.status = { status: "pending", requestId: "req-1", conversation: input.conversation, covered };
        return { code: "prepared", requestId: "req-1", message: "Prepare handoff vivary-handoff-request:req-1", facts: covered.facts };
      }
      if (name === "vivary-handoff-save") {
        handoffFixture.status = { status: "fresh", covered: { ...covered, requestId: input.requestId }, reasons: [] };
        return { code: "saved", record: covered };
      }
      throw new Error("Unexpected action " + name);
    } };
});
test.afterEach(async () => { await act(async () => root.unmount()); handoffFixture.client?.clear(); host.remove(); });
const render = (props = {}) => act(async () => root.render(module.exports.view(props)));
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); });
const button = label => [...host.querySelectorAll("button")].find(item => item.textContent === label);
const click = async label => { await act(async () => button(label).click()); await settle(); };

test("a fresh handoff is shown, and refreshes or switching harness send nothing", async () => {
  await render(); await settle();
  assert.match(host.textContent, /Handoff in STATE\.md is fresh/);
  assert.ok(button("Update handoff"));
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated"))); await settle();
  // A harness switch opens another conversation surface. It only reads freshness.
  await render({ conversation: { kind: "native", id: "thread-b" } }); await settle();
  assert.deepEqual([...new Set(handoffFixture.calls.map(call => call.name))], ["vivary-handoff-freshness"]);
  assert.deepEqual(handoffFixture.submitted, []);
});

test("Prepare submits the request to this conversation, and Save handoff is a second owner click", async () => {
  handoffFixture.status = { status: "none", path: "STATE.md" };
  await render(); await settle();
  assert.match(host.textContent, /No handoff saved/);
  await click("Prepare handoff");
  assert.deepEqual(handoffFixture.submitted, ["Prepare handoff vivary-handoff-request:req-1"]);
  assert.equal(handoffFixture.calls.some(call => call.name === "vivary-handoff-save"), false, "Prepare never saves");
  assert.match(host.textContent, /Save handoff/);
  await click("Save handoff");
  const save = handoffFixture.calls.find(call => call.name === "vivary-handoff-save");
  assert.deepEqual(save.input, { projectId: "alpha", conversation: { kind: "code", id: "run-a" }, requestId: "req-1" });
  assert.match(host.textContent, /fresh/);
});

test("an undelivered request says so and offers Prepare again", async () => {
  handoffFixture.status = { status: "none", path: "STATE.md" };
  handoffFixture.submit = async message => { handoffFixture.submitted.push(message); return false; };
  await render(); await settle();
  await click("Prepare handoff");
  assert.match(host.textContent, /not delivered/);
  assert.ok(button("Prepare handoff") ?? button("Update handoff"), "Prepare stays available");
});

test("a refused reply lists the problems and keeps Save handoff", async () => {
  handoffFixture.status = { status: "pending", requestId: "req-1", conversation: { kind: "code", id: "run-a" }, covered: null };
  handoffFixture.call = async (name, input) => {
    handoffFixture.calls.push({ name, input });
    return name === "vivary-handoff-save" ? { code: "refused", problems: ["goal: Required"] } : handoffFixture.status;
  };
  await render(); await settle();
  await click("Save handoff");
  assert.match(host.textContent, /goal: Required/);
  assert.ok(button("Save handoff"));
});

test("an unsaved Native conversation shows nothing until a conversation update finds it", async () => {
  let saved = false;
  handoffFixture.call = async (name, input) => {
    handoffFixture.calls.push({ name, input });
    if (!saved) throw Object.assign(new Error("The linked conversation is no longer available in this project."),
      { errorCode: "vivary_linked_history_unavailable" });
    return { status: "none", path: "STATE.md" };
  };
  await render({ conversation: { kind: "native", id: "unsaved-thread" } }); await settle();
  assert.equal(host.textContent, "");
  saved = true;
  await act(async () => window.dispatchEvent(new window.Event("agent-chat:threads-updated"))); await settle();
  assert.match(host.textContent, /No handoff saved/);
  assert.deepEqual(handoffFixture.submitted, []);
});

test("Out of date names the reasons", async () => {
  handoffFixture.status = { status: "out-of-date", covered, reasons: ["head-moved", "document-edited"] };
  await render(); await settle();
  assert.match(host.textContent, /out of date/i);
  assert.match(host.textContent, /Git commit or branch changed/);
  assert.match(host.textContent, /STATE\.md was edited/);
});

test("a failed save keeps the previous version, shows no fresh status, and Retry saves the same request", async () => {
  handoffFixture.status = { status: "failed", requestId: "req-1", conversation: { kind: "code", id: "run-a" },
    message: "Vivary could not write STATE.md. The previous version of STATE.md is kept.", retryable: true, covered };
  await render(); await settle();
  assert.match(host.textContent, /Handoff not saved[\s\S]*previous version of STATE\.md is kept/);
  assert.doesNotMatch(host.textContent, /is fresh/);
  await click("Retry");
  assert.equal(handoffFixture.calls.find(call => call.name === "vivary-handoff-save").input.requestId, "req-1");
});

test("a Code run that ends rechecks freshness", async () => {
  await render({ disabled: true }); await settle();
  const checks = () => handoffFixture.calls.filter(call => call.name === "vivary-handoff-freshness").length;
  const before = checks();
  await render({ disabled: false }); await settle();
  assert.ok(checks() > before, "the end of the run is a conversation update");
  assert.deepEqual(handoffFixture.submitted, []);
});

test("a Prepare that returns after the owner opened another conversation sends nothing", async () => {
  handoffFixture.status = { status: "none", path: "STATE.md" };
  let finish;
  const answer = handoffFixture.call;
  handoffFixture.call = (name, input) => name === "vivary-handoff-prepare"
    ? new Promise(resolve => { finish = () => resolve(answer(name, input)); })
    : answer(name, input);
  await render({ conversation: { kind: "native", id: "thread-a" } }); await settle();
  await act(async () => button("Prepare handoff").click());
  await render({ conversation: { kind: "native", id: "thread-b" } }); await settle();
  await act(async () => finish()); await settle();
  assert.deepEqual(handoffFixture.submitted, [], "the request is not delivered to the newly selected conversation");
});

test("a conflict that the same request can never save offers Update handoff, not Retry", async () => {
  handoffFixture.status = { status: "failed", requestId: "req-1", conversation: { kind: "code", id: "run-a" },
    message: "STATE.md changed after Prepare. Its current text is kept. Prepare the handoff again.", retryable: false, covered };
  await render(); await settle();
  assert.match(host.textContent, /Prepare the handoff again/);
  assert.equal(button("Retry"), undefined);
  assert.ok(button("Update handoff"));
});

test("an unavailable state document explains why and offers no Prepare", async () => {
  handoffFixture.status = { status: "unavailable", reason: "no-state-role",
    message: "This project has no designated state document such as STATE.md." };
  await render(); await settle();
  assert.match(host.textContent, /no designated state document/);
  assert.equal(button("Prepare handoff"), undefined);
});

test("a run already active at mount disables Prepare until that run ends", async () => {
  handoffFixture.status = { status: "none", path: "STATE.md" };
  const probes = [];
  // Native reads the same active-run state its composer reads on mount.
  await render({ conversation: { kind: "native", id: "thread-b" },
    runActive: async () => { probes.push("thread-b"); return true; } }); await settle();
  assert.deepEqual(probes, ["thread-b"]);
  assert.equal(button("Prepare handoff").disabled, true);
  const ended = new window.Event("agentNative.chatRunning");
  Object.defineProperty(ended, "detail", { value: { tabId: "native-ui-tab", isRunning: false } });
  await act(async () => window.dispatchEvent(ended)); await settle();
  assert.equal(button("Prepare handoff").disabled, false);
  // Code passes the run state its composer already has.
  await render({ disabled: true }); await settle();
  assert.equal(button("Prepare handoff").disabled, true);
  await render({ disabled: false }); await settle();
  assert.equal(button("Prepare handoff").disabled, false);
  assert.deepEqual(handoffFixture.submitted, []);
});

test("Prepare is disabled while a run is active", async () => {
  handoffFixture.status = { status: "none", path: "STATE.md" };
  await render({ disabled: true }); await settle();
  assert.equal(button("Prepare handoff").disabled, true);
  await render(); await settle();
  assert.equal(button("Prepare handoff").disabled, false);
  const running = new window.Event("agentNative.chatRunning");
  Object.defineProperty(running, "detail", { value: { tabId: "native-ui-tab", isRunning: true } });
  await act(async () => window.dispatchEvent(running)); await settle();
  assert.equal(button("Prepare handoff").disabled, true);
});
