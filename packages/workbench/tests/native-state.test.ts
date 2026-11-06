import assert from "node:assert/strict";
import test from "node:test";
import { createAppStateWriter } from "../app/lib/native-state";
import { installOwnerSessionFetch } from "../app/lib/owner-session-fetch";
import { VIVARY_OWNER_SESSION_STORAGE_KEY } from "../shared/owner-session";

type Call = { input: RequestInfo | URL; init?: RequestInit };

function harness(options: {
  status?: "loading" | "authenticated" | "unauthenticated" | "unavailable" | "signing-out";
  token?: unknown;
  responses?: Response[];
  nativePath?: (path: string) => string;
} = {}) {
  const calls: Call[] = [];
  const cookieWrites: Array<{ key: string; value: unknown; options?: object }> = [];
  let invalidations = 0;
  let rejectedToken: string | null = null;
  const responses = [...(options.responses ?? [
    new Response(JSON.stringify({ saved: true }), { status: 200 }),
  ])];
  const writer = createAppStateWriter({
    getSession: () => ({
      status: options.status ?? "authenticated",
      session: !("token" in options)
        ? { email: "owner@example.test", token: "native-session-token" }
        : options.token === undefined
          ? { email: "owner@example.test" }
          : { email: "owner@example.test", token: options.token },
    }),
    cookieWriter: async (key, value, writeOptions) => {
      cookieWrites.push({ key, value, options: writeOptions });
      return value;
    },
    fetch: async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return response;
    },
    invalidateSession: () => { invalidations += 1; },
    isRejectedToken: token => rejectedToken === token,
    rejectToken: token => { rejectedToken = token; },
    locationHref: () => "https://private.example.test/workbench/agent",
    nativePath: options.nativePath ?? (path => `/workbench${path}`),
  });
  return { calls, cookieWrites, invalidations: () => invalidations, writer };
}

test("a ready Native token performs exactly one same-origin PUT", async () => {
  const proof = harness({
    responses: [new Response(JSON.stringify({ projectId: "project-b" }), { status: 200 })],
  });

  const result = await proof.writer("selection", { projectId: "project-b" });
  assert.deepEqual(result, { projectId: "project-b" });
  assert.equal(proof.calls.length, 1);
  const call = proof.calls[0];
  assert.equal(String(call.input), "https://private.example.test/workbench/_agent-native/application-state/selection");
  assert.equal(call.init?.method, "PUT");
  assert.equal(call.init?.credentials, "same-origin");
  assert.equal(call.init?.redirect, "error");
  assert.equal(new Headers(call.init?.headers).get("X-Vivary-Session"), "native-session-token");
  assert.equal(call.init?.body, JSON.stringify({ projectId: "project-b" }));
});

test("loading, signed-out, unavailable, and malformed sessions never fetch", async () => {
  const cases = [
    { status: "loading" as const, token: null },
    { status: "unauthenticated" as const, token: null },
    { status: "unavailable" as const, token: null },
    { status: "signing-out" as const, token: "stale-token" },
    { status: "authenticated" as const, token: null },
    { status: "authenticated" as const, token: "" },
    { status: "authenticated" as const, token: "bad\ntoken" },
  ];
  for (const item of cases) {
    const proof = harness(item);
    await assert.rejects(proof.writer("selection", "value"));
    assert.equal(proof.calls.length, 0, `unexpected fetch for ${item.status}`);
  }
});

test("an authenticated tokenless session delegates to the public cookie writer", async () => {
  const proof = harness({ token: undefined });
  const controller = new AbortController();
  const value = await proof.writer("selection", null, {
    keepalive: true,
    signal: controller.signal,
    requestSource: "project-picker",
  });
  assert.equal(value, null);
  assert.equal(proof.calls.length, 0);
  assert.deepEqual(proof.cookieWrites, [{
    key: "selection",
    value: null,
    options: {
      keepalive: true,
      signal: controller.signal,
      requestSource: "project-picker",
    },
  }]);
});

test("write options preserve signal, keepalive, and request source", async () => {
  const proof = harness();
  const controller = new AbortController();
  await proof.writer("theme", { theme: "dark" }, {
    signal: controller.signal,
    keepalive: true,
    requestSource: "appearance",
  });
  const call = proof.calls[0];
  assert.equal(call.init?.signal, controller.signal);
  assert.equal(call.init?.keepalive, true);
  assert.equal(new Headers(call.init?.headers).get("X-Request-Source"), "appearance");
});

test("invalid keys are rejected before fetch", async () => {
  const proof = harness();
  await assert.rejects(
    proof.writer("../selection", "value"),
    /Application state keys may only contain/,
  );
  assert.equal(proof.calls.length, 0);
});

test("cross-origin and prefix-escaped paths cannot receive the token", async () => {
  const crossOrigin = harness({
    nativePath: path => path.includes("application-state")
      ? `https://attacker.example/${path}`
      : `/workbench${path}`,
  });
  await assert.rejects(crossOrigin.writer("selection", "value"), /same-origin Native API path/);
  assert.equal(crossOrigin.calls.length, 0);

  const escapedPrefix = harness({
    nativePath: path => path.includes("application-state")
      ? path
      : `/workbench${path}`,
  });
  await assert.rejects(escapedPrefix.writer("selection", "value"), /same-origin Native API path/);
  assert.equal(escapedPrefix.calls.length, 0);
});

