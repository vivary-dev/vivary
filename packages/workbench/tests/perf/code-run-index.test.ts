import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import {
  codeAgentRunsDir, codeAgentRunTranscriptPath, listCodeAgentRunRecords,
  listCodeAgentTranscriptEvents, type CodeAgentRunRecord, type CodeAgentTranscriptEvent,
} from "@agent-native/core/code-agents";
import { getIndexedLegacyCodeDraftId, listIndexedCodeRuns, listIndexedCodeTranscript } from "../../server/code-run-index.ts";
import { getVivaryCodeState, linkedCodeDraftRuns } from "../../server/local-code-agent.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "vivary-code-index-test-"));
const environment: Record<string, string | undefined> = { DATABASE_URL: process.env.DATABASE_URL,
  VIVARY_ACCESS_MODE: process.env.VIVARY_ACCESS_MODE }; // guard:allow-env-credential - Preserve only modified test configuration.
process.env.DATABASE_URL = "file:" + path.join(data, "state.sqlite"); // guard:allow-env-credential - Disposable test DB.
process.env.VIVARY_ACCESS_MODE = "hosted"; // guard:allow-env-credential - Skip runtime CLI probes, no sockets or providers.
after(() => {
  if (environment.DATABASE_URL === undefined) delete process.env.DATABASE_URL; // guard:allow-env-credential - Restore disposable test DB configuration.
  else process.env.DATABASE_URL = environment.DATABASE_URL; // guard:allow-env-credential - Restore disposable test DB configuration.
  if (environment.VIVARY_ACCESS_MODE === undefined) delete process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Restore disposable hosted-mode test configuration.
  else process.env.VIVARY_ACCESS_MODE = environment.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Restore disposable hosted-mode test configuration.
  fs.rmSync(data, { recursive: true, force: true });
});

function store(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(data, "store-"));
  const previous = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = root; // guard:allow-env-credential - Disposable synthetic run store.
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous; // guard:allow-env-credential - Restore test configuration.
  });
  fs.mkdirSync(codeAgentRunsDir());
  fs.mkdirSync(path.dirname(codeAgentRunTranscriptPath("fixture")));
  return root;
}

function record(id: string, title = "First"): CodeAgentRunRecord {
  return { schemaVersion: 1, id, goalId: "vivary-local-code", title, status: "completed",
    cwd: process.env.AGENT_NATIVE_CODE_AGENTS_HOME!, createdAt: "2023-11-14T22:13:20.000Z",
    updatedAt: "2023-11-14T22:13:20.000Z", metadata: { app: "vivary-workbench-local-code",
      ownerEmail: "a@test", orgId: "a", engine: "claude-cli", model: "sonnet",
      workspaceRoot: process.env.AGENT_NATIVE_CODE_AGENTS_HOME,
      draftThreadId: "vivary-code:fixture" } };
}
function writeRun(run: CodeAgentRunRecord, filename = run.id): string {
  const file = path.join(codeAgentRunsDir(), filename + ".json");
  fs.writeFileSync(file, JSON.stringify(run));
  return file;
}
function event(runId: string, index: number): CodeAgentTranscriptEvent {
  return { schemaVersion: 1, id: `${runId}-${index}`, runId, kind: "user", message: `Message ${index}`,
    createdAt: "2023-11-14T22:13:20.000Z" };
}
function writeTranscript(id: string, events: CodeAgentTranscriptEvent[]): string {
  const file = codeAgentRunTranscriptPath(id);
  fs.writeFileSync(file, events.map(value => JSON.stringify(value)).join("\n") + "\n");
  return file;
}
function countReads(t: TestContext) {
  const counts = { runReads: 0, runParses: 0, transcriptReads: 0, transcriptParses: 0 };
  const read = fs.readFileSync, parse = JSON.parse;
  t.mock.method(fs, "readFileSync", function(...args: Parameters<typeof read>) {
    const file = String(args[0]);
    if (file.startsWith(codeAgentRunsDir() + path.sep) && file.endsWith(".json")) counts.runReads++;
    if (file.endsWith(".jsonl")) counts.transcriptReads++;
    return Reflect.apply(read, fs, args);
  });
  t.mock.method(JSON, "parse", function(...args: Parameters<typeof parse>) {
    if (args[0].includes('"goalId":"vivary-local-code"')) counts.runParses++;
    if (args[0].includes('"runId":')) counts.transcriptParses++;
    return Reflect.apply(parse, JSON, args);
  });
  return counts;
}

