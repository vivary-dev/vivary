import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-desktop-oauth-"));
const resource = "http://127.0.0.1:47231/mcp";
const issuer = "http://127.0.0.1:47232";
const owner = "oauth-owner@example.test";
Object.assign(process.env, {
  NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: `file:${root}/oauth.sqlite`,
  DATABASE_URL_UNPOOLED: `file:${root}/oauth.sqlite`, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  WORKSPACE_OAUTH_ORIGIN: "http://127.0.0.1:47230",
  AGENT_NATIVE_MCP_OAUTH_PRIVATE_ORIGINS: [new URL(resource).origin, issuer].join(","),
});
const core = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = name => import(pathToFileURL(path.join(core, "dist", name)).href);
const [{ mountMcpServersRoutes }, remote, oauth, database, { H3, H3Event },
  { VIVARY_NATIVE_MCP_OPTIONS }, { admitBrowserContext }] = await Promise.all([
  load("mcp-client/routes.js"), load("mcp-client/remote-store.js"), load("mcp-client/oauth-client.js"),
  load("db/client.js"), import("h3"), import("../server/native-mcp.ts"), import("../server/browser-request-context.mjs"),
]);
const originalFetch = globalThis.fetch;
let requests = [];
let failRefresh = false;
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.ok([new URL(resource).origin, issuer].includes(url.origin), "no outward transport is permitted");
  const method = request.method;
  const headers = request.headers;
  const body = await request.text();
  requests.push({ path: url.pathname, method, authorization: headers.get("authorization") });
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource, authorization_servers: [issuer] });
  if (url.pathname.startsWith("/.well-known/")) return json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
  });
  if (url.pathname === "/register") return json({ ...JSON.parse(body), client_id: "fixture-client" });
  if (url.pathname === "/token") {
    assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
    if (failRefresh) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    return json({ access_token: "fixture-refreshed", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
  }
  assert.equal(url.pathname, "/mcp");
  if (method === "DELETE") return new Response(null, { status: 200 });
  const message = JSON.parse(body);
  if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
  if (message.method === "server/discover") return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id,
    result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  assert.equal(message.method, "tools/list");
  return json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
};
after(async () => { globalThis.fetch = originalFetch; await database.closeDbExec(); await rm(root, { recursive: true, force: true }); });

function fixture() {
  const handlers = new Map();
  let configured;
  let waits = 0;
  const manager = {
    getStatus: () => ({ connectedServers: Object.keys(configured?.servers ?? {}), configuredServers: [], tools: [], errors: {} }),
    hasServer: id => Boolean(configured?.servers[id]),
    reconfigure: async config => { configured = config; },
  };
  // Capture Native's mounted handlers without bootstrapping unrelated plugins.
  const nitro = { h3: new H3(), hooks: { hook() {} }, _agentNativeH3Shim: { use: (prefix, handler) => handlers.set(prefix, handler) } };
  mountMcpServersRoutes(nitro, manager, {
    waitUntilReady: async () => { waits += 1; },
    oauthAvailability: VIVARY_NATIVE_MCP_OPTIONS.agentChat.mcpOAuthAvailability,
  });
  return {
    configured: () => configured, waits: () => waits,
    async request(route, method = "GET", { desktop = true, headers = {}, body } = {}) {
      const event = new H3Event(new Request(`http://127.0.0.1:47230${route}`, { method, headers: { host: "127.0.0.1:47230", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { host: "127.0.0.1:47230", "content-type": "application/json", ...headers } }) }));
      event.context.__anSessionCache = Promise.resolve({ email: owner });
      if (desktop) admitBrowserContext(event.context, { kind: "desktop" });
      const handler = handlers.get(route.startsWith("/start") ? "/_agent-native/mcp/servers/oauth" : "/_agent-native/mcp/servers");
      const value = await handler(event);
      if (value instanceof Response) return { status: value.status, headers: value.headers,
        body: value.headers.get("content-type")?.includes("application/json") ? await value.json() : null };
      return { status: event.res.status ?? 200, body: value };
    },
  };
}
function bundle(overrides = {}) {
  return { serverUrl: resource, clientInformation: { client_id: "fixture-client", issuer, token_endpoint_auth_method: "none" },
    tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", issuer },
    discoveryState: { authorizationServerUrl: issuer, authorizationServerMetadata: {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["refresh_token"] }, resourceMetadata: { resource, authorization_servers: [issuer] } },
    tokenExpiresAt: Date.now() + 3600_000, ...overrides };
}
let count = 0;
async function saved(credentials) {
  const result = await remote.addOAuthRemoteServer("user", owner, { name: `fixture-${++count}`, url: resource, credentials });
  assert.equal(result.ok, true);
  return result.server;
}
function reset() { requests = []; failRefresh = false; }
const start = `/start?${new URLSearchParams({ name: "fixture", url: resource, scope: "user" })}`;

