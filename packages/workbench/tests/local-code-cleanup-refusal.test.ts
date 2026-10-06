import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
  listCodeAgentTranscriptEvents,
} from "@agent-native/core/code-agents";

import { checkStoppedWorker, CLEANUP_TIMEOUT_MS, readLinuxProcStat, STARTUP_TIMEOUT_MS, TERMINATION_GRACE_MS,
} from "../server/code-execution-host.ts";

// Issue #121. The code host keeps process-global state and loads persisted refusals once, when it first initializes, so
// this file runs in its own process like local-code-approval-restart.test.ts, and its tests run in order. Every record,
// process name, and address here is synthetic. The fakes are shell scripts and the targets are Linux process groups.
const linuxOnly = { skip: process.platform !== "linux" };
const WORKER_TEST_TIMEOUT_MS = STARTUP_TIMEOUT_MS + TERMINATION_GRACE_MS + CLEANUP_TIMEOUT_MS + 10_000;
const OWNER = "owner@example.test";
const OWNER_CONTEXT = { caller: "frontend", userEmail: OWNER } as const;
const SYSTEM_ROW = "4\t0\t\tSystem\r\n";

/** A Windows creation time as a FILETIME, 100-nanosecond intervals since 1601, from Unix milliseconds. */
function filetime(unixMs: number): bigint {
  return BigInt(unixMs) * 10_000n + 116_444_736_000_000_000n;
}

/** One row of the Windows process scan. */
function row(pid: number, parentPid: number, createdMs: number, name: string): string {
  return `${pid}\t${parentPid}\t${filetime(createdMs)}\t${name}\r\n`;
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-code-cleanup-"));
const projectRoot = path.join(fixture, "project");
const bin = path.join(fixture, "bin");
const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
const scanRows = path.join(fixture, "scan-rows.txt");
const scanFails = path.join(fixture, "scan-fails");
const leaveChild = path.join(fixture, "leave-child");
const scanHold = path.join(fixture, "scan-hold");
const endUnreadable = path.join(fixture, "end-unreadable");
const endDenied = path.join(fixture, "end-denied");
const endBreaksRecord = path.join(fixture, "end-breaks-record");
const workerRecord = path.join(fixture, "worker.txt");
const endLog = path.join(fixture, "end.log");
await mkdir(path.join(fixture, ".output", "server"), { recursive: true });
await mkdir(projectRoot);
await mkdir(bin);
await mkdir(scanner, { recursive: true });
await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true}');
`, { mode: 0o755 });
// The runtime lookup adds `.exe` while the platform reads as Windows.
await copyFile(path.join(bin, "claude"), path.join(bin, "claude.exe"));
// A run whose prompt asks for it exits after it receives its run, like a worker that died on its own.
await writeFile(path.join(fixture, ".output", "server", "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  if (message.prompt === "exit after its run") {
    writeFileSync(${JSON.stringify(workerRecord)}, process.pid + "\\t" + (BigInt(Date.now()) * 10000n + 116444736000000000n));
    process.exit(0);
  }
  process.send({ type: "vivary:code-worker:done", runId: message.runId });
});
process.send({ type: "vivary:code-worker:ready" });
`);
// Answers the Windows process scan from a file, names a child of the worker created while it ran, and counts the rows
// on the last line as the real scan does. A call that ends processes gets each PID with the lowest FILETIME its
// creation time may have, and ends a PID only when the file still holds it with a creation time in that millisecond.
// PID 4130 refuses, like a process Windows denies access to, and every PID refuses while the end-denied marker exists.
// Every such call is logged. The end-unreadable marker adds a line Vivary cannot read, as a module's warning could,
// after the call ended what it ends. The end-breaks-record marker holds a run record's path, and the call leaves that
// record unreadable. The scan-fails marker fails scans only, and the scan-hold marker holds a scan for up to 10
// seconds, as long as the host waits for one.
const scanOut = path.join(fixture, "scan-out.txt");
await writeFile(path.join(scanner, "powershell.exe"), `#!/bin/sh
case "$*" in *Stop-Process*)
  targets=$(printf '%s' "$*" | grep -oE '[0-9]+:[0-9]{16,}')
  printf '%s\\n' "$(printf '%s' "$targets" | tr '\\n' ' ')" >> ${JSON.stringify(endLog)}
  count=0
  for target in $targets; do
    pid=\${target%%:*}
    from=\${target#*:}
    created=$(awk -F '\\t' -v pid="$pid" '$1 == pid { print $3 }' ${JSON.stringify(scanRows)})
    if [ -z "$created" ]; then outcome=gone
    elif [ "$created" -lt "$from" ] || [ "$created" -ge $((from + 10000)) ]; then outcome=mismatched
    elif [ "$pid" = 4130 ] || [ -f ${JSON.stringify(endDenied)} ]; then outcome=failed
    else
      outcome=ended
      awk -F '\\t' -v pid="$pid" '$1 != pid' ${JSON.stringify(scanRows)} > ${JSON.stringify(scanRows)}.next
      mv ${JSON.stringify(scanRows)}.next ${JSON.stringify(scanRows)}
    fi
    printf '%s\\t%s\\r\\n' "$pid" "$outcome"
    count=$((count + 1))
  done
  [ -f ${JSON.stringify(endBreaksRecord)} ] && printf '{' > "$(cat ${JSON.stringify(endBreaksRecord)})"
  [ -f ${JSON.stringify(endUnreadable)} ] && printf 'WARNING: a module printed this line\\r\\n'
  printf 'END\\t%s\\r\\n' "$count"
  exit 0 ;;
esac
[ -f ${JSON.stringify(scanFails)} ] && exit 1
held=0
while [ -f ${JSON.stringify(scanHold)} ] && [ "$held" -lt 200 ]; do sleep 0.05; held=$((held + 1)); done
{
  cat ${JSON.stringify(scanRows)}
  if [ -f ${JSON.stringify(leaveChild)} ]; then
    printf '4242\\t%s\\tcodex.exe\\r\\n' "$(cat ${JSON.stringify(workerRecord)})"
  fi
} > ${JSON.stringify(scanOut)}
cat ${JSON.stringify(scanOut)}
printf 'END\\t%s\\r\\n' "$(grep -c . ${JSON.stringify(scanOut)})"
`, { mode: 0o755 });
await writeFile(scanRows, SYSTEM_ROW);

