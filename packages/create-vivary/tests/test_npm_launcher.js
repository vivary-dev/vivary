// Tests for the npm launcher arg-mapping (packages/create-vivary/npm/index.js).
// The launcher defaults a bare target to the `init` subcommand so the documented
// `npm create @vivary@latest my-workspace` UX reaches the Python CLI, which requires
// an explicit public subcommand.
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { mapArgs, pipxArgs, run, uvxArgs } = require(path.join(__dirname, "..", "npm", "index.js"));
const { version } = require(path.join(__dirname, "..", "npm", "package.json"));

// Keep this literal list aligned with the public subparsers in create_vivary.py and
// the documented command reference. Do not source it from the launcher: the table
// must catch a launcher missing a public command.
const PUBLIC_SUBCOMMANDS = [
  ["init", ["workspace"]],
  ["doctor", ["workspace"]],
  ["wizard", ["workspace"]],
  ["capabilities", ["--json"]],
  ["adopt", ["workspace", "--preset", "coding"]],
];

const cases = [
  // [input, expected, description]
  [["Benchmarkies"], ["init", "Benchmarkies"], "bare target gets init"],
  [
    ["Benchmarkies", "--preset", "coding"],
    ["init", "Benchmarkies", "--preset", "coding"],
    "bare target keeps trailing flags",
  ],
  ...PUBLIC_SUBCOMMANDS.map(([subcommand, args]) => [
    [subcommand, ...args],
    [subcommand, ...args],
    `explicit ${subcommand} unchanged`,
  ]),
  [["-h"], ["-h"], "leading short help flag unchanged"],
  [["--help"], ["--help"], "leading long help flag unchanged"],
  [[], [], "no args unchanged"],
];

let failed = 0;
for (const [input, expected, description] of cases) {
  const actual = mapArgs(input);
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok - ${description}`);
  } catch {
    failed += 1;
    console.error(`FAIL - ${description}`);
    console.error(`  input:    ${JSON.stringify(input)}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

if (failed) {
  console.error(`\n${failed} launcher test(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} launcher tests passed`);

assert.deepStrictEqual(
  uvxArgs(["--help"], ""),
  [`create-vivary@${version}`, "--help"],
);
assert.deepStrictEqual(
  pipxArgs(["--help"], ""),
  ["run", `create-vivary==${version}`, "--help"],
);
assert.deepStrictEqual(
  uvxArgs(["doctor", "ws"], "C:/tmp/create-vivary.whl"),
  ["--from", "C:/tmp/create-vivary.whl", "create-vivary", "doctor", "ws"],
);
assert.deepStrictEqual(
  pipxArgs(["doctor", "ws"], "C:/tmp/create-vivary.whl"),
  ["run", "--spec", "C:/tmp/create-vivary.whl", "create-vivary", "doctor", "ws"],
);
console.log("ok - launcher pins PyPI package to npm package version");

let captured;
const fakeSpawn = (cmd, cmdArgs, options) => {
  captured = { cmd, cmdArgs, options };
  return { status: 0 };
};
assert.deepStrictEqual(
  run("uvx", ["create-vivary", "demo&echo pwned"], fakeSpawn),
  { status: 0 },
);
assert.deepStrictEqual(captured, {
  cmd: "uvx",
  cmdArgs: ["create-vivary", "demo&echo pwned"],
  options: { stdio: "inherit", shell: false },
});
console.log("ok - launcher always passes args without a shell");
