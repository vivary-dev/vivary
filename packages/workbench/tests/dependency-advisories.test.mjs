import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Lowest fixed release for each advisory tracked in issue #23. The floor applies to
// every locked version of the package, so an older major line also fails here and
// needs its own review before it can enter a lockfile.
const advisoryFloors = [
  { name: "proxy-addr", fixed: "2.0.8", advisories: ["GHSA-jqcg-44mw-7w3h"] },
  { name: "brace-expansion", fixed: "5.0.12", advisories: ["GHSA-qhr7-859c-m2p7", "GHSA-6j4f-fj2g-mc7p", "GHSA-q2hr-2g5m-vwhr"] },
  { name: "pdfjs-dist", fixed: "6.2.108", advisories: ["GHSA-hq66-cqwq-w95j"] },
  { name: "xlsx", fixed: "0.19.3", advisories: ["GHSA-4r6h-8v6p-xvw6"] },
  { name: "xlsx", fixed: "0.20.2", advisories: ["GHSA-5pgg-2g8v-p4x9"] },
];

// SheetJS publishes fixed xlsx releases only on its CDN. This is the reviewed 0.20.3 archive.
const sheetjsArchive = {
  tarball: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
  integrity: "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==",
};

const workbenchLock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const workbenchPackages = workbenchLock.slice(workbenchLock.indexOf("\npackages:\n"), workbenchLock.indexOf("\nsnapshots:\n") + 1);
const desktopPackages = JSON.parse(readFileSync(new URL("../../desktop/package-lock.json", import.meta.url), "utf8")).packages;

// Each entry's key is name@version, or name@url for a tarball, which records its version inside.
const workbenchEntries = [...workbenchPackages.matchAll(/^  '?([^' ].*?)'?:\n((?: {4}.*\n)*)/gm)].map(([, key, body]) => {
  const at = key.lastIndexOf("@");
  const fields = body.split("\n").map((line) => line.trim());
  const recorded = fields.find((field) => field.startsWith("version: "));
  return { name: key.slice(0, at), version: recorded ? recorded.slice("version: ".length) : key.slice(at + 1), source: key.slice(at + 1), fields };
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

for (const { name, fixed, advisories } of advisoryFloors) {
  test(`${name} is locked at or above ${fixed} for ${advisories.join(", ")}`, () => {
    const locked = lockedVersions(name);
    assert.ok(locked.length > 0, `${name} is missing from the committed lockfiles`);
    assert.deepEqual(locked.filter(({ version }) => !isAtLeast(version, fixed)), [], `${name} is locked below ${fixed}`);
  });
}

test("xlsx resolves only from the reviewed SheetJS archive and its integrity", () => {
  const entries = workbenchEntries.filter(({ name }) => name === "xlsx");
  assert.deepEqual(entries.map(({ source }) => source), [sheetjsArchive.tarball]);
  assert.ok(entries[0].fields.includes(`tarball: ${sheetjsArchive.tarball}`), "xlsx lock entry names another tarball");
  assert.ok(entries[0].fields.includes(`integrity: ${sheetjsArchive.integrity}`), "xlsx lock entry records another integrity");
});
