import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// PR #323 regression review. Beta.1 started without the Discord RPC package. A missing or broken package must not
// stop the desktop app, and must leave presence off. This file resolves the package as absent for every import.
const electronStub = "data:text/javascript," + encodeURIComponent(
  "export const app = { setName() {}, isPackaged: false }; export const BrowserWindow = null; export const dialog = {}; export const session = {}; export const shell = {};",
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: electronStub, shortCircuit: true };
    if (specifier === "@xhayper/discord-rpc") {
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" });
    }
    return nextResolve(specifier, context);
  },
});
test.after(() => hooks.deregister());

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the desktop main module loads without the Discord RPC package", async () => {
  const main = await import("../main.mjs");
  assert.equal(typeof main.attachDiscordPresence, "function");
});

test("turning presence on without the Discord RPC package leaves presence off", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  const { createDiscordPresenceController } = await import("../discord-presence.mjs");
  const controller = createDiscordPresenceController({
    readSettings: async () => ({ discord: { enabled: true, applicationId: "123456789012345678" } }),
  });
  t.after(() => controller.dispose());
  await controller.reloadSettings();
  controller.updateSnapshot({ phase: "agent", projectLabel: "Private launch", startedAt: 100 });
  await flush();
  assert.deepEqual(logged.mock.calls.map((call) => call.arguments[0]),
    ["[vivary-desktop] Discord presence is off because its RPC package could not load."]);
});
