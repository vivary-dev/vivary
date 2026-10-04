import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { checkStoppedWorker, checkWorkerCleanup, CLEANUP_TIMEOUT_MS, endWorkerLeftovers, executeVivaryCodeWorker, parseWindowsEndResults,
  parseWindowsProcessRows,
  readLinuxProcStat, scanLinuxWorkerGroup, STARTUP_TIMEOUT_MS, TERMINATION_GRACE_MS, VivaryCodeWorkerCleanupError,
  waitForLinuxWorkerGroupExit, windowsLeftovers, windowsWorkerStoppedCleanly, workerCleanupTarget,
  type CleanupCheck, type CleanupTarget, type WindowsProcessIdentity, type WindowsProcessRow,
} from "../server/code-execution-host.ts";
import { isVivaryCodeWorkerRequest } from "../server/code-execution-protocol.ts";
import { credentialFingerprints } from "../server/credential-redaction.ts";
import { isCredentialName } from "../server/local-runtime-setup.ts";

const request = {
  type: "vivary:code-worker:start", runId: "vivary-local-code-test",
  prompt: "Read the project note.", ownerEmail: "owner@local.vivary.test", redaction: credentialFingerprints(),
};
// Issue #121. node:test starts the next test without waiting for the body of one that timed out, and that body can
// still hold its fixture as cwd. Every test restores this cwd rather than the one it started in.
const originalCwd = process.cwd();
// Issue #121. Outlasts every budget a real worker can spend, so a slow run reports its own result, not a test timeout.
const WORKER_TEST_TIMEOUT_MS = STARTUP_TIMEOUT_MS + TERMINATION_GRACE_MS + CLEANUP_TIMEOUT_MS + 10_000;

test("worker protocol has bounded input and no path or credential fields", () => {
  assert.equal(isVivaryCodeWorkerRequest(request), true);
  for (const patch of [
    { runId: "../another-run" }, { prompt: "" }, { prompt: "x".repeat(64_001) },
    { permissionMode: "plan" }, { permissionMode: "full-auto" }, { cwd: "/another-project" }, { apiKey: "not-a-real-key" }, { orgId: "org/other" },
  ]) assert.equal(isVivaryCodeWorkerRequest({ ...request, ...patch }), false);
});

// Issue #121. The calling test's timeout bounds this wait through its signal, so a slow worker start on a loaded
// host is not a failure.
async function waitForPids(file: string, signal: AbortSignal): Promise<{ worker: number; descendant: number }> {
  for (;;) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await delay(25, undefined, { signal }); }
  }
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      if (/^State:\s+Z/m.test(status)) return false;
    }
    return true;
  } catch { return false; }
}

/** A `/proc/<pid>/stat` line with the fields the group scan reads: state, process group, and start time (field 22). */
function statLine(pid: number, name: string, state: string, group: number, start: number): string {
  return `${pid} (${name}) ${state} 1 ${group} ${group} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 100 0`;
}

const liveGroup = { members: [{ pid: 7, name: "codex", start: 900, parentPid: 1 }], hidden: false };
const emptyGroup = { members: [], hidden: false };

test("Linux worker cleanup waits until every observed group member has stopped", async () => {
  const observations = [liveGroup, emptyGroup, liveGroup, emptyGroup, emptyGroup];
  const checked: number[] = [];
  await waitForLinuxWorkerGroupExit(12345, async groupId => {
    checked.push(groupId);
    return observations.shift() ?? emptyGroup;
  });
  assert.deepEqual(checked, [12345, 12345, 12345, 12345, 12345]);
});

test("Linux stat lines give the name, state, group, and start time, and malformed lines refuse", async () => {
  assert.deepEqual(readLinuxProcStat(statLine(42, "kernel worker", "S", 0, 3)),
    { name: "kernel worker", state: "S", parentPid: 1, processGroup: 0, start: 3 });
  assert.deepEqual(readLinuxProcStat(statLine(43, "a) b (c", "Z", 12345, 8417)),
    { name: "a) b (c", state: "Z", parentPid: 1, processGroup: 12345, start: 8417 });
  for (const malformed of ["malformed", "43 (child) S 2 12345 0 0", statLine(44, "child", "S", 12345, -1)]) {
    assert.throws(() => readLinuxProcStat(malformed), VivaryCodeWorkerCleanupError, malformed);
  }
  const error = await waitForLinuxWorkerGroupExit(12345, () => new Promise(() => {}), 10).then(() => null, failure => failure);
  assert.ok(error instanceof VivaryCodeWorkerCleanupError);
  assert.equal(error.observation, undefined, "no scan completed");
});

// Issue #121. A reader stands in for `/proc` and for the kernel's answer to signal 0 on the group.
function procReader(stat: (pid: string) => Promise<string>, signal: () => void = () => undefined) {
  return { signalGroup: signal, list: async () => ["self", "42", "43", "44"], stat };
}

test("Linux group scan names live members from comm and skips zombies and other groups", async () => {
  const observation = await scanLinuxWorkerGroup(12345, procReader(async pid => pid === "42"
    ? statLine(42, "my ) app", "S", 12345, 777) : pid === "43" ? statLine(43, "vivary-worker", "Z", 12345, 700)
      : statLine(44, "unrelated", "S", 999, 800)));
  assert.deepEqual(observation, { members: [{ pid: 42, name: "my ) app", start: 777, parentPid: 1 }], hidden: false });
});

test("Linux group scan trusts the kernel when no process has the group id and never reads /proc", async () => {
  const error = (code: string) => () => { throw Object.assign(new Error(`signal failed with ${code}`), { code }); };
  const unread = { signalGroup: error("ESRCH"), list: async () => assert.fail("/proc was read"), stat: async () => "" };
  assert.deepEqual(await scanLinuxWorkerGroup(12345, unread), { members: [], hidden: false });
  const present = procReader(async pid => statLine(Number(pid), "codex", "S", 12345, 1), error("EPERM"));
  assert.equal((await scanLinuxWorkerGroup(12345, present)).members.length, 3, "EPERM means the group exists");
  await assert.rejects(scanLinuxWorkerGroup(12345, procReader(async () => "", error("EINVAL"))), VivaryCodeWorkerCleanupError);
});

// Issue #121. On a Linux kernel, reading the `stat` file of a process reaped after the scan opened it fails with
// ESRCH. That process is gone. Under `hidepid=1` another user's entry fails with EACCES or EPERM, which must not fail
// the stop. Any other read error must still fail it.
test("Linux group scan tolerates gone and unreadable entries and refuses other read errors", async () => {
  const procWithStatError = (code: string, zombie: boolean) => procReader(async pid => {
    if (pid === "42") throw Object.assign(new Error(`reading /proc/42/stat failed with ${code}`), { code });
    if (pid === "44" && zombie) return statLine(44, "vivary-worker", "Z", 12345, 700);
    return statLine(Number(pid), "unrelated", "S", 999, 800);
  });
  for (const code of ["ENOENT", "ESRCH"]) {
    assert.deepEqual(await scanLinuxWorkerGroup(12345, procWithStatError(code, true)), emptyGroup, code);
  }
  // The group exists, so an unreadable entry could be the member. So could one `/proc` no longer shows.
  for (const code of ["EACCES", "EPERM"]) {
    assert.deepEqual(await scanLinuxWorkerGroup(12345, procWithStatError(code, true)), { members: [], hidden: true }, code);
  }
  assert.deepEqual(await scanLinuxWorkerGroup(12345, procWithStatError("ENOENT", false)), { members: [], hidden: true });
  await assert.rejects(scanLinuxWorkerGroup(12345, procWithStatError("EIO", true)), VivaryCodeWorkerCleanupError);
});

// Issue #121. Under `hidepid=1` a group can hold a member Vivary reads beside an entry it cannot read, which could be
// another member. The kernel says the group exists, so the scan lists the member and marks the group hidden.
test("Linux group scan marks an unreadable entry hidden beside a member it can read", async () => {
  const observation = await scanLinuxWorkerGroup(12345, procReader(async pid => {
    if (pid === "42") throw Object.assign(new Error("reading /proc/42/stat failed with EACCES"), { code: "EACCES" });
    return pid === "43" ? statLine(43, "codex", "S", 12345, 700) : statLine(44, "unrelated", "S", 999, 800);
  }));
  assert.deepEqual(observation, { members: [{ pid: 43, name: "codex", start: 700, parentPid: 1 }], hidden: true });
});