test("1,000-run cold poll reads each file once; unchanged and switched warm polls read/parse nothing", async t => {
  const root = store(t);
  for (let i = 0; i < 1000; i++) writeRun(record(`run-${i}`));
  for (const id of ["run-0", "run-999"]) writeTranscript(id, Array.from({ length: 450 }, (_, i) => event(id, i)));
  const counts = countReads(t);
  const poll = (id: string) => getVivaryCodeState("a@test", id, { root, label: "Fixture" }, "a");
  const cold = await poll("run-999");
  assert.equal(cold.runs.length, 20);
  assert.equal(cold.run?.events.length, 400);
  assert.deepEqual(counts, { runReads: 1000, runParses: 1000, transcriptReads: 1, transcriptParses: 450 });
  await poll("run-0"); // Cold opening of a second transcript, same metadata cache.
  Object.assign(counts, { runReads: 0, runParses: 0, transcriptReads: 0, transcriptParses: 0 });
  await poll("run-999"); await poll("run-0");
  assert.deepEqual(counts, { runReads: 0, runParses: 0, transcriptReads: 0, transcriptParses: 0 });
});

test("unmatched draft lookup across 1,000 legacy runs reads no warm transcripts and refreshes only a changed run", t => {
  const root = store(t);
  for (let i = 0; i < 1000; i++) {
    const run = record(`legacy-${i}`); delete run.metadata!.draftThreadId;
    writeRun(run); writeTranscript(run.id, [event(run.id, 0)]);
  }
  const counts = countReads(t), scope = { root, label: "Fixture" };
  const lookup = () => linkedCodeDraftRuns("a@test", "a", scope, ["vivary-code:missing", "vivary-code:found"]);
  assert.equal(lookup().size, 0);
  assert.equal(counts.transcriptReads, 1000); assert.equal(counts.transcriptParses, 1000);
  Object.assign(counts, { runReads: 0, runParses: 0, transcriptReads: 0, transcriptParses: 0 });
  assert.equal(lookup().size, 0);
  assert.deepEqual(counts, { runReads: 0, runParses: 0, transcriptReads: 0, transcriptParses: 0 });
  fs.appendFileSync(codeAgentRunTranscriptPath("legacy-500"), JSON.stringify({ ...event("legacy-500", 1),
    metadata: { draftThreadId: "vivary-code:found" } }) + "\n");
  assert.equal(lookup().get("vivary-code:found")?.id, "legacy-500");
  assert.equal(counts.transcriptReads, 1); assert.equal(counts.transcriptParses, 2);
  const cache = (globalThis as unknown as Record<symbol, { legacyDraftIds: Map<string, unknown> }>)[
    Symbol.for("vivary.workbench.code-run-index")];
  assert.equal(cache.legacyDraftIds.size, 1000, "one small memo per stored run");
  fs.rmSync(path.join(codeAgentRunsDir(), "legacy-500.json"));
  assert.equal(lookup().size, 0);
  assert.equal(cache.legacyDraftIds.size, 999, "deletion prunes the legacy memo on the next listing");
  const oversizedId = "vivary-code:" + "x".repeat(513);
  writeTranscript("legacy-0", [{ ...event("legacy-0", 0), metadata: { draftThreadId: oversizedId } }]);
  assert.equal(getIndexedLegacyCodeDraftId("legacy-0"), oversizedId, "oversized values keep their reader result");
  assert.equal(cache.legacyDraftIds.has("legacy-0"), false, "oversized draft IDs are not retained in the small memo");
});

