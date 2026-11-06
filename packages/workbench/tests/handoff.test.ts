import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  const { ensureRunTables, insertRun } = await import(new URL("../../agent/run-store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
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
  let failRename = false, failAfterRename = false;
  const files = createProjectFileService(async () => workspace, { unlink,
    rename: async (from, to) => {
      if (failRename) throw Object.assign(new Error("Selected disk fault"), { code: "EIO" });
      await rename(from, to);
      if (failAfterRename) throw new Error("Selected post-rename verification fault");
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

  const { createCodeAgentRunRecord, appendCodeAgentTranscriptEvent, listCodeAgentTranscriptEvents,
    codeAgentRunTranscriptPath } = await import("@agent-native/core/code-agents");
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
      assert.equal("replyRefused" in result && result.replyRefused, true, name);
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
    // The reply was not read, so the reply preview must not show it as refused.
    assert.equal("replyRefused" in early, false);
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

    // Git lists a new untracked directory as one entry, which the observer refuses. The Git state
    // is then unknown, so an edit inside that directory can never read Fresh.
    await mkdir(path.join(projectRoot, "drafts", "deep"), { recursive: true });
    await writeFile(path.join(projectRoot, "drafts", "deep", "guide.md"), "first draft\n");
    try {
      const request = await prepared();
      assert.equal(request.facts.project.dirty, null);
      deliver(request.message, fenced(proposal(request.requestId)));
      assert.equal((await handoff.save(actor, { ...input, requestId: request.requestId })).code, "saved");
      assert.deepEqual(await freshness(), { status: "unverifiable", reasons: [] });
      await appendFile(path.join(projectRoot, "drafts", "deep", "guide.md"), "a much longer second draft\n");
      assert.deepEqual(await freshness(), { status: "unverifiable", reasons: [] });
    } finally {
      await rm(path.join(projectRoot, "drafts"), { recursive: true });
    }

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
    // The same request can never pass this check again, so Retry is not offered.
    assert.equal("retryable" in failed && failed.retryable, false);

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
    assert.equal("retryable" in status && status.retryable, true);
    assert.match(JSON.stringify(status), /previous version/i);
    const retried = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(retried.code, "saved");
    assert.match(await readFile(statePath, "utf8"), /Second version/);
    assert.deepEqual(await freshness(), { status: "fresh", reasons: [] });
  });

  await t.test("Save refuses a reply the conversation continued past, so the facts end where the narrative ends", async () => {
    await saveHandoff();
    const bytes = await readFile(statePath);
    const request = await prepared();
    deliver(request.message, fenced(proposal(request.requestId)));
    deliver("Also rename the queue table", "Renamed it.");
    const result = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(result.code, "refused", JSON.stringify(result));
    assert.match(JSON.stringify(result), /continued after the handoff reply/);
    assert.equal("replyRefused" in result && result.replyRefused, true);
    assert.deepEqual(await readFile(statePath), bytes);
    assert.equal((await handoff.freshness(actor, input)).status, "pending");
  });

  await t.test("stopped, failed and active Code follow-ups refuse stale Save and stale Fresh", async () => {
    for (const status of ["paused", "errored", "active"] as const) {
      await saveHandoff();
      const request = await prepared();
      deliver(request.message, fenced(proposal(request.requestId)));
      const before = await readFile(statePath);
      const record = await conversations.record(conversation, await conversations.scope(actor, input.projectId));
      const completed = await conversations.completedPrefix(conversation, record);
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message: "Also revise the operator guide" });
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: "PARTIAL OUTPUT", metadata: { role: "assistant" } });
      if (status !== "active") appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: status,
        metadata: { status, phase: status } });
      assert.deepEqual(await conversations.completedPrefix(conversation, record), completed, "linked prefix still stops at completion");
      const result = await handoff.save(actor, { ...input, requestId: request.requestId });
      assert.equal(result.code, "refused", status);
      assert.match(JSON.stringify(result), /continued after the handoff reply/);
      assert.deepEqual(await readFile(statePath), before);

      await saveHandoff();
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message: "A new request after Save" });
      if (status !== "active") appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: status, metadata: { status } });
      assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["events-appended"] }, status);
    }
  });

  await t.test("Native progression follows selected ancestry including stopped, failed and active tails", async () => {
    const { createThread, updateThreadData, getThread } = await import("@agent-native/core/server");
    const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: workspace.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "handoff-native", orgId, scope: identity.scope });
    const native = { projectId: input.projectId, conversation: { kind: "native" as const, id: thread.id } };
    const ask = (id: string, parentId: string | null, text: string) => ({ parentId, message: { id, role: "user", content: [{ type: "text", text }] } });
    const answer = (id: string, parentId: string, text: string, status = { type: "complete", reason: "stop" }, custom = {}) =>
      ({ parentId, message: { id, role: "assistant", content: [{ type: "text", text }], status, metadata: { custom } } });
    await insertRun("native-live-run", thread.id);
    let messages: unknown[] = [];
    const store = (headId: string) => updateThreadData(thread.id, JSON.stringify({ headId, messages }), "Handoff Native", "", messages.length);
    for (const tail of ["stopped", "runError", "active", "live-run"] as const) {
      messages = [ask("native-ask", null, "Initial request"), answer("native-evidence", "native-ask", "12 passed")];
      await store("native-evidence");
      const request = await handoff.prepare(actor, native);
      assert.equal(request.code, "prepared");
      if (!("requestId" in request)) throw new Error("Prepare refused");
      messages.push(ask("handoff-ask", "native-evidence", request.message), answer("handoff-answer", "handoff-ask",
        fenced(proposal(request.requestId, { checks: [{ name: "tests", outcome: "passed", evidenceEventId: "native-evidence" }] }))));
      await store("handoff-answer");
      const source = (await getThread(thread.id))!;
      const completed = await conversations.completedPrefix(native.conversation, source);
      const appendTail = async () => {
        const partial = answer("tail-answer", "tail-ask", "PARTIAL OUTPUT",
          tail === "live-run" ? { type: "complete", reason: "stop" } : { type: "incomplete", reason: tail === "runError" ? "error" : "cancelled" },
          tail === "stopped" ? { userStopped: true } : tail === "runError" ? { runError: true } : {});
        if (tail === "live-run") Object.assign(partial.message.metadata, { runId: "native-live-run" });
        messages.push(ask("tail-ask", "handoff-answer", "Follow up"), partial);
        await store("tail-answer");
      };
      const before = await readFile(statePath);
      await appendTail();
      assert.deepEqual(await conversations.completedPrefix(native.conversation, (await getThread(thread.id))!), completed);
      const refused = await handoff.save(actor, { ...native, requestId: request.requestId });
      assert.equal(refused.code, "refused", tail);
      assert.match(JSON.stringify(refused), /continued after the handoff reply/);
      assert.deepEqual(await readFile(statePath), before);

      // The unrelated stored branch cannot invalidate selected history or make a failed reply evidence.
      messages.push(null); // An unrelated malformed stored sibling cannot change selected ancestry.
      await store("handoff-answer");
      assert.equal((await handoff.save(actor, { ...native, requestId: request.requestId })).code, "saved");
      assert.equal((await handoff.freshness(actor, native)).status, "fresh");
      await store("tail-answer");
      const stale = await handoff.freshness(actor, native);
      assert.equal(stale.status, "out-of-date", tail);
      assert.deepEqual("reasons" in stale && stale.reasons, ["events-appended"]);
    }
  });

  await t.test("malformed or oversized Native progression refuses Save and cannot remain Fresh", async () => {
    const { createThread, getThread } = await import("@agent-native/core/server");
    const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: workspace.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "bounded-handoff-native", orgId, scope: identity.scope });
    const native = { projectId: input.projectId, conversation: { kind: "native" as const, id: thread.id } };
    // Inject exact stored corruption without Native's client-save merge retaining old sibling messages or keys.
    const store = (data: string) => db.execute({ sql: "UPDATE chat_threads SET thread_data = ? WHERE id = ?", args: [data, thread.id] });
    for (const oversized of [false, true]) {
      await store("{}");
      const request = await handoff.prepare(actor, native);
      if (!("requestId" in request)) throw new Error("Prepare refused");
      const messages = [
        { parentId: null, message: { id: "bounded-ask", role: "user", content: [{ type: "text", text: request.message }] } },
        { parentId: "bounded-ask", message: { id: "bounded-answer", role: "assistant", status: { type: "complete", reason: "stop" },
          content: [{ type: "text", text: fenced(proposal(request.requestId, { checks: [{ name: "tests", outcome: "not-run", evidenceEventId: null }] })) }] } },
      ];
      const original = JSON.stringify({ headId: "bounded-answer", messages });
      await store(original);
      const later = oversized ? JSON.stringify({ headId: "bounded-answer", messages, padding: "x".repeat(8 * 1024 * 1024) })
        : JSON.stringify({ headId: "broken-tail", messages: [...messages, { parentId: "bounded-answer", message: { id: "broken-tail", role: "user", content: [null] } }] });
      const bytes = await readFile(statePath);
      await store(later);
      await assert.rejects(handoff.save(actor, { ...native, requestId: request.requestId }), { errorCode: "vivary_linked_history_unavailable" });
      assert.deepEqual(await readFile(statePath), bytes);
      await store(original);
      assert.equal((await handoff.save(actor, { ...native, requestId: request.requestId })).code, "saved");
      await store(later);
      const stale = await handoff.freshness(actor, native);
      assert.equal(stale.status, "out-of-date");
      assert.deepEqual("reasons" in stale && stale.reasons, ["history-changed"]);
      // The frozen completed prefix remains readable even though the selected progression cannot be verified.
      assert.equal((await conversations.completedPrefix(native.conversation, (await getThread(thread.id))!, "bounded-answer")).boundaryId, "bounded-answer");
    }
  });

  await t.test("older saved handoffs without progression facts require an update before Fresh", async () => {
    await saveHandoff();
    const stored = JSON.parse((await row())[0]);
    delete stored.saved.facts.conversation.progressionDigest;
    await db.execute({ sql: "UPDATE vivary_handoff_records SET record_json = ?", args: [JSON.stringify(stored)] });
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["history-changed"] });
  });

  await t.test("post-rename failure never promises preservation or offers the same request Retry", async () => {
    await saveHandoff();
    const request = await prepared();
    deliver(request.message, fenced(proposal(request.requestId, { goal: "New content already written" })));
    failAfterRename = true;
    let result;
    try { result = await handoff.save(actor, { ...input, requestId: request.requestId }); }
    finally { failAfterRename = false; }
    assert.equal(result.code, "failed");
    assert.match(await readFile(statePath, "utf8"), /New content already written/);
    assert.doesNotMatch(JSON.stringify(result), /previous version.*kept/i);
    assert.match(JSON.stringify(result), /may have changed|could not confirm/i);
    const status = await handoff.freshness(actor, input);
    assert.equal(status.status, "failed");
    assert.equal("retryable" in status && status.retryable, false);
    assert.equal((await handoff.save(actor, { ...input, requestId: request.requestId })).code, "refused");
  });

  await t.test("failed record finalization reports uncertain outcome after a successful file write", async () => {
    for (const failStatusWrite of [false, true]) {
      await saveHandoff();
      const request = await prepared();
      deliver(request.message, fenced(proposal(request.requestId, { goal: "Written before record failure" })));
      const execute = db.execute.bind(db);
      db.execute = async command => {
        if (typeof command !== "string" && command.sql.startsWith("INSERT INTO vivary_handoff_records")
          && (failStatusWrite || JSON.parse(String(command.args?.[3])).request === null)) throw new Error("Record finalization unavailable");
        return execute(command);
      };
      let result;
      try { result = await handoff.save(actor, { ...input, requestId: request.requestId }); }
      finally { db.execute = execute; }
      assert.equal(result.code, "failed");
      assert.match(await readFile(statePath, "utf8"), /Written before record failure/);
      assert.doesNotMatch(JSON.stringify(result), /previous version.*kept/i);
      const status = await handoff.freshness(actor, input);
      assert.equal(status.status, failStatusWrite ? "pending" : "failed");
      assert.equal("retryable" in status && status.retryable, false);
      assert.match(JSON.stringify(result), /may have changed/);
    }
  });

  await t.test("an uncertain write with a foreign edit or unavailable reread never infers success from its marker", async () => {
    for (const unreadable of [false, true]) {
      await saveHandoff();
      const previousSaved = JSON.parse((await row())[0]).saved;
      const request = await prepared();
      deliver(request.message, fenced(proposal(request.requestId, { goal: "A matching request marker is insufficient" })));
      let wrote = false;
      const faulted = createHandoffService({ conversations, files: { ...files, save: async (ctx, args) => {
        await files.save(ctx, args);
        await appendFile(statePath, "Foreign edit after handoff replacement\n");
        wrote = true;
        throw new Error("Post-write fault");
      } }, state: async (ctx, projectId) => {
        if (wrote && unreadable) throw new Error("Reread unavailable");
        return memory.stateDocument(ctx, projectId);
      }, observe: current => observeProjectVersion(current, { runCreator }) });
      const result = await faulted.save(actor, { ...input, requestId: request.requestId });
      assert.equal(result.code, "failed");
      assert.doesNotMatch(JSON.stringify(result), /previous version.*kept/i);
      assert.match(await readFile(statePath, "utf8"), /Foreign edit after handoff replacement/);
      const status = await handoff.freshness(actor, input);
      assert.equal(status.status, "failed");
      assert.equal("retryable" in status && status.retryable, false);
      assert.deepEqual(JSON.parse((await row())[0]).saved, previousSaved);
    }
  });

  await t.test("malformed or oversized later history cannot stay Fresh or write a stale reply", async () => {
    for (const tail of ["null\n", "x".repeat(8 * 1024 * 1024) + "\n"]) {
      await saveHandoff();
      const transcript = codeAgentRunTranscriptPath(run.id);
      const original = await readFile(transcript);
      try {
        await appendFile(transcript, tail);
        const status = await handoff.freshness(actor, input);
        assert.equal(status.status, "out-of-date");
        assert.deepEqual("reasons" in status && status.reasons, ["history-changed"]);
      } finally { await writeFile(transcript, original); }
      const request = await prepared();
      deliver(request.message, fenced(proposal(request.requestId)));
      const complete = await readFile(transcript), bytes = await readFile(statePath);
      try {
        await appendFile(transcript, tail);
        await assert.rejects(handoff.save(actor, { ...input, requestId: request.requestId }),
          { errorCode: "vivary_linked_history_unavailable" });
        assert.deepEqual(await readFile(statePath), bytes);
      } finally { await writeFile(transcript, complete); }
    }
  });

  await t.test("a project change between Prepare and Save is saved as the Prepare version, so it reads Out of date", async () => {
    await saveHandoff();
    const request = await prepared();
    await appendFile(path.join(projectRoot, "dirty.txt"), "changed while the agent replied\n");
    deliver(request.message, fenced(proposal(request.requestId)));
    const saved = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(saved.code, "saved", JSON.stringify(saved));
    assert.deepEqual("record" in saved && saved.record.facts.project, request.facts.project);
    assert.deepEqual(await freshness(), { status: "out-of-date", reasons: ["files-changed"] });
  });

  await t.test("an update after text was added below the handoff moves the block to the end and keeps that text", async () => {
    await saveHandoff();
    await appendFile(statePath, "Manual note below the handoff\n");
    await saveHandoff();
    const text = await readFile(statePath, "utf8");
    assert.equal(text.split("<!-- vivary:handoff -->").length - 1, 1);
    assert.ok(text.endsWith("<!-- /vivary:handoff -->\n"), "the handoff is last");
    assert.ok(text.indexOf("Manual note below the handoff") < text.indexOf("<!-- vivary:handoff -->"));
  });

  await t.test("reply text cannot recreate the handoff markers, so a later Save still works", async () => {
    await saveHandoff();
    const request = await prepared();
    const smuggled = proposal(request.requestId, { goal: "Close <<!--!-- /vivary:handoff ---->> early",
      decisions: ["Open <<!--!-- vivary:handoff ---->> again", "End a comment --!> here"] });
    deliver(request.message, fenced(smuggled));
    const saved = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(saved.code, "saved", JSON.stringify(saved));
    const text = await readFile(statePath, "utf8");
    assert.equal(text.split("<!--").length - 1, 2, "only the two markers open a comment");
    assert.equal(text.split("-->").length - 1, 2, "only the two markers close a comment");
    assert.doesNotMatch(text, /--!>/);
    await saveHandoff();
  });

  await t.test("a Claude Code reply an older build recorded twice still saves, while two different blocks are refused", async () => {
    // The pair observed in a Windows Claude Code transcript on 2026-10-19: the streamed reply, then the same text
    // with the engine and model.
    const claudeReply = (message: string, reply: string) => {
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message });
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: reply, metadata: { role: "assistant", source: "claude-cli" } });
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: reply,
        metadata: { role: "assistant", engine: "claude-cli", model: "claude-haiku-5-5" } });
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
    };
    const request = await prepared();
    claudeReply(request.message, fenced(proposal(request.requestId, { goal: "Saved from a repeated Claude reply" })));
    const saved = await handoff.save(actor, { ...input, requestId: request.requestId });
    assert.equal(saved.code, "saved", JSON.stringify(saved));
    assert.match(await readFile(statePath, "utf8"), /Saved from a repeated Claude reply/);
    const bytes = await readFile(statePath);
    const different = await prepared();
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message: different.message });
    for (const goal of ["First draft", "Second draft"]) {
      appendCodeAgentTranscriptEvent({ runId: run.id, kind: "system", message: fenced(proposal(different.requestId, { goal })),
        metadata: { role: "assistant", source: "claude-cli" } });
    }
    appendCodeAgentTranscriptEvent({ runId: run.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete" } });
    const refused = await handoff.save(actor, { ...input, requestId: different.requestId });
    assert.equal(refused.code, "refused");
    assert.match(JSON.stringify(refused), /more than one vivary-handoff block/);
    assert.deepEqual(await readFile(statePath), bytes);
    await saveHandoff();
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

  await t.test("existing noneditable state is never described as missing and no refusal changes bytes", async t => {
    const original = await readFile(statePath);
    t.after(() => writeFile(statePath, original));
    const before = await row();
    for (const [reason, bytes] of [["too-large", Buffer.alloc(262_145, 97)], ["binary", Buffer.from([0, 1, 2])]] as const) {
      await writeFile(statePath, bytes);
      const result = await service(memoryFor(thin)).prepare(actor, input);
      assert.equal("reason" in result && result.reason, "state-uneditable", reason);
      assert.match(JSON.stringify(result), reason === "too-large" ? /too large/ : /text/);
      assert.doesNotMatch(JSON.stringify(result), /does not exist|Create it/);
      assert.deepEqual(await readFile(statePath), bytes);
    }
    await writeFile(statePath, original);
    await link(statePath, statePath + ".link");
    try {
      const result = await service(memoryFor(thin)).prepare(actor, input);
      assert.equal("reason" in result && result.reason, "state-uneditable");
      assert.match(JSON.stringify(result), /linked/);
    } finally { await unlink(statePath + ".link"); }
    await rename(statePath, statePath + ".original");
    await symlink(statePath + ".original", statePath);
    try {
      const result = await service(memoryFor(thin)).prepare(actor, input);
      assert.equal("reason" in result && result.reason, "state-uneditable");
      assert.doesNotMatch(JSON.stringify(result), /does not exist|Create it/);
    } finally { await unlink(statePath); await rename(statePath + ".original", statePath); }
    const privateState = await service(memoryFor({ ...thin, privacy: { ...thin.privacy, privateFiles: ["STATE.md"] } })).prepare(actor, input);
    assert.equal("reason" in privateState && privateState.reason, "state-private");
    assert.deepEqual(await row(), before);
    assert.deepEqual(await readFile(statePath), original);
  });

  await t.test("a conversation linking refuses is refused here too, as unavailable", async () => {
    const before = await row();
    const codeRun = (id: string, metadata: Record<string, unknown> = {}) => createCodeAgentRunRecord({ id, goalId: "vivary-local-code",
      title: "Other", cwd: projectRoot, status: "completed", phase: "completed", needsApproval: false,
      metadata: { app: "vivary-workbench-local-code", ...history(), workspaceRoot: projectRoot, ownerEmail: owner, orgId,
        engine: "claude-cli", model: "sonnet", ...metadata } });
    // A link target an interrupted link left marked, with no finished link row.
    const unfinished = codeRun("unfinished-target", { linkedHistoryId: "4d2c8f6e-3b1a-4c5d-9e7f-0a1b2c3d4e5f", linkedCreationPending: true });
    // Retained history the linked reader cannot parse.
    const broken = codeRun("broken-history");
    appendCodeAgentTranscriptEvent({ runId: broken.id, kind: "user", message: "Request" });
    await writeFile(codeAgentRunTranscriptPath(broken.id), "not a transcript record\n");
    for (const id of [unfinished.id, broken.id]) {
      const refused = { projectId: "project-a", conversation: { kind: "code" as const, id } };
      await assert.rejects(handoff.prepare(actor, refused), { errorCode: "vivary_linked_history_unavailable" }, id);
    }
    await assert.rejects(handoff.freshness(actor, { projectId: "project-a", conversation: { kind: "code", id: unfinished.id } }),
      { errorCode: "vivary_linked_history_unavailable" });
    assert.deepEqual(await row(), before);
  });

  await t.test("a check run while writing the handoff reply cites its tool call and saves", async () => {
    const { createThread } = await import("@agent-native/core/server");
    const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: workspace.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "fresh-check-native", orgId, scope: identity.scope });
    const native = { projectId: input.projectId, conversation: { kind: "native" as const, id: thread.id } };
    const store = (data: string) => db.execute({ sql: "UPDATE chat_threads SET thread_data = ? WHERE id = ?", args: [data, thread.id] });
    const check = (cited: string) => ({ checks: [{ name: "state document read", outcome: "passed", evidenceEventId: cited }] });
    // Native: the reply's own tool call has a toolCallId and no completed event ID until the turn ends.
    for (const [cited, saved] of [["tool:call_made_up", false], ["tool:call_earlier", false], ["tool:call_fresh_1", true]] as const) {
      await store("{}");
      const request = await handoff.prepare(actor, native);
      if (!("requestId" in request)) throw new Error("Prepare refused");
      assert.match(request.message, /tool:call_1/);
      const messages = [
        { parentId: null, message: { id: "earlier-ask", role: "user", content: [{ type: "text", text: "Read the state document" }] } },
        { parentId: "earlier-ask", message: { id: "earlier-answer", role: "assistant", status: { type: "complete", reason: "stop" },
          content: [{ type: "tool-call", toolCallId: "call_earlier", toolName: "vivary-project-read", args: {}, result: "STATE.md read" },
            { type: "text", text: "Read it." }] } },
        { parentId: "earlier-answer", message: { id: "fresh-ask", role: "user", content: [{ type: "text", text: request.message }] } },
        { parentId: "fresh-ask", message: { id: "fresh-answer", role: "assistant", status: { type: "complete", reason: "stop" },
          content: [{ type: "tool-call", toolCallId: "call_fresh_1", toolName: "vivary-project-read", args: {}, result: "STATE.md read" },
            { type: "text", text: fenced(proposal(request.requestId, check(cited))) }] } },
      ];
      await store(JSON.stringify({ headId: "fresh-answer", messages }));
      const before = await readFile(statePath);
      const result = await handoff.save(actor, { ...native, requestId: request.requestId });
      if (!saved) {
        // A made-up call, or one from an earlier turn, is not evidence produced by this reply.
        assert.equal(result.code, "refused", cited);
        assert.match(JSON.stringify(result), new RegExp(`Tool call ${cited.slice(5)} is not a completed tool call in this handoff reply`));
        assert.deepEqual(await readFile(statePath), before);
        continue;
      }
      assert.equal(result.code, "saved");
      if (result.code !== "saved") return;
      assert.equal(result.record.checks[0].evidenceEventId, "fresh-answer");
      assert.match(await readFile(statePath, "utf8"), /passed: state document read \(event fresh-answer\)/);
    }
    // Code: the tool result is its own completed event, recorded with the runtime's tool call ID.
    const fresh = createCodeAgentRunRecord({ id: "fresh-check-code", goalId: "vivary-local-code", title: "Fresh check", cwd: projectRoot,
      status: "completed", phase: "completed", needsApproval: false,
      metadata: { app: "vivary-workbench-local-code", ...history(), workspaceRoot: projectRoot, ownerEmail: owner, orgId,
        engine: "claude-cli", model: "sonnet" } });
    const code = { projectId: input.projectId, conversation: { kind: "code" as const, id: fresh.id } };
    const completed = () => appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "status", message: "Completed",
      metadata: { status: "completed", phase: "complete" } });
    appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "user", message: "Read the state document" });
    appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "status", message: "Finished Read.",
      metadata: { type: "tool_done", tool: "Read", result: "STATE.md read", toolCallId: "toolu_earlier", source: "claude-cli" } });
    appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "system", message: "Read it.", metadata: { role: "assistant" } });
    completed();
    // A reply that cites the earlier turn's call is refused, and one that cites its own call saves.
    for (const [own, cited, saves] of [["toolu_other", "toolu_earlier", false], ["toolu_fresh", "toolu_fresh", true]] as const) {
      const request = await handoff.prepare(actor, code);
      if (!("requestId" in request)) throw new Error("Prepare refused");
      appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "user", message: request.message });
      appendCodeAgentTranscriptEvent({ runId: fresh.id, id: `${own}-event`, kind: "status", message: "Finished Read.",
        metadata: { type: "tool_done", tool: "Read", result: "STATE.md read", toolCallId: own, source: "claude-cli" } });
      appendCodeAgentTranscriptEvent({ runId: fresh.id, kind: "system", message: fenced(proposal(request.requestId, check(`tool:${cited}`))),
        metadata: { role: "assistant" } });
      completed();
      const saved = await handoff.save(actor, { ...code, requestId: request.requestId });
      if (!saves) {
        assert.equal(saved.code, "refused");
        assert.match(JSON.stringify(saved), /Tool call toolu_earlier is not a completed tool call in this handoff reply/);
        continue;
      }
      assert.equal(saved.code, "saved");
      if (saved.code === "saved") assert.equal(saved.record.checks[0].evidenceEventId, "toolu_fresh-event");
    }
  });

  await t.test("a foreign actor or project cannot prepare or inspect", async () => {
    await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      args: ["foreign-member", orgId, "foreign@example.test", "member", Date.now()] });
    for (const patch of [{ userEmail: "foreign@example.test" }, { orgId: "foreign-org" }, { caller: "tool" as const }]) {
      await assert.rejects(handoff.freshness({ ...actor, ...patch }, input));
      await assert.rejects(handoff.prepare({ ...actor, ...patch }, input));
    }
    await assert.rejects(handoff.prepare(actor, { ...input, projectId: "foreign-project" }));
  });
});
