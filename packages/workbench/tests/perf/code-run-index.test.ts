import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFunction } from "node:vm";
import test, { after, type TestContext } from "node:test";
import { transformSync } from "esbuild";
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

// Execute the production response and scope helpers with either Core's readers
// or the cache. Fixed discovery/host inputs make byte equality deterministic.
const localSource = fs.readFileSync(new URL("../../server/local-code-agent.ts", import.meta.url), "utf8");
function functionSource(name: string): string {
  const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m").exec(localSource);
  assert.ok(match, name);
  return localSource.slice(match.index, localSource.indexOf("\n}", match.index) + 2).replace(/^export /, "");
}
const functions = ["getVivaryCodeState", "ownedRuns", "requireOwnedRun", "isOwnedRun", "isOwnedIdentity",
  "isVivaryAppRun", "isVivaryProjectHistoryRun", "metadataString", "metadataNumber", "runDraftThreadId",
  "toRunSummary", "engineFromRun", "engineLabelFromRun", "modelFromRun", "dedupeAdjacentAssistantEvents", "isAssistantEvent"];
const { code: stateCode } = transformSync(functions.map(functionSource).join("\n"), { loader: "ts" });
function stateReader(cached: boolean) {
  const inputs = { listCodeAgentRunRecords: cached ? listIndexedCodeRuns : listCodeAgentRunRecords,
    listCodeAgentTranscriptEvents: cached ? listIndexedCodeTranscript : listCodeAgentTranscriptEvents,
    getIndexedLegacyCodeDraftId: cached ? getIndexedLegacyCodeDraftId : (runId: string) => {
      const first = listCodeAgentTranscriptEvents(runId).find(event =>
        event.kind === "user" && typeof event.metadata?.draftThreadId === "string");
      return typeof first?.metadata?.draftThreadId === "string" ? first.metadata.draftThreadId : null;
    },
    ensureVivaryCodeHostInitialized: async () => {},
    getVivaryRuntimeStatus: async () => ({ status: "ready", checkedAt: "fixed" }),
    getCodexModels: async () => ({ status: "ready", models: [{ id: "fixture-model" }] }),
    getCodePermissionMode: async () => "auto-edit", activeRuns: new Map(),
    isActiveCodeAgentRun: (run: CodeAgentRunRecord) => ["running", "needs-approval"].includes(run.status),
    readVivaryCodeHostState: () => ({ activeRun: null, pendingApproval: null, recentRun: null, busy: false, cleanup: null }),
    VIVARY_CODE_ENGINES: ["claude-cli", "codex-cli"], VIVARY_CODE_DEFAULT_ENGINE: "claude-cli",
    VIVARY_CODE_MODELS: ["sonnet", "opus", "fable"], VIVARY_CODE_DEFAULT_MODEL: "sonnet",
    VIVARY_CODE_GOAL_ID: "vivary-local-code", VIVARY_CODE_APP_MARKER: "vivary-workbench-local-code",
    MAX_RUNS: 20, MAX_TRANSCRIPT_EVENTS: 400, fail: (message: string, details: object) => { throw Object.assign(new Error(message), details); } };
  return compileFunction(stateCode + "\nreturn getVivaryCodeState;", Object.keys(inputs))(...Object.values(inputs));
}

