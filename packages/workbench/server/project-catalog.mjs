/** Read-only scoped projection; native access and physical custody keep their owners. */
import { createHash } from "node:crypto";
import { defineAction } from "@agent-native/core/action";
import { and, eq, inArray } from "@agent-native/core/db/schema";
import { getH3App, mountActionRoutes } from "@agent-native/core/server";
import { defineEventHandler } from "h3";
import { z } from "zod";
import { catalogSchema } from "../app/lib/project-catalog-schema.ts";
import { workspaceKind } from "../shared/workspace-kind.ts";
import { getDb } from "./db/index.mjs";
import { bindings, projects, revisions } from "./db/schema.mjs";

const ACTION_NAME = "vivary-project-catalog";
const ACTION_PATH = `/_agent-native/actions/${ACTION_NAME}`;
const schema = z.strictObject({});
const label = z.string().refine(value => value.isWellFormed()
  && Array.from(value).length >= 1 && Array.from(value).length <= 200);
const labelsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), label);
const refused = code => ({ code });
const fingerprint = scope => createHash("sha256").update(JSON.stringify(scope)).digest("hex");

function contextSnapshot(context) {
  if (!context || typeof context !== "object") return undefined;
  return Object.freeze(Object.fromEntries(["userEmail", "orgId", "appId", "caller", "actionName"]
    .filter(key => typeof context[key] === "string").map(key => [key, context[key]])));
}

/** Installation-only arguments. Browser input cannot supply a resolver or root label map. */
export function createProjectCatalog({ readScope, provider, locationLabels, canReconnect }) {
  if (typeof readScope !== "function" || typeof provider?.inspect !== "function") {
    throw new TypeError("project catalog requires the current native scope and trusted root provider");
  }
  const fixedLabels = typeof locationLabels === "function" ? null : Object.freeze(labelsSchema.parse(locationLabels));

  async function read(context) {
    const owner = contextSnapshot(context);
    const scope = await readScope(owner);
    if (!scope) return refused("denied");
    const labels = fixedLabels ?? labelsSchema.parse(await locationLabels());
    if (!scope.locationRefs.every(ref => Object.hasOwn(labels, ref))) return refused("unavailable");

    const snapshot = await getDb().transaction(async tx => {
      const [version] = await tx.select({ revision: revisions.revision }).from(revisions).where(and(
        eq(revisions.collectionId, scope.collectionId), eq(revisions.deviceId, scope.deviceId),
      ));
      const records = await tx.select({ projectId: projects.projectId, displayName: projects.displayName,
        workspaceKind: projects.workspaceKind, bindingRevision: bindings.bindingRevision, locationRef: bindings.locationRef, rootId: bindings.rootId,
        verificationKind: bindings.verificationKind,
      }).from(bindings).innerJoin(projects, eq(projects.projectId, bindings.projectId)).where(and(
        eq(bindings.actorId, scope.actorId), eq(bindings.collectionId, scope.collectionId),
        eq(bindings.deviceId, scope.deviceId), inArray(bindings.locationRef, scope.locationRefs),
      )).limit(129);
      return { registryRevision: version?.revision ?? 0, records };
    });
    if (snapshot.records.length > 128) return refused("unavailable");

    const observed = new Map();
    const reconnectable = new Map();
    for (const ref of scope.locationRefs) {
      try { observed.set(ref, await provider.inspect(ref)); }
      catch { observed.set(ref, { code: "unavailable" }); }
      try { reconnectable.set(ref, await canReconnect?.(ref) === true); }
      catch { reconnectable.set(ref, false); }
    }
    const current = await readScope(owner);
    if (!current || fingerprint(current) !== fingerprint(scope)) return refused("denied");

    const bindingCounts = new Map();
    for (const record of snapshot.records) {
      bindingCounts.set(record.projectId, (bindingCounts.get(record.projectId) ?? 0) + 1);
    }
    const byProject = new Map();
    for (const record of snapshot.records) {
      const root = observed.get(record.locationRef);
      const status = root?.code === "available" && root.rootId !== null && root.rootId === record.rootId
        && (root.verificationKind ?? "held-custody-v1") === record.verificationKind
        ? "available" : "unavailable";
      const previous = byProject.get(record.projectId);
      // A same-scope multi-binding record can select an available binding, but
      // cannot acquire file access or a runtime through this read projection.
      if (!previous || previous.status !== "available") byProject.set(record.projectId, {
        projectId: record.projectId, displayName: record.displayName,
        bindingRevision: record.bindingRevision, status,
        reconnectEligible: status === "unavailable"
          && bindingCounts.get(record.projectId) === 1
          && record.verificationKind === "local-stat-revalidated-v1"
          && reconnectable.get(record.locationRef) === true,
        // The column check admits only these values. Anything else reads as Not set rather than failing the list.
        workspaceKind: workspaceKind.safeParse(record.workspaceKind).data ?? null,
      });
    }
    return { code: "catalog", scopeKey: fingerprint({ actorId: scope.actorId,
      collectionId: scope.collectionId, deviceId: scope.deviceId }), policyRevision: scope.policyRevision,
      registryRevision: snapshot.registryRevision,
      locations: scope.locationRefs.map(locationRef => ({ locationRef, displayName: labels[locationRef],
        status: observed.get(locationRef)?.code === "available" ? "available" : "unavailable" })),
      projects: [...byProject.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)
        || left.projectId.localeCompare(right.projectId)),
    };
  }

  return defineAction({
    description: "List currently authorized configured folders and registered projects.",
    schema, outputSchema: catalogSchema, outputErrorStrategy: "strict",
    http: false, agentTool: false, mcpTool: false, toolCallable: false, readOnly: true,
    audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
    authorize: async (_input, context) => Boolean(await readScope(contextSnapshot(context))),
    run: async (_input, context) => read(context),
  });
}

/** Native GET action transport; no new CRUD endpoint or authentication implementation. */
export function mountProjectCatalog(nitroApp, { catalog, auth }) {
  if (!catalog?.schema || typeof catalog.run !== "function"
    || typeof auth?.getOwnerFromEvent !== "function" || typeof auth?.resolveOrgId !== "function") {
    throw new TypeError("catalog mount requires its action and current native authentication");
  }
  getH3App(nitroApp).use(ACTION_PATH, defineEventHandler(event => {
    if (event.url.pathname !== "/") return Response.json({ error: "Not found" }, { status: 404 });
    if (event.req.method === "OPTIONS") return;
    if (event.req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
    if (event.url.search !== "") return Response.json({ error: "Catalog accepts no query fields" }, { status: 400 });
  }));
  mountActionRoutes(nitroApp, { [ACTION_NAME]: { ...catalog, http: { method: "GET" }, requiresAuth: true } },
    { ...auth, appId: "workbench", allowDelegatedCaller: false });
}
