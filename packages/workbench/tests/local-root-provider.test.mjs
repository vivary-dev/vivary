import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const directory = await mkdtemp(path.join(tmpdir(), "vivary-local-roots-"));
const database = "file:" + path.join(directory, "native.sqlite");
Object.assign(process.env, { APP_NAME: "Vivary", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARY_DATABASE_URL: database, VIVARY_DATABASE_URL_UNPOOLED: database });
const { withMigrationRuntime, runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers, setAppMemberRole, listAppMemberRoles } = await import("@agent-native/core/org");
const { deleteSettingIfValue, getSetting, mutateSetting } = await import("@agent-native/core/settings");
const { getDb } = await import("../server/db/index.mjs");
const { migrateRegistry } = await import("../server/db/migrations.mjs");
const { bindings, projects } = await import("../server/db/schema.mjs");
const { createLocalRootProvider, LOCAL_ROOT_VERIFICATION } = await import("../server/local-root-provider.mjs");
const { createNativeRegistry } = await import("../server/native-registry.mjs");
const { createProjectCatalog } = await import("../server/project-catalog.mjs");
const {
  matchChatProject,
  getLocalProjectAccess,
  connectLocalProjectFolder,
  resolveLocalProjectHistory,
  resolveLocalProjectWorkspace,
} = await import("../server/project-services.mjs");
const { evaluateRegistryOperation, deriveMutationKeys } = await import("../../../scripts/registry_contract_model.mjs");
const { projectChatScopeId } = await import("../server/chat-project-scope.mjs");
const { runWithRequestContext } = await import("@agent-native/core/server");
const { resolveNativeChatProject } = await import("../server/native-chat-project.ts");
const { createProjectReadRunner } = await import("../server/original-runtime.ts");

