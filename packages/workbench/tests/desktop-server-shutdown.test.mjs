import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
const nativeWindows = process.platform === "win32";
const lifecycle = new URL("../server/plugins/02-local-code-lifecycle.ts", import.meta.url).href;
const desktop = new URL("../bin/desktop-server.mjs", import.meta.url).href;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function forceWindowsTree(pid) {
  // guard:allow-env-credential - Native Windows fixture locates the OS tree-kill executable.
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

async function isRunning(pid) {
  if (!isAlive(pid)) return false;
  if (nativeWindows) return true;
  // An orphan can be a terminated zombie until the host's init process reaps it.
  const stat = await readFile("/proc/" + pid + "/stat", "utf8")
    .catch(error => { if (error.code === "ENOENT" || error.code === "ESRCH") return ""; throw error; });
  return stat !== "" && !/^\d+ \(.+\) Z /.test(stat);
}

async function until(check, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, description);
    await delay(10);
  }
}

if (role === "preview-service-server") {
  const root = process.argv[3];
  const url = process.argv[4];
  const { createProjectPreviewService, resolveLauncher } = await import("../server/project-preview.ts");
  // CI already installs pnpm globally. Scope the real resolver to that installation,
  // since the Node distribution's sibling Corepack shim would need a network fetch.
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const prefixResult = spawnSync(process.execPath, [npmCli, "prefix", "--global"], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(prefixResult.status, 0, prefixResult.error?.message || prefixResult.stderr);
  const globalPrefix = prefixResult.stdout.trim();
  assert.ok(path.isAbsolute(globalPrefix), "npm reports its existing global installation");
  const installedPnpm = path.join(globalPrefix, "node_modules", "pnpm");
  const manifest = JSON.parse(await readFile(path.join(installedPnpm, "package.json"), "utf8"));
  assert.equal(manifest.version, process.argv[5], "installed pnpm matches the existing CI pin");
  const entrypoint = await realpath(path.join(installedPnpm, "bin", "pnpm.cjs"));
  const service = createProjectPreviewService({
    mode: () => "local",
    resolveLauncher: (manager, root) => resolveLauncher(manager, root, [globalPrefix]),
    resolveWorkspace: async () => ({
      root, label: "preview-exit", projectId: "preview-exit", actorId: "actor",
      bindingId: "binding", bindingRevision: 1, policyRevision: 1, rootId: "root",
      locationRef: "location", verificationKind: "local-stat-revalidated-v1",
    }),
  });
  const owner = { userEmail: "owner@local.vivary.test", orgId: "local", caller: "frontend" };
  const review = await service.run({ operation: "review", projectId: "preview-exit", script: "dev", url }, owner);
  assert.equal(review.code, "review");
  assert.equal(review.launcher, [process.execPath, entrypoint].join(" "), "the real resolver selects installed pnpm, not Corepack");
  const started = await service.run({
    operation: "start", projectId: "preview-exit", script: "dev", url,
    requestId: "7fd84cba-a9cc-492f-8bfb-32db6d505ac7",
    acceptedManifestDigest: review.manifestDigest, reviewExpiresAt: review.reviewExpiresAt,
  }, owner);
  assert.equal(started.code, "ready", JSON.stringify(started));
  process.send({ type: "ready", rootPid: started.pid });
  process.on("message", async message => {
    if (message.type !== "stop-preview") return;
    const result = await service.run({ operation: "stop", projectId: "preview-exit", launchId: started.launchId }, owner);
    assert.equal(result.code, "stopped");
    process.send({ type: "stopped" });
  });
} else if (role === "parent-loss-owner") {
  const directory = process.argv[3];
  const scenario = process.argv[4];
  const environment = { ...process.env };
  delete environment.VIVARY_STANDALONE_HOST;
  environment.VIVARY_DESKTOP_HOST = "1";
  const server = fork(fileURLToPath(import.meta.url), [scenario, directory, "parent-loss"], {
    env: environment, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Survive the intermediary's Windows job closing so production observes IPC loss.
    detached: nativeWindows, windowsHide: true,
  });
  writeFileSync(path.join(directory, "server-pid"), String(server.pid));
  server.on("message", message => {
    if (message.type === "vivary:desktop:bootstrap-needed") {
      server.send({ type: "vivary:desktop:bootstrap", capability: "a".repeat(43) });
    }
    if (message.type === "ready") process.send({ type: "ready" });
  });
  process.on("message", message => {
    if (message.type === "shutdown-server") server.send({ type: "shutdown" });
  });
} else if (role === "reader-pipe-refusal" || role === "reader-graceful-eof") {
  const directory = process.argv[3];
  const bin = path.join(directory, "bin");
  const pidsFile = path.join(directory, "pipe-pids");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), "#!" + process.execPath + (role === "reader-graceful-eof" ? String.raw`
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ reader: process.pid }));
process.stdin.resume();
process.stdin.once("end", () => {
  writeFileSync(${JSON.stringify(path.join(directory, "eof-completed"))}, "EOF");
  process.stdout.write("drained output\n".repeat(16_384), () => process.exit(0));
});
` : String.raw`
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
if (!existsSync(${JSON.stringify(pidsFile)})) {
  // A different process group keeps the reader's actual output descriptors open.
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  helper.unref();
  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ reader: process.pid, helper: helper.pid }));
}
setInterval(() => {}, 1000);
`), { mode: 0o755 });
  // guard:allow-env-credential - Selects the harmless CLI owned by this disposable fork process.
  process.env.PATH = bin + path.delimiter + process.env.PATH; // guard:allow-env-mutation - Disposable fork selects its inert pipe fixture; setting ends with that process.
  const owner = await import("../server/codex-session-process.ts");
  const { checkWorkerCleanup, workerCleanupTarget, CLEANUP_TIMEOUT_MS } = await import("../server/code-execution-host.ts");
  let reader;
  let nextReader;
  let closing;
  let pids;
  let pipesClosed = false;
  try {
    reader = await owner.codexSessionLogLifecycle.open(directory);
    assert.ok(reader, "the real owner opens the inert reader");
    reader.child.once("close", () => { pipesClosed = true; });
    await until(() => readFile(pidsFile).then(() => true, () => false), "escaped output helper starts");
    pids = JSON.parse(await readFile(pidsFile, "utf8"));
    assert.equal(pids.reader, reader.child.pid);
    const started = performance.now();
    closing = reader.close();
    if (role === "reader-graceful-eof") {
      assert.equal(await closing, true, "EOF shutdown confirms the normal reader closed");
      assert.equal(await readFile(path.join(directory, "eof-completed"), "utf8"), "EOF");
      assert.equal(reader.child.exitCode, 0, "the reader completed its own teardown");
      assert.equal(reader.child.signalCode, null, "the normal reader was not force-killed");
      await owner.shutdownCodexSessionReaders();
    } else {
      assert.equal(await closing, false, "open inherited pipes prevent confirmed close");
      assert.ok(performance.now() - started < CLEANUP_TIMEOUT_MS + 2000, "close has a bounded wait");
      assert.equal(pipesClosed, false, "the escaped helper still holds the output descriptors");
      assert.ok(await isRunning(pids.helper), "the harmless helper remains alive for the assertions");
      const target = await workerCleanupTarget(reader.child.pid, 0, 0, Date.now());
      assert.ok(target);
      assert.equal((await checkWorkerCleanup(target)).result, "clean", "the original Linux group is actually clean");
      nextReader = await owner.codexSessionLogLifecycle.open(directory);
      assert.equal(nextReader, null, "clean group alone must not clear a pipe-closure refusal");
      await assert.rejects(owner.shutdownCodexSessionReaders(), /could not be stopped completely/,
        "shutdown must preserve the still-open pipe refusal");
    }
  } finally {
    pids ??= await readFile(pidsFile, "utf8").then(JSON.parse, () => null);
    if (pids?.helper) {
      try { process.kill(-pids.helper, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until(async () => !await isRunning(pids.helper), "escaped fixture helper ends");
    }
    if (reader) { await reader.close(); await until(() => pipesClosed, "fixture output descriptors close after helper cleanup"); }
    if (nextReader) await nextReader.close();
    await closing;
  }
} else if (role?.startsWith("reader-observation-")) {
  // Real reader/stop owners and subprocesses; only external Windows executable output is simulated.
  const directory = process.argv[3];
  const receipt = name => path.join(directory, name);
  const scanner = path.join(directory, "System32", "WindowsPowerShell", "v1.0");
  const bin = path.join(directory, "bin");
  await Promise.all([mkdir(scanner, { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(bin, "codex.exe"), "#!" + process.execPath + "\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  await writeFile(path.join(scanner, "scanner.mjs"), String.raw`
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const first = !existsSync(${JSON.stringify(receipt("first-scan"))});
if (first) writeFileSync(${JSON.stringify(receipt("first-scan"))}, "");
process.once("SIGTERM", () => process.exit(0));
if (first) while (!existsSync(${JSON.stringify(receipt("release-scan"))}) || ${JSON.stringify(role)} === "reader-observation-timeout") await delay(10);
if (first && ${JSON.stringify(role)} === "reader-observation-unavailable") { process.stdout.write("incomplete scan"); process.exit(0); }
const command = process.argv.at(-1);
if (command.includes("Stop-Process") && /reader-observation-(early|first)/.test(${JSON.stringify(role)})) {
  const targets = command.match(/foreach \(\$target in '([^']+)'\.Split/)[1].split(";");
  writeFileSync(${JSON.stringify(receipt("ended-targets"))}, JSON.stringify(targets));
  writeFileSync(${JSON.stringify(receipt("helper-ended"))}, "");
  for (const target of targets) process.stdout.write(target.split(":")[0] + "\tended\n");
  process.stdout.write("END\t" + targets.length + "\n");
  process.exit(0);
}
const { pid, at } = JSON.parse(readFileSync(${JSON.stringify(receipt("reader-identity"))}, "utf8"));
const stopped = existsSync(${JSON.stringify(receipt("stopped"))}) || existsSync(${JSON.stringify(receipt("root-exited"))});
const ended = existsSync(${JSON.stringify(receipt("helper-ended"))});
const rows = ended ? [] : stopped ? [[41002, ${JSON.stringify(role)} === "reader-observation-early-reused" || ${JSON.stringify(role)}.startsWith("reader-observation-first") ? 77 : 41001,
    at + (${JSON.stringify(role)} === "reader-observation-early-reused" ? 20 : 2), "orphan.exe"]]
  : [[pid, 1, at, "reader.exe"], [41001, pid, at + 1, "intermediate.exe"],
    ...(${JSON.stringify(role)} === "reader-observation-early-untraced" ? [] : [[41002, 41001, at + 2, "orphan.exe"]])];
// A whole Windows snapshot still contains unrelated processes after the owned tree ends.
rows.push([4, 0, at - 60_000, "System"]);
if (stopped && ${JSON.stringify(role)} === "reader-observation-first-reused-root") {
  rows.push([pid, 1, at + 1_000, "reused-reader.exe"]);
}
for (const [id, parent, created, name] of rows) {
  process.stdout.write([id, parent, String(BigInt(created) * 10000n + 116444736000000000n), name].join("\t") + "\n");
}
process.stdout.write("END\t" + rows.length + "\n");
if (first) writeFileSync(${JSON.stringify(receipt("first-observed"))}, "");
`);
  await writeFile(path.join(scanner, "powershell.exe"),
    "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(path.join(scanner, "scanner.mjs")) + ' "$@"\n', { mode: 0o755 });
  await writeFile(path.join(directory, "System32", "taskkill.exe"),
    "#!/bin/sh\nprintf stopped > " + JSON.stringify(receipt("stopped")) + '\nkill -9 "$2"\n', { mode: 0o755 });
  // guard:allow-env-credential - Selects only disposable Windows scanner/stop executables.
  process.env.SystemRoot = directory;
  // guard:allow-env-credential - Selects the inert disposable CLI before host installations.
  process.env.PATH = bin + path.delimiter + process.env.PATH; // guard:allow-env-mutation - Disposable fork process selects its inert Windows CLI; setting ends with that process.
  const owner = await import("../server/codex-session-process.ts");
  const { CLEANUP_TIMEOUT_MS } = await import("../server/code-execution-host.ts");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let reader;
  let recoveredReader;
  let closing;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    // The simulated root creation time must match the owner's actual launch window,
    // not a later timestamp after open() has also started its PowerShell observer.
    const at = Date.now();
    const launchClock = mock.method(Date, "now", () => at);
    try { reader = await owner.codexSessionLogLifecycle.open(directory); }
    finally { launchClock.mock.restore(); } // Cleanup/scan deadlines keep using real time.
    assert.ok(reader, "real reader owner launches the inert app-server");
    await writeFile(receipt("reader-identity"), JSON.stringify({ pid: reader.child.pid, at }));
    await until(() => readFile(receipt("first-scan")).then(() => true, () => false), "first scan starts");
    const started = performance.now();
    if (role.startsWith("reader-observation-first")) {
      const exited = new Promise(resolve => reader.child.once("exit", resolve));
      process.kill(reader.child.pid, "SIGTERM");
      await exited;
      await writeFile(receipt("root-exited"), "");
      closing = reader.close();
      await writeFile(receipt("release-scan"), "");
      await until(() => readFile(receipt("first-observed")).then(() => true, () => false), "rootless first snapshot completes");
      assert.equal(await closing, false, "a complete scan without the original root cannot confirm cleanup");
      assert.equal(await readFile(receipt("ended-targets")).then(() => true, () => false), false,
        "disconnected or reused identities must not be ended");
      assert.equal(await readFile(receipt("stopped")).then(() => true, () => false), false, "the exited root is not killed again");
      assert.equal(await owner.codexSessionLogLifecycle.open(directory), null, "unestablished ancestry keeps admission closed");
      await assert.rejects(owner.shutdownCodexSessionReaders(), /could not be stopped completely/);
    } else if (role.startsWith("reader-observation-early")) {
      await writeFile(receipt("release-scan"), "");
      await until(() => readFile(receipt("first-observed")).then(() => true, () => false), "live ancestry observation completes");
      const exited = new Promise(resolve => reader.child.once("exit", resolve));
      process.kill(reader.child.pid, "SIGTERM");
      await exited;
      await writeFile(receipt("root-exited"), "");
      const recoverable = role !== "reader-observation-early-untraced";
      assert.equal(await reader.close(), recoverable, "only verified recoverable leftovers permit success");
      if (role === "reader-observation-early-exit") {
        const targets = JSON.parse(await readFile(receipt("ended-targets"), "utf8"));
        assert.equal(targets.length, 1);
        const { at } = JSON.parse(await readFile(receipt("reader-identity"), "utf8"));
        assert.equal(targets[0], "41002:" + (BigInt(at + 2) * 10000n + 116444736000000000n),
          "the end primitive receives the traced helper's original creation identity");
      } else {
        assert.equal(await readFile(receipt("ended-targets")).then(() => true, () => false), false,
          "untraced or reused PID identities are never sent to the end primitive");
      }
      assert.equal(await readFile(receipt("stopped")).then(() => true, () => false), false, "an exited root is not passed to taskkill");
      if (recoverable) {
        // A second real reader needs its own live root snapshot, not the first reader's ended identities.
        for (const name of ["root-exited", "helper-ended", "first-scan", "first-observed", "release-scan"]) {
          await rm(receipt(name), { force: true });
        }
        const recoveredAt = Date.now();
        const recoveredClock = mock.method(Date, "now", () => recoveredAt);
        try { recoveredReader = await owner.codexSessionLogLifecycle.open(directory); }
        finally { recoveredClock.mock.restore(); }
        assert.ok(recoveredReader, "verified cleanup permits a later reader");
        await writeFile(receipt("reader-identity"), JSON.stringify({ pid: recoveredReader.child.pid, at: recoveredAt }));
        await until(() => readFile(receipt("first-scan")).then(() => true, () => false), "recovered reader scan starts");
        await writeFile(receipt("release-scan"), "");
        await until(() => readFile(receipt("first-observed")).then(() => true, () => false), "recovered reader root is observed");
        assert.equal(await recoveredReader.close(), true);
        await owner.shutdownCodexSessionReaders();
      } else {
        recoveredReader = await owner.codexSessionLogLifecycle.open(directory);
        assert.equal(recoveredReader, null, "an untraced leftover keeps admission closed");
        await assert.rejects(owner.shutdownCodexSessionReaders(), /could not be stopped completely/);
      }
    } else {
      closing = reader.close();
      await delay(100);
      assert.equal(await readFile(receipt("stopped")).then(() => true, () => false), false,
        "reader termination must wait for the bounded in-flight ancestry observation");
      await writeFile(receipt("release-scan"), "");
      assert.equal(await closing, false, "escaped ancestry or uncertain observation cannot report clean");
      assert.ok(performance.now() - started < CLEANUP_TIMEOUT_MS + 1000, "the entire close is bounded");
      assert.equal(await owner.codexSessionLogLifecycle.open(directory), null,
        "a later root-only scan cannot clear escaped or unobserved ancestry");
      await assert.rejects(owner.shutdownCodexSessionReaders(), /could not be stopped completely/);
    }
  } finally {
    await writeFile(receipt("release-scan"), "");
    await closing;
    if (recoveredReader) await recoveredReader.close();
    if (reader?.child.pid) { try { process.kill(reader.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    Object.defineProperty(process, "platform", platform);
  }
} else if (role) {
  const directory = process.argv[3];
  const receipt = name => path.join(directory, name);
  const exists = name => readFile(receipt(name)).then(() => true, () => false);
  const windows = role.startsWith("windows-");
  const parentLoss = process.argv[4] === "parent-loss";
  process.once("exit", code => writeFileSync(receipt("exit-code"), String(code)));
  globalThis.__shutdownTestTaskkill = (command, args, options) => {
    writeFileSync(receipt("taskkill"), JSON.stringify({ command, args, timeout: options?.timeout }));
    return { status: 0, signal: null };
  };
  if (nativeWindows && ["windows-pending", "windows-preview-failure", "windows-close-failure", "windows-root-only-kill"].includes(role)) {
    // The descendant has no IPC or pipe that could keep its server parent alive.
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      // Tree cleanup must not pass merely because the server's Windows job closes.
      stdio: "ignore", detached: true, windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      descendant.once("spawn", resolve);
      descendant.once("error", reject);
    });
    descendant.unref();
    await writeFile(receipt("descendant-pid"), String(descendant.pid));
  }
  // Success cases retain this handle to require an explicit production exit.
  const keepAlive = setInterval(() => {}, 1000);
  const hooks = new Map();
  const nitro = { hooks: {
    hook: (name, handler) => hooks.set(name, handler),
    callHook: async name => {
      await writeFile(receipt("close-started"), "");
      await hooks.get(name)?.();
      if (role === "windows-close-failure") throw new Error("expected Nitro close failure");
    },
  } };
  let automationStop;
  globalThis.__shutdownTestStops = {
    automations: () => automationStop ??= (async () => {
      await writeFile(receipt("started"), "");
      if (windows) {
        // No fixture timer or polling may hide a missing production hold.
        if (role !== "windows-success" || parentLoss) clearInterval(keepAlive);
        if (role === "windows-pending") await new Promise(() => {});
      } else {
        await until(() => exists("release"), "parent releases held cleanup");
      }
      await writeFile(receipt("settled"), "");
    })(),
    reader: () => role === "reader-cleanup-failure" ? Promise.reject(new Error("unconfirmed reader cleanup")) : Promise.resolve(),
    code: () => role === "failure" ? Promise.reject(new Error("expected cleanup failure")) : Promise.resolve(),
    previews: () => {
      if (["windows-preview-failure", "windows-standalone-failure"].includes(role)) {
        writeFileSync(receipt("preview-rejected"), "");
        return Promise.reject(new Error("expected preview cleanup failure"));
      }
      return Promise.resolve();
    },
  };
  const replacements = {
    "@agent-native/core/server": "export const defineNitroPlugin = value => value;",
    "@agent-native/core/jobs": "export const stopRecurringJobs = () => globalThis.__shutdownTestStops.automations();",
    "../local-code-agent.ts": "export const initializeVivaryCodeAgent = async () => {}; export const shutdownVivaryCodeAgent = () => globalThis.__shutdownTestStops.code();",
    "../codex-session-process.ts": role.startsWith("codex-reader") ? undefined
      : "export const shutdownCodexSessionReaders = () => globalThis.__shutdownTestStops.reader();",
    "../original-runtime.ts": "export const shutdownOriginalCommands = async () => {};",
    "../project-preview.ts": "export const shutdownProjectPreviews = () => globalThis.__shutdownTestStops.previews();",
  };
  registerHooks({ resolve(specifier, context, nextResolve) {
    const replacement = !nativeWindows && context.parentURL === desktop && specifier === "node:child_process"
      ? "export * from 'node:child_process'; export const spawnSync = (...args) => globalThis.__shutdownTestTaskkill(...args);"
      : context.parentURL === lifecycle ? replacements[specifier]
      : context.parentURL === desktop && specifier === "./start.mjs"
        ? "export const startupOptions = () => ({mode: 'local', appUrl: 'http://127.0.0.1:4317'}); export const startVivary = () => globalThis.__shutdownTestBoot();"
        : undefined;
    return replacement === undefined ? nextResolve(specifier, context)
      : { url: "data:text/javascript," + encodeURIComponent(replacement), shortCircuit: true };
  } });
  if (role.startsWith("codex-reader")) {
    const project = path.join(directory, "project");
    const provider = path.join(directory, "provider");
    const bin = path.join(directory, "bin");
    await Promise.all([mkdir(project), mkdir(provider), mkdir(bin)]);
    // guard:allow-env-credential - Synthetic CLI/runtime data only; no host credentials are copied.
    process.env.CODEX_HOME = provider; // guard:allow-env-mutation - Disposable fork process uses its synthetic provider store; setting ends with that process.
    process.env.AGENT_NATIVE_CODE_AGENTS_HOME = path.join(directory, "native"); // guard:allow-env-mutation - Disposable fork process isolates Native run data; setting ends with that process.
    // guard:allow-env-credential - Resolve only this disposable external app-server fixture first.
    process.env.PATH = bin + path.delimiter + process.env.PATH; // guard:allow-env-mutation - Disposable fork process selects only its inert app-server fixture first; setting ends with that process.
    // guard:allow-env-credential - The disposable reader uses the existing local launcher.
    process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-mutation - Disposable fork process selects the existing local launcher; setting ends with that process.
    const threadId = "shutdown-fixture-thread";
    await writeFile(path.join(bin, "codex"), String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(receipt("reader-pids"))}, JSON.stringify([process.pid, helper.pid]));
appendFileSync(${JSON.stringify(receipt("reader-spawns"))}, "spawn\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
  if (request.method === "thread/read" && ${JSON.stringify(role)} === "codex-reader-turn") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { thread: {
      id: ${JSON.stringify(threadId)}, cwd: ${JSON.stringify(project)}, modelProvider: "openai", turns: [],
      path: ${JSON.stringify(path.join(provider, "stored.jsonl"))} } } }) + "\n");
  } else if (request.method === "thread/read" || request.method === "thread/turns/list") {
    writeFileSync(${JSON.stringify(receipt("reader-held"))}, "");
  }
});
`, { mode: 0o755 });
    const { createCodeAgentRunRecord, readCodexCodeSessionLog } = await import("@agent-native/core/code-agents");
    const actionReader = await import(new URL("../server/codex-session-process.ts?source-action-reader", import.meta.url));
    const run = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Held reader", cwd: project,
      status: "paused", metadata: { engine: "codex-cli", codexSessionId: threadId, workspaceRoot: project,
        app: "vivary-workbench-local-code", ownerEmail: "owner@example.test", orgId: "fixture-org" } });
    void readCodexCodeSessionLog(run, actionReader.codexSessionLogLifecycle).then(result =>
      writeFile(receipt("reader-settled"), result.status));
    await until(() => exists("reader-held"), "real public reader reaches held RPC", 5000);
    // This public inspection waits behind the held reader; shutdown must deny its later open.
    void readCodexCodeSessionLog(run, actionReader.codexSessionLogLifecycle);
  }
  const plugin = (await import(lifecycle)).default;
  globalThis.__shutdownTestBoot = async () => {
    // Load with the real platform first, then select Windows or POSIX only for initialization.
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { ...platform, value: windows ? "win32" : "linux" });
      await plugin(nitro);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  };
  if (role === "hosted" || role === "windows-standalone-failure") {
    await globalThis.__shutdownTestBoot();
    process.on("message", async message => {
      if (message.type === "signal") {
        process.emit("SIGTERM");
        if (role === "windows-standalone-failure") process.disconnect();
      }
      if (message.type === "owner-finish") {
        await nitro.hooks.callHook("close");
        clearInterval(keepAlive);
        process.disconnect();
      }
    });
    process.send({ type: "ready" });
  } else {
    globalThis.fetch = async () => new Response("ready");
    const { runDesktopServer } = await import(desktop);
    // Both modules are preloaded before simulating the launcher's platform decision.
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { ...platform, value: windows ? "win32" : "linux" });
      await runDesktopServer([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }
} else {
  for (const ending of ["server death", "Stop", "command exit"]) {
  test("Windows preview chain cleanup after " + ending, { skip: !nativeWindows, timeout: 50000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-preview-server-exit-"));
    const receipt = path.join(directory, "preview-pids.json");
    const portServer = createServer();
    await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    const workflow = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const pnpmVersions = [...workflow.matchAll(/npm install --global pnpm@([\d.]+)/g)].map(match => match[1]);
    assert.equal(new Set(pnpmVersions).size, 1, "the fixture derives the existing CI pnpm pin");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "vivary-preview-server-exit", private: true, packageManager: "pnpm@" + pnpmVersions[0],
      scripts: { dev: "node preview.mjs" },
    }));
    await writeFile(path.join(directory, "descendant.mjs"), "setInterval(() => {}, 1000);\n");
    await writeFile(path.join(directory, "preview.mjs"), [
      "import { createServer } from 'node:http';",
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "setInterval(() => { if (existsSync('exit-preview')) process.exit(0); }, 50).unref();",
      "const child = spawn(process.execPath, ['descendant.mjs'], { stdio: 'ignore', detached: false, windowsHide: true });",
      "child.once('spawn', () => {",
      "  writeFileSync('preview-pids.json', JSON.stringify({ preview: process.pid, shell: process.ppid, descendant: child.pid }));",
      "  createServer((_req, res) => res.end('ready')).listen(Number(process.env.PORT), process.env.HOST);",
      "});",
    ].join("\n"));
    const server = fork(fileURLToPath(import.meta.url), ["preview-service-server", directory, "http://127.0.0.1:" + port + "/", pnpmVersions[0]], {
      execArgv: ["--import", "tsx"], detached: true, windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    let ready;
    let stopped = false;
    let exited = false;
    server.stderr.on("data", chunk => { stderr += chunk; });
    server.once("exit", () => { exited = true; });
    server.on("message", message => {
      if (message.type === "ready") ready = message;
      if (message.type === "stopped") stopped = true;
    });
    let owned;
    let managerPid;
    try {
      await until(() => ready || exited, "preview service starts the real package command: " + stderr, 15000);
      assert.equal(exited, false, stderr);
      owned = JSON.parse(await readFile(receipt, "utf8"));
      // Query only ancestry fields. A cold CI CIM provider may need more than five seconds.
      const ancestry = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name FROM Win32_Process' | ConvertTo-Json -Compress",
      ], { encoding: "utf8", timeout: 15000, windowsHide: true });
      assert.equal(ancestry.status, 0, ancestry.error?.message || ancestry.stderr);
      const rows = new Map(JSON.parse(ancestry.stdout).map(row => [row.ProcessId, row]));
      managerPid = rows.get(owned.shell)?.ParentProcessId;
      const ids = [server.pid, managerPid, owned.shell, owned.preview, owned.descendant];
      // Preserve the original five-process red case while verifying the contained owner's extra edge.
      if (ready.rootPid !== managerPid) {
        ids.splice(1, 0, ready.rootPid);
        assert.equal(rows.get(ready.rootPid)?.ParentProcessId, server.pid, "server owns the preview containment process");
      }
      assert.equal(new Set(ids).size, ids.length, "every process owner is distinct");
      assert.ok(ids.every(pid => Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)));
      assert.equal(rows.get(managerPid)?.ParentProcessId, ready.rootPid === managerPid ? server.pid : ready.rootPid,
        "the live preview owner owns the real pnpm process");
      assert.equal(rows.get(owned.shell)?.Name.toLowerCase(), "cmd.exe");
      assert.equal(rows.get(owned.preview)?.ParentProcessId, owned.shell, "cmd owns the actual preview");
      assert.equal(rows.get(owned.descendant)?.ParentProcessId, owned.preview, "preview owns its ordinary attached child");
      if (ending === "server death") {
        assert.ok(server.kill("SIGKILL"), "terminate only the preview service server, without /T");
        await until(() => exited, "server-only termination completes");
      } else if (ending === "Stop") {
        server.send({ type: "stop-preview" });
        await until(() => stopped || exited, "Stop confirms owned job cleanup", 6000);
        assert.equal(exited, false, stderr);
        assert.equal(stopped, true);
      } else {
        await writeFile(path.join(directory, "exit-preview"), "");
      }
      const expectedGone = ending === "server death" ? ids : ids.filter(pid => pid !== server.pid);
      const deadline = Date.now() + 5000;
      while (expectedGone.some(isAlive) && Date.now() < deadline) await delay(25);
      const surviving = expectedGone.filter(isAlive);
      t.diagnostic(JSON.stringify({ ending, server: server.pid, root: ready.rootPid, manager: managerPid, ...owned, surviving }));
      // This assertion must happen before the finally block manually removes survivors.
      assert.deepEqual(surviving, [], ending + " must clean the actual pnpm/cmd/preview/ordinary-child chain");
      if (ending !== "server death") assert.ok(isAlive(server.pid), "the service remains alive after preview cleanup");
      if (ending === "command exit") {
        server.send({ type: "stop-preview" });
        await until(() => stopped || exited, "natural exit retires the owned preview without killing a departed PID");
        assert.equal(exited, false, stderr);
        assert.equal(stopped, true);
      }
    } finally {
      if (isAlive(server.pid)) forceWindowsTree(server.pid);
      if (!owned) owned = await readFile(receipt, "utf8").then(JSON.parse, () => undefined);
      for (const pid of [ready?.rootPid, managerPid, owned?.shell, owned?.preview, owned?.descendant]) {
        if (pid && isAlive(pid)) forceWindowsTree(pid);
      }
      await until(() => ![server.pid, ready?.rootPid, managerPid, owned?.shell, owned?.preview, owned?.descendant]
        .some(pid => pid && isAlive(pid)), "fixture processes are gone after manual cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  });
  }

  for (const scenario of ["reader-pipe-refusal", "reader-graceful-eof"]) test(
    scenario === "reader-pipe-refusal" ? "reader cleanup rechecks retain escaped-helper pipe closure" : "reader completes graceful EOF shutdown without force kill",
    { timeout: 45000, skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-reader-pipes-"));
    const child = fork(fileURLToPath(import.meta.url), [scenario, directory], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    let result;
    const exited = new Promise(resolve => child.once("exit", (code, signal) => { result = { code, signal }; resolve(result); }));
    try {
      await until(() => result, "reader pipe fixture finishes: " + stderr, 35000);
      assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    } finally {
      if (!result) { child.kill("SIGKILL"); await exited; }
      const pids = await readFile(path.join(directory, "pipe-pids"), "utf8").then(JSON.parse, () => null);
      if (pids?.helper && await isRunning(pids.helper)) {
        try { process.kill(-pids.helper, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await until(async () => !await isRunning(pids.helper), "recorded escaped fixture group ends");
      }
      if (pids?.reader && await isRunning(pids.reader)) process.kill(pids.reader, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const scenario of ["ancestry", "unavailable", "timeout", "early-exit", "early-reused", "early-untraced", "first-rootless", "first-reused-root"]) {
    test("reader pre-stop Windows observation: " + scenario, { timeout: 25000, skip: process.platform !== "linux" }, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-reader-observation-"));
      const child = fork(fileURLToPath(import.meta.url), ["reader-observation-" + scenario, directory], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      let result;
      const exited = new Promise(resolve => child.once("exit", (code, signal) => { result = { code, signal }; resolve(result); }));
      try {
        await until(() => result, "reader observation fixture finishes: " + stderr, 20000);
        assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
      } finally {
        if (!result) { child.kill("SIGKILL"); await exited; }
        const identity = await readFile(path.join(directory, "reader-identity"), "utf8").then(JSON.parse, () => null);
        if (identity?.pid && await isRunning(identity.pid)) process.kill(identity.pid, "SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  for (const scenario of [
    "shutdown", "disconnect", "failure", "hosted", "windows-success",
    "codex-reader-metadata", "codex-reader-turn", "reader-cleanup-failure",
    "windows-pending", "windows-preview-failure", "windows-close-failure",
    "windows-standalone-failure", "windows-root-only-kill",
  ]) {
    test(`desktop lifecycle: ${scenario}`, {
      timeout: scenario.startsWith("codex-reader") ? 30000 : nativeWindows ? 20000 : 10000,
      skip: scenario === "windows-root-only-kill" && !nativeWindows || scenario.startsWith("codex-reader") && process.platform !== "linux",
    }, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-shutdown-"));
      const environment = { ...process.env };
      delete environment.VIVARY_STANDALONE_HOST;
      delete environment.VIVARY_DESKTOP_HOST;
      const standalone = scenario === "windows-standalone-failure";
      if (standalone) environment.VIVARY_STANDALONE_HOST = "1";
      else if (scenario !== "hosted") environment.VIVARY_DESKTOP_HOST = "1";
      const child = fork(fileURLToPath(import.meta.url), [scenario, directory], {
        env: environment, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      let result;
      let ready = false;
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.once("exit", (code, signal) => {
        result = { code, signal };
        resolve(result);
      }));
      child.on("message", message => {
        if (message.type === "vivary:desktop:bootstrap-needed") {
          child.send({ type: "vivary:desktop:bootstrap", capability: "a".repeat(43) });
        }
        if (message.type === "ready") ready = true;
      });
      const exists = name => readFile(path.join(directory, name)).then(() => true, () => false);
      try {
        await until(() => ready || result, "child becomes ready: " + stderr, scenario.startsWith("codex-reader") ? 15000 : 3000);
        assert.equal(result, undefined, stderr);
        if (scenario === "windows-root-only-kill") {
          const descendantPid = Number(await readFile(path.join(directory, "descendant-pid"), "utf8"));
          assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, "fixture descendant PID is valid");
          assert.ok(isAlive(child.pid), "fixture server is live before root-only termination");
          assert.ok(isAlive(descendantPid), "detached descendant is live before root-only termination");
          // Terminate only the root process. This deliberately omits taskkill /T.
          assert.ok(child.kill("SIGKILL"), "root-only termination kills the server");
          await until(() => result, "root-only server termination completes");
          await exited;
          await until(() => !isAlive(child.pid), "root-only server PID is gone");
          await delay(200);
          assert.ok(isAlive(descendantPid), "root-only termination must leave the detached descendant alive");
          return;
        }
        if (scenario === "disconnect") child.disconnect();
        else child.send({ type: scenario === "hosted" || standalone ? "signal" : "shutdown" });
        if (scenario.startsWith("windows-")) {
          await until(() => exists("started"), "Windows shutdown starts cleanup");
          if (scenario === "windows-success" || standalone) {
            await until(() => result, `Windows control must exit after cleanup: ${stderr}`);
            assert.deepEqual(await exited, { code: standalone ? 1 : 0, signal: null });
            assert.ok(await exists("settled"), "automation cleanup settled before exit");
            if (!standalone) assert.ok(await exists("close-started"), "success closes Nitro");
          } else {
            if (scenario !== "windows-pending") {
              await until(() => stderr.includes("Shutdown did not settle."), "cleanup rejection is reported");
              assert.ok(await exists("settled"), "automation cleanup settled before rejection");
              if (scenario === "windows-close-failure") {
                assert.ok(await exists("close-started"), "Nitro close was attempted");
              }
            }
            // No fixture interval or polling may replace production's live-parent hold.
            await delay(200);
            assert.equal(result, undefined,
              `Windows desktop must preserve its live PID for the parent tree fallback: ${stderr}`);
            if (nativeWindows) {
              const descendantPid = Number(await readFile(path.join(directory, "descendant-pid"), "utf8"));
              assert.ok(isAlive(child.pid), "Windows server PID remains live");
              assert.ok(isAlive(descendantPid), "owned descendant remains live before fallback");
              forceWindowsTree(child.pid);
              await until(() => result, "taskkill terminates the server");
              await exited;
              await until(() => !isAlive(child.pid) && !isAlive(descendantPid),
                "taskkill terminates both server and owned descendant");
            } else {
              assert.ok(child.kill("SIGKILL"), "parent fallback kills the live server");
              await until(() => result, "parent force kill completes");
              assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
            }
          }
          return;
        }
        await until(() => exists("started"), "shutdown starts cleanup");
        if (scenario.startsWith("codex-reader")) {
          const pids = JSON.parse(await readFile(path.join(directory, "reader-pids"), "utf8"));
          for (const pid of pids) await until(async () => !await isRunning(pid),
            "normal host shutdown stops its reader/helper while automation still holds exit", 5000);
        }
        await delay(100);
        assert.equal(result, undefined, "held automation cleanup must keep the child alive");
        await writeFile(path.join(directory, "release"), "");
        await until(() => exists("settled"), "automation cleanup settles");
        if (scenario === "hosted") {
          await delay(100);
          assert.equal(result, undefined, "imported hosted lifecycle must leave process exit to its owner");
          child.send({ type: "owner-finish" });
        }
        await until(() => result, `child must exit after cleanup without a force kill: ${stderr}`);
        assert.deepEqual(await exited, { code: ["failure", "reader-cleanup-failure"].includes(scenario) ? 1 : 0, signal: null });
        if (scenario.startsWith("codex-reader")) {
          const pids = JSON.parse(await readFile(path.join(directory, "reader-pids"), "utf8"));
          for (const pid of pids) await until(async () => !await isRunning(pid), "normal host quit stops owned reader/helper before exit");
          assert.equal(await readFile(path.join(directory, "reader-spawns"), "utf8"), "spawn\n",
            "closing admission prevents the queued inspection from spawning another reader");
        }
      } finally {
        if (!result) {
          child.kill("SIGKILL");
          await until(() => result, "fixture force kill completes");
          await exited;
        }
        if (nativeWindows) {
          // Red source may exit before tree fallback. Clean only this fixture's recorded child.
          const descendant = await readFile(path.join(directory, "descendant-pid"), "utf8")
            .catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
          if (descendant !== undefined) {
            const descendantPid = Number(descendant);
            assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, "fixture descendant PID is valid");
            if (isAlive(descendantPid)) forceWindowsTree(descendantPid);
            await until(() => !isAlive(descendantPid), "fixture descendant cleanup completes");
          }
        }
        if (scenario.startsWith("codex-reader")) {
          const pids = await readFile(path.join(directory, "reader-pids"), "utf8").then(JSON.parse, () => []);
          if (pids[0]) {
            try { process.kill(-pids[0], "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
            for (const pid of pids) await until(async () => !await isRunning(pid), "exact fixture group cleanup");
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  for (const [scenario, requestFirst] of [
    ["windows-pending", false],
    ["windows-preview-failure", true],
    ["windows-success", false],
  ]) {
    const loss = requestFirst ? "after shutdown" : "before shutdown";
    test("desktop parent loss: " + scenario + " " + loss, { timeout: 30000 }, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-parent-loss-"));
      const receipt = name => path.join(directory, name);
      const exists = name => readFile(receipt(name)).then(() => true, () => false);
      const readPid = async name => {
        const value = await readFile(receipt(name), "utf8")
          .catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (value === undefined) return undefined;
        const pid = Number(value);
        assert.ok(Number.isSafeInteger(pid) && pid > 0, "owned fixture PID is valid");
        return pid;
      };
      const owner = fork(fileURLToPath(import.meta.url), ["parent-loss-owner", directory, scenario], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let ownerResult;
      let ready = false;
      const ownerExited = new Promise(resolve => owner.once("exit", (code, signal) => {
        ownerResult = { code, signal };
        resolve(ownerResult);
      }));
      owner.on("message", message => { if (message.type === "ready") ready = true; });
      try {
        await until(() => ready || ownerResult, "intermediary reports server readiness");
        assert.equal(ownerResult, undefined, "desktop owner remains alive until the test terminates it");
        const serverPid = await readPid("server-pid");
        assert.ok(serverPid, "intermediary records its server PID");
        if (requestFirst) {
          owner.send({ type: "shutdown-server" });
          await until(() => exists("settled"), "explicit shutdown settles automation cleanup");
          assert.ok(await exists("preview-rejected"), "preview cleanup rejected before parent loss");
        }
        // Kill only the intermediary. The server loses its real IPC peer without a shutdown message.
        assert.ok(owner.kill("SIGKILL"), "desktop owner is abruptly terminated");
        await until(() => ownerResult, "desktop owner termination completes");
        await ownerExited;
        await until(() => exists("started"), "real parent loss starts server cleanup");
        if (scenario === "windows-success") {
          await until(async () => !await isRunning(serverPid), "successful cleanup exits after parent loss");
          assert.equal(await readFile(receipt("exit-code"), "utf8"), "0");
          assert.ok(await exists("settled"), "successful cleanup settles automations");
          assert.ok(await exists("close-started"), "successful cleanup closes Nitro");
          assert.equal(await exists("taskkill"), false, "success does not invoke fallback");
        } else {
          await delay(200);
          assert.ok(await isRunning(serverPid), "unsettled server remains live for bounded tree cleanup");
          const descendantPid = nativeWindows ? await readPid("descendant-pid") : undefined;
          if (nativeWindows) {
            assert.ok(descendantPid, "Windows fixture records its owned descendant");
            assert.ok(await isRunning(descendantPid), "owned descendant is live before fallback");
          }
          await until(async () => !await isRunning(serverPid),
            "server must terminate after parent loss within the 15-second fallback plus grace", 23000);
          if (nativeWindows) {
            await until(async () => !await isRunning(descendantPid), "server self-fallback terminates its descendant");
          } else {
            const fallback = JSON.parse(await readFile(receipt("taskkill"), "utf8"));
            // Linux records the Windows OS boundary. Windows executes the real command above.
            // guard:allow-env-credential - Match the fixture OS taskkill path.
            const expectedTaskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
            assert.equal(path.win32.normalize(fallback.command), expectedTaskkill);
            assert.deepEqual(fallback.args, ["/PID", String(serverPid), "/T", "/F"]);
            assert.ok(fallback.timeout > 0 && fallback.timeout <= 5000, "self taskkill is bounded");
            assert.equal(await readFile(receipt("exit-code"), "utf8"), "1", "server really exits after fallback returns");
          }
        }
      } finally {
        if (!ownerResult) {
          owner.kill("SIGKILL");
          await until(() => ownerResult, "fixture owner cleanup completes");
          await ownerExited;
        }
        const serverPid = await readPid("server-pid");
        if (serverPid && await isRunning(serverPid)) {
          if (nativeWindows) forceWindowsTree(serverPid);
          else {
            try {
              process.kill(serverPid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          await until(async () => !await isRunning(serverPid), "fixture server cleanup completes");
        }
        if (nativeWindows) {
          const descendantPid = await readPid("descendant-pid");
          if (descendantPid && await isRunning(descendantPid)) {
            forceWindowsTree(descendantPid);
            await until(async () => !await isRunning(descendantPid), "fixture descendant cleanup completes");
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
