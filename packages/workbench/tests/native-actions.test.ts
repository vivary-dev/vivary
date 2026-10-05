import assert from "node:assert/strict";
import test from "node:test";
import evaluateOwner from "../actions/vivary-project-evaluate-owner.ts";
import evaluateTool from "../actions/vivary-project-evaluate.ts";
import { createNativeActionCaller, folderConnectionErrorMessage } from "../app/lib/native-actions";
import { VIVARY_OWNER_ACTIONS } from "../shared/owner-actions";

test("owner action sends one bounded same-origin request without redirects", async () => {
  const requests: Request[] = [];
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "native-test-token" } }),
    cookieAction: async () => { throw new Error("Cookie fallback was not expected"); },
    fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({ accepted: true }); },
    locationHref: () => "https://private.example.test/agent",
    nativePath: path => path, invalidate: () => { throw new Error("Unexpected invalidation"); },
  });
  assert.deepEqual(await call("vivary-code-deny", { runId: "run-test", requestId: "request-test" }), { accepted: true });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://private.example.test/_agent-native/actions/vivary-code-deny");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.credentials, "same-origin");
  assert.equal(request.headers.get("x-vivary-session"), "native-test-token");
  assert.deepEqual(await request.json(), { runId: "run-test", requestId: "request-test" });
});

test("rejects cross-origin paths and unavailable sessions before a request", async () => {
  for (const crossOrigin of [true, false]) {
    let calls = 0;
    const call = createNativeActionCaller({
      getSession: () => ({ status: "unauthenticated", session: null }),
      cookieAction: async () => { calls++; throw new Error("Unexpected"); },
      fetch: async () => { calls++; return Response.json({}); },
      locationHref: () => "https://private.example.test/agent",
      nativePath: path => crossOrigin ? "https://other.example.test" + path : path,
      invalidate: () => undefined,
    });
    await assert.rejects(call("vivary-code-send", { message: "hello" }));
    assert.equal(calls, 0);
  }
});

test("a rejected token is never replayed and a new session can retry", async () => {
  let token = "old-test-token";
  let calls = 0;
  let invalidations = 0;
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token } }),
    cookieAction: async () => { throw new Error("Unexpected"); },
    fetch: async () => { calls++; return calls === 1 ? Response.json({ message: "Sign in." }, { status: 401 }) : Response.json({ accepted: true }); },
    locationHref: () => "https://private.example.test/agent", nativePath: path => path,
    invalidate: () => { invalidations++; },
  });
  await assert.rejects(call("vivary-code-send", {}), /Sign in/);
  await assert.rejects(call("vivary-code-send", {}), /session refreshes/);
  assert.equal(calls, 1);
  assert.equal(invalidations, 1);
  token = "new-test-token";
  assert.deepEqual(await call("vivary-code-send", {}), { accepted: true });
});

test("authenticated cookie sessions retain Native action transport", async () => {
  let fallback = 0;
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test" } }),
    cookieAction: async <T>() => { fallback++; return null as T; },
    fetch: async () => { throw new Error("Unexpected direct fetch"); },
    locationHref: () => "https://private.example.test/agent", nativePath: path => path,
    invalidate: () => undefined,
  });
  assert.equal(await call("vivary-register-project", {}), null);
  assert.equal(fallback, 1);
});

test("malformed session tokens cannot reach an action", async () => {
  for (const token of ["", "has space", "bad\ntoken", "x".repeat(4097)]) {
    let calls = 0;
    const call = createNativeActionCaller({
      getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token } }),
      cookieAction: async () => { calls++; throw new Error("Unexpected fallback"); },
      fetch: async () => { calls++; return Response.json({}); },
      locationHref: () => "https://private.example.test/agent", nativePath: path => path,
      invalidate: () => undefined,
    });
    await assert.rejects(call("vivary-code-approve", {}), /valid session token/);
    assert.equal(calls, 0);
  }
});

test("independent controls cannot replay a token rejected by another control", async () => {
  let token = "shared-rejected-test-token";
  let requests = 0;
  const dependencies = {
    getSession: () => ({ status: "authenticated" as const, session: { email: "owner@example.test", token } }),
    cookieAction: async <T>() => { throw new Error("Unexpected cookie fallback"); },
    fetch: async () => {
      requests++;
      return requests === 1 ? Response.json({ message: "Sign in." }, { status: 401 }) : Response.json({ accepted: true });
    },
    locationHref: () => "https://private.example.test/agent",
    nativePath: (path: string) => path,
    invalidate: () => undefined,
  };
  const first = createNativeActionCaller(dependencies);
  const second = createNativeActionCaller(dependencies);
  await assert.rejects(first("vivary-code-send", {}), /Sign in/);
  await assert.rejects(second("vivary-code-approve", {}), /session refreshes/);
  assert.equal(requests, 1);
  token = "shared-refreshed-test-token";
  assert.deepEqual(await second("vivary-code-approve", {}), { accepted: true });
  token = "shared-rejected-test-token";
  await assert.rejects(first("vivary-code-send", {}), /session refreshes/);
  assert.equal(requests, 2);
});

