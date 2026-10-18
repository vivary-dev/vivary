// Existing postgres-driver adapter seam, with no sockets or live database.
// Run only in the isolated policy child so dialect caches cannot affect SQLite.
import assert from "node:assert/strict";
export const databaseUrl = "postgres://invalid.example/approval_policy";
export const enabledBindings = [];
export const retentionQueries = [];
let retentionAdapter = false;
export const enableRetentionAdapter = () => { retentionAdapter = true; };
let policy = null;
export default function postgres(url) {
  assert.equal(url, databaseUrl);
  const sql = async () => [];
  sql.unsafe = async (text, args = []) => {
    const compact = text.trim().replace(/\s+/g, " ");
    if (/^(CREATE|ALTER|SET)\b/i.test(compact)) return [];
    if (/information_schema|pg_indexes|pg_class|pg_namespace/.test(compact)) return [];
    if (retentionAdapter) {
      if (compact.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
      if (compact.startsWith("DELETE FROM agent_runs")) retentionQueries.push(compact);
      return Object.assign([], { count: 0 });
    }
    if (compact.startsWith("INSERT INTO agent_tool_approval_policies")) {
      assert.equal(typeof args[4], "boolean", "the real PostgreSQL store binds BOOLEAN as a JavaScript boolean");
      enabledBindings.push(args[4]);
      policy = { owner: args[1], org: args[2], tool: args[3], enabled: args[4] };
      return Object.assign([], { count: 1 });
    }
    if (compact.startsWith("SELECT 1 FROM agent_tool_approval_policies")) {
      return policy?.enabled && args[0] === policy.owner && args[1] === policy.org && args[3] === policy.tool ? [{ allowed: 1 }] : [];
    }
    throw new Error(`The policy adapter refuses unexpected SQL: ${compact}`);
  };
  sql.begin = async callback => callback(sql);
  sql.end = async () => {};
  return sql;
}
