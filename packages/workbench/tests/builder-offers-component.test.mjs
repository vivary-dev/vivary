import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// Issue #104. The local app's missing-access card offers the owner's own provider keys and no
// Builder.io option, and the file storage card keeps its custom-key path. The cards are Core's, so
// the proof bundles Core's installed, patched modules and renders them with the page config the
// server sends in local mode. Core's real provider-key form renders inside the card.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const CLIENT = join(CORE, "dist", "client");

// Only the Builder connect flow, which polls a status route, and the translation hook are stubbed.
// They are matched by the file they resolve to, so every importer gets the same stub.
const stubs = new Map([
  [join(CLIENT, "settings", "useBuilderStatus.js"), `
    export function useBuilderConnectFlow() {
      return { configured: false, connecting: false, error: null, orgName: null, statusResolved: true, start() {} };
    }
    export function useBuilderStatus() { return { status: null, refetch() {} }; }`],
  [join(CLIENT, "settings", "BuilderConnectPopover.js"), `
    import { builderOffersEnabled } from "${join(CORE, "dist", "shared", "builder-offers.js").replaceAll("\\", "/")}";
    export function BuilderConnectPopover({ children }) { return builderOffersEnabled() ? children : null; }`],
  [join(CLIENT, "i18n.js"), `
    export function useT() { return (key, options) => options?.defaultValue ?? key; }
    export function useFormatters() { return {}; }`],
]);

const proofSource = String.raw`
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BuilderSetupCard } from "@proof/run-recovery";
import { FileStorageSetupCard } from "@proof/file-storage";

async function render(builderOffers, element) {
  window.__AGENT_NATIVE_CONFIG__ = builderOffers ? {} : { builderOffers: false };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  const snapshot = {
    text: host.textContent,
    buttons: [...host.querySelectorAll("button")].map(button => button.textContent),
    inputs: [...host.querySelectorAll("input")].map(input => input.getAttribute("type") ?? "text"),
    cards: host.querySelectorAll('[data-testid="file-storage-setup-card"]').length,
  };
  await act(async () => { root.unmount(); });
  host.remove();
  return snapshot;
}
export const renderMissingAccess = builderOffers => render(builderOffers, <BuilderSetupCard onConnected={() => {}} />);
export const renderFileStorage = builderOffers => render(builderOffers, <FileStorageSetupCard />);
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: HERE, sourcefile: "builder-offers-proof.tsx", loader: "tsx" },
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
      name: "builder-offers-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/run-recovery") return { path: join(CLIENT, "chat", "run-recovery.js") };
          if (args.path === "@proof/file-storage") return { path: join(CLIENT, "FileStorageSetupCard.js") };
          if (args.path.startsWith(".") && args.importer.startsWith(CORE)) {
            const target = resolve(dirname(args.importer), args.path);
            if (stubs.has(target)) return { path: target, namespace: "stub" };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
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
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
    ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
}

test("the local app's cards offer the owner's own keys and no Builder.io", async t => {
  const proof = await import(`data:text/javascript;base64,${Buffer.from(await buildProof()).toString("base64")}`);
  const closeChannels = installDom();
  t.after(() => closeChannels());

  await t.test("the missing-access card shows the real key form and no Builder offer", async () => {
    const local = await proof.renderMissingAccess(false);
    assert.doesNotMatch(local.text, /builder/i, "no Builder text");
    assert.deepEqual(local.buttons.filter(label => /builder|credits/i.test(label)), [], "no Builder button");
    assert.match(local.text, /Connect AI/);
    assert.match(local.text, /Add your own provider keys\./);
    assert.ok(local.inputs.length >= 1, "Core's provider-key form renders its key field without a toggle");
    // Control: Core's own behavior still offers Builder.io, and its key form waits behind a toggle.
    const hosted = await proof.renderMissingAccess(true);
    assert.match(hosted.text, /builder/i);
    assert.equal(hosted.inputs.length, 0);
  });

  await t.test("the file storage card keeps its custom-key path", async () => {
    const local = await proof.renderFileStorage(false);
    assert.equal(local.cards, 1, "the card still renders");
    assert.doesNotMatch(local.text, /builder/i, "no Builder text");
    assert.match(local.text, /Use custom storage keys/);
    assert.match(local.text, /Configure an S3-compatible bucket with a stable public URL\./);
    const hosted = await proof.renderFileStorage(true);
    assert.match(hosted.text, /Connect Builder for file storage/);
    assert.match(hosted.text, /Use custom storage keys/);
  });
});

test.after(() => esbuild.stop());
