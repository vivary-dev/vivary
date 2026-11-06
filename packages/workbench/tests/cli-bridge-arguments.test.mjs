import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

// Vivary #111: Core's CLI bridge turns a tool call's arguments into argv for a script that reads
// them with parseArgs. A chat's script must read the names and values the model sent, and plan
// mode must approve the arguments the script then reads. Core's package entries do not export
// these modules, so load the installed, patched files by path.
const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-cli-bridge-"));
const database = `file:${path.join(caseRoot, "app.sqlite")}`;
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
});

const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
const load = relative => import(pathToFileURL(path.join(coreRoot, "dist", relative)).href);
const [
  { createChatScriptEntries, createDbScriptEntries, createDocsScriptEntries, createResourceScriptEntries },
  { createPlanModeActionRegistry },
  { runWithRequestContext },
  { resourceGetByPath, SHARED_OWNER },
  { formatArgs, parseArgs },
  { createThread, updateThreadData },
] = await Promise.all([
  load("server/agent-chat/script-entries.js"),
  load("agent/production-agent.js"),
  load("server/request-context.js"),
  load("resources/store.js"),
  load("scripts/parse-args.js"),
  load("chat-threads/store.js"),
]);
const Database = createRequire(path.join(coreRoot, "package.json"))("better-sqlite3");

const owner = "owner@example.test";
const chat = { caller: "tool" };
const asOwner = fn => runWithRequestContext({ userEmail: owner }, fn);
const outcome = promise => promise.then(String, error => `Error: ${error.message}`);
// runToolCall appends the code to the model's text only for a thrown ActionContractError.
const unknownArgument = error => error.errorCode === "unknown_argument" && error.statusCode === 400;
const stored = async resourcePath => (await resourceGetByPath(owner, resourcePath))?.content ?? null;

after(async () => {
  await rm(caseRoot, { recursive: true, force: true });
});

const { resources } = await createResourceScriptEntries();
const db = await createDbScriptEntries("read");
const call = (entry, args) => outcome(asOwner(() => entry.run(args, chat)));
const write = args => call(resources, { action: "write", ...args });

test("a chat stores content that starts with Markdown front matter", async () => {
  const content = "---\ntitle: Notes\ntags: [a=b]\n---\nBody.\n";
  assert.match(await write({ path: "notes/front-matter.md", content }), /Wrote resource: notes\/front-matter\.md/);
  assert.equal(await stored("notes/front-matter.md"), content);
});

test("a chat value that reads like another flag stays a value", async () => {
  const content = "--path=notes/from-value.md";
  assert.match(await write({ path: "notes/flag-value.md", content }), /Wrote resource: notes\/flag-value\.md/);
  assert.equal(await stored("notes/flag-value.md"), content);
  assert.equal(await stored("notes/from-value.md"), null);
});

test("declared arguments still reach the script", async () => {
  // A notes/ path defaults to the personal scope, agent_scratch, and text/markdown.
  const result = await write({ path: "notes/declared.md", content: "kept", scope: "shared", visibility: "workspace", mime: "text/plain" });
  assert.match(result, /Wrote resource: notes\/declared\.md/);
  const row = await resourceGetByPath(SHARED_OWNER, "notes/declared.md");
  assert.deepEqual({ content: row?.content, visibility: row?.visibility, mimeType: row?.mimeType },
    { content: "kept", visibility: "workspace", mimeType: "text/plain" });
  assert.equal(await stored("notes/declared.md"), null, "the shared scope reached the script");
  assert.match(await write({ path: "notes/declared-scratch.md", content: "scratch" }), /Wrote resource/);
  const listed = includeAgentScratch =>
    call(resources, { action: "list", prefix: "notes/declared-scratch", includeAgentScratch, format: "json" });
  assert.match(await listed(true), /notes\/declared-scratch\.md/, "a boolean argument still lists agent scratch files");
  assert.doesNotMatch(await listed(false), /notes\/declared-scratch\.md/);
});

