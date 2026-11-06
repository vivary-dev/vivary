import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNativeSqliteMatchesNode, ensureCorePackageJson, ensureProofRoot } from "./maintained-test-options.mjs";

const TEST_FILE = fileURLToPath(import.meta.url);
const CHILD_HEAP_ARG = "--max-old-space-size=192";
const CHILD_STREAM_MAX_BYTES = 512 * 1024;
const CHILD_AGGREGATE_MAX_BYTES = CHILD_STREAM_MAX_BYTES * 2;
const cases = {
  metadata: "native action metadata disables HTTP, tool, extension and public discovery",
  persistence: "native registration, replay, duplicate and portable export use the same atomic store",
  invalid: "strict same-schema boundary rejects coercion and authority fields before callbacks",
  unicode: "Unicode and nested content identity validation matches the registry request contract",
  context: "missing native identity cannot reach authorization or registry facts",
  authorization: "native authorize requires exactly true and preserves guard failures",
  policy: "current policy refusal is projected without private records",
  revocation: "policy revocation after inserts rolls back through the native action",
  concurrent: "concurrent native invocations retain separate immutable caller contexts",
  projection: "native strict output validation rejects an overbroad trusted producer result",
  vcsConsistency: "native registration enforces duplicate VCS consistency through strict action output",
  audit: "native audit records private metadata without request inputs",
  auditFailure: "native audit failure cannot replace committed registration or receipt replay",
};