test("a failed PUT is surfaced and a 401 invalidates without replay", async () => {
  const proof = harness({
    responses: [new Response(JSON.stringify({ error: "Session required" }), { status: 401 })],
  });
  await assert.rejects(
    proof.writer("selection", "value"),
    /Write application state "selection" failed: Session required/,
  );
  assert.equal(proof.calls.length, 1);
  assert.equal(proof.invalidations(), 1);
});



test("a rejected token cannot be reused while Native refreshes it", async () => {
  let token = "old-token";
  const calls: Call[] = [];
  let rejectedToken: string | null = null;
  let invalidations = 0;
  const responses = [
    new Response(JSON.stringify({ error: "Session required" }), { status: 401 }),
    new Response(JSON.stringify({ saved: true }), { status: 200 }),
  ];
  const writer = createAppStateWriter({
    getSession: () => ({
      status: "authenticated",
      session: { email: "owner@example.test", token },
    }),
    cookieWriter: async (_key, value) => value,
    fetch: async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return response;
    },
    invalidateSession: () => { invalidations += 1; },
    isRejectedToken: candidate => rejectedToken === candidate,
    rejectToken: candidate => { rejectedToken = candidate; },
    locationHref: () => "https://private.example.test/workbench/agent",
    nativePath: path => `/workbench${path}`,
  });

  await assert.rejects(writer("selection", "first"), /Session required/);
  await assert.rejects(writer("selection", "second"), /session token was rejected/);
  assert.equal(calls.length, 1);
  assert.equal(invalidations, 1);

  token = "fresh-token";
  await writer("selection", "third");
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[1].init?.headers).get("X-Vivary-Session"), "fresh-token");
});

function ownerSessionWindow(storage: () => string | null) {
  const calls: Call[] = [];
  const original: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 204 });
  };
  const target = {
    fetch: original,
    location: { href: "https://private.example.test/workbench/agent", origin: "https://private.example.test" },
    get localStorage() {
      return { getItem: (key: string) => (key === VIVARY_OWNER_SESSION_STORAGE_KEY ? storage() : null) };
    },
  };
  installOwnerSessionFetch(target);
  return { calls, installed: target.fetch !== original, fetch: target.fetch };
}

test("the owner session fetch installs nothing without a valid stored token", () => {
  for (const stored of [null, "", "bad token", "bad\ntoken", "x".repeat(4097)]) {
    assert.equal(ownerSessionWindow(() => stored).installed, false, JSON.stringify(stored));
  }
  assert.equal(ownerSessionWindow(() => { throw new Error("storage is blocked"); }).installed, false);
  const blocked = {
    fetch: globalThis.fetch,
    location: { href: "https://private.example.test/", origin: "https://private.example.test" },
    get localStorage(): Storage { throw new Error("storage is blocked"); },
  };
  installOwnerSessionFetch(blocked);
  assert.equal(blocked.fetch, globalThis.fetch);
});

test("the owner session fetch adds the header only to same-origin reads", async () => {
  const proof = ownerSessionWindow(() => "owner-session-token");
  assert.equal(proof.installed, true);
  const controller = new AbortController();
  await proof.fetch("/_agent-native/auth/session", { cache: "no-store", signal: controller.signal });
  await proof.fetch("https://private.example.test/workbench/_agent-native/poll", { method: "head" });
  await proof.fetch(new URL("https://private.example.test/assets/app.js"));
  const request = new Request("https://private.example.test/workbench/_agent-native/actions/list", {
    headers: { Accept: "application/json" },
  });
  await proof.fetch(request);

  assert.equal(proof.calls.length, 4);
  for (const call of proof.calls) {
    assert.equal(new Headers(call.init?.headers).get("X-Vivary-Session"), "owner-session-token");
  }
  assert.equal(proof.calls[0].input, "/_agent-native/auth/session");
  assert.equal(proof.calls[0].init?.cache, "no-store");
  assert.equal(proof.calls[0].init?.signal, controller.signal);
  assert.equal(proof.calls[3].input, request, "a Request input passes through as the same object");
  assert.equal(new Headers(proof.calls[3].init?.headers).get("Accept"), "application/json");
});

test("the owner session fetch passes other requests through untouched", async () => {
  const proof = ownerSessionWindow(() => "owner-session-token");
  const explicit = { headers: { "x-vivary-session": "explicit-token" } };
  const write = { method: "PUT", body: "{}", headers: { "Content-Type": "application/json" } };
  const post = new Request("https://private.example.test/workbench/_agent-native/actions/run", {
    method: "POST",
    body: "{}",
  });
  const presetRequest = new Request("https://private.example.test/", { headers: { "X-Vivary-Session": "preset-token" } });
  const sent: Array<[RequestInfo | URL, RequestInit | undefined]> = [
    ["/_agent-native/auth/session", explicit],
    [presetRequest, undefined],
    ["https://attacker.example/steal", undefined],
    ["//attacker.example/steal", { method: "GET" }],
    ["http://private.example.test/insecure", undefined],
    ["/_agent-native/application-state/selection", write],
    [post, undefined],
    ["/_agent-native/actions/run", { method: "DELETE" }],
  ];
  for (const [input, init] of sent) await proof.fetch(input, init);

  assert.equal(proof.calls.length, sent.length);
  proof.calls.forEach((call, index) => {
    assert.equal(call.input, sent[index][0]);
    assert.equal(call.init, sent[index][1], `request ${index} passes through unchanged`);
  });
});

test("null is persisted as JSON null", async () => {
  const proof = harness({
    responses: [new Response("null", { status: 200 })],
  });
  const result = await proof.writer("selection", null);
  assert.equal(result, null);
  assert.equal(proof.calls[0].init?.body, "null");
});