// Issue #121. Each scan advances the mocked clock by a second, so these cases take milliseconds.
test("Linux worker cleanup accepts a group that empties after more than 3 seconds", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  let scans = 0;
  await waitForLinuxWorkerGroupExit(12345, async () => {
    t.mock.timers.tick(1_000);
    return ++scans <= 5 ? liveGroup : emptyGroup;
  });
  assert.equal(scans, 7, "five scans with live members, then two empty scans");
});

test("Linux worker cleanup trusts an empty scan that finished after the deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  for (const scanMs of [600, 1_500]) {
    await waitForLinuxWorkerGroupExit(12345, async () => {
      t.mock.timers.tick(scanMs);
      return emptyGroup;
    }, 1_000);
  }
});

test("Linux worker cleanup refuses a group that stays live for the whole budget and names what it saw", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  let scans = 0;
  const hidden = { members: [], hidden: true };
  const error = await waitForLinuxWorkerGroupExit(12345, async () => {
    t.mock.timers.tick(1_000);
    return ++scans === CLEANUP_TIMEOUT_MS / 1_000 ? hidden : liveGroup;
  }).then(() => null, failure => failure);
  assert.ok(error instanceof VivaryCodeWorkerCleanupError);
  assert.equal(scans, CLEANUP_TIMEOUT_MS / 1_000, "every scan inside the budget ran");
  assert.deepEqual(error.observation, hidden, "the last completed scan");
});

// Issue #121. A real process group on the kernel in use, or on gVisor on Zo. `sleep` leads its own group, as the
// worker does.
test("a cleanup check finds a live group by name and reads an emptied one as clean", {
  skip: process.platform !== "linux",
}, async () => {
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const groupId = sleeper.pid!;
  const exited = once(sleeper, "exit");
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const target = { platform: "linux" as const, groupId, bootId, traced: [] };
    const live = await checkWorkerCleanup(target);
    assert.ok(live.result === "remaining");
    assert.deepEqual(live.remaining.map(({ pid, name }) => ({ pid, name })), [{ pid: groupId, name: "sleep" }]);
    assert.equal(live.hidden, false);
    assert.ok(Number.isSafeInteger(live.remaining[0]!.start));
    assert.deepEqual(live.target.traced, [], "a later check traces nothing the stop did not");
    // An unknown boot id, then or now, is no evidence of a reboot, so the group is still scanned.
    const noCurrentBootId = { bootId: async () => null, windowsProcesses: async () => [], windowsEnd: async () => [],
      proc: { signalGroup: (id: number) => { process.kill(-id, 0); }, list: () => readdir("/proc"),
        stat: (pid: string) => readFile(`/proc/${pid}/stat`, "utf8"), kill: () => assert.fail("a check ended a process") } };
    for (const check of [await checkWorkerCleanup({ ...target, bootId: null }),
      await checkWorkerCleanup(target, noCurrentBootId)]) assert.equal(check.result, "remaining");
    process.kill(-groupId, "SIGKILL");
    await exited;
    assert.deepEqual(await checkWorkerCleanup(target), { result: "clean" });
    const rebooted = { bootId: async () => "another-boot", windowsProcesses: async () => [], windowsEnd: async () => [],
      proc: { signalGroup: () => assert.fail("a group from before a reboot was signaled"),
        list: async () => [], stat: async () => "", kill: () => assert.fail("a check ended a process") } };
    assert.deepEqual(await checkWorkerCleanup(target, rebooted), { result: "clean" });
  } finally {
    if (sleeper.exitCode === null && sleeper.signalCode === null) process.kill(-groupId, "SIGKILL");
  }
});

/** A Windows creation time as the scan prints it: 100-nanosecond intervals since 1601, from Unix milliseconds. */
function filetime(unixMs: number): string {
  return String(BigInt(unixMs) * 10_000n + 116_444_736_000_000_000n);
}

// Issue #121. The scan prints a creation time on every row but the System Idle Process (PID 0) and System (PID 4), then
// a last line with the row count. Under Constrained Language Mode the script before this change printed every row
// without a creation time and no count.
test("Windows process rows parse only from a complete scan with a creation time on every ordinary row", () => {
  const codex = `4120\t880\t${filetime(1790553600123)}\tcodex.exe`;
  assert.deepEqual(parseWindowsProcessRows(`\uFEFF0\t0\t\tSystem Idle Process\r\n4\t0\t\tSystem\r\n${codex}\r\n\r\nEND\t3\r\n`), [
    { pid: 0, parentPid: 0, created: null, name: "System Idle Process" },
    { pid: 4, parentPid: 0, created: null, name: "System" },
    { pid: 4120, parentPid: 880, created: 1790553600123, name: "codex.exe" },
  ]);
  for (const [name, output] of [
    ["the earlier script under Constrained Language Mode", "4\t0\t\tSystem\r\n4120\t880\t\tcodex.exe\r\n"],
    ["an ordinary row without a creation time", "4\t0\t\tSystem\r\n4120\t880\t\tcodex.exe\r\nEND\t2\r\n"],
    ["output cut before the count", `4\t0\t\tSystem\r\n${codex}\r\n`],
    ["output cut inside a row", `4\t0\t\tSystem\r\n${codex.slice(0, 16)}`],
    ["a count that differs from the rows", `4\t0\t\tSystem\r\n${codex}\r\nEND\t3\r\n`],
    ["a count that is not last", `4\t0\t\tSystem\r\nEND\t1\r\n${codex}\r\n`],
    ["no rows", "END\t0\r\n"], ["nothing", ""], ["a blank line", "\r\n"],
    ["a row with three fields", `4120\t880\t${filetime(1790553600123)}\r\nEND\t1\r\n`],
    ["a warning line", `4\t0\t\tSystem\r\nWARNING: something\r\nEND\t2\r\n`],
  ]) assert.equal(parseWindowsProcessRows(output), null, name);
});

// Issue #121. The worker (PID 100) was forked between 1,000 and 7,000. A process is traced when End them may end it.
test("Windows leftovers follow parent PIDs by creation time and trace only through live parents", () => {
  const live = { pid: 100, createdFrom: 1_000, createdTo: 7_000, childrenTo: null };
  const exited = { ...live, childrenTo: 9_000 };
  const exact = (pid: number, created: number) => ({ pid, createdFrom: created, createdTo: created, childrenTo: null });
  const row = (pid: number, parentPid: number, created: number | null, name = `p${pid}.exe`) =>
    ({ pid, parentPid, created, name });
  const cases = [
    { name: "a live worker with a child and a grandchild", tracked: [live], traced: [],
      rows: [row(4, 0, null), row(100, 50, 2_000), row(200, 100, 3_000), row(300, 200, 4_000), row(400, 50, 2_500)],
      found: [100, 200, 300], endable: [100, 200, 300] },
    { name: "an exited worker's child inside its window", tracked: [exited], traced: [], rows: [row(200, 100, 8_000)],
      found: [200], endable: [200] },
    { name: "a child created after the worker's exit window", tracked: [exited], traced: [],
      rows: [row(201, 100, 9_500)], found: [], endable: [] },
    { name: "the child of a process that reused the worker's PID", tracked: [live], traced: [],
      rows: [row(100, 60, 20_000), row(202, 100, 21_000)], found: [], endable: [] },
    { name: "children created before the worker or before their parent", tracked: [live], traced: [],
      rows: [row(100, 50, 2_000), row(203, 100, 500), row(200, 100, 3_000), row(301, 200, 2_900)],
      found: [100, 200], endable: [100, 200] },
    { name: "a traced grandchild whose parent exited, and its live child", tracked: [exited, exact(300, 4_000)],
      traced: [{ pid: 300, start: 4_000 }], rows: [row(300, 200, 4_000), row(301, 300, 5_000)],
      found: [300, 301], endable: [300, 301] },
    { name: "the child of an exited process, whose PID another program may have reused",
      tracked: [exited, exact(300, 4_000)], traced: [{ pid: 300, start: 4_000 }], rows: [row(500, 300, 20_000)],
      found: [500], endable: [] },
    { name: "the child of a worker whose exit was never observed", tracked: [live], traced: [],
      rows: [row(204, 100, 8_000)], found: [204], endable: [] },
  ];
  for (const { name, tracked, traced, rows, found, endable } of cases) {
    const result = windowsLeftovers(rows, tracked, traced);
    const pids = (processes: { pid: number }[]) => processes.map(({ pid }) => pid).sort((a, b) => a - b);
    assert.deepEqual(pids(result.remaining), found, name);
    assert.deepEqual(pids(result.remaining.filter(leftover => result.traced.some(({ pid, start }) =>
      pid === leftover.pid && start === leftover.start))), endable, `${name}: traced`);
    for (const leftover of result.remaining) {
      assert.equal(leftover.start, rows.find(candidate => candidate.pid === leftover.pid)?.created, name);
      assert.ok(result.tracked.some(identity => identity.pid === leftover.pid && identity.createdFrom === leftover.start
        && identity.createdTo === leftover.start), `${name}: ${leftover.pid} is tracked exactly`);
    }
    assert.deepEqual(result.tracked.slice(0, tracked.length), tracked, `${name}: earlier identities stay first`);
    assert.deepEqual(result.traced.slice(0, traced.length), traced, `${name}: earlier traced processes stay first`);
  }
  const many = [row(100, 50, 2_000), ...Array.from({ length: 250 }, (_, index) => row(1_000 + index, 100, 3_000))];
  const capped = windowsLeftovers(many, [live], []);
  assert.equal(capped.remaining.length, 251);
  assert.equal(capped.tracked.length, 200);
  assert.deepEqual(capped.tracked[0], live);
  assert.equal(capped.traced.length, 200);
});

