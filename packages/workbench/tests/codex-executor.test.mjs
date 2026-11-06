import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { compileFunction } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

// Load the real executor with only its external stores and providers replaced.
const workbench = fileURLToPath(new URL("../", import.meta.url));
// guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
const core = process.env.VIVARY_CORE_TEST_ROOT
  ?? path.join(workbench, "node_modules/@agent-native/core");
const executorSource = await readFile(path.join(core, "dist/cli/code-agent-executor.js"), "utf8");
const { normalizeCodeAgentTranscript } = await import(
  pathToFileURL(path.join(core, "dist/code-agents/transcript-normalizer.js")).href);
const source = executorSource.replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");

async function fixture(t, { mode = "complete", permissionMode = "auto-edit" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary codex executor "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "fake codex.mjs");
  const receipt = path.join(directory, "invocation.json");
  await writeFile(script, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => { prompt += value; });
process.stdin.on("end", () => {
  // guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
  writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify({args, prompt, pid:process.pid, cwd:process.cwd(), marker:process.env.FIXTURE_MARKER}));
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"019a1234-abcd-7123-abcd-0123456789ab"}) + "\\n");
  // guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
  if (process.env.FIXTURE_MODE === "wait") { setInterval(() => {}, 1000); return; }
  // guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
  if (process.env.FIXTURE_MODE === "fail") { process.stderr.write("fixture failure"); process.exitCode = 1; return; }
  writeFileSync(output, "Fixture completed.");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"command_execution",id:"tool-1",command:"read fixture",aggregated_output:"read result",exit_code:0}}));
});
`);
  const state = { id: "run-1", cwd: directory, permissionMode, metadata: { engine: "codex-cli" } };
  const events = [];
  const launches = [];
  let mergedReads = 0;
  const environment = { ...process.env, FIXTURE_RECEIPT: receipt, FIXTURE_MODE: mode, FIXTURE_MARKER: "preserved" };
  const dependencies = {
    fs, os, path,
    truncateBashOutput: value => value,
    truncateCodingOutput: value => value,
    spawn(command, args, options) {
      launches.push({ command, args, options });
      // The legacy branch must never launch a real model during this test.
      return command === "codex"
        ? spawnProcess(process.execPath, [script, ...args], { ...options, env: environment })
        : spawnProcess(command, args, options);
    },
    getCodeAgentRunRecord: () => ({ ...state, metadata: { ...state.metadata } }),
    updateCodeAgentRunRecord(_id, update) {
      const metadata = { ...state.metadata, ...update.metadata };
      Object.assign(state, update, { metadata });
      return { ...state, metadata: { ...metadata } };
    },
    appendCodeAgentTranscriptEvent: event => events.push(event),
    listCodeAgentTranscriptEvents: () => events,
    dequeueCodeAgentFollowUp: () => null,
    formatPromptWithAttachments: prompt => prompt,
    getAppConfig: () => ({ agent: { engine: "codex-cli" } }),
    buildMergedConfig: async () => { mergedReads++; return { servers: { host: { type: "http", url: "https://example.invalid/mcp" } } }; },
    codexMcpConfigArgs: () => ["-c", 'mcp_servers.host.url="https://example.invalid/mcp"'],
  };
  const create = compileFunction(`${source}\nreturn {executeCodeAgentRun, appendCodexAppServerTranscriptEvent};`, Object.keys(dependencies), {
    filename: path.join(core, "dist/cli/code-agent-executor.js"),
  });
  const { executeCodeAgentRun, appendCodexAppServerTranscriptEvent } = create(...Object.values(dependencies));
  const codexCli = { command: process.execPath, argsPrefix: [script], env: environment, configMode: "native" };
  const execute = overrides => executeCodeAgentRun({
    runId: state.id, prompt: "Read the fixture.", attachments: [], appendUserEvent: false,
    streamToolOutputToStdout: false, ...overrides,
  });
  return { directory, script, receipt, state, events, launches, codexCli, execute, appendCodexAppServerTranscriptEvent,
    mergedReads: () => mergedReads,
    invocation: async () => JSON.parse(await readFile(receipt, "utf8")),
  };
}

test("native image view is paired as a path-only transcript tool", async t => {
  const f = await fixture(t);
  const item = { type: "imageView", id: "screenshot-1", path: "/private/project/screenshot.png" };
  f.appendCodexAppServerTranscriptEvent(f.state.id, "item/started", { item });
  f.appendCodexAppServerTranscriptEvent(f.state.id, "item/completed", { item });
  assert.deepEqual(f.events.map(event => [event.metadata?.type, event.metadata?.tool,
    event.metadata?.toolCallId]), [
    ["tool_start", "view_image", item.id], ["tool_done", "view_image", item.id],
  ]);
  const [tool] = normalizeCodeAgentTranscript(f.events).items.filter(entry => entry.type === "tool");
  assert.equal(tool.state, "completed");
  assert.deepEqual(tool.input, { path: item.path });
  assert.equal(tool.result, JSON.stringify({ path: item.path }));
  assert.equal(f.events.some(event => event.metadata?.image || event.metadata?.pixels), false);
});

function valueAfter(args, flag) { return args[args.indexOf(flag) + 1]; }
function assertOutputRemoved(args) {
  assert.equal(fs.existsSync(path.dirname(valueAfter(args, "--output-last-message"))), false);
}

test("legacy Core execution retains host MCP and ignores user config", async t => {
  const f = await fixture(t);
  const run = await f.execute({ codexCli: undefined });
  const call = await f.invocation();
  assert.equal(run.status, "completed");
  assert.ok(call.args.includes("--ignore-user-config"));
  assert.ok(call.args.some(value => value.startsWith("mcp_servers.host.url=")));
  assert.equal(f.launches[0].command, "codex");
  assert.equal(run.metadata.codexSessionId, undefined);
  assert.equal(call.args.includes("resume"), false);
});

test("failed Codex execution records failure and removes temporary output", async t => {
  const f = await fixture(t, { mode: "fail" });
  const run = await f.execute();
  assert.equal(run.status, "errored");
  assert.match(run.metadata.executionError, /fixture failure/);
  assertOutputRemoved((await f.invocation()).args);
});

test("abort stops the Codex child and removes temporary output", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { mode: "wait" });
  const controller = new AbortController();
  const result = f.execute({ signal: controller.signal });
  let call;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { call = await f.invocation(); break; } catch { await delay(20); }
  }
  assert.ok(call, "The fake CLI started.");
  controller.abort();
  const run = await result;
  assert.equal(run.status, "paused");
  assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
  assertOutputRemoved(call.args);
});

test("installed legacy Codex flags resolve bounded permissions over extra roots and profiles", {
  // guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
  skip: !process.env.VIVARY_CODEX_POLICY_PROBE,
  timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vivary-codex-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configs = [
    'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nwritable_roots=["/unapproved-root"]\nnetwork_access=true\n',
    'default_permissions="broad"\n[permissions.broad.filesystem]\n"/"="write"\n[permissions.broad.workspace_roots]\n"/unapproved-root"=true\n',
  ];
  for (const config of configs) {
    await writeFile(path.join(directory, "config.toml"), config);
    const { stdout, stderr, code } = await new Promise((resolve, reject) => {
      // guard:allow-env-credential - Nonsecret test paths and fixture controls, never provider credentials.
      const child = spawnProcess(process.env.VIVARY_CODEX_POLICY_PROBE, [
        "--ask-for-approval", "never", "--sandbox", "workspace-write", "--cd", directory,
        "-c", "sandbox_workspace_write.writable_roots=[]",
        "-c", "sandbox_workspace_write.network_access=false",
        "debug", "prompt-input", "No model request.",
      ], { env: { ...process.env, CODEX_HOME: directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.on("data", value => { stdout += value; });
      child.stderr.on("data", value => { stderr += value; });
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    });
    assert.equal(code, 0, stderr);
    const strings = [];
    function collect(value) {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    }
    collect(JSON.parse(stdout));
    const prompt = strings.join("\n");
    assert.match(prompt, /sandbox_mode.*workspace-write/);
    assert.match(prompt, /Network access is restricted/);
    const writePaths = [...prompt.matchAll(/<entry access="write"><path>([^<]+)<\/path>/g)].map(match => match[1]);
    assert.deepEqual(writePaths, [directory]);
  }
});
