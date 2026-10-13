import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodeAgentRunRecord, getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";
import { credentialFingerprints } from "../server/credential-redaction.ts";
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
