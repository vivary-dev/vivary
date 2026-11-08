// A profile written by the 2026-09-22 preview (source 98846706) must open in this
// release with its projects intact. The preview kept them in the same data folder,
// database file and sign-in secret, with registry migrations 1 to 4.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PROFILE_AUTH_SECRET, PROFILE_DATABASE, authSecret, startupOptions } from "../bin/start.mjs";
import { REGISTRY_MIGRATIONS, REGISTRY_MIGRATIONS_TABLE } from "../server/db/registry-migrations.mjs";

// SHA-256 of each migration's SQL in the preview's server/db/migrations.mjs.
const PREVIEW_MIGRATIONS = [
  [1, "vivary-registry-registration-v1", "3b2659999b6f7be3fe7e43b0057502a5c6837092a1a2a45d667ad9cf5be0d603"],
  [2, "vivary-creation-receipts-v1", "70ebd193f048f571898b63feb0c9cd836bd0e1076b5e2233144a2ec3175a25cd"],
  [3, "vivary-mutation-admission-v1", "b98a3cb4a354624fb32dae94b17a9ac288fe1a557deff5a0f761ffa1df2594b9"],
  [4, "vivary-local-folder-verification-v1", "16c2c921f98f9d3d6d7388f87a3f3f66e53bb16b0837e0d58a3ae822ad411488"],
];
const sha256 = text => createHash("sha256").update(text).digest("hex");

// The preview recorded its migrations here. A renamed table would make every preview profile look fresh, and
// migration 2's ALTER TABLE would then fail on the existing column.
const PREVIEW_MIGRATIONS_TABLE = "vivary_workbench_registry_migrations";

// Project tables only. Core's runner keeps its history in the table and in "<table>_named".
function rows(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vivary_%' AND name NOT IN (?, ?) ORDER BY name")
    .all(PREVIEW_MIGRATIONS_TABLE, `${PREVIEW_MIGRATIONS_TABLE}_named`);
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test("released registry migrations are unchanged since the preview", () => {
  assert.equal(REGISTRY_MIGRATIONS_TABLE, PREVIEW_MIGRATIONS_TABLE, "a preview profile keeps its migration history here");
  assert.deepEqual(REGISTRY_MIGRATIONS.slice(0, PREVIEW_MIGRATIONS.length).map(({ version, name, sql }) => [version, name, sha256(sql)]),
    PREVIEW_MIGRATIONS, "a profile keeps the migrations it already ran, so a released one must not change");
  assert.deepEqual(REGISTRY_MIGRATIONS.map(({ version }) => version), REGISTRY_MIGRATIONS.map((_, index) => index + 1),
    "versions run in order with no gap");
});

// #291 review: the upgrade runs through the startup runner in server/db/migrations.mjs, not a model of it.
// The preview ran Core 0.176.5's runMigrations too, so the seed below writes the history a preview profile holds.
test("the startup migration runner opens a preview profile and keeps its projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vivary-preview-upgrade-"));
  const file = path.join(root, PROFILE_DATABASE);
  process.env.DATABASE_URL = `file:${file}`; // guard:allow-env-mutation - This test's own SQLite file, set before Core loads.
  const { closeDbExec, runMigrations, withMigrationRuntime } = await import("@agent-native/core/db");
  try {
    await withMigrationRuntime(() => runMigrations(REGISTRY_MIGRATIONS.slice(0, PREVIEW_MIGRATIONS.length),
      { table: PREVIEW_MIGRATIONS_TABLE })());
    await closeDbExec();
    let db = new DatabaseSync(file);
    db.exec(`
      INSERT INTO vivary_registry_projects VALUES ('project-a', 1, 'Project A', 'sha256', 'digest-a');
      INSERT INTO vivary_registry_bindings (binding_id, project_id, collection_id, actor_id, device_id, root_id,
        location_ref, binding_revision, policy_revision, vcs_kind, repository_id, checkout_id)
        VALUES ('binding-a', 'project-a', 'collection-a', 'actor-a', 'device-a', 'root-a',
        'C:\\Users\\owner\\Projects\\a', 1, 1, 'git', 'repository-a', 'checkout-a');
      INSERT INTO vivary_registry_revisions VALUES ('scope-a', 'collection-a', 'device-a', 3);
      INSERT INTO vivary_registry_receipts (receipt_key, actor_id, collection_id, device_id, operation, operation_id, record)
        VALUES ('receipt-a', 'actor-a', 'collection-a', 'device-a', 'register', 'operation-a', '{"ok":true}');
    `);
    const before = rows(db);
    assert.equal(before.vivary_registry_bindings[0].verification_kind, "held-custody-v1");
    db.close();

    const { migrateRegistry } = await import("../server/db/migrations.mjs");
    await withMigrationRuntime(() => migrateRegistry());
    await closeDbExec();
    db = new DatabaseSync(file);
    try {
      const after = rows(db);
      for (const [table, contents] of Object.entries(before)) {
        assert.deepEqual(after[table], contents, `${table} keeps every preview row`);
      }
      assert.deepEqual(Object.keys(after).filter(name => !(name in before)).sort(),
        ["vivary_conversation_links", "vivary_handoff_records"]);
      assert.deepEqual(db.prepare(`SELECT name FROM "${PREVIEW_MIGRATIONS_TABLE}_named" ORDER BY version`).all().map(row => row.name),
        REGISTRY_MIGRATIONS.map(({ name }) => name), "the preview's history gains only the later migrations");
    } finally {
      db.close();
    }
  } finally {
    await closeDbExec();
    await rm(root, { recursive: true, force: true });
  }
});

test("the profile keeps the preview's folder, database file and sign-in secret", async () => {
  const options = startupOptions([], {});
  assert.equal(options.dataDir, path.join(os.homedir(), ".vivary", "workbench"));
  assert.equal(options.workspace, path.join(options.dataDir, "workspace"));
  assert.equal(PROFILE_DATABASE, "auth.sqlite");
  assert.equal(PROFILE_AUTH_SECRET, "auth-secret");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-preview-profile-"));
  try {
    const previewSecret = `${"b".repeat(64)}\n`;
    await writeFile(path.join(dataDir, PROFILE_AUTH_SECRET), previewSecret);
    assert.equal(await authSecret(dataDir), previewSecret.trim());
    assert.equal(await readFile(path.join(dataDir, PROFILE_AUTH_SECRET), "utf8"), previewSecret,
      "an existing secret is kept, so sign-ins saved by the preview stay valid");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
