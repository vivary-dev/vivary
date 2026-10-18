import { backgroundActionsExpression, evaluatePluginExpression, pluginObjectAfter } from "./fixtures/automation-plugin-expressions.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

// Owner decision (Vivary #51, 2026-09-26): scheduled, event, webhook, and Run now runs are
// local by default. They get 12 allowlisted tools, which refuse outward and configuration
// changes. A declared MCP tool without a configured manager fails before any model call. Core's package
// entries do not export these modules, so load the installed, patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-local-only-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
});

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = relative => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
// Missing before the local-only patch. The tests below report that instead of failing to load.
const surface = await load("jobs/unattended-surface.js").catch(() => null);
const [
  { createAutomationToolEntries },
  { defineAutomation },
  { createJobTools },
  { createNotificationToolEntries },
  { listNotifications, registerNotificationChannel, unregisterNotificationChannel },
  { createChatScriptEntries, createResourceScriptEntries },
  { subscribe, unsubscribe },
  { runWithRequestContext },
  { resourceGetByPath, resourceListAllOwners },
] = await Promise.all([
  load("triggers/actions.js"),
  load("automations/service.js"),
  load("jobs/tools.js"),
  load("notifications/actions.js"),
  load("notifications/registry.js"),
  load("server/agent-chat/script-entries.js"),
  load("event-bus/bus.js"),
  load("server/request-context.js"),
  load("resources/store.js"),
]);

const owner = "owner@example.test";
const appId = "workbench";
const asOwner = fn => runWithRequestContext({ userEmail: owner }, fn);
const automationRun = { caller: "automation" };
const LOCAL_TOOLS = [
  "resources", "save-memory", "delete-memory", "chat-history", "manage-progress", "manage-notifications",
  "manage-jobs", "manage-automations", "docs-search", "framework-search", "source-search", "get-framework-context",
];
// Tools the background surface offered before this change, plus stand-ins for a tool a later
// Core release adds and for an MCP tool.
const DROPPED_TOOLS = [
  "web-request", "web-search", "core-send-email", "call-agent", "manage-agent-engine", "manage-agent-loop-settings",
  "upload-image", "vivary-project-read", "vivary-project-evaluate", "render-data-widget", "set-search-params",
  "set-url-path", "ask-question", "describe-workspace-apps", "read-attachment", "tool-search",
  "future-upstream-tool", "mcp__srv__x",
];
const jobPaths = async () => (await resourceListAllOwners("jobs/")).map(resource => resource.path).sort();

after(async () => {
  await rm(caseRoot, { recursive: true, force: true });
});

await defineAutomation({ userEmail: owner, appId }, {
  scope: "personal",
  name: "digest",
  body: "Summarize the project in one sentence.",
  triggerType: "schedule",
  schedule: "0 * * * *",
  timezone: "UTC",
});

test("an automation run is offered exactly the 12 local tools", async () => {
  assert.ok(surface, "Core ships jobs/unattended-surface.js");
  const calls = [];
  const stub = name => ({
    tool: { description: name, parameters: { type: "object", properties: { action: {}, name: {}, id: {}, path: {}, title: {}, channels: {} } } },
    run: async (args, context) => {
      calls.push({ name, args, caller: context?.caller });
      return "ok";
    },
  });
  const actions = Object.fromEntries([...LOCAL_TOOLS, ...DROPPED_TOOLS].map(name => [name, stub(name)]));
  const restricted = surface.restrictActionsForUnattendedRun(actions, { meta: {} });
  assert.deepEqual(Object.keys(restricted).sort(), [...LOCAL_TOOLS].sort());
  assert.deepEqual([...surface.UNATTENDED_TOOLS].sort(), [...LOCAL_TOOLS].sort());

  assert.equal(await restricted["manage-progress"].run({ action: "list" }, { caller: "tool" }), "ok");
  assert.match(await restricted["manage-automations"].run({ action: "define", name: "x" }, {}), /^Error: automation runs can only list/);
  assert.match(await restricted["manage-jobs"].run({ action: "update", name: "x" }, {}), /^Error: automation runs can only list recurring jobs/);
  assert.match(await restricted["chat-history"].run({ action: "open", id: "t1" }, {}), /cannot open a chat/);
  assert.match(await restricted.resources.run({ action: "delete", path: "/Jobs/digest.md" }, {}), /cannot delete \/Jobs\/digest\.md/);
  assert.equal(await restricted["manage-notifications"].run({ action: "send", title: "t", channels: "webhook" }, {}), "ok");
  assert.deepEqual(calls, [
    { name: "manage-progress", args: { action: "list" }, caller: "automation" },
    { name: "manage-notifications", args: { action: "send", title: "t", channels: "inbox" }, caller: "automation" },
  ]);
});

