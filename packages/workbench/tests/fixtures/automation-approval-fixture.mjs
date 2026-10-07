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
export async function makeApprovalCase(name, { existing = false, repeatLocal = true, triggerType = "schedule" } = {}) {
  if (!existing) await service.defineAutomation(actor, { scope: "personal", name, body: "Perform the local step, then the configured step.",
    triggerType, schedule: "0 * * * *", timezone: "UTC", event: "test.event.fired", mcpTools: [mcpName] });
  const resource = await resources.resourceGetByPath(owner, `jobs/${name}.md`);
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
