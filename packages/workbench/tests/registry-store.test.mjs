import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNativeSqliteMatchesNode, ensureCorePackageJson, ensureProofRoot } from "./maintained-test-options.mjs";

const TEST_FILE = fileURLToPath(import.meta.url);
const CHILD_HEAP_ARG = "--max-old-space-size=192";
const CHILD_STREAM_MAX_BYTES = 512 * 1024;
const CHILD_AGGREGATE_MAX_BYTES = CHILD_STREAM_MAX_BYTES * 2;
const activeChildren = new Map();
const fixture = JSON.parse(await readFile(new URL(
  "../../../docs/product/multi-project/fixtures/project-registry.json", import.meta.url,
), "utf8"));
const request = (patch = {}) => ({ ...fixture.inputs.register.request,
  expectedRegistryRevision: 0, ...patch });
const exactRefusal = (code) => ({ output: { code }, effects: [], recordChanges: {} });
const exportRequest = (projectId = "project-new") => ({
  operationId: "op-export", expectedPolicyRevision: 1, projectId,
});
const proofWitness = {
  schemaVersion: 1,
  suite: "registry-store",
  childProcess: {
    execArgv: [CHILD_HEAP_ARG],
    stdoutMaxBytes: CHILD_STREAM_MAX_BYTES,
    stderrMaxBytes: CHILD_STREAM_MAX_BYTES,
    aggregateMaxBytes: CHILD_AGGREGATE_MAX_BYTES,
  },
  cases: [],
};

