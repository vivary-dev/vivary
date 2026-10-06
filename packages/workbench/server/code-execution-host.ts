import type { CodePermissionMode } from "./code-permissions";
import { execFile, fork, type ChildProcess, type ForkOptions, type SpawnOptions } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isVivaryCodeWorkerRequest, type VivaryCodeWorkerRequest, isCodexActionRequest, type CodexActionRequest } from "./code-execution-protocol";
import { credentialFingerprints } from "./credential-redaction.ts";
import { codingRuntimeEnvironment } from "./local-runtime-setup.ts";

export const STARTUP_TIMEOUT_MS = 15_000;
export const TERMINATION_GRACE_MS = 5_000;
// Issue #121. One budget for the whole stop, from its first step. The tree was already sent SIGKILL or
// `taskkill /F`, so a longer wait costs only Stop latency, while a false failure refuses every later run.
export const CLEANUP_TIMEOUT_MS = 15_000;
// On Windows `taskkill` gets the budget less this reserve, so a late `taskkill` success still leaves the exit wait
// this long to observe the worker's exit.
export const CLEANUP_EXIT_RESERVE_MS = 3_000;
// The `taskkill` bound for the other modules that call `hardStopWorkerTree`.
const TASKKILL_TIMEOUT_MS = 3_000;
// Issue #121. A check after a stop gives a Linux group this long to empty, which also gives a slow stop one more second.
const CLEANUP_CHECK_MS = 1_000;
// Bounds PowerShell startup, the CIM query, and output collection when a scan stalls.
const WINDOWS_SCAN_TIMEOUT_MS = 10_000;
// Issue #133. Wait after each completed scan, rather than overlap slow PowerShell queries.
const WINDOWS_TRACK_INTERVAL_MS = 1_000;
// The worker's Windows identity comes from the host clock, read just before and just after `fork`, which creates the
// process before it returns, and at its observed exit, since a dead parent starts nothing. Windows stamps a creation
// time from its system clock, which can advance in 15.6 ms ticks, and both clocks are compared in whole milliseconds,
// so each bound gets this much room. On a Windows laptop, 36 forks all fell inside the two readings without it.
const CLOCK_TOLERANCE_MS = 20;
const MAX_TRACKED_PROCESSES = 200;
const MAX_TRACED_PROCESSES = 200;

/**
 * The cleanup step that failed and what it threw. `worker-exited` means a Windows worker exited after it was sent its
 * run. `taskkill` cannot reach that worker's descendants, so it never ran.
 */
export type CleanupFailure = { step: "taskkill" | "exit" | "group" | "worker-exited"; error: unknown };

/**
 * A process that outlived a stop. `name` is the Linux `comm` or the Windows image name, never a command line. `start`
 * tells it apart from a later process that reuses its PID: the Windows creation time in Unix milliseconds, or the Linux
 * start time in clock ticks after boot. Only equality with a value from the same host means anything.
 */
export type LeftoverProcess = { pid: number; name: string; start: number };

/**
 * One Windows process, or the worker, by PID and creation time, so a reused PID never matches. Times are Unix
 * milliseconds. A process read from a scan has createdFrom === createdTo. `childrenTo` is set when the worker's exit was
 * observed, because a dead parent starts nothing.
 */
export type WindowsProcessIdentity = { pid: number; createdFrom: number; createdTo: number; childrenTo: number | null };

/** A process End them may end, by PID and start stamp. */
export type TracedProcess = Pick<LeftoverProcess, "pid" | "start">;

/**
 * What a later check needs to find the same processes again, including after a Vivary restart. A check lists every
 * process it links to the run, so a refusal never lifts early. `traced` is the narrower set End them may end: what the
 * check right after the failed stop found, and later children of a traced process that is alive in the same scan. A
 * process linked only through an exited parent or a reused group id could belong to another program. `overflow` marks a
 * Windows target that linked more live processes to the run than it can track, so no later check of it is clean.
 */
export type CleanupTarget =
  | { platform: "linux"; groupId: number; bootId: string | null; traced: TracedProcess[] }
  | { platform: "win32"; tracked: WindowsProcessIdentity[]; traced: TracedProcess[]; overflow?: true };

/** A Linux boot id, which the kernel prints as a UUID. */
export const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const WINDOWS_SCAN_FAILURES = ["timeout", "aborted", "access-denied", "command-not-found",
  "command-failed", "output-limit", "invalid-output", "tracking-overflow"] as const;
export type WindowsScanFailure = typeof WINDOWS_SCAN_FAILURES[number];

/**
 * One observation of a target. `hidden` is Linux only. The group exists and may hold a member Vivary could not read,
 * for example under `hidepid=1`, beside any it lists. A Windows `target` also tracks every process the scan found.
 */
export type CleanupCheck =
  | { result: "clean" }
  | { result: "remaining"; remaining: LeftoverProcess[]; hidden: boolean; target: CleanupTarget }
  | { result: "unavailable"; reason?: WindowsScanFailure };

/** A failed stop's target, null on a platform Vivary cannot check, and the one check taken right after the failure. */
export type WorkerLeftovers = { target: CleanupTarget | null; check: Exclude<CleanupCheck, { result: "clean" }> };

/** One scan of a Linux process group. A member's parent PID lets a later check trace it. */
export type LinuxGroupObservation = { members: (LeftoverProcess & { parentPid: number })[]; hidden: boolean };