test("trusted desktop OAuth setup refuses before discovery and registration", async () => {
  reset();
  const app = fixture();
  const response = await app.request(start);
  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "mcp_oauth_interactive_unavailable");
  assert.equal(response.body.retryable, false);
  assert.deepEqual(requests, []);
  assert.equal(app.waits(), 0);
});

test("request headers cannot invent desktop identity and non-desktop setup still starts", async () => {
  reset();
  const response = await fixture().request(start, "GET", { desktop: false,
    headers: { "x-vivary-desktop": "forged", "user-agent": "Electron AgentNativeDesktop/fixture" } });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).origin, issuer);
  assert.equal(requests.filter(r => r.path === "/register").length, 1);
});

test("authenticated lists expose desktop setup availability without hiding saved entries", async () => {
  reset();
  const server = await saved(bundle());
  const app = fixture();
  const desktop = await app.request("/");
  assert.equal(desktop.body.oauth.available, false);
  assert.ok(desktop.body.user.some(item => item.id === server.id));
  const browser = await app.request("/", "GET", { desktop: false });
  assert.equal(browser.body.oauth.available, true);
});

test("a valid saved OAuth grant still passes Test without OAuth discovery", async () => {
  const server = await saved(bundle());
  reset();
  const response = await fixture().request(`/${server.id}/test?scope=user`, "POST");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  assert.ok(requests.some(r => r.path === "/mcp" && r.authorization === "Bearer fixture-access"));
  assert.ok(requests.every(r => r.path === "/mcp"));
});

test("an expired saved grant refreshes once and can still pass Test", async () => {
  const server = await saved(bundle({ tokenExpiresAt: Date.now() - 1000 }));
  reset();
  const response = await fixture().request(`/${server.id}/test?scope=user`, "POST");
  assert.equal(response.body.ok, true);
  assert.equal(requests.filter(r => r.path === "/token").length, 1);
  assert.ok(requests.some(r => r.path === "/mcp" && r.authorization === "Bearer fixture-refreshed"));
  assert.ok(!requests.some(r => r.path === "/register" || r.path === "/authorize"));
});

test("a saved OAuth retry uses the existing manager with its usable grant", async () => {
  const server = await saved(bundle());
  reset();
  const app = fixture();
  const response = await app.request(`/${server.id}/reconnect?scope=user`, "POST");
  assert.equal(response.body.ok, true);
  const config = app.configured().servers[remote.mergedConfigKey("user", server, owner)];
  assert.equal(config.headers.Authorization, "Bearer fixture-access");
  assert.ok(!requests.some(r => r.path === "/register" || r.path === "/authorize"));
});

for (const operation of ["test", "reconnect"]) {
  test(`a failed saved refresh returns a precise ${operation} diagnostic without anonymous fallback`, async () => {
    const server = await saved(bundle({ tokenExpiresAt: Date.now() - 1000 }));
    reset(); failRefresh = true;
    const response = await fixture().request(`/${server.id}/${operation}?scope=user`, "POST");
    assert.equal(response.status, 409);
    assert.equal(response.body.errorCode, "mcp_oauth_reauthorization_unavailable");
    assert.equal(response.body.reauthorizationRequired, true);
    assert.equal(requests.filter(r => r.path === "/token").length, 1);
    assert.ok(!requests.some(r => r.path === "/mcp" || r.path === "/register" || r.path === "/authorize"));
    const kept = (await remote.listRemoteServers("user", owner)).find(item => item.id === server.id);
    assert.equal(kept.oauthSecretKey, server.oauthSecretKey);
  });
}

test("a saved grant needing reauthorization cannot start a desktop sign-in", async () => {
  const server = await saved(bundle());
  reset();
  const response = await fixture().request(`/start?serverId=${server.id}&scope=user`);
  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "mcp_oauth_interactive_unavailable");
  assert.deepEqual(requests, []);
});

for (const headers of [undefined, { Authorization: "Bearer fixture-manual" }]) {
  test(`desktop ${headers ? "header" : "no-auth"} connections retain add, Test and retry`, async () => {
    reset();
    const app = fixture();
    const added = await app.request("/", "POST", { body: { scope: "user", name: `plain-${++count}`, url: resource, headers } });
    assert.equal(added.body.ok, true);
    const id = added.body.server.id;
    assert.equal((await app.request(`/${id}/test?scope=user`, "POST")).body.ok, true);
    assert.equal((await app.request(`/${id}/reconnect?scope=user`, "POST")).body.ok, true);
    assert.ok(!requests.some(r => r.path === "/register" || r.path === "/authorize"));
  });
}