// A retained draft link must have an eviction bound independent of store size.
// Observe re-reading an evicted link through the reader, not a private cache map.
test("legacy draft links evict old entries after the 4,096-run retention bound", t => {
  store(t);
  const counts = countReads(t);
  for (let i = 0; i < 4097; i++) {
    const id = `bounded-legacy-${i}`, draft = `vivary-code:draft-${i}`;
    writeTranscript(id, [{ ...event(id, 0), metadata: { draftThreadId: draft } }]);
    assert.equal(getIndexedLegacyCodeDraftId(id), draft);
  }
  const before = counts.transcriptReads;
  assert.equal(getIndexedLegacyCodeDraftId("bounded-legacy-4096"), "vivary-code:draft-4096");
  assert.equal(counts.transcriptReads, before, "recent links remain cached");
  assert.equal(getIndexedLegacyCodeDraftId("bounded-legacy-0"), "vivary-code:draft-0");
  assert.equal(counts.transcriptReads, before + 1, "the oldest evicted link is read again without changing its result");
});

test("membership, preserved-mtime same-size rewrite, atomic rename, malformed replacement and missing directory", t => {
  store(t);
  const file = writeRun(record("one"));
  const timestamp = 1700000000;
  fs.utimesSync(file, timestamp, timestamp);
  assert.deepEqual(listIndexedCodeRuns(), listCodeAgentRunRecords());
  const before = fs.statSync(file, { bigint: true });
  writeRun(record("one", "Later"));
  fs.utimesSync(file, timestamp, timestamp);
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino, "in-place edit preserves inode");
  assert.notEqual(after.ctimeNs, before.ctimeNs, "ctime distinguishes an edit despite identical size/mtime/inode");
  assert.equal(listIndexedCodeRuns()[0].title, "Later");
  const replacement = writeRun(record("one", "Final"), "replacement");
  fs.utimesSync(replacement, timestamp, timestamp);
  fs.renameSync(replacement, file);
  const replaced = fs.statSync(file, { bigint: true });
  assert.equal(replaced.size, before.size); assert.equal(replaced.mtimeNs, before.mtimeNs);
  assert.notEqual(replaced.ino, after.ino, "atomic replacement changes file ID");
  assert.equal(listIndexedCodeRuns()[0].title, "Final");
  writeRun(record("two"));
  assert.deepEqual(listIndexedCodeRuns(), listCodeAgentRunRecords());
  fs.renameSync(file, path.join(codeAgentRunsDir(), "renamed.json"));
  assert.deepEqual(listIndexedCodeRuns(), listCodeAgentRunRecords(), "Core reads the filename, even when ID differs");
  fs.rmSync(path.join(codeAgentRunsDir(), "renamed.json"));
  assert.deepEqual(listIndexedCodeRuns().map(run => run.id), ["two"]);
  fs.writeFileSync(path.join(codeAgentRunsDir(), "two.json"), "broken");
  assert.deepEqual(listIndexedCodeRuns(), []);
  writeRun({ ...record("two"), schemaVersion: 2 } as unknown as CodeAgentRunRecord);
  assert.deepEqual(listIndexedCodeRuns(), [], "Core validation rejects well-formed invalid JSON");
  writeRun(record("two"));
  assert.equal(listIndexedCodeRuns().length, 1);
  fs.rmSync(codeAgentRunsDir(), { recursive: true });
  assert.deepEqual(listIndexedCodeRuns(), []);
  fs.mkdirSync(codeAgentRunsDir()); writeRun(record("new"));
  assert.deepEqual(listIndexedCodeRuns().map(run => run.id), ["new"]);
});

