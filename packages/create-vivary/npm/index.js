#!/usr/bin/env node
// create-vivary (npm): a thin launcher for the Python `create-vivary` scaffolder.
// `npm create vivary` / `npx create-vivary` -> runs the published PyPI package via
// uv (uvx) or pipx, so users get the create-t3-app experience without a manual
// `pip install`. The scaffolder itself is one source of truth in Python.
"use strict";

const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const onWindows = process.platform === "win32";

// VIVARY_FROM lets dev/CI point at a local wheel or path instead of PyPI.
const from = process.env.VIVARY_FROM;

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: onWindows });
}

// 1) uv (uvx) — preferred, fast, no global install.
let result = run("uvx", from
  ? ["--from", from, "create-vivary", ...args]
  : ["create-vivary", ...args]);

// 2) pipx fallback if uv is not installed.
if (result.error && result.error.code === "ENOENT") {
  result = run("pipx", from
    ? ["run", "--spec", from, "create-vivary", ...args]
    : ["run", "create-vivary", ...args]);
}

// 3) Neither runner present — guide the user.
if (result.error && result.error.code === "ENOENT") {
  console.error(
    "create-vivary needs Python tooling to run the scaffolder.\n" +
    "Install uv (https://docs.astral.sh/uv/) or pipx, then re-run `npm create vivary`."
  );
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
