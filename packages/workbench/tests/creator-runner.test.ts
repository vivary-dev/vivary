import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { redactCredentials } from "../server/credential-redaction.ts";
import { installedPatternCatalog } from "../server/managed-projects.mjs";
import { creatorGate, originalCommandSchema, runCreatorBridge, type CreatorCall, type CreatorRuntime } from "../server/original-runtime";
import { scheduling, type Execute } from "./original-runtime-harness.ts";

const python = execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const plan = (target: string): CreatorCall => ({ operation: "plan", target, patternChoices: [], preset: "coding" });
const apply = (target: string): CreatorCall => ({ operation: "apply", target,
  acceptedPlanSha256: "sha256:" + "a".repeat(64), patternChoices: [], preset: "coding" });
const fakeRuntime = (directory: string): CreatorRuntime =>
  ({ executable: "python-test", bridge: path.join(directory, "managed_project_workspace.py"), version: "test", bundle: null });

/** An executor that records each request and holds it until released. */
function holding() {
  const calls: { operation: string; target?: string }[] = [];
  const held: (() => void)[] = [];
  const execute: Execute = (_python, _args, stdin) => new Promise(resolve => {
    calls.push(JSON.parse(stdin));
    held.push(() => resolve({ exitCode: 0, stdout: "{}", stderr: "", signal: null }));
  });
  const until = async (count: number) => {
    for (let attempt = 0; attempt < 100 && calls.length < count; attempt++) await delay(20);
    assert.equal(calls.length, count, JSON.stringify(calls));
  };
  return { calls, execute, until, release: () => { for (const release of held.splice(0)) release(); } };
}

/** A stand-in bridge with its own folder. It reads its request, then runs `body`. */
async function standIn(body: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-creator-runner-"));
  const bridge = path.join(directory, "managed_project_workspace.py");
  await writeFile(bridge, `import json, sys\nsys.stdin.read()\n${body}\n`);
  return { bridge, runtime: { executable: python, bridge, version: "test", bundle: null },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("a settings read waits while an adoption write holds its project", async () => {
  const f = await scheduling();
  const reads = holding();
  const context = (projectId: string) => runCreatorBridge({ operation: "context", projectId,
    target: path.join(f.directory, projectId) }, fakeRuntime(f.directory), { dataDir: undefined, execute: reads.execute });
  try {
    const write = f.apply("project-a");
    await write.queued();
    assert.deepEqual(f.running(write), [true]);
    const blocked = context("project-a");
    const other = context("project-b");
    await reads.until(1);
    await delay(200);
    assert.deepEqual(reads.calls.map(call => path.basename(call.target!)), ["project-b"],
      "the read of the project being written waits");
    reads.release();
    await other;
    await f.finish(write);
    await reads.until(2);
    assert.equal(path.basename(reads.calls[1].target!), "project-a");
    reads.release();
    await blocked;
  } finally {
    reads.release();
    await f.cleanup();
  }
});

test("a plan waits for an apply to the same folder in any case, and the catalog does not wait", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "vivary-creator-gate-"));
  const runner = holding();
  const run = (call: CreatorCall) => runCreatorBridge(call, fakeRuntime(data), { dataDir: data, execute: runner.execute });
  try {
    const applying = run(apply(path.join(data, "projects", "Alpha")));
    await runner.until(1);
    const planning = run(plan(path.join(data, "projects", "ALPHA")));
    const catalog = run({ operation: "catalog" });
    await runner.until(2);
    await delay(200);
    assert.deepEqual(runner.calls.map(call => call.operation), ["apply", "catalog"], "the plan waits for the apply");
    runner.release();
    await Promise.all([applying, catalog]);
    await runner.until(3);
    assert.equal(runner.calls[2].operation, "plan");
    runner.release();
    await planning;
  } finally {
    runner.release();
    await rm(data, { recursive: true, force: true });
  }
});

