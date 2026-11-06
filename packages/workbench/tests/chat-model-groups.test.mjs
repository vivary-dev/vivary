import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The maintained Core patch makes a provider and model the user chose the default for a new Native
// chat. Core does not export this module, so load the installed, patched copy.
const clientDir = path.dirname(fileURLToPath(import.meta.resolve("@agent-native/core/client")));
const { buildChatModelGroups, chosenSettingsKey, storedPickYieldsToSettings } = await import(pathToFileURL(path.join(clientDir, "chat-model-groups.js")).href);

const engines = [
  { name: "anthropic", label: "Claude", supportedModels: ["claude-haiku-4-5-20251001", "claude-sonnet-5"], requiredEnvVars: ["ANTHROPIC_API_KEY"] },
  { name: "ai-sdk:openai", label: "OpenAI", supportedModels: ["gpt-5.6-luna", "gpt-5.6-sol"], requiredEnvVars: ["OPENAI_API_KEY"] },
  { name: "ai-sdk:openrouter", label: "OpenRouter", supportedModels: ["openai/gpt-5.6-luna", "anthropic/claude-opus-4.8"], requiredEnvVars: ["OPENROUTER_API_KEY"] },
];
const listed = (groups, model) => groups.filter(group => group.models.includes(model)).map(group => group.engine);

test("a chosen custom OpenRouter model leads the picker and becomes the new-chat default", () => {
  const groups = buildChatModelGroups({ engines, configuredKeys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    currentEngineName: "ai-sdk:openrouter", currentModel: "stealth/space-bunny-alpha", currentChosen: true });
  assert.equal(groups[0].engine, "ai-sdk:openrouter");
  assert.equal(groups[0].models[0], "stealth/space-bunny-alpha");
  assert.ok(groups[0].models.includes("openai/gpt-5.6-luna"), "built-in models stay selectable");
  assert.ok(groups.some(group => group.engine === "ai-sdk:openai"), "other configured providers stay listed");
});

test("a chosen model already in the built-in list moves first without a duplicate", () => {
  const groups = buildChatModelGroups({ engines, configuredKeys: ["OPENROUTER_API_KEY"],
    currentEngineName: "ai-sdk:openrouter", currentModel: "anthropic/claude-opus-4.8", currentChosen: true });
  assert.equal(groups[0].models[0], "anthropic/claude-opus-4.8");
  assert.equal(groups[0].models.filter(model => model === "anthropic/claude-opus-4.8").length, 1);
});

test("a chosen provider without a key does not become the default", () => {
  const groups = buildChatModelGroups({ engines, configuredKeys: ["OPENAI_API_KEY"],
    currentEngineName: "ai-sdk:openrouter", currentModel: "stealth/space-bunny-alpha", currentChosen: true });
  assert.equal(groups.find(group => group.configured)?.engine, "ai-sdk:openai");
});

test("a chosen model is not added to a shown group that has no key", () => {
  const groups = buildChatModelGroups({ engines, configuredKeys: ["OPENAI_API_KEY"],
    currentEngineName: "anthropic", currentModel: "claude-custom-preview", currentChosen: true });
  assert.ok(groups.some(group => group.engine === "anthropic" && !group.configured), "the keyless Claude group is shown");
  assert.deepEqual(listed(groups, "claude-custom-preview"), []);
  assert.equal(groups.find(group => group.configured)?.engine, "ai-sdk:openai");
});

test("a detected engine keeps core's order, so detection never picks the model", () => {
  const options = { engines, configuredKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    currentEngineName: "anthropic", currentModel: "claude-sonnet-5" };
  const detected = buildChatModelGroups({ ...options, currentChosen: false });
  assert.deepEqual(detected, buildChatModelGroups(options), "detected is the same as no signal");
  assert.equal(detected[0].engine, "ai-sdk:openai");
});

test("a model reported for an engine without a key is not added to its group", () => {
  const groups = buildChatModelGroups({ engines, configuredKeys: [],
    currentEngineName: "anthropic", currentModel: "gpt-5-6-luna", currentChosen: false });
  assert.deepEqual(listed(groups, "gpt-5-6-luna"), []);
});

test("with the Builder gateway lane, Builder stays first and the chosen model is still listed", () => {
  const gateway = [...engines, { name: "builder", label: "Builder", supportedModels: ["gpt-5-6-luna"], requiredEnvVars: [], configured: true }];
  const groups = buildChatModelGroups({ engines: gateway, configuredKeys: ["OPENROUTER_API_KEY"],
    currentEngineName: "ai-sdk:openrouter", currentModel: "stealth/space-bunny-alpha", currentChosen: true });
  assert.equal(groups[0].engine, "builder");
  assert.deepEqual(listed(groups, "stealth/space-bunny-alpha"), ["ai-sdk:openrouter"]);
});

test("the Settings choice key exists only for a chosen engine and model", () => {
  assert.equal(chosenSettingsKey({ engine: "ai-sdk:openrouter", model: "stealth/space-bunny-alpha", chosen: true }),
    "ai-sdk:openrouter|stealth/space-bunny-alpha");
  assert.equal(chosenSettingsKey({ engine: "anthropic", model: "claude-sonnet-5", chosen: false }), undefined);
  assert.equal(chosenSettingsKey({ engine: "anthropic", model: "claude-sonnet-5" }), undefined);
  assert.equal(chosenSettingsKey(null), undefined);
});

test("a stored composer pick yields only to a different Settings choice", () => {
  const chosen = "ai-sdk:openrouter|stealth/space-bunny-alpha";
  const yields = (hasStoredPick, storedChoice, chosenSettings) => storedPickYieldsToSettings({ hasStoredPick, storedChoice, chosenSettings });
  assert.equal(yields(true, "ai-sdk:openai|gpt-5.6-luna", chosen), true, "a pick made under an earlier choice yields");
  assert.equal(yields(true, undefined, chosen), true, "a pick made under no choice, or before this patch, yields");
  assert.equal(yields(true, chosen, chosen), false, "a pick made under the current choice stays");
  assert.equal(yields(false, undefined, chosen), false, "no pick, nothing to clear");
  assert.equal(yields(true, "ai-sdk:openai|gpt-5.6-luna", undefined), false, "a detected engine never clears a pick");
});
