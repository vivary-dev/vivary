import { execFile } from "node:child_process";
import path from "node:path";

import { setTextRedactor } from "@agent-native/core/audit";
import { executeCodeAgentRun, getCodeAgentRunRecord } from "@agent-native/core/code-agents";
import { runWithRequestContext } from "@agent-native/core/server";

import { resolveVivaryRuntimeCommand } from "./local-runtime-setup";

import { isVivaryCodeWorkerRequest } from "./code-execution-protocol";
import { createFingerprintRedactor } from "./credential-redaction.ts";

const controller = new AbortController();
let started = false;
const pendingResponses = new Map<string, (result: Record<string, unknown>) => void>();

function reply(message: Record<string, unknown>) {
  if (!process.connected || !process.send) return;
  try { process.send(message, () => undefined); } catch {
    // Parent teardown may close IPC before the final status reaches it.
  }
}

async function receive(message: unknown) {
  if (message && typeof message === "object" && "type" in message && message.type === "vivary:code-worker:abort") {
    controller.abort();
    return;
  }
  if (message && typeof message === "object" && "type" in message && message.type === "vivary:code-worker:response"
      && "requestId" in message && typeof message.requestId === "string" && "result" in message
      && message.result && typeof message.result === "object" && !Array.isArray(message.result)) {
    pendingResponses.get(message.requestId)?.(message.result as Record<string, unknown>);
    pendingResponses.delete(message.requestId);
    return;
  }
  if (started || !isVivaryCodeWorkerRequest(message)) return;
  started = true;
  // Issue #97. Core redacts each transcript event before it is written, using fingerprints of the
  // host's held credentials. The CLI this worker starts can read this process, so the host sends
  // fingerprints rather than values. For the same reason the host starts this worker without credential-shaped names (#98).
  const redact = createFingerprintRedactor(message.redaction).redact;
  setTextRedactor(redact);
  const record = getCodeAgentRunRecord(message.runId);
  const engine = record?.metadata?.engine;
  if (!record || record.metadata?.ownerEmail !== message.ownerEmail ||
      record.metadata?.app !== "vivary-workbench-local-code" ||
      (engine !== "claude-cli" && engine !== "codex-cli")) {
    reply({ type: "vivary:code-worker:failed", runId: message.runId });
    return;
  }
  try {
    const launch = await resolveVivaryRuntimeCommand(engine);
    if (!launch) throw new Error(`${engine === "claude-cli" ? "Claude Code" : "Codex"} could not be started. Refresh Runtime settings.`);
    if (!record.cwd) throw new Error("The saved workspace is unavailable.");
    const savedModel = typeof record.metadata?.model === "string" ? record.metadata.model
      : engine === "claude-cli" ? "sonnet" : "default";
    if (message.model !== savedModel) throw new Error("The saved coding model changed. Reopen the conversation.");
    await runWithRequestContext({ userEmail: message.ownerEmail, orgId: message.orgId }, () =>
      executeCodeAgentRun({
        runId: message.runId,
        ...(engine === "claude-cli" ? { claudeCli: { command: launch.executable, argsPrefix: launch.prefix, env: launch.env } }
          : { codexCli: { command: launch.executable, argsPrefix: launch.prefix,
          env: launch.env, configMode: "native" as const,
          permissionMode: message.permissionMode ?? "normal",
          onRequest: (request: { requestId: string; method: string; params: Record<string, unknown> }) => new Promise<Record<string, unknown>>(resolve => {
            pendingResponses.set(request.requestId, resolve);
            reply({ type: "vivary:code-worker:request", runId: message.runId, request });
          }),
          onRequestResolved: (requestId: string) => {
            pendingResponses.delete(requestId);
            reply({ type: "vivary:code-worker:resolved", runId: message.runId, requestId });
          } } }),
        prompt: message.prompt,
        model: message.model,
        appendUserEvent: false,
        streamToolOutputToStdout: false,
        signal: controller.signal,
      }));
    reply({ type: "vivary:code-worker:done", runId: message.runId });
  } catch (error) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "The Native coding executor failed.";
    reply({ type: "vivary:code-worker:failed", runId: message.runId, error: redact(detail).slice(0, 700) });
  }
  // Keep the ancestor alive until the parent has stopped the owned process tree.
}

// This file is a separate Nitro entry, never imported by the HTTP application.
if (process.connected && process.send) {
  process.on("message", message => { void receive(message); });
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  process.once("disconnect", () => {
    controller.abort();
    setTimeout(() => {
      if (process.platform === "win32") {
        // guard:allow-env-credential - OS directory selects the fixed emergency tree-stop command.
        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        execFile(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(process.pid), "/T", "/F"], {
          windowsHide: true, shell: false, timeout: 3_000, maxBuffer: 16 * 1024,
        }, () => process.exit(1));
      } else {
        try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
      }
    }, 1_000);
  });
  reply({ type: "vivary:code-worker:ready" });
}
