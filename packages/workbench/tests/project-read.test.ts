import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ActionContractError, isActionExposedToExternalAgents, type ActionRunContext } from "@agent-native/core/action";
import type { AgentEngine } from "@agent-native/core/agent/engine";
import {
  actionsToEngineTools, executeAgentToolCall, getRequestOrgId, getRequestRunContext,
  loadActionsFromStaticRegistry, runAgentLoop, runWithRequestContext, type RequestRunContext,
} from "@agent-native/core/server";

import { defineProjectReadTool } from "../actions/vivary-project-read.ts";
import {
  PROJECT_READ_MAX_RESULT_CHARS, PUBLIC_REVIEW_RULES, READ_BOUNDS, REVIEW_RULE_SENTENCES, type ProjectReadResult,
} from "../app/lib/project-read-schema.ts";
import { createVivaryChatIdentity } from "../server/chat-identity.ts";
import { createVivaryNativeChatProjectResolver } from "../server/native-chat-project.ts";
import { incompleteNote, privateExcluded, sensitiveExcluded } from "../app/lib/project-read-display.ts";
import {
  createProjectReadRunner, ORIGINAL_RUN_FAILURES, runOriginalProcess, type OriginalRunFailure, type ProjectReadCommand, type ProjectReadRun,
} from "../server/original-runtime.ts";
import { createProjectRead } from "../server/project-read.ts";

type Output = { exitCode: number | null; stdout: string; stderr: string };
const fixtures = path.join(import.meta.dirname, "fixtures", "project-read");
const load = async (name: string) => JSON.parse(await readFile(path.join(fixtures, `${name}.json`), "utf8")) as Record<string, Output>;
const coding = await load("coding");
const notes = await load("notes");
const host = await load("host");
const unsafeSnippet = await load("unsafe-snippet");
// Real `review --public` and `impact --public` output over a Git project whose
// ignored `private-roadmap` note is linked from `changes/retry.md`.
const review = await load("review");

// The captured fixtures replaced their temporary folders with these paths.
const hostPaths = { root: "/fixture/coding", dataDir: "/fixture/app-data" };
const ownerEmail = "owner@example.test";
const orgId = "org-a";
const owner: ActionRunContext = { caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" };

type Fake = Output | { failure: OriginalRunFailure } | Error;

function fakeRun(output: (projectId: string, command: ProjectReadCommand) => Fake, paths = hostPaths) {
  const calls: { projectId: string; command: ProjectReadCommand; context: ActionRunContext | undefined }[] = [];
  const run = async (projectId: string, command: ProjectReadCommand, context?: ActionRunContext): Promise<ProjectReadRun> => {
    calls.push({ projectId, command, context });
    const value = output(projectId, command);
    if (value instanceof Error) throw value;
    const project = { id: projectId, label: projectId === "project-b" ? "Project B" : "Project A" };
    if ("failure" in value) return { project, failure: value.failure };
    return { project, ...value, hostPaths: paths };
  };
  return { run, calls };
}

function reviewOutput(command: ProjectReadCommand): Output | undefined {
  if (command.verb === "review") return command.pack === "editorial" ? review.reviewEditorial : review.reviewStructure;
  if (command.verb !== "impact") return undefined;
  return ({ "sync-tests": review.impact, "private-roadmap": review.impactPrivate } as Record<string, Output>)[command.nodeId]
    ?? review.impactMissing;
}
const fixtureFor = (set: Record<string, Output>) => (_projectId: string, command: ProjectReadCommand) =>
  command.verb === "logs" ? (command.failedOnly ? host.logsFailed : host.logs) : reviewOutput(command) ?? set[command.verb];
const noChat = async () => { throw new Error("The owner path must not consult a chat."); };
const reported = (result: ProjectReadResult) => {
  assert.equal(result.status, "reported", JSON.stringify(result));
  if (result.status !== "reported") throw new Error("unreachable");
  return result.report;
};
const raw = (output: Output) => JSON.parse(output.stdout);

test("each operation runs its documented original command for the requested project", async () => {
  const { run, calls } = fakeRun(fixtureFor(coding));
  const reads = createProjectRead({ run, chatProject: noChat });
  for (const input of [
    { operation: "doctor" }, { operation: "check" }, { operation: "find", query: "sync queue" },
    { operation: "find", query: "sync queue", k: 3, budget: 800 }, { operation: "capabilities" },
    { operation: "capabilities", preset: "writing" }, { operation: "receipts" }, { operation: "receipts", failedOnly: true },
    { operation: "review" }, { operation: "review", pack: "editorial" }, { operation: "impact", nodeId: "sync-tests" },
  ] as const) await reads.forOwner(owner, { projectId: "project-a", ...input });
  assert.deepEqual(calls.map(call => call.command), [
    { verb: "doctor" }, { verb: "check" }, { verb: "find", query: "sync queue", k: 5, budget: 1200 },
    { verb: "find", query: "sync queue", k: 3, budget: 800 }, { verb: "capabilities", preset: "coding" },
    { verb: "capabilities", preset: "writing" }, { verb: "logs", failedOnly: false }, { verb: "logs", failedOnly: true },
    { verb: "review", pack: "structure" }, { verb: "review", pack: "editorial" }, { verb: "impact", nodeId: "sync-tests" },
  ]);
  assert.ok(calls.every(call => call.projectId === "project-a" && call.context === owner));
});

test("captured coding and notes reports keep the original findings, sources and limits", async () => {
  for (const [set, name] of [[coding, "coding"], [notes, "notes"]] as const) {
    const reads = createProjectRead({ run: fakeRun(fixtureFor(set)).run, chatProject: noChat });
    const request = { projectId: "project-a" };
    const doctor = reported(await reads.forOwner(owner, { ...request, operation: "doctor" }));
    const doctorRaw = raw(set.doctor);
    assert.deepEqual(doctor, { operation: "doctor", ok: doctorRaw.ok,
      errors: { items: doctorRaw.errors, total: doctorRaw.errors.length },
      warnings: { items: doctorRaw.warnings, total: doctorRaw.warnings.length } }, name);

    const check = reported(await reads.forOwner(owner, { ...request, operation: "check" }));
    const checkRaw = raw(set.check);
    assert.deepEqual(check, { operation: "check", checked: checkRaw.checked, clean: checkRaw.clean,
      errorCount: checkRaw.errors, warningCount: checkRaw.warnings, strict: checkRaw.strict, complete: checkRaw.complete,
      findings: { items: checkRaw.findings, total: checkRaw.findings.length }, omissions: checkRaw.omissions }, name);

    const find = reported(await reads.forOwner(owner, { ...request, operation: "find", query: raw(set.find).query }));
    const findRaw = raw(set.find);
    assert.deepEqual(find, { operation: "find", query: findRaw.query, k: 5, budget: 1200,
      estimatedTokens: findRaw.estimated_tokens, complete: findRaw.complete,
      results: { items: findRaw.results.map(({ edges: _edges, snippet, ...result }: { edges: unknown; snippet: string }) =>
        ({ ...result, snippet: snippet.length > READ_BOUNDS.text ? snippet.slice(0, READ_BOUNDS.text - 1) + "…" : snippet })),
      total: findRaw.results.length },
      omissions: findRaw.omissions }, name);

    const capabilities = reported(await reads.forOwner(owner, { ...request, operation: "capabilities" }));
    const capabilitiesRaw = raw(set.capabilities);
    assert.equal(capabilities.operation, "capabilities");
    if (capabilities.operation !== "capabilities") return;
    assert.equal(capabilities.preset, capabilitiesRaw.preset);
    assert.deepEqual(capabilities.defaults, capabilitiesRaw.default_capabilities);
    assert.deepEqual(capabilities.capabilities.items.map(item => [item.id, item.isDefault, item.network, item.installStatus, item.missing]),
      capabilitiesRaw.available_capabilities.map((item: Record<string, unknown>) =>
        [item.id, item.default, item.network, item.install_status, item.missing_install]));
    assert.equal(JSON.stringify(capabilities).includes("--governed"), false, "install and run commands are dropped");
  }
  const reads = createProjectRead({ run: fakeRun(fixtureFor(coding)).run, chatProject: noChat });
  const find = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "find", query: "How does the sync queue work?" }));
  assert.equal(find.operation, "find");
  if (find.operation !== "find") return;
  assert.deepEqual(find.omissions, [{ kind: "privacy_excluded", reason: "git_ignored", count: 1 }]);
  assert.equal(JSON.stringify(find).includes("private-roadmap"), false, "the git-ignored note stays out of context");
});

