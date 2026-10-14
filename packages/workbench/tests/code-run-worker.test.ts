import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodeAgentRunRecord, getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";
import { credentialFingerprints } from "../server/credential-redaction.ts";
import { claudeSubscriptionAccount, claudeSubscriptionRuntime } from "../server/code-subscription-funding.ts";
import { claudeAccount, createClaudeSubscriptionFixture, includedClaudeUsage } from "./fixtures/claude-subscription.ts";
import { codingRuntimeEnvironment } from "../server/local-runtime-setup.ts";

test("the actual worker refuses retained Claude and Codex records before any runtime starts", {
  timeout: 60_000, skip: process.platform === "win32",
}, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-funding-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  const bin = path.join(fixture, "bin");
  const probe = path.join(fixture, "runtime-started");
  try {
    await mkdir(bin);
    // guard:allow-env-credential - Use a disposable Native store for synthetic retained runs.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture;
    for (const command of ["claude", "codex"]) await writeFile(path.join(bin, command),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(probe)}, "started");
`, { mode: 0o755 });
    for (const engine of ["claude-cli", "codex-cli"] as const) {
      const runId = `worker-funding-${engine}`;
      const ownerEmail = "worker@example.test";
      createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code", title: "Retained worker fixture",
        status: "completed", cwd: fixture, metadata: { app: "vivary-workbench-local-code", engine, ownerEmail } });
      const record = getCodeAgentRunRecord(runId);
      const child = fork(path.join(import.meta.dirname, "..", "server", "code-execution-worker.ts"), [], {
        execArgv: ["--import", "tsx"], cwd: path.join(import.meta.dirname, ".."),
        // guard:allow-env-credential - Nonsecret executable search path for disposable fake runtimes. All other child environment fields remain filtered.
        env: { ...codingRuntimeEnvironment(process.env), PATH: bin + path.delimiter + (process.env.PATH ?? "") },
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const exited = once(child, "exit");
      try {
        const [ready] = await once(child, "message");
        assert.equal(ready.type, "vivary:code-worker:ready");
        const response = once(child, "message");
        child.send({ type: "vivary:code-worker:start", runId, prompt: "Must not execute",
          model: engine === "claude-cli" ? "claude-fable-5-1" : "retained-model", ownerEmail,
          redaction: credentialFingerprints() });
        const [failed] = await response;
        assert.equal(failed.type, "vivary:code-worker:failed");
        assert.deepEqual(getCodeAgentRunRecord(runId), record);
        assert.deepEqual(listCodeAgentTranscriptEvents(runId), []);
        await assert.rejects(readFile(probe), { code: "ENOENT" });
      } finally {
        if (child.connected) child.disconnect();
        await exited;
      }
    }
  } finally {
    // guard:allow-env-credential - Restore only the fixture Native record directory.
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    await rm(fixture, { recursive: true, force: true });
  }
});


test("the actual worker admits Claude through Native's same-process check and refuses changed funding before a prompt", {
  timeout: 90_000, skip: process.platform === "win32",
}, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-included-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  try {
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Disposable Native store, restored below.
    const cli = await createClaudeSubscriptionFixture(fixture);
    const runId = "worker-verified-included";
    const ownerEmail = "worker@example.test";
    createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code", title: "Included worker fixture",
      status: "completed", cwd: fixture, permissionMode: "auto-edit", metadata: {
        app: "vivary-workbench-local-code", engine: "claude-cli", ownerEmail, model: "claude-fable-5-1",
        subscriptionFundingBinding: { version: "2.1.289", account: claudeSubscriptionAccount({ account: claudeAccount }),
          runtime: await claudeSubscriptionRuntime(fixture, cli.launch) },
      } });
    async function execute() {
      const child = fork(path.join(import.meta.dirname, "..", "server", "code-execution-worker.ts"), [], {
        execArgv: ["--import", "tsx"], cwd: path.join(import.meta.dirname, ".."),
        env: { ...codingRuntimeEnvironment(process.env), PATH: cli.bin + path.delimiter + (process.env.PATH ?? "") }, // guard:allow-env-credential - Disposable executable search path.
        detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr += chunk; });
      const exited = once(child, "exit");
      try {
        const [ready] = await once(child, "message");
        assert.equal(ready.type, "vivary:code-worker:ready", stderr);
        const response = once(child, "message");
        child.send({ type: "vivary:code-worker:start", runId, prompt: "Use included allowance only",
          model: "claude-fable-5-1", ownerEmail, redaction: credentialFingerprints() });
        const [result] = await response;
        return result;
      } finally {
        if (child.connected) child.disconnect();
        await exited;
      }
    }
    for (let turn = 0; turn < 2; turn++) {
      assert.equal((await execute()).type, "vivary:code-worker:done");
      assert.equal(getCodeAgentRunRecord(runId)?.status, "completed");
    }
    const events = await cli.events();
    assert.equal(events.filter(event => event.type === "user").length, 2);
    assert.equal(events.filter(event => event.request?.subtype === "get_usage").length, 2);
    assert.ok(events.some(event => event.args?.includes("--resume")));
    assert.equal(events.some(event => event.args?.includes("--safe-mode")), false);
    assert.doesNotMatch(JSON.stringify(listCodeAgentTranscriptEvents(runId)), /fixture@example|user_disabled|control_response/);
    for (const mutation of ["exhausted", "changed-account", "credits-enabled", "malformed-control"]) {
      const usage: ReturnType<typeof includedClaudeUsage> & { malformed_control?: boolean } = includedClaudeUsage();
      if (mutation === "malformed-control") usage.malformed_control = true;
      if (mutation === "exhausted") usage.rate_limits.seven_day.utilization = 100;
      if (mutation === "credits-enabled") usage.rate_limits.extra_usage.user_disabled = false;
      await writeFile(cli.usageFile, JSON.stringify(usage));
      await writeFile(cli.accountFile, JSON.stringify(mutation === "changed-account" ? { ...claudeAccount, email: "other@example.test" } : claudeAccount));
      const record = getCodeAgentRunRecord(runId);
      const transcript = listCodeAgentTranscriptEvents(runId);
      const result = await execute();
      assert.equal(result.type, "vivary:code-worker:failed");
      assert.equal(result.funding.status, mutation === "exhausted" ? "exhausted" : mutation === "credits-enabled" ? "paid-funding-enabled" : "unavailable");
      assert.deepEqual(getCodeAgentRunRecord(runId), record);
      const cliProcess = (await cli.events()).filter(event => event.args).at(-1)?.pid;
      assert.ok(typeof cliProcess === "number");
      assert.throws(() => process.kill(cliProcess, 0), { code: "ESRCH" });
      assert.deepEqual(listCodeAgentTranscriptEvents(runId), transcript);
      assert.equal((await cli.events()).filter(event => event.type === "user").length, 2);
    }
  } finally {
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Restore fixture state.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Restore fixture state.
    await rm(fixture, { recursive: true, force: true });
  }
});
