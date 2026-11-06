import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

const electronStub = "data:text/javascript," + encodeURIComponent(
  "export const app = { setName() {}, isPackaged: false }; export const BrowserWindow = null; export const dialog = {}; export const session = {}; export const shell = {};",
);
const mainModule = new URL("../main.mjs", import.meta.url).href;
const childProcessStub = "data:text/javascript," + encodeURIComponent(
  "export let fork; export const setFork = value => { fork = value; }; export { spawnSync } from 'node:child_process';",
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: electronStub, shortCircuit: true };
    if (specifier === "node:child_process" && context.parentURL === mainModule) {
      return { url: childProcessStub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { launchServer, createExternalWindowHandler, attachProjectFolderChooser, chooseDesktopPort, DESKTOP_PORT_RANGE, desktopDataDir, flushDraftsBeforeQuit, isExternalSetupUrl, isProjectFolderRequest, localChildEnvironment, portChangeNotice, saveDesktopPort, selectLoopbackPort, startOnDesktopPort } = await import("../main.mjs");
const { setFork } = await import(childProcessStub);
hooks.deregister();

const firstId = "01a094af-1abc-4234-8abc-123456789abc";
const secondId = "01a094af-2abc-4234-8abc-123456789abc";
const choose = (requestId = firstId) => ({ type: "vivary:project-folder:choose", requestId });

function childFixture() {
  const child = new EventEmitter();
  child.connected = true;
  child.replies = [];
  child.send = message => { child.replies.push(message); };
  return child;
}

test("folder IPC accepts only the request identifier and allowlisted operation", () => {
  assert.equal(isProjectFolderRequest(choose()), true);
  for (const message of [null, [], {}, { ...choose(), path: "/tmp/untrusted" }, choose("short"), { ...choose(), type: "shell" }]) {
    assert.equal(isProjectFolderRequest(message), false);
  }
});

test("one native directory dialog returns only its selected path", async () => {
  const child = childFixture();
  const response = Promise.withResolvers();
  let shown = 0;
  const dispose = attachProjectFolderChooser(child, () => ({ isDestroyed: () => false }), async (_window, options) => {
    shown++;
    assert.deepEqual(options, { title: "Open project folder", buttonLabel: "Open project", properties: ["openDirectory"] });
    return response.promise;
  });
  child.emit("message", choose());
  child.emit("message", choose(secondId));
  await setImmediate();
  assert.equal(shown, 1);
  assert.deepEqual(child.replies, [{ type: "vivary:project-folder:result", requestId: secondId, error: "chooser-unavailable" }]);
  response.resolve({ canceled: false, filePaths: ["/tmp/project"] });
  await setImmediate();
  assert.deepEqual(child.replies[1], { type: "vivary:project-folder:result", requestId: firstId, path: "/tmp/project" });
  dispose();
  assert.equal(child.listenerCount("message"), 0);
});

test("dialog cancellation stays distinct from safe dialog failures", async () => {
  for (const result of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: ["relative"] }, { canceled: false, filePaths: ["/one", "/two"] }, new Error("private host detail")]) {
    const child = childFixture();
    const dispose = attachProjectFolderChooser(child, () => ({ isDestroyed: () => false }), async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    child.emit("message", choose());
    await setImmediate();
    assert.deepEqual(child.replies, [{
      type: "vivary:project-folder:result", requestId: firstId,
      ...(result.canceled ? { path: null } : { error: "chooser-unavailable" }),
    }]);
    dispose();
  }
});

test("an unavailable parent window returns a safe failure", () => {
  for (const window of [null, { isDestroyed: () => true }]) {
    const child = childFixture();
    const dispose = attachProjectFolderChooser(child, () => window, () => assert.fail("No dialog should open without a parent window."));
    child.emit("message", choose());
    assert.deepEqual(child.replies, [{
      type: "vivary:project-folder:result", requestId: firstId, error: "chooser-unavailable",
    }]);
    dispose();
  }
});

test("shutdown and disconnected IPC discard late native selections", async () => {
  for (const reason of ["dispose", "disconnect", "error", "exit", "cancel"]) {
    const child = childFixture();
    const response = Promise.withResolvers();
    const dispose = attachProjectFolderChooser(child, () => ({ isDestroyed: () => false }), () => response.promise);
    child.emit("message", choose());
    await setImmediate();
    if (reason === "dispose") dispose();
    else if (reason === "cancel") child.emit("message", { type: "vivary:project-folder:cancel", requestId: firstId });
    else child.emit(reason, new Error("private host detail"));
    response.resolve({ canceled: false, filePaths: ["/tmp/late-selection"] });
    await setImmediate();
    assert.equal(child.replies.some(reply => reply.path !== null), false);
    dispose();
    for (const event of ["message", "disconnect", "error", "exit"]) assert.equal(child.listenerCount(event), 0);
  }
});

test("only exact HTTPS provider setup destinations can leave the app", () => {
  for (const url of [
    "https://code.claude.com/docs/en/setup",
    "https://developers.openai.com/codex/auth",
    "https://console.anthropic.com/settings/keys",
    "https://platform.openai.com/api-keys",
  ]) assert.equal(isExternalSetupUrl(url), true);
  for (const url of [
    "javascript:alert(1)", "file:///tmp/project", "http://platform.openai.com/api-keys",
    "https://platform.openai.com@evil.test/api-keys", "https://platform.openai.com/api-keys?secret=value",
    "https://platform.openai.com/api-keys#secret", "https://example.org", "https://platform.openai.com/",
  ]) assert.equal(isExternalSetupUrl(url), false);
});


test("packaged startup uses its own original runtime and does not inherit data or receipt targets", () => {
  const resources = path.resolve("packaged-resources");
  const environment = localChildEnvironment({ VIVARY_ORIGINAL_RUNTIME: path.resolve("other-runtime"), VIVARY_DATA_DIR: "/other-data", VIVARY_RECEIPT_LOG: "/other-receipt", APP_URL: "https://example.test", PATH: "host-tools" }, true, resources);
  assert.equal(environment.VIVARY_ORIGINAL_RUNTIME, path.join(resources, "original-runtime"));
  for (const key of ["VIVARY_DATA_DIR", "VIVARY_RECEIPT_LOG", "APP_URL"]) assert.equal(environment[key], undefined);
  assert.equal(environment.PATH, "host-tools");
  assert.equal(localChildEnvironment({ VIVARY_ORIGINAL_RUNTIME: "relative" }, false).VIVARY_ORIGINAL_RUNTIME, undefined);
});

test("preview links open the exact HTTP address only after native confirmation", async () => {
  for (const url of ["http://127.0.0.1:4321/page?q=one#two", "https://example.org/app"]) {
    const opened = [];
    const response = Promise.withResolvers();
    const window = { isDestroyed: () => false };
    const handler = createExternalWindowHandler(window, {
      openExternal: async (...args) => opened.push(args),
    }, {
      showMessageBox: (parent, options) => {
        assert.equal(parent, window);
        assert.equal(options.detail, url);
        assert.equal(options.cancelId, 0);
        assert.equal(options.defaultId, 0);
        return response.promise;
      },
    });
    assert.deepEqual(handler({ url }), { action: "deny" });
    assert.deepEqual(opened, []);
    handler({ url: "https://other.test" });
    response.resolve({ response: 1 });
    await setImmediate();
    assert.deepEqual(opened, [[url, { activate: true }]]);
  }
});

test("preview cancellation and parent closure never launch a browser", async () => {
  for (const response of [0, 1]) {
    let destroyed = false;
    const handler = createExternalWindowHandler({ isDestroyed: () => destroyed }, {
      openExternal: () => assert.fail("unexpected browser launch"),
    }, {
      showMessageBox: async () => { destroyed = response === 1; return { response }; },
    });
    handler({ url: "https://example.org" });
    await setImmediate();
  }
});

test("external window requests reject unsafe schemes, credentials, malformed URLs and POST", () => {
  const handler = createExternalWindowHandler({ isDestroyed: () => false }, {}, {
    showMessageBox: () => assert.fail("unsafe URL reached confirmation"),
  });
  for (const url of ["file:///tmp/page", "javascript:alert(1)", "data:text/html,hello", "mailto:a@example.org", "vivary://open", "https://user:secret@example.org", "bad url"]) {
    assert.deepEqual(handler({ url }), { action: "deny" });
  }
  assert.deepEqual(handler({ url: "https://example.org", postBody: { data: [] } }), { action: "deny" });
});

test("browser failure gives recovery and permits the next request", async () => {
  let attempts = 0;
  let errors = 0;
  const handler = createExternalWindowHandler({ isDestroyed: () => false }, {
    openExternal: async () => { attempts++; throw new Error("launch failed"); },
  }, {
    showMessageBox: async () => ({ response: 1 }),
    showErrorBox: (title, message) => { errors++; assert.match(message, /Copy the address/); },
  });
  for (let i = 0; i < 2; i++) {
    handler({ url: "http://localhost:4321/" });
    await setImmediate();
  }
  assert.equal(attempts, 2);
  assert.equal(errors, 2);
});

test("allowlisted provider setup links retain direct browser opening", async () => {
  const opened = [];
  const handler = createExternalWindowHandler({ isDestroyed: () => false }, {
    openExternal: async url => opened.push(url),
  }, {
    showMessageBox: () => assert.fail("setup links do not need confirmation"),
  });
  handler({ url: "https://developers.openai.com/codex/auth" });
  await setImmediate();
  assert.deepEqual(opened, ["https://developers.openai.com/codex/auth"]);
});

test("desktop close waits for same-origin draft acknowledgement and refuses failure", async () => {
  const origin = "http://127.0.0.1:4567";
  const pending = Promise.withResolvers();
  let executed = 0;
  const enabled = [];
  const window = {
    isDestroyed: () => false,
    setEnabled: value => enabled.push(value),
    webContents: {
      isDestroyed: () => false,
      getURL: () => origin + "/?runtime=native",
      executeJavaScript: script => {
        assert.equal(script, "globalThis.__vivaryFlushChatDraftsForClose?.() ?? true");
        executed++;
        return pending.promise;
      },
    },
  };
  const waiting = flushDraftsBeforeQuit(window, origin, 1000);
  await setImmediate();
  assert.equal(executed, 1);
  pending.resolve(true);
  assert.equal(await waiting, true);
  assert.deepEqual(enabled, [false]);
  window.webContents.executeJavaScript = async () => false;
  assert.equal(await flushDraftsBeforeQuit(window, origin, 1000), false);
  assert.deepEqual(enabled, [false, false, true]);
  window.webContents.getURL = () => "https://other.test/";
  assert.equal(await flushDraftsBeforeQuit(window, origin, 1000), false);
  assert.equal(executed, 1);
  window.webContents.getURL = () => origin + "/";
  window.webContents.executeJavaScript = () => new Promise(() => undefined);
  assert.equal(await flushDraftsBeforeQuit(window, origin, 5), false);
  assert.deepEqual(enabled, [false, false, true, false, true]);
});

test("the desktop reuses its saved port, retries it briefly, and replaces an unavailable one", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-desktop-port-"));
  try {
    let picks = 0;
    const selectPort = async () => 42_100 + ++picks;
    const free = { selectPort, isFree: async () => true, retryDelayMs: 1 };
    assert.deepEqual(await chooseDesktopPort(dataDir, free), { port: 42_101, saved: null }, "a first launch picks a port");
    await saveDesktopPort(dataDir, 42_101);
    assert.equal(await readFile(path.join(dataDir, "desktop-port"), "utf8"), "42101\n");
    assert.deepEqual(await chooseDesktopPort(dataDir, free), { port: 42_101, saved: 42_101 }, "a later launch reuses it");
    let probes = 0;
    const freeOnThirdTry = { selectPort, retryDelayMs: 1, isFree: async () => ++probes >= 3 };
    assert.deepEqual(await chooseDesktopPort(dataDir, freeOnThirdTry), { port: 42_101, saved: 42_101 },
      "a port the previous instance still holds is reused once it frees");
    assert.equal(picks, 1);
    assert.deepEqual(await chooseDesktopPort(dataDir, { selectPort, retryDelayMs: 1, isFree: async () => false }),
      { port: 42_102, saved: 42_101 });
    await saveDesktopPort(dataDir, 50_010);
    const probed = [];
    const upgrade = await chooseDesktopPort(dataDir, { selectPort, retryDelayMs: 1,
      isFree: async port => { probed.push(port); return true; } });
    assert.deepEqual(upgrade, { port: 42_103, saved: 50_010 }, "a saved port in the dynamic range is not reused");
    assert.deepEqual(probed, [], "and is not retried");
    const started = await startOnDesktopPort(upgrade, async port => ({ origin: `http://127.0.0.1:${port}` }));
    assert.equal(started.replaced, 50_010, "the window shows the notice for the replaced port");
    await writeFile(path.join(dataDir, "desktop-port"), "not a port\n");
    assert.deepEqual(await chooseDesktopPort(dataDir, free), { port: 42_104, saved: null }, "an unreadable file counts as none");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("new ports come from the fixed range below the Windows dynamic range", async () => {
  assert.ok(DESKTOP_PORT_RANGE.first >= 1024 && DESKTOP_PORT_RANGE.last < 49_152);
  const tried = [];
  const port = await selectLoopbackPort({ random: () => 0.5, isFree: async candidate => { tried.push(candidate); return tried.length > 1; } });
  assert.ok(port >= DESKTOP_PORT_RANGE.first && port <= DESKTOP_PORT_RANGE.last);
  await assert.rejects(selectLoopbackPort({ isFree: async () => false }), /Could not find a free local port for Vivary from 42100 to 42999\./);
  const real = await selectLoopbackPort();
  assert.ok(real >= DESKTOP_PORT_RANGE.first && real <= DESKTOP_PORT_RANGE.last);
});

test("a saved port that another program holds is replaced, and reused once it is free", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-desktop-port-"));
  const blocker = createServer();
  try {
    const busy = await selectLoopbackPort();
    await new Promise(resolve => blocker.listen(busy, "127.0.0.1", resolve));
    await saveDesktopPort(dataDir, busy);
    const choice = await chooseDesktopPort(dataDir, { retryDelayMs: 1 });
    assert.equal(choice.saved, busy);
    assert.notEqual(choice.port, busy);
    await new Promise(resolve => blocker.close(resolve));
    assert.deepEqual(await chooseDesktopPort(dataDir, { retryDelayMs: 1 }), { port: busy, saved: busy });
  } finally {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a server that loses its port at bind starts once more on a fresh port", async () => {
  const launched = [];
  const launch = async port => {
    launched.push(port);
    if (launched.length === 1) throw new Error(`Port ${port} is already in use. Stop that instance or choose --port.`);
    return { origin: `http://127.0.0.1:${port}` };
  };
  const started = await startOnDesktopPort({ port: 42_150, saved: 42_150 }, launch, { selectPort: async () => 42_151 });
  assert.deepEqual(launched, [42_150, 42_151]);
  assert.deepEqual(started, { origin: "http://127.0.0.1:42151", port: 42_151, replaced: 42_150 });
  const first = await startOnDesktopPort({ port: 42_160, saved: null }, async port => ({ origin: `x:${port}` }));
  assert.equal(first.replaced, null, "a first launch has no notice");
  await assert.rejects(startOnDesktopPort({ port: 42_170, saved: null }, async () => { throw new Error("startup timed out"); }),
    /startup timed out/, "other failures are not retried");
});

test("the port notice names both ports and where to copy the new webhook URL", () => {
  const notice = portChangeNotice(42_101, 42_102);
  assert.equal(notice.message, "Port 42101 was unavailable, so Vivary now uses port 42102.");
  assert.match(notice.detail, /Webhook URLs with the old port no longer reach Vivary\. Copy each new URL from Automations/);
});

test("the desktop data folder is the local server's default and is passed to it", async () => {
  const { startupOptions } = await import("../../workbench/bin/start.mjs");
  assert.equal(desktopDataDir(), startupOptions([], {}).dataDir);
  assert.equal(desktopDataDir("/home/owner"), path.join("/home/owner", ".vivary", "workbench"));
  const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  assert.match(source, /fork\(entry, \["--port", String\(port\), "--data-dir", dataDir\]/);
  const start = source.indexOf("const started = await startOnDesktopPort(");
  const save = source.indexOf("await saveDesktopPort(dataDir, started.port)");
  assert.ok(start > 0 && save > start, "the port is saved after the server started");
});

test("Windows server launch preserves independent cleanup after Electron exits", { timeout: 3000 }, async () => {
  const root = path.resolve("desktop-spawn-fixture");
  const input = {
    root, node: path.join(root, "node.exe"), entry: path.join(root, "bin", "desktop-server.mjs"),
    dataDir: path.join(root, "profile"), port: 42_199,
  };
  const child = childFixture();
  child.exitCode = null;
  child.signalCode = null;
  const calls = [];
  setFork((entry, args, options) => {
    calls.push({ entry, args, options });
    return child;
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const starting = launchServer(input);
    child.emit("message", { type: "vivary:desktop:bootstrap-needed" });
    child.emit("message", { type: "ready", origin: "http://127.0.0.1:42199" });
    assert.deepEqual(await starting, { origin: "http://127.0.0.1:42199" });
    assert.equal(child.replies.length, 1);
    assert.equal(child.replies[0].type, "vivary:desktop:bootstrap");
    assert.match(child.replies[0].capability, /^[\w-]{43}$/);
    assert.equal(calls.length, 1);
    const { entry, args, options } = calls[0];
    assert.equal(entry, input.entry);
    assert.deepEqual(args, ["--port", "42199", "--data-dir", input.dataDir]);
    assert.equal(options.cwd, input.root);
    assert.equal(options.execPath, input.node);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, true, "Windows server must survive Electron exit to clean its tree");
  } finally {
    Object.defineProperty(process, "platform", platform);
    // No real PID exists. Mark the fake ended without invoking app shutdown callbacks.
    child.exitCode = 0;
    child.connected = false;
    child.removeAllListeners();
    setFork(undefined);
  }
});
