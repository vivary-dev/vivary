import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Exercise public Send, its real IPC request, and the actual worker with inert CLIs.
const workbench = path.join(import.meta.dirname, "..");
const root = await mkdtemp(path.join(tmpdir(), "vivary-code-legacy-model-"));
const database = `file:${path.join(root, "state.sqlite")}`;
const original = {
  DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  VIVARY_ACCESS_MODE: process.env.VIVARY_ACCESS_MODE, AGENT_NATIVE_CODE_AGENTS_HOME: process.env.AGENT_NATIVE_CODE_AGENTS_HOME, // guard:allow-env-credential - Saved test mode flag, restored after the suite.
};
Object.assign(process.env, { DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARY_ACCESS_MODE: "local", AGENT_NATIVE_CODE_AGENTS_HOME: path.join(root, "runs") });
after(async () => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value; // guard:allow-env-credential - Restores the four fixture names saved above.
  }
  await rm(root, { recursive: true, force: true });
});

const { getVivaryCodeHostState, sendVivaryCodeMessage, stopVivaryCodeRun } = await import("../server/local-code-agent.ts");
const { getVivaryRuntimeStatus } = await import("../server/local-runtime-setup.ts");
const { createCodeAgentRunRecord, getCodeAgentRunRecord, listCodeAgentTranscriptEvents } = await import("@agent-native/core/code-agents");
const coreModules = ["server", "code-agents", "audit", "db", "mcp-client", "secrets", "settings", "terminal/server"]
  .map(entry => import.meta.resolve(`@agent-native/core/${entry}`));

