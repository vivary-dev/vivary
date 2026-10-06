import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendCodeAgentTranscriptEvent, codeAgentRunTranscriptPath, createCodeAgentRunRecord,
  readClaudeCodeSessionLog } from "@agent-native/core/code-agents";
import { getVivaryCodeSessionDetails, type VivaryCodeSessionDetails } from "../server/local-code-agent.ts";
import codeStateAction from "../actions/vivary-code-state.ts";

const sessionId = "00000000-0000-4000-8000-000000000010";

test("session details reads a bounded Native log only for its conversation owner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-session-details-"));
  const previousStore = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  const previousDatabase = process.env.DATABASE_URL;
  const previousUnpooled = process.env.DATABASE_URL_UNPOOLED;
  process.env.DATABASE_URL = "file:" + path.join(root, "fixture.sqlite");
  process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
  const previousWorkspace = process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Save nonsecret workspace configuration for restoration after the disposable fixture.
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = path.join(root, "native");
  process.env.VIVARY_LOCAL_AGENT_WORKSPACE = root; // guard:allow-env-credential - Disposable test workspace path, restored after the test.
  t.after(async () => {
    if (previousStore === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previousStore;
    if (previousWorkspace === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Restore the absent workspace setting after the disposable fixture.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = previousWorkspace; // guard:allow-env-credential - Restore the prior nonsecret workspace configuration after the fixture.
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousUnpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
    else process.env.DATABASE_URL_UNPOOLED = previousUnpooled;
    await rm(root, { recursive: true, force: true });
  });
  const run = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Fixture", cwd: root,
    status: "paused", metadata: { app: "vivary-workbench-local-code", engine: "claude-cli", ownerEmail: "owner@example.test",
      orgId: "fixture-org", workspaceRoot: root, claudeSessionId: sessionId, providerSessionMode: "native-resume" } });
  appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Stopped by owner. Token: ghp_0123456789abcdef0123456789abcdef0123" });
  const input = codeStateAction.schema.parse({ runId: run.id, details: true });
  const context = { userEmail: "owner@example.test", orgId: "fixture-org" };
  const details = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
  assert.equal(details.sessionId, sessionId);
  assert.equal(details.continuity, "native-resume");
  assert.equal(details.nextTurn, "native-resume");
  assert.equal(details.log.status, "available");
  assert.equal(details.log.reference, `native-transcript:${run.id}`);
  assert.match(details.log.excerpt, /Stopped by owner/);
  assert.equal(JSON.stringify(details).includes(root), false);
  assert.equal(details.log.excerpt.includes("ghp_012345"), false);
  await assert.rejects(() => codeStateAction.run(input, { ...context, userEmail: "other@example.test" }), /not found/i);
  await assert.rejects(() => codeStateAction.run(input, { ...context, orgId: "other-org" }), /not found/i);
  await assert.rejects(() => getVivaryCodeSessionDetails(context.userEmail, run.id,
    { root, label: "Other project", projectId: "other-project", bindingId: "other-binding" }, context.orgId), /not found/i);
  assert.equal(codeStateAction.schema.safeParse({ runId: run.id, details: true, path: "/etc/passwd" }).success, false);
  await rm(codeAgentRunTranscriptPath(run.id));
  const missing = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
  assert.equal(missing.log.status, "missing");
  assert.equal(missing.sessionId, sessionId);
  await writeFile(codeAgentRunTranscriptPath(run.id), JSON.stringify({ runId: run.id, id: "large", kind: "status",
    createdAt: "2026-10-06T00:00:00Z", message: "x".repeat(100_000) }) + "\n");
  const bounded = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
  assert.equal(bounded.log.truncated, true);
  assert.ok(bounded.log.excerpt.length <= 20_000);
  if (process.platform !== "win32") {
    const outside = path.join(root, "provider-credential.txt");
    await writeFile(outside, "PRIVATE_CREDENTIAL_SENTINEL");
    await rm(codeAgentRunTranscriptPath(run.id));
    await symlink(outside, codeAgentRunTranscriptPath(run.id));
    const linked = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
    assert.equal(linked.log.status, "unavailable");
    assert.equal(JSON.stringify(linked).includes("PRIVATE_CREDENTIAL_SENTINEL"), false);
  }
});

