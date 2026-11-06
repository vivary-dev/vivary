import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNativeSqliteMatchesNode, ensureCorePackageJson, ensureProofRoot } from "./maintained-test-options.mjs";

const TEST_FILE = fileURLToPath(import.meta.url);
const CHILD_HEAP_ARG = "--max-old-space-size=192";
const ACTION_PATH = "/_agent-native/actions/vivary-register-project";
const scenarios = {
  registration: "real native HTTP registration and replay preserve store, caller context and audit",
  duplicates: "raw duplicate, escaped-duplicate and nested JSON keys are rejected before native auth",
  coercion: "HTTP numeric strings and caller authority fields cannot reach native actions",
  encoding: "invalid UTF-8, unpaired Unicode, BOM and malformed JSON are rejected",
  declaredSize: "declared oversized JSON is refused without a registry effect",
  streamedSize: "chunked JSON is limited by actual bytes without hanging the native request",
  protocol: "method and content-type boundaries run before native action dispatch",
  authorization: "native authenticated identity and action authorization remain required",
  paths: "suffix and neighboring paths cannot bypass strict middleware or expose export",
  appBase: "configured app-base and root aliases share the same strict native mount",
};

async function worker(scenario) {
  const progress = (step) => process.stdout.write(`HTTP proof: ${step}\n`);
  register(new URL("./native-http-dependency-loader.mjs", import.meta.url), {
    data: { corePackageJson: process.env.VIVARY_TEST_CORE_PACKAGE_JSON }, // guard:allow-env-credential — Test dependency manifest path; no credential value.
  });
  const { H3, toNodeHandler, createError } = await import("h3");
  progress("H3 loaded");
  const { awaitBootstrap } = await import("@agent-native/core/server");
  progress("native server loaded");
  const { withMigrationRuntime, getDbExec, closeDbExec } = await import("@agent-native/core/db");
  const { migrateRegistry } = await import("../server/db/migrations.mjs");
  const { getDb } = await import("../server/db/index.mjs");
  const tables = await import("../server/db/schema.mjs");
  const { createRegistryActions } = await import("../server/registry-actions.mjs");
  const { mountRegistryHttp } = await import("../server/registry-http.mjs");
  const { parseStrictJson, evaluateRegistryOperation } = await import("../../../scripts/registry_contract_model.mjs");
  const fixture = JSON.parse(await readFile(new URL(
    "../../../docs/product/multi-project/fixtures/project-registry.json", import.meta.url,
  ), "utf8"));
  await withMigrationRuntime(() => migrateRegistry());
  progress("migrations complete");
  const request = { ...structuredClone(fixture.inputs.register.request), expectedRegistryRevision: 0 };
  const json = JSON.stringify(request);
  const token = randomUUID();
  const deniedToken = randomUUID();
  let authenticated = 0;
  let authorized = 0;
  let resolved = 0;
  let allocated = 0;
  const contexts = [];
  const actions = createRegistryActions({
    authorizeContext: async (_operation, context) => {
      authorized++;
      return context.userEmail === "actor-a@example.test" && context.orgId === "collection-a";
    },
    resolveFacts: async (_operation, args, context) => {
      resolved++;
      contexts.push(context);
      const keys = ["actorId", "collectionId", "deviceId", "member", "capabilities",
        "rootAccess", "policyRevision", "root", "overlapSafe"];
      const facts = Object.fromEntries(keys.map((key) =>
        [key, structuredClone(fixture.inputs.register.trusted[key])]));
      facts.actorId = "actor-a";
      facts.collectionId = context.orgId;
      facts.root.locationRef = args.locationRef;
      return facts;
    },
    allocateIds: async () => {
      allocated++;
      return { projectId: "project-http", bindingId: "binding-http" };
    },
    evaluate: evaluateRegistryOperation,
  });
  const nitroApp = { h3: new H3() };
  mountRegistryHttp(nitroApp, { registration: actions.register, parseStrictJson,
    getOwnerFromEvent: async (event) => {
      authenticated++;
      const bearer = event.headers.get("authorization");
      if (bearer === `Bearer ${token}`) return "actor-a@example.test";
      if (bearer === `Bearer ${deniedToken}`) return "actor-denied@example.test";
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    },
    resolveOrgId: async () => "collection-a",
  });
  progress("native registration mounted");
  await awaitBootstrap(nitroApp);
  progress("bootstrap settled");
  assert.equal(actions.register.http, false, "mounting must not mutate the internal entry");
  for (const key of ["agentTool", "mcpTool", "toolCallable"]) assert.equal(actions.register[key], false);
  const server = createServer(toNodeHandler(nitroApp.h3));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  progress("loopback listener ready");
  assert.equal(address.address, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  const call = async ({ body = json, pathname = ACTION_PATH, method = "POST",
    headers = {}, authenticated: withIdentity = true, stream = false } = {}) => {
    const response = await fetch(origin + pathname, { method,
      headers: { "content-type": "application/json",
        ...(withIdentity ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
      ...(stream ? { duplex: "half" } : {}), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    progress(`response ${response.status}`);
    let output;
    try { output = JSON.parse(text); } catch { output = null; }
    return { status: response.status, output, text, contentType: response.headers.get("content-type") };
  };
  const snapshot = () => getDb().transaction(async (tx) => ({
    projects: await tx.select().from(tables.projects),
    bindings: await tx.select().from(tables.bindings),
    receipts: await tx.select().from(tables.receipts),
    revisions: await tx.select().from(tables.revisions),
  }));
  const empty = async () => {
    for (const rows of Object.values(await snapshot())) assert.equal(rows.length, 0);
  };
  const noDispatch = async () => {
    assert.deepEqual([authenticated, authorized, resolved, allocated], [0, 0, 0, 0]);
    await empty();
  };
  try {
    if (scenario === "registration") {
      const accepted = await call();
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.output.code, "registered");
      assert.deepEqual(Object.keys(accepted.output).sort(),
        ["code", "projectId", "bindingId", "bindingRevision", "replayed"].sort());
      assert.match(accepted.contentType, /application\/json/);
      const stored = await snapshot();
      assert.deepEqual(Object.values(stored).map((rows) => rows.length), [1, 1, 1, 1]);
      assert.equal(stored.bindings[0].actorId, "actor-a");
      assert.equal(stored.bindings[0].collectionId, "collection-a");
      assert.ok(contexts.every((ctx) => ctx.userEmail === "actor-a@example.test"
        && ctx.caller === "http" && ctx.appId === "workbench" && Object.isFrozen(ctx)));
      const replay = await call();
      assert.equal(replay.status, 200, replay.text);
      assert.deepEqual(replay.output, { ...accepted.output, replayed: true });
      assert.deepEqual(await snapshot(), stored);
      assert.equal(allocated, 1);
      const audit = await getDbExec().execute("SELECT action, input, visibility FROM agent_audit_log");
      assert.equal(audit.rows.length, 2);
      assert.ok(audit.rows.every((row) => row.action === "vivary-register-project"
        && row.input === null && row.visibility === "private"));
    } else if (scenario === "duplicates") {
      for (const body of [json.replace('"expectedPolicyRevision":1', '"expectedPolicyRevision":1,"expectedPolicyRevision":1'),
        json.replace('"expectedPolicyRevision":1', '"expectedPolicyRevision":1,"expectedPolicy\\u0052evision":1'),
        json.replace(/"contentIdentity":(?:null|\{[^}]+\})/,
          `"contentIdentity":{"algorithm":"sha256","algorithm":"sha256","manifestDigest":"${"a".repeat(64)}"}`)]) {
        const response = await call({ body });
        assert.equal(response.status, 400, response.text);
        assert.ok(!response.text.includes("expectedPolicy") && !response.text.includes("manifestDigest"));
      }
      await noDispatch();
    } else if (scenario === "coercion") {
      for (const patch of [{ expectedPolicyRevision: "1" }, { expectedRegistryRevision: "0" },
        { actorId: "caller-owned" }, { trusted: {} }, { rootAccess: ["caller-owned"] }]) {
        const response = await call({ body: JSON.stringify({ ...request, ...patch }) });
        assert.equal(response.status, 400, response.text);
      }
      await noDispatch();
    } else if (scenario === "encoding") {
      const validTemplate = JSON.stringify({ ...request, displayName: "UTF8_MARKER" });
      const [beforeMarker, afterMarker] = validTemplate.split("UTF8_MARKER");
      const invalidUtf8 = Buffer.concat([Buffer.from(beforeMarker), Buffer.from([0x80]), Buffer.from(afterMarker)]);
      for (const body of [invalidUtf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
        json.replace(/"displayName":"[^"]*"/, '"displayName":"\\ud800"'), "{", json + " trailing", "[]", "null"]) {
        const response = await call({ body });
        assert.equal(response.status, 400, response.text);
      }
      await noDispatch();
    } else if (scenario === "declaredSize") {
      const response = await call({ body: " ".repeat(8193) + json });
      assert.equal(response.status, 413, response.text);
      await noDispatch();
    } else if (scenario === "streamedSize") {
      const body = new ReadableStream({ start(controller) {
        for (let index = 0; index < 3; index++) controller.enqueue(Buffer.from(" ".repeat(4096)));
        controller.enqueue(Buffer.from(json));
        controller.close();
      } });
      const response = await call({ body, stream: true });
      assert.equal(response.status, 413, response.text);
      await noDispatch();
    } else if (scenario === "protocol") {
      for (const options of [{ method: "GET" }, { method: "PUT", headers: { "x-agent-native-frontend": "1" } }]) {
        const response = await call(options);
        assert.equal(response.status, 405, response.text);
      }
      for (const headers of [{ "content-type": "text/plain" }, { "content-encoding": "gzip" }]) {
        const response = await call({ headers });
        assert.equal(response.status, 415, response.text);
      }
      await noDispatch();
    } else if (scenario === "authorization") {
      const missing = await call({ authenticated: false, headers: { "x-actor-id": "actor-a" } });
      // Issue #142. Core once dropped the thrown owner error as a client
      // abort after reading the body and answered 404. It keeps the 401 now.
      assert.equal(missing.status, 401, missing.text);
      const denied = await call({ headers: { authorization: `Bearer ${deniedToken}` } });
      assert.equal(denied.status, 403, denied.text);
      assert.equal(authenticated, 2);
      assert.equal(authorized, 1);
      assert.deepEqual([resolved, allocated], [0, 0]);
      await empty();
    } else if (scenario === "paths") {
      for (const pathname of [ACTION_PATH + "/extra", ACTION_PATH + "-neighbor",
        "/_agent-native/actions/vivary-export-project", ACTION_PATH + "%2Fextra"]) {
        const response = await call({ pathname });
        assert.equal(response.status, 404, response.text);
      }
      await noDispatch();
    } else if (scenario === "appBase") {
      const pathname = "/workbench" + ACTION_PATH;
      const duplicate = json.replace('"expectedPolicyRevision":1', '"expectedPolicyRevision":1,"expectedPolicyRevision":1');
      const rejected = await call({ pathname, body: duplicate });
      assert.equal(rejected.status, 400, rejected.text);
      const suffix = await call({ pathname: pathname + "/extra" });
      assert.equal(suffix.status, 404, suffix.text);
      await noDispatch();
      const accepted = await call({ pathname });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.output.code, "registered");
      const replay = await call();
      assert.equal(replay.status, 200, replay.text);
      assert.deepEqual(replay.output, { ...accepted.output, replayed: true });
      assert.equal(allocated, 1);
    } else throw new Error("Unknown HTTP proof scenario");
  } finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await closeDbExec();
  }
  process.stdout.write("Native HTTP scenario passed.\n");
  process.exitCode = 0;
}

if (process.env.VIVARY_HTTP_WORKER === "1") { // guard:allow-env-credential — Test child mode flag; no credential value.
  try { await worker(process.argv[2]); }
  catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  assertNativeSqliteMatchesNode(ensureCorePackageJson());
  ensureProofRoot("VIVARY_REGISTRY_PROOF_ROOT");
  for (const [scenario, title] of Object.entries(scenarios)) {
    test(title, async () => {
      const configured = process.env.VIVARY_REGISTRY_PROOF_ROOT; // guard:allow-env-credential — Disposable test directory path; no credential value.
      assert.ok(configured && path.isAbsolute(configured), "explicit absolute proof root required");
      const proofRoot = await realpath(configured);
      const caseRoot = await mkdtemp(path.join(proofRoot, "registry-http-"));
      assert.equal(path.dirname(await realpath(caseRoot)), proofRoot);
      const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
        "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
      const env = Object.fromEntries(retained.filter((key) => process.env[key]) // guard:allow-env-credential — Test child receives only the fixed OS launch-path allowlist above.
        .map((key) => [key, process.env[key]])); // guard:allow-env-credential — Test child receives only the fixed OS launch-path allowlist above.
      Object.assign(env, { VIVARY_HTTP_WORKER: "1", NODE_ENV: "test",
        VIVARY_TEST_CORE_PACKAGE_JSON: process.env.VIVARY_TEST_CORE_PACKAGE_JSON, // guard:allow-env-credential — Test dependency manifest path; no credential value.
        DATABASE_URL: `file:${path.join(caseRoot, "registry.sqlite")}`,
        AGENT_NATIVE_DISABLED_PLUGINS: "agent-chat,auth,context-xray,core-routes,integrations,observational-memory,onboarding,org,resources,sentry,terminal",
        ...(scenario === "appBase" ? { APP_BASE_PATH: "/workbench" } : {}),
      });
      try {
        const result = spawnSync(process.execPath, [CHILD_HEAP_ARG, TEST_FILE, scenario], {
          cwd: caseRoot, env, windowsHide: true, encoding: "utf8", timeout: 45000,
          maxBuffer: 1024 * 1024,
        });
        assert.equal(result.error, undefined, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /Native HTTP scenario passed/);
      } finally {
        assert.equal(path.dirname(await realpath(caseRoot)), proofRoot);
        await rm(caseRoot, { recursive: true, force: true });
      }
    });
  }
}
