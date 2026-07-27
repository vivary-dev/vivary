#!/usr/bin/env node
// create-vivary (npm): a thin launcher for the Python `create-vivary` scaffolder.
// `npm create @vivary@latest` / `npx @vivary/create@latest` -> runs the published PyPI package via
// uv (uvx) or pipx, so users get one-command setup without a manual `pip install`.
"use strict";

const { spawnSync } = require("node:child_process");
const { constants: osConstants } = require("node:os");
const { version } = require("./package.json");


function uvxArgs(args, from) {
  return from
    ? ["--from", from, "create-vivary", ...args]
    : [`create-vivary@${version}`, ...args];
}

function pipxArgs(args, from) {
  return from
    ? ["run", "--spec", from, "create-vivary", ...args]
    : ["run", `create-vivary==${version}`, ...args];
}

function run(cmd, cmdArgs, spawn = spawnSync) {
  return spawn(cmd, cmdArgs, { stdio: "inherit", shell: false });
}

function describeSpawnError(error) {
  return [error.code, error.message].filter(Boolean).join(": ") || String(error);
}

function exitStatus(result) {
  if (result.signal) {
    const signalNumber = osConstants.signals[result.signal];
    return typeof signalNumber === "number" ? 128 + signalNumber : 1;
  }
  return typeof result.status === "number" ? result.status : 1;
}

function main(
  argv = process.argv.slice(2),
  from = process.env.VIVARY_FROM,
  spawn = spawnSync,
  reportError = console.error,
) {
  const uvxResult = run("uvx", uvxArgs(argv, from), spawn);
  if (!uvxResult.error) {
    return exitStatus(uvxResult);
  }

  const pipxResult = run("pipx", pipxArgs(argv, from), spawn);
  if (!pipxResult.error) {
    return exitStatus(pipxResult);
  }

  reportError(
    "create-vivary could not start either Python runner.\n" +
      `uvx failed: ${describeSpawnError(uvxResult.error)}\n` +
      `pipx failed: ${describeSpawnError(pipxResult.error)}\n` +
      "Install or repair uv (https://docs.astral.sh/uv/) or pipx, then re-run `npm create @vivary@latest` or `npx @vivary/create@latest`.",
  );
  return 1;
}

module.exports = { main, pipxArgs, run, uvxArgs };

if (require.main === module) {
  process.exit(main());
}