const saved = new Map<string, string | undefined>();
function useSetting(name: string, value: string): void {
  // guard:allow-env-credential - Saves a synthetic test setting's previous value, restored after this file.
  saved.set(name, process.env[name]);
  // guard:allow-env-credential - Isolated synthetic test configuration, restored after this file.
  process.env[name] = value;
}
useSetting("AGENT_NATIVE_CODE_AGENTS_HOME", path.join(fixture, "runs"));
useSetting("DATABASE_URL", "file:" + path.join(fixture, "state.sqlite"));
useSetting("VIVARY_LOCAL_AGENT_WORKSPACE", projectRoot);
useSetting("VIVARY_ACCESS_MODE", "local");
// guard:allow-env-credential - The fake runtime directory goes first on the existing search path.
useSetting("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
useSetting("SystemRoot", fixture);
const originalCwd = process.cwd();
process.chdir(fixture);
after(async () => {
  process.chdir(originalCwd);
  for (const [name, value] of saved) {
    // guard:allow-env-credential - Restores a synthetic test setting, or its absence.
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(fixture, { recursive: true, force: true });
});

const workspace = { root: projectRoot, label: "Cleanup project" };
const runMetadata = { app: "vivary-workbench-local-code", engine: "claude-cli", model: "sonnet", ownerEmail: OWNER,
  workspaceRoot: projectRoot };

function seedRun(id: string, metadata: Record<string, unknown>) {
  return createCodeAgentRunRecord({ id, goalId: "vivary-local-code", title: `Leftovers from ${id}`, status: "errored",
    phase: "cleanup-unverified", cwd: projectRoot, metadata: { ...runMetadata, ...metadata } });
}

function seedRefusal(id: string, target: unknown, refusedAt = new Date().toISOString()) {
  return seedRun(id, { cleanupRefusal: { target, remaining: [], hidden: false, scan: "done", step: "group", refusedAt,
    checkedAt: refusedAt } });
}

async function bootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

/** A process as the check right after a failed stop traces it: by PID and start time. */
async function traced(pid: number): Promise<{ pid: number; start: number }> {
  return { pid, start: readLinuxProcStat(await readFile(`/proc/${pid}/stat`, "utf8")).start };
}

/** A PID that no process uses as a group id now: a short process that already exited and was reaped. */
async function emptiedGroup(): Promise<number> {
  const child = spawn("true", [], { detached: true, stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

function metadataOf(id: string): Record<string, unknown> {
  return getCodeAgentRunRecord(id)?.metadata ?? {};
}

/** Each End them a refusal or a lift records: who chose it, that it has a time, and each process's outcome. */
function endsOf(record: unknown) {
  const ends = (record as { ends?: { by: string; at: unknown; attempts: { pid: number; outcome: string }[] | null }[] })
    ?.ends;
  return ends?.map(({ by, at, attempts }) => ({ by, at: typeof at,
    attempts: attempts?.map(({ pid, outcome }) => [pid, outcome]) ?? null }));
}

function lastStatus(id: string): string | undefined {
  return listCodeAgentTranscriptEvents(id).findLast(event => event.kind === "status")?.message;
}

function hostSlots(): { activeRuns: Map<string, { execution: Promise<void> | null }>; unsaved: Map<string, unknown>;
  cleanup: unknown } {
  return Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host"));
}

async function waitFor<T>(read: () => T | undefined, signal: AbortSignal): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20, undefined, { signal });
  }
}

// Runs the Windows cleanup branch on this host. Only the platform name changes.
async function asWindows<T>(run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform, "process.platform is an own property");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try { return await run(); } finally { Object.defineProperty(process, "platform", platform); }
}

// Both seeded before the host first initializes: an older refusal whose group is already empty, and a marker from
// before part B that names nothing.
const emptied = linuxOnly.skip ? 0 : await emptiedGroup();
if (!linuxOnly.skip) {
  seedRefusal("emptied-at-start", { platform: "linux", groupId: emptied, bootId: await bootId() }, "2026-09-28T10:00:00.000Z");
  seedRun("legacy-marker", { cleanupUnverified: true });
}
const agent = await import("../server/local-code-agent.ts");

function send(message: string) {
  return agent.sendVivaryCodeMessage({ ownerEmail: OWNER, message, engine: "claude-cli", model: "sonnet", workspace });
}

async function sendAndSettle(message: string): Promise<string> {
  const state = await send(message);
  const runId = state.run!.id;
  // A fixture run can finish before the send returns, so the run's own transcript shows that it started.
  assert.ok(listCodeAgentTranscriptEvents(runId).some(event => event.kind === "user" && event.message === message));
  await hostSlots().activeRuns.get(runId)?.execution;
  return runId;
}

/** The owner's choice on the list the host strip shows now, through the action's own input schema. */
async function decide(decision: string) {
  const { default: cleanupAction } = await import("../actions/vivary-code-cleanup.ts");
  const version = (await agent.getVivaryCodeHostState(OWNER)).cleanup?.version;
  return cleanupAction.run(cleanupAction.schema.parse({ decision, version }), OWNER_CONTEXT);
}

function continueAnyway() {
  return decide("continue");
}

test("host start lifts a refusal whose group already emptied without a send, and keeps one it cannot check", {
  ...linuxOnly, timeout: 10_000,
}, async t => {
  await agent.initializeVivaryCodeAgent();
  const lift = await waitFor(() => metadataOf("emptied-at-start").cleanupLifted, t.signal);
  assert.equal((lift as { how?: string }).how, "rechecked");
  assert.equal("cleanupRefusal" in metadataOf("emptied-at-start"), false);
  // The legacy marker still refuses, so this lift does not say that Vivary accepts new messages. The next case lifts
  // the marker, and its status does.
  assert.equal(lastStatus("emptied-at-start"), "The leftover coding processes are gone. This run no longer keeps Vivary "
    + "from accepting new messages, but another run still does.");

  const host = await agent.getVivaryCodeHostState(OWNER);
  assert.match(host.cleanup?.version ?? "", /^[0-9a-f]{16}$/);
  assert.deepEqual({ ...host.cleanup, version: "" }, {
    version: "",
    heading: "Vivary could not confirm that an earlier run's coding processes stopped",
    instruction: "This run ended before Vivary recorded which processes it started. End any codex, claude, or node "
      + "processes left from it in your process list, then choose Continue anyway.",
    remaining: [], unlisted: 0, canEnd: false, canContinue: true, notice: null,
    composer: "Vivary could not confirm that an earlier run's coding processes stopped. Choose Continue anyway above "
      + "before sending another message.",
    checking: false, run: { id: "legacy-marker", title: "Leftovers from legacy-marker", projectId: null },
  });
  assert.equal((await agent.getVivaryCodeHostState("someone-else@example.test")).cleanup?.run, null,
    "another user sees the refusal but not the run");
  await assert.rejects(send("Start while refused"), (error: Error & { errorCode?: string; statusCode?: number }) => {
    assert.equal(error.errorCode, "vivary_code_cleanup_required");
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /^Vivary could not confirm that an earlier run's coding processes stopped\. /);
    return true;
  });
});

test("Continue anyway lifts a refusal Vivary cannot check, records who chose it, and the next send starts", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async () => {
  const state = await continueAnyway();
  assert.equal(state.cleanup, null);
  const metadata = metadataOf("legacy-marker");
  assert.equal("cleanupUnverified" in metadata, false);
  assert.equal("cleanupRefusal" in metadata, false);
  const lift = metadata.cleanupLifted as Record<string, unknown>;
  assert.equal(typeof lift.confirmedAt, "string");
  assert.deepEqual({ ...lift, confirmedAt: "" }, { how: "owner-confirmed", confirmedAt: "", by: OWNER, shown: [],
    hidden: false, scan: "not-recorded", remaining: [], total: 0, ends: [] });
  assert.equal(lastStatus("legacy-marker"),
    "You chose to continue. Vivary could not check whether this run's coding processes stopped. "
    + "Vivary accepts new messages again.");
  const runId = await sendAndSettle("Start after continuing");
  assert.notEqual(getCodeAgentRunRecord(runId)?.status, "errored");
});

test("a live process group keeps refusing by name, and a send after it stops lifts the refusal", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async () => {
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const groupId = sleeper.pid!;
  const exited = once(sleeper, "exit");
  try {
    // Traced as the check right after a failed stop traces what it finds.
    const seeded = seedRefusal("live-group", { platform: "linux", groupId, bootId: await bootId(),
      traced: [await traced(groupId)] });
    await agent.recheckVivaryCodeCleanup();
    const host = await agent.getVivaryCodeHostState(OWNER);
    assert.equal(host.cleanup?.heading, "Coding processes from an earlier run are still running");
    assert.deepEqual(host.cleanup?.remaining, [{ pid: groupId, name: "sleep", confirmed: true }]);
    assert.equal(host.cleanup?.canEnd, true);
    const refusal = metadataOf("live-group").cleanupRefusal as { remaining: { pid: number; name: string; start: number }[] };
    assert.deepEqual(refusal.remaining.map(({ pid, name }) => ({ pid, name })), [{ pid: groupId, name: "sleep" }]);
    assert.equal(getCodeAgentRunRecord("live-group")?.updatedAt, seeded.updatedAt, "a check keeps the history order");
    await assert.rejects(send("Start beside the leftover"), (error: Error & { errorCode?: string }) => {
      assert.equal(error.errorCode, "vivary_code_cleanup_required");
      assert.ok(error.message.startsWith(`Coding processes from an earlier run are still running: sleep (PID ${groupId}). `),
        error.message);
      return true;
    });
    process.kill(-groupId, "SIGKILL");
    await exited;
    const runId = await sendAndSettle("Start after it stopped");
    assert.notEqual(getCodeAgentRunRecord(runId)?.status, "errored");
    assert.equal((metadataOf("live-group").cleanupLifted as { how?: string }).how, "rechecked");
    assert.equal(lastStatus("live-group"), "The leftover coding processes are gone. Vivary accepts new messages again.");
  } finally {
    if (sleeper.exitCode === null && sleeper.signalCode === null) process.kill(-groupId, "SIGKILL");
  }
});

test("a Windows target refuses by name, lifts once the scan misses it, and falls back to Continue anyway", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  const tracked = (pid: number) => ({ platform: "win32", tracked: [{ pid, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: 9_000 }] });
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe"));
  seedRefusal("windows-leftover", tracked(4120));
  await agent.recheckVivaryCodeCleanup();
  const host = await agent.getVivaryCodeHostState(OWNER);
  assert.deepEqual(host.cleanup?.remaining, [{ pid: 4120, name: "codex.exe", confirmed: true }]);
  assert.equal(host.cleanup?.canEnd, true);
  await assert.rejects(send("Start beside the leftover"), /still running: codex\.exe \(PID 4120\)\. /);
  await writeFile(scanRows, SYSTEM_ROW);
  await agent.recheckVivaryCodeCleanup();
  assert.equal((metadataOf("windows-leftover").cleanupLifted as { how?: string }).how, "rechecked");
  assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup, null);

  seedRefusal("windows-unscanned", tracked(4121));
  await writeFile(scanFails, "");
  try {
    await agent.recheckVivaryCodeCleanup();
    const unscanned = await agent.getVivaryCodeHostState(OWNER);
    assert.equal(unscanned.cleanup?.heading, "Vivary could not confirm that an earlier run's coding processes stopped");
    assert.equal(unscanned.cleanup?.instruction, "Vivary could not list the processes. Check Task Manager for codex, "
      + "claude, or node processes from that run and end them, then choose Continue anyway.");
    assert.equal(unscanned.cleanup?.canEnd, false);
    assert.equal((metadataOf("windows-unscanned").cleanupRefusal as { scan?: string }).scan, "unavailable");
    assert.equal((metadataOf("windows-unscanned").cleanupRefusal as { scanFailure?: string }).scanFailure, "command-failed");
    await agent.recheckVivaryCodeCleanup();
    assert.equal((metadataOf("windows-unscanned").cleanupRefusal as { scanFailure?: string }).scanFailure,
      "command-failed", "a recheck reparses the stored refusal and keeps refusing with its category");

    assert.equal((await continueAnyway()).cleanup, null);
    const lift = metadataOf("windows-unscanned").cleanupLifted as Record<string, unknown>;
    assert.equal(lift.how, "owner-confirmed");
    assert.equal(lift.scan, "unavailable");
  } finally {
    await rm(scanFails, { force: true });
  }
});