export class VivaryCodeWorkerCleanupError extends Error {
  declare cause?: CleanupFailure;
  /** Set on the error a run settles with. */
  readonly leftovers?: WorkerLeftovers;
  /** Set when the Linux group wait ran out of time, from its last completed scan. */
  readonly observation?: LinuxGroupObservation;

  constructor(cause?: CleanupFailure, details: { leftovers?: WorkerLeftovers; observation?: LinuxGroupObservation } = {}) {
    super("The coding process could not be stopped completely.", cause && { cause });
    this.name = "VivaryCodeWorkerCleanupError";
    this.leftovers = details.leftovers;
    this.observation = details.observation;
  }
}

function aborted(message = "The coding run was stopped."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export async function executeVivaryCodeWorker(input: {
  runId: string;
  prompt: string;
  model?: string;
  permissionMode?: CodePermissionMode;
  onRequest?: (request: CodexActionRequest) => Promise<Record<string, unknown>>;
  onRequestResolved?: (requestId: string) => void;
  ownerEmail: string;
  orgId?: string;
  signal: AbortSignal;
  /**
   * Called before checking a failed stop or verifying Windows descendants after taskkill. The caller persists the
   * target while verification is pending, so a host exit during that scan cannot lose an already observed orphan.
   */
  onStopFailed?: (failure: { step: CleanupFailure["step"]; target: CleanupTarget | null }) => void;
}): Promise<void> {
  if (input.signal.aborted) throw aborted();
  const request: VivaryCodeWorkerRequest = {
    type: "vivary:code-worker:start", runId: input.runId, prompt: input.prompt,
    model: input.model, permissionMode: input.permissionMode, ownerEmail: input.ownerEmail, orgId: input.orgId,
    // The worker redacts transcript events with fingerprints of the values the host holds now.
    redaction: credentialFingerprints(),
  };
  if (!isVivaryCodeWorkerRequest(request)) throw new Error("The coding worker received an invalid run request.");
  // startVivary pins cwd to the Workbench package, including relocated desktop builds.
  const entry = path.join(process.cwd(), ".output", "server", "vivary-code-worker.mjs");
  await access(entry).catch(() => { throw new Error("Rebuild Vivary to include the coding worker."); });
  if (input.signal.aborted) throw aborted();

  return new Promise((resolve, reject) => {
    // The worker needs no credential. Claude Code and native Codex get no host MCP servers, and runs are stored in files.
    const environment = codingRuntimeEnvironment(process.env);
    delete environment.VIVARY_DESKTOP_HOST;
    delete environment.VIVARY_STANDALONE_HOST;
    const forkOptions: ForkOptions & Pick<SpawnOptions, "windowsHide"> = {
      cwd: process.cwd(), execPath: process.execPath,
      execArgv: ["--max-old-space-size=512"],
      env: environment, detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    };
    const forkedFrom = Date.now();
    const child = fork(entry, [], forkOptions);
    const forkedTo = Date.now();
    let exitedAt: number | null = null;
    let failure: Error | null = null;
    let reported = false;
    let settled = false;
    let sent = false;
    // `sent` turns true when ready arrives, even when the host then withholds the run.
    let runSent = false;
    let cleanup: Promise<void> | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let workerExited = false;
    let windowsTarget = process.platform === "win32" && child.pid
      ? windowsWorkerTarget(child.pid, forkedFrom, forkedTo, null) : null;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let scanAbort: AbortController | undefined;
    let activeScan: Promise<void> | undefined;
    const trackWindows = () => {
      if (!windowsTarget || activeScan || settled || cleanup || !runSent) return;
      const controller = new AbortController();
      scanAbort = controller;
      activeScan = scanWindowsProcesses(controller.signal).then(rows => {
        if (controller.signal.aborted || settled || !windowsTarget) return;
        const observed = windowsLeftovers(rows, windowsTarget.tracked, windowsTarget.traced);
        windowsTarget = { platform: "win32", tracked: observed.tracked, traced: observed.traced,
          ...(windowsTarget.overflow || observed.overflow ? { overflow: true } : {}) };
      }).catch(() => { /* A later scan retries without discarding identities already observed. */ }).finally(() => {
        activeScan = undefined;
        if (!settled && !cleanup && runSent) scanTimer = setTimeout(trackWindows, WINDOWS_TRACK_INTERVAL_MS);
      });
    };
    const stopTracking = () => {
      clearTimeout(scanTimer);
      scanAbort?.abort();
      return activeScan;
    };
    let resolveExit: () => void;
    const exited = new Promise<void>(done => { resolveExit = done; });

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupDeadline);
      clearTimeout(grace);
      clearTimeout(exitTimer);
      stopTracking();
      input.signal.removeEventListener("abort", onAbort);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
      if (child.connected) {
        try { child.disconnect(); } catch { /* The child may already be exiting. */ }
      }
      if (error) reject(error);
      else resolve();
    };
    // A successful taskkill can miss an orphan. Keep identities observed while its ancestry was still live.
    const stoppedOutcome = async (cause: CleanupFailure | null, deadline: number): Promise<Error | null> => {
      if (windowsTarget && exitedAt !== null) {
        const childrenTo = exitedAt + CLOCK_TOLERANCE_MS;
        windowsTarget.tracked = windowsTarget.tracked.map(identity => identity.pid === child.pid
          && identity.createdFrom >= forkedFrom - CLOCK_TOLERANCE_MS
          && identity.createdTo <= forkedTo + CLOCK_TOLERANCE_MS
          ? { ...identity, childrenTo } : identity);
      }
      const target = windowsTarget ?? await workerCleanupTarget(child.pid, forkedFrom, forkedTo, exitedAt);
      const reportFailure = (failure: CleanupFailure, target: CleanupTarget | null) => {
        try { input.onStopFailed?.({ step: failure.step, target }); }
        catch { /* The error the run settles with records the refusal. */ }
      };
      const failed: CleanupFailure = cause ?? {
        step: "exit", error: new Error("Windows coding process cleanup could not be confirmed."),
      };
      reportFailure(failed, target);
      let check: CleanupCheck = { result: "unavailable" };
      try {
        if (target?.platform === "win32") {
          const remaining = deadline - Date.now();
          if (remaining > 0) check = await checkWorkerCleanup(target, { ...cleanupIo,
            windowsProcesses: () => scanWindowsProcesses(AbortSignal.timeout(remaining)) });
        } else if (target) check = await checkStoppedWorker(target);
      } catch { /* An unavailable check still refuses later runs. */ }
      if (check.result === "clean") return failure;
      const checkedTarget = check.result === "remaining" ? check.target : target;
      return new VivaryCodeWorkerCleanupError(failed, { leftovers: { target: checkedTarget, check } });
    };
    const stopTree = () => {
      cleanup ??= (async () => {
        const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
        const pendingScan = stopTracking();
        let step: CleanupFailure["step"] = process.platform !== "win32" ? "group"
          : workerExited ? "worker-exited" : "taskkill";
        try {
          if (!windowsWorkerStoppedCleanly({ platform: process.platform, workerExited, runSent })) {
            await hardStopWorkerTree(child, workerExited, CLEANUP_TIMEOUT_MS - CLEANUP_EXIT_RESERVE_MS);
            if (process.platform === "linux" && child.pid) {
              // The worker leads its own process group, so the group scan also sees the worker.
              await waitForLinuxWorkerGroupExit(child.pid, undefined, deadline - Date.now());
            } else {
              step = "exit";
              await new Promise<void>((resolveStop, rejectStop) => {
                void exited.then(resolveStop);
                // A starved host can run this timer before the poll phase delivers an exit that already
                // happened, so the verdict waits one more turn and reads the exit the host observed.
                exitTimer = setTimeout(() => setImmediate(() => {
                  if (workerExited) resolveStop();
                  else rejectStop(new VivaryCodeWorkerCleanupError());
                }), Math.max(0, deadline - Date.now()));
              });
            }
          }
          await pendingScan;
          finish(process.platform === "win32" && runSent ? await stoppedOutcome(null, deadline) : failure);
        } catch (error) {
          await pendingScan;
          finish(await stoppedOutcome({ step, error }, deadline));
        }
      })();
    };
    const requestStop = (reason: Error) => {
      failure ??= reason;
      if (cleanup) return;
      try {
        if (child.connected) child.send({ type: "vivary:code-worker:abort" }, () => undefined);
      } catch { /* Hard termination still follows a closed IPC channel. */ }
      grace ??= setTimeout(stopTree, TERMINATION_GRACE_MS);
    };
    const onAbort = () => requestStop(aborted());
    const onError = () => {
      failure ??= new Error("The coding worker could not start.");
      if (!child.pid) { resolveExit(); finish(failure); }
      else stopTree();
    };
    const onExit = () => {
      workerExited = true;
      exitedAt = Date.now();
      resolveExit();
      failure ??= reported ? null : new Error("The coding worker ended before completing its run.");
      stopTree();
    };
    const onDisconnect = () => {
      if (!cleanup) requestStop(new Error("The coding worker connection closed."));
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "vivary:code-worker:ready" && !sent) {
        sent = true;
        clearTimeout(startupDeadline);
        // A ready that arrives after the deadline or an abort must not start the run the host is stopping.
        if (failure) return;
        // A failed write did not deliver the run, so it clears `runSent`. That helps only when the failure is reported
        // before the worker's exit, because `stopTree` reads `runSent` when it starts.
        try {
          runSent = true;
          child.send(request, error => {
            if (!error) return;
            runSent = false;
            requestStop(new Error("The coding worker could not receive its run."));
          });
          trackWindows();
        } catch {
          runSent = false;
          requestStop(new Error("The coding worker connection closed."));
        }
        return;
      }
      if (!("runId" in message) || message.runId !== input.runId) return;
      if (message.type === "vivary:code-worker:request" && "request" in message && isCodexActionRequest(message.request)) {
        const action = message.request;
        Promise.resolve().then(() => input.onRequest?.(action)).then(result => {
          if (!settled && !cleanup && child.connected) child.send({ type: "vivary:code-worker:response", requestId: action.requestId, result: result ?? { decision: "decline" } }, () => undefined);
        }).catch(() => requestStop(new Error("The Codex approval request could not be handled.")));
        return;
      }
      if (message.type === "vivary:code-worker:resolved" && "requestId" in message && typeof message.requestId === "string") {
        input.onRequestResolved?.(message.requestId);
        return;
      }
      if (message.type !== "vivary:code-worker:done" && message.type !== "vivary:code-worker:failed") return;
      reported = true;
      if (message.type === "vivary:code-worker:failed") failure ??= new Error("The Native coding executor failed.");
      stopTree();
    };
    const startupDeadline = setTimeout(() => requestStop(
      new Error(`The coding worker did not start within ${STARTUP_TIMEOUT_MS / 1_000} seconds.`)), STARTUP_TIMEOUT_MS);
    child.on("message", onMessage);
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
  });
}