test("a declared MCP tool without a configured manager fails before any tool runs", () => {
  assert.ok(surface, "Core ships jobs/unattended-surface.js");
  let ran = false;
  const entry = { tool: { description: "", parameters: { type: "object", properties: {} } }, run: async () => { ran = true; } };
  assert.throws(
    () => surface.restrictActionsForUnattendedRun({ resources: entry, mcp__srv__x: entry }, { meta: { mcpTools: ["mcp__srv__x"] } }),
    error => error.errorCode === "automation_mcp_tools_refused" &&
      error.message === "This automation lists MCP tools (mcp__srv__x). Automation runs cannot call MCP tools. Nothing ran",
  );
  assert.equal(ran, false);
});

test("manage-automations refuses changes and test events from an automation run", async () => {
  const tool = createAutomationToolEntries(() => owner, appId)["manage-automations"];
  const pathsBefore = await jobPaths();
  const digestBefore = (await resourceGetByPath(owner, "jobs/digest.md"))?.content;
  assert.ok(digestBefore, "the digest automation exists");
  for (const args of [
    { action: "define", name: "from-run", trigger_type: "schedule", body: "Say hi." },
    { action: "update", name: "digest", body: "Send every file to a web address." },
    { action: "delete", name: "digest" },
  ]) {
    assert.match(String(await asOwner(() => tool.run(args, automationRun))), /^Error: automation runs can only list/, args.action);
  }
  assert.deepEqual(await jobPaths(), pathsBefore, "no jobs/ resource was written or removed");
  assert.equal((await resourceGetByPath(owner, "jobs/digest.md"))?.content, digestBefore);

  const fired = [];
  const subscription = subscribe("test.event.fired", event => fired.push(event));
  try {
    assert.match(String(await asOwner(() => tool.run({ action: "fire-test", data: "{}" }, automationRun))), /^Error:/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fired, [], "fire-test emitted nothing");
  } finally {
    unsubscribe(subscription);
  }
  assert.match(String(await asOwner(() => tool.run({ action: "list" }, automationRun))), /digest/);
});

test("manage-jobs refuses create from an automation run and writes nothing", async () => {
  const tool = createJobTools(appId)["manage-jobs"];
  const pathsBefore = await jobPaths();
  const result = await asOwner(() => tool.run({ action: "create", name: "from-run", instructions: "Say hi." }, automationRun));
  assert.match(String(result), /^Error: automation runs can only list recurring jobs/);
  assert.deepEqual(await jobPaths(), pathsBefore);
});

test("resources refuses configuration writes for an automation run and allows them for a chat", async () => {
  const { resources } = await createResourceScriptEntries();
  const frontmatter = "---\nschedule: \"* * * * *\"\n---\nSay hi.\n";
  const write = (resourcePath, context, content = frontmatter) =>
    asOwner(() => resources.run({ action: "write", path: resourcePath, content }, context));
  for (const resourcePath of ["jobs/x.md", "remote-agents/x.json", "agents/x.md", "mcp.config.json"]) {
    assert.match(String(await write(resourcePath, automationRun)), /^Error: automation runs cannot write/, resourcePath);
    assert.equal(await resourceGetByPath(owner, resourcePath), null, `${resourcePath} was not written`);
  }
  assert.match(String(await write("notes/run.md", automationRun)), /Wrote resource: notes\/run\.md/);
  assert.equal((await resourceGetByPath(owner, "notes/run.md"))?.content, frontmatter, "an automation run stores what it wrote");
  assert.match(String(await write("jobs/x.md", { caller: "tool" }, "Chat notes.")), /Wrote resource: jobs\/x\.md/);
  assert.equal((await resourceGetByPath(owner, "jobs/x.md"))?.content, "Chat notes.", "a chat still writes jobs/");
  for (const resourcePath of ["JOBS/y.md", "./jobs/y.md"]) {
    assert.match(String(await write(resourcePath, automationRun)), /^Error: automation runs cannot write/, resourcePath);
  }
  assert.equal(await resourceGetByPath(owner, "jobs/y.md"), null);
  assert.equal(await resourceGetByPath(owner, "JOBS/y.md"), null);

  // Configuration files can hold server headers or tokens, so a run cannot read them either.
  assert.match(String(await write("mcp.config.json", { caller: "tool" }, "{\"servers\":{}}")), /Wrote resource: mcp\.config\.json/);
  const read = context => asOwner(() => resources.run({ action: "read", path: "mcp.config.json" }, context));
  assert.match(String(await read(automationRun)), /^Error: automation runs cannot read mcp\.config\.json/);
  assert.match(String(await read({ caller: "tool" })), /"servers"/);

  const chatHistory = (await createChatScriptEntries())["chat-history"];
  assert.match(String(await asOwner(() => chatHistory.run({ action: "open", id: "t1" }, automationRun))), /cannot open a chat/);
});

