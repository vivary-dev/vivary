import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = await mkdtemp(path.join(os.tmpdir(), "vivary-reconnect-"));
const dataDir = path.join(fixture, "data");
const parent = path.join(dataDir, "projects");
const alpha = path.join(parent, "Alpha");
const orgId = "reconnect-test-org";
const email = "owner@local.vivary.test";
const context = { userEmail: email, orgId, appId: "workbench", caller: "frontend" };
const actionContext = { ...context, appId: "vivary" };
const database = "file:" + path.join(fixture, "auth.sqlite");
Object.assign(process.env, { APP_NAME: "Vivary", DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database, VIVARY_DATABASE_URL: database,
  VIVARY_DATABASE_URL_UNPOOLED: database, VIVARY_DATA_DIR: dataDir,
  AGENT_NATIVE_CODE_AGENTS_HOME: path.join(fixture, "code-agents") });

const { withMigrationRuntime, runMigrations, closeDbExec, createDbExec } =
  await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers, setAppMemberRole } =
  await import("@agent-native/core/org");
const { getSetting, mutateSetting } = await import("@agent-native/core/settings");
const { createCodeAgentRunRecord, updateCodeAgentRunRecord } =
  await import("@agent-native/core/code-agents");

const { getDb } = await import("../server/db/index.mjs");
const { migrateRegistry } = await import("../server/db/migrations.mjs");
const { bindings, projects, revisions, receipts } = await import("../server/db/schema.mjs");
const { createLocalRootProvider, localRootInventoryKey } =
  await import("../server/local-root-provider.mjs");
const { createNativeRegistry } = await import("../server/native-registry.mjs");
const { createProjectCatalog } = await import("../server/project-catalog.mjs");
const { resolveLocalProjectHistory, resolveLocalProjectWorkspace } =
  await import("../server/project-services.mjs");
const { previewManagedProjectReconnection, confirmManagedProjectReconnection } =
  await import("../server/managed-project-reconnection.mjs");
const { projectReconnectionPending } = await import("../server/project-reconnection-admission.mjs");
const { evaluateRegistryOperation, deriveMutationKeys } =
  await import("../../../scripts/registry_contract_model.mjs");