/**
 * Issue #121. `taskkill /T` needs a live parent, so Windows cannot stop the tree of a worker that already exited.
 * The worker starts processes only after it receives its run, so a worker that exited before the host sent its run
 * has started nothing and needs no cleanup.
 */
export function windowsWorkerStoppedCleanly(worker: {
  platform: NodeJS.Platform; workerExited: boolean; runSent: boolean;
}): boolean {
  return worker.platform === "win32" && worker.workerExited && !worker.runSent;
}

export async function hardStopWorkerTree(
  child: ChildProcess, workerExited: boolean, taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (workerExited) throw new VivaryCodeWorkerCleanupError();
    // guard:allow-env-credential - Windows system directory selects the fixed taskkill executable.
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    await new Promise<void>((resolve, reject) => {
      execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, shell: false, timeout: taskkillTimeoutMs, maxBuffer: 16 * 1024,
      }, error => { if (error) reject(error); else resolve(); });
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/**
 * Reads `/proc`, signals a process group, and ends one process. Tests pass their own to produce errors a kernel shows
 * only in a race.
 */
type LinuxProcReader = {
  signalGroup: (groupId: number) => void;
  list: () => Promise<string[]>;
  stat: (pid: string) => Promise<string>;
  kill: (pid: number) => void;
};

const linuxProc: LinuxProcReader = {
  signalGroup: groupId => { process.kill(-groupId, 0); },
  list: () => readdir("/proc"),
  stat: pid => readFile(`/proc/${pid}/stat`, "utf8"),
  kill: pid => { process.kill(pid, "SIGKILL"); },
};

/**
 * Issue #121. The live members of a process group, by PID, `comm` name, and start time. Only `stat` is read, never
 * `cmdline`, `environ`, or `status`, because arguments and environments can carry secrets. The kernel's answer to
 * signal 0 decides whether the group exists, so a member that `/proc` cannot show is reported as `hidden`, never as
 * gone.
 */
export async function scanLinuxWorkerGroup(groupId: number, proc = linuxProc, signal?: AbortSignal): Promise<LinuxGroupObservation> {
  try { proc.signalGroup(groupId); } catch (error) {
    // ESRCH means no process, zombies included, has this group id. EPERM means one exists that we may not signal.
    if (errorCode(error) === "ESRCH") return { members: [], hidden: false };
    if (errorCode(error) !== "EPERM") throw new VivaryCodeWorkerCleanupError();
  }
  let entries: string[];
  try { entries = await proc.list(); }
  catch { throw new VivaryCodeWorkerCleanupError(); }
  const members: LinuxGroupObservation["members"] = [];
  let zombie = false;
  let unreadable = false;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try { raw = await proc.stat(entry); }
    catch (error) {
      // ENOENT is a process that exited before the open. ESRCH is one reaped between the open and the read, which a
      // Linux kernel reports and gVisor does not. EACCES and EPERM are another user's entry under `hidepid=1`, which
      // could be a member. Any other error fails closed.
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ESRCH") continue;
      if (code === "EACCES" || code === "EPERM") { unreadable = true; continue; }
      throw new VivaryCodeWorkerCleanupError();
    }
    const stat = readLinuxProcStat(raw);
    if (stat.processGroup !== groupId) continue;
    if (stat.state === "Z" || stat.state === "X") zombie = true;
    else members.push({ pid: Number(entry), name: stat.name, start: stat.start, parentPid: stat.parentPid });
  }
  // The group exists, so an unreadable entry could be a member, even beside readable ones. A visible zombie explains an
  // otherwise empty group.
  return { members, hidden: unreadable || (members.length === 0 && !zombie) };
}

