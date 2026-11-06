import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { desktopHostAvailable, isDesktopProjectFolderPath } from "../server/desktop-host.ts";

test("ordinary web processes have no desktop chooser", () => {
  assert.equal(desktopHostAvailable(), false);
  assert.equal(isDesktopProjectFolderPath("/tmp/project"), true);
  for (const value of [null, 123, "", "relative", "/tmp/bad\0folder"]) {
    assert.equal(isDesktopProjectFolderPath(value), false);
  }
});

test("private chooser IPC validates replies and cleans up after completion", { timeout: 10_000 }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "vivary-desktop-host-"));
  const entry = path.join(fixture, "child.mjs");
  const helper = new URL("../server/desktop-host.ts", import.meta.url).href;
  await writeFile(entry, `import { mock } from "node:test";
import { desktopHostAvailable, chooseDesktopProjectFolder } from ${JSON.stringify(helper)};
process.on("message", async message => {
  if (message?.type === "test:expire") { mock.timers.tick(120_000); return; }
  if (message?.type !== "test:choose") return;
  if (message.timeout) mock.timers.enable({ apis: ["setTimeout"] });
  const baseline = process.listenerCount("message");
  const selection = chooseDesktopProjectFolder();
  if (message.busy) {
    try { await chooseDesktopProjectFolder(); process.send({ type: "test:busy", rejected: false }); }
    catch { process.send({ type: "test:busy", rejected: true }); }
  }
  try { process.send({ type: "test:result", folder: await selection, remaining: process.listenerCount("message") - baseline }); }
  catch (error) { process.send({ type: "test:error", message: error.message, remaining: process.listenerCount("message") - baseline, ...(error.name === "TimeoutError" ? { timedOut: true } : {}) }); }
  finally { if (message.timeout) mock.timers.reset(); }
});
process.send({ type: "test:ready", available: desktopHostAvailable() });
`);
  const child = fork(entry, [], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, VIVARY_ACCESS_MODE: "local", VIVARY_DESKTOP_HOST: "1" },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const messages: unknown[] = [];
  child.on("message", message => { messages.push(message); });
  const next = async (type: string) => {
    for (;;) {
      const index = messages.findIndex(value => value !== null && typeof value === "object" && "type" in value && value.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await once(child, "message");
    }
  };
  const readRequest = async () => {
    const request = await next("vivary:project-folder:choose");
    assert.ok(request && typeof request === "object" && "requestId" in request && typeof request.requestId === "string");
    assert.deepEqual(Object.keys(request).sort(), ["requestId", "type"]);
    return request.requestId;
  };
  try {
    assert.deepEqual(await next("test:ready"), { type: "test:ready", available: true });
    child.send({ type: "test:choose", busy: true });
    const requestId = await readRequest();
    assert.deepEqual(await next("test:busy"), { type: "test:busy", rejected: true });
    child.send({ type: "vivary:project-folder:result", requestId: "unrelated", path: "/ignored" });
    child.send({ type: "vivary:project-folder:result", requestId, path: "/tmp/project" });
    assert.deepEqual(await next("test:result"), { type: "test:result", folder: "/tmp/project", remaining: 0 });

    child.send({ type: "test:choose" });
    child.send({ type: "vivary:project-folder:result", requestId: await readRequest(), path: null });
    assert.deepEqual(await next("test:result"), { type: "test:result", folder: null, remaining: 0 });

    child.send({ type: "test:choose" });
    child.send({ type: "vivary:project-folder:result", requestId: await readRequest(), path: "relative" });
    assert.deepEqual(await next("test:error"), { type: "test:error", message: "The desktop returned an invalid folder selection.", remaining: 0 });

    for (const [result, message] of [
      [{ error: "chooser-unavailable" }, "The desktop could not open the project folder chooser."],
      [{ error: "private host detail" }, "The desktop returned an invalid folder selection."],
      [{ error: "chooser-unavailable", path: "/unexpected" }, "The desktop returned an invalid folder selection."],
    ] as const) {
      child.send({ type: "test:choose" });
      child.send({ type: "vivary:project-folder:result", requestId: await readRequest(), ...result });
      assert.deepEqual(await next("test:error"), { type: "test:error", message, remaining: 0 });
    }

    child.send({ type: "test:choose", timeout: true });
    const expiredRequest = await readRequest();
    child.send({ type: "test:expire" });
    assert.deepEqual(await next("vivary:project-folder:cancel"), { type: "vivary:project-folder:cancel", requestId: expiredRequest });
    assert.deepEqual(await next("test:error"), { type: "test:error", message: "Folder selection timed out. Close the folder chooser and try again.", remaining: 0, timedOut: true });
    child.send({ type: "test:choose" });
    const retryRequest = await readRequest();
    child.send({ type: "vivary:project-folder:result", requestId: expiredRequest, path: "/tmp/expired-folder" });
    child.send({ type: "vivary:project-folder:result", requestId: retryRequest, path: "/tmp/retried-folder" });
    assert.deepEqual(await next("test:result"), { type: "test:result", folder: "/tmp/retried-folder", remaining: 0 });

    child.send({ type: "test:choose" });
    await readRequest();
    child.send({ type: "shutdown" });
    assert.deepEqual(await next("test:error"), { type: "test:error", message: "The desktop connection closed before a folder was selected.", remaining: 0 });
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await rm(fixture, { recursive: true, force: true });
  }
});