// Issue #121. A target keeps at most 200 identities. In these cases the first scan finds the live worker 100 and
// processes it started. In the second a grandchild still runs whose parent has exited, so only its own identity links
// it to the run.
const liveWorker = { pid: 100, createdFrom: 1_000, createdTo: 7_000, childrenTo: null };
const scanRow = (pid: number, parentPid: number, created: number) => ({ pid, parentPid, created, name: `p${pid}.exe` });

/** Checks a Windows target once for each scan, carrying the target each check returns into the next. */
async function checksOf(tracked: WindowsProcessIdentity[], scans: WindowsProcessRow[][]): Promise<CleanupCheck[]> {
  let rows: WindowsProcessRow[] = [];
  const io = { bootId: async () => null, windowsProcesses: async () => rows,
    windowsEnd: async () => assert.fail("a check ended a process"),
    proc: { signalGroup: () => undefined, list: async () => [], stat: async () => "", kill: () => undefined } };
  const results: CleanupCheck[] = [];
  let target: CleanupTarget = { platform: "win32", tracked, traced: [] };
  for (const scan of scans) {
    rows = scan;
    const check = await checkWorkerCleanup(target, io);
    results.push(check);
    if (check.result === "remaining") target = check.target;
  }
  return results;
}

test("a Windows target past its cap drops identities the scan found gone to keep the new ones", async () => {
  const gone = Array.from({ length: 199 }, (_, index) => ({ pid: 10_000 + index, createdFrom: 2_000, createdTo: 2_000,
    childrenTo: null }));
  const [, later] = await checksOf([liveWorker, ...gone], [
    [scanRow(100, 50, 2_000), scanRow(300, 100, 3_000), scanRow(400, 300, 4_000)], [scanRow(400, 300, 4_000)]]);
  assert.deepEqual(later?.result === "remaining" && later.remaining.map(({ pid }) => pid), [400],
    "the grandchild is found after its parent exits");
});

test("a Windows target with more live processes than its cap reads unavailable, never clean", async () => {
  const children = Array.from({ length: 250 }, (_, index) => scanRow(1_000 + index, 100, 3_000));
  const [first, ...later] = await checksOf([liveWorker], [
    [scanRow(100, 50, 2_000), ...children, scanRow(9_000, 1_249, 4_000)], [scanRow(9_000, 1_249, 4_000)], []]);
  assert.equal(first?.result === "remaining" && first.remaining.length, 252);
  assert.deepEqual(later, [{ result: "unavailable", reason: "tracking-overflow" }, { result: "unavailable", reason: "tracking-overflow" }],
    "a target that could not keep every identity never reads clean");
});

// Issue #121. A reader that shows group 12345: the traced 42, its child 43, a stranger 44 that another program started,
// and 45, which names 42 as its parent but started before it.
test("a Linux check traces only children of a traced member that started after it", async () => {
  const withParent = (line: string, parentPid: number) => line.replace(" S 1 ", ` S ${parentPid} `);
  const members: Record<string, string> = {
    42: statLine(42, "codex", "S", 12345, 700), 43: withParent(statLine(43, "node", "S", 12345, 800), 42),
    44: statLine(44, "stranger", "S", 12345, 900), 45: withParent(statLine(45, "early", "S", 12345, 600), 42),
  };
  const io = { bootId: async () => null, windowsProcesses: async () => [], windowsEnd: async () => [],
    proc: { signalGroup: () => undefined, list: async () => Object.keys(members), stat: async (pid: string) => members[pid]!,
      kill: () => assert.fail("a check ended a process") } };
  const check = await checkWorkerCleanup({ platform: "linux", groupId: 12345, bootId: null,
    traced: [{ pid: 42, start: 700 }] }, io);
  assert.ok(check.result === "remaining");
  assert.deepEqual(check.remaining.map(({ pid }) => pid), [42, 43, 44, 45], "every member is listed");
  assert.deepEqual(check.target.traced, [{ pid: 42, start: 700 }, { pid: 43, start: 800 }]);
});

// Issue #121. A target traces at most 200 processes. Group 12345 holds the worker 100 and 250 children it started, so
// the check right after the failed stop traces the first 200 it reads. The owner then ends 60 of those, and the worker
// still runs, so a later check traces its children that found no room before.
test("a Linux target past its traced cap drops ended processes to trace the rest", async () => {
  const members = new Map<number, string>([[100, statLine(100, "codex", "S", 12345, 700)],
    ...Array.from({ length: 250 }, (_, index): [number, string] =>
      [101 + index, statLine(101 + index, "node", "S", 12345, 800).replace(" S 1 ", " S 100 ")])]);
  const io = { bootId: async () => null, windowsProcesses: async () => [], windowsEnd: async () => [],
    proc: { signalGroup: () => undefined, list: async () => [...members.keys()].map(String),
      stat: async (pid: string) => members.get(Number(pid)) ?? assert.fail(`read ${pid}`),
      kill: () => assert.fail("a check ended a process") } };
  const stopped = await checkStoppedWorker({ platform: "linux", groupId: 12345, bootId: null, traced: [] }, io);
  assert.ok(stopped.result === "remaining");
  assert.equal(stopped.target.traced.length, 200);
  for (let pid = 101; pid <= 160; pid += 1) members.delete(pid);
  const later = await checkWorkerCleanup(stopped.target, io);
  assert.ok(later.result === "remaining");
  assert.equal(later.remaining.length, 191);
  const untraced = later.remaining.filter(({ pid, start }) => !later.target.traced.some(traced =>
    traced.pid === pid && traced.start === start));
  assert.deepEqual(untraced.map(({ pid }) => pid), [], "every live child of the traced worker is traced");
});

const errno = (code: string) => Object.assign(new Error(`failed with ${code}`), { code });

// Issue #121. The host just stopped the worker's group or tree, so the check right after a failed stop traces every
// process it finds, and End them may end them. A later check traces only what descends from those. On Linux the reader
// shows group 12345 with 42 and its child 43. On Windows the live worker 100's own row is gone, and its child 200 is
// found through the worker's identity, which alone would not trace it.
test("the check right after a failed stop traces every process it finds", async () => {
  const members: Record<string, string> = {
    42: statLine(42, "codex", "S", 12345, 700), 43: statLine(43, "node", "S", 12345, 800).replace(" S 1 ", " S 42 "),
  };
  const io = { bootId: async () => null, windowsEnd: async () => assert.fail("a check ended a process"),
    windowsProcesses: async () => [{ pid: 200, parentPid: 100, created: 3_000, name: "codex.exe" }],
    proc: { signalGroup: () => undefined, list: async () => Object.keys(members), stat: async (pid: string) => members[pid]!,
      kill: () => assert.fail("a check ended a process") } };
  const group = { platform: "linux" as const, groupId: 12345, bootId: null, traced: [] };
  const worker = { platform: "win32" as const, traced: [],
    tracked: [{ pid: 100, createdFrom: 1_000, createdTo: 7_000, childrenTo: null }] };
  for (const [target, traced] of [[group, [{ pid: 42, start: 700 }, { pid: 43, start: 800 }]],
    [worker, [{ pid: 200, start: 3_000 }]]] as const) {
    const stopped = await checkStoppedWorker(target, io);
    assert.ok(stopped.result === "remaining", target.platform);
    assert.deepEqual(stopped.target.traced, traced, `${target.platform}: the check after the stop traces them`);
    const later = await checkWorkerCleanup(target, io);
    assert.ok(later.result === "remaining", target.platform);
    assert.deepEqual(later.target.traced, [], `${target.platform}: a later check does not`);
  }
});

