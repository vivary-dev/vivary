import { z } from "zod";

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
    locations: z.array(z.strictObject({ locationRef: identifier, displayName: label,
      status: availability })).max(16),
    projects: z.array(z.strictObject({ projectId: identifier, displayName: label,
      bindingRevision: revision(1), status: availability,
      reconnectEligible: z.boolean().default(false) })).max(128),
  }),
]);

export type CatalogResult = z.infer<typeof catalogSchema>;
export type ProjectCatalog = Extract<CatalogResult, { code: "catalog" }>;
export type CatalogProject = ProjectCatalog["projects"][number];

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