/** The fields of a `/proc/<pid>/stat` line that the group scan uses. The `comm` name may itself hold `)` and spaces. */
export function readLinuxProcStat(raw: string): {
  name: string; state: string; parentPid: number; processGroup: number; start: number;
} {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  const fields = open < 0 || close < open ? [] : raw.slice(close + 2).trim().split(/\s+/);
  // The fields after `comm` start at field 3, so the parent is field 4, the group field 5, and the start time field 22.
  const state = fields[0];
  const parentPid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  const start = Number(fields[19]);
  // Kernel threads can have process group zero. They cannot be in our positive group.
  if (!state || [parentPid, processGroup, start].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new VivaryCodeWorkerCleanupError();
  }
  return { name: raw.slice(open + 1, close), state, parentPid, processGroup, start };
}

export async function waitForLinuxWorkerGroupExit(
  groupId: number, inspect: (groupId: number) => Promise<LinuxGroupObservation> = scanLinuxWorkerGroup,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(groupId) || groupId < 1) throw new VivaryCodeWorkerCleanupError();
  const deadline = Date.now() + timeoutMs;
  let emptyObservations = 0;
  let lastLive: LinuxGroupObservation | undefined;
  for (;;) {
    const observation = await scanBefore(deadline, () => inspect(groupId));
    // Issue #121. At the deadline the last completed scan decides, not the clock. The group was sent SIGKILL
    // before this wait, so an empty scan is trusted even when no time is left for a second one.
    if (observation === undefined) {
      if (emptyObservations > 0) return;
      throw new VivaryCodeWorkerCleanupError(undefined, { observation: lastLive });
    }
    const live = observation.members.length > 0 || observation.hidden;
    if (live) lastLive = observation;
    emptyObservations = live ? 0 : emptyObservations + 1;
    // /proc traversal is not atomic. A second empty scan catches a group
    // member that appeared after the first scan passed its PID.
    if (emptyObservations === 2) return;
    if (live) await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
}

