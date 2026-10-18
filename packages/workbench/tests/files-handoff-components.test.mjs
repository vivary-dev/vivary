import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// Mount the production Files route and HandoffControl with the same query cache.
// Only host transport, routing, and draft persistence are fixtures; real Save and Rename handlers run.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom lacks an oninput property; advertise its supported dispatch so React uses the modern input path.
window.document.oninput = null;
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@/lib/native-actions", `export const useNativeActionCaller = () => ({ ready: true, call: globalThis.handoffFixture.call });`],
  ["@agent-native/toolkit/ui", `import { createElement } from "react";
    export const Skeleton = () => createElement("div");
    export const Button = ({ size, variant, ...props }) => createElement("button", props);`],
]);

stubs.set("@agent-native/core/client/hooks", `import { useQuery } from "@tanstack/react-query";
  export const useActionQuery = (name, input, options) => useQuery({queryKey: ["action", name, input], queryFn: () => globalThis.handoffFixture.call(name, input), ...options});`);
stubs.set("@agent-native/toolkit/editor", `import {createElement} from "react"; export const SharedRichEditor = ({value}) => createElement("pre", null, value);`);
stubs.set("@agent-native/toolkit/editor.css", ``);
stubs.set("@/components/projects/ProjectContext", `export const useProjects = () => ({activeProject: {projectId: "alpha", displayName: "Alpha"}, catalog: {scopeKey: "owner"}, workspaceAvailable: true, checking: false});`);
stubs.set("@/components/projects/FileDrafts", `import {useState} from "react";
  export const fileDraftKey = async () => "draft-key";
  export function useFileDraft() { const [data, setData] = useState(globalThis.handoffFixture.draft);
    return {data, isPending: false, isError: false, saveStatus: "saved", put: value => {globalThis.handoffFixture.draft = value; setData(value);}}; }`);
stubs.set("react-router", `export const useLocation = () => ({pathname: "/", search: "?project=alpha&path=STATE.md", key: "first"});
  export const useSearchParams = () => [new URLSearchParams("project=alpha&path=STATE.md")];
  export const useNavigate = () => (...args) => globalThis.handoffFixture.navigation.push(args);`);

