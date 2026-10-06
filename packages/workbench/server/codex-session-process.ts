import { spawn } from "node:child_process";
import type { CodexSessionLogLifecycle } from "@agent-native/core/code-agents";
import { CLEANUP_EXIT_RESERVE_MS, CLEANUP_TIMEOUT_MS, checkWorkerCleanup, cleanupIo, hardStopWorkerTree,
  scanWindowsProcesses, waitForLinuxWorkerGroupExit, windowsLeftovers, windowsWorkerTarget,
  workerCleanupTarget, VivaryCodeWorkerCleanupError, type CleanupTarget } from "./code-execution-host";
import { resolveVivaryRuntimeCommand } from "./local-runtime-setup";

const PRE_STOP_OBSERVATION_TIMEOUT_MS = 3_000;

type ReaderProcess = NonNullable<Awaited<ReturnType<CodexSessionLogLifecycle["open"]>>>;
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
    if (target === "uncheckable") continue;
    const check = await checkWorkerCleanup(target).catch(() => null);
    // A concurrent close may have replaced this owner's target while the check awaited IO.
    if (host.unconfirmed.get(owner) !== target) continue;
    if (check?.result === "clean") host.unconfirmed.delete(owner);
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
  const owned: ReaderProcess = { child, close: () => closing ??= (async () => {
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
    try {
      await hardStopWorkerTree(child, exitedAt !== null, Math.max(1, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS));
      if (process.platform === "linux" && child.pid) await waitForLinuxWorkerGroupExit(child.pid, undefined, deadline - Date.now());
    } catch { /* The retained identity scan below is authoritative even when the stop reports failure. */ }
    child.stdin.destroy();
    await pendingScan;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      void closed.then(() => { clearTimeout(timer); resolve(); });
    });
    if (windowsTarget && child.pid && exitedAt !== null) {
      const seed = windowsWorkerTarget(child.pid, from, to, exitedAt).tracked[0];
      windowsTarget.tracked = windowsTarget.tracked.map(identity => identity.pid === seed.pid
        && identity.createdFrom >= seed.createdFrom && identity.createdTo <= seed.createdTo
        ? { ...identity, childrenTo: seed.childrenTo } : identity);
    }
    if (!observationConfirmed) {
      // A later root-only snapshot cannot recover ancestry lost before observation; never clear this with that scan.
      host.unconfirmed.set(owned, "uncheckable");
      return false;
    }
    const target = windowsTarget ?? await workerCleanupTarget(child.pid, from, to, exitedAt).catch(() => null);
    if (target) {
      // Keep the target while the final scan is pending, including across shutdown and duplicated modules.
      host.unconfirmed.set(owned, target);
      const remaining = deadline - Date.now();
      const check = remaining <= 0 ? null : await checkWorkerCleanup(target, target.platform === "win32"
        ? { ...cleanupIo, windowsProcesses: () => scanWindowsProcesses(AbortSignal.timeout(remaining)) } : undefined).catch(() => null);
      if (didClose && check?.result === "clean") { host.unconfirmed.delete(owned); return true; }
      host.unconfirmed.set(owned, check?.result === "remaining" ? check.target : target);
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