// Constrained Language Mode refused the earlier scan's creation-time conversion, so every row came back without one.
test("a Windows scan whose rows lack creation times, as under Constrained Language Mode, never lifts a refusal", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  await writeFile(scanRows, `${SYSTEM_ROW}4120\t880\t\tcodex.exe\r\n`);
  seedRefusal("windows-untimed", { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: 9_000 }] });
  try {
    await agent.recheckVivaryCodeCleanup();
    assert.equal("cleanupLifted" in metadataOf("windows-untimed"), false, "a scan it cannot trust lifts nothing");
    assert.equal((metadataOf("windows-untimed").cleanupRefusal as { scan?: string }).scan, "unavailable");
    assert.equal((metadataOf("windows-untimed").cleanupRefusal as { scanFailure?: string }).scanFailure, "invalid-output");

    assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup?.heading,
      "Vivary could not confirm that an earlier run's coding processes stopped");
  } finally {
    await writeFile(scanRows, SYSTEM_ROW);
    if (!("cleanupLifted" in metadataOf("windows-untimed"))) await continueAnyway();
  }
});

test("a Windows run whose worker exits after its run records a refusal that names the leftover", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async () => {
  await writeFile(leaveChild, "");
  try {
    const runId = await asWindows(() => sendAndSettle("exit after its run"));
    const record = getCodeAgentRunRecord(runId);
    assert.equal(record?.status, "errored");
    assert.equal(record?.phase, "cleanup-unverified");
    assert.equal("cleanupUnverified" in (record?.metadata ?? {}), false);
    const refusal = record?.metadata?.cleanupRefusal as { remaining: { pid: number; name: string }[]; scan: string;
      step: string; target: { platform: string; traced: { pid: number }[] } };
    assert.deepEqual(refusal.remaining.map(({ pid, name }) => ({ pid, name })), [{ pid: 4242, name: "codex.exe" }]);
    assert.equal(refusal.scan, "done");
    assert.equal(refusal.step, "worker-exited");
    assert.equal(refusal.target.platform, "win32");
    assert.deepEqual(refusal.target.traced.map(({ pid }) => pid), [4242], "the check right after the stop traces it");
    assert.equal(lastStatus(runId), "The coding process could not be stopped completely. Still running: codex.exe "
      + "(PID 4242). Choose End them at the top of Vivary to stop these processes. Vivary ends only listed processes "
      + "it can confirm came from that run, then checks again.");
    assert.deepEqual((await agent.getVivaryCodeHostState(OWNER)).cleanup?.remaining,
      [{ pid: 4242, name: "codex.exe", confirmed: true }]);
    await rm(leaveChild);
    await agent.recheckVivaryCodeCleanup();
    assert.equal((metadataOf(runId).cleanupLifted as { how?: string }).how, "rechecked");
  } finally {
    await rm(leaveChild, { force: true });
  }
});