async function worker() {
  register(new URL("./native-dependency-loader.mjs", import.meta.url), {
    data: { corePackageJson: process.env.VIVARY_TEST_CORE_PACKAGE_JSON }, // guard:allow-env-credential — Test dependency manifest path; no credential value.
  });
  const { withMigrationRuntime, getDbExec, closeDbExec } = await import("@agent-native/core/db");
  const { migrateRegistry } = await import("../server/db/migrations.mjs");
  const { getDb } = await import("../server/db/index.mjs");
  const schema = await import("../server/db/schema.mjs");
  const { eq } = await import("@agent-native/core/db/schema");
  const { createRegistryStore } = await import("../server/registry-store.mjs");
  const { evaluateRegistryOperation } = await import("../../../scripts/registry_contract_model.mjs");
  process.send({ type: "ready" });
  const payload = await new Promise((resolve) => process.once("message", resolve));
  if (payload.migrate) await withMigrationRuntime(() => migrateRegistry());
  if (payload.fixtureVcsReplacement) {
    const setup = payload.fixtureVcsReplacement;
    const target = setup.target === "receipt" ? schema.receipts
      : setup.target === "binding" ? schema.bindings : null;
    assert.ok(target, "fixture VCS replacement target is bounded");
    const key = setup.target === "receipt" ? schema.receipts.receiptKey : schema.bindings.bindingId;
    const value = setup.target === "receipt" ? setup.expectedRow.receiptKey : setup.expectedRow.bindingId;
    const [current] = await getDb().select().from(target).where(eq(key, value));
    assert.deepEqual(current, setup.expectedRow, "fixture VCS replacement requires the exact selected row");
    if (setup.target === "receipt") {
      const record = JSON.parse(current.record);
      record.vcs = structuredClone(setup.vcs);
      await getDb().update(target).set({ record: JSON.stringify(record) }).where(eq(key, value));
    } else {
      await getDb().update(target).set({
        vcsKind: setup.vcs.kind,
        repositoryId: setup.vcs.repositoryId,
        checkoutId: setup.vcs.checkoutId,
        mutationOwner: setup.vcs.mutationOwner,
        jjRepositoryId: setup.vcs.jjRepositoryId ?? null,
        jjWorkspaceId: setup.vcs.jjWorkspaceId ?? null,
      }).where(eq(key, value));
    }
  }
  if (payload.trigger) {
    const table = { project: "projects", binding: "bindings", receipt: "receipts", revision: "revisions" }[payload.trigger];
    assert.ok(table);
    await getDbExec().execute(`CREATE TRIGGER fixture_abort BEFORE INSERT ON vivary_registry_${table}
      BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  }
  const FACTS = ["actorId", "collectionId", "deviceId", "member", "capabilities",
    "rootAccess", "policyRevision", "root", "overlapSafe"];
  let resolutions = 0;
  let allocations = 0;
  const facts = { ...Object.fromEntries(FACTS.map((key) => [key, fixture.inputs.register.trusted[key]])),
    ...payload.factsPatch };
  const store = createRegistryStore({
    evaluate: evaluateRegistryOperation,
    resolveFacts: async () => {
      resolutions++;
      if (payload.revokeAfter === resolutions) return { ...facts, member: false };
      return facts;
    },
    allocateIds: async () => {
      allocations++;
      return payload.allocation ?? { projectId: "project-new", bindingId: "binding-new" };
    },
  });
  let value;
  if (payload.action === "register") {
    try {
      value = { decision: await store.register(payload.request), allocations };
    } catch (error) {
      if (!payload.expectFailure) throw error;
      value = { failed: true, errorCode: error.cause?.code ?? error.code ?? error.name };
    }
  } else if (payload.action === "export") {
    value = { decision: await store.exportProject(payload.request), allocations };
  } else if (payload.action === "parallel") {
    value = await Promise.all(payload.requests.map((item) => store.register(item)));
  } else if (payload.action !== "snapshot") {
    throw new Error("unsupported proof action");
  }
  if (payload.action === "snapshot" || payload.snapshot) {
    const snapshot = await getDb().transaction(async (tx) => ({
      projects: await tx.select().from(schema.projects),
      bindings: await tx.select().from(schema.bindings),
      receipts: await tx.select().from(schema.receipts),
      revisions: await tx.select().from(schema.revisions),
    }));
    value = { ...value, snapshot };
  }
  await closeDbExec();
  await new Promise((resolve, reject) => process.send({ type: "result", value },
    (error) => error ? reject(error) : resolve()));
  // The transaction is settled. Process exit closes the Core-owned Drizzle
  // connection; no unsupported private connection-close hook is called.
  process.exit(0);
}

function startWorker(directory) {
  const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
  const env = Object.fromEntries(retained.filter((key) => process.env[key]).map((key) => [key, process.env[key]])); // guard:allow-env-credential — Test child receives only the fixed OS launch-path allowlist above.
  Object.assign(env, {
    VIVARY_REGISTRY_WORKER: "1",
    VIVARY_TEST_CORE_PACKAGE_JSON: process.env.VIVARY_TEST_CORE_PACKAGE_JSON, // guard:allow-env-credential — Test dependency manifest path; no credential value.
    DATABASE_URL: `file:${path.join(directory, "registry.sqlite")}`,
    NODE_ENV: "test",
  });
  const child = fork(TEST_FILE, [], { cwd: directory, env, execArgv: [CHILD_HEAP_ARG], windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const owned = activeChildren.get(directory) ?? new Set();
  activeChildren.set(directory, owned);
  const record = { child, closed: null };
  record.closed = new Promise((resolve) => child.once("close", () => {
    owned.delete(record);
    resolve();
  }));
  owned.add(record);
  let diagnostic = "";
  let outputLimit;
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      diagnostic = (diagnostic + chunk.toString()).slice(-16000);
      if (bytes > CHILD_STREAM_MAX_BYTES && outputLimit === undefined) {
        outputLimit = name;
        child.kill();
      }
    });
  }
  let received;
  let sent = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("proof worker exceeded 30 seconds")); }, 30000);
    child.on("message", (message) => {
      if (message.type === "ready") readyResolve();
      else if (message.type === "result") received = message.value;
    });
    child.on("error", (error) => { clearTimeout(timeout); readyReject(error); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || received === undefined || outputLimit !== undefined) {
        const detail = outputLimit === undefined ? diagnostic
          : `${outputLimit} exceeded ${CHILD_STREAM_MAX_BYTES} bytes`;
        const error = new Error(`proof worker failed (${code}): ${detail}`);
        readyReject(error);
        reject(error);
      } else resolve(received);
    });
  });
  // Attach a rejection handler before a worker can fail during imports.
  completion.catch(() => {});
  return { ready, completion, send(payload) { assert.equal(sent, false); sent = true; child.send(payload); } };
}

async function run(directory, payload) {
  const child = startWorker(directory);
  await child.ready;
  child.send(payload);
  return child.completion;
}

async function sandbox(check) {
  assert.ok(process.env.VIVARY_TEST_CORE_PACKAGE_JSON, "set the explicit existing native dependency root"); // guard:allow-env-credential — Test dependency manifest path; no credential value.
  const configuredRoot = process.env.VIVARY_REGISTRY_PROOF_ROOT; // guard:allow-env-credential — Disposable test directory path; no credential value.
  assert.ok(configuredRoot && path.isAbsolute(configuredRoot), "set an absolute task-owned proof root");
  const proofRoot = await realpath(configuredRoot);
  const directory = await mkdtemp(path.join(proofRoot, "case-"));
  try { await check(directory); }
  finally {
    const remaining = [...(activeChildren.get(directory) ?? [])];
    for (const { child } of remaining) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(remaining.map((record) => record.closed));
    activeChildren.delete(directory);
    const resolved = await realpath(directory);
    const relative = path.relative(proofRoot, resolved);
    assert.equal(path.dirname(relative), ".");
    assert.ok(path.basename(relative).startsWith("case-") && !path.isAbsolute(relative));
    await rm(resolved, { recursive: true, force: true });
  }
}

function empty(snapshot) {
  for (const rows of Object.values(snapshot)) assert.deepEqual(rows, []);
}

const gitVcs = (checkoutId = "checkout-a") => ({
  kind: "git", repositoryId: "repository-a", checkoutId, mutationOwner: "git",
});
const gitFacts = (vcs = gitVcs()) => ({
  root: { ...structuredClone(fixture.inputs.register.trusted.root), vcs: structuredClone(vcs) },
});
const rememberProofCase = (entry) => proofWitness.cases.push(structuredClone(entry));

if (process.env.VIVARY_REGISTRY_WORKER === "1") { // guard:allow-env-credential — Test child mode flag; no credential value.
  await worker();
} else {
  assertNativeSqliteMatchesNode(ensureCorePackageJson());
  ensureProofRoot("VIVARY_REGISTRY_PROOF_ROOT");
  test("native migrations are repeatable and an unopened registry has no product records", async () => sandbox(async (dir) => {
    empty((await run(dir, { migrate: true, action: "snapshot" })).snapshot);
    empty((await run(dir, { migrate: true, action: "snapshot" })).snapshot);
  }));

  test("file-backed registration survives process exit and exports only portable fields", async () => sandbox(async (dir) => {
    const created = await run(dir, { migrate: true, action: "register", request: request(), snapshot: true });
    assert.equal(created.decision.output.code, "registered");
    assert.equal(created.snapshot.projects.length, 1);
    assert.equal(created.snapshot.bindings.length, 1);
    assert.equal(created.snapshot.receipts.length, 1);
    assert.equal(created.snapshot.revisions[0].revision, 1);
    const reopened = await run(dir, { action: "export", request: exportRequest(), snapshot: true });
    assert.deepEqual(reopened.decision.output, { code: "exported", project: {
      schemaVersion: 1, projectId: "project-new", displayName: "Example project", contentIdentity: null,
    } });
    assert.deepEqual(reopened.snapshot, created.snapshot);
  }));

  for (const trigger of ["project", "binding", "receipt", "revision"]) {
    test(`native failure before ${trigger} insert rolls back every registry record`, async () => sandbox(async (dir) => {
      const failed = await run(dir, { migrate: true, trigger, action: "register", request: request(),
        expectFailure: true, snapshot: true });
      assert.equal(failed.failed, true);
      empty(failed.snapshot);
      empty((await run(dir, { action: "snapshot" })).snapshot);
    }));
  }

  test("completed replay survives restart without allocation, writes or revision reset", async () => sandbox(async (dir) => {
    const first = await run(dir, { migrate: true, action: "register", request: request(), snapshot: true });
    const second = await run(dir, { action: "register", request: request(), snapshot: true });
    assert.equal(second.decision.output.replayed, true);
    assert.equal(second.allocations, 0);
    assert.deepEqual(second.decision.effects, []);
    assert.deepEqual(second.snapshot, first.snapshot);
  }));

  test("native replay refuses an exact stored receipt VCS mismatch without writes or allocation", async () => sandbox(async (dir) => {
    const currentVcs = gitVcs();
    const created = await run(dir, { migrate: true, action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.equal(created.decision.output.code, "registered");
    const setup = {
      kind: "synthetic-receipt-vcs-replacement",
      target: "receipt",
      expectedRow: created.snapshot.receipts[0],
      vcs: gitVcs("checkout-recreated"),
    };
    const before = (await run(dir, { action: "snapshot", fixtureVcsReplacement: setup })).snapshot;
    const attempted = await run(dir, { action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.deepEqual(attempted.decision, exactRefusal("superseded-operation"));
    assert.equal(attempted.allocations, 0);
    assert.deepEqual(attempted.snapshot, before);
    rememberProofCase({
      id: "native-replay-receipt-vcs-mismatch",
      setup: { kind: setup.kind, target: setup.target, expectedRow: setup.expectedRow,
        replacementVcs: setup.vcs },
      request: request(),
      decision: attempted.decision,
      allocatorCalls: attempted.allocations,
      before,
      after: attempted.snapshot,
    });
  }));

  test("native replay refuses an exact current binding VCS mismatch without writes or allocation", async () => sandbox(async (dir) => {
    const currentVcs = gitVcs();
    const created = await run(dir, { migrate: true, action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.equal(created.decision.output.code, "registered");
    const setup = {
      kind: "synthetic-binding-vcs-replacement",
      target: "binding",
      expectedRow: created.snapshot.bindings[0],
      vcs: gitVcs("checkout-recreated"),
    };
    const before = (await run(dir, { action: "snapshot", fixtureVcsReplacement: setup })).snapshot;
    const attempted = await run(dir, { action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.deepEqual(attempted.decision, exactRefusal("superseded-operation"));
    assert.equal(attempted.allocations, 0);
    assert.deepEqual(attempted.snapshot, before);
    rememberProofCase({
      id: "native-replay-binding-vcs-mismatch",
      setup: { kind: setup.kind, target: setup.target, expectedRow: setup.expectedRow,
        replacementVcs: setup.vcs },
      request: request(),
      decision: attempted.decision,
      allocatorCalls: attempted.allocations,
      before,
      after: attempted.snapshot,
    });
  }));

  test("native replay refuses a changed current observed-root VCS without writes or allocation", async () => sandbox(async (dir) => {
    const savedVcs = gitVcs();
    const currentVcs = gitVcs("checkout-recreated");
    const created = await run(dir, { migrate: true, action: "register", request: request(),
      factsPatch: gitFacts(savedVcs), snapshot: true });
    assert.equal(created.decision.output.code, "registered");
    const before = created.snapshot;
    const attempted = await run(dir, { action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.deepEqual(attempted.decision, exactRefusal("superseded-operation"));
    assert.equal(attempted.allocations, 0);
    assert.deepEqual(attempted.snapshot, before);
    rememberProofCase({
      id: "native-replay-observed-root-vcs-mismatch",
      setup: { kind: "synthetic-current-root-vcs-observation", savedVcs, currentVcs },
      request: request(),
      decision: attempted.decision,
      allocatorCalls: attempted.allocations,
      before,
      after: attempted.snapshot,
    });
  }));

  test("native duplicate refuses an exact stored binding VCS mismatch before stale revision", async () => sandbox(async (dir) => {
    const currentVcs = gitVcs();
    const created = await run(dir, { migrate: true, action: "register", request: request(),
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.equal(created.decision.output.code, "registered");
    const setup = {
      kind: "synthetic-binding-vcs-replacement",
      target: "binding",
      expectedRow: created.snapshot.bindings[0],
      vcs: gitVcs("checkout-recreated"),
    };
    const before = (await run(dir, { action: "snapshot", fixtureVcsReplacement: setup })).snapshot;
    const staleRequest = request({ operationId: "op-duplicate-stale-vcs", expectedRegistryRevision: 0 });
    const attempted = await run(dir, { action: "register", request: staleRequest,
      factsPatch: gitFacts(currentVcs), snapshot: true });
    assert.deepEqual(attempted.decision, exactRefusal("stale-binding"));
    assert.equal(attempted.allocations, 0);
    assert.deepEqual(attempted.snapshot, before);
    rememberProofCase({
      id: "native-duplicate-binding-vcs-mismatch",
      setup: { kind: setup.kind, target: setup.target, expectedRow: setup.expectedRow,
        replacementVcs: setup.vcs, expectedRegistryRevisionAlsoStale: true },
      request: staleRequest,
      decision: attempted.decision,
      allocatorCalls: attempted.allocations,
      before,
      after: attempted.snapshot,
    });
  }));

  test("changed same-key request conflicts and a new-key duplicate advances only its receipt", async () => sandbox(async (dir) => {
    const first = await run(dir, { migrate: true, action: "register", request: request(), snapshot: true });
    const conflict = await run(dir, { action: "register", request: request({ displayName: "Changed" }), snapshot: true });
    assert.equal(conflict.decision.output.code, "operation-conflict");
    assert.deepEqual(conflict.snapshot, first.snapshot);
    const duplicate = await run(dir, { action: "register", request: request({ operationId: "op-duplicate", expectedRegistryRevision: 1 }), snapshot: true });
    assert.equal(duplicate.decision.output.code, "already-registered");
    assert.equal(duplicate.allocations, 0);
    assert.deepEqual(duplicate.snapshot.projects, first.snapshot.projects);
    assert.deepEqual(duplicate.snapshot.bindings, first.snapshot.bindings);
    assert.equal(duplicate.snapshot.receipts.length, 2);
    assert.equal(duplicate.snapshot.revisions[0].revision, 2);
  }));

  test("foreign actor cannot register the same scoped root or export its binding", async () => sandbox(async (dir) => {
    const first = await run(dir, { migrate: true, action: "register", request: request(), snapshot: true });
    const denied = await run(dir, { action: "register", request: request({ operationId: "foreign", expectedRegistryRevision: 1 }),
      factsPatch: { actorId: "foreign-actor" }, snapshot: true });
    assert.equal(denied.decision.output.code, "denied");
    assert.deepEqual(denied.snapshot, first.snapshot);
    const hidden = await run(dir, { action: "export", request: exportRequest(), factsPatch: { actorId: "foreign-actor" } });
    assert.deepEqual(hidden.decision.output, { code: "binding-unavailable" });
  }));

  test("revocation after inserts causes transaction rollback", async () => sandbox(async (dir) => {
    const denied = await run(dir, { migrate: true, action: "register", request: request(), revokeAfter: 3, snapshot: true });
    assert.equal(denied.decision.output.code, "denied");
    empty(denied.snapshot);
    empty((await run(dir, { action: "snapshot" })).snapshot);
  }));

  test("allocation collision cannot overwrite existing portable records", async () => sandbox(async (dir) => {
    const first = await run(dir, { migrate: true, action: "register", request: request(), snapshot: true });
    const root = { ...fixture.inputs.register.trusted.root, rootId: "root-other" };
    const conflict = await run(dir, { action: "register", request: request({ operationId: "op-other", expectedRegistryRevision: 1 }),
      factsPatch: { root, rootAccess: ["root-other"] }, snapshot: true });
    assert.equal(conflict.decision.output.code, "allocation-conflict");
    assert.deepEqual(conflict.snapshot, first.snapshot);
  }));

  test("parallel transactions on one native connection converge through receipt replay", async () => sandbox(async (dir) => {
    const decisions = await run(dir, { migrate: true, action: "parallel", requests: [request(), request()] });
    assert.deepEqual(decisions.map((item) => item.output.replayed).sort(), [false, true]);
    const { snapshot } = await run(dir, { action: "snapshot" });
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.receipts.length, 1);
    assert.equal(snapshot.revisions[0].revision, 1);
  }));

  for (const sameOperation of [false, true]) {
    test(`independent process contenders ${sameOperation ? "replay one operation" : "reject a stale competing revision"}`, async () => sandbox(async (dir) => {
      await run(dir, { migrate: true, action: "snapshot" });
      const children = [startWorker(dir), startWorker(dir)];
      await Promise.all(children.map((child) => child.ready));
      children.forEach((child, index) => child.send({ action: "register",
        request: request({ operationId: sameOperation ? "shared-op" : `contender-${index}` }),
        allocation: { projectId: `project-${index}`, bindingId: `binding-${index}` },
      }));
      const results = await Promise.all(children.map((child) => child.completion));
      if (sameOperation) {
        assert.deepEqual(results.map((item) => item.decision.output.replayed).sort(), [false, true]);
        assert.equal(results[0].decision.output.projectId, results[1].decision.output.projectId);
      } else {
        assert.deepEqual(results.map((item) => item.decision.output.code).sort(), ["registered", "retry-state"]);
      }
      const { snapshot } = await run(dir, { action: "snapshot" });
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.bindings.length, 1);
      assert.equal(snapshot.receipts.length, 1);
      assert.equal(snapshot.revisions[0].revision, 1);
    }));
  }

  test.after(() => {
    process.stdout.write(`VIVARY_REGISTRY_STORE_WITNESS ${JSON.stringify({
      ...proofWitness, caseCount: proofWitness.cases.length,
    })}\n`);
  });
}