test("transcript append, same-size edit, replacement, deletion and legacy draft links use fresh contents", t => {
  store(t);
  const run = record("one"); delete run.metadata!.draftThreadId;
  writeRun(run);
  const first = { ...event("one", 0), metadata: { draftThreadId: "vivary-code:first" } };
  const file = writeTranscript("one", [first]);
  const timestamp = 1700000000;
  fs.utimesSync(file, timestamp, timestamp);
  assert.deepEqual(listIndexedCodeTranscript("one"), listCodeAgentTranscriptEvents("one"));
  const before = fs.statSync(file, { bigint: true });
  writeTranscript("one", [{ ...first, metadata: { draftThreadId: "vivary-code:later" } }]);
  fs.utimesSync(file, timestamp, timestamp);
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const scope = { root: run.cwd, label: "Fixture" };
  assert.equal(linkedCodeDraftRuns("a@test", "a", scope, ["vivary-code:later"]).get("vivary-code:later")?.id, "one");
  fs.appendFileSync(file, JSON.stringify(event("one", 1)) + "\n");
  assert.deepEqual(listIndexedCodeTranscript("one"), listCodeAgentTranscriptEvents("one"));
  assert.equal(listIndexedCodeTranscript("one").length, 2);
  fs.writeFileSync(file + ".tmp", "malformed\n"); fs.renameSync(file + ".tmp", file);
  assert.deepEqual(listIndexedCodeTranscript("one"), []);
  writeTranscript("one", [first]);
  assert.equal(listIndexedCodeTranscript("one").length, 1);
  fs.rmSync(file);
  assert.deepEqual(listIndexedCodeTranscript("one"), []);
});

test("a writer during a Core read cannot tag old contents with the replacement identity", t => {
  store(t);
  const runFile = writeRun(record("one"));
  const transcriptFile = writeTranscript("one", [event("one", 0)]);
  const read = fs.readFileSync;
  const changed = new Set<string>();
  t.mock.method(fs, "readFileSync", function(...args: Parameters<typeof read>) {
    const value = Reflect.apply(read, fs, args);
    const file = String(args[0]);
    if ((file === runFile || file === transcriptFile) && !changed.has(file)) {
      changed.add(file);
      fs.writeFileSync(file + ".tmp", file === runFile ? JSON.stringify(record("one", "Latest"))
        : JSON.stringify(event("one", 1)) + "\n");
      fs.renameSync(file + ".tmp", file);
    }
    return value;
  });
  assert.equal(listIndexedCodeRuns()[0].title, "First", "read predates concurrent replacement");
  assert.equal(listIndexedCodeRuns()[0].title, "Latest", "next listing sees replacement");
  assert.equal(listIndexedCodeTranscript("one")[0].id, "one-0");
  assert.equal(listIndexedCodeTranscript("one")[0].id, "one-1");
});

test("fresh scope admission precedes transcript reads for owner, org, project and binding", async t => {
  const root = store(t);
  for (const [id, owner, org, project, binding] of [["mine", "a@test", "a", "p", "b"],
    ["owner", "b@test", "a", "p", "b"], ["org", "a@test", "b", "p", "b"],
    ["project", "a@test", "a", "q", "b"], ["binding", "a@test", "a", "p", "other"]]) {
    writeRun({ ...record(id), metadata: { ...record(id).metadata, ownerEmail: owner, orgId: org,
      projectId: project, bindingId: binding, draftThreadId: "vivary-code:project:p:fixture" } });
    writeTranscript(id, [event(id, 0)]);
  }
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(...args: Parameters<typeof read>) {
    if (String(args[0]).endsWith(".jsonl")) assert.equal(String(args[0]), codeAgentRunTranscriptPath("mine"));
    return Reflect.apply(read, fs, args);
  });
  const scope = { label: "P", projectId: "p", bindingId: "b", rootId: "root", bindingRevision: 1 };
  assert.deepEqual((await getVivaryCodeState("a@test", undefined, scope, "a")).runs.map(run => run.id), ["mine"]);
  for (const id of ["owner", "org", "project", "binding"]) await assert.rejects(
    getVivaryCodeState("a@test", id, scope, "a"), { statusCode: 404 });
  const mine = record("mine");
  writeRun({ ...mine, metadata: { ...mine.metadata, ownerEmail: "b@test", projectId: "p", bindingId: "b" } });
  await assert.rejects(getVivaryCodeState("a@test", "mine", scope, "a"), { statusCode: 404 });
  assert.deepEqual((await getVivaryCodeState("a@test", undefined, scope, "a")).runs, []);
  fs.rmSync(path.join(root, "runs", "mine.json"));
  await assert.rejects(getVivaryCodeState("a@test", "mine", scope, "a"), { statusCode: 404 });
});