test("a hit whose snippet the facade withheld is reported without a snippet", async () => {
  const reads = createProjectRead({ run: fakeRun(() => unsafeSnippet.find).run, chatProject: noChat });
  const find = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "find", query: "users endpoint" }));
  assert.equal(find.operation, "find");
  if (find.operation !== "find") return;
  assert.deepEqual(find.results.items.map(hit => [hit.path, hit.snippet]), [
    ["docs/users.md", "# Users The users endpoint lists every account in pages of fifty."], ["docs/api.md", null]]);
});

test("captured review and impact reports keep the public findings and dependents, never the private note", async () => {
  const reads = createProjectRead({ run: fakeRun(fixtureFor(coding)).run, chatProject: noChat });
  for (const [pack, output] of [["structure", review.reviewStructure], ["editorial", review.reviewEditorial]] as const) {
    const report = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "review", pack }));
    const rawReview = raw(output);
    assert.deepEqual(report, { operation: "review", pack, reviewed: rawReview.reviewed, warnings: rawReview.warnings,
      notes: rawReview.notes, complete: rawReview.complete, findings: { items: rawReview.findings, total: rawReview.findings.length },
      omissions: rawReview.omissions }, pack);
  }
  const structure = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "review" }));
  assert.ok(structure.operation === "review" && structure.pack === "structure");
  assert.deepEqual(structure.findings.items.filter(finding => finding.rule === "broken-edge"),
    [{ severity: "warn", rule: "broken-edge", id: "retry", type: "change", path: "changes/retry.md", field: "verification" }]);
  assert.ok(structure.findings.items.every(finding => finding.rule === "broken-edge" || !("field" in finding)));

  const impact = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "impact", nodeId: "sync-tests" }));
  const rawImpact = raw(review.impact);
  assert.deepEqual(impact, { operation: "impact", target: "sync-tests", impacted: rawImpact.impacted, complete: rawImpact.complete,
    nodes: { items: rawImpact.nodes, total: rawImpact.nodes.length }, omissions: rawImpact.omissions });
  assert.equal(JSON.stringify([structure, impact]).includes("private-roadmap"), false);
});

test("review findings read from a closed rule table, and anything outside it is unreadable", async () => {
  const ozone = execFileSync(process.platform === "win32" ? "python" : "python3", ["-B", "-c",
    "import json, sys; sys.path.insert(0, sys.argv[1]); import ozone; print(json.dumps(list(ozone.PUBLIC_REVIEW_RULES)))",
    path.join(import.meta.dirname, "..", "..", "ozone")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(ozone), [...PUBLIC_REVIEW_RULES], "Ozone's public rules");
  assert.deepEqual(Object.keys(REVIEW_RULE_SENTENCES).sort(), [...PUBLIC_REVIEW_RULES].sort());
  const sentences = Object.values(REVIEW_RULE_SENTENCES);
  assert.equal(new Set(sentences).size, sentences.length, "one sentence per rule");
  assert.ok(sentences.every(sentence => /^[A-Z][^\u2014;]*\.$/.test(sentence)), "plain sentences");

  type Raw = ReturnType<typeof raw>;
  const read = async (edit: (output: Raw) => void, pack: "structure" | "editorial" = "structure") => {
    const output = raw(review.reviewStructure);
    edit(output);
    return createProjectRead({ run: fakeRun(() => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(output) })).run,
      chatProject: noChat }).forOwner(owner, { projectId: "project-a", operation: "review", pack });
  };
  const broken = (output: Raw) => output.findings.find((finding: { rule: string }) => finding.rule === "broken-edge");
  const cases: [string, (output: Raw) => void, ("structure" | "editorial")?][] = [
    ["an unknown rule", output => { output.findings[0].rule = "context-bloat"; }],
    ["a field on another rule", output => { output.findings[0].field = "verification"; }],
    ["a broken edge without its field", output => { delete broken(output).field; }],
    ["an unknown severity", output => { output.findings[0].severity = "error"; }],
    ["a pack other than the one requested", () => {}, "editorial"],
    ["a missing count", output => { delete output.warnings; }],
  ];
  for (const [label, edit, pack] of cases) {
    const result = await read(edit, pack);
    assert.ok(result.status === "unavailable" && result.reason === "unreadable_output", label);
  }
  const withMessage = reported(await read(output => { broken(output).message = "edge retry --verification--> private-roadmap"; }));
  assert.equal(JSON.stringify(withMessage).includes("private-roadmap"), false, "a free-text message never passes");
});