test("cached responses are byte-identical to Core readers, including legacy draft links, normalization, dedupe and latest 400", async t => {
  const root = store(t);
  for (let i = 0; i < 25; i++) {
    const run = record(`run-${i}`); delete run.metadata!.draftThreadId; writeRun(run);
    const events = Array.from({ length: 450 }, (_, j) => event(run.id, j));
    events[0].metadata = { draftThreadId: "vivary-code:legacy" };
    events.push({ ...event(run.id, 450), kind: "system", message: "Same", metadata: { role: "assistant" } },
      { ...event(run.id, 451), kind: "system", message: "Same", metadata: { role: "assistant" } });
    const file = writeTranscript(run.id, events);
    fs.appendFileSync(file, 'broken\n{"schemaVersion":1,"id":"normalized","runId":"' + run.id
      + '","role":"human","text":"Normalized","createdAt":"fixed"}\n');
  }
  writeRun({ ...record("foreign"), metadata: { ...record("foreign").metadata, ownerEmail: "b@test" } });
  writeRun({ ...record("other-goal"), goalId: "other" });
  writeRun(record("tied-id"), "different-name");
  fs.writeFileSync(path.join(codeAgentRunsDir(), "bad.json"), "broken");
  assert.equal(JSON.stringify(listIndexedCodeRuns()), JSON.stringify(listCodeAgentRunRecords()));
  assert.equal(JSON.stringify(listIndexedCodeRuns("vivary-local-code")), JSON.stringify(listCodeAgentRunRecords("vivary-local-code")));
  const cached = stateReader(true), direct = stateReader(false), scope = { root, label: "Fixture" };
  for (const id of [undefined, "run-24", "run-0"]) {
    assert.equal(JSON.stringify(await cached("a@test", id, scope, "a")),
      JSON.stringify(await direct("a@test", id, scope, "a")));
  }
});

test("production retention budgets cap entries and charged bytes; evicted/oversized files are re-read", async t => {
  store(t);
  const source = fs.readFileSync(new URL("../../server/code-run-index.ts", import.meta.url), "utf8");
  const start = source.indexOf("class FileContentCache");
  const end = source.indexOf("\ntype StoreCache", start);
  const { code } = transformSync(source.slice(start, end), { loader: "ts" });
  const Cache = compileFunction(code + "\nreturn FileContentCache;", ["identity"])((file: string) => {
    const info = fs.statSync(file, { bigint: true });
    return { token: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, bytes: Number(info.size) };
  });
  const files = ["one", "two", "three"].map(id => writeRun(record(id)));
  let reads = 0;
  const reader = () => { reads++; return "parsed"; };
  const cache = new Cache({ entries: 2, bytes: 100_000 });
  for (const file of files) cache.read(file, reader);
  assert.equal(cache.entries.size, 2); assert.ok(cache.bytes <= cache.limits.bytes);
  cache.read(files[0], reader); assert.equal(reads, 4, "entry eviction costs a re-read");
  const byteCache = new Cache({ entries: 64, bytes: fs.statSync(files[0]).size * 8 + 512 });
  for (const file of files) byteCache.read(file, reader);
  assert.equal(byteCache.entries.size, 1); assert.ok(byteCache.bytes <= byteCache.limits.bytes);
  fs.writeFileSync(files[0], "x".repeat(20_000));
  reads = 0; byteCache.read(files[0], reader); byteCache.read(files[0], reader);
  assert.equal(reads, 2, "oversized content is returned fresh without retention");
  const runFile = writeRun(record("current"));
  listIndexedCodeRuns(); writeTranscript("current", [event("current", 0)]); listIndexedCodeTranscript("current");
  type CacheState = { root: string; runs: { limits: { entries: number; bytes: number }; bytes: number };
    transcripts: { limits: { entries: number; bytes: number }; bytes: number } };
  const state = (globalThis as unknown as Record<symbol, CacheState>)[Symbol.for("vivary.workbench.code-run-index")];
  assert.deepEqual(state.runs.limits, { entries: 4096, bytes: 16 * 1024 * 1024 });
  assert.deepEqual(state.transcripts.limits, { entries: 64, bytes: 64 * 1024 * 1024 });
  assert.ok(state.runs.bytes <= state.runs.limits.bytes); assert.ok(state.transcripts.bytes <= state.transcripts.limits.bytes);
  fs.rmSync(runFile);
  const nextRoot = fs.mkdtempSync(path.join(data, "store-swap-"));
  fs.mkdirSync(path.join(nextRoot, "runs"));
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = nextRoot; // guard:allow-env-credential - Test host-store transition.
  assert.deepEqual(listIndexedCodeRuns(), [], "a different store cannot reuse any previous contents");
});