// Issue #121. Group 12345 holds the traced 42 and its child 43. Ending 43 lets 42 exit, and another process takes PID
// 42 before End them reaches it. End them reads each `stat` again right before its kill, so it skips that process.
test("End them on Linux reads each process again right before its kill and skips one whose start changed", async () => {
  const table = new Map([[42, { name: "codex", start: 700 }], [43, { name: "node", start: 800 }]]);
  const kills: number[] = [];
  const kill = (pid: number) => {
    kills.push(pid);
    table.delete(pid);
    if (pid === 43) table.set(42, { name: "stranger", start: 999 });
  };
  const proc = {
    signalGroup: () => { if (!table.size) throw errno("ESRCH"); },
    list: async () => [...table.keys()].map(String),
    stat: async (pid: string) => {
      const entry = table.get(Number(pid));
      if (!entry) throw errno("ENOENT");
      return statLine(Number(pid), entry.name, "S", 12345, entry.start);
    },
    kill,
  };
  const io = { bootId: async () => null, proc, windowsProcesses: async () => assert.fail("Windows was scanned"),
    windowsEnd: async () => assert.fail("Windows End ran") };
  const shown = [{ pid: 42, name: "codex", start: 700 }, { pid: 43, name: "node", start: 800 }];
  const result = await endWorkerLeftovers({ platform: "linux", groupId: 12345, bootId: null,
    traced: shown.map(({ pid, start }) => ({ pid, start })) }, shown, io);
  assert.deepEqual(kills, [43], "the process that took PID 42 is never ended");
  assert.deepEqual(result.attempts, [{ ...shown[1], outcome: "ended" },
    { ...shown[0], outcome: "mismatched" }]);
});

// Issue #121. Windows ends every process in one PowerShell call that checks each creation time through the handle it
// ends the process with. This host, a process the owner was not shown, and one never traced to the run are not passed.
test("End them on Windows hands the shown traced processes to one identity-checked call, newest first", async () => {
  const calls: unknown[] = [];
  const codex = { pid: 4120, name: "codex.exe", start: 2_000 };
  const node = { pid: 4130, name: "node.exe", start: 3_000 };
  const stranger = { pid: 4140, name: "stranger.exe", start: 3_500 };
  const host = { pid: process.pid, name: "Vivary.exe", start: 1_000 };
  const rows = [codex, node, stranger, host].map(({ pid, name, start }) => ({ pid, parentPid: 1, created: start, name }));
  const io = { bootId: async () => null, proc: { signalGroup: () => assert.fail("a group was signaled"),
    list: async () => assert.fail("/proc was read"), stat: async () => assert.fail("/proc was read"),
    kill: () => assert.fail("a Linux kill ran") },
    windowsProcesses: async () => rows,
    windowsEnd: async (processes: { pid: number; name: string; start: number }[]) => {
      calls.push(["end", processes.map(({ pid, start }) => [pid, start])]);
      return processes.map(leftover => ({ ...leftover, outcome: leftover.pid === node.pid ? "failed" : "ended" }));
    } };
  const unseen = { pid: 4150, name: "late.exe", start: 3_600 };
  const traced = [codex, node, host, unseen].map(({ pid, start }) => ({ pid, start }));
  const tracked = [codex, node, stranger, host].map(({ pid, start }) =>
    ({ pid, createdFrom: start, createdTo: start, childrenTo: null }));
  const result = await endWorkerLeftovers({ platform: "win32", tracked, traced }, [codex, node, stranger, host], io);
  assert.deepEqual(calls, [["end", [[4130, 3_000], [4120, 2_000]]]], "one call, and never taskkill");
  assert.deepEqual(result.attempts, [{ ...node, outcome: "failed" },
    { ...codex, outcome: "ended" }]);

  const unread = await endWorkerLeftovers({ platform: "win32", tracked, traced }, [codex, node],
    { ...io, windowsEnd: async () => { throw new Error("The Windows end step printed output Vivary cannot read."); } });
  assert.deepEqual(unread.attempts, [{ ...node, outcome: "unknown" }, { ...codex, outcome: "unknown" }],
    "an End call that fails, or whose output Vivary cannot read, leaves each process it was sent unknown");
});

test("End them on Linux reports each process as ended, mismatched, gone, or failed", async () => {
  const members: Record<string, string> = {
    50: statLine(50, "codex", "S", 12345, 500), 51: statLine(51, "moved", "S", 999, 510),
    52: statLine(52, "reaped", "Z", 12345, 520), 54: statLine(54, "setuid", "S", 12345, 540),
  };
  const kills: number[] = [];
  const proc = { signalGroup: () => { throw errno("ESRCH"); }, list: async () => [],
    stat: async (pid: string) => {
      if (pid === "53") throw errno("ENOENT");
      return members[pid] ?? assert.fail(`read ${pid}`);
    },
    kill: (pid: number) => { kills.push(pid); if (pid === 54) throw errno("EPERM"); } };
  const shown = [{ pid: 50, name: "codex", start: 500 }, { pid: 51, name: "moved", start: 510 },
    { pid: 52, name: "reaped", start: 520 }, { pid: 53, name: "exited", start: 530 },
    { pid: 54, name: "setuid", start: 540 }];
  const target = { platform: "linux" as const, groupId: 12345, bootId: "11111111-1111-4111-8111-111111111111",
    traced: shown.map(({ pid, start }) => ({ pid, start })) };
  const io = { bootId: async () => target.bootId, proc, windowsProcesses: async () => assert.fail("Windows was scanned"),
    windowsEnd: async () => assert.fail("Windows End ran") };
  const result = await endWorkerLeftovers(target, shown, io);
  assert.deepEqual(result.attempts?.map(({ pid, outcome }) => [pid, outcome]),
    [[54, "failed"], [53, "gone"], [52, "gone"], [51, "mismatched"], [50, "ended"]]);
  assert.deepEqual(kills, [54, 50], "a process in another group, a zombie, and an exited PID are not signaled");
  assert.deepEqual(result.check, { result: "clean" });

  const rebooted = await endWorkerLeftovers(target, shown, { ...io, bootId: async () => "22222222-2222-4222-8222-222222222222",
    proc: { ...proc, stat: async () => assert.fail("a PID from before a reboot was read") } });
  assert.deepEqual(rebooted.attempts?.map(({ outcome }) => outcome), ["gone", "gone", "gone", "gone", "gone"]);
});

test("the Windows End output gives one outcome per process in order and then counts them", () => {
  const processes = [{ pid: 4130, name: "node.exe", start: 3_000 }, { pid: 4120, name: "codex.exe", start: 2_000 }];
  assert.deepEqual(parseWindowsEndResults("﻿4130\tfailed\r\n4120\tended\r\nEND\t2\r\n", processes),
    [{ ...processes[0], outcome: "failed" }, { ...processes[1], outcome: "ended" }]);
  for (const [name, output] of [
    ["cut before the count", "4130\tfailed\r\n4120\tended\r\n"],
    ["a missing process", "4130\tfailed\r\nEND\t1\r\n"],
    ["the processes out of order", "4120\tended\r\n4130\tfailed\r\nEND\t2\r\n"],
    ["an unknown outcome", "4130\tkilled\r\n4120\tended\r\nEND\t2\r\n"],
    ["an error line", "4130\tfailed\r\nGet-Process : denied\r\nEND\t2\r\n"],
    ["nothing", ""],
  ]) assert.equal(parseWindowsEndResults(output, processes), null, name);
});


test("only a Windows worker that exited before its run was sent counts as stopped", () => {
  const cases = [
    { platform: "win32", workerExited: true, runSent: false, clean: true },
    { platform: "win32", workerExited: true, runSent: true, clean: false },
    { platform: "win32", workerExited: false, runSent: false, clean: false },
    { platform: "linux", workerExited: true, runSent: false, clean: false },
  ] as const;
  for (const { clean, ...worker } of cases) assert.equal(windowsWorkerStoppedCleanly(worker), clean, JSON.stringify(worker));
});