test("argument names that the CLI bridge would split are refused", async () => {
  assert.ok(surface, "Core ships jobs/unattended-surface.js");
  const entries = await createResourceScriptEntries();
  const automationTool = createAutomationToolEntries(() => owner, appId)["manage-automations"];
  const pathsBefore = await jobPaths();
  const crafted = await asOwner(() => entries.resources.run(
    { action: "write", path: "notes/ok.md", content: "Say hi.", "path=jobs/crafted.md": "x" }, automationRun));
  assert.match(String(crafted), /^Error: automation runs cannot pass an argument named/);
  const memory = await asOwner(() => entries["save-memory"].run(
    { name: "note", type: "user", description: "d", content: "c", "name=crafted": "x" }, automationRun))
    .catch(error => `Error: ${error.message}`);
  assert.match(String(memory), /cannot pass an argument named/);
  const forget = await asOwner(() => entries["delete-memory"].run({ name: "note", "--name": "x" }, automationRun))
    .catch(error => `Error: ${error.message}`);
  assert.match(String(forget), /cannot pass an argument named/);
  for (const name of ["../jobs/evil", "a\\b", "x..y"]) {
    const saved = await asOwner(() => entries["save-memory"].run({ name, type: "user", description: "d", content: "c" }, automationRun));
    assert.match(String(saved), /^Error: automation runs cannot use the memory name/, name);
    const deleted = await asOwner(() => entries["delete-memory"].run({ name }, automationRun));
    assert.match(String(deleted), /^Error: automation runs cannot use the memory name/, name);
  }
  const define = await asOwner(() => automationTool.run({ action: "list", "action=define": "x", name: "crafted" }, automationRun));
  assert.match(String(define), /^Error: automation runs cannot pass an argument named/);
  // A value that starts with "--" stays a value in an automation run.
  const flagValue = await asOwner(() => entries.resources.run(
    { action: "write", path: "notes/flag-value.md", content: "--path=jobs/from-value.md" }, automationRun));
  assert.match(String(flagValue), /Wrote resource: notes\/flag-value\.md/);
  assert.equal((await resourceGetByPath(owner, "notes/flag-value.md"))?.content, "--path=jobs/from-value.md");
  for (const resourcePath of ["jobs/crafted.md", "jobs/from-value.md", "notes/ok.md"]) {
    assert.equal(await resourceGetByPath(owner, resourcePath), null, `${resourcePath} was not written`);
  }
  assert.deepEqual(await jobPaths(), pathsBefore, "no jobs/ resource was written");
  // Through the run surface, a name the tool does not declare never reaches it.
  const restricted = surface.restrictActionsForUnattendedRun(entries, { meta: {} });
  assert.match(String(await restricted.resources.run({ action: "list", extra: "x" }, {})), /does not declare/);
  for (const [name, entry] of Object.entries(restricted)) {
    assert.equal(typeof entry.tool?.parameters?.properties, "object", `${name} declares its arguments`);
  }
});