/** The scan's result, or undefined when the deadline passes before the scan finishes. */
function scanBefore<T>(deadline: number, scan: () => Promise<T>): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), remaining);
    void scan().then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/** One row of the Windows process scan. `created` can be null only for PID 0, System Idle, and PID 4, System. */
export type WindowsProcessRow = { pid: number; parentPid: number; created: number | null; name: string };

// A Windows FILETIME counts 100-nanosecond intervals from 1601. This is 1970 in those units.
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
// The System Idle Process (PID 0) and System (PID 4) may have no creation time. Every other process has one.
const WINDOWS_UNTIMED_PIDS: ReadonlySet<number> = new Set([0, 4]);

// The query names four properties, so WMI never returns a command line, a path, or an owner to Vivary. Windows file
// names cannot hold a tab. The script also works under Constrained Language Mode. It converts creation times with a
// method of the core DateTime type, and only the encoding step, which that mode refuses, may fail without ending the
// script. Names then arrive in the console code page, which is harmless because only PIDs and creation times are
// compared. Any other error ends the script with a non-zero exit. The last line counts the rows, so cut output never
// reads as a scan.
const WINDOWS_PROCESS_SCAN = [
  "$ErrorActionPreference = 'Stop'",
  "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }",
  "$rows = @(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name,CreationDate FROM Win32_Process')",
  "foreach ($row in $rows) { @($row.ProcessId, $row.ParentProcessId, "
    + "$(if ($row.CreationDate) { $row.CreationDate.ToFileTimeUtc() }), $row.Name) -join [char]9 }",
  "@('END', $rows.Count) -join [char]9",
].join("; ");

function windowsSystem32(): string {
  // guard:allow-env-credential - Windows system directory selects fixed system executables.
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32");
}

function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const powershell = path.join(windowsSystem32(), "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, shell: false, signal, timeout: WINDOWS_SCAN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8",
    }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

