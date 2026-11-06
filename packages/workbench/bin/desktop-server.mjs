import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startVivary, startupOptions } from "./start.mjs";

const sourceFile = fileURLToPath(import.meta.url);
const READY_TIMEOUT_MS = 8_000;
const PARENT_LOSS_TIMEOUT_MS = 15_000;

function send(message) {
  if (!process.connected || !process.send) return;
  try {
    process.send(message, () => undefined);
  } catch {
    // The parent may disconnect between the connected check and send.
  }
}

function forceDisconnectedTree() {
  console.error("[vivary-desktop] Parent disconnected before shutdown completed. Ending the server tree.");
  // guard:allow-env-credential - Windows provides the path to its tree cleanup tool.
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  spawnSync(taskkill, ["/PID", String(process.pid), "/T", "/F"], {
    stdio: "ignore", windowsHide: true, timeout: 5_000,
  });
  console.error("[vivary-desktop] Tree cleanup returned without ending the server.");
  process.exit(1);
}

export async function runDesktopServer(args = process.argv.slice(2)) {
  const windows = process.platform === "win32";
  let stopping = false;
  let nativeHandlersReady = false;
  const requestShutdown = () => {
    if (stopping) return;
    stopping = true;
    send({ type: "stopping" });
    if (!nativeHandlersReady) {
      process.exit(0);
      return;
    }
    process.emit("SIGTERM");
    // Keep IPC open so the parent owns normal shutdown and later loss stays observable.
  };
  process.on("message", (message) => {
    if (message?.type === "shutdown") requestShutdown();
  });
  process.once("disconnect", () => {
    // This must also run when the parent disappears during an existing shutdown.
    if (windows) setTimeout(forceDisconnectedTree, PARENT_LOSS_TIMEOUT_MS);
    requestShutdown();
  });

  const capability = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.off("message", receive); reject(new Error("Desktop capability handoff timed out.")); }, 8000);
    const receive = message => {
      if (message?.type !== "vivary:desktop:bootstrap" || typeof message.capability !== "string" || !/^[\w-]{43}$/.test(message.capability)) return;
      clearTimeout(timer); process.off("message", receive); resolve(message.capability);
    };
    process.on("message", receive);
    send({ type: "vivary:desktop:bootstrap-needed" });
  });
  globalThis[Symbol.for("vivary.desktop.bootstrap")] = Object.freeze({ capability });
  const options = startupOptions(args, process.env);
  if (options.help || options.mode !== "local") {
    throw new Error("The desktop server accepts only validated local startup options.");
  }
  // guard:allow-env-credential - This dedicated server process owns its exit after cleanup.
  process.env.VIVARY_STANDALONE_HOST = "1"; // guard:allow-env-mutation - Desktop process startup only.
  await startVivary(options);
  nativeHandlersReady = true;
  await waitForWorkspace(options.appUrl, capability);
  send({ type: "ready", origin: options.appUrl });
}

export async function waitForWorkspace(origin, capability) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(`${origin}/`, {
        headers: { accept: "text/html", ...(capability ? { "x-vivary-desktop": capability } : {}) },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      lastStatus = response.status;
      const ready = response.ok;
      try {
        await response.body?.cancel();
      } catch {
        // Readiness depends on the response status, not body disposal.
      }
      if (ready) return;
    } catch {
      // The server may still be completing its first local boot.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cause = lastStatus === undefined ? "no HTTP response" : `last HTTP status ${lastStatus}`;
  throw new Error(`Vivary local server did not return a successful GET / response (${cause}).`);
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === sourceFile;
if (directEntry) {
  runDesktopServer().catch((error) => {
    send({
      type: "error",
      message: error instanceof Error ? error.message.slice(0, 1_000) : "Vivary local server failed.",
    });
    process.exitCode = 1;
  });
}
