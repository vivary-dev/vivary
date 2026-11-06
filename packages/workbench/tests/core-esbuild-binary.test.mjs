import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Desktop releases build Core's server output on windows-latest, where esbuild/bin/esbuild is a
// JavaScript launcher that execFileSync cannot start. The maintained Core patch makes
// findEsbuild() prefer the qualified binary the build workflows export as ESBUILD_BINARY_PATH.
const build = new URL("../node_modules/@agent-native/core/dist/deploy/build.js", import.meta.url);

// Core resolves esbuild from the build's working directory. This project's esbuild launcher is a
// plain file without an executable bit, so starting it directly fails as the Windows one does.
function project(directory) {
  const root = path.join(directory, "project");
  const launcher = path.join(root, "node_modules/esbuild/bin/esbuild");
  mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(path.join(root, "node_modules/esbuild/package.json"), '{"name":"esbuild","version":"0.0.0-fixture"}');
  writeFileSync(launcher, "// stands in for the Windows JavaScript launcher\n");
  chmodSync(launcher, 0o644);
  const serverDir = path.join(root, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "index.mjs"), 'import * as Y from "yjs";\nexport default Y;\n');
  return { root, serverDir };
}

function bundle(root, serverDir, environment) {
  const code = `const { bundleYjsRuntimeForServerlessOutput } = await import(${JSON.stringify(build.href)});
bundleYjsRuntimeForServerlessOutput(${JSON.stringify(serverDir)}, process.cwd());`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env: environment, encoding: "utf8", timeout: 60_000 });
}

test("Core's yjs bundling runs the qualified esbuild named by ESBUILD_BINARY_PATH", {
  skip: process.platform === "win32" && "the fixture esbuild is a POSIX script",
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vivary-esbuild-path-"));
  try {
    const { root, serverDir } = project(directory);
    const record = path.join(directory, "arguments.json");
    const qualified = path.join(directory, "esbuild-qualified");
    writeFileSync(qualified, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
      "const output = process.argv.find((value) => value.startsWith('--outfile=')).slice('--outfile='.length);",
      "fs.writeFileSync(output, 'export {};\\n');",
    ].join("\n"));
    chmodSync(qualified, 0o755);
    const { ESBUILD_BINARY_PATH: _unset, ...inherited } = process.env;

    const control = bundle(root, serverDir, inherited);
    assert.notEqual(control.status, 0, "without ESBUILD_BINARY_PATH the fixture launcher must fail to start");
    assert.equal(existsSync(record), false);

    const result = bundle(root, serverDir, { ...inherited, ESBUILD_BINARY_PATH: qualified });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(record, "utf8"));
    assert.ok(args.includes("--bundle"), "the qualified esbuild received the bundle request");
    assert.ok(args.includes(`--outfile=${path.join(serverDir, "_libs", "yjs-runtime.mjs")}`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