for (const shape of ["missing", "null"] as const) {
  test(`public Send retries a retained Codex conversation with ${shape} model metadata after route refusal`,
    { timeout: 60_000, skip: process.platform === "win32" }, async () => {
      const fixture = path.join(root, shape);
      const bin = path.join(fixture, "bin");
      const server = path.join(fixture, ".output", "server");
      const callsFile = path.join(fixture, "calls.jsonl");
      const started = path.join(fixture, "started.json");
      const refused = path.join(fixture, "refuse-account");
      await mkdir(bin, { recursive: true });
      await mkdir(server, { recursive: true });
      await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      await writeFile(path.join(bin, "codex"), `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const record = value => appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ pid: process.pid, ...value }) + "\\n");
record({ args: process.argv.slice(2) });
if (process.argv[2] === "login") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
const threadId = "retained-codex-thread", turnId = "retained-codex-turn";
let clientName;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  record({ message });
  if (message.method === "initialize") { clientName = message.params.clientInfo.name; emit({ id: message.id, result: {} }); }
  if (message.method === "account/read") emit({ id: message.id, result: { account: { type: clientName === "vivary" && existsSync(${JSON.stringify(refused)}) ? "apiKey" : "chatgpt" } } });
  if (message.method === "config/read") emit({ id: message.id, result: { config: { model_provider: "openai" } } });
  if (message.method === "model/list") emit({ id: message.id, result: { data: [
    { model: "gpt-6-astra", displayName: "Astra", isDefault: true }
  ], nextCursor: null } });
  if (message.method === "thread/resume" || message.method === "thread/start") {
    const p = message.params;
    emit({ id: message.id, result: { thread: { id: threadId }, cwd: p.cwd, model: "gpt-6-astra",
      modelProvider: "openai", approvalPolicy: p.approvalPolicy, approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } } });
  }
  if (message.method === "turn/start") {
    emit({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    emit({ method: "item/completed", params: { threadId, turnId,
      item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Retained fixture answered." } } });
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
});
`, { mode: 0o755 });
      await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
process.on("message", message => {
  if (message?.type === "vivary:code-worker:start") writeFileSync(${JSON.stringify(started)}, JSON.stringify(message));
});
await Promise.all(${JSON.stringify(coreModules)}.map(entry => import(entry)));
register();
await import(${JSON.stringify(pathToFileURL(path.join(workbench, "server", "code-execution-worker.ts")).href)});
`);
      const ownerEmail = "retained-model@example.test";
      const workspace = { root: fixture, label: "Retained model fixture" };
      const run = createCodeAgentRunRecord({ id: `retained-model-${shape}`, goalId: "vivary-local-code",
        title: "Retained Codex", status: "completed", cwd: fixture, permissionMode: "auto-edit",
        metadata: { app: "vivary-workbench-local-code", ownerEmail, engine: "codex-cli", workspaceRoot: fixture,
          codexSessionId: "retained-codex-thread", ...(shape === "null" ? { model: null } : {}) } });
      const previousCwd = process.cwd();
      const previousPath = process.env.PATH; // guard:allow-env-credential - Fixture CLI search path, restored below.
      try {
        process.chdir(fixture);
        process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Puts the inert fixture CLI first.
        assert.equal((await getVivaryRuntimeStatus("codex-cli", { refresh: true })).status, "ready");
        await writeFile(refused, "Refuse only the executing process after discovery succeeds.");
        await sendVivaryCodeMessage({ ownerEmail, runId: run.id, engine: "codex-cli",
          model: "default", message: "First attempt with a stale cached route.", workspace,
          revalidateWorkspace: async () => workspace });
        for (let attempt = 0; attempt < 400 && (await getVivaryCodeHostState(ownerEmail)).busy; attempt++) await delay(50);
        assert.equal((await getVivaryCodeHostState(ownerEmail)).busy, false);
        const failed = getCodeAgentRunRecord(run.id);
        assert.equal(failed?.status, "errored");
        assert.match(String(failed?.metadata?.executionError), /not signed in with ChatGPT/);
        assert.equal(failed?.metadata?.model, shape === "null" ? null : undefined,
          "a refusal before native resume preserves the original absent model");
        await rm(refused);
        const state = await sendVivaryCodeMessage({ ownerEmail, runId: run.id, engine: "codex-cli",
          model: "default", message: "Continue this retained conversation.", workspace,
          revalidateWorkspace: async () => workspace });
        assert.equal(state.run?.id, run.id);
        for (let attempt = 0; attempt < 400 && (await getVivaryCodeHostState(ownerEmail)).busy; attempt++) await delay(50);
        assert.equal((await getVivaryCodeHostState(ownerEmail)).busy, false);
        const request = JSON.parse(await readFile(started, "utf8"));
        assert.equal(Object.hasOwn(request, "model"), false, "the real host preserves an omitted model in IPC");
        const stored = getCodeAgentRunRecord(run.id);
        assert.equal(stored?.status, "completed", String(stored?.metadata?.executionError));
        assert.equal(stored?.metadata?.providerSessionMode, "native-resume");
        assert.equal(stored?.metadata?.model, "gpt-6-astra", "the native session reports its effective model");
        const events = listCodeAgentTranscriptEvents(run.id);
        assert.equal(events.filter(event => event.kind === "user").length, 2);
        assert.ok(events.some(event => event.message === "Retained fixture answered."));
        const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const resumes = calls.filter(call => call.message?.method === "thread/resume");
        assert.equal(resumes.length, 1);
        assert.equal(resumes[0].message.params.threadId, "retained-codex-thread");
        assert.equal(resumes[0].message.params.model ?? undefined, undefined, "no model override is sent to the retained native session");
        assert.equal(calls.some(call => call.message?.method === "thread/start"), false);
        assert.equal(calls.filter(call => call.message?.method === "turn/start").length, 1);
        for (const pid of new Set<number>(calls.map(call => call.pid))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if ((await getVivaryCodeHostState(ownerEmail)).activeRun?.id === run.id) await stopVivaryCodeRun({ ownerEmail, runId: run.id });
        process.chdir(previousCwd);
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Restores the saved search path.
      }
    });
}
