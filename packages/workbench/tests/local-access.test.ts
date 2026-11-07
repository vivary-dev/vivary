import { VIVARY_OWNER_ACTIONS } from "../shared/owner-actions.ts";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session.ts";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { H3Event } from "h3";
import { COOKIE_NAME } from "@agent-native/core/server";

import { admitBrowserContext } from "../server/browser-request-context.mjs";
import {
  createVivaryLocalAuthOptions,
  createVivaryLocalSessionResolver,
  createVivaryOwnerProof,
  localAccessRequestRejection,
  readVivarySessionTokens,
  resolveVivaryLocalAccessConfig,
  type VivaryLocalAccessConfig,
  type VivaryLocalAccessRequest,
  type VivaryLocalAccessSessionDependencies,
  type VivaryOwnerProof,
} from "../server/local-access.ts";
import { NATIVE_MCP_DISCOVERY_PATH, VIVARY_NATIVE_MCP_OPTIONS } from "../server/native-mcp.ts";
import {
  createVivaryOwnerSignIn,
  VIVARY_OWNER_SIGN_IN_FILE,
  VIVARY_OWNER_SIGN_IN_HTML,
} from "../server/owner-sign-in.ts";

const ORIGIN = "http://127.0.0.1:4317";
const PRIVATE_ORIGIN = "https://vivary.example.test";

function localEnvironment(
  patch: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    APP_URL: ORIGIN,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: "4317",
    VIVARY_ACCESS_MODE: "local",
    ...patch,
  };
}

function privateProxyEnvironment(
  patch: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    APP_URL: PRIVATE_ORIGIN,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: "4317",
    VIVARY_ACCESS_MODE: "private-proxy",
    VIVARY_TRUSTED_PROXY: "zo-owner-only",
    ...patch,
  };
}

function request(
  patch: Partial<VivaryLocalAccessRequest> = {},
): VivaryLocalAccessRequest {
  return {
    host: "127.0.0.1:4317",
    method: "GET",
    peerAddress: "127.0.0.1",
    secFetchSite: "same-origin",
    ...patch,
  };
}

function privateProxyRequest(
  patch: Partial<VivaryLocalAccessRequest> = {},
): VivaryLocalAccessRequest {
  return {
    forwardedFor: "192.0.2.10",
    forwardedHost: "vivary.example.test",
    forwardedPort: "443",
    forwardedProto: "https",
    host: "127.0.0.1:4317",
    method: "GET",
    peerAddress: "127.0.0.1",
    realIp: "192.0.2.10",
    secFetchSite: "same-origin",
    ...patch,
  };
}

type TestEvent = H3Event & {
  localRequest: VivaryLocalAccessRequest;
  sessionTokens: string[];
};

function event(
  localRequest: VivaryLocalAccessRequest,
  sessionTokens: string[] = [],
): TestEvent {
  return { localRequest, sessionTokens } as unknown as TestEvent;
}

function sessionFixture(initialSessions: ReadonlyArray<readonly [string, string]> = []) {
  const sessions = new Map(initialSessions);
  const persisted: Array<{ email: string; token: string }> = [];
  const cookies: string[] = [];
  let tokenNumber = 0;
  const dependencies: VivaryLocalAccessSessionDependencies = {
    addSession: async (token, email) => {
      sessions.set(token, email);
      persisted.push({ email, token });
    },
    createToken: () => `local-session-${String(++tokenNumber).padStart(32, "0")}`,
    getSessionEmail: async (token) => sessions.get(token) ?? null,
    readRequest: (value) => (value as TestEvent).localRequest,
    readSessionTokens: (value) => (value as TestEvent).sessionTokens,
    setSessionCookie: (_value, token) => {
      cookies.push(token);
    },
  };
  return { cookies, dependencies, persisted, sessions };
}

// A real one-time sign-in store that keeps its saved addresses in memory.
function signInProof(origin = ORIGIN) {
  const saved: string[] = [];
  const signIn = createVivaryOwnerSignIn({
    origin,
    dataDir: "/unused",
    saveFile: (_file, contents) => {
      saved.push(contents);
    },
  });
  const currentSecret = () => (saved.at(-1) ?? "").trim().split("#")[1] ?? "";
  const proof: VivaryOwnerProof = { kind: "one-time-sign-in", signIn };
  return { currentSecret, proof, saved, signIn };
}

// Counts how often a resolver tries to spend the store's secret.
function countedSignInProof(origin = ORIGIN) {
  const store = signInProof(origin);
  let redeemCalls = 0;
  const proof: VivaryOwnerProof = {
    kind: "one-time-sign-in",
    signIn: {
      redeem: (presented) => {
        redeemCalls++;
        return store.signIn.redeem(presented);
      },
    },
  };
  return { ...store, proof, redeemCalls: () => redeemCalls };
}

function desktopConfig(): VivaryLocalAccessConfig {
  const config = resolveVivaryLocalAccessConfig(localEnvironment({ VIVARY_DESKTOP_HOST: "1" }));
  assert.ok(config?.desktop);
  return config;
}

// The range of the block an opener starts. Braces in comments and string literals do not count.
function blockRange(source: string, opener: RegExp): [number, number] {
  const start = source.search(opener);
  assert.ok(start >= 0, `${opener} is present`);
  const masked = source.slice(start).replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    literal => " ".repeat(literal.length));
  let depth = 0;
  for (let index = masked.indexOf("{"); index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    if (masked[index] === "}" && --depth === 0) return [start, start + index];
  }
  assert.fail(`${opener} closes`);
}