test("a private or missing impact target reads as one refusal, and a report for another target is unreadable", async () => {
  const reads = createProjectRead({ run: fakeRun(fixtureFor(coding)).run, chatProject: noChat });
  const privateNote = await reads.forOwner(owner, { projectId: "project-a", operation: "impact", nodeId: "private-roadmap" });
  const missing = await reads.forOwner(owner, { projectId: "project-a", operation: "impact", nodeId: "nowhere-9f2c41d7" });
  assert.deepEqual(privateNote, { status: "unavailable", project: { id: "project-a", label: "Project A" }, operation: "impact",
    reason: "target_unavailable", message: "No shared note in this project has this id." });
  assert.deepEqual(missing, privateNote, "a private id and a random id are indistinguishable");
  const other = await createProjectRead({ run: fakeRun(() => review.impact).run, chatProject: noChat })
    .forOwner(owner, { projectId: "project-a", operation: "impact", nodeId: "release" });
  assert.ok(other.status === "unavailable" && other.reason === "unreadable_output", "a report for another target");
});

test("receipts report the application log, including an absent one", async () => {
  const reads = createProjectRead({ run: fakeRun(fixtureFor(coding)).run, chatProject: noChat });
  const all = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "receipts" }));
  const allRaw = raw(host.logs);
  assert.equal(all.operation, "receipts");
  if (all.operation !== "receipts") return;
  assert.deepEqual([all.scope, all.failedOnly, all.logPresent, all.total, all.failed, all.invalidLines, all.records.total],
    ["application", false, true, allRaw.log.total, allRaw.log.failed, 0, allRaw.log.total]);
  const newest = allRaw.records.at(-1);
  assert.deepEqual(all.records.items[0], { timestamp: newest.timestamp, tool: newest.tool, command: newest.command,
    ok: newest.ok, exitCode: newest.exit_code, durationMs: newest.duration_ms, source: newest.receipt_source });
  const timestamps = all.records.items.map(record => record.timestamp);
  assert.deepEqual(timestamps, [...timestamps].sort().reverse(), "newest first, so fitting drops the oldest");
  const failed = reported(await reads.forOwner(owner, { projectId: "project-a", operation: "receipts", failedOnly: true }));
  assert.ok(failed.operation === "receipts" && failed.failedOnly && failed.records.items.length > 0
    && failed.records.items.every(record => !record.ok) && failed.records.total === raw(host.logsFailed).log.failed);

  // The runner asks for the latest 40, so the totals come from the whole-log summary.
  const latest = raw(host.logs);
  latest.log = { ...latest.log, total: 500, failed: 120 };
  const capped = reported(await createProjectRead({ run: fakeRun(() => ({ exitCode: 0, stderr: "",
    stdout: JSON.stringify(latest) })).run, chatProject: noChat }).forOwner(owner, { projectId: "project-a", operation: "receipts" }));
  assert.ok(capped.operation === "receipts");
  assert.deepEqual([capped.total, capped.failed, capped.records.total, capped.records.items.length],
    [500, 120, 500, latest.records.length]);
  const absent = { exitCode: 0, stderr: "", stdout: JSON.stringify({ summary: { total: 0, failed: 0, invalid_lines: 0, tools: {} },
    log: null, records: [] }) };
  const missing = createProjectRead({ run: fakeRun(() => absent).run, chatProject: noChat });
  assert.deepEqual(reported(await missing.forOwner(owner, { projectId: "project-a", operation: "receipts" })),
    { operation: "receipts", scope: "application", failedOnly: false, logPresent: false, total: 0, failed: 0, invalidLines: 0,
      records: { items: [], total: 0 } });
});

