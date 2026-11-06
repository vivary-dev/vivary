import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNativeSqliteMatchesNode, ensureCorePackageJson, ensureProofRoot } from "./maintained-test-options.mjs";

const TEST_FILE = fileURLToPath(import.meta.url);
const HEAP = "--max-old-space-size=192";
const STREAM_LIMIT = 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
};
const serializable = (value) => JSON.parse(JSON.stringify(value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item));
function errorChain(error) {
  const chain = [];
  for (let current = error; current && chain.length < 8; current = current.cause) {
    chain.push({ name: String(current.name), message: String(current.message),
      code: current.code === undefined ? null : String(current.code),
      statusCode: Number.isInteger(current.statusCode) ? current.statusCode : null });
  }
  return chain;
}

ensureCorePackageJson();
register(new URL("./native-http-dependency-loader.mjs", import.meta.url), {
  data: { corePackageJson: process.env.VIVARY_TEST_CORE_PACKAGE_JSON }, // guard:allow-env-credential — Existing dependency manifest path.
});

const observations = Object.freeze({
  plain: { code: "observed", rootId: "root_plain", contentRevision: "content_plain",
    vcs: { kind: "none", repositoryId: null, checkoutId: null, mutationOwner: null } },
  repository: { code: "observed", rootId: "root_repository", contentRevision: "content_repository",
    vcs: { kind: "git", repositoryId: "repo_shared", checkoutId: "checkout_main", mutationOwner: "git" } },
  linked: { code: "observed", rootId: "root_linked", contentRevision: "content_linked",
    vcs: { kind: "git", repositoryId: "repo_shared", checkoutId: "checkout_linked", mutationOwner: "git" } },
  nested: { code: "observed", rootId: "root_nested", contentRevision: "content_nested",
    vcs: { kind: "git", repositoryId: "repo_shared", checkoutId: "checkout_main", mutationOwner: "git" } },
  separate: { code: "observed", rootId: "root_separate", contentRevision: "content_separate",
    vcs: { kind: "git", repositoryId: "repo_separate", checkoutId: "checkout_separate", mutationOwner: "git" } },
  fault: { code: "observed", rootId: "root_fault", contentRevision: "content_fault",
    vcs: { kind: "none", repositoryId: null, checkoutId: null, mutationOwner: null } },
  race: { code: "observed", rootId: "root_race", contentRevision: "content_race",
    vcs: { kind: "git", repositoryId: "repo_race", checkoutId: "checkout_race", mutationOwner: "git" } },
  unsupported: { code: "observed", rootId: "root_unsupported", contentRevision: "content_unsupported",
    vcs: { kind: "unsupported", repositoryId: null, checkoutId: null, mutationOwner: null } },
});
const EXPECTED_CASES = Object.freeze([
  ["registration-outside-grant-stays-denied", "denied"],
  ["rollback-revision", "injected-error"],
  ["rollback-reservation", "injected-error"],
  ["rollback-key", "injected-error"],
  ["rollback-high-water", "injected-error"],
  ["rollback-receipt", "injected-error"],
  ["missing-key-owner-refuses", "missing-key-owner"],
  ["admit-no-vcs", "admitted"],
  ["restart-retains-pending-owner", "reconciliation-required"],
  ["admit-git", "admitted"],
  ["shared-repository-busy", "busy"],
  ["busy-precedes-stale-registry", "busy"],
  ["cross-collection-shared-repository-busy", "busy"],
  ["nested-root-shares-repository-owner", "busy"],
  ["pending-retry-reconciles", "reconciliation-required"],
  ["pending-digest-change-conflicts", "operation-conflict"],
  ["pending-retry-precedes-unsafe-overlap", "reconciliation-required"],
  ["pending-digest-precedes-unsafe-overlap", "operation-conflict"],
  ["wrong-git-owner-read-only", "read-only"],
  ["stale-binding-revision", "stale-binding"],
  ["stale-policy-before-binding-read", "stale-policy"],
  ["stale-registry-refuses", "retry-state"],
  ["forged-root-field-rejected", "input-rejected"],
  ["busy-precedes-max-high-water", "busy"],
  ["uncertain-owner-reconciles", "reconciliation-required"],
  ["uncertain-precedes-stale-registry", "reconciliation-required"],
  ["uncertain-precedes-max-high-water", "reconciliation-required"],
  ["admit-disjoint-repository", "admitted"],
  ["historical-high-water-increments", "admitted"],
  ["stale-content-precedes-busy", "content-conflict"],
  ["replaced-root-refuses", "root-replaced"],
  ["changed-vcs-refuses", "stale-binding"],
  ["registry-revision-exhaustion-refuses", "invalid-input"],
  ["stale-location-refuses", "stale-binding"],
  ["unsafe-overlap-refuses", "ambiguous-ownership"],
  ["unsupported-vcs-read-only", "read-only"],
  ["fence-exhaustion-refuses", "invalid-input"],
  ["pending-retry-precedes-fence-exhaustion", "reconciliation-required"],
  ["foreign-scope-binding-hidden", "binding-unavailable"],
  ["registrar-cannot-admit", "authorization-rejected"],
  ["revocation-across-observation", "denied"],
  ["independent-process-single-owner", "one-admitted-one-busy"],
]);
const ERROR_EXPECTATIONS = Object.freeze({
  "injected-error": { chainEntry: { message: "fixture", code: "SQLITE_CONSTRAINT_TRIGGER" } },
  "missing-key-owner": { name: "TypeError",
    message: "mutation admission requires the registry key derivation owner" },
  "input-rejected": { name: "RegistryActionInputError", statusCode: 400,
    message: "Invalid registry action request" },
  "authorization-rejected": { statusCode: 403 },
});

