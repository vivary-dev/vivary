import { desktopCapability, createDesktopCapabilityHandler, attachBrowserAccessDialogs } from "./browser-access.mjs";
import { createDiscordPresenceController } from "./discord-presence.mjs";
import { desktopDataDir } from "./desktop-settings.mjs";
import { fork, spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, session, shell } from "electron";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const DRAFT_CLOSE_TIMEOUT_MS = 8_000;
const DESKTOP_PORT_FILE = "desktop-port";
/**
 * The desktop picks its port from this range. Windows reserves blocks of its
 * dynamic range (49152 to 65535) for Hyper-V, WSL, and Docker, and the blocks
 * move when the computer restarts, so a saved port there could stop working.
 * IANA assigns no service in this range.
 */
export const DESKTOP_PORT_RANGE = Object.freeze({ first: 42100, last: 42999 });
const SAVED_PORT_RETRY_DELAY_MS = 750;
const SAVED_PORT_ATTEMPTS = 5;
const sourceFile = fileURLToPath(import.meta.url);
const sourceRoot = path.dirname(sourceFile);

let mainWindow = null;
let serverChild = null;
let allowQuit = false;
let shutdownPromise = null;
let serverOrigin = null;
let serverCapability = null;
let disposeProjectChooser = () => undefined;
let disposeDiscordPresence = () => undefined;

app.setName("Vivary");
process.once("exit", () => {
  if (serverChild) forceServerTree(serverChild);
});

function workbenchRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "workbench")
    : path.resolve(sourceRoot, "../workbench");
}

function ordinaryNodePath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "node",
      process.platform === "win32" ? "node.exe" : "node",
    );
  }
  const configured = process.env.VIVARY_DESKTOP_NODE?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("Development requires an absolute VIVARY_DESKTOP_NODE path.");
  }
  return configured;
}

/** A free loopback port from DESKTOP_PORT_RANGE, tried in random order. */
export async function selectLoopbackPort({ isFree = loopbackPortIsFree, random = Math.random } = {}) {
  const { first, last } = DESKTOP_PORT_RANGE;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = first + Math.floor(random() * (last - first + 1));
    if (await isFree(port)) return port;
  }
  throw new Error(`Could not find a free local port for Vivary from ${first} to ${last}.`);
}

/**
 * The local server's data folder, the same default that bin/start.mjs uses.
 * The desktop passes it to the server, so the saved port and the data always
 * share one folder.
 */
export { desktopDataDir } from "./desktop-settings.mjs";

async function loopbackPortIsFree(port) {
  const probe = createServer();
  const free = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (free) await new Promise((resolve) => probe.close(resolve));
  return free;
}