// The worker exits after its run, so its stop fails, and the scan after the failure is held. The refusal is on the
// record before that scan ends. Then a lock that a live process holds on the run's record makes the next write fail
// after Core's 10-second lock wait, and the refusal with the names stays in force from memory.
test("a failed stop is recorded before its scan, and a refusal whose record cannot be written still refuses", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async t => {
  const logged = t.mock.method(console, "error", () => undefined);
  let lock: string | undefined;
  await writeFile(leaveChild, "");
  await writeFile(scanHold, "");
  try {
    const runId = await asWindows(async () => {
      const id = (await send("exit after its run")).run!.id;
      // The held scan ends after 10 seconds, so a refusal written only after it would arrive too late.
      const provisional = await waitFor(() => metadataOf(id).cleanupRefusal as Record<string, unknown> | undefined,
        AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]));
      assert.deepEqual({ scan: provisional.scan, step: provisional.step, remaining: provisional.remaining },
        { scan: "unavailable", step: "worker-exited", remaining: [] }, "on the record while its scan still runs");
      lock = path.join(fixture, "runs", "runs", `${id}.json.lock`);
      await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "held-by-this-test" }));
      await rm(scanHold);
      await hostSlots().activeRuns.get(id)?.execution;
      return id;
    });
    await rm(lock!);
    assert.deepEqual((await agent.getVivaryCodeHostState(OWNER)).cleanup?.remaining.map(({ pid, name }) => ({ pid, name })),
      [{ pid: 4242, name: "codex.exe" }], "the names Vivary could not write still refuse");
    assert.deepEqual((metadataOf(runId).cleanupRefusal as { remaining?: unknown }).remaining, [],
      "the record keeps the write before the scan");
    assert.ok(logged.mock.calls.some(call =>
      String(call.arguments[0]).startsWith(`[vivary-code-host] cleanup-record-failed run=${runId} `)));
    await agent.recheckVivaryCodeCleanup();
    assert.deepEqual((metadataOf(runId).cleanupRefusal as { remaining: { pid: number }[] }).remaining.map(({ pid }) => pid),
      [4242], "the next check writes it");
    await rm(leaveChild);
    await agent.recheckVivaryCodeCleanup();
    assert.equal((metadataOf(runId).cleanupLifted as { how?: string }).how, "rechecked");
  } finally {
    await rm(scanHold, { force: true });
    await rm(leaveChild, { force: true });
    if (lock) await rm(lock, { force: true });
  }
});

// The worker exits after its run and leaves nothing, so its stop fails and the scan after it, held until the early
// refusal is on the record, reads clean. The stop did finish, as a slow but successful stop does, so nothing refuses.
test("a failed stop whose check finds nothing left takes its early refusal off the run", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async t => {
  await writeFile(scanHold, "");
  try {
    const runId = await asWindows(async () => {
      const id = (await send("exit after its run")).run!.id;
      await waitFor(() => metadataOf(id).cleanupRefusal, AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]));
      await rm(scanHold);
      await hostSlots().activeRuns.get(id)?.execution;
      return id;
    });
    const record = getCodeAgentRunRecord(runId);
    assert.equal(record?.phase, "error", "the run failed because its worker exited, not because of its cleanup");
    assert.equal("cleanupRefusal" in (record?.metadata ?? {}), false, "the clean check takes the early refusal off");
    assert.equal("cleanupLifted" in (record?.metadata ?? {}), false, "nothing was refused, so nothing was lifted");
    assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup, null);
  } finally {
    await rm(scanHold, { force: true });
  }
});

// The same failed stop, and the owner asks to stop the run while its check is held. That check is already ending the
// run, so the Stop records nothing, and the run keeps the worker's own failure when the check reads clean.
test("a Stop during a failed stop's own check leaves the run failed, not stopped by its owner", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async t => {
  await writeFile(scanHold, "");
  try {
    const runId = await asWindows(async () => {
      const id = (await send("exit after its run")).run!.id;
      await waitFor(() => metadataOf(id).cleanupRefusal, AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]));
      const owners = await agent.getVivaryCodeHostState(OWNER);
      assert.deepEqual({ active: owners.activeRun?.id, checking: owners.cleanup?.checking, run: owners.cleanup?.run?.id },
        { active: id, checking: true, run: id }, "the owner's strip can tell that the check belongs to its run");
      await agent.stopVivaryCodeRun({ ownerEmail: OWNER, runId: id });
      await rm(scanHold);
      await hostSlots().activeRuns.get(id)?.execution;
      return id;
    });
    const statuses = listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "status")
      .map(event => event.message);
    const record = getCodeAgentRunRecord(runId);
    assert.deepEqual({ stopRecorded: statuses.includes("Stop requested from the Vivary workbench."),
      status: record?.status, phase: record?.phase }, { stopRecorded: false, status: "errored", phase: "error" },
    "the Stop records nothing and the run keeps the worker's failure");
    // The worker's exit and its closed connection race, so either one can be the failure the run keeps.
    assert.match(statuses.at(-1) ?? "",
      /^The local code run failed: The coding worker (ended before completing its run|connection closed)\.$/);
  } finally {
    await rm(scanHold, { force: true });
  }
});

// The worker exits after its run and leaves a child, and the scan after the failed stop is held. That check decides what
// is left, so until it ends the strip offers no choice and says that Vivary is checking, and a send is told the same.
test("a failed stop's own check offers no choice until it ends and says that Vivary is checking", {
  ...linuxOnly, timeout: WORKER_TEST_TIMEOUT_MS,
}, async t => {
  await writeFile(leaveChild, "");
  await writeFile(scanHold, "");
  try {
    const runId = await asWindows(async () => {
      const id = (await send("exit after its run")).run!.id;
      await waitFor(() => metadataOf(id).cleanupRefusal, AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]));
      // Another user of the host sees the check without the run. The owner's view is in the Stop case above.
      const checking = (await agent.getVivaryCodeHostState("someone-else@example.test")).cleanup;
      assert.deepEqual({ ...checking, version: "" }, {
        version: "", heading: "Vivary is checking whether coding processes stopped", remaining: [], unlisted: 0,
        instruction: "The choices appear here when the check ends.", canEnd: false, canContinue: false,
        notice: null, composer: "Vivary is checking whether coding processes stopped. Wait for the check to end before "
          + "sending another message.", checking: true, run: null,
      });
      await assert.rejects(send("Start during the check"), (error: Error & { errorCode?: string }) => {
        assert.equal(error.errorCode, "vivary_code_cleanup_required");
        assert.equal(error.message, "Vivary is checking whether coding processes stopped. The choices appear at the top "
          + "of Vivary when the check ends.");
        return true;
      });
      await rm(scanHold);
      await hostSlots().activeRuns.get(id)?.execution;
      return id;
    });
    const settled = (await agent.getVivaryCodeHostState(OWNER)).cleanup;
    assert.deepEqual({ canEnd: settled?.canEnd, checking: settled?.checking }, { canEnd: true, checking: false },
      "the choices appear when the check ends");
    await rm(leaveChild);
    await agent.recheckVivaryCodeCleanup();
    assert.equal((metadataOf(runId).cleanupLifted as { how?: string }).how, "rechecked");
  } finally {
    await rm(scanHold, { force: true });
    await rm(leaveChild, { force: true });
  }
});