const provider = (deviceId, hook = async () => {}, transform = (value) => value) => Object.freeze({
  deviceId, locationRefs: Object.keys(observations),
  observe: async (locationRef) => {
    assert.ok(Object.hasOwn(observations, locationRef));
    await hook(locationRef);
    return transform(structuredClone(observations[locationRef]), locationRef);
  },
});

const grant = (orgId, collectionId) => ({ orgId, collectionId, policyRevision: 1,
  locationRefs: Object.keys(observations) });
const context = (orgId) => ({ userEmail: "mutator@example.test", orgId,
  caller: "frontend", appId: "workbench" });
const registrationRequest = (locationRef, expectedRegistryRevision) => ({
  operationId: `register_${locationRef}`, expectedPolicyRevision: 1,
  expectedRegistryRevision, locationRef, displayName: locationRef,
  contentIdentity: null, attachProjectId: null,
});
const admissionRequest = (binding, expectedRegistryRevision, operationId, patch = {}) => ({
  operationId, expectedPolicyRevision: 1, expectedRegistryRevision,
  bindingId: binding.bindingId, expectedBindingRevision: binding.bindingRevision,
  expectedContentRevision: observations[binding.locationRef].contentRevision,
  requestedVcsOwner: observations[binding.locationRef].vcs.kind === "git" ? "git" : null,
  ...patch,
});

async function modules() {
  const [{ withMigrationRuntime, runMigrations, closeDbExec, getDbExec }, dbSchema, org,
    model, dbIndex, migrations, tables, native, store] = await Promise.all([
    import("@agent-native/core/db"), import("@agent-native/core/db/schema"),
    import("@agent-native/core/org"), import("../../../scripts/registry_contract_model.mjs"),
    import("../server/db/index.mjs"), import("../server/db/migrations.mjs"),
    import("../server/db/schema.mjs"), import("../server/native-registry.mjs"),
    import("../server/registry-store.mjs"),
  ]);
  return { withMigrationRuntime, runMigrations, closeDbExec, getDbExec,
    ...dbSchema, ...org, ...model, ...dbIndex, ...migrations, ...tables, ...native, ...store };
}

async function childWorker() {
  assert.ok(process.execArgv.includes(HEAP));
  const payloadPromise = new Promise((resolve) => process.once("message", resolve));
  const m = await modules();
  const send = (value) => new Promise((resolve, reject) => process.send(value,
    (error) => error ? reject(error) : resolve()));
  await send({ type: "initialized" });
  const payload = await payloadPromise;
  let message;
  let timeout;
  let barrierUsed = false;
  try {
    const observedProvider = provider(payload.deviceId, async () => {
      if (!payload.barrier || barrierUsed) return;
      barrierUsed = true;
      const goPromise = new Promise((resolve) => process.once("message", resolve));
      await send({ type: "barrier-ready" });
      const go = await goPromise;
      assert.equal(go.type, "go");
    });
    const runtime = m.createNativeRegistry({ provider: observedProvider, grant: payload.grant,
      evaluate: m.evaluateRegistryOperation, deriveMutationKeys: m.deriveMutationKeys });
    timeout = setTimeout(() => { process.exitCode = 1; }, 30000);
    const output = await runtime.mutationAdmission.run(payload.request, payload.context);
    message = { output };
  } catch (error) {
    message = { error: { name: error.name, message: error.message, code: error.code } };
  } finally {
    clearTimeout(timeout);
    await m.closeDbExec();
  }
  await send({ type: "result", value: message });
  process.disconnect();
}

function startChild(payload) {
  const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "LANG",
    "AGENT_NATIVE_DISABLED_PLUGINS"];
  const env = Object.fromEntries(retained.filter((key) => process.env[key]) // guard:allow-env-credential — Fixed harmless child-process environment allowlist.
    .map((key) => [key, process.env[key]])); // guard:allow-env-credential — Copies only values selected by the fixed allowlist.
  Object.assign(env, {
    VIVARY_12H_CHILD: "1",
    VIVARY_TEST_CORE_PACKAGE_JSON: process.env.VIVARY_TEST_CORE_PACKAGE_JSON, // guard:allow-env-credential — Existing dependency manifest path.
    DATABASE_URL: process.env.DATABASE_URL, // guard:allow-env-credential — Task-owned SQLite fixture file only.
    NODE_ENV: "test",
  });
  const child = fork(TEST_FILE, [], { env, execArgv: [HEAP], windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let result;
  let diagnostic = "";
  let overflow = false;
  let bytes = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      diagnostic = (diagnostic + chunk.toString()).slice(-16000);
      if (bytes > STREAM_LIMIT && !overflow) { overflow = true; child.kill(); }
    });
  }
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("child exceeded 45 seconds")); }, 45000);
    child.on("message", (message) => {
      if (message.type === "initialized") {
        child.send(payload);
        if (!payload.barrier) readyResolve();
      } else if (message.type === "barrier-ready") readyResolve();
      else if (message.type === "result") result = message.value;
    });
    child.on("error", (error) => { readyReject(error); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (payload.barrier) readyReject(new Error(`child exited before or after barrier (${code})`));
      if (code !== 0 || overflow || !result) reject(new Error(`child failed (${code}): ${diagnostic}`));
      else resolve(result);
    });
  });
  completion.catch(() => {});
  return { ready, completion, go: () => child.send({ type: "go" }) };
}

