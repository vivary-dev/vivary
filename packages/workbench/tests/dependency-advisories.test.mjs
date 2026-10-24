import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Lowest fixed release for each advisory tracked in issue #23. The floor applies to
// every locked version of the package, so an older major line also fails here and
// needs its own review before it can enter a lockfile.
const advisoryFloors = [
  // Later release lines also contained these bugs; a numeric floor alone would admit them.
  { name: "vite", branch: "8.2.", fixed: "8.2.4", advisories: ["GHSA-rq7h-c2jc-7f22"] },
  { name: "vite", branch: "8.3.", fixed: "8.3.3", advisories: ["GHSA-rq7h-c2jc-7f22"] },
  { name: "markdown-it", branch: "15.", fixed: "15.0.3", advisories: ["GHSA-gfr2-rv44-r23c"] },
  { name: "@vitest/mocker", branch: "5.", fixed: "5.0.3", advisories: ["GHSA-xp26-3454-mjgp"] },
  // The 4.x floor leaves the reviewed zod 3.25.76 copy out of scope. Its only dependents,
  // botframework-connector and botframework-schema, import the zod root, which loads only v3.
  // The site's pre-install admission floors its own undici and zod copies.
  { name: "zod", branch: "4.", fixed: "4.6.6", advisories: ["GHSA-mrhx-c7xc-m3w5"] },
  // undici 2026-10-23 advisories. Each line has its own patched release.
  { name: "undici", branch: "6.", fixed: "6.29.1", advisories: ["GHSA-xjj6-f33q-929c", "GHSA-4qv8-2p9j-2685"] },
  { name: "undici", branch: "7.", fixed: "7.30.1", advisories: ["GHSA-xjj6-f33q-929c", "GHSA-4qv8-2p9j-2685", "GHSA-f72v-6w45-q472"] },
  { name: "undici", branch: "8.", fixed: "8.12.2", advisories: ["GHSA-xjj6-f33q-929c", "GHSA-4qv8-2p9j-2685", "GHSA-f72v-6w45-q472"] },
  { name: "@modelcontextprotocol/sdk", fixed: "1.32.0", advisories: ["GHSA-22jm-h49p-29qw", "GHSA-6prh-2h8m-c8cw", "GHSA-46jr-4wx8-v453", "GHSA-rvq5-wwqv-78pq"] },
  { name: "@modelcontextprotocol/client", fixed: "2.3.0", advisories: ["GHSA-6prh-2h8m-c8cw"] },
  { name: "@modelcontextprotocol/server", fixed: "2.3.0", advisories: ["GHSA-jm63-cq47-j5jp", "GHSA-46jr-4wx8-v453", "GHSA-rvq5-wwqv-78pq"] },
  { name: "@anthropic-ai/sdk", fixed: "0.91.1", advisories: ["GHSA-p7fg-763f-g4gf"] },
  { name: "uuid", fixed: "11.1.1", advisories: ["GHSA-w5hq-g745-h8pq"] },
  { name: "postcss-selector-parser", fixed: "7.1.6", advisories: ["GHSA-rj75-hqrm-r3gf"] },
  { name: "hono", fixed: "4.13.11", advisories: ["GHSA-5r4p-p66f-jhc7"] },
  { name: "markdown-it", fixed: "14.3.3", advisories: ["GHSA-r7fv-28h4-cvq7", "GHSA-vfgh-jcmw-g37q", "GHSA-gfr2-rv44-r23c"] },
  { name: "follow-redirects", fixed: "1.16.1", advisories: ["GHSA-q3jh-wrc6-jgq8", "GHSA-8r9p-f939-6h3c"] },
  { name: "vite", fixed: "8.1.6", advisories: ["GHSA-698v-4r3x-3vcv", "GHSA-r825-w8mm-5pxw", "GHSA-587h-7wmj-h5pm", "GHSA-9jrq-w75r-8gcw", "GHSA-rq7h-c2jc-7f22"] },
  { name: "@vitest/mocker", fixed: "4.1.12", advisories: ["GHSA-qxg6-89mg-rqv8", "GHSA-xp26-3454-mjgp"] },
  { name: "@modelcontextprotocol/sdk", fixed: "1.31.0", advisories: ["GHSA-6qxp-vccf-f47h"] },
  { name: "@modelcontextprotocol/client", fixed: "2.2.0", advisories: ["GHSA-6qxp-vccf-f47h"] },
  { name: "proxy-addr", fixed: "2.0.8", advisories: ["GHSA-jqcg-44mw-7w3h"] },
  { name: "brace-expansion", fixed: "5.0.12", advisories: ["GHSA-qhr7-859c-m2p7", "GHSA-6j4f-fj2g-mc7p", "GHSA-q2hr-2g5m-vwhr"] },
  { name: "fast-uri", fixed: "3.1.8", advisories: ["GHSA-hrr3-gc8f-f4qj"] },
  { name: "ip-address", fixed: "10.7.4", advisories: ["GHSA-rxp7-6hxx-x8q5"] },
  { name: "pdfjs-dist", fixed: "6.2.108", advisories: ["GHSA-hq66-cqwq-w95j"] },
  { name: "xlsx", fixed: "0.19.3", advisories: ["GHSA-4r6h-8v6p-xvw6"] },
  { name: "xlsx", fixed: "0.20.2", advisories: ["GHSA-5pgg-2g8v-p4x9"] },
  { name: "@tiptap/core", fixed: "3.30.4", advisories: ["GHSA-cp6q-959q-f8rh"] },
  { name: "@tiptap/core", fixed: "3.30.5", advisories: ["GHSA-j95f-988m-3j2f"] },
];

