import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { H3, defineEventHandler } from "h3";
import {
  awaitBootstrap, getH3App, getRequestContext, runWithRequestContext,
} from "@agent-native/core/server";
import { CHAT_TITLE_PATH, mountChatTitles } from "../server/chat-title.mjs";

// The production-plugin test below bootstraps Core. Keep that bootstrap inert
// and its database disposable so the process exits when the assertions finish,
// the way registry-http and the runtime suites already do. Assign rather than
// default: an inherited value must not be able to re-enable background work.
// guard:allow-env-mutation — Test-only framework switches; process-scoped by design.
process.env.AGENT_NATIVE_DISABLED_PLUGINS = "agent-chat,auth,context-xray,core-routes,integrations,observational-memory,onboarding,org,resources,sentry,terminal"; // guard:allow-env-credential — Fixed framework plugin list; no credential value.
// guard:allow-env-mutation — Test-only framework switches; process-scoped by design.
process.env.AGENT_NATIVE_DISABLE_RECURRING_JOBS = "1"; // guard:allow-env-credential — Framework switch; no credential value.
// guard:allow-env-mutation — Test-only framework switches; process-scoped by design.
process.env.AGENT_NATIVE_DISABLE_INPROCESS_SWEEPS = "1"; // guard:allow-env-credential — Framework switch; no credential value.
// guard:allow-env-mutation — Test-only framework switches; process-scoped by design.
process.env.AGENT_NATIVE_DISABLE_KEEP_WARM = "1"; // guard:allow-env-credential — Framework switch; no credential value.
const disposableData = mkdtempSync(path.join(os.tmpdir(), "vivary-chat-title-"));
// guard:allow-env-mutation — Test-only disposable database, never an inherited one; process-scoped by design.
process.env.DATABASE_URL = `file:${path.join(disposableData, "app.sqlite")}`; // guard:allow-env-credential — Task-owned SQLite fixture file only.
test.after(async () => {
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec();
  rmSync(disposableData, { recursive: true, force: true });
});

async function fixture(options = {}) {
  const app = { h3: new H3() };
  const calls = [];
  const credentials = [];
  let time = 0;
  let fallbackCalls = 0;
  const dependencies = {
    getSession: async event => event.req.headers.get("x-test-user") === "anonymous"
      ? null : { email: event.req.headers.get("x-test-user") || "actor@example.test" },
    getOrgContext: async event => ({ orgId: event.req.headers.get("x-test-org") ?? "org-test" }),
    runWithRequestContext,
    resolveSecret: async key => {
      credentials.push({ key, ...getRequestContext() });
      return "test-only-deepseek-key";
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, context: getRequestContext() });
      return Response.json({ choices: [{ message: { content: '"Planning a Garden"' } }] });
    },
    now: () => time,
    ...options,
  };
  mountChatTitles(app, dependencies);
  await awaitBootstrap(app);
  getH3App(app).use(CHAT_TITLE_PATH, defineEventHandler(() => {
    fallbackCalls++;
    return Response.json({ title: "Unwanted default provider" });
  }));
  async function request(message = "Plan my garden", init = {}) {
    return app.h3.request("http://localhost" + (init.path ?? CHAT_TITLE_PATH), {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.method === "GET" ? {} : { body: init.body ?? JSON.stringify({ message }) }),
    });
  }
  return { request, calls, credentials, app, advance: value => { time += value; },
    defaultCalls: () => fallbackCalls };
}

test("native title route uses DeepSeek with bounded visible text and scoped credentials", async () => {
  const f = await fixture();
  const res = await f.request('<context>private project instructions</context>\nPlan @[garden|hidden-metadata] ' + "x".repeat(700));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { title: "Planning a Garden" });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.headers.Authorization, "Bearer test-only-deepseek-key");
  assert.equal(init.redirect, "error");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content.length, 500);
  assert.ok(body.messages[1].content.startsWith("Plan @garden "));
  assert.doesNotMatch(init.body, /private project|hidden-metadata|<context>/);
  assert.equal(f.credentials[0].key, "DEEPSEEK_API_KEY");
  assert.equal(f.credentials[0].userEmail, "actor@example.test");
  assert.equal(f.credentials[0].orgId, "org-test");
  assert.equal(f.defaultCalls(), 0);
});

