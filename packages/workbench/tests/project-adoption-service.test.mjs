import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Use the host's native temporary filesystem for byte/mtime retry assertions.
// Zo's mounted /tmp can report cached timestamps from before a completed write.
const directory = await mkdtemp(path.join(process.platform === "linux" ? "/dev/shm" : os.tmpdir(), "vivary-adoption-app-"));
const dataDir = path.join(directory, "data");
const database = "file:" + path.join(directory, "app.sqlite");
Object.assign(process.env, { APP_NAME: "Vivary", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARY_DATABASE_URL: database, VIVARY_DATABASE_URL_UNPOOLED: database, VIVARY_DATA_DIR: dataDir });
const { withMigrationRuntime, runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers, setAppMemberRole } = await import("@agent-native/core/org");
const { getSetting, mutateSetting, deleteSettingIfValue } = await import("@agent-native/core/settings");
const { getDb } = await import("../server/db/index.mjs");
const { migrateRegistry } = await import("../server/db/migrations.mjs");
const { projects, bindings } = await import("../server/db/schema.mjs");
const { eq } = await import("@agent-native/core/db/schema");
const { createLocalRootProvider } = await import("../server/local-root-provider.mjs");
const { createNativeRegistry } = await import("../server/native-registry.mjs");
const { createProjectCatalog } = await import("../server/project-catalog.mjs");
const { connectLocalProjectFolder, resolveLocalProjectWorkspace } = await import("../server/project-services.mjs");
const { createProjectAdoptionService } = await import("../server/project-adoption.ts");
const { originalChildEnvironment, originalCommandArguments, runOriginalProcess } = await import("../server/original-runtime.ts");
const { evaluateRegistryOperation, deriveMutationKeys } = await import("../../../scripts/registry_contract_model.mjs");
const { default: action } = await import("../actions/vivary-project-adoption.ts");
const creator = path.resolve(import.meta.dirname, "../../create-vivary/create_vivary.py");
const context = { caller: "frontend", appId: "vivary", userEmail: "owner@local.vivary.test", orgId: "adoption-test-org" };
const owner = { ...context, appId: "workbench" };
const executeFile = promisify(execFile);
let provider;
let executions = 0;
let loseResponse = false;
let crash = null;
let beforeExecute = async () => {};
async function execute(command, workspace) {
  executions++;
  await beforeExecute();
  const invocation = originalCommandArguments(command, workspace.root);
  let output;
  const crashMode = crash;
  crash = null;
  if (crashMode && command.verb === "adopt-apply") {
    const script = `import runpy,sys
m=runpy.run_path(sys.argv[1])
f=m['adopt_workspace']
if sys.argv[5] == 'publishing':
 original=f.__globals__['_write_adopt_journal']
 def write(target,payload,**kw):
  original(target,payload,**kw)
  if payload.get('phase') == 'publishing': raise KeyboardInterrupt('injected publishing crash')
 f.__globals__['_write_adopt_journal']=write
f(sys.argv[2],yes=True,plan_hash=sys.argv[3],request_id=sys.argv[4],_crash_after=2 if sys.argv[5]=='applying' else None)
`;
    try { await executeFile("python3", ["-B", "-c", script, creator, workspace.root, command.planHash, command.requestId, crashMode]); }
    catch { return { exitCode: 130, stdout: "", stderr: "injected crash", signal: null }; }
    assert.fail("crash injection did not run");
  }
  try {
    if (invocation.stdin) {
      output = await runOriginalProcess("python3", ["-B", creator, ...invocation.args], invocation.stdin,
        dataDir, originalChildEnvironment(process.env, path.join(dataDir, "original-runtime", "receipts.jsonl"), workspace.root));
    } else {
      const result = await executeFile("python3", ["-B", creator, ...invocation.args], { maxBuffer: 512 * 1024 });
      output = { exitCode: 0, ...result, signal: null };
    }
  } catch (error) { output = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr, signal: error.signal }; }
  if (loseResponse) { loseResponse = false; throw new Error("injected lost response"); }
  return output;
}
function service() {
  return createProjectAdoptionService({ resolveWorkspace: resolveLocalProjectWorkspace,
    preview: async (input, ctx) => execute(input.command, await resolveLocalProjectWorkspace(ctx, input.projectId)),
    execute, get: getSetting, mutate: mutateSetting, remove: deleteSettingIfValue });
}
async function reopen() {
  await provider?.close();
  provider = await createLocalRootProvider({ ownerEmail: context.userEmail });
  const registry = createNativeRegistry({ provider, resolveGrant: provider.resolveGrant,
    evaluate: evaluateRegistryOperation, deriveMutationKeys });
  const catalog = createProjectCatalog({ readScope: registry.readScope, provider, locationLabels: provider.locationLabels });
  globalThis[Symbol.for("vivary.local-project-services.v1")] = {
    provider, registry, catalog, controller: { snapshot: () => ({ status: "open" }) },
  };
  await provider.resolveGrant(owner);
}
async function snapshot(root) {
  const result = {};
  async function visit(relative) {
    for (const name of await readdir(path.join(root, relative))) {
      const rel = path.join(relative, name);
      const file = path.join(root, rel);
      const info = await stat(file);
      if (info.isDirectory()) { result[rel + "/"] = "directory"; await visit(rel); }
      else result[rel] = { bytes: (await readFile(file)).toString("base64"), mtime: info.mtimeMs };
    }
  }
  await visit("");
  return result;
}
const approval = (review, operation = "apply") => ({ operation, projectId: review.projectId,
  operationId: review.operationId, acceptedPlanHash: review.planHash });
