import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, link, readdir, realpath, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActionRunContext } from "@agent-native/core/action";
import type { LocalProjectWorkspace } from "../server/project-services.mjs";
import { ActionContractError } from "@agent-native/core/action";
import { adoptionExecutionSchema, createAdoptionCommandRunner, createOriginalCommandRunner, createProjectEvaluateRunner, createProjectReadRunner, ORIGINAL_RUN_FAILURES, originalChildEnvironment, originalCommandArguments, originalCommandSchema, runOriginalProcess, type GovernedCommand } from "../server/original-runtime";
import { projectAgentActorId } from "../server/governed-request.ts";
import { bundle, context, fixture, projectWorkspace, scheduling } from "./original-runtime-harness.ts";

const input = { projectId: "project-a", command: { verb: "pattern-state" as const } };

test("command input has no caller-supplied executable, paths, flags or receipt target", () => {
  for (const invalid of [
    { ...input, args: ["--root", "/outside"] },
    { ...input, receiptLog: "/outside" },
    { ...input, command: { verb: "shell" } },
    { ...input, command: { verb: "create", root: "/outside" } },
    { ...input, command: { verb: "review", pack: "/outside" } },
    { ...input, command: { verb: "find", query: "--root /outside" } },
    { ...input, command: { verb: "find", query: "-v" } },
    { ...input, command: { verb: "impact", nodeId: "--receipt=/outside" } },
    { ...input, command: { verb: "review", pack: "context-budget" } },
    { ...input, command: { verb: "adopt", approvedPlanHash: "--yes" } },
    { ...input, command: { verb: "create", apply: true } },
    { ...input, command: { verb: "create", apply: false } },
    { ...input, command: { verb: "adopt", approvedPlanHash: "sha256:" + "a".repeat(64) } },
  ]) assert.equal(originalCommandSchema.safeParse(invalid).success, false);
});

test("the public command action has no project read and no governed evaluation", () => {
  for (const command of [{ verb: "doctor" }, { verb: "capabilities" }, { verb: "check" },
    { verb: "find", query: "chapter outline" }, { verb: "logs" }, { verb: "review" }, { verb: "impact", nodeId: "outline" },
    { verb: "decide", request: "{}" }, { verb: "control", request: "{}" }]) {
    assert.equal(originalCommandSchema.safeParse({ projectId: "project-a", command }).success, false, command.verb);
  }
});

test("project reads use the privacy-filtered front door and never pass a receipt path", () => {
  const root = "/granted/project";
  assert.deepEqual(originalCommandArguments({ verb: "doctor" }, root).args, ["doctor", "--root", root, "--public", "--json"]);
  assert.deepEqual(originalCommandArguments({ verb: "capabilities", preset: "writing" }, root).args,
    ["capabilities", "--preset", "writing", "--json"]);
  assert.deepEqual(originalCommandArguments({ verb: "find", query: "chapter outline", k: 5, budget: 1200 }, root).args,
    ["find", "chapter outline", "--root", root, "--public", "--json", "--k", "5", "--budget", "1200"]);
  assert.deepEqual(originalCommandArguments({ verb: "check" }, root).args, ["check", "--root", root, "--public", "--json"]);
  assert.deepEqual(originalCommandArguments({ verb: "logs", failedOnly: false }, root).args, ["logs", "--json", "--tail", "40"]);
  assert.deepEqual(originalCommandArguments({ verb: "logs", failedOnly: true }, root).args, ["logs", "--json", "--tail", "40", "--failed"]);
  assert.deepEqual(originalCommandArguments({ verb: "review", pack: "editorial" }, root).args,
    ["review", "--root", root, "--public", "--json", "--pack", "editorial"]);
  assert.deepEqual(originalCommandArguments({ verb: "impact", nodeId: "decision-auth" }, root).args,
    ["impact", "decision-auth", "--root", root, "--public", "--json"]);
});

test("governed commands pass only the document the runner built", () => {
  const decide: GovernedCommand = { verb: "decide", evaluateAs: "agent", input: { operation: "decide", capsule: {} } };
  assert.deepEqual(originalCommandArguments(decide, "/granted/project", undefined, "{\"built\":true}"),
    { args: ["decide", "--governed", "--json", "--strict", "-"], stdin: "{\"built\":true}" });
  const control: GovernedCommand = { verb: "control", evaluateAs: "agent", input: { operation: "expire_leases", state: { claims: [] } } };
  assert.deepEqual(originalCommandArguments(control, "/granted/project", "/private/request.json", "{}"),
    { args: ["control", "--governed", "--json", "--strict", "/private/request.json"], stdin: "" });
  assert.throws(() => originalCommandArguments(decide, "/granted/project"), /built decision request/);
});

test("arguments preserve the public owners and place the node id directly after its verb", () => {
  // tropo and ozone parse positionals once, right after the verb; a trailing
  // positional or a `--` terminator after options is rejected by both CLIs.
  for (const command of [{ verb: "create" }, { verb: "adopt" }, { verb: "pattern-state" }]) {
    const parsed = originalCommandSchema.parse({ projectId: "project-a", command });
    const invocation = originalCommandArguments(parsed.command, "/granted/project");
    assert.equal(invocation.args[0], command.verb === "pattern-state" ? "adopt" : command.verb);
    if (command.verb === "create") assert.ok(invocation.args.includes("--dry-run"));
    if (command.verb === "adopt") assert.ok(!invocation.args.includes("--yes"));
    assert.ok(!invocation.args.includes("--"), invocation.args.join(" "));
  }
  assert.deepEqual(originalCommandArguments({ verb: "impact", nodeId: "outline" }, "/granted/project").args.slice(0, 2),
    ["impact", "outline"]);
});