test("an owner explicitly reconnects one recorded local folder", async suite => {
  await mkdir(alpha, { recursive: true });
  await writeFile(path.join(alpha, "note.md"), "old marker");
  await withMigrationRuntime(async () => {
    await runMigrations(ORG_MIGRATIONS, { table: "reconnect_test_org_migrations" })();
    await migrateRegistry();
  });
  await getDb().insert(organizations).values({ id: orgId, name: "Reconnect test",
    createdBy: email, createdAt: Date.now() });
  await getDb().insert(orgMembers).values({ id: "reconnect_test_member", orgId,
    email, role: "owner", joinedAt: Date.now() });

  let provider;
  let registry;
  let catalog;
  async function reopen() {
    await provider?.close();
    provider = await createLocalRootProvider({ ownerEmail: email });
    registry = createNativeRegistry({ provider, resolveGrant: provider.resolveGrant,
      evaluate: evaluateRegistryOperation, deriveMutationKeys });
    catalog = createProjectCatalog({ readScope: registry.readScope, provider,
      locationLabels: provider.locationLabels,
      canReconnect: () => true });
    globalThis[Symbol.for("vivary.local-project-services.v1")] = {
      provider, registry, catalog, controller: { snapshot: () => ({ status: "open" }) },
    };
  }
  async function replace() {
    const original = path.join(fixture, "previous-" + Date.now());
    await rename(alpha, original);
    await mkdir(alpha);
    await writeFile(path.join(alpha, "note.md"), "new marker " + Date.now());
    return original;
  }
  async function state(projectId) {
    const [binding] = (await getDb().select().from(bindings)).filter(row => row.projectId === projectId);
    const inventory = await getSetting(localRootInventoryKey(email, orgId), { bypassCache: true });
    const [revision] = await getDb().select().from(revisions);
    return { binding, inventory, revision, receiptCount: (await getDb().select().from(receipts)).length };
  }
  try {
    await reopen();
    await provider.resolveGrant(context);
    const connected = await provider.addGrantedFolder(context, alpha);
    const current = await catalog.run({}, context);
    const registered = await registry.registration.run({
      operationId: "reconnect-register-alpha",
      expectedPolicyRevision: current.policyRevision,
      expectedRegistryRevision: current.registryRevision,
      locationRef: connected.locationRef, displayName: "Alpha",
      contentIdentity: null, attachProjectId: null,
    }, context);
    assert.equal(registered.code, "registered");
    assert.equal(await provider.isManagedLocation(connected.locationRef, dataDir), true);
    assert.equal(await provider.isManagedLocation(connected.locationRef, path.join(fixture, "missing-data")), false);
    assert.equal(await provider.isManagedLocation("location_foreign", dataDir), false);
    const originalState = await state(registered.projectId);
    const originalProject = (await getDb().select().from(projects))[0];

    await suite.test("preview requires a changed identity and makes no record writes", async () => {
      await assert.rejects(previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId }), /has not changed/);
      assert.deepEqual(await state(registered.projectId), originalState);
      await replace();
      const unavailable = await catalog.run({}, context);
      assert.equal(unavailable.projects[0].status, "unavailable");
      assert.equal(unavailable.projects[0].reconnectEligible, true);
      assert.ok(!JSON.stringify(unavailable).includes(dataDir));
      assert.deepEqual(await resolveLocalProjectHistory(actionContext, registered.projectId), {
        label: "Alpha", projectId: registered.projectId,
        bindingId: originalState.binding.bindingId,
        rootId: originalState.binding.rootId,
        bindingRevision: originalState.binding.bindingRevision,
      });
      await assert.rejects(resolveLocalProjectWorkspace(actionContext, registered.projectId),
        /missing or changed/);
    });

    let firstPlan;
    let firstResult;
    await suite.test("confirm atomically advances grant and binding while preserving project identity", async () => {
      firstPlan = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      assert.equal(firstPlan.code, "reconnect-preview");
      assert.equal(firstPlan.folderName, "Alpha");
      assert.equal(firstPlan.identityChanged, true);
      assert.equal(firstPlan.recorded, false);
      assert.equal(Object.hasOwn(firstPlan, "path"), false);
      assert.equal(Object.hasOwn(firstPlan, "ino"), false);
      const pendingRun = createCodeAgentRunRecord({ id: "reconnect-active-approval",
        goalId: "vivary-local-code", title: "Old folder pending approval",
        status: "needs-approval", phase: "launch-approval", needsApproval: true,
        cwd: alpha, metadata: {
          app: "vivary-workbench-local-code", ownerEmail: email, orgId,
          projectId: registered.projectId, bindingId: originalState.binding.bindingId,
          rootId: originalState.binding.rootId,
          workspaceRoot: alpha, engine: "claude-cli", model: "sonnet",
          pendingLaunch: { requestId: "reconnect-pending-request", message: "Use the old folder.",
            engine: "claude-cli", model: "sonnet", ownerEmail: email, orgId,
            isFollowUp: false, timeoutMs: 120_000,
            continuesAfterBrowserClose: true, workspace: {
              root: alpha, label: "Alpha", projectId: registered.projectId,
              bindingId: originalState.binding.bindingId,
              rootId: originalState.binding.rootId,
              bindingRevision: originalState.binding.bindingRevision,
            } },
        } });
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: firstPlan.operationId,
        acceptedPlanSha256: firstPlan.planSha256,
      }), /Stop or deny the active coding request/);
      assert.deepEqual(await state(registered.projectId), originalState);
      updateCodeAgentRunRecord(pendingRun.id, { status: "paused", phase: "approval-denied",
        needsApproval: false, metadata: { pendingLaunch: undefined } });
      let releaseBarrier;
      let enteredBarrier;
      const barrier = new Promise(resolve => { releaseBarrier = resolve; });
      const entered = new Promise(resolve => { enteredBarrier = resolve; });
      const inFlight = confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: firstPlan.operationId,
        acceptedPlanSha256: firstPlan.planSha256,
      }, { createExec: async () => {
        enteredBarrier();
        await barrier;
        return createDbExec({ url: database });
      } });
      try {
        await entered;
        assert.equal(projectReconnectionPending(), true);
        await assert.rejects(confirmManagedProjectReconnection(actionContext, {
          projectId: registered.projectId, operationId: firstPlan.operationId,
          acceptedPlanSha256: firstPlan.planSha256,
        }), /Another project reconnection is in progress/);
        assert.deepEqual(await state(registered.projectId), originalState);
      } finally {
        releaseBarrier();
      }
      firstResult = await inFlight;
      assert.equal(projectReconnectionPending(), false);
      assert.equal(firstResult.code, "reconnected");
      assert.equal(firstResult.projectId, registered.projectId);
      assert.equal(firstResult.bindingId, originalState.binding.bindingId);
      assert.notEqual(firstResult.rootId, originalState.binding.rootId);
      const after = await state(registered.projectId);
      assert.equal(after.binding.rootId, firstResult.rootId);
      assert.equal(after.binding.bindingRevision, originalState.binding.bindingRevision + 1);
      assert.equal(after.inventory.policyRevision, originalState.inventory.policyRevision + 1);
      assert.equal(after.revision.revision, originalState.revision.revision + 1);
      assert.equal(after.receiptCount, originalState.receiptCount + 1);
      assert.deepEqual((await getDb().select().from(projects))[0], originalProject);
      assert.equal((await resolveLocalProjectWorkspace(actionContext, registered.projectId)).root, alpha);
      assert.equal((await catalog.run({}, context)).projects[0].status, "available");
    });

    await suite.test("exact replay persists across restart without advancing revisions", async () => {
      const after = await state(registered.projectId);
      await reopen();
      const replay = await confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: firstPlan.operationId,
        acceptedPlanSha256: firstPlan.planSha256,
      });
      assert.equal(replay.code, "already-reconnected");
      assert.equal(replay.rootId, firstResult.rootId);
      assert.deepEqual(await state(registered.projectId), after);
      assert.equal((await resolveLocalProjectWorkspace(actionContext, registered.projectId)).root, alpha);
    });

    await suite.test("resume preview refuses ambiguous or malformed scoped receipts", async () => {
      const before = await state(registered.projectId);
      const saved = (await getDb().select().from(receipts))
        .find(row => row.operationId === firstPlan.operationId);
      assert.ok(saved);
      const direct = await createDbExec({ url: database });
      const ambiguousKey = saved.receiptKey + "-ambiguous";
      const invalidKey = saved.receiptKey + "-invalid";
      try {
        await getDb().insert(receipts).values({ ...saved,
          receiptKey: ambiguousKey, operationId: "reconnect-ambiguous-fixture" });
        await assert.rejects(previewManagedProjectReconnection(actionContext,
          { projectId: registered.projectId }), /Multiple current reconnection receipts/);
        await direct.execute({ sql: "DELETE FROM vivary_registry_receipts WHERE receipt_key = ?",
          args: [ambiguousKey] });
        await getDb().insert(receipts).values({ ...saved,
          receiptKey: invalidKey, operationId: "reconnect-invalid-fixture", record: "{" });
        await assert.rejects(previewManagedProjectReconnection(actionContext,
          { projectId: registered.projectId }), /saved reconnection receipt is invalid/);
      } finally {
        await direct.execute({ sql: "DELETE FROM vivary_registry_receipts WHERE receipt_key IN (?, ?)",
          args: [ambiguousKey, invalidKey] });
        await direct.close();
      }
      assert.deepEqual(await state(registered.projectId), before);
    });

    await suite.test("stale plan and revoked app role roll back all four rows", async () => {
      await replace();
      const stale = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      assert.equal(stale.recorded, false);
      assert.notEqual(stale.operationId, firstPlan.operationId);
      const before = await state(registered.projectId);
      await mutateSetting(localRootInventoryKey(email, orgId), value => ({
        ...value, policyRevision: value.policyRevision + 1,
      }));
      const changed = await state(registered.projectId);
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: stale.operationId,
        acceptedPlanSha256: stale.planSha256,
      }), /Review the reconnection again|changed/);
      assert.deepEqual(await state(registered.projectId), changed);
      assert.equal(changed.binding.rootId, before.binding.rootId);
      const reviewed = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      await setAppMemberRole({ appId: "workbench", orgId, email, role: null, updatedBy: email });
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: reviewed.operationId,
        acceptedPlanSha256: reviewed.planSha256,
      }), { statusCode: 403 });
      assert.deepEqual(await state(registered.projectId), changed);
      await setAppMemberRole({ appId: "workbench", orgId, email,
        role: "project-registrar", updatedBy: email });
    });

    await suite.test("a receipt insert failure rolls back the settings and registry transaction", async () => {
      const reviewed = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      const before = await state(registered.projectId);
      const createExec = async () => {
        const real = await createDbExec({ url: database });
        return { ...real, execute: real.execute.bind(real), close: real.close.bind(real),
          transaction: fn => real.transaction(tx => fn({
            execute: statement => {
              if (typeof statement === "object"
                && statement.sql.includes("INSERT INTO vivary_registry_receipts")) {
                throw new Error("fixture receipt write failure");
              }
              return tx.execute(statement);
            },
          })) };
      };
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: reviewed.operationId,
        acceptedPlanSha256: reviewed.planSha256,
      }, { createExec }), /fixture receipt write failure/);
      assert.deepEqual(await state(registered.projectId), before);
      const accepted = await confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: reviewed.operationId,
        acceptedPlanSha256: reviewed.planSha256,
      });
      assert.equal(accepted.code, "reconnected");
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: firstPlan.operationId,
        acceptedPlanSha256: firstPlan.planSha256,
      }), /superseded/);
      assert.equal((await state(registered.projectId)).binding.rootId, accepted.rootId);
    });

    await suite.test("a post-commit path replacement returns uncertain and exact retry reconciles", async () => {
      await replace();
      const reviewed = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      const before = await state(registered.projectId);
      const displaced = path.join(fixture, "post-commit-reviewed");
      let moved = false;
      const createExec = async () => {
        const real = await createDbExec({ url: database });
        return { execute: real.execute.bind(real), close: real.close.bind(real),
          transaction: async fn => {
            const result = await real.transaction(fn);
            if (!moved && result?.code === "reconnected") {
              moved = true;
              await rename(alpha, displaced);
              await mkdir(alpha);
              await writeFile(path.join(alpha, "note.md"), "unreviewed replacement");
            }
            return result;
          } };
      };
      const request = { projectId: registered.projectId, operationId: reviewed.operationId,
        acceptedPlanSha256: reviewed.planSha256 };
      await assert.rejects(confirmManagedProjectReconnection(actionContext, request,
        { createExec }), /reconnection was recorded.*retry this same confirmation/);
      const committed = await state(registered.projectId);
      assert.equal(moved, true);
      assert.notEqual(committed.binding.rootId, before.binding.rootId);
      assert.equal(committed.binding.bindingRevision, before.binding.bindingRevision + 1);
      assert.equal(committed.inventory.policyRevision, before.inventory.policyRevision + 1);
      assert.equal(committed.revision.revision, before.revision.revision + 1);
      assert.equal(committed.receiptCount, before.receiptCount + 1);
      assert.equal((await catalog.run({}, context)).projects[0].status, "unavailable");
      await assert.rejects(confirmManagedProjectReconnection(actionContext, request),
        /completed project folder changed again/);
      assert.deepEqual(await state(registered.projectId), committed);
      const changedPlan = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      assert.equal(changedPlan.recorded, false);
      assert.equal(changedPlan.identityChanged, true);
      assert.notEqual(changedPlan.operationId, request.operationId);
      assert.notEqual(changedPlan.planSha256, request.acceptedPlanSha256);
      await rm(alpha, { recursive: true });
      await rename(displaced, alpha);
      await reopen();
      const recovered = await previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId });
      assert.equal(recovered.recorded, true);
      assert.equal(recovered.identityChanged, false);
      assert.equal(recovered.operationId, request.operationId);
      assert.equal(recovered.planSha256, request.acceptedPlanSha256);
      assert.deepEqual(await state(registered.projectId), committed);
      const replay = await confirmManagedProjectReconnection(actionContext, {
        projectId: registered.projectId, operationId: recovered.operationId,
        acceptedPlanSha256: recovered.planSha256,
      });
      assert.equal(replay.code, "already-reconnected");
      assert.equal(replay.rootId, committed.binding.rootId);
      assert.deepEqual(await state(registered.projectId), committed);
      assert.equal((await catalog.run({}, context)).projects[0].status, "available");
    });

    await suite.test("a filesystem root has a nonempty reviewed folder name", async () => {
      const rootOrgId = "reconnect-root-test-org";
      const rootContext = { ...context, orgId: rootOrgId };
      const rootActionContext = { ...actionContext, orgId: rootOrgId };
      const filesystemRoot = path.parse(fixture).root;
      await getDb().insert(organizations).values({ id: rootOrgId, name: "Root path test",
        createdBy: email, createdAt: Date.now() });
      await getDb().insert(orgMembers).values({ id: "reconnect_root_test_member", orgId: rootOrgId,
        email, role: "owner", joinedAt: Date.now() });
      await provider.resolveGrant(rootContext);
      const rootGrant = await provider.addGrantedFolder(rootContext, filesystemRoot);
      const rootCatalog = await catalog.run({}, rootContext);
      const rootProject = await registry.registration.run({
        operationId: "reconnect-register-root",
        expectedPolicyRevision: rootCatalog.policyRevision,
        expectedRegistryRevision: rootCatalog.registryRevision,
        locationRef: rootGrant.locationRef, displayName: "Filesystem root",
        contentIdentity: null, attachProjectId: null,
      }, rootContext);
      assert.equal(rootProject.code, "registered");
      await mutateSetting(localRootInventoryKey(email, rootOrgId), current => ({
        ...current, grants: current.grants.map(grant => grant.locationRef === rootGrant.locationRef
          ? { ...grant, ino: grant.ino === "1" ? "2" : "1" } : grant),
      }));
      const preview = await previewManagedProjectReconnection(rootActionContext,
        { projectId: rootProject.projectId });
      assert.equal(preview.folderName, filesystemRoot);
      assert.equal(preview.folderPath, filesystemRoot);
      assert.equal(preview.folderKind, "external");
      assert.equal(preview.identityChanged, true);
    });

    await suite.test("picked folder beside managed projects keeps external reconnection semantics", async () => {
      const picked = path.join(parent, "My Project");
      await mkdir(picked);
      await writeFile(path.join(picked, "note.md"), "picked folder marker");
      const pickedGrant = await provider.addGrantedFolder(context, picked);
      assert.equal(await provider.isManagedLocation(pickedGrant.locationRef, dataDir), false);
      const current = await catalog.run({}, context);
      const pickedProject = await registry.registration.run({
        operationId: "reconnect-register-picked-sibling",
        expectedPolicyRevision: current.policyRevision,
        expectedRegistryRevision: current.registryRevision,
        locationRef: pickedGrant.locationRef, displayName: "My Project",
        contentIdentity: null, attachProjectId: null,
      }, context);
      assert.equal(pickedProject.code, "registered");
      await rename(picked, path.join(fixture, "old-picked-sibling"));
      await mkdir(picked);
      await writeFile(path.join(picked, "note.md"), "restored picked marker");
      const unavailable = (await catalog.run({}, context)).projects.find(
        row => row.projectId === pickedProject.projectId);
      assert.equal(unavailable.status, "unavailable");
      assert.equal(unavailable.reconnectEligible, true);
      const before = await state(pickedProject.projectId);
      const reviewed = await previewManagedProjectReconnection(actionContext,
        { projectId: pickedProject.projectId });
      assert.equal(reviewed.folderName, "My Project");
      assert.equal(reviewed.folderPath, picked);
      assert.equal(reviewed.folderKind, "external");
      assert.deepEqual(await state(pickedProject.projectId), before);
      const result = await confirmManagedProjectReconnection(actionContext, {
        projectId: pickedProject.projectId, operationId: reviewed.operationId,
        acceptedPlanSha256: reviewed.planSha256,
      });
      assert.equal(result.code, "reconnected");
      assert.equal(result.projectId, pickedProject.projectId);
      assert.equal((await catalog.run({}, context)).projects.find(
        row => row.projectId === pickedProject.projectId).status, "available");
      assert.equal((await resolveLocalProjectWorkspace(actionContext, pickedProject.projectId)).root,
        picked);
    });

    await suite.test("external folder recovery checks the saved path and changed parent", async () => {
      await rename(alpha, path.join(fixture, "moved-current"));
      await symlink(path.join(fixture, "moved-current"), alpha, "dir");
      await assert.rejects(previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId }), /linked|managed Projects/);
      const externalParent = path.join(fixture, "external-parent");
      const foreign = path.join(externalParent, "Foreign");
      await mkdir(foreign, { recursive: true });
      const foreignGrant = await provider.addGrantedFolder(context, foreign);
      const latest = await catalog.run({}, context);
      const foreignProject = await registry.registration.run({
        operationId: "reconnect-register-foreign",
        expectedPolicyRevision: latest.policyRevision,
        expectedRegistryRevision: latest.registryRevision,
        locationRef: foreignGrant.locationRef, displayName: "Foreign",
        contentIdentity: null, attachProjectId: null,
      }, context);
      await rename(foreign, path.join(externalParent, "old-foreign"));
      await mkdir(foreign);
      assert.equal(await provider.isManagedLocation(foreignGrant.locationRef, dataDir), false);
      const catalogAfterReplacement = await catalog.run({}, context);
      const external = catalogAfterReplacement.projects.find(row => row.projectId === foreignProject.projectId);
      assert.equal(external.status, "unavailable");
      assert.equal(external.reconnectEligible, true);
      assert.ok(!JSON.stringify(catalogAfterReplacement).includes(foreign));
      const externalBefore = await state(foreignProject.projectId);
      const externalPlan = await previewManagedProjectReconnection(actionContext,
        { projectId: foreignProject.projectId });
      assert.equal(externalPlan.folderKind, "external");
      assert.equal(externalPlan.folderPath, foreign);
      assert.equal(externalPlan.recorded, false);
      assert.deepEqual(await state(foreignProject.projectId), externalBefore);
      const externalResult = await confirmManagedProjectReconnection(actionContext, {
        projectId: foreignProject.projectId, operationId: externalPlan.operationId,
        acceptedPlanSha256: externalPlan.planSha256,
      });
      assert.equal(externalResult.code, "reconnected");
      assert.equal((await catalog.run({}, context)).projects.find(
        row => row.projectId === foreignProject.projectId).status, "available");
      assert.equal((await resolveLocalProjectWorkspace(actionContext, foreignProject.projectId)).projectId,
        foreignProject.projectId);
      assert.equal((await confirmManagedProjectReconnection(actionContext, {
        projectId: foreignProject.projectId, operationId: externalPlan.operationId,
        acceptedPlanSha256: externalPlan.planSha256,
      })).code, "already-reconnected");
      await rename(foreign, path.join(externalParent, "second-old-foreign"));
      await mkdir(foreign);
      const staleParentPlan = await previewManagedProjectReconnection(actionContext,
        { projectId: foreignProject.projectId });
      const movedParent = path.join(fixture, "old-external-parent");
      await rename(externalParent, movedParent);
      await mkdir(foreign, { recursive: true });
      await assert.rejects(confirmManagedProjectReconnection(actionContext, {
        projectId: foreignProject.projectId, operationId: staleParentPlan.operationId,
        acceptedPlanSha256: staleParentPlan.planSha256,
      }), /parent changed|Review the reconnection again/);
      await rm(foreign, { recursive: true });
      await assert.rejects(previewManagedProjectReconnection(actionContext,
        { projectId: foreignProject.projectId }), /missing/);
      await symlink(path.join(movedParent, "Foreign"), foreign, "dir");
      await assert.rejects(previewManagedProjectReconnection(actionContext,
        { projectId: foreignProject.projectId }), /linked|changed/);
      const originalBinding = (await state(registered.projectId)).binding;
      await getDb().insert(bindings).values({ ...originalBinding,
        bindingId: "reconnect-test-extra-binding", rootId: "reconnect-test-extra-root",
        locationRef: foreignGrant.locationRef });
      const multiple = (await catalog.run({}, context)).projects.find(row => row.projectId === registered.projectId);
      assert.equal(multiple.reconnectEligible, false);
      await assert.rejects(previewManagedProjectReconnection(actionContext,
        { projectId: registered.projectId }), /single recorded local folder/);
      const savedParent = path.join(fixture, "saved-projects-parent");
      await rename(parent, savedParent);
      await symlink(savedParent, parent, "dir");
      assert.equal(await provider.isManagedLocation(connected.locationRef, dataDir), false);
    });
  } finally {
    delete globalThis[Symbol.for("vivary.local-project-services.v1")];
    await provider?.close();
    await closeDbExec();
    await rm(fixture, { recursive: true, force: true });
  }
});
