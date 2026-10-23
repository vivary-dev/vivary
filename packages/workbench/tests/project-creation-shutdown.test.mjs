import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const directory = await realpath(await mkdtemp(path.join(tmpdir(), "vivary-creation-kind-shutdown-")));
const childTemporary = path.join(directory, "tmp");
await mkdir(childTemporary);
const database = "file:" + path.join(directory, "native.sqlite");
const originalCwd = process.cwd();
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
Object.assign(process.env, { APP_NAME: "Vivary", DATABASE_URL: database, DATABASE_URL_UNPOOLED: database,
  VIVARY_DATABASE_URL: database, VIVARY_DATABASE_URL_UNPOOLED: database,
  VIVARY_DATA_DIR: directory, VIVARY_PYTHON: process.platform === "win32" ? "python" : "python3",
  TEMP: childTemporary, TMP: childTemporary, TMPDIR: childTemporary });
delete process.env.VIVARY_ORIGINAL_RUNTIME; // guard:allow-env-credential - Test worker clears inherited packaged-runtime selection before importing the real Python bridge. // guard:allow-env-mutation - Isolate the unbundled bridge test in owned temporary storage before imports.

const { withMigrationRuntime, runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { ORG_MIGRATIONS, organizations, orgMembers } = await import("@agent-native/core/org");
const { getDb } = await import("../server/db/index.mjs");
const { projects } = await import("../server/db/schema.mjs");
const { eq } = await import("@agent-native/core/db/schema");
const { loadProductionRuntime, setLocalProjectKind, startProjectServices } = await import("../server/project-services.mjs");
const { previewManagedProject } = await import("../server/managed-projects.mjs");
const { default: createProject } = await import("../actions/vivary-create-new-project.ts");
const runtime = await loadProductionRuntime();
await withMigrationRuntime(() => runMigrations(ORG_MIGRATIONS, { table: "creation_shutdown_org_migrations" })());
after(async () => {
  process.chdir(originalCwd);
  await closeDbExec();
  await rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

// The request/response hooks and exact-path middleware match the existing project-services fixture.
function fakeNitro() {
  const hooks = new Map();
  const handlers = new Map();
  const nitro = { hooks: { hook(name, callback) {
    hooks.set(name, [...(hooks.get(name) ?? []), callback]);
  } } };
  const getH3App = () => ({ use(pathname, handler) {
    handlers.set(pathname, [...(handlers.get(pathname) ?? []), handler]);
  } });
  return { nitro, getH3App, async request(pathname) {
    const event = { url: new URL("http://example.test" + pathname), req: new Request("http://example.test" + pathname) };
    for (const callback of hooks.get("request") ?? []) await callback(event);
    let response;
    for (const handler of handlers.get(pathname) ?? []) {
      response = await handler(event);
      if (response !== undefined) break;
    }
    response ??= new Response("Not found", { status: 404 });
    for (const callback of hooks.get("response") ?? []) await callback(response, event);
    return response;
  } };
}

for (const race of ["inside-kind-scope", "after-registration"]) {
  test(`creation keeps its chosen kind when shutdown starts ${race}`, { timeout: 30_000 }, async () => {
    const owner = { userEmail: "owner@local.vivary.test", orgId: "creation-" + race,
      appId: "vivary", caller: "frontend" };
    await getDb().insert(organizations).values({ id: owner.orgId, name: race,
      createdBy: owner.userEmail, createdAt: Date.now() });
    await getDb().insert(orgMembers).values({ id: owner.orgId + "-member", orgId: owner.orgId,
      email: owner.userEmail, role: "owner", joinedAt: Date.now() });
    const fixture = fakeNitro();
    const reached = deferred();
    const release = deferred();
    let pauseKindScope = false;
    let providerCloses = 0;
    const controller = startProjectServices(fixture.nitro, {
      getH3App: fixture.getH3App, awaitBootstrap: async () => {},
      loadInstallation: async () => null, environment: { VIVARY_ACCESS_MODE: "local" },
      loadRuntime: async () => ({ ...runtime,
        // These handlers are outside the selected action; keep the real local service composition.
        mountRegistryHttp() {}, mountProjectCatalog() {},
        mountProjectRuntimeReadiness() {}, mountProjectRuntimeActivity() {},
        createLocalRootProvider: async options => {
          const provider = await runtime.createLocalRootProvider(options);
          // Preserve dynamic getters such as locationRefs while observing the real close.
          return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(provider),
            close: { value: async () => { providerCloses++; await provider.close(); } },
          });
        },
        createNativeRegistry: options => {
          const registry = runtime.createNativeRegistry(options);
          return { ...registry,
            registration: { ...registry.registration, async run(...args) {
              const result = await registry.registration.run(...args);
              if (["registered", "already-registered"].includes(result.code)) {
                if (race === "after-registration") {
                  // SQLite registration has committed; createManagedProject has not entered its kind setter.
                  reached.resolve(result.projectId);
                  await release.promise;
                } else {
                  pauseKindScope = true;
                }
              }
              return result;
            } },
            async readScope(context) {
              if (pauseKindScope) {
                pauseKindScope = false;
                // The actual setter already captured its service and is about to read its real provider scope.
                reached.resolve();
                await release.promise;
              }
              return registry.readScope(context);
            },
          };
        },
      }),
    });
    const pathname = "/_agent-native/actions/vivary-create-new-project";
    let active;
    let closing;
    try {
      assert.deepEqual(await controller.ready, { status: "open", failure: null });
      const input = { name: race, displayName: race, preset: "coding", workspaceKind: "personal" };
      const preview = await previewManagedProject(owner, input);
      assert.equal(preview.plan.target, path.join(directory, "projects", race), "creation stays inside the owned test root");
      input.acceptedPlanSha256 = preview.plan.plan_sha256;
      fixture.getH3App().use(pathname, async () => Response.json(await createProject.run(input, owner)));
      active = fixture.request(pathname);
      await Promise.race([reached.promise, active.then(() => { throw new Error("creation ended before the selected race"); })]);
      closing = controller.close();
      await new Promise(resolve => setImmediate(resolve));
      const closedBeforeRelease = providerCloses;
      // A fresh external owner context must still be refused while the admitted creation finishes.
      await assert.rejects(setLocalProjectKind({ ...owner }, "project_external", "coding"), { statusCode: 503 });
      release.resolve();
      const response = await active;
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.target, path.join(directory, "projects", race));
      await closing;
      const [row] = await getDb().select().from(projects).where(eq(projects.projectId, result.registration.projectId));
      assert.equal(closedBeforeRelease, 0, "the provider stayed open across the selected creation continuation");
      assert.equal(result.kindSaved, true, "the admitted creation completed its real kind save");
      assert.equal(row.workspaceKind, "personal", "the chosen kind persisted in SQLite before shutdown finished");
      assert.equal(providerCloses, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([active, closing ?? controller.close()]);
    }
  });
}
