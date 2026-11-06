import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Issue #97, Code runs. The coding worker receives salted fingerprints of the held values, never
// the values, and redacts each transcript event before it is written. code-run-worker.test.ts runs
// the real worker with a stub CLI. Every value is random and generated for this run. A failed
// comparison masks the generated values before it reports text.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-code-redaction-"));
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
const { isVivaryCodeWorkerRequest } = await import("../server/code-execution-protocol.ts");
const { buildVivaryCodeFollowUpPrompt, getVivaryCodeHostState } = await import("../server/local-code-agent.ts");
const { appendCodeAgentTranscriptEvent, createCodeAgentRunRecord, listCodeAgentTranscriptEvents, updateCodeAgentRunRecord } =
  await import("@agent-native/core/code-agents");
const { setTextRedactor } = await import("@agent-native/core/audit");
// The server process registers its redactor as the Nitro plugin does.
setTextRedactor(redaction.redactCredentials);

const masked = (text: string) => generated.reduce((out, value) => out.split(value).join("<generated>"), text);
function assertText(actual: string, expected: string, label = "") {
  if (actual !== expected) assert.fail(`${label} ${masked(actual)} !== ${masked(expected)}`);
}
function assertMatch(text: string, pattern: RegExp, label = "") {
  if (!pattern.test(text)) assert.fail(`${label} ${masked(text).slice(0, 2_000)} does not match ${pattern}`);
}
function assertHidden(text: string, values: string[], label: string) {
  const shown = values.filter(value => text.includes(value)).length;
  assert.equal(shown, 0, `${label} showed ${shown} generated value(s)`);
}
const fingerprintsOf = () => {
  assert.equal(typeof redaction.credentialFingerprints, "function", "the redaction module has no worker fingerprints");
  return redaction.credentialFingerprints();
};

test("worker fingerprints redact like the server redactor and carry no held value", async () => {
  const special = `${synthetic(30)}/+"?`;
  await redaction.refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: held, OTHER_API_KEY: special }),
    mcpConfig: () => null, storedSecrets: async () => [] });
  const fingerprints = fingerprintsOf();
  assert.equal(redaction.isCredentialFingerprints(fingerprints), true);
  const base64 = ["", "a", "ab"].flatMap(prefix => [Buffer.from(`${prefix}${held}tail`).toString("base64"),
    Buffer.from(`${prefix}${special}tail`).toString("base64url")]);
  const forms = [held, special, encodeURIComponent(special), JSON.stringify(special).slice(1, -1),
    Buffer.from(held).toString("base64").slice(0, 40)];
  assertHidden(JSON.stringify(fingerprints), forms, "fingerprints");
  const worker = redaction.createFingerprintRedactor(fingerprints);
  assert.equal(worker.count, 2);
  const samples = [`a ${held} b`, `url ${encodeURIComponent(special)} end`, `json "${JSON.stringify(special).slice(1, -1)}"`,
    ...base64, `ghp_${synthetic(36)} and OPENROUTER_API_KEY=${synthetic(44)}`, "nothing to redact here", `${held}${held}`];
  for (const sample of samples) assertText(worker.redact(sample), redaction.redactCredentials(sample), "worker and server");
  assertHidden(samples.map(sample => worker.redact(sample)).join("\n"), [held, special], "worker output");
  const again = fingerprintsOf();
  assert.notEqual(again.salt, fingerprints.salt);
  assert.notDeepEqual(again.entries.map(entry => entry.digest), fingerprints.entries.map(entry => entry.digest));
});

test("the worker start request requires fingerprints and refuses any other credential field", async () => {
  await redaction.refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: held }), mcpConfig: () => null, storedSecrets: async () => [] });
  const fingerprints = fingerprintsOf();
  const request = { type: "vivary:code-worker:start", runId: "vivary-local-code-test", prompt: "Read the note.",
    ownerEmail: "owner@local.vivary.test", redaction: fingerprints };
  assert.equal(isVivaryCodeWorkerRequest(request), true);
  const { redaction: _omitted, ...withoutFingerprints } = request;
  for (const invalid of [withoutFingerprints, { ...request, redaction: { ...fingerprints, values: [held] } },
    { ...request, redaction: { ...fingerprints, salt: "short" } },
    { ...request, redaction: { ...fingerprints, entries: [{ ...fingerprints.entries[0], value: held }] } },
    { ...request, redaction: { ...fingerprints, entries: [{ ...fingerprints.entries[0], digest: "not-a-digest" }] } },
  ]) assert.equal(isVivaryCodeWorkerRequest(invalid), false);
});