test("an apply records a required receipt, a plan an optional one, and catalog and settings reads none", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "vivary-creator-receipts-"));
  const target = path.join(data, "projects", "Alpha");
  const receiptDir = path.join(data, "original-runtime");
  let executed = 0;
  const execute: Execute = async () => {
    executed += 1;
    return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
  };
  const run = (call: CreatorCall, dataDir: string | undefined) =>
    runCreatorBridge(call, fakeRuntime(data), { dataDir, execute });
  try {
    await run({ operation: "catalog" }, data);
    await run({ operation: "context", projectId: "project-a", target: data }, data);
    await assert.rejects(readdir(receiptDir), { code: "ENOENT" }, "a read that records nothing never touches the receipt folder");
    await run(plan(target), data);
    await run(apply(target), data);
    const receipts = (await readFile(path.join(receiptDir, "receipts.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line));
    assert.deepEqual(receipts.map(receipt => [receipt.command, receipt.ok, receipt.python, receipt.receipt_source]),
      [["creator-plan", true, "test", "app"], ["creator-apply", true, "test", "app"]]);
    for (const call of [{ operation: "catalog" } as const, plan(target)]) await run(call, undefined);
    assert.equal(executed, 6, "a catalog and a plan run without application data");
    await assert.rejects(run(apply(target), undefined), { errorCode: "vivary_original_data_unavailable" });
    await rm(path.join(receiptDir, "receipts.jsonl"));
    await mkdir(path.join(receiptDir, "receipts.jsonl"));
    await assert.rejects(run(apply(target), data), { errorCode: "vivary_original_receipt_path" });
    assert.equal(executed, 6, "an apply that cannot record never starts");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a creator answer may pass the 256 KiB command cap and stops past 512 KiB", async () => {
  const fits = await standIn(`print(json.dumps({"code": "catalog", "pad": "x" * ${300 * 1024}}))`);
  const overflows = await standIn(`print(json.dumps({"code": "catalog", "pad": "x" * ${600 * 1024}}))`);
  try {
    const result = await runCreatorBridge({ operation: "catalog" }, fits.runtime, { dataDir: undefined });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).pad.length, 300 * 1024);
    await assert.rejects(runCreatorBridge({ operation: "catalog" }, overflows.runtime, { dataDir: undefined }),
      { errorCode: "vivary_original_output_limit", statusCode: 413 });
  } finally {
    await Promise.all([fits.cleanup(), overflows.cleanup()]);
  }
});

test("a creator answer comes back byte-exact, and only the refusal an owner reads is redacted", async () => {
  const token = "sk-proj-" + randomBytes(16).toString("hex");
  const answer = JSON.stringify({ code: "context", context: { private_files: [`notes/${token}.md`] } });
  assert.notEqual(redactCredentials(answer), answer, "the redactor would change this answer");
  const exact = await standIn(`sys.stdout.write(${JSON.stringify(answer)})`);
  const refusing = await standIn(`print(json.dumps({"code": "refused", "message": "cannot use ${token}"}))\nraise SystemExit(2)`);
  try {
    assert.equal((await runCreatorBridge({ operation: "catalog" }, exact.runtime, { dataDir: undefined })).stdout, answer);
    await assert.rejects(installedPatternCatalog({}, { getAccess: async () => ({ code: "catalog" }), python,
      bridge: refusing.bridge }), (error: Error) => error.message === "cannot use [redacted credential]");
  } finally {
    await Promise.all([exact.cleanup(), refusing.cleanup()]);
  }
});

test("a creator gate never equals a project's gate, and a settings read shares its project's", () => {
  const projectId = originalCommandSchema.shape.projectId;
  for (const call of [{ operation: "catalog" } as const, plan("/data/projects/Alpha"), apply("/data/projects/Alpha")]) {
    assert.equal(projectId.safeParse(creatorGate(call)).success, false, call.operation);
  }
  assert.equal(creatorGate({ operation: "context", projectId: "project-a", target: "/project" }), "project-a");
});

test("managed projects start no process of their own", async () => {
  const source = await readFile(new URL("../server/managed-projects.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process/, "every creator call goes through the original runner");
});
