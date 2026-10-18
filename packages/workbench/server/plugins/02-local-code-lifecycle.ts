import { stopRecurringJobs } from "@agent-native/core/jobs";
import { defineNitroPlugin } from "@agent-native/core/server";
import {
  initializeVivaryCodeAgent,
  shutdownVivaryCodeAgent,
} from "../local-code-agent.ts";

import { shutdownCodexSessionReaders } from "../codex-session-process.ts";
import { shutdownOriginalCommands } from "../original-runtime.ts";
import { shutdownProjectPreviews } from "../project-preview.ts";

// Automations get the Code host's 10-second shutdown wait, so a normal quit still
// settles before the desktop ends the server 15 seconds after asking it to stop.
// Every stop starts, even when another throws as it is called, and a failed stop
// is reported only after all of them settle, so the automation stop is always
// waited for. Reader admission closes first; all remaining owners begin their stops in the same pass.
const stopLocalWork = async () => {
  const results = await Promise.allSettled([
    shutdownCodexSessionReaders,
    () => stopRecurringJobs({ timeoutMs: 10_000 }),
    shutdownVivaryCodeAgent, shutdownOriginalCommands, shutdownProjectPreviews,
  ].map(async stop => stop()));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
};

export default defineNitroPlugin(async (nitroApp) => {
  // guard:allow-env-credential - The dedicated CLI and desktop launchers own this process's exit.
  const standalone = process.env.VIVARY_STANDALONE_HOST === "1";
  // guard:allow-env-credential - The Windows desktop parent owns the tree fallback.
  const windowsDesktop = standalone && process.platform === "win32" && process.env.VIVARY_DESKTOP_HOST === "1";
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const cleanup = stopLocalWork().then(() =>
      standalone ? nitroApp.hooks.callHook("close") : undefined);
    void cleanup.then(() => {
      if (standalone) process.exit(0);
    }).catch(() => {
      console.error("[vivary-local-host] Shutdown did not settle.");
      if (standalone && !windowsDesktop) process.exit(1);
    });
  };
  const removeSignalHandlers = () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  nitroApp.hooks.hook("close", async () => {
    removeSignalHandlers();
    await stopLocalWork();
  });
  try {
    await initializeVivaryCodeAgent();
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
});