describe("Vivary local access configuration", () => {
  it("leaves unset and explicit hosted modes to Native's default auth plugin", () => {
    for (const environment of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", VIVARY_ACCESS_MODE: "hosted" },
    ]) {
      assert.equal(resolveVivaryLocalAccessConfig(environment), null);
    }
  });

  it("accepts only an exact production loopback origin", () => {
    assert.deepEqual(resolveVivaryLocalAccessConfig(localEnvironment()), {
      mode: "local",
      host: "127.0.0.1",
      origin: ORIGIN,
      ownerEmail: VIVARY_LOCAL_OWNER_EMAIL,
      port: 4317,
    });

    assert.deepEqual(
      resolveVivaryLocalAccessConfig(
        localEnvironment({ APP_URL: "http://127.0.0.1", PORT: "80" }),
      ),
      {
        mode: "local",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        ownerEmail: VIVARY_LOCAL_OWNER_EMAIL,
        port: 80,
      },
    );

    for (const patch of [
      { VIVARY_ACCESS_MODE: "typo" },
      { NODE_ENV: "development" },
      { HOST: "0.0.0.0" },
      { HOST: "localhost", APP_URL: "http://localhost:4317" },
      { PORT: "0" },
      { PORT: "4318" },
      { APP_URL: "https://127.0.0.1:4317" },
      { APP_URL: "http://127.0.0.1:4318" },
      { APP_URL: "http://127.0.0.1:4317/path" },
      { APP_URL: "http://127.0.0.1:4317/" },
    ]) {
      assert.throws(
        () => resolveVivaryLocalAccessConfig(localEnvironment(patch)),
        /vivary-local-access/,
      );
    }
  });

  it("infers the local origin when Native's public URL is unset", () => {
    for (const appUrl of [undefined, ""]) {
      assert.deepEqual(
        resolveVivaryLocalAccessConfig(localEnvironment({ APP_URL: appUrl })),
        {
          mode: "local",
          host: "127.0.0.1",
          origin: ORIGIN,
          ownerEmail: VIVARY_LOCAL_OWNER_EMAIL,
          port: 4317,
        },
      );
    }
  });

  it("rejects an explicit local URL from a different origin", () => {
    assert.throws(
      () => resolveVivaryLocalAccessConfig(
        localEnvironment({ APP_URL: "http://127.0.0.2:4317" }),
      ),
      /must exactly match the configured numeric loopback HOST and PORT/,
    );
  });

  it("requires an explicit private ingress profile and canonical external HTTPS origin", () => {
    assert.deepEqual(resolveVivaryLocalAccessConfig(privateProxyEnvironment()), {
      mode: "private-proxy",
      host: "127.0.0.1",
      origin: PRIVATE_ORIGIN,
      ownerEmail: VIVARY_LOCAL_OWNER_EMAIL,
      port: 4317,
    });

    for (const patch of [
      { VIVARY_TRUSTED_PROXY: undefined },
      { VIVARY_TRUSTED_PROXY: "generic" },
      { HOST: "::1" },
      { HOST: "0.0.0.0" },
      { APP_URL: "http://vivary.example.test" },
      { APP_URL: "https://127.0.0.1" },
      { APP_URL: "https://[::1]" },
      { APP_URL: "https://localhost" },
      { APP_URL: "https://vivary.example.test/" },
      { APP_URL: "https://vivary.example.test/path" },
    ]) {
      assert.throws(
        () => resolveVivaryLocalAccessConfig(privateProxyEnvironment(patch)),
        /vivary-local-access/,
      );
    }
  });

  it("replaces Native credential pages with the unified workspace route on the desktop", () => {
    const config = desktopConfig();
    const options = createVivaryLocalAuthOptions(config, createVivaryOwnerProof(config, {}));
    assert.equal(options.rootAuth, false);
    assert.match(options.loginHtml ?? "", /url=\/"/);
    assert.match(options.loginHtml ?? "", /location\.replace\("\/"\)/);
    assert.doesNotMatch(options.loginHtml ?? "", /email|password|signup/i);
  });

  it("replaces Native credential pages with the owner sign-in page in both self-hosted modes", () => {
    for (const environment of [localEnvironment(), privateProxyEnvironment()]) {
      const config = resolveVivaryLocalAccessConfig(environment);
      assert.ok(config);
      const options = createVivaryLocalAuthOptions(config, signInProof(config.origin).proof);
      assert.equal(options.rootAuth, false);
      assert.equal(options.loginHtml, VIVARY_OWNER_SIGN_IN_HTML[config.mode]);
    }
  });

  it("turns off Native's MCP endpoint and its connect, OAuth, embed, and discovery routes", async () => {
    const nativeServer = import.meta.resolve("@agent-native/core/server");
    const { resolveAgentChatMcpOptions } = await import(new URL("./agent-chat/mcp-options.js", nativeServer).href);
    const { resolveCoreRoutesMcpOptions } = await import(
      new URL("./core-routes/mcp-connect-options.js", nativeServer).href);
    assert.equal(resolveAgentChatMcpOptions(VIVARY_NATIVE_MCP_OPTIONS.agentChat).enabled, false);
    assert.equal(resolveCoreRoutesMcpOptions(VIVARY_NATIVE_MCP_OPTIONS.coreRoutes).connect, false);
    assert.equal(VIVARY_NATIVE_MCP_OPTIONS.coreRoutes.disableEmbedRoute, true);

    const chatPlugin = await readFile(new URL("../server/plugins/agent-chat.ts", import.meta.url), "utf8");
    assert.match(chatPlugin, /\.\.\.vivaryNativeChatProjectOptions,\s*\.\.\.VIVARY_NATIVE_MCP_OPTIONS\.agentChat,?\s*\}\)/);
    const nativeChat = await readFile(new URL("./agent-chat-plugin.js", nativeServer), "utf8");
    // Native imports mountMCP inside the gate, so no call outside it can mount the endpoint.
    const endpointGate = /if\s*\(\s*mcpOptions\.enabled\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*const\s*\{\s*mountMCP\s*\}\s*=\s*await\s+import\([^)]*\);\s*mountMCP\(\s*nitroApp\b/;
    assert.match(nativeChat, endpointGate);
    assert.equal(nativeChat.match(/\bmountMCP\s*\(/g)?.length, 1);
    // With the endpoint off, Integrations still manages the MCP servers that Vivary connects to.
    assert.equal(nativeChat.match(/\bmountMcpServersRoutes\s*\(\s*nitroApp\b/g)?.length, 1);
    assert.equal(nativeChat.match(/if\s*\(\s*mcpOptions\.enabled\s*\)/g)?.length, 1);
    assert.ok(nativeChat.search(/\bmountMcpServersRoutes\s*\(\s*nitroApp\b/) < nativeChat.search(endpointGate));

    // Native mounts its public MCP discovery card outside that gate and after an await, so Vivary's
    // refusal, mounted while plugins load, answers first. If Native gates the card, the refusal can go.
    const [gateStart, gateEnd] = blockRange(nativeChat, /if\s*\(\s*mcpOptions\.enabled\s*\)\s*\{/);
    assert.equal(nativeChat.match(/\bmountWebMcpActionRoutes\s*\(/g)?.length, 1);
    const cardMount = nativeChat.search(/\bmountWebMcpActionRoutes\s*\(\s*nitroApp\b/);
    assert.ok(cardMount < gateStart || cardMount > gateEnd, "the discovery card mounts outside the MCP gate");
    assert.match(nativeChat,
      /const\s*\{[^}]*\bmountWebMcpActionRoutes\b[^}]*\}\s*=\s*await\s+import\(\s*"\.\/action-routes\.js"\s*\)/);
    const actionRoutes = await readFile(new URL("./action-routes.js", nativeServer), "utf8");
    const webMcp = actionRoutes.slice(actionRoutes.search(/export\s+function\s+mountWebMcpActionRoutes\s*\(/));
    const card = /\.use\(\s*"([^"]+)"\s*,/.exec(webMcp);
    assert.ok(card);
    assert.equal(card[1], NATIVE_MCP_DISCOVERY_PATH);
    assert.ok(card.index < webMcp.search(/\breturn\b/), "the discovery card mounts before any early return");
    const refusal = await readFile(new URL("../server/plugins/00-mcp-discovery.ts", import.meta.url), "utf8");
    assert.match(refusal,
      /defineNitroPlugin\(\s*nitroApp\s*=>\s*\{\s*getH3App\(\s*nitroApp\s*\)\.use\(\s*NATIVE_MCP_DISCOVERY_PATH\s*,\s*defineEventHandler\(\s*\(\)\s*=>\s*Response\.json\(\s*\{[^}]*\}\s*,\s*\{\s*status:\s*404\b/);

    // Native skips its default core routes when an app plugin has the same file stem. A packaged
    // build has no plugins folder on disk, so there the plugin must mark the slot before its first await.
    const routesPlugin = await readFile(new URL("../server/plugins/core-routes.ts", import.meta.url), "utf8");
    assert.match(routesPlugin, /createCoreRoutesPlugin\(\{\s*googleOAuthManagedConnection:\s*"not_applicable",\s*\.\.\.VIVARY_NATIVE_MCP_OPTIONS\.coreRoutes,?\s*\}\)/);
    const nativeRoutes = await readFile(new URL("./core-routes-plugin.js", nativeServer), "utf8");
    assert.match(nativeRoutes, /export\s+const\s+defaultCoreRoutesPlugin\s*=\s*createCoreRoutesPlugin\(\{\s*googleOAuthManagedConnection:\s*"not_applicable",?\s*\}\)/);
    const pluginBody = nativeRoutes.slice(nativeRoutes.search(/export\s+function\s+createCoreRoutesPlugin\s*\(/));
    const slotMark = pluginBody.search(/\bmarkDefaultPluginProvided\s*\(\s*nitroApp\s*,\s*"core-routes"\s*\)/);
    assert.ok(slotMark > 0 && slotMark < pluginBody.search(/\bawait\b/), "the core routes slot is marked before any await");
    const connectGate = nativeRoutes.search(
      /const\s+mcpConnect\s*=\s*resolveCoreRoutesMcpOptions\(\s*options\s*\);\s*if\s*\(\s*mcpConnect\.connect\s*\)\s*\{/);
    const afterGate = nativeRoutes.search(/if\s*\(\s*!options\.disableOpenRoute\s*\)/);
    assert.ok(connectGate > 0 && afterGate > connectGate);
    const connectHandlers = /\bhandleMcp(?:Connect|OAuth\w*)\s*\(/g;
    const gatedHandlers = nativeRoutes.slice(connectGate, afterGate).match(connectHandlers)?.length ?? 0;
    assert.ok(gatedHandlers > 0);
    assert.equal(nativeRoutes.match(connectHandlers)?.length, gatedHandlers, "every connect and OAuth route sits behind the gate");
    // Only MCP tools mint MCP App embed tickets, and both embed routes sit behind disableEmbedRoute.
    assert.equal(nativeRoutes.match(/\.use\(\s*\x60\$\{P\}\/(?:embed\/start|mcp\/embed-error)\x60/g)?.length, 2);
    for (const route of [String.raw`embed\/start`, String.raw`mcp\/embed-error`]) {
      assert.match(nativeRoutes, new RegExp(String.raw`if\s*\(\s*!options\.disableEmbedRoute\s*\)\s*\{\s*(?:\/\/[^\n]*\s*)*` +
        String.raw`getH3App\(\s*nitroApp\s*\)\.use\(\s*\x60\$\{P\}\/${route}\x60`), route);
    }
  });

  it("gives desktop admission only to a desktop config and a sign-in file to every other", async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "vivary-owner-proof-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const file = path.join(dataDir, VIVARY_OWNER_SIGN_IN_FILE);

    assert.deepEqual(createVivaryOwnerProof(desktopConfig(), { VIVARY_DATA_DIR: dataDir }), { kind: "desktop-admission" });
    assert.deepEqual(createVivaryOwnerProof(desktopConfig(), {}), { kind: "desktop-admission" });
    assert.deepEqual(await readdir(dataDir), [], "a desktop launch writes no sign-in file");

    for (const environment of [localEnvironment(), privateProxyEnvironment()]) {
      const config = resolveVivaryLocalAccessConfig(environment);
      assert.ok(config);
      // Only the resolved config decides desktop admission, never the raw marker.
      const proof = createVivaryOwnerProof(config, { VIVARY_DATA_DIR: dataDir, VIVARY_DESKTOP_HOST: "1" });
      assert.equal(proof.kind, "one-time-sign-in");
      assert.match(await readFile(file, "utf8"), new RegExp(`^${config.origin}/sign-in#[\\w-]{43}\\n$`));
      assert.throws(() => createVivaryOwnerProof(config, {}), /VIVARY_DATA_DIR is required for owner sign-in/);
    }
  });
});

describe("Vivary local request boundary", () => {
  const config = resolveVivaryLocalAccessConfig(localEnvironment());
  assert.ok(config);

  it("accepts the configured raw loopback request", () => {
    assert.equal(localAccessRequestRejection(config, request()), null);
    assert.equal(
      localAccessRequestRejection(config, request({ peerAddress: "::ffff:127.0.0.1" })),
      null,
    );
  });

  it("rejects hostile peers, hosts, origins, proxy headers, and fetch sites", () => {
    const hostile: Array<[Partial<VivaryLocalAccessRequest>, string]> = [
      [{ peerAddress: "192.0.2.10" }, "non-loopback-peer"],
      [{ peerAddress: "127.not-an-address" }, "non-loopback-peer"],
      [{ peerAddress: "127.0.0.999" }, "non-loopback-peer"],
      [{ peerAddress: "::ffff:127.0.0.999" }, "non-loopback-peer"],
      [{ host: "attacker.example" }, "unexpected-host"],
      [{ host: "127.0.0.1:4318" }, "unexpected-host"],
      [{ origin: "https://attacker.example" }, "unexpected-origin"],
      [{ origin: "null" }, "unexpected-origin"],
      [{ forwardedProxyHeader: "x-forwarded-for" }, "forwarded-proxy-header"],
      [{ secFetchSite: "cross-site" }, "cross-site-request"],
      [{ secFetchSite: "same-site" }, "cross-site-request"],
    ];
    for (const [patch, reason] of hostile) {
      assert.equal(localAccessRequestRejection(config, request(patch)), reason);
    }
  });
});

describe("Vivary private proxy request boundary", () => {
  const config = resolveVivaryLocalAccessConfig(privateProxyEnvironment());
  assert.ok(config);

  it("accepts only canonical external or exact loopback-backend host shapes", () => {
    assert.equal(localAccessRequestRejection(config, privateProxyRequest()), null);
    assert.equal(
      localAccessRequestRejection(
        config,
        privateProxyRequest({
          forwardedHost: undefined,
          forwardedProto: undefined,
          host: "vivary.example.test",
        }),
      ),
      null,
    );
  });

  it("rejects foreign routing, origins, fetch sites, and proxy chains", () => {
    const hostile: Array<[Partial<VivaryLocalAccessRequest>, string]> = [
      [{ peerAddress: "192.0.2.20" }, "non-loopback-peer"],
      [{ host: "attacker.example" }, "unexpected-host"],
      [{ host: "127.0.0.1:4318" }, "unexpected-host"],
      [{ forwardedHost: undefined }, "unexpected-forwarded-host"],
      [{ forwardedHost: "attacker.example" }, "unexpected-forwarded-host"],
      [{ forwardedProto: undefined }, "unexpected-forwarded-proto"],
      [{ forwardedProto: "http" }, "unexpected-forwarded-proto"],
      [{ forwardedPort: "444" }, "unexpected-forwarded-port"],
      [{ origin: "https://attacker.example" }, "unexpected-origin"],
      [{ origin: "http://127.0.0.1:4317" }, "unexpected-origin"],
      [{ secFetchSite: "cross-site" }, "cross-site-request"],
      [{ forwardedProxyHeader: "forwarded" }, "unexpected-proxy-header"],
      [{ forwardedFor: "192.0.2.10, 127.0.0.1" }, "unexpected-proxy-chain"],
      [{ forwardedFor: "not-an-ip" }, "unexpected-proxy-chain"],
      [{ realIp: "192.0.2.11" }, "unexpected-proxy-chain"],
    ];
    for (const [patch, reason] of hostile) {
      assert.equal(
        localAccessRequestRejection(config, privateProxyRequest(patch)),
        reason,
      );
    }
  });
});

describe("Vivary local session provider", () => {
  const config = resolveVivaryLocalAccessConfig(localEnvironment());
  assert.ok(config);

  it("bootstraps on a safe page read and restores the persisted Native session", async () => {
    const fixture = sessionFixture();
    const signIn = signInProof();
    const firstResolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);
    const firstSession = await firstResolver(event(request({ ownerSignIn: signIn.currentSecret() })));

    assert.equal(firstSession?.email, VIVARY_LOCAL_OWNER_EMAIL);
    assert.equal(firstSession?.token, fixture.cookies[0]);
    assert.deepEqual(fixture.persisted, [
      { email: VIVARY_LOCAL_OWNER_EMAIL, token: fixture.cookies[0] },
    ]);

    const restoredResolver = createVivaryLocalSessionResolver(config, signInProof().proof, {
      ...fixture.dependencies,
      createToken: () => {
        throw new Error("restored sessions must not mint another token");
      },
    });
    const restored = await restoredResolver(
      event(request({ method: "POST", origin: ORIGIN }), [fixture.cookies[0]]),
    );
    assert.deepEqual(restored, firstSession);
    assert.equal(fixture.persisted.length, 1);
  });

  it("does not create an identity for POST before the browser bootstrap", async () => {
    const fixture = sessionFixture();
    const resolver = createVivaryLocalSessionResolver(config, signInProof().proof, fixture.dependencies);
    const result = await resolver(event(request({ method: "POST", origin: ORIGIN })));

    assert.equal(result, null);
    assert.deepEqual(fixture.persisted, []);
    assert.deepEqual(fixture.cookies, []);
  });

  it("does not authenticate foreign sessions or bootstrap hostile requests", async () => {
    const fixture = sessionFixture([["foreign-token", "someone@example.test"]]);
    const resolver = createVivaryLocalSessionResolver(config, signInProof().proof, fixture.dependencies);

    assert.equal(await resolver(event(request(), ["foreign-token"])), null);
    assert.equal(
      await resolver(event(request({ origin: "https://attacker.example" }))),
      null,
    );
    assert.deepEqual(fixture.persisted, []);
    assert.deepEqual(fixture.cookies, []);
  });

  it("fails closed when persisted session lookup is unavailable", async () => {
    const fixture = sessionFixture();
    const resolver = createVivaryLocalSessionResolver(config, signInProof().proof, {
      ...fixture.dependencies,
      getSessionEmail: async () => {
        throw new Error("database unavailable");
      },
    });

    assert.equal(await resolver(event(request(), ["unreadable-token"])), null);
    assert.deepEqual(fixture.persisted, []);
  });
});

describe("Vivary private proxy session provider", () => {
  const config = resolveVivaryLocalAccessConfig(privateProxyEnvironment());
  assert.ok(config);

  it("bootstraps one reserved owner and restores only that Native session", async () => {
    const fixture = sessionFixture();
    const signIn = signInProof(PRIVATE_ORIGIN);
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);
    const first = await resolver(event(privateProxyRequest({ ownerSignIn: signIn.currentSecret() })));

    assert.equal(first?.email, VIVARY_LOCAL_OWNER_EMAIL);
    assert.equal(fixture.persisted.length, 1);

    const restored = await resolver(
      event(
        privateProxyRequest({ method: "POST", origin: PRIVATE_ORIGIN }),
        [fixture.cookies[0]],
      ),
    );
    assert.deepEqual(restored, first);
    assert.equal(fixture.persisted.length, 1);
  });

  it("does not mint an owner on POST or accept a foreign Native session", async () => {
    const fixture = sessionFixture([["foreign-token", "someone@example.test"]]);
    const resolver = createVivaryLocalSessionResolver(config, signInProof(PRIVATE_ORIGIN).proof, fixture.dependencies);

    assert.equal(
      await resolver(event(privateProxyRequest({ method: "POST", origin: PRIVATE_ORIGIN }))),
      null,
    );
    assert.equal(
      await resolver(
        event(
          privateProxyRequest({ method: "POST", origin: PRIVATE_ORIGIN }),
          ["foreign-token"],
        ),
      ),
      null,
    );
    assert.deepEqual(fixture.persisted, []);
  });

  it("replaces a stale foreign cookie on a safe page read", async () => {
    const fixture = sessionFixture([["foreign-token", "someone@example.test"]]);
    const signIn = signInProof(PRIVATE_ORIGIN);
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);

    const migrated = await resolver(
      event(
        privateProxyRequest({ ownerSignIn: signIn.currentSecret() }),
        ["invalid-token", "foreign-token"],
      ),
    );

    assert.equal(migrated?.email, VIVARY_LOCAL_OWNER_EMAIL);
    assert.equal(migrated?.token, fixture.cookies[0]);
    assert.deepEqual(fixture.persisted, [
      { email: VIVARY_LOCAL_OWNER_EMAIL, token: fixture.cookies[0] },
    ]);
  });
});


describe("Vivary owner session bootstrap secret", () => {
  // A local program, or another account on the same computer, can reach the
  // loopback port with the expected Host and no browser headers at all.
  const rawLocalProgram = { host: "127.0.0.1:4317", method: "GET", peerAddress: "127.0.0.1" };

  it("gives a loopback request with the expected Host, no Origin, and no secret no session", async () => {
    const config = resolveVivaryLocalAccessConfig(localEnvironment());
    assert.ok(config);
    const fixture = sessionFixture();
    const signIn = signInProof();
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);

    assert.equal(await resolver(event(rawLocalProgram)), null);
    assert.deepEqual(fixture.persisted, []);
    assert.deepEqual(fixture.cookies, []);
    assert.equal(signIn.saved.length, 1);
  });

  it("gives a private proxy backend request with no Origin and no secret no session", async () => {
    const config = resolveVivaryLocalAccessConfig(privateProxyEnvironment());
    assert.ok(config);
    const fixture = sessionFixture();
    const signIn = signInProof(PRIVATE_ORIGIN);
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);

    assert.equal(
      await resolver(event(privateProxyRequest({ origin: undefined, secFetchSite: undefined }))),
      null,
    );
    assert.deepEqual(fixture.persisted, []);
    assert.deepEqual(fixture.cookies, []);
    assert.equal(signIn.saved.length, 1);
  });

  for (const [mode, environment, makeRequest, origin] of [
    ["local", localEnvironment(), request, ORIGIN],
    ["private proxy", privateProxyEnvironment(), privateProxyRequest, PRIVATE_ORIGIN],
  ] as const) {
    it(`creates one session per saved address in ${mode} mode`, async () => {
      const config = resolveVivaryLocalAccessConfig(environment);
      assert.ok(config);
      const fixture = sessionFixture();
      const signIn = signInProof(origin);
      const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);
      const secret = signIn.currentSecret();
      assert.match(secret, /^[\w-]{43}$/);

      for (const ownerSignIn of [undefined, "", "x".repeat(43), secret.slice(1), `${secret}=`, ` ${secret}`]) {
        assert.equal(await resolver(event(makeRequest({ ownerSignIn }))), null, JSON.stringify(ownerSignIn));
      }
      assert.equal(signIn.saved.length, 1);

      assert.equal((await resolver(event(makeRequest({ ownerSignIn: secret }))))?.email, VIVARY_LOCAL_OWNER_EMAIL);
      assert.equal(await resolver(event(makeRequest({ ownerSignIn: secret }))), null);
      assert.equal(signIn.saved.length, 2);
      assert.notEqual(signIn.currentSecret(), secret);
      assert.equal(signIn.saved[1], `${origin}/sign-in#${signIn.currentSecret()}\n`);

      const next = await resolver(event(makeRequest({ ownerSignIn: signIn.currentSecret() })));
      assert.equal(next?.email, VIVARY_LOCAL_OWNER_EMAIL);
      assert.equal(fixture.persisted.length, 2);
    });
  }

  it("never spends the secret on a refused, write, or already signed-in request", async () => {
    const config = resolveVivaryLocalAccessConfig(localEnvironment());
    assert.ok(config);
    const fixture = sessionFixture([
      ["owner-token", VIVARY_LOCAL_OWNER_EMAIL],
      ["foreign-token", "someone@example.test"],
    ]);
    const signIn = countedSignInProof();
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);
    const ownerSignIn = signIn.currentSecret();

    assert.equal(await resolver(event(request({ ownerSignIn, origin: "https://attacker.example" }))), null);
    assert.equal(await resolver(event(request({ ownerSignIn, method: "POST", origin: ORIGIN }))), null);
    assert.equal(await resolver(event(request({ ownerSignIn }), ["foreign-token"])), null);
    assert.deepEqual(await resolver(event(request({ ownerSignIn }), ["owner-token"])), {
      email: VIVARY_LOCAL_OWNER_EMAIL,
      name: "Local owner",
      token: "owner-token",
    });
    assert.equal(signIn.redeemCalls(), 0);
    assert.equal(signIn.saved.length, 1);
    assert.deepEqual(fixture.persisted, []);

    assert.equal((await resolver(event(request({ ownerSignIn }))))?.email, VIVARY_LOCAL_OWNER_EMAIL);
    assert.equal(signIn.redeemCalls(), 1);
  });

  it("lets only one of several concurrent requests spend a secret", async () => {
    const config = resolveVivaryLocalAccessConfig(localEnvironment());
    assert.ok(config);
    const fixture = sessionFixture();
    const signIn = signInProof();
    const resolver = createVivaryLocalSessionResolver(config, signIn.proof, fixture.dependencies);
    const ownerSignIn = signIn.currentSecret();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => resolver(event(request({ ownerSignIn }), ["stale-token"]))),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(fixture.persisted.length, 1);
    assert.equal(signIn.saved.length, 2);
  });
});

describe("Vivary session diagnostics", () => {
  it("is opt-in and reports only cookie presence and token counts", async (t) => {
    const config = resolveVivaryLocalAccessConfig(localEnvironment());
    assert.ok(config);
    const resolveSession = createVivaryLocalSessionResolver(config, signInProof().proof);
    const output: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    const previous = process.env.VIVARY_SESSION_DIAGNOSTICS; // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
    const makeRequest = (cookie?: string) => new H3Event(Object.assign(
      new Request(`${ORIGIN}/_agent-native/application-state/selection`, {
        method: "PUT",
        headers: { host: "127.0.0.1:4317", origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
      }),
      { context: { clientAddress: "127.0.0.1" } },
    ));
    try {
      delete process.env.VIVARY_SESSION_DIAGNOSTICS; // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
      assert.equal(await resolveSession(makeRequest()), null);
      assert.equal(output.length, 0);
      process.env.VIVARY_SESSION_DIAGNOSTICS = "1"; // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
      for (const [cookie, expectedCookieNamePresent] of [
        [undefined, false],
        ["other=private-value", false],
        [`${COOKIE_NAME}x`, false],
        [`${COOKIE_NAME}=`, true],
      ] as const) {
        assert.equal(await resolveSession(makeRequest(cookie)), null);
        assert.deepEqual(JSON.parse(output.at(-1) ?? ""), {
          cookieHeaderPresent: cookie !== undefined,
          expectedCookieNamePresent,
          recognizedTokenCount: 0,
        });
      }
      assert.equal(output.length, 4);
      assert.ok(output.every(line => !line.includes("private-value")));
    } finally {
      if (previous === undefined) delete process.env.VIVARY_SESSION_DIAGNOSTICS; // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
      else process.env.VIVARY_SESSION_DIAGNOSTICS = previous; // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
    }
  });
});

describe("Vivary private state session header", () => {
  const config = resolveVivaryLocalAccessConfig(privateProxyEnvironment());
  const localConfig = resolveVivaryLocalAccessConfig(localEnvironment());
  assert.ok(config);
  assert.ok(localConfig);

  function stateEvent(
    path = "/_agent-native/application-state/project-selection",
    method = "PUT",
    patch: Record<string, string | undefined> = {},
  ): H3Event {
    const headers = new Headers({
      origin: PRIVATE_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-vivary-session": "owner-token",
    });
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) headers.delete(name);
      else headers.set(name, value);
    }
    return new H3Event(new Request(PRIVATE_ORIGIN + path, { method, headers }));
  }

  it("reads the header on same-origin private state writes and no other write", () => {
    assert.deepEqual(readVivarySessionTokens(stateEvent(), config), ["owner-token"]);
    assert.deepEqual(readVivarySessionTokens(stateEvent(), localConfig), []);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      assert.deepEqual(readVivarySessionTokens(stateEvent(undefined, method), config), []);
    }
    for (const path of [
      "/_agent-native/actions/run",
      "/_agent-native/application-state",
      "/_agent-native/application-state/",
      "/_agent-native/application-state/compose",
      "/_agent-native/application-state/nested/key",
      "/_agent-native/application-state/nested%2Fkey",
      "/_agent-native/application-state/%",
      "/_agent-native/application-state/has%20space",
    ]) {
      assert.deepEqual(readVivarySessionTokens(stateEvent(path), config), []);
    }
    for (const patch of [
      { origin: undefined },
      { origin: "https://other.example.test" },
      { "sec-fetch-site": undefined },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "cross-site" },
      { "x-vivary-session": "" },
      { "x-vivary-session": "x".repeat(4097) },
    ]) {
      assert.deepEqual(readVivarySessionTokens(stateEvent(undefined, undefined, patch), config), []);
    }
  });

  it("accepts only named owner action POSTs through the same-origin boundary", () => {
    for (const name of VIVARY_OWNER_ACTIONS) {
      const route = "/_agent-native/actions/" + name;
      assert.deepEqual(readVivarySessionTokens(stateEvent(route, "POST"), config), ["owner-token"]);
      assert.deepEqual(readVivarySessionTokens(stateEvent(route, "POST"), localConfig), []);
      for (const method of ["PUT", "DELETE"]) {
        assert.deepEqual(readVivarySessionTokens(stateEvent(route, method), config), []);
      }
      for (const patch of [{ origin: undefined }, { origin: "https://other.example.test" },
        { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": undefined }]) {
        assert.deepEqual(readVivarySessionTokens(stateEvent(route, "POST", patch), config), []);
      }
      assert.deepEqual(readVivarySessionTokens(stateEvent(route + "/extra", "POST"), config), []);
    }
    assert.deepEqual(readVivarySessionTokens(stateEvent("/_agent-native/actions/unrelated-action", "POST"), config), []);
  });

  it("reads the header on every same-origin private read and never in local or desktop mode", () => {
    const cookieOnlyConfigs: VivaryLocalAccessConfig[] = [localConfig, { ...localConfig, desktop: true }];
    for (const method of ["GET", "HEAD"]) {
      for (const path of [
        "/",
        "/_agent-native/auth/session",
        "/_agent-native/application-state/compose",
        "/_agent-native/actions/unrelated-action",
        "/projects/any/nested/path",
      ]) {
        const read = (patch: Record<string, string | undefined>, target: VivaryLocalAccessConfig = config) =>
          readVivarySessionTokens(stateEvent(path, method, patch), target);
        assert.deepEqual(read({}), ["owner-token"]);
        assert.deepEqual(read({ origin: undefined }), ["owner-token"]);
        assert.deepEqual(read({ "x-vivary-session": "x".repeat(4096) }), ["x".repeat(4096)]);
        for (const patch of [
          { origin: "https://other.example.test" },
          { origin: "null" },
          { "sec-fetch-site": "cross-site" },
          { "sec-fetch-site": "same-site" },
          { "sec-fetch-site": "none" },
          { "sec-fetch-site": undefined },
          { "x-vivary-session": "" },
          { "x-vivary-session": "x".repeat(4097) },
          { "x-vivary-session": "owner token" },
        ]) {
          assert.deepEqual(read(patch), [], `${method} ${path} ${JSON.stringify(patch)}`);
        }
        for (const target of cookieOnlyConfigs) {
          for (const origin of [ORIGIN, undefined]) {
            assert.deepEqual(read({ origin }, target), []);
          }
        }
      }
    }
  });

  it("preserves cookie sessions and deduplicates matching header tokens", () => {
    const value = stateEvent(undefined, undefined, { cookie: `${COOKIE_NAME}=owner-token` });
    assert.deepEqual(readVivarySessionTokens(value, config), ["owner-token"]);
    assert.deepEqual(readVivarySessionTokens(value, localConfig), ["owner-token"]);
    const read = stateEvent("/", "GET", { cookie: `${COOKIE_NAME}=owner-token` });
    assert.deepEqual(readVivarySessionTokens(read, config), ["owner-token"]);
    const other = stateEvent("/", "GET", { cookie: `${COOKIE_NAME}=cookie-token` });
    assert.deepEqual(readVivarySessionTokens(other, config), ["cookie-token", "owner-token"]);
    assert.deepEqual(readVivarySessionTokens(other, localConfig), ["cookie-token"]);
  });

  it("resolves the owner from a read header before it spends a sign-in secret", async () => {
    for (const method of ["GET", "HEAD"]) {
      const fixture = sessionFixture([["owner-token", VIVARY_LOCAL_OWNER_EMAIL]]);
      const signIn = countedSignInProof(PRIVATE_ORIGIN);
      const resolver = createVivaryLocalSessionResolver(config, signIn.proof, {
        ...fixture.dependencies,
        readRequest: () => privateProxyRequest({ method, ownerSignIn: signIn.currentSecret() }),
        readSessionTokens: readVivarySessionTokens,
      });
      const sessionRead = (patch: Record<string, string | undefined> = {}) =>
        stateEvent("/_agent-native/auth/session", method, { origin: undefined, ...patch });

      assert.deepEqual(await resolver(sessionRead()), {
        email: VIVARY_LOCAL_OWNER_EMAIL,
        name: "Local owner",
        token: "owner-token",
      });
      assert.equal(signIn.redeemCalls(), 0);
      assert.equal(signIn.saved.length, 1);
      assert.deepEqual(fixture.persisted, []);
      assert.deepEqual(fixture.cookies, []);

      const replaced = await resolver(sessionRead({ "x-vivary-session": "stale-token" }));
      assert.equal(replaced?.email, VIVARY_LOCAL_OWNER_EMAIL);
      assert.notEqual(replaced?.token, "owner-token");
      assert.equal(signIn.redeemCalls(), 1, "an unknown header token falls through to the secret");
      assert.equal(fixture.persisted.length, 1);
    }
  });

  it("requires an existing reserved-owner session and never mints on a write", async () => {
    for (const email of [VIVARY_LOCAL_OWNER_EMAIL, "foreign@example.test", null]) {
      const fixture = sessionFixture(email ? [["owner-token", email]] : []);
      const resolver = createVivaryLocalSessionResolver(config, signInProof(PRIVATE_ORIGIN).proof, {
        ...fixture.dependencies,
        readRequest: () => privateProxyRequest({ method: "PUT", origin: PRIVATE_ORIGIN }),
        readSessionTokens: readVivarySessionTokens,
      });
      const result = await resolver(stateEvent());
      assert.equal(result?.email ?? null, email === VIVARY_LOCAL_OWNER_EMAIL ? email : null);
      assert.deepEqual(fixture.persisted, []);
      assert.deepEqual(fixture.cookies, []);
    }
  });

  it("rejects before token lookup when the request boundary fails", async () => {
    for (const patch of [
      { peerAddress: "192.0.2.20" },
      { host: "attacker.example.test" },
      { forwardedHost: "attacker.example.test" },
      { origin: "https://attacker.example.test" },
      { secFetchSite: "cross-site" },
    ]) {
      let lookups = 0;
      const fixture = sessionFixture();
      const resolver = createVivaryLocalSessionResolver(config, signInProof(PRIVATE_ORIGIN).proof, {
        ...fixture.dependencies,
        readRequest: () => privateProxyRequest({ method: "PUT", origin: PRIVATE_ORIGIN, ...patch }),
        readSessionTokens: readVivarySessionTokens,
        getSessionEmail: async () => { lookups++; return VIVARY_LOCAL_OWNER_EMAIL; },
      });
      assert.equal(await resolver(stateEvent()), null);
      assert.equal(lookups, 0);
      assert.deepEqual(fixture.persisted, []);
    }
  });

  it("fails closed when a header token lookup fails", async () => {
    const fixture = sessionFixture();
    const resolver = createVivaryLocalSessionResolver(config, signInProof(PRIVATE_ORIGIN).proof, {
      ...fixture.dependencies,
      readRequest: () => privateProxyRequest({ method: "PUT", origin: PRIVATE_ORIGIN }),
      readSessionTokens: readVivarySessionTokens,
      getSessionEmail: async () => { throw new Error("unavailable"); },
    });
    assert.equal(await resolver(stateEvent()), null);
    assert.deepEqual(fixture.persisted, []);
    assert.deepEqual(fixture.cookies, []);
  });
});

describe('desktop listener admission', () => {
  const admitted = (localRequest: VivaryLocalAccessRequest, sessionTokens: string[] = []) => {
    const value = Object.assign(event(localRequest, sessionTokens), { context: {} });
    admitBrowserContext(value.context, { kind: 'desktop' });
    return value;
  };

  it('does not bootstrap an apparent loopback request without desktop admission', async () => {
    const config = desktopConfig();
    const fixture = sessionFixture();
    const resolver = createVivaryLocalSessionResolver(config, createVivaryOwnerProof(config, {}), fixture.dependencies);
    assert.equal(await resolver(event(request())), null);
    assert.equal(await resolver(event(request({ ownerSignIn: 's'.repeat(43) }))), null);
    assert.equal(fixture.persisted.length, 0);
  });

  it('never reads an existing owner session on a request without desktop admission', async () => {
    const config = desktopConfig();
    const fixture = sessionFixture([['owner-session', VIVARY_LOCAL_OWNER_EMAIL]]);
    const reads: string[] = [];
    const resolver = createVivaryLocalSessionResolver(config, createVivaryOwnerProof(config, {}), {
      ...fixture.dependencies,
      readSessionTokens: (value, current) => {
        reads.push('tokens');
        return fixture.dependencies.readSessionTokens(value, current);
      },
      getSessionEmail: (token) => {
        reads.push(token);
        return fixture.dependencies.getSessionEmail(token);
      },
    });
    assert.equal(await resolver(event(request(), ['owner-session'])), null);
    assert.deepEqual(reads, []);
    assert.equal((await resolver(admitted(request(), ['owner-session'])))?.token, 'owner-session');
    assert.deepEqual(reads, ['tokens', 'owner-session']);
    assert.equal(fixture.persisted.length, 0);
  });

  it('bootstraps with desktop admission and no sign-in secret', async () => {
    const config = desktopConfig();
    const fixture = sessionFixture();
    const resolver = createVivaryLocalSessionResolver(config, createVivaryOwnerProof(config, {}), fixture.dependencies);
    assert.equal((await resolver(admitted(request())))?.email, VIVARY_LOCAL_OWNER_EMAIL);
    assert.equal(fixture.persisted.length, 1);
  });
});