test("Native Claude inspection rejects unscoped, linked and resource-limited snapshots", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vivary-claude-reader-")));
  const project = path.join(root, "project-a");
  const home = path.join(root, "home");
  await mkdir(project);
  const previousConfig = process.env.CLAUDE_CONFIG_DIR; // guard:allow-env-credential - Nonsecret configuration path, restored after the fixture.
  const previousProjectName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME; // guard:allow-env-credential - Save the nonsecret provider directory name for fixture restoration.
  delete process.env.CLAUDE_CONFIG_DIR; // guard:allow-env-credential - Never read the owner's custom store in a fixture.
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME; // guard:allow-env-credential - Exercise only default provider naming in this fixture.
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; // guard:allow-env-credential - Restore the absent setting.
    else process.env.CLAUDE_CONFIG_DIR = previousConfig; // guard:allow-env-credential - Restore the previous nonsecret configuration path.
    if (previousProjectName === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME; // guard:allow-env-credential - Restore the absent provider name.
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = previousProjectName; // guard:allow-env-credential - Restore the previous nonsecret provider name.
    await rm(root, { recursive: true, force: true });
  });
  // This trusted Native seam receives a retained run, never a client-supplied file path.
  const run = { id: "fixture-run", cwd: project,
    metadata: { engine: "claude-cli", claudeSessionId: sessionId } } as Parameters<typeof readClaudeCodeSessionLog>[0];
  const directory = path.join(home, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, { recursive: true });
  const logPath = path.join(directory, sessionId + ".jsonl");
  const userId = "00000000-0000-4000-8000-000000000011";
  const assistantId = "00000000-0000-4000-8000-000000000012";
  const entries = [
    { type: "user", uuid: userId, parentUuid: null as string | null, sessionId, cwd: project,
      timestamp: "2026-10-06T00:00:00.000Z", message: { role: "user", content: "Fixture prompt" } },
    { type: "assistant", uuid: assistantId, parentUuid: userId, sessionId, cwd: project,
      timestamp: "2026-10-06T00:00:01.000Z", message: { role: "assistant", content: "Fixture reply" } },
  ];
  const read = () => readClaudeCodeSessionLog(run, { homeDirectory: home });
  const save = (values: unknown[] = entries) => writeFile(logPath, values.map(value => JSON.stringify(value)).join("\n") + "\n");
  await t.test("official SDK returns user and assistant text from the full owned snapshot", async () => {
    await save();
    const result = await read();
    assert.equal(result.status, "available");
    assert.deepEqual(result.messages, [{ role: "user", text: "Fixture prompt" }, { role: "assistant", text: "Fixture reply" }]);
  });
  await t.test("overlapping readers of the same intact log both succeed", async () => {
    await save();
    const results = await Promise.all([read(), read()]);
    assert.deepEqual(results.map(result => result.status), ["available", "available"]);
    for (const result of results) assert.equal(result.messages.at(-1)?.text, "Fixture reply");
  });
  await t.test("different logs serialize and a malformed predecessor releases admission", async () => {
    const otherSession = "00000000-0000-4000-8000-000000000099";
    const otherRun = { ...run, metadata: { ...run.metadata, claudeSessionId: otherSession } };
    const otherEntries = entries.map(entry => ({ ...entry, sessionId: otherSession,
      message: { ...entry.message, content: entry.type === "user" ? "Other prompt" : "Other reply" } }));
    await writeFile(path.join(directory, otherSession + ".jsonl"), otherEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const otherRead = () => readClaudeCodeSessionLog(otherRun, { homeDirectory: home });
    await save();
    const valid = await Promise.all([read(), otherRead()]);
    assert.deepEqual(valid.map(result => result.status), ["available", "available"]);
    assert.equal(valid[0].messages.at(-1)?.text, "Fixture reply");
    assert.equal(valid[1].messages.at(-1)?.text, "Other reply");
    await writeFile(logPath, "{\n");
    const afterFailure = await Promise.all([read(), otherRead()]);
    assert.deepEqual(afterFailure.map(result => result.status), ["malformed", "available"]);
    assert.equal(afterFailure[1].messages.at(-1)?.text, "Other reply");
  });
  await t.test("reader overload stays bounded and admission recovers afterward", async () => {
    await save();
    const results = await Promise.all(Array.from({ length: 6 }, () => read()));
    assert.deepEqual(results.slice(0, 5).map(result => result.status), Array(5).fill("available"));
    assert.equal(results[5].status, "unavailable");
    assert.deepEqual(results[5].messages, []);
    assert.equal((await read()).status, "available");
  });
  await t.test("root-owned queued text keeps cross-session provenance separate from authority", async () => {
    const foreignSession = "00000000-0000-4000-8000-000000000098";
    const queued = { type: "attachment", uuid: "00000000-0000-4000-8000-000000000013",
      parentUuid: assistantId, sessionId, cwd: project, timestamp: "2026-10-06T00:00:02.000Z",
      attachment: { type: "queued_command", prompt: "Root-owned queued note",
        origin: { kind: "peer", from: "fixture-sender", fromSession: foreignSession } } };
    await save([...entries, queued]);
    const result = await read();
    assert.equal(result.status, "available");
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.text, "Root-owned queued note");
    assert.equal(JSON.stringify(result).includes(foreignSession), false);
    await save([...entries, { ...queued, sessionId: foreignSession }]);
    assert.equal((await read()).status, "malformed");
  });
  await t.test("retained history reads an intact log after its project folder disappears", async () => {
    await save();
    const moved = project + "-removed";
    await rename(project, moved);
    try {
      const result = await read();
      assert.equal(result.status, "available");
      assert.equal(result.reference, `claude-session:${sessionId}`);
      assert.deepEqual(result.messages, [{ role: "user", text: "Fixture prompt" }, { role: "assistant", text: "Fixture reply" }]);
    } finally { await rename(moved, project); }
  });
  await t.test("missing logs retain the logical provider reference", async () => {
    await rm(logPath);
    const result = await read();
    assert.equal(result.status, "missing");
    assert.equal(result.reference, `claude-session:${sessionId}`);
  });
  await t.test("mismatched and absent session or cwd metadata fail closed", async () => {
    for (const alteration of [{ sessionId: "00000000-0000-4000-8000-000000000099" },
      { cwd: path.join(root, "other-project") }, { sessionId: undefined }, { cwd: undefined }]) {
      await save([{ ...entries[0], ...alteration }, entries[1]]);
      assert.equal((await read()).status, "malformed");
    }
  });
  await t.test("colliding default project names cannot attach another cwd", async () => {
    const collision = path.join(root, "project_a");
    await mkdir(collision);
    await save(entries.map(entry => ({ ...entry, cwd: collision })));
    assert.equal((await read()).status, "malformed");
  });
  await t.test("malformed and incomplete lines are never interpreted as a partial chain", async () => {
    for (const text of ['{"type":\n', JSON.stringify(entries[0]), '{"type":"user","uuid":123}\n']) {
      await writeFile(logPath, text);
      assert.equal((await read()).status, "malformed");
    }
  });
  await t.test("byte, line, nesting and record limits apply before official interpretation", async () => {
    for (const text of ["x".repeat(256 * 1024 + 1), '{"type":"metadata","value":"' + "x".repeat(33 * 1024) + '"}\n',
      '{"type":"metadata"}\n'.repeat(2049), '{"type":"metadata","value":' + "[".repeat(40) + "0" + "]".repeat(40) + '}\n']) {
      await writeFile(logPath, text);
      assert.equal((await read()).status, "too-large");
    }
  });
  await t.test("cyclic and overlong identifiers cannot stall the official graph reader", async () => {
    for (const values of [[{ ...entries[0], parentUuid: assistantId }, entries[1]],
      [{ ...entries[0], parentUuid: userId }, entries[1]], [{ ...entries[0], parentUuid: "x".repeat(129) }, entries[1]]]) {
      await save(values);
      assert.equal((await read()).status, "malformed");
    }
  });
  await t.test("unsupported config, long names, unsafe identity and private project storage are explicit", async () => {
    await save();
    assert.equal((await readClaudeCodeSessionLog({ ...run, metadata: { ...run.metadata, claudeConfigDir: "/custom" } },
      { homeDirectory: home })).status, "unsupported");
    assert.equal((await readClaudeCodeSessionLog({ ...run, cwd: path.join(root, "x".repeat(201)) },
      { homeDirectory: home })).status, "unsupported");
    assert.equal((await readClaudeCodeSessionLog({ ...run, metadata: { ...run.metadata, claudeSessionId: "../unsafe" } },
      { homeDirectory: home })).status, "unsupported");
    assert.equal((await readClaudeCodeSessionLog(run, { homeDirectory: project })).status, "unsupported");
  });
  if (process.platform !== "win32") {
    await t.test("an existing linked project is refused even with an intact log", async () => {
      await save();
      const moved = project + "-linked";
      await rename(project, moved);
      try {
        await symlink(moved, project);
        assert.equal((await read()).status, "unavailable");
      } finally {
        await rm(project);
        await rename(moved, project);
      }
    });
    await t.test("file symlinks, hardlinks and parent links are unavailable", async () => {
      await save();
      const outside = path.join(root, "outside.jsonl");
      await rename(logPath, outside);
      await symlink(outside, logPath);
      assert.equal((await read()).status, "unavailable");
      await rm(logPath);
      await link(outside, logPath);
      assert.equal((await read()).status, "unavailable");
      await rm(logPath);
      await rename(outside, logPath);
      const moved = directory + "-moved";
      await rename(directory, moved);
      await symlink(moved, directory);
      assert.equal((await read()).status, "unavailable");
      await rm(directory);
      await rename(moved, directory);
    });
  }
});

