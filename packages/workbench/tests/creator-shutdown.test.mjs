// Shutdown closes the process-wide command host for good, so this test has a
// file of its own, and node:test runs each file in its own process. Windows CI
// runs this file, so it proves the taskkill tree stop on a real Python tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagedProject, installedPatternCatalog } from "../server/managed-projects.mjs";
import { shutdownOriginalCommands } from "../server/original-runtime.ts";

const python = execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function running(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    // A stopped process stays a zombie until its new parent reaps it.
    try { if ((await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ")) return false; }
    catch { return false; }
  }
  return true;
}

test("shutdown stops a running creator apply and its process tree, and records the apply first", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-creator-shutdown-"));
  const dataDir = path.join(directory, "data");
  const bridge = path.join(directory, "managed_project_workspace.py");
  const pids = path.join(directory, "pids.json");
  const log = path.join(dataDir, "original-runtime", "receipts.jsonl");
  await mkdir(dataDir);
  await writeFile(bridge, [
    "import json, os, subprocess, sys, time",
    "sys.stdin.read()",
    "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],",
    "    stdout=sys.stdout, stderr=sys.stderr)",
    `with open(${JSON.stringify(pids + ".partial")}, 'w') as handle:`,
    "    json.dump({'child': os.getpid(), 'grandchild': grandchild.pid}, handle)",
    `os.replace(${JSON.stringify(pids + ".partial")}, ${JSON.stringify(pids)})`,
    "time.sleep(120)",
  ].join("\n") + "\n");
  const dependencies = { dataDir, getAccess: async () => ({ code: "catalog" }), python, bridge,
    connectFolder: async () => assert.fail("a stopped apply registers nothing") };
  const outcome = createManagedProject({}, { name: "Stopped", acceptedPlanSha256: "sha256:" + "a".repeat(64) },
    dependencies).then(() => "created", error => error.message);
  let started;
  try {
    for (let attempt = 0; attempt < 100 && !started; attempt++) {
      started = await readFile(pids, "utf8").then(JSON.parse, () => undefined);
      if (!started) await delay(100);
    }
    assert.ok(started, "the stand-in bridge started a grandchild");
    // The log is read in the turn shutdown resolves, before a later file write could finish.
    const atShutdown = await Promise.race([
      shutdownOriginalCommands().then(() => existsSync(log) ? readFileSync(log, "utf8") : ""),
      delay(15_000).then(() => undefined)]);
    // The grandchild inherits the output pipes on Windows and Linux, so a stop that misses it leaves shutdown waiting.
    assert.notEqual(atShutdown, undefined, "shutdown ended the process tree within 15 seconds");
    const receipts = atShutdown.split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(receipts.map(receipt => [receipt.command, receipt.ok, receipt.error_type]),
      [["creator-apply", false, "stopped"]], "the stopped apply was recorded before shutdown resolved");
    assert.match(await outcome, /closing. The original command was stopped/);
    for (const pid of [started.child, started.grandchild]) {
      for (let attempt = 0; attempt < 50 && await running(pid); attempt++) await delay(100);
      assert.equal(await running(pid), false, `process ${pid} survived shutdown`);
    }
    await assert.rejects(installedPatternCatalog({}, dependencies), /New original commands cannot start/);
  } finally {
    for (const pid of [started?.child, started?.grandchild]) {
      if (pid && await running(pid)) process.kill(pid, "SIGKILL");
    }
    await shutdownOriginalCommands();
    await outcome;
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