test("End them ends the listed process that a fresh scan still shows, then lifts the refusal", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const groupId = sleeper.pid!;
  const exited = once(sleeper, "exit");
  try {
    // Seeded from the check a failed stop takes, which traces the group's live member.
    const stopped = await checkStoppedWorker({ platform: "linux", groupId, bootId: await bootId(), traced: [] });
    assert.ok(stopped.result === "remaining");
    assert.deepEqual(stopped.target.traced, [await traced(groupId)]);
    seedRefusal("end-linux", stopped.target);
    await agent.recheckVivaryCodeCleanup();
    assert.deepEqual((await agent.getVivaryCodeHostState(OWNER)).cleanup?.remaining,
      [{ pid: groupId, name: "sleep", confirmed: true }]);
    assert.equal((await decide("end")).cleanup, null);
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    const lift = metadataOf("end-linux").cleanupLifted as { how: string; by: string };
    assert.equal(lift.how, "ended");
    assert.equal(lift.by, OWNER);
    assert.deepEqual(endsOf(lift), [{ by: OWNER, at: "string", attempts: [[groupId, "ended"]] }]);
    assert.equal(lastStatus("end-linux"), `You chose End them. Vivary ended sleep (PID ${groupId}) and found no coding `
      + "processes left. Vivary accepts new messages again.");
  } finally {
    if (sleeper.exitCode === null && sleeper.signalCode === null) process.kill(-groupId, "SIGKILL");
  }
});

// The worker 4120 left a child and a grandchild. Before End them, the grandchild's PID passes to a new process, and a
// process the owner never saw appears.
test("End them on Windows ends each shown process by PID and creation time, never a tree, then offers Continue anyway", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  await rm(endLog, { force: true });
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + row(4130, 4120, 3_000, "node.exe")
    + row(4140, 4120, 3_500, "powershell.exe"));
  seedRefusal("end-windows", { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: null }] });
  await agent.recheckVivaryCodeCleanup();
  const before = (await agent.getVivaryCodeHostState(OWNER)).cleanup;
  assert.deepEqual(before?.remaining.map(({ pid }) => pid), [4120, 4130, 4140]);
  assert.equal(before?.canContinue, false, "Continue anyway waits until End them has run");
  assert.equal(before?.notice, null);
  assert.equal(before?.composer, "Coding processes from an earlier run are still running. "
    + "Choose End them above before sending another message.");
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + row(4130, 4120, 3_000, "node.exe")
    + row(4140, 4120, 9_999, "powershell.exe") + row(4150, 4120, 3_600, "late.exe"));
  const state = await decide("end");
  // One call, newest first, so the children go before their parent 4120. It gets 4140 as the owner saw it, and finds
  // that PID now names a process created later.
  assert.deepEqual((await readFile(endLog, "utf8")).trim().split("\n"),
    [`4140:${filetime(3_500)} 4130:${filetime(3_000)} 4120:${filetime(2_000)}`]);
  assert.deepEqual(state.cleanup?.remaining.map(({ pid }) => pid), [4130, 4140, 4150], "what End them could not end");
  assert.equal(state.cleanup?.canEnd, true);
  assert.equal(state.cleanup?.canContinue, true);
  assert.equal(state.cleanup?.notice, "End them ended codex.exe (PID 4120). Vivary could not end node.exe (PID 4130).");
  assert.equal(state.cleanup?.composer, "Processes that may be left from an earlier run are still running. "
    + "Choose End them or Continue anyway above before sending another message.");
  assert.equal("cleanupLifted" in metadataOf("end-windows"), false);
  const ended = [{ by: OWNER, at: "string", attempts: [[4140, "mismatched"], [4130, "failed"], [4120, "ended"]] }];
  assert.deepEqual(endsOf(metadataOf("end-windows").cleanupRefusal), ended, "the refusal records what End them did");

  assert.equal((await continueAnyway()).cleanup, null);
  const lift = metadataOf("end-windows").cleanupLifted as { how: string; shown?: { pid: number }[];
    remaining: { pid: number }[] };
  assert.equal(lift.how, "owner-confirmed");
  assert.deepEqual(lift.shown?.map(({ pid }) => pid), [4130, 4140, 4150], "what the owner was shown");
  assert.deepEqual(lift.remaining.map(({ pid }) => pid), [4130, 4140, 4150], "what the check before the lift found");
  assert.deepEqual(endsOf(lift), ended, "the lift keeps what End them did");
  assert.equal(lastStatus("end-windows"), "You chose to continue while these processes were still running: "
    + "node.exe (PID 4130), powershell.exe (PID 4140, not confirmed from that run), late.exe (PID 4150, not confirmed "
    + "from that run). End them ended codex.exe (PID 4120). Vivary accepts new messages again.");
  await writeFile(scanRows, SYSTEM_ROW);
});

test("End them records what it ended even when the check after it cannot run", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe"));
  seedRefusal("end-unchecked", { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: null }] });
  await agent.recheckVivaryCodeCleanup();
  await writeFile(scanFails, "");
  try {
    const state = await decide("end");
    assert.equal(state.cleanup?.heading, "Vivary could not confirm that an earlier run's coding processes stopped");
    assert.equal(state.cleanup?.canEnd, false);
    assert.equal(state.cleanup?.canContinue, true);
    assert.equal(state.cleanup?.notice, "End them ended codex.exe (PID 4120).");
    assert.equal(state.cleanup?.composer, "Vivary could not confirm that an earlier run's coding processes stopped. "
      + "Choose Continue anyway above before sending another message.");
    const refusal = metadataOf("end-unchecked").cleanupRefusal as { scan?: string };
    assert.equal(refusal.scan, "unavailable");
    assert.deepEqual(endsOf(refusal), [{ by: OWNER, at: "string", attempts: [[4120, "ended"]] }]);
  } finally {
    await rm(scanFails, { force: true });
  }
  assert.equal((await continueAnyway()).cleanup, null);
  const lift = metadataOf("end-unchecked").cleanupLifted as { how?: string };
  assert.equal(lift.how, "rechecked", "the check before Continue anyway found nothing left");
  assert.deepEqual(endsOf(lift), [{ by: OWNER, at: "string", attempts: [[4120, "ended"]] }]);
  assert.equal(lastStatus("end-unchecked"), "The leftover coding processes are gone. End them ended codex.exe "
    + "(PID 4120). Vivary accepts new messages again.");
});

// The End call ends what it can and then prints a line Vivary cannot read, so Vivary cannot tell what it did.
test("End them whose output Vivary cannot read records what it sent as unknown and says so", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  const worker = { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000, childrenTo: null }] };
  const unread = (child: number) => [{ by: OWNER, at: "string", attempts: [[child, "unknown"], [4120, "unknown"]] }];
  await writeFile(endUnreadable, "");
  try {
    // 4130 refuses to end, so the strip still lists it after End them.
    await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + row(4130, 4120, 3_000, "node.exe"));
    seedRefusal("end-unread", worker);
    await agent.recheckVivaryCodeCleanup();
    const state = await decide("end");
    assert.deepEqual(state.cleanup?.remaining.map(({ pid }) => pid), [4130]);
    assert.equal(state.cleanup?.notice,
      "Vivary could not read what End them did to node.exe (PID 4130), codex.exe (PID 4120).");
    assert.deepEqual(endsOf(metadataOf("end-unread").cleanupRefusal), unread(4130), "the run records what was sent");
    assert.equal((await continueAnyway()).cleanup, null);
    assert.deepEqual(endsOf(metadataOf("end-unread").cleanupLifted), unread(4130));
    assert.equal(lastStatus("end-unread"), "You chose to continue while these coding processes were still running: "
      + "node.exe (PID 4130). Vivary could not read what End them did to node.exe (PID 4130), codex.exe (PID 4120). "
      + "Vivary accepts new messages again.");

    // Both end, as in the re-review's case, and the check after End them finds nothing left.
    await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + row(4140, 4120, 3_500, "node.exe"));
    seedRefusal("end-unread-clean", worker);
    await agent.recheckVivaryCodeCleanup();
    assert.equal((await decide("end")).cleanup, null);
    const lift = metadataOf("end-unread-clean").cleanupLifted as { how?: string };
    assert.equal(lift.how, "rechecked");
    assert.deepEqual(endsOf(lift), unread(4140));
    assert.equal(lastStatus("end-unread-clean"), "The leftover coding processes are gone. Vivary could not read what "
      + "End them did to node.exe (PID 4140), codex.exe (PID 4120). Vivary accepts new messages again.");
  } finally {
    await rm(endUnreadable, { force: true });
    await writeFile(scanRows, SYSTEM_ROW);
  }
});