test("authorized details read a decomposed Unicode Claude project and redact before shortening", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vivary-claude-details-")));
  const projectPath = path.join(root, "Cafe\u0301");
  const home = path.join(root, "home");
  await mkdir(projectPath);
  const project = await realpath(projectPath);
  t.mock.method(os, "homedir", () => home);
  const previous = { store: process.env.AGENT_NATIVE_CODE_AGENTS_HOME,
    workspace: process.env.VIVARY_LOCAL_AGENT_WORKSPACE, // guard:allow-env-credential - Nonsecret fixture workspace, restored below.
    config: process.env.CLAUDE_CONFIG_DIR, // guard:allow-env-credential - Nonsecret provider configuration path, restored below.
    projectName: process.env.CLAUDE_CODE_PROJECT_DIR_NAME, // guard:allow-env-credential - Nonsecret provider directory name, restored below.
    heldCredential: process.env.VIVARY_DETAILS_TEST_API_KEY, // guard:allow-env-credential - Save the test-only held credential setting for restoration.
    database: process.env.DATABASE_URL, unpooled: process.env.DATABASE_URL_UNPOOLED };
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = path.join(root, "native");
  process.env.VIVARY_LOCAL_AGENT_WORKSPACE = project; // guard:allow-env-credential - Disposable selected project.
  delete process.env.CLAUDE_CONFIG_DIR; // guard:allow-env-credential - Exercise default storage without touching the real provider directory.
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME; // guard:allow-env-credential - Exercise default naming without inheriting a custom provider directory.
  const heldCredential = "fixtureHeldValue_0123456789_abcdefghijk";
  process.env.VIVARY_DETAILS_TEST_API_KEY = heldCredential; // guard:allow-env-credential - Hold a synthetic fixture value through the normal credential source.
  process.env.DATABASE_URL = "file:" + path.join(root, "fixture.sqlite");
  process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
  t.after(async () => {
    if (previous.store === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous.store;
    if (previous.workspace === undefined) delete process.env.VIVARY_LOCAL_AGENT_WORKSPACE; // guard:allow-env-credential - Restore the absent fixture workspace setting.
    else process.env.VIVARY_LOCAL_AGENT_WORKSPACE = previous.workspace; // guard:allow-env-credential - Restore the prior nonsecret workspace setting.
    if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; // guard:allow-env-credential - Restore the absent provider configuration path.
    else process.env.CLAUDE_CONFIG_DIR = previous.config; // guard:allow-env-credential - Restore the prior nonsecret provider configuration path.
    if (previous.projectName === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME; // guard:allow-env-credential - Restore the absent provider directory name.
    else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = previous.projectName; // guard:allow-env-credential - Restore the prior nonsecret provider directory name.
    if (previous.heldCredential === undefined) delete process.env.VIVARY_DETAILS_TEST_API_KEY; // guard:allow-env-credential - Remove the synthetic fixture credential setting.
    else process.env.VIVARY_DETAILS_TEST_API_KEY = previous.heldCredential; // guard:allow-env-credential - Restore the prior test-only credential setting.
    if (previous.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.database;
    if (previous.unpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
    else process.env.DATABASE_URL_UNPOOLED = previous.unpooled;
    await rm(root, { recursive: true, force: true });
  });
  const run = createCodeAgentRunRecord({ goalId: "vivary-local-code", title: "Claude log fixture", cwd: project,
    status: "paused", metadata: { app: "vivary-workbench-local-code", engine: "claude-cli",
      ownerEmail: "owner@example.test", orgId: "fixture-org", workspaceRoot: project, claudeSessionId: sessionId } });
  // SDK 0.3.288 normalizes Darwin cwd to NFC: Cafe + combining accent -> Caf-.
  // Linux keeps the decomposed spelling, whose documented encoded suffix is Cafe-.
  const projectKey = root.replace(/[^a-zA-Z0-9]/g, "-") + (process.platform === "darwin" ? "-Caf-" : "-Cafe-");
  const directory = path.join(home, ".claude", "projects", projectKey);
  const recordedCwd = process.platform === "darwin" ? project.normalize("NFC") : project;
  await mkdir(directory, { recursive: true });
  const userId = "00000000-0000-4000-8000-000000000011";
  const assistantId = "00000000-0000-4000-8000-000000000012";
  const providerEntries = [
    { type: "user", uuid: userId, parentUuid: null, sessionId, cwd: recordedCwd,
      timestamp: "2026-10-06T00:00:00.000Z", message: { role: "user", content: "Read my saved conversation." } },
    { type: "assistant", uuid: assistantId, parentUuid: userId, sessionId, cwd: recordedCwd,
      timestamp: "2026-10-06T00:00:01.000Z", message: { role: "assistant", content: [
        { type: "text", text: "x".repeat(1_490) + " ghp_0123456789abcdef0123456789abcdef0123" },
        { type: "thinking", thinking: "PRIVATE_THINKING_SENTINEL" },
        { type: "tool_use", id: "tool-fixture", name: "Read", input: { path: "PRIVATE_TOOL_SENTINEL" } },
      ] } },
  ];
  await writeFile(path.join(directory, sessionId + ".jsonl"), providerEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const input = codeStateAction.schema.parse({ runId: run.id, details: true });
  const context = { userEmail: "owner@example.test", orgId: "fixture-org" };
  const details = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
  assert.equal(details.providerLog.status, "available");
  assert.equal(details.providerLog.reference, `claude-session:${sessionId}`);
  assert.match(details.providerLog.excerpt, /Read my saved conversation/);
  assert.equal(details.providerLog.excerpt.includes("ghp_"), false);
  assert.equal(JSON.stringify(details).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(details).includes(root), false);
  assert.equal(details.sessionId, sessionId);
  await t.test("a held credential concatenated across the text cutoff is redacted before truncation", async () => {
    const entries = [providerEntries[0], { ...providerEntries[1], message: { role: "assistant", content: [
      { type: "text", text: "x".repeat(1_490) + heldCredential + "trailingText" },
    ] } }];
    await writeFile(path.join(directory, sessionId + ".jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const heldDetails = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
    assert.equal(heldDetails.providerLog.status, "available");
    assert.equal(heldDetails.providerLog.truncated, true);
    assert.equal(heldDetails.providerLog.excerpt.includes(heldCredential.slice(0, 10)), false);
    assert.match(heldDetails.providerLog.excerpt, /\[redacted/);
  });
  await t.test("aggregate provider bounds retain the newest redacted text", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      parentUuid: index === 0 ? null : `00000000-0000-4000-8000-${String(99 + index).padStart(12, "0")}`,
      sessionId, cwd: recordedCwd, timestamp: `2026-10-06T00:00:${String(index).padStart(2, "0")}.000Z`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: index === 23
        ? "NEWEST_PROVIDER_MARKER " + heldCredential + " " + "z".repeat(1_400)
        : (index === 0 ? "OLDEST_PROVIDER_MARKER " : "") + "x".repeat(1_400) },
    }));
    await writeFile(path.join(directory, sessionId + ".jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const latest = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
    assert.equal(latest.providerLog.status, "available");
    assert.equal(latest.providerLog.truncated, true);
    assert.equal(latest.providerLog.excerpt.length, 20_000);
    assert.match(latest.providerLog.excerpt, /NEWEST_PROVIDER_MARKER/);
    assert.equal(latest.providerLog.excerpt.includes("OLDEST_PROVIDER_MARKER"), false);
    assert.equal(latest.providerLog.excerpt.includes(heldCredential), false);
    assert.match(latest.providerLog.excerpt, /\[redacted/);
  });
  await t.test("an encoded-name collision cannot supply another project's Unicode metadata", async () => {
    const other = path.join(root, process.platform === "darwin" ? "Caf\u00e8" : "Cafe_");
    await mkdir(other);
    const foreignEntries = providerEntries.map(entry => ({ ...entry, cwd: other }));
    await writeFile(path.join(directory, sessionId + ".jsonl"), foreignEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const foreignDetails = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
    assert.equal(foreignDetails.providerLog.status, "malformed");
    assert.equal(foreignDetails.sessionId, sessionId);
    assert.equal(foreignDetails.providerLog.excerpt, "");
  });
  await t.test("Linux keeps distinct NFC and NFD project identities", { skip: process.platform !== "linux" }, async () => {
    const composed = path.join(root, "Caf\u00e9");
    await mkdir(composed);
    assert.notEqual(await realpath(composed), project);
    const foreignEntries = providerEntries.map(entry => ({ ...entry, cwd: composed }));
    await writeFile(path.join(directory, sessionId + ".jsonl"), foreignEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const foreignDetails = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
    assert.equal(foreignDetails.providerLog.status, "malformed");
    assert.equal(foreignDetails.providerLog.excerpt, "");
  });
  await assert.rejects(() => codeStateAction.run(input, { ...context, userEmail: "other@example.test" }), /not found/i);
  await assert.rejects(() => codeStateAction.run(input, { ...context, orgId: "other-org" }), /not found/i);
  await rm(path.join(directory, sessionId + ".jsonl"));
  const missing = await codeStateAction.run(input, context) as VivaryCodeSessionDetails;
  assert.equal(missing.providerLog.status, "missing");
  assert.equal(missing.sessionId, sessionId);
  assert.equal(missing.providerLog.reference, details.providerLog.reference);
});
