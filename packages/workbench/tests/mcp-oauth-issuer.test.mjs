import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-mcp214-"));
const resource = "http://127.0.0.1:47141/mcp";
const issuer = "http://127.0.0.1:47142";
const otherIssuer = "http://127.0.0.1:47143";
Object.assign(process.env, {
  NODE_ENV: "production", APP_NAME: "Vivary", DATABASE_URL: `file:${root}/oauth.sqlite`,
  DATABASE_URL_UNPOOLED: `file:${root}/oauth.sqlite`, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  HUBSPOT_MCP_CLIENT_ID: "fixture-hubspot-client", HUBSPOT_MCP_CLIENT_SECRET: "fixture-hubspot-secret",
  GOOGLE_CLIENT_ID: "fixture-google-client", GOOGLE_CLIENT_SECRET: "fixture-google-secret",
  AGENT_NATIVE_MCP_OAUTH_PRIVATE_ORIGINS: [new URL(resource).origin, issuer, otherIssuer].join(","),
});
const originalFetch = globalThis.fetch;
let requests = [];
let respond;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.ok([new URL(resource).origin, issuer, otherIssuer, "https://mcp.hubspot.com"].includes(url.origin),
    `the fixture forbids an outward request to ${url.origin}`);
  const request = { url, method: init.method ?? "GET", body: String(init.body ?? "") };
  requests.push(request);
  assert.ok(respond, "the fixture must declare its fake response");
  return respond(request);
};
const core = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const loadCore = name => import(pathToFileURL(path.join(core, "dist", name)).href);
const [oauth, routes, remote, database] = await Promise.all([
  "mcp-client/oauth-client.js", "mcp-client/oauth-routes.js", "mcp-client/remote-store.js", "db/client.js",
].map(loadCore));
after(async () => { globalThis.fetch = originalFetch; await database.closeDbExec(); await rm(root, { recursive: true, force: true }); });
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const identity = key => ({ key, scope: "user", scopeId: "mcp-owner@example.test", serverUrl: resource });
function bundle(overrides = {}) {
  return {
    serverUrl: resource,
    clientInformation: { client_id: "fixture-client", client_secret: "fixture-secret", issuer, token_endpoint_auth_method: "client_secret_post" },
    tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", issuer },
    discoveryState: { authorizationServerUrl: issuer, authorizationServerMetadata: {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"],
    }, resourceMetadata: { resource, authorization_servers: [issuer] } },
    tokenExpiresAt: Date.now() - 1000,
    ...overrides,
  };
}
function begin(response) { requests = []; respond = response; }
async function save(key, credentials) { await oauth.saveMcpOAuthCredentials({ ...identity(key), credentials }); }

test("Native resolves the fixed MCP SDK and one aligned client, core and server set", async () => {
  const require = createRequire(path.join(core, "package.json"));
  for (const [name, entry, version] of [
    ["sdk", "@modelcontextprotocol/sdk/client/index.js", "1.31.0"],
    ["client", "@modelcontextprotocol/client", "2.2.0"],
    ["core", "@modelcontextprotocol/core", "2.2.0"],
    ["server", "@modelcontextprotocol/server", "2.2.0"],
  ]) {
    let directory = path.dirname(require.resolve(entry));
    for (;;) {
      const manifest = await readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => null);
      if (manifest?.name === `@modelcontextprotocol/${name}`) { assert.equal(manifest.version, version); break; }
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, `could not find the resolved ${name} package`);
      directory = parent;
    }
  }
});

test("managed OAuth client credentials carry the issuer from the trusted catalog", async () => {
  begin(() => { throw new Error("managed credential lookup needs no network"); });
  const hubspot = await routes.resolveManagedMcpOAuthClient(new URL("https://mcp.hubspot.com/mcp"));
  assert.equal(hubspot.client_id, "fixture-hubspot-client");
  assert.equal(hubspot.issuer, "https://mcp.hubspot.com");
  for (const origin of ["https://gmailmcp.googleapis.com", "https://workspacemcp.googleapis.com"]) {
    assert.equal((await routes.resolveManagedMcpOAuthClient(new URL(origin))).issuer, "https://accounts.google.com");
  }
  assert.equal(await routes.resolveManagedMcpOAuthClient(new URL(resource)), undefined);
  assert.equal(requests.length, 0);
});

test("the custom SDK provider preserves issuer binding and context-free reads", () => {
  const provider = new oauth.McpOAuthClientProvider({ serverUrl: resource, redirectUrl: `${resource}/callback`, state: "fixture-state" });
  provider.saveClientInformation({ client_id: "fixture-client", issuer }, { issuer });
  provider.saveTokens({ access_token: "fixture-access", token_type: "Bearer", issuer }, { issuer });
  assert.equal(provider.clientInformation().issuer, issuer);
  assert.equal(provider.tokens().issuer, issuer);
  assert.equal(provider.clientInformation({ issuer }).client_id, "fixture-client");
  assert.equal(provider.tokens({ issuer }).access_token, "fixture-access");
  assert.equal(provider.clientInformation({ issuer: otherIssuer }), undefined);
  assert.equal(provider.tokens({ issuer: otherIssuer }), undefined);
  assert.throws(() => provider.saveTokens({ access_token: "wrong", issuer: otherIssuer }, { issuer }), /issuer/);
  assert.throws(() => provider.saveClientInformation({ client_id: "wrong", issuer: otherIssuer }, { issuer }), /issuer/);
});

