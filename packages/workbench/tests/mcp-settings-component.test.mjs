import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Issues #157 and #162. No Vivary launch serves an MCP endpoint, so Settings > MCP shows every user one note
// instead of Native's setup guides. Hosted mode refuses the coding runtimes tab, so the note links nowhere.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const SETTINGS = join(WORKBENCH, "app", "components", "settings", "McpSettings.tsx");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));

const proofSource = String.raw`
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { McpSettings } from "@proof/McpSettings";

export async function everyUserGetsTheNote() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<McpSettings />); });
  assert.equal(host.querySelector("p").textContent, "The Vivary app serves no MCP endpoint, so MCP clients cannot " +
    "connect to it. The separate vivary-mcp adapter offers read-only MCP access to a local workspace.");
  assert.equal(host.querySelectorAll("a, button").length, 0, "the note sends no one to a page their launch may refuse");
  await act(async () => { root.unmount(); });
  host.remove();
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: join(WORKBENCH, "app", "components", "settings"),
      sourcefile: "mcp-settings-proof.tsx", loader: "tsx" },
    absWorkingDir: WORKBENCH,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "mcp-settings-proof",
      setup(build) {
        build.onResolve({ filter: /^@proof\/McpSettings$/ }, () => ({ path: SETTINGS }));
      },
    }],
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
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
}

test("Settings > MCP shows every user the same note and no link", async t => {
  assert.ok(existsSync(SETTINGS), "Vivary has its own MCP settings content");
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  const closeChannels = installDom();
  t.after(() => closeChannels());
  await proof.everyUserGetsTheNote();
});

test("the Settings page replaces the content and search terms of Native's MCP tab", async () => {
  const settings = await readFile(join(WORKBENCH, "app", "routes", "settings.tsx"), "utf8");
  assert.match(settings,
    /tab\.id === "mcp" \? \{ \.\.\.tab, keywords: "mcp", searchEntries: \[\], content: <McpSettings \/> \}/);
});

test.after(() => esbuild.stop());
