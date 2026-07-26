#!/usr/bin/env node
// create-vivary (npm): a thin launcher for the Python `create-vivary` scaffolder.
// `npm create @vivary@latest` / `npx @vivary/create@latest` -> runs the published PyPI package via
// uv (uvx) or pipx, so users get one-command setup without a manual `pip install`.
"use strict";

const { spawnSync } = require("node:child_process");
const { version } = require("./package.json");

// The documented UX permits the bare-target form
// `npm create @vivary@latest my-workspace`, but the Python CLI expects an explicit
// `init`/`doctor` subcommand. Default a bare target to `init`; an explicit subcommand
// or leading flag (e.g. `-h`/`--help`) passes through unchanged.
const SUBCOMMANDS = new Set(["init", "doctor", "wizard", "capabilities"]);

function mapArgs(args) {
  const first = args[0];
  if (first && !first.startsWith("-") && !SUBCOMMANDS.has(first)) {
    return ["init", ...args];
  }
  return args;
}

function uvxArgs(args, from = process.env.VIVARY_FROM) {
  return from
    ? ["--from", from, "create-vivary", ...args]
    : [`create-vivary@${version}`, ...args];
}

function pipxArgs(args, from = process.env.VIVARY_FROM) {
  return from
    ? ["run", "--spec", from, "create-vivary", ...args]
    : ["run", `create-vivary==${version}`, ...args];
}

function run(cmd, cmdArgs, spawn = spawnSync) {
  return spawn(cmd, cmdArgs, { stdio: "inherit", shell: false });
}

function main() {
  const args = mapArgs(process.argv.slice(2));
  // VIVARY_FROM lets dev/CI point at a local wheel or path instead of PyPI.
  const from = process.env.VIVARY_FROM;

  // 1) uv (uvx) — preferred, fast, no global install.
  let result = run("uvx", uvxArgs(args, from));

  // 2) pipx fallback if uv is not installed.
  if (result.error && result.error.code === "ENOENT") {
    result = run("pipx", pipxArgs(args, from));
  }

  // 3) Neither runner present — guide the user.
  if (result.error && result.error.code === "ENOENT") {
    console.error(
      "create-vivary needs Python tooling to run the scaffolder.\n" +
      "Install uv (https://docs.astral.sh/uv/) or pipx, then re-run `npm create @vivary@latest` or `npx @vivary/create@latest`."
    );
    process.exit(1);
  }

  process.exit(result.status == null ? 1 : result.status);
}

module.exports = { mapArgs, pipxArgs, run, uvxArgs };

if (require.main === module) {
  main();
}