const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { HandoffControl } from "./app/components/workspace/HandoffControl";
  import FilesRoute from "./app/routes/files";
  export function view(props) {
    const client = globalThis.handoffFixture.client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: {gcTime: 0} } });
    return createElement(QueryClientProvider, { client }, createElement(HandoffControl, { projectId: "alpha",
      conversation: { kind: "code", id: "run-a" }, disabled: false, submit: globalThis.handoffFixture.submit, ...props }), createElement(FilesRoute));
  }`, loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", loader: {".css": "empty"}, external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : args.path.startsWith("@/lib/") ? {path: workbench + "/app/" + args.path.slice(2) + ".ts"} : undefined);
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
const baseFile = {path: "STATE.md", name: "STATE.md", version: "v1", content: "Original state", kind: "markdown", sizeBytes: 14, access: "editable"};
const dirtyDraft = {content: "Owner draft", baseContent: "Original state", baseVersion: "v1"};
function configure(mode = "saved", draft = dirtyDraft) {
  Object.assign(handoffFixture, {draft: draft ? {...draft} : null, navigation: [], file: {...baseFile}, mode, freshnessReads: 0});
  handoffFixture.call = async (name, input) => {
    handoffFixture.calls.push({name, input});
    if (name === "vivary-handoff-freshness") {
      handoffFixture.freshnessReads++;
      if (handoffFixture.failFreshness) throw new Error("Selected freshness read failed");
      return handoffFixture.status;
    }
    if (name === "vivary-project-files") return {code: "file", file: handoffFixture.file};
    if (name === "vivary-project-file-save" || name === "vivary-project-file-rename") {
      if (handoffFixture.mode === "error") throw new Error("Selected mutation transport failed");
      if (handoffFixture.mode === "conflict") return {code: "conflict", reason: "changed", current: {...baseFile, content: "Concurrent host edit", version: "v2"}};
      if (name === "vivary-project-file-save") handoffFixture.file = {...baseFile, content: input.content, version: "v2"};
      else handoffFixture.file = {...baseFile, path: input.name, name: input.name, version: "v2"};
      handoffFixture.status = {status: "out-of-date", covered, reasons: ["document-edited"]};
      return {code: name.endsWith("save") ? "saved" : "renamed", file: handoffFixture.file};
    }
    throw new Error("Unexpected call " + name);
  };
}
const render = (props = {}) => act(async () => root.render(module.exports.view(props)));
const settle = async () => { for (let phase = 0; phase < 3; phase++) await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); }); };
const button = label => [...host.querySelectorAll("button")].find(item => item.textContent === label);
const click = async label => { await act(async () => button(label).click()); await settle(); };



test("actual Files Save handler refreshes mounted handoff and clears only successful draft", async () => {
  configure(); await render(); await settle();
  assert.match(host.textContent, /is fresh/);
  await click("Resume edit");
  assert.equal(button("Save").disabled, false);
  await click("Save");
  assert.equal(handoffFixture.calls.find(call => call.name === "vivary-project-file-save").input.content, "Owner draft");
  assert.equal(handoffFixture.draft, null);
  assert.match(host.textContent, /File saved/);
  assert.match(host.textContent, /out of date/);
  assert.doesNotMatch(host.textContent, /is fresh/);
});

test("actual Files Rename handler refreshes handoff and navigates on success", async () => {
  configure("saved", {content: baseFile.content, baseContent: baseFile.content, baseVersion: "v1"});
  await render(); await settle(); await click("Rename");
  const input = host.querySelector("#file-name");
  input.type = "text"; // Browser default absent in linkedom; enables React text-input event recognition.
  await act(async () => {Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "RENAMED.md"); input.dispatchEvent(new window.Event("input", {bubbles:true})); input.dispatchEvent(new window.Event("change", {bubbles:true}));});
  await act(async () => host.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles:true, cancelable:true})));
  await settle();
  const call = handoffFixture.calls.find(call => call.name === "vivary-project-file-rename");
  assert.equal(call.input.name, "RENAMED.md");
  assert.equal(handoffFixture.draft, null);
  assert.equal(handoffFixture.navigation.length, 1);
  assert.match(handoffFixture.navigation[0][0].search, /RENAMED.md/);
  assert.match(host.textContent, /out of date/);
});

for (const outcome of ["conflict", "error"]) {
  test(`actual Files Save ${outcome} retains draft and does not report mutation success`, async () => {
    configure(outcome); await render(); await settle();
    const reads = handoffFixture.freshnessReads;
    await click("Resume edit"); await click("Save");
    assert.deepEqual(handoffFixture.draft, dirtyDraft);
    assert.equal(handoffFixture.freshnessReads, reads, "failed mutation must not imply a new successful file state");
    assert.doesNotMatch(host.textContent, /File saved/);
    assert.match(host.textContent, outcome === "conflict" ? /draft is retained/ : /Selected mutation transport failed/);
    assert.equal(host.querySelector("textarea").defaultValue, "Owner draft");
  });
  test(`actual Files Rename ${outcome} retains clean saved draft and stays on current file`, async () => {
    const draft = {content: baseFile.content, baseContent: baseFile.content, baseVersion: "v1"};
    configure(outcome, draft); await render(); await settle();
    const reads = handoffFixture.freshnessReads;
    await click("Rename");
    await act(async () => host.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles:true, cancelable:true})));
    await settle();
    assert.deepEqual(handoffFixture.draft, draft);
    assert.equal(handoffFixture.freshnessReads, reads);
    assert.equal(handoffFixture.navigation.length, 0);
    assert.doesNotMatch(host.textContent, /File saved/);
    assert.match(host.textContent, outcome === "conflict" ? /changed before it could be renamed/ : /Selected mutation transport failed/);
  });
}

test("unavailable Check again read failure exposes Retry check and recovers", async () => {
  configure(); handoffFixture.status = {status: "unavailable", reason: "state-missing", message: "Create STATE.md, then prepare the handoff."};
  await render(); await settle();
  handoffFixture.failFreshness = true;
  await click("Check again");
  assert.match(host.textContent, /freshness could not be checked/);
  assert.ok(button("Retry check"));
  handoffFixture.failFreshness = false;
  handoffFixture.status = {status: "none", path: "STATE.md"};
  await click("Retry check");
  assert.ok(button("Prepare handoff"));
  assert.deepEqual(handoffFixture.submitted, []);
  assert.equal(handoffFixture.calls.some(call => call.name === "vivary-project-file-save"), false);
});
