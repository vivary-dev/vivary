import { z } from "zod";
import { workspaceKind, type WorkspaceKind } from "../../shared/workspace-kind.ts";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = (minimum: number) => z.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER);
const label = z.string().refine(value => value.isWellFormed()
  && Array.from(value).length >= 1 && Array.from(value).length <= 200);
const availability = z.enum(["available", "unavailable"]);

export const catalogSchema = z.union([
  z.strictObject({ code: z.enum(["denied", "unavailable"]) }),
  z.strictObject({
    code: z.literal("catalog"), scopeKey: identifier,
    policyRevision: revision(1), registryRevision: revision(0),
    kindEditable: z.boolean().default(false),
    locations: z.array(z.strictObject({ locationRef: identifier, displayName: label,
      status: availability })).max(16),
    projects: z.array(z.strictObject({ projectId: identifier, displayName: label,
      bindingRevision: revision(1), status: availability,
      reconnectEligible: z.boolean().default(false),
      workspaceKind: workspaceKind.nullable().default(null) })).max(128),
  }),
]);

export type CatalogResult = z.infer<typeof catalogSchema>;
export type ProjectCatalog = Extract<CatalogResult, { code: "catalog" }>;
export type CatalogProject = ProjectCatalog["projects"][number];

/** The query key `useActionQuery("vivary-project-catalog", {})` caches the project list under. */
export const CATALOG_QUERY_KEY = ["action", "vivary-project-catalog", {}] as const;

/** The cached project list with one project's saved kind applied. Anything else is returned unchanged. */
export function withProjectKind(current: CatalogResult | undefined, projectId: string, kind: WorkspaceKind) {
  if (current?.code !== "catalog") return current;
  return { ...current, projects: current.projects.map(project =>
    project.projectId === projectId ? { ...project, workspaceKind: kind } : project) };
}

/**
 * Whether Open folder asks Coding or Personal for the folder it just registered or found registered. It asks only
 * where the host can save a kind and only while the project's kind is Not set. Without a fresh list, a new
 * registration still asks and a repeated one does not.
 */
export function openedFolderNeedsKind(code: "registered" | "already-registered", projectId: string,
  catalog: CatalogResult | undefined) {
  if (catalog?.code !== "catalog") return code === "registered";
  if (!catalog.kindEditable) return false;
  const project = catalog.projects.find(item => item.projectId === projectId);
  return project ? project.workspaceKind === null : code === "registered";
}

export const selectionSchema = z.strictObject({ scopeKey: identifier, projectId: identifier.nullable() });
export type ProjectSelection = z.infer<typeof selectionSchema>;

export type RegistrationAttempt = {
  operationId: string;
  expectedPolicyRevision: number;
  expectedRegistryRevision: number;
  locationRef: string;
  displayName: string;
  contentIdentity: null;
  attachProjectId: null;
};

export type RegistrationResult =
  | { code: "registered" | "already-registered"; projectId: string; bindingId: string;
      bindingRevision: number; replayed: boolean }
  | { code: "invalid-input" | "denied" | "stale-policy" | "root-unavailable"
      | "not-directory" | "identity-unverified" | "attachment-required"
      | "ambiguous-ownership" | "retry-state" | "allocation-conflict"
      | "operation-conflict" | "reconciliation-required" | "superseded-operation"
      | "binding-unavailable" };
