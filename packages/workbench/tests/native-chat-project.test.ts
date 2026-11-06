import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ActionRunContext } from "@agent-native/core/action";
import { runWithRequestContext, type AgentChatPluginOptions } from "@agent-native/core/server";
import { H3, HTTPError } from "h3";
import { projectChatScopeId } from "../server/chat-project-scope.mjs";
import {
  createVivaryNativeChatActionSurface,
  createVivaryNativeChatContext,
  createVivaryNativeChatProjectGuard,
  createVivaryNativeChatProjectResolver,
  loadNativeProjectContext,
  OWNER_WIDE_ACTIONS,
  prepareVivaryNativeChatProject,
  prepareVivaryNativeChatSend,
  vivaryNativeChatProjectOptions,
} from "../server/native-chat-project";
import { createProjectEvaluate } from "../server/project-evaluate.ts";
import { renderUnavailableContext, type ProjectContextBlock } from "../server/project-memory.ts";
import type { ChatScopeMatch } from "../server/project-services.mjs";

type PrepareDetails = Parameters<
  NonNullable<AgentChatPluginOptions["prepareRequest"]>
>[0];

const ownerEmail = "owner@example.test";
const orgId = "org-a";

function details(): PrepareDetails {
  return {
    event: {},
    ownerEmail,
    message: "Continue.",
    attachments: [],
    references: [],
    mode: "act",
  };
}

// Project services classify the request's scope. The guard only acts on the
// classification, so these tests hand it one and count workspace reads.
function guardFor(
  match: ChatScopeMatch | Error,
  resolveProjectWorkspace: (context: ActionRunContext, projectId: string) => Promise<unknown> = async () => ({}),
) {
  const asked: ActionRunContext[] = [];
  const guard = createVivaryNativeChatProjectGuard({
    getOrgId: () => orgId,
    matchChatProject: async context => {
      asked.push(context);
      if (match instanceof Error) throw match;
      return match;
    },
    resolveProjectWorkspace,
  });
  return { guard, asked };
}

test("a chat outside any project, and Personal, pass without a workspace read", async () => {
  for (const match of [{ kind: "not-project" }, { kind: "personal" }] satisfies ChatScopeMatch[]) {
    let workspaceReads = 0;
    const { guard } = guardFor(match, async () => { workspaceReads += 1; return {}; });
    await guard(details());
    assert.equal(workspaceReads, 0, match.kind);
  }
});

