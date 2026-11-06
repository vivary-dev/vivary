import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNativeSqliteMatchesNode, ensureCorePackageJson, ensureProofRoot } from "./maintained-test-options.mjs";
import { gzipSync } from "node:zlib";

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

const EXPECTED_CASES = Object.freeze([
  ["private-action-metadata", "private"],
  ["strict-quarantine-request", "input-rejected"],
  ["revoked-between-entry-and-admission-read", "denied"],
  ["first-no-vcs-quarantine", "quarantined"],
  ["stale-policy-uncertain-repeat", "stale-policy"],
  ["revoked-uncertain-repeat", "authorization-rejected"],
  ["first-git-quarantine", "quarantined"],
  ["restart-stale-revision-replay", "quarantined"],
  ["maximum-revision-replay", "quarantined"],
  ["first-transition-stale-revision", "retry-state"],
  ["first-transition-revision-exhausted", "invalid-input"],
  ["wrong-operation-unavailable", "admission-unavailable"],
  ["wrong-binding-stale-fence", "stale-fence"],
  ["wrong-fence-stale-fence", "stale-fence"],
  ["wrong-actor-unavailable", "admission-unavailable"],
  ["wrong-collection-unavailable", "admission-unavailable"],
  ["wrong-device-unavailable", "admission-unavailable"],
  ["stale-policy-before-admission-read", "stale-policy"],
  ["registrar-cannot-quarantine", "authorization-rejected"],
  ["missing-binding-and-root-still-quarantine", "quarantined"],
  ["replaced-root-changed-binding-still-quarantine", "quarantined"],
  ["receipt-null-invalid", "invalid-input"],
  ["receipt-envelope-invalid", "invalid-input"],
  ["receipt-derived-keys-invalid", "invalid-input"],
  ["parent-owner-invalid", "invalid-input"],
  ["claim-missing", "invalid-input"],
  ["claim-foreign", "invalid-input"],
  ["high-water-missing", "invalid-input"],
  ["high-water-lower", "invalid-input"],
  ["high-water-higher", "invalid-input"],
  ["mixed-receipt-lifecycle", "reconciliation-required"],
  ["mixed-parent-lifecycle", "reconciliation-required"],
  ["rollback-revision", "injected-error"],
  ["rollback-reservation", "injected-error"],
  ["rollback-receipt", "injected-error"],
  ["same-key-contender-quarantined", "reconciliation-required"],
  ["cross-collection-contender-quarantined", "reconciliation-required"],
  ["pending-retry-preserved", "reconciliation-required"],
  ["pending-digest-conflict-preserved", "operation-conflict"],
  ["independent-process-single-transition", "one-transition-one-replay"],
]);
const ERROR_EXPECTATIONS = Object.freeze({
  "injected-error": { chainEntry: { message: "fixture", code: "SQLITE_CONSTRAINT_TRIGGER" } },
  "input-rejected": { name: "RegistryActionInputError", statusCode: 400,
    message: "Invalid registry action request" },
  "authorization-rejected": { statusCode: 403 },
});

const noVcs = () => ({ kind: "none", repositoryId: null, checkoutId: null, mutationOwner: null });
const observed = (locationRef, patch = {}) => ({
  code: "observed", rootId: `root_${locationRef}`, contentRevision: `content_${locationRef}`,
  vcs: noVcs(), ...patch,
});
const OBSERVATIONS = Object.freeze({
  plain: observed("plain"),
  git: observed("git", { vcs: { kind: "git", repositoryId: "repo_shared",
    checkoutId: "checkout_main", mutationOwner: "git" } }),
  linked: observed("linked", { vcs: { kind: "git", repositoryId: "repo_shared",
    checkoutId: "checkout_linked", mutationOwner: "git" } }),
  boundary: observed("boundary"), stale: observed("stale"), exhausted: observed("exhausted"),
  missing: observed("missing"),
  replaced: observed("replaced"),
  corrupt: observed("corrupt"), rollback: observed("rollback"), pending: observed("pending"),
  race: observed("race"),
});

const provider = (deviceId, counter = { calls: 0 }, transform = (value) => value) => Object.freeze({
  deviceId, locationRefs: Object.keys(OBSERVATIONS),
  observe: async (locationRef) => {
    counter.calls += 1;
    assert.ok(Object.hasOwn(OBSERVATIONS, locationRef));
    return transform(structuredClone(OBSERVATIONS[locationRef]), locationRef);
  },
});
const grant = (orgId, collectionId) => ({ orgId, collectionId, policyRevision: 1,
  locationRefs: Object.keys(OBSERVATIONS) });
const context = (orgId, userEmail = "mutator@example.test") => ({ userEmail, orgId,
  caller: "frontend", appId: "workbench" });
const registrationRequest = (locationRef, expectedRegistryRevision = 0, operationId = `register_${locationRef}`) => ({
  operationId, expectedPolicyRevision: 1, expectedRegistryRevision, locationRef,
  displayName: locationRef, contentIdentity: null, attachProjectId: null,
});
const admissionRequest = (binding, expectedRegistryRevision, operationId, patch = {}) => ({
  operationId, expectedPolicyRevision: 1, expectedRegistryRevision,
  bindingId: binding.bindingId, expectedBindingRevision: binding.bindingRevision,
  expectedContentRevision: OBSERVATIONS[binding.locationRef].contentRevision,
  requestedVcsOwner: OBSERVATIONS[binding.locationRef].vcs.kind === "git" ? "git" : null,
  ...patch,
});
const quarantineRequest = (admission, expectedRegistryRevision, patch = {}) => ({
  operationId: admission.ownerOperationId, bindingId: admission.bindingId,
  fence: admission.fence, expectedPolicyRevision: 1, expectedRegistryRevision,
  ...patch,
});
const quarantineResult = (admission, replayed) => ({
  code: "quarantined", bindingId: admission.bindingId,
  ownerOperationId: admission.ownerOperationId, fence: admission.fence, replayed,
});

