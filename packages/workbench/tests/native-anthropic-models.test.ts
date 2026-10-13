import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const core = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = (file: string) => import(pathToFileURL(path.join(core, "dist", file)).href);
const catalog = await load("agent/model-config.js");
const reasoning = await load("shared/reasoning-effort.js");
const { buildChatModelGroups } = await load("client/chat-model-groups.js");
const current = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"];
const legacy = ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"];

test("direct Anthropic defaults and limits update while old choices stay selected", () => {
  for (const config of [catalog.AGENT_MODEL_CONFIG.anthropic, catalog.AGENT_MODEL_CONFIG.aiSdk.anthropic]) {
    assert.equal(config.defaultModel, current[0]);
    assert.deepEqual(config.supportedModels, [...current, ...legacy]);
  }
  for (const id of current) {
    assert.equal(catalog.getContextWindowForModel(id), 1_000_000);
    assert.equal(catalog.getMaxOutputTokensForModel(id), 128_000);
    assert.equal(reasoning.supportsClaudeAdaptiveThinking(id), true);
    assert.deepEqual(reasoning.getReasoningEffortOptionsForModel(id), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(reasoning.normalizeReasoningEffortForModel(id, "xhigh"), "xhigh");
    assert.equal(reasoning.allowsSamplingParams({ model: id }), false);
  }
  assert.equal(catalog.getContextWindowForModel(legacy[0]), 200_000);
  assert.equal(catalog.getMaxOutputTokensForModel(legacy[0]), 64_000);
  const engines = [{ name: "anthropic", label: "Claude", supportedModels: catalog.ANTHROPIC_MODEL_CONFIG.supportedModels,
    requiredEnvVars: ["ANTHROPIC_API_KEY"] }];
  for (const model of [...legacy, "claude-custom-retained-model"]) {
    const groups = buildChatModelGroups({ engines, configuredKeys: ["ANTHROPIC_API_KEY"],
      currentEngineName: "anthropic", currentModel: model, currentChosen: true });
    assert.equal(groups[0].models[0], model);
    assert.equal(groups[0].engine, "anthropic");
  }
});

test("Builder and OpenRouter keep independent IDs and defaults", () => {
  assert.equal(catalog.CLAUDE_SONNET_MODEL_ID, "claude-sonnet-5");
  assert.equal(catalog.AGENT_MODEL_CONFIG.builder.defaultModel, "gpt-5-6-luna");
  assert.deepEqual(catalog.AGENT_MODEL_CONFIG.builder.supportedModels,
    ["auto", "gpt-5-6-luna", "gpt-5-6-terra", "gpt-5-6-sol", "claude-haiku-4-5", "claude-sonnet-5",
      "claude-opus-4-8", "gemini-3-5-flash", "gemini-3-1-pro"]);
  assert.equal(catalog.AGENT_MODEL_CONFIG.aiSdk.openrouter.defaultModel, "openai/gpt-5.6-luna");
  assert.deepEqual(catalog.AGENT_MODEL_CONFIG.aiSdk.openrouter.supportedModels,
    ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8", "anthropic/claude-fable-5", "google/gemini-2.5-flash", "z-ai/glm-5.2"]);
});

test("real Anthropic SDK request compatibility uses intercepted transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vivary-api-models-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/native-anthropic-api.mjs", import.meta.url))], {
      timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
      env: { ...process.env, APP_NAME: "Vivary", NODE_ENV: "production",
        DATABASE_URL: "file:" + path.join(root, "fixture.sqlite"), DATABASE_URL_UNPOOLED: "file:" + path.join(root, "fixture.sqlite"),
        BETTER_AUTH_SECRET: "vivary-offline-fixture-secret-no-account-access" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OFFLINE_ANTHROPIC_REQUESTS_VERIFIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engine listing pairs the fresh provider default and preserves chosen legacy/custom models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vivary-engine-default-"));
  try {
    // A minimal child environment excludes real provider credentials and uses only disposable storage.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ["PATH", "HOME", "USER", "LANG", "TEMP", "TMP", "TMPDIR"].includes(name)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/native-engine-defaults.mjs", import.meta.url))], {
      timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
      env: { ...environment, APP_NAME: "Vivary", NODE_ENV: "production",
        DATABASE_URL: "file:" + path.join(root, "fixture.sqlite"), DATABASE_URL_UNPOOLED: "file:" + path.join(root, "fixture.sqlite"),
        BETTER_AUTH_SECRET: "vivary-offline-fixture-secret-no-account-access" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OFFLINE_ENGINE_DEFAULTS_VERIFIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
