import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Issue #121. The host strip names the coding processes an earlier run left behind and offers End them, then
// Continue anyway when End them could not end everything or when Vivary cannot scan. The component, its request
// fields, and React are real. The host-state query, the owner action transport, project selection, navigation, and the
// toolkit button are stubbed.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const CONTROL = join(WORKBENCH, "app", "components", "layout", "CodeRunControl.tsx");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));

const stubs = new Map([
  ["@agent-native/core/client/hooks", `
    import { useSyncExternalStore } from "react";
    let state = { data: undefined, error: null };
    const listeners = new Set();
    export const hostProof = { set(data) { state = { data, error: null }; for (const listener of listeners) listener(); } };
    export function useActionQuery() {
      const current = useSyncExternalStore(listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, () => state);
      return { ...current, refetch: async () => current };
    }
    export function actionErrorMessage(failure) { return failure?.message; }`],
  ["../../lib/native-actions", `
    export const callProof = { calls: [], answer: null };
    export function useNativeActionCaller() {
      return { ready: true, retrySession() {}, call(name, params) {
        callProof.calls.push({ name, params });
        return callProof.answer;
      } };
    }`],
  ["../projects/ProjectContext", `
    export function useProjects() { return { catalog: { projects: [] }, async selectProject() { return true; } }; }`],
  ["react-router", `export function useNavigate() { return () => {}; }
    export function useLocation() { return { pathname: "/", search: "" }; }`],
  ["@agent-native/toolkit/ui", `
    import { forwardRef } from "react";
    export const Button = forwardRef(function Button({ size, variant, ...props }, ref) {
      return <button ref={ref} type="button" {...props} />;
    });`],
]);