async function readSavedPort(dataDir) {
  let text;
  try {
    text = await readFile(path.join(dataDir, DESKTOP_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const port = Number(text.trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** A port in the Windows dynamic range may be reserved after a restart, so it is not reused. */
function isReusablePort(port) {
  return port < 49152;
}

/**
 * A webhook URL names the local port, so the app reuses the port saved in its
 * data folder. A port can be briefly busy while the previous instance lets it
 * go, so the saved port is tried for a few seconds before a new one is taken.
 * A saved port in the dynamic range, which an earlier build could pick, is
 * replaced at once. `saved` is the saved port, or null, so the window says
 * when the port changed.
 */
export async function chooseDesktopPort(dataDir, {
  isFree = loopbackPortIsFree,
  selectPort = selectLoopbackPort,
  retryDelayMs = SAVED_PORT_RETRY_DELAY_MS,
} = {}) {
  const saved = await readSavedPort(dataDir);
  const reusable = saved !== null && isReusablePort(saved);
  for (let attempt = 0; reusable && attempt < SAVED_PORT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    if (await isFree(saved)) return { port: saved, saved };
  }
  return { port: await selectPort(), saved };
}

export function isPortInUseError(error) {
  return error instanceof Error && /already in use/i.test(error.message);
}

/**
 * Start the server on the chosen port. Another program can take the port
 * between the probe and the server's bind, so startup then tries once more on
 * a fresh port instead of failing. `replaced` is the saved port when the
 * server ended up on another one, for the notice.
 */
export async function startOnDesktopPort(choice, launch, { selectPort = selectLoopbackPort } = {}) {
  let port = choice.port;
  let started;
  try {
    started = await launch(port);
  } catch (error) {
    if (!isPortInUseError(error)) throw error;
    port = await selectPort();
    started = await launch(port);
  }
  const replaced = choice.saved !== null && choice.saved !== port ? choice.saved : null;
  return { ...started, port, replaced };
}

export async function saveDesktopPort(dataDir, port) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dataDir, DESKTOP_PORT_FILE), `${port}\n`, { mode: 0o600 });
}

/** The notice shown when the saved port could not be used. */
export function portChangeNotice(replaced, port) {
  return {
    type: "info",
    buttons: ["OK"],
    defaultId: 0,
    title: "Vivary changed its local port",
    message: `Port ${replaced} was unavailable, so Vivary now uses port ${port}.`,
    detail: "Webhook URLs with the old port no longer reach Vivary. Copy each new URL from Automations and update the program that calls it.",
  };
}

export function localChildEnvironment(source = process.env, packaged = app.isPackaged, resources = process.resourcesPath) {
  const environment = { ...source };
  for (const key of [
    "APP_URL",
    "DATABASE_URL",
    "HOST",
    "NITRO_HOST",
    "NITRO_PORT",
    "PORT",
    "VIVARY_ACCESS_MODE",
    "VIVARY_DATA_DIR",
    "VIVARY_LOCAL_AGENT_WORKSPACE",
    "VIVARY_ORIGINAL_RUNTIME",
    "VIVARY_RECEIPT_LOG",
    "VIVARY_TRUSTED_PROXY",
  ]) {
    delete environment[key];
  }
  if (packaged) {
    environment.VIVARY_ORIGINAL_RUNTIME = path.join(resources, "original-runtime");
  } else if (source.VIVARY_ORIGINAL_RUNTIME && path.isAbsolute(source.VIVARY_ORIGINAL_RUNTIME)) {
    environment.VIVARY_ORIGINAL_RUNTIME = source.VIVARY_ORIGINAL_RUNTIME;
  }
  environment.VIVARY_DESKTOP_HOST = "1";
  return environment;
}

async function startServer() {
  const root = workbenchRoot();
  const node = ordinaryNodePath();
  const entry = path.join(root, "bin", "desktop-server.mjs");
  await Promise.all([access(node), access(entry)]);
  const dataDir = desktopDataDir();
  const started = await startOnDesktopPort(await chooseDesktopPort(dataDir),
    (port) => launchServer({ root, node, entry, dataDir, port }));
  // Saved only after the server started, so a port that failed is not kept.
  // A failed save costs only the next launch's port, not this one.
  await saveDesktopPort(dataDir, started.port).catch(() => undefined);
  return started;
}

export async function launchServer({ root, node, entry, dataDir, port }) {
  const origin = `http://127.0.0.1:${port}`;
  const child = fork(entry, ["--port", String(port), "--data-dir", dataDir], {
    cwd: root,
    // On Windows, survive the parent job so IPC loss can trigger tree cleanup.
    detached: true,
    env: localChildEnvironment(),
    execArgv: [],
    execPath: node,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  serverChild = child;
  serverCapability = desktopCapability();
  const capability = serverCapability;
  const disposeBrowserDialogs = attachBrowserAccessDialogs(child, () => mainWindow, (window, options) => dialog.showMessageBox(window, options));
  child.once("exit", disposeBrowserDialogs);
  disposeProjectChooser = attachProjectFolderChooser(child, () => mainWindow);
  disposeDiscordPresence = attachDiscordPresence(child);

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => settle(new Error("Vivary local server startup timed out.")),
      START_TIMEOUT_MS,
    );
    const onError = (error) => settle(error);
    const onExit = (code) => settle(
      new Error(`Vivary local server exited during startup (${code ?? "signal"}).`),
    );
    const onMessage = (message) => {
      if (message?.type === "vivary:desktop:bootstrap-needed") {
        child.send({ type: "vivary:desktop:bootstrap", capability });
      } else if (message?.type === "ready" && message.origin === origin) {
        settle();
      } else if (message?.type === "error") {
        settle(new Error(String(message.message || "Vivary local server failed.")));
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  }).catch((error) => {
    forceServerTree(child);
    disposeProjectChooser();
    disposeDiscordPresence();
    serverChild = null;
    throw error;
  });

  child.once("exit", (code, signal) => {
    if (process.platform !== "win32") forceServerTree(child);
    if (!shutdownPromise && !allowQuit) {
      dialog.showErrorBox(
        "Vivary stopped",
        `The local server ended unexpectedly (${code ?? signal ?? "unknown"}).`,
      );
      void beginQuit({ skipDraftFlush: true });
    }
  });
  return { origin };
}

function forceServerTree(child) {
  if (!child.pid) return;
  const leaderAlive = child.exitCode === null && child.signalCode === null;
  if (process.platform === "win32") {
    if (!leaderAlive) return;
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (leaderAlive) child.kill("SIGKILL");
  }
}

async function stopServer() {
  disposeProjectChooser();
  disposeDiscordPresence();
  const child = serverChild;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (process.platform !== "win32") forceServerTree(child);
    return;
  }
  try {
    if (child.connected) child.send({ type: "shutdown" }, () => undefined);
  } catch {
    // The child's disconnect handler owns graceful shutdown if IPC closed first.
  }
  await new Promise((resolve) => {
    let fallbackTimer;
    const settle = () => {
      clearTimeout(stopTimer);
      clearTimeout(fallbackTimer);
      child.off("exit", settle);
      resolve();
    };
    const stopTimer = setTimeout(() => {
      forceServerTree(child);
      fallbackTimer = setTimeout(settle, 2_000);
    }, STOP_TIMEOUT_MS);
    child.once("exit", settle);
  });
}

export async function flushDraftsBeforeQuit(window, origin, timeoutMs = DRAFT_CLOSE_TIMEOUT_MS) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return true;
  const pageUrl = window.webContents.getURL();
  if (!pageUrl || pageUrl === "about:blank") return true;
  try {
    if (new URL(pageUrl).origin !== origin) return false;
  } catch { return false; }
  let timer;
  let saved = false;
  window.setEnabled(false);
  try {
    saved = await Promise.race([
      window.webContents.executeJavaScript("globalThis.__vivaryFlushChatDraftsForClose?.() ?? true")
        .then(result => result === true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    return saved;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (!saved && !window.isDestroyed()) window.setEnabled(true);
  }
}

function beginQuit({ skipDraftFlush = false } = {}) {
  shutdownPromise ??= (async () => {
    const serverAlive = serverChild && serverChild.exitCode === null && serverChild.signalCode === null;
    if (!skipDraftFlush && serverAlive && !await flushDraftsBeforeQuit(mainWindow, serverOrigin)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: "warning", buttons: ["Keep working"], defaultId: 0,
          title: "Conversation changes not saved",
          message: "A conversation change could not be saved. Keep Vivary open, retry the visible save, then close it again.",
        });
      }
      return false;
    }
    await stopServer();
    allowQuit = true;
    app.quit();
    return true;
  })().finally(() => { if (!allowQuit) shutdownPromise = null; });
  return shutdownPromise;
}

function hardenSession() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  activeSession.on("will-download", (event) => event.preventDefault());
}