async function worker(scenario) {
  register(new URL("./native-action-dependency-loader.mjs", import.meta.url), {
    data: { corePackageJson: process.env.VIVARY_TEST_CORE_PACKAGE_JSON }, // guard:allow-env-credential — Test dependency manifest path; no credential value.
  });
  const { withMigrationRuntime, getDbExec, closeDbExec } = await import("@agent-native/core/db");
  const { migrateRegistry } = await import("../server/db/migrations.mjs");
  const { getDb } = await import("../server/db/index.mjs");
  const tables = await import("../server/db/schema.mjs");
  const { eq } = await import("@agent-native/core/db/schema");
  const { createRegistryActions } = await import("../server/registry-actions.mjs");
  const { evaluateRegistryOperation } = await import("../../../scripts/registry_contract_model.mjs");
  const fixture = JSON.parse(await readFile(new URL(
    "../../../docs/product/multi-project/fixtures/project-registry.json", import.meta.url,
  ), "utf8"));
  await withMigrationRuntime(() => migrateRegistry());
  const request = (patch = {}) => ({ ...structuredClone(fixture.inputs.register.request),
    expectedRegistryRevision: 0, ...patch });
  const context = (patch = {}) => ({ userEmail: "actor-a@example.test", orgId: "collection-a",
    appId: "workbench", caller: "frontend", threadId: "thread-a", ...patch });
  const exportRequest = (projectId) => ({ operationId: "export-a", expectedPolicyRevision: 1, projectId });
  const FACTS = ["actorId", "collectionId", "deviceId", "member", "capabilities",
    "rootAccess", "policyRevision", "root", "overlapSafe"];
  let authorized = 0;
  let resolved = 0;
  let allocated = 0;
  let observedVcs = null;
  const seenContexts = [];
  const actor = (ctx) => ctx.userEmail.split("@")[0];
  const facts = (operation, args, ctx) => {
    const result = Object.fromEntries(FACTS.map((key) =>
      [key, structuredClone(fixture.inputs.register.trusted[key])]));
    result.actorId = actor(ctx);
    result.collectionId = ctx.orgId;
    result.root.rootId = `root-${ctx.orgId}`;
    result.root.locationRef = args.locationRef ?? fixture.inputs.register.request.locationRef;
    if (observedVcs !== null) result.root.vcs = structuredClone(observedVcs);
    result.rootAccess = [result.root.rootId];
    return result;
  };
  const make = (overrides = {}) => createRegistryActions({
    authorizeContext: async (_operation, ctx) => {
      authorized++;
      return ctx.userEmail.endsWith("@example.test");
    },
    resolveFacts: async (operation, args, ctx) => {
      resolved++;
      seenContexts.push(ctx);
      return facts(operation, args, ctx);
    },
    allocateIds: async (ctx) => {
      allocated++;
      return { projectId: `project-${actor(ctx)}-${ctx.orgId}`,
        bindingId: `binding-${actor(ctx)}-${ctx.orgId}` };
    },
    evaluate: evaluateRegistryOperation, ...overrides,
  });
  const snapshot = () => getDb().transaction(async (tx) => ({
    projects: await tx.select().from(tables.projects),
    bindings: await tx.select().from(tables.bindings),
    receipts: await tx.select().from(tables.receipts),
    revisions: await tx.select().from(tables.revisions),
  }));
  const empty = async () => {
    for (const rows of Object.values(await snapshot())) assert.equal(rows.length, 0);
  };
  const invalid = { name: "RegistryActionInputError", statusCode: 400,
    message: "Invalid registry action request" };
  const forbidden = { name: "ForbiddenError", statusCode: 403 };
  const outputError = (error) => /output/i.test(error.name + error.message);

  if (scenario === "metadata") {
    const actions = make();
    assert.ok(Object.isFrozen(actions));
    for (const [name, action] of Object.entries(actions)) {
      assert.ok(Object.isFrozen(action));
      for (const field of ["http", "agentTool", "mcpTool", "toolCallable"]) assert.equal(action[field], false);
      assert.equal(action.publicAgent, undefined);
      assert.equal(action.outputErrorStrategy, "strict");
      assert.equal(action.readOnly, name === "exportProject");
      assert.equal(action.audit.recordInputs, false);
      assert.equal(action.audit.target().visibility, "private");
      assert.equal(action.schema.safeParse(request()).success, name === "register");
      assert.equal(action.tool.parameters.additionalProperties, false);
    }
    assert.deepEqual(Object.keys(actions).sort(),
      ["exportProject", "mutationAdmission", "mutationQuarantine", "register"]);
    // Registry actions are composed in server/registry-actions.mjs and mounted only
    // by registry-http.mjs. Core discovers the app actions folder on its own, so a
    // same-named file there would expose a registry action; assert absence by name.
    const registryActionNames = ["vivary-register-project", "vivary-export-project",
      "vivary-admit-project-mutation", "vivary-quarantine-project-mutation"];
    const discovered = new Set((await readdir(new URL("../actions/", import.meta.url)))
      .map((file) => path.parse(file).name));
    for (const name of registryActionNames) {
      assert.ok(!discovered.has(name), `${name} must not be discoverable from the app actions folder`);
    }
    await empty();
  } else if (scenario === "persistence") {
    const actions = make();
    const accepted = await actions.register.run(request(), context());
    assert.deepEqual(Object.keys(accepted).sort(),
      ["code", "projectId", "bindingId", "bindingRevision", "replayed"].sort());
    assert.equal(accepted.code, "registered");
    assert.equal(allocated, 1);
    const initial = await snapshot();
    assert.deepEqual(Object.values(initial).map((rows) => rows.length), [1, 1, 1, 1]);
    assert.deepEqual(await actions.register.run(request(), context()), { ...accepted, replayed: true });
    assert.equal(allocated, 1);
    assert.deepEqual(await snapshot(), initial);
    const duplicate = await actions.register.run(request({ operationId: "op-duplicate",
      expectedRegistryRevision: 1 }), context());
    assert.deepEqual(duplicate, { ...accepted, code: "already-registered", replayed: false });
    assert.equal(allocated, 1);
    const afterDuplicate = await snapshot();
    assert.deepEqual(afterDuplicate.projects, initial.projects);
    assert.deepEqual(afterDuplicate.bindings, initial.bindings);
    assert.equal(afterDuplicate.receipts.length, 2);
    assert.equal(afterDuplicate.revisions[0].revision, 2);
    const exported = await actions.exportProject.run(exportRequest(accepted.projectId), context());
    assert.deepEqual(exported, { code: "exported", project: { schemaVersion: 1,
      projectId: accepted.projectId, displayName: request().displayName, contentIdentity: request().contentIdentity } });
    assert.deepEqual(await actions.exportProject.run(exportRequest(accepted.projectId),
      context({ userEmail: "actor-b@example.test" })), { code: "binding-unavailable" });
    assert.deepEqual(await snapshot(), afterDuplicate);
  } else if (scenario === "invalid") {
    const actions = make();
    const invalidRequests = [null, [], JSON.stringify(request()),
      request({ expectedPolicyRevision: "1" }), request({ expectedRegistryRevision: "0" }),
      request({ expectedRegistryRevision: 0.1 }), request({ expectedPolicyRevision: 0 }),
      request({ expectedRegistryRevision: Number.MAX_SAFE_INTEGER + 1 }),
      request({ locationRef: "../outside" }), request({ operationId: "" }),
      request({ actorId: "caller-owned" }), request({ trusted: {} }),
      request({ rootAccess: ["caller-root"] }), request({ unknown: true })];
    for (const malformed of invalidRequests) {
      const original = structuredClone(malformed);
      await assert.rejects(actions.register.run(malformed, context()), invalid);
      assert.deepEqual(malformed, original);
    }
    await assert.rejects(actions.exportProject.run({ ...exportRequest("project-a"),
      expectedPolicyRevision: "1" }, context()), invalid);
    await assert.rejects(actions.exportProject.run({ ...exportRequest("project-a"),
      actorId: "caller-owned" }, context()), invalid);
    assert.deepEqual([authorized, resolved, allocated], [0, 0, 0]);
    await empty();
  } else if (scenario === "unicode") {
    const action = make().register;
    for (const patch of [{ displayName: "" }, { displayName: "x".repeat(201) },
      { displayName: "\ud800" }, { contentIdentity: { algorithm: "sha1", manifestDigest: "a".repeat(64) } },
      { contentIdentity: { algorithm: "sha256", manifestDigest: "A".repeat(64) } },
      { contentIdentity: { algorithm: "sha256", manifestDigest: "a".repeat(64), locator: "private" } }]) {
      await assert.rejects(action.run(request(patch), context()), invalid);
    }
    assert.deepEqual([authorized, resolved, allocated], [0, 0, 0]);
    const accepted = await action.run(request({ displayName: "\u{1f331}".repeat(200) }), context());
    assert.equal(accepted.code, "registered");
  } else if (scenario === "context") {
    const actions = make();
    for (const missing of [undefined, null, {}, context({ userEmail: "" }),
      context({ orgId: null }), context({ caller: "" })]) {
      await assert.rejects(actions.register.run(request(), missing), forbidden);
    }
    assert.deepEqual([authorized, resolved, allocated], [0, 0, 0]);
    await empty();
  } else if (scenario === "authorization") {
    for (const verdict of [false, undefined, null, "yes", 1]) {
      const actions = make({ authorizeContext: async () => verdict });
      await assert.rejects(actions.register.run(request(), context()), forbidden);
    }
    const denied = new Error("fixture authorization failure");
    await assert.rejects(make({ authorizeContext: async () => { throw denied; } })
      .register.run(request(), context()), (error) => error === denied);
    assert.deepEqual([resolved, allocated], [0, 0]);
    await empty();
  } else if (scenario === "policy") {
    const actions = make({ resolveFacts: async (operation, args, ctx) =>
      ({ ...facts(operation, args, ctx), member: false }) });
    assert.deepEqual(await actions.register.run(request(), context()), { code: "denied" });
    assert.equal(allocated, 0);
    await empty();
  } else if (scenario === "revocation") {
    const actions = make({ resolveFacts: async (operation, args, ctx) => {
      resolved++;
      return { ...facts(operation, args, ctx), member: resolved < 3 };
    } });
    assert.deepEqual(await actions.register.run(request(), context()), { code: "denied" });
    assert.equal(allocated, 1);
    await empty();
  } else if (scenario === "concurrent") {
    const actions = make({ resolveFacts: async (operation, args, ctx) => {
      assert.ok(Object.isFrozen(ctx));
      assert.equal(ctx.actorId, undefined);
      assert.equal(ctx.rootAccess, undefined);
      seenContexts.push(ctx);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return facts(operation, args, ctx);
    } });
    const firstContext = context({ actorId: "injected", rootAccess: ["injected"] });
    const first = actions.register.run(request(), firstContext);
    firstContext.userEmail = "changed@example.test";
    firstContext.orgId = "changed";
    const secondContext = context({ userEmail: "actor-b@example.test", orgId: "collection-b" });
    const outputs = await Promise.all([first, actions.register.run(request(), secondContext)]);
    assert.deepEqual(outputs.map((value) => value.projectId),
      ["project-actor-a-collection-a", "project-actor-b-collection-b"]);
    const stored = await snapshot();
    assert.deepEqual(stored.bindings.map((value) => [value.actorId, value.collectionId]).sort(),
      [["actor-a", "collection-a"], ["actor-b", "collection-b"]]);
    assert.equal(new Set(seenContexts).size, 2);
    assert.ok(seenContexts.every((ctx) => ctx.orgId !== "changed"));
  } else if (scenario === "projection") {
    const actions = make({ evaluate: () => ({ output: { code: "denied", privateState: "fixture-private" },
      effects: [], recordChanges: {} }) });
    await assert.rejects(actions.register.run(request(), context()),
      outputError);
    assert.equal(allocated, 0);
    await empty();
  } else if (scenario === "vcsConsistency") {
    observedVcs = {
      kind: "git", repositoryId: "repository-a", checkoutId: "checkout-a", mutationOwner: "git",
    };
    const actions = make();
    const accepted = await actions.register.run(request(), context());
    assert.equal(accepted.code, "registered");
    const initial = await snapshot();
    const expectedRow = initial.bindings[0];
    const [selectedRow] = await getDb().select().from(tables.bindings)
      .where(eq(tables.bindings.bindingId, expectedRow.bindingId));
    assert.deepEqual(selectedRow, expectedRow,
      "synthetic binding VCS replacement requires the exact selected row");
    await getDb().update(tables.bindings).set({ checkoutId: "checkout-recreated" })
      .where(eq(tables.bindings.bindingId, expectedRow.bindingId));
    const before = await snapshot();
    const staleRequest = request({ operationId: "op-duplicate-stale-vcs", expectedRegistryRevision: 0 });
    const allocationsBefore = allocated;
    const refused = await actions.register.run(staleRequest, context());
    const after = await snapshot();
    const mismatchAllocatorCalls = allocated - allocationsBefore;
    assert.deepEqual(refused, { code: "stale-binding" });
    assert.equal(mismatchAllocatorCalls, 0);
    assert.deepEqual(after, before);

    const exactStale = () => ({ output: { code: "stale-binding" }, effects: [], recordChanges: {} });
    assert.deepEqual(await make({ evaluate: exactStale }).register.run(request({
      operationId: "strict-stale-binding",
    }), context()), { code: "stale-binding" });
    const privateStale = make({ evaluate: () => ({
      output: { code: "stale-binding", privateState: "fixture-private" },
      effects: [], recordChanges: {},
    }) });
    await assert.rejects(privateStale.register.run(request({ operationId: "private-stale-binding" }), context()),
      outputError);
    await assert.rejects(make({ evaluate: exactStale }).exportProject
      .run(exportRequest(accepted.projectId), context()), outputError);
    assert.deepEqual(await snapshot(), before);

    process.stdout.write(`VIVARY_REGISTRY_ACTION_WITNESS ${JSON.stringify({
      schemaVersion: 1,
      suite: "registry-actions",
      caseCount: 1,
      childProcess: {
        execArgv: [CHILD_HEAP_ARG],
        stdoutMaxBytes: CHILD_STREAM_MAX_BYTES,
        stderrMaxBytes: CHILD_STREAM_MAX_BYTES,
        aggregateMaxBytes: CHILD_AGGREGATE_MAX_BYTES,
      },
      cases: [{
        id: "native-action-duplicate-binding-vcs-mismatch",
        setup: { kind: "synthetic-binding-vcs-replacement", expectedRow,
          replacementVcs: { ...observedVcs, checkoutId: "checkout-recreated" },
          expectedRegistryRevisionAlsoStale: true },
        request: staleRequest,
        output: refused,
        allocatorCalls: mismatchAllocatorCalls,
        before,
        after,
      }],
      strictValidation: {
        acceptedRegistrationRefusal: { code: "stale-binding" },
        registrationPrivateFieldRejected: true,
        exportStaleBindingRejected: true,
      },
    })}\n`);
  } else if (scenario === "audit") {
    await make().register.run(request(), context());
    const result = await getDbExec().execute("SELECT action, input, visibility, status FROM agent_audit_log");
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], { action: "vivary-register-project", input: null,
      visibility: "private", status: "success" });
  } else if (scenario === "auditFailure") {
    const actions = make();
    await actions.register.run(request(), context());
    await getDbExec().execute("CREATE TRIGGER fixture_audit_abort BEFORE INSERT ON agent_audit_log BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    const other = context({ userEmail: "actor-b@example.test", orgId: "collection-b" });
    const accepted = await actions.register.run(request(), other);
    assert.equal(accepted.code, "registered");
    const stored = await snapshot();
    assert.deepEqual(Object.values(stored).map((rows) => rows.length), [2, 2, 2, 2]);
    assert.deepEqual(await actions.register.run(request(), other), { ...accepted, replayed: true });
    assert.deepEqual(await snapshot(), stored);
    const audit = await getDbExec().execute("SELECT count(*) AS count FROM agent_audit_log");
    assert.equal(audit.rows[0].count, 1);
  } else {
    throw new Error("Unknown bounded proof scenario");
  }
  await closeDbExec();
  process.stdout.write("Native action scenario passed.\n");
  process.exit(0);
}

