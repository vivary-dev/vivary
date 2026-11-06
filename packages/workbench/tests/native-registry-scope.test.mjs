import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { H3Event } from "h3";

// Each run owns a disposable database, so the fixed ids below never collide.
const directory = await mkdtemp(path.join(tmpdir(), "vivary-registry-scope-"));
const database = "file:" + path.join(directory, "native.sqlite");
Object.assign(process.env, { DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARY_DATABASE_URL: database, VIVARY_DATABASE_URL_UNPOOLED: database });
test.after(() => rm(directory, { recursive: true, force: true }));
const { withMigrationRuntime, runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers, setAppMemberRole } = await import("@agent-native/core/org");
const { addSession, removeSession } = await import("@agent-native/core/server");
const { and, eq } = await import("@agent-native/core/db/schema");
const { getDb } = await import("../server/db/index.mjs");
const { createNativeRegistry, createNativeRegistryAuth } = await import("../server/native-registry.mjs");
const { evaluateRegistryOperation } = await import("../../../scripts/registry_contract_model.mjs");

test("catalog scope shares native authority without observing or broadening it", async (suite) => {
  const email = "catalog-actor@example.test";
  const orgId = "catalog-org";
  const original = { userEmail: email, orgId, appId: "workbench", caller: "frontend" };
  const grant = { orgId, collectionId: "catalog-collection", policyRevision: 3,
    locationRefs: ["location-a", "location-b"] };
  let observations = 0;
  const provider = Object.freeze({ deviceId: "catalog-device", locationRefs: grant.locationRefs,
    observe: async () => { observations++; throw new Error("scope reads must not observe roots"); } });
  const runtime = createNativeRegistry({ provider, grant, evaluate: evaluateRegistryOperation });
  const assign = (role) => setAppMemberRole({ appId: "workbench", orgId, email,
    role, updatedBy: email });
  const token = randomUUID();
  try {
    await withMigrationRuntime(async () => {
      await runMigrations(ORG_MIGRATIONS, { table: "scope_proof_org_migrations" })();
      await addSession(token, email);
    });
    await getDb().insert(organizations).values({ id: orgId, name: "Catalog fixture",
      createdBy: email, createdAt: Date.now() });
    await getDb().insert(orgMembers).values({ id: "catalog-member", orgId, email,
      role: "owner", joinedAt: Date.now() });
    await suite.test("native org ownership without explicit app capability stays denied", async () => {
      assert.equal(await runtime.readScope(original), null);
      for (const context of [undefined, null, [], {}, { ...original, caller: "agent" },
        { ...original, appId: "other" }, { ...original, orgId: "foreign" },
        { ...original, userEmail: "" }]) assert.equal(await runtime.readScope(context), null);
    });
    await assign("project-registrar");
    await suite.test("scope snapshots caller primitives before native asynchronous lookup", async () => {
      const mutable = { ...original };
      const pending = runtime.readScope(mutable);
      Object.assign(mutable, { userEmail: "changed@example.test", orgId: "foreign", appId: "other" });
      grant.locationRefs.push("later-added");
      const scope = await pending;
      assert.deepEqual(scope, { actorId: "actor_" + createHash("sha256").update(orgId + "\0" + email).digest("hex"),
        collectionId: "catalog-collection", deviceId: "catalog-device", policyRevision: 3,
        locationRefs: ["location-a", "location-b"] });
      assert.ok(Object.isFrozen(scope));
      assert.ok(Object.isFrozen(scope.locationRefs));
      assert.equal(await runtime.readScope(mutable), null);
      assert.equal(observations, 0);
    });
    await suite.test("only the owner's own requests read the scope", async () => {
      assert.notEqual(await runtime.readScope(original), null);
      for (const caller of ["tool", "agent"]) assert.equal(await runtime.readScope({ ...original, caller }), null);
    });
    await suite.test("each scope lookup observes native role and membership removal", async () => {
      assert.notEqual(await runtime.readScope(original), null);
      await assign(null);
      assert.equal(await runtime.readScope(original), null);
      await assign("retired-role");
      assert.equal(await runtime.readScope(original), null);
      await assign("project-registrar");
      await getDb().delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.email, email)));
      assert.equal(await runtime.readScope(original), null);
      await getDb().insert(orgMembers).values({ id: "catalog-member", orgId, email,
        role: "member", joinedAt: Date.now() });
      assert.notEqual(await runtime.readScope(original), null);
    });
    await suite.test("shared request callbacks resolve the same actual native session and organization", async () => {
      const auth = createNativeRegistryAuth();
      assert.ok(Object.isFrozen(auth));
      assert.deepEqual(Object.keys(auth).sort(), ["getOwnerFromEvent", "resolveOrgId"]);
      const event = new H3Event(new Request("http://example.test/_agent-native/actions/catalog", {
        headers: { authorization: `Bearer ${token}` },
      }));
      assert.equal(await auth.getOwnerFromEvent(event), email);
      assert.equal(await auth.resolveOrgId(event), orgId);
      assert.equal(observations, 0);
    });
  } finally {
    await removeSession(token);
    closeDbExec();
  }
});