test("refusals, run failures and unreadable output are unavailable values, access errors throw", async () => {
  const project = { id: "project-a", label: "Project A" };
  const refused = createProjectRead({ run: fakeRun(() => host.refusal).run, chatProject: noChat });
  const privacy = await refused.forOwner(owner, { projectId: "project-a", operation: "find", query: "garden" });
  assert.equal(privacy.status, "unavailable");
  assert.ok(privacy.status === "unavailable" && privacy.reason === "privacy_policy_unavailable"
    && /private files/.test(privacy.message) && /Git repository on a host with Git installed, or a Vivary workspace/.test(privacy.message));
  const refusal = (reason: string) => ({ exitCode: 2, stderr: "", stdout: JSON.stringify({ schema: "vivary.read-refusal/v0", reason }) });
  const messages: Record<string, string> = {};
  for (const [operation, reason] of [["find", "path_refused"], ["check", "path_refused"], ["check", "work_limit_exceeded"]] as const) {
    const result = await createProjectRead({ run: fakeRun(() => refusal(reason)).run, chatProject: noChat })
      .forOwner(owner, operation === "find" ? { projectId: "project-a", operation, query: "garden" } : { projectId: "project-a", operation });
    assert.ok(result.status === "unavailable" && result.reason === reason, JSON.stringify(result));
    messages[`${operation} ${reason}`] = result.message;
  }
  assert.match(messages["find path_refused"], /question .*file or URL path, credential-like text/);
  assert.match(messages["check path_refused"], /this project folder/);
  assert.doesNotMatch(messages["check path_refused"], /question/);
  assert.match(messages["check work_limit_exceeded"], /larger than .* or check found more than 200 findings/);
  for (const [failure, reason] of [[ORIGINAL_RUN_FAILURES.timeout, "timeout"], [ORIGINAL_RUN_FAILURES.queueTimeout, "queue_timeout"],
    [ORIGINAL_RUN_FAILURES.outputLimit, "output_limit"], [ORIGINAL_RUN_FAILURES.runtimeUnavailable, "runtime_unavailable"],
    [ORIGINAL_RUN_FAILURES.dataUnavailable, "app_data_unavailable"], [ORIGINAL_RUN_FAILURES.receiptPath, "app_data_unavailable"]] as const) {
    const reads = createProjectRead({ run: fakeRun(() => ({ failure })).run, chatProject: noChat });
    const result = await reads.forOwner(owner, { projectId: "project-a", operation: "check" });
    assert.ok(result.status === "unavailable" && result.reason === reason && result.operation === "check"
      && result.message.length > 0, reason);
    assert.deepEqual(result.project, project);
  }
  const changed = new ActionContractError("The project changed while the command ran.",
    { errorCode: "vivary_original_project_changed", statusCode: 409 });
  await assert.rejects(createProjectRead({ run: fakeRun(() => changed).run, chatProject: noChat })
    .forOwner(owner, { projectId: "project-a", operation: "check" }), error => error === changed);
  for (const output of [{ exitCode: 2, stdout: "", stderr: "\nvivary doctor: create-vivary is not installed at /fixture/coding.\n" },
    { exitCode: 0, stdout: "not json", stderr: "" }, { exitCode: 0, stdout: JSON.stringify({ ok: "yes" }), stderr: "" }]) {
    const reads = createProjectRead({ run: fakeRun(() => output).run, chatProject: noChat });
    const result = await reads.forOwner(owner, { projectId: "project-a", operation: "doctor" });
    assert.ok(result.status === "unavailable" && result.reason === "unreadable_output", output.stdout);
  }
  const stderr = await createProjectRead({ run: fakeRun(() => ({ exitCode: 2, stdout: "",
    stderr: "Traceback (most recent call last):\n  File \"c:/users/x/proj/tool.py\"\nvivary find: error: unrecognized arguments: --public C:\\Users\\x\\proj\n" }),
  { root: "C:\\Users\\x\\proj", dataDir: "C:\\Users\\x\\data" }).run, chatProject: noChat })
    .forOwner(owner, { projectId: "project-a", operation: "find", query: "x" });
  assert.deepEqual(stderr, { status: "unavailable", project, operation: "find", reason: "unreadable_output",
    message: "The original command did not return a readable report." }, "stderr never reaches a result");

  const revoked = Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  const denied = createProjectRead({ run: async () => { throw revoked; }, chatProject: async () => { throw revoked; } });
  await assert.rejects(denied.forOwner(owner, { projectId: "project-a", operation: "doctor" }), error => error === revoked);
  await assert.rejects(denied.forChat({ caller: "tool" }, { operation: "doctor" }), error => error === revoked);
});

type RunnerDependencies = NonNullable<Parameters<typeof createProjectReadRunner>[0]>;

// The real runner over a fixture bundle. The child is a fake unless a test spawns the fixture interpreter.
async function realRunner() {
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-project-read-"));
  const runtime = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const root = path.join(directory, "project");
  const interpreter = process.platform === "win32" ? "python/python.exe" : "python/bin/python3";
  await Promise.all([mkdir(path.join(runtime, path.dirname(interpreter)), { recursive: true }), mkdir(data), mkdir(root)]);
  await writeFile(path.join(runtime, interpreter), "fixture interpreter, not executable");
  await writeFile(path.join(runtime, "manifest.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform,
    arch: process.arch, pythonVersion: "3.12.14", pythonExecutable: interpreter }));
  const workspace = { root, actorId: "actor-owner", label: "Project A", projectId: "project-a", rootId: "root-a", bindingId: "binding-a",
    bindingRevision: 1, policyRevision: 1, locationRef: "local:a", verificationKind: "local-stat-revalidated-v1" as const };
  const reads = (dependencies: Partial<RunnerDependencies> = {}) => createProjectRead({ chatProject: noChat,
    run: createProjectReadRunner({ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
      resolveWorkspace: async () => workspace, execute: async () => ({ ...coding.find, signal: null }), parallelism: 4,
      ...dependencies }) });
  return { directory, runtime, data, root, workspace, reads, receipts: path.join(data, "original-runtime", "receipts.jsonl"),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const findQuery = { projectId: "project-a", operation: "find", query: "How does the sync queue work?" } as const;

test("a good read survives a receipt that cannot be written", async () => {
  const h = await realRunner();
  try {
    const outside = path.join(h.directory, "outside.jsonl");
    await writeFile(outside, "preserve me");
    for (const block of [() => mkdir(h.receipts), () => symlink(outside, h.receipts)]) {
      await rm(h.receipts, { recursive: true, force: true });
      const result = await h.reads({ execute: async () => { await block(); return { ...coding.find, signal: null }; } })
        .forOwner(owner, findQuery);
      assert.equal(reported(result).operation, "find");
    }
    assert.equal(await readFile(outside, "utf8"), "preserve me");
  } finally { await h.cleanup(); }
});

test("host configuration failures are unavailable values that name the project", async () => {
  const h = await realRunner();
  const project = { id: "project-a", label: "Project A" };
  try {
    const cases: [Partial<RunnerDependencies>, string][] = [
      [{ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: h.runtime }) }, "app_data_unavailable"],
      [{ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: h.runtime, VIVARY_DATA_DIR: "data" }) }, "app_data_unavailable"],
      [{ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: h.runtime, VIVARY_DATA_DIR: path.join(h.directory, "absent") }) }, "app_data_unavailable"],
      [{ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: path.join(h.directory, "absent"), VIVARY_DATA_DIR: h.data }) }, "runtime_unavailable"],
      [{ execute: runOriginalProcess }, "runtime_unavailable"],
    ];
    for (const [dependencies, reason] of cases) {
      const result = await h.reads(dependencies).forOwner(owner, findQuery);
      assert.ok(result.status === "unavailable" && result.reason === reason && result.message.length > 0, JSON.stringify(result));
      assert.deepEqual(result.project, project);
      assert.equal(JSON.stringify(result).includes(h.directory), false);
    }
    let executed = 0;
    await mkdir(path.dirname(h.receipts), { recursive: true });
    // The failed runs above recorded themselves, so the link replaces that log.
    await rm(h.receipts, { force: true });
    await writeFile(path.join(h.directory, "linked.jsonl"), "");
    await link(path.join(h.directory, "linked.jsonl"), h.receipts);
    const counting = h.reads({ execute: async () => { executed++; return { ...coding.find, signal: null }; } });
    assert.equal(reported(await counting.forOwner(owner, findQuery)).operation, "find", "a read stands without its receipt");
    const linked = await counting.forOwner(owner, { projectId: "project-a", operation: "receipts" });
    assert.ok(linked.status === "unavailable" && linked.reason === "app_data_unavailable" && executed === 1, JSON.stringify(linked));
    assert.equal(await readFile(path.join(h.directory, "linked.jsonl"), "utf8"), "");
  } finally { await h.cleanup(); }
});