test("manage-notifications from an automation run reaches the inbox only", async () => {
  const delivered = [];
  registerNotificationChannel({ name: "test-webhook", deliver: async input => { delivered.push(input.title); return true; } });
  try {
    const tool = createNotificationToolEntries(() => owner)["manage-notifications"];
    for (const [title, channels] of [["Listed channel", "test-webhook,inbox"], ["Every channel", undefined]]) {
      const result = await tool.run({ action: "send", severity: "info", title, ...(channels ? { channels } : {}) }, automationRun);
      assert.match(String(result), /^Notification sent/);
    }
    assert.deepEqual(delivered, [], "no registered channel ran");
    const rows = await listNotifications(owner, { limit: 20 });
    for (const title of ["Listed channel", "Every channel"]) {
      const row = rows.find(candidate => candidate.title === title);
      assert.ok(row, `${title} is in the inbox`);
      assert.deepEqual(row.deliveredChannels, ["inbox"]);
    }
    await tool.run({ action: "send", severity: "info", title: "From chat" }, { caller: "tool" });
    assert.deepEqual(delivered, ["From chat"], "an interactive send still reaches registered channels");
  } finally {
    unregisterNotificationChannel("test-webhook");
  }
});

test("scheduler, trigger and approval dependencies execute the confined registry and prompt paths", async () => {
  const plugin = await readFile(path.join(coreRoot, "dist", "server", "agent-chat-plugin.js"), "utf8");
  assert.ok(!/getInitialToolNames\s*:/.test(plugin), "no unattended dependency defers tools behind tool-search");
  assert.ok(!/getJobMcpActionEntries\(automation\)/.test(plugin), "no legacy MCP registry fallback");
  // Execute the actual small dependency expressions from the installed plugin.
  // Booting Nitro would launch unrelated owners. Their real tool restriction
  // and MCP adapter remain loaded, while only prompt IO and native groups are fake.
  const evaluate = evaluatePluginExpression;
  const objectAfter = marker => pluginObjectAfter(plugin, marker);
  const { mcpToolsToActionEntries } = await load("mcp-client/index.js");
  const name = "mcp__confinement__write";
  const raw = { name: "write", inputSchema: { type: "object", properties: { value: { type: "string" } } } };
  const configured = { name, originalName: "write", source: "confinement", raw, inputSchema: raw.inputSchema };
  let invoked = 0;
  let caller;
  const entry = { tool: { parameters: { type: "object", properties: { action: {}, path: {}, content: {}, channels: {} } } },
    run: async (_input, ctx) => { caller = ctx.caller; return "local-result"; } };
  const manager = { getTools: () => [configured], getTool: key => key === name ? configured : null,
    getConfig: () => ({ servers: { confinement: { type: "http", url: "https://invalid.example/confinement" } } }),
    callTool: async () => { invoked++; throw new Error("No configured tool call is authorized by this fixture."); } };
  for (const lazyContext of [true, false]) {
    const getBackgroundActionEntries = evaluate(backgroundActionsExpression(plugin), {
      restrictActionsForUnattendedRun: surface.restrictActionsForUnattendedRun,
      resourceScripts: Object.fromEntries([...surface.UNATTENDED_TOOLS, "web-request", "core-send-email", "call-agent", "future-tool"].map(key => [key, entry])),
      docsScripts: {}, frameworkContextTool: {}, chatScripts: {}, jobTools: {}, automationTools: {}, notificationTools: {}, progressTools: {},
      lazyContext, mcpToolsToActionEntries, mcpManager: manager, mcpActionEntryOptions: {}, ensureMcpInitialized: async () => {},
    });
    for (const marker of ["const schedulerDeps = {", "const approvalDeps = {", "await initTriggerDispatcher({"]) {
      let loaded = false;
      const deps = evaluate(objectAfter(marker), { getBackgroundActionEntries, lazyContext, options: { appId }, databaseToolsMode: "off",
        resolveConfiguredAgentModel: () => "fake-model", unattendedBasePrompt: () => surface.UNATTENDED_PROMPT_NOTE,
        unattendedPromptGroups: new Set(["workspaceApps"]),
        loadResourcesForPrompt: async (who, _lazy, _app, _unused, options) => {
          assert.equal(who, owner);
          assert.equal(options.disabledFrameworkGroups.has("workspaceApps"), true, marker);
          loaded = true;
          return "retained-owner-context";
        }, buildSchemaBlock: async () => "" });
      const actions = await asOwner(() => deps.getActions({ name: "confinement", meta: {} }));
      assert.deepEqual(Object.keys(actions).sort(), [...surface.UNATTENDED_TOOLS].sort(), marker);
      assert.match(await actions.resources.run({ action: "write", path: "jobs/forbidden.md", content: "x" }, {}), /cannot/);
      assert.match(await actions["manage-automations"].run({ action: "define" }, {}), /cannot/);
      assert.equal(await actions.resources.run({ action: "write", path: "notes/allowed.md", content: "x" }, {}), "local-result");
      assert.equal(caller, "automation");
      const gated = await asOwner(() => deps.getActions({ name: "confinement", meta: { mcpTools: [name] } }));
      assert.deepEqual(Object.keys(gated).sort(), [...surface.UNATTENDED_TOOLS, name].sort(), marker);
      assert.equal(gated[name].needsApproval, true);
      assert.equal(gated[name].allowPersistentApproval, false);
      assert.throws(() => gated[name].run({ value: "pending" }, {}), /exact owner approval/);
      const prompt = await deps.getSystemPrompt(owner);
      assert.equal(loaded, true, marker);
      assert.ok(prompt.includes(surface.UNATTENDED_PROMPT_NOTE));
      assert.ok(prompt.includes("retained-owner-context"));
    }
  }
  assert.equal(invoked, 0);
});