test("local project grants register real folders and reopen without content snapshots", async suite => {
  const email = "owner@local.vivary.test";
  const orgId = "local-provider-test-org";
  const context = { userEmail: email, orgId, appId: "workbench", caller: "frontend" };
  const privateKey = "vivary-private:local-folders-v1:actor_" + createHash("sha256")
    .update(orgId + "\0" + email).digest("hex");
  const oldKey = "u:" + email + ":vivary-local-folders-v1:" + orgId;
  const alpha = path.join(directory, "Alpha");
  const beta = path.join(directory, "Beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const large = await open(path.join(alpha, "large.bin"), "w");
  await large.truncate(65 * 1024 * 1024);
  await large.close();
  await symlink(beta, path.join(alpha, "linked-dependency"), "junction");
  await withMigrationRuntime(async () => {
    await runMigrations(ORG_MIGRATIONS, { table: "local_root_test_org_migrations" })();
    await migrateRegistry();
  });
  await getDb().insert(organizations).values({ id: orgId, name: "Local test", createdBy: email, createdAt: Date.now() });
  await getDb().insert(orgMembers).values({ id: "local-provider-test-member", orgId, email, role: "owner", joinedAt: Date.now() });

  let provider;
  let registry;
  let catalog;
  async function reopen() {
    await provider?.close();
    provider = await createLocalRootProvider({ ownerEmail: email, defaultFolder: alpha });
    registry = createNativeRegistry({ provider, resolveGrant: provider.resolveGrant,
      evaluate: evaluateRegistryOperation, deriveMutationKeys });
    catalog = createProjectCatalog({ readScope: registry.readScope, provider, locationLabels: provider.locationLabels });
    globalThis[Symbol.for("vivary.local-project-services.v1")] = {
      provider, registry, catalog, controller: { snapshot: () => ({ status: "open" }) },
    };
  }
  async function register(locationRef, displayName, operationId) {
    const current = await catalog.run({}, context);
    assert.equal(current.code, "catalog");
    return registry.registration.run({ operationId, expectedPolicyRevision: current.policyRevision,
      expectedRegistryRevision: current.registryRevision, locationRef, displayName,
      contentIdentity: null, attachProjectId: null }, context);
  }
  let alphaRef;
  let alphaResult;
  let betaResult;
  try {
    await reopen();
    await suite.test("folders without creation times reopen and reject replacement or redirection", async check => {
      const missingOrgId = "local-no-birthtime-org";
      const missingContext = { ...context, orgId: missingOrgId };
      await getDb().insert(organizations).values({ id: missingOrgId, name: "No creation time", createdBy: email, createdAt: Date.now() });
      await getDb().insert(orgMembers).values({ id: "local-no-birthtime-member", orgId: missingOrgId, email, role: "owner", joinedAt: Date.now() });
      const folder = path.join(directory, "NoBirthtime");
      const originalFolder = path.join(directory, "OriginalNoBirthtime");
      await mkdir(folder);
      const originalStat = filesystem.stat;
      const originalOpen = filesystem.open;
      check.mock.method(filesystem, "stat", async (...args) => {
        const info = await originalStat(...args);
        if (typeof info.birthtimeNs === "bigint") info.birthtimeNs = 0n;
        return info;
      });
      check.mock.method(filesystem, "open", async (...args) => {
        const handle = await originalOpen(...args);
        const statHandle = handle.stat.bind(handle);
        check.mock.method(handle, "stat", async (...statArgs) => {
          const info = await statHandle(...statArgs);
          if (typeof info.birthtimeNs === "bigint") info.birthtimeNs = 0n;
          return info;
        });
        return handle;
      });
      syncBuiltinESMExports();
      let missingProvider;
      try {
        missingProvider = await createLocalRootProvider({ ownerEmail: email, defaultFolder: folder });
        const grant = await missingProvider.resolveGrant(missingContext);
        assert.equal(grant.locationRefs.length, 1);
        const ref = grant.locationRefs[0];
        assert.equal((await missingProvider.inspect(ref)).code, "available");
        await writeFile(path.join(folder, "note.md"), "A normal edit must preserve folder access.");
        assert.equal((await missingProvider.inspect(ref)).code, "available");
        await missingProvider.close();
        missingProvider = await createLocalRootProvider({ ownerEmail: email, defaultFolder: folder });
        assert.deepEqual(await missingProvider.resolveGrant(missingContext), grant);
        assert.equal((await missingProvider.inspect(ref)).code, "available");
        await rename(folder, originalFolder);
        await mkdir(folder);
        assert.equal((await missingProvider.inspect(ref)).code, "identity-unverified");
        await assert.rejects(missingProvider.addGrantedFolder(missingContext, folder), /different folder/);
        await rm(folder, { recursive: true });
        await symlink(originalFolder, folder, "junction");
        assert.equal((await missingProvider.inspect(ref)).code, "identity-unverified");
        assert.deepEqual(await missingProvider.resolveGrant(missingContext), grant);
      } finally {
        await missingProvider?.close();
        check.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
    await suite.test("first authenticated owner gets a scoped folder grant and registrar role", async () => {
      const current = await catalog.run({}, context);
      assert.equal(current.code, "catalog");
      assert.equal(current.projects.length, 0);
      assert.equal(current.locations.length, 1);
      alphaRef = current.locations[0].locationRef;
      const observation = await provider.observe(alphaRef);
      assert.equal(observation.verificationKind, LOCAL_ROOT_VERIFICATION);
      assert.equal(observation.contentRevision, null);
      assert.equal(observation.vcs.kind, "unobserved");
      assert.equal(observation.code, "observed");
      alphaResult = await register(alphaRef, "Alpha", "local-alpha");
      assert.equal(alphaResult.code, "registered");
      const [binding] = await getDb().select().from(bindings);
      assert.equal(binding.verificationKind, LOCAL_ROOT_VERIFICATION);
      assert.equal(binding.vcsKind, "unobserved");
      const inventory = await getSetting(privateKey, { bypassCache: true });
      assert.equal(inventory.grants[0].locationRef, alphaRef);
      assert.equal(privateKey.startsWith("u:"), false);
      assert.equal(await getSetting(oldKey, { bypassCache: true }), null);
    });
    await suite.test("content size and dependency links do not block folder identity", async () => {
      await writeFile(path.join(alpha, "new-file.md"), "A normal project edit.\n");
      assert.equal((await provider.inspect(alphaRef)).code, "available");
      const duplicate = await provider.addGrantedFolder(context, alpha);
      assert.equal(duplicate.locationRef, alphaRef);
      assert.equal((await catalog.run({}, context)).projects[0].status, "available");
    });
    await suite.test("a second explicit folder joins the running provider and existing project remains usable", async () => {
      const actionContext = { ...context, appId: "vivary" };
      const before = await catalog.run({}, context);
      betaResult = await connectLocalProjectFolder(actionContext, beta, "Beta");
      assert.equal(Object.hasOwn(betaResult, "path"), false);
      assert.equal(Object.hasOwn(betaResult, "root"), false);
      assert.equal((await getLocalProjectAccess(actionContext)).code, "catalog");
      const resolved = await resolveLocalProjectWorkspace(actionContext, alphaResult.projectId);
      assert.equal(resolved.root, alpha);
      assert.equal(resolved.projectId, alphaResult.projectId);
      await assert.rejects(resolveLocalProjectWorkspace({ ...actionContext, orgId: "foreign" }, alphaResult.projectId));
      await assert.rejects(resolveLocalProjectWorkspace({ ...actionContext, caller: "agent" }, alphaResult.projectId));
      const tool = { ...actionContext, appId: "workbench", caller: "tool" };
      await assert.rejects(getLocalProjectAccess(tool), { statusCode: 403 });
      await assert.rejects(resolveLocalProjectWorkspace(tool, alphaResult.projectId), { statusCode: 403 });
      await assert.rejects(resolveLocalProjectWorkspace({ ...tool, chatProjectId: alphaResult.projectId }, alphaResult.projectId),
        { statusCode: 403 });
      const alphaScope = projectChatScopeId(actionContext.userEmail, actionContext.orgId, alphaResult.projectId);
      const inChat = (chatScope, run) => runWithRequestContext({ userEmail: actionContext.userEmail,
        orgId: actionContext.orgId, run: { chatScope } }, run);
      const alphaChat = { type: "workspace-app", id: alphaScope };
      const personalId = (org) => projectChatScopeId(actionContext.userEmail, org, null);
      assert.deepEqual(await matchChatProject(tool), { kind: "not-project" }, "a request outside a chat reaches no project");
      assert.deepEqual(await inChat({ type: "workspace-app", id: `vivary-workbench-chat-v1:${actionContext.orgId}` },
        () => matchChatProject(tool)), { kind: "not-project" }, "a legacy chat keeps Native's own behavior");
      await assert.rejects(inChat({ type: "thread", id: alphaScope }, () => matchChatProject(tool)), { statusCode: 403 });
      assert.deepEqual(await inChat({ type: "workspace-app", id: personalId(actionContext.orgId) },
        () => matchChatProject(tool)), { kind: "personal" });
      await assert.rejects(inChat({ type: "workspace-app", id: personalId("another-org") }, () => matchChatProject(tool)),
        { statusCode: 403 }, "another organization's Personal scope is not this one's");
      await assert.rejects(inChat({ type: "workspace-app", id: "vivary-project-chat-v2:" + "0".repeat(64) },
        () => matchChatProject(tool)), { statusCode: 403 });
      await assert.rejects(inChat(alphaChat, () => matchChatProject({ ...tool, orgId: undefined })), { statusCode: 403 },
        "a project scope without an organization is refused");
      const owned = await inChat(alphaChat, () => matchChatProject(actionContext));
      assert.equal(owned.kind, "project");
      assert.equal(owned.context, actionContext, "the owner's request keeps its own context");
      const admitted = await inChat(alphaChat, () => matchChatProject(tool));
      assert.equal(admitted.projectId, alphaResult.projectId);
      assert.equal(admitted.context.caller, "tool");
      assert.equal((await resolveLocalProjectWorkspace(admitted.context, alphaResult.projectId)).root, alpha);
      await assert.rejects(resolveLocalProjectWorkspace(admitted.context, betaResult.projectId), { statusCode: 403 });
      await assert.rejects(resolveLocalProjectWorkspace({ ...admitted.context }, alphaResult.projectId), { statusCode: 403 });
      await assert.rejects(getLocalProjectAccess(admitted.context), { statusCode: 403 });
      await assert.rejects(connectLocalProjectFolder(admitted.context, beta, "Beta"), { statusCode: 403 });

      // The real chain: the chat resolver, project services, and the project read runner.
      const runtime = path.join(directory, "runtime");
      const interpreter = process.platform === "win32" ? "python/python.exe" : "python/bin/python3";
      await mkdir(path.join(runtime, path.dirname(interpreter)), { recursive: true });
      await writeFile(path.join(runtime, interpreter), "fixture interpreter, not executable");
      await writeFile(path.join(runtime, "manifest.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform,
        arch: process.arch, pythonVersion: "3.12.14", pythonExecutable: interpreter }));
      const appData = path.join(directory, "app-data");
      await mkdir(appData);
      const read = createProjectReadRunner({ resolveWorkspace: resolveLocalProjectWorkspace, parallelism: 4,
        environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: appData }),
        execute: async () => ({ exitCode: 0, stdout: "{}", stderr: "", signal: null }) });
      const chat = await inChat(alphaChat, () => resolveNativeChatProject(tool));
      assert.equal(chat.projectId, alphaResult.projectId);
      assert.equal((await read(chat.projectId, { verb: "doctor" }, chat.projectContext)).exitCode, 0);
      await assert.rejects(read(chat.projectId, { verb: "doctor" }, { ...chat.projectContext }), { statusCode: 403 },
        "a copy of the admitted context is not admitted");
      await assert.rejects(resolveLocalProjectWorkspace(actionContext, "../alpha"),
        { message: "Choose a registered project.", statusCode: 400 });
      assert.equal(betaResult.code, "registered");
      const current = await catalog.run({}, context);
      assert.equal(current.projects.length, 2);
      assert.equal(current.scopeKey, before.scopeKey);
      assert.ok(current.policyRevision > before.policyRevision);
      assert.ok(current.projects.every(project => project.status === "available"));
      await assert.rejects(provider.addGrantedFolder(context, directory), /outside/);
    });
    await suite.test("reopening preserves project and root identifiers with fresh metadata checks", async () => {
      const before = await catalog.run({}, context);
      await reopen();
      const after = await catalog.run({}, context);
      assert.deepEqual(after, before);
      const [binding] = (await getDb().select().from(bindings)).filter(value => value.projectId === alphaResult.projectId);
      const resolved = await provider.resolvePath(context, binding.rootId, binding.locationRef);
      assert.equal(resolved.path, alpha);
      assert.equal(resolved.verificationKind, LOCAL_ROOT_VERIFICATION);
    });
    await suite.test("the exact legacy inventory migrates privately without restoring a revoked role", async () => {
      const before = await catalog.run({}, context);
      const saved = await getSetting(privateKey, { bypassCache: true });
      await mutateSetting(oldKey, () => saved);
      assert.equal(await deleteSettingIfValue(privateKey, saved), true);
      await setAppMemberRole({ appId: "workbench", orgId, email, role: null, updatedBy: email });
      await reopen();
      await provider.resolveGrant(context);
      assert.deepEqual(await getSetting(privateKey, { bypassCache: true }), saved);
      assert.equal(await getSetting(oldKey, { bypassCache: true }), null);
      assert.equal((await listAppMemberRoles("workbench", orgId)).length, 0);
      assert.equal(await registry.readScope(context), null);
      await setAppMemberRole({ appId: "workbench", orgId, email, role: "project-registrar", updatedBy: email });
      assert.deepEqual(await catalog.run({}, context), before);
    });
    await suite.test("conflicting or malformed legacy inventory is preserved without overwriting private state", async () => {
      const saved = await getSetting(privateKey, { bypassCache: true });
      const newer = { ...saved, policyRevision: saved.policyRevision + 1 };
      await mutateSetting(oldKey, () => newer);
      await reopen();
      await provider.resolveGrant(context);
      assert.deepEqual(await getSetting(privateKey, { bypassCache: true }), saved);
      assert.deepEqual(await getSetting(oldKey, { bypassCache: true }), newer);
      assert.equal(await deleteSettingIfValue(oldKey, saved), false);
      assert.equal(await deleteSettingIfValue(oldKey, newer), true);
      const malformed = { ...saved, unexpected: true };
      await mutateSetting(oldKey, () => malformed);
      assert.equal(await deleteSettingIfValue(privateKey, saved), true);
      await reopen();
      await assert.rejects(provider.resolveGrant(context), /inventory is invalid/);
      assert.equal(await getSetting(privateKey, { bypassCache: true }), null);
      assert.deepEqual(await getSetting(oldKey, { bypassCache: true }), malformed);
      assert.equal(await deleteSettingIfValue(oldKey, malformed), true);
      await mutateSetting(privateKey, () => saved);
      await reopen();
    });
    await suite.test("replacement and missing roots remain unavailable without deleting records", async () => {
      await rename(alpha, path.join(directory, "OriginalAlpha"));
      await mkdir(alpha);
      await rename(beta, path.join(directory, "OriginalBeta"));
      const current = await catalog.run({}, context);
      assert.ok(current.projects.every(project => project.status === "unavailable"));
      const projectRows = await getDb().select().from(projects);
      assert.equal(projectRows.length, 2);
      const [alphaBinding] = (await getDb().select().from(bindings))
        .filter(value => value.projectId === alphaResult.projectId);
      assert.deepEqual(await resolveLocalProjectHistory(context, alphaResult.projectId), {
        label: "Alpha",
        projectId: alphaResult.projectId,
        bindingId: alphaBinding.bindingId,
        rootId: alphaBinding.rootId,
        bindingRevision: alphaBinding.bindingRevision,
      });
      await assert.rejects(resolveLocalProjectWorkspace(context, alphaResult.projectId),
        { message: /missing or changed/, statusCode: 409 });
      await assert.rejects(provider.addGrantedFolder(context, alpha), /different folder/);
    });
    await suite.test("role removal survives restart and cannot be repaired by ordinary reads", async () => {
      await setAppMemberRole({ appId: "workbench", orgId, email, role: null, updatedBy: email });
      await reopen();
      assert.equal(await registry.readScope(context), null);
      assert.equal(await registry.readScope({ ...context, userEmail: "another@local.test" }), null);
      await assert.rejects(resolveLocalProjectHistory(context, alphaResult.projectId), { statusCode: 403 });
      await assert.rejects(
        resolveLocalProjectHistory({ ...context, userEmail: "another@local.test" }, alphaResult.projectId),
        { statusCode: 403 },
      );
      await setAppMemberRole({ appId: "workbench", orgId, email, role: "project-mutator", updatedBy: email });
      const mutation = { operationId: "local-mutation", expectedPolicyRevision: 1, expectedRegistryRevision: 2,
        bindingId: alphaResult.bindingId, expectedBindingRevision: 1, expectedContentRevision: "fiction",
        requestedVcsOwner: null };
      await assert.rejects(registry.mutationAdmission.run(mutation, context));
      await assert.rejects(registry.mutationQuarantine.run({ operationId: "local-quarantine",
        bindingId: alphaResult.bindingId, fence: 1, expectedPolicyRevision: 1, expectedRegistryRevision: 2 }, context));
    });
  } finally {
    delete globalThis[Symbol.for("vivary.local-project-services.v1")];
    await provider?.close();
    await closeDbExec();
    await rm(directory, { recursive: true, force: true });
  }
});
