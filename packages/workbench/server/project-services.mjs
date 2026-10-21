import { PROJECT_CHAT_SCOPE_PREFIX, projectChatScopeId } from "./chat-project-scope.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { defineEventHandler } from "h3";
import { z } from "zod";
import {
  deriveMutationKeys,
  evaluateRegistryOperation,
  parseStrictJson,
} from "../../../scripts/registry_contract_model.mjs";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const absolutePath = z.string().refine(value => isAbsolute(value) && normalize(value) === value);
const label = z.string().refine(value => value.isWellFormed()
  && Array.from(value).length >= 1 && Array.from(value).length <= 200);
const installationSchema = z.strictObject({
  python: absolutePath,
  entryFile: absolutePath,
  provider: z.strictObject({
    deviceId: identifier,
    scope: absolutePath,
    statePath: absolutePath,
    locations: z.record(identifier, absolutePath)
      .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 16),
  }),
  grant: z.strictObject({
    orgId: identifier,
    collectionId: identifier,
    policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    locationRefs: z.array(identifier).min(1).max(16)
      .refine(refs => new Set(refs).size === refs.length),
  }),
  locationLabels: z.record(identifier, label),
}).superRefine((value, context) => {
  const locations = new Set(Object.keys(value.provider.locations));
  const labels = new Set(Object.keys(value.locationLabels));
  for (const ref of value.grant.locationRefs) {
    if (!locations.has(ref)) {
      context.addIssue({ code: "custom", message: "grant location is not configured" });
    }
    if (!labels.has(ref)) {
      context.addIssue({ code: "custom", message: "grant location has no label" });
    }
  }
  if (labels.size !== value.grant.locationRefs.length
    || [...labels].some(ref => !value.grant.locationRefs.includes(ref))) {
    context.addIssue({ code: "custom", message: "location labels must exactly cover the grant" });
  }
});

export const PROJECT_ACTION_PATHS = Object.freeze([
  "/_agent-native/actions/vivary-register-project",
  "/_agent-native/actions/vivary-project-catalog",
  "/_agent-native/actions/vivary-project-runtime-readiness",
  "/_agent-native/actions/vivary-project-runtime-activity",
  "/_agent-native/actions/vivary-preview-managed-project-reconnection",
  "/_agent-native/actions/vivary-confirm-managed-project-reconnection",
  "/_agent-native/actions/vivary-set-project-kind",
]);

const controllers = new WeakMap();
const LOCAL_SERVICE = Symbol.for("vivary.local-project-services.v1");
const LOCAL_VERIFICATION = "local-stat-revalidated-v1";
const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const projectAction = pathname => PROJECT_ACTION_PATHS.some(path =>
  pathname === path || pathname.endsWith(path));

class InstallationError extends Error {
  constructor(code) {
    super(code);
    this.name = "InstallationError";
    this.code = code;
  }
}

export function parseProjectInstallation(value) {
  try {
    return deepFreeze(installationSchema.parse(value));
  } catch {
    throw new InstallationError("invalid-configuration");
  }
}

export async function loadProjectInstallation(filePath, dependencies = {}) {
  if (filePath === undefined || filePath === null || filePath === "") return null;
  if (!isAbsolute(filePath) || normalize(filePath) !== filePath) {
    throw new InstallationError("invalid-configuration-file");
  }
  const read = dependencies.readFile ?? readFile;
  const resolve = dependencies.realpath ?? realpath;
  const inspect = dependencies.stat ?? stat;
  let raw;
  try {
    raw = await read(filePath, "utf8");
  } catch {
    throw new InstallationError("configuration-unavailable");
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 65_536) {
    throw new InstallationError("invalid-configuration");
  }
  let parsed;
  try {
    parsed = parseStrictJson(raw);
  } catch {
    throw new InstallationError("invalid-configuration");
  }
  const configuration = parseProjectInstallation(parsed);
  try {
    for (const executable of [configuration.python, configuration.entryFile]) {
      if (await resolve(executable) !== executable || !(await inspect(executable)).isFile()) {
        throw new InstallationError("invalid-configuration");
      }
    }
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    throw new InstallationError("configuration-unavailable");
  }
  return configuration;
}

