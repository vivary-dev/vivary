import { randomUUID } from "node:crypto";
import path from "node:path";

const CHOOSE_FOLDER_REQUEST = "vivary:project-folder:choose";
const CHOOSE_FOLDER_RESULT = "vivary:project-folder:result";
const CHOOSE_FOLDER_CANCEL = "vivary:project-folder:cancel";
const CHOOSE_FOLDER_TIMEOUT_MS = 120_000;
let pendingChoice = false;

export function desktopHostAvailable(): boolean {
  // guard:allow-env-credential - The desktop launcher marks its private parent-child IPC channel.
  const desktopHost = process.env.VIVARY_DESKTOP_HOST;
  // guard:allow-env-credential - Desktop folder selection requires the local deployment mode.
  const accessMode = process.env.VIVARY_ACCESS_MODE;
  return desktopHost === "1" && accessMode === "local"
    && process.connected === true && typeof process.send === "function";
}

export function chooseDesktopProjectFolder(): Promise<string | null> {
  if (!desktopHostAvailable()) {
    return Promise.reject(new Error("Open the desktop app to choose a project folder."));
  }
  if (pendingChoice) {
    return Promise.reject(new Error("A project folder chooser is already open."));
  }
  const send = process.send;
  if (!send) return Promise.reject(new Error("The desktop connection is unavailable."));
  pendingChoice = true;
  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failure: Error | null, folder: string | null = null) => {
      if (settled) return;
      settled = true;
      pendingChoice = false;
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      process.off("exit", onDisconnect);
      process.off("SIGTERM", onDisconnect);
      process.off("SIGINT", onDisconnect);
      if (failure) reject(failure);
      else resolve(folder);
    };
    const onDisconnect = () => finish(new Error("The desktop connection closed before a folder was selected."));
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "shutdown") { onDisconnect(); return; }
      if (message.type !== CHOOSE_FOLDER_RESULT || !("requestId" in message) || message.requestId !== requestId) return;
      if (Object.keys(message).length === 3 && "error" in message && message.error === "chooser-unavailable") {
        finish(new Error("The desktop could not open the project folder chooser."));
        return;
      }
      if (Object.keys(message).length !== 3 || !("path" in message) ||
          !(message.path === null || isDesktopProjectFolderPath(message.path))) {
        finish(new Error("The desktop returned an invalid folder selection."));
        return;
      }
      finish(null, message.path);
    };
    const timer = setTimeout(() => {
      try {
        if (process.connected) send.call(process, { type: CHOOSE_FOLDER_CANCEL, requestId }, () => undefined);
      } catch {
        // The parent may disconnect while the chooser deadline expires.
      }
      finish(new DOMException("Folder selection timed out. Close the folder chooser and try again.", "TimeoutError"));
    }, CHOOSE_FOLDER_TIMEOUT_MS);
    timer.unref();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.once("exit", onDisconnect);
    process.once("SIGTERM", onDisconnect);
    process.once("SIGINT", onDisconnect);
    try {
      send.call(process, { type: CHOOSE_FOLDER_REQUEST, requestId }, error => {
        if (error) finish(new Error("The desktop could not open the project folder chooser."));
      });
    } catch {
      finish(new Error("The desktop connection is unavailable."));
    }
  });
}

export function isDesktopProjectFolderPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768
    && !value.includes("\0") && path.isAbsolute(value);
}
