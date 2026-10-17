import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ActionRunContext } from "@agent-native/core/action";

// Prepare handoff (A083) and handoff freshness (A084) over the production
// stores: Native records, the Workbench database, the project file owner and
// the creator bridge's Git observation. No model or provider is contacted.
test("handoffs are written through the file owner and go stale without a model call", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-handoff-"));
  const previous = { ...process.env };
  t.after(async () => {
    const { closeDbExec } = await import("@agent-native/core/db");
    await closeDbExec();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; // guard:allow-env-credential - Removes only names this disposable fixture added, then restores the saved environment.
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  // Process-scoped disposable Native stores, as in the linked conversation suite.
  Object.assign(process.env, { APP_NAME: "VivaryHandoffTest", AGENT_USER_EMAIL: "handoff@example.test", AGENT_NATIVE_CODE_AGENTS_HOME: path.join(root, "code"),
    DATABASE_URL: "file:" + path.join(root, "state.sqlite"), DATABASE_URL_UNPOOLED: "file:" + path.join(root, "state.sqlite") });
  const { withMigrationRuntime, getDbExec, runMigrations } = await import("@agent-native/core/db");
  const { ORG_MIGRATIONS, isOrgMember } = await import("@agent-native/core/org");
  const { ensureChatThreadTables } = await import(new URL("../../chat-threads/store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
  const { ensureRunTables } = await import(new URL("../../agent/run-store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
  const { migrateRegistry } = await import("../server/db/migrations.mjs");
  await withMigrationRuntime(async () => {
    await runMigrations(ORG_MIGRATIONS, { table: "_org_migrations" })({});
    await migrateRegistry({}); await ensureChatThreadTables(); await ensureRunTables();
  });
  const db = getDbExec(), owner = "handoff@example.test", orgId = "handoff-org";
  await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
    args: ["handoff-member", orgId, owner, "owner", Date.now()] });
  const actor: ActionRunContext = { userEmail: owner, orgId, appId: "workbench", caller: "http" };

  // A thin workspace in a Git checkout with one already-dirty file.
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(projectRoot, ".vivary"), { recursive: true });
  await writeFile(path.join(projectRoot, ".vivary", "workspace.toml"), "version = 1\n");
  await writeFile(path.join(projectRoot, "STATE.md"), "# State\nFocus: relay beta\n");
  await writeFile(path.join(projectRoot, "notes.txt"), "tracked\n");
  await writeFile(path.join(projectRoot, "dirty.txt"), "base\n");
  const hostPath = previous.PATH ?? "/usr/bin:/bin";
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", timeout: 10_000,
      env: { PATH: hostPath, HOME: root, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "main"); git("add", "."); git("-c", "commit.gpgSign=false", "commit", "-q", "-m", "fixture");
  await appendFile(path.join(projectRoot, "dirty.txt"), "uncommitted\n");
  const statePath = path.join(projectRoot, "STATE.md");

  let workspace = { root: projectRoot, label: "Alpha", projectId: "project-a", bindingId: "binding-a", rootId: "root-a",
    bindingRevision: 1, policyRevision: 1, actorId: "actor", locationRef: "loc", verificationKind: "local-stat-revalidated-v1" as const };
  const history = () => ({ projectId: workspace.projectId, label: workspace.label, bindingId: workspace.bindingId,
    rootId: workspace.rootId, bindingRevision: workspace.bindingRevision });
  const thin = { status: "thin" as const,
    roles: { law: [], map: [], record: [], memory: [], boundary: [".vivary/private"] },
    state: "STATE.md", memory: [".vivary/knowledge"], memoryAssigned: false, protected: [".vivary/private"],
    privacy: { policy: "none" as const, private: [], privateFiles: [], privateCandidates: [], checkedFiles: [], ignoreFiles: [] } };

  const { createLinkedConversationService } = await import("../server/linked-conversations.ts");
  const conversations = createLinkedConversationService({ member: isOrgMember,
    history: async (_ctx, projectId) => {
      if (projectId !== workspace.projectId) throw Object.assign(new Error("Current project grant refused"), { statusCode: 403 });
      return history();
    }, workspace: async () => workspace, targetModel: async choice => choice.model });
  const { createProjectMemory } = await import("../server/project-memory.ts");
  const { createProjectFileService } = await import("../server/project-files.ts");
  const { observeProjectVersion } = await import("../server/managed-projects.mjs");
  let failRename = false;
  const files = createProjectFileService(async () => workspace, { unlink,
    rename: async (from, to) => {
      if (failRename) throw Object.assign(new Error("Selected disk fault"), { code: "EIO" });
      return rename(from, to);
    } });
  const memoryFor = (answer: unknown) => createProjectMemory({ resolveWorkspace: async () => workspace,
    readWorkspaceContext: async () => answer as never, files });
  const memory = memoryFor(thin);
  // The real bridge script, run as the bundle runs it, without the original runner's receipts.
  const bridge = fileURLToPath(new URL("../server/managed_project_workspace.py", import.meta.url));
  let observations = 0;
  const runCreator = async (call: { operation: string; target: string }) => {
    observations++;
    const result = spawnSync("python3", ["-I", "-X", "utf8", "-B", bridge], { encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ operation: call.operation, target: call.target }), env: { PATH: hostPath, HOME: root } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const { createHandoffService } = await import("../server/handoff.ts");
  const service = (state = memory) => createHandoffService({ conversations, files,
    state: (ctx, projectId) => state.stateDocument(ctx, projectId),
    observe: current => observeProjectVersion(current, { runCreator }) });
  const handoff = service();

  const { createCodeAgentRunRecord, appendCodeAgentTranscriptEvent, listCodeAgentTranscriptEvents } = await import("@agent-native/core/code-agents");
  const { getVivaryCodeHostState } = await import("../server/local-code-agent.ts");
  await getVivaryCodeHostState(owner, orgId);
  const run = createCodeAgentRunRecord({ id: "handoff-run", goalId: "vivary-local-code", title: "Relay work", cwd: projectRoot,
    status: "completed", phase: "completed", needsApproval: false,
    metadata: { app: "vivary-workbench-local-code", ...history(), workspaceRoot: projectRoot, ownerEmail: owner, orgId,
      engine: "claude-cli", model: "sonnet", draftThreadId: "vivary-code:project:project-a:handoff" } });
  appendCodeAgentTranscriptEvent({ runId: run.id, id: "work-request", kind: "user", message: "Edit dirty.txt and run the tests" });
  appendCodeAgentTranscriptEvent({ runId: run.id, id: "check-output", kind: "status", message: "Finished bash.",
    metadata: { type: "tool_done", tool: "bash", result: "12 passed" } });
  appendCodeAgentTranscriptEvent({ runId: run.id, id: "work-answer", kind: "system", message: "Edited dirty.txt. Tests pass.", metadata: { role: "assistant" } });
  appendCodeAgentTranscriptEvent({ runId: run.id, id: "work-done", kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
  const conversation = { kind: "code" as const, id: run.id };
  const input = { projectId: "project-a", conversation };

  const proposal = (requestId: string, patch: Record<string, unknown> = {}) => ({ requestId, goal: "Finish the relay beta",
    decisions: ["Keep SQLite for the relay queue"], changes: ["Edited dirty.txt"],
    checks: [{ name: "unit tests", outcome: "passed", evidenceEventId: "check-output" },
      { name: "lint", outcome: "not-run", evidenceEventId: null }],
    unfinished: ["Write the operator guide"], risks: ["The relay budget is unconfirmed"], nextAction: "Run the integration suite", ...patch });
  const fenced = (value: unknown) => "Here is the handoff.\n\n```vivary-handoff\n" + JSON.stringify(value, null, 2) + "\n```\n";
  // The delivered request and the agent's completed reply, as the Code adapter and worker record them.
  const deliver = (message: string, reply: string | null) => {
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message });
    if (reply === null) return;
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: reply, metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
  };
  const prepared = async () => {
    const result = await handoff.prepare(actor, input);
    assert.equal(result.code, "prepared");
    if (!("requestId" in result)) throw new Error("Prepare was refused.");
    return result;
  };
  const row = async () => (await db.execute({ sql: "SELECT record_json FROM vivary_handoff_records", args: [] })).rows.map(item => String(item.record_json));
  const freshness = async () => {
    const result = await handoff.freshness(actor, input);
    return { status: result.status, reasons: "reasons" in result ? [...result.reasons].sort() : [] };
  };
  const saveHandoff = async () => {
    const request = await prepared();
    deliver(request.message, fenced(proposal(request.requestId)));
    const saved = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(saved.code, "saved", JSON.stringify(saved));
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
    return request;
  };

  await t.test("Prepare names the request, the facts and the reply format, and writes nothing", async () => {
    const before = await readFile(statePath, "utf8");
    assert.deepEqual(await freshness(), { status: "none", reasons: [] });
    const request = await prepared();
    assert.match(request.message, new RegExp(request.requestId));
    assert.match(request.message, /vivary-handoff/);
    assert.match(request.message, /check-output/, "recent completed events are offered as evidence IDs");
    assert.ok(request.message.length < 8_000, "the Code adapter accepts the request");
    assert.equal(request.facts.path, "STATE.md");
    assert.equal(request.facts.project.kind, "git");
    assert.equal(request.facts.conversation.boundaryId, "work-done");
    assert.equal(await readFile(statePath, "utf8"), before);
    assert.equal((await handoff.freshness(actor, input)).status, "pending");
  });

  await t.test("bad structure is refused with the file and the request row unchanged", async () => {
    const bytes = await readFile(statePath);
    const cases: Array<[string, (id: string) => string]> = [
      ["missing field", id => { const value: Record<string, unknown> = proposal(id); delete value.goal; return fenced(value); }],
      ["two blocks", id => fenced(proposal(id)) + fenced(proposal(id))],
      ["wrong request", () => fenced(proposal("another-request"))],
      ["extra key", id => fenced(proposal(id, { extra: "not allowed" }))],
      ["passed check without evidence", id => fenced(proposal(id, { checks: [{ name: "unit tests", outcome: "passed", evidenceEventId: null }] }))],
      ["evidence outside the conversation", id => fenced(proposal(id, { checks: [{ name: "unit tests", outcome: "failed", evidenceEventId: "invented" }] }))],
      ["not-run check with evidence", id => fenced(proposal(id, { checks: [{ name: "lint", outcome: "not-run", evidenceEventId: "check-output" }] }))],
      ["empty list", id => fenced(proposal(id, { risks: [] }))],
      ["no block", () => "I updated STATE.md myself."],
    ];
    for (const [name, reply] of cases) {
      const request = await prepared();
      deliver(request.message, reply(request.requestId));
      const pending = await row();
      const result = await handoff.save(actor, { ...input, requestId: request.requestId });
      assert.equal(result.code, "refused", name);
      assert.ok("problems" in result && result.problems.length > 0, name);
      assert.deepEqual(await readFile(statePath), bytes, name);
      assert.deepEqual(await row(), pending, name);
    }
    // A subagent status mid-turn is not a turn completion, for Save as for linking.
    const midTurn = await prepared();
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message: midTurn.message });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: fenced(proposal(midTurn.requestId)), metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Subagent finished",
      metadata: { status: "completed", type: "subagent" } });
    const early = await handoff.save(actor, { ...input, requestId: midTurn.requestId });
    assert.equal(early.code, "refused");
    assert.match(JSON.stringify(early), /not finished/);
    assert.deepEqual(await readFile(statePath), bytes);
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
    const unanswered = await prepared();
    deliver(unanswered.message, null);
    const result = await handoff.save(actor, { ...input, requestId: unanswered.requestId });
    assert.equal(result.code, "refused");
    assert.match(JSON.stringify(result), /not finished|not completed/i);
    assert.equal((await handoff.freshness(actor, input)).status, "pending");
  });

  await t.test("a valid reply is saved at the end of STATE.md, reports the dirty tree and changes no Git state", async () => {
    const before = await readFile(statePath, "utf8");
    const gitStatus = () => git("status", "--porcelain=v1").split("\n").filter(line => line && !line.endsWith("STATE.md")).join("\n");
    const gitBefore = { status: gitStatus(), log: git("log", "--format=%H"), stash: git("stash", "list") };
    const request = await prepared();
    assert.equal(request.facts.project.dirty, true);
    assert.equal(request.facts.project.dirtyCount, 1, "only dirty.txt, never the designated document");
    deliver(request.message, fenced(proposal(request.requestId)));
    const saved = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(saved.code, "saved", JSON.stringify(saved));
    const after = await readFile(statePath, "utf8");
    assert.ok(after.startsWith(before), "existing bytes are kept");
    assert.match(after.slice(before.length), /^\n<!-- vivary:handoff -->[\s\S]*<!-- \/vivary:handoff -->\n$/);
    assert.match(after, /Dirty working tree: 1 entry/);
    assert.match(after, /Finish the relay beta[\s\S]*Run the integration suite/);
    assert.match(after, /passed: unit tests \(event check-output\)/);
    assert.deepEqual({ status: gitStatus(), log: git("log", "--format=%H"), stash: git("stash", "list") }, gitBefore);
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
    const replay = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(replay.code, "refused", "a saved request cannot be saved twice");
    // Updating replaces the one block and keeps every byte around it.
    await saveHandoff();
    const updated = await readFile(statePath, "utf8");
    assert.equal(updated.match(/<!-- vivary:handoff -->/g)!.length, 1);
    assert.ok(updated.startsWith(before));
  });

  await t.test("later changes mark the handoff Out of date without any model or conversation work", async () => {
    await saveHandoff();
    const events = listCodeAgentTranscriptEvents(run.id).length;
    const runs = (await db.execute({ sql: "SELECT COUNT(*) AS count FROM agent_runs", args: [] })).rows[0].count;
    const reads = observations;
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
    assert.equal(listCodeAgentTranscriptEvents(run.id).length, events, "freshness appends no conversation event");
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS count FROM agent_runs", args: [] })).rows[0].count, runs);
    assert.ok(observations > reads, "freshness observes the project on request");

    await appendFile(path.join(projectRoot, "dirty.txt"), "more\n");
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["files-changed"] });

    await saveHandoff();
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: "Later work", metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["events-appended"] });

    await saveHandoff();
    await writeFile(path.join(projectRoot, "notes.txt"), "committed change\n");
    git("add", "notes.txt"); git("-c", "commit.gpgSign=false", "commit", "-q", "-m", "notes", "--", "notes.txt");
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["head-moved"] });

    await saveHandoff();
    await appendFile(statePath, "Manual note\n");
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["document-edited"] });

    await saveHandoff();
    await writeFile(path.join(projectRoot, "new.txt"), "untracked\n");
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["files-changed", "tree-changed"] });
    await unlink(path.join(projectRoot, "new.txt"));

    // Without Git, the listed files carry the version.
    await rename(path.join(projectRoot, ".git"), path.join(root, "git-away"));
    try {
      const plain = await saveHandoff();
      assert.equal(plain.facts.project.kind, "plain");
      await writeFile(path.join(projectRoot, "notes.txt"), "plain change\n");
      assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["files-changed"] });
    } finally {
      await rename(path.join(root, "git-away"), path.join(projectRoot, ".git"));
    }
  });

  await t.test("an external edit or a rebinding between Prepare and Save is a conflict that keeps the edit", async () => {
    await saveHandoff();
    const request = await prepared();
    deliver(request.message, fenced(proposal(request.requestId)));
    const external = (await readFile(statePath, "utf8")) + "Edited elsewhere\n";
    await writeFile(statePath, external);
    const result = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(result.code, "conflict");
    assert.equal("reason" in result && result.reason, "changed");
    assert.equal(await readFile(statePath, "utf8"), external);
    const failed = await handoff.freshness(actor, input);
    assert.equal(failed.status, "failed");

    const rebound = await prepared();
    deliver(rebound.message, fenced(proposal(rebound.requestId)));
    workspace = { ...workspace, bindingRevision: 2 };
    try {
      const changed = await handoff.save(actor, { ...input, requestId: rebound.requestId });
      assert.equal(changed.code, "conflict");
      assert.equal("reason" in changed && changed.reason, "project-changed");
      assert.equal(await readFile(statePath, "utf8"), external);
    } finally { workspace = { ...workspace, bindingRevision: 1 }; }
  });

  await t.test("a failed write keeps the previous version and record, reports no fresh status, and Retry saves", async () => {
    await saveHandoff();
    const kept = await readFile(statePath, "utf8");
    const covered = JSON.parse((await row())[0]).saved;
    const request = await prepared();
    deliver(request.message, fenced(proposal(request.requestId, { goal: "Second version" })));
    failRename = true;
    try {
      const result = await handoff.save(actor, { ...input, requestId: request.requestId });
      assert.equal(result.code, "failed");
    } finally { failRename = false; }
    assert.equal(await readFile(statePath, "utf8"), kept);
    assert.deepEqual(JSON.parse((await row())[0]).saved, covered);
    const status = await handoff.freshness(actor, input);
    assert.equal(status.status, "failed");
    assert.match(JSON.stringify(status), /previous version/i);
    const retried = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(retried.code, "saved");
    assert.match(await readFile(statePath, "utf8"), /Second version/);
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
  });

  await t.test("no designated state document refuses Prepare with a clear message", async () => {
    const plainWorkspace = service(memoryFor({ status: "plain", memory: [".vivary/knowledge"], protected: [],
      privacy: thin.privacy }));
    const before = await row();
    const refused = await plainWorkspace.prepare(actor, input);
    assert.equal("status" in refused && refused.status, "unavailable");
    assert.equal("reason" in refused && refused.reason, "no-state-role");
    assert.match(JSON.stringify(refused), /STATE\.md|state document/);
    await rename(statePath, statePath + ".away");
    try {
      const missing = await service(memoryFor(thin)).prepare(actor, input);
      assert.equal("reason" in missing && missing.reason, "state-missing");
    } finally { await rename(statePath + ".away", statePath); }
    assert.deepEqual(await row(), before);
  });

  await t.test("a foreign actor or project cannot prepare, save or inspect", async () => {
    await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      args: ["foreign-member", orgId, "foreign@example.test", "member", Date.now()] });
    for (const patch of [{ userEmail: "foreign@example.test" }, { orgId: "foreign-org" }, { caller: "tool" as const }]) {
      await assert.rejects(handoff.freshness({ ...actor, ...patch }, input));
      await assert.rejects(handoff.prepare({ ...actor, ...patch }, input));
    }
    await assert.rejects(handoff.prepare(actor, { ...input, projectId: "foreign-project" }));
  });
});
