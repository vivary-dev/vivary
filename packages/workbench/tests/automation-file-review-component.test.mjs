import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Issue #109. Settings > Automation files lists the owner's instruction and memory files that automation runs wrote,
// each with its text as plain text, Accept, and Discard. The component and React are real. The owner action transport
// and the toolkit button are stubbed.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const REVIEW = join(WORKBENCH, "app", "components", "settings", "AutomationFileReview.tsx");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));

const stubs = new Map([
  // The real caller keeps one call function for the component's life, so the stand-in does too.
  ["../../lib/native-actions", `
    export const callProof = { calls: [], answer: () => ({ files: [] }) };
    async function call(name, params) {
      callProof.calls.push({ name, params });
      return callProof.answer(params);
    }
    export function useNativeActionCaller() {
      return { ready: true, retrySession() {}, call };
    }`],
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
import { AutomationFileReview } from "@proof/AutomationFileReview";
import { callProof } from "../../lib/native-actions";

const PLANTED = "# Rules\n\n![x](http://evil.test/x.png) <img src=x onerror=alert(1)> [click](http://evil.test)";
const CHANGED = "This file changed since the list showed it. Read it again before you accept or discard it.";
const UNCONFIRMED = "Your decision could not be confirmed. Check the list and try again if the file is still waiting.";
const AGENTS = { id: "res-agents", path: "AGENTS.md", content: PLANTED, updatedAt: Date.UTC(2026, 8, 29, 13) };

async function flush() {
  await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
}

async function mount(answer) {
  callProof.calls = [];
  callProof.answer = answer;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AutomationFileReview />); });
  await flush();
  return { host, dispose: async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  } };
}

const items = host => [...host.querySelectorAll("li")];
const button = (scope, label) => [...scope.querySelectorAll("button")].find(item => item.textContent === label);
async function click(element) {
  await act(async () => { element.click(); });
  await flush();
}

export async function aFileShowsItsPathAndPlainText() {
  const { host, dispose } = await mount(() => ({ files: [AGENTS] }));
  try {
    assert.deepEqual(callProof.calls, [{ name: "vivary-automation-files", params: { operation: "list" } }]);
    const [item] = items(host);
    assert.equal(item.querySelector("h3")?.textContent, "AGENTS.md");
    assert.equal(item.querySelector("pre")?.textContent, PLANTED, "the file shows as written");
    assert.match(host.textContent, /accepted|previous/i, "review copy identifies the version kept active");
    assert.match(host.textContent, /Discard/, "review copy explains the discard action");
    assert.doesNotMatch(host.textContent, /Delete removes the whole file/);
    assert.equal(host.querySelectorAll("img, a").length, 0, "a planted image or link is only text");
    assert.deepEqual([...item.querySelectorAll("button")].map(control => control.textContent), ["Accept", "Discard"]);
  } finally { await dispose(); }
}

export async function eachReviewNamesTheVersionShownAndReloads() {
  for (const [label, operation] of [["Accept", "accept"], ["Discard", "delete"]]) {
    let files = [AGENTS];
    const { host, dispose } = await mount(params => {
      if (params.operation !== "list") files = [];
      return { files };
    });
    try {
      await click(button(items(host)[0], label));
      assert.deepEqual(callProof.calls.map(call => call.params), [
        { operation: "list" },
        { operation, id: AGENTS.id, updatedAt: AGENTS.updatedAt },
        { operation: "list" },
      ]);
      assert.equal(items(host).length, 0, label + " clears the file from the list");
    } finally { await dispose(); }
  }
}

export async function aRefusedReviewShowsTheChangedFileWithANotice() {
  const changed = { ...AGENTS, content: "Changed text.", updatedAt: AGENTS.updatedAt + 1 };
  const SKILL = { id: "res-skill", path: "skills/probe/SKILL.md", content: "Skill text.", updatedAt: AGENTS.updatedAt };
  let files = [AGENTS, SKILL];
  const { host, dispose } = await mount(params => {
    if (params.operation === "accept") {
      files = [changed, SKILL];
      // The action refuses a review of a file that changed with 409, and both transports put the status on the error.
      throw Object.assign(new Error("This file changed. Reload the list."), { status: 409 });
    }
    return { files };
  });
  try {
    await click(button(items(host)[0], "Accept"));
    const [agents, skill] = items(host);
    assert.equal(agents.querySelector("pre")?.textContent, "Changed text.", "the list shows the file as it is now");
    assert.match(agents.textContent, new RegExp(CHANGED), "the refused file says it changed and must be read again");
    assert.equal(host.textContent.split(CHANGED).length - 1, 1, "one notice, on that file only");
    assert.doesNotMatch(skill.textContent, new RegExp(CHANGED));
  } finally { await dispose(); }
}

export async function anUnconfirmedReviewShowsFeedback() {
  for (const failure of [
    Object.assign(new Error("Sign in again to review automation files."), { status: 401 }),
    Object.assign(new Error("Server error"), { status: 500 }),
    new Error("Failed to fetch"),
  ]) {
    for (const label of ["Accept", "Discard"]) {
      const { host, dispose } = await mount(params => {
        if (params.operation !== "list") throw failure;
        return { files: [AGENTS] };
      });
      try {
        await click(button(items(host)[0], label));
        assert.equal(items(host).length, 1, "the file still waits");
        assert.equal(items(host)[0].querySelector("pre").textContent, AGENTS.content);
        assert.doesNotMatch(host.textContent, new RegExp(CHANGED), "an unconfirmed decision does not claim the file changed");
        assert.equal(host.querySelector('[role="alert"]')?.textContent, UNCONFIRMED,
          label + " reports an unconfirmed decision after " + failure.message);
      } finally { await dispose(); }
    }
  }
}

