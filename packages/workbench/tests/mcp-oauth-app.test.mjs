import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { assertNoMcpSurface, OWNER, send, startBuiltApp } from "./built-app.mjs";

const cookies = response => [response.headers["set-cookie"] ?? []].flat().map(value => value.split(";")[0]).join("; ");
const fetchPreload = fileURLToPath(new URL("./fixtures/loopback-fetch-only.mjs", import.meta.url));

async function startOAuthFixture() {
  let origin;
  const observed = { registered: 0, exchanges: 0, bearerRequests: 0, toolLists: 0, revocations: 0, errors: [] };
  const active = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (url.pathname.startsWith("/.well-known/")) return json({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
      });
      if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", "fixture-authorization-code");
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", origin);
        response.writeHead(302, { location: callback.href }); response.end(); return;
      }
      if (["/register", "/token", "/revoke"].includes(url.pathname)) {
        let body = "";
        for await (const chunk of request) body += chunk;
        assert.ok(body.length < 65536);
        if (url.pathname === "/register") {
          observed.registered += 1;
          return json({ ...JSON.parse(body), client_id: "fixture-public-client" }, 201);
        }
        const form = new URLSearchParams(body);
        assert.equal(form.get("client_id"), "fixture-public-client");
        if (url.pathname === "/revoke") {
          observed.revocations += 1;
          assert.equal(form.get("token"), "fixture-refresh-token");
          response.writeHead(200); response.end(); return;
        }
        observed.exchanges += 1;
        assert.equal(form.get("code"), "fixture-authorization-code");
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.ok(form.get("code_verifier"));
        return json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname !== "/mcp") return json({ error: "Fixture route not found" }, 404);
      if (request.headers.authorization !== "Bearer fixture-access-token") {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); response.end(); return;
      }
      observed.bearerRequests += 1;
      const mcp = new McpServer({ name: "vivary-oauth-fixture", version: "1" });
      mcp.registerTool("fixture_read", { description: "Read the OAuth fixture", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "fixture-read-ok" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      active.add(mcp);
      response.once("close", () => { active.delete(mcp); mcp.close().catch(() => undefined); });
      await mcp.connect(transport);
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      if (parsed?.method === "tools/list") observed.toolLists += 1;
      await transport.handleRequest(request, response, parsed);
    } catch (error) {
      observed.errors.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture request failed");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, observed, async stop() {
    await Promise.all([...active].map(mcp => mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

test("the rebuilt production server connects, reloads and disconnects outgoing MCP OAuth", { timeout: 180000 }, async t => {
  const data = await mkdtemp(path.join(tmpdir(), "vivary-mcp214-app-"));
  const fixture = await startOAuthFixture();
  let app;
  t.after(async () => { await app?.stop(); await fixture.stop(); await rm(data, { recursive: true, force: true }); });
  const start = () => startBuiltApp([], data, { env: port => ({
    WORKSPACE_OAUTH_ORIGIN: `http://127.0.0.1:${port}`,
    AGENT_NATIVE_MCP_OAUTH_PRIVATE_ORIGINS: fixture.origin,
    NODE_OPTIONS: `--import=${fetchPreload}`,
  }) });
  app = await start();
  await assertNoMcpSurface(app.port, { host: `127.0.0.1:${app.port}` });
  const address = new URL((await readFile(path.join(data, "owner-sign-in.txt"), "utf8")).trim());
  const session = await send(app.port, "GET", "/_agent-native/auth/session", { "x-vivary-owner-sign-in": address.hash.slice(1) });
  assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).email, OWNER);
  const ownerCookie = cookies(session);
  const query = new URLSearchParams({ name: "oauth-fixture", url: `${fixture.origin}/mcp`, scope: "user" });
  const started = await send(app.port, "GET", `/_agent-native/mcp/servers/oauth/start?${query}`, { cookie: ownerCookie });
  assert.equal(started.status, 302, started.body);
  const authorize = new URL(started.headers.location);
  assert.equal(authorize.origin, fixture.origin);
  const authorized = await fetch(authorize, { redirect: "manual" });
  assert.equal(authorized.status, 302);
  const callback = new URL(authorized.headers.get("location"));
  assert.equal(callback.origin, `http://127.0.0.1:${app.port}`);
  // Route-level acceptance delivers the callback with retained owner and flow cookies.
  const finished = await send(app.port, "GET", `${callback.pathname}${callback.search}`, { cookie: `${ownerCookie}; ${cookies(started)}` });
  assert.equal(finished.status, 302, finished.body);
  assert.match(finished.headers.location, /connected=mcp-oauth-fixture/);
  let listed = JSON.parse((await send(app.port, "GET", "/_agent-native/mcp/servers", { cookie: ownerCookie })).body);
  let stored = listed.user.find(server => server.name === "oauth-fixture");
  assert.ok(stored);
  assert.equal(stored.status.state, "connected");
  assert.equal(stored.status.toolCount, 1);
  assert.ok(!JSON.stringify(listed).includes("fixture-access-token"));
  const id = stored.id;
  await app.stop();
  app = await start();
  listed = JSON.parse((await send(app.port, "GET", "/_agent-native/mcp/servers", { cookie: ownerCookie })).body);
  stored = listed.user.find(server => server.id === id);
  assert.ok(stored, "the same saved connection survives restart");
  const tested = await send(app.port, "POST", `/_agent-native/mcp/servers/${id}/test?scope=user`, {
    cookie: ownerCookie, origin: `http://127.0.0.1:${app.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, "{}");
  assert.equal(tested.status, 200, tested.body);
  assert.match(tested.body, /fixture_read/);
  const removed = await send(app.port, "DELETE", `/_agent-native/mcp/servers/${id}?scope=user`, {
    cookie: ownerCookie, origin: `http://127.0.0.1:${app.port}`, "sec-fetch-site": "same-origin",
  });
  assert.equal(removed.status, 200, removed.body);
  const afterRemoval = await send(app.port, "GET", "/_agent-native/mcp/servers", { cookie: ownerCookie });
  assert.equal(afterRemoval.status, 200);
  assert.ok(!JSON.parse(afterRemoval.body).user.some(server => server.id === id));
  await assertNoMcpSurface(app.port, { host: `127.0.0.1:${app.port}` });
  assert.equal(fixture.observed.registered, 1);
  assert.equal(fixture.observed.exchanges, 1);
  assert.ok(fixture.observed.bearerRequests > 0);
  assert.ok(fixture.observed.toolLists > 0);
  assert.equal(fixture.observed.revocations, 1);
  assert.deepEqual(fixture.observed.errors, []);
});
