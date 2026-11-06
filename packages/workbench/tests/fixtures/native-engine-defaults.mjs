import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

let outboundRequests = 0;
globalThis.fetch = async () => { outboundRequests++; throw new Error("Unexpected outbound request in metadata fixture"); };
const core = await realpath(new URL("../../node_modules/@agent-native/core", import.meta.url));
const load = file => import(pathToFileURL(path.join(core, "dist", file)).href);
const { run: list } = await load("scripts/agent-engines/list-agent-engines.js");
const { putSetting } = await load("settings/store.js");
const { runWithRequestContext } = await load("server/request-context.js");
await runWithRequestContext({ userEmail: "fallback@example.test" }, async () => {
  const fresh = JSON.parse(await list());
  assert.deepEqual(fresh.current, { engine: "anthropic", model: "claude-sonnet-5-5", chosen: false });
  assert.equal(fresh.engines.find(engine => engine.name === "anthropic").configured, false);
  // guard:allow-env-credential - Synthetic metadata-only fixture keys. Transport always throws and the process owns disposable SQLite storage.
  Object.assign(process.env, { ANTHROPIC_API_KEY: "synthetic-offline-only", OPENROUTER_API_KEY: "synthetic-offline-only" });
  for (const choice of [
    { engine: "anthropic", model: "claude-sonnet-5" },
    { engine: "ai-sdk:openrouter", model: "custom/retained-model" },
  ]) {
    await putSetting("agent-engine", choice);
    const saved = JSON.parse(await list());
    assert.deepEqual(saved.current, { ...choice, chosen: true });
  }
});
assert.equal(outboundRequests, 0);
console.log("OFFLINE_ENGINE_DEFAULTS_VERIFIED");