export async function aSuccessfulRetryClearsDecisionFeedback() {
  for (const label of ["Accept", "Discard"]) {
    let attempts = 0;
    let files = [AGENTS];
    const { host, dispose } = await mount(params => {
      if (params.operation !== "list") {
        attempts += 1;
        if (attempts === 1) throw new Error("Failed to fetch");
        files = [];
      }
      return { files };
    });
    try {
      await click(button(items(host)[0], label));
      assert.equal(host.querySelector('[role="alert"]')?.textContent, UNCONFIRMED);
      assert.equal(items(host).length, 1);
      await click(button(items(host)[0], label));
      assert.equal(attempts, 2, "the retry reaches the action");
      assert.equal(items(host).length, 0, "the successful decision removes the proposal");
      assert.equal(host.querySelector('[role="alert"]'), null, "a confirmed decision clears the earlier error");
      assert.doesNotMatch(host.textContent, new RegExp(CHANGED));
    } finally { await dispose(); }
  }
}

export async function anotherFilesSuccessPreservesDecisionFeedback() {
  for (const label of ["Accept", "Discard"]) {
    for (const failureFirst of [true, false]) {
      const skill = { ...AGENTS, id: "res-skill", path: "skills/probe/SKILL.md" };
      let files = [AGENTS, skill];
      const decisions = new Map();
      const { host, dispose } = await mount(params => {
        if (params.operation === "list") return { files };
        return new Promise((resolve, reject) => { decisions.set(params.id, { resolve, reject }); });
      });
      try {
        await click(button(items(host)[0], label));
        await click(button(items(host)[1], label));
        assert.equal(decisions.size, 2, "both files have decisions in flight");
        const fail = async () => {
          await act(async () => { decisions.get(AGENTS.id).reject(new Error("Failed to fetch")); });
          await flush();
        };
        const succeed = async () => {
          files = [AGENTS];
          await act(async () => { decisions.get(skill.id).resolve({}); });
          await flush();
        };
        if (failureFirst) {
          await fail();
          assert.equal(host.querySelector('[role="alert"]')?.textContent, UNCONFIRMED);
          await succeed();
        } else {
          await succeed();
          await fail();
        }
        assert.equal(items(host).length, 1, "only the unconfirmed proposal still waits");
        assert.equal(items(host)[0].querySelector("h3").textContent, AGENTS.path);
        assert.equal(host.querySelector('[role="alert"]')?.textContent, UNCONFIRMED,
          label + " preserves another file's error with failureFirst=" + failureFirst);
      } finally { await dispose(); }
    }
  }
}

export async function aListThatFailsSaysSo() {
  const { host, dispose } = await mount(() => { throw new Error("Server error: 500"); });
  try {
    assert.equal(items(host).length, 0);
    assert.match(host.textContent, /The list of waiting files could not load, so files may still be waiting\./,
      "a failed list does not look like an empty one");
  } finally { await dispose(); }
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: join(WORKBENCH, "app", "components", "settings"),
      sourcefile: "automation-file-review-proof.tsx", loader: "tsx" },
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
      name: "automation-file-review-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/AutomationFileReview") return { path: REVIEW };
          if (stubs.has(args.path)) return { path: args.path, namespace: "stub" };
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
      },
    }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => resolve(WORKBENCH, input));
  assert.ok(inputs.includes(REVIEW), "the proof bundles the real AutomationFileReview");
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
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
}

test("Settings > Automation files lists run-written files with their text, Accept, and Discard", async t => {
  assert.ok(existsSync(REVIEW), "Vivary has the Automation files tab");
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  const closeChannels = installDom();
  t.after(() => closeChannels());
  for (const [name, run] of [
    ["a file shows its path and its text as plain text", proof.aFileShowsItsPathAndPlainText],
    ["Accept and Discard name the version shown and reload the list", proof.eachReviewNamesTheVersionShownAndReloads],
    ["a refused review shows the file as it is now, with one notice to read it again",
      proof.aRefusedReviewShowsTheChangedFileWithANotice],
    ["an unconfirmed review shows feedback without claiming the file changed",
      proof.anUnconfirmedReviewShowsFeedback],
    ["a successful retry clears decision feedback", proof.aSuccessfulRetryClearsDecisionFeedback],
    ["another file's successful decision preserves feedback in either completion order",
      proof.anotherFilesSuccessPreservesDecisionFeedback],
    ["a list that fails to load says so", proof.aListThatFailsSaysSo],
  ]) await t.test(name, () => run());
});

test("the Settings page offers the Automation files tab", async () => {
  const settings = await readFile(join(WORKBENCH, "app", "routes", "settings.tsx"), "utf8");
  assert.ok(settings.includes('id: "automation-files"'), "the tab has its id");
  assert.ok(settings.includes('label: "Automation files"'), "the tab has its label");
  assert.ok(settings.includes("<AutomationFileReview />"), "the tab renders the review");
});

test.after(() => esbuild.stop());