test("a project chat reopens its workspace with the context project services returned", async () => {
  const projectContext: ActionRunContext = { caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" };
  let resolved: [ActionRunContext, string] | null = null;
  const { guard, asked } = guardFor({ kind: "project", projectId: "project-a", context: projectContext },
    async (context, projectId) => { resolved = [context, projectId]; return {}; });
  await guard({ ...details(), ownerEmail: " OWNER@example.test " });
  assert.deepEqual(asked, [{ caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" }]);
  assert.deepEqual(resolved, [projectContext, "project-a"]);
});

// h3 answers 500 for any thrown value that is not its own HTTPError.
const httpError = (statusCode: number, statusMessage: string) => (error: unknown) =>
  HTTPError.isError(error) && error.statusCode === statusCode && error.statusMessage === statusMessage;
// Issue #91. A refused send is a final error Core's chat client shows as written.
const refusedSend = (message: string) => (error: unknown) =>
  HTTPError.isError(error) && error.status === 422 && error.message === message
  && isDeepStrictEqual(error.body, { error: message, errorCode: "vivary_project_conversation_refused", retryable: false });

test("a refused classification stops before any workspace read", async () => {
  const refused = Object.assign(new Error("refused"), { statusCode: 403 });
  const unready = Object.assign(new Error("starting"), { statusCode: 503 });
  const signedOut = Object.assign(new Error("Authentication required"), { statusCode: 401 });
  let workspaceReads = 0;
  const count = async () => { workspaceReads += 1; return {}; };
  await assert.rejects(guardFor(refused, count).guard(details()), refusedSend("refused"));
  await assert.rejects(guardFor(unready, count).guard(details()), httpError(503, "starting"));
  await assert.rejects(guardFor(signedOut, count).guard(details()), httpError(401, "Authentication required"));
  await assert.rejects(guardFor(new Error("catalog"), count).guard(details()),
    refusedSend("Project conversation access is unavailable."));
  assert.equal(workspaceReads, 0);
});

test("fails closed when project access is revoked or its folder is missing", async () => {
  const project: ChatScopeMatch = { kind: "project", projectId: "project-a",
    context: { caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" } };
  const revoked = Object.assign(new Error("revoked"), { statusCode: 403 });
  await assert.rejects(guardFor(project, async () => { throw revoked; }).guard(details()), refusedSend("revoked"));
  await assert.rejects(guardFor(project, async () => { throw new Error("missing"); }).guard(details()),
    refusedSend("This project folder is unavailable. Reconnect it from Projects."));
});

test("a Native tool call gets a refusal with its own error code", async () => {
  const refused = Object.assign(new Error("Local project access is unavailable."), { statusCode: 403 });
  const resolve = createVivaryNativeChatProjectResolver({ getOrgId: () => orgId,
    matchChatProject: async () => { throw refused; }, resolveProjectWorkspace: async () => ({}) });
  await assert.rejects(resolve({ caller: "tool", userEmail: ownerEmail, orgId, appId: "workbench" }),
    { errorCode: "vivary_project_read_access", statusCode: 403, message: "Local project access is unavailable." });
});

test("a refusal reaches the client as a final error, not a server error", async () => {
  const refused = Object.assign(new Error("Project conversation access is unavailable."), { statusCode: 403 });
  const { guard } = guardFor(refused);
  const app = new H3().post("/", async () => { await guard(details()); return "sent"; });
  const response = await app.fetch(new Request("http://local/", { method: "POST" }));
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.error, "Project conversation access is unavailable.");
  assert.equal(body.errorCode, "vivary_project_conversation_refused");
  assert.equal(body.retryable, false);
  assert.equal(body.unhandled, undefined);
});

// Core's chat client, as the browser runs it. Core's package entries do not export the adapter, so the test loads the
// installed module by path, as the replay-id tests do.
const coreClientDir = path.dirname(fileURLToPath(import.meta.resolve("@agent-native/core/client")));
const { createAgentChatAdapter } = await import(pathToFileURL(path.join(coreClientDir, "agent-chat-adapter.js")).href);

/** What the chat shows when the guard refuses a send, and how many times the client posted it. */
async function shownForRefusedSend(t: TestContext, guard: ReturnType<typeof guardFor>["guard"]) {
  let sends = 0;
  const app = new H3()
    .post("/_agent-native/agent-chat", async () => { sends += 1; await guard(details()); return "sent"; });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) =>
    app.fetch(new Request(new URL(input instanceof Request ? input.url : input, "http://local"),
      { method: init.method ?? "GET", body: init.body, headers: init.headers })));
  const adapter = createAgentChatAdapter({ apiUrl: "http://local/_agent-native/agent-chat" });
  let last: { content: { text?: string }[] } | undefined;
  for await (const update of adapter.run({ messages: [{ id: "user-1", role: "user", content: [{ type: "text", text: "Hi" }] }],
    abortSignal: new AbortController().signal })) last = update;
  return { shown: last?.content.map(part => part.text), sends };
}

test("the chat shows a refusal's own sentence once, not a sign-in prompt or a server error", async t => {
  const project: ChatScopeMatch = { kind: "project", projectId: "project-a",
    context: { caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" } };
  const refused = Object.assign(new Error("Project conversation access is unavailable."), { statusCode: 403 });
  assert.deepEqual(await shownForRefusedSend(t, guardFor(refused).guard),
    { shown: ["Something went wrong: Project conversation access is unavailable."], sends: 1 });
  assert.deepEqual(await shownForRefusedSend(t, guardFor(project, async () => { throw new Error("missing"); }).guard),
    { shown: ["Something went wrong: This project folder is unavailable. Reconnect it from Projects."], sends: 1 });
});

test("a lost session still asks the owner to sign in again", async t => {
  const signedOut = Object.assign(new Error("Authentication required"), { statusCode: 401 });
  const { shown } = await shownForRefusedSend(t, guardFor(signedOut).guard);
  assert.deepEqual(shown, ["Error: Authentication required. Sign in again to use chat."]);
});

test("uses Native's parsed scope after its HTTP body has been consumed", async () => {
  let bodyReads = 0;
  const event = { get req() { bodyReads += 1; throw new Error("The request body was already consumed."); } };
  const personal = { type: "workspace-app" as const, id: projectChatScopeId(ownerEmail, orgId, null) };
  await runWithRequestContext({ userEmail: ownerEmail, orgId, run: { chatScope: personal } },
    () => prepareVivaryNativeChatProject({ ...details(), event }));
  assert.equal(bodyReads, 0);
});

// Project context and the tool surface reuse the guard's scope classification.
function contextFor(match: ChatScopeMatch | Error,
  loadProjectContext: (context: ActionRunContext, projectId: string) => Promise<ProjectContextBlock>) {
  return createVivaryNativeChatContext({
    getOrgId: () => orgId,
    matchChatProject: async () => { if (match instanceof Error) throw match; return match; },
    loadProjectContext,
  });
}
const projectMatch: ChatScopeMatch = { kind: "project", projectId: "project-a",
  context: { caller: "http", userEmail: ownerEmail, orgId, appId: "workbench" } };

test("the Full chat block is unavailable when the binding changed during the load", async () => {
  const block = renderUnavailableContext("Relay", "Fixture block.", "full-chat");
  const recorded: string[] = [];
  const workspace = { root: "/project", label: "Relay", projectId: "project-a", bindingId: "binding-a",
    rootId: "root-a", bindingRevision: 1, policyRevision: 1 };
  const memory = {
    renderForRun: async () => ({ block, revision: "ctx-000000000000", summary: "", factCount: 0 }),
    recordLoad: (_workspace: unknown, load: { revision: string }) => { recorded.push(load.revision); },
  };
  const context = { userEmail: ownerEmail, orgId } as ActionRunContext;
  assert.equal(await loadNativeProjectContext(context, "project-a",
    { resolve: async () => workspace as never, memory: memory as never }), block);
  assert.deepEqual(recorded, ["ctx-000000000000"]);
  let revision = 1;
  const changed = await loadNativeProjectContext(context, "project-a",
    { resolve: async () => ({ ...workspace, policyRevision: ++revision }) as never, memory: memory as never });
  assert.match(changed, /The project changed while its context was loaded\./);
  assert.deepEqual(recorded, ["ctx-000000000000"]);
});

test("extraContext returns the pinned project's block", async () => {
  const block = renderUnavailableContext("Relay", "Fixture block.", "full-chat");
  let loaded: [ActionRunContext, string] | null = null;
  const extraContext = contextFor(projectMatch, async (context, projectId) => { loaded = [context, projectId]; return block; });
  assert.equal(await extraContext({}, ownerEmail), block);
  assert.deepEqual(loaded, [projectMatch.context, "project-a"]);
});

test("extraContext returns null for Personal and non-project chats", async () => {
  for (const match of [{ kind: "not-project" }, { kind: "personal" }] satisfies ChatScopeMatch[]) {
    let loads = 0;
    const extraContext = contextFor(match, async () => { loads += 1; return renderUnavailableContext(null, "x", "full-chat"); });
    assert.equal(await extraContext({}, ownerEmail), null, match.kind);
    assert.equal(loads, 0);
  }
});

test("extraContext renders unavailable when access is revoked after the guard", async () => {
  const revoked = Object.assign(new Error("Local project access is unavailable."), { statusCode: 403 });
  const afterGuard = await contextFor(projectMatch, async () => { throw revoked; })({}, ownerEmail);
  assert.match(String(afterGuard), /could not load this project's instructions, state, or facts: Local project access is unavailable\./);
  const unclassified = await contextFor(new Error("/home/owner/private path"), async () => { throw new Error("unused"); })({}, ownerEmail);
  assert.match(String(unclassified), /The project folder could not be read\./);
  assert.doesNotMatch(String(unclassified), /private path/);
});

test("resolveActionSurface removes owner-wide actions only in project chats", async () => {
  const available = ["vivary-project-read", "vivary-project-evaluate", "resources", "save-memory", "delete-memory",
    "chat-history", "web-request"];
  const surface = (match: ChatScopeMatch | Error) => createVivaryNativeChatActionSurface({
    getOrgId: () => orgId,
    matchChatProject: async () => { if (match instanceof Error) throw match; return match; },
  })({ event: {}, ownerEmail, orgId, mode: "act", internalContinuation: false, availableActionNames: available });
  const projectTools = ["vivary-project-read", "vivary-project-evaluate", "web-request"];
  assert.deepEqual(await surface(projectMatch), { allowedActionNames: projectTools });
  assert.deepEqual(await surface({ kind: "personal" }), { mode: "default" });
  assert.deepEqual(await surface({ kind: "not-project" }), { mode: "default" });
  assert.deepEqual(await surface(new Error("catalog")), { allowedActionNames: projectTools });
});

test("a request-scoped surface changes only trusted code execution, which Full chat does not use", async () => {
  const core = new URL("./agent-chat-plugin.js", import.meta.resolve("@agent-native/core/server"));
  assert.match(await readFile(core, "utf8"), /return hasRequestScopedSurface && mode === "trusted" \? "sandboxed" : mode;/);
  const plugin = await readFile(new URL("../server/plugins/agent-chat.ts", import.meta.url), "utf8");
  assert.doesNotMatch(plugin, /codeExecution/);
  assert.equal("codeExecution" in vivaryNativeChatProjectOptions, false);
});

// The framework action names Native registers, read from its installed source,
// and the database tools its database entry builder can add.
async function nativeFrameworkActions(): Promise<{ registered: Set<string>; database: Set<string> }> {
  const entries = new URL("./agent-chat/script-entries.js", import.meta.resolve("@agent-native/core/server"));
  const source = await readFile(entries, "utf8");
  // The maintained Core patch wraps some entries as refuseForAutomationCaller("<name>", wrapCliScript(...)).
  const registered = new Set([...source.matchAll(/^ {12}(?:"([a-z-]+)"|([a-z]+)): (?:wrapCliScript\(|\{|refuseForAutomationCaller\("[a-z-]+", wrapCliScript\()/gm)]
    .map(match => match[1] ?? match[2]));
  const builder = source.slice(source.indexOf("export async function createDbScriptEntries"),
    source.indexOf("export async function createDocsScriptEntries"));
  const database = new Set([...builder.matchAll(/(?:^ {12}"|entries\[")(db-[a-z-]+)"/gm)].map(match => match[1]));
  for (const name of database) registered.add(name);
  return { registered, database };
}

test("owner-wide action names match Native's resource, chat, and database entries", async () => {
  const { registered, database } = await nativeFrameworkActions();
  assert.deepEqual([...database].sort(), ["db-exec", "db-patch", "db-query", "db-schema"]);
  for (const name of OWNER_WIDE_ACTIONS) assert.ok(registered.has(name), name);
  for (const name of database) assert.ok(OWNER_WIDE_ACTIONS.some(denied => denied === name), name);
});

test("a project chat's resolved surface keeps no owner-wide or database tool Native registers", async () => {
  const { registered } = await nativeFrameworkActions();
  const available = ["vivary-project-read", "vivary-project-evaluate", ...registered];
  const resolve = (match: ChatScopeMatch) => createVivaryNativeChatActionSurface({
    getOrgId: () => orgId, matchChatProject: async () => match,
  })({ event: {}, ownerEmail, orgId, mode: "act", internalContinuation: false, availableActionNames: available });
  const project = await resolve(projectMatch);
  assert.ok("allowedActionNames" in project);
  if (!("allowedActionNames" in project)) return;
  for (const name of ["resources", "save-memory", "delete-memory", "chat-history", "db-schema", "db-query", "db-exec", "db-patch"]) {
    assert.equal(project.allowedActionNames.includes(name), false, name);
  }
  assert.ok(project.allowedActionNames.includes("vivary-project-read"));
  assert.ok(project.allowedActionNames.includes("vivary-project-evaluate"));
  assert.deepEqual(await resolve({ kind: "personal" }), { mode: "default" });
});

test("a governed evaluation takes its project from the chat scope, never from its input", async () => {
  const runs: { projectId: string; caller: string | undefined }[] = [];
  const resolve = (match: ChatScopeMatch) => createVivaryNativeChatProjectResolver({ getOrgId: () => orgId,
    matchChatProject: async () => match, resolveProjectWorkspace: async () => { throw new Error("The runner resolves the workspace."); } });
  const evaluations = (match: ChatScopeMatch) => createProjectEvaluate({ chatProject: resolve(match),
    run: async (projectId, _command, context) => {
      runs.push({ projectId, caller: context?.caller });
      return { project: { id: projectId, label: "Project B" }, failure: "vivary_original_queue_timeout" };
    } });
  const tool: ActionRunContext = { caller: "tool", userEmail: ownerEmail, orgId, appId: "workbench" };
  const input = { operation: "expire_leases", state: { claims: [] } };
  const result = await evaluations({ kind: "project", projectId: "project-b", context: tool }).forChat(tool, input);
  assert.ok(result.status === "unavailable" && result.project.id === "project-b");
  assert.deepEqual(runs, [{ projectId: "project-b", caller: "tool" }]);
  assert.deepEqual(await evaluations({ kind: "project", projectId: "project-b", context: tool }).forChat(tool, { ...input, projectId: "project-a" }),
    { status: "refused", project: null, operation: "expire_leases", reason: "server_owned_field", field: "projectId",
      message: "Vivary sets projectId itself. Remove projectId and try again." });
  for (const match of [{ kind: "personal" }, { kind: "not-project" }] as const) {
    await assert.rejects(evaluations(match).forChat(tool, input), /Open this chat from a project to use project tools/);
  }
  assert.equal(runs.length, 1);
});

test("the Native chat plugin uses the project guard, context, and action surface", async () => {
  assert.equal(vivaryNativeChatProjectOptions.prepareRequest, prepareVivaryNativeChatSend);
  assert.equal(typeof vivaryNativeChatProjectOptions.extraContext, "function");
  assert.equal(typeof vivaryNativeChatProjectOptions.resolveActionSurface, "function");
  // The plugin module imports the generated action registry, so its wiring is read as source.
  const plugin = await readFile(new URL("../server/plugins/agent-chat.ts", import.meta.url), "utf8");
  assert.match(plugin, /\.\.\.vivaryNativeChatProjectOptions,/);
});
