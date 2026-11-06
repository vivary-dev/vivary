import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runOriginalProcess, shutdownOriginalCommands } from "../server/original-runtime";
import { scheduling } from "./original-runtime-harness.ts";

test("shutdown stops running children, refuses waiters, and stops an admitted command before it spawns", async () => {
  const executed: string[] = [];
  const f = await scheduling({ execute: (_python, args, stdin, cwd, environment, signal) => {
    executed.push(path.basename(args.find(value => path.dirname(value) === f.directory)!));
    return runOriginalProcess(process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(path.join(f.directory, "ready"))},"ready");setInterval(()=>{},1000)`],
      stdin, cwd, environment, signal);
  } });
  const write = f.apply("project-a");
  await write.queued();
  const waiting = f.read("project-a");
  const hold = f.hold("project-c");
  const admitted = f.read("project-c");
  const stopped = assert.rejects(write.result, /closing. The original command was stopped/);
  const refused = assert.rejects(waiting.result, /closing. New original commands cannot start/);
  const unspawned = assert.rejects(admitted.result, /closing. New original commands cannot start/);
  try {
    let started = false;
    for (let attempt = 0; attempt < 40 && !started; attempt++) {
      try { await readFile(path.join(f.directory, "ready")); started = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(started, true);
    await waiting.queued();
    await hold.admitted;
    const shutdown = shutdownOriginalCommands();
    assert.equal(shutdownOriginalCommands(), shutdown);
    // Shutdown settles while the admitted command is still held in its project check: it cannot spawn now.
    await shutdown;
    const recorded = await readFile(path.join(f.directory, "data", "original-runtime", "receipts.jsonl"), "utf8").catch(() => "");
    assert.ok(recorded.includes('"command":"adopt-apply"') && recorded.includes('"ok":false'),
      "the stopped write was recorded before shutdown resolved");
    hold.release();
    await Promise.all([stopped, refused, unspawned]);
    assert.deepEqual(executed, ["project-a"], "the admitted project-c command never reached the executor");
    await assert.rejects(f.read("project-b").result, /cannot start/);
    assert.throws(() => runOriginalProcess(process.execPath, ["-e", ""], "", f.directory, {}), /cannot start/);
  } finally {
    hold.release();
    await shutdownOriginalCommands();
    await Promise.allSettled([stopped, refused, unspawned]);
    await f.cleanup();
  }
});
