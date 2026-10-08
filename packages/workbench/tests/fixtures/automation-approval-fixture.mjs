import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Native retains completed chunks for later subscribers. Those cleanup timers
// must not keep a disposable test process alive for five minutes.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (handler, delay, ...args) => {
  const timer = nativeSetTimeout(handler, delay, ...args);
  if ((delay ?? 0) >= 60_000) timer.unref();
  return timer;
};
const core = await realpath(new URL("../../node_modules/@agent-native/core", import.meta.url));
export const loadCore = name => import(pathToFileURL(path.join(core, "dist", name)).href);
export const [runner, history, approvalStore, resources, frontmatter, threads, runStore, runManager, bus, service,
  surface, mcp, context, database] = await Promise.all([
  "jobs/background-automation-runner.js", "jobs/run-history.js", "agent/tool-approval-store.js",
  "resources/store.js", "jobs/frontmatter.js", "chat-threads/store.js", "agent/run-store.js",
  "agent/run-manager.js", "event-bus/index.js", "automations/service.js", "jobs/unattended-surface.js",
  "mcp-client/index.js", "server/request-context.js", "db/client.js",
].map(loadCore));
export const restoreTimers = () => { globalThis.setTimeout = nativeSetTimeout; };
export const owner = "approval-owner@example.test";
export const appId = "approval-test";
export const actor = { userEmail: owner, appId };
export const mcpName = "mcp__approval_fixture__write";
export const localInput = { action: "write", path: "notes/approval-fixture.md", content: "fixture" };
export const toolInput = { value: "the exact approved input" };
export const until = async check => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, "automation settled within ten seconds");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
export async function makeApprovalCase(name, { existing = false, repeatLocal = true, triggerType = "schedule", resourceOwner = owner } = {}) {
  if (!existing) await service.defineAutomation(actor, { scope: "personal", name, body: "Perform the local step, then the configured step.",
    triggerType, schedule: "0 * * * *", timezone: "UTC", event: "test.event.fired", mcpTools: [mcpName] });
  const resource = await resources.resourceGetByPath(resourceOwner, `jobs/${name}.md`);
  const automation = { name, resource, ...frontmatter.parseJobResource(resource.content) };
  const fixture = { automation, calls: [], modelCalls: [], hidden: false, repeated: false, toolGate: null };
  const raw = { name: "write", description: "Fixture write", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  fixture.manager = {
    config: { servers: { approval_fixture: { type: "http", url: "https://fixture.invalid/original" } } },
    tool: { name: mcpName, source: "approval_fixture", originalName: "write", description: raw.description, inputSchema: raw.inputSchema, raw },
    getConfig() { return this.config; },
    getTools() { return this.tool ? [this.tool] : []; },
    getTool(name) { return this.tool?.name === name ? this.tool : null; },
    async callTool(name, input) {
      fixture.calls.push({ name, input: structuredClone(input) });
      fixture.toolStarted?.();
      if (fixture.toolGate) await fixture.toolGate;
      return { content: [{ type: "text", text: "configured-result" }] };
    },
  };
  const entry = name => ({
    tool: { description: name, parameters: { type: "object", properties: { action: { type: "string" }, path: { type: "string" }, content: { type: "string" } } } },
    run: async (input, ctx) => {
      fixture.calls.push({ name, input: structuredClone(input), runId: ctx.runId, threadId: ctx.threadId, turnId: ctx.turnId, caller: ctx.caller });
      return name === "resources" ? "local-write-result" : `local-${name}`;
    },
  });
  fixture.engine = {
    name: "fake", label: "Approval fixture", defaultModel: "fake-model", supportedModels: ["fake-model"],
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: false },
    async *stream(options) {
      const messages = JSON.stringify(options.messages);
      fixture.modelCalls.push(structuredClone(options.messages));
      assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...surface.UNATTENDED_TOOLS, mcpName].sort());
      let call;
      if (!messages.includes("local-write-result")) call = { name: "resources", id: "local-first", input: localInput };
      else if (!messages.includes("configured-result")) call = { name: mcpName, id: "configured-first", input: toolInput };
      else if (repeatLocal && !fixture.repeated) {
        fixture.repeated = true;
        call = { name: "resources", id: "local-repeat", input: localInput };
      }
      if (call) {
        yield { type: "assistant-content", parts: [{ type: "tool-call", ...call }] };
        yield { type: "stop", reason: "tool_use" };
      } else {
        yield { type: "assistant-content", parts: [{ type: "text", text: "Automation complete." }] };
        yield { type: "stop", reason: "end_turn" };
      }
    },
  };
  fixture.deps = { appId, engine: fixture.engine, model: "fake-model", getSystemPrompt: async () => "Use only the attached automation tools.",
    getActions: current => surface.restrictActionsForUnattendedRun({
      ...Object.fromEntries(surface.UNATTENDED_TOOLS.map(name => [name, entry(name)])),
      ...mcp.mcpToolsToActionEntries(fixture.manager, { resolveActionEntry: () => fixture.hidden ? { agentTool: false } : {} }),
    }, current, { mcpManager: fixture.manager }),
  };
  fixture.options = { automation, ownerEmail: owner, prompt: "Perform the automation steps.", threadTitle: `Automation: ${name}`,
    runIdPrefix: name, usageLabel: `approval:${name}`, actionCaller: "automation", advanceSchedule: false };
  fixture.start = () => runner.runBackgroundAutomation(fixture.options, fixture.deps);
  fixture.pending = async id => (await history.getAutomationContinuation(id)).context;
  fixture.decide = (id, pending, decision = "approve", who = actor) => runner.decideAutomationApproval({ historyId: id, askId: pending.askId, decision }, who, fixture.deps);
  fixture.terminal = id => until(async () => { const run = await history.getAutomationRun(id); return run.finishedAt ? run : null; });
  return fixture;
}