test("access and project refusals from the runner still throw", async () => {
  const h = await realRunner();
  try {
    const revoked = Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
    let resolutions = 0;
    await assert.rejects(h.reads({ resolveWorkspace: async () => { if (++resolutions > 1) throw revoked; return h.workspace; } })
      .forOwner(owner, findQuery), error => error === revoked);
    resolutions = 0;
    await assert.rejects(h.reads({ resolveWorkspace: async () => ++resolutions > 2 ? { ...h.workspace, policyRevision: 2 } : h.workspace })
      .forOwner(owner, findQuery), { errorCode: "vivary_original_project_changed", statusCode: 409 });
    await assert.rejects(h.reads({ resolveWorkspace: async () => ({ ...h.workspace, root: h.directory }) })
      .forOwner(owner, findQuery), { errorCode: "vivary_original_data_in_project" });
  } finally { await h.cleanup(); }
});

test("source paths that could leave the project make the whole report unreadable", async () => {
  for (const bad of ["/etc/passwd", "../outside.md", "notes/../../outside.md", "notes\\inside.md", "C:/notes.md",
    "notes/\u0000.md", "a".repeat(513)]) {
    const check = raw(coding.check);
    const find = raw(coding.find);
    const reviewed = raw(review.reviewStructure);
    const impacted = raw(review.impact);
    check.findings[0].path = bad;
    find.results[0].path = bad;
    reviewed.findings[0].path = bad;
    impacted.nodes[0].path = bad;
    const outputs: Partial<Record<ProjectReadCommand["verb"], unknown>> = { check, find, review: reviewed, impact: impacted };
    const reads = createProjectRead({ run: fakeRun((_id, command) => ({ exitCode: 0, stderr: "",
      stdout: JSON.stringify(outputs[command.verb]) })).run, chatProject: noChat });
    for (const input of [{ operation: "check" }, { operation: "find", query: "sync" }, { operation: "review" },
      { operation: "impact", nodeId: "sync-tests" }] as const) {
      const result = await reads.forOwner(owner, { projectId: "project-a", ...input });
      assert.ok(result.status === "unavailable" && result.reason === "unreadable_output", `${input.operation} ${bad}`);
    }
  }
});

test("host paths never appear in any serialized result", async () => {
  const doctor = raw(coding.doctor);
  doctor.errors.push(`workspace root ${hostPaths.root} is readable`, `receipts live in ${hostPaths.dataDir}/original-runtime`);
  const check = raw(coding.check);
  check.findings[0].message = `see ${hostPaths.root}/changes/add-sync.md`;
  const reviewed = raw(review.reviewStructure);
  reviewed.findings[0].id = `${hostPaths.root}/cleanup`;
  reviewed.omissions[0].reason = `${hostPaths.dataDir}/ignored`;
  const impacted = raw(review.impact);
  impacted.nodes[0].via = `${hostPaths.root}/field`;
  const edited: Partial<Record<ProjectReadCommand["verb"], unknown>> = { doctor, check, review: reviewed, impact: impacted };
  const reads = createProjectRead({ run: fakeRun((_id, command) => edited[command.verb]
    ? { exitCode: 1, stdout: JSON.stringify(edited[command.verb]), stderr: "" }
    : fixtureFor(coding)(_id, command)).run, chatProject: noChat });
  const results = [];
  for (const input of [{ operation: "doctor" }, { operation: "check" }, { operation: "find", query: "sync queue" },
    { operation: "capabilities" }, { operation: "receipts" }, { operation: "review" },
    { operation: "impact", nodeId: "sync-tests" }] as const) {
    results.push(await reads.forOwner(owner, { projectId: "project-a", ...input }));
  }
  const text = JSON.stringify(results);
  assert.equal(text.includes(hostPaths.root), false);
  assert.equal(text.includes(hostPaths.dataDir), false);
  const report = reported(results[0]);
  assert.ok(report.operation === "doctor" && report.errors.items.includes("workspace root . is readable")
    && report.errors.items.includes("receipts live in <app data>/original-runtime"));
  const reviewReport = reported(results[5]);
  assert.ok(reviewReport.operation === "review" && reviewReport.findings.items[0].id === "./cleanup"
    && reviewReport.omissions[0].reason === "<app data>/ignored");

  const windows = { root: "C:\\Users\\x\\proj", dataDir: "C:\\Users\\x\\AppData\\Roaming\\Vivary" };
  const spelled = raw(coding.doctor);
  spelled.errors = ["cannot read c:/users/x/proj/notes.md", "cannot read C:\\Users\\x\\proj\\a.md",
    "receipts in c:/users/x/appdata/roaming/vivary/original-runtime", "receipts in C:\\USERS\\X\\AppData\\Roaming\\Vivary\\logs"];
  const windowsRead = createProjectRead({ run: fakeRun(() => ({ exitCode: 1, stdout: JSON.stringify(spelled), stderr: "" }), windows).run,
    chatProject: noChat });
  const windowsReport = reported(await windowsRead.forOwner(owner, { projectId: "project-a", operation: "doctor" }));
  assert.equal(JSON.stringify(windowsReport).toLowerCase().replaceAll("\\\\", "/").includes("users/x"), false);
  assert.ok(windowsReport.operation === "doctor");
  assert.deepEqual(windowsReport.errors.items, ["cannot read ./notes.md", "cannot read .\\a.md",
    "receipts in <app data>/original-runtime", "receipts in <app data>\\logs"]);
});

