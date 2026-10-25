import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";

// Beta ticket 07. A host ends without warning while its run waits on a Codex request. The first host runs in a child
// process and is killed, the way a crash or a forced quit ends it. A fresh host in this process must show the run
// Interrupted, the request Expired with its reason, and must not start the turn again.
const workspace = { label: "Restart project", projectId: "restart", bindingId: "restart-binding", rootId: "restart-root",
  bindingRevision: 1 };
const ownerEmail = "restart@example.com";
const requestId = "request-restart";
const expiredNotice = "Codex request expired. Vivary restarted before this request was answered.";

if (process.argv[2] === "first-host") await runFirstHost(process.argv[3]);
else test("a run waiting on a Codex request comes back Interrupted after a host crash, its request Expired, with no replay",
  { timeout: 120_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-restart-crash-"));
  const server = path.join(fixture, ".output", "server");
  const bin = path.join(fixture, "bin");
  const launches = path.join(fixture, "launches.log");
  await mkdir(server, { recursive: true });
  await mkdir(bin);
  await writeFile(launches, "");
  await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
  // Each start is one launch of a turn. The worker leaves with its host, so a killed host leaves no worker behind.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `import { appendFileSync } from "node:fs";
process.on("disconnect", () => process.exit(0));
process.on("message", message => {
 if (message.type !== "vivary:code-worker:start") return;
 appendFileSync(${JSON.stringify(launches)}, message.runId + "\\n");
 process.send({ type: "vivary:code-worker:request", runId: message.runId, request: { requestId: ${JSON.stringify(requestId)},
  method: "item/commandExecution/requestApproval", params: { command: "pnpm test" } } });
});
process.send({ type: "vivary:code-worker:ready" });
`);
  const previous = { cwd: process.cwd(), mode: process.env.VIVARY_ACCESS_MODE, // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    path: process.env.PATH, store: process.env.AGENT_NATIVE_CODE_AGENTS_HOME, // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    database: process.env.DATABASE_URL, // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    workspace: process.env.VIVARY_LOCAL_AGENT_WORKSPACE }; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
  let shutdown: (() => Promise<void>) | undefined;
  let first: ChildProcess | undefined;
  try {
    process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.PATH = bin + path.delimiter + (previous.path ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.DATABASE_URL = "file:" + path.join(fixture, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.VIVARY_LOCAL_AGENT_WORKSPACE = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.

    first = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "first-host", fixture],
      { cwd: previous.cwd, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
    const firstHost = first;
    const runId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The first host did not reach a waiting run within 60 seconds.")), 60_000);
      let output = "";
      firstHost.stdout!.on("data", chunk => {
        output += chunk;
        const ready = /^waiting (\S+)$/m.exec(output);
        if (ready) {
          clearTimeout(timer);
          resolve(ready[1]);
        }
      });
      firstHost.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`The first host exited with ${code} before its run waited.`));
      });
    });
    await killFirstHost(firstHost);
    assert.equal(getCodeAgentRunRecord(runId)?.status, "needs-approval", "the killed host left its run waiting");

    process.chdir(fixture);
    const { denyVivaryCodeMessage, getVivaryCodeHostState, initializeVivaryCodeAgent, shutdownVivaryCodeAgent } =
      await import("../server/local-code-agent.ts");
    shutdown = shutdownVivaryCodeAgent;
    await initializeVivaryCodeAgent();

    const run = getCodeAgentRunRecord(runId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.phase, "interrupted");
    assert.equal(run?.needsApproval, false);
    const [expired] = (run?.metadata?.pendingApprovals ?? []) as Record<string, unknown>[];
    assert.equal(expired?.requestId, requestId);
    assert.equal(expired?.reason, "host-restart");
    assert.equal(typeof expired?.expiredAt, "string");
    const events = listCodeAgentTranscriptEvents(runId);
    assert.equal(events.filter(event => event.metadata?.requestId === requestId && event.message === expiredNotice).length, 1);
    assert.equal(events.filter(event => event.metadata?.reason === "host-restart"
      && event.message === "The previous Vivary code host ended before this run finished.").length, 1);

    const host = await getVivaryCodeHostState(ownerEmail);
    assert.equal(host.activeRun, null);
    assert.equal(host.pendingApproval, null, "an expired request is never offered for an answer");
    assert.deepEqual(host.recentRun?.expiredApproval, { method: "item/commandExecution/requestApproval",
      summary: "pnpm test", reason: "Vivary restarted before this request was answered." });
    await assert.rejects(denyVivaryCodeMessage({ ownerEmail, runId, requestId, projectId: workspace.projectId }),
      { errorCode: "vivary_code_approval_stale", statusCode: 409 });

    // No replay: the fresh host starts no turn, so the one launch and the one user message stay the only ones.
    await delay(500);
    assert.deepEqual((await readFile(launches, "utf8")).split("\n").filter(Boolean), [runId]);
    assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").length, 1);
  } finally {
    if (first) await killFirstHost(first);
    await shutdown?.();
    process.chdir(previous.cwd);
    if (previous.mode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previous.mode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.PATH = previous.path; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previous.store === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous.store; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previous.database === undefined) delete process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.DATABASE_URL = previous.database; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previous.workspace === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = previous.workspace; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    await rm(fixture, { recursive: true, force: true });
  }
});

/** Kills the first host and waits for it to exit. It does nothing once the host has exited. */
async function killFirstHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  const exited = once(host, "exit");
  host.kill("SIGKILL");
  await exited;
}

/** The first host: it starts a run, waits until the run waits on a request, says so, and waits to be killed. */
async function runFirstHost(fixture: string): Promise<void> {
  process.chdir(fixture);
  const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
  const { sendVivaryCodeMessage } = await import("../server/local-code-agent.ts");
  assert.equal((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status, "ready");
  const scoped = { ...workspace, root: fixture };
  const state = await sendVivaryCodeMessage({ ownerEmail, message: "Run the tests", engine: "claude-cli", model: "sonnet",
    workspace: scoped, revalidateWorkspace: async () => scoped });
  const runId = state.run!.id;
  for (let attempt = 0; attempt < 250 && getCodeAgentRunRecord(runId)?.status !== "needs-approval"; attempt++) await delay(20);
  process.stdout.write(`waiting ${runId}\n`);
  await new Promise(() => {});
}