test("an old PKCE callback binds only its in-flight client to its saved discovery", () => {
  const options = { serverUrl: resource, redirectUrl: `${resource}/callback`, state: "fixture-state",
    clientInformation: { client_id: "fixture-client" }, discoveryState: bundle().discoveryState };
  assert.equal(new oauth.McpOAuthClientProvider(options).clientInformation({ issuer }), undefined);
  assert.equal(new oauth.McpOAuthClientProvider({ ...options, codeVerifier: "fixture-verifier" }).clientInformation({ issuer }).issuer, issuer);
});

const managedFlows = [
  { wrongIssuer: false, registration: false, label: "uses its static client without DCR" },
  { wrongIssuer: true, registration: false, label: "refuses changed issuer without a credential POST" },
  { wrongIssuer: true, registration: true, label: "keeps its static secret out of another issuer's registration" },
];
for (const { wrongIssuer, registration, label } of managedFlows) test(`managed HubSpot PKCE ${label}`, async () => {
  const serverUrl = "https://mcp.hubspot.com/mcp";
  const advertisedIssuer = wrongIssuer ? otherIssuer : "https://mcp.hubspot.com";
  begin(({ url, method, body }) => {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: serverUrl, authorization_servers: [advertisedIssuer] });
    if (url.pathname.startsWith("/.well-known/")) return json({ issuer: advertisedIssuer,
      authorization_endpoint: `${advertisedIssuer}/authorize`, token_endpoint: `${advertisedIssuer}/oauth/v3/token`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"], code_challenge_methods_supported: ["S256"],
      ...(registration ? { registration_endpoint: `${advertisedIssuer}/register` } : {}) });
    if (url.pathname === "/register" && method === "POST") {
      assert.ok(!body.includes("fixture-hubspot-secret"));
      return json({ ...JSON.parse(body), client_id: "fixture-dynamic-client" });
    }
    if (url.pathname === "/oauth/v3/token" && method === "POST") {
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "fixture-hubspot-client");
      assert.equal(form.get("client_secret"), "fixture-hubspot-secret");
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.ok(form.get("code_verifier"));
      return json({ access_token: "hubspot-fixture-access", refresh_token: "hubspot-fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`unexpected fake HubSpot request ${method} ${url.pathname}`);
  });
  const clientInformation = await routes.resolveManagedMcpOAuthClient(new URL(serverUrl));
  const options = { serverUrl, redirectUrl: `${resource}/callback`, state: "fixture-state", clientInformation };
  if (wrongIssuer && registration) {
    const started = await oauth.startMcpOAuthAuthorization(options);
    assert.equal(started.clientInformation.client_id, "fixture-dynamic-client");
    assert.equal(started.clientInformation.issuer, otherIssuer);
    assert.equal(requests.filter(request => request.method === "POST").length, 1);
    assert.ok(requests.every(request => !request.body.includes("fixture-hubspot-secret")));
  } else if (wrongIssuer) {
    await assert.rejects(oauth.startMcpOAuthAuthorization(options));
    assert.equal(requests.filter(request => request.method === "POST").length, 0);
    assert.ok(requests.every(request => !request.body.includes("fixture-hubspot-secret")));
  } else {
    const started = await oauth.startMcpOAuthAuthorization(options);
    assert.equal(started.clientInformation.issuer, advertisedIssuer);
    assert.equal(started.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(started.authorizationUrl.searchParams.get("client_id"), "fixture-hubspot-client");
    assert.ok(!started.authorizationUrl.toString().includes("fixture-hubspot-secret"));
    const { credentials } = await oauth.finishMcpOAuthAuthorization({ ...options, ...started, authorizationCode: "fixture-code", iss: advertisedIssuer });
    assert.equal(credentials.tokens.issuer, advertisedIssuer);
    assert.equal(credentials.clientInformation.issuer, advertisedIssuer);
    assert.equal(requests.filter(request => request.method === "POST").length, 1);
  }
});

test("a matching issuer refreshes and persists rotated credentials", async () => {
  const key = "matching-refresh";
  await save(key, bundle());
  begin(({ url, body }) => {
    assert.equal(url.href, `${issuer}/token`);
    const form = new URLSearchParams(body);
    assert.equal(form.get("refresh_token"), "fixture-refresh");
    assert.equal(form.get("client_secret"), "fixture-secret");
    return json({ access_token: "fixture-rotated-access", refresh_token: "fixture-rotated-refresh", token_type: "Bearer", expires_in: 3600 });
  });
  assert.equal(await oauth.getMcpOAuthAccessToken(identity(key)), "fixture-rotated-access");
  const stored = await oauth.readMcpOAuthCredentials(identity(key));
  assert.equal(stored.tokens.refresh_token, "fixture-rotated-refresh");
  assert.equal(stored.tokens.issuer, issuer);
  assert.equal(requests.length, 1);
});

for (const invalid of ["client", "token", "discovery", "unbound"]) {
  function invalidBundle() {
    const credentials = bundle();
    if (invalid === "client") credentials.clientInformation.issuer = otherIssuer;
    if (invalid === "token") credentials.tokens.issuer = otherIssuer;
    if (invalid === "discovery") delete credentials.discoveryState.authorizationServerMetadata.issuer;
    if (invalid === "unbound") { delete credentials.tokens.issuer; delete credentials.clientInformation.issuer; }
    return credentials;
  }
  test(`${invalid} issuer binding refuses refresh before any request`, async () => {
    const key = `refresh-${invalid}`;
    await save(key, invalidBundle());
    begin(() => { throw new Error("unbound refresh must not send credentials"); });
    assert.equal(await oauth.getMcpOAuthAccessToken(identity(key)), null);
    assert.equal(requests.length, 0);
    assert.equal((await oauth.getMcpOAuthConnectionState(identity(key))).kind, "reconnect_required");
  });
  test(`${invalid} issuer binding skips remote revocation while unlinking locally`, async () => {
    const key = `revoke-${invalid}`;
    await save(key, invalidBundle());
    begin(() => new Response(null, { status: 200 }));
    assert.deepEqual(await oauth.revokeMcpOAuthCredentials(identity(key)), { remote: "unsupported", local: "deleted" });
    assert.equal(requests.length, 0);
    assert.equal(await oauth.readMcpOAuthCredentials(identity(key)), null);
  });
}

test("bound revocation sends the token and deletes its local revision", async () => {
  const key = "bound-revoke";
  await save(key, bundle());
  begin(({ url, body }) => {
    assert.equal(url.href, `${issuer}/revoke`);
    assert.equal(new URLSearchParams(body).get("token"), "fixture-refresh");
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await oauth.revokeMcpOAuthCredentials(identity(key)), { remote: "succeeded", local: "deleted" });
  assert.equal(requests.length, 1);
});

test("revocation preserves a credential replaced while the request is pending", async () => {
  const key = "concurrent-revoke";
  await save(key, bundle());
  begin(async () => {
    await save(key, bundle({ tokens: { access_token: "replacement-access", refresh_token: "replacement-refresh", token_type: "Bearer", issuer } }));
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await oauth.revokeMcpOAuthCredentials(identity(key)), { remote: "succeeded", local: "replaced" });
  assert.equal((await oauth.readMcpOAuthCredentials(identity(key))).tokens.access_token, "replacement-access");
});

test("reconnect unlinks an old unbound grant in place and bound disconnect removes its row", async () => {
  const old = bundle(); delete old.tokens.issuer; delete old.clientInformation.issuer;
  begin(() => { throw new Error("unbound grant cleanup must not call its authorization server"); });
  const added = await remote.addOAuthRemoteServer("user", "mcp-owner@example.test", { name: "fixture-connect", url: resource, credentials: old });
  assert.equal(added.ok, true);
  const replacement = await remote.replaceOAuthRemoteServer("user", "mcp-owner@example.test", added.server.id, bundle());
  assert.equal(replacement.ok, true);
  assert.equal(replacement.server.id, added.server.id);
  assert.notEqual(replacement.server.oauthSecretKey, added.server.oauthSecretKey);
  assert.equal((await remote.listRemoteServers("user", "mcp-owner@example.test")).length, 1);
  assert.equal(await oauth.readMcpOAuthCredentials(identity(added.server.oauthSecretKey)), null);
  assert.equal(requests.length, 0);
  begin(() => new Response(null, { status: 200 }));
  assert.equal(await remote.removeRemoteServer("user", "mcp-owner@example.test", replacement.server.id), true);
  assert.equal((await remote.listRemoteServers("user", "mcp-owner@example.test")).length, 0);
  assert.equal(await oauth.readMcpOAuthCredentials(identity(replacement.server.oauthSecretKey)), null);
});

test("an unexpired legacy bearer remains usable only for its canonical resource without an AS request", async () => {
  const key = "legacy-bearer";
  const credentials = bundle({ tokenExpiresAt: Date.now() + 3600000 });
  delete credentials.clientInformation.issuer; delete credentials.tokens.issuer;
  await save(key, credentials);
  begin(() => { throw new Error("unexpired bearer lookup must not contact an authorization server"); });
  assert.equal(await oauth.getMcpOAuthAccessToken(identity(key)), "fixture-access");
  assert.equal(await oauth.getMcpOAuthAccessToken({ ...identity(key), serverUrl: `${resource}/other` }), null);
  assert.equal(requests.length, 0);
});
