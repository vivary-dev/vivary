import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Lowest fixed release for each advisory tracked in issue #23. The floor applies to
// every locked version of the package, so an older major line also fails here and
// needs its own review before it can enter the lockfile.
const advisoryFloors = [
  { name: "proxy-addr", fixed: "2.0.8", advisories: ["GHSA-jqcg-44mw-7w3h"] },
  { name: "brace-expansion", fixed: "5.0.12", advisories: ["GHSA-qhr7-859c-m2p7", "GHSA-6j4f-fj2g-mc7p", "GHSA-q2hr-2g5m-vwhr"] },
];

const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const packagesSection = lockfile.slice(lockfile.indexOf("\npackages:\n"), lockfile.indexOf("\nsnapshots:\n"));

function lockedVersions(name) {
  const versions = [];
  for (const [, key] of packagesSection.matchAll(/^  '?([^' ].*?)'?:$/gm)) {
    const at = key.lastIndexOf("@");
    if (key.slice(0, at) === name) versions.push(key.slice(at + 1));
  }
  return versions;
}

function isAtLeast(version, floor) {
  const [actual, minimum] = [version, floor].map((value) => value.split(/[.+-]/, 3).map(Number));
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

for (const { name, fixed, advisories } of advisoryFloors) {
  test(`${name} is locked at or above ${fixed} for ${advisories.join(", ")}`, () => {
    const versions = lockedVersions(name);
    assert.ok(versions.length > 0, `${name} is missing from pnpm-lock.yaml`);
    assert.deepEqual(versions.filter((version) => !isAtLeast(version, fixed)), [], `${name} is locked below ${fixed}`);
  });
}
