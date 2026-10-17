import { runMigrations } from "@agent-native/core/db";

export const migrateRegistry = runMigrations([{
  version: 1,
  name: "vivary-registry-registration-v1",
  sql: `
    CREATE TABLE IF NOT EXISTS vivary_registry_projects (
      project_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      content_algorithm TEXT,
      content_manifest_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS vivary_registry_bindings (
      binding_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES vivary_registry_projects(project_id),
      collection_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      location_ref TEXT NOT NULL,
      binding_revision INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL,
      vcs_kind TEXT NOT NULL,
      repository_id TEXT,
      checkout_id TEXT,
      mutation_owner TEXT,
      jj_repository_id TEXT,
      jj_workspace_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vivary_registry_physical_root
      ON vivary_registry_bindings(collection_id, device_id, root_id);
    CREATE TABLE IF NOT EXISTS vivary_registry_revisions (
      scope_key TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vivary_registry_revision_scope
      ON vivary_registry_revisions(collection_id, device_id);
    CREATE TABLE IF NOT EXISTS vivary_registry_receipts (
      receipt_key TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vivary_registry_operation_scope
      ON vivary_registry_receipts(actor_id, collection_id, device_id, operation, operation_id);
  `,
}, {
  version: 2,
  name: "vivary-creation-receipts-v1",
  sql: `
    ALTER TABLE vivary_registry_receipts ADD COLUMN request_digest TEXT;
    ALTER TABLE vivary_registry_receipts ADD COLUMN creation_namespace_key TEXT;
    ALTER TABLE vivary_registry_receipts ADD COLUMN creation_child_key TEXT;
    ALTER TABLE vivary_registry_receipts ADD COLUMN creation_phase TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS vivary_creation_target_reservation
      ON vivary_registry_receipts(
        collection_id, device_id, creation_namespace_key, creation_child_key
      );
  `,
}, {
  version: 3,
  name: "vivary-mutation-admission-v1",
  sql: `
    CREATE TABLE IF NOT EXISTS vivary_mutation_reservations (
      reservation_id TEXT PRIMARY KEY,
      owner_actor_id TEXT NOT NULL,
      owner_collection_id TEXT NOT NULL,
      owner_device_id TEXT NOT NULL,
      owner_operation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'uncertain')),
      fence INTEGER NOT NULL CHECK (fence >= 1 AND fence <= 9007199254740991),
      keys_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vivary_mutation_reservation_owner
      ON vivary_mutation_reservations(
        owner_actor_id, owner_collection_id, owner_device_id, owner_operation_id
      );
    CREATE TABLE IF NOT EXISTS vivary_mutation_reservation_keys (
      resource_key TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL REFERENCES vivary_mutation_reservations(reservation_id)
    );
    CREATE INDEX IF NOT EXISTS vivary_mutation_reservation_keys_parent
      ON vivary_mutation_reservation_keys(reservation_id);
    CREATE TABLE IF NOT EXISTS vivary_mutation_fence_high_water (
      resource_key TEXT PRIMARY KEY,
      fence INTEGER NOT NULL CHECK (fence >= 1 AND fence <= 9007199254740991)
    );
  `,
}, {
  version: 4,
  name: "vivary-local-folder-verification-v1",
  sql: `ALTER TABLE vivary_registry_bindings ADD COLUMN verification_kind TEXT NOT NULL DEFAULT 'held-custody-v1';`,
}, {
  version: 5,
  name: "vivary-linked-conversation-metadata-v1",
  sql: `CREATE TABLE IF NOT EXISTS vivary_conversation_links (
    link_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('code', 'native')),
    target_id TEXT NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS vivary_conversation_link_target
    ON vivary_conversation_links(target_kind, target_id);`,
}], { table: "vivary_workbench_registry_migrations" });