async function storedText(directory: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    parts.push(entry.isDirectory() ? await storedText(target) : await readFile(target, "utf8"));
  }
  return parts.join("\n");
}

// This case has no POSIX-only step. The Windows CI job runs no Node tests, so it covers Windows only when run there.
test("worker-side transcript and record writes keep placeholders only, with no POSIX-only step", async () => {
  const token = `ghp_${synthetic(36)}`;
  await redaction.refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: held }), mcpConfig: () => null, storedSecrets: async () => [] });
  // As the coding worker does, redact with fingerprints only, then write what the CLI printed.
  setTextRedactor(redaction.createFingerprintRedactor(redaction.credentialFingerprints()).redact);
  try {
    const run = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Neutral probe", cwd: caseRoot,
      metadata: { app: "vivary-workbench-local-code", ownerEmail: "neutral@example.test", engine: "claude-cli" } });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Finished Read.",
      metadata: { type: "tool_done", tool: "Read", result: `${held}\n${token}\n` } });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: `The file holds ${held} and ${token}.`,
      metadata: { role: "assistant" } });
    updateCodeAgentRunRecord(run.id, { status: "errored", metadata: { executionError: `failed near ${held}` } });
    assertHidden(await storedText(codeRuns), [held, token], "code-runs folder");
    const followUp = buildVivaryCodeFollowUpPrompt(listCodeAgentTranscriptEvents(run.id), "What else is in it?");
    assertHidden(followUp, [held, token], "follow-up prompt");
    assertMatch(followUp, /Assistant: The file holds \[redacted VIVARY_PROBE_TOKEN\] and \[redacted credential\]\./);
  } finally {
    setTextRedactor(redaction.redactCredentials);
  }
});

test("a Codex approval card shows placeholders, and the answer keeps the request Codex sent", async () => {
  const ownerEmail = "approval@example.test";
  await redaction.refreshHeldCredentials({ environment: () => ({ VIVARY_PROBE_TOKEN: held }), mcpConfig: () => null, storedSecrets: async () => [] });
  await getVivaryCodeHostState(ownerEmail);
  const host = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host")) as { activeRuns: Map<string, { requests: Map<string, { request: { params: { command: string } } }> }> };
  const runId = `approval-${randomBytes(4).toString("hex")}`;
  createCodeAgentRunRecord({ id: runId, goalId: "vivary-local-code", title: "Approval probe", status: "running", cwd: caseRoot,
    metadata: { app: "vivary-workbench-local-code", ownerEmail, projectId: "approval_probe", engine: "codex-cli" } });
  // A stub of the request Codex sends when a command needs approval.
  const request = { requestId: "17", method: "item/commandExecution/requestApproval",
    params: { command: `curl -H "Authorization: Bearer ${held}" https://api.example.test/v1`, reason: `Uses the key ${held}`, cwd: caseRoot } };
  host.activeRuns.set(runId, { controller: new AbortController(), ownerEmail, execution: null, stopReason: null,
    workspace: { root: caseRoot, label: "Approval probe" }, requests: new Map([["17", { request, resolve: () => undefined }]]) } as never);
  try {
    const shown = JSON.stringify((await getVivaryCodeHostState(ownerEmail)).pendingApproval);
    assertHidden(shown, [held], "approval card");
    assertMatch(shown, /Authorization: Bearer \[redacted VIVARY_PROBE_TOKEN\]/);
    assertMatch(shown, /"requestId":"17"/);
    assert.equal(host.activeRuns.get(runId)?.requests.get("17")?.request.params.command.includes(held), true,
      "the stored request still matches what Codex sent");
  } finally {
    host.activeRuns.delete(runId);
  }
});