export async function loadProductionRuntime() {
  const [
    database,
    migrations,
    registry,
    registryHttp,
    provider,
    catalog,
    readiness,
    activity,
    localProvider,
  ] = await Promise.all([
    import("@agent-native/core/db"),
    import("./db/migrations.mjs"),
    import("./native-registry.mjs"),
    import("./registry-http.mjs"),
    import("./root-provider.mjs"),
    import("./project-catalog.mjs"),
    import("./project-runtime-readiness.mjs"),
    import("./project-runtime-activity.mjs"),
    import("./local-root-provider.mjs"),
  ]);
  return Object.freeze({
    migrateRegistry: () => database.withMigrationRuntime(() => migrations.migrateRegistry()),
    createNativeRegistry: registry.createNativeRegistry,
    createNativeRegistryAuth: registry.createNativeRegistryAuth,
    startRootProvider: provider.startRootProvider,
    createLocalRootProvider: localProvider.createLocalRootProvider,
    createProjectCatalog: catalog.createProjectCatalog,
    mountProjectCatalog: catalog.mountProjectCatalog,
    mountRegistryHttp: registryHttp.mountRegistryHttp,
    createProjectRuntimeReadiness: readiness.createProjectRuntimeReadiness,
    mountProjectRuntimeReadiness: readiness.mountProjectRuntimeReadiness,
    createProjectRuntimeActivity: activity.createProjectRuntimeActivity,
    mountProjectRuntimeActivity: activity.mountProjectRuntimeActivity,
  });
}

function diagnosticCode(error) {
  return error instanceof InstallationError ? error.code : "initialization-failed";
}

function defaultDiagnostic(code) {
  console.error(`[vivary-project-services] ${code}`);
}

