import { claudeCodeModelChoices } from "../shared/claude-models.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { codingRuntimeEnvironment, getVivaryRuntimeStatus, resolveRuntimeCommandIn, resolveVivaryRuntimeCommand, runtimeInstallationVersion, vivaryRuntimeStatusFromProbe } from "../server/local-runtime-setup.ts";

describe("local coding runtime status", () => {
  it("marks exact Claude IDs by installed version and labels API list prices", () => {
    const server = claudeCodeModelChoices("2.1.289");
    assert.equal(server.find(model => model.id === "claude-haiku-5-5")?.support, "upgrade-required");
    assert.equal(server.find(model => model.id === "claude-sonnet-5-5")?.support, "supported");
    assert.equal(server.find(model => model.id === "claude-fable-5-1")?.apiPrice, "$10 input / $50 output");
    assert.equal(claudeCodeModelChoices("2.1.296").every(model => model.support === "supported"), true);
    assert.equal(claudeCodeModelChoices().every(model => model.support === "unverified"), true);
    assert.equal(claudeCodeModelChoices("bad.version").every(model => model.support === "unverified"), true);
  });

  it("reads named CLI installation metadata without executing the entry", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "vivary-runtime-version-"));
    try {
      const entry = path.join(fixture, "cli.js");
      await writeFile(entry, "throw new Error('Must not run');");
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.289" }));
      assert.equal(await runtimeInstallationVersion({ executable: process.execPath, prefix: [entry] }, "claude-cli"), "2.1.289");
      await mkdir(path.join(fixture, "bin"));
      const nativeEntry = path.join(fixture, "bin", "claude.exe");
      await writeFile(nativeEntry, "Not an executable");
      assert.equal(await runtimeInstallationVersion({ executable: nativeEntry, prefix: [] }, "claude-cli"), "2.1.289");
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "another-package", version: "9.0.0" }));
      assert.equal(await runtimeInstallationVersion({ executable: process.execPath, prefix: [entry] }, "claude-cli"), undefined);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("requires first-party Claude subscription sign-in without returning account details", () => {
    const result = vivaryRuntimeStatusFromProbe("claude-cli", {
      kind: "exited", exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "private@example.test", organization: "private" }),
      stderr: "private diagnostics",
    });
    assert.equal(result.status, "ready");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(vivaryRuntimeStatusFromProbe("claude-cli", {
      kind: "exited", exitCode: 1, stdout: '{"loggedIn":false}', stderr: "",
    }).status, "sign-in-required");
  });

  it("rejects Claude API keys, cloud providers, and unknown sign-in routes", () => {
    for (const auth of [
      { authMethod: "apiKey", apiProvider: "firstParty" },
      { authMethod: "claude.ai", apiProvider: "bedrock" },
      { authMethod: "claude.ai", apiProvider: "vertex" },
      { authMethod: "claude.ai", apiProvider: "foundry" },
      { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "" },
      { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "  " },
      { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: null },
      { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: undefined },
      { authMethod: "claude.ai" },
      { apiProvider: "firstParty" },
      {},
    ]) {
      const result = vivaryRuntimeStatusFromProbe("claude-cli", {
        kind: "exited", exitCode: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max", ...auth }), stderr: "",
      });
      assert.equal(result.status, "unavailable");
      assert.match(result.message, /Claude subscription/);
    }
  });

  it("rejects malformed, misleading, and failed Claude status", () => {
    for (const stdout of ["not json", "null", "[]", '{"loggedIn":"true"}', "{}"]) {
      assert.equal(vivaryRuntimeStatusFromProbe("claude-cli", { kind: "exited", exitCode: 0, stdout, stderr: "" }).status, "unavailable");
    }
    assert.equal(vivaryRuntimeStatusFromProbe("claude-cli", {
      kind: "exited", exitCode: 2, stdout: '{"loggedIn":true}', stderr: "",
    }).status, "unavailable");
  });

  it("distinguishes Codex login failure from a failed status command", () => {
    assert.equal(vivaryRuntimeStatusFromProbe("codex-cli", {
      kind: "exited", exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT",
    }).status, "ready");
    assert.equal(vivaryRuntimeStatusFromProbe("codex-cli", {
      kind: "exited", exitCode: 0, stdout: "", stderr: "Logged in using an API key",
    }).status, "unavailable");
    assert.equal(vivaryRuntimeStatusFromProbe("codex-cli", {
      kind: "exited", exitCode: 1, stdout: "", stderr: "Not logged in",
    }).status, "sign-in-required");
    assert.equal(vivaryRuntimeStatusFromProbe("codex-cli", {
      kind: "exited", exitCode: 1, stdout: "", stderr: "Could not access the credential store",
    }).status, "unavailable");
  });

  it("keeps missing installations separate from failed probes", () => {
    assert.equal(vivaryRuntimeStatusFromProbe("claude-cli", { kind: "not-installed" }).status, "not-installed");
    assert.equal(vivaryRuntimeStatusFromProbe("codex-cli", { kind: "unavailable" }).status, "unavailable");
  });

  it("deduplicates concurrent probes, caches polling, and refreshes explicitly", { skip: process.platform === "win32" }, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "vivary-runtime-status-"));
    const countFile = path.join(fixture, "calls");
    // guard:allow-env-credential - Preserve only the test executable path, deployment mode, and CLI nesting marker.
    const previous = { PATH: process.env.PATH, VIVARY_ACCESS_MODE: process.env.VIVARY_ACCESS_MODE, CLAUDECODE: process.env.CLAUDECODE };
    try {
      const script = `#!/usr/bin/env node
const fs = require("node:fs");
// guard:allow-env-credential - The synthetic CLI checks that its nonsecret nesting marker was removed.
if (process.env.CLAUDECODE) process.exit(2);
if (JSON.stringify(process.argv.slice(2)) === '["--version"]') {
  process.stdout.write('2.1.300 (Claude Code)\\n');
  process.exit(0);
}
if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(2);
const file = ${JSON.stringify(countFile)};
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(count + 1));
setTimeout(() => process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"private@example.test"}'), 50);
`;
      await writeFile(path.join(fixture, "claude"), script, { mode: 0o755 });
      // guard:allow-env-credential - Locate only the disposable allowlisted CLI fixture before normal executables.
      process.env.PATH = fixture + path.delimiter + previous.PATH;
      // guard:allow-env-credential - Select the local deployment mode for this status test.
      process.env.VIVARY_ACCESS_MODE = "local";
      // guard:allow-env-credential - Synthetic nonsecret marker verifies nested CLI state is stripped.
      process.env.CLAUDECODE = "nested-marker";
      const [one, two] = await Promise.all([
        getVivaryRuntimeStatus("claude-cli", { refresh: true }),
        getVivaryRuntimeStatus("claude-cli", { refresh: true }),
      ]);
      assert.equal(one.status, "ready");
      assert.equal(one.version, "2.1.300", "native CLI version is discovered without a package manifest");
      assert.equal(claudeCodeModelChoices(one.version).every(model => model.support === "supported"), true);
      assert.strictEqual(one, two);
      assert.equal(await readFile(countFile, "utf8"), "1");
      await getVivaryRuntimeStatus("claude-cli");
      assert.equal(await readFile(countFile, "utf8"), "1");
      await getVivaryRuntimeStatus("claude-cli", { refresh: true });
      assert.equal(await readFile(countFile, "utf8"), "2");
      // guard:allow-env-credential - Verify hosted deployment mode cannot start local status probes.
      process.env.VIVARY_ACCESS_MODE = "hosted";
      assert.equal((await getVivaryRuntimeStatus("claude-cli")).status, "unavailable");
      assert.equal(await readFile(countFile, "utf8"), "2");
    } finally {
      // guard:allow-env-credential - Restore only the test's previous executable search path.
      if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
      // guard:allow-env-credential - Restore only the test's previous deployment mode.
      if (previous.VIVARY_ACCESS_MODE === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previous.VIVARY_ACCESS_MODE;
      // guard:allow-env-credential - Restore only the test's previous CLI nesting marker.
      if (previous.CLAUDECODE === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous.CLAUDECODE;
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps native Claude version support unverified after failed or malformed version responses", { skip: process.platform === "win32" }, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "vivary-native-version-"));
    // guard:allow-env-credential - Restore the fixture's executable search path and local deployment mode.
    const previous = { PATH: process.env.PATH, VIVARY_ACCESS_MODE: process.env.VIVARY_ACCESS_MODE };
    try {
      // guard:allow-env-credential - Use the disposable executable for the local runtime probe.
      process.env.PATH = fixture + path.delimiter + previous.PATH;
      // guard:allow-env-credential - Local mode enables only this synthetic status probe.
      process.env.VIVARY_ACCESS_MODE = "local";
      for (const response of [
        { text: "2.1.300 (Claude Code)\n", exit: 1 },
        { text: "2.1.300\n", exit: 0 },
        { text: "unrelated 2.1.300 (Claude Code)\n", exit: 0 },
        { text: "2.1.300 (Claude Code)\nadditional text", exit: 0 },
      ]) {
        await writeFile(path.join(fixture, "claude"), `#!/usr/bin/env node
const args = JSON.stringify(process.argv.slice(2));
if (args === '["--version"]') { process.stdout.write(${JSON.stringify(response.text)}); process.exit(${response.exit}); }
if (args !== '["auth","status","--json"]') process.exit(2);
process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
`, { mode: 0o755 });
        const status = await getVivaryRuntimeStatus("claude-cli", { refresh: true });
        assert.equal(status.status, "ready");
        assert.equal(status.version, undefined);
        assert.equal(claudeCodeModelChoices(status.version).every(model => model.support === "unverified"), true);
      }
    } finally {
      // guard:allow-env-credential - Restore only the fixture's executable path and local deployment mode.
      if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
      // guard:allow-env-credential - Restore the deployment mode after the local fixture.
      if (previous.VIVARY_ACCESS_MODE === undefined) delete process.env.VIVARY_ACCESS_MODE; else process.env.VIVARY_ACCESS_MODE = previous.VIVARY_ACCESS_MODE;
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

// Credential names the server can hold, taken from what Agent-Native and Vivary read. The spellings
// in mixed and lower case stand for Windows, where environment names are case-insensitive.
const SERVER_CREDENTIALS = ["OPENROUTER_API_KEY", "OpenRouter_Api_Key", "openai_api_key", "CODEX_API_KEY",
  "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "BUILDER_GATEWAY_TOKEN", "BUILDER_PRIVATE_KEY", "BETTER_AUTH_SECRET", "AUTH_SECRET",
  "A2A_SECRET", "OAUTH_STATE_SECRET", "SECRETS_ENCRYPTION_KEY", "Vivary_SECRETS_ENCRYPTION_KEY",
  "WORKSPACE_SECRETS_ENCRYPTION_KEY", "WORKSPACE_SECRETS_ENCRYPTION_KEY_PREVIOUS", "DATABASE_URL",
  "DATABASE_URL_UNPOOLED", "VIVARY_DATABASE_URL", "NETLIFY_DATABASE_URL_UNPOOLED", "DATABASE_AUTH_TOKEN",
  "ACCESS_TOKEN", "ACCESS_TOKENS", "AGENT_NATIVE_MCP_HUB_TOKEN", "GOOGLE_CLIENT_SECRET",
  "GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "TURNSTILE_SECRET_KEY",
  "R2_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "SENTRY_DSN", "NOTIFICATIONS_WEBHOOK_AUTH",
  "NOTIFICATIONS_SLACK_WEBHOOK_URL", "SLACK_BOT_TOKEN", "STRIPE_SECRET_KEY", "PROMETHEUS_PASSWORD",
  "GITHUB_TOKEN", "GH_TOKEN"];
// Ordinary settings a coding runtime needs to find its login, reach the network, and build projects.
const ORDINARY_SETTINGS = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot",
  "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "TERM", "HTTPS_PROXY", "no_proxy", "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS", "SSH_AUTH_SOCK", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME",
  "JAVA_HOME", "GOPATH", "AUTH_DISABLED", "BETTER_AUTH_URL"];

describe("coding runtime launch environment", () => {
  it("withholds credential-shaped names in any case and keeps ordinary settings", () => {
    const source = Object.fromEntries([...SERVER_CREDENTIALS, ...ORDINARY_SETTINGS, "CLAUDECODE", "CODEX_THREAD_ID"]
      .map(name => [name, `synthetic-${name}`]));
    const launch = codingRuntimeEnvironment(source);
    assert.deepEqual(SERVER_CREDENTIALS.filter(name => name in launch), [], "no server credential reaches the runtime");
    assert.deepEqual(ORDINARY_SETTINGS.filter(name => launch[name] !== `synthetic-${name}`), [], "ordinary settings pass through");
    assert.equal("CLAUDECODE" in launch || "CODEX_THREAD_ID" in launch, false, "nested-session markers are removed");
  });

  it("applies each branch of the credential rule", () => {
    const withheld = ["PGPASSWORD", "MYSQL_PWD_PASSWD", "CLIENT_SECRET", "SLACK_BOT_TOKEN", "OPENAIAPIKEY",
      "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_STORAGE_CONNECTION_STRING", "SQLCONNECTIONSTRING", "SESSION_COOKIE",
      "SLACK_WEBHOOK", "NETLIFY_DATABASE_URL_UNPOOLED", "NITRO_SSL_KEY", "PUBLIC_KEYS", "DB_PASS", "GITHUB_PAT",
      "SENTRY_DSN", "NOTIFICATIONS_WEBHOOK_AUTH", "PROXY_AUTH", "MCP_SERVERS", "mcp_servers",
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_12", "MYSQL_PWD", "DOCKER_AUTH_CONFIG",
      "POSTGRES_URL_NON_POOLING", "MONGODB_URI", "REDIS_URL", "KV_REST_API_URL", "SYSTEM_ACCESSTOKEN", "Jwt__SecretKey",
      "DATABASE_URL", "Database__Url", "REDISCLOUD_URL", "JAWSDB_URL", "MONGOLAB_URI", "CLOUDAMQP_URL", "CELERY_BROKER_URL",
      "SPRING_DATASOURCE_URL", "GIT_CONFIG_PARAMETERS", "BW_SESSION", "OP_SESSION_my_team"];
    const kept = ["SSH_AUTH_SOCK", "SSH_ASKPASS", "GIT_ASKPASS", "PATH", "PATHEXT", "PATHNAME_STYLE",
      "DBUS_SESSION_BUS_ADDRESS", "WT_SESSION", "SESSIONNAME", "TERM_SESSION_ID", "KEYBOARD_LAYOUT", "MONKEY_MODE",
      "AUTH_DISABLED", "BETTER_AUTH_URL", "OAUTH_REDIRECT_URL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
      "PASSENGER_APP_ENV", "COMPATIBILITY_MODE", "GCM_CREDENTIAL_STORE", "PWD", "OLDPWD", "APP_URL", "PGDATA",
      "REDIS_HOST", "DATABASE_NAME", "GCM_AZREPOS_CREDENTIALTYPE", "NUGET_CREDENTIALPROVIDERS_PATH", "COOKIECUTTER_CONFIG",
      "TIKTOKEN_CACHE_DIR", "CALLBACK_URL", "SITE_URL", "URL", "DB_HOST"];
    const launch = codingRuntimeEnvironment(Object.fromEntries([...withheld, ...kept].map(name => [name, "synthetic"])));
    assert.deepEqual(withheld.filter(name => name in launch), [], "credential-shaped names are withheld");
    assert.deepEqual(kept.filter(name => !(name in launch)), [], "ordinary names are kept");
  });

  it("withholds every Native provider key Agent-Native reads", async () => {
    // Agent-Native does not export its provider list, so read the installed copy to catch a new provider.
    const coreServer = fileURLToPath(import.meta.resolve("@agent-native/core/server"));
    const listFile = path.join(path.dirname(coreServer), "..", "agent", "engine", "provider-env-vars.js");
    const { PROVIDER_ENV_VARS } = await import(pathToFileURL(listFile).href).catch((error: Error) => {
      throw new Error(`Agent-Native moved its provider list from ${listFile}. Update this test. ${error.message}`);
    });
    assert.ok(PROVIDER_ENV_VARS.length > 0);
    const launch = codingRuntimeEnvironment(Object.fromEntries(PROVIDER_ENV_VARS.map((name: string) => [name, "synthetic"])));
    assert.deepEqual(Object.keys(launch), []);
  });

  it("builds the Codex and Claude launches from the filtered environment", { skip: process.platform === "win32" }, async () => {
    const seeded = ["OPENROUTER_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL", "HTTPS_PROXY", "PATH"];
    // guard:allow-env-credential - Snapshot only the names this test seeds, to restore them afterward.
    const previous = new Map(seeded.map(name => [name, process.env[name]]));
    const fixture = await mkdtemp(path.join(tmpdir(), "vivary-runtime-environment-"));
    try {
      for (const command of ["codex", "claude"]) await writeFile(path.join(fixture, command), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      // guard:allow-env-credential - Locate only the disposable CLI fixtures before normal executables.
      process.env.PATH = fixture + path.delimiter + previous.get("PATH");
      // guard:allow-env-credential - Seed synthetic nonsecret markers under credential names and one ordinary setting.
      Object.assign(process.env, { OPENROUTER_API_KEY: "synthetic", BETTER_AUTH_SECRET: "synthetic", DATABASE_URL: "synthetic", HTTPS_PROXY: "http://127.0.0.1:9" });
      for (const engine of ["codex-cli", "claude-cli"] as const) {
        const launch = await resolveVivaryRuntimeCommand(engine);
        assert.ok(launch, `${engine} resolves from the fixture`);
        assert.deepEqual(["OPENROUTER_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL"].filter(name => name in launch.env), []);
        assert.equal(launch.env.HTTPS_PROXY, "http://127.0.0.1:9");
        assert.deepEqual(Object.keys(launch.env).filter(name => name.toUpperCase() === "PATH"), ["PATH"]);
      }
    } finally {
      for (const [name, value] of previous) {
        // guard:allow-env-credential - Restore only the names this test seeded.
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

it("review regression: signed-out installations retain known model compatibility", () => {
  for (const engine of ["claude-cli", "codex-cli"] as const) {
    const result = vivaryRuntimeStatusFromProbe(engine, {
      kind: "exited", exitCode: 1, version: "2.1.289",
      stdout: engine === "claude-cli" ? '{"loggedIn":false}' : "Not logged in", stderr: "",
    });
    assert.equal(result.status, "sign-in-required");
    assert.equal(result.version, "2.1.289");
    if (engine === "claude-cli") {
      assert.equal(claudeCodeModelChoices(result.version).find(model => model.id === "claude-sonnet-5-5")?.support, "supported");
      assert.equal(claudeCodeModelChoices(result.version).find(model => model.id === "claude-haiku-5-5")?.support, "upgrade-required");
    }
  }
  assert.equal(vivaryRuntimeStatusFromProbe("claude-cli", {
    kind: "exited", exitCode: 1, stdout: '{"loggedIn":false}', stderr: "",
  }).version, undefined);
});


// pnpm on Windows installs a CLI as `<pnpm>\bin\<command>.cmd` with the package under
// `<pnpm>\global\v11\<hash>\node_modules`. npm keeps `<command>.cmd` beside `node_modules`.
// These cases pass Windows semantics to the lookup, so they exercise the same branches on every host.
describe("Windows runtime lookup", () => {
  const runtimes = {
    "codex-cli": { command: "codex", scope: "@openai", name: "codex", entry: ["bin", "codex.js"], version: "9.8.7" },
    "claude-cli": { command: "claude", scope: "@anthropic-ai", name: "claude-code", entry: ["cli.js"], version: "2.1.296" },
  } as const;
  type Engine = keyof typeof runtimes;
  const engines = Object.keys(runtimes) as Engine[];
  const hash = "0000-fixture";
  const placeholder = "throw new Error('Must not run');";

  // pnpm's generated Windows shim. Its first quoted argument is node.exe.
  function pnpmShim(...targets: string[]): string {
    const [first, second = first] = targets;
    return ["@SETLOCAL", '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${first}" %*`, ") ELSE (",
      "  @SET PATHEXT=%PATHEXT:;.JS;=;%", `  node  "%~dp0\\${second}" %*`, ")", ""].join("\r\n");
  }

  // npm's generated shim names the entry through its own dp0 variable, which this lookup does not read.
  function npmShim(engine: Engine): string {
    const runtime = runtimes[engine];
    return ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${runtime.scope}\\${runtime.name}\\${runtime.entry.join("\\")}" %*`,
      ""].join("\r\n");
  }

  async function writePackage(packageRoot: string, engine: Engine, manifestName?: string): Promise<string> {
    const runtime = runtimes[engine];
    const entry = path.join(packageRoot, ...runtime.entry);
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, placeholder);
    await writeFile(path.join(packageRoot, "package.json"),
      JSON.stringify({ name: manifestName ?? `${runtime.scope}/${runtime.name}`, version: runtime.version }));
    return entry;
  }

  function pnpmTarget(engine: Engine, separator = "\\"): string {
    const runtime = runtimes[engine];
    return ["..", "global", "v11", hash, "node_modules", runtime.scope, runtime.name, ...runtime.entry].join(separator);
  }

  function pnpmPackageRoot(root: string, engine: Engine): string {
    return path.join(root, "pnpm", "global", "v11", hash, "node_modules", runtimes[engine].scope, runtimes[engine].name);
  }

  async function pnpmGlobal(root: string, engine: Engine, { shim = pnpmShim(pnpmTarget(engine)), manifestName,
    install = true, shimName = `${runtimes[engine].command}.cmd` }: { shim?: string; manifestName?: string; install?: boolean;
    shimName?: string } = {}) {
    const shimDir = path.join(root, "pnpm", "bin");
    await mkdir(shimDir, { recursive: true });
    await writeFile(path.join(shimDir, shimName), shim);
    const entry = install ? await writePackage(pnpmPackageRoot(root, engine), engine, manifestName) : undefined;
    return { shimDir, entry };
  }

  // A global npm installation: the launcher beside `node_modules`.
  async function npmGlobal(root: string, engine: Engine) {
    const dir = path.join(root, "npm");
    const entry = await writePackage(path.join(dir, "node_modules", runtimes[engine].scope, runtimes[engine].name), engine);
    await writeFile(path.join(dir, `${runtimes[engine].command}.cmd`), npmShim(engine));
    return { dir, entry };
  }

  // A package left behind with no launcher beside it.
  async function bareEntry(root: string, engine: Engine) {
    const dir = path.join(root, "leftover", "node");
    return { dir, entry: await writePackage(path.join(dir, "node_modules", runtimes[engine].scope, runtimes[engine].name), engine) };
  }

  function resolveOnWindows(engine: Engine, directories: string[]) {
    return resolveRuntimeCommandIn(engine, "win32", { executablePath: directories.join(path.delimiter) }, {});
  }

  async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "vivary-pnpm-runtime-"));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
  }

  it("launches Node with the package entry a pnpm shim names", async () => {
    for (const engine of engines) {
      for (const separator of ["\\", "/"]) {
        await withFixture(async root => {
          const { shimDir, entry } = await pnpmGlobal(root, engine, { shim: pnpmShim(pnpmTarget(engine, separator)) });
          const launch = await resolveOnWindows(engine, [shimDir]);
          assert.ok(launch, `${engine} resolves from the pnpm shim with ${separator}`);
          assert.equal(launch.executable, process.execPath);
          assert.deepEqual(launch.prefix, [entry]);
          assert.equal(await runtimeInstallationVersion(launch, engine), runtimes[engine].version);
        });
      }
    }
  });

  it("reads a shim named with an upper-case extension", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const { shimDir, entry } = await pnpmGlobal(root, engine, { shimName: `${runtimes[engine].command}.CMD` });
        assert.deepEqual((await resolveOnWindows(engine, [shimDir]))?.prefix, [entry]);
      });
    }
  });

  it("prefers a later launcher over an earlier package with no launcher", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const bare = await bareEntry(root, engine);
        const pnpm = await pnpmGlobal(root, engine);
        assert.deepEqual((await resolveOnWindows(engine, [bare.dir, pnpm.shimDir]))?.prefix, [pnpm.entry],
          `${engine} skips the package with no launcher`);
      });
    }
  });

  it("still finds a package with no launcher when nothing else matches", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const bare = await bareEntry(root, engine);
        const launch = await resolveOnWindows(engine, [bare.dir]);
        assert.equal(launch?.executable, process.execPath);
        assert.deepEqual(launch?.prefix, [bare.entry]);
      });
    }
  });

  it("keeps PATH order between pnpm and npm launchers", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const pnpm = await pnpmGlobal(root, engine);
        const npm = await npmGlobal(root, engine);
        assert.deepEqual((await resolveOnWindows(engine, [pnpm.shimDir, npm.dir]))?.prefix, [pnpm.entry]);
        assert.deepEqual((await resolveOnWindows(engine, [npm.dir, pnpm.shimDir]))?.prefix, [npm.entry]);
      });
    }
  });

  it("prefers an executable in the same directory over its shim", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const { shimDir } = await pnpmGlobal(root, engine);
        const executable = path.join(shimDir, `${runtimes[engine].command}.exe`);
        await writeFile(executable, "Not an executable", { mode: 0o755 });
        const launch = await resolveOnWindows(engine, [shimDir]);
        assert.equal(launch?.executable, executable);
        assert.deepEqual(launch?.prefix, []);
      });
    }
  });

  it("refuses a shim whose package has another name and keeps searching", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const { shimDir } = await pnpmGlobal(root, engine, { manifestName: "another-package" });
        const npm = await npmGlobal(root, engine);
        assert.deepEqual((await resolveOnWindows(engine, [shimDir, npm.dir]))?.prefix, [npm.entry],
          `${engine} skips the misnamed package`);
      });
    }
  });

  it("refuses a shim that names anything but the exact package entry", async () => {
    for (const engine of engines) {
      const runtime = runtimes[engine];
      const entryPath = runtime.entry.join("\\");
      const valid = pnpmTarget(engine);
      const cases = [
        // A correctly named package outside any node_modules directory.
        { label: "no node_modules directory", shim: pnpmShim(`..\\global\\${runtime.scope}\\${runtime.name}\\${entryPath}`),
          prepare: (root: string) => writePackage(path.join(root, "pnpm", "global", runtime.scope, runtime.name), engine) },
        { label: "another file in the package",
          shim: pnpmShim(`..\\global\\v11\\${hash}\\node_modules\\${runtime.scope}\\${runtime.name}\\other.js`),
          prepare: async (root: string) => {
            await writePackage(pnpmPackageRoot(root, engine), engine);
            await writeFile(path.join(pnpmPackageRoot(root, engine), "other.js"), placeholder);
          } },
        // cmd.exe would expand the variable, so a literal directory of that name must not match.
        { label: "a variable in the path", shim: pnpmShim(`%PNPM_GLOBAL%\\node_modules\\${runtime.scope}\\${runtime.name}\\${entryPath}`),
          prepare: (root: string) => writePackage(
            path.join(root, "pnpm", "bin", "%PNPM_GLOBAL%", "node_modules", runtime.scope, runtime.name), engine) },
        { label: "a missing entry", shim: pnpmShim(valid), prepare: async () => {} },
        { label: "a target only on comment lines",
          shim: [`@REM "%~dp0\\${valid}"`, `REM "%~dp0\\${valid}"`, `:: "%~dp0\\${valid}"`, "@SETLOCAL", ""].join("\r\n"),
          prepare: (root: string) => writePackage(pnpmPackageRoot(root, engine), engine) },
        // The first entry argument is checked alone, so a valid second one is not tried.
        { label: "an invalid first entry argument", shim: pnpmShim(`..\\missing\\node_modules\\${runtime.scope}\\${runtime.name}\\${entryPath}`, valid),
          prepare: (root: string) => writePackage(pnpmPackageRoot(root, engine), engine) },
        { label: "`..` inside the package path",
          shim: pnpmShim(`..\\global\\v11\\${hash}\\node_modules\\${runtime.scope}\\..\\${runtime.scope}\\${runtime.name}\\${entryPath}`),
          prepare: (root: string) => writePackage(pnpmPackageRoot(root, engine), engine) },
        { label: "`..` that reaches a misnamed package",
          shim: pnpmShim(`..\\..\\elsewhere\\node_modules\\${runtime.scope}\\${runtime.name}\\${entryPath}`),
          prepare: (root: string) => writePackage(path.join(root, "elsewhere", "node_modules", runtime.scope, runtime.name), engine, "another-package") },
      ];
      for (const { label, shim, prepare } of cases) {
        await withFixture(async root => {
          const { shimDir } = await pnpmGlobal(root, engine, { shim, install: false });
          await prepare(root);
          const npm = await npmGlobal(root, engine);
          assert.deepEqual((await resolveOnWindows(engine, [shimDir, npm.dir]))?.prefix, [npm.entry], `${engine} refuses ${label}`);
        });
      }
    }
  });

  it("follows `..` before the package path to a correctly named package", async () => {
    for (const engine of engines) {
      const runtime = runtimes[engine];
      await withFixture(async root => {
        const { shimDir } = await pnpmGlobal(root, engine, { install: false,
          shim: pnpmShim(`..\\..\\elsewhere\\node_modules\\${runtime.scope}\\${runtime.name}\\${runtime.entry.join("\\")}`) });
        const entry = await writePackage(path.join(root, "elsewhere", "node_modules", runtime.scope, runtime.name), engine);
        assert.deepEqual((await resolveOnWindows(engine, [shimDir]))?.prefix, [entry]);
      });
    }
  });

  it("reads only the start of a shim", async () => {
    for (const engine of engines) {
      await withFixture(async root => {
        const { shimDir } = await pnpmGlobal(root, engine, { shim: `@ECHO off\r\n${" ".repeat(9000)}\r\n${pnpmShim(pnpmTarget(engine))}` });
        const npm = await npmGlobal(root, engine);
        assert.deepEqual((await resolveOnWindows(engine, [shimDir, npm.dir]))?.prefix, [npm.entry],
          `${engine} ignores a target past the read limit`);
      });
    }
  });
});