test("only check and review findings, find results, and impact nodes carry a path, the one field redaction leaves whole", async () => {
  const reads = createProjectRead({ run: fakeRun(fixtureFor(coding)).run, chatProject: noChat });
  const paths = new Set<string>();
  const walk = (value: unknown, where: string) => {
    if (Array.isArray(value)) value.forEach(item => walk(item, `${where}[]`));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "path") paths.add(`${where}.path`);
        walk(item, `${where}.${key}`);
      }
    }
  };
  for (const input of [{ operation: "doctor" }, { operation: "check" }, { operation: "find", query: "sync queue" },
    { operation: "capabilities" }, { operation: "receipts" }, { operation: "review" },
    { operation: "impact", nodeId: "sync-tests" }] as const) {
    walk(reported(await reads.forOwner(owner, { projectId: "project-a", ...input })), input.operation);
  }
  assert.deepEqual([...paths].sort(), ["check.findings.items[].path", "find.results.items[].path",
    "impact.nodes.items[].path", "review.findings.items[].path"]);
});

test("worst-case outputs stay under the tool result limit with true totals", async () => {
  // Control characters, quotes, and backslashes cost the most JSON per character, and a cut
  // can land inside a non-BMP character. Every list is longer than its bound.
  for (const unit of ["\u0001\u001b\"\\é😀\u0085", "\\", "\u0001"]) {
    const long = (prefix: string) => prefix + unit.repeat(Math.ceil(400 / unit.length));
    const many = <T>(make: (index: number) => T) => Array.from({ length: 90 }, (_, index) => make(index));
    const sourcePath = (index: number) => `notes/${String(index).padStart(4, "0")}-${"é😀".repeat(160)}.md`;
    const atOmissionBound = (prefix: string) => prefix + unit.repeat(Math.floor(120 / unit.length));
    const omissions = Array.from({ length: 40 }, () => ({ kind: atOmissionBound("kind"), reason: atOmissionBound("reason"), count: 9 }));
    const worst = {
      doctor: { schema: "vivary.doctor-result/v0", ok: false, errors: many(() => long("error")), warnings: many(() => long("warning")) },
      check: { schema: "vivary.check-result/v0", checked: 900, clean: 0, errors: 900, warnings: 0, strict: true, complete: false, omissions,
        findings: many(index => ({ path: sourcePath(index), line: 1, level: "error", code: long("E"), message: long("m") })) },
      find: { schema: "vivary.find-result/v0", query: long("q"), k: 20, budget: 4000, estimated_tokens: 4000, complete: false, omissions,
        results: many(index => ({ id: long("id"), type: long("type"), path: sourcePath(index), reason: long("r"), snippet: long("s") })) },
      capabilities: { preset: "coding", default_capabilities: many(() => long("default")),
        available_capabilities: many(() => ({ id: long("id"), label: long("label"), default: false, requires_approval: true,
          network: long("network"), install_status: "not-installed", missing_install: many(() => long("package")) })) },
      review: { schema: "vivary.review-result/v0", pack: "structure", reviewed: 900, warnings: 90, notes: 0, complete: false, omissions,
        findings: many(index => ({ severity: "warn", rule: "broken-edge", id: long("id"), type: long("type"), path: sourcePath(index),
          field: long("field") })) },
      impact: { schema: "vivary.impact-result/v0", target: "q", impacted: 90, complete: false, omissions,
        nodes: many(index => ({ id: long("id"), distance: index + 1, via: long("via"), type: long("type"), path: sourcePath(index) })) },
      logs: { summary: { total: 90, failed: 90, invalid_lines: 0 }, log: { total: 90, failed: 90, invalid_lines: 0 }, records: many(() => ({ timestamp: long("t"), tool: long("tool"),
        command: long("command"), ok: false, exit_code: 1, duration_ms: 5, receipt_source: long("source"), error_type: long("type") })) },
    };
    const reads = createProjectRead({ run: fakeRun((_id, command) => ({ exitCode: 1, stderr: "",
      stdout: JSON.stringify(worst[command.verb]) })).run, chatProject: noChat });
    for (const input of [{ operation: "doctor" }, { operation: "check" }, { operation: "find", query: "q" },
      { operation: "capabilities" }, { operation: "receipts" }, { operation: "review" }, { operation: "impact", nodeId: "q" }] as const) {
      const label = `${input.operation} with ${JSON.stringify(unit)}`;
      const result = await reads.forOwner(owner, { projectId: "project-a", ...input });
      const report = reported(result);
      const size = JSON.stringify(result, null, 2).length;
      assert.ok(size <= PROJECT_READ_MAX_RESULT_CHARS, `${label} is ${size} characters`);
      const lists = Object.values(report).filter((value): value is { items: unknown[]; total: number } =>
        typeof value === "object" && value !== null && "total" in value);
      assert.ok(lists.length > 0 && lists.every(list => list.total === 90 && list.items.length <= READ_BOUNDS.items), `${label} keeps true totals`);
      const strings = (JSON.stringify(report).match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(value => JSON.parse(value) as string);
      assert.ok(strings.every(value => value.length <= 512 && value.isWellFormed()), `${label} strings are bounded and well formed`);
      assert.ok(strings.every(value => !/\p{Cc}/u.test(value)), `${label} strings are printable`);
    }
  }
  const oversized = raw(coding.find);
  oversized.omissions = [{ kind: "k".repeat(129), reason: "git_ignored", count: 1 }];
  const beyond = await createProjectRead({ run: fakeRun(() => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(oversized) })).run,
    chatProject: noChat }).forOwner(owner, findQuery);
  assert.ok(beyond.status === "unavailable" && beyond.reason === "unreadable_output", "omission text past Tropo's bound");
});