// Exercise the real async actionEntry predicate, with Native execution and
// Stop owners unchanged. Child isolation keeps shutdown process-local.
export async function runApprovalPredicateStopCase(reason, name) {
  const shutdown = reason === "shutdown";
  const fixture = await makeApprovalCase(name, { repeatLocal: false, triggerType: shutdown ? "webhook" : "schedule" });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let barrierHit = 0, selectedStorageFaults = 0;
  const actions = fixture.deps.getActions;
  fixture.deps.getActions = async automation => {
    const registry = await actions(automation);
    assert.equal(registry[mcpName].allowPersistentApproval, false);
    return { ...registry, [mcpName]: { ...registry[mcpName], needsApproval: async input => {
      assert.deepEqual(input, toolInput);
      barrierHit++;
      await gate;
      return true;
    } } };
  };
  const db = database.getDbExec(), execute = db.execute.bind(db);
  db.execute = async statement => {
    const sql = String(statement.sql ?? statement).replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO agent_tool_approvals") ||
        sql.startsWith("UPDATE automation_runs SET status = 'waiting_approval'") ||
        sql.startsWith("UPDATE integration_pending_tasks SET status = 'waiting_approval'")) {
      selectedStorageFaults++;
      throw new Error("Stop control must not reach approval persistence.");
    }
    return execute(statement);
  };
  let tasks, work, taskId;
  try {
    if (shutdown) {
      tasks = await loadCore("integrations/pending-tasks-store.js");
      const dispatcher = await loadCore("triggers/dispatcher.js");
      const webhook = await loadCore("integrations/automation-webhook-task.js");
      await dispatcher.initTriggerDispatcher(fixture.deps);
      const resource = fixture.automation.resource;
      taskId = `predicate-stop-${name}`;
      await tasks.insertPendingTask({ id: taskId, platform: "automation-webhook", externalThreadId: `${owner}:${resource.path}`,
        ownerEmail: owner, orgId: null, externalEventKey: taskId, payload: JSON.stringify({ kind: "automation-webhook",
          automationId: resource.id, owner, path: resource.path, eventId: taskId, payload: {} }) });
      work = webhook.runAutomationWebhookTaskInProcess(taskId, { appId }).then(result => ({ result }), error => ({ error }));
    } else work = fixture.start().then(result => ({ result }), error => ({ error }));
    await until(() => barrierHit === 1);
    const [running] = await history.listAutomationRuns({ owners: [owner], automation: name, appId });
    assert.equal(runManager.getRun(running.runId).status, "running");
    let stopping;
    if (shutdown) stopping = runner.interruptBackgroundAutomations(new Promise(() => {}));
    else {
      await runManager.abortTurnDurably(running.runId, "user");
      await runManager.abortRunDurably(running.runId, "user");
    }
    release(); // Release before awaiting drain, since the drain waits for this call.
    const settled = await work;
    if (stopping) await stopping;
    const run = await fixture.terminal(running.id);
    const expectedCode = shutdown ? history.INTERRUPTED_RUN_ERROR_CODE : "background_automation_aborted";
    assert.equal(run.status, shutdown ? "interrupted" : "error");
    assert.equal(run.errorCode, expectedCode);
    assert.notEqual(run.errorCode, "automation_approval_storage_failed");
    assert.equal(barrierHit, 1); assert.equal(selectedStorageFaults, 0);
    const state = await history.getAutomationContinuation(run.id);
    assert.equal(state.context, null); assert.equal(run.pendingAskId, null);
    const { rows } = await execute({ sql: "SELECT abort_reason FROM agent_runs WHERE id = ?", args: [run.runId] });
    assert.equal(rows[0].abort_reason, shutdown ? "shutdown" : "user");
    const configuredEffects = fixture.calls.filter(call => call.name === mcpName).length;
    assert.equal(configuredEffects, 0);
    const task = shutdown ? await tasks.getPendingTask(taskId) : null;
    if (shutdown) {
      assert.equal(settled.result, "retry"); assert.equal(task.status, "pending"); assert.equal(task.attempts, 0);
      assert.equal(JSON.parse(task.payload).eventId, taskId);
    } else assert.equal(settled.error?.errorCode, expectedCode);
    return { barrierHit, selectedStorageFaults, configuredEffects, historyStatus: run.status,
      errorCode: run.errorCode, abortReason: rows[0].abort_reason, workerResult: settled.result ?? null,
      taskStatus: task?.status ?? null, taskAttempts: task?.attempts ?? null };
  } finally {
    release();
    if (work) await work;
    db.execute = execute;
  }
}
