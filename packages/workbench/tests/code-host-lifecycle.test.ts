import assert from "node:assert/strict";
import { test } from "node:test";

test("plugin and source-action module instances share one shutdown", async () => {
  const moduleUrl = new URL("../server/local-code-agent.ts", import.meta.url);
  const plugin = await import(moduleUrl.href + "?plugin");
  const action = await import(moduleUrl.href + "?action");
  const first = plugin.shutdownVivaryCodeAgent();
  const second = action.shutdownVivaryCodeAgent();
  assert.equal(first, second);
  await first;
});

test("reader module instances share shutdown and reject later admissions", async () => {
  const moduleUrl = new URL("../server/codex-session-process.ts", import.meta.url);
  const plugin = await import(moduleUrl.href + "?plugin-reader");
  const action = await import(moduleUrl.href + "?action-reader");
  const first = plugin.shutdownCodexSessionReaders();
  const second = action.shutdownCodexSessionReaders();
  assert.equal(first, second);
  assert.equal(await action.codexSessionLogLifecycle.open(undefined), null);
  await first;
  assert.equal(await plugin.codexSessionLogLifecycle.open(undefined), null);
});
