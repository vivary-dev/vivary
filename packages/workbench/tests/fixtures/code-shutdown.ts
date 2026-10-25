import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getCodeAgentRunRecord } from "@agent-native/core/code-agents";

type CodeHost = typeof import("../../server/local-code-agent.ts");
type Workspace = { root: string; label: string; projectId: string; bindingId: string; rootId: string; bindingRevision: number };
export type CodeHostFixture = {
  host: CodeHost;
  workspace: Workspace;
  ownerEmail: string;
  /** Sends a message as the owner and returns the new run's id. */
  send(message: string): Promise<string>;
  /** The requests a run records as waiting or expired. */
  listed(runId: string): Record<string, unknown>[] | undefined;
  /** Waits until a run records its first request. */
  waitForRequest(runId: string): Promise<void>;
};

/**
 * Beta tickets 05 and 27. Shutdown closes the Vivary code host for the rest of the process, so each quit scenario
 * runs in a test file of its own. This sets up a fake Claude Code runtime and a fake worker that writes runs through
 * Core's file store, as the real executor does. With `request`, the worker asks a Codex question as each run starts.
 * On abort it writes paused/paused, as the real executor writes for an interrupted result, then reports the run done.
 */
export async function withCodeHost(options: { request: boolean }, body: (fixture: CodeHostFixture) => Promise<void>): Promise<void> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-shutdown-"));
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
  const codeAgents = import.meta.resolve("@agent-native/core/code-agents");
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
const REQUEST = ${JSON.stringify(options.request)};
let runId;
process.on("message", async message => {
 if (message.type === "vivary:code-worker:abort") {
  // The real executor writes paused/paused for an interrupted result before the worker reports it (#306).
  const { updateCodeAgentRunRecord } = await import(${JSON.stringify(codeAgents)});
  updateCodeAgentRunRecord(runId, { status: "paused", phase: "paused" });
  // The real executor's teardown clears every pending request, and the worker forwards each one before it finishes.
  if (REQUEST) process.send({ type: "vivary:code-worker:resolved", runId, requestId: "request-quit" });
  process.send({ type: "vivary:code-worker:done", runId });
  return;
 }
 if (message.type !== "vivary:code-worker:start") return;
 runId = message.runId;
 if (REQUEST) process.send({ type: "vivary:code-worker:request", runId, request: { requestId: "request-quit",
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
  const ownerEmail = "quit@example.com";
  // Shutdown is idempotent. The finally block repeats it, so a failed assertion cannot leave the worker running.
  let host: CodeHost | undefined;
  try {
    process.chdir(fixture);
    process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = fixture; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    process.env.DATABASE_URL = "file:" + path.join(fixture, "state.sqlite"); // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    const { getVivaryRuntimeStatus } = await import("../../server/local-runtime-setup.ts");
    host = await import("../../server/local-code-agent.ts");
    if ((await getVivaryRuntimeStatus("claude-cli", { refresh: true })).status !== "ready") throw new Error("The fake Claude Code runtime is not ready.");
    const loaded = host;
    const listed = (runId: string) => getCodeAgentRunRecord(runId)?.metadata?.pendingApprovals as Record<string, unknown>[] | undefined;
    await body({
      host: loaded, workspace, ownerEmail, listed,
      async send(message) {
        const state = await loaded.sendVivaryCodeMessage({ ownerEmail, message, engine: "claude-cli", model: "sonnet",
          workspace, revalidateWorkspace: async () => workspace });
        return state.run!.id;
      },
      async waitForRequest(runId) {
        for (let attempt = 0; attempt < 100 && !listed(runId)?.length; attempt++) await delay(20);
        if (!listed(runId)?.length) throw new Error("The run never recorded its Codex request.");
      },
    });
  } finally {
    await host?.shutdownVivaryCodeAgent();
    process.chdir(previousCwd);
    if (previousMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previousMode; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    else process.env.DATABASE_URL = previousDatabase; // guard:allow-env-credential - Isolated synthetic test configuration, restored after cleanup.
    await rm(fixture, { recursive: true, force: true });
  }
}
