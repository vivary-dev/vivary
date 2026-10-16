import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTextRedactor } from "@agent-native/core/audit";

const { runClaudeCodeParticipant } = await import(
  new URL("../cli/claude-code-participant.js", import.meta.resolve("@agent-native/core/code-agents"))
);

for (const held of ["opaqueQ7AaBbCcDdEeFfGgHhIiJjKkLlMmNnPp", "opaque value  with\ninternal whitespace"]) {
  test(`Claude redacts a held value before error normalization or shortening: ${held.includes(" ") ? "whitespace" : "boundary"}`, async () => {
    // The actual worker registers its fingerprint matcher through this same Native hook.
    setTextRedactor(text => text.replaceAll(held, "[redacted fixture]"));
    try {
      await assert.rejects(runClaudeCodeParticipant({ role: "driver", prompt: "Offline error fixture", cwd: process.cwd(),
        preflight: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
        onEvent() { throw new Error("x".repeat(180) + " " + held); },
        spawnProcess() {
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => false;
          child.stdin.once("finish", () => queueMicrotask(() => {
            child.stdout.end(JSON.stringify({ type: "result", is_error: true }) + "\n");
            child.stderr.end();
            child.emit("close", 0, null);
          }));
          return child;
        }, timeoutMs: 1000,
      }), error => {
        assert.ok(error.message.length <= 200);
        assert.match(error.message, /redacted fixture/);
        assert.equal(error.message.includes(held.slice(0, 10)), false, "even the credential prefix stays private");
        return true;
      });
    } finally {
      setTextRedactor(null);
    }
  });
}