// The abort case waits out the grace, and either case can spend the whole cleanup budget. A true cleanup failure
// then reports its own error instead of a test timeout.
test("native-complete and aborted workers stop descendants before settling", {
  timeout: WORKER_TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-"));
  const server = path.join(fixture, ".output", "server");
  const pids = path.join(fixture, "pids.json");
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ worker: process.pid, descendant: descendant.pid }));
  if (message.prompt === "complete") setTimeout(() => process.send({type:"vivary:code-worker:done",runId:message.runId}), 80);
});
process.send({type:"vivary:code-worker:ready"});
`);
  let controller: AbortController | undefined;
  let execution: Promise<void> | undefined;
  try {
    process.chdir(fixture);
    for (const mode of ["complete", "abort"]) {
      await rm(pids, { force: true });
      controller = new AbortController();
      execution = executeVivaryCodeWorker({
        runId: request.runId, prompt: mode, ownerEmail: request.ownerEmail, signal: controller.signal,
      });
      const identities = await waitForPids(pids, t.signal);
      if (mode === "abort") {
        controller.abort();
        await assert.rejects(execution, { name: "AbortError" });
      } else {
        await execution;
      }
      assert.equal(await isAlive(identities.worker), false);
      assert.equal(await isAlive(identities.descendant), false);
    }
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(executeVivaryCodeWorker({
      runId: request.runId, prompt: "complete", ownerEmail: request.ownerEmail, signal: canceled.signal,
    }), { name: "AbortError" });
  } finally {
    process.chdir(originalCwd);
    // A wait that the test's timeout ended leaves the detached worker and its descendant running until this stop.
    controller?.abort();
    await execution?.catch(() => undefined);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the coding worker starts without any credential-shaped name in its environment", { timeout: WORKER_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-environment-"));
  const server = path.join(fixture, ".output", "server");
  const names = path.join(fixture, "names.json");
  await mkdir(server, { recursive: true });
  // Issue #98. On Linux a child reads its parent's start environment, as a command in a coding run could.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const readParent = "const entries = require('node:fs').readFileSync('/proc/' + process.ppid + '/environ', 'utf8');"
  + "process.stdout.write(JSON.stringify(entries.split(String.fromCharCode(0)).filter(Boolean)"
  + ".map(entry => entry.slice(0, entry.indexOf('=')))));";
writeFileSync(${JSON.stringify(names)}, process.platform === "linux"
  ? execFileSync(process.execPath, ["-e", readParent], { encoding: "utf8", env: {} })
  : JSON.stringify(Object.keys(process.env)));
process.on("message", message => {
  if (message.type === "vivary:code-worker:start") process.send({ type: "vivary:code-worker:done", runId: message.runId });
});
process.send({ type: "vivary:code-worker:ready" });
`);
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  const credentialName = `VIVARY_PROBE_${suffix}_TOKEN`;
  const controlName = `VIVARY_PROBE_${suffix}_SETTING`;
  const seeded = Object.fromEntries(["BETTER_AUTH_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY", credentialName,
    controlName, "VIVARY_DESKTOP_HOST", "VIVARY_STANDALONE_HOST"].map(name => [name, randomBytes(24).toString("hex")]));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, seeded);
    process.chdir(fixture);
    await executeVivaryCodeWorker({ runId: request.runId, prompt: "report the start environment",
      ownerEmail: request.ownerEmail, signal: new AbortController().signal });
    const started: string[] = JSON.parse(await readFile(names, "utf8"));
    assert.ok(started.includes(controlName), "an ordinary setting reaches the worker");
    assert.deepEqual(started.filter(name => isCredentialName(name.toUpperCase())), [],
      "credential-shaped names in the worker's start environment");
    assert.deepEqual(started.filter(name => name === "VIVARY_DESKTOP_HOST" || name === "VIVARY_STANDALONE_HOST"), []);
  } finally {
    for (const name of Object.keys(seeded)) {
      // guard:allow-env-credential - Removes a random test setting seeded above.
      if (previous[name] === undefined) delete process.env[name];
      else Object.assign(process.env, { [name]: previous[name] });
    }
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a worker that reports ready after a stop request never receives its run", { timeout: WORKER_TEST_TIMEOUT_MS }, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-late-ready-"));
  const server = path.join(fixture, ".output", "server");
  const loaded = path.join(fixture, "loaded.json");
  const received = path.join(fixture, "received-run.txt");
  const readySent = path.join(fixture, "ready-sent.txt");
  await mkdir(server, { recursive: true });
  // Issue #117. This worker reports ready only once the host has asked it to stop, like a worker that loads too slowly.
  // It exits after 8 seconds even when the host never stops it, so it cannot outlive the test by more than 8 seconds.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