// SheetJS publishes fixed xlsx releases only on its CDN. This is the reviewed 0.20.3 archive.
const sheetjsArchive = {
  tarball: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
  integrity: "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==",
};

const workbenchLock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const workbenchPackages = workbenchLock.slice(workbenchLock.indexOf("\npackages:\n"), workbenchLock.indexOf("\nsnapshots:\n") + 1);
const desktopPackages = JSON.parse(readFileSync(new URL("../../desktop/package-lock.json", import.meta.url), "utf8")).packages;

// pnpm may render resolution as a block or a flow mapping. Keep the exact URL/integrity
// checks below when its serializer changes; these scalar values contain no commas.
function lockFields(body) {
  return body.split("\n").flatMap(line => {
    const field = line.trim();
    const resolution = /^resolution: \{(.*)\}$/.exec(field);
    return resolution ? resolution[1].split(",").map(value => value.trim()) : [field];
  });
}

// Each entry's key is name@version, or name@url for a tarball, which records its version inside.
const workbenchEntries = [...workbenchPackages.matchAll(/^  '?([^' ].*?)'?:\n((?: {4}.*\n)*)/gm)].map(([, key, body]) => {
  const at = key.lastIndexOf("@");
  const fields = lockFields(body);
  const recorded = fields.find((field) => field.startsWith("version: "));
  return { name: key.slice(0, at), version: recorded ? recorded.slice("version: ".length) : key.slice(at + 1), source: key.slice(at + 1), fields };
});

test("exact archive checks read both pnpm resolution formats without accepting a changed value", () => {
  for (const body of ["    resolution:\n      integrity: sha512-reviewed\n      tarball: https://example.test/package.tgz\n",
    "    resolution: {integrity: sha512-reviewed, tarball: https://example.test/package.tgz}\n"]) {
    const fields = lockFields(body);
    assert.ok(fields.includes("integrity: sha512-reviewed"));
    assert.ok(fields.includes("tarball: https://example.test/package.tgz"));
    assert.ok(!fields.includes("integrity: sha512-other"));
    assert.ok(!fields.includes("tarball: https://other.test/package.tgz"));
  }
});