test("installed guidance choices use bounded stdin and the existing adoption owner", () => {
  const choices = [{ id: "capture" as const, name: "My intake", path: "notes/inbox.md" }];
  const preview = originalCommandSchema.parse({
    projectId: "project-a", command: { verb: "adopt", patternChoices: choices },
  });
  const invocation = originalCommandArguments(preview.command, "/granted/project");
  assert.deepEqual(invocation.args, ["adopt", "/granted/project", "--json",
    "--pattern-choices", "-"]);
  assert.deepEqual(JSON.parse(invocation.stdin), choices);
  const apply = adoptionExecutionSchema.parse({
    verb: "adopt-apply", planHash: "sha256:" + "a".repeat(64),
    requestId: "00000000-0000-4000-8000-000000000001", patternChoices: choices,
  });
  const approved = originalCommandArguments(apply, "/granted/project");
  assert.ok(approved.args.includes("--yes"));
  assert.deepEqual(JSON.parse(approved.stdin), choices);
  assert.equal(originalCommandSchema.safeParse({
    projectId: "project-a", command: { verb: "adopt",
      patternChoices: [{ id: "unknown", name: "Other", path: "other.md" }] },
  }).success, false);
  assert.deepEqual(originalCommandArguments({ verb: "pattern-state" }, "/granted/project"),
    { args: ["adopt", "/granted/project", "--json", "--pattern-state"], stdin: "" });
});

test("privacy preparation is an internal owner-approved verb with a strict reviewed JSON descriptor", () => {
  const privacyRequest = {
    schema: "vivary.adopt-privacy-request.v1",
    root_hash: "sha256:" + "a".repeat(64),
    before_hash: null,
    after_hash: "sha256:" + "b".repeat(64),
  };
  const command = adoptionExecutionSchema.parse({
    verb: "adopt-prepare-privacy", planHash: "sha256:" + "c".repeat(64),
    requestId: "c86a4ac8-2cd3-4bab-befb-a01aef34a27a", privacyRequest,
  });
  const invocation = originalCommandArguments(command, "/granted/project");
  assert.deepEqual(invocation.args, ["adopt", "/granted/project", "--json", "--yes", "--prepare-privacy",
    "--plan", command.planHash, "--request-id", command.requestId, "--privacy-request", "-"]);
  assert.equal(invocation.stdin, JSON.stringify(privacyRequest));
  assert.equal(originalCommandSchema.safeParse({ projectId: "project-a", command }).success, false);
  for (const invalid of [
    { ...privacyRequest, extra: "caller field" },
    { ...privacyRequest, root_hash: "not-a-digest" },
    { ...privacyRequest, before_hash: "not-a-digest" },
    { ...privacyRequest, after_hash: "not-a-digest" },
    { ...privacyRequest, schema: "other-schema" },
  ]) {
    assert.equal(adoptionExecutionSchema.safeParse({ ...command, privacyRequest: invalid }).success, false);
  }
  assert.equal(adoptionExecutionSchema.safeParse({ ...command, callerPath: "/outside" }).success, false);
});

test("child environment excludes credentials and Python injection while owning the receipt location", () => {
  const env = originalChildEnvironment({ PATH: "/bin", HOME: "/home/owner", PYTHONPATH: "/evil", PYTHONHOME: "/evil", OPENAI_API_KEY: "fixture-secret", VIVARY_RECEIPT_LOG: "/outside" }, "/app-data/original-runtime/receipts.jsonl");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/owner", PYTHONNOUSERSITE: "1", VIVARY_RECEIPT_LOG: "/app-data/original-runtime/receipts.jsonl" });
  assert.equal("VIVARY_RECEIPT_LOG" in originalChildEnvironment({ PATH: "/bin", VIVARY_RECEIPT_LOG: "/outside" }, undefined), false,
    "a child given no receipt path writes none");
});


test("child executable search excludes the project and relative PATH entries", () => {
  const project = path.resolve("fixture-project");
  const trusted = path.resolve("trusted-tools");
  const env = originalChildEnvironment({ PATH: [".", "relative-tools", project, path.join(project, "bin"), trusted].join(path.delimiter) }, "/private/receipts", project);
  assert.equal(env.PATH, trusted);
});

test("requires an authenticated actor before resolving a project", async () => {
  const f = await fixture();
  try { await assert.rejects(f.runner(input), /confirm access/); assert.equal(f.reads(), 0); }
  finally { await f.cleanup(); }
});

test("rechecks project policy before spawning and before returning its result", async () => {
  for (const when of ["before", "after"] as const) {
    const f = await fixture();
    try {
      if (when === "before") f.beforeResolve(() => { if (f.reads() === 2) f.revise(); });
      else f.afterExecute(f.revise);
      await assert.rejects(f.runner(input, context), /project changed/i);
      assert.equal(f.calls(), when === "before" ? 0 : 1);
    } finally { await f.cleanup(); }
  }
});

test("uses the exact bundle and private receipt path for an unchanged project", async () => {
  const f = await fixture();
  try {
    const result = await f.runner(input, context);
    assert.equal(result.stdout, "result");
    assert.equal(result.projectId, "project-a");
    assert.equal(f.reads(), 3);
  } finally { await f.cleanup(); }
});

test("a required receipt refuses a hard-linked receipt file before execution, and a read still runs", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.evaluate("project-a", { verb: "decide", evaluateAs: "me",
      input: { operation: "decide", capsule: { note: "é".repeat(40_000) } } }, context), /format or size/);
    const receiptDir = path.join(f.data, "original-runtime");
    const outside = path.join(f.directory, "outside.jsonl");
    await writeFile(outside, "preserve me");
    await link(outside, path.join(receiptDir, "receipts.jsonl"));
    assert.deepEqual(await f.evaluate("project-a", { verb: "decide", evaluateAs: "me",
      input: { operation: "decide", capsule: { task: { scope: ["."] } } } }, context),
    { project: { id: "project-a", label: "Project A" }, failure: ORIGINAL_RUN_FAILURES.receiptPath });
    assert.equal(f.calls(), 0);
    const writing = createOriginalCommandRunner({ parallelism: 4,
      environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
      resolveWorkspace: async () => projectWorkspace("project-a", f.root),
      execute: async (_python, _args, _stdin, _cwd, environment) => {
        await writeFile(environment.VIVARY_RECEIPT_LOG!, JSON.stringify({ command: "review" }) + "\n");
        return { exitCode: 0, stdout: "result", stderr: "", signal: null };
      } });
    assert.equal((await writing(input, context)).stdout, "result", "a read's report stands without its receipt");
    assert.equal(await readFile(outside, "utf8"), "preserve me");
  } finally { await f.cleanup(); }
});

