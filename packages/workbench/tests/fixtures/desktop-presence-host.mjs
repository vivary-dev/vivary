// A desktop server child for desktop-presence-timer.test.ts. Core app state, the owner's org, the local folder
// provider, the registry and the project catalog are real, set up as local-root-provider.test.mjs sets them up.
// The code host is a stand-in, because the agent and review phases would otherwise need live coding runs.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";

let host = { activeRun: null, pendingApproval: null };
mock.module(new URL("../../server/local-code-agent.ts", import.meta.url).href, {
  namedExports: { getVivaryCodeHostState: async () => host },
});
mock.timers.enable({ apis: ["setInterval"] });

const OWNER = "owner@local.vivary.test";
const ORG = "presence-test-org";
const context = { userEmail: OWNER, orgId: ORG, appId: "workbench", caller: "frontend" };

const { runMigrations, withMigrationRuntime } = await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers } = await import("@agent-native/core/org");
const { writeAppState } = await import("@agent-native/core/application-state");
const { runWithRequestContext } = await import("@agent-native/core/server");
const { getDb } = await import("../../server/db/index.mjs");
const { migrateRegistry } = await import("../../server/db/migrations.mjs");
const { createLocalRootProvider } = await import("../../server/local-root-provider.mjs");
const { createNativeRegistry } = await import("../../server/native-registry.mjs");
const { createProjectCatalog } = await import("../../server/project-catalog.mjs");
const { evaluateRegistryOperation, deriveMutationKeys } = await import("../../../../scripts/registry_contract_model.mjs");
const { installDesktopPresencePublisher } = await import("../../server/desktop-presence.ts");
const { writeDesktopSettings } = await import("../../server/desktop-settings-store.ts");

const share = enabled => writeDesktopSettings({ discord: { enabled, applicationId: "123456789012345678" } });

const alpha = path.join(process.argv[2], "Alpha");
const beta = path.join(process.argv[2], "Beta");
const gamma = path.join(process.argv[2], "Gamma");
await Promise.all([mkdir(alpha), mkdir(beta), mkdir(gamma)]);
await withMigrationRuntime(async () => {
  await runMigrations(ORG_MIGRATIONS, { table: "presence_test_org_migrations" })();
  await migrateRegistry();
});
await getDb().insert(organizations).values({ id: ORG, name: "Presence test", createdBy: OWNER, createdAt: Date.now() });
await getDb().insert(orgMembers).values({ id: "presence-test-member", orgId: ORG, email: OWNER, role: "owner",
  joinedAt: Date.now() });

const provider = await createLocalRootProvider({ ownerEmail: OWNER, defaultFolder: alpha });
const registry = createNativeRegistry({ provider, resolveGrant: provider.resolveGrant,
  evaluate: evaluateRegistryOperation, deriveMutationKeys });
const catalog = createProjectCatalog({ readScope: registry.readScope, provider, locationLabels: provider.locationLabels });
globalThis[Symbol.for("vivary.local-project-services.v1")] = {
  provider, registry, catalog, controller: { snapshot: () => ({ status: "open" }) },
};

async function register(key, locationRef, displayName) {
  const current = await catalog.run({}, context);
  const result = await registry.registration.run({ operationId: `presence-${key}`,
    expectedPolicyRevision: current.policyRevision, expectedRegistryRevision: current.registryRevision,
    locationRef, displayName, contentIdentity: null, attachProjectId: null }, context);
  return result.projectId;
}
const projects = {
  a: await register("a", (await catalog.run({}, context)).locations[0].locationRef, "Project A"),
  b: await register("b", (await provider.addGrantedFolder(context, beta)).locationRef, "Project B"),
  // 150 code points and 300 UTF-16 units, past the 128 code points a presence label may hold.
  emoji: await register("emoji", (await provider.addGrantedFolder(context, gamma)).locationRef, "🚀".repeat(150)),
};
const { scopeKey } = await catalog.run({}, context);

// ProjectContext.tsx saves the catalog's scopeKey with the project through Core's app-state route, keyed by the owner.
const select = projectId => runWithRequestContext({ userEmail: OWNER, orgId: ORG },
  () => writeAppState("vivary-project-selection-v1", { scopeKey, projectId }));

process.on("message", async message => {
  if (message?.type === "test:select") await select(message.projectId);
  else if (message?.type === "test:share") await share(message.enabled);
  else if (message?.type === "test:host") host = message.host;
  else if (message?.type === "test:tick") mock.timers.tick(5_000);
  else return;
  process.send({ type: "test:done" });
});

await select(projects.a);
await share(true);
installDesktopPresencePublisher();
process.send({ type: "test:ready", projects });
