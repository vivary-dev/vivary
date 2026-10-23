import { index, integer, table, text, uniqueIndex } from "@agent-native/core/db/schema";

// Metadata only. Native threads and Code transcripts remain the history owners.
export const conversationLinks = table("vivary_conversation_links", {
  linkId: text("link_id").primaryKey(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  record: text("record_json").notNull(),
}, row => [uniqueIndex("vivary_conversation_link_target").on(row.targetKind, row.targetId)]);

// One saved handoff and at most one pending request per designated document. The file holds the narrative.
export const handoffRecords = table("vivary_handoff_records", {
  projectId: text("project_id").notNull(),
  bindingId: text("binding_id").notNull(),
  path: text("path").notNull(),
  record: text("record_json").notNull(),
}, row => [uniqueIndex("vivary_handoff_record_document").on(row.projectId, row.bindingId, row.path)]);

export const projects = table("vivary_registry_projects", {
  projectId: text("project_id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  displayName: text("display_name").notNull(),
  contentAlgorithm: text("content_algorithm"),
  contentManifestDigest: text("content_manifest_digest"),
  // Owner preference, null until chosen. Values and meaning: shared/workspace-kind.ts.
  workspaceKind: text("workspace_kind"),
});

export const bindings = table("vivary_registry_bindings", {
  bindingId: text("binding_id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.projectId),
  collectionId: text("collection_id").notNull(),
  actorId: text("actor_id").notNull(),
  deviceId: text("device_id").notNull(),
  rootId: text("root_id").notNull(),
  verificationKind: text("verification_kind").notNull().default("held-custody-v1"),
  locationRef: text("location_ref").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  vcsKind: text("vcs_kind").notNull(),
  repositoryId: text("repository_id"),
  checkoutId: text("checkout_id"),
  mutationOwner: text("mutation_owner"),
  jjRepositoryId: text("jj_repository_id"),
  jjWorkspaceId: text("jj_workspace_id"),
}, (row) => [uniqueIndex("vivary_registry_physical_root").on(
  row.collectionId, row.deviceId, row.rootId,
)]);

export const revisions = table("vivary_registry_revisions", {
  scopeKey: text("scope_key").primaryKey(),
  collectionId: text("collection_id").notNull(),
  deviceId: text("device_id").notNull(),
  revision: integer("revision").notNull(),
}, (row) => [uniqueIndex("vivary_registry_revision_scope").on(row.collectionId, row.deviceId)]);

export const receipts = table("vivary_registry_receipts", {
  receiptKey: text("receipt_key").primaryKey(),
  actorId: text("actor_id").notNull(),
  collectionId: text("collection_id").notNull(),
  deviceId: text("device_id").notNull(),
  operation: text("operation").notNull(),
  operationId: text("operation_id").notNull(),
  requestDigest: text("request_digest"),
  creationNamespaceKey: text("creation_namespace_key"),
  creationChildKey: text("creation_child_key"),
  creationPhase: text("creation_phase"),
  record: text("record").notNull(),
}, (row) => [uniqueIndex("vivary_registry_operation_scope").on(
  row.actorId, row.collectionId, row.deviceId, row.operation, row.operationId,
), uniqueIndex("vivary_creation_target_reservation").on(
  row.collectionId, row.deviceId, row.creationNamespaceKey, row.creationChildKey,
)]);

export const mutationReservations = table("vivary_mutation_reservations", {
  reservationId: text("reservation_id").primaryKey(),
  ownerActorId: text("owner_actor_id").notNull(),
  ownerCollectionId: text("owner_collection_id").notNull(),
  ownerDeviceId: text("owner_device_id").notNull(),
  ownerOperationId: text("owner_operation_id").notNull(),
  state: text("state").notNull(),
  fence: integer("fence").notNull(),
  keys: text("keys_json").notNull(),
}, (row) => [uniqueIndex("vivary_mutation_reservation_owner").on(
  row.ownerActorId, row.ownerCollectionId, row.ownerDeviceId, row.ownerOperationId,
)]);

export const mutationReservationKeys = table("vivary_mutation_reservation_keys", {
  resourceKey: text("resource_key").primaryKey(),
  reservationId: text("reservation_id").notNull()
    .references(() => mutationReservations.reservationId),
}, (row) => [index("vivary_mutation_reservation_keys_parent").on(row.reservationId)]);

export const mutationFenceHighWater = table("vivary_mutation_fence_high_water", {
  resourceKey: text("resource_key").primaryKey(),
  fence: integer("fence").notNull(),
});
