import {
  CLEANUP_EXIT_RESERVE_MS, CLEANUP_TIMEOUT_MS, checkWorkerCleanup, hardStopWorkerTree, waitForLinuxWorkerGroupExit,
  workerCleanupTarget,
  type CleanupCheck, type CleanupFailure, type CleanupTarget,
} from "./code-execution-host";
import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveVivaryRuntimeCommand, type CommandLaunch } from "./local-runtime-setup";

const modelSchema = z.object({
  model: z.string().min(1).max(128), displayName: z.string().min(1).max(200),
  isDefault: z.boolean(), hidden: z.boolean().optional(),
});
const modelsSchema = z.object({ data: z.array(modelSchema).max(200), nextCursor: z.string().nullable().optional() });
const configSchema = z.object({ config: z.object({
  model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(),
  model_providers: z.record(z.string(), z.unknown()).optional(),
  mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() }).passthrough()).optional(),
}) });
const accountSchema = z.object({ account: z.object({ type: z.literal("chatgpt") }).passthrough() });
export type CodexModelCatalog =
  | { status: "ready"; models: { id: string; label: string }[]; defaultModel: string; connections: string[]; message: string }
  | { status: "unavailable"; message: string };
const unavailable = (): CodexModelCatalog => ({ status: "unavailable",
  message: "Codex could not report its subscription models. Check Codex in your terminal, then refresh Runtime settings." });
const cleanupUnavailable = (): CodexModelCatalog => ({ status: "unavailable",
  // A restart clears the refusal but not the processes, so the owner ends them first.
  message: "Vivary could not confirm that Codex stopped after checking models. Refresh Runtime settings in a moment. "
    + "If this message stays, end any Codex processes still running on the computer that runs Vivary, "
    + "then restart Vivary.",
});
// Issue #130. What finds again the processes of each Codex whose stop a model check could not confirm. While a check
// still finds any, a model check starts no other Codex, so repeated refreshes cannot pile them up. Every model check
// looks again first, so a stop that finishes late needs no restart.
const unconfirmedStops = new Set<CleanupTarget>();
const cache = new Map<string, { expiresAt: number; value: CodexModelCatalog }>();
const pending = new Map<string, Promise<CodexModelCatalog>>();

export function parseCodexCatalog(modelsValue: unknown, configValue: unknown, accountValue: unknown): CodexModelCatalog {
  const models = modelsSchema.safeParse(modelsValue);
  const config = configSchema.safeParse(configValue);
  if (!models.success || !config.success || !accountSchema.safeParse(accountValue).success) return unavailable();
  const settings = config.data.config;
  if ((settings.model_provider && settings.model_provider !== "openai") || settings.model_providers?.openai !== undefined) return {
    status: "unavailable", message: "Codex is configured for another provider. Select the ChatGPT provider in Codex to use your subscription here.",
  };
  // A partial catalog must not silently hide available choices.
  if (models.data.nextCursor) return unavailable();
  const visible = models.data.data.filter(model => !model.hidden);
  const preferred = visible.find(model => model.model === settings.model)
    ?? visible.find(model => model.isDefault) ?? visible[0];
  if (!preferred) return unavailable();
  const unique = [...new Map(visible.map(model => [model.model, model])).values()];
  unique.sort((a, b) => Number(b.model === preferred.model) - Number(a.model === preferred.model));
  return {
    status: "ready", models: unique.map(model => ({ id: model.model, label: model.displayName })),
    defaultModel: preferred.model,
    connections: Object.entries(settings.mcp_servers ?? {}).filter(([, server]) => server.enabled !== false).map(([name]) => name),
    message: settings.model && settings.model !== preferred.model
      ? "The configured Codex model is not in its reported catalog. Choose an available model."
      : "Models and configured connections come from Codex. Credentials stay with Codex.",
  };
}

