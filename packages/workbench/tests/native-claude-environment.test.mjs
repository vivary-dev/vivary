import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

const { readClaudeCodeSubscriptionStatus, runClaudeCodeParticipant } = await import(
  new URL("../cli/claude-code-participant.js", import.meta.resolve("@agent-native/core/code-agents"))
);
const signedIn = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
const denied = { ANTHROPIC_API_KEY: "synthetic", CLAUDE_CODE_OAUTH_TOKEN: "synthetic", OPENAI_API_KEY: "synthetic",
  NODE_OPTIONS: "synthetic", NODE_EXTRA_CA_CERTS: "synthetic", SYSTEMROOT_TOKEN: "synthetic", SystemRooted: "synthetic", OTHER: "synthetic" };

async function launches(source) {
  const environments = [];
  await readClaudeCodeSubscriptionStatus({ env: source, execute: async (_command, _args, options) => {
    environments.push(options.env);
    return { stdout: JSON.stringify(signedIn) };
  } });
  await runClaudeCodeParticipant({ role: "driver", prompt: "offline environment fixture", cwd: process.cwd(), env: source,
    preflight: async () => signedIn,
    spawnProcess: (_command, _args, options) => {
      environments.push(options.env);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => false;
      child.stdin.once("finish", () => queueMicrotask(() => {
        child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
      }));
      return child;
    }, timeoutMs: 1000 });
  return environments;
}

for (const name of ["SystemRoot", "SYSTEMROOT", "sYsTeMrOoT"]) {
  test(`Native auth and run retain ${name} as one canonical SystemRoot without widening the allowlist`, async () => {
    for (const env of await launches({ ...denied, HOME: "synthetic-home", [name]: "C:\\Windows" })) {
      assert.deepEqual(env, { HOME: "synthetic-home", SystemRoot: "C:\\Windows" });
      for (const key of Object.keys(denied)) assert.equal(env[key], undefined);
    }
  });
}
for (const source of [{}, { SystemRoot: 123 }]) {
  test(`Native auth and run do not invent a SystemRoot for ${JSON.stringify(source)}`, async () => {
    for (const env of await launches({ ...denied, ...source })) assert.deepEqual(env, {});
  });
}