test("a chat cannot pass an argument name the bridge would split or the tool does not declare", async () => {
  for (const [name, value] of [
    ["path=notes/crafted.md", "y"],
    ["-path", "notes/crafted.md"],
    ["--path", "notes/crafted.md"],
    ["created-by", "user"],
    ["createdBy", "user"],
    ["threadId", "thread-from-model"],
  ]) {
    const result = await write({ path: "notes/named.md", content: "x", [name]: value });
    assert.ok(result.startsWith(`Error: Unknown argument ${JSON.stringify(name)}. `), `${name} is refused: ${result}`);
  }
  await assert.rejects(asOwner(() => resources.run({ action: "write", path: "notes/named.md", content: "x", createdBy: "user" }, chat)),
    unknownArgument);
  assert.equal(await stored("notes/named.md"), null, "no crafted call wrote its declared path");
  assert.equal(await stored("notes/crafted.md"), null, "no crafted call wrote the crafted path");
});

test("db-query reads only the app database", async () => {
  assert.ok(db["db-query"], "read mode registers db-query");
  const other = path.join(caseRoot, "other.sqlite");
  const seeded = new Database(other);
  seeded.exec(`CREATE TABLE secret (marker TEXT, owner_email TEXT); INSERT INTO secret VALUES ('other-file-row', '${owner}');`);
  seeded.close();
  const query = args => call(db["db-query"], args);
  const fromOther = await query({ sql: "SELECT marker FROM secret LIMIT 1", limit: `--db=${other}` });
  assert.doesNotMatch(fromOther, /other-file-row/);
  assert.match(fromOther, /no such table: secret/, "the query ran against the app database");
  const created = path.join(caseRoot, "created.sqlite");
  await query({ sql: "PRAGMA user_version", limit: `--db=${created}` });
  assert.equal(existsSync(created), false, "a value cannot open or create another SQLite file");
  assert.match(await query({ sql: "SELECT 1", db: other }), /^Error: .*\bdb\b/, "the db name stays refused");
});

test("plan mode approves the arguments the script reads", async () => {
  assert.match(await write({ path: "notes/plan-visible.md", content: "visible" }), /Wrote resource/);
  assert.match(await write({ path: "notes/plan-hidden.md", content: "hidden-from-plan" }), /Wrote resource/);
  const planned = createPlanModeActionRegistry({ resources, "db-query": db["db-query"] });
  const read = args => call(planned.resources, { action: "read", ...args });
  assert.equal(await read({ path: "notes/plan-visible.md" }), "visible");
  assert.match(await read({ path: "notes/plan-visible.md", "path=notes/plan-hidden.md": "x" }),
    /^Error: Unknown argument "path=notes\/plan-hidden\.md"\. /);
  assert.match(await read({ path: "--path=notes/plan-hidden.md" }), /^Resource not found: --path=notes\/plan-hidden\.md\. /);
  const created = path.join(caseRoot, "plan-created.sqlite");
  assert.match(await call(planned["db-query"], { sql: "PRAGMA user_version", limit: `--db=${created}` }),
    /^Query: PRAGMA user_version\nRows: 1\n\nuser_version\n/);
  assert.equal(existsSync(created), false, "a plan-mode read cannot create a file");
});

test("parseArgs reads back the names and values formatArgs writes", () => {
  const values = [
    ["---\nx: [a=b]\n---\n", "---\nx: [a=b]\n---\n"],
    ["--path=x", "--path=x"],
    ["a=b=c", "a=b=c"],
    ["=x", "=x"],
    ["", ""],
    ["-", "-"],
    ["--", "--"],
    ["\n--db=x", "\n--db=x"],
    ["é", "é"],
    [true, "true"],
    [false, "false"],
    [0, "0"],
    [{ a: "--x" }, '{"a":"--x"}'],
    [["--db=x"], '["--db=x"]'],
  ];
  for (const name of ["v", "a b", "x.y", "include-agent-scratch"]) {
    for (const [value, expected] of values) {
      assert.deepEqual(parseArgs(formatArgs({ [name]: value })), { [name]: expected }, `${name}: ${JSON.stringify(value)}`);
    }
  }
  const named = entries => Object.fromEntries(entries.map((entry, index) => [`v${index}`, entry]));
  assert.deepEqual(parseArgs(formatArgs(named(values.map(([value]) => value)))), named(values.map(([, expected]) => expected)));
  assert.deepEqual(formatArgs({ a: null, b: undefined }), []);
  for (const args of [{ "path=x": "y" }, { "-x": "y" }, { "--x": "y" }, JSON.parse('{"__proto__":"x"}')]) {
    assert.throws(() => formatArgs(args), /cannot be passed to a script/, Object.keys(args)[0]);
  }
});

