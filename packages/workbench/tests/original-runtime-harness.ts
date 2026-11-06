// Shared fixtures for the original runner tests. Shutdown closes the
// process-wide command host for good, so each shutdown test lives in its own
// file, and node:test runs each file in its own process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActionRunContext } from "@agent-native/core/action";
import type { LocalProjectWorkspace } from "../server/project-services.mjs";
import { createAdoptionCommandRunner, createOriginalCommandRunner, createProjectEvaluateRunner } from "../server/original-runtime";
import { pycachePrefixFlag } from "../server/python-bytecode.ts";

export const context: ActionRunContext = { caller: "http", userEmail: "owner@example.test", orgId: "test-org" };

export async function bundle(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const runtime = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const relative = process.platform === "win32" ? "python/python.exe" : "python/bin/python3";
  const executable = path.join(runtime, relative);
  await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(data)]);
  await writeFile(executable, "fixture interpreter; execution is injected");
  await writeFile(path.join(runtime, "manifest.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, pythonVersion: "3.12.14", pythonExecutable: relative }));
  return { directory, runtime, data, executable };
}

/** The folder a fixture bundle's launches compile into, named by its manifest's digest. */
export async function cacheFolder(runtime: string, data: string) {
  const build = createHash("sha256").update(await readFile(path.join(runtime, "manifest.json"))).digest("hex").slice(0, 8);
  return path.join(await realpath(data), "python-cache", build);
}

export const projectWorkspace = (projectId: string, root: string): LocalProjectWorkspace => ({ root, actorId: "actor-owner", label: "Project A",
  projectId, rootId: "root-a", bindingId: "binding-a", bindingRevision: 1, policyRevision: 1, locationRef: "local:a", verificationKind: "local-stat-revalidated-v1" });

export async function fixture(inspect?: (args: string[], stdin: string) => Promise<void>) {
  const { directory, runtime, data, executable } = await bundle("vivary-original-");
  const cache = await cacheFolder(runtime, data);
  const root = path.join(directory, "project");
  await mkdir(root);
  let workspace = projectWorkspace("project-a", root);
  let reads = 0;
  let calls = 0;
  let beforeResolve = () => {};
  let afterExecute = () => {};
  let clock = new Date("2026-09-26T12:00:00.000Z");
  const dependencies = {
    parallelism: 4,
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
    resolveWorkspace: async () => { reads++; beforeResolve(); return workspace; },
    execute: async (python, args, stdin, cwd, environment) => {
      calls++;
      assert.equal(python, executable);
      assert.deepEqual(args.slice(0, 6), ["-I", "-X", "utf8", pycachePrefixFlag(cache), "-m", "vivary_cli"]);
      assert.ok((await stat(cache)).isDirectory(), "the build folder exists before the child starts");
      assert.equal(cwd, data);
      const childLog = environment.VIVARY_RECEIPT_LOG;
      // A component writes a private receipt. The app records decide and every project read, and logs reads the shared log.
      const source = args[6] === "logs" ? "shared"
        : ["decide", "doctor", "find", "check", "review", "impact"].includes(args[6]) ? "app" : "component";
      if (source === "component") {
        assert.ok(childLog && path.dirname(childLog).startsWith(path.join(data, "original-runtime", "run-")), childLog);
      } else {
        assert.equal(childLog, source === "shared" ? path.join(data, "original-runtime", "receipts.jsonl") : undefined);
      }
      await inspect?.(args, stdin);
      afterExecute();
      // A real component writes its receipt to the private path it was given.
      if (source === "component") await writeFile(childLog!, JSON.stringify({ command: args[6], ok: true }) + "\n");
      return { exitCode: 0, stdout: "result", stderr: "", signal: null };
    },
  };
  const runner = createOriginalCommandRunner(dependencies);
  const evaluate = createProjectEvaluateRunner({ ...dependencies, now: () => clock });
  return { directory, runtime, data, root, runner, evaluate, calls: () => calls, reads: () => reads,
    setClock: (next: Date) => { clock = next; },
    beforeResolve: (callback: () => void) => { beforeResolve = callback; },
    afterExecute: (callback: () => void) => { afterExecute = callback; },
    revise: () => { workspace = { ...workspace, policyRevision: workspace.policyRevision + 1 }; },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export type Execute = NonNullable<Parameters<typeof createOriginalCommandRunner>[0]>["execute"];
export type Submission = { result: Promise<unknown>; signal: AbortSignal; abort: () => void; queued: () => Promise<void> };
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Commands reach the scheduler in any order, so each test observes queue
// entry through the abort listener the scheduler registers on the caller's
// signal, and admission through the fake executor that receives that signal.
export async function scheduling(options: { execute?: Execute; parallelism?: number } = {}) {
  const { directory, runtime, data } = await bundle("vivary-original-queue-");
  const started: { projectId: string; verb: string; signal?: AbortSignal; finish: () => void }[] = [];
  const submitted: Submission[] = [];
  const resolutions = new Map<string, number>();
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  const fake: Execute = (_python, args, _stdin, _cwd, environment, signal) => new Promise(resolve => started.push({
    projectId: path.basename(args.find(value => path.dirname(value) === directory)!),
    verb: args[6] === "adopt" && args.includes("--yes") ? "adopt-apply" : args[6], signal,
    // A real component writes its receipt before it exits. A test may finish a command after cleanup.
    finish: () => void writeFile(environment.VIVARY_RECEIPT_LOG!, JSON.stringify({ command: args[6], ok: true }) + "\n")
      .catch(() => undefined).then(() => resolve({ exitCode: 0, stdout: "", stderr: "", signal: null })),
  }));
  const dependencies = {
    environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
    resolveWorkspace: async (_context: ActionRunContext | undefined, projectId: string) => {
      const count = (resolutions.get(projectId) ?? 0) + 1;
      resolutions.set(projectId, count);
      // A command resolves its project a second time right after the scheduler admits it.
      const hold = holds.get(projectId);
      if (count === 2 && hold) { hold.reached(); await hold.released; }
      return projectWorkspace(projectId, path.join(directory, projectId));
    },
    execute: options.execute ?? fake,
    parallelism: options.parallelism ?? 4,
  };
  const owner = createOriginalCommandRunner(dependencies);
  const write = createAdoptionCommandRunner(dependencies);
  const submit = (run: (signal: AbortSignal) => Promise<unknown>): Submission => {
    const controller = new AbortController();
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    let entered!: () => void;
    const queued = new Promise<void>(resolve => { entered = resolve; });
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type === "abort") entered();
      add(type, listener, options);
    }) as typeof signal.addEventListener;
    const result = run(signal);
    result.catch(() => undefined);
    const submission = { result, signal, abort: () => controller.abort(), queued: () => queued.then(flush) };
    submitted.push(submission);
    return submission;
  };
  return {
    directory, started,
    // A read-locked owner command, standing in for any read.
    read: (projectId: string) => submit(signal => owner({ projectId, command: { verb: "pattern-state" } }, { ...context, signal })),
    apply: (projectId: string) => submit(signal => write({ verb: "adopt-apply", planHash: "sha256:" + "a".repeat(64),
      requestId: "00000000-0000-4000-8000-000000000001" }, projectWorkspace(projectId, path.join(directory, projectId)), { ...context, signal })),
    finish: async (submission: Submission) => {
      const entry = started.find(candidate => candidate.signal === submission.signal);
      assert.ok(entry, "the command was admitted");
      entry.finish();
      await submission.result;
      await flush();
    },
    running: (...submissions: Submission[]) => submissions.map(submission =>
      started.some(entry => entry.signal === submission.signal)),
    // Holds the next command for a project after admission, before it reaches the executor.
    hold: (projectId: string) => {
      let reached!: () => void;
      let release!: () => void;
      const admitted = new Promise<void>(resolve => { reached = resolve; });
      holds.set(projectId, { reached, released: new Promise<void>(resolve => { release = resolve; }) });
      return { admitted, release };
    },
    // A failed assertion must not leave a project locked for the next test.
    cleanup: async () => {
      for (const submission of submitted) submission.abort();
      for (const entry of started) entry.finish();
      await Promise.allSettled(submitted.map(submission => submission.result));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