function lockedVersions(name) {
  const locked = [];
  for (const entry of workbenchEntries) {
    if (entry.name === name) locked.push({ lockfile: "packages/workbench/pnpm-lock.yaml", version: entry.version });
  }
  for (const [path, entry] of Object.entries(desktopPackages)) {
    if (path.split("node_modules/").at(-1) === name) locked.push({ lockfile: "packages/desktop/package-lock.json", version: entry.version });
  }
  return locked;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// A prerelease of the fixed release precedes it, and an unparsable version fails closed.
function isAtLeast(version, fixed) {
  const actual = SEMVER.exec(version ?? "");
  const minimum = SEMVER.exec(fixed);
  if (!actual || !minimum) return false;
  for (let index = 1; index <= 3; index += 1) {
    const [have, need] = [Number(actual[index]), Number(minimum[index])];
    if (have !== need) return have > need;
  }
  return actual[4] === undefined;
}

test("the floor comparison follows SemVer precedence and rejects unparsable versions", () => {
  assert.equal(isAtLeast("2.0.8-beta.1", "2.0.8"), false);
  assert.equal(isAtLeast("2.0.8", "2.0.8"), true);
  assert.equal(isAtLeast("2.0.9-rc.1", "2.0.8"), true);
  assert.equal(isAtLeast("10.0.0", "9.9.9"), true);
  assert.equal(isAtLeast("5.0.12", "5.0.12"), true);
  assert.equal(isAtLeast("2.0.7", "2.0.8"), false);
  assert.equal(isAtLeast("https://registry.example.test/proxy-addr-2.0.8.tgz", "2.0.8"), false);
  assert.equal(isAtLeast(undefined, "2.0.8"), false);
});

for (const { name, branch, fixed, advisories } of advisoryFloors) {
  test(`${name}${branch ? ` ${branch}x` : ""} has no locked copy below ${fixed} for ${advisories.join(", ")}`, () => {
    const locked = lockedVersions(name);
    assert.ok(locked.length > 0, `${name} is missing from the committed lockfiles`);
    assert.deepEqual(locked.filter(({ version }) => (!branch || version.startsWith(branch))
      && (!isAtLeast(version, fixed) || SEMVER.exec(version)?.[4])), [], `${name} is locked below ${fixed} or is a prerelease`);
  });
}

// TipTap packages pin each other exactly, so a partial update breaks peer alignment.
// @tiptap/y-tiptap has its own release line.
test("the TipTap packages stay on one release", () => {
  const releases = workbenchEntries.filter(({ name }) => name.startsWith("@tiptap/") && name !== "@tiptap/y-tiptap");
  assert.ok(releases.length > 0, "no TipTap packages are locked");
  assert.equal(new Set(releases.map(({ version }) => version)).size, 1, "TipTap packages are locked at different releases");
});

test("xlsx resolves only from the reviewed SheetJS archive and its integrity", () => {
  const entries = workbenchEntries.filter(({ name }) => name === "xlsx");
  assert.deepEqual(entries.map(({ source }) => source), [sheetjsArchive.tarball]);
  assert.ok(entries[0].fields.includes(`tarball: ${sheetjsArchive.tarball}`), "xlsx lock entry names another tarball");
  assert.ok(entries[0].fields.includes(`integrity: ${sheetjsArchive.integrity}`), "xlsx lock entry records another integrity");
});

// The two major-version overrides must retain the APIs their actual consumers use.
const require = createRequire(import.meta.url);

test("MSAL and Bot Framework retain UUID generation with the patched CJS and ESM exports", async () => {
  const coreRequire = createRequire(require.resolve("@agent-native/core"));
  const connectorRequire = createRequire(coreRequire.resolve("botframework-connector"));
  const msalPath = connectorRequire.resolve("@azure/msal-node");
  const schemaPath = connectorRequire.resolve("botframework-schema");
  const { CryptoProvider } = connectorRequire("@azure/msal-node");
  const { ActivityEx } = connectorRequire("botframework-schema");
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(new CryptoProvider().createNewGuid(), uuidV4);
  const reference = {
    channelId: "fixture", locale: "en-US", serviceUrl: "https://example.test",
    conversation: { id: "conversation" }, bot: { id: "bot" }, user: { id: "user" },
  };
  const activity = ActivityEx.getContinuationActivity(reference);
  assert.match(activity.id, uuidV4);
  assert.equal(activity.type, "event");
  assert.equal(activity.name, "ContinueConversation");
  assert.deepEqual(activity.relatesTo, reference);
  assert.deepEqual(activity.recipient, reference.bot);
  assert.deepEqual(activity.from, reference.user);
  for (const consumer of [msalPath, schemaPath]) {
    const consumerRequire = createRequire(consumer);
    const uuid = consumerRequire("uuid");
    const metadataUrl = pathToFileURL(consumerRequire.resolve("uuid/package.json"));
    const metadata = consumerRequire("uuid/package.json");
    const esm = await import(new URL(metadata.exports["."].node.import, metadataUrl).href);
    assert.match(uuid.v4(), uuidV4);
    assert.match(esm.v4(), uuidV4);
  }
});

test("Typography retains selector AST behavior with the patched parser", () => {
  const coreRequire = createRequire(require.resolve("@agent-native/core"));
  const { commonTrailingPseudos } = coreRequire("@tailwindcss/typography/src/utils.js");
  for (const [input, expected] of [
    ["p::before, a::before", ["::before", "p, a"]],
    ["p::before, a::after", [null, "p::before, a::after"]],
    ["a:not(:where(.skip))::before", ["::before", "a:not(:where(.skip))"]],
    [".sm\\:prose::before", ["::before", ".sm\\:prose"]],
    ["p strong", [null, "p strong"]],
  ]) assert.deepEqual(commonTrailingPseudos(input), expected);
});

test("Core's SQLite binding includes maintenance fixes and preserves transactions and stored values", () => {
  const coreRequire = createRequire(require.resolve("@agent-native/core"));
  const locked = lockedVersions("better-sqlite3");
  assert.ok(locked.length > 0, "better-sqlite3 is missing from the committed lockfiles");
  assert.ok(locked.every(({ version }) => isAtLeast(version, "13.0.3")));
  const Database = coreRequire("better-sqlite3");
  const directory = mkdtempSync(join(tmpdir(), "vivary-sqlite-compatibility-"));
  const filename = join(directory, "fixture.sqlite");
  let db;
  try {
    db = new Database(filename);
    assert.ok(isAtLeast(db.prepare("select sqlite_version() as version").get().version, "3.53.4"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, payload BLOB)");
    const insert = db.prepare("INSERT INTO items VALUES (?, ?, ?)");
    const bytes = Buffer.from([0, 127, 255]);
    const nested = db.transaction(() => { insert.run(2, "rolled back", bytes); throw new Error("rollback nested"); });
    db.transaction(() => {
      insert.run(1, "kept", bytes);
      assert.throws(nested, /rollback nested/);
      assert.equal(db.inTransaction, true);
      insert.run(3, "also kept", bytes);
    })();
    assert.throws(db.transaction(() => {
      insert.run(4, "rolled back outer", bytes);
      throw new Error("rollback outer");
    }), /rollback outer/);
    assert.equal(db.inTransaction, false);
    db.close();
    db = new Database(filename);
    assert.deepEqual(db.prepare("SELECT * FROM items ORDER BY id").all(), [
      { id: 1, label: "kept", payload: bytes }, { id: 3, label: "also kept", payload: bytes },
    ]);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
