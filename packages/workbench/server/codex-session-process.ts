import { spawn } from "node:child_process";
import type { CodexSessionLogLifecycle } from "@agent-native/core/code-agents";
import { CLEANUP_EXIT_RESERVE_MS, CLEANUP_TIMEOUT_MS, checkWorkerCleanup, cleanupIo, endWindowsProcesses, endWorkerLeftovers, hardStopWorkerTree,
  scanWindowsProcesses, waitForLinuxWorkerGroupExit, windowsLeftovers, windowsWorkerTarget,
  workerCleanupTarget, VivaryCodeWorkerCleanupError, type CleanupTarget } from "./code-execution-host";
import { resolveVivaryRuntimeCommand } from "./local-runtime-setup";

const PRE_STOP_OBSERVATION_TIMEOUT_MS = 3_000;
const GRACEFUL_EXIT_MS = 1_000;

type ReaderProcess = NonNullable<Awaited<ReturnType<CodexSessionLogLifecycle["open"]>>> & {
  // Keep this live after close returns: an escaped helper may still own inherited output descriptors.
  pipesClosed: () => boolean;
};
type ReaderHost = {
  closing: boolean;
  shutdown: Promise<void> | null;
  active: Set<ReaderProcess>;
  opening: Set<Promise<ReaderProcess | null>>;
  unconfirmed: Map<ReaderProcess, CleanupTarget | "uncheckable">;
};
// Nitro's plugin and source actions may load separate modules, but own one process registry and shutdown promise.
const readerHostKey = Symbol.for("vivary.workbench.codex-session-readers");
const readerProcess = globalThis as typeof globalThis & { [readerHostKey]?: ReaderHost };
const host = readerProcess[readerHostKey] ??= {
  closing: false, shutdown: null, active: new Set(), opening: new Set(), unconfirmed: new Map(),
};

async function checkRetainedCleanup(): Promise<boolean> {
  for (const [owner, target] of host.unconfirmed) {
    if (target === "uncheckable" || !owner.pipesClosed()) continue;
    const check = await checkWorkerCleanup(target).catch(() => null);
    // A concurrent close may have replaced this owner's target while the check awaited IO.
    if (host.unconfirmed.get(owner) !== target) continue;
    if (check?.result === "clean" && owner.pipesClosed()) host.unconfirmed.delete(owner);
    else if (check?.result === "remaining") host.unconfirmed.set(owner, check.target);
  }
  return host.unconfirmed.size === 0;
}

/** Close admission synchronously, then await every owned reader; a failed shutdown remains failed on later hooks. */
export function shutdownCodexSessionReaders(): Promise<void> {
  host.closing = true;
  host.shutdown ??= (async () => {
    const closes = [...host.active].map(process => process.close());
    const results = await Promise.allSettled(closes);
    await Promise.allSettled([...host.opening]);
    if (results.some(result => result.status === "rejected" || !result.value) || !await checkRetainedCleanup()) {
      throw new VivaryCodeWorkerCleanupError();
    }
  })();
  return host.shutdown;
}

export const codexSessionLogLifecycle: CodexSessionLogLifecycle = {
  open(cwd) {
    if (host.closing) return Promise.resolve(null);
    const request = openReader(cwd);
    host.opening.add(request);
    return request.finally(() => host.opening.delete(request));
  },
};