// Exercise the admitted state API itself: hand-written expected events also catch
// regressions in response assembly, which a copied implementation cannot detect.
test("admitted state keeps the latest 400 events, legacy links, dedupe and fresh edits", async t => {
  const root = store(t), run = record("conversation");
  delete run.metadata!.draftThreadId;
  writeRun(run);
  const events = Array.from({ length: 450 }, (_, i) => event(run.id, i));
  events[0].metadata = { draftThreadId: "vivary-code:legacy" };
  events.push({ ...event(run.id, 450), kind: "system", message: "Same", metadata: { role: "assistant" } },
    { ...event(run.id, 451), kind: "system", message: "Same", metadata: { role: "assistant" } });
  const file = writeTranscript(run.id, events);
  fs.appendFileSync(file, 'broken\n' + JSON.stringify({ schemaVersion: 1, id: 'normalized',
    runId: run.id, role: 'human', text: 'Normalized', createdAt: 'fixed' }) + '\n');
  writeRun({ ...record("foreign"), metadata: { ...record("foreign").metadata, ownerEmail: "b@test" } });
  writeRun({ ...record("other-goal"), goalId: "other" });
  const scope = { root, label: "Fixture" };
  const poll = () => getVivaryCodeState("a@test", run.id, scope, "a");
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await poll();
    assert.deepEqual(state.runs.map(item => item.id), [run.id]);
    assert.equal(state.run?.events.length, 400);
    assert.equal(state.run?.events[0].id, "conversation-52");
    assert.equal(state.run?.events.at(-1)?.id, "normalized");
    assert.equal(state.run?.events.filter(item => item.message === "Same").length, 1);
    assert.equal(state.run?.events.at(-1)?.kind, "user", "legacy human roles are normalized on cold and warm reads");
    assert.equal(state.run?.events.at(-1)?.message, "Normalized", "legacy text remains visible");
    assert.equal(linkedCodeDraftRuns("a@test", "a", scope, ["vivary-code:legacy"]).get("vivary-code:legacy")?.id, run.id);
  }
  fs.appendFileSync(file, JSON.stringify(event(run.id, 452)) + "\n");
  const fresh = await poll();
  assert.equal(fresh.run?.events.length, 400);
  assert.equal(fresh.run?.events[0].id, "conversation-53");
  assert.equal(fresh.run?.events.at(-1)?.message, "Message 452");
});

test("transcript retention evicts old entries and oversized contents are always read fresh", t => {
  store(t);
  const counts = countReads(t);
  for (let i = 0; i < 65; i++) {
    const id = `retained-${i}`;
    writeTranscript(id, [event(id, 0)]);
    assert.equal(listIndexedCodeTranscript(id)[0].message, "Message 0");
  }
  assert.equal(counts.transcriptReads, 65);
  listIndexedCodeTranscript("retained-64");
  assert.equal(counts.transcriptReads, 65, "recent contents are reused");
  listIndexedCodeTranscript("retained-0");
  assert.equal(counts.transcriptReads, 66, "the 65th entry evicts the oldest of the 64 retained transcripts");

  // Three 3 MiB transcripts exceed the 64 MiB charged-content budget (8x raw bytes),
  // even though they fit the entry count. Observe eviction through the public reader.
  for (let i = 0; i < 3; i++) {
    const id = `large-${i}`;
    writeTranscript(id, [{ ...event(id, 0), message: "x".repeat(3 * 1024 * 1024) }]);
    listIndexedCodeTranscript(id);
  }
  const beforeEvictionRead = counts.transcriptReads;
  assert.equal(listIndexedCodeTranscript("large-0")[0].message.length, 3 * 1024 * 1024);
  assert.equal(counts.transcriptReads, beforeEvictionRead + 1, "byte pressure also evicts contents");
  writeTranscript("oversized", [{ ...event("oversized", 0), message: "x".repeat(9 * 1024 * 1024) }]);
  const beforeOversized = counts.transcriptReads;
  for (let i = 0; i < 2; i++) assert.equal(listIndexedCodeTranscript("oversized")[0].message.length, 9 * 1024 * 1024);
  assert.equal(counts.transcriptReads, beforeOversized + 2, "oversized responses stay correct without retention");

  const nextRoot = fs.mkdtempSync(path.join(data, "store-swap-"));
  fs.mkdirSync(path.join(nextRoot, "runs"));
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = nextRoot; // guard:allow-env-credential - Test host-store transition.
  assert.deepEqual(listIndexedCodeRuns(), [], "a different store cannot reuse previous records");
  assert.deepEqual(listIndexedCodeTranscript("retained-0"), [], "a different store cannot reuse previous private text");
});