setTimeout(() => process.exit(0), 8_000).unref();
process.on("message", message => {
  if (message.type === "vivary:code-worker:start") {
    writeFileSync(${JSON.stringify(received)}, "received");
    process.exit(0);
  }
  if (message.type === "vivary:code-worker:abort") {
    writeFileSync(${JSON.stringify(readySent)}, "sent");
    process.send({ type: "vivary:code-worker:ready" });
    setTimeout(() => process.exit(0), 500);
  }
});
writeFileSync(${JSON.stringify(loaded)}, JSON.stringify({ worker: process.pid }));
`);
  try {
    process.chdir(fixture);
    for (const stop of ["startup deadline", "abort"] as const) await t.test(stop, async t => {
      await rm(loaded, { force: true });
      await rm(received, { force: true });
      await rm(readySent, { force: true });
      const controller = new AbortController();
      try {
        if (stop === "startup deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
        const outcome = executeVivaryCodeWorker({ runId: request.runId, prompt: "start late", ownerEmail: request.ownerEmail,
          signal: controller.signal }).then(() => null, (error: unknown) => error);
        const { worker } = await waitForPids(loaded, t.signal);
        if (stop === "startup deadline") {
          t.mock.timers.tick(STARTUP_TIMEOUT_MS);
          t.mock.timers.reset();
        } else {
          controller.abort();
        }
        const error = await outcome;
        await assert.doesNotReject(readFile(readySent), "the worker never sent its late ready");
        assert.equal(await isAlive(worker), false, "the worker was still running after its run settled");
        await assert.rejects(readFile(received), { code: "ENOENT" }, "the worker received its run after the stop request");
        assert.ok(error instanceof Error);
        if (stop === "startup deadline") assert.equal(error.message, `The coding worker did not start within ${STARTUP_TIMEOUT_MS / 1_000} seconds.`);
        else assert.equal(error.name, "AbortError");
      } finally {
        const pid = await readFile(loaded, "utf8").then(text => Number(JSON.parse(text).worker), () => 0);
        if (pid && await isAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
    });
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("worker relays native approvals and remains active beyond the former turn deadline", { timeout: WORKER_TEST_TIMEOUT_MS }, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-request-"));
  const server = path.join(fixture, ".output", "server");
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import {writeFileSync} from "node:fs";
let runId;
process.on("message", message => {
 if(message.type === "vivary:code-worker:start") {
  runId=message.runId;
  const request={requestId:"native-id",method:"item/commandExecution/requestApproval",params:{command:"read fixture"}};
  process.send({type:"vivary:code-worker:request",runId:"foreign-run",request});
  process.send({type:"vivary:code-worker:request",runId,request});
 }
 if(message.type === "vivary:code-worker:response") {
  writeFileSync("response.json",JSON.stringify(message));
  process.send({type:"vivary:code-worker:resolved",runId,requestId:message.requestId});
  process.send({type:"vivary:code-worker:done",runId});
 }
 if(message.type === "vivary:code-worker:abort") writeFileSync("aborted.txt","aborted");
});
process.send({type:"vivary:code-worker:ready"});
`);
  let resolveRequest: ((value: Record<string, unknown>) => void) | undefined;
  let requestArrived: () => void = () => undefined;
  const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
  const received: string[] = [], resolved: string[] = [];
  let finished = false;
  const controller = new AbortController();
  let execution: Promise<void> | undefined;
  try {
    process.chdir(fixture);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    execution = executeVivaryCodeWorker({ runId: request.runId, prompt: "wait for action", ownerEmail: request.ownerEmail,
      signal: controller.signal, permissionMode: "normal",
      onRequest: action => {
        received.push(action.requestId);
        requestArrived();
        return new Promise(resolve => { resolveRequest = resolve; });
      },
      onRequestResolved: id => { resolved.push(id); },
    });
    // Issue #121. The rejection handler keeps a stopped run from replacing this test's own failure.
    void execution.then(() => { finished = true; }, () => undefined);
    // Wait for the request itself, however long the worker takes to start. A run that ends first fails the test, and
    // the test's timeout ends the wait so that `finally` runs.
    await Promise.race([arrived, execution, once(t.signal, "abort")]);
    assert.ok(resolveRequest, "the approval request arrived before the test timed out");
    t.mock.timers.tick(120_001);
    await delay(20);
    assert.equal(finished, false);
    await assert.rejects(readFile(path.join(fixture, "aborted.txt")), { code: "ENOENT" });
    assert.deepEqual(received, ["native-id"]);
    t.mock.timers.reset();
    resolveRequest({ decision: "decline" });
    await execution;
    assert.deepEqual(resolved, ["native-id"]);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture, "response.json"), "utf8")),
      { type: "vivary:code-worker:response", requestId: "native-id", result: { decision: "decline" } });
  } finally {
    // Restore cwd before anything that waits, since a stop can take the grace plus the cleanup budget.
    process.chdir(originalCwd);
    t.mock.timers.reset();
    controller.abort();
    await execution?.catch(() => undefined);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a synchronous native-request handler failure stops the worker without escaping IPC", { timeout: WORKER_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-request-error-"));
  const server = path.join(fixture, ".output", "server");
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
process.on("message", message => {
 if(message.type === "vivary:code-worker:start") process.send({type:"vivary:code-worker:request",runId:message.runId,
 request:{requestId:"native-id",method:"unsupported",params:{}}});
});
process.send({type:"vivary:code-worker:ready"});
`);
  try {
    process.chdir(fixture);
    await assert.rejects(executeVivaryCodeWorker({ runId: request.runId, prompt: "invalid interaction", ownerEmail: request.ownerEmail,
      signal: new AbortController().signal, onRequest: () => { throw new Error("Unsupported native method"); } }),
      /approval request could not be handled/);
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});

// Issue #121. Runs the Windows cleanup branch on any host. Only the platform name changes, so the fork, the worker,
// and its exit are real.
async function asWindows<T>(run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform, "process.platform is an own property");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try { return await run(); } finally { Object.defineProperty(process, "platform", platform); }
}

test("a Windows worker that exits before it receives its run stops cleanly", { timeout: WORKER_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-early-exit-"));
  const server = path.join(fixture, ".output", "server");
  await mkdir(server, { recursive: true });
  // Like a worker that crashes while it loads, before the host sends its run.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), "process.exit(1);\n");
  try {
    process.chdir(fixture);
    const error = await asWindows(() => executeVivaryCodeWorker({ runId: request.runId, prompt: "never sent",
      ownerEmail: request.ownerEmail, signal: new AbortController().signal }).then(() => null, (failure: unknown) => failure));
    assert.ok(error instanceof Error, "the run reports that its worker ended");
    assert.equal(error instanceof VivaryCodeWorkerCleanupError, false, "a worker that started nothing needs no cleanup");
    assert.match(error.message, /^The coding worker (ended before completing its run|connection closed)\.$/);
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a Windows worker that reports ready after an abort and then exits stops cleanly", { timeout: WORKER_TEST_TIMEOUT_MS }, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-windows-late-ready-"));
  const server = path.join(fixture, ".output", "server");
  const loaded = path.join(fixture, "loaded.json");
  await mkdir(server, { recursive: true });
  // The host withholds the run from a ready that arrives after the abort, so this worker started nothing.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type !== "vivary:code-worker:abort") return;
  process.send({ type: "vivary:code-worker:ready" });
  setTimeout(() => process.exit(0), 500);
});
writeFileSync(${JSON.stringify(loaded)}, JSON.stringify({ worker: process.pid }));
`);
  try {
    process.chdir(fixture);
    const controller = new AbortController();
    const error = await asWindows(async () => {
      const outcome = executeVivaryCodeWorker({ runId: request.runId, prompt: "start late", ownerEmail: request.ownerEmail,
        signal: controller.signal }).then(() => null, (failure: unknown) => failure);
      await waitForPids(loaded, t.signal);
      controller.abort();
      return outcome;
    });
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError", "a run the host withheld needs no cleanup");
  } finally {
    process.chdir(originalCwd);
    const pid = await readFile(loaded, "utf8").then(text => Number(JSON.parse(text).worker), () => 0);
    if (pid && await isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a cleanup failure names its step and does not refuse the next run", { timeout: WORKER_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-cleanup-failure-"));
  const server = path.join(fixture, ".output", "server");
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  if (message.prompt === "exit after its run") process.exit(0);
  process.send({ type: "vivary:code-worker:done", runId: message.runId });
});
process.send({ type: "vivary:code-worker:ready" });
`);
  try {
    process.chdir(fixture);
    // On Windows, cleanup cannot reach the descendants of a worker that exited after it received its run.
    const failure = await asWindows(() => executeVivaryCodeWorker({ runId: request.runId, prompt: "exit after its run",
      ownerEmail: request.ownerEmail, signal: new AbortController().signal }).then(() => null, (error: unknown) => error));
    await executeVivaryCodeWorker({ runId: request.runId, prompt: "complete", ownerEmail: request.ownerEmail,
      signal: new AbortController().signal });
    assert.ok(failure instanceof VivaryCodeWorkerCleanupError);
    assert.equal(failure.cause?.step, "worker-exited");
    // This host has no `powershell.exe`, so the check after the failed stop could not scan.
    assert.deepEqual(failure.leftovers?.check, { result: "unavailable", reason: "command-not-found" });
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});

// Issue #121. A fake `taskkill.exe` under `SystemRoot` runs the whole Windows stop on this host, `taskkill` and then
// the exit wait. The fake is a shell script, so this case cannot run on Windows. The timeout leaves room for a stop
// that spends the whole budget to report its own error.
test("a Windows abort of a live worker runs taskkill and then observes the exit", {
  timeout: WORKER_TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-taskkill-"));
  const server = path.join(fixture, ".output", "server");
  const received = path.join(fixture, "received.json");
  const log = path.join(fixture, "taskkill.log");
  await mkdir(server, { recursive: true });
  await mkdir(path.join(fixture, "System32"));
  await writeFile(path.join(fixture, "System32", "taskkill.exe"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nkill -9 "$2"\n`, { mode: 0o755 });
  const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
  await mkdir(scanner, { recursive: true });
  await writeFile(path.join(scanner, "powershell.exe"),
    "#!/bin/sh\nprintf '4\\t0\\t\\tSystem\\nEND\\t1\\n'\n", { mode: 0o755 });
  // This worker ignores the abort, so it stays alive until `taskkill` stops it.
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type === "vivary:code-worker:start") writeFileSync(${JSON.stringify(received)}, JSON.stringify({ worker: process.pid }));
});
process.send({ type: "vivary:code-worker:ready" });
`);
  // guard:allow-env-credential - Points the Windows system directory at the fake `taskkill` until `finally`.
  const systemRoot = process.env.SystemRoot;
  try {
    // guard:allow-env-credential - Points the Windows system directory at the fake `taskkill`.
    process.env.SystemRoot = fixture;
    process.chdir(fixture);
    const controller = new AbortController();
    const { error, worker } = await asWindows(async () => {
      const outcome = executeVivaryCodeWorker({ runId: request.runId, prompt: "stay alive", ownerEmail: request.ownerEmail,
        signal: controller.signal }).then(() => null, (failure: unknown) => failure);
      const { worker } = await waitForPids(received, t.signal);
      controller.abort();
      return { error: await outcome, worker };
    });
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError", "the stop observed the worker's exit after taskkill");
    assert.equal(await readFile(log, "utf8"), `/PID ${worker} /T /F\n`);
  } finally {
    process.chdir(originalCwd);
    // guard:allow-env-credential - Restores the Windows system directory, or its absence.
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    const pid = await readFile(received, "utf8").then(text => Number(JSON.parse(text).worker), () => 0);
    if (pid && await isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(fixture, { recursive: true, force: true });
  }
});

// Issue #121. A fake `powershell.exe` under `SystemRoot` answers the process scan with fixed rows, so the Windows check
// after a failed stop runs on this host. The fake is a shell script, so this case cannot run on Windows.
test("a Windows worker that exits after its run receives cleanup verification", {
  timeout: WORKER_TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-process-scan-"));
  const server = path.join(fixture, ".output", "server");
  const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
  const worker = path.join(fixture, "worker.txt");
  const leaveChild = path.join(fixture, "leave-child");
  const log = path.join(fixture, "powershell.log");
  await mkdir(server, { recursive: true });
  await mkdir(scanner, { recursive: true });
  // The System row has no creation time, like the real one. The child row names the worker as its parent and was
  // created while the worker ran. The last line counts the rows.
  await writeFile(path.join(scanner, "powershell.exe"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf '4\\t0\\t\\tSystem\\r\\n'
if [ -f ${JSON.stringify(leaveChild)} ]; then
  printf '4242\\t%s\\tcodex.exe\\r\\nEND\\t2\\r\\n' "$(cat ${JSON.stringify(worker)})"
else
  printf 'END\\t1\\r\\n'
fi
`, { mode: 0o755 });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  writeFileSync(${JSON.stringify(worker)}, process.pid + "\\t" + (BigInt(Date.now()) * 10000n + 116444736000000000n));
  process.exit(0);
});
process.send({ type: "vivary:code-worker:ready" });
`);
  // guard:allow-env-credential - Points the Windows system directory at the fake `powershell.exe` until `finally`.
  const systemRoot = process.env.SystemRoot;
  try {
    // guard:allow-env-credential - Points the Windows system directory at the fake `powershell.exe`.
    process.env.SystemRoot = fixture;
    process.chdir(fixture);
    for (const leaves of [true, false]) await t.test(leaves ? "a child is left" : "nothing is left", async () => {
      await rm(leaveChild, { force: true });
      if (leaves) await writeFile(leaveChild, "");
      const failure = await asWindows(() => executeVivaryCodeWorker({ runId: request.runId, prompt: "exit after its run",
        ownerEmail: request.ownerEmail, signal: new AbortController().signal }).then(() => null, (error: unknown) => error));
      assert.ok(failure instanceof Error);
      if (!leaves) {
        assert.equal(failure instanceof VivaryCodeWorkerCleanupError, false, "a worker that left nothing stopped cleanly");
        // The worker's disconnect and exit race, as in the early-exit case above.
        assert.match(failure.message, /^The coding worker (ended before completing its run|connection closed)\.$/);
        return;
      }
      assert.ok(failure instanceof VivaryCodeWorkerCleanupError);
      assert.equal(failure.cause?.step, "worker-exited");
      const check = failure.leftovers?.check;
      assert.ok(check?.result === "remaining");
      assert.deepEqual(check.remaining.map(({ pid, name }) => ({ pid, name })), [{ pid: 4242, name: "codex.exe" }]);
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.ok(calls.length > 0, "cleanup queries ran, including any active observations");
    for (const call of calls) {
      assert.ok(call.startsWith("-NoProfile -NonInteractive -Command "), call);
      assert.ok(call.includes("'SELECT ProcessId,ParentProcessId,Name,CreationDate FROM Win32_Process'"), call);
    }
  } finally {
    process.chdir(originalCwd);
    // guard:allow-env-credential - Restores the Windows system directory, or its absence.
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    await rm(fixture, { recursive: true, force: true });
  }
});

// Issue #121. The worker records its PID and the time just before it exits after it received its run. The fake scan
// then shows a child created 10 ms before that exit, a process that took the worker's PID 2.5 seconds later with a
// child of its own, and a child of that PID created 0.9 seconds after the exit. A dead worker starts nothing, and only
// the first one can be the run's.
test("a Windows check after the worker exits counts only children created before its exit, never a PID reuser", {
  timeout: WORKER_TEST_TIMEOUT_MS, skip: process.platform === "win32",
}, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-window-"));
  const server = path.join(fixture, ".output", "server");
  const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
  const worker = path.join(fixture, "worker.txt");
  await mkdir(server, { recursive: true });
  await mkdir(scanner, { recursive: true });
  await writeFile(path.join(scanner, "powershell.exe"), `#!/bin/sh