async function modules() {
  const [{ withMigrationRuntime, runMigrations, closeDbExec, getDbExec }, dbSchema, org,
    model, dbIndex, migrations, tables, native, actions] = await Promise.all([
    import("@agent-native/core/db"), import("@agent-native/core/db/schema"),
    import("@agent-native/core/org"), import("../../../scripts/registry_contract_model.mjs"),
    import("../server/db/index.mjs"), import("../server/db/migrations.mjs"),
    import("../server/db/schema.mjs"), import("../server/native-registry.mjs"),
    import("../server/registry-actions.mjs"),
  ]);
  return { withMigrationRuntime, runMigrations, closeDbExec, getDbExec,
    ...dbSchema, ...org, ...model, ...dbIndex, ...migrations, ...tables, ...native, ...actions };
}

async function childWorker() {
  assert.ok(process.execArgv.includes(HEAP));
  const m = await modules();
  const send = (value) => new Promise((resolve, reject) => process.send(value,
    (error) => error ? reject(error) : resolve()));
  await send({ type: "ready" });
  const payload = await new Promise((resolve) => process.once("message", resolve));
  const counter = { calls: 0 };
  let value;
  try {
    assert.equal(payload.type, "go");
    const runtime = m.createNativeRegistry({ provider: provider(payload.deviceId, counter),
      grant: payload.grant, evaluate: m.evaluateRegistryOperation,
      deriveMutationKeys: m.deriveMutationKeys });
    value = { output: await runtime.mutationQuarantine.run(payload.request, payload.context),
      observationCalls: counter.calls };
  } catch (error) {
    value = { error: errorChain(error), observationCalls: counter.calls };
  } finally {
    await m.closeDbExec();
  }
  await send({ type: "result", value });
  process.disconnect();
}

function startChild(payload) {
  const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "LANG",
    "AGENT_NATIVE_DISABLED_PLUGINS"];
  const env = Object.fromEntries(retained.filter((key) => process.env[key]) // guard:allow-env-credential — Fixed harmless child-process environment allowlist.
    .map((key) => [key, process.env[key]])); // guard:allow-env-credential — Copies only values selected by the fixed allowlist.
  Object.assign(env, {
    VIVARY_17A_CHILD: "1",
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
  let readySettled = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const resolveReady = () => {
    if (!readySettled) { readySettled = true; readyResolve(); }
  };
  const rejectReady = (error) => {
    if (!readySettled) { readySettled = true; readyReject(error); }
  };
  let settledResolve;
  const settled = new Promise((resolve) => { settledResolve = resolve; });
  child.once("close", (code, signal) => settledResolve({ code, signal }));
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      diagnostic = (diagnostic + chunk.toString()).slice(-16000);
      if (bytes > STREAM_LIMIT && !overflow) { overflow = true; child.kill(); }
    });
  }
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error("child exceeded 45 seconds");
      rejectReady(error);
      child.kill();
      reject(error);
    }, 45000);
    child.on("message", (message) => {
      if (message.type === "ready") resolveReady();
      else if (message.type === "result") result = message.value;
    });
    child.on("error", (error) => { rejectReady(error); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || overflow || !result) {
        const error = new Error(`child failed (${code}): ${diagnostic}`);
        rejectReady(error);
        reject(error);
      } else if (!readySettled) {
        const error = new Error("child exited before readiness was observed");
        rejectReady(error);
        reject(error);
      } else resolve({ ...result, exitCode: code });
    });
  });
  completion.catch(() => {});
  const waitForSettlement = async (milliseconds) => {
    let timer;
    const observed = await Promise.race([
      settled.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
    clearTimeout(timer);
    return observed;
  };
  const terminate = async () => {
    if (child.exitCode === null) child.kill();
    if (await waitForSettlement(4000)) return;
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!await waitForSettlement(1000)) throw new Error("child did not settle after termination");
  };
  return { ready, completion, go: () => child.send({ type: "go", ...payload }),
    settled, terminate };
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
  return { entries: entries.length, sha256: sha256(stable(entries)) };
}

async function makeFixture(base) {
  const root = await mkdtemp(path.join(base, "quarantine-"));
  const dirs = Object.fromEntries(Object.keys(OBSERVATIONS).map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(dirs)) await mkdir(directory);
  for (const [name, directory] of Object.entries(dirs)) await writeFile(path.join(directory, "note.txt"), `${name}\n`);
  const gitEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (cwd, ...args) => spawnSync("/usr/bin/git", ["-C", cwd, ...args],
    { env: gitEnv, timeout: 5000, maxBuffer: 32768 });
  for (const args of [["init", "-q", "-b", "main"], ["add", "."],
    ["-c", "commit.gpgSign=false", "commit", "-q", "-m", "fixture"]]) {
    const result = git(dirs.git, ...args);
    assert.equal(result.status, 0, result.stderr.toString());
  }
  await rm(dirs.linked, { recursive: true });
  const linked = git(dirs.git, "worktree", "add", "-q", "-b", "linked", dirs.linked);
  assert.equal(linked.status, 0, linked.stderr.toString());
  const gitRoots = { git: path.join(dirs.git, ".git"), linked: path.join(dirs.git, ".git") };
  return { root, dirs, gitRoots };
}