const catalog = { code: "catalog", projects: [{ projectId: "project-a", displayName: "Project A" },
  { projectId: "project-b", displayName: "Project B" }] };
const scope = (projectId: string | null) => createVivaryChatIdentity(ownerEmail, orgId,
  { kind: "project", projectId, label: projectId ?? "Personal workspace" }).scope;

function tool() {
  const fake = fakeRun((projectId, command) => fixtureFor(projectId === "project-b" ? notes : coding)(projectId, command));
  const reads = createProjectRead({ run: fake.run, chatProject: createVivaryNativeChatProjectResolver({
    getOrgId: getRequestOrgId,
    resolveProjectWorkspace: async () => { throw new Error("The tool path resolves the workspace in the runner."); },
    // Stands in for project services, which classify the request's scope.
    matchChatProject: async context => {
      const scopeId = getRequestRunContext()?.chatScope?.id;
      if (!scopeId?.startsWith("vivary-project-chat-v2:")) return { kind: "not-project" };
      if (scopeId === scope(null).id) return { kind: "personal" };
      const match = catalog.projects.find(candidate => scope(candidate.projectId).id === scopeId);
      if (!match) throw Object.assign(new Error("Project conversation access is unavailable."), { statusCode: 403 });
      return { kind: "project", projectId: match.projectId, context };
    },
  }) });
  const actions = loadActionsFromStaticRegistry({ "vivary-project-read": { default: defineProjectReadTool(reads) } });
  const call = (chatScope: RequestRunContext["chatScope"], input: unknown) =>
    runWithRequestContext({ userEmail: ownerEmail, orgId, run: { chatScope } }, () => executeAgentToolCall({
      actions, name: "vivary-project-read", input, callId: "call-project-read", ownerEmail, orgId }));
  return { reads, calls: fake.calls, call };
}

test("the Native tool reads only the chat's own project, and the owner path returns the same result", async () => {
  const { reads, calls, call } = tool();
  const result = await call(scope("project-b"), { operation: "check" });
  assert.equal(result.status, "completed", result.output);
  const parsed = JSON.parse(result.output) as ProjectReadResult;
  assert.deepEqual(parsed.project, { id: "project-b", label: "Project B" });
  assert.deepEqual(calls.map(entry => [entry.projectId, entry.context?.caller, entry.context?.appId, entry.context?.userEmail]),
    [["project-b", "tool", "workbench", ownerEmail]]);
  assert.deepEqual(parsed, await reads.forOwner(owner, { projectId: "project-b", operation: "check" }));
});

test("review and impact reach the model exactly as the owner sees them", async () => {
  const { reads, calls, call } = tool();
  for (const input of [{ operation: "review" }, { operation: "review", pack: "editorial" },
    { operation: "impact", nodeId: "sync-tests" }, { operation: "impact", nodeId: "private-roadmap" }] as const) {
    const result = await call(scope("project-a"), input);
    assert.equal(result.status, "completed", result.output);
    assert.deepEqual(JSON.parse(result.output), await reads.forOwner(owner, { projectId: "project-a", ...input }), JSON.stringify(input));
  }
  assert.deepEqual(calls.filter(entry => entry.context?.caller === "tool").map(entry => entry.command), [
    { verb: "review", pack: "structure" }, { verb: "review", pack: "editorial" },
    { verb: "impact", nodeId: "sync-tests" }, { verb: "impact", nodeId: "private-roadmap" }]);
});

test("the Native tool refuses caller projects, personal and legacy chats, and malformed input before running", async () => {
  const { calls, call } = tool();
  for (const input of [{ operation: "doctor", projectId: "project-a" }, { operation: "doctor", root: "/outside" },
    { operation: "find" }, { operation: "find", query: "--root /outside" }, { operation: "find", query: "x", k: 21 },
    { operation: "find", query: "x", budget: 5_000 }, { operation: "doctor", query: "x" }, { operation: "shell" },
    { operation: "receipts", path: "/outside/receipts.jsonl" }, { operation: "capabilities", preset: "admin" },
    { operation: "impact" }, { operation: "impact", nodeId: "--root" }, { operation: "impact", nodeId: "x".repeat(257) },
    { operation: "review", pack: "context-budget" }, { operation: "doctor", pack: "structure" },
    { operation: "review", nodeId: "sync-tests" }]) {
    const result = await call(scope("project-a"), input);
    assert.equal(result.status, "failed", JSON.stringify(input));
  }
  for (const [input, message] of [[{ operation: "find" }, "find needs a query"],
    [{ operation: "find", query: "--root /outside" }, "The question must not start with a dash"],
    [{ operation: "doctor", query: "x" }, "query does not apply to doctor"]] as const) {
    const result = await call(scope("project-a"), input);
    assert.ok(result.output.includes(`query: ${message}. Received:`), result.output);
  }
  for (const chatScope of [scope(null), createVivaryChatIdentity(ownerEmail, orgId, { kind: "unassigned" }).scope, undefined]) {
    const result = await call(chatScope, { operation: "doctor" });
    assert.equal(result.status, "failed");
    assert.match(result.output, /Open this chat from a project to use project tools/);
  }
  assert.equal(calls.length, 0);
});

