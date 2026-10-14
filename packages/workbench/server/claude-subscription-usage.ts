import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { query, type AccountInfo, type SDKControlGetUsageResponse, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { codingRuntimeEnvironment, resolveVivaryRuntimeCommand, type CommandLaunch } from "./local-runtime-setup";
import { checkWorkerCleanup, hardStopWorkerTree, workerCleanupTarget, type CleanupTarget } from "./code-execution-host";

const execute = promisify(execFile);
export const CLAUDE_FUNDING_CLI_VERSIONS = ["2.1.289", "2.1.296", "2.1.300"] as const;
export type ClaudeFundingCliVersion = typeof CLAUDE_FUNDING_CLI_VERSIONS[number];
let unconfirmedStop: CleanupTarget | null = null;

export function claudeSubscriptionProbeLaunch(launch: CommandLaunch, requested: Pick<SpawnOptions, "command" | "args">) {
  const entry = launch.prefix[0] ?? launch.executable;
  const args = requested.command === entry ? requested.args
    : requested.args[0] === entry ? requested.args.slice(1) : null;
  if (!args) throw new Error("The SDK requested an unexpected Claude executable.");
  return { command: launch.executable, args: [...launch.prefix, ...args] };
}

export type ClaudeSubscriptionUsage =
  | { status: "observed"; version: ClaudeFundingCliVersion; account: AccountInfo; usage: SDKControlGetUsageResponse }
  | { status: "unavailable"; message: string };

type UsageReadOptions = { launch?: CommandLaunch; timeoutMs?: number; signal?: AbortSignal };
let ownedRead: Promise<void> = Promise.resolve();
const abortedRead = (): ClaudeSubscriptionUsage => ({ status: "unavailable", message: "Claude subscription check was canceled. No message was sent." });

/** Serialize ownership so a failed cleanup cannot lose its target to another probe. */
export function readClaudeSubscriptionUsage(cwd: string, options: UsageReadOptions = {}): Promise<ClaudeSubscriptionUsage> {
  const request = ownedRead.then(() => options.signal?.aborted ? abortedRead() : readOwnedClaudeSubscriptionUsage(cwd, options));
  ownedRead = request.then(() => undefined, () => undefined);
  return request;
}

/** Read account controls without yielding a user message or starting a model turn. */
async function readOwnedClaudeSubscriptionUsage(cwd: string, {
  launch: suppliedLaunch, timeoutMs = 12_000, signal,
}: UsageReadOptions): Promise<ClaudeSubscriptionUsage> {
  const launch = suppliedLaunch ?? await resolveVivaryRuntimeCommand("claude-cli");
  if (signal?.aborted) return abortedRead();
  if (!launch) return { status: "unavailable", message: "Claude Code is not installed. Open Runtime settings." };
  if (unconfirmedStop) {
    const check = await checkWorkerCleanup(unconfirmedStop).catch(() => ({ result: "unavailable" }));
    if (check.result !== "clean") return { status: "unavailable", message: "A previous Claude usage check has not stopped completely. Refresh Runtime settings after its processes have ended." };
    unconfirmedStop = null;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutMs);
  let releaseInput: (() => void) | undefined;
  let active: ReturnType<typeof query> | undefined;
  let child: ChildProcess | undefined;
  let spawnedFrom = 0, spawnedTo = 0;
  let exitedAt: number | null = null;
  let didClose = false;
  let closed: Promise<void> | undefined;
  let outcome: ClaudeSubscriptionUsage = { status: "unavailable", message: "Claude Code could not verify its subscription allowance and usage-credit setting. Refresh Runtime settings. No message was sent." };
  try {
    const version = await execute(launch.executable, [...launch.prefix, "--version"], {
      cwd, env: launch.env, encoding: "utf8", signal: controller.signal,
      timeout: timeoutMs, maxBuffer: 16 * 1024, windowsHide: true, shell: false,
    });
    const observedVersion = CLAUDE_FUNDING_CLI_VERSIONS.find(value => version.stdout.trim() === `${value} (Claude Code)`);
    if (!observedVersion) {
      outcome = { status: "unavailable", message: `Claude subscription controls are verified for CLI ${CLAUDE_FUNDING_CLI_VERSIONS.join(" or ")}. This installation needs a compatibility check.` };
      return outcome;
    }
    const inputClosed = new Promise<void>(resolve => { releaseInput = resolve; });
    async function* noMessages(): AsyncGenerator<SDKUserMessage> { await inputClosed; }
    if (controller.signal.aborted) return outcome;
    active = query({ prompt: noMessages(), options: {
      cwd, pathToClaudeCodeExecutable: launch.prefix[0] ?? launch.executable,
      env: launch.env, abortController: controller, persistSession: false,
      permissionMode: "plan", tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], extraArgs: { "safe-mode": null },
      spawnClaudeCodeProcess: requested => {
        const resolved = claudeSubscriptionProbeLaunch(launch, requested);
        spawnedFrom = Date.now();
        const spawned = spawn(resolved.command, resolved.args, {
          cwd, env: codingRuntimeEnvironment(requested.env), shell: false, windowsHide: true,
          detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
        });
        child = spawned;
        spawnedTo = Date.now();
        child.once("exit", () => { exitedAt = Date.now(); });
        closed = new Promise(resolve => { spawned.once("close", () => { didClose = true; resolve(); }); });
        return spawned;
      },
    } });
    const account = await active.accountInfo();
    const usage = await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    outcome = { status: "observed", version: observedVersion, account, usage };
  } catch {
    // Leave unavailable reads separate from an observed account control.
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    releaseInput?.();
    try { active?.close(); } catch { controller.abort(); }
    if (child) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        try { if (!didClose || process.platform !== "win32") await hardStopWorkerTree(child, didClose); } catch {
          // A process that ended before the tree stop may still be proved clean below.
        }
        const closedInTime = didClose || await Promise.race([
          closed?.then(() => true) ?? Promise.resolve(false),
          new Promise<false>(resolve => { closeTimer = setTimeout(() => resolve(false), 3_000); }),
        ]);
        const target = await workerCleanupTarget(child.pid, spawnedFrom, spawnedTo, exitedAt);
        const check = target ? await checkWorkerCleanup(target) : { result: "unavailable" };
        if (!closedInTime || check.result !== "clean") {
          unconfirmedStop = target;
          outcome = { status: "unavailable", message: "Vivary could not confirm that the Claude usage check stopped. No message was sent. End its remaining processes before retrying." };
        }
      } catch {
        unconfirmedStop = await workerCleanupTarget(child.pid, spawnedFrom, spawnedTo, exitedAt);
        outcome = { status: "unavailable", message: "Vivary could not confirm that the Claude usage check stopped. No message was sent. End its remaining processes before retrying." };
      } finally { if (closeTimer) clearTimeout(closeTimer); }
    }
  }
  return outcome;
}
