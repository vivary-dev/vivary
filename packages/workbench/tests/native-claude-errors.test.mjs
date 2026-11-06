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

const stderrLimit = 128 * 1024;
const heldCredential = ("opaqueZ9" + "Qq7Ww3Ee5Rr1Tt8Yy2Uu6Ii4Oo0PpAaSsDdFfGgHhJjKkLl").slice(0, 48);

function failingClaude(stderrWrites) {
  return {
    role: "driver", prompt: "Offline stderr fixture", cwd: process.cwd(),
    preflight: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }),
    spawnProcess() {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => false;
      child.stdin.once("finish", () => queueMicrotask(() => {
        child.stdout.end();
        child.stderr.once("end", () => child.emit("close", 1, null));
        for (const write of stderrWrites) child.stderr.write(write);
        child.stderr.end();
      }));
      return child;
    }, timeoutMs: 1000,
  };
}

function assertNoCredentialFragment(message) {
  for (let start = 0; start + 8 <= heldCredential.length; start++) {
    assert.equal(message.includes(heldCredential.slice(start, start + 8)), false, `fragment at ${start} stays private`);
  }
}

const crossing = " ".repeat(stderrLimit - 24) + heldCredential;
for (const [name, writes] of [
  ["one write", [crossing]],
  ["split before the limit", [crossing.slice(0, stderrLimit - 30), crossing.slice(stderrLimit - 30)]],
  ["split at the limit", [crossing.slice(0, stderrLimit), crossing.slice(stderrLimit)]],
  ["split after the limit", [crossing.slice(0, stderrLimit + 6), crossing.slice(stderrLimit + 6)]],
]) {
  test(`Claude withholds truncated stderr when a held credential crosses the limit: ${name}`, async () => {
    assert.equal(heldCredential.length, 48);
    setTextRedactor(text => text.replaceAll(heldCredential, "[redacted fixture]"));
    try {
      await assert.rejects(runClaudeCodeParticipant(failingClaude(writes)), error => {
        assertNoCredentialFragment(error.message);
        assert.match(error.message, /^Claude Code exited with 1\. Oversized diagnostic output was withheld\.$/);
        return true;
      });
    } finally {
      setTextRedactor(null);
    }
  });
}

test("Claude still redacts a held credential split across writes inside the limit", async () => {
  setTextRedactor(text => text.replaceAll(heldCredential, "[redacted fixture]"));
  try {
    const diagnostic = "auth failed for " + heldCredential;
    await assert.rejects(runClaudeCodeParticipant(failingClaude([diagnostic.slice(0, 30), diagnostic.slice(30)])), error => {
      assertNoCredentialFragment(error.message);
      assert.match(error.message, /^Claude Code exited with 1: auth failed for \[redacted fixture\]$/);
      return true;
    });
  } finally {
    setTextRedactor(null);
  }
});
