import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// Same DOM and bundling composition as the maintained conversation tests. The real Settings page and the
// real conversation footer render. Only the action hooks and toolkit primitives are stubbed.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@agent-native/core/client/hooks", `
    export const useActionQuery = name => globalThis.labelFixture.queries[name];
    export const callAction = async () => ({});
    export const actionErrorMessage = () => undefined;`],
  ["@agent-native/core/client/settings", `import { createElement } from "react";
    export const SettingsGroup = ({ title, children }) => createElement("section", { "data-group": title }, createElement("h3", null, title), children);
    export const SettingsRow = ({ id, label, description, status, children }) => createElement("div", { id },
      createElement("h4", null, label), createElement("p", null, description), status, children);`],
  ["@agent-native/toolkit/ui", `import { createElement } from "react";
    export const Button = ({ size, variant, ...props }) => createElement("button", props);
    export const Badge = ({ variant, ...props }) => createElement("span", { "data-badge": "", ...props });
    export const Skeleton = props => createElement("span", props);`],
]);
const bundle = await build({ stdin: { contents: `
  export { LocalRuntimeSettings } from "./app/components/settings/LocalRuntimeSettings";
  export { CodeConversationLimits } from "./app/components/workspace/CodeConversationLimits";
  export * from "./app/lib/code-permission-labels";`, loader: "tsx", resolveDir: workbench },
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react/*", "react-dom/*"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);
const { CLAUDE_CODE_PERMISSION_LABEL, CODEX_PERMISSION_LABEL, EXECUTION_MODE_SCOPE_LABEL,
  CodeConversationLimits, LocalRuntimeSettings } = module.exports;
const { createElement } = await import("react");

let host, root;
test.beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
test.afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = element => act(async () => root.render(element));

function settingsFixture(mode) {
  const checkedAt = "2026-10-24T00:00:00.000Z";
  globalThis.labelFixture = { queries: {
    "vivary-code-permissions": { data: { mode }, error: null, refetch: async () => {} },
    "vivary-runtime-status": { isPending: false, error: null, refetch: async () => {}, data: {
      codexModels: null, claudeModels: null, runtimes: [
        { engine: "claude-cli", label: "Claude Code", status: "ready", message: "Claude Code is signed in.", checkedAt, version: "2.1.309" },
        { engine: "codex-cli", label: "Codex", status: "update-required", checkedAt, version: "0.148.0",
          message: "Update Codex to 0.160.0 or later, then refresh. Installed: 0.148.0." },
      ] } },
  } };
}

test("Settings says the execution mode applies to Codex and that Claude Code accepts edits, in every mode", async () => {
  for (const mode of ["normal", "read-only", "yolo"]) {
    settingsFixture(mode);
    await render(createElement(LocalRuntimeSettings));
    const group = host.querySelector('[data-group="Codex permissions"]');
    assert.ok(group, "the execution mode keeps its Codex group");
    assert.equal(group.textContent.includes(EXECUTION_MODE_SCOPE_LABEL), true, `${mode}: ${group.textContent}`);
    assert.match(EXECUTION_MODE_SCOPE_LABEL, /applies to Codex only/);
    assert.match(EXECUTION_MODE_SCOPE_LABEL, /Claude Code .*accept file edits without asking/);
  }
});

test("Settings labels an older CLI as Update required and links its update", async () => {
  settingsFixture("normal");
  await render(createElement(LocalRuntimeSettings));
  const codex = host.querySelector("#codex-cli");
  assert.equal(codex.querySelector("[data-badge]").textContent, "Update required");
  assert.match(codex.textContent, /Update Codex to 0\.160\.0 or later, then refresh\. Installed: 0\.148\.0\./);
  assert.match([...codex.querySelectorAll("a")].map(link => link.textContent).join("\n"), /^Update Codex/m);
  assert.equal(host.querySelector("#claude-cli [data-badge]").textContent, "Signed in");
});

test("the conversation footer names each runtime's permissions", async () => {
  await render(createElement(CodeConversationLimits, { engine: "claude-cli", engineLabel: "Claude Code", model: "claude-sonnet-5-5" }));
  assert.equal(host.textContent.includes(CLAUDE_CODE_PERMISSION_LABEL), true, host.textContent);
  assert.match(host.textContent, /^Claude Code · claude-sonnet-5-5\. Claude Code accepts file edits without asking\. The execution mode in Runtime settings applies to Codex only\./);
  assert.match(host.textContent, /Use Stop to end the active turn\.$/);
  await render(createElement(CodeConversationLimits, { engine: "codex-cli", engineLabel: "Codex", model: "gpt-fixture" }));
  assert.equal(host.textContent.includes(CODEX_PERMISSION_LABEL), true, host.textContent);
  assert.doesNotMatch(host.textContent, /accepts file edits/);
});
