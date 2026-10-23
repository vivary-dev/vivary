// A separate host process over the concurrency suite's existing IPC worker and disposable SQLite/run stores.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as agent from "../../server/local-code-agent.ts";
import { getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";
import { appStateGet, appStateList } from "@agent-native/core/application-state";
import { closeDbExec, getDbExec } from "@agent-native/core/db";
import { setTextRedactor } from "@agent-native/core/audit";
import { redactCredentials, refreshHeldCredentials } from "../../server/credential-redaction.ts";

const [mode, fixture, token] = process.argv.slice(2) as [string, string, string];
// guard:allow-env-mutation - Disposable lifecycle child only; synthetic token is process-scoped and its fetch is disabled.
process.env.VIVARY_PROBE_TOKEN = token; // guard:allow-env-credential - Synthetic token survives the real send-boundary credential refresh in this disposable process.
globalThis.fetch = async () => { throw new Error("Queue lifecycle fixture forbids network calls."); };
const owner = { ownerEmail: "queue-restart@example.test", orgId: "queue-restart-org" };
const workspace = (name: string) => ({ root: path.join(fixture, name), label: name, projectId: name,
  bindingId: `${name}-binding`, rootId: `${name}-root`, bindingRevision: 1 });
const queuedWorkspace = workspace("queued");
const message = `Use ${token}\r\nKeep  tabs\tand trailing spaces.  `;
const prefix = "vivary-code-queue-payload-v1:";
const receipt = path.join(fixture, "queue-lifecycle.json");
const starts = async (): Promise<{ runId: string; prompt: string }[]> =>
  (await readFile(path.join(fixture, "starts.jsonl"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function until(read: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await read()) return;
    await delay(25);
  }
  assert.fail("queue lifecycle condition did not settle");
}
setTextRedactor(redactCredentials);
await refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: token }),
  mcpConfig: () => null, storedSecrets: async () => [] });

if (mode === "resume") {
  const saved = JSON.parse(await readFile(receipt, "utf8")) as { pid: number; queued: string; key: string; running: string };
  assert.notEqual(process.pid, saved.pid, "the original host exited before this fresh host started");
  const state = await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId);
  assert.deepEqual(state.queuedRuns.map(run => [run.id, run.state]), [[saved.queued, "held"]]);
  assert.deepEqual(state.activeRuns, [], "startup starts no held work");
  assert.deepEqual((await starts()).map(run => run.runId), [saved.running]);
  const exact = await agent.readQueuedVivaryCodeTurn({ ...owner, runId: saved.queued, projectId: queuedWorkspace.projectId });
  assert.equal(exact.message, message, "a new process reads the original exact bytes from durable storage");
  assert.equal(JSON.stringify(getCodeAgentRunRecord(saved.queued)).includes(token), false);
  await agent.resumeQueuedVivaryCodeTurn({ ...owner, ...exact, runId: saved.queued, workspace: queuedWorkspace,
    revalidateWorkspace: async () => queuedWorkspace, proceed: false });
  await until(async () => (await starts()).some(run => run.runId === saved.queued));
  assert.equal((await starts()).find(run => run.runId === saved.queued)?.prompt, message);
  assert.equal(JSON.stringify(listCodeAgentTranscriptEvents(saved.queued)).includes(token), false);
  await until(async () => await appStateGet(owner.ownerEmail, saved.key) === null);
} else {
  await agent.setVivaryCodeRunCapacity({ limit: 1, whenFull: "queue" });
  const runningWorkspace = workspace("running");
  const running = (await agent.sendVivaryCodeMessage({ ...owner, workspace: runningWorkspace, message: "Keep working",
    revalidateWorkspace: async () => runningWorkspace, engine: "claude-cli", model: "claude-sonnet-5-5" })).run!.id;
  await until(async () => (await starts()).some(run => run.runId === running));
  const db = getDbExec();
  const execute = db.execute.bind(db);
  let releaseSave = () => {};
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  let enteredSave = false;
  db.execute = async statement => {
    if (!enteredSave && typeof statement !== "string" && /^INSERT/.test(statement.sql)
      && typeof statement.args?.[1] === "string" && statement.args[1].startsWith(prefix)) {
      enteredSave = true;
      await saveGate;
    }
    return execute(statement);
  };
  let accepted = false;
  const queuedSend = agent.sendVivaryCodeMessage({ ...owner, workspace: queuedWorkspace, message,
    revalidateWorkspace: async () => queuedWorkspace, engine: "claude-cli", model: "claude-sonnet-5-5" })
    .then(state => { accepted = true; return state; });
  try {
    await until(async () => enteredSave);
    let closed = false;
    const closing = agent.shutdownVivaryCodeAgent().then(() => { closed = true; });
    const closingResult = mode === "timeout"
      ? assert.rejects(closing, /Queued messages are still being saved/) : closing;
    await until(async () => !(await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).activeRuns.length);
    assert.equal(accepted, false, "a pending payload save is not acknowledged");
    assert.equal(closed, false, "worker cleanup cannot finish shutdown before the queued payload save");
    assert.deepEqual(await appStateList(owner.ownerEmail, prefix), [], "the gate precedes the actual SQL write");
    if (mode === "timeout") await closingResult;
    releaseSave();
    const queued = (await queuedSend).run!.id;
    if (mode === "timeout") await agent.shutdownVivaryCodeAgent();
    else await closingResult;
    const payloads = await appStateList(owner.ownerEmail, prefix);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.value.message, message);
    assert.equal(JSON.stringify(getCodeAgentRunRecord(queued)).includes(token), false);
    assert.deepEqual((await starts()).map(run => run.runId), [running], "shutdown never admits the queued turn");
    await writeFile(receipt, JSON.stringify({ pid: process.pid, queued, key: payloads[0]!.key, running }));
  } finally {
    releaseSave();
    db.execute = execute;
    await queuedSend;
  }
}
await agent.shutdownVivaryCodeAgent();
assert.deepEqual((await agent.getVivaryCodeHostState(owner.ownerEmail, owner.orgId)).activeRuns, []);
await closeDbExec();
console.log(`QUEUE_LIFECYCLE_OK ${mode}`);
process.exit(0);