// A group or a parent PID that Vivary did not trace to the run can belong to another program after PID reuse, so End
// them lists such processes but never ends them.
test("a list with no process traced to the run offers only Continue anyway and says why", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const groupId = stranger.pid!;
  const exited = once(stranger, "exit");
  try {
    seedRefusal("untraced-group", { platform: "linux", groupId, bootId: await bootId() });
    await agent.recheckVivaryCodeCleanup();
    const host = await agent.getVivaryCodeHostState(OWNER);
    assert.equal(host.cleanup?.heading, "Processes that may be left from an earlier run are still running");
    assert.deepEqual(host.cleanup?.remaining, [{ pid: groupId, name: "sleep", confirmed: false }]);
    assert.equal(host.cleanup?.instruction, "Vivary cannot confirm that these came from that run, so it does not end "
      + `them. If they did, stop them with \`kill -KILL -- -${groupId}\`, then choose Continue anyway.`);
    assert.equal(host.cleanup?.canEnd, false, "End them has nothing it may end");
    assert.equal(host.cleanup?.canContinue, true);
    await assert.rejects(decide("end"), { errorCode: "vivary_code_cleanup_not_offered" });
    assert.equal(stranger.exitCode === null && stranger.signalCode === null, true, "the untraced process still runs");
    assert.equal((await continueAnyway()).cleanup, null);
  } finally {
    if (stranger.exitCode === null && stranger.signalCode === null) process.kill(-groupId, "SIGKILL");
    await exited;
  }

  // The worker's child 300 exited, another program took PID 300 and started 500, and that program exited too.
  await rm(endLog, { force: true });
  await writeFile(scanRows, SYSTEM_ROW + row(500, 300, 20_000, "unrelated.exe"));
  seedRefusal("untraced-parent", { platform: "win32", tracked: [{ pid: 100, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: 9_000 }, { pid: 300, createdFrom: 4_000, createdTo: 4_000, childrenTo: null }] });
  await agent.recheckVivaryCodeCleanup();
  const windows = (await agent.getVivaryCodeHostState(OWNER)).cleanup;
  assert.deepEqual(windows?.remaining, [{ pid: 500, name: "unrelated.exe", confirmed: false }]);
  assert.equal(windows?.canEnd, false);
  assert.equal(windows?.instruction, "Vivary cannot confirm that these came from that run, so it does not end them. "
    + "If they did, end them in Task Manager by PID, then choose Continue anyway.");
  await assert.rejects(readFile(endLog), { code: "ENOENT" }, "Vivary tried to end nothing");
  assert.equal((await continueAnyway()).cleanup, null);
  await writeFile(scanRows, SYSTEM_ROW);
});

// A decision carries the version of the list the strip showed. When the list changed since, the decision changes
// nothing, and Continue anyway never covers a process the owner was not shown.
test("End them and Continue anyway act only on the list the owner saw", { ...linuxOnly, timeout: 20_000 }, async () => {
  const worker = { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000, childrenTo: null }] };
  const shownVersion = async () => (await agent.getVivaryCodeHostState(OWNER)).cleanup?.version;
  const resolve = (decision: "end" | "continue", version: string | undefined) =>
    agent.resolveVivaryCodeCleanup({ ownerEmail: OWNER, decision, version: version! });
  const changed = (error: Error & { errorCode?: string; statusCode?: number }) => {
    assert.equal(error.errorCode, "vivary_code_cleanup_changed");
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, "The list of leftover coding processes changed. Review it again before you choose.");
    return true;
  };
  await rm(endLog, { force: true });
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe"));
  seedRefusal("stale-choice", worker);
  await agent.recheckVivaryCodeCleanup();
  const seen = await shownVersion();
  // A send from another browser checks again and finds a child the owner has not seen yet.
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + row(4160, 4120, 4_000, "node.exe"));
  await agent.recheckVivaryCodeCleanup();
  await assert.rejects(resolve("end", seen), changed);
  await assert.rejects(readFile(endLog), { code: "ENOENT" }, "a stale End them tried to end nothing");
  await assert.rejects(resolve("continue", seen), changed);
  assert.equal("cleanupLifted" in metadataOf("stale-choice"), false);
  await writeFile(scanRows, SYSTEM_ROW);
  await agent.recheckVivaryCodeCleanup();
  assert.equal((metadataOf("stale-choice").cleanupLifted as { how?: string }).how, "rechecked");

  // Vivary could not scan when the owner looked, and the check before Continue anyway finds a process never shown.
  await writeFile(scanFails, "");
  seedRefusal("unscanned-choice", worker);
  await agent.recheckVivaryCodeCleanup();
  const unscanned = await shownVersion();
  await rm(scanFails);
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe"));
  await assert.rejects(resolve("continue", unscanned), changed);
  assert.equal("cleanupLifted" in metadataOf("unscanned-choice"), false);
  const host = await agent.getVivaryCodeHostState(OWNER);
  assert.deepEqual(host.cleanup?.remaining.map(({ pid }) => pid), [4120], "the strip now lists it");
  assert.equal(host.cleanup?.canEnd, true);
  assert.equal(host.cleanup?.canContinue, false);
  // End them can act on this list, so Continue anyway waits until it has run, even for a current version.
  await assert.rejects(resolve("continue", host.cleanup?.version), (error: Error & { errorCode?: string }) => {
    assert.equal(error.errorCode, "vivary_code_cleanup_not_offered");
    assert.equal(error.message, "Choose End them first. Continue anyway is offered when End them cannot end everything.");
    return true;
  });
  assert.equal("cleanupLifted" in metadataOf("unscanned-choice"), false);
  await writeFile(scanRows, SYSTEM_ROW);
  await agent.recheckVivaryCodeCleanup();
  assert.equal((metadataOf("unscanned-choice").cleanupLifted as { how?: string }).how, "rechecked");
});