test("missing or unavailable credentials produce sanitized fallback without provider calls", async () => {
  for (const resolveSecret of [async () => null, async () => { throw Error("private store error"); }]) {
    const f = await fixture({ resolveSecret });
    const res = await f.request("<context>secret</context> Discuss @[plants|file:/private] today");
    assert.deepEqual(await res.json(), { title: "Discuss @plants today" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.defaultCalls(), 0);
  }
  const hidden = await fixture();
  assert.deepEqual(await (await hidden.request("<context>unterminated hidden data")).json(), { title: "New chat" });
  assert.equal(hidden.credentials.length, 0);
  const nested = await fixture();
  assert.deepEqual(await (await nested.request("<context>outer<context>inner</context>still hidden</context>Visible message")).json(), { title: "Planning a Garden" });
  assert.equal(JSON.parse(nested.calls[0].init.body).messages[1].content, "Visible message");
});

test("provider rejection, malformed output and transport failure return a local title", async () => {
  for (const fetchImpl of [
    async () => new Response("private upstream error", { status: 500 }),
    async () => new Response("not JSON"),
    async () => Response.json({ choices: [{ message: { content: 7 } }] }),
    async () => Response.json({ choices: [{ message: { content: "  " } }] }),
    async () => { throw Error("private provider error"); },
  ]) {
    const f = await fixture({ fetchImpl });
    assert.deepEqual(await (await f.request()).json(), { title: "Plan my garden" });
    assert.equal(f.defaultCalls(), 0);
  }
});

test("authentication, organization, method, JSON and body limits reject before provider use", async () => {
  for (const [init, status] of [
    [{ headers: { "x-test-user": "anonymous" } }, 401],
    [{ headers: { "x-test-org": "" } }, 403],
    [{ method: "GET" }, 405],
    [{ headers: { "content-type": "text/plain" } }, 415],
    [{ body: "{" }, 400],
    [{ body: '{"message":7}' }, 400],
    [{ body: '{"message":" "}' }, 400],
    [{ body: JSON.stringify({ message: "x".repeat(17_000) }) }, 413],
    [{ path: CHAT_TITLE_PATH + "/suffix" }, 404],
  ]) {
    const f = await fixture();
    const res = await f.request(undefined, init);
    assert.equal(res.status, status, await res.text());
    assert.equal(f.credentials.length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.defaultCalls(), 0);
  }
  for (const callback of ["getSession", "getOrgContext"]) {
    const f = await fixture({ [callback]: async () => { throw Error("private auth failure"); } });
    const res = await f.request();
    assert.equal(res.status, 503);
    assert.equal(f.credentials.length, 0);
    assert.equal(f.defaultCalls(), 0);
  }
});

test("sliding title request limit separates users and organizations and expires", async () => {
  const f = await fixture({ resolveSecret: async () => null });
  for (let i = 0; i < 10; i++) assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request(undefined, { headers: { "x-test-user": "other@example.test" } })).status, 200);
  assert.equal((await f.request(undefined, { headers: { "x-test-org": "other-org" } })).status, 200);
  f.advance(60_000);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.defaultCalls(), 0);
});

test("overlapping requests keep native credential context isolated", async () => {
  const identities = [];
  let unblock;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const f = await fixture({
    resolveSecret: async () => {
      const before = getRequestContext();
      if (before.userEmail === "a@example.test") await waiting;
      else unblock();
      const after = getRequestContext();
      identities.push([before.userEmail, after.userEmail, after.orgId]);
      return null;
    },
  });
  const results = await Promise.all([
    f.request("A title", { headers: { "x-test-user": "a@example.test", "x-test-org": "org-a" } }),
    f.request("B title", { headers: { "x-test-user": "b@example.test", "x-test-org": "org-b" } }),
  ]);
  assert.ok(results.every(res => res.status === 200));
  assert.deepEqual(identities.sort(), [
    ["a@example.test", "a@example.test", "org-a"],
    ["b@example.test", "b@example.test", "org-b"],
  ]);
});

test("provider timeout aborts after five seconds and does not retry or fall through", async () => {
  let calls = 0;
  const f = await fixture({ fetchImpl: async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  // A real fetch owns an active socket; keep the synthetic pending request alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await (await f.request()).json(), { title: "Plan my garden" });
    assert.equal(calls, 1);
    assert.equal(f.defaultCalls(), 0);
  } finally { clearInterval(keepAlive); }
});

test("production plugin installs the native title route", async () => {
  const plugin = await import("../server/plugins/00-chat-title.mjs");
  assert.equal(typeof plugin.default, "function");
  const app = { h3: new H3() };
  await plugin.default(app);
  const res = await app.h3.request("http://localhost" + CHAT_TITLE_PATH);
  assert.equal(res.status, 405);
});