const proofSource = String.raw`
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CodeRunControl } from "@proof/CodeRunControl";
import { hostProof } from "@agent-native/core/client/hooks";
import { callProof } from "../../lib/native-actions";

const HOST = { activeRuns: [], recentRun: null, busy: false };
const NAMED = {
  version: "4a1b2c3d4e5f6a7b",
  heading: "Coding processes from an earlier run are still running",
  instruction: "Choose End them to stop these processes. Vivary ends only the processes listed here and then checks again.",
  remaining: [{ pid: 4120, name: "codex.exe", confirmed: true },
    { pid: 5532, name: "mcp-server-windows-x64.exe", confirmed: true }],
  unlisted: 0, canEnd: true, canContinue: false, checking: false,
  run: { id: "run-leftover", title: "Refactor the parser", projectId: null },
};
const UNSCANNED = {
  version: "0f1e2d3c4b5a6978",
  heading: "Vivary could not confirm that an earlier run's coding processes stopped",
  instruction: "Vivary could not list the processes. Check them with \u0060pgrep -l -g 4120\u0060, stop them with "
    + "\u0060kill -KILL -- -4120\u0060, then choose Continue anyway.",
  remaining: [], unlisted: 0, canEnd: false, canContinue: true, checking: false, run: null,
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount(cleanup, state = {}) {
  hostProof.set({ ...HOST, ...state, cleanup });
  callProof.calls = [];
  const main = document.createElement("main");
  main.id = "workbench-content";
  const host = document.createElement("div");
  document.body.append(host, main);
  const root = createRoot(host);
  await act(async () => { root.render(<CodeRunControl />); });
  return { host, main, dispose: async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    main.remove();
  } };
}

const region = host => host.querySelector('[role="region"][aria-label="Leftover coding processes"]');
const buttons = host => [...host.querySelectorAll("button")].map(button => button.textContent);
const button = (host, label) => [...host.querySelectorAll("button")].find(item => item.textContent === label);
const alertText = host => host.querySelector('[role="alert"]')?.textContent ?? null;
const statusText = host => region(host)?.querySelector('[role="status"]')?.textContent ?? null;

async function click(element) {
  await act(async () => { element.click(); });
}

async function settle(pending, next) {
  await act(async () => {
    hostProof.set({ ...HOST, cleanup: next });
    pending.resolve({ ...HOST, cleanup: next });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

export async function endThemLiftsTheRefusal() {
  const { host, main, dispose } = await mount(NAMED);
  try {
    assert.ok(region(host), "the strip is a labelled region");
    assert.equal(host.querySelector("h2")?.textContent, NAMED.heading);
    assert.deepEqual([...host.querySelectorAll("li")].map(item => item.textContent),
      ["codex.exe (PID 4120)", "mcp-server-windows-x64.exe (PID 5532)"]);
    assert.deepEqual(buttons(host), ["End them", "Open conversation"]);
    const pending = deferred();
    callProof.answer = pending.promise;
    await click(button(host, "End them"));
    const ending = button(host, "Ending…");
    assert.ok(ending, "End them reads Ending… while it runs");
    assert.equal(ending.getAttribute("aria-disabled"), "true");
    assert.equal(ending.hasAttribute("disabled"), false, "focus stays on the control");
    await click(ending);
    assert.deepEqual(callProof.calls, [{ name: "vivary-code-cleanup",
      params: { decision: "end", version: NAMED.version } }], "the choice names the list on screen");
    await settle(pending, null);
    assert.equal(region(host), null, "the strip closes once nothing is left");
    assert.equal(document.activeElement, main, "focus moves to the page");
  } finally { await dispose(); }
}

export async function endThemThatLeavesProcessesOffersContinue() {
  const { host, dispose } = await mount(NAMED);
  try {
    const ended = deferred();
    callProof.answer = ended.promise;
    await click(button(host, "End them"));
    const left = { ...NAMED, version: "5b6c7d8e9fa0b1c2",
      remaining: [{ pid: 5532, name: "mcp-server-windows-x64.exe", confirmed: true },
        { pid: 6100, name: "unrelated.exe", confirmed: false }], canContinue: true,
      notice: "End them ended codex.exe (PID 4120). Vivary could not end mcp-server-windows-x64.exe (PID 5532)." };
    await settle(ended, left);
    assert.equal(alertText(host), null, "the strip adds no words of its own");
    assert.equal(statusText(host), left.notice, "it shows what the server says End them did");
    assert.deepEqual([...host.querySelectorAll("li")].map(item => item.textContent),
      ["mcp-server-windows-x64.exe (PID 5532)", "unrelated.exe (PID 6100, not confirmed from that run)"]);
    assert.deepEqual(buttons(host), ["End them", "Continue anyway", "Open conversation"]);
    const continued = deferred();
    callProof.answer = continued.promise;
    await click(button(host, "Continue anyway"));
    assert.ok(button(host, "Continuing…"));
    assert.deepEqual(callProof.calls.map(call => call.params),
      [{ decision: "end", version: NAMED.version }, { decision: "continue", version: left.version }]);
    await settle(continued, null);
    assert.equal(region(host), null);
  } finally { await dispose(); }
}

export async function endThemWhoseCheckCannotRunShowsTheServerState() {
  const { host, dispose } = await mount(NAMED);
  try {
    const ended = deferred();
    callProof.answer = ended.promise;
    await click(button(host, "End them"));
    const unchecked = { ...UNSCANNED, version: "6c7d8e9fa0b1c2d3", notice: "End them ended codex.exe (PID 4120)." };
    await settle(ended, unchecked);
    assert.equal(host.querySelector("h2")?.textContent, UNSCANNED.heading);
    assert.equal(alertText(host), null, "nothing claims the processes are still running");
    assert.equal(statusText(host), unchecked.notice);
    assert.deepEqual(buttons(host), ["Continue anyway"]);
  } finally { await dispose(); }
}

export async function aCutListSaysHowManyProcessesItDoesNotList() {
  const { host, dispose } = await mount({ ...NAMED, unlisted: 5 });
  try {
    assert.deepEqual([...host.querySelectorAll("li")].map(item => item.textContent),
      ["codex.exe (PID 4120)", "mcp-server-windows-x64.exe (PID 5532)", "and 5 more not listed"]);
  } finally { await dispose(); }
}

export async function aScanVivaryCannotRunOffersOnlyContinue() {
  const { host, dispose } = await mount(UNSCANNED);
  try {
    assert.equal(host.querySelector("h2")?.textContent, UNSCANNED.heading);
    assert.equal(host.querySelectorAll("li").length, 0);
    assert.deepEqual([...host.querySelectorAll("code")].map(code => code.textContent),
      ["pgrep -l -g 4120", "kill -KILL -- -4120"]);
    assert.equal(region(host).querySelector("p")?.textContent,
      "Vivary could not list the processes. Check them with pgrep -l -g 4120, stop them with kill -KILL -- -4120, "
      + "then choose Continue anyway.");
    assert.deepEqual(buttons(host), ["Continue anyway"]);
  } finally { await dispose(); }
}

export async function aRunningCheckHoldsEndThem() {
  const { host, dispose } = await mount({ ...NAMED, checking: true });
  try {
    const checking = button(host, "Checking…");
    assert.ok(checking);
    assert.equal(checking.getAttribute("aria-disabled"), "true");
    await click(checking);
    assert.deepEqual(callProof.calls, [], "a click during a check does nothing");
  } finally { await dispose(); }
}

export async function aFailedStopsOwnCheckOffersNoChoice() {
  const checking = { ...UNSCANNED, heading: "Vivary is checking what a failed stop left running",
    instruction: "The choices appear here when the check ends.", canContinue: false, checking: true };
  const { host, dispose } = await mount(checking);
  try {
    assert.equal(host.querySelector("h2")?.textContent, checking.heading);
    assert.equal(region(host).querySelector("p")?.textContent, checking.instruction);
    assert.deepEqual(buttons(host), [], "nothing to choose until the check ends");
  } finally { await dispose(); }
}

export async function theOwnerSeesItsFailedStopsCheckInPlaceOfStop() {
  const run = { id: "run-crashed", title: "Refactor the parser", projectId: null };
  const checking = { ...UNSCANNED, heading: "Vivary is checking what a failed stop left running",
    instruction: "The choices appear here when the check ends.", canContinue: false, checking: true, run };
  const { host, dispose } = await mount(checking, { activeRuns: [activeRun(run)], busy: true });
  try {
    assert.equal(host.querySelector("h2")?.textContent, checking.heading, "the strip shows the check, not the run working");
    assert.equal(region(host).querySelector("p")?.textContent, checking.instruction);
    assert.deepEqual(buttons(host), ["Open conversation"], "no Stop and no choice until the check ends");
  } finally { await dispose(); }
}

function activeRun(run, extra = {}) {
  return { status: "running", phase: "running", workspaceLabel: "Parser", engineLabel: "Claude Code", model: "sonnet",
    stopping: false, pendingApprovals: [], ...run, ...extra };
}

// Codex numbers its requests per session, so two runs can each wait on request 17.
function approval(run, requestId = "17") {
  return { requestId, method: "item/commandExecution/requestApproval", params: { command: "read " + run.id },
    runId: run.id, title: run.title, projectId: run.projectId, workspaceLabel: "Parser" };
}

const CLAUDE_RUN = { id: "run-claude", title: "Write the parser tests", projectId: null };
const CODEX_RUN = { id: "run-codex", title: "Refactor the parser", projectId: null };
const OTHER_CODEX_RUN = { id: "run-codex-2", title: "Update the docs", projectId: null };

export async function eachRunningConversationHasItsOwnApprovalsAndStop() {
  const runs = [activeRun(CLAUDE_RUN), activeRun(CODEX_RUN, { engineLabel: "Codex CLI", pendingApprovals: [approval(CODEX_RUN)] }),
    activeRun(OTHER_CODEX_RUN, { engineLabel: "Codex CLI", pendingApprovals: [approval(OTHER_CODEX_RUN)] })];
  const { host, dispose } = await mount(null, { activeRuns: runs, busy: true });
  try {
    const rows = [...host.querySelectorAll('[aria-label="Running conversations"] > li')];
    assert.deepEqual(rows.map(row => row.getAttribute("aria-label")), runs.map(run => run.title));
    assert.deepEqual(rows.map(row => row.querySelector('[role="status"]')?.textContent), [
      "Agent working in Personal workspace (Claude Code): Write the parser tests",
      "Agent working in Personal workspace (Codex CLI): Refactor the parser",
      "Agent working in Personal workspace (Codex CLI): Update the docs"]);
    assert.deepEqual(rows.map(row => [...row.querySelectorAll('[role="region"]')].map(card => card.getAttribute("aria-label"))),
      [[], ["Codex request: Refactor the parser"], ["Codex request: Update the docs"]], "each request sits in its run's row");
    const allow = row => [...row.querySelectorAll("button")].find(item => item.textContent === "Allow once");
    await click(allow(rows[2]));
    assert.deepEqual(callProof.calls, [{ name: "vivary-code-approve", params: { runId: OTHER_CODEX_RUN.id, requestId: "17",
      projectId: undefined, answers: {}, content: {} } }], "Allow once answers only its own run's request");
    callProof.calls = [];
    await click(rows[1].querySelector('[aria-label="Stop Refactor the parser"]'));
    assert.deepEqual(callProof.calls, [{ name: "vivary-code-stop", params: { runId: CODEX_RUN.id, projectId: undefined } }],
      "Stop stops only its own run");
    callProof.calls = [];
    const decline = [...rows[1].querySelectorAll("button")].find(item => item.textContent === "Decline");
    await click(decline);
    assert.deepEqual(callProof.calls, [{ name: "vivary-code-deny", params: { runId: CODEX_RUN.id, requestId: "17",
      projectId: undefined } }]);
  } finally { await dispose(); }
}

export async function aStoppingRunHoldsItsStopOnly() {
  const runs = [activeRun(CLAUDE_RUN, { stopping: true }), activeRun(CODEX_RUN, { engineLabel: "Codex CLI" })];
  const { host, dispose } = await mount(null, { activeRuns: runs, busy: true });
  try {
    const stops = runs.map(run => host.querySelector('[aria-label="Stop ' + run.title + '"]'));
    assert.deepEqual(stops.map(stop => [stop.textContent, stop.disabled]), [["Stopping…", true], ["Stop", false]]);
    assert.equal(host.querySelector('[aria-label="Running conversations"] > li')?.querySelector('[role="status"]')?.textContent,
      "Stopping in Personal workspace (Claude Code): Write the parser tests");
  } finally { await dispose(); }
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: join(WORKBENCH, "app", "components", "layout"),
      sourcefile: "code-run-control-cleanup-proof.tsx", loader: "tsx" },
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
      name: "code-run-control-cleanup-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/CodeRunControl") return { path: CONTROL };
          if (stubs.has(args.path)) return { path: args.path, namespace: "stub" };
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
      },
    }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => resolve(WORKBENCH, input));
  assert.ok(inputs.includes(CONTROL), "the proof bundles the real CodeRunControl");
  return result.outputFiles[0].text;
}

function installDom() {
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const view = linkedom.parseHTML("<!doctype html><html><body></body></html>");
  // linkedom tracks no focus, so the proof records the element that last received it.
  let focused = null;
  view.HTMLElement.prototype.focus = function focus() { focused = this; };
  Object.defineProperty(view.document, "activeElement", { configurable: true, get: () => focused ?? view.document.body });
  // React schedules through MessageChannel. Open ports keep Node alive, so the proof closes them.
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
}

test("the host strip lists leftover coding processes and offers End them, then Continue anyway", async t => {
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  const closeChannels = installDom();
  t.after(() => closeChannels());
  for (const [name, run] of [
    ["End them lifts the refusal and moves focus to the page", proof.endThemLiftsTheRefusal],
    ["End them that leaves processes running offers Continue anyway", proof.endThemThatLeavesProcessesOffersContinue],
    ["End them whose check after it cannot run shows the server's state", proof.endThemWhoseCheckCannotRunShowsTheServerState],
    ["a list cut at 50 says how many processes it does not list", proof.aCutListSaysHowManyProcessesItDoesNotList],
    ["a scan Vivary cannot run offers only Continue anyway and shows its commands", proof.aScanVivaryCannotRunOffersOnlyContinue],
    ["a check already running holds End them", proof.aRunningCheckHoldsEndThem],
    ["a failed stop's own check offers no choice and says why", proof.aFailedStopsOwnCheckOffersNoChoice],
    ["the run's owner sees its failed stop's check in place of Stop", proof.theOwnerSeesItsFailedStopsCheckInPlaceOfStop],
    ["each running conversation has its own approvals and Stop", proof.eachRunningConversationHasItsOwnApprovalsAndStop],
    ["a stopping run holds only its own Stop", proof.aStoppingRunHoldsItsStopOnly],
  ]) await t.test(name, () => run());
});

test.after(() => esbuild.stop());