test("original engine commands use the same private owner-session transport", async () => {
  const requests: Request[] = [];
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "original-owner-test-token" } }),
    cookieAction: async () => { throw new Error("A private owner session must use its existing transport."); },
    fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({ exitCode: 0 }); },
    locationHref: () => "https://private.example.test/",
    nativePath: path => path,
    invalidate: () => { throw new Error("Unexpected invalidation"); },
  });
  const input = { projectId: "project-test", command: { verb: "pattern-state" } };
  assert.deepEqual(await call("vivary-original-command", input), { exitCode: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://private.example.test/_agent-native/actions/vivary-original-command");
  assert.equal(requests[0].headers.get("x-vivary-session"), "original-owner-test-token");
  assert.equal(requests[0].redirect, "error");
  assert.deepEqual(await requests[0].json(), input);
});

test("governed evaluation is an owner action and a separate agent tool that is not a read", async () => {
  assert.ok(VIVARY_OWNER_ACTIONS.includes("vivary-project-evaluate-owner"));
  assert.equal((VIVARY_OWNER_ACTIONS as readonly string[]).includes("vivary-project-evaluate"), false, "the tool has no owner transport");
  assert.deepEqual([evaluateTool.agentTool, evaluateTool.readOnly, evaluateTool.dedupe, evaluateTool.timeoutMs,
    evaluateTool.mcpTool, evaluateTool.toolCallable], [true, false, false, 70_000, false, false]);
  assert.deepEqual([evaluateOwner.agentTool, evaluateOwner.readOnly, evaluateOwner.mcpTool, evaluateOwner.toolCallable],
    [false, false, false, false]);
  const requests: Request[] = [];
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "evaluate-owner-test-token" } }),
    cookieAction: async () => { throw new Error("A private owner session must use its existing transport."); },
    fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({ status: "evaluated" }); },
    locationHref: () => "https://private.example.test/", nativePath: path => path,
    invalidate: () => { throw new Error("Unexpected invalidation"); },
  });
  const input = { projectId: "project-test", evaluateAs: "agent", operation: "expire_leases", state: { claims: [] } };
  assert.deepEqual(await call("vivary-project-evaluate-owner", input), { status: "evaluated" });
  assert.equal(requests[0].url, "https://private.example.test/_agent-native/actions/vivary-project-evaluate-owner");
  assert.deepEqual(await requests[0].json(), input);
});

test("folder picker timeouts explain how to recover on both owner transports", async () => {
  for (const token of ["picker-timeout-owner", undefined]) {
    const failure = token
      ? new DOMException("The operation was aborted due to timeout", "TimeoutError")
      : Object.assign(new Error("Action timed out after 130s"), { timedOut: true, status: 408 });
    const call = createNativeActionCaller({
      getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", ...(token ? { token } : {}) } }),
      cookieAction: async () => { throw failure; },
      fetch: async () => { throw failure; },
      locationHref: () => "https://private.example.test/", nativePath: path => path,
      invalidate: () => { throw new Error("Unexpected invalidation"); },
    });
    try {
      await call("vivary-connect-project-folder", {});
      assert.fail("The expired picker must reject");
    } catch (error) {
      assert.equal(folderConnectionErrorMessage(error), "Folder selection timed out. Close the folder chooser and try again.");
    }
  }
});

test("folder connection preserves the server's safe recovery message", async () => {
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "picker-server-error-owner" } }),
    cookieAction: async () => { throw new Error("Unexpected cookie fallback"); },
    fetch: async () => Response.json({ message: "Close the folder chooser and try again in the desktop app." }, { status: 409 }),
    locationHref: () => "https://private.example.test/", nativePath: path => path, invalidate: () => undefined,
  });
  await assert.rejects(call("vivary-connect-project-folder", {}), error => {
    assert.equal(folderConnectionErrorMessage(error), "Close the folder chooser and try again in the desktop app.");
    return true;
  });
  assert.equal(folderConnectionErrorMessage(new Error("private unexpected failure")), "The folder could not be connected. Try again.");
});


test("preview refusal preserves the Native error code for safe review recovery", async () => {
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "preview-refusal-test-owner" } }),
    cookieAction: async () => { throw new Error("Unexpected cookie fallback"); },
    fetch: async () => Response.json({ message: "The project changed. Review it again.", errorCode: "vivary_project_preview_refused" }, { status: 409 }),
    locationHref: () => "https://private.example.test/", nativePath: path => path, invalidate: () => undefined,
  });
  await assert.rejects(call("vivary-project-preview", {}), error => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { errorCode?: string }).errorCode, "vivary_project_preview_refused");
    return true;
  });
});


test("draft keepalive uses the full UTF-8 body budget", async () => {
  const flags: boolean[] = [];
  const call = createNativeActionCaller({
    getSession: () => ({ status: "authenticated", session: { email: "owner@example.test", token: "native-budget-token" } }),
    cookieAction: async () => { throw new Error("Unexpected cookie fallback"); },
    fetch: async (_input, init) => { flags.push(Boolean(init?.keepalive)); return Response.json({ accepted: true }); },
    locationHref: () => "https://private.example.test/agent", nativePath: path => path,
    invalidate: () => undefined,
  });
  await call("vivary-chat-draft", { expected: { text: "a".repeat(32_000) }, next: { text: "a".repeat(32_000) } }, { keepalive: true });
  await call("vivary-chat-draft", { next: { text: "short" } }, { keepalive: true });
  assert.deepEqual(flags, [false, true]);
});