async function treeSummary(root) {
  const entries = [];
  async function visit(current, relative) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) entries.push({ path: relative, kind: "symlink", target: await readlink(current) });
    else if (info.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of (await readdir(current)).sort()) {
        await visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
    } else {
      const bytes = await readFile(current);
      entries.push({ path: relative, kind: "file", bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit(root, "");
  return { entries: entries.length, sha256: sha256(JSON.stringify(entries)) };
}

async function makeFixture(base) {
  const root = await mkdtemp(path.join(base, "mutation-"));
  const dirs = Object.fromEntries(Object.keys(observations).map((name) => [name, path.join(root, name)]));
  dirs.nested = path.join(dirs.repository, "nested");
  for (const directory of Object.values(dirs)) await mkdir(directory);
  for (const [name, directory] of Object.entries(dirs)) await writeFile(path.join(directory, "note.txt"), `${name}\n`);
  const gitEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (cwd, ...args) => spawnSync("/usr/bin/git", ["-C", cwd, ...args],
    { env: gitEnv, timeout: 5000, maxBuffer: 32768 });
  for (const name of ["repository", "separate", "race"]) {
    for (const args of [["init", "-q", "-b", "main"], ["add", "."],
      ["-c", "commit.gpgSign=false", "commit", "-q", "-m", "fixture"]]) {
      const result = git(dirs[name], ...args);
      assert.equal(result.status, 0, result.stderr.toString());
    }
  }
  await rm(dirs.linked, { recursive: true });
  const linked = git(dirs.repository, "worktree", "add", "-q", "-b", "linked", dirs.linked);
  assert.equal(linked.status, 0, linked.stderr.toString());
  return { root, dirs, gitRoots: { repository: path.join(dirs.repository, ".git"),
    linked: path.join(dirs.repository, ".git"), separate: path.join(dirs.separate, ".git"),
    nested: path.join(dirs.repository, ".git"), race: path.join(dirs.race, ".git") } };
}

async function mainTest() {
  assert.ok(process.execArgv.includes(HEAP));
  assertNativeSqliteMatchesNode(ensureCorePackageJson());
  ensureProofRoot("VIVARY_12H_PROOF_ROOT");
  assert.ok(process.env.VIVARY_TEST_CORE_PACKAGE_JSON); // guard:allow-env-credential — Reviewed installed Core package manifest path.
  assert.ok(process.env.VIVARY_12H_PROOF_ROOT && path.isAbsolute(process.env.VIVARY_12H_PROOF_ROOT)); // guard:allow-env-credential — Disposable proof path.
  const base = await realpath(process.env.VIVARY_12H_PROOF_ROOT); // guard:allow-env-credential — Disposable proof path.
  const f = await makeFixture(base);
  // Parent and forked children share this database. Always use the fixture
  // root the suite removes: never an inherited DATABASE_URL, and not Core's
  // cwd-relative default. Core still creates an empty data/ directory under
  // the working directory, which the package scripts keep in packages/workbench.
  // guard:allow-env-mutation — Test-only fixture location shared with the forked children; process-scoped by design.
  process.env.DATABASE_URL = `file:${path.join(f.root, "registry.sqlite")}`; // guard:allow-env-credential — Task-owned SQLite fixture file only.
  const m = await modules();
  const cases = [];
  const snapshotPool = new Map();
  const orgId = `org_${randomUUID().replaceAll("-", "")}`;
  const deviceId = `device_${randomUUID().replaceAll("-", "")}`;
  const email = context(orgId).userEmail;
  const collectionA = "collection_a";
  const collectionB = "collection_b";
  const runtime = (collectionId, selectedProvider = provider(deviceId)) => m.createNativeRegistry({
    provider: selectedProvider, grant: grant(orgId, collectionId), evaluate: m.evaluateRegistryOperation,
    deriveMutationKeys: m.deriveMutationKeys,
  });

  const sqlSnapshot = async () => {
    const rows = {
      projects: await m.getDb().select().from(m.projects),
      bindings: await m.getDb().select().from(m.bindings),
      revisions: await m.getDb().select().from(m.revisions),
      reservations: await m.getDb().select().from(m.mutationReservations),
      reservationKeys: await m.getDb().select().from(m.mutationReservationKeys),
      fenceHighWater: await m.getDb().select().from(m.mutationFenceHighWater),
      receipts: await m.getDb().select().from(m.receipts),
    };
    return Object.fromEntries(Object.entries(rows).map(([name, values]) => [name,
      values.map(serializable).sort((left, right) => stable(left).localeCompare(stable(right)))]));
  };
  const providerState = { persistent: false, locations: Object.fromEntries(Object.entries(observations)
    .map(([name, value]) => [name, sha256(stable(value))])) };
  const capture = async (locationRef) => ({ sql: await sqlSnapshot(),
    provider: structuredClone(providerState),
    project: await treeSummary(f.dirs[locationRef]),
    git: f.gitRoots[locationRef] ? await treeSummary(f.gitRoots[locationRef]) : null });
  const retainSnapshot = (snapshot) => {
    const id = sha256(stable(snapshot));
    if (!snapshotPool.has(id)) snapshotPool.set(id, snapshot);
    else assert.deepEqual(snapshotPool.get(id), snapshot);
    return id;
  };
  function assertAdmissionDelta(before, after, output) {
    assert.deepEqual(after.projects, before.projects);
    assert.deepEqual(after.bindings, before.bindings);
    const additions = (beforeRows, afterRows, key) => {
      const prior = new Set(beforeRows.map((row) => row[key]));
      return afterRows.filter((row) => !prior.has(row[key]));
    };
    const newReservations = additions(before.reservations, after.reservations, "reservationId");
    assert.equal(newReservations.length, 1);
    assert.equal(after.reservations.length, before.reservations.length + 1);
    for (const row of before.reservations) assert.deepEqual(
      after.reservations.find((item) => item.reservationId === row.reservationId), row);
    const reservation = newReservations[0];
    assert.deepEqual(JSON.parse(reservation.keys), output.keys);
    assert.equal(reservation.ownerOperationId, output.ownerOperationId);
    assert.equal(reservation.fence, output.fence);
    assert.equal(reservation.state, "active");
    const selectedBinding = before.bindings.find((row) => row.bindingId === output.bindingId);
    assert.ok(selectedBinding);
    assert.deepEqual([reservation.ownerActorId, reservation.ownerCollectionId, reservation.ownerDeviceId],
      [selectedBinding.actorId, selectedBinding.collectionId, selectedBinding.deviceId]);
    const newClaims = additions(before.reservationKeys, after.reservationKeys, "resourceKey");
    assert.deepEqual(newClaims.map((row) => row.resourceKey).sort(), output.keys);
    assert.ok(newClaims.every((row) => row.reservationId === reservation.reservationId));
    assert.equal(after.reservationKeys.length, before.reservationKeys.length + output.keys.length);
    for (const row of before.reservationKeys) assert.deepEqual(
      after.reservationKeys.find((item) => item.resourceKey === row.resourceKey), row);
    const highWater = new Map(after.fenceHighWater.map((row) => [row.resourceKey, row.fence]));
    assert.ok(output.keys.every((key) => highWater.get(key) === output.fence));
    const priorHighWater = new Map(before.fenceHighWater.map((row) => [row.resourceKey, row.fence]));
    assert.ok(output.keys.every((key) => output.fence > (priorHighWater.get(key) ?? 0)));
    assert.deepEqual([...highWater.keys()].sort(),
      [...new Set([...priorHighWater.keys(), ...output.keys])].sort());
    for (const row of before.fenceHighWater.filter((item) => !output.keys.includes(item.resourceKey))) {
      assert.deepEqual(after.fenceHighWater.find((item) => item.resourceKey === row.resourceKey), row);
    }
    const newReceipts = additions(before.receipts, after.receipts, "receiptKey");
    assert.equal(newReceipts.length, 1);
    assert.equal(after.receipts.length, before.receipts.length + 1);
    const receipt = JSON.parse(newReceipts[0].record);
    assert.equal(receipt.status, "pending");
    assert.deepEqual(receipt.output, output);
    assert.deepEqual([receipt.actorId, receipt.collectionId, receipt.deviceId],
      [selectedBinding.actorId, selectedBinding.collectionId, selectedBinding.deviceId]);
    assert.equal(newReceipts[0].requestDigest, receipt.requestDigest);
    assert.equal(newReceipts[0].receiptKey,
      `${receipt.actorId}:${receipt.collectionId}:${receipt.deviceId}:admit-mutation:${output.ownerOperationId}`);
    for (const row of before.receipts) assert.deepEqual(
      after.receipts.find((item) => item.receiptKey === row.receiptKey), row);
    const beforeRevisions = new Map(before.revisions.map((row) => [row.scopeKey, row]));
    assert.equal(after.revisions.length, before.revisions.length);
    const changed = after.revisions.filter((row) => stable(row) !== stable(beforeRevisions.get(row.scopeKey)));
    assert.equal(changed.length, 1);
    assert.equal(changed[0].scopeKey, `${reservation.ownerCollectionId}:${reservation.ownerDeviceId}`);
    assert.equal(changed[0].revision, beforeRevisions.get(changed[0].scopeKey).revision + 1);
  }
  async function witness(id, locationRef, invoke, expectedCode, {
    throws = false, statusCode, errorMatch, sqlChanges = false,
  } = {}) {
    const before = await capture(locationRef);
    let output;
    let failure;
    try { output = await invoke(); } catch (error) { failure = error; }
    const after = await capture(locationRef);
    assert.deepEqual(after.project, before.project, `${id} changed project bytes`);
    assert.deepEqual(after.git, before.git, `${id} changed Git bytes`);
    assert.deepEqual(after.provider, before.provider, `${id} changed provider state`);
    const code = failure ? expectedCode : output.code;
    assert.equal(code, expectedCode, `${id} code mismatch`);
    assert.equal(stable(after.sql) !== stable(before.sql), sqlChanges, `${id} SQL change mismatch`);
    assert.equal(Boolean(failure), throws,
      `${id}: ${failure ? JSON.stringify(errorChain(failure)) : "expected an error but invocation succeeded"}`);
    if (statusCode !== undefined) assert.equal(failure?.statusCode, statusCode);
    if (errorMatch) assert.equal(errorMatch(errorChain(failure)), true,
      `${id} raised an unrelated error: ${JSON.stringify(errorChain(failure))}`);
    if (!sqlChanges) assert.deepEqual(after.sql, before.sql, `${id} left partial SQL state`);
    else assertAdmissionDelta(before.sql, after.sql, output);
    cases.push({ id, code, before: retainSnapshot(before), after: retainSnapshot(after),
      error: failure ? errorChain(failure) : null });
    return output;
  }

  try {
    await m.withMigrationRuntime(async () => {
      await m.runMigrations(m.ORG_MIGRATIONS, { table: "native_org_mutation_migrations" })();
      await m.migrateRegistry();
    });
    await m.getDb().insert(m.organizations).values({ id: orgId, name: "Mutation fixture",
      createdBy: email, createdAt: Date.now() });
    await m.getDb().insert(m.orgMembers).values({ id: `member_${randomUUID().replaceAll("-", "")}`,
      orgId, email, role: "owner", joinedAt: Date.now() });
    await m.setAppMemberRole({ appId: "workbench", orgId, email,
      role: "project-mutator", updatedBy: email });

    const a = runtime(collectionA);
    const b = runtime(collectionB);
    assert.equal((await a.readScope(context(orgId))).collectionId, collectionA);
    assert.deepEqual({ http: a.mutationAdmission.http, agentTool: a.mutationAdmission.agentTool,
      mcpTool: a.mutationAdmission.mcpTool, toolCallable: a.mutationAdmission.toolCallable },
    { http: false, agentTool: false, mcpTool: false, toolCallable: false });
    for (const [index, locationRef] of ["plain", "repository", "linked", "separate", "fault"].entries()) {
      assert.equal((await a.registration.run(registrationRequest(locationRef, index), context(orgId))).code,
        "registered", "project-mutator must preserve registration behavior");
    }
    assert.equal((await b.registration.run(registrationRequest("repository", 0), context(orgId))).code, "registered");
    const allBindings = await m.getDb().select().from(m.bindings);
    const selected = (collectionId, locationRef) => allBindings.find((row) =>
      row.collectionId === collectionId && row.locationRef === locationRef);

    await witness("registration-outside-grant-stays-denied", "plain", () => a.registration.run({
      ...registrationRequest("plain", 5), operationId: "register_outside", locationRef: "outside",
    }, context(orgId)), "denied");

    const fault = selected(collectionA, "fault");
    for (const [id, sql] of [
      ["rollback-revision", "CREATE TRIGGER mutation_fault BEFORE UPDATE ON vivary_registry_revisions BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
      ["rollback-reservation", "CREATE TRIGGER mutation_fault BEFORE INSERT ON vivary_mutation_reservations BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
      ["rollback-key", "CREATE TRIGGER mutation_fault BEFORE INSERT ON vivary_mutation_reservation_keys BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
      ["rollback-high-water", "CREATE TRIGGER mutation_fault BEFORE INSERT ON vivary_mutation_fence_high_water BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
      ["rollback-receipt", "CREATE TRIGGER mutation_fault BEFORE INSERT ON vivary_registry_receipts WHEN NEW.operation = 'admit-mutation' BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
    ]) {
      await m.getDbExec().execute(sql);
      await witness(id, "fault", () => a.mutationAdmission.run(
        admissionRequest(fault, 5, `operation_${id}`), context(orgId)), "injected-error",
      { throws: true, sqlChanges: false,
        errorMatch: (chain) => chain.some((item) =>
          item.message === "fixture" && item.code === "SQLITE_CONSTRAINT_TRIGGER") });
      await m.getDbExec().execute("DROP TRIGGER mutation_fault");
    }

    const missingKeyOwner = m.createNativeRegistry({ provider: provider(deviceId),
      grant: grant(orgId, collectionA), evaluate: m.evaluateRegistryOperation });
    await witness("missing-key-owner-refuses", "fault", () => missingKeyOwner.mutationAdmission.run(
      admissionRequest(fault, 5, "operation_missing_key_owner"), context(orgId)),
    "missing-key-owner", { throws: true, errorMatch: (chain) => chain[0]?.name === "TypeError"
      && chain[0]?.message === "mutation admission requires the registry key derivation owner" });

    const plain = selected(collectionA, "plain");
    const admittedPlain = await witness("admit-no-vcs", "plain", () => a.mutationAdmission.run(
      admissionRequest(plain, 5, "operation_plain"), context(orgId)), "admitted", { sqlChanges: true });
    assert.deepEqual(admittedPlain.keys, [`${deviceId}:root:root_plain`]);
    await witness("restart-retains-pending-owner", "plain", async () => {
      const restarted = await startChild({ deviceId, grant: grant(orgId, collectionA),
        context: context(orgId), request: admissionRequest(plain, 5, "operation_plain") }).completion;
      assert.equal(restarted.error, undefined, JSON.stringify(restarted));
      return restarted.output;
    }, "reconciliation-required");

    const repository = selected(collectionA, "repository");
    const admittedGit = await witness("admit-git", "repository", () => a.mutationAdmission.run(
      admissionRequest(repository, 6, "operation_repository"), context(orgId)), "admitted", { sqlChanges: true });
    assert.deepEqual(admittedGit.keys, [`${deviceId}:checkout:checkout_main`, `${deviceId}:repository:repo_shared`]);

    const linked = selected(collectionA, "linked");
    await witness("shared-repository-busy", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 7, "operation_linked"), context(orgId)), "busy");
    await witness("busy-precedes-stale-registry", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 0, "operation_linked_stale"), context(orgId)), "busy");
    const foreignRepository = selected(collectionB, "repository");
    await witness("cross-collection-shared-repository-busy", "repository", () => b.mutationAdmission.run(
      admissionRequest(foreignRepository, 1, "operation_cross_collection"), context(orgId)), "busy");
    const nestedCollection = "collection_nested";
    const nestedRuntime = runtime(nestedCollection);
    assert.equal((await nestedRuntime.registration.run(
      registrationRequest("nested", 0), context(orgId))).code, "registered");
    const nestedBinding = (await m.getDb().select().from(m.bindings)).find((row) =>
      row.collectionId === nestedCollection && row.locationRef === "nested");
    await witness("nested-root-shares-repository-owner", "nested", () => nestedRuntime.mutationAdmission.run(
      admissionRequest(nestedBinding, 1, "operation_nested"), context(orgId)), "busy");
    await witness("pending-retry-reconciles", "repository", () => a.mutationAdmission.run(
      admissionRequest(repository, 6, "operation_repository"), context(orgId)), "reconciliation-required");
    await witness("pending-digest-change-conflicts", "repository", () => a.mutationAdmission.run(
      admissionRequest(repository, 6, "operation_repository", { expectedContentRevision: "content_changed" }),
      context(orgId)), "operation-conflict");
    const { code: _repositoryCode, ...observedRepository } = observations.repository;
    const unsafeReplayStore = m.createRegistryStore({
      allocateIds: async () => ({ projectId: "unused", bindingId: "unused" }),
      evaluate: m.evaluateRegistryOperation, deriveMutationKeys: m.deriveMutationKeys,
      resolveFacts: async () => ({
        actorId: repository.actorId, collectionId: collectionA, deviceId,
        member: true, capabilities: ["mutate-project"], rootAccess: [repository.rootId],
        policyRevision: 1, root: { ...structuredClone(observedRepository),
          locationRef: repository.locationRef, exists: true, isDirectory: true, identityVerified: true },
        overlapSafe: false,
      }),
    });
    await witness("pending-retry-precedes-unsafe-overlap", "repository",
      async () => (await unsafeReplayStore.admitMutation(
        admissionRequest(repository, 6, "operation_repository"))).output,
      "reconciliation-required");
    await witness("pending-digest-precedes-unsafe-overlap", "repository",
      async () => (await unsafeReplayStore.admitMutation(admissionRequest(repository, 6,
        "operation_repository", { expectedContentRevision: "content_changed" }))).output,
      "operation-conflict");
    await witness("wrong-git-owner-read-only", "repository", () => a.mutationAdmission.run(
      admissionRequest(repository, 7, "operation_wrong_owner", { requestedVcsOwner: null }),
      context(orgId)), "read-only");
    await witness("stale-binding-revision", "repository", () => a.mutationAdmission.run(
      admissionRequest(repository, 7, "operation_stale_binding", { expectedBindingRevision: 2 }),
      context(orgId)), "stale-binding");
    let stalePolicyObservations = 0;
    const stalePolicyRuntime = runtime(collectionA,
      provider(deviceId, async () => { stalePolicyObservations++; }));
    await witness("stale-policy-before-binding-read", "repository", () => stalePolicyRuntime.mutationAdmission.run(
      admissionRequest(repository, 7, "operation_stale_policy", { expectedPolicyRevision: 2 }),
      context(orgId)), "stale-policy");
    assert.equal(stalePolicyObservations, 0);
    await witness("stale-registry-refuses", "fault", () => a.mutationAdmission.run(
      admissionRequest(fault, 0, "operation_stale_registry"), context(orgId)), "retry-state");
    await witness("forged-root-field-rejected", "repository", () => a.mutationAdmission.run({
      ...admissionRequest(repository, 7, "operation_forged_root"), rootId: "root_forged",
    }, context(orgId)), "input-rejected", { throws: true, statusCode: 400,
      errorMatch: (chain) => chain[0]?.name === "RegistryActionInputError"
        && chain[0]?.message === "Invalid registry action request" });

    await m.getDb().update(m.mutationFenceHighWater).set({ fence: Number.MAX_SAFE_INTEGER })
      .where(m.inArray(m.mutationFenceHighWater.resourceKey, admittedGit.keys));
    await witness("busy-precedes-max-high-water", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 7, "operation_linked_max"), context(orgId)), "busy");
    await m.getDb().update(m.mutationReservations).set({ state: "uncertain" })
      .where(m.eq(m.mutationReservations.ownerOperationId, "operation_repository"));
    await witness("uncertain-owner-reconciles", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 7, "operation_linked_uncertain"), context(orgId)), "reconciliation-required");
    await witness("uncertain-precedes-stale-registry", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 0, "operation_linked_uncertain_stale"), context(orgId)),
      "reconciliation-required");
    await witness("uncertain-precedes-max-high-water", "linked", () => a.mutationAdmission.run(
      admissionRequest(linked, 7, "operation_linked_uncertain_max"), context(orgId)),
      "reconciliation-required");

    const separate = selected(collectionA, "separate");
    const firstSeparate = await witness("admit-disjoint-repository", "separate", () => a.mutationAdmission.run(
      admissionRequest(separate, 7, "operation_separate_1"), context(orgId)), "admitted", { sqlChanges: true });
    assert.equal(firstSeparate.fence, 1);
    const [separateOwner] = await m.getDb().select().from(m.mutationReservations)
      .where(m.eq(m.mutationReservations.ownerOperationId, "operation_separate_1"));
    await m.getDb().delete(m.mutationReservationKeys)
      .where(m.eq(m.mutationReservationKeys.reservationId, separateOwner.reservationId));
    await m.getDb().delete(m.mutationReservations)
      .where(m.eq(m.mutationReservations.reservationId, separateOwner.reservationId));
    const secondSeparate = await witness("historical-high-water-increments", "separate", () => a.mutationAdmission.run(
      admissionRequest(separate, 8, "operation_separate_2"), context(orgId)), "admitted", { sqlChanges: true });
    assert.equal(secondSeparate.fence, 2);
    await witness("stale-content-precedes-busy", "separate", () => a.mutationAdmission.run(
      admissionRequest(separate, 9, "operation_stale_content", { expectedContentRevision: "content_stale" }),
      context(orgId)), "content-conflict");
    const replacedRoot = runtime(collectionA, provider(deviceId, async () => {},
      (value, locationRef) => locationRef === "fault" ? { ...value, rootId: "root_replaced" } : value));
    await witness("replaced-root-refuses", "fault", () => replacedRoot.mutationAdmission.run(
      admissionRequest(fault, 9, "operation_root_replaced"), context(orgId)), "root-replaced");
    const changedVcs = runtime(collectionA, provider(deviceId, async () => {},
      (value, locationRef) => locationRef === "fault" ? { ...value, vcs: {
        kind: "git", repositoryId: "repo_changed", checkoutId: "checkout_changed", mutationOwner: "git",
      } } : value));
    await witness("changed-vcs-refuses", "fault", () => changedVcs.mutationAdmission.run(
      admissionRequest(fault, 9, "operation_vcs_changed"), context(orgId)), "stale-binding");
    await m.getDb().update(m.revisions).set({ revision: Number.MAX_SAFE_INTEGER })
      .where(m.eq(m.revisions.scopeKey, `${collectionA}:${deviceId}`));
    await witness("registry-revision-exhaustion-refuses", "fault", () => a.mutationAdmission.run(
      admissionRequest(fault, Number.MAX_SAFE_INTEGER, "operation_registry_exhausted"), context(orgId)),
    "invalid-input");
    await m.getDb().update(m.revisions).set({ revision: 9 })
      .where(m.eq(m.revisions.scopeKey, `${collectionA}:${deviceId}`));
    const { code: _faultCode, ...observedFault } = observations.fault;
    const mutationFacts = (rootPatch = {}, overlapSafe = true) => ({
      actorId: fault.actorId, collectionId: collectionA, deviceId,
      member: true, capabilities: ["mutate-project"], rootAccess: ["root_fault"],
      policyRevision: 1, root: { ...structuredClone(observedFault),
        locationRef: "fault", exists: true, isDirectory: true, identityVerified: true,
        ...rootPatch }, overlapSafe,
    });
    const staleLocationStore = m.createRegistryStore({
      allocateIds: async () => ({ projectId: "unused", bindingId: "unused" }),
      evaluate: m.evaluateRegistryOperation, deriveMutationKeys: m.deriveMutationKeys,
      resolveFacts: async () => mutationFacts({ locationRef: "plain" }),
    });
    await witness("stale-location-refuses", "fault", async () => (
      await staleLocationStore.admitMutation(
        admissionRequest(fault, 9, "operation_stale_location"))).output, "stale-binding");
    const ambiguousStore = m.createRegistryStore({
      allocateIds: async () => ({ projectId: "unused", bindingId: "unused" }),
      evaluate: m.evaluateRegistryOperation, deriveMutationKeys: m.deriveMutationKeys,
      resolveFacts: async () => mutationFacts({}, false),
    });
    await witness("unsafe-overlap-refuses", "fault", async () => (
      await ambiguousStore.admitMutation(
        admissionRequest(fault, 9, "operation_unsafe_overlap"))).output, "ambiguous-ownership");

    const unsupportedCollection = "collection_unsupported";
    const unsupportedRuntime = runtime(unsupportedCollection);
    assert.equal((await unsupportedRuntime.registration.run(
      registrationRequest("unsupported", 0), context(orgId))).code, "registered");
    const unsupportedBinding = (await m.getDb().select().from(m.bindings)).find((row) =>
      row.collectionId === unsupportedCollection && row.locationRef === "unsupported");
    await witness("unsupported-vcs-read-only", "unsupported", () => unsupportedRuntime.mutationAdmission.run(
      admissionRequest(unsupportedBinding, 1, "operation_unsupported"), context(orgId)), "read-only");

    const [plainOwner] = await m.getDb().select().from(m.mutationReservations)
      .where(m.eq(m.mutationReservations.ownerOperationId, "operation_plain"));
    await m.getDb().delete(m.mutationReservationKeys)
      .where(m.eq(m.mutationReservationKeys.reservationId, plainOwner.reservationId));
    await m.getDb().delete(m.mutationReservations)
      .where(m.eq(m.mutationReservations.reservationId, plainOwner.reservationId));
    await m.getDb().update(m.mutationFenceHighWater).set({ fence: Number.MAX_SAFE_INTEGER })
      .where(m.eq(m.mutationFenceHighWater.resourceKey, `${deviceId}:root:root_plain`));
    await witness("fence-exhaustion-refuses", "plain", () => a.mutationAdmission.run(
      admissionRequest(plain, 9, "operation_plain_exhausted"), context(orgId)), "invalid-input");
    await witness("pending-retry-precedes-fence-exhaustion", "plain", () => a.mutationAdmission.run(
      admissionRequest(plain, 5, "operation_plain"), context(orgId)), "reconciliation-required");

    let observationsMade = 0;
    const tracked = provider(deviceId, async () => { observationsMade++; });
    const scoped = runtime(collectionB, tracked);
    await witness("foreign-scope-binding-hidden", "plain", () => scoped.mutationAdmission.run(
      admissionRequest(plain, 1, "operation_foreign_binding"), context(orgId)), "binding-unavailable");
    assert.equal(observationsMade, 0, "foreign binding location must not be observed");

    await m.setAppMemberRole({ appId: "workbench", orgId, email,
      role: "project-registrar", updatedBy: email });
    await witness("registrar-cannot-admit", "plain", () => a.mutationAdmission.run(
      admissionRequest(plain, 9, "operation_registrar"), context(orgId)), "authorization-rejected",
      { throws: true, statusCode: 403 });
    await m.setAppMemberRole({ appId: "workbench", orgId, email,
      role: "project-mutator", updatedBy: email });

    let revoked = false;
    const revoking = runtime(collectionA, provider(deviceId, async () => {
      if (!revoked) {
        revoked = true;
        await m.setAppMemberRole({ appId: "workbench", orgId, email, role: null, updatedBy: email });
      }
    }));
    await witness("revocation-across-observation", "fault", () => revoking.mutationAdmission.run(
      admissionRequest(fault, 9, "operation_revoked"), context(orgId)), "denied");
    await m.setAppMemberRole({ appId: "workbench", orgId, email,
      role: "project-mutator", updatedBy: email });

    const collections = ["collection_race_a", "collection_race_b"];
    const raceBindings = [];
    for (const collectionId of collections) {
      const current = runtime(collectionId);
      assert.equal((await current.registration.run(registrationRequest("race", 0), context(orgId))).code, "registered");
      raceBindings.push((await m.getDb().select().from(m.bindings)).find((row) =>
        row.collectionId === collectionId && row.locationRef === "race"));
    }
    const beforeRace = await capture("race");
    const children = collections.map((collectionId, index) => startChild({
      deviceId, grant: grant(orgId, collectionId), context: context(orgId),
      request: admissionRequest(raceBindings[index], 1, `operation_race_${index}`), barrier: true,
    }));
    await Promise.all(children.map((child) => child.ready));
    children.forEach((child) => child.go());
    const childResults = await Promise.all(children.map((child) => child.completion));
    assert.ok(childResults.every((item) => !item.error), JSON.stringify(childResults));
    const raceCodes = childResults.map((item) => item.output.code);
    assert.deepEqual(raceCodes.sort(), ["admitted", "busy"]);
    const afterRace = await capture("race");
    assertAdmissionDelta(beforeRace.sql, afterRace.sql,
      childResults.find((item) => item.output.code === "admitted").output);
    assert.deepEqual(afterRace.provider, beforeRace.provider);
    assert.deepEqual(afterRace.project, beforeRace.project);
    assert.deepEqual(afterRace.git, beforeRace.git);
    cases.push({ id: "independent-process-single-owner", code: "one-admitted-one-busy",
      before: retainSnapshot(beforeRace), after: retainSnapshot(afterRace), error: null });

    assert.deepEqual(cases.map(({ id, code }) => [id, code]), EXPECTED_CASES);
    const line = `VIVARY_12H_MUTATION_WITNESS ${JSON.stringify({
      schema: "vivary.12h-mutation-witness/v1", errorExpectations: ERROR_EXPECTATIONS, cases,
      snapshots: [...snapshotPool].map(([id, value]) => ({ id, ...value })),
    })}`;
    assert.ok(Buffer.byteLength(line, "utf8") < 900 * 1024);
    process.stdout.write(`${line}\n`);
  } finally {
    await m.closeDbExec();
    await rm(f.root, { recursive: true });
  }
}

if (process.env.VIVARY_12H_CHILD === "1") await childWorker(); // guard:allow-env-credential — Test child mode only.
else test("durable Native mutation admission preserves project and Git bytes", mainTest);