export function startProjectServices(nitroApp, dependencies) {
  if (!nitroApp || typeof dependencies?.getH3App !== "function"
    || typeof dependencies?.awaitBootstrap !== "function") {
    throw new TypeError("project service startup requires Native application primitives");
  }
  const existing = controllers.get(nitroApp);
  if (existing) return existing;

  const hooks = nitroApp.hooks;
  const signals = dependencies.shutdownSignals;
  let status = "initializing";
  let failure = null;
  let provider = null;
  let providerClose = null;
  let closing = false;
  let ready;
  let closePromise;
  const activeRequests = new Set();
  const drainWaiters = new Set();

  const snapshot = () => Object.freeze({ status, failure });
  const finishRequest = event => {
    if (!activeRequests.delete(event) || activeRequests.size !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const waitForRequests = async () => {
    if (activeRequests.size === 0) return;
    const drainMs = Number.isInteger(dependencies.requestDrainMs)
      && dependencies.requestDrainMs >= 10 && dependencies.requestDrainMs <= 10_000
      ? dependencies.requestDrainMs
      : 5_000;
    let timer;
    await Promise.race([
      new Promise(resolve => drainWaiters.add(resolve)),
      new Promise(resolve => { timer = setTimeout(resolve, drainMs); }),
    ]);
    clearTimeout(timer);
    activeRequests.clear();
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const closeProvider = async () => {
    if (!provider) return;
    providerClose ??= Promise.resolve().then(() => provider.close());
    await providerClose;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    if (status === "open" || status === "initializing") status = "closing";
    closePromise = (async () => {
      try {
        await ready;
        await waitForRequests();
        await closeProvider();
        if (globalThis[LOCAL_SERVICE]?.controller === controller) delete globalThis[LOCAL_SERVICE];
        status = "closed";
        failure = null;
        return snapshot();
      } finally {
        signals?.off("SIGTERM", shutdown);
        signals?.off("SIGINT", shutdown);
      }
    })();
    return closePromise;
  };

  const shutdown = () => {
    void close().catch(() => {
      failure = "shutdown-failed";
      (dependencies.diagnostic ?? defaultDiagnostic)(failure);
    });
  };
  // The Node server closes HTTP on signals without invoking Nitro's close hook.
  signals?.once("SIGTERM", shutdown);
  signals?.once("SIGINT", shutdown);

  hooks?.hook?.("request", event => {
    if (status === "open" && projectAction(event.url?.pathname ?? "")) activeRequests.add(event);
  });
  hooks?.hook?.("response", (_response, event) => finishRequest(event));
  hooks?.hook?.("close", close);

  const unavailable = defineEventHandler(event => {
    if (status === "open") return;
    return Response.json({ error: "Project services unavailable" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  });
  const app = dependencies.getH3App(nitroApp);
  for (const path of PROJECT_ACTION_PATHS) app.use(path, unavailable);

  const controller = Object.freeze({
    get ready() { return ready; },
    close,
    snapshot,
  });
  controllers.set(nitroApp, controller);

  ready = (async () => {
    try {
      const installation = await (dependencies.loadInstallation ?? loadProjectInstallation)(
        dependencies.installationFile ?? process.env.VIVARY_PROJECT_INSTALLATION_FILE, // guard:allow-env-credential - Trusted server configuration path; no credential value.
      );
      const environment = dependencies.environment ?? process.env;
      const local = installation === null && ["local", "private-proxy"].includes(environment.VIVARY_ACCESS_MODE);
      if (installation === null && !local) {
        status = closing ? "closed" : "unconfigured";
        return snapshot();
      }
      if (closing) return snapshot();

      const runtime = await (dependencies.loadRuntime ?? loadProductionRuntime)();
      await dependencies.awaitBootstrap(nitroApp);
      if (closing) return snapshot();
      await runtime.migrateRegistry();
      if (closing) return snapshot();

      provider = local
        ? await runtime.createLocalRootProvider({
          ownerEmail: "owner@local.vivary.test",
          defaultFolder: environment.VIVARY_LOCAL_AGENT_WORKSPACE ?? null,
        })
        : await runtime.startRootProvider({
          python: installation.python,
          entryFile: installation.entryFile,
          config: installation.provider,
          parseStrictJson,
        });
      if (closing) return snapshot();

      const registry = runtime.createNativeRegistry({
        provider,
        ...(local ? { resolveGrant: provider.resolveGrant } : { grant: installation.grant }),
        evaluate: evaluateRegistryOperation,
        deriveMutationKeys,
      });
      const auth = runtime.createNativeRegistryAuth();
      const catalog = runtime.createProjectCatalog({
        readScope: registry.readScope,
        provider,
        locationLabels: local ? provider.locationLabels : installation.locationLabels,
        canReconnect: local
          ? () => true : undefined,
        // vivary-set-project-kind writes through the local service only. A configured installation has none.
        kindEditable: local,
      });
      const readiness = runtime.createProjectRuntimeReadiness({
        readScope: registry.readScope,
        provider,
      });
      const activity = runtime.createProjectRuntimeActivity({
        readScope: registry.readScope,
        provider,
      });
      runtime.mountRegistryHttp(nitroApp, {
        registration: registry.registration,
        parseStrictJson,
        ...auth,
      });
      runtime.mountProjectCatalog(nitroApp, { catalog, auth });
      runtime.mountProjectRuntimeReadiness(nitroApp, { readiness, auth });
      runtime.mountProjectRuntimeActivity(nitroApp, { activity, auth });
      if (local) globalThis[LOCAL_SERVICE] = { controller, provider, registry, catalog };
      status = "open";
      return snapshot();
    } catch (error) {
      const code = diagnosticCode(error);
      failure = code;
      status = closing ? "closing" : "failed";
      (dependencies.diagnostic ?? defaultDiagnostic)(code);
      try {
        await closeProvider();
      } catch {
        failure = "shutdown-failed";
      }
      return snapshot();
    }
  })();

  return controller;
}


// Native tool call contexts that matchChatProject admitted, each mapped to the
// one project its chat is pinned to. Only the admitted object itself counts.
const chatProjects = new WeakMap();
const CHAT_CATALOG = Symbol("chat catalog");

// `tool` is the project a Native tool call may reach: the catalog read inside
// matchChatProject, or the project matchChatProject admitted it for.
function localService(context, tool) {
  const service = globalThis[LOCAL_SERVICE];
  if (!service || service.controller.snapshot().status !== "open") {
    throw Object.assign(new Error("Local project folders are not ready."), { statusCode: 503 });
  }
  const chatTool = context?.caller === "tool" && tool !== undefined
    && (tool === CHAT_CATALOG || chatProjects.get(context) === tool);
  if (!context || !["vivary", "workbench"].includes(context.appId)
    || !(["frontend", "http"].includes(context.caller) || chatTool)
    || context.userEmail?.trim().toLowerCase() !== "owner@local.vivary.test"
    || !identifier.safeParse(context.orgId).success) {
    throw Object.assign(new Error("Local project access is unavailable."), { statusCode: 403 });
  }
  // Both names belong to this app. Workbench retains its existing role namespace.
  // The registry reads the owner's scope for an admitted tool call, which
  // stays "tool" everywhere outside this module.
  return { service, owner: Object.freeze({ userEmail: context.userEmail, orgId: context.orgId,
    appId: "workbench", caller: chatTool ? "http" : context.caller }) };
}

/**
 * Classifies the Native chat scope the current request is pinned to. The
 * scope comes from the request, never from the caller. The owner's request
 * gets its own context back. A Native tool call gets a context that the read
 * entry points accept for that project only, and it stays a tool call. A
 * project scope of the wrong type, without an identity, or that does not match
 * exactly one registered project is refused.
 */
export async function matchChatProject(context) {
  const { getRequestRunContext } = await import("@agent-native/core/server");
  const scope = getRequestRunContext()?.chatScope;
  if (!scope?.id.startsWith(PROJECT_CHAT_SCOPE_PREFIX)) return { kind: "not-project" };
  const email = context?.userEmail?.trim().toLowerCase();
  if (scope.type !== "workspace-app" || !email || !context.orgId) {
    throw Object.assign(new Error("Project conversation access is unavailable."), { statusCode: 403 });
  }
  if (scope.id === projectChatScopeId(email, context.orgId, null)) return { kind: "personal" };
  const tool = context?.caller === "tool";
  const { service, owner } = localService(context, tool ? CHAT_CATALOG : undefined);
  const catalog = await service.catalog.run({}, owner);
  if (catalog.code !== "catalog") {
    throw Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  }
  const matches = catalog.projects.filter(project =>
    projectChatScopeId(owner.userEmail, owner.orgId, project.projectId) === scope.id);
  if (matches.length !== 1) {
    throw Object.assign(new Error("Project conversation access is unavailable."), { statusCode: 403 });
  }
  const { projectId } = matches[0];
  if (!tool) return { kind: "project", projectId, context };
  const admitted = Object.freeze({ ...context });
  chatProjects.set(admitted, projectId);
  return { kind: "project", projectId, context: admitted };
}

export function getLocalProjectReconnectionService(context) {
  return localService(context);
}

export async function getLocalProjectAccess(context) {
  const { service, owner } = localService(context);
  return service.catalog.run({}, owner);
}

/** The desktop picker or trusted launcher supplies folder. No public action accepts a path. */
export async function connectLocalProjectFolder(context, folder, displayName) {
  const { service, owner } = localService(context);
  if (!await service.registry.readScope(owner)) {
    throw Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  }
  const selected = await service.provider.addGrantedFolder(owner, folder);
  const catalog = await service.catalog.run({}, owner);
  if (catalog.code !== "catalog") throw new Error("The project list could not be refreshed.");
  const name = label.parse(displayName ?? selected.displayName);
  const result = await service.registry.registration.run({
    operationId: randomUUID().replaceAll("-", ""),
    expectedPolicyRevision: catalog.policyRevision, expectedRegistryRevision: catalog.registryRevision,
    locationRef: selected.locationRef, displayName: name, contentIdentity: null, attachProjectId: null,
  }, owner);
  return Object.freeze({ ...result, locationRef: selected.locationRef, displayName: name });
}

/** The owner's current project scope, for a project id that is well formed. */
async function readLocalProjectScope(context, projectId) {
  const { service, owner } = localService(context, projectId);
  if (!identifier.safeParse(projectId).success) {
    throw Object.assign(new Error("Choose a registered project."), { statusCode: 400 });
  }
  const scope = await service.registry.readScope(owner);
  if (!scope) throw Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  return { service, owner, scope };
}

async function resolveLocalProjectBinding(context, projectId) {
  const { service, owner, scope } = await readLocalProjectScope(context, projectId);
  const [{ getDb }, { bindings, projects }, { and, eq, inArray }] = await Promise.all([
    import("./db/index.mjs"), import("./db/schema.mjs"), import("@agent-native/core/db/schema"),
  ]);
  const rows = await getDb().select({ bindingId: bindings.bindingId, bindingRevision: bindings.bindingRevision,
    rootId: bindings.rootId, locationRef: bindings.locationRef, verificationKind: bindings.verificationKind,
    label: projects.displayName }).from(bindings).innerJoin(projects, eq(bindings.projectId, projects.projectId))
    .where(and(eq(bindings.projectId, projectId), eq(bindings.actorId, scope.actorId),
      eq(bindings.collectionId, scope.collectionId), eq(bindings.deviceId, scope.deviceId),
      inArray(bindings.locationRef, scope.locationRefs))).limit(2);
  const binding = rows[0];
  if (rows.length !== 1 || binding.verificationKind !== LOCAL_VERIFICATION) {
    throw Object.assign(new Error("This project does not have one connected local folder."), { statusCode: 409 });
  }
  return { service, owner, scope, binding };
}

async function requireCurrentProjectScope(service, owner, scope) {
  const current = await service.registry.readScope(owner);
  if (!current || JSON.stringify(current) !== JSON.stringify(scope)) {
    throw Object.assign(new Error("Project folder access changed."), { statusCode: 403 });
  }
}

/** Read registered project identity without requiring its local folder to exist. */
export async function resolveLocalProjectHistory(context, projectId) {
  const { service, owner, scope, binding } = await resolveLocalProjectBinding(context, projectId);
  await requireCurrentProjectScope(service, owner, scope);
  return Object.freeze({ label: binding.label, projectId,
    bindingId: binding.bindingId, rootId: binding.rootId,
    bindingRevision: binding.bindingRevision });
}

/**
 * Saves the owner's Coding or Personal choice for one registered project in
 * the owner's scope. It writes only the registry row, never project files, and
 * does not need the folder to be available. The project needs at least one
 * binding in the owner's current scope, the same rule the catalog lists it by,
 * so a project with several same-scope bindings can be saved as well.
 */
export async function setLocalProjectKind(context, projectId, kind) {
  // Only the owner chooses. An admitted chat tool may read its project but never change this preference.
  if (context?.caller === "tool") {
    throw Object.assign(new Error("Local project access is unavailable."), { statusCode: 403 });
  }
  const { service, owner, scope } = await readLocalProjectScope(context, projectId);
  const [{ getDb }, { bindings }, { and, eq, inArray }] = await Promise.all([
    import("./db/index.mjs"), import("./db/schema.mjs"), import("@agent-native/core/db/schema"),
  ]);
  const listed = await getDb().select({ bindingId: bindings.bindingId }).from(bindings)
    .where(and(eq(bindings.projectId, projectId), eq(bindings.actorId, scope.actorId),
      eq(bindings.collectionId, scope.collectionId), eq(bindings.deviceId, scope.deviceId),
      inArray(bindings.locationRef, scope.locationRefs))).limit(1);
  if (listed.length === 0) throw Object.assign(new Error("Choose a registered project."), { statusCode: 404 });
  const { updateProjectWorkspaceKind } = await import("./registry-store.mjs");
  await requireCurrentProjectScope(service, owner, scope);
  if (!await updateProjectWorkspaceKind(projectId, kind)) {
    throw Object.assign(new Error("Choose a registered project."), { statusCode: 404 });
  }
  return Object.freeze({ projectId, workspaceKind: kind });
}

/** Resolves local access for Native execution. This is not a held-custody execution grant. */
export async function resolveLocalProjectWorkspace(context, projectId) {
  const { service, owner, scope, binding } = await resolveLocalProjectBinding(context, projectId);
  const resolved = await service.provider.resolvePath(owner, binding.rootId, binding.locationRef);
  await requireCurrentProjectScope(service, owner, scope);
  if (!resolved) {
    throw Object.assign(new Error("The project folder is missing or changed. Reconnect it from Projects."),
      { statusCode: 409 });
  }
  return Object.freeze({ root: resolved.path, label: binding.label, projectId, actorId: scope.actorId,
    bindingId: binding.bindingId, bindingRevision: binding.bindingRevision,
    policyRevision: scope.policyRevision, rootId: binding.rootId, locationRef: binding.locationRef,
    verificationKind: LOCAL_VERIFICATION });
}
