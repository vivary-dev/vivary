import { runMigrations } from "@agent-native/core/db";
import { REGISTRY_MIGRATIONS, REGISTRY_MIGRATIONS_TABLE } from "./registry-migrations.mjs";

export const migrateRegistry = runMigrations(REGISTRY_MIGRATIONS, { table: REGISTRY_MIGRATIONS_TABLE });