// The worker left 54 children, so each check finds 55 processes, all traced to the run through the live worker,
// and a refusal lists 50 of them. Windows denies End them every one, so End them cannot bring the list under 50.
test("Continue anyway lifts an unchanged list cut at 50, and not once a process past the 50th changed", {
  ...linuxOnly, timeout: 30_000,
}, async () => {
  // Synthetic targets must never alias the real host, which cleanup deliberately refuses to end.
  const workerPid = process.pid + 4_120;
  const firstChildPid = process.pid + 5_000;
  const worker = { platform: "win32", tracked: [{ pid: workerPid, createdFrom: 1_000, createdTo: 7_000, childrenTo: null }] };
  const child = (index: number, createdMs = 3_000 + index) => row(firstChildPid + index, workerPid, createdMs, `child${index}.exe`);
  const children = Array.from({ length: 54 }, (_, index) => child(index));
  const scan = (list: readonly string[]) => writeFile(scanRows, SYSTEM_ROW + row(workerPid, 880, 2_000, "codex.exe")
    + list.join(""));
  const changed = { errorCode: "vivary_code_cleanup_changed" };
  const unlisted = async () => (await agent.getVivaryCodeHostState(OWNER)).cleanup?.unlisted;
  await writeFile(endDenied, "");
  try {
    await scan(children);
    seedRefusal("cut-unended", worker);
    await agent.recheckVivaryCodeCleanup();
    assert.equal((await decide("end")).cleanup?.canContinue, true);
    const attempts = endsOf(metadataOf("cut-unended").cleanupRefusal)?.[0]?.attempts ?? [];
    assert.deepEqual({ sent: attempts.length, failed: attempts.filter(([, outcome]) => outcome === "failed").length },
      { sent: 50, failed: 50 }, "End them ended none of the 50 it was sent");
    await assert.doesNotReject(continueAnyway(), "an unchanged list of 55 lifts although End them ended none");
    const lift = metadataOf("cut-unended").cleanupLifted as { how?: string; shown?: unknown[]; remaining?: unknown[];
      total?: number };
    assert.deepEqual({ how: lift.how, shown: lift.shown?.length, remaining: lift.remaining?.length, total: lift.total },
      { how: "owner-confirmed", shown: 50, remaining: 50, total: 55 });
    assert.equal(lastStatus("cut-unended"), "You chose to continue while these coding processes were still running: "
      + `codex.exe (PID ${workerPid}), child0.exe (PID ${firstChildPid}), child1.exe (PID ${firstChildPid + 1}), `
      + `child2.exe (PID ${firstChildPid + 2}), child3.exe (PID ${firstChildPid + 3}), and 50 more. `
      + "Vivary accepts new messages again.");

    seedRefusal("cut-changes", worker);
    await agent.recheckVivaryCodeCleanup();
    const strip = (await agent.getVivaryCodeHostState(OWNER)).cleanup;
    assert.deepEqual({ listed: strip?.remaining.length, unlisted: strip?.unlisted, instruction: strip?.instruction }, {
      listed: 50, unlisted: 5, instruction: "Choose End them to stop these processes. Vivary ends only listed "
        + "processes it can confirm came from that run, then checks again." });
    await assert.rejects(send("Start beside the cut list"), (error: Error) => {
      assert.equal(error.message, `Coding processes from an earlier run are still running: codex.exe (PID ${workerPid}), `
        + `child0.exe (PID ${firstChildPid}), child1.exe (PID ${firstChildPid + 1}), `
        + `child2.exe (PID ${firstChildPid + 2}), child3.exe (PID ${firstChildPid + 3}), and 50 more. `
        + "Choose End them at the top of Vivary to stop these processes. Vivary ends only listed processes it can "
        + "confirm came from that run, then checks again.");
      return true;
    });
    await decide("end");
    const appeared = [...children, child(54)];
    const exited = appeared.filter(line => line !== child(52));
    const restarted = exited.map(line => line === child(51) ? child(51, 4_000) : line);
    for (const [list, count, what] of [[appeared, 6, "started"], [exited, 5, "exited"],
      [restarted, 5, "changed its start time"]] as const) {
      await scan(list);
      await assert.rejects(continueAnyway(), changed, `a process past the 50th ${what}`);
      assert.equal("cleanupLifted" in metadataOf("cut-changes"), false);
      assert.equal(await unlisted(), count, "the strip counts every process the check found");
    }

    // Another check, as a send from another browser takes, finds that one more process past the 50th exited.
    const seen = (await agent.getVivaryCodeHostState(OWNER)).cleanup?.version;
    await scan(restarted.filter(line => line !== child(53)));
    await agent.recheckVivaryCodeCleanup();
    await assert.rejects(agent.resolveVivaryCodeCleanup({ ownerEmail: OWNER, decision: "continue", version: seen! }),
      changed, "the version the owner saw names every process, listed or not");
    assert.equal(await unlisted(), 4);
    assert.equal((await continueAnyway()).cleanup, null);
    assert.equal((metadataOf("cut-changes").cleanupLifted as { total?: number }).total, 54);
  } finally {
    await rm(endDenied, { force: true });
    await writeFile(scanRows, SYSTEM_ROW);
    await agent.recheckVivaryCodeCleanup();
  }
});

// A refusal whose first write failed is in force only from memory, as the failed-write case above shows. Its lift
// writes a transcript status and then the run's record, and the refusal stays in force while either write fails.
test("a refusal in force only from memory keeps refusing until its run records the lift", {
  ...linuxOnly, timeout: 20_000,
}, async t => {
  t.mock.method(console, "error", () => undefined);
  const id = "unsaved-lift";
  seedRun(id, {});
  const record = path.join(fixture, "runs", "runs", `${id}.json`);
  const transcript = path.join(fixture, "runs", "transcripts", `${id}.jsonl`);
  const intact = await readFile(record, "utf8");
  const refusedAt = new Date().toISOString();
  hostSlots().unsaved.set(id, { runId: id, target: { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000,
    createdTo: 7_000, childrenTo: 9_000 }], traced: [] }, remaining: [], total: 0, fingerprint: null, hidden: false,
  scan: "unavailable", step: "worker-exited", refusedAt, checkedAt: refusedAt, ends: [] });
  await writeFile(scanRows, SYSTEM_ROW);

  // A directory where the transcript belongs fails the status write.
  await mkdir(transcript, { recursive: true });
  await assert.rejects(agent.recheckVivaryCodeCleanup(), { code: "EISDIR" });
  assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup?.run?.id, id,
    "a lift whose transcript write failed keeps the refusal");
  await assert.rejects(send("Start past a lift that was not recorded"), { errorCode: "vivary_code_cleanup_required" });
  await rm(transcript, { recursive: true });

  // A record Vivary cannot read takes no update.
  await writeFile(record, "{");
  await assert.rejects(agent.recheckVivaryCodeCleanup(), /^Error: The run record is missing\.$/);
  assert.notEqual((await agent.getVivaryCodeHostState(OWNER)).cleanup, null,
    "a lift whose record update failed keeps the refusal");
  await writeFile(record, intact);
  assert.equal("cleanupLifted" in metadataOf(id), false);

  await agent.recheckVivaryCodeCleanup();
  assert.equal((metadataOf(id).cleanupLifted as { how?: string }).how, "rechecked");
  assert.equal(hostSlots().unsaved.has(id), false);
  assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup, null);
});