pid=$(cut -f1 ${JSON.stringify(worker)})
at=$(cut -f2 ${JSON.stringify(worker)})
printf '4\t0\t\tSystem\r\n'
printf '4243\t%s\t%s\tchild.exe\r\n' "$pid" "$((at - 100000))"
printf '%s\t77\t%s\treuser.exe\r\n' "$pid" "$((at + 25000000))"
printf '4244\t%s\t%s\treuser-child.exe\r\n' "$pid" "$((at + 26000000))"
printf '4245\t%s\t%s\tlate.exe\r\n' "$pid" "$((at + 9000000))"
printf 'END\t5\r\n'
`, { mode: 0o755 });
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  writeFileSync(${JSON.stringify(worker)}, process.pid + "\t" + (BigInt(Date.now()) * 10000n + 116444736000000000n));
  process.exit(0);
});
process.send({ type: "vivary:code-worker:ready" });
`);
  // guard:allow-env-credential - Points the Windows system directory at the fake `powershell.exe` until `finally`.
  const systemRoot = process.env.SystemRoot;
  try {
    // guard:allow-env-credential - Points the Windows system directory at the fake `powershell.exe`.
    process.env.SystemRoot = fixture;
    process.chdir(fixture);
    const failure = await asWindows(() => executeVivaryCodeWorker({ runId: request.runId, prompt: "exit after its run",
      ownerEmail: request.ownerEmail, signal: new AbortController().signal }).then(() => null, (error: unknown) => error));
    assert.ok(failure instanceof VivaryCodeWorkerCleanupError);
    const check = failure.leftovers?.check;
    assert.ok(check?.result === "remaining");
    assert.deepEqual(check.remaining.map(({ pid, name }) => ({ pid, name })), [{ pid: 4243, name: "child.exe" }]);
  } finally {
    process.chdir(originalCwd);
    // guard:allow-env-credential - Restores the Windows system directory, or its absence.
    if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    await rm(fixture, { recursive: true, force: true });
  }
});

// Issue #121. The worker's own window is the clock read just before and just after `fork`, and its children's window
// closes at its observed exit, each widened by 20 ms for the clock's resolution. The cases above find a child through
// its parent PID, which a window turned inside out or placed outside the fork would still pass, so this pins the bounds.
test("the Windows worker's identity spans its fork readings and its children end at its observed exit", async () => {
  const target = (pid: number | undefined, exitedAt: number | null) =>
    asWindows(() => workerCleanupTarget(pid, 50_000, 50_030, exitedAt));
  assert.deepEqual(await target(4100, 60_000), { platform: "win32", traced: [],
    tracked: [{ pid: 4100, createdFrom: 49_980, createdTo: 50_050, childrenTo: 60_020 }] });
  assert.deepEqual(await target(4100, null), { platform: "win32", traced: [],
    tracked: [{ pid: 4100, createdFrom: 49_980, createdTo: 50_050, childrenTo: null }] },
  "an exit Vivary did not observe leaves the children's window open");
  assert.equal(await target(undefined, 60_000), null, "a worker that never got a PID has no target");
});

// Issue #133. Real worker IPC and exit, with names-only Windows scan rows and taskkill supplied by fixtures.
// A fixed host clock gives the synthetic rows the worker's fork identity without relying on process-start timing.
async function windowsOrphanFixture() {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-orphan-"));
  const server = path.join(fixture, ".output", "server");
  const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
  const received = path.join(fixture, "received.json");
  const phase = path.join(fixture, "phase");
  const scans = path.join(fixture, "scans.jsonl");
  const hold = path.join(fixture, "hold");
  const done = path.join(fixture, "done");
  const stopped = path.join(fixture, "stopped");
  const holdFinal = path.join(fixture, "hold-final");
  await mkdir(server, { recursive: true });
  await mkdir(scanner, { recursive: true });
  await writeFile(phase, "linked");
  await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { existsSync, writeFileSync } from "node:fs";
process.on("message", message => {
  if (message.type !== "vivary:code-worker:start") return;
  writeFileSync(${JSON.stringify(received)}, JSON.stringify({ worker: process.pid }));
  const tick = setInterval(() => {
    if (!existsSync(${JSON.stringify(done)})) return;
    clearInterval(tick);
    process.send({ type: "vivary:code-worker:done", runId: message.runId });
  }, 10);
});
process.send({ type: "vivary:code-worker:ready" });
`);
  await writeFile(path.join(scanner, "scanner.mjs"), `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
appendFileSync(${JSON.stringify(scans)}, JSON.stringify({ event: "start", args: process.argv.slice(2) }) + "\\n");
process.once("SIGTERM", () => {
  appendFileSync(${JSON.stringify(scans)}, JSON.stringify({ event: "aborted" }) + "\\n");
  process.exit(0);
});
while (!existsSync(${JSON.stringify(received)}) || existsSync(${JSON.stringify(hold)})
  || (existsSync(${JSON.stringify(stopped)}) && existsSync(${JSON.stringify(holdFinal)}))) await delay(10);
const { worker } = JSON.parse(readFileSync(${JSON.stringify(received)}, "utf8"));
const phase = readFileSync(${JSON.stringify(phase)}, "utf8");
const stopped = existsSync(${JSON.stringify(stopped)});
const rows = [[4, 0, null, "System"]];
if (!stopped) rows.push([worker, 1, 100000, "worker.exe"]);
if (phase === "linked") rows.push([41001, worker, 100010, "launcher.exe"], [41002, 41001, 100020, "orphan.exe"]);
else if (phase === "orphan") rows.push([41002, 41001, 100020, "orphan.exe"], [41003, 41001, 100030, "ambiguous.exe"]);
else if (phase === "direct") rows.push([41004, worker, 100010, "leftover.exe"]);
else if (phase === "reused") rows.push([41002, 77, 100040, "unrelated.exe"]);
for (const [pid, parent, created, name] of rows) {
  const stamp = created === null ? "" : String(BigInt(created) * 10000n + 116444736000000000n);
  process.stdout.write([pid, parent, stamp, name].join("\\t") + "\\n");
}
process.stdout.write("END\\t" + rows.length + "\\n");
appendFileSync(${JSON.stringify(scans)}, JSON.stringify({ event: "end", phase, stopped }) + "\\n");
`, { mode: 0o755 });
  await writeFile(path.join(scanner, "powershell.exe"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(scanner, "scanner.mjs"))} "$@"\n`,
    { mode: 0o755 });
  await writeFile(path.join(fixture, "System32", "taskkill.exe"),
    `#!/bin/sh\nprintf stopped > ${JSON.stringify(stopped)}\nkill -9 "$2"\n`, { mode: 0o755 });
  const events = async () => (await readFile(scans, "utf8").catch(() => "")).trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line));
  const waitForScan = async (event: string, count: number) => {
    const signal = AbortSignal.timeout(5_000);
    try {
      while ((await events()).filter(item => item.event === event).length < count) await delay(20, undefined, { signal });
    } catch (error) {
      if (signal.aborted) assert.fail("The active Windows run did not record scan " + event + " " + count);
      throw error;
    }
  };
  return { fixture, received, phase, hold, holdFinal, done, events, waitForScan };
}

