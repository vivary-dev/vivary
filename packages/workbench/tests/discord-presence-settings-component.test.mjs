import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// PR #323 review B2. Settings > Discord presence shows the saved sharing setting, never one a failed save only asked
// for. The component and React are real. The settings actions, the settings layout and the toolkit controls are stubbed.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const SETTINGS = join(WORKBENCH, "app", "components", "settings", "DiscordPresenceSettings.tsx");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));

const stubs = new Map([
  // The stored settings live here. A refetch reads them, as the real query reads the settings file.
  ["@agent-native/core/client/hooks", `
    import { useState } from "react";
    export const settingsProof = { saved: null, calls: [], update: async () => undefined };
    export function useActionQuery() {
      const [data, setData] = useState(() => structuredClone(settingsProof.saved));
      return { data, isError: false, refetch: async () => {
        const next = structuredClone(settingsProof.saved);
        setData(next);
        return { data: next };
      } };
    }
    export async function callAction(name, params) {
      settingsProof.calls.push({ name, params });
      return settingsProof.update(params);
    }
    export function actionErrorMessage(cause) { return cause instanceof Error ? cause.message : null; }`],
  ["@agent-native/core/client/settings", `
    export function SettingsGroup({ title, children }) { return <section aria-label={title}>{children}</section>; }
    export function SettingsRow({ id, label, control }) { return <div id={id}><span>{label}</span>{control}</div>; }`],
  ["@agent-native/toolkit/ui", `
    import { forwardRef } from "react";
    export const Button = forwardRef(function Button({ size, variant, ...props }, ref) {
      return <button ref={ref} {...props} />;
    });
    export const Input = forwardRef(function Input(props, ref) { return <input ref={ref} {...props} />; });`],
]);

const proofSource = String.raw`
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DiscordPresenceSettings } from "@proof/DiscordPresenceSettings";
import { settingsProof } from "@agent-native/core/client/hooks";

const APPLICATION_ID = "123456789012345678";

async function flush() {
  await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
}

async function mount(enabled, update) {
  settingsProof.saved = { discord: { enabled, applicationId: APPLICATION_ID } };
  settingsProof.calls = [];
  settingsProof.update = update;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DiscordPresenceSettings />); });
  await flush();
  return { host, dispose: async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  } };
}

const toggle = host => host.querySelector("#discord-enabled input[type=checkbox]");
const shown = host => ({ checked: toggle(host).checked, label: toggle(host).nextElementSibling.textContent,
  applicationId: host.querySelector("input[aria-label='Discord application id']").value });

// A browser flips the box before it dispatches the click, and React then puts back the value its state holds.
// linkedom has no checked property, so React keeps checked as a plain field on the element and reads it on click.
async function clickToggle(host) {
  const box = toggle(host);
  await act(async () => {
    box.checked = !box.checked;
    box.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

export async function aRejectedSaveKeepsTheSavedSetting(savedEnabled) {
  const { host, dispose } = await mount(savedEnabled, async () => { throw new Error("Desktop settings could not be saved."); });
  try {
    const before = savedEnabled ? { checked: true, label: "On", applicationId: APPLICATION_ID }
      : { checked: false, label: "Off", applicationId: APPLICATION_ID };
    assert.deepEqual(shown(host), before);
    await clickToggle(host);
    assert.deepEqual(settingsProof.calls, [{ name: "vivary-update-desktop-settings",
      params: { discord: { enabled: !savedEnabled, applicationId: APPLICATION_ID } } }], "the toggle asked to save");
    assert.equal(settingsProof.saved.discord.enabled, savedEnabled, "the stored setting did not change");
    assert.deepEqual(shown(host), before, "the toggle shows the stored setting");
    assert.equal(host.querySelector("[role=alert]")?.textContent, "Desktop settings could not be saved.");
  } finally { await dispose(); }
}

export async function aSaveThatFailsAfterWritingShowsTheWrittenSetting() {
  const { host, dispose } = await mount(true, async params => {
    settingsProof.saved = structuredClone(params);
    throw new Error("Discord presence could not be updated.");
  });
  try {
    await clickToggle(host);
    assert.equal(settingsProof.saved.discord.enabled, false, "the stored setting changed before the failure");
    assert.deepEqual(shown(host), { checked: false, label: "Off", applicationId: APPLICATION_ID },
      "the toggle shows the stored setting");
    assert.equal(host.querySelector("[role=alert]")?.textContent, "Discord presence could not be updated.");
  } finally { await dispose(); }
}

export async function aSuccessfulSaveShowsTheNewSetting() {
  const { host, dispose } = await mount(false, async params => { settingsProof.saved = structuredClone(params); });
  try {
    await clickToggle(host);
    assert.deepEqual(shown(host), { checked: true, label: "On", applicationId: APPLICATION_ID });
    assert.equal(host.querySelector("[role=alert]"), null);
  } finally { await dispose(); }
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: join(WORKBENCH, "app", "components", "settings"),
      sourcefile: "discord-presence-settings-proof.tsx", loader: "tsx" },
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
      name: "discord-presence-settings-proof",
      setup(build) {
        build.onResolve({ filter: /^@proof\/DiscordPresenceSettings$/ }, () => ({ path: SETTINGS }));
        build.onResolve({ filter: /^@agent-native\/(core\/client\/(hooks|settings)|toolkit\/ui)$/ },
          args => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
          contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
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

// A file rather than a data URL keeps a failure's stack trace readable.
const proofDirectory = await mkdtemp(join(tmpdir(), "vivary-discord-settings-"));
const proofFile = join(proofDirectory, "proof.mjs");
await writeFile(proofFile, await buildProof());
const proof = await import(pathToFileURL(proofFile).href);
const closeChannels = installDom();

test("a rejected opt-in leaves sharing shown as Off", () => proof.aRejectedSaveKeepsTheSavedSetting(false));
test("a rejected opt-out leaves sharing shown as On", () => proof.aRejectedSaveKeepsTheSavedSetting(true));
test("a save that wrote the setting and then failed shows the written setting", () =>
  proof.aSaveThatFailsAfterWritingShowsTheWrittenSetting());
test("a successful save shows the new setting", () => proof.aSuccessfulSaveShowsTheNewSetting());

test.after(async () => {
  closeChannels();
  await esbuild.stop();
  await rm(proofDirectory, { recursive: true, force: true });
});