/** Match the server side of an established preview connection, never just a listening port. */
export async function windowsTcpOwner(serverPort: number, clientPort: number, signal?: AbortSignal): Promise<number> {
  if (![serverPort, clientPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error("Invalid preview connection.");
  }
  const output = await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$rows = @(Get-NetTCPConnection -State Established -LocalAddress 127.0.0.1 -LocalPort ${serverPort} -RemoteAddress 127.0.0.1 -RemotePort ${clientPort})`,
    "if ($rows.Count -ne 1) { throw 'Ambiguous preview connection' }",
    "$rows[0].OwningProcess",
  ].join("; "), signal);
  if (!/^\d+$/.test(output.trim())) throw new Error("Unknown preview connection owner.");
  const pid = Number(output.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Unknown preview connection owner.");
  return pid;
}

/** The lines before a last line that counts them, or null when that count is missing or wrong. */
function countedLines(text: string): string[] | null {
  // PowerShell can start UTF-8 output with a byte order mark.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line !== "");
  const count = /^END\t(\d+)$/.exec(lines.pop() ?? "");
  return count && Number(count[1]) === lines.length ? lines : null;
}

/** Issue #121. Every process on this Windows host by PID, parent PID, creation time, and image name. */
export async function scanWindowsProcesses(signal?: AbortSignal): Promise<WindowsProcessRow[]> {
  const rows = parseWindowsProcessRows(await runPowerShell(WINDOWS_PROCESS_SCAN, signal));
  if (!rows) throw Object.assign(new Error("The Windows process scan printed output Vivary cannot read."),
    { code: "VIVARY_WINDOWS_SCAN_OUTPUT" });
  return rows;
}

/**
 * Null unless the output is one whole scan: rows only, then a count of them, and a creation time on every row but PIDs 0
 * and 4. So a cut output, or a scan that could not read creation times, never reads as an empty or partial one.
 */
export function parseWindowsProcessRows(text: string): WindowsProcessRow[] | null {
  const lines = countedLines(text);
  if (!lines?.length) return null;
  const rows: WindowsProcessRow[] = [];
  for (const line of lines) {
    const match = /^(\d+)\t(\d+)\t(\d*)\t(.+)$/.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    const created = match[3] ? unixMsFromFiletime(match[3]) : null;
    if (created === null && !WINDOWS_UNTIMED_PIDS.has(pid)) return null;
    rows.push({ pid, parentPid: Number(match[2]), created, name: match[4] });
  }
  return rows;
}

function unixMsFromFiletime(digits: string): number {
  return Number((BigInt(digits) - FILETIME_UNIX_EPOCH) / 10_000n);
}

/**
 * What End them did to one process. `mismatched` means its PID now names another process, `gone` that it had exited,
 * `failed` that Windows or the kernel refused, and `unknown` that the Windows End call it was sent to failed or printed
 * output Vivary cannot read, so it may have ended.
 */
export type EndOutcome = "ended" | "mismatched" | "gone" | "failed" | "unknown";
export type EndAttempt = LeftoverProcess & { outcome: EndOutcome };

/**
 * Issue #121. Ends Windows processes in one PowerShell call. For each PID the script takes the process, opens its
 * handle, reads the creation time through that handle, and ends the process through the same object only when that
 * time falls in the recorded millisecond. Windows cannot hand a PID to another process while a handle to it is open, so
 * the check and the end act on the same process. Every step also works under Constrained Language Mode. Throws when
 * the call cannot run or prints anything else.
 */
export async function endWindowsProcesses(processes: readonly LeftoverProcess[]): Promise<EndAttempt[]> {
  // The earliest FILETIME in each process's recorded millisecond. Each target is `<pid>:<FILETIME>`.
  const targets = processes.map(({ pid, start }) => `${pid}:${BigInt(start) * 10_000n + FILETIME_UNIX_EPOCH}`).join(";");
  const attempts = parseWindowsEndResults(await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "$count = 0",
    `foreach ($target in '${targets}'.Split(';')) { $pair = $target.Split(':'); $id = [int]$pair[0]; `
      + "$from = [long]$pair[1]; $outcome = 'failed'; try { $process = Get-Process -Id $id -ErrorAction SilentlyContinue; "
      + "if (-not $process) { $outcome = 'gone' } else { $null = $process.Handle; "
      + "$created = $process.StartTime.ToFileTimeUtc(); "
      + "if ($created -lt $from -or $created -ge $from + 10000) { $outcome = 'mismatched' } "
      + "else { Stop-Process -InputObject $process -Force; $outcome = 'ended' } } } "
      + "catch { if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { $outcome = 'gone' } }; "
      + "@($id, $outcome) -join [char]9; $count++ }",
    "@('END', $count) -join [char]9",
  ].join("; ")), processes);
  if (!attempts) throw new Error("The Windows end step printed output Vivary cannot read.");
  return attempts;
}

/** Null unless the output gives one outcome for each process, in order, then counts them. */
export function parseWindowsEndResults(text: string, processes: readonly LeftoverProcess[]): EndAttempt[] | null {
  const lines = countedLines(text);
  if (lines?.length !== processes.length) return null;
  const attempts: EndAttempt[] = [];
  for (const [index, leftover] of processes.entries()) {
    const match = /^(\d+)\t(ended|mismatched|gone|failed)$/.exec(lines[index]!);
    if (!match || Number(match[1]) !== leftover.pid) return null;
    attempts.push({ ...leftover, outcome: match[2] as EndOutcome });
  }
  return attempts;
}

/**
 * Issue #121. The rows that are tracked processes or descend from one, by parent PID and creation time. A row created
 * before its parent, or whose parent PID now belongs to a process older than the row, is the child of a process that
 * reused the PID. The returned `tracked` adds each row found, so a grandchild stays traceable after its parent exits.
 * The returned `traced` adds the rows End them may end: a traced process, the worker, a child inside the worker's
 * closed window, and their children through a parent alive in this scan. Past the cap, the returned `tracked` drops the
 * identities this scan did not find, and `overflow` says whether it still holds too many.
 */
export function windowsLeftovers(rows: readonly WindowsProcessRow[], tracked: readonly WindowsProcessIdentity[],
  traced: readonly TracedProcess[]): { remaining: LeftoverProcess[]; tracked: WindowsProcessIdentity[];
  traced: TracedProcess[]; overflow: boolean } {
  const timed = rows.filter((row): row is WindowsProcessRow & { created: number } => row.created !== null);
  const holds = (identity: WindowsProcessIdentity, row: { pid: number; created: number }) =>
    row.pid === identity.pid && row.created >= identity.createdFrom && row.created <= identity.createdTo;
  const childOf = (identity: WindowsProcessIdentity, row: WindowsProcessRow & { created: number }) =>
    row.parentPid === identity.pid && row.created >= identity.createdFrom
      && (identity.childrenTo === null || row.created <= identity.childrenTo)
      && !timed.some(other => other.pid === identity.pid && !holds(identity, other) && other.created <= row.created);
  const found = new Map(timed.filter(row => tracked.some(identity => holds(identity, row) || childOf(identity, row)))
    .map(row => [row.pid, row]));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of timed) {
      const parent = found.get(row.parentPid);
      if (found.has(row.pid) || !parent || row.created < parent.created) continue;
      found.set(row.pid, row);
      grew = true;
    }
  }
  const remaining = [...found.values()].map(({ pid, name, created }) => ({ pid, name, start: created }));
  const added = remaining.filter(({ pid, start }) => !tracked.some(identity =>
    identity.pid === pid && identity.createdFrom === start && identity.createdTo === start))
    .map(({ pid, start }) => ({ pid, createdFrom: start, createdTo: start, childrenTo: null }));
  // The worker's window is a few seconds wide, and its children's window closes when its exit was observed.
  const worker = tracked.filter(identity => identity.createdFrom < identity.createdTo);
  const seeds = remaining.filter(leftover => isTraced(traced, leftover) || worker.some(identity =>
    holds(identity, { pid: leftover.pid, created: leftover.start })
    || (identity.childrenTo !== null && childOf(identity, found.get(leftover.pid)!))));
  const parents = [...found.values()].map(({ pid, parentPid, created }) => ({ pid, parentPid, start: created }));
  // A process this scan did not find starts nothing more, and each child of it that runs is in this scan, so it is
  // tracked by its own identity.
  const all = [...tracked, ...added];
  const kept = all.length <= MAX_TRACKED_PROCESSES ? all
    : all.filter(identity => timed.some(row => holds(identity, row)));
  return { remaining, tracked: kept.slice(0, MAX_TRACKED_PROCESSES), overflow: kept.length > MAX_TRACKED_PROCESSES,
    traced: traceable(traced, remaining, traceLiveDescendants(parents, new Set(seeds.map(({ pid }) => pid)))) };
}

export function isTraced(traced: readonly TracedProcess[], candidate: TracedProcess): boolean {
  return traced.some(({ pid, start }) => pid === candidate.pid && start === candidate.start);
}

/**
 * Issue #121. The seeds, then each process whose parent is traced and in the same scan, so still alive and holding its
 * PID, and which started no earlier than that parent, until nothing changes.
 */
function traceLiveDescendants(processes: readonly { pid: number; parentPid: number; start: number }[],
  seeds: ReadonlySet<number>): Set<number> {
  const traced = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const child of processes) {
      const parent = processes.find(candidate => candidate.pid === child.parentPid);
      if (traced.has(child.pid) || !parent || !traced.has(parent.pid) || child.start < parent.start) continue;
      traced.add(child.pid);
      grew = true;
    }
  }
  return traced;
}

/**
 * `traced` plus the found processes whose PID is in `pids`, or every found process when `pids` is left out. Past the
 * cap, it drops the traced processes this scan did not find, so an ended one makes room for one that runs.
 */
function traceable(traced: readonly TracedProcess[], found: readonly LeftoverProcess[],
  pids?: ReadonlySet<number>): TracedProcess[] {
  const added = found.filter(leftover => (!pids || pids.has(leftover.pid)) && !isTraced(traced, leftover))
    .map(({ pid, start }) => ({ pid, start }));
  const all = [...traced, ...added];
  const kept = all.length <= MAX_TRACED_PROCESSES ? all : all.filter(identity => isTraced(found, identity));
  return kept.slice(0, MAX_TRACED_PROCESSES);
}

/** The target that finds a stopped worker's processes again, or null on a platform Vivary cannot check. */
export async function workerCleanupTarget(
  pid: number | undefined, forkedFrom: number, forkedTo: number, exitedAt: number | null,
): Promise<CleanupTarget | null> {
  if (!pid) return null;
  // The worker leads its own process group on Linux, so the group id is its PID.
  if (process.platform === "linux") {
    return { platform: "linux", groupId: pid, bootId: await readBootId(), traced: [] };
  }
  if (process.platform !== "win32") return null;
  return windowsWorkerTarget(pid, forkedFrom, forkedTo, exitedAt);
}

export function windowsWorkerTarget(pid: number, forkedFrom: number, forkedTo: number,
  exitedAt: number | null): Extract<CleanupTarget, { platform: "win32" }> {
  return { platform: "win32", tracked: [{ pid, createdFrom: forkedFrom - CLOCK_TOLERANCE_MS,
    createdTo: forkedTo + CLOCK_TOLERANCE_MS,
    childrenTo: exitedAt === null ? null : exitedAt + CLOCK_TOLERANCE_MS }], traced: [] };
}

function readBootId(): Promise<string | null> {
  return readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then(text => BOOT_ID_PATTERN.test(text.trim()) ? text.trim() : null, () => null);
}

/** What a check reads, and how End them ends processes. Tests pass their own. */
type CleanupIo = {
  bootId: () => Promise<string | null>;
  proc: LinuxProcReader;
  windowsProcesses: () => Promise<WindowsProcessRow[]>;
  windowsEnd: (processes: readonly LeftoverProcess[]) => Promise<EndAttempt[]>;
};

export const cleanupIo: CleanupIo = {
  bootId: readBootId, proc: linuxProc, windowsProcesses: scanWindowsProcesses, windowsEnd: endWindowsProcesses,
};

/** A reboot ended every process, and after one an unrelated group can hold the same small id. */
async function rebootedSince(target: Extract<CleanupTarget, { platform: "linux" }>, io: CleanupIo): Promise<boolean> {
  const bootId = await io.bootId();
  return target.bootId !== null && bootId !== null && target.bootId !== bootId;
}

/** Keep only a fixed diagnostic category. Child-process errors can contain commands and stderr. */
function windowsScanFailure(error: unknown): WindowsScanFailure {
  if (error instanceof Error) {
    const cause = error.cause;
    if (error.name === "TimeoutError" || (error.name === "AbortError" && cause && typeof cause === "object"
      && "name" in cause && cause.name === "TimeoutError")) return "timeout";
    if (error.name === "AbortError") return "aborted";
  }
  if (error && typeof error === "object") {
    if ("code" in error) {
      if (error.code === "EPERM" || error.code === "EACCES") return "access-denied";
      if (error.code === "ENOENT") return "command-not-found";
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
      if (error.code === "VIVARY_WINDOWS_SCAN_OUTPUT") return "invalid-output";
    }
    if ("killed" in error && error.killed === true) return "timeout";
  }
  return "command-failed";
}

async function scanWindowsTarget(target: Extract<CleanupTarget, { platform: "win32" }>, io: CleanupIo,
): Promise<CleanupCheck> {
  if (target.overflow) return { result: "unavailable", reason: "tracking-overflow" };
  let rows: WindowsProcessRow[];
  try { rows = await io.windowsProcesses(); } catch (error) { return { result: "unavailable", reason: windowsScanFailure(error) }; }
  const { remaining, tracked, traced, overflow } = windowsLeftovers(rows, target.tracked, target.traced);
  return remaining.length === 0 ? { result: "clean" } : { result: "remaining", remaining, hidden: false,
    target: { platform: "win32", tracked, traced, ...(overflow ? { overflow: true as const } : {}) } };
}

function linuxGroupCheck(observation: LinuxGroupObservation,
  target: Extract<CleanupTarget, { platform: "linux" }>): CleanupCheck {
  if (!observation.members.length && !observation.hidden) return { result: "clean" };
  const remaining = observation.members.map(({ pid, name, start }) => ({ pid, name, start }));
  const seeds = new Set(remaining.filter(member => isTraced(target.traced, member)).map(({ pid }) => pid));
  const traced = traceable(target.traced, remaining, traceLiveDescendants(observation.members, seeds));
  return { result: "remaining", remaining, hidden: observation.hidden, target: { ...target, traced } };
}

/**
 * Issue #121. Whether a stopped worker's processes are gone. A check only reads and never acts on a process. A Linux
 * group gets up to a second to empty. A read or scan that fails is `unavailable`, never `clean`.
 */
export async function checkWorkerCleanup(target: CleanupTarget, io: CleanupIo = cleanupIo): Promise<CleanupCheck> {
  if (target.platform === "win32") return scanWindowsTarget(target, io);
  if (await rebootedSince(target, io)) return { result: "clean" };
  try {
    await waitForLinuxWorkerGroupExit(target.groupId, groupId => scanLinuxWorkerGroup(groupId, io.proc),
      CLEANUP_CHECK_MS);
    return { result: "clean" };
  } catch (error) {
    const observation = error instanceof VivaryCodeWorkerCleanupError ? error.observation : undefined;
    return observation ? linuxGroupCheck(observation, target) : { result: "unavailable" };
  }
}

/**
 * Issue #121. The check right after a failed stop. This host just stopped that group or tree, so every process the
 * check finds belongs to the run and is traced, so End them may end it.
 */
export async function checkStoppedWorker(target: CleanupTarget, io: CleanupIo = cleanupIo): Promise<CleanupCheck> {
  const check = await checkWorkerCleanup(target, io);
  return check.result === "remaining"
    ? { ...check, target: { ...check.target, traced: traceable(check.target.traced, check.remaining) } } : check;
}

/**
 * Issue #121. Ends one Linux group member only when its `stat`, read again right before the kill, still shows the
 * recorded start time and group. No other read or process step comes between that read and the kill.
 */
async function endLinuxProcess(groupId: number, leftover: LeftoverProcess, proc: LinuxProcReader): Promise<EndOutcome> {
  let stat: ReturnType<typeof readLinuxProcStat>;
  try { stat = readLinuxProcStat(await proc.stat(String(leftover.pid))); }
  catch (error) { return errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH" ? "gone" : "failed"; }
  if (stat.start !== leftover.start || stat.processGroup !== groupId) return "mismatched";
  if (stat.state === "Z" || stat.state === "X") return "gone";
  try {
    proc.kill(leftover.pid);
    return "ended";
  } catch (error) { return errorCode(error) === "ESRCH" ? "gone" : "failed"; }
}

/** What one End them tried, and the check after it. */
export type EndResult = { attempts: EndAttempt[]; check: CleanupCheck };

/**
 * Issue #121. The owner's End them. It tries each process the owner was shown that Vivary traced to the run, never this
 * host, newest first, so a child goes before the parent whose exit could free the child's PID for another program. Each
 * end checks the process's identity at the moment it acts. Then one check says what is left.
 */
export async function endWorkerLeftovers(target: CleanupTarget, shown: readonly LeftoverProcess[],
  io: CleanupIo = cleanupIo): Promise<EndResult> {
  const candidates = shown.filter(leftover => leftover.pid !== process.pid && isTraced(target.traced, leftover))
    .sort((left, right) => right.start - left.start);
  let attempts: EndAttempt[] = [];
  if (candidates.length && target.platform === "win32") {
    attempts = await io.windowsEnd(candidates)
      .catch(() => candidates.map(leftover => ({ ...leftover, outcome: "unknown" as const })));
  } else if (candidates.length && target.platform === "linux") {
    const rebooted = await rebootedSince(target, io);
    for (const leftover of candidates) {
      attempts.push({ ...leftover,
        outcome: rebooted ? "gone" : await endLinuxProcess(target.groupId, leftover, io.proc) });
    }
  }
  return { attempts, check: await checkWorkerCleanup(target, io) };
}
