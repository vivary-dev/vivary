import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Issue #97, a Code run through the real coding worker source. The worker starts under tsx, and
// Core's server modules take several seconds to load, so this file runs in the sequential
// test:credential-redaction suite rather than beside forty parallel files, where the worker can
// miss the host's 15-second startup deadline. Every value is random and generated for this run.
const workbench = path.join(import.meta.dirname, "..");
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-code-worker-redaction-"));
const database = `file:${path.join(caseRoot, "code.sqlite")}`;
const codeRuns = path.join(caseRoot, "code-runs");
const generated: string[] = [];
const synthetic = (length = 40) => {
  const value = randomBytes(length * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, length - 2) + "9m";
  generated.push(value);
  return value;
};
const held = synthetic();
Object.assign(process.env, { DATABASE_URL: database, DATABASE_URL_UNPOOLED: database, VIVARY_ACCESS_MODE: "local",
  AGENT_NATIVE_CODE_AGENTS_HOME: codeRuns, VIVARY_PROBE_TOKEN: held });
after(() => rm(caseRoot, { recursive: true, force: true }));

const redaction = await import("../server/credential-redaction.ts");
const { buildVivaryCodeFollowUpPrompt, getVivaryCodeState, sendVivaryCodeMessage } = await import("../server/local-code-agent.ts");
const { codeAgentRunTranscriptPath, getCodeAgentRunRecord, listCodeAgentTranscriptEvents } = await import("@agent-native/core/code-agents");
const { setTextRedactor } = await import("@agent-native/core/audit");
const { isCredentialName } = await import("../server/local-runtime-setup.ts");
// The server process registers its redactor as the Nitro plugin does.
setTextRedactor(redaction.redactCredentials);
// The worker wrapper loads these natively before tsx starts, so tsx compiles only the worker's own TypeScript.
const coreModules = ["server", "code-agents", "audit", "db", "mcp-client", "secrets", "settings", "terminal/server"]
  .map(entry => import.meta.resolve(`@agent-native/core/${entry}`));

const masked = (text: string) => generated.reduce((out, value) => out.split(value).join("<generated>"), text);
function assertMatch(text: string, pattern: RegExp, label = "") {
  if (!pattern.test(text)) assert.fail(`${label} ${masked(text).slice(0, 2_000)} does not match ${pattern}`);
}
function assertHidden(text: string, values: string[], label: string) {
  const shown = values.filter(value => text.includes(value)).length;
  assert.equal(shown, 0, `${label} showed ${shown} generated value(s)`);
}

test("a Claude run that prints a held value keeps placeholders only in the transcript, the state, and the follow-up prompt",
  // The stub CLI is a POSIX script. code-run-redaction.test.ts checks the same writes with no POSIX-only step.
  { timeout: 120_000, skip: process.platform === "win32" }, async () => {
    await redaction.refreshHeldCredentials({ environment: () => ({}), mcpConfig: () => null, storedSecrets: async () => [] });
    const fixture = await mkdtemp(path.join(tmpdir(), "vivary-code-redaction-run-"));
    const server = path.join(fixture, ".output", "server");
    const bin = path.join(fixture, "bin");
    const started = path.join(fixture, "started.json");
    const ancestry = path.join(fixture, "ancestry.json");
    const credentialNames = Object.keys(process.env).filter(name => isCredentialName(name.toUpperCase()));
    assert.ok(credentialNames.length > 0, "the test process holds credential-shaped names");
    await mkdir(server, { recursive: true });
    await mkdir(bin);
    const token = `ghp_${synthetic(36)}`;
    // The project file holds both values, as a real .env or note might. The stub reads it like an agent would.
    await writeFile(path.join(fixture, "probe.txt"), `${held}\n${token}\n`);
    await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
if (process.argv[2] === "--version") {
  process.stdout.write("2.1.300 (Claude Code)\\n");
  process.exit(0);
}
if (process.argv[2] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }));
  process.exit(0);
}
// Issue #98. A command in the run reads each ancestor's start environment below the test process.
const credentialNames = new Set(${JSON.stringify(credentialNames)});
let ancestors = 0, credentialNameSeen = false, pid = process.ppid;
while (pid > 1 && pid !== ${process.pid}) {
  const names = readFileSync("/proc/" + pid + "/environ", "utf8").split("\\0").map(entry => entry.slice(0, entry.indexOf("=")));
  credentialNameSeen ||= names.some(name => credentialNames.has(name));
  ancestors++;
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}
writeFileSync(${JSON.stringify(ancestry)}, JSON.stringify({ reachedTest: pid === ${process.pid}, ancestors, credentialNameSeen }));
process.stdin.resume();
process.stdin.on("end", () => {
  const probe = readFileSync("probe.txt", "utf8");
  const [value, pattern] = probe.trim().split("\\n");
  const reply = "The file holds " + value + " and " + pattern + ".";
  for (const line of [
    { type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000097" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading probe.txt." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "probe.txt" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: probe }] } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "It holds " + value }, { type: "text", text: reply }] } },
    { type: "result", subtype: "success", is_error: false, result: reply, session_id: "00000000-0000-4000-8000-000000000097" },
  ]) process.stdout.write(JSON.stringify(line) + "\\n");
});
`, { mode: 0o755 });
    // Keep any accidental alternate route inert.
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    // The built worker is this source file. tsx loads it, and the wrapper keeps a copy of the start request.
    await writeFile(path.join(server, "vivary-code-worker.mjs"), `
