import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeSubscriptionProbeLaunch, readClaudeSubscriptionUsage } from "../server/claude-subscription-usage.ts";
import { claudeAccount, includedClaudeUsage } from "./fixtures/claude-subscription.ts";
import { codingRuntimeEnvironment } from "../server/local-runtime-setup.ts";

for (const version of ["2.1.289", "2.1.296"] as const) test(`the installed SDK reads Claude ${version} controls without sending any user message`, {
  timeout: 20_000, skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-claude-usage-"));
  try {
    const calls = path.join(root, "calls.jsonl");
    const pidFile = path.join(root, "pid");
    const executable = path.join(root, "claude");
    const account = { email: "fixture@example.test", subscriptionType: "max", apiProvider: "firstParty" };
    const usage = { subscription_type: "max", rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 5, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" },
        model_scoped: [], extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, utilization: 0 } } };
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("${version} (Claude Code)"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + "\\n");
  if (message.type !== "control_request") process.exit(3);
  const subtype = message.request.subtype;
  const response = subtype === "initialize" ? { account: ${JSON.stringify(account)}, commands: [], models: [], agents: [] }
    : subtype === "get_usage" ? ${JSON.stringify(usage)} : {};
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\\n");
});
`, { mode: 0o755 });
    const observed = await readClaudeSubscriptionUsage(root, {
      launch: { executable, prefix: [], env: codingRuntimeEnvironment(process.env) }, timeoutMs: 5_000,
    });
    assert.equal(observed.status, "observed");
    if (observed.status !== "observed") assert.fail(observed.message);
    assert.equal(observed.version, version);
    assert.deepEqual(observed.account, account);
    assert.deepEqual(observed.usage, usage);
    const events = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.some(event => event.type === "user"), false);
    assert.equal(events.filter(event => event.type === "control_request" && event.request.subtype === "get_usage").length, 1);
    assert.equal(events.find(event => event.request?.subtype === "get_usage").request.skip_behaviors, true);
    assert.ok(events[0].args.includes("--safe-mode"));
    assert.ok(events[0].args.includes("--no-session-persistence"));
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SDK launch arguments retain the resolved Node, prefix, and native executable", () => {
  const env = {};
  assert.deepEqual(claudeSubscriptionProbeLaunch({ executable: "C:\\node.exe", prefix: ["C:\\cli.js"], env },
    { command: "C:\\Electron.exe", args: ["C:\\cli.js", "--print", "--safe-mode"] }),
  { command: "C:\\node.exe", args: ["C:\\cli.js", "--print", "--safe-mode"] });
  assert.deepEqual(claudeSubscriptionProbeLaunch({ executable: "/cli/claude", prefix: [], env },
    { command: "/cli/claude", args: ["--print"] }), { command: "/cli/claude", args: ["--print"] });
  assert.throws(() => claudeSubscriptionProbeLaunch({ executable: "/cli/claude", prefix: [], env },
    { command: "/unexpected", args: ["--print"] }), /unexpected Claude executable/);
});

test("unsupported Claude versions and failed usage reads stay unavailable", {
  timeout: 20_000, skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-claude-usage-error-"));
  try {
    const pidFile = path.join(root, "pid");
    const executable = path.join(root, "claude");
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log("2.1.288 (Claude Code)");\n', { mode: 0o755 });
    const launch = { executable, prefix: [], env: codingRuntimeEnvironment(process.env) };
    const old = await readClaudeSubscriptionUsage(root, { launch, timeoutMs: 2_000 });
    assert.equal(old.status, "unavailable");
    await writeFile(executable, `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("2.1.289 (Claude Code)"); process.exit(0); }\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    assert.equal((await readClaudeSubscriptionUsage(root, { launch, timeoutMs: 300 })).status, "unavailable");
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("concurrent metadata reads serialize ownership and an aborted queued read never starts", {
  timeout: 20_000, skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-claude-usage-queue-"));
  try {
    const firstPid = path.join(root, "first.pid");
    const secondStarted = path.join(root, "second-started");
    const overlapped = path.join(root, "overlapped");
    async function fixture(name: string, delay: number, marker: string) {
      const executable = path.join(root, name);
      await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (${JSON.stringify(name)} === "second") fs.writeFileSync(${JSON.stringify(marker)}, "spawned");
if (process.argv.includes("--version")) { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (${JSON.stringify(name)} === "first") fs.writeFileSync(${JSON.stringify(firstPid)}, String(process.pid));
else {
  fs.writeFileSync(${JSON.stringify(marker)}, "started");
  let live = false;
  try { process.kill(Number(fs.readFileSync(${JSON.stringify(firstPid)}, "utf8")), 0); live = true; } catch {}
  if (live) fs.writeFileSync(${JSON.stringify(overlapped)}, "overlap");
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") process.exit(3);
  const usage = message.request.subtype === "get_usage";
  const response = usage ? ${JSON.stringify(includedClaudeUsage())} : { account: ${JSON.stringify(claudeAccount)}, commands: [], models: [], agents: [] };
  setTimeout(() => console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })), usage ? ${delay} : 0);
});
`, { mode: 0o755 });
      return { executable, prefix: [], env: codingRuntimeEnvironment(process.env) };
    }
    const first = await fixture("first", 300, firstPid);
    const second = await fixture("second", 0, secondStarted);
    const third = await fixture("third", 0, path.join(root, "third-started"));
    const active = readClaudeSubscriptionUsage(root, { launch: first, timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(firstPid).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(await readFile(firstPid));
    const abort = new AbortController();
    const canceled = readClaudeSubscriptionUsage(root, { launch: second, timeoutMs: 5_000, signal: abort.signal });
    const next = readClaudeSubscriptionUsage(root, { launch: third, timeoutMs: 5_000 });
    abort.abort();
    assert.equal((await active).status, "observed");
    assert.equal((await canceled).status, "unavailable");
    assert.equal((await next).status, "observed");
    await assert.rejects(readFile(secondStarted), { code: "ENOENT" });
    await assert.rejects(readFile(overlapped), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