test("bounded subprocess returns real output and stops on cancellation or excessive output", async () => {
  const env = originalChildEnvironment(process.env, path.join(tmpdir(), "unused-original-receipt.jsonl"));
  const result = await runOriginalProcess(process.execPath, ["-e", "process.stdout.write('ok')"], "", process.cwd(), env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(runOriginalProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", process.cwd(), env, controller.signal), /cancelled/); }
  finally { clearTimeout(timer); }
  await assert.rejects(runOriginalProcess(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(300000));setInterval(() => {}, 1000)"], "", process.cwd(), env), /output limit/);
});


test("cancellation stops a real descendant even when it ignores graceful termination", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-original-tree-"));
  const pidFile = path.join(directory, "descendant.pid");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const execution = runOriginalProcess(process.execPath, ["-e", parent], "", directory,
    originalChildEnvironment(process.env, path.join(directory, "receipt.jsonl")), controller.signal);
  const stopped = assert.rejects(execution, /cancelled/);
  let pid: number | undefined;
  const delay = () => new Promise(resolve => setTimeout(resolve, 50));
  const running = async () => {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    if (process.platform === "linux") {
      try { if ((await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ")) return false; }
      catch { return false; }
    }
    return true;
  };
  try {
    for (let attempt = 0; attempt < 40 && !pid; attempt++) {
      try { pid = Number(await readFile(pidFile, "utf8")); } catch { await delay(); }
    }
    assert.ok(pid && Number.isSafeInteger(pid));
    controller.abort();
    await stopped;
    for (let attempt = 0; attempt < 40 && await running(); attempt++) await delay();
    assert.equal(await running(), false, "The command descendant must not survive cancellation.");
  } finally {
    controller.abort();
    await stopped;
    if (pid && await running()) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("create and adopt apply requests are rejected before project resolution or execution", async () => {
  const digest = "sha256:" + "a".repeat(64);
  const f = await fixture();
  try {
    for (const command of [
      { verb: "create", apply: true },
      { verb: "create", apply: false },
      { verb: "adopt", approvedPlanHash: digest },
    ]) {
      const request = { projectId: "project-a", command };
      assert.equal(originalCommandSchema.safeParse(request).success, false);
      await assert.rejects(f.runner(request, context));
    }
    assert.equal(f.reads(), 0);
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test("output overflow returns a safe action error after the child stops", async () => {
  const f = await fixture(async () => {
    await runOriginalProcess(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(300000));setInterval(() => {}, 1000)"], "", process.cwd(), process.env);
  });
  try {
    await assert.rejects(f.runner(input, context), {
      message: "The original Vivary command exceeded its output limit.",
      statusCode: 413,
      errorCode: "vivary_original_output_limit",
    });
    assert.equal((await runOriginalProcess(process.execPath, ["-e", ""], "", process.cwd(), process.env)).exitCode, 0);
  } finally { await f.cleanup(); }
});

test("control uses a separate private request file and removes it after success or failure", async () => {
  for (const reject of [false, true]) {
    let requestPath = "";
    const request = JSON.stringify({ schema: "vivary.exo-control-request/v0", operation: "expire_leases", state: { claims: [] },
      input: { now: "2026-09-26T12:00:00.000Z" } });
    const f = await fixture(async (args, stdin) => {
      requestPath = args.at(-1)!;
      assert.ok(requestPath.startsWith(path.join(f.data, "original-runtime", "run-")));
      assert.equal(await readFile(requestPath, "utf8"), request);
      assert.equal(stdin, "");
      if (reject) throw new Error("fixture execution failure");
    });
    try {
      const run = f.evaluate("project-a", { verb: "control", evaluateAs: "me",
        input: { operation: "expire_leases", state: { claims: [] } } }, context);
      if (reject) await assert.rejects(run, /fixture execution failure/); else await run;
      await assert.rejects(readFile(requestPath), { code: "ENOENT" });
      assert.deepEqual(await readdir(path.join(f.data, "original-runtime")), ["receipts.jsonl"], "no request folder is left");
    } finally { await f.cleanup(); }
  }
});

test("app decisions append a compatible private receipt without request or output text", async () => {
  const f = await fixture();
  try {
    await f.evaluate("project-a", { verb: "decide", evaluateAs: "me", input: { operation: "decide",
      capsule: { task: { scope: ["."] }, privateNote: "private request content" } } }, context);
    const text = await readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8");
    const receipt = JSON.parse(text);
    assert.equal(receipt.schema, "vivary.run_receipt.v1");
    assert.equal(receipt.command, "decide");
    assert.equal(receipt.exit_code, 0);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.tool, "vivary-workbench");
    assert.equal(receipt.receipt_source, "app");
    assert.equal(text.includes("private request content"), false);
    assert.equal(text.includes("result"), false);
    assert.deepEqual(await readdir(path.join(f.directory, "project")), []);
  } finally { await f.cleanup(); }
});

test("reads in one project overlap and a write waits for them, then holds later reads back", async () => {
  const f = await scheduling();
  try {
    const first = f.read("project-a"), second = f.read("project-a");
    await first.queued(); await second.queued();
    assert.deepEqual(f.running(first, second), [true, true]);
    const write = f.apply("project-a");
    await write.queued();
    const later = f.read("project-a");
    await later.queued();
    assert.deepEqual(f.running(write, later), [false, false], "the write and the read behind it wait for the running reads");
    const other = f.read("project-b");
    await other.queued();
    assert.deepEqual(f.running(other), [true]);
    await f.finish(first);
    assert.deepEqual(f.running(write, later), [false, false]);
    await f.finish(second);
    assert.deepEqual(f.running(write, later), [true, false]);
    await f.finish(write);
    assert.deepEqual(f.running(later), [true]);
    await Promise.all([f.finish(later), f.finish(other)]);
  } finally { await f.cleanup(); }
});

test("a write in one project never waits for another project", async () => {
  const f = await scheduling();
  try {
    const read = f.read("project-a");
    await read.queued();
    const write = f.apply("project-b");
    await write.queued();
    assert.deepEqual(f.running(read, write), [true, true]);
    await Promise.all([f.finish(read), f.finish(write)]);
  } finally { await f.cleanup(); }
});

test("at a ceiling of one child, a second command waits for the first instead of failing", async () => {
  const f = await scheduling({ parallelism: 1 });
  try {
    const first = f.read("project-a");
    await first.queued();
    const second = f.read("project-b");
    await second.queued();
    assert.deepEqual(f.running(first, second), [true, false]);
    await f.finish(first);
    assert.deepEqual(f.running(second), [true]);
    await f.finish(second);
  } finally { await f.cleanup(); }
});

test("a write waiting at the ceiling starts first, and reads of other projects pass the project it holds", async () => {
  const f = await scheduling({ parallelism: 2 });
  try {
    const b = f.read("project-b"), c = f.read("project-c");
    await b.queued(); await c.queued();
    const write = f.apply("project-a");
    await write.queued();
    const behind = f.read("project-a");
    await behind.queued();
    const other = f.read("project-d");
    await other.queued();
    assert.deepEqual(f.running(b, c, write, behind, other), [true, true, false, false, false]);
    await f.finish(b);
    assert.deepEqual(f.running(write, behind, other), [true, false, false], "the write was first in line");
    await f.finish(c);
    assert.deepEqual(f.running(behind, other), [false, true]);
    await f.finish(write);
    assert.deepEqual(f.running(behind), [true]);
    await Promise.all([f.finish(behind), f.finish(other)]);
  } finally { await f.cleanup(); }
});

test("a cancelled or timed-out waiter leaves the queue without running", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await scheduling();
  try {
    const write = f.apply("project-a");
    await write.queued();
    const cancelled = f.read("project-a");
    await cancelled.queued();
    cancelled.abort();
    await assert.rejects(cancelled.result, /cancelled/);
    const expired = f.read("project-a");
    await expired.queued();
    t.mock.timers.tick(30_000);
    await assert.rejects(expired.result, { errorCode: "vivary_original_queue_timeout", statusCode: 503, message: /still running/ });
    await f.finish(write);
    assert.deepEqual(f.running(cancelled, expired), [false, false]);
    const next = f.read("project-a");
    await next.queued();
    assert.deepEqual(f.running(next), [true], "the project lock was released");
    await f.finish(next);
  } finally { await f.cleanup(); }
});

test("a missing bundle and a slow command fail with their own codes", async t => {
  const f = await fixture();
  try {
    const missing = createOriginalCommandRunner({ environment: () => ({ VIVARY_ORIGINAL_RUNTIME: path.join(f.directory, "absent"), VIVARY_DATA_DIR: f.data }),
      resolveWorkspace: async () => projectWorkspace("project-a", f.root), execute: runOriginalProcess, parallelism: 4 });
    await assert.rejects(missing(input, context), { errorCode: "vivary_original_runtime_unavailable", statusCode: 503 });
  } finally { await f.cleanup(); }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = runOriginalProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", process.cwd(),
    originalChildEnvironment(process.env, path.join(tmpdir(), "unused-original-receipt.jsonl")));
  t.mock.timers.tick(30_000);
  await assert.rejects(slow, { errorCode: "vivary_original_timeout", statusCode: 504, message: /30-second limit/ });
});

test("public doctor, find, and check append an app receipt without the question", async () => {
  const f = await fixture();
  try {
    const read = createProjectReadRunner({
      parallelism: 4,
      environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
      resolveWorkspace: async () => projectWorkspace("project-a", f.root),
      execute: async () => ({ exitCode: 1, stdout: "{}", stderr: "", signal: null }),
    });
    await read("project-a", { verb: "find", query: "private question text", k: 5, budget: 1200 }, context);
    await read("project-a", { verb: "check" }, context);
    await read("project-a", { verb: "doctor" }, context);
    const text = await readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8");
    const receipts = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(receipts.map(receipt => [receipt.command, receipt.exit_code, receipt.ok, receipt.receipt_source]),
      [["find", 1, false, "app"], ["check", 1, false, "app"], ["doctor", 1, false, "app"]]);
    assert.equal(text.includes("private question text"), false);
    assert.equal(text.includes(f.root), false);
  } finally { await f.cleanup(); }
});

test("an original command keeps -B for a project inside the bytecode cache folder, and that call does not sweep", async () => {
  const { directory, runtime, data } = await bundle("vivary-original-cache-");
  const root = path.join(await realpath(data), "python-cache", "a71d44e0", "project");
  await mkdir(root, { recursive: true });
  const flags: string[] = [];
  const read = createProjectReadRunner({
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
    resolveWorkspace: async () => projectWorkspace("project-a", root), parallelism: 4,
    execute: async (_python, args) => {
      flags.push(args[3]);
      return { exitCode: 0, stdout: "report", stderr: "", signal: null };
    },
  });
  try {
    const result = await read("project-a", { verb: "doctor" }, context);
    assert.equal("exitCode" in result && result.exitCode, 0);
    assert.deepEqual(flags, ["-B"]);
    assert.ok((await stat(root)).isDirectory(), "the refused call did not sweep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a project read names its project and keeps host paths out of band", async () => {
  const f = await fixture();
  const dependencies = {
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => projectWorkspace("project-a", f.root),
    parallelism: 4,
  };
  const project = { id: "project-a", label: "Project A" };
  try {
    const exited = await createProjectReadRunner({ ...dependencies,
      execute: async () => ({ exitCode: 0, stdout: "report", stderr: "", signal: null }) })("project-a", { verb: "doctor" }, context);
    assert.deepEqual(exited, { project, exitCode: 0, stdout: "report", stderr: "", hostPaths: { root: f.root, dataDir: f.data } });
    for (const failure of Object.values(ORIGINAL_RUN_FAILURES)) {
      assert.deepEqual(await createProjectReadRunner({ ...dependencies, execute: async () => {
        throw new ActionContractError("refused", { errorCode: failure, statusCode: 503 });
      } })("project-a", { verb: "check" }, context), { project, failure });
    }
    assert.deepEqual(await createProjectReadRunner({ ...dependencies, execute: runOriginalProcess,
      environment: () => ({ VIVARY_ORIGINAL_RUNTIME: path.join(f.directory, "absent"), VIVARY_DATA_DIR: f.data }) })(
      "project-a", { verb: "doctor" }, context), { project, failure: "vivary_original_runtime_unavailable" });
    const other = new ActionContractError("other", { errorCode: "vivary_original_project_changed", statusCode: 409 });
    await assert.rejects(createProjectReadRunner({ ...dependencies, execute: async () => { throw other; } })(
      "project-a", { verb: "check" }, context), error => error === other);
    const revoked = Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
    await assert.rejects(createProjectReadRunner({ ...dependencies, execute: runOriginalProcess,
      resolveWorkspace: async () => { throw revoked; } })("project-a", { verb: "doctor" }, context), error => error === revoked);
    await assert.rejects(createProjectReadRunner({ ...dependencies, execute: runOriginalProcess })(
      "project-a", { verb: "find", query: "--root /outside", k: 5, budget: 1200 }, context));
  } finally { await f.cleanup(); }
});

test("children write receipts to their own files and the app moves them into the shared log", async () => {
  const f = await fixture();
  const childLogs: string[] = [];
  const sharedLog = path.join(f.data, "original-runtime", "receipts.jsonl");
  const dependencies = {
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => projectWorkspace("project-a", f.root),
    parallelism: 4,
  };
  try {
    let started = 0;
    let release!: () => void;
    const together = new Promise<void>(resolve => { release = resolve; });
    const run = createOriginalCommandRunner({ ...dependencies, execute: async (_python, _args, _stdin, _cwd, environment) => {
      const childLog = environment.VIVARY_RECEIPT_LOG!;
      childLogs.push(childLog);
      if (++started === 2) release();
      await together;
      await writeFile(childLog, JSON.stringify({ command: "review", child: childLogs.indexOf(childLog) }) + "\n");
      return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
    } });
    await Promise.all([run(input, context), run(input, context)]);
    assert.notEqual(childLogs[0], childLogs[1]);
    const lines = (await readFile(sharedLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.child).sort(), [0, 1]);
    assert.deepEqual(await readdir(path.join(f.data, "original-runtime")), ["receipts.jsonl"]);

    const logsEnvironment: string[] = [];
    const logs = createProjectReadRunner({ ...dependencies, execute: async (_python, _args, _stdin, _cwd, environment) => {
      logsEnvironment.push(environment.VIVARY_RECEIPT_LOG!);
      return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
    } });
    await logs("project-a", { verb: "logs", failedOnly: false }, context);
    assert.deepEqual(logsEnvironment, [sharedLog]);
    assert.equal((await readFile(sharedLog, "utf8")).trim().split("\n").length, 2, "logs writes no receipt");
    await logs("project-a", { verb: "doctor" }, context);
    assert.deepEqual(logsEnvironment, [sharedLog, undefined], "only logs sees the shared log, and doctor gets none");
  } finally { await f.cleanup(); }
});

test("a write that finishes without its component receipt fails, and the app records it", async () => {
  const f = await fixture();
  const workspace = projectWorkspace("project-a", f.root);
  const apply = { verb: "adopt-apply" as const, planHash: "sha256:" + "a".repeat(64), requestId: randomUUID() };
  const runner = (writes: boolean) => createAdoptionCommandRunner({ parallelism: 4,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => workspace,
    execute: async (_python, _args, _stdin, _cwd, environment) => {
      if (writes) await writeFile(environment.VIVARY_RECEIPT_LOG!, JSON.stringify({ command: "adopt", ok: true }) + "\n");
      return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
    } });
  try {
    await assert.rejects(runner(false)(apply, workspace, context), { errorCode: "vivary_original_receipt_path" });
    await runner(true)(apply, workspace, context);
    const lines = (await readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => [line.command, line.ok, line.exit_code, line.error_type, line.receipt_source]),
      [["adopt-apply", false, 0, ORIGINAL_RUN_FAILURES.receiptPath, "app"], ["adopt", true, undefined, undefined, undefined]]);
  } finally { await f.cleanup(); }
});

test("the owner's commands refuse a Native tool call, and project reads accept one", async () => {
  const f = await fixture();
  const tool: ActionRunContext = { ...context, caller: "tool" };
  const workspace = projectWorkspace("project-a", f.root);
  const dependencies = { parallelism: 4, environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => workspace };
  try {
    await assert.rejects(f.runner(input, tool), { errorCode: "vivary_original_tool_caller", statusCode: 403 });
    await assert.rejects(f.evaluate("project-a", { verb: "control", evaluateAs: "me",
      input: { operation: "expire_leases", state: { claims: [] } } }, tool), { errorCode: "vivary_original_tool_caller", statusCode: 403 });
    await assert.rejects(createAdoptionCommandRunner({ ...dependencies, execute: runOriginalProcess })(
      { verb: "adopt-apply", planHash: "sha256:" + "a".repeat(64), requestId: randomUUID() }, workspace, tool),
    { errorCode: "vivary_original_tool_caller", statusCode: 403 });
    assert.equal(f.calls(), 0);
    const read = await createProjectReadRunner({ ...dependencies,
      execute: async () => ({ exitCode: 0, stdout: "{}", stderr: "", signal: null }) })("project-a", { verb: "doctor" }, tool);
    assert.ok("exitCode" in read && read.exitCode === 0);
    const evaluated = await f.evaluate("project-a", { verb: "control", evaluateAs: "agent",
      input: { operation: "expire_leases", state: { claims: [] } } }, tool);
    assert.ok("actor" in evaluated && evaluated.actor.kind === "agent" && f.calls() === 1);
  } finally { await f.cleanup(); }
});

test("a component command that ends without its receipt is recorded by the app", async () => {
  for (const exitCode of [2, 0]) {
    const f = await fixture();
    const run = createOriginalCommandRunner({ parallelism: 4,
      environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
      resolveWorkspace: async () => projectWorkspace("project-a", f.root),
      execute: async () => ({ exitCode, stdout: "", stderr: "", signal: null }) });
    try {
      assert.equal((await run(input, context)).exitCode, exitCode);
      const receipt = JSON.parse(await readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8"));
      assert.deepEqual([receipt.command, receipt.ok, receipt.exit_code, receipt.receipt_source],
        ["pattern-state", exitCode === 0, exitCode, "app"]);
    } finally { await f.cleanup(); }
  }
});

test("an appended component receipt leaves its private folder before the command returns", async () => {
  const f = await fixture();
  let childLog = "";
  let resolutions = 0;
  let presentAfterAppend: boolean | undefined;
  const run = createOriginalCommandRunner({ parallelism: 4,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => {
      // The third resolution is the recheck after the receipt was appended.
      if (++resolutions === 3) presentAfterAppend = await readFile(childLog).then(() => true, () => false);
      return projectWorkspace("project-a", f.root);
    },
    execute: async (_python, _args, _stdin, _cwd, environment) => {
      childLog = environment.VIVARY_RECEIPT_LOG!;
      await writeFile(childLog, JSON.stringify({ command: "review", ok: true }) + "\n");
      return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
    } });
  try {
    await run(input, context);
    assert.equal(presentAfterAppend, false, "the appended receipt was deleted before the command returned");
    assert.deepEqual(await readdir(path.join(f.data, "original-runtime")), ["receipts.jsonl"]);
  } finally { await f.cleanup(); }
});

test("the sweep keeps an old run folder whose receipt it cannot append", async () => {
  const f = await fixture();
  const receiptDir = path.join(f.data, "original-runtime");
  const old = path.join(receiptDir, "run-old");
  const outside = path.join(f.directory, "outside.jsonl");
  try {
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "receipts.jsonl"), JSON.stringify({ command: "adopt", ok: true }) + "\n");
    const eleven = new Date(Date.now() - 11 * 60_000);
    await utimes(old, eleven, eleven);
    await writeFile(outside, "");
    await link(outside, path.join(receiptDir, "receipts.jsonl"));
    await f.runner(input, context);
    assert.ok((await readdir(receiptDir)).includes("run-old"), "the unappended receipt waits for a later sweep");
    assert.equal(await readFile(outside, "utf8"), "");
  } finally { await f.cleanup(); }
});

test("the sweep appends a crashed run's receipt once and removes an old request folder", async () => {
  const f = await fixture();
  const receiptDir = path.join(f.data, "original-runtime");
  const appendedBefore = path.join(receiptDir, "run-appended");
  const request = path.join(receiptDir, "request-old");
  const line = JSON.stringify({ command: "adopt-apply", ok: true, timestamp: "2026-09-24T00:00:00Z" }) + "\n";
  try {
    await mkdir(appendedBefore, { recursive: true });
    await mkdir(request);
    await writeFile(path.join(appendedBefore, "receipts.jsonl"), line);
    await writeFile(path.join(request, "request.json"), "{}");
    await writeFile(path.join(receiptDir, "receipts.jsonl"), line);
    const eleven = new Date(Date.now() - 11 * 60_000);
    await utimes(appendedBefore, eleven, eleven);
    await utimes(request, eleven, eleven);
    await f.runner(input, context);
    assert.deepEqual(await readdir(receiptDir), ["receipts.jsonl"]);
    const lines = (await readFile(path.join(receiptDir, "receipts.jsonl"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map(entry => JSON.parse(entry).command), ["adopt-apply", "adopt"], "the appended receipt was not repeated");
  } finally { await f.cleanup(); }
});

test("a command cancelled before its child spawns records no receipt", async () => {
  const f = await fixture();
  const cancel = new AbortController();
  let resolutions = 0;
  const run = createOriginalCommandRunner({ parallelism: 4,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => {
      // The second resolution is the recheck after admission, just before the spawn.
      if (++resolutions === 2) cancel.abort();
      return projectWorkspace("project-a", f.root);
    },
    execute: runOriginalProcess });
  try {
    await assert.rejects(run(input, { ...context, signal: cancel.signal }), { name: "AbortError" });
    await assert.rejects(readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8"), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("a command stopped after it started is still recorded as failed", async () => {
  const f = await fixture();
  const run = createOriginalCommandRunner({ parallelism: 4,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: f.runtime, VIVARY_DATA_DIR: f.data }),
    resolveWorkspace: async () => projectWorkspace("project-a", f.root),
    execute: async () => { throw new ActionContractError("slow", { errorCode: ORIGINAL_RUN_FAILURES.timeout, statusCode: 504 }); } });
  try {
    await assert.rejects(run(input, context), { errorCode: ORIGINAL_RUN_FAILURES.timeout });
    const receipt = JSON.parse(await readFile(path.join(f.data, "original-runtime", "receipts.jsonl"), "utf8"));
    assert.deepEqual([receipt.command, receipt.ok, receipt.error_type, receipt.receipt_source],
      ["pattern-state", false, ORIGINAL_RUN_FAILURES.timeout, "app"]);
  } finally { await f.cleanup(); }
});

test("the first command in a data folder recovers and removes old run folders and keeps young ones", async () => {
  const f = await fixture();
  const receiptDir = path.join(f.data, "original-runtime");
  const old = path.join(receiptDir, "run-old");
  const young = path.join(receiptDir, "run-young");
  try {
    await mkdir(old, { recursive: true });
    await mkdir(young);
    await writeFile(path.join(old, "receipts.jsonl"), JSON.stringify({ command: "adopt-apply", ok: true }) + "\n");
    const eleven = new Date(Date.now() - 11 * 60_000);
    await utimes(old, eleven, eleven);
    await f.runner(input, context);
    const entries = await readdir(receiptDir);
    assert.ok(!entries.includes("run-old") && entries.includes("run-young"), entries.join(","));
    const lines = (await readFile(path.join(receiptDir, "receipts.jsonl"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map(line => JSON.parse(line).command), ["adopt-apply", "adopt"], "the crashed run's receipt was kept");
  } finally { await f.cleanup(); }
});

const project = { id: "project-a", label: "Project A" };
const agentId = projectAgentActorId("actor-owner", "project-a");
const expire = { operation: "expire_leases" as const, state: { claims: [] } };

test("a governed command takes no actor, clock, authority, or scope from its input", async () => {
  const f = await fixture();
  const tool: ActionRunContext = { ...context, caller: "tool" };
  try {
    await assert.rejects(f.evaluate("project-a", { verb: "control", evaluateAs: "me", input: expire }, tool),
      { errorCode: "vivary_original_tool_caller", statusCode: 403 });
    for (const forged of [
      { ...expire, now: "2020-01-01T00:00:00Z" }, { ...expire, actor: { kind: "human", id: "actor-owner" } },
      { operation: "decide", capsule: {}, requested_at: "2020-01-01T00:00:00Z" },
      { operation: "decide", capsule: {}, authority_class: "owner" },
      { operation: "claim", state: { claims: [] }, paths: ["src"], scope: { project: "other", paths: ["/"] } },
      { operation: "decide", capsule: {}, receipt: {} },
    ]) {
      await assert.rejects(f.evaluate("project-a", { verb: forged.operation === "decide" ? "decide" : "control",
        evaluateAs: "agent", input: forged } as unknown as GovernedCommand, context), JSON.stringify(forged));
    }
    await assert.rejects(f.evaluate("project-a", { verb: "decide", evaluateAs: "me", input: expire } as unknown as GovernedCommand, context));
    assert.equal(f.calls(), 0);
    assert.deepEqual(await readdir(path.join(f.data, "original-runtime")).catch(() => []), [], "no request file and no receipt");
  } finally { await f.cleanup(); }
});

test("a governed document binds the actor, project, contributor authority, and the server clock", async () => {
  const documents: Record<string, unknown>[] = [];
  const f = await fixture(async (args, stdin) => {
    documents.push(JSON.parse(args[6] === "control" ? await readFile(args.at(-1)!, "utf8") : stdin));
  });
  const tool: ActionRunContext = { ...context, caller: "tool" };
  try {
    await f.evaluate("project-a", { verb: "control", evaluateAs: "agent",
      input: { operation: "claim", state: { claims: [] }, paths: [".", "src/api"] } }, tool);
    await f.evaluate("project-a", { verb: "control", evaluateAs: "me",
      input: { operation: "release", state: { claims: [] }, claim_id: "claim-1" } }, context);
    const capsule = { task: { scope: ["./notes"] }, workspace: { fingerprint: "capsule-print", observed_at: "2026-09-26T11:59:00Z" } };
    await f.evaluate("project-a", { verb: "decide", evaluateAs: "agent", input: { operation: "decide", capsule } }, context);
    assert.deepEqual(documents[0], { schema: "vivary.exo-control-request/v0", operation: "claim", state: { claims: [] },
      input: { scope: { project: "project-a", paths: [f.root, path.join(f.root, "src", "api")] },
        actor: { kind: "agent", id: agentId }, now: "2026-09-26T12:00:00.000Z", authority_class: "contributor" } });
    assert.deepEqual(documents[1], { schema: "vivary.exo-control-request/v0", operation: "release", state: { claims: [] },
      input: { claim_id: "claim-1", actor: { kind: "human", id: "actor-owner" } } });
    const notes = path.join(f.root, "notes");
    assert.deepEqual(documents[2], { schema: "vivary.strato-decision-request/v0", policy_version: "vivary.strato-policy/v0",
      actor: { kind: "agent", id: agentId }, authority_class: "contributor", workspace: { fingerprint: "capsule-print" },
      scope: { project: "project-a", paths: [notes] }, requested_at: "2026-09-26T12:00:00.000Z",
      decision_at: "2026-09-26T12:00:00.000Z", capsule: { ...capsule, task: { scope: [notes] } } });
    assert.match(agentId, /^agent_[0-9a-f]{64}$/);
    assert.notEqual(projectAgentActorId("actor-owner", "project-b"), agentId, "an agent id never crosses projects");
  } finally { await f.cleanup(); }
});

test("the document is stamped after the project lock is held, so queue wait does not age it", async () => {
  let stamped = "";
  const f = await fixture(async args => {
    stamped = (JSON.parse(await readFile(args.at(-1)!, "utf8")) as { input: { now: string } }).input.now;
  });
  try {
    // The second resolution is the recheck after admission.
    f.beforeResolve(() => { if (f.reads() === 2) f.setClock(new Date("2026-09-26T12:05:00.000Z")); });
    await f.evaluate("project-a", { verb: "control", evaluateAs: "me", input: expire }, context);
    assert.equal(stamped, "2026-09-26T12:05:00.000Z");
  } finally { await f.cleanup(); }
});

test("governed evidence outside the project is a foreign path, and a foreign identity is a named refusal", async () => {
  const recipients: unknown[] = [];
  const f = await fixture(async args => {
    if (args[6] === "control") recipients.push((JSON.parse(await readFile(args.at(-1)!, "utf8")) as { input: { to_actor: unknown } }).input.to_actor);
  });
  const claim = (paths: string[]) => ({ scope: { project: "project-a", paths }, authority_class: "contributor" });
  const handoff = { operation: "handoff" as const, state: { claims: [] }, claim_id: "claim-1", receipt: {},
    capsule: { task: { scope: ["."] } }, workspace_revision: "revision" };
  try {
    for (const evaluateAs of ["agent", "me"] as const) {
      for (const input of [
        { ...expire, state: { claims: [claim([path.dirname(f.root)])] } },
        { ...expire, state: { claims: [claim(["relative"])] } },
        { ...expire, state: { claims: [{ ...claim(["."]), scope: { project: "other-project", paths: ["."] } }] } },
        { ...expire, state: { claims: [claim(["./../outside"])] } },
        { operation: "decide" as const, capsule: { task: { scope: [path.dirname(f.root)] } } },
      ]) {
        assert.deepEqual(await f.evaluate("project-a", { verb: input.operation === "decide" ? "decide" : "control",
          evaluateAs, input } as GovernedCommand, context), { project, refusal: "foreign_path" }, JSON.stringify(input));
      }
      assert.deepEqual(await f.evaluate("project-a", { verb: "control", evaluateAs,
        input: { ...expire, state: { claims: [{ ...claim(["."]), authority_class: "owner" }] } } }, context),
      { project, refusal: "identity" }, evaluateAs);
    }
    await assert.rejects(f.evaluate("project-a", { verb: "control", evaluateAs: "me",
      input: { ...handoff, to_actor: { kind: "human", id: "someone-else" } } } as unknown as GovernedCommand, context));
    assert.equal(f.calls(), 0);
    assert.deepEqual(await readdir(path.join(f.data, "original-runtime")).catch(() => []), [], "no request file and no receipt");
    for (const to_actor of ["me", "agent"] as const) {
      await f.evaluate("project-a", { verb: "control", evaluateAs: "me", input: { ...handoff, to_actor } }, context);
    }
    assert.deepEqual(recipients, [{ kind: "human", id: "actor-owner" }, { kind: "agent", id: agentId }],
      "the server resolves the owner's handoff recipient");
  } finally { await f.cleanup(); }
});

test("the owner's scope and capsule paths refuse an existing link to a foreign root", async () => {
  const f = await fixture();
  const foreign = path.join(f.directory, "foreign");
  const linked = path.join(f.root, "linked");
  try {
    await mkdir(foreign);
    await mkdir(path.join(foreign, "child"));
    await writeFile(path.join(foreign, "secret.txt"), "foreign marker");
    await symlink(path.join(foreign, "child"), linked, process.platform === "win32" ? "junction" : "dir");
    const escaped = path.join(linked, "secret.txt");
    const planned = path.join(linked, "planned", "child.txt");
    const inputs = [
      { operation: "claim" as const, state: { claims: [] }, paths: ["linked/secret.txt"] },
      { operation: "claim" as const, state: { claims: [] }, paths: ["linked/planned/child.txt"] },
      { ...expire, state: { claims: [{ scope: { project: "project-a", paths: [escaped] }, authority_class: "contributor" }] } },
      { operation: "decide" as const, capsule: { task: { scope: [planned] } } },
    ];
    const command = (evaluateAs: "me" | "agent", input: typeof inputs[number]) =>
      ({ verb: input.operation === "decide" ? "decide" : "control", evaluateAs, input }) as GovernedCommand;
    for (const input of [...inputs,
      { operation: "decide" as const, capsule: { task: { scope: [`${linked}${path.sep}..${path.sep}secret.txt`] } } }]) {
      assert.deepEqual(await f.evaluate("project-a", command("me", input), context), { project, refusal: "foreign_path" },
        JSON.stringify(input));
    }
    assert.equal(f.calls(), 0);
    // The agent's paths are checked lexically, so a link reads like any other name.
    for (const input of inputs) {
      const result = await f.evaluate("project-a", command("agent", input), context);
      assert.ok("exitCode" in result && result.exitCode === 0, JSON.stringify(input));
    }
    assert.equal(f.calls(), inputs.length);
  } finally { await f.cleanup(); }
});

test("governed plans allow a missing child below a verified project parent", async () => {
  const f = await fixture();
  try {
    const result = await f.evaluate("project-a", { verb: "control", evaluateAs: "agent",
      input: { operation: "claim", state: { claims: [] }, paths: ["planned/child.txt"] } }, context);
    assert.ok("exitCode" in result && result.exitCode === 0);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test("a governed evaluation returns its output as a value with no execution grant", async () => {
  const f = await fixture();
  try {
    const result = await f.evaluate("project-a", { verb: "decide", evaluateAs: "me",
      input: { operation: "decide", capsule: { task: { scope: ["."] } }, receipt: { id: "r" }, verdict: "pass" } }, context);
    assert.deepEqual(result, { project, exitCode: 0, stdout: "result", stderr: "", actor: { kind: "human", id: "actor-owner" },
      hostPaths: { root: f.root, dataDir: f.data } });
  } finally { await f.cleanup(); }
});