// End them ends codex.exe 4120, and the check after it finds nothing left, but a write of the lift fails. In one case
// a directory where the transcript belongs fails the status write. In the other the End call leaves the run's record
// unreadable, so the record update fails. The refusal, with what End them did, stays in force until a later check
// records the lift.
test("End them that ends processes keeps what it did in force until its run records the lift", {
  ...linuxOnly, timeout: 20_000,
}, async t => {
  t.mock.method(console, "error", () => undefined);
  const worker = { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000, childrenTo: null }] };
  for (const [id, failing] of [["end-status-unwritten", "transcript"], ["end-record-unwritten", "record"]] as const) {
    await t.test(`when the lift's ${failing} write fails`, async () => {
      const record = path.join(fixture, "runs", "runs", `${id}.json`);
      const transcript = path.join(fixture, "runs", "transcripts", `${id}.jsonl`);
      try {
        await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe"));
        seedRefusal(id, worker);
        await agent.recheckVivaryCodeCleanup();
        const intact = await readFile(record, "utf8");
        if (failing === "transcript") await mkdir(transcript, { recursive: true });
        else await writeFile(endBreaksRecord, record);
        try {
          await assert.rejects(decide("end"),
            failing === "transcript" ? { code: "EISDIR" } : /^Error: The run record is missing\.$/);
          assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup?.notice,
            "End them ended codex.exe (PID 4120).", `a lift whose ${failing} write failed keeps what End them did`);
        } finally {
          if (failing === "transcript") await rm(transcript, { recursive: true, force: true });
          else {
            await rm(endBreaksRecord, { force: true });
            await writeFile(record, intact);
          }
        }
        await agent.recheckVivaryCodeCleanup();
        const lift = metadataOf(id).cleanupLifted as { how?: string };
        assert.equal(lift.how, "rechecked");
        assert.deepEqual(endsOf(lift), [{ by: OWNER, at: "string", attempts: [[4120, "ended"]] }],
          "the lift records what End them ended");
        assert.equal(lastStatus(id), "The leftover coding processes are gone. End them ended codex.exe (PID 4120). "
          + "Vivary accepts new messages again.");
        assert.equal(hostSlots().unsaved.has(id), false);
      } finally {
        // A refusal this case leaves in force would refuse every later case.
        await writeFile(scanRows, SYSTEM_ROW);
        await agent.recheckVivaryCodeCleanup();
      }
    });
  }
});

// Under `hidepid=1` a group can hold a member Vivary reads beside an entry it cannot read. Zo runs these tests as root,
// so no scan here meets such an entry, and the refusal that scan leaves is put in force directly, with every listed
// process traced to the run, with none, and with some.
test("a refusal whose group may hold a process Vivary cannot read says so beside the list", linuxOnly, async () => {
  const slots = hostSlots();
  const before = slots.cleanup;
  const refusedAt = new Date().toISOString();
  // Synthetic targets must never alias the real host, which cleanup deliberately refuses to end.
  const sleepPid = process.pid + 4_321;
  const nodePid = process.pid + 4_322;
  const sleep = { pid: sleepPid, name: "sleep", start: 700 };
  const node = { pid: nodePid, name: "node", start: 800 };
  const unread = `Process group ${sleepPid} may also hold a process that Vivary cannot read or end. `;
  const cases: [traced: (typeof sleep)[], remaining: (typeof sleep)[], instruction: string][] = [
    [[sleep], [sleep], "Choose End them to stop these processes. Vivary ends only listed processes it can confirm "
      + "came from that run, then checks again."],
    [[], [sleep], "Vivary cannot confirm that these came from that run, so it does not end them. If they did, stop "
      + `them with \`kill -KILL -- -${sleepPid}\`, then choose Continue anyway.`],
    [[sleep], [sleep, node], "Choose End them to stop the processes confirmed from that run, then Vivary checks "
      + `again. It does not end the others. If they came from that run, stop them with \`kill -KILL -- -${sleepPid}\`.`],
  ];
  try {
    for (const [traced, remaining, instruction] of cases) {
      slots.cleanup = { runId: "hidden-beside", target: { platform: "linux", groupId: sleepPid, bootId: null,
        traced: traced.map(({ pid, start }) => ({ pid, start })) }, remaining, total: remaining.length,
      fingerprint: null, hidden: true, scan: "done", step: "group", refusedAt, checkedAt: refusedAt, ends: [] };
      assert.equal((await agent.getVivaryCodeHostState(OWNER)).cleanup?.instruction, unread + instruction);
    }
  } finally {
    slots.cleanup = before;
  }
});

// The worker 4120 left 250 children and a grandchild, more processes than a target tracks. The children exit and the
// grandchild runs on, and no tracked parent links it to the run any longer.
test("a Windows refusal whose target outgrew its cap stays in force until the owner continues", {
  ...linuxOnly, timeout: 20_000,
}, async () => {
  const children = Array.from({ length: 250 }, (_, index) => row(6_000 + index, 4120, 3_000, `child${index}.exe`));
  const grandchild = row(9_000, 6_249, 4_000, "node.exe");
  await writeFile(scanRows, SYSTEM_ROW + row(4120, 880, 2_000, "codex.exe") + children.join("") + grandchild);
  seedRefusal("outgrown", { platform: "win32", tracked: [{ pid: 4120, createdFrom: 1_000, createdTo: 7_000,
    childrenTo: null }] });
  await agent.recheckVivaryCodeCleanup();
  assert.equal((metadataOf("outgrown").cleanupRefusal as { scan?: string }).scan, "done");
  await writeFile(scanRows, SYSTEM_ROW + grandchild);
  await agent.recheckVivaryCodeCleanup();
  assert.equal("cleanupLifted" in metadataOf("outgrown"), false, "the grandchild still runs");
  const host = (await agent.getVivaryCodeHostState(OWNER)).cleanup;
  assert.deepEqual({ heading: host?.heading, canEnd: host?.canEnd, canContinue: host?.canContinue }, {
    heading: "Vivary could not confirm that an earlier run's coding processes stopped", canEnd: false, canContinue: true });
  await writeFile(scanRows, SYSTEM_ROW);
  await agent.recheckVivaryCodeCleanup();
  assert.equal("cleanupLifted" in metadataOf("outgrown"), false, "no later check reads clean");
  assert.equal((await continueAnyway()).cleanup, null);
  const lift = metadataOf("outgrown").cleanupLifted as { how?: string; scan?: string };
  assert.deepEqual({ how: lift.how, scan: lift.scan }, { how: "owner-confirmed", scan: "unavailable" });
});

test("a refusal Vivary cannot read still refuses until the owner continues", linuxOnly, async () => {
  seedRun("unreadable-refusal", { cleanupRefusal: { target: { platform: "linux", groupId: 0 }, scan: "done" } });
  await agent.recheckVivaryCodeCleanup();
  const host = await agent.getVivaryCodeHostState(OWNER);
  assert.equal(host.cleanup?.heading, "Vivary could not confirm that an earlier run's coding processes stopped");
  assert.equal(host.cleanup?.canEnd, false);
  await assert.rejects(send("Start past an unreadable refusal"), { errorCode: "vivary_code_cleanup_required" });
  assert.equal((await continueAnyway()).cleanup, null);
  assert.equal((metadataOf("unreadable-refusal").cleanupLifted as { scan?: string }).scan, "not-recorded");
});

test("shutdown refuses new sends with its own reason, and a check does not lift it", linuxOnly, async () => {
  await agent.shutdownVivaryCodeAgent();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(send("Start while shutting down"), { errorCode: "vivary_code_host_closing",
      message: "The coding host is shutting down." });
    await agent.recheckVivaryCodeCleanup();
  }
});