export async function getCodexModels(cwd: string, { refresh = false }: { refresh?: boolean } = {}): Promise<CodexModelCatalog> {
  const active = pending.get(cwd);
  if (active) return active;
  const previous = cache.get(cwd);
  if (!refresh && previous && previous.expiresAt > Date.now()) return previous.value;
  const request = (async () => {
    const launch = await resolveVivaryRuntimeCommand("codex-cli");
    const value = launch ? await probeCodexModels(launch, cwd) : unavailable();
    if (cache.size >= 32) cache.delete(cache.keys().next().value ?? "");
    cache.set(cwd, { expiresAt: Date.now() + 30_000, value });
    return value;
  })().catch(unavailable).finally(() => pending.delete(cwd));
  pending.set(cwd, request);
  return request;
}

let unconfirmedStopLook: Promise<boolean> | undefined;

/**
 * Whether an unconfirmed Codex stop still leaves processes. A clean check drops its target. Model checks that start
 * during a look share it, so each target is checked once and replaced by one updated target, never a copy per caller.
 */
function unconfirmedStopRemains(checkCleanup: typeof checkWorkerCleanup): Promise<boolean> {
  unconfirmedStopLook ??= (async () => {
    await Promise.all([...unconfirmedStops].map(async target => {
      const check = await checkCleanup(target).catch((): CleanupCheck => ({ result: "unavailable" }));
      if (check.result === "unavailable") return;
      unconfirmedStops.delete(target);
      // A Windows check also tracks the processes it found, so their children stay linked after their parent exits.
      if (check.result === "remaining") unconfirmedStops.add(check.target);
    }));
    return unconfirmedStops.size > 0;
  })().finally(() => { unconfirmedStopLook = undefined; });
  return unconfirmedStopLook;
}

