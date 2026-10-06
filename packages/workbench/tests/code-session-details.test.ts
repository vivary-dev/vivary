import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendCodeAgentTranscriptEvent, codeAgentRunTranscriptPath, createCodeAgentRunRecord } from "@agent-native/core/code-agents";
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