import { writeFileSync } from "node:fs";
import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
process.on("message", message => {
  if (message?.type === "vivary:code-worker:start") writeFileSync(${JSON.stringify(started)}, JSON.stringify(message));
});
await Promise.all(${JSON.stringify(coreModules)}.map(entry => import(entry)));
register();
await import(${JSON.stringify(pathToFileURL(path.join(workbench, "server", "code-execution-worker.ts")).href)});
`);
    const owner = "redaction@example.test";
    const workspace = { root: fixture, label: "Redaction project", projectId: "redaction", bindingId: "redaction-binding",
      rootId: "redaction-root", bindingRevision: 1 };
    const previousCwd = process.cwd();
    // guard:allow-env-credential - Isolated synthetic test configuration, restored after the run.
    const previousPath = process.env.PATH;
    try {
      process.chdir(fixture);
      Object.assign(process.env, { PATH: bin + path.delimiter + (previousPath ?? "") });
      const state = await sendVivaryCodeMessage({ ownerEmail: owner, message: "Read probe.txt and tell me what it holds.",
        engine: "claude-cli", model: "sonnet", workspace, revalidateWorkspace: async () => workspace });
      const runId = state.run!.id;
      let record = getCodeAgentRunRecord(runId);
      for (let attempt = 0; attempt < 400 && !["completed", "errored", "paused"].includes(String(record?.status)); attempt++) {
        await delay(100);
        record = getCodeAgentRunRecord(runId);
      }
      for (let attempt = 0; attempt < 100 && (await getVivaryCodeState(owner, runId, workspace)).activeRun; attempt++) await delay(100);
      if (record?.status !== "completed") {
        const statuses = listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "status").slice(-3)
          .map(event => event.message).join(" | ");
        assert.fail(masked(`the run ended as ${String(record?.status)} in phase ${String(record?.phase)}: `
          + `${String(record?.metadata?.executionError ?? "")} (${statuses})`));
      }
      const { reachedTest, ancestors, credentialNameSeen } = JSON.parse(await readFile(ancestry, "utf8"));
      assert.equal(reachedTest, true, "the CLI's ancestors lead to the test process");
      assert.ok(ancestors >= 1, "the CLI read at least the worker's environment");
      assert.equal(credentialNameSeen, false, "a credential-shaped name in an ancestor's start environment");
      // The worker runs in the fixture without database settings, so a Core query from it would write a file in data/ here.
      // The data folder itself can exist, because Core makes it in the test process's working folder too.
      const written = await readdir(path.join(fixture, "data")).catch(error => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      assert.deepEqual(written, [], "the worker opened a default database in its working folder");

      const transcript = await readFile(codeAgentRunTranscriptPath(runId), "utf8");
      assertHidden(transcript, [held, token], "transcript");
      assertMatch(transcript, /The file holds \[redacted VIVARY_PROBE_TOKEN\] and \[redacted credential\]\./);
      assertMatch(transcript, /"result":"\[redacted VIVARY_PROBE_TOKEN\]\\n\[redacted credential\]/);
      const stored: string[] = [];
      const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(target);
          else stored.push(await readFile(target, "utf8"));
        }
      };
      await walk(codeRuns);
      assertHidden(stored.join("\n"), [held, token], "code-runs folder");

      const request = await readFile(started, "utf8");
      assertHidden(request, [held, token], "worker start request");
      assert.ok((JSON.parse(request).redaction?.entries?.length ?? 0) > 0, "the worker received fingerprints");
      const shown = JSON.stringify(await getVivaryCodeState(owner, runId, workspace));
      assertHidden(shown, [held, token], "state route");
      assertMatch(shown, /\[redacted VIVARY_PROBE_TOKEN\]/);
      const followUp = buildVivaryCodeFollowUpPrompt(listCodeAgentTranscriptEvents(runId), "What else is in it?");
      assertHidden(followUp, [held, token], "follow-up prompt");
      assertMatch(followUp, /Assistant: The file holds \[redacted VIVARY_PROBE_TOKEN\] and \[redacted credential\]\./);
    } finally {
      process.chdir(previousCwd);
      Object.assign(process.env, { PATH: previousPath });
      await rm(fixture, { recursive: true, force: true });
    }
  });
