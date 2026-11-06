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
  // Core's real layout, without the settings index and its panels, so the anchor Settings search scrolls to is real.
  ["@agent-native/core/client/settings", `
    export { SettingsGroup, SettingsRow } from ${JSON.stringify(join(CORE, "dist", "client", "settings", "SettingsRow.js"))};`],
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

const PASTED_ID = "987654321098765432";

async function flush() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
  }
}

async function mount(enabled, update, applicationId = APPLICATION_ID) {
  settingsProof.saved = { discord: { enabled, applicationId } };
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
const idInput = host => host.querySelector("input[aria-label='Discord application id']");
const shown = host => ({ checked: toggle(host).checked, label: toggle(host).nextElementSibling.textContent,
  applicationId: idInput(host).value });

// A browser ignores a click on a disabled box. Otherwise it flips the box before it dispatches the click, and React
// then puts back the value its state holds. linkedom has no checked property, so React keeps checked as a plain
// field on the element and reads it on click.
async function clickToggle(host) {
  const box = toggle(host);
  if (box.disabled) return;
  await act(async () => {
    box.checked = !box.checked;
    box.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

// A paste sets the value through the DOM setter React tracks, then fires input and change, as
// files-handoff-components.test.mjs does, because React reads change under linkedom. Leaving the field fires focusout.
async function pasteApplicationId(host, value) {
  const input = idInput(host);
  input.type = "text"; // Browser default absent in linkedom. React needs it to treat the field as text.
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

async function leaveApplicationId(host) {
  await act(async () => { idInput(host).dispatchEvent(new window.Event("focusout", { bubbles: true })); });
}

export async function theSectionCarriesTheSearchAnchor() {
  const { host, dispose } = await mount(false, async () => undefined);
  try {
    assert.equal(host.querySelector("section#discord")?.querySelector("h2")?.textContent, "Discord presence");
  } finally { await dispose(); }
}

export async function aClickRightAfterPastingTheIdIsNotLost() {
  let releaseBlurSave;
  const { host, dispose } = await mount(false, async params => {
    // The blur save is still in flight when the click lands, as it is when a real save crosses IPC.
    if (settingsProof.calls.length === 1) await new Promise(resolve => { releaseBlurSave = resolve; });
    settingsProof.saved = structuredClone(params);
  }, "");
  try {
    await pasteApplicationId(host, PASTED_ID);
    await leaveApplicationId(host);
    await clickToggle(host);
    releaseBlurSave?.();
    await flush();
    assert.deepEqual(settingsProof.calls.map(call => call.params.discord), [
      { enabled: false, applicationId: PASTED_ID },
      { enabled: true, applicationId: PASTED_ID },
    ], "the blur save and then the toggle save ran in order");
    assert.deepEqual(settingsProof.saved.discord, { enabled: true, applicationId: PASTED_ID });
    assert.deepEqual(shown(host), { checked: true, label: "On", applicationId: PASTED_ID });
  } finally { await dispose(); }
}

export async function leavingAnUnchangedIdSavesNothing() {
  const { host, dispose } = await mount(true, async params => { settingsProof.saved = structuredClone(params); });
  try {
    await pasteApplicationId(host, " " + APPLICATION_ID + " ");
    await leaveApplicationId(host);
    assert.deepEqual(settingsProof.calls, [], "the trimmed id matches the saved id");
    await pasteApplicationId(host, PASTED_ID);
    await leaveApplicationId(host);
    await flush();
    assert.deepEqual(settingsProof.calls.map(call => call.params.discord), [{ enabled: true, applicationId: PASTED_ID }],
      "a changed id still saves when the field is left");
  } finally { await dispose(); }
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
  // A browser document has an oninput handler property. Without it React DOM treats input events as unsupported
  // and never reads a typed or pasted value.
  view.document.oninput = null;
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
// React DOM chooses its input events when it loads, so the DOM must exist first or it ignores input and change.
const closeChannels = installDom();
const proof = await import(pathToFileURL(proofFile).href);

test("a rejected opt-in leaves sharing shown as Off", () => proof.aRejectedSaveKeepsTheSavedSetting(false));
test("a rejected opt-out leaves sharing shown as On", () => proof.aRejectedSaveKeepsTheSavedSetting(true));
test("a save that wrote the setting and then failed shows the written setting", () =>
  proof.aSaveThatFailsAfterWritingShowsTheWrittenSetting());
test("a successful save shows the new setting", () => proof.aSuccessfulSaveShowsTheNewSetting());
test("the Discord section carries the anchor its Settings search entry scrolls to", () =>
  proof.theSectionCarriesTheSearchAnchor());
test("a toggle clicked right after pasting the application id is saved", () =>
  proof.aClickRightAfterPastingTheIdIsNotLost());
test("leaving the application id field unchanged saves nothing", () => proof.leavingAnUnchangedIdSavesNothing());

test.after(async () => {
  closeChannels();
  await esbuild.stop();
  await rm(proofDirectory, { recursive: true, force: true });
});