test("a revoked project reaches the model as the resolver's refusal", async () => {
  const revoked = Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  const reads = createProjectRead({ run: async () => { throw revoked; }, chatProject: async () => ({ projectId: "project-a", projectContext: owner }) });
  const actions = loadActionsFromStaticRegistry({ "vivary-project-read": { default: defineProjectReadTool(reads) } });
  const result = await runWithRequestContext({ userEmail: ownerEmail, orgId, run: { chatScope: scope("project-a") } },
    () => executeAgentToolCall({ actions, name: "vivary-project-read", input: { operation: "doctor" }, callId: "call-revoked", ownerEmail, orgId }));
  assert.equal(result.status, "failed");
  assert.match(result.output, /Project folder access changed/);
});

test("a repeated read in one agent turn reaches the runner again, so a queue timeout can be retried", async () => {
  let runs = 0;
  const reads = createProjectRead({ chatProject: async () => ({ projectId: "project-a", projectContext: owner }), run: async () => {
    runs++;
    return { project: { id: "project-a", label: "Project A" }, failure: ORIGINAL_RUN_FAILURES.queueTimeout };
  } });
  const actions = loadActionsFromStaticRegistry({ "vivary-project-read": { default: defineProjectReadTool(reads) } });
  let requests = 0;
  const engine: AgentEngine = { name: "fake", label: "Fake", defaultModel: "fake-model", supportedModels: ["fake-model"],
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
    async *stream() {
      requests++;
      if (requests <= 2) {
        const call = { type: "tool-call" as const, id: `call-${requests}`, name: "vivary-project-read", input: { operation: "doctor" } };
        yield call;
        yield { type: "assistant-content", parts: [call] };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "assistant-content", parts: [{ type: "text", text: "Vivary is still busy." }] };
        yield { type: "stop", reason: "end_turn" };
      }
    } };
  const results: string[] = [];
  await runWithRequestContext({ userEmail: ownerEmail, orgId, run: {} }, () => runAgentLoop({ engine, model: "fake-model",
    systemPrompt: "", tools: actionsToEngineTools(actions), actions, signal: new AbortController().signal,
    messages: [{ role: "user", content: [{ type: "text", text: "Check the project health, then try again." }] }],
    send: event => { if (event.type === "tool_done") results.push(event.result); } }));
  assert.equal(runs, 2, "the second identical call was not served from the turn's read cache");
  assert.deepEqual(results.map(result => (JSON.parse(result) as ProjectReadResult).status), ["unavailable", "unavailable"]);
});

test("the model sees the read and evaluate tools with no project field, and the read tool's observations rule", async () => {
  const modules: Record<string, unknown> = {};
  for (const file of await readdir(path.join(import.meta.dirname, "..", "actions"))) {
    if (file.endsWith(".ts")) modules[file.slice(0, -3)] = await import(`../actions/${file}`);
  }
  const actions = loadActionsFromStaticRegistry(modules);
  const vivaryTools = actionsToEngineTools(actions).filter(entry => entry.name.startsWith("vivary-"));
  assert.deepEqual(vivaryTools.map(entry => entry.name).sort(), ["vivary-project-evaluate", "vivary-project-read"]);
  const projectTool = vivaryTools.find(entry => entry.name === "vivary-project-read")!;
  const schema = projectTool.inputSchema as { type: string; properties: Record<string, { enum?: string[] }>; required?: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties.operation.enum, ["doctor", "check", "find", "capabilities", "receipts", "review", "impact"]);
  assert.equal("projectId" in schema.properties, false);
  assert.match(projectTool.description, /observations/);
  assert.match(projectTool.description, /review: structure or editorial findings/);
  assert.match(projectTool.description, /impact: the shared notes that link to one note id/);
  assert.equal(isActionExposedToExternalAgents(actions["vivary-project-read"]), false);
  assert.equal(isActionExposedToExternalAgents(actions["vivary-project-read-owner"]), false);
});

test("the panel's exclusion and incomplete notes claim only what Tropo's rows state", () => {
  // Rows captured from real vivary --public output on Zo, 2026-09-25.
  const ignoredConfig = [{ kind: "config", reason: "git_ignored", count: 1 },
    { kind: "filesystem", reason: "link_or_reparse", count: 1 }, { kind: "privacy_excluded", reason: "git_ignored", count: 1 }];
  assert.equal(privateExcluded(ignoredConfig), "1 private file excluded", "a Git-ignored config file counts once");
  assert.equal(sensitiveExcluded(ignoredConfig), null);
  assert.equal(incompleteNote(ignoredConfig), "This report is incomplete.");
  const budgetFind = [{ kind: "document", reason: "sensitive_name", count: 1 }, { kind: "result", reason: "budget_limit", count: 5 }];
  assert.equal(privateExcluded(budgetFind), null);
  assert.equal(sensitiveExcluded(budgetFind), "1 file left out because its name or content looks sensitive");
  assert.equal(incompleteNote(budgetFind), "This report is incomplete. The token budget cut the results short, so more context may exist.");
  const sensitive = [{ kind: "document", reason: "sensitive_content", count: 1 }, { kind: "document", reason: "sensitive_name", count: 1 },
    { kind: "filesystem", reason: "sensitive_name", count: 1 }];
  assert.equal(sensitiveExcluded(sensitive), "2 files and 1 folder left out because their name or content looks sensitive");
  // Core's privacy policy writes a file under an id_rsa folder as privacy_excluded/sensitive_name.
  const coreSensitive = [{ kind: "document", reason: "sensitive_name", count: 1 }, { kind: "filesystem", reason: "sensitive_name", count: 1 },
    { kind: "privacy_excluded", reason: "git_ignored", count: 1 }, { kind: "privacy_excluded", reason: "sensitive_name", count: 1 }];
  assert.equal(privateExcluded(coreSensitive), "1 private file excluded", "each excluded item counts once");
  assert.equal(sensitiveExcluded(coreSensitive), "2 files and 1 folder left out because their name or content looks sensitive");
});