/** Read safe catalog fields over Codex's supported protocol without starting a thread or model turn. */
export async function probeCodexModels(
  launch: CommandLaunch, cwd: string, timeoutMs = 12_000,
  // Tests pass their own tree stop, check, and budget to produce the slow and failed stops a loaded Windows host shows.
  { stopTree = hardStopWorkerTree, checkCleanup = checkWorkerCleanup, stopBudgetMs = CLEANUP_TIMEOUT_MS }: {
    stopTree?: typeof hardStopWorkerTree; checkCleanup?: typeof checkWorkerCleanup; stopBudgetMs?: number;
  } = {},
): Promise<CodexModelCatalog> {
  if (await unconfirmedStopRemains(checkCleanup)) return cleanupUnavailable();
  return new Promise(resolve => {
    // The host clock just before and after the spawn, and at the exit, bounds Codex's Windows identity for a check.
    const spawnedFrom = Date.now();
    const child = spawn(launch.executable, [...launch.prefix, "app-server", "--listen", "stdio://"], {
      cwd, env: launch.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
    });
    const spawnedTo = Date.now();
    let exitedAt: number | null = null;
    child.once("exit", () => { exitedAt = Date.now(); });
    let buffer = "";
    let bytes = 0;
    let complete = false;
    const replies = new Map<number, unknown>();
    let didClose = false;
    const closed = new Promise<void>(done => child.once("close", () => { didClose = true; done(); }));
    const waitClosed = (ms: number) => new Promise<boolean>(done => {
      // A starved host can run this timer before the poll phase delivers a close that already happened, so the
      // verdict waits one more turn and reads the close the host observed.
      const timeout = setTimeout(() => setImmediate(() => done(didClose)), Math.max(0, ms));
      void closed.then(() => { clearTimeout(timeout); done(true); });
    });
    // Issue #130. One budget for the whole stop, from its first step, as in the Code host. A tree stop that succeeds,
    // followed by Codex closing its pipes within the budget, finishes the stop. Otherwise this returns the failed step.
    const stopCodex = async (): Promise<CleanupFailure | null> => {
      const deadline = Date.now() + stopBudgetMs;
      if (!await waitClosed(Math.min(1_000, stopBudgetMs))) {
        const treeError = await stopTree(child, false, Math.max(1, deadline - Date.now() - CLEANUP_EXIT_RESERVE_MS))
          .then(() => undefined, (error: unknown) => error);
        const closedInTime = await waitClosed(deadline - Date.now());
        if (treeError !== undefined) return { step: process.platform === "win32" ? "taskkill" : "group", error: treeError };
        if (!closedInTime) {
          const timedOut = Object.assign(new Error("Codex did not close within the stop budget."), { code: "timeout" });
          return { step: "exit", error: timedOut };
        }
      }
      // On Linux the group can still hold processes that closed no pipe. As in the Code host, the stop waits for the
      // group to empty, because a delivered SIGKILL does not mean its members have ended.
      if (process.platform !== "win32") {
        try {
          await stopTree(child, true);
          if (process.platform === "linux" && child.pid) {
            await waitForLinuxWorkerGroupExit(child.pid, undefined, deadline - Date.now());
          }
        } catch (error) { return { step: "group", error }; }
      }
      return null;
    };
    // Codex closing its pipes does not show that a process holding none of them, such as an MCP server, stopped. So a
    // failed step leaves the verdict to the Code host's #121 check, which only reads. When it finds nothing, the stop
    // finished after all. Otherwise its target is kept until a later check is clean.
    const stopConfirmed = async (failure: CleanupFailure): Promise<boolean> => {
      const target = await workerCleanupTarget(child.pid, spawnedFrom, spawnedTo, exitedAt);
      const check: CleanupCheck = target
        ? await checkCleanup(target).catch((): CleanupCheck => ({ result: "unavailable" }))
        : { result: "unavailable" };
      if (check.result === "clean") return true;
      // The credential redaction plugin redacts server output. Process names and error messages stay out of the log.
      console.error(`[vivary-codex-models] cleanup-unverified step=${failure.step} error=${stopErrorCode(failure.error)} `
        + `scan=${check.result} remaining=${check.result === "remaining" ? check.remaining.length : 0}`);
      if (target) unconfirmedStops.add(check.result === "remaining" ? check.target : target);
      return false;
    };
    const finish = async (value: CodexModelCatalog) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.stdin.end();
      const failure = await stopCodex();
      resolve(failure && !await stopConfirmed(failure) ? cleanupUnavailable() : value);
    };
    const timer = setTimeout(() => finish({ status: "unavailable",
      message: "Codex took too long to report its models. Refresh Runtime settings and try again.",
    }), timeoutMs);
    const send = (message: unknown) => { if (!complete) child.stdin.write(JSON.stringify(message) + "\n"); };
    child.once("error", () => finish(unavailable()));
    child.once("close", () => { void finish(unavailable()); });
    child.stdin.on("error", () => finish(unavailable()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 512 * 1024) { finish(unavailable()); return; }
      buffer += chunk;
      let newline: number;
      while (!complete && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { finish(unavailable()); return; }
        const parsed = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).safeParse(message);
        if (!parsed.success || parsed.data.id === undefined) continue;
        if (parsed.data.error) { finish(unavailable()); return; }
        if (parsed.data.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { limit: 200, includeHidden: false } });
          send({ id: 3, method: "config/read", params: { includeLayers: false, cwd } });
          send({ id: 4, method: "account/read", params: { refreshToken: false } });
        } else if (parsed.data.id >= 2 && parsed.data.id <= 4) {
          replies.set(parsed.data.id, parsed.data.result);
          if (replies.size === 3) finish(parseCodexCatalog(replies.get(2), replies.get(3), replies.get(4)));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "vivary-model-discovery", version: "0.0.0" }, capabilities: {} } });
  });
}

/**
 * A failed stop's error as the log may show it: a code, `timeout` for a bounded `taskkill`, or the error's name, never
 * its message.
 */
function stopErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "none";
  if ("killed" in error && error.killed === true) return "timeout";
  if ("code" in error && (typeof error.code === "string" || typeof error.code === "number")) return String(error.code);
  return error instanceof Error ? error.name : "unknown";
}