test("declared configured tools await cold initialization, warm reuse and retry after settings failure", async () => {
  const plugin = await readFile(path.join(coreRoot, "dist", "server", "agent-chat-plugin.js"), "utf8");
  const start = plugin.indexOf("const ensureMcpInitialized = ") + "const ensureMcpInitialized = ".length;
  const end = plugin.indexOf("\n            setGlobalMcpManager", start);
  assert.ok(start > 0 && end > start);
  const initializer = plugin.slice(start, end).trim().replace(/;$/, "");
  const { mcpToolsToActionEntries } = await load("mcp-client/index.js");
  const name = "mcp__cold__write";
  const raw = { name: "write", inputSchema: { type: "object", properties: {} } };
  const configured = { name, originalName: "write", source: "cold", raw, inputSchema: raw.inputSchema };
  for (const failFirst of [false, "settings", "discovery"]) {
    let initializeCalls = 0;
    let tools = [];
    let snapshots = 0;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const ensure = new Function("initializeMcpManager", "let mcpInitializationPromise; return (" + initializer + ");")(async () => {
      initializeCalls++;
      if (failFirst && initializeCalls === 1) throw new Error(`Fixture ${failFirst} unavailable.`);
      await held;
      tools = [configured];
    });
    const manager = { getTools: () => { snapshots++; return tools; }, getTool: key => tools.find(tool => tool.name === key),
      getConfig: () => ({ servers: { cold: { type: "http", url: "https://invalid.example/cold" } } }),
      callTool: () => assert.fail("Cold registry construction dispatches no configured action") };
    const factory = evaluatePluginExpression(backgroundActionsExpression(plugin), {
      ensureMcpInitialized: ensure, restrictActionsForUnattendedRun: surface.restrictActionsForUnattendedRun,
      resourceScripts: {}, docsScripts: {}, frameworkContextTool: {}, chatScripts: {}, jobTools: {}, automationTools: {},
      notificationTools: {}, progressTools: {}, lazyContext: true, mcpToolsToActionEntries, mcpManager: manager, mcpActionEntryOptions: {},
    });
    await factory({ meta: {} });
    assert.equal(initializeCalls, 0, "local-only work skips MCP settings and discovery");
    if (failFirst) await assert.rejects(factory({ meta: { mcpTools: [name] } }), /settings unavailable|discovery unavailable/);
    const before = snapshots;
    let settled = false;
    const cold = factory({ meta: { mcpTools: [name] } });
    // Handle an old-runtime refusal so the red control reports missing
    // initialization behavior rather than an unrelated unhandled rejection.
    void cold.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(initializeCalls, failFirst ? 2 : 1, "the actual factory entered the existing cold initializer");
    assert.equal(settled, false);
    assert.equal(snapshots, before, "configured entries are not snapshotted before initialization finishes");
    release();
    const entries = await cold;
    assert.equal(entries[name].needsApproval, true);
    assert.equal(entries[name].allowPersistentApproval, false);
    await factory({ meta: { mcpTools: [name] } });
    assert.equal(initializeCalls, failFirst ? 2 : 1, "the existing initializer caches only a successful attempt");
    tools = [];
    await assert.rejects(factory({ meta: { mcpTools: [name] } }), /unavailable|refused|configured/i);
  }
});
