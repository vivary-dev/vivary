// Tests for the npm launcher transport (packages/create-vivary/npm/index.js).
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { main, pipxArgs, run, uvxArgs } = require(path.join(__dirname, "..", "npm", "index.js"));
const { version } = require(path.join(__dirname, "..", "npm", "package.json"));

function test(name, callback) {
  callback();
  console.log(`ok - ${name}`);
}

function invoke(argv, responses, from = "") {
  const calls = [];
  const errors = [];
  const status = main(
    argv,
    from,
    (cmd, cmdArgs, options) => {
      calls.push({ cmd, cmdArgs, options });
      return responses.shift();
    },
    (message) => errors.push(message),
  );
  return { calls, errors, status };
}

function assertSingleUvxLaunch(outcome, argv) {
  assert.deepStrictEqual(outcome.calls, [
    {
      cmd: "uvx",
      cmdArgs: [`create-vivary@${version}`, ...argv],
      options: { stdio: "inherit", shell: false },
    },
  ]);
}

// Keep this literal table aligned with the five documented public subcommands.
// It verifies transport shape only; Python owns command recognition.
const PUBLIC_SUBCOMMANDS = ["init", "doctor", "wizard", "capabilities", "adopt"];

test("all public subcommand names pass through unchanged", () => {
  for (const subcommand of PUBLIC_SUBCOMMANDS) {
    const outcome = invoke([subcommand], [{ status: 0 }]);
    assert.strictEqual(outcome.status, 0);
    assertSingleUvxLaunch(outcome, [subcommand]);
  }
});

test("explicit adopt arguments pass through unchanged", () => {
  const argv = ["adopt", ".", "--json"];
  const outcome = invoke(argv, [{ status: 0 }]);
  assert.strictEqual(outcome.status, 0);
  assertSingleUvxLaunch(outcome, argv);
});

test("bare targets pass through unchanged for Python to normalize", () => {
  const argv = ["my-workspace", "--preset", "coding"];
  const outcome = invoke(argv, [{ status: 0 }]);
  assert.strictEqual(outcome.status, 0);
  assertSingleUvxLaunch(outcome, argv);
});

test("leading flags pass through unchanged", () => {
  for (const argv of [["-h"], ["--help"]]) {
    const outcome = invoke(argv, [{ status: 0 }]);
    assert.strictEqual(outcome.status, 0);
    assertSingleUvxLaunch(outcome, argv);
  }
});

test("uvx success and nonzero statuses propagate exactly", () => {
  const success = invoke(["adopt", "."], [{ status: 0 }]);
  const nonzero = invoke(["adopt", "."], [{ status: 23 }]);
  assert.strictEqual(success.status, 0);
  assert.strictEqual(nonzero.status, 23);
  assert.strictEqual(success.calls.length, 1);
  assert.strictEqual(nonzero.calls.length, 1);
});

test("uvx errors fall back to pipx and preserve pipx statuses", () => {
  const success = invoke(["adopt", "."], [{ error: { code: "EACCES" } }, { status: 0 }]);
  const nonzero = invoke(["adopt", "."], [{ error: { code: "ENOENT" } }, { status: 17 }]);
  assert.strictEqual(success.status, 0);
  assert.strictEqual(nonzero.status, 17);
  assert.deepStrictEqual(success.calls.map(({ cmd }) => cmd), ["uvx", "pipx"]);
  assert.deepStrictEqual(nonzero.calls.map(({ cmd }) => cmd), ["uvx", "pipx"]);
  assert.deepStrictEqual(
    success.calls[1].cmdArgs,
    ["run", `create-vivary==${version}`, "adopt", "."],
  );
});

test("both runner errors report both failures and return one", () => {
  const outcome = invoke(
    ["adopt", "."],
    [
      { error: { code: "EACCES", message: "uvx permission denied" } },
      { error: { code: "EPERM", message: "pipx permission denied" } },
    ],
  );
  assert.strictEqual(outcome.status, 1);
  assert.deepStrictEqual(outcome.calls.map(({ cmd }) => cmd), ["uvx", "pipx"]);
  assert.strictEqual(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /uvx failed: EACCES: uvx permission denied/);
  assert.match(outcome.errors[0], /pipx failed: EPERM: pipx permission denied/);
});

test("signals retain their conventional exit status", () => {
  const outcome = invoke(["adopt", "."], [{ status: null, signal: "SIGINT" }]);
  assert.strictEqual(outcome.status, 130);
});

test("package arguments stay pinned and support VIVARY_FROM", () => {
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
});

test("main reads VIVARY_FROM once and passes it to the runner", () => {
  const previous = process.env.VIVARY_FROM;
  const calls = [];
  process.env.VIVARY_FROM = "C:/tmp/create-vivary.whl";
  try {
    const status = main(
      ["doctor", "ws"],
      undefined,
      (cmd, cmdArgs, options) => {
        calls.push({ cmd, cmdArgs, options });
        return { status: 0 };
      },
      () => {},
    );
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(
      calls[0].cmdArgs,
      ["--from", "C:/tmp/create-vivary.whl", "create-vivary", "doctor", "ws"],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.VIVARY_FROM;
    } else {
      process.env.VIVARY_FROM = previous;
    }
  }
});

test("spawns always inherit stdio without a shell", () => {
  let captured;
  const result = run("uvx", ["create-vivary", "demo&echo pwned"], (cmd, cmdArgs, options) => {
    captured = { cmd, cmdArgs, options };
    return { status: 0 };
  });
  assert.deepStrictEqual(result, { status: 0 });
  assert.deepStrictEqual(captured, {
    cmd: "uvx",
    cmdArgs: ["create-vivary", "demo&echo pwned"],
    options: { stdio: "inherit", shell: false },
  });
});
