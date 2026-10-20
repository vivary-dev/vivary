import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withMigrationRuntime, runMigrations, closeDbExec } from "@agent-native/core/db";
import { ORG_MIGRATIONS, organizations, orgMembers, setAppMemberRole } from "@agent-native/core/org";
import { addSession, removeSession, awaitBootstrap } from "@agent-native/core/server";
import { and, eq } from "@agent-native/core/db/schema";
import { H3 } from "h3";
import { getDb } from "../server/db/index.mjs";
import { migrateRegistry } from "../server/db/migrations.mjs";
import * as tables from "../server/db/schema.mjs";
import { createNativeRegistry, createNativeRegistryAuth } from "../server/native-registry.mjs";
import { mountRegistryHttp } from "../server/registry-http.mjs";
import { createProjectCatalog, mountProjectCatalog } from "../server/project-catalog.mjs";
import { updateProjectWorkspaceKind } from "../server/registry-store.mjs";
import { startRootProvider } from "../server/root-provider.mjs";
import { parseStrictJson, evaluateRegistryOperation } from "../../../scripts/registry_contract_model.mjs";

const [proofRoot, entryFile, pythonPath] = process.argv.slice(2);
if (![proofRoot, entryFile, pythonPath].every(value => path.isAbsolute(value ?? ""))) throw Error("Explicit proof paths required");

