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
];

const workbenchLock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const workbenchPackages = workbenchLock.slice(workbenchLock.indexOf("\npackages:\n"), workbenchLock.indexOf("\nsnapshots:\n"));
const desktopPackages = JSON.parse(readFileSync(new URL("../../desktop/package-lock.json", import.meta.url), "utf8")).packages;

function lockedVersions(name) {
  const locked = [];
  for (const [, key] of workbenchPackages.matchAll(/^  '?([^' ].*?)'?:$/gm)) {
    const at = key.lastIndexOf("@");
    if (key.slice(0, at) === name) locked.push({ lockfile: "packages/workbench/pnpm-lock.yaml", version: key.slice(at + 1) });
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