for (const scenario of ["orphan", "direct", "reused", "scan-held-at-stop", "final-scan-persistence"]) test(
  `Windows active descendant tracking: ${scenario} after successful taskkill`,
  { timeout: WORKER_TEST_TIMEOUT_MS, skip: process.platform === "win32" }, async t => {
    t.mock.method(Date, "now", () => 100_000);
    const proof = await windowsOrphanFixture();
    if (scenario === "orphan" || scenario === "scan-held-at-stop") await writeFile(proof.hold, "");
    // guard:allow-env-credential - Directs fixed Windows executables to this test's process fixtures.
    const systemRoot = process.env.SystemRoot;
    try {
      // guard:allow-env-credential - Directs fixed Windows executables to this test's process fixtures.
      process.env.SystemRoot = proof.fixture;
      process.chdir(proof.fixture);
      await asWindows(async () => {
        const controller = new AbortController();
        const refusals: { target: CleanupTarget | null }[] = [];
        const outcome = executeVivaryCodeWorker({ runId: request.runId, prompt: "observe descendants",
          ownerEmail: request.ownerEmail, signal: controller.signal,
          onStopFailed: refusal => { refusals.push(refusal); } }).then(() => null, (error: unknown) => error);
        try {
          await waitForPids(proof.received, t.signal);
          if (scenario === "scan-held-at-stop") {
            await proof.waitForScan("start", 1);
            await writeFile(proof.phase, "reused");
          } else if (scenario !== "direct") {
            if (scenario === "orphan") {
              await proof.waitForScan("start", 1);
              await delay(1_300);
              assert.equal((await proof.events()).filter(item => item.event === "start").length, 1,
                "a held scan does not overlap another periodic scan");
              await rm(proof.hold);
            }
            await proof.waitForScan("end", 1);
            await writeFile(proof.phase, scenario === "final-scan-persistence" ? "orphan" : scenario);
            await proof.waitForScan("end", 2);
          } else {
            await writeFile(proof.phase, "direct");
          }
          if (scenario === "final-scan-persistence") await writeFile(proof.holdFinal, "");
          await writeFile(proof.done, "");
          if (scenario === "final-scan-persistence") {
            await proof.waitForScan("start", 3);
            assert.equal(refusals.length, 1, "persist the target before awaiting final verification");
            const saved = refusals[0]?.target;
            assert.ok(saved?.platform === "win32");
            assert.ok(saved.tracked.some(item => item.pid === 41002 && item.createdFrom === 100020));
            assert.ok(saved.traced.some(item => item.pid === 41002 && item.start === 100020),
              "a restart during verification must retain the orphan's End them identity");
            await rm(proof.holdFinal);
          }
          if (scenario === "scan-held-at-stop") {
            await proof.waitForScan("aborted", 1);
            await rm(proof.hold);
          }
          const error = await outcome;
          if (scenario === "reused" || scenario === "scan-held-at-stop") {
            assert.equal(error, null, "a reused orphan PID does not belong to the completed run");
            assert.equal(refusals.length, 1, "even a clean final result is persisted while verification is pending");
            return;
          }
          assert.ok(error instanceof VivaryCodeWorkerCleanupError, "successful taskkill still checks for descendants");
          assert.equal(error.cause?.step, "exit");
          const check = error.leftovers?.check;
          assert.ok(check?.result === "remaining");
          const expected = scenario === "orphan" || scenario === "final-scan-persistence" ? [41002, 41003] : [41004];
          assert.deepEqual(check.remaining.map(item => item.pid).sort(), expected);
          assert.equal(refusals.length, 1, "the existing refusal strip receives the failed cleanup");
          const ended: number[] = [];
          await endWorkerLeftovers(check.target, check.remaining, {
            bootId: async () => null,
            proc: { signalGroup: () => undefined, list: async () => [], stat: async () => "", kill: () => undefined },
            windowsProcesses: async () => [],
            windowsEnd: async processes => {
              ended.push(...processes.map(item => item.pid));
              return processes.map(item => ({ ...item, outcome: "ended" }));
            },
          });
          assert.deepEqual(ended, scenario === "orphan" || scenario === "final-scan-persistence" ? [41002] : [41004],
            "End them uses observed live ancestry, never the ambiguous child of a historical parent");
          const calls = await proof.events();
          for (const call of calls.filter(item => item.event === "start")) {
            assert.ok(call.args.join(" ").includes("SELECT ProcessId,ParentProcessId,Name,CreationDate FROM Win32_Process"));
            assert.doesNotMatch(call.args.join(" "), /CommandLine/);
          }
          await delay(1_200);
          assert.deepEqual(await proof.events(), calls, "settled runs start no more scans");
        } finally {
          await rm(proof.hold, { force: true });
          await rm(proof.holdFinal, { force: true });
          controller.abort();
          await outcome;
        }
      });
    } finally {
      process.chdir(originalCwd);
      // guard:allow-env-credential - Restores the original fixed Windows executable directory.
      if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
      const pid = await readFile(proof.received, "utf8").then(value => Number(JSON.parse(value).worker), () => 0);
      if (pid && await isAlive(pid)) process.kill(pid, "SIGKILL");
      await rm(proof.fixture, { recursive: true, force: true });
    }
  });

// Uses real scanner subprocesses. Error text must never enter a stored cleanup diagnostic.
test("Windows scan failure categories survive cleanup verification", {
  timeout: 20_000, skip: process.platform === "win32",
}, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-scan-diagnostic-"));
  const scanner = path.join(fixture, "System32", "WindowsPowerShell", "v1.0");
  await mkdir(scanner, { recursive: true });
  // guard:allow-env-credential - Restored synthetic system directory for scanner subprocesses.
  const previous = process.env.SystemRoot;
  // guard:allow-env-credential - Selects only the disposable scanner executable.
  process.env.SystemRoot = fixture; // guard:allow-env-mutation - Test-local executable fixture.
  const target: CleanupTarget = { platform: "win32",
    tracked: [{ pid: 41002, createdFrom: 1, createdTo: 1, childrenTo: 2 }], traced: [] };
  try {
    const cases = [
      { script: "printf 'private-error-must-not-persist' >&2; exit 1", reason: "command-failed" },
      { script: "printf 'incomplete scan\\n'", reason: "invalid-output" },
      { script: "exec sleep 30", reason: "timeout" },
    ];
    for (const scenario of cases) {
      await writeFile(path.join(scanner, "powershell.exe"), "#!/bin/sh\n" + scenario.script + "\n", { mode: 0o755 });
      assert.deepEqual(await checkWorkerCleanup(target), { result: "unavailable", reason: scenario.reason });
    }
    await writeFile(path.join(scanner, "powershell.exe"),
      "#!/bin/sh\nprintf '4\\t0\\t\\tSystem\\nEND\\t1\\n'\n", { mode: 0o755 });
    assert.deepEqual(await checkWorkerCleanup(target), { result: "clean" }, "a complete empty target scan still passes");
  } finally {
    // guard:allow-env-credential - Restores the real system directory after the isolated test.
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    await rm(fixture, { recursive: true, force: true });
  }
});