test("real native catalog, scoped registry and non-enrolling custody compose", async suite => {
  const root = await mkdtemp(path.join(proofRoot, "catalog-"));
  const scope = path.join(root, "projects");
  const privateRoot = path.join(root, "private");
  await mkdir(scope); await mkdir(privateRoot);
  const locations = {};
  for (const ref of ["a", "b", "foreign"]) {
    locations[ref] = path.join(scope, ref); await mkdir(locations[ref]);
    await writeFile(path.join(locations[ref], "note.txt"), ref + " original\n");
  }
  const config = { deviceId: "catalog-device", scope, statePath: path.join(privateRoot, "roots.json"), locations };
  const email = "catalog@example.test";
  const grant = { orgId: "catalog-org", collectionId: "catalog-collection", policyRevision: 1, locationRefs: ["a", "b"] };
  const context = { userEmail: email, orgId: grant.orgId, appId: "workbench", caller: "frontend" };
  const token = randomUUID();
  const setRole = role => setAppMemberRole({ appId: "workbench", orgId: grant.orgId, email, role, updatedBy: email });
  const snapshot = async () => ({ projects: await getDb().select().from(tables.projects),
    bindings: await getDb().select().from(tables.bindings), receipts: await getDb().select().from(tables.receipts),
    revisions: await getDb().select().from(tables.revisions) });
  let provider;
  try {
    await withMigrationRuntime(async () => {
      await runMigrations(ORG_MIGRATIONS, { table: "catalog_org_migrations" })();
      await migrateRegistry(); await addSession(token, email);
    });
    await getDb().insert(organizations).values({ id: grant.orgId, name: "Catalog fixture", createdBy: email, createdAt: Date.now() });
    await getDb().insert(orgMembers).values({ id: "catalog-member", orgId: grant.orgId, email, role: "owner", joinedAt: Date.now() });
    provider = await startRootProvider({ python: await realpath(pythonPath), entryFile, config, parseStrictJson });
    const runtime = createNativeRegistry({ provider, grant, evaluate: evaluateRegistryOperation });
    const catalog = createProjectCatalog({ readScope: runtime.readScope, provider, locationLabels: { a: "Documents", b: "Research" } });
    const nitro = { h3: new H3() };
    const auth = createNativeRegistryAuth();
    mountProjectCatalog(nitro, { catalog, auth });
    mountRegistryHttp(nitro, { registration: runtime.registration, parseStrictJson, ...auth });
    await awaitBootstrap(nitro);
    const call = async (suffix = "", options = {}) => {
      const response = await nitro.h3.fetch(new Request("http://example.test/_agent-native/actions/vivary-project-catalog" + suffix,
        { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } }));
      return { status: response.status, body: await response.json() };
    };
    await suite.test("explicit native role gates HTTP; GET rejects query, suffix and method authority", async () => {
      assert.equal((await call()).status, 403);
      await setRole("project-registrar");
      assert.equal((await call("?actorId=foreign")).status, 400);
      assert.equal((await call("/foreign")).status, 404);
      assert.equal((await call("", { method: "POST" })).status, 405);
    });
    await suite.test("empty authorized catalog creates no identity, registry or receipt", async () => {
      const before = await snapshot();
      const result = await call();
      assert.equal(result.status, 200); assert.equal(result.body.code, "catalog");
      assert.deepEqual(result.body.projects, []);
      assert.equal(result.body.kindEditable, false, "a configured installation's catalog hides the kind controls");
      assert.deepEqual(result.body.locations, [ { locationRef: "a", displayName: "Documents", status: "available" },
        { locationRef: "b", displayName: "Research", status: "available" } ]);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await readdir(privateRoot), ["roots.json.lock"]);
    });
    const register = async (locationRef, displayName, revision, operationId = randomUUID().replaceAll("-", "")) => {
      const body = { locationRef, displayName, operationId, expectedPolicyRevision: 1,
        expectedRegistryRevision: revision, contentIdentity: null, attachProjectId: null };
      const response = await nitro.h3.fetch(new Request("http://example.test/_agent-native/actions/vivary-register-project", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
      assert.equal(response.status, 200); return { body, result: await response.json() };
    };
    await suite.test("registered projects appear while duplicate and replay keep one identity", async () => {
      const one = await register("a", "Alpha", 0, "first-operation");
      assert.equal(one.result.code, "registered");
      const replay = await register("a", "Alpha", 0, "first-operation");
      assert.deepEqual(replay.result, { ...one.result, replayed: true });
      assert.equal((await register("a", "Alpha", 1)).result.code, "already-registered");
      assert.equal((await register("b", "Beta", 2)).result.code, "registered");
      const before = await snapshot(); const custody = await readFile(config.statePath, "utf8");
      const result = await call();
      assert.deepEqual(result.body.projects.map(row => [row.displayName, row.status]), [["Alpha", "available"], ["Beta", "available"]]);
      assert.deepEqual(result.body.projects.map(row => row.workspaceKind), [null, null], "registration leaves the kind Not set");
      const serialized = JSON.stringify(result.body);
      for (const forbidden of ["root_", "actor_", "bindingId", "receipt", scope, email]) assert.ok(!serialized.includes(forbidden));
      assert.deepEqual(await snapshot(), before); assert.equal(await readFile(config.statePath, "utf8"), custody);
    });
    await suite.test("the catalog returns a saved kind without changing other records or files", async () => {
      const [alpha] = (await call()).body.projects;
      const before = await snapshot();
      assert.equal(await updateProjectWorkspaceKind(alpha.projectId, "personal"), true);
      const result = await call();
      assert.deepEqual(result.body.projects.map(row => row.workspaceKind), ["personal", null]);
      const after = await snapshot();
      assert.deepEqual({ ...after, projects: after.projects.map(row => ({ ...row, workspaceKind: null })) }, before);
      assert.deepEqual(await readdir(locations.a), ["note.txt"]);
    });
    await suite.test("same-scope read excludes foreign actor, collection, device and locator records", async () => {
      const first = (await snapshot()).bindings[0];
      for (const [index, change] of [{ actorId: "foreign" }, { collectionId: "foreign" }, { deviceId: "foreign" }, { locationRef: "foreign" }].entries()) {
        const projectId = "foreign-project-" + index;
        await getDb().insert(tables.projects).values({ projectId, schemaVersion: 1, displayName: "Secret foreign " + index });
        await getDb().insert(tables.bindings).values({ ...first, ...change, projectId, bindingId: "foreign-binding-" + index, rootId: "foreign-root-" + index });
      }
      const result = await call(); assert.equal(result.body.projects.length, 2);
      assert.ok(!JSON.stringify(result.body).includes("foreign"));
    });
    await suite.test("role loss during physical reads refuses the entire response", async () => {
      let once = false;
      const revoking = createProjectCatalog({ readScope: runtime.readScope, locationLabels: { a: "Documents", b: "Research" },
        provider: { inspect: async ref => { const result = await provider.inspect(ref); if (!once) { once = true; await setRole(null); } return result; } } });
      assert.deepEqual(await revoking.run({}, context), { code: "denied" });
      assert.equal((await call()).status, 403);
      await setRole("project-registrar");
      await getDb().delete(orgMembers).where(and(eq(orgMembers.orgId, grant.orgId), eq(orgMembers.email, email)));
      assert.equal((await call()).status, 403);
      await getDb().insert(orgMembers).values({ id: "catalog-member", orgId: grant.orgId, email, role: "member", joinedAt: Date.now() });
    });
    await suite.test("closed custody keeps authorized records unavailable without registry writes", async () => {
      const before = await snapshot(); await provider.close();
      const result = await call(); assert.equal(result.body.code, "catalog");
      assert.ok(result.body.locations.every(row => row.status === "unavailable"));
      assert.ok(result.body.projects.every(row => row.status === "unavailable"));
      assert.deepEqual(await snapshot(), before);
      for (const [ref, folder] of Object.entries(locations)) {
        assert.deepEqual(await readdir(folder), ["note.txt"]);
        assert.equal(await readFile(path.join(folder, "note.txt"), "utf8"), ref + " original\n");
      }
    });
  } finally { await provider?.close(); await removeSession(token); closeDbExec(); await rm(root, { recursive: true }); }
});
