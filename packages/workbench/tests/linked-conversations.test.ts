import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActionRunContext } from "@agent-native/core/action";

test("linked conversations use Native records and immutable authorized completed history", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-linked-conversations-"));
  const previous = { ...process.env };
  t.after(async () => {
    const { closeDbExec } = await import("@agent-native/core/db");
    await closeDbExec();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; // guard:allow-env-credential - Restores the test process environment saved above, no credential is read.
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  // Process-scoped disposable Native stores, as in the maintained chat/draft suites.
  Object.assign(process.env, { APP_NAME: "VivaryLinkedTest", AGENT_USER_EMAIL: "linked@example.test", AGENT_NATIVE_CODE_AGENTS_HOME: path.join(root, "code"),
    DATABASE_URL: "file:" + path.join(root, "state.sqlite"), DATABASE_URL_UNPOOLED: "file:" + path.join(root, "state.sqlite") });
  const { withMigrationRuntime, getDbExec, runMigrations } = await import("@agent-native/core/db");
  const { ORG_MIGRATIONS, isOrgMember } = await import("@agent-native/core/org");
  const { createThread, getThread, updateThreadData } = await import("@agent-native/core/server");
  const { ensureChatThreadTables } = await import(new URL("../../chat-threads/store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
  const { ensureRunTables, insertRun } = await import(new URL("../../agent/run-store.js", import.meta.resolve("@agent-native/core/client/agent-chat")).href);
  const { migrateRegistry } = await import("../server/db/migrations.mjs");
  await withMigrationRuntime(async () => {
    await runMigrations(ORG_MIGRATIONS, { table: "_org_migrations" })({});
    await migrateRegistry({}); await ensureChatThreadTables(); await ensureRunTables();
  });
  const db = getDbExec(), owner = "linked@example.test", orgId = "linked-org";
  await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
    args: ["linked-member", orgId, owner, "owner", Date.now()] });
  const actor: ActionRunContext = { userEmail: owner, orgId, appId: "workbench", caller: "http" };
  const project = { projectId: "project-a", label: "Alpha", bindingId: "binding-a", rootId: "root-a", bindingRevision: 1 };
  let revoked = false, discoveryFailure = false;
  const { createLinkedConversationService } = await import("../server/linked-conversations.ts");
  const service = createLinkedConversationService({ member: isOrgMember,
    history: async (_ctx, projectId) => {
      if (revoked || projectId !== project.projectId) throw Object.assign(new Error("Current project grant refused"), { statusCode: 403 });
      return project;
    }, workspace: async () => ({ root, ...project }),
    targetModel: async choice => { if (discoveryFailure) throw new Error("Discovery unavailable"); return choice.model; } });
  const { createCodeAgentRunRecord, appendCodeAgentTranscriptEvent, getCodeAgentRunRecord, listCodeAgentTranscriptEvents,
    codeAgentRunTranscriptPath, updateCodeAgentRunRecord } = await import("@agent-native/core/code-agents");
  const { createVivaryChatIdentity } = await import("../server/chat-identity.ts");
  const { changeChatDraft, readChatDraft, createCodeDraftIdentity } = await import("../server/chat-draft.ts");
  // Initialize the existing host before simulating live sources, rather than treating them as prior-host leftovers.
  const { getVivaryCodeHostState } = await import("../server/local-code-agent.ts");
  await getVivaryCodeHostState(owner, orgId);
  const code = (id: string, engine = "claude-cli") => createCodeAgentRunRecord({ id, goalId: "vivary-local-code", title: "Source", cwd: root,
    status: "needs-approval", phase: "action-approval", needsApproval: true,
    metadata: { app: "vivary-workbench-local-code", ...project, workspaceRoot: root, ownerEmail: owner, orgId, engine,
      model: "sonnet", claudeSessionId: "source-resume-id", pendingLaunch: "retained-source", draftThreadId: "vivary-code:project:project-a:source" } });
  const source = code("source");
  appendCodeAgentTranscriptEvent({ runId: source.id, id: "source-user", kind: "user", message: "Completed request" });
  appendCodeAgentTranscriptEvent({ runId: source.id, id: "source-answer", kind: "system", message: "Completed answer", metadata: { role: "assistant" } });
  appendCodeAgentTranscriptEvent({ runId: source.id, id: "source-done", kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
  appendCodeAgentTranscriptEvent({ runId: source.id, id: "source-pending", kind: "user", message: "Live pending request excluded" });
  const draftIdentity = createCodeDraftIdentity(owner, orgId, project.projectId);
  await changeChatDraft(draftIdentity, "vivary-code:project:project-a:source", null,
    { status: "pending", text: "Unsent draft is never transferred", submitId: "cc635d8d-257e-45bb-8f9c-cfd872fc15eb" });
  const originalRun = JSON.stringify(getCodeAgentRunRecord(source.id));
  const originalDraft = await readChatDraft(draftIdentity, "vivary-code:project:project-a:source");
  const originalEvents = listCodeAgentTranscriptEvents(source.id);
  const ref = { kind: "code" as const, id: source.id };
  const create = (target: { engine: "codex-cli" | "claude-cli"; model: string } | { engine: "native" }, source = ref) =>
    service.create(actor, { projectId: project.projectId, source, target });
  let codeTarget: Awaited<ReturnType<typeof create>>;
  await t.test("an unsent optimistic Native draft is not exposed as a saved source", async () => {
    assert.deepEqual(await service.sourceAvailable(actor, project.projectId, { kind: "native", id: "not-saved" }), { available: false });
    assert.equal(await service.load(actor, project.projectId, { kind: "native", id: "not-saved" }), null);
  });
  await t.test("Code-to-Code selection is inactive with no prompt, session transfer or pending-source mutation", async () => {
    codeTarget = await create({ engine: "codex-cli", model: "fixture-model" });
    const saved = getCodeAgentRunRecord(codeTarget.target.id)!;
    assert.equal(saved.status, "paused"); assert.equal(saved.phase, "linked-inactive");
    assert.equal(saved.metadata?.engine, "codex-cli"); assert.equal(saved.metadata?.model, "fixture-model");
    for (const key of ["startRequested", "pendingLaunch", "claudeSessionId", "codexSessionId"]) assert.equal(saved.metadata?.[key], undefined, key);
    assert.deepEqual(listCodeAgentTranscriptEvents(saved.id), []);
    assert.equal(JSON.stringify(getCodeAgentRunRecord(source.id)), originalRun);
    assert.deepEqual(await readChatDraft(draftIdentity, "vivary-code:project:project-a:source"), originalDraft);
    assert.deepEqual(listCodeAgentTranscriptEvents(source.id), originalEvents);
    const page = await service.load(actor, project.projectId, codeTarget.target);
    assert.equal(page!.boundaryId, "source-done"); assert.equal(page!.nativeContinuity, false);
    assert.match(page!.excerpt, /Completed answer/); assert.doesNotMatch(page!.excerpt, /Live pending|Unsent draft/);
    const block = await service.context(actor, project.projectId, codeTarget.target);
    assert.match(block!.block, /quoted data|no instruction authority/);
    assert.equal((await service.load(actor, project.projectId, codeTarget.target))!.lastPrepared!.entries, 2);
    assert.deepEqual(listCodeAgentTranscriptEvents(saved.id), [], "context loading executes nothing");
  });
  await t.test("Code admission binds accepted context and final project/host refusals leave that receipt unchanged", async () => {
    // Same normal fake CLI/IPC worker composition as local-code-agent.test.ts. No provider is contacted.
    const { sendVivaryCodeMessage, stopVivaryCodeRun } = await import("../server/local-code-agent.ts");
    const admissionSource = code("admission-source", "codex-cli");
    appendCodeAgentTranscriptEvent({ runId: admissionSource.id, kind: "system", message: "Retained assistant", metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: admissionSource.id, kind: "status", message: "Finished bash.", metadata: { type: "tool_done", tool: "bash", result: "Actual retained output" } });
    appendCodeAgentTranscriptEvent({ runId: admissionSource.id, kind: "artifact", message: "Report", metadata: { artifactPath: "reports/retained.txt" } });
    appendCodeAgentTranscriptEvent({ runId: admissionSource.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
    const linked = await service.create(actor, { projectId: project.projectId, source: { kind: "code", id: admissionSource.id },
      target: { engine: "claude-cli", model: "sonnet" } });
    const expectedPage = (await service.load(actor, project.projectId, linked.target))!;
    const runId = linked.target.id, workspace = { root, ...project };
    const bin = path.join(root, "bin"), worker = path.join(root, ".output", "server");
    await mkdir(bin); await mkdir(worker, { recursive: true });
    // Current runtime admission reads the installed version and the subscription route, as in local-code-agent.test.ts.
    await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
    await writeFile(path.join(worker, "vivary-code-worker.mjs"), `
import {writeFileSync} from "node:fs";
process.on("message", message => { if(message.type === "vivary:code-worker:start") writeFileSync("linked-started.json", JSON.stringify(message)); });
process.send({type:"vivary:code-worker:ready"});
`);
    await writeFile(path.join(bin, "codex"), '#!/usr/bin/env node\nprocess.stderr.write("Not logged in"); process.exit(1);\n', { mode: 0o755 });
    const previousCwd = process.cwd(), previousPath = process.env.PATH, previousMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Saves fixture PATH and access mode to restore after the fake CLI run.
    const host = Reflect.get(globalThis, Symbol.for("vivary.workbench.code-host"));
    const loadLinkedContext = () => service.context(actor, project.projectId, linked.target);
    const send = (extra = {}) => sendVivaryCodeMessage({ ownerEmail: owner, orgId, runId, workspace,
      message: "Explicit request", engine: "claude-cli", model: "sonnet", loadLinkedContext, ...extra });
    try {
      process.chdir(root);
      process.env.PATH = bin + path.delimiter + (previousPath ?? ""); // guard:allow-env-credential - Disposable normal fake CLI fixture, restored below.
      process.env.VIVARY_ACCESS_MODE = "local"; // guard:allow-env-credential - Disposable local fixture, restored below.
      const accepted = await send();
      assert.equal(accepted.run!.id, runId);
      const execution = host.activeRuns.get(runId)?.execution;
      let started: { prompt: string } | undefined;
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        try { started = JSON.parse(await readFile(path.join(root, "linked-started.json"), "utf8")); }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      assert.match(started!.prompt, /Actual retained output[\s\S]*reports\/retained.txt[\s\S]*Explicit request/);
      await stopVivaryCodeRun({ ownerEmail: owner, orgId, runId, projectId: project.projectId }); await execution;
      const receipt = (await service.load(actor, project.projectId, linked.target))!.lastAccepted;
      const users = listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user");
      assert.equal(users.length, 1); assert.equal(receipt!.userEventId, users[0].id);
      assert.equal(receipt!.entries, 3); assert.equal(receipt!.characters, expectedPage.excerpt.length); assert.equal(users[0].message, "Explicit request");
      await rm(path.join(root, "linked-started.json"));
      await assert.rejects(send({ revalidateWorkspace: async () => ({ ...workspace, bindingRevision: 2 }) }),
        { errorCode: "vivary_code_project_changed" });
      const slotId = "selected-host-refusal";
      try {
        await assert.rejects(send({ loadLinkedContext: async () => {
          const prepared = await loadLinkedContext();
          // Hold the existing host admission seam while this send is awaiting preparation.
          host.activeRuns.set(slotId, { runId: slotId }); return prepared;
        } }), { errorCode: "vivary_code_run_active" });
      } finally { host.activeRuns.delete(slotId); }
      assert.deepEqual((await service.load(actor, project.projectId, linked.target))!.lastAccepted, receipt);
      assert.equal(listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user").length, 1);
      assert.equal(host.activeRuns.size, 0);
      await assert.rejects(readFile(path.join(root, "linked-started.json")), { code: "ENOENT" });
      // A folder reconnect allocates a new root epoch for the same binding. The linked target still sends with its context.
      Object.assign(project, { rootId: "root-reconnected", bindingRevision: 2 });
      const reconnected = await sendVivaryCodeMessage({ ownerEmail: owner, orgId, runId, workspace: { root, ...project },
        message: "After reconnect", engine: "claude-cli", model: "sonnet", loadLinkedContext });
      assert.equal(reconnected.run!.id, runId);
      const reconnectedExecution = host.activeRuns.get(runId)?.execution;
      let restarted: { prompt: string } | undefined;
      for (let attempt = 0; attempt < 100 && !restarted; attempt++) {
        try { restarted = JSON.parse(await readFile(path.join(root, "linked-started.json"), "utf8")); }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      assert.match(restarted!.prompt, /Actual retained output[\s\S]*After reconnect/);
      await stopVivaryCodeRun({ ownerEmail: owner, orgId, runId, projectId: project.projectId }); await reconnectedExecution;
      await rm(path.join(root, "linked-started.json"));
      const reconnectedUsers = listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user");
      assert.equal(reconnectedUsers.length, 2);
      assert.equal(reconnectedUsers[1].metadata?.linkedHistory?.entries, 3);
      // A deleted source transcript leaves the target usable. The send supplies and records no linked portion.
      await rm(codeAgentRunTranscriptPath(admissionSource.id));
      const withoutSource = await sendVivaryCodeMessage({ ownerEmail: owner, orgId, runId, workspace: { root, ...project },
        message: "Source deleted request", engine: "claude-cli", model: "sonnet", loadLinkedContext });
      assert.equal(withoutSource.run!.id, runId);
      const unlinkedExecution = host.activeRuns.get(runId)?.execution;
      let unlinked: { prompt: string } | undefined;
      for (let attempt = 0; attempt < 100 && !unlinked; attempt++) {
        try { unlinked = JSON.parse(await readFile(path.join(root, "linked-started.json"), "utf8")); }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      assert.match(unlinked!.prompt, /Source deleted request/);
      assert.doesNotMatch(unlinked!.prompt, /Actual retained output|Linked conversation history/);
      await stopVivaryCodeRun({ ownerEmail: owner, orgId, runId, projectId: project.projectId }); await unlinkedExecution;
      await rm(path.join(root, "linked-started.json"));
      const unlinkedUsers = listCodeAgentTranscriptEvents(runId).filter(event => event.kind === "user");
      assert.equal(unlinkedUsers.length, 3); assert.equal(unlinkedUsers[2].metadata?.linkedHistory, undefined);
      const unavailablePage = (await service.load(actor, project.projectId, linked.target))!;
      assert.equal(unavailablePage.sourceStatus, "unavailable"); assert.equal(unavailablePage.excerpt, "");
      assert.equal(unavailablePage.lastAccepted!.userEventId, reconnectedUsers[1].id, "the receipt stays on the last send that had context");
    } finally {
      Object.assign(project, { rootId: "root-a", bindingRevision: 1 });
      const execution = host.activeRuns.get(runId)?.execution;
      if (execution) { await stopVivaryCodeRun({ ownerEmail: owner, orgId, runId, projectId: project.projectId }).catch(() => undefined); await execution; }
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; // guard:allow-env-credential - Restore disposable fixture.
      if (previousMode === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previousMode; // guard:allow-env-credential - Restore disposable fixture.
    }
  });
  await t.test("Code-to-Native uses the existing empty thread and draft owners without copied messages", async () => {
    const linked = await create({ engine: "native" });
    const thread = await getThread(linked.target.id);
    assert.equal(thread!.ownerEmail, owner); assert.equal(thread!.messageCount, 0);
    assert.match(linked.route, /runtime=native/);
    assert.equal(thread!.orgId, orgId);
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    assert.deepEqual(thread!.scope, identity.scope);
    assert.equal((await readChatDraft(identity, thread!.id))!.status, "cleared");
    assert.match((await service.context(actor, project.projectId, linked.target))!.block, /Completed answer/);
    assert.equal((await getThread(linked.target.id))!.messageCount, 0);
  });
  await t.test("Code-to-empty-Native-to-Code retains a legitimate empty completed boundary", async () => {
    const native = await create({ engine: "native" });
    const originalEmptyData = (await getThread(native.target.id))!.threadData;
    assert.equal(JSON.parse(originalEmptyData).messages?.length ?? 0, 0);
    const linked = await service.create(actor, { projectId: project.projectId, source: native.target,
      target: { engine: "claude-cli", model: "sonnet" } });
    const page = (await service.load(actor, project.projectId, linked.target))!;
    assert.equal(page.boundaryId, null); assert.equal(page.availableEntries, 0);
    assert.equal(page.excerpt, ""); assert.deepEqual(listCodeAgentTranscriptEvents(linked.target.id), []);
    assert.equal((await getThread(native.target.id))!.threadData, originalEmptyData);
  });
  await t.test("Native prepareRequest preserves display text and reports preparation without delivery", async () => {
    const linked = await create({ engine: "native" });
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const { runWithRequestContext } = await import("@agent-native/core/server");
    const result = await runWithRequestContext({ userEmail: owner, orgId, run: { chatScope: identity.scope } }, () =>
      service.prepareNativeMessage({ threadId: linked.target.id, ownerEmail: owner, message: "Typed request", displayMessage: "Visible request" }));
    assert.match(result!.message, /Completed answer[\s\S]*# Current request\nTyped request$/);
    assert.equal(result!.displayMessage, "Visible request");
    const page = (await service.load(actor, project.projectId, linked.target))!;
    assert.equal(page.lastPrepared!.entries, 2); assert.equal(page.lastAccepted, null);
    assert.equal((await getThread(linked.target.id))!.messageCount, 0);
    assert.equal(await service.prepareNativeMessage({ threadId: linked.target.id, ownerEmail: owner, message: "Internal", internalContinuation: true }), undefined);
    await assert.rejects(runWithRequestContext({ userEmail: owner, orgId, run: { chatScope: { type: "workspace-app", id: "foreign" } } }, () =>
      service.prepareNativeMessage({ threadId: linked.target.id, ownerEmail: owner, message: "Forged" })));
  });
  await t.test("Codex also links to Claude Code and Native without copying either provider session", async () => {
    const codex = code("codex-source", "codex-cli");
    updateCodeAgentRunRecord(codex.id, { metadata: { codexSessionId: "source-codex-session" } });
    appendCodeAgentTranscriptEvent({ runId: codex.id, kind: "system", message: "Codex completed history", metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: codex.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
    for (const target of [{ engine: "claude-cli", model: "sonnet" }, { engine: "native" }] as const) {
      const linked = await create(target, { kind: "code", id: codex.id });
      assert.match((await service.load(actor, project.projectId, linked.target))!.excerpt, /Codex completed history/);
      if (linked.target.kind === "code") {
        const run = getCodeAgentRunRecord(linked.target.id)!;
        assert.equal(run.metadata?.claudeSessionId, undefined); assert.equal(run.metadata?.codexSessionId, undefined);
        assert.deepEqual(listCodeAgentTranscriptEvents(run.id), []);
      } else assert.equal((await getThread(linked.target.id))!.messageCount, 0);
    }
  });
  await t.test("Native-to-Code captures a completed prefix while its pending approval/draft remain in the source", async () => {
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "native-source", orgId, scope: identity.scope });
    const messages = [
      { parentId: null, message: { id: "native-user", role: "user", content: [{ type: "text", text: "Native request" }] } },
      { parentId: "native-user", message: { id: "native-answer", role: "assistant", status: { type: "complete", reason: "stop" },
        content: [{ type: "text", text: "Native completed answer" }] } },
      { parentId: "native-answer", message: { id: "native-wait", role: "assistant", status: { type: "complete", reason: "stop" },
        content: [{ type: "tool-call", approval: { askId: "retained-exact-ask" }, args: { command: "MUST NOT REPLAY" }, result: "Pending" }] } },
    ];
    await updateThreadData(thread.id, JSON.stringify({ headId: "native-wait", messages }), "Native source", "Waiting", messages.length);
    await changeChatDraft(identity, thread.id, null, { status: "draft", text: "Native unsent", submitId: null });
    const before = (await getThread(thread.id))!.threadData;
    for (const engine of ["claude-cli", "codex-cli"] as const) {
      const linked = await service.create(actor, { projectId: project.projectId, source: { kind: "native", id: thread.id }, target: { engine, model: "fixture" } });
      const page = await service.load(actor, project.projectId, linked.target);
      assert.equal(page!.boundaryId, "native-answer"); assert.match(page!.excerpt, /Native completed answer/);
      assert.doesNotMatch(page!.excerpt, /MUST NOT REPLAY|retained-exact-ask|Native unsent/);
      assert.deepEqual(listCodeAgentTranscriptEvents(linked.target.id), []);
    }
    assert.equal((await getThread(thread.id))!.threadData, before);
    assert.equal((await readChatDraft(identity, thread.id))!.text, "Native unsent");
  });
  await t.test("a project folder reconnect keeps links and older sources usable for the same binding only", async () => {
    const native = await create({ engine: "native" });
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const { runWithRequestContext } = await import("@agent-native/core/server");
    const prepareNative = () => runWithRequestContext({ userEmail: owner, orgId, run: { chatScope: identity.scope } }, () =>
      service.prepareNativeMessage({ threadId: native.target.id, ownerEmail: owner, message: "After reconnect" }));
    try {
      // Reconnection allocates a new root epoch and keeps the binding, as in local-code-agent.test.ts.
      Object.assign(project, { rootId: "root-reconnected", bindingRevision: 2 });
      assert.equal((await service.load(actor, project.projectId, codeTarget.target))!.boundaryId, "source-done");
      assert.match((await service.context(actor, project.projectId, codeTarget.target))!.block!, /Completed answer/);
      assert.match((await prepareNative())!.message, /Completed answer[\s\S]*# Current request\nAfter reconnect$/);
      const older = await create({ engine: "native" });
      assert.match((await service.load(actor, project.projectId, older.target))!.excerpt, /Completed answer/);
      // A different binding is a different folder grant, so every read and new link still refuses.
      project.bindingId = "binding-other";
      await assert.rejects(service.load(actor, project.projectId, codeTarget.target), { errorCode: "vivary_linked_history_unavailable" });
      await assert.rejects(service.context(actor, project.projectId, native.target), { errorCode: "vivary_linked_history_unavailable" });
      await assert.rejects(create({ engine: "native" }), { errorCode: "vivary_linked_history_unavailable" });
    } finally { Object.assign(project, { bindingId: "binding-a", rootId: "root-a", bindingRevision: 1 }); }
  });
  await t.test("editing or regenerating the source boundary or an earlier message keeps the frozen linked prefix", async () => {
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "branching-source", orgId, scope: identity.scope });
    const answer = (id: string, parentId: string, text: string) => ({ parentId, message: { id, role: "assistant",
      status: { type: "complete", reason: "stop" }, content: [{ type: "text", text }] } });
    const ask = (id: string, parentId: string | null, text: string) => ({ parentId, message: { id, role: "user", content: [{ type: "text", text }] } });
    const messages: unknown[] = [ask("first-ask", null, "First request"), answer("first-answer", "first-ask", "First answer"),
      ask("second-ask", "first-answer", "Second request"), answer("second-answer", "second-ask", "Original boundary answer")];
    const save = (headId: string) => updateThreadData(thread.id, JSON.stringify({ headId, messages }), "Branching", "", messages.length);
    await save("second-answer");
    const linked = await service.create(actor, { projectId: project.projectId, source: { kind: "native", id: thread.id },
      target: { engine: "claude-cli", model: "sonnet" } });
    const before = (await service.load(actor, project.projectId, linked.target))!;
    const block = (await service.context(actor, project.projectId, linked.target))!.block;
    assert.equal(before.boundaryId, "second-answer"); assert.match(before.excerpt, /Original boundary answer/);
    // Regenerating the boundary adds a sibling answer and moves the head. The original stays stored.
    messages.push(answer("regenerated-answer", "second-ask", "REGENERATED ANSWER"));
    await save("regenerated-answer");
    // Editing an earlier message starts a sibling branch from the root.
    messages.push(ask("edited-ask", null, "EDITED REQUEST"), answer("edited-answer", "edited-ask", "EDITED ANSWER"));
    await save("edited-answer");
    const after = (await service.load(actor, project.projectId, linked.target))!;
    assert.equal(after.sourceStatus, "available"); assert.equal(after.boundaryId, "second-answer");
    assert.equal(after.excerpt, before.excerpt); assert.doesNotMatch(after.excerpt, /REGENERATED|EDITED/);
    assert.equal((await service.context(actor, project.projectId, linked.target))!.block, block);
  });
  await t.test("earlier stopped and failed Native replies inside the completed prefix are not quoted", async () => {
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const thread = await createThread(owner, { id: "stopped-source", orgId, scope: identity.scope });
    const ask = (id: string, parentId: string | null, text: string) => ({ parentId, message: { id, role: "user", content: [{ type: "text", text }] } });
    const reply = (id: string, parentId: string, text: string, status: Record<string, string>, custom?: Record<string, unknown>) => ({ parentId,
      message: { id, role: "assistant", status, content: [{ type: "text", text }], ...(custom ? { metadata: { custom } } : {}) } });
    // Shapes Native persists for a reply the owner stopped and for a failed run (thread-data-builder and the chat adapter).
    const messages = [ask("stop-ask", null, "Request the owner stopped"),
      reply("stopped", "stop-ask", "STOPPED PARTIAL", { type: "incomplete", reason: "cancelled" }, { userStopped: true }),
      ask("error-ask", "stopped", "Request that failed"),
      reply("errored", "error-ask", "FAILED PARTIAL", { type: "incomplete", reason: "error" }, { runError: { message: "Provider failed" } }),
      ask("reason-ask", "errored", "Request with an error reason"),
      reply("reason-error", "reason-ask", "ERROR REASON PARTIAL", { type: "complete", reason: "error" }),
      ask("final-ask", "reason-error", "Final request"),
      reply("final-answer", "final-ask", "Final completed answer", { type: "complete", reason: "stop" })];
    await updateThreadData(thread.id, JSON.stringify({ headId: "final-answer", messages }), "Stopped source", "", messages.length);
    const linked = await service.create(actor, { projectId: project.projectId, source: { kind: "native", id: thread.id },
      target: { engine: "claude-cli", model: "sonnet" } });
    const page = (await service.load(actor, project.projectId, linked.target))!;
    assert.equal(page.boundaryId, "final-answer");
    assert.match(page.excerpt, /Request the owner stopped[\s\S]*Request that failed[\s\S]*Final completed answer/);
    assert.doesNotMatch(page.excerpt, /STOPPED PARTIAL|FAILED PARTIAL|ERROR REASON PARTIAL/);
    assert.equal(page.availableEntries, 5);
  });
  await t.test("a deleted source leaves the target usable without linked context, while a tampered link record refuses", async () => {
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    const { runWithRequestContext, deleteThread } = await import("@agent-native/core/server");
    const linkRecord = async (id: string) => String((await db.execute({ sql: "SELECT record_json FROM vivary_conversation_links WHERE target_id = ?", args: [id] })).rows[0].record_json);
    // Native source to Code target. The Native thread is deleted through its owner.
    const nativeSource = await createThread(owner, { id: "deleted-native-source", orgId, scope: identity.scope });
    const messages = [{ parentId: null, message: { id: "deleted-ask", role: "user", content: [{ type: "text", text: "Deleted request" }] } },
      { parentId: "deleted-ask", message: { id: "deleted-answer", role: "assistant", status: { type: "complete", reason: "stop" }, content: [{ type: "text", text: "Deleted answer" }] } }];
    await updateThreadData(nativeSource.id, JSON.stringify({ headId: "deleted-answer", messages }), "Deleted source", "", 2);
    const codeLinked = await service.create(actor, { projectId: project.projectId, source: { kind: "native", id: nativeSource.id },
      target: { engine: "claude-cli", model: "sonnet" } });
    assert.match((await service.context(actor, project.projectId, codeLinked.target))!.block!, /Deleted answer/);
    const prepared = await linkRecord(codeLinked.target.id);
    assert.equal(await deleteThread(nativeSource.id), true);
    const page = (await service.load(actor, project.projectId, codeLinked.target))!;
    assert.equal(page.sourceStatus, "unavailable"); assert.equal(page.sourceTitle, "Deleted source");
    assert.equal(page.excerpt, ""); assert.equal(page.availableEntries, 0); assert.equal(page.suppliedEntries, 0);
    assert.equal(page.nextCursor, null); assert.equal(page.lastAccepted, null);
    assert.deepEqual(await service.context(actor, project.projectId, codeLinked.target), { block: null, portion: null });
    assert.equal(await linkRecord(codeLinked.target.id), prepared, "an unavailable source records no prepared portion");
    await assert.rejects(service.load(actor, project.projectId, codeLinked.target, "0".repeat(64) + ":1"), { errorCode: "vivary_linked_history_unavailable" });
    // Code source to Native target. The Native send proceeds with the unchanged request.
    const codeSource = code("deleted-code-source");
    appendCodeAgentTranscriptEvent({ runId: codeSource.id, kind: "system", message: "Code answer", metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: codeSource.id, kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
    const nativeLinked = await create({ engine: "native" }, { kind: "code", id: codeSource.id });
    const prepareNative = () => runWithRequestContext({ userEmail: owner, orgId, run: { chatScope: identity.scope } }, () =>
      service.prepareNativeMessage({ threadId: nativeLinked.target.id, ownerEmail: owner, message: "Native request" }));
    assert.match((await prepareNative())!.message, /Code answer[\s\S]*Native request$/);
    const nativePrepared = await linkRecord(nativeLinked.target.id);
    await rm(codeAgentRunTranscriptPath(codeSource.id));
    assert.equal(await prepareNative(), undefined, "the request proceeds unchanged without linked context");
    assert.equal(await linkRecord(nativeLinked.target.id), nativePrepared);
    assert.equal((await service.load(actor, project.projectId, nativeLinked.target))!.sourceStatus, "unavailable");
    // A target link record that belongs to someone else or fails its schema is a safety refusal, not an unavailable source.
    const tamper = (record: string) => db.execute({ sql: "UPDATE vivary_conversation_links SET record_json = ? WHERE target_id = ?", args: [record, nativeLinked.target.id] });
    for (const forged of [{ ...JSON.parse(nativePrepared), owner: "foreign@example.test" }, { ...JSON.parse(nativePrepared), injected: true }]) {
      await tamper(JSON.stringify(forged));
      await assert.rejects(service.load(actor, project.projectId, nativeLinked.target));
      await assert.rejects(prepareNative());
    }
    await tamper(nativePrepared);
    await db.execute({ sql: "DELETE FROM vivary_conversation_links WHERE target_id = ?", args: [codeLinked.target.id] });
    await assert.rejects(service.load(actor, project.projectId, codeLinked.target), { errorCode: "vivary_linked_history_unavailable" });
    await assert.rejects(service.context(actor, project.projectId, codeLinked.target), { errorCode: "vivary_linked_history_unavailable" });
  });
  await t.test("appended and partial source events cannot widen a retained boundary", async () => {
    await appendFile(codeAgentRunTranscriptPath(source.id), '{"runId":"source","id":"in-progress"');
    assert.equal((await service.load(actor, project.projectId, codeTarget.target))!.boundaryId, "source-done");
    const text = await readFile(codeAgentRunTranscriptPath(source.id), "utf8");
    await writeFile(codeAgentRunTranscriptPath(source.id), text.slice(0, text.lastIndexOf("\n") + 1));
    appendCodeAgentTranscriptEvent({ runId: source.id, id: "later-answer", kind: "system", message: "AFTER BOUNDARY", metadata: { role: "assistant" } });
    appendCodeAgentTranscriptEvent({ runId: source.id, id: "later-done", kind: "status", message: "Later complete", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
    assert.doesNotMatch((await service.load(actor, project.projectId, codeTarget.target))!.excerpt, /AFTER BOUNDARY|Live pending/);
    await appendFile(codeAgentRunTranscriptPath(source.id), "malformed-after-boundary\n");
    assert.equal((await service.load(actor, project.projectId, codeTarget.target))!.boundaryId, "source-done");
    const later = await readFile(codeAgentRunTranscriptPath(source.id), "utf8");
    await writeFile(codeAgentRunTranscriptPath(source.id), later.replace("malformed-after-boundary\n", ""));
  });
  await t.test("foreign actor/app/org/project and revocation refuse, while a changed source binding or prefix withholds its history", async () => {
    await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)",
      args: ["other-member", orgId, "foreign@example.test", "member", Date.now()] });
    for (const patch of [{ userEmail: "foreign@example.test" }, { appId: "foreign-app" }, { orgId: "foreign-org" }, { caller: "tool" as const }])
      await assert.rejects(service.load({ ...actor, ...patch }, project.projectId, codeTarget.target));
    await assert.rejects(service.load(actor, "foreign-project", codeTarget.target));
    revoked = true; await assert.rejects(service.load(actor, project.projectId, codeTarget.target)); revoked = false;
    await db.execute({ sql: "DELETE FROM org_members WHERE id = ?", args: ["linked-member"] });
    await assert.rejects(service.load(actor, project.projectId, codeTarget.target));
    await db.execute({ sql: "INSERT INTO org_members (id, org_id, email, role, joined_at) VALUES (?, ?, ?, ?, ?)", args: ["linked-member", orgId, owner, "owner", Date.now()] });
    // A source that moved binding or changed its prefix supplies nothing. The valid target link stays usable without it.
    const sourceWithheld = async () => {
      const page = (await service.load(actor, project.projectId, codeTarget.target))!;
      assert.equal(page.sourceStatus, "unavailable"); assert.equal(page.excerpt, ""); assert.doesNotMatch(JSON.stringify(page), /Replaced answer|Completed answer/);
      assert.deepEqual(await service.context(actor, project.projectId, codeTarget.target), { block: null, portion: null });
    };
    updateCodeAgentRunRecord(source.id, { metadata: { bindingId: "forged" } });
    await sourceWithheld();
    updateCodeAgentRunRecord(source.id, { metadata: { bindingId: project.bindingId } });
    const text = await readFile(codeAgentRunTranscriptPath(source.id), "utf8");
    await writeFile(codeAgentRunTranscriptPath(source.id), text.replace("Completed answer", "Replaced answer"));
    await sourceWithheld();
    await writeFile(codeAgentRunTranscriptPath(source.id), text);
    assert.equal((await service.load(actor, project.projectId, codeTarget.target))!.sourceStatus, "available");
  });
  await t.test("failed target discovery preserves the original and a retry creates an inert target", async () => {
    const before = JSON.stringify(getCodeAgentRunRecord(source.id));
    discoveryFailure = true; await assert.rejects(create({ engine: "codex-cli", model: "fixture-model" }));
    assert.equal(JSON.stringify(getCodeAgentRunRecord(source.id)), before);
    assert.deepEqual(await readChatDraft(draftIdentity, "vivary-code:project:project-a:source"), originalDraft);
    discoveryFailure = false;
    const retry = await create({ engine: "codex-cli", model: "fixture-model" });
    assert.equal(getCodeAgentRunRecord(retry.target.id)!.status, "paused");
    assert.deepEqual(listCodeAgentTranscriptEvents(retry.target.id), []);
  });
  await t.test("a real metadata write failure starts nothing, preserves source custody and permits Retry", async () => {
    const before = JSON.stringify(getCodeAgentRunRecord(source.id));
    await db.execute("CREATE TRIGGER fail_link_write BEFORE INSERT ON vivary_conversation_links BEGIN SELECT RAISE(ABORT, 'selected metadata fault'); END");
    try { await assert.rejects(create({ engine: "codex-cli", model: "fixture-model" }), /selected metadata fault/); }
    finally { await db.execute("DROP TRIGGER fail_link_write"); }
    assert.equal(JSON.stringify(getCodeAgentRunRecord(source.id)), before);
    assert.deepEqual(await readChatDraft(draftIdentity, "vivary-code:project:project-a:source"), originalDraft);
    const retry = await create({ engine: "codex-cli", model: "fixture-model" });
    assert.deepEqual(listCodeAgentTranscriptEvents(retry.target.id), []);
  });
  await t.test("real large-history pages stay within the exact source and reject forged continuation", async () => {
    const paged = code("paged-source");
    for (let index = 0; index < 211; index++) appendCodeAgentTranscriptEvent({ runId: paged.id, id: "paged-" + index,
      kind: "user", message: "Historical entry " + index });
    appendCodeAgentTranscriptEvent({ runId: paged.id, id: "paged-done", kind: "status", message: "Completed", metadata: { status: "completed", phase: "complete", engine: "claude-cli" } });
    const linked = await create({ engine: "codex-cli", model: "fixture-model" }, { kind: "code", id: paged.id });
    const first = (await service.load(actor, project.projectId, linked.target))!;
    assert.equal(first.availableEntries, 211); assert.equal(first.truncated, true); assert.ok(first.nextCursor);
    const second = (await service.load(actor, project.projectId, linked.target, first.nextCursor!))!;
    assert.match(second.excerpt, /Historical entry 100/); assert.doesNotMatch(second.excerpt, /Historical entry 0\b/);
    await assert.rejects(service.load(actor, project.projectId, codeTarget.target, first.nextCursor!));
    await assert.rejects(service.load(actor, project.projectId, linked.target, first.nextCursor!.replace(/:\d+$/, ":999999")));
    appendCodeAgentTranscriptEvent({ runId: paged.id, kind: "user", message: "New unlinked work" });
    assert.doesNotMatch((await service.load(actor, project.projectId, linked.target, second.nextCursor!))!.excerpt, /New unlinked work/);
  });
  await t.test("a source without completed work links truthfully to an empty excerpt", async () => {
    const noCompletion = code("no-completed-work");
    appendCodeAgentTranscriptEvent({ runId: noCompletion.id, kind: "user", message: "Still active" });
    const linked = await create({ engine: "native" }, { kind: "code", id: noCompletion.id });
    const page = await service.load(actor, project.projectId, linked.target);
    assert.equal(page!.boundaryId, null); assert.equal(page!.availableEntries, 0); assert.equal(page!.excerpt, "");
  });
  await t.test("a live Native persistence chunk is excluded despite a complete-looking assistant snapshot", async () => {
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: project.projectId, label: "Alpha" });
    await createThread(owner, { id: "saving-source", orgId, scope: identity.scope });
    await insertRun("saving-run", "saving-source");
    await updateThreadData("saving-source", JSON.stringify({ headId: "saving-answer", messages: [{ parentId: null,
      message: { id: "saving-answer", role: "assistant", status: { type: "complete" }, metadata: { runId: "saving-run" }, content: [{ type: "text", text: "Incomplete snapshot" }] } }] }), "Saving", "", 1);
    const linked = await service.create(actor, { projectId: project.projectId, source: { kind: "native", id: "saving-source" }, target: { engine: "codex-cli", model: "fixture" } });
    assert.equal((await service.load(actor, project.projectId, linked.target))!.boundaryId, null);
  });
});
