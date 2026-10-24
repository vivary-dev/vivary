import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";

// Beta ticket 05. Quitting the app shuts the host down while Codex waits for an answer. The answer channel ends with
// the host, so the request expires visibly instead of vanishing. Shutdown closes the host for this process, so the
// test has a file of its own.
test("a Codex request pending at shutdown expires visibly", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-shutdown-request-"));
  const server = path.join(fixture, ".output", "server");
  const bin = path.join(fixture, "bin");
  await mkdir(server, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
process.on("message", message => {
 if (message.type !== "vivary:code-worker:start") return;
 process.send({ type: "vivary:code-worker:request", runId: message.runId, request: { requestId: "request-quit",
  method: "item/commandExecution/requestApproval", params: { command: "pnpm test" } } });
});
process.send({type:"vivary:code-worker:ready"});
`);
  const previousCwd = process.cwd();
  const previousMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const previousPath = process.env.PATH; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const previousDatabase = process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  const workspace = { root: fixture, label: "Quit project", projectId: "quit",
    bindingId: "quit-binding", rootId: "quit-root", bindingRevision: 1 };
  // Shutdown is idempotent. The finally block repeats it, so a failed assertion cannot leave the worker running.
  let shutdown: (() => Promise<void>) | undefined;
  try {
    process.chdir(fixture);
    process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.DATABASE_URL = "file:" + path.join(fixture, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
    const { getVivaryCodeHostState, sendVivaryCodeMessage, shutdownVivaryCodeAgent } = await import("../server/local-code-agent.ts");
    shutdown = shutdownVivaryCodeAgent;
    assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
    const state = await sendVivaryCodeMessage({ ownerEmail: "quit@example.com", message: "Run the tests",
      engine: "claude-cli", model: "sonnet", workspace, revalidateWorkspace: async () => workspace });
    const runId = state.run!.id;
    const listed = () => getCodeAgentRunRecord(runId)?.metadata?.pendingApprovals as Record<string, unknown>[] | undefined;
    for (let attempt = 0; attempt < 100 && !listed()?.length; attempt++) await delay(20);
    assert.equal(listed()?.length, 1);

    await shutdownVivaryCodeAgent();

    const [expired] = listed() ?? [];
    assert.equal(expired?.requestId, "request-quit");
    assert.equal(expired?.reason, "host-restart");
    assert.equal(typeof expired?.expiredAt, "string");
    assert.equal(getCodeAgentRunRecord(runId)?.status, "paused");
    assert.equal(getCodeAgentRunRecord(runId)?.needsApproval, false);
    assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.metadata?.requestId === "request-quit"
      && event.message === "Codex request expired. Vivary restarted before this request was answered.").length, 1);
    const host = await getVivaryCodeHostState("quit@example.com");
    assert.equal(host.pendingApproval, null);
    assert.deepEqual(host.recentRun?.expiredApproval, { method: "item/commandExecution/requestApproval",
      summary: "pnpm test", reason: "Vivary restarted before this request was answered." });
  } finally {
    await shutdown?.();
    process.chdir(previousCwd);
    if (previousMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previousMode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.DATABASE_URL = previousDatabase; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    await rm(fixture, { recursive: true, force: true });
  }
});
