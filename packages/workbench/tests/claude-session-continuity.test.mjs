import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCodeAgentRunRecord, executeCodeAgentRun, getCodeAgentRunRecord, listCodeAgentTranscriptEvents } from "@agent-native/core/code-agents";

const sessionId = "00000000-0000-4000-8000-000000000010";

// Exercise the public executor with its real participant and Native store.
// The CLI process is an inert executable first on this test's PATH.
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-claude-session-"));
  const project = path.join(directory, "project");
  const nativeStore = path.join(directory, "native");
  fs.mkdirSync(project);
  const previous = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  const previousPath = process.env.PATH; // guard:allow-env-credential - Save nonsecret fixture CLI search paths for restoration after the test.
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  // guard:allow-env-mutation - Test-only PATH selects the inert CLI; restored after the test.
  process.env.PATH = bin + path.delimiter + previousPath; // guard:allow-env-credential - Nonsecret search path for the disposable inert CLI fixture.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = nativeStore; // guard:allow-env-mutation - Disposable Native fixture store, restored after the test.
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME; // guard:allow-env-mutation - Restore the absent Native store setting after the disposable fixture.
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous; // guard:allow-env-mutation - Restore the prior Native store setting after the disposable fixture.
    // guard:allow-env-mutation - Restore the original CLI search paths after the inert fixture.
    process.env.PATH = previousPath; // guard:allow-env-credential - Restore nonsecret PATH configuration saved before the test.
    await rm(directory, { recursive: true, force: true });
  });
  const script = path.join(bin, "claude");
  const modeFile = path.join(directory, "mode.txt");
  await writeFile(modeFile, "complete");
  const receipt = path.join(directory, "calls.jsonl");
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv[2] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }));
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => { prompt += value; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");
  const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8");
  const id = mode === "mismatch" ? "00000000-0000-4000-8000-000000000099" : args.includes("--resume") ? args[args.indexOf("--resume") + 1] : ${JSON.stringify(sessionId)};
  const [invalidEventType, invalidIdentity] = mode.split(":");
  const init = { type: "system", subtype: "init", session_id: id };
  const assistant = { type: "assistant", message: { content: [
    { type: "text", text: invalidEventType === "assistant" ? "Unverified Claude output." : "Ordinary stream text." },
  ] } };
  const result = { type: "result", subtype: "success", session_id: id,
    result: invalidIdentity ? "Unverified Claude result." : "Fixture answer." };
  const invalidEvent = { init, assistant, result }[invalidEventType];
  if (invalidEvent) {
    if (invalidIdentity === "missing") delete invalidEvent.session_id;
    else invalidEvent.session_id = { numeric: 123, null: null, empty: "" }[invalidIdentity];
  }
  const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
  emit(init);
  if (mode === "wait") { setInterval(() => {}, 1_000); return; }
  if (mode === "idless-stream" || invalidEventType === "assistant") emit(assistant);
  if (mode === "idless-stream") {
    emit({ type: "tool_use", name: "Read", id: "fixture-read", input: { file_path: "fixture.txt" } });
    emit({ type: "tool_result", tool_use_id: "fixture-read", content: "Ordinary tool result." });
  }
  emit(result);
});
`, { mode: 0o755 });
  const run = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Fixture conversation", cwd: project, permissionMode: "auto-edit",
    metadata: { app: "vivary-workbench-local-code", engine: "claude-cli", ownerEmail: "owner@example.test" } });
  return { run, project, nativeStore, script,
    configure: mode => writeFile(modeFile, mode),
    execute: (prompt, signal) => executeCodeAgentRun({ runId: run.id, prompt, appendUserEvent: true, streamToolOutputToStdout: false, signal }),
    calls: async () => (await readFile(receipt, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("a Claude conversation persists its provider session and resumes it after reloading the Native run",
  { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const first = await f.execute("First question");
  assert.equal(first.status, "completed");
  assert.equal(first.metadata.claudeSessionId, sessionId);
  assert.equal(first.metadata.providerSessionMode, "new-session");
  const reloaded = getCodeAgentRunRecord(f.run.id);
  assert.equal(reloaded.metadata.claudeSessionId, sessionId);
  const second = await f.execute("Follow-up question");
  assert.equal(second.metadata.claudeSessionId, sessionId);
  assert.equal(second.metadata.providerSessionMode, "native-resume");
  const [start, followUp] = await f.calls();
  assert.equal(start.args.includes("--no-session-persistence"), false);
  assert.equal(start.args.includes("--resume"), false);
  assert.equal(followUp.args[followUp.args.indexOf("--resume") + 1], sessionId);
  assert.equal(followUp.args.includes("--no-session-persistence"), false);
  assert.equal(followUp.cwd, f.project);
  assert.deepEqual(fs.readdirSync(f.project), []);
});


test("Stop retains the reported Claude session for a later turn", { skip: process.platform === "win32", timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.configure("wait");
  const controller = new AbortController();
  const executing = f.execute("Wait for Stop", controller.signal);
  t.after(() => controller.abort());
  for (let attempt = 0; attempt < 100 && !getCodeAgentRunRecord(f.run.id).metadata.claudeSessionId; attempt++) await delay(25);
  assert.equal(getCodeAgentRunRecord(f.run.id).metadata.claudeSessionId, sessionId);
  controller.abort();
  const stopped = await executing;
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.metadata.claudeSessionId, sessionId);
  await f.configure("complete");
  const continued = await f.execute("Continue after Stop");
  assert.equal(continued.status, "completed");
  assert.equal(continued.metadata.providerSessionMode, "native-resume");
});

test("a resumed Claude turn refuses a different provider session without replacing its reference", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await f.execute("First question");
  await f.configure("mismatch");
  const wrong = await f.execute("Follow up");
  assert.equal(wrong.status, "errored");
  assert.equal(wrong.metadata.claudeSessionId, sessionId);
  assert.equal(wrong.metadata.providerSessionMode, "resume-requested");
  assert.match(wrong.metadata.executionError, /different or invalid session/);
});

for (const eventType of ["init", "result"]) {
  for (const identity of ["numeric", "null", "missing", "empty"]) {
    test(`Claude refuses a ${identity} session identity on ${eventType} before accepting its output`,
      { skip: process.platform === "win32" }, async t => {
      const f = await fixture(t);
      await f.execute("First question");
      await f.configure(`${eventType}:${identity}`);
      const rejected = await f.execute("Follow up");
      assert.equal(rejected.status, "errored");
      assert.equal(rejected.metadata.claudeSessionId, sessionId);
      assert.equal(getCodeAgentRunRecord(f.run.id).metadata.claudeSessionId, sessionId);
      // A valid init can confirm resume before a later result is rejected.
      assert.equal(rejected.metadata.providerSessionMode, eventType === "init" ? "resume-requested" : "native-resume");
      assert.match(rejected.metadata.executionError, /different or invalid session/);
      assert.equal(JSON.stringify(listCodeAgentTranscriptEvents(f.run.id)).includes("Unverified Claude"), false);
    });
  }
}

for (const identity of ["numeric", "null", "empty"]) {
  test(`Claude refuses an explicitly ${identity} identity on an ordinary content event before attaching it`,
    { skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    await f.execute("First question");
    await f.configure(`assistant:${identity}`);
    const rejected = await f.execute("Follow up");
    assert.equal(rejected.status, "errored");
    assert.equal(rejected.metadata.claudeSessionId, sessionId);
    assert.equal(rejected.metadata.providerSessionMode, "native-resume");
    assert.match(rejected.metadata.executionError, /different or invalid session/);
    assert.equal(JSON.stringify(listCodeAgentTranscriptEvents(f.run.id)).includes("Unverified Claude"), false);
  });
}

test("Claude accepts ordinary ID-less content/tool events after a valid session init",
  { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await f.execute("First question");
  await f.configure("idless-stream");
  const resumed = await f.execute("Follow up");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.metadata.claudeSessionId, sessionId);
  assert.equal(resumed.metadata.providerSessionMode, "native-resume");
  const events = listCodeAgentTranscriptEvents(f.run.id);
  assert.ok(events.some(event => event.message === "Ordinary stream text."));
  assert.ok(events.some(event => event.metadata?.type === "tool_start" && event.metadata.tool === "Read"));
  assert.ok(events.some(event => event.metadata?.type === "tool_done" && event.metadata.result === "Ordinary tool result."));
});