async function openReader(cwd: string | undefined): Promise<ReaderProcess | null> {
  // These are the platforms where the existing host can verify descendant identities after a stop.
  if (process.platform !== "linux" && process.platform !== "win32") return null;
  if (!await checkRetainedCleanup() || host.closing) return null;
  const launch = await resolveVivaryRuntimeCommand("codex-cli");
  if (!launch || host.closing) return null;
  const from = Date.now();
  const child = spawn(launch.executable, [...launch.prefix, "app-server", "--listen", "stdio://"], {
    cwd, env: launch.env, shell: false, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const to = Date.now();
  let exitedAt: number | null = null, didClose = false;
  child.once("exit", () => { exitedAt = Date.now(); });
  child.on("error", () => undefined);
  const closed = new Promise<void>(resolve => child.once("close", () => { didClose = true; resolve(); }));
  // Retain ancestry while it is live: post-stop scans cannot reconstruct an already exited intermediate.
  let windowsTarget = process.platform === "win32" && child.pid ? windowsWorkerTarget(child.pid, from, to, null) : null;
  const windowsRoot = windowsTarget?.tracked[0];
  let rootObserved = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanAbort: AbortController | undefined;
  let activeScan: Promise<boolean> | undefined;
  let lastObservationSucceeded = false;
  let trackingStopped = false;
  const observeWindows = () => {
    if (!windowsTarget || activeScan || trackingStopped) return;
    const controller = new AbortController();
    scanAbort = controller;
    activeScan = scanWindowsProcesses(controller.signal).then(rows => {
      if (controller.signal.aborted || !windowsTarget) { lastObservationSucceeded = false; return false; }
      // A valid whole-system scan alone cannot establish ancestry after the original root has vanished.
      rootObserved ||= rows.some(row => windowsRoot && row.pid === windowsRoot.pid && row.created !== null
        && row.created >= windowsRoot.createdFrom && row.created <= windowsRoot.createdTo);
      if (!rootObserved) { lastObservationSucceeded = false; return false; }
      const observed = windowsLeftovers(rows, windowsTarget.tracked, windowsTarget.traced);
      windowsTarget = { platform: "win32", tracked: observed.tracked, traced: observed.traced,
        ...(windowsTarget.overflow || observed.overflow ? { overflow: true } : {}) };
      lastObservationSucceeded = true;
      return true;
    }).catch(() => { lastObservationSucceeded = false; return false; }).finally(() => {
      activeScan = undefined;
      if (!trackingStopped) scanTimer = setTimeout(observeWindows, 1_000);
    });
  };
  observeWindows();
  let closing: Promise<boolean> | undefined;
  const owned: ReaderProcess = { child, pipesClosed: () => didClose, close: () => closing ??= (async () => {
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    trackingStopped = true;
    clearTimeout(scanTimer);
    const pendingScan = activeScan;
    let observationConfirmed = !windowsTarget || lastObservationSucceeded;
    if (pendingScan) {
      // Finish the live snapshot before termination can erase an intermediate parent.
      // Reserve the rest of the same cleanup budget for tree stop, pipe closure and verification.
      observationConfirmed = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { scanAbort?.abort(); resolve(false); },
          Math.min(PRE_STOP_OBSERVATION_TIMEOUT_MS, Math.max(1, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS)));
        void pendingScan.then(result => { clearTimeout(timer); resolve(result); });
      });
    }
    const waitForClosure = (timeoutMs: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, timeoutMs));
      void closed.then(() => { clearTimeout(timer); resolve(); });
    });
    // The supported app-server teardown starts with EOF; drain output so buffered writes cannot block its exit.
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.once("error", () => undefined);
    child.stdin.end();
    await waitForClosure(Math.min(GRACEFUL_EXIT_MS, Math.max(0, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS)));
    if (!didClose && (process.platform !== "win32" || exitedAt === null)) {
      try {
        await hardStopWorkerTree(child, exitedAt !== null, Math.max(1, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS));
      } catch { /* Retained identities and pipe closure determine the result after a failed fallback. */ }
    }
    child.stdin.destroy();
    await pendingScan;
    if (windowsTarget && child.pid && exitedAt !== null) {
      const seed = windowsWorkerTarget(child.pid, from, to, exitedAt).tracked[0];
      windowsTarget.tracked = windowsTarget.tracked.map(identity => identity.pid === seed.pid
        && identity.createdFrom >= seed.createdFrom && identity.createdTo <= seed.createdTo
        ? { ...identity, childrenTo: seed.childrenTo } : identity);
    }
    if (!observationConfirmed) {
      // A later root-only snapshot cannot recover ancestry lost before observation; never clear this with that scan.
      host.unconfirmed.set(owned, "uncheckable");
      await waitForClosure(deadline - Date.now());
      return false;
    }
    const target = windowsTarget ?? await workerCleanupTarget(child.pid, from, to, exitedAt).catch(() => null);
    if (target) {
      // Keep the target while the final scan is pending, including across shutdown and duplicated modules.
      host.unconfirmed.set(owned, target);
      const remainingSignal = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new DOMException("Reader cleanup deadline expired.", "TimeoutError");
        return AbortSignal.timeout(remaining);
      };
      const io = target.platform === "win32" ? { ...cleanupIo,
        windowsProcesses: () => scanWindowsProcesses(remainingSignal()),
        windowsEnd: (processes: Parameters<typeof endWindowsProcesses>[0]) => endWindowsProcesses(processes, remainingSignal()),
      } : cleanupIo;
      let check = Date.now() >= deadline ? null : await checkWorkerCleanup(target, io).catch(() => null);
      if (check?.result === "remaining" && Date.now() < deadline) {
        host.unconfirmed.set(owned, check.target);
        if (target.platform === "win32") {
          // An exited root cannot receive taskkill /T; end only retained, safely traced PID/creation identities.
          check = await endWorkerLeftovers(check.target, check.remaining, io).then(result => result.check, () => null);
        } else {
          // EOF can close the root's pipes while an ordinary same-group helper remains.
          try {
            await hardStopWorkerTree(child, exitedAt !== null, Math.max(1, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS));
            if (child.pid) await waitForLinuxWorkerGroupExit(child.pid, undefined, deadline - Date.now());
          } catch { /* The identity recheck remains authoritative. */ }
          check = await checkWorkerCleanup(check.target, io).catch(() => null);
        }
      }
      await waitForClosure(deadline - Date.now());
      if (didClose && check?.result === "clean") { host.unconfirmed.delete(owned); return true; }
      host.unconfirmed.set(owned, check?.result === "remaining" ? check.target : host.unconfirmed.get(owned) ?? target);
      return false;
    }
    if (didClose && !child.pid) return true;
    host.unconfirmed.set(owned, "uncheckable");
    return false;
  })().catch(() => { if (!host.unconfirmed.has(owned)) host.unconfirmed.set(owned, "uncheckable"); return false; })
    .finally(() => host.active.delete(owned)) };
  host.active.add(owned);
  return owned;
}
