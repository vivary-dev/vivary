import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(os.tmpdir(), "vivary-sql-inspection-"));
const database = `file:${path.join(root, "app.sqlite")}`;
Object.assign(process.env, { APP_NAME: "Vivary", NODE_ENV: "production",
  DATABASE_URL: database, DATABASE_URL_UNPOOLED: database });
const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = name => import(pathToFileURL(path.join(coreRoot, "dist", name)).href);
const [{ createDbScriptEntries }, { runWithRequestContext }, { getDbExec, closeDbExec }, routes] =
  await Promise.all([load("server/agent-chat/script-entries.js"), load("server/request-context.js"),
    load("db/client.js"), load("extensions/routes.js")]);
const require = createRequire(path.join(coreRoot, "package.json"));
const { H3 } = await import(pathToFileURL(require.resolve("h3")).href);
const owner = "owner@example.test";
const db = getDbExec();
await db.execute("CREATE TABLE inspection_notes (id TEXT PRIMARY KEY, body TEXT, owner_email TEXT, is_admin INTEGER)");
for (const [id, body, email] of [["own", "own seeded row", owner],
  ["other", "other seeded row", "other@example.test"]]) {
  await db.execute({ sql: "INSERT INTO inspection_notes VALUES (?, ?, ?, 0)", args: [id, body, email] });
}
const read = await createDbScriptEntries("read");
const write = await createDbScriptEntries("write");
const call = (name, args) => runWithRequestContext({ userEmail: owner },
  () => (read[name] ?? write[name]).run(args, { caller: "tool" }))
  .then(String, error => `Error: ${error.message}`);
const query = (sql, extra = {}) => call("db-query", { sql, format: "json", ...extra });
async function control() {
  const result = JSON.parse(await query("SELECT id, body FROM inspection_notes"));
  assert.deepEqual(result.rows, [{ id: "own", body: "own seeded row" }]);
  const stored = await db.execute("SELECT id, body, is_admin FROM inspection_notes ORDER BY id");
  assert.deepEqual(stored.rows.map(row => ({ id: row.id, body: row.body, is_admin: row.is_admin })), [
    { id: "other", body: "other seeded row", is_admin: 0 },
    { id: "own", body: "own seeded row", is_admin: 0 },
  ]);
}
const sensitive = (name, verb) => `Error: Sensitive framework table "${name}" is not ${verb} through raw DB tools. Use the framework auth, secrets, OAuth, or resources APIs instead.`;
const access = name => `Error: Sensitive identity/access-control column "${name}" is not writable through raw DB tools. Use a dedicated app action or implement the permission change in reviewed code.`;
const schema = verb => `Error: Schema-qualified table references (e.g. "public.<table>" or "main.<table>") cannot be ${verb} through raw DB tools — a qualified name bypasses the per-user data scoping that isolates each tenant's rows. Use the bare table name; the current user's scoping is applied automatically.`;
const quote = (value, style) => style === "[" ? `[${value}]` : style + value.replaceAll(style, style + style) + style;
after(async () => { await closeDbExec(); await rm(root, { recursive: true, force: true }); });

