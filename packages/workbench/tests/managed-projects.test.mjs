import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createManagedProject, installedPatternCatalog, previewManagedProject, readWorkspaceContext,
} from "../server/managed-projects.mjs";
import { isOriginalRunFailure, ORIGINAL_RUN_FAILURES } from "../server/original-runtime.ts";
import { pycachePrefixFlag } from "../server/python-bytecode.ts";
import { bundle, cacheFolder } from "./original-runtime-harness.ts";

test("production package cwd resolves the shipped creator bridge", async () => {
  const originalCwd = process.cwd();
  const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-managed-préview-"));
  try {
    process.chdir(workbenchRoot);
    const result = await previewManagedProject({}, { name: "Hosted-Preview" }, {
      dataDir,
      getAccess: async () => ({ code: "catalog" }),
    });
    assert.equal(result.code, "preview");
    assert.equal(result.plan.schema, "vivary.thin-init-plan/v1");
    assert.equal(result.plan.target, path.join(dataDir, "projects", "Hosted-Preview"));
    assert.equal(result.plan.files.length, 5);
  } finally {
    process.chdir(originalCwd);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the creator runs isolated Python through the original runner with only allowlisted names", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-managed-args-"));
  const bridge = path.join(dataDir, "managed_project_workspace.py");
  const launches = [];
  const answer = value => async (executable, args, stdin, cwd, environment, _signal, output) => {
    launches.push({ executable, args, request: JSON.parse(stdin), cwd, environment, output });
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "", signal: null };
  };
  const dependencies = { dataDir, getAccess: async () => ({ code: "catalog" }), python: "python-test", bridge,
    access: async () => {} };
  const target = path.join(dataDir, "projects", "Preview");
  const allowed = new Set(["PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "PATH", "PYTHONNOUSERSITE"]);
  try {
    const result = await previewManagedProject({}, { name: "Preview" }, { ...dependencies,
      execute: answer({ code: "preview", plan: { schema: "vivary.thin-init-plan/v1", target, files: [] } }) });
    assert.equal(result.code, "preview");
    assert.deepEqual(await readWorkspaceContext({ projectId: "project_a", root: dataDir }, ["notes/new.md"],
      { ...dependencies, execute: answer({ code: "context", context: { status: "invalid", message: "bad toml" } }) }),
    { status: "invalid", message: "bad toml" });
    for (const launch of launches) {
      assert.equal(launch.executable, "python-test");
      assert.deepEqual(launch.args, ["-I", "-X", "utf8", "-B", bridge]);
      assert.equal(launch.cwd, dataDir);
      assert.deepEqual(launch.output, { bytes: 512 * 1024, stdout: "structured" });
      assert.deepEqual(Object.keys(launch.environment).filter(name => !allowed.has(name)), []);
    }
    assert.deepEqual(launches.map(launch => launch.request), [
      { operation: "plan", target, patternChoices: [], preset: "coding" },
      { operation: "context", target: dataDir, candidates: ["notes/new.md"] },
    ], "the bridge never receives the project id");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a bundled creator call compiles into its build's cache, and keeps -B without data or inside its project", async () => {
  const { directory, runtime, data } = await bundle("vivary-creator-cache-");
  const flags = [];
  const answers = { catalog: { code: "catalog", patterns: [] }, plan: { code: "preview" },
    context: { code: "context", context: { status: "invalid", message: "unset" } } };
  const execute = async (_executable, args, stdin) => {
    const { operation } = JSON.parse(stdin);
    flags.push([operation, args[3]]);
    return { exitCode: 0, stdout: JSON.stringify(answers[operation]), stderr: "", signal: null };
  };
  const dependencies = { runtimeDirectory: runtime, dataDir: data, getAccess: async () => ({ code: "catalog" }),
    access: async () => {}, execute };
  try {
    const cache = pycachePrefixFlag(await cacheFolder(runtime, data));
    await installedPatternCatalog({}, dependencies);
    await previewManagedProject({}, { name: "Alpha" }, dependencies);
    await readWorkspaceContext({ projectId: "project_a", root: path.join(directory, "project") }, [], dependencies);
    await readWorkspaceContext({ projectId: "project_data", root: await realpath(data) }, [], dependencies);
    await installedPatternCatalog({}, { ...dependencies, dataDir: undefined });
    assert.deepEqual(flags, [["catalog", cache], ["plan", cache], ["context", cache], ["context", "-B"], ["catalog", "-B"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the creator child receives no server credential", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-creator-environment-"));
  const bridge = path.join(dataDir, "managed_project_workspace.py");
  await writeFile(bridge, "import json, os, sys\nsys.stdin.read()\nprint(json.dumps(sorted(os.environ)))\n");
  const seeded = {
    BETTER_AUTH_SECRET: randomBytes(24).toString("hex"),
    OPENROUTER_API_KEY: randomBytes(24).toString("hex"),
  };
  // guard:allow-env-credential - Saves two random test values seeded below, restored in `finally`.
  const previous = Object.fromEntries(Object.keys(seeded).map(name => [name, process.env[name]]));
  Object.assign(process.env, seeded);
  try {
    const names = await installedPatternCatalog({}, {
      getAccess: async () => ({ code: "catalog" }), python: "python3", bridge,
    });
    for (const name of Object.keys(seeded)) assert.equal(names.includes(name), false, `${name} reached the creator`);
    assert.ok(names.includes("PATH"), "an ordinary variable still reaches the creator");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      // guard:allow-env-credential - Removes a random test value seeded above.
      if (value === undefined) delete process.env[name];
      // guard:allow-env-credential - Restores the value saved above.
      else process.env[name] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one managed target has one apply and registration owner", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-managed-owner-"));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let applyCount = 0;
  let registrationCount = 0;
  const dependencies = {
    dataDir,
    getAccess: async () => ({ code: "catalog" }),
    runCreator: async ({ target }) => {
      applyCount += 1;
      await gate;
      await mkdir(target);
      return { code: "created", target, planSha256: "sha256:" + "a".repeat(64) };
    },
    connectFolder: async () => {
      registrationCount += 1;
      return { code: "registered", projectId: "project_one" };
    },
  };
  const input = {
    name: "Project-One",
    displayName: "Project One",
    acceptedPlanSha256: "sha256:" + "a".repeat(64),
  };
  try {
    const first = createManagedProject({}, input, dependencies);
    while (applyCount === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(createManagedProject({}, input, dependencies), /already being created/);
    assert.equal(applyCount, 1);
    release();
    const result = await first;
    assert.equal(result.registration.code, "registered");
    assert.equal(applyCount, 1);
    assert.equal(registrationCount, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("managed names reject Windows device names and case collisions before apply", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vivary-managed-name-"));
  await mkdir(path.join(dataDir, "projects"));
  await mkdir(path.join(dataDir, "projects", "Alpha"));
  let applyCount = 0;
  const dependencies = {
    dataDir,
    getAccess: async () => ({ code: "catalog" }),
    runCreator: async () => {
      applyCount += 1;
      throw new Error("must not run");
    },
  };
  const base = {
    displayName: "Project",
    acceptedPlanSha256: "sha256:" + "b".repeat(64),
  };
  try {
    await assert.rejects(createManagedProject({}, { ...base, name: "CON.txt" }, dependencies), /valid on Windows/);
    await assert.rejects(createManagedProject({}, { ...base, name: "alpha" }, dependencies), /different capitalization/);
    assert.equal(applyCount, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workspace context reads the engine answer through the shipped bridge", async () => {
  const originalCwd = process.cwd();
  const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const folder = await mkdtemp(path.join(os.tmpdir(), "vivary-context-plain-"));
  try {
    process.chdir(workbenchRoot);
    assert.deepEqual(await readWorkspaceContext({ projectId: "project_plain", root: folder }), {
      status: "plain", memory: [".vivary/knowledge"], protected: [],
      privacy: { policy: "none", private: [], privateFiles: [],
        ignoreFiles: [".gitignore", ".vivary/.gitignore", ".vivary/knowledge/.gitignore"], privateCandidates: [],
        checkedFiles: [] },
    });
  } finally {
    process.chdir(originalCwd);
    await rm(folder, { recursive: true, force: true });
  }
});

test("a project's own Python never runs for that project", { skip: process.platform === "win32" }, async () => {
  const originalCwd = process.cwd();
  const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const folder = await mkdtemp(path.join(os.tmpdir(), "vivary-context-venv-"));
  const root = path.join(folder, "project");
  const venv = path.join(root, ".venv", "bin");
  const marker = path.join(folder, "project-python-ran");
  const real = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  await mkdir(venv, { recursive: true });
  await writeFile(path.join(venv, "python3"),
    `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  // guard:allow-env-credential - Saves the server's executable search path, restored in `finally`.
  const previous = process.env.PATH;
  // guard:allow-env-mutation - Puts the project's activated virtual environment first, as a developer shell would.
  process.env.PATH = `${venv}${path.delimiter}${previous}`; // guard:allow-env-credential - The search path, not a credential.
  try {
    process.chdir(workbenchRoot);
    const answer = await readWorkspaceContext({ projectId: "project_venv", root }, [], { python: "python3" });
    assert.equal(answer.status, "plain", "the context read ran the next python3 on the server's PATH");
    assert.equal(existsSync(marker), false, "the project's .venv python3 never ran");
  } finally {
    // guard:allow-env-mutation - Restores the search path saved above.
    process.env.PATH = previous; // guard:allow-env-credential - The search path, not a credential.
    process.chdir(originalCwd);
    await rm(folder, { recursive: true, force: true });
  }
});

test("a relative interpreter path resolves against the server's working folder", async () => {
  const launches = [];
  const execute = async (executable, _args, _stdin, cwd) => {
    launches.push({ executable, cwd });
    return { exitCode: 0, stdout: JSON.stringify({ code: "catalog", patterns: [] }), stderr: "", signal: null };
  };
  const bridge = path.join(os.tmpdir(), "vivary-creator-bridge", "managed_project_workspace.py");
  await installedPatternCatalog({}, { getAccess: async () => ({ code: "catalog" }), access: async () => {}, bridge,
    python: path.join("rel", "python3"), execute });
  assert.deepEqual(launches, [{ executable: path.resolve("rel", "python3"), cwd: path.dirname(bridge) }]);
});

test("an unbundled interpreter that is missing or cannot start is named without a reinstall step", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "vivary-creator-python-"));
  const dependencies = { getAccess: async () => ({ code: "catalog" }), access: async () => {},
    bridge: path.join(folder, "managed_project_workspace.py") };
  try {
    for (const python of ["vivary-no-such-python", path.join(folder, "python3")]) {
      await assert.rejects(installedPatternCatalog({}, { ...dependencies, python }), error => {
        assert.ok(isOriginalRunFailure(error), `${python} fails as an original run failure`);
        assert.deepEqual([error.message, error.errorCode, error.statusCode],
          ["The Python interpreter for the workspace creator could not start.", ORIGINAL_RUN_FAILURES.runtimeUnavailable, 503]);
        return true;
      });
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("workspace context passes invalid settings through and refuses an unexpected answer", async () => {
  const answer = context => ({ runCreator: async () => ({ code: "context", context }) });
  const project = { projectId: "project_a", root: "/project" };
  assert.deepEqual(await readWorkspaceContext(project, [], answer({ status: "invalid", message: "bad toml" })),
    { status: "invalid", message: "bad toml" });
  const token = "sk-proj-" + randomBytes(16).toString("hex");
  assert.deepEqual(await readWorkspaceContext(project, [], answer({ status: "invalid", message: `bad key ${token}` })),
    { status: "invalid", message: "bad key [redacted credential]" }, "the settings error is redacted for display");
  await assert.rejects(readWorkspaceContext(project, [], answer({ status: "plain", roles: null, state: null,
    memory: ["../outside"], memory_assigned: false, protected: [], privacy_policy: "none", private: [],
    private_files: [], ignore_files: [], private_candidates: [], checked_files: [] })));
  const limited = await readWorkspaceContext(project, [], answer({ status: "plain", roles: null, state: null,
    memory: [".vivary/knowledge"], memory_assigned: false, protected: [], privacy_policy: "gitignore", private: [],
    private_files: [], ignore_files: [".gitignore"], private_candidates: [], checked_files: [], privacy_limited: true }));
  assert.equal(limited.status === "plain" && limited.privacy.limited, true);
  await assert.rejects(readWorkspaceContext(project, [], { runCreator: async () => ({ code: "refused" }) }),
    /settings reader is unavailable/);
});