async function mainTest(t) {
  assert.ok(process.execArgv.includes(HEAP));
  assertNativeSqliteMatchesNode(ensureCorePackageJson());
  ensureProofRoot("VIVARY_17A_PROOF_ROOT");
  assert.ok(process.env.VIVARY_TEST_CORE_PACKAGE_JSON); // guard:allow-env-credential — Reviewed installed Core package manifest path.
  const requestedRoot = process.env.VIVARY_17A_PROOF_ROOT; // guard:allow-env-credential — Disposable proof path.
  assert.ok(requestedRoot && path.isAbsolute(requestedRoot));
  const base = await realpath(requestedRoot);
  const fixture = await makeFixture(base);
  let m;
  // Close the shared database before removing the fixture that holds it:
  // Windows refuses to delete an open SQLite file. Also covers a failure
  // part-way through module loading below.
  t.after(async () => {
    if (m) await m.closeDbExec();
    await rm(fixture.root, { recursive: true, force: true });
  });
  // Parent and forked children share this database. Always use the fixture
  // root the suite removes: never an inherited DATABASE_URL, and not Core's
  // cwd-relative default. Core still creates an empty data/ directory under
  // the working directory, which the package scripts keep in packages/workbench.
  // guard:allow-env-mutation — Test-only fixture location shared with the forked children; process-scoped by design.
  process.env.DATABASE_URL = `file:${path.join(fixture.root, "registry.sqlite")}`; // guard:allow-env-credential — Task-owned SQLite fixture file only.
  m = await modules();
  const cases = [];
  const snapshotPool = new Map();
  const orgId = `org_${randomUUID().replaceAll("-", "")}`;
  const deviceId = `device_${randomUUID().replaceAll("-", "")}`;
  const mutatorEmail = "mutator@example.test";
  const auth = (patch = {}) => ({ role: "project-mutator", capability: "mutate-project",
    policyRevision: 1, authorized: true, ...patch });

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
  const treeOrMissing = async (root) => {
    try { return await treeSummary(root); }
    catch (error) {
      if (error?.code === "ENOENT") return { missing: true };
      throw error;
    }
  };
  const capture = async (locationRef, counter, selectedDeviceId = deviceId) => ({
    sql: await sqlSnapshot(),
    provider: { deviceId: selectedDeviceId, observationCalls: counter.calls },
    project: await treeOrMissing(fixture.dirs[locationRef]),
    git: fixture.gitRoots[locationRef] ? await treeOrMissing(fixture.gitRoots[locationRef]) : null,
  });
  const retainSnapshot = (snapshot) => {
    const id = sha256(stable(snapshot));
    if (!snapshotPool.has(id)) snapshotPool.set(id, snapshot);
    else assert.deepEqual(snapshotPool.get(id), snapshot);
    return id;
  };
  const rowsChanged = (beforeRows, afterRows, key) => {
    const after = new Map(afterRows.map((row) => [row[key], row]));
    return beforeRows.filter((row) => stable(row) !== stable(after.get(row[key])));
  };
  function assertQuarantineDelta(before, after, output) {
    assert.deepEqual(after.projects, before.projects);
    assert.deepEqual(after.bindings, before.bindings);
    assert.deepEqual(after.reservationKeys, before.reservationKeys);
    assert.deepEqual(after.fenceHighWater, before.fenceHighWater);
    assert.deepEqual(after.projects.length, before.projects.length);
    for (const table of ["revisions", "reservations", "receipts"]) {
      assert.equal(after[table].length, before[table].length, `${table} row count changed`);
    }

    const changedRevisions = rowsChanged(before.revisions, after.revisions, "scopeKey");
    assert.equal(changedRevisions.length, 1);
    const oldRevision = changedRevisions[0];
    const newRevision = after.revisions.find((row) => row.scopeKey === oldRevision.scopeKey);
    assert.deepEqual({ ...newRevision, revision: oldRevision.revision }, oldRevision);
    assert.equal(newRevision.revision, oldRevision.revision + 1);

    const changedReservations = rowsChanged(before.reservations, after.reservations, "reservationId");
    assert.equal(changedReservations.length, 1);
    const oldReservation = changedReservations[0];
    const newReservation = after.reservations.find((row) => row.reservationId === oldReservation.reservationId);
    assert.equal(oldReservation.state, "active");
    assert.equal(newReservation.state, "uncertain");
    assert.deepEqual({ ...newReservation, state: oldReservation.state }, oldReservation);
    assert.equal(oldReservation.ownerOperationId, output.ownerOperationId);
    assert.equal(oldReservation.fence, output.fence);

    const changedReceipts = rowsChanged(before.receipts, after.receipts, "receiptKey");
    assert.equal(changedReceipts.length, 1);
    const oldReceiptRow = changedReceipts[0];
    const newReceiptRow = after.receipts.find((row) => row.receiptKey === oldReceiptRow.receiptKey);
    assert.deepEqual({ ...newReceiptRow, record: oldReceiptRow.record }, oldReceiptRow);
    const oldReceipt = JSON.parse(oldReceiptRow.record);
    const newReceipt = JSON.parse(newReceiptRow.record);
    assert.equal(oldRevision.scopeKey, `${oldReceipt.collectionId}:${oldReceipt.deviceId}`);
    assert.equal(oldRevision.collectionId, oldReceipt.collectionId);
    assert.equal(oldRevision.deviceId, oldReceipt.deviceId);
    assert.equal(oldReservation.ownerActorId, oldReceipt.actorId);
    assert.equal(oldReservation.ownerCollectionId, oldReceipt.collectionId);
    assert.equal(oldReservation.ownerDeviceId, oldReceipt.deviceId);
    assert.equal(oldReservation.ownerOperationId, oldReceipt.operationId);
    assert.equal(oldReservation.fence, oldReceipt.output.fence);
    assert.deepEqual(JSON.parse(oldReservation.keys), oldReceipt.output.keys);
    assert.equal(oldReceipt.status, "pending");
    assert.equal(newReceipt.status, "uncertain");
    assert.deepEqual({ ...newReceipt, status: oldReceipt.status }, oldReceipt);
    assert.equal(oldReceipt.output.bindingId, output.bindingId);
    assert.equal(oldReceipt.output.ownerOperationId, output.ownerOperationId);
    assert.equal(oldReceipt.output.fence, output.fence);
    assert.equal(changedRevisions.length + changedReservations.length + changedReceipts.length, 3);
  }
  async function witness(id, locationRef, counter, invoke, expectedCode, {
    sqlChange = false, throws = false, authorization = auth(), observation = "none",
    errorMatch, childSettlement = null, selectedDeviceId = deviceId, expectedOutput,
  } = {}) {
    const before = await capture(locationRef, counter, selectedDeviceId);
    let output;
    let failure;
    try { output = await invoke(); } catch (error) { failure = error; }
    const after = await capture(locationRef, counter, selectedDeviceId);
    const code = failure ? expectedCode : output.code;
    assert.equal(code, expectedCode, `${id} code mismatch`);
    assert.equal(Boolean(failure), throws,
      `${id}: ${failure ? JSON.stringify(errorChain(failure)) : "expected an error but invocation succeeded"}`);
    if (errorMatch) assert.equal(errorMatch(errorChain(failure)), true,
      `${id} raised an unrelated error: ${JSON.stringify(errorChain(failure))}`);
    if (!failure) assert.deepEqual(output, expectedOutput ?? { code: expectedCode },
      `${id} returned an unexpected projection`);
    assert.deepEqual(after.project, before.project, `${id} changed project bytes`);
    assert.deepEqual(after.git, before.git, `${id} changed Git bytes`);
    const delta = after.provider.observationCalls - before.provider.observationCalls;
    if (observation === "none") assert.equal(delta, 0, `${id} observed a root`);
    else assert.ok(delta > 0, `${id} did not perform its admission observations`);
    if (sqlChange === "quarantine") assertQuarantineDelta(before.sql, after.sql, output);
    else assert.deepEqual(after.sql, before.sql, `${id} left partial SQL state`);
    const settlement = typeof childSettlement === "function" ? childSettlement() : childSettlement;
    cases.push({ id, code, before: retainSnapshot(before), after: retainSnapshot(after),
      authorization, observationCalls: { before: before.provider.observationCalls,
        after: after.provider.observationCalls, delta }, childSettlement: settlement,
      error: failure ? errorChain(failure) : null });
    return output;
  }
  const runtime = (collectionId, { selectedDeviceId = deviceId, email = mutatorEmail,
    transform } = {}) => {
    const counter = { calls: 0 };
    const native = m.createNativeRegistry({ provider: provider(selectedDeviceId, counter, transform),
      grant: grant(orgId, collectionId), evaluate: m.evaluateRegistryOperation,
      deriveMutationKeys: m.deriveMutationKeys });
    return { native, counter, context: context(orgId, email), collectionId, selectedDeviceId };
  };
  const selectBinding = async (bundle, locationRef) => (
    await m.getDb().select().from(m.bindings).where(m.and(
      m.eq(m.bindings.collectionId, bundle.collectionId),
      m.eq(m.bindings.deviceId, bundle.selectedDeviceId),
      m.eq(m.bindings.locationRef, locationRef),
    ))
  )[0];
  const createTarget = async (locationRef, collectionId, operationId) => {
    const bundle = runtime(collectionId);
    const registered = await bundle.native.registration.run(
      registrationRequest(locationRef), bundle.context);
    assert.equal(registered.code, "registered");
    const binding = await selectBinding(bundle, locationRef);
    const admission = await bundle.native.mutationAdmission.run(
      admissionRequest(binding, 1, operationId), bundle.context);
    assert.equal(admission.code, "admitted");
    return { ...bundle, binding, admission, revision: 2 };
  };

  await m.withMigrationRuntime(async () => {
    await m.runMigrations(m.ORG_MIGRATIONS, { table: "native_org_quarantine_migrations" })();
    await m.migrateRegistry();
  });
  await m.getDb().insert(m.organizations).values({ id: orgId, name: "Quarantine fixture",
    createdBy: mutatorEmail, createdAt: Date.now() });
  await m.getDb().insert(m.orgMembers).values({ id: `member_${randomUUID().replaceAll("-", "")}`,
    orgId, email: mutatorEmail, role: "owner", joinedAt: Date.now() });
  await m.setAppMemberRole({ appId: "workbench", orgId, email: mutatorEmail,
    role: "project-mutator", updatedBy: mutatorEmail });

  const metadata = runtime("collection_metadata");
  await witness("private-action-metadata", "plain", metadata.counter, async () => {
    const action = metadata.native.mutationQuarantine;
    assert.deepEqual({ http: action.http, agentTool: action.agentTool,
      mcpTool: action.mcpTool, toolCallable: action.toolCallable, readOnly: action.readOnly,
      recordInputs: action.audit.recordInputs, visibility: action.audit.target().visibility },
    { http: false, agentTool: false, mcpTool: false, toolCallable: false, readOnly: false,
      recordInputs: false, visibility: "private" });
    return { code: "private" };
  }, "private");
  await witness("strict-quarantine-request", "plain", metadata.counter, async () => {
    for (const field of ["actorId", "collectionId", "deviceId", "rootId", "resourceKeys",
      "vcs", "receipt", "callerPath"]) {
      await assert.rejects(metadata.native.mutationQuarantine.run({
        operationId: "operation_missing", bindingId: "binding_missing", fence: 1,
        expectedPolicyRevision: 1, expectedRegistryRevision: 0, [field]: "forbidden",
      }, metadata.context), (error) => error.name === "RegistryActionInputError"
        && error.statusCode === 400);
    }
    return metadata.native.mutationQuarantine.run({
      operationId: "operation_missing", bindingId: "binding_missing", fence: 1,
      expectedPolicyRevision: 1, expectedRegistryRevision: 0, callerPath: "forbidden",
    }, metadata.context);
  }, "input-rejected", { throws: true,
    errorMatch: (chain) => chain[0]?.name === "RegistryActionInputError"
      && chain[0]?.statusCode === 400
      && chain[0]?.message === "Invalid registry action request" });

  const boundary = await createTarget("boundary", "collection_boundary", "operation_boundary");
  const [boundaryReceipt] = await m.getDb().select().from(m.receipts)
    .where(m.eq(m.receipts.operationId, boundary.admission.ownerOperationId));
  await m.getDb().update(m.receipts).set({ record: "null" })
    .where(m.eq(m.receipts.receiptKey, boundaryReceipt.receiptKey));
  let entryAuthorizations = 0;
  let factResolutions = 0;
  const boundaryAction = m.createRegistryActions({
    authorizeContext: async () => {
      entryAuthorizations += 1;
      return true;
    },
    resolveFacts: async () => {
      factResolutions += 1;
      const assigned = factResolutions === 1;
      return {
        actorId: boundary.binding.actorId, collectionId: boundary.collectionId, deviceId,
        member: assigned, capabilities: assigned ? ["mutate-project"] : [],
        rootAccess: [], policyRevision: 1,
        root: { rootId: "unverified", locationRef: "unverified", exists: false,
          isDirectory: false, identityVerified: false, contentRevision: "unverified", vcs: noVcs() },
        overlapSafe: false,
      };
    },
    allocateIds: () => assert.fail("revoked quarantine must not allocate"),
    evaluate: m.evaluateRegistryOperation,
    deriveMutationKeys: m.deriveMutationKeys,
  }).mutationQuarantine;
  await witness("revoked-between-entry-and-admission-read", "boundary", boundary.counter, async () => {
    const result = await boundaryAction.run(
      quarantineRequest(boundary.admission, boundary.revision), boundary.context);
    assert.equal(entryAuthorizations, 1);
    assert.equal(factResolutions, 2);
    return result;
  }, "denied", {
    authorization: auth({ role: "unassigned", capability: null, authorized: false }),
  });

  const plain = await createTarget("plain", "collection_plain", "operation_plain");
  await witness("first-no-vcs-quarantine", "plain", plain.counter,
    () => plain.native.mutationQuarantine.run(
      quarantineRequest(plain.admission, plain.revision), plain.context),
  "quarantined", { sqlChange: "quarantine", expectedOutput: quarantineResult(plain.admission, false) });
  await witness("stale-policy-uncertain-repeat", "plain", plain.counter,
    () => plain.native.mutationQuarantine.run({
      ...quarantineRequest(plain.admission, 0), expectedPolicyRevision: 2,
    }, plain.context), "stale-policy", {
      authorization: auth({ authorized: false }),
    });
  await m.setAppMemberRole({ appId: "workbench", orgId, email: mutatorEmail,
    role: "project-registrar", updatedBy: mutatorEmail });
  await witness("revoked-uncertain-repeat", "plain", plain.counter,
    () => plain.native.mutationQuarantine.run(
      quarantineRequest(plain.admission, 0), plain.context),
  "authorization-rejected", { throws: true,
    authorization: auth({ role: "project-registrar", capability: null, authorized: false }),
    errorMatch: (chain) => chain[0]?.statusCode === 403 });
  await m.setAppMemberRole({ appId: "workbench", orgId, email: mutatorEmail,
    role: "project-mutator", updatedBy: mutatorEmail });

  const gitBundle = runtime("collection_git");
  assert.equal((await gitBundle.native.registration.run(
    registrationRequest("git", 0, "register_git"), gitBundle.context)).code, "registered");
  assert.equal((await gitBundle.native.registration.run(
    registrationRequest("linked", 1, "register_linked"), gitBundle.context)).code, "registered");
  const gitBinding = await selectBinding(gitBundle, "git");
  const linkedBinding = await selectBinding(gitBundle, "linked");
  const gitAdmission = await gitBundle.native.mutationAdmission.run(
    admissionRequest(gitBinding, 2, "operation_git"), gitBundle.context);
  assert.equal(gitAdmission.code, "admitted");
  await witness("first-git-quarantine", "git", gitBundle.counter,
    () => gitBundle.native.mutationQuarantine.run(quarantineRequest(gitAdmission, 3), gitBundle.context),
  "quarantined", { sqlChange: "quarantine", expectedOutput: quarantineResult(gitAdmission, false) });

  let restartSettlement;
  await witness("restart-stale-revision-replay", "git", gitBundle.counter, async () => {
    const child = startChild({ deviceId, grant: grant(orgId, "collection_git"),
      context: gitBundle.context, request: quarantineRequest(gitAdmission, 0) });
    try {
      await child.ready;
      child.go();
      const result = await child.completion;
      await child.settled;
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.observationCalls, 0);
      assert.equal(result.output.replayed, true);
      restartSettlement = { started: 1, settled: 1, exitCodes: [result.exitCode],
        codes: [result.output.code], replayed: [result.output.replayed] };
      return result.output;
    } catch (error) {
      await child.terminate();
      await Promise.allSettled([child.completion]);
      throw error;
    }
  }, "quarantined", { childSettlement: () => restartSettlement,
    expectedOutput: quarantineResult(gitAdmission, true) });

  await m.getDb().update(m.revisions).set({ revision: Number.MAX_SAFE_INTEGER })
    .where(m.eq(m.revisions.scopeKey, `collection_git:${deviceId}`));
  await witness("maximum-revision-replay", "git", gitBundle.counter,
    () => gitBundle.native.mutationQuarantine.run(quarantineRequest(gitAdmission, 0), gitBundle.context),
  "quarantined", { expectedOutput: quarantineResult(gitAdmission, true) });
  await m.getDb().update(m.revisions).set({ revision: 4 })
    .where(m.eq(m.revisions.scopeKey, `collection_git:${deviceId}`));

  const stale = await createTarget("stale", "collection_stale", "operation_stale");
  await witness("first-transition-stale-revision", "stale", stale.counter,
    () => stale.native.mutationQuarantine.run(quarantineRequest(stale.admission, 0), stale.context),
  "retry-state");

  const exhausted = await createTarget("exhausted", "collection_exhausted", "operation_exhausted");
  await m.getDb().update(m.revisions).set({ revision: Number.MAX_SAFE_INTEGER })
    .where(m.eq(m.revisions.scopeKey, `collection_exhausted:${deviceId}`));
  await witness("first-transition-revision-exhausted", "exhausted", exhausted.counter,
    () => exhausted.native.mutationQuarantine.run(
      quarantineRequest(exhausted.admission, Number.MAX_SAFE_INTEGER), exhausted.context),
  "invalid-input");

  await witness("wrong-operation-unavailable", "stale", stale.counter,
    () => stale.native.mutationQuarantine.run({
      ...quarantineRequest(stale.admission, stale.revision), operationId: "operation_other",
    }, stale.context), "admission-unavailable");
  await witness("wrong-binding-stale-fence", "stale", stale.counter,
    () => stale.native.mutationQuarantine.run({
      ...quarantineRequest(stale.admission, stale.revision), bindingId: "binding_other",
    }, stale.context), "stale-fence");
  await witness("wrong-fence-stale-fence", "stale", stale.counter,
    () => stale.native.mutationQuarantine.run({
      ...quarantineRequest(stale.admission, stale.revision), fence: stale.admission.fence + 1,
    }, stale.context), "stale-fence");

  const otherEmail = "other-mutator@example.test";
  await m.getDb().insert(m.orgMembers).values({ id: `member_${randomUUID().replaceAll("-", "")}`,
    orgId, email: otherEmail, role: "member", joinedAt: Date.now() });
  await m.setAppMemberRole({ appId: "workbench", orgId, email: otherEmail,
    role: "project-mutator", updatedBy: mutatorEmail });
  const wrongActor = runtime("collection_stale", { email: otherEmail });
  await witness("wrong-actor-unavailable", "stale", wrongActor.counter,
    () => wrongActor.native.mutationQuarantine.run(
      quarantineRequest(stale.admission, stale.revision), wrongActor.context),
  "admission-unavailable");
  const wrongCollection = runtime("collection_other");
  await witness("wrong-collection-unavailable", "stale", wrongCollection.counter,
    () => wrongCollection.native.mutationQuarantine.run(
      quarantineRequest(stale.admission, 0), wrongCollection.context),
  "admission-unavailable");
  const otherDeviceId = `device_${randomUUID().replaceAll("-", "")}`;
  const wrongDevice = runtime("collection_stale", { selectedDeviceId: otherDeviceId });
  await witness("wrong-device-unavailable", "stale", wrongDevice.counter,
    () => wrongDevice.native.mutationQuarantine.run(
      quarantineRequest(stale.admission, 0), wrongDevice.context),
  "admission-unavailable", { selectedDeviceId: otherDeviceId });

  const corruptResourceKey = `${deviceId}:root:${OBSERVATIONS.corrupt.rootId}`;
  await m.getDb().insert(m.mutationFenceHighWater).values({
    resourceKey: corruptResourceKey, fence: 1,
  });
  const corrupt = await createTarget("corrupt", "collection_corrupt", "operation_corrupt");
  assert.equal(corrupt.admission.fence, 2);
  const [corruptReceiptRow] = await m.getDb().select().from(m.receipts)
    .where(m.eq(m.receipts.operationId, corrupt.admission.ownerOperationId));
  const originalReceiptRecord = corruptReceiptRow.record;
  await m.getDb().update(m.receipts).set({ record: "null" })
    .where(m.eq(m.receipts.receiptKey, corruptReceiptRow.receiptKey));
  await witness("stale-policy-before-admission-read", "corrupt", corrupt.counter,
    () => corrupt.native.mutationQuarantine.run({
      ...quarantineRequest(corrupt.admission, corrupt.revision), expectedPolicyRevision: 2,
    }, corrupt.context), "stale-policy", {
      authorization: auth({ policyRevision: 1, authorized: false }),
    });

  await m.setAppMemberRole({ appId: "workbench", orgId, email: mutatorEmail,
    role: "project-registrar", updatedBy: mutatorEmail });
  await witness("registrar-cannot-quarantine", "corrupt", corrupt.counter,
    () => corrupt.native.mutationQuarantine.run(
      quarantineRequest(corrupt.admission, corrupt.revision), corrupt.context),
  "authorization-rejected", { throws: true,
    authorization: auth({ role: "project-registrar", capability: null, authorized: false }),
    errorMatch: (chain) => chain[0]?.statusCode === 403 });
  await m.setAppMemberRole({ appId: "workbench", orgId, email: mutatorEmail,
    role: "project-mutator", updatedBy: mutatorEmail });
  await m.getDb().update(m.receipts).set({ record: originalReceiptRecord })
    .where(m.eq(m.receipts.receiptKey, corruptReceiptRow.receiptKey));

  const missing = await createTarget("missing", "collection_missing", "operation_missing");
  await m.getDb().delete(m.bindings).where(m.eq(m.bindings.bindingId, missing.binding.bindingId));
  await rm(fixture.dirs.missing, { recursive: true, force: true });
  const blind = runtime("collection_missing", {
    transform: () => assert.fail("quarantine must not call provider.observe"),
  });
  await witness("missing-binding-and-root-still-quarantine", "missing", blind.counter,
    () => blind.native.mutationQuarantine.run(
      quarantineRequest(missing.admission, missing.revision), blind.context),
  "quarantined", { sqlChange: "quarantine", expectedOutput: quarantineResult(missing.admission, false) });

  const replaced = await createTarget("replaced", "collection_replaced", "operation_replaced");
  await m.getDb().update(m.bindings).set({
    rootId: "root_changed_after_admission", locationRef: "location_changed_after_admission",
    bindingRevision: replaced.binding.bindingRevision + 1,
  }).where(m.eq(m.bindings.bindingId, replaced.binding.bindingId));
  await rm(fixture.dirs.replaced, { recursive: true, force: true });
  await mkdir(fixture.dirs.replaced);
  await writeFile(path.join(fixture.dirs.replaced, "replacement.txt"), "replacement\n");
  const replacedBlind = runtime("collection_replaced", {
    transform: () => assert.fail("quarantine must not inspect a replaced root or changed binding"),
  });
  await witness("replaced-root-changed-binding-still-quarantine", "replaced", replacedBlind.counter,
    () => replacedBlind.native.mutationQuarantine.run(
      quarantineRequest(replaced.admission, replaced.revision), replacedBlind.context),
  "quarantined", { sqlChange: "quarantine", expectedOutput: quarantineResult(replaced.admission, false) });

  async function corruptWitness(id, mutate, restore, expectedCode = "invalid-input") {
    await mutate();
    try {
      await witness(id, "corrupt", corrupt.counter,
        () => corrupt.native.mutationQuarantine.run(
          quarantineRequest(corrupt.admission, corrupt.revision), corrupt.context), expectedCode);
    } finally {
      await restore();
    }
  }
  const receiptRecord = JSON.parse(originalReceiptRecord);
  const [parentRow] = await m.getDb().select().from(m.mutationReservations)
    .where(m.eq(m.mutationReservations.ownerOperationId, corrupt.admission.ownerOperationId));
  const [claimRow] = await m.getDb().select().from(m.mutationReservationKeys)
    .where(m.eq(m.mutationReservationKeys.reservationId, parentRow.reservationId));
  const [highWaterRow] = await m.getDb().select().from(m.mutationFenceHighWater)
    .where(m.eq(m.mutationFenceHighWater.resourceKey, claimRow.resourceKey));
  const setReceiptRecord = (record) => m.getDb().update(m.receipts)
    .set({ record: typeof record === "string" ? record : JSON.stringify(record) })
    .where(m.eq(m.receipts.receiptKey, corruptReceiptRow.receiptKey));

  await corruptWitness("receipt-null-invalid", () => setReceiptRecord("null"),
    () => setReceiptRecord(originalReceiptRecord));
  await corruptWitness("receipt-envelope-invalid", () => setReceiptRecord({
    ...receiptRecord, actorId: "actor_other",
  }), () => setReceiptRecord(originalReceiptRecord));

  const forgedKey = `${deviceId}:root:root_forged`;
  const forgedReceipt = structuredClone(receiptRecord);
  forgedReceipt.output.keys = [forgedKey];
  await corruptWitness("receipt-derived-keys-invalid", async () => {
    await m.getDb().transaction(async (tx) => {
      await tx.update(m.receipts).set({ record: JSON.stringify(forgedReceipt) })
        .where(m.eq(m.receipts.receiptKey, corruptReceiptRow.receiptKey));
      await tx.update(m.mutationReservations).set({ keys: JSON.stringify([forgedKey]) })
        .where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId));
      await tx.update(m.mutationReservationKeys).set({ resourceKey: forgedKey })
        .where(m.eq(m.mutationReservationKeys.resourceKey, claimRow.resourceKey));
      await tx.update(m.mutationFenceHighWater).set({ resourceKey: forgedKey })
        .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey));
    });
  }, async () => {
    await m.getDb().transaction(async (tx) => {
      await tx.update(m.receipts).set({ record: originalReceiptRecord })
        .where(m.eq(m.receipts.receiptKey, corruptReceiptRow.receiptKey));
      await tx.update(m.mutationReservations).set({ keys: parentRow.keys })
        .where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId));
      await tx.update(m.mutationReservationKeys).set({ resourceKey: claimRow.resourceKey })
        .where(m.eq(m.mutationReservationKeys.resourceKey, forgedKey));
      await tx.update(m.mutationFenceHighWater).set({ resourceKey: highWaterRow.resourceKey })
        .where(m.eq(m.mutationFenceHighWater.resourceKey, forgedKey));
    });
  });
  await corruptWitness("parent-owner-invalid", () => m.getDb().update(m.mutationReservations)
    .set({ ownerActorId: "actor_other" })
    .where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId)),
  () => m.getDb().update(m.mutationReservations).set({ ownerActorId: parentRow.ownerActorId })
    .where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId)));
  await corruptWitness("claim-missing", () => m.getDb().delete(m.mutationReservationKeys)
    .where(m.eq(m.mutationReservationKeys.resourceKey, claimRow.resourceKey)),
  () => m.getDb().insert(m.mutationReservationKeys).values(claimRow));
  const foreignClaim = `${deviceId}:root:root_foreign`;
  await corruptWitness("claim-foreign", () => m.getDb().update(m.mutationReservationKeys)
    .set({ resourceKey: foreignClaim })
    .where(m.eq(m.mutationReservationKeys.resourceKey, claimRow.resourceKey)),
  () => m.getDb().update(m.mutationReservationKeys).set({ resourceKey: claimRow.resourceKey })
    .where(m.eq(m.mutationReservationKeys.resourceKey, foreignClaim)));
  await corruptWitness("high-water-missing", () => m.getDb().delete(m.mutationFenceHighWater)
    .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey)),
  () => m.getDb().insert(m.mutationFenceHighWater).values(highWaterRow));
  await corruptWitness("high-water-lower", () => m.getDb().update(m.mutationFenceHighWater)
    .set({ fence: highWaterRow.fence - 1 })
    .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey)),
  () => m.getDb().update(m.mutationFenceHighWater).set({ fence: highWaterRow.fence })
    .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey)));
  await corruptWitness("high-water-higher", () => m.getDb().update(m.mutationFenceHighWater)
    .set({ fence: highWaterRow.fence + 1 })
    .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey)),
  () => m.getDb().update(m.mutationFenceHighWater).set({ fence: highWaterRow.fence })
    .where(m.eq(m.mutationFenceHighWater.resourceKey, highWaterRow.resourceKey)));
  await corruptWitness("mixed-receipt-lifecycle", () => setReceiptRecord({
    ...receiptRecord, status: "uncertain",
  }), () => setReceiptRecord(originalReceiptRecord), "reconciliation-required");
  await corruptWitness("mixed-parent-lifecycle", () => m.getDb().update(m.mutationReservations)
    .set({ state: "uncertain" }).where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId)),
  () => m.getDb().update(m.mutationReservations).set({ state: "active" })
    .where(m.eq(m.mutationReservations.reservationId, parentRow.reservationId)),
  "reconciliation-required");

  const rollback = await createTarget("rollback", "collection_rollback", "operation_rollback");
  for (const [id, statement] of [
    ["rollback-revision", "CREATE TRIGGER quarantine_fault BEFORE UPDATE ON vivary_registry_revisions BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
    ["rollback-reservation", "CREATE TRIGGER quarantine_fault BEFORE UPDATE ON vivary_mutation_reservations BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
    ["rollback-receipt", "CREATE TRIGGER quarantine_fault BEFORE UPDATE OF record ON vivary_registry_receipts WHEN OLD.operation = 'admit-mutation' BEGIN SELECT RAISE(ABORT, 'fixture'); END"],
  ]) {
    await m.getDbExec().execute(statement);
    try {
      await witness(id, "rollback", rollback.counter,
        () => rollback.native.mutationQuarantine.run(
          quarantineRequest(rollback.admission, rollback.revision), rollback.context),
      "injected-error", { throws: true,
        errorMatch: (chain) => chain.some((entry) => entry.message === "fixture"
          && entry.code === "SQLITE_CONSTRAINT_TRIGGER") });
    } finally {
      await m.getDbExec().execute("DROP TRIGGER quarantine_fault");
    }
  }

  await witness("same-key-contender-quarantined", "linked", gitBundle.counter,
    () => gitBundle.native.mutationAdmission.run(
      admissionRequest(linkedBinding, 4, "operation_linked_contender"), gitBundle.context),
  "reconciliation-required", { observation: "positive" });
  const cross = runtime("collection_cross");
  assert.equal((await cross.native.registration.run(
    registrationRequest("git", 0, "register_cross_git"), cross.context)).code, "registered");
  const crossBinding = await selectBinding(cross, "git");
  await witness("cross-collection-contender-quarantined", "git", cross.counter,
    () => cross.native.mutationAdmission.run(
      admissionRequest(crossBinding, 1, "operation_cross_contender"), cross.context),
  "reconciliation-required", { observation: "positive" });

  const pending = await createTarget("pending", "collection_pending", "operation_pending");
  await witness("pending-retry-preserved", "pending", pending.counter,
    () => pending.native.mutationAdmission.run(
      admissionRequest(pending.binding, 1, "operation_pending"), pending.context),
  "reconciliation-required", { observation: "positive" });
  await witness("pending-digest-conflict-preserved", "pending", pending.counter,
    () => pending.native.mutationAdmission.run(admissionRequest(
      pending.binding, 1, "operation_pending", { expectedContentRevision: "content_changed" }),
    pending.context), "operation-conflict", { observation: "positive" });

  const race = await createTarget("race", "collection_race", "operation_race");
  const raceRequest = quarantineRequest(race.admission, race.revision);
  const beforeRace = await capture("race", race.counter);
  const children = [0, 1].map(() => startChild({ deviceId,
    grant: grant(orgId, "collection_race"), context: race.context, request: raceRequest }));
  let childResults;
  try {
    await Promise.all(children.map((child) => child.ready));
    children.forEach((child) => child.go());
    childResults = await Promise.all(children.map((child) => child.completion));
    await Promise.all(children.map((child) => child.settled));
  } catch (error) {
    await Promise.allSettled(children.map((child) => child.terminate()));
    await Promise.allSettled(children.map((child) => child.completion));
    throw error;
  }
  assert.ok(childResults.every((result) => result.error === undefined), JSON.stringify(childResults));
  assert.ok(childResults.every((result) => result.observationCalls === 0));
  assert.deepEqual(childResults.map((result) => result.output)
    .sort((left, right) => Number(left.replayed) - Number(right.replayed)),
  [quarantineResult(race.admission, false), quarantineResult(race.admission, true)]);
  const afterRace = await capture("race", race.counter);
  assertQuarantineDelta(beforeRace.sql, afterRace.sql,
    childResults.find((result) => result.output.replayed === false).output);
  assert.deepEqual(afterRace.project, beforeRace.project);
  assert.deepEqual(afterRace.git, beforeRace.git);
  assert.equal(afterRace.provider.observationCalls, beforeRace.provider.observationCalls);
  cases.push({ id: "independent-process-single-transition", code: "one-transition-one-replay",
    before: retainSnapshot(beforeRace), after: retainSnapshot(afterRace), authorization: auth(),
    observationCalls: { before: beforeRace.provider.observationCalls,
      after: afterRace.provider.observationCalls, delta: 0 },
    childSettlement: { started: 2, settled: 2,
      exitCodes: childResults.map((result) => result.exitCode),
      codes: childResults.map((result) => result.output.code),
      replayed: childResults.map((result) => result.output.replayed).sort() },
    error: null });

  assert.deepEqual(cases.map(({ id, code }) => [id, code]), EXPECTED_CASES);
  const quarantineWitnessPayload = {
    schema: "vivary.17a-quarantine-witness/v1",
    contract: "vivary.project-registry-contract.v1",
    errorExpectations: ERROR_EXPECTATIONS,
    cases,
    snapshots: [...snapshotPool].map(([id, value]) => ({ id, ...value })),
  };
  const quarantineWitnessBytes = Buffer.from(JSON.stringify(quarantineWitnessPayload), "utf8");
  assert.ok(quarantineWitnessBytes.length > 0 && quarantineWitnessBytes.length <= 8 * 1024 * 1024);
  const quarantineWitnessEnvelope = {
    schema: "vivary.17a-quarantine-witness-transport/v1",
    encoding: "gzip+base64",
    bytes: quarantineWitnessBytes.length,
    sha256: sha256(quarantineWitnessBytes),
    data: gzipSync(quarantineWitnessBytes, { level: 9 }).toString("base64"),
  };
  const quarantineWitnessLine = `VIVARY_17A_QUARANTINE_WITNESS ${JSON.stringify(quarantineWitnessEnvelope)}`;
  assert.ok(Buffer.byteLength(quarantineWitnessLine, "utf8") < 900 * 1024);
  process.stdout.write(`${quarantineWitnessLine}\n`);
}

if (process.env.VIVARY_17A_CHILD === "1") { // guard:allow-env-credential — Test-only child role marker.
  await childWorker();
} else {
  test("quarantine mutation preserves admitted ownership under every bounded witness", {
    timeout: 170000,
  }, mainTest);
}
