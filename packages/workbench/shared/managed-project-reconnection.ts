import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const managedProjectReconnectionPreviewInput = z.strictObject({
  projectId: identifier,
});
export const managedProjectReconnectionConfirmInput = z.strictObject({
  projectId: identifier,
  operationId: identifier,
  acceptedPlanSha256: digest,
});
const previewFields = {
  code: z.literal("reconnect-preview"),
  projectId: identifier,
  displayName: z.string().min(1).max(200),
  folderName: z.string().min(1).max(255),
  folderPath: z.string().min(1),
  folderKind: z.enum(["managed", "external"]),
  operationId: identifier,
  planSha256: digest,
};
export const managedProjectReconnectionPreviewOutput = z.discriminatedUnion("recorded", [
  z.strictObject({ ...previewFields, recorded: z.literal(false), identityChanged: z.literal(true) }),
  z.strictObject({ ...previewFields, recorded: z.literal(true), identityChanged: z.literal(false) }),
]);
export const managedProjectReconnectionResultOutput = z.strictObject({
  code: z.enum(["reconnected", "already-reconnected"]),
  projectId: identifier,
  bindingId: identifier,
  rootId: identifier,
  bindingRevision: revision,
  policyRevision: revision,
  registryRevision: revision,
});

export type ManagedProjectReconnectionPreview = z.infer<typeof managedProjectReconnectionPreviewOutput>;
export type ManagedProjectReconnectionResult = z.infer<typeof managedProjectReconnectionResultOutput>;