async function createWindow(origin) {
  const window = new BrowserWindow({
    height: 900,
    show: false,
    title: "Vivary",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
    width: 1440,
  });
  mainWindow = window;
  window.webContents.session.webRequest.onBeforeSendHeaders(
    createDesktopCapabilityHandler(() => window.isDestroyed() ? null : window.webContents, origin, serverCapability),
  );
  window.once("closed", () => session.defaultSession.webRequest.onBeforeSendHeaders(null));
  const allow = (target) => {
    try {
      return new URL(target).origin === origin;
    } catch {
      return false;
    }
  };
  window.webContents.on("will-navigate", (event, target) => {
    if (!allow(target)) {
      event.preventDefault();
      openExternalSetupLink(target);
    }
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!allow(target)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(createExternalWindowHandler(window));
  window.on("close", (event) => {
    if (!allowQuit) {
      event.preventDefault();
      void beginQuit();
    }
  });
  window.once("ready-to-show", () => window.show());
  try {
    await window.loadURL(`${origin}/`);
  } catch (error) {
    if (mainWindow === window) mainWindow = null;
    window.destroy();
    throw error;
  }
  return window;
}

const EXTERNAL_SETUP_URLS = new Set([
  "https://code.claude.com/docs/en/setup",
  "https://code.claude.com/docs/en/cli-usage",
  "https://developers.openai.com/codex/cli",
  "https://developers.openai.com/codex/auth",
  "https://console.anthropic.com/settings/keys",
  "https://platform.openai.com/api-keys",
  "https://openrouter.ai/keys",
  "https://aistudio.google.com/apikey",
  "https://console.groq.com/keys",
  "https://console.mistral.ai/api-keys/",
  "https://dashboard.cohere.com/api-keys",
]);

export function isExternalSetupUrl(target) {
  return typeof target === "string" && EXTERNAL_SETUP_URLS.has(target);
}

function openExternalSetupLink(target) {
  if (!isExternalSetupUrl(target)) return;
  void shell.openExternal(target, { activate: true }).catch(() => {
    dialog.showErrorBox("Browser could not open", "Copy the setup link and open it in your browser.");
  });
}

// Unrestricted destinations require a native confirmation before leaving Electron.
// This also protects against scripted window.open calls in renderer content.
export function createExternalWindowHandler(window, browser = shell, dialogs = dialog) {
  let pending = false;
  return ({ url, postBody }) => {
    if (postBody || pending || window.isDestroyed()) return { action: "deny" };
    let target;
    try {
      target = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      return { action: "deny" };
    }
    pending = true;
    void (async () => {
      try {
        if (!isExternalSetupUrl(url)) {
          const result = await dialogs.showMessageBox(window, {
            type: "question",
            title: "Open in browser",
            message: `Open ${target.origin} in your default browser?`,
            detail: target.href,
            buttons: ["Cancel", "Open in browser"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (result.response !== 1 || window.isDestroyed()) return;
        }
        await browser.openExternal(target.href, { activate: true });
      } catch {
        if (!window.isDestroyed()) {
          dialogs.showErrorBox("Browser could not open", "Copy the address and open it in your browser.");
        }
      } finally {
        pending = false;
      }
    })();
    return { action: "deny" };
  };
}

export function isProjectFolderRequest(message) {
  return message !== null && typeof message === "object"
    && Object.keys(message).length === 2
    && (message.type === "vivary:project-folder:choose" || message.type === "vivary:project-folder:cancel")
    && typeof message.requestId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.requestId);
}

export function attachProjectFolderChooser(child, getWindow, showOpenDialog = (window, options) => dialog.showOpenDialog(window, options)) {
  let disposed = false;
  let pending = null;

  const reply = (requestId, result) => {
    if (!child.connected) return;
    try {
      child.send({ type: "vivary:project-folder:result", requestId, ...result }, () => undefined);
    } catch {
      // The server may disconnect while a native dialog is closing.
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    child.off("message", onMessage);
    child.off("disconnect", dispose);
    child.off("error", dispose);
    child.off("exit", dispose);
    if (pending) {
      pending.canceled = true;
      reply(pending.requestId, { path: null });
      pending = null;
    }
  };
  const onMessage = (message) => {
    if (disposed || !isProjectFolderRequest(message)) return;
    if (message.type === "vivary:project-folder:cancel") {
      if (pending?.requestId === message.requestId) pending.canceled = true;
      return;
    }
    const window = getWindow();
    if (pending || !window || window.isDestroyed()) {
      reply(message.requestId, { error: "chooser-unavailable" });
      return;
    }
    const request = { requestId: message.requestId, canceled: false };
    pending = request;
    Promise.resolve().then(() => showOpenDialog(window, {
      title: "Open project folder",
      buttonLabel: "Open project",
      properties: ["openDirectory"],
    })).then(result => {
      if (disposed || request.canceled) return;
      if (result.canceled) {
        reply(request.requestId, { path: null });
        return;
      }
      const selected = result.filePaths.length === 1 ? result.filePaths[0] : null;
      const valid = typeof selected === "string" && selected.length > 0 && selected.length <= 32_768
        && !selected.includes("\0") && path.isAbsolute(selected);
      reply(request.requestId, valid ? { path: selected } : { error: "chooser-unavailable" });
    }).catch(() => {
      if (!disposed && !request.canceled) reply(request.requestId, { error: "chooser-unavailable" });
    }).finally(() => {
      if (pending === request) pending = null;
    });
  };

  child.on("message", onMessage);
  child.once("disconnect", dispose);
  child.once("error", dispose);
  child.once("exit", dispose);
  return dispose;
}

export function attachDiscordPresence(child) {
  const controller = createDiscordPresenceController();
  void controller.reloadSettings();
  const onMessage = (message) => {
    if (message?.type === "vivary:desktop:presence" && message.snapshot) {
      controller.updateSnapshot(message.snapshot);
    }
    if (message?.type === "vivary:desktop:settings") {
      void controller.reloadSettings();
    }
  };
  child.on("message", onMessage);
  return () => {
    child.off("message", onMessage);
    controller.dispose();
  };
}

export async function runDesktop() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (!allowQuit) {
      event.preventDefault();
      void beginQuit();
    }
  });
  await app.whenReady();
  hardenSession();
  try {
    const { origin, port, replaced } = await startServer();
    serverOrigin = origin;
    await createWindow(origin);
    if (replaced !== null && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, portChangeNotice(replaced, port));
    }
  } catch (error) {
    await stopServer();
    dialog.showErrorBox("Vivary could not start", error instanceof Error ? error.message : "Unknown error.");
    allowQuit = true;
    app.quit();
  }
}

const sourceArgument = process.argv[1] && path.resolve(process.argv[1]);
const directSourceEntry = sourceArgument === sourceFile || sourceArgument === sourceRoot;
if (app.isPackaged || directSourceEntry) void runDesktop();