if (process.env.VIVARY_ACTION_WORKER === "1") { // guard:allow-env-credential — Test child mode flag; no credential value.
  await worker(process.argv[2]);
} else {
  assertNativeSqliteMatchesNode(ensureCorePackageJson());
  ensureProofRoot("VIVARY_REGISTRY_PROOF_ROOT");
  for (const [scenario, title] of Object.entries(cases)) {
    test(title, async () => {
      const configured = process.env.VIVARY_REGISTRY_PROOF_ROOT; // guard:allow-env-credential — Disposable test directory path; no credential value.
      assert.ok(configured && path.isAbsolute(configured), "explicit absolute proof root required");
      const proofRoot = await realpath(configured);
      const caseRoot = await mkdtemp(path.join(proofRoot, "registry-action-"));
      assert.equal(path.dirname(await realpath(caseRoot)), proofRoot);
      const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
        "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
      const env = Object.fromEntries(retained.filter((key) => process.env[key]) // guard:allow-env-credential — Test child receives only the fixed OS launch-path allowlist above.
        .map((key) => [key, process.env[key]])); // guard:allow-env-credential — Test child receives only the fixed OS launch-path allowlist above.
      Object.assign(env, { VIVARY_ACTION_WORKER: "1", NODE_ENV: "test",
        VIVARY_TEST_CORE_PACKAGE_JSON: process.env.VIVARY_TEST_CORE_PACKAGE_JSON, // guard:allow-env-credential — Test dependency manifest path; no credential value.
        DATABASE_URL: `file:${path.join(caseRoot, "registry.sqlite")}` });
      try {
        const result = spawnSync(process.execPath, [CHILD_HEAP_ARG, TEST_FILE, scenario], {
          cwd: caseRoot, env, windowsHide: true, encoding: "utf8", timeout: 45000,
          maxBuffer: CHILD_STREAM_MAX_BYTES,
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /Native action scenario passed/);
        const witness = result.stdout.split(/\r?\n/)
          .find((line) => line.startsWith("VIVARY_REGISTRY_ACTION_WITNESS "));
        if (witness) process.stdout.write(`${witness}\n`);
      } finally {
        assert.equal(path.dirname(await realpath(caseRoot)), proofRoot);
        await rm(caseRoot, { recursive: true, force: true });
      }
    });
  }
}