test("db-query scopes the seeded table to the caller", control);
for (const style of ['"', "`", "["]) {
  test(`db-query inspects identifiers with comment markers (${style})`, async () => {
    await control();
    for (const value of ["note-- marker", "note/* marker", "note' marker"]) {
      const alias = quote(value, style);
      assert.equal(await query(`SELECT 1 AS ${alias} FROM resources`), sensitive("resources", "readable"));
    }
  });
  test(`db-query inspects schema references after quoted comment markers (${style})`, async () => {
    await control();
    for (const value of ["note-- marker", "note/* marker", "note' marker"]) {
      const alias = quote(value, style);
      assert.equal(await query(`SELECT 1 AS ${alias} FROM main.inspection_notes`), schema("queried"));
    }
  });
  test(`quoted schema names remain refused (${style})`, async () => {
    await control();
    assert.equal(await query(`SELECT id FROM ${quote("main", style)}.inspection_notes`), schema("queried"));
  });
}
test("comments separate tokens and protected names inside strings are data", async () => {
  await control();
  const result = JSON.parse(await query("/* header */ SELECT/**/id, 'resources main.inspection_notes -- /*' AS literal FROM/**/inspection_notes"));
  assert.equal(result.rows[0].id, "own");
  assert.equal(result.rows[0].literal, "resources main.inspection_notes -- /*");
});
test("LIMIT in strings and quoted aliases does not suppress the requested row limit", async () => {
  await control();
  for (const expression of ["'LIMIT' AS label", '"id" AS "LIMIT"', "'/* LIMIT */' AS label"]) {
    const result = JSON.parse(await query(`SELECT ${expression} FROM inspection_notes UNION ALL SELECT ${expression} FROM inspection_notes`, { limit: "1" }));
    assert.equal(result.count, 1);
  }
});
test("LIMIT is inserted before a statement terminator and trailing comment", async () => {
  await control();
  for (const tail of [";", "; -- tail", " -- tail"]) {
    const result = JSON.parse(await query(`SELECT id FROM inspection_notes${tail}`, { limit: "1" }));
    assert.deepEqual(result.rows, [{ id: "own" }]);
  }
});
test("an existing LIMIT remains effective", async () => {
  await control();
  assert.equal(JSON.parse(await query("SELECT id FROM inspection_notes LIMIT 1", { limit: "2" })).count, 1);
});
test("db-exec preserves literal comment markers and statement punctuation", async () => {
  const literal = "/*keep*/ -- WHERE RETURNING LIMIT ; 'quoted'";
  const result = await call("db-exec", { sql: "UPDATE inspection_notes SET body = ? WHERE id = 'own'", args: JSON.stringify([literal]) });
  assert.doesNotMatch(result, /^Error:/);
  try {
    const changed = await call("db-exec", { sql: "UPDATE inspection_notes SET body = '/*keep*/ -- WHERE RETURNING LIMIT ; ''quoted''' WHERE id = 'own'" });
    assert.doesNotMatch(changed, /^Error:/);
    assert.equal(JSON.parse(await query("SELECT body FROM inspection_notes")).rows[0].body, literal);
  } finally {
    await db.execute({ sql: "UPDATE inspection_notes SET body = ? WHERE id = 'own'", args: ["own seeded row"] });
  }
});
test("db-exec accepts a trailing comment after its terminator", async () => {
  await control();
  assert.doesNotMatch(await call("db-exec", { sql: "UPDATE inspection_notes SET body = body WHERE id = 'own'; -- tail" }), /^Error:/);
});
test("db-exec refuses a second statement before changing any row", async () => {
  await control();
  assert.equal(await call("db-exec", { sql: "UPDATE inspection_notes SET body = 'changed' WHERE id = 'own'; SELECT 1" }),
    "Error: Statement 1 contains multiple SQL statements. Use --statements for batches so each write can be validated and run transactionally.");
  await control();
});
for (const assignment of ["[is_admin] = 1", "(body, is_admin) = ('own seeded row', 1)",
  "body = 'WHERE', is_admin = 1", "body = 'RETURNING', is_admin = 1"]) {
  test(`db-exec checks every assignment: ${assignment}`, async () => {
    await control();
    try {
      assert.equal(await call("db-exec", { sql: `UPDATE inspection_notes SET ${assignment} WHERE id = 'own'` }), assignment.startsWith("(")
        ? "Error: Unsupported raw SQL write: UPDATE requires individual column assignments. Use a dedicated app action or reviewed code."
        : access("is_admin"));
    } finally {
      await db.execute("UPDATE inspection_notes SET body = 'own seeded row', is_admin = 0 WHERE id = 'own'");
    }
  });
}
test("db-exec checks bracket-quoted INSERT columns", async () => {
  await control();
  assert.equal(await call("db-exec", { sql: "INSERT INTO [inspection_notes] ([id], [body], [is_admin]) VALUES ('inserted', 'text', 1)" }), access("is_admin"));
});
test("db-patch refuses schema-qualified subqueries in its predicate", async () => {
  await control();
  try {
    assert.equal(await call("db-patch", { table: "inspection_notes", column: "body",
      where: "id = 'own' AND EXISTS (SELECT 1 FROM main.inspection_notes WHERE id = 'other')",
      find: "seeded", replace: "changed" }), schema("written"));
  } finally {
    await db.execute("UPDATE inspection_notes SET body = 'own seeded row' WHERE id = 'own'");
  }
});
test("db-patch treats punctuation and SQL words in string values as data", async () => {
  await control();
  assert.doesNotMatch(await call("db-patch", { table: "inspection_notes", column: "body",
    where: "id = 'own' AND '; -- /* WHERE RETURNING LIMIT' = '; -- /* WHERE RETURNING LIMIT'",
    find: "seeded", replace: "seeded" }), /^Error:/);
});
test("extension gates inspect identifiers while ignoring literals and ordinary comments", async () => {
  await control();
  for (const style of ['"', "`", "["]) {
    const alias = quote("note--/*' marker", style);
    assert.equal(routes.matchesSqlGate(routes.SENSITIVE_SQL_RE, `SELECT 1 AS ${alias} FROM settings`), true);
  }
  assert.equal(routes.matchesSqlGate(routes.SENSITIVE_SQL_RE, "SELECT 'settings -- resources /*' FROM inspection_notes"), false);
  assert.equal(routes.matchesSqlGate(routes.DESTRUCTIVE_SQL_RE, "UPDATE inspection_notes SET body = 'DROP TABLE example'"), false);
  assert.equal(routes.matchesSqlGate(routes.DESTRUCTIVE_SQL_RE, "DROP/**/TABLE example"), true);
  assert.equal(routes.matchesSqlGate(routes.POSITIONAL_INSERT_RE, "INSERT INTO [inspection_notes] VALUES ('x')"), true);
});
const handler = routes.createExtensionsHandler();
const app = new H3().all("/**", event => {
  // Match the session cache used by the authenticated application boundary.
  event.context.__anSessionCache = Promise.resolve({ email: owner });
  return handler(event);
});
async function route(kind, sql) {
  const response = await app.request(`http://example.test/sql/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }),
  });
  return { status: response.status, body: await response.json() };
}
test("extension query route reads the caller's seeded row", async () => {
  await control();
  const result = await route("query", "SELECT id, body FROM inspection_notes");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, [{ id: "own", body: "own seeded row" }]);
});
for (const kind of ["query", "exec"]) {
  test(`extension ${kind} route retains its larger protected-table set`, async () => {
    await control();
    const sql = kind === "query" ? 'SELECT 1 AS "note-- marker" FROM settings' :
      'UPDATE inspection_notes SET body = (SELECT key AS "note-- marker" FROM settings LIMIT 1)';
    try {
      const result = await route(kind, sql);
      assert.deepEqual(result, { status: 403, body: {
        error: `Sensitive framework tables are not ${kind === "query" ? "readable" : "writable"} from extensions`,
      } });
      await control();
    } finally {
      await db.execute("UPDATE inspection_notes SET body = 'own seeded row' WHERE id = 'own'");
    }
  });
}
test("extension routes keep harmless SQL-looking text intact", async () => {
  await control();
  const result = await route("query", "SELECT 'settings -- DROP TABLE /*' AS body FROM inspection_notes");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, [{ body: "settings -- DROP TABLE /*" }]);
  const written = await route("exec", "UPDATE inspection_notes SET body = 'own seeded row' WHERE id = 'own' AND 'DROP TABLE settings' = 'DROP TABLE settings'");
  assert.equal(written.status, 200);
  assert.equal(written.body.changes, 1);
  await control();
});

for (const body of ["WHERE", "RETURNING", "owner_email", "/*keep*/"]) {
  test(`db-exec scopes writes containing the literal ${body}`, async () => {
    await control();
    try {
      const result = await call("db-exec", { sql: `UPDATE inspection_notes SET body = '${body}'` });
      assert.doesNotMatch(result, /^Error:/);
      const stored = await db.execute("SELECT id, body FROM inspection_notes ORDER BY id");
      assert.deepEqual(stored.rows.map(row => ({ id: row.id, body: row.body })), [
        { id: "other", body: "other seeded row" }, { id: "own", body },
      ]);
    } finally {
      await db.execute("UPDATE inspection_notes SET body = CASE id WHEN 'own' THEN 'own seeded row' ELSE 'other seeded row' END");
    }
  });
}
test("db-exec injects ownership when a value names the ownership column", async () => {
  await control();
  try {
    assert.doesNotMatch(await call("db-exec", { sql: "INSERT INTO inspection_notes (id, body) VALUES ('injected', 'owner_email')" }), /^Error:/);
    const result = await db.execute("SELECT owner_email FROM inspection_notes WHERE id = 'injected'");
    assert.equal(result.rows[0]?.owner_email, owner);
  } finally {
    await db.execute("DELETE FROM inspection_notes WHERE id = 'injected'");
  }
});
test("a nested LIMIT does not suppress the outer requested limit", async () => {
  await control();
  const result = JSON.parse(await query("SELECT id FROM (SELECT id FROM inspection_notes LIMIT 2) UNION ALL SELECT id FROM inspection_notes", { limit: "1" }));
  assert.equal(result.count, 1);
});

test("db-query requires a complete read statement keyword", async () => {
  await control();
  assert.equal(await query("SELECTED id FROM inspection_notes"),
    "Error: Only SELECT, WITH, EXPLAIN, and PRAGMA queries are allowed. Use db-exec for writes.");
});

test("db-query inspects protected references after literal comment markers", async () => {
  await control();
  assert.equal(await query("SELECT '/*', content FROM resources --*/'"), sensitive("resources", "readable"));
});
test("db-query inspects schema references after literal comment markers", async () => {
  await control();
  assert.equal(await query("SELECT '/*', id FROM main.inspection_notes --*/'"), schema("queried"));
});
test("SQLite legacy quoted table names remain visible to safety checks", async () => {
  await control();
  assert.equal(await query("SELECT 1 FROM 'resources'"), sensitive("resources", "readable"));
  assert.equal(await query("SELECT id FROM 'main'.'inspection_notes'"), schema("queried"));
});
test("db-query refuses writes introduced by WITH or PRAGMA", async () => {
  await control();
  assert.deepEqual(JSON.parse(await query("WITH rows AS (SELECT id FROM inspection_notes) SELECT id FROM rows")).rows, [{ id: "own" }]);
  assert.equal(JSON.parse(await query("PRAGMA user_version")).rows[0].user_version, 0);
  for (const sql of ["WITH rows AS (SELECT 1) UPDATE inspection_notes SET body = 'changed'", "PRAGMA user_version = 2"]) {
    try {
      assert.equal(await query(sql), "Error: Only read-only statements are allowed through db-query.");
    } finally {
      await db.execute("UPDATE inspection_notes SET body = CASE id WHEN 'own' THEN 'own seeded row' ELSE 'other seeded row' END");
      await db.execute("PRAGMA user_version = 0");
    }
    await control();
  }
});

for (const [label, sql] of [
  ["modifying CTE", "WITH changed AS (UPDATE inspection_notes SET body = 'changed' RETURNING id) SELECT id FROM changed"],
  ["EXPLAIN ANALYZE write", "EXPLAIN ANALYZE UPDATE inspection_notes SET body = 'changed'"],
  ["SELECT INTO", "SELECT id INTO inspection_copy FROM inspection_notes"],
]) {
  test(`db-query refuses ${label} before execution`, async () => {
    await control();
    assert.deepEqual(JSON.parse(await query("WITH rows AS (SELECT id FROM inspection_notes) SELECT id FROM rows")).rows, [{ id: "own" }]);
    assert.ok(JSON.parse(await query("EXPLAIN SELECT id FROM inspection_notes")).count > 0);
    try {
      assert.equal(await query(sql), "Error: Only read-only statements are allowed through db-query.");
      await control();
    } finally {
      await db.execute("UPDATE inspection_notes SET body = CASE id WHEN 'own' THEN 'own seeded row' ELSE 'other seeded row' END");
    }
  });
}
for (const prefix of ["REPLACE", "INSERT OR REPLACE"]) {
  test(`db-exec refuses ${prefix} conflicts`, async () => {
    await control();
    try {
      assert.equal(await call("db-exec", { sql: `${prefix} INTO inspection_notes (id, body) VALUES ('other', 'changed')` }),
        "Error: REPLACE conflict handling is not supported through raw DB tools.");
      await control();
    } finally {
      await db.execute({ sql: "INSERT OR REPLACE INTO inspection_notes VALUES ('other', 'other seeded row', ?, 0)", args: ["other@example.test"] });
    }
  });
}
await db.execute("CREATE TABLE inspection_org_notes (id TEXT PRIMARY KEY, body TEXT, org_id TEXT)");
for (const [id, body, org] of [["org-own", "own org row", "org-test"], ["org-other", "other org row", "org-other"]]) {
  await db.execute({ sql: "INSERT INTO inspection_org_notes VALUES (?, ?, ?)", args: [id, body, org] });
}
const orgCall = (name, args) => runWithRequestContext({ userEmail: owner, orgId: "org-test" },
  () => (read[name] ?? write[name]).run(args, { caller: "tool" }))
  .then(String, error => `Error: ${error.message}`);
async function orgControl() {
  await control();
  const result = JSON.parse(await orgCall("db-query", { sql: "SELECT id, body FROM inspection_org_notes", format: "json" }));
  assert.deepEqual(result.rows, [{ id: "org-own", body: "own org row" }]);
}
for (const [label, sql] of [
  ["INSERT", "INSERT INTO inspection_org_notes (id, body, org_id) VALUES ('org-inserted', 'changed', 'org-other')"],
  ["UPDATE", "UPDATE inspection_org_notes SET org_id = 'org-other' WHERE id = 'org-own'"],
]) {
  test(`db-exec refuses caller-specified org_id in ${label}`, async () => {
    await orgControl();
    try {
      assert.equal(await orgCall("db-exec", { sql }), access("org_id"));
      await orgControl();
      const result = await db.execute("SELECT id, org_id FROM inspection_org_notes ORDER BY id");
      assert.deepEqual(result.rows.map(row => ({ id: row.id, org_id: row.org_id })), [
        { id: "org-other", org_id: "org-other" }, { id: "org-own", org_id: "org-test" },
      ]);
    } finally {
      await db.execute("DELETE FROM inspection_org_notes WHERE id = 'org-inserted'");
      await db.execute("UPDATE inspection_org_notes SET org_id = 'org-test' WHERE id = 'org-own'");
    }
  });
}
test("db-query preserves string values in a nested SELECT", async () => {
  await control();
  const result = JSON.parse(await query("SELECT label FROM (SELECT id, 'resources' AS label FROM inspection_notes)"));
  assert.deepEqual(result.rows, [{ label: "resources" }]);
});
test("db-query preserves JSON table-function path arguments", async () => {
  await control();
  const result = JSON.parse(await query(`SELECT value FROM json_each('{"resources":["kept"]}', '$.resources')`));
  assert.deepEqual(result.rows, [{ value: "kept" }]);
});
test("db-query refuses CR-only line comments and accepts CRLF", async () => {
  await control();
  assert.deepEqual(JSON.parse(await query("-- heading\r\nSELECT id FROM inspection_notes")).rows, [{ id: "own" }]);
  assert.equal(await query("SELECT id FROM inspection_notes -- tail\r"),
    "Error: CR-only SQL line comments are not supported by raw DB tools.");
});
for (const [label, sql, error] of [
  ["Unicode dollar quoting", "SELECT $é$resources$é$",
    "Dollar-quoted SQL is not supported by raw DB tools. Use bind parameters."],
  ["prefixed string quoting", "SELECT E'resources'",
    "Prefixed SQL quoting is not supported by raw DB tools. Use bind parameters."],
  ["nested block comments", "SELECT /* outer /* inner */ 1",
    "Nested SQL comments are not supported by raw DB tools."],
]) {
  test(`db-query refuses unsupported ${label}`, async () => {
    await control();
    assert.deepEqual(JSON.parse(await query("SELECT 'resources' AS literal FROM inspection_notes")).rows, [{ literal: "resources" }]);
    assert.equal(await query(sql), `Error: ${error}`);
  });
}

for (const grouped of [false, true]) {
  test(`db-query refuses qualified tables in ${grouped ? "grouped" : "comma-separated"} FROM lists`, async () => {
    await control();
    const positive = JSON.parse(await query("SELECT n.id, length(n.body) AS size FROM inspection_notes AS n"));
    assert.deepEqual(positive.rows, [{ id: "own", size: 14 }]);
    for (const style of [null, '"', "`", "[", "'"]) {
      const identifier = value => style === null ? value : quote(value, style);
      const tables = `inspection_notes AS n, ${identifier("tenant")}.${identifier("inspection_notes")} AS t`;
      const sql = `SELECT n.id FROM ${grouped ? `(${tables})` : tables}`;
      assert.equal(await query(sql), schema("queried"));
    }
  });
}