test("every script tool a chat can call refuses a name it does not declare", async () => {
  const groups = {
    read: db,
    write: await createDbScriptEntries("write"),
    docs: await createDocsScriptEntries(),
    resources: await createResourceScriptEntries(),
    chat: await createChatScriptEntries(),
  };
  assert.deepEqual(Object.keys(groups.read).sort(), ["db-query", "db-schema"]);
  assert.deepEqual(Object.keys(groups.write).sort(), ["db-exec", "db-patch", "db-query", "db-schema"]);
  assert.ok(groups.docs["framework-search"] && groups.docs["docs-search"]);
  assert.deepEqual(Object.keys(groups.resources).sort(), ["delete-memory", "resources", "save-memory"]);
  assert.deepEqual(Object.keys(groups.chat), ["chat-history"]);
  for (const [group, entries] of Object.entries(groups)) {
    for (const [name, entry] of Object.entries(entries)) {
      assert.match(await call(entry, { "undeclared-probe": "x" }), /Unknown argument "undeclared-probe"/, `${group} ${name}`);
    }
  }
  await assert.rejects(asOwner(() => groups.read["db-query"].run({ sql: "SELECT 1", db: "x" }, chat)), unknownArgument);
  const other = path.join(caseRoot, "exec-other.sqlite");
  assert.match(await call(groups.write["db-exec"], { sql: "INSERT INTO notes (id) VALUES ('n1')", db: other }),
    /Unknown argument "db"/);
  assert.equal(existsSync(other), false);
});

test("chat-history search from a chat reaches the search script", async () => {
  const chatHistory = (await createChatScriptEntries())["chat-history"];
  const thread = await asOwner(() => createThread(owner, { title: "Bridge probe thread" }));
  const messages = JSON.stringify({ messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hello" }] }] });
  await asOwner(() => updateThreadData(thread.id, messages, "Bridge probe thread", "probe preview", 1));
  assert.match(await call(chatHistory, { action: "search", query: "Bridge probe" }), /Bridge probe thread/);
  assert.match(await call(chatHistory, { action: "search", "--query": "x" }), /Unknown argument "--query"/);
});

test("the chat bridge and the extensions SQL route build argv only with formatArgs", async () => {
  const source = relative => readFile(path.join(coreRoot, "dist", relative), "utf8");
  const entries = await source("server/agent-chat/script-entries.js");
  // assert.equal on booleans keeps a failure from printing the whole source file.
  assert.equal(entries.includes("push(`--${"), false, "script-entries.js builds no argv of its own");
  assert.equal(entries.includes("allowedArgs"), false, "the input schema is the only argument list");
  const routes = await source("extensions/routes.js");
  for (const handler of ["handleSqlQuery", "handleSqlExec"]) {
    const start = routes.indexOf(`async function ${handler}(event) {`);
    assert.notEqual(start, -1, handler);
    const end = routes.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `${handler} ends`);
    const body = routes.slice(start, end);
    assert.equal(body.split("formatArgs({").length - 1, 1, `${handler} calls formatArgs once`);
    assert.equal(body.includes(".push("), false, `${handler} pushes nothing onto argv`);
    assert.equal(/["'`]--/.test(body), false, `${handler} writes no -- token of its own`);
  }
});