async function preview(run, projectId, preset = "auto") {
  const result = await run({ operation: "preview", projectId, preset }, context);
  assert.equal(result.code, "preview", JSON.stringify(result));
  return result;
}

test("registered existing-folder setup uses creator plans, exact owner approval and durable replay", async suite => {
  await mkdir(dataDir);
  await withMigrationRuntime(async () => {
    await runMigrations(ORG_MIGRATIONS, { table: "adoption_test_org_migrations" })();
    await migrateRegistry();
  });
  await getDb().insert(organizations).values({ id: context.orgId, name: "Adoption test", createdBy: context.userEmail, createdAt: Date.now() });
  await getDb().insert(orgMembers).values({ id: "adoption-owner", orgId: context.orgId,
    email: context.userEmail, role: "owner", joinedAt: Date.now() });
  try {
    await reopen();
    const folders = {};
    for (const name of ["Alpha", "Beta", "Unprotected", "UnprotectedPresent", "LostPrivacy", "PreparedRecovery", "StaleIgnore", "Tracked", "Recovery", "Interrupted", "Uncertain", "RecoveryRetry", "Symlink", "RetryRefusal", "ConcurrentRetry"]) {
      const root = path.join(directory, name);
      await mkdir(root);
      await writeFile(path.join(root, "AGENTS.md"), "# Existing owner guidance\nKeep these instructions.\n");
      await writeFile(path.join(root, "unrelated.txt"), "Do not change me.\n");
      if (!["Unprotected", "UnprotectedPresent", "LostPrivacy", "PreparedRecovery", "StaleIgnore"].includes(name)) await writeFile(path.join(root, ".gitignore"), ".vivary/runtime/\n");
      if (name === "UnprotectedPresent" || name === "StaleIgnore") await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
      const registration = await connectLocalProjectFolder(context, root);
      assert.equal(registration.code, "registered");
      folders[name] = { root, projectId: registration.projectId };
    }
    let run = service();
    const alpha = folders.Alpha;
    const beta = folders.Beta;

    await suite.test("preview and Cancel preserve every project byte and timestamp", async () => {
      const before = await snapshot(alpha.root);
      const review = await preview(run, alpha.projectId);
      assert.equal(review.report.request_replay.ready, true);
      assert.deepEqual(await snapshot(alpha.root), before);
      assert.deepEqual(await run(approval(review, "cancel"), context), { code: "idle" });
      assert.deepEqual(await snapshot(alpha.root), before);
      await assert.rejects(run(approval(review), context), /does not match/);
    });
    await suite.test("owner action rejects tool callers and unrelated owners before creator invocation", async () => {
      assert.equal(action.toolCallable, false);
      assert.equal(action.agentTool, false);
      assert.equal(action.mcpTool, false);
      assert.equal(action.requiresAuth, true);
      const calls = executions;
      for (const ctx of [undefined, { ...context, caller: "agent" }, { ...context, userEmail: "another@example.test" }]) {
        await assert.rejects(run({ operation: "preview", projectId: alpha.projectId, preset: "auto" }, ctx));
      }
      assert.equal(executions, calls);
    });
    await suite.test("options, target and content require the exact current review", async () => {
      const old = await preview(run, alpha.projectId);
      const review = await preview(run, alpha.projectId, "writing");
      const calls = executions;
      await assert.rejects(run(approval(old), context), /does not match/);
      await assert.rejects(run({ ...approval(review), projectId: beta.projectId }, context), /does not match/);
      await assert.rejects(run({ ...approval(review), acceptedPlanHash: "sha256:" + "0".repeat(64) }, context), /does not match/);
      assert.equal(executions, calls);
      await writeFile(path.join(alpha.root, "AGENTS.md"), "# Changed owner guidance\nKeep this revision.\n");
      const before = await snapshot(alpha.root);
      const changed = await run(approval(review), context);
      assert.equal(changed.code, "refused");
      assert.match(changed.message, /changed/);
      assert.deepEqual(await snapshot(alpha.root), before);
    });
    await suite.test("refresh replaces an unapproved preview with the requested options and current files", async () => {
      const old = await preview(run, alpha.projectId, "coding");
      const writing = await preview(run, alpha.projectId, "writing");
      assert.equal(writing.preset, "writing");
      assert.equal(writing.report.preset, "writing");
      assert.notEqual(writing.operationId, old.operationId);
      await writeFile(path.join(alpha.root, "unrelated.txt"), "Updated outside setup.\n");
      await writeFile(path.join(alpha.root, "AGENTS.md"), "# Changed owner guidance\nKeep this revision.\nFresh preview sees this line.\n");
      const before = await snapshot(alpha.root);
      const refreshed = await preview(run, alpha.projectId, "writing");
      assert.notEqual(refreshed.planHash, writing.planHash);
      assert.match(refreshed.report.content_plan.files.find(file => file.path === "AGENTS.md").content, /Fresh preview sees this line/);
      assert.deepEqual(await snapshot(alpha.root), before);
      await assert.rejects(run(approval(writing), context), /does not match/);
      await run(approval(refreshed, "cancel"), context);
    });
    await suite.test("a binding change discards unapproved content and permits a fresh cancellable preview", async () => {
      const review = await preview(run, alpha.projectId);
      const workspace = await resolveLocalProjectWorkspace(context, alpha.projectId);
      const before = await snapshot(alpha.root);
      await getDb().update(bindings).set({ bindingRevision: workspace.bindingRevision + 1 })
        .where(eq(bindings.bindingId, workspace.bindingId));
      assert.deepEqual(await run({ operation: "resume", projectId: alpha.projectId }, context), { code: "idle" });
      await assert.rejects(run(approval(review), context), /does not match/);
      const refreshed = await preview(run, alpha.projectId);
      assert.notEqual(refreshed.planHash, review.planHash);
      assert.deepEqual(await run(approval(refreshed, "cancel"), context), { code: "idle" });
      assert.deepEqual(await snapshot(alpha.root), before);
    });
    await suite.test("revoked application role prevents writes", async () => {
      const review = await preview(run, alpha.projectId);
      const before = await snapshot(alpha.root);
      await setAppMemberRole({ appId: "workbench", orgId: context.orgId, email: context.userEmail,
        role: "denied-role", updatedBy: context.userEmail });
      await assert.rejects(run(approval(review), context));
      assert.deepEqual(await snapshot(alpha.root), before);
      await setAppMemberRole({ appId: "workbench", orgId: context.orgId, email: context.userEmail,
        role: "project-registrar", updatedBy: context.userEmail });
    });
    await suite.test("apply matches reviewed bytes and preserves unrelated files and existing guidance", async () => {
      const review = await preview(run, alpha.projectId);
      const unrelated = (await snapshot(alpha.root))["unrelated.txt"];
      const result = await run(approval(review), context);
      assert.deepEqual(result, { code: "applied", projectId: alpha.projectId, replayed: false });
      for (const file of review.report.content_plan.files) {
        assert.equal(await readFile(path.join(alpha.root, file.path), "utf8"), file.content);
      }
      assert.match(await readFile(path.join(alpha.root, "AGENTS.md"), "utf8"), /^# Changed owner guidance\nKeep this revision\.\n/);
      assert.deepEqual((await snapshot(alpha.root))["unrelated.txt"], unrelated);
      const after = await snapshot(alpha.root);
      assert.deepEqual(await run(approval(review), context), { code: "applied", projectId: alpha.projectId, replayed: true });
      assert.deepEqual(await snapshot(alpha.root), after);
    });
    await suite.test("lost response survives service restart and replay makes no duplicate writes or projects", async () => {
      const review = await preview(run, beta.projectId);
      loseResponse = true;
      await assert.rejects(run(approval(review), context), /lost response/);
      const after = await snapshot(beta.root);
      const beforeProjects = await getDb().select().from(projects);
      const beforeBindings = await getDb().select().from(bindings);
      await reopen();
      run = service();
      const resumed = await run({ operation: "resume", projectId: beta.projectId }, context);
      assert.equal(resumed.code, "pending");
      assert.equal(resumed.operationId, review.operationId);
      assert.deepEqual(await run(approval(resumed), context), { code: "applied", projectId: beta.projectId, replayed: true });
      assert.deepEqual(await snapshot(beta.root), after);
      const registration = await connectLocalProjectFolder(context, beta.root);
      assert.equal(registration.code, "already-registered");
      assert.equal(registration.projectId, beta.projectId);
      assert.deepEqual(await getDb().select().from(projects), beforeProjects);
      assert.deepEqual(await getDb().select().from(bindings), beforeBindings);
    });
    await suite.test("missing and existing ignore files require separate exact privacy approval and a fresh setup review", async () => {
      for (const target of [folders.Unprotected, folders.UnprotectedPresent]) {
        const before = await snapshot(target.root);
        const review = await preview(run, target.projectId);
        assert.equal(review.report.request_replay.ready, false);
        assert.equal(review.report.privacy_preparation.required, true);
        assert.equal(review.report.privacy_preparation.ready, true);
        const approvedIgnore = review.report.content_plan.files.find(file => file.path === ".gitignore");
        assert.ok(approvedIgnore);
        assert.deepEqual(await snapshot(target.root), before, "preview must remain read-only");

        const prepared = await run(approval(review, "prepare-privacy"), context);
        assert.deepEqual(prepared, { code: "privacy-prepared", projectId: target.projectId, replayed: false });
        assert.equal(await readFile(path.join(target.root, ".gitignore"), "utf8"), approvedIgnore.content);
        const afterPreparation = await snapshot(target.root);
        assert.deepEqual(Object.keys(afterPreparation).sort(), [...new Set([...Object.keys(before), ".gitignore"])].sort());
        for (const [name, value] of Object.entries(before)) {
          if (name !== ".gitignore") assert.deepEqual(afterPreparation[name], value);
        }
        assert.equal((await readdir(target.root)).includes(".vivary"), false,
          "privacy-only approval must not create setup or recovery files");
        await assert.rejects(run(approval(review), context), /Finish privacy preparation/);
        assert.equal((await run({ operation: "resume", projectId: target.projectId }, context)).code, "privacy-prepared");

        const fresh = await preview(run, target.projectId);
        assert.notEqual(fresh.operationId, review.operationId);
        assert.equal(fresh.report.request_replay.ready, true);
        assert.deepEqual(await run(approval(fresh, "cancel"), context), { code: "idle" });
        assert.deepEqual(await snapshot(target.root), afterPreparation, "cancel after privacy approval keeps the reviewed ignore change");
      }
    });
    await suite.test("privacy preparation keeps one operation across a lost response and restart without writing on resume", async () => {
      const target = folders.LostPrivacy;
      const review = await preview(run, target.projectId);
      const approvedIgnore = review.report.content_plan.files.find(file => file.path === ".gitignore").content;
      loseResponse = true;
      await assert.rejects(run(approval(review, "prepare-privacy"), context), /lost response/);
      const afterWrite = await snapshot(target.root);
      assert.equal(await readFile(path.join(target.root, ".gitignore"), "utf8"), approvedIgnore);
      const calls = executions;
      const resumed = await run({ operation: "resume", projectId: target.projectId }, context);
      assert.equal(resumed.code, "privacy-pending");
      assert.equal(resumed.operationId, review.operationId);
      assert.deepEqual(await snapshot(target.root), afterWrite);
      assert.equal(executions, calls, "resume must not dispatch another filesystem operation");

      await reopen();
      run = service();
      const afterRestart = await run({ operation: "resume", projectId: target.projectId }, context);
      assert.equal(afterRestart.code, "privacy-pending");
      assert.equal(afterRestart.operationId, review.operationId);
      assert.deepEqual(await snapshot(target.root), afterWrite);
      assert.equal(executions, calls);
      assert.deepEqual(await run(approval(afterRestart, "prepare-privacy"), context),
        { code: "privacy-prepared", projectId: target.projectId, replayed: true });
      assert.deepEqual(await snapshot(target.root), afterWrite);
    });
    await suite.test("stale ignore and guidance bytes refuse privacy preparation without overwriting owner edits", async () => {
      const target = folders.StaleIgnore;
      let review = await preview(run, target.projectId);
      const ignorePath = path.join(target.root, ".gitignore");
      await writeFile(ignorePath, "node_modules/\n# Owner edit after preview\n");
      let changed = await snapshot(target.root);
      const staleIgnore = await run(approval(review, "prepare-privacy"), context);
      assert.equal(staleIgnore.code, "refused");
      assert.match(staleIgnore.message, /changed|new preview/i);
      assert.deepEqual(await snapshot(target.root), changed);

      review = await preview(run, target.projectId);
      await writeFile(path.join(target.root, "AGENTS.md"), "# New owner guidance\nKeep this revision.\n");
      changed = await snapshot(target.root);
      const staleGuidance = await run(approval(review, "prepare-privacy"), context);
      assert.equal(staleGuidance.code, "refused");
      assert.match(staleGuidance.message, /changed|new preview/i);
      assert.deepEqual(await snapshot(target.root), changed);
    });
    await suite.test("tracked runtime records block setup with a specific explanation and no index or file changes", async () => {
      const target = folders.Tracked;
      const runtime = path.join(target.root, ".vivary", "runtime");
      await mkdir(runtime, { recursive: true });
      await writeFile(path.join(runtime, "synthetic-record.db"), "fixture only\n");
      await executeFile("git", ["init", "-q"], { cwd: target.root });
      await executeFile("git", ["add", "-f", ".vivary/runtime/synthetic-record.db"], { cwd: target.root });
      const before = await snapshot(target.root);
      const tracked = await executeFile("git", ["ls-files", "--cached", "-z"], { cwd: target.root });
      const review = await preview(run, target.projectId);
      assert.equal(review.report.request_replay.ready, false);
      assert.match(review.report.request_replay.reason, /tracks|tracked/i);
      assert.deepEqual(await snapshot(target.root), before);
      assert.equal((await executeFile("git", ["ls-files", "--cached", "-z"], { cwd: target.root })).stdout, tracked.stdout);
      await assert.rejects(run(approval(review), context));
      assert.deepEqual(await snapshot(target.root), before);
    });
    await suite.test("a confirmed first-attempt refusal permits another preview and Cancel", async () => {
      const target = folders.Symlink;
      const outside = path.join(directory, "symlink-target");
      await mkdir(outside);
      await mkdir(path.join(target.root, ".vivary"));
      await symlink(outside, path.join(target.root, ".vivary/runtime"), "dir");
      const review = await preview(run, target.projectId);
      assert.equal(review.report.request_replay.ready, true);
      const before = await snapshot(target.root);
      const result = await run(approval(review), context);
      assert.equal(result.code, "refused", JSON.stringify(result));
      assert.match(result.message, /outside the selected target directory/);
      assert.deepEqual(await snapshot(target.root), before);
      await unlink(path.join(target.root, ".vivary/runtime"));
      const refreshed = await preview(run, target.projectId);
      assert.deepEqual(await run(approval(refreshed, "cancel"), context), { code: "idle" });
      assert.deepEqual(await readdir(outside), []);
    });
    await suite.test("a pre-mutation refusal on retry cannot discard earlier incomplete writes", async () => {
      const target = folders.RetryRefusal;
      const review = await preview(run, target.projectId);
      crash = "applying";
      assert.equal((await run(approval(review), context)).code, "pending");
      const interrupted = await snapshot(target.root);
      const runtime = path.join(target.root, ".vivary/runtime");
      const held = path.join(directory, "held-retry-runtime");
      const outside = path.join(directory, "empty-retry-runtime");
      await mkdir(outside);
      await rename(runtime, held);
      await symlink(outside, runtime, "dir");
      try {
        const result = await run(approval(review), context);
        assert.equal(result.code, "pending", JSON.stringify(result));
        assert.match(result.message, /outside the selected target directory/);
        assert.equal((await run({ operation: "resume", projectId: target.projectId }, context)).operationId, review.operationId);
        await assert.rejects(run(approval(review, "cancel"), context), /cannot be cancelled/);
        const refreshed = await run({ operation: "preview", projectId: target.projectId, preset: "writing" }, context);
        assert.equal(refreshed.code, "pending");
        assert.equal(refreshed.operationId, review.operationId);
      } finally {
        await unlink(runtime);
        await rename(held, runtime);
      }
      assert.deepEqual(await snapshot(target.root), interrupted);
    });
    await suite.test("recovery preserves the separately approved ignore guard and restores original owner files", async () => {
      const target = folders.PreparedRecovery;
      const before = await snapshot(target.root);
      const privacyReview = await preview(run, target.projectId);
      const approvedIgnore = privacyReview.report.content_plan.files.find(file => file.path === ".gitignore").content;
      assert.equal((await run(approval(privacyReview, "prepare-privacy"), context)).code, "privacy-prepared");
      assert.equal(await readFile(path.join(target.root, ".gitignore"), "utf8"), approvedIgnore);

      const setupReview = await preview(run, target.projectId);
      assert.notEqual(setupReview.operationId, privacyReview.operationId);
      assert.equal(setupReview.report.request_replay.ready, true);
      crash = "applying";
      assert.equal((await run(approval(setupReview), context)).code, "pending");
      run = service();
      const recovery = await run(approval(setupReview, "preview-recovery"), context);
      assert.equal(recovery.code, "recovery-preview");
      assert.equal(recovery.recovery.recovery_actions.some(action => action.path === ".gitignore"), false,
        "setup rollback must not undo the separately approved privacy change");
      const interrupted = await snapshot(target.root);
      assert.deepEqual(await run({ ...approval(setupReview, "recover"),
        acceptedRecoveryHash: recovery.recovery.recovery_plan_hash }, context).then(result => result.code), "recovered");
      const restored = await snapshot(target.root);
      for (const [name, value] of Object.entries(before)) {
        assert.equal(restored[name].bytes, value.bytes, name + " bytes should be restored");
      }
      assert.equal(await readFile(path.join(target.root, ".gitignore"), "utf8"), approvedIgnore);
      assert.equal(restored[".vivary/context.md"], undefined);
      assert.equal(restored[".vivary/workspace.toml"], undefined);
      assert.equal(restored[".vivary/runtime/adopt-journal.json"], undefined);
      const receipts = await readdir(path.join(target.root, ".vivary/runtime/adopt-receipts"));
      assert.deepEqual(receipts, [setupReview.operationId + ".json"]);
      assert.notDeepEqual(interrupted, restored);
      assert.equal((await preview(run, target.projectId)).report.request_replay.ready, true);
    });
    await suite.test("incomplete writes require a reviewed recovery and restore original bytes", async () => {
      const target = folders.Interrupted;
      const before = await snapshot(target.root);
      const review = await preview(run, target.projectId);
      crash = "applying";
      assert.equal((await run(approval(review), context)).code, "pending");
      run = service();
      const recovery = await run(approval(review, "preview-recovery"), context);
      assert.equal(recovery.code, "recovery-preview", JSON.stringify(recovery));
      const interrupted = await snapshot(target.root);
      await assert.rejects(run({ ...approval(review, "recover"), acceptedRecoveryHash: "sha256:" + "0".repeat(64) }, context), /recovery preview changed/);
      assert.deepEqual(await snapshot(target.root), interrupted);
      assert.equal((await run({ ...approval(review, "recover"), acceptedRecoveryHash: recovery.recovery.recovery_plan_hash }, context)).code, "recovered");
      const bytes = snapshot => Object.fromEntries(Object.entries(snapshot).map(([key,value]) => [key, typeof value === "string" ? value : value.bytes]));
      const restored = bytes(await snapshot(target.root));
      for (const [name, value] of Object.entries(bytes(before))) assert.equal(restored[name], value);
      assert.equal(restored["STATE.md"], undefined);
      assert.equal(restored[path.join(".vivary", "context.md")], undefined);
      assert.equal((await preview(run, target.projectId)).report.request_replay.ready, true);
    });
    await suite.test("lost recovery success survives restart and cannot re-enable original apply", async () => {
      const target = folders.RecoveryRetry;
      const review = await preview(run, target.projectId);
      crash = "applying";
      assert.equal((await run(approval(review), context)).code, "pending");
      const recovery = await run(approval(review, "preview-recovery"), context);
      assert.equal(recovery.code, "recovery-preview");
      loseResponse = true;
      const request = { ...approval(review, "recover"), acceptedRecoveryHash: recovery.recovery.recovery_plan_hash };
      await assert.rejects(run(request, context), /lost response/);
      const restored = await snapshot(target.root);
      await reopen();
      run = service();
      const refreshed = await run(approval(review, "preview-recovery"), context);
      assert.equal(refreshed.code, "recovery-preview");
      assert.equal(refreshed.approved, true);
      await assert.rejects(run(approval(review), context), /Recovery was approved/);
      assert.equal((await run(request, context)).code, "recovered");
      assert.deepEqual(await snapshot(target.root), restored);
    });
    await suite.test("possible completed publication refuses rollback and preserves all files", async () => {
      const target = folders.Uncertain;
      const review = await preview(run, target.projectId);
      crash = "publishing";
      assert.equal((await run(approval(review), context)).code, "pending");
      const after = await snapshot(target.root);
      const recovery = await run(approval(review, "preview-recovery"), context);
      assert.equal(recovery.code, "pending");
      assert.match(recovery.message, /committed or uncertain/);
      assert.deepEqual(await snapshot(target.root), after);
      assert.equal((await run(approval(review), context)).code, "pending");
      assert.deepEqual(await snapshot(target.root), after);
      const workspace = await resolveLocalProjectWorkspace(context, target.projectId);
      await getDb().update(bindings).set({ bindingRevision: workspace.bindingRevision + 1 })
        .where(eq(bindings.bindingId, workspace.bindingId));
      await assert.rejects(run({ operation: "resume", projectId: target.projectId }, context), /earlier folder connection/);
      await assert.rejects(preview(run, target.projectId), /earlier folder connection/);
      await getDb().update(bindings).set({ bindingRevision: workspace.bindingRevision })
        .where(eq(bindings.bindingId, workspace.bindingId));
      const resumed = await run({ operation: "resume", projectId: target.projectId }, context);
      assert.equal(resumed.code, "pending");
      assert.equal(resumed.operationId, review.operationId);
      assert.deepEqual(await snapshot(target.root), after);
    });
    await suite.test("concurrent requests do not start another writer", async () => {
      const target = folders.Recovery;
      const review = await preview(run, target.projectId);
      let release;
      let arrived;
      const entered = new Promise(resolve => { arrived = resolve; });
      beforeExecute = async () => { arrived(); await new Promise(resolve => { release = resolve; }); };
      const running = run(approval(review), context);
      await entered;
      await assert.rejects(run(approval(review), context), /already running/);
      release();
      assert.equal((await running).code, "applied");
      beforeExecute = async () => {};
    });
    await suite.test("a first-attempt refusal cannot clear a retry admitted by another service instance", async () => {
      const target = folders.ConcurrentRetry;
      const review = await preview(run, target.projectId);
      const first = service();
      const second = service();
      let enteredFirst, enteredSecond, releaseFirst, releaseSecond;
      const arrivedFirst = new Promise(resolve => { enteredFirst = resolve; });
      const arrivedSecond = new Promise(resolve => { enteredSecond = resolve; });
      const waitFirst = new Promise(resolve => { releaseFirst = resolve; });
      const waitSecond = new Promise(resolve => { releaseSecond = resolve; });
      let dispatches = 0;
      beforeExecute = async () => {
        if (++dispatches === 1) { enteredFirst(); await waitFirst; }
        else { enteredSecond(); await waitSecond; }
      };
      const refused = assert.rejects(first(approval(review), context), /setup request changed/);
      await arrivedFirst;
      const retry = second(approval(review), context);
      await arrivedSecond;
      const outside = path.join(directory, "concurrent-refusal-target");
      await mkdir(outside);
      await mkdir(path.join(target.root, ".vivary"));
      const runtime = path.join(target.root, ".vivary/runtime");
      await symlink(outside, runtime, "dir");
      try {
        releaseFirst();
        await refused;
        const pending = await run({ operation: "resume", projectId: target.projectId }, context);
        assert.equal(pending.code, "pending");
        assert.equal(pending.operationId, review.operationId);
      } finally {
        await unlink(runtime);
        releaseSecond();
        beforeExecute = async () => {};
      }
      assert.deepEqual(await retry, { code: "applied", projectId: target.projectId, replayed: false });
      assert.equal((await run({ operation: "resume", projectId: target.projectId }, context)).code, "applied");
      for (const file of review.report.content_plan.files) {
        assert.equal(await readFile(path.join(target.root, file.path), "utf8"), file.content);
      }
    });
    await suite.test("pattern change uses the registered project approval and preserves user files", async () => {
      const root = path.join(directory, "PatternWorkspace");
      const planned = await executeFile("python3", ["-B", creator, "init", root,
        "--reviewed", "--dry-run", "--json"]);
      const initHash = JSON.parse(planned.stdout).plan.plan_sha256;
      await executeFile("python3", ["-B", creator, "init", root, "--reviewed",
        "--yes", "--plan", initHash, "--json"]);
      const registered = await connectLocalProjectFolder(context, root);
      assert.equal(registered.code, "registered");
      const choices = [{ id: "capture", name: "Intake", path: "inbox/README.md" }];
      const before = await snapshot(root);
      await assert.rejects(run({ operation: "preview", projectId: registered.projectId,
        preset: "coding", patternChoices: choices }, context), /automatic type/);
      assert.deepEqual(await snapshot(root), before);
      const review = await run({ operation: "preview", projectId: registered.projectId,
        preset: "auto", patternChoices: choices }, context);
      assert.equal(review.code, "preview");
      assert.deepEqual(review.patternChoices, choices);
      assert.equal(review.report.pattern_choices[0].name, "Intake");
      assert.deepEqual(await snapshot(root), before);
      const changedChoices = [{ ...choices[0], name: "Inbox" }];
      const approved = await run({ operation: "preview", projectId: registered.projectId,
        preset: "auto", patternChoices: changedChoices }, context);
      assert.equal(approved.code, "preview");
      assert.notEqual(approved.operationId, review.operationId);
      assert.deepEqual(approved.patternChoices, changedChoices);
      assert.equal(approved.report.pattern_choices[0].name, "Inbox");
      await assert.rejects(run(approval(review), context), /does not match/);
      assert.deepEqual(await snapshot(root), before);
      assert.equal((await run(approval(approved), context)).code, "applied");
      assert.match(await readFile(path.join(root, "inbox/README.md"), "utf8"), /^# Inbox/);
      assert.equal((await run({ operation: "resume", projectId: registered.projectId }, context)).code, "applied");
    });
  } finally {
    await provider?.close();
    delete globalThis[Symbol.for("vivary.local-project-services.v1")];
    await closeDbExec();
    await rm(directory, { recursive: true, force: true });
  }
});
