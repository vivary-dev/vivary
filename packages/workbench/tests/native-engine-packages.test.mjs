import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Agent-Native bakes the names in package.json dependencies and optionalDependencies into the
// built server, and a packaged app treats an AI SDK engine as installed only when its packages are
// on that list. A provider package left off makes that provider read as not installed.
const workbench = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreEngineDir = path.join(path.dirname(fileURLToPath(import.meta.resolve("@agent-native/core/server"))), "..", "agent", "engine");

test("every AI SDK provider the Native picker offers is a declared runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(path.join(workbench, "package.json"), "utf8"));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
  const engineSource = await readFile(path.join(coreEngineDir, "ai-sdk-engine.js"), "utf8");
  const table = /const PROVIDER_PACKAGES = \{([^}]+)\}/.exec(engineSource)?.[1];
  assert.ok(table, "Agent-Native still names its provider packages in ai-sdk-engine.js");
  const providers = Object.fromEntries([...table.matchAll(/(\w+): "([^"]+)"/g)].map(match => [match[1], match[2]]));
  assert.ok(providers.openrouter, "the provider table was read");
  // Core hides ai-sdk:anthropic from the picker, and Claude runs on its native Anthropic engine.
  delete providers.anthropic;
  const required = ["ai", ...Object.values(providers)];
  assert.deepEqual(required.filter(name => !declared.has(name)), []);
});