test("successful Core sign-out clears retained run, transcript and legacy-link contents", async t => {
  store(t);
  const { H3, H3Event } = await import("h3");
  const { autoMountAuth, addSession, getSessionEmail, COOKIE_NAME, getH3App, awaitBootstrap } = await import("@agent-native/core/server");
  const { default: cacheLifecycle } = await import("../../server/plugins/05-code-cache.ts");
  const callbacks = new Map<string, ((...args: any[]) => unknown)[]>();
  const hooks = { hook(name: string, callback: (...args: any[]) => unknown) {
    callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
  } };
  const fire = async (name: string, ...args: unknown[]) => {
    for (const callback of callbacks.get(name) ?? []) await callback(...args);
  };
  const app = new H3({ silent: true, onRequest: event => fire("request", event),
    onResponse: (response, event) => fire("response", response, event) });
  // Exercise Core's production mount shim, without bootstrapping unrelated jobs.
  const switches = {
    AGENT_NATIVE_DISABLED_PLUGINS: "agent-chat,auth,context-xray,core-routes,integrations,observational-memory,onboarding,org,resources,sentry,terminal",
    AGENT_NATIVE_DISABLE_RECURRING_JOBS: "1", AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: "1",
    AGENT_NATIVE_DISABLE_KEEP_WARM: "1", VITE_APP_BASE_PATH: "/fixture",
  };
  const previous = {
    AGENT_NATIVE_DISABLED_PLUGINS: process.env.AGENT_NATIVE_DISABLED_PLUGINS,
    AGENT_NATIVE_DISABLE_RECURRING_JOBS: process.env.AGENT_NATIVE_DISABLE_RECURRING_JOBS,
    AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS: process.env.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS,
    AGENT_NATIVE_DISABLE_KEEP_WARM: process.env.AGENT_NATIVE_DISABLE_KEEP_WARM,
    VITE_APP_BASE_PATH: process.env.VITE_APP_BASE_PATH, // guard:allow-env-credential - Save the synthetic mount prefix.
  };
  Object.assign(process.env, switches); // guard:allow-env-credential - Synthetic mount fixture, no credentials.
  t.after(() => {
    if (previous.AGENT_NATIVE_DISABLED_PLUGINS === undefined) delete process.env.AGENT_NATIVE_DISABLED_PLUGINS;
    else process.env.AGENT_NATIVE_DISABLED_PLUGINS = previous.AGENT_NATIVE_DISABLED_PLUGINS;
    if (previous.AGENT_NATIVE_DISABLE_RECURRING_JOBS === undefined) delete process.env.AGENT_NATIVE_DISABLE_RECURRING_JOBS;
    else process.env.AGENT_NATIVE_DISABLE_RECURRING_JOBS = previous.AGENT_NATIVE_DISABLE_RECURRING_JOBS;
    if (previous.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS === undefined) delete process.env.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS;
    else process.env.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS = previous.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS;
    if (previous.AGENT_NATIVE_DISABLE_KEEP_WARM === undefined) delete process.env.AGENT_NATIVE_DISABLE_KEEP_WARM;
    else process.env.AGENT_NATIVE_DISABLE_KEEP_WARM = previous.AGENT_NATIVE_DISABLE_KEEP_WARM;
    if (previous.VITE_APP_BASE_PATH === undefined) delete process.env.VITE_APP_BASE_PATH; // guard:allow-env-credential - Restore the synthetic mount prefix.
    else process.env.VITE_APP_BASE_PATH = previous.VITE_APP_BASE_PATH; // guard:allow-env-credential - Restore the synthetic mount prefix.
  });
  const nitroApp = { h3: app, hooks };
  await cacheLifecycle(nitroApp);
  await autoMountAuth(getH3App(nitroApp), { getSession: async () => null, rootAuth: false });
  await awaitBootstrap(nitroApp);
  app.get("/unrelated", () => ({ ok: true }));
  writeRun(record("one"));
  writeRun(record("legacy"));
  writeTranscript("one", [event("one", 0)]);
  writeTranscript("legacy", [{ ...event("legacy", 0), metadata: { draftThreadId: "vivary-code:legacy" } }]);
  for (let i = 0; i < 65; i++) writeTranscript(`evict-${i}`, [event(`evict-${i}`, 0)]);
  const counts = countReads(t);
  const read = () => {
    assert.deepEqual(listIndexedCodeRuns().map(run => run.id).sort(), ["legacy", "one"]);
    assert.equal(listIndexedCodeTranscript("one")[0].id, "one-0");
    assert.equal(getIndexedLegacyCodeDraftId("legacy"), "vivary-code:legacy");
  };
  const warm = () => {
    read();
    // Keep the legacy link warm while evicting its parsed transcript. A later
    // read then distinguishes the small link memo from the full-content cache.
    for (let i = 0; i < 65; i++) listIndexedCodeTranscript(`evict-${i}`);
    read();
  };
  let logoutCase = 0;
  for (const [method, logoutPath] of [
    ["POST", "/_agent-native/auth/logout"], ["GET", "/_agent-native/auth/logout"],
    ["GET", "/_agent-native/auth/logout/"], ["POST", "/_agent-native/auth/logout/child"],
    ["GET", "/fixture/_agent-native/auth/logout/"],
  ]) {
    warm();
    const before = { ...counts };
    read();
    assert.deepEqual(counts, before, "unchanged public reads reuse all three cache categories");
    assert.equal((await app.request("http://localhost/unrelated")).status, 200);
    const token = `synthetic-code-cache-logout-${method}-${++logoutCase}`;
    await addSession(token, "owner@example.test");
    const authenticatedHeaders = method === "POST" ? { authorization: `Bearer ${token}` }
      : { cookie: `${COOKIE_NAME}=${token}` };
    const failedEvent = new H3Event(new Request("http://localhost" + logoutPath, {
      method, headers: authenticatedHeaders,
    }));
    await fire("request", failedEvent);
    await fire("response", new Response(null, { status: 403 }), failedEvent);
    read();
    assert.deepEqual(counts, before, "unrelated or failed responses do not clear retained contents");
    for (const headers of [{}, { authorization: "Bearer invalid-synthetic-token" }]) {
      const anonymous = await app.request("http://localhost" + logoutPath, { method, headers });
      assert.equal(anonymous.status, 200);
      read();
      assert.deepEqual(counts, before, "anonymous sign-out cannot flush another session's warm cache");
    }
    assert.equal(await getSessionEmail(token), "owner@example.test");
    const response = await app.request("http://localhost" + logoutPath, {
      method, headers: authenticatedHeaders,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await getSessionEmail(token), null, "Core revokes the actual synthetic session");
    read();
    assert.equal(counts.runReads, before.runReads + 2, "sign-out clears retained records");
    assert.equal(counts.transcriptReads, before.transcriptReads + 2,
      "sign-out clears both parsed transcripts and the separate legacy-link memo");
  }
});
