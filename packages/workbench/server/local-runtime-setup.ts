import type { CodexModelCatalog } from "./codex-models";
import { claudeCodeModelChoices } from "../shared/claude-models";
import { compareReleaseVersions } from "../shared/runtime-versions";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { CLI_REGISTRY, isAllowedCommand } from "@agent-native/core/terminal/server";

export type VivaryCodeEngine = "claude-cli" | "codex-cli";
export type VivaryRuntimeStatus = {
  status: "ready" | "sign-in-required" | "update-required" | "not-installed" | "unavailable";
  message: string;
  checkedAt: string;
  version?: string;
};
export type VivaryRuntimeStatusResult = {
  codexModels: CodexModelCatalog | null;
  claudeModels: ReturnType<typeof claudeCodeModelChoices>;
  runtimes: Array<VivaryRuntimeStatus & { engine: VivaryCodeEngine; label: string }>;
};

type ProbeResult =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string; version?: string }
  | { kind: "not-installed" }
  | { kind: "unavailable"; version?: string };
export type CommandLaunch = { executable: string; prefix: string[]; env: NodeJS.ProcessEnv };

const STATUS_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 64 * 1024;
const cached = new Map<VivaryCodeEngine, { expiresAt: number; value: VivaryRuntimeStatus }>();
const pending = new Map<VivaryCodeEngine, Promise<VivaryRuntimeStatus>>();

// Coding runtimes run commands the agent chooses and keep their own logins in their own stores.
// Their launch keeps the host's ordinary settings, such as proxies, locale, and toolchain paths, and
// withholds every credential-shaped name: the Native provider keys Agent-Native reads from this
// environment, the sign-in secret that also derives the secret-store key, database URLs and tokens,
// webhook URLs, and integration secrets. Agent-Native reads well over a hundred such names, so a
// rule covers them rather than a list. Fragments match anywhere in a name, so PGPASSWORD matches.
// Short words match whole "_"-separated words, so SSH_AUTH_SOCK, GIT_ASKPASS, and PATH stay.
const CREDENTIAL_FRAGMENTS = ["PASSWORD", "PASSWD", "SECRET", "TOKEN", "APIKEY", "CREDENTIAL",
  "CONNECTION_STRING", "CONNECTIONSTRING", "COOKIE", "WEBHOOK"];
const CREDENTIAL_WORDS = new Set(["KEY", "KEYS", "PASS", "PAT", "DSN"]);
// MCP_SERVERS holds whole server configurations, including their headers and environments.
// GIT_CONFIG_PARAMETERS carries `git -c` values such as http.extraheader. BW_SESSION and
// OP_SESSION_<account> unlock the Bitwarden and 1Password command-line vaults.
const CREDENTIAL_NAMES = new Set(["MCP_SERVERS", "MYSQL_PWD", "DOCKER_AUTH_CONFIG", "GIT_CONFIG_PARAMETERS", "BW_SESSION"]);
const CREDENTIAL_PREFIXES = ["OP_SESSION_"];
// Database and message broker URLs can carry a password, as in POSTGRES_URL_NON_POOLING,
// MONGODB_URI, or CELERY_BROKER_URL. A URL or URI word after such a word marks one.
const DATABASE_STEMS = ["DATABASE", "DATASOURCE", "POSTGRES", "PG", "MYSQL", "MARIADB", "MONGO", "REDIS", "KV",
  "BROKER", "AMQP", "CLOUDAMQP"];
// These match the rule, but tools need them and they hold no secret. Git Credential Manager
// needs its store type on Linux.
const ORDINARY_NAMES = new Set(["GCM_CREDENTIAL_STORE", "GCM_AZREPOS_CREDENTIALTYPE", "NUGET_CREDENTIALPROVIDERS_PATH",
  "COOKIECUTTER_CONFIG", "TIKTOKEN_CACHE_DIR"]);
// Git reads GIT_CONFIG_COUNT with KEY_n and VALUE_n as complete pairs and exits if one is missing.
// A value can hold an authorization header, so the whole group is withheld together.
const GIT_CONFIG_GROUP = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
// Nested-session markers that would make a CLI believe it runs inside another agent's session.
const SESSION_MARKERS = new Set([...Object.values(CLI_REGISTRY).flatMap(entry => entry.stripEnv),
  "CODEX_THREAD_ID", "CODEX_SESSION_ID"].map(name => name.toUpperCase()));

function isDatabaseUrl(words: string[]): boolean {
  const url = words.findLastIndex(word => word === "URL" || word === "URI");
  return url > 0 && words.slice(0, url)
    .some(word => word.endsWith("DB") || DATABASE_STEMS.some(stem => word.startsWith(stem)));
}

export function isCredentialName(upperName: string): boolean {
  if (ORDINARY_NAMES.has(upperName)) return false;
  const words = upperName.split("_");
  return CREDENTIAL_FRAGMENTS.some(fragment => upperName.includes(fragment))
    || words.some(word => CREDENTIAL_WORDS.has(word)) || words.at(-1) === "AUTH"
    || CREDENTIAL_NAMES.has(upperName) || CREDENTIAL_PREFIXES.some(prefix => upperName.startsWith(prefix))
    || isDatabaseUrl(words) || GIT_CONFIG_GROUP.test(upperName);
}

// Windows environment names are case-insensitive, so names compare in upper case.
export function codingRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => {
    const upperName = name.toUpperCase();
    return !isCredentialName(upperName) && !SESSION_MARKERS.has(upperName);
  }));
}

// The oldest releases Vivary supports. An older CLI gets an update message before its sign-in is read,
// because its status command or protocol can fail in ways that do not name the version.
// Claude Code 2.1.286 is the first release whose `auth status` reports a Console sign-in's stored API key
// as `api_key` instead of `claude.ai` (Claude Code CHANGELOG.md, checked 2026-10-24), so the subscription
// check below cannot be passed by an API key. Codex 0.160.0 is the app-server release that Native's
// stored-thread reader is pinned to (receipts/10-codex-stored-thread-reader.md) and that the 2026-10-06
// sandbox receipt ran. Codex 0.148.0 could not parse configuration written by the Codex desktop app
// (desktop-acceptance-status.md), and 0.153.4 could not start its default sandbox on Zo (README.md).
// `versionPattern` accepts only the complete `--version` line for an installation with no npm manifest.
const commands = {
  "claude-cli": { command: "claude", args: ["auth", "status", "--json"], npmEntry: ["@anthropic-ai", "claude-code", "cli.js"],
    minimumVersion: "2.1.286", versionPattern: /^(\d+\.\d+\.\d+) \(Claude Code\)$/ },
  "codex-cli": { command: "codex", args: ["login", "status"], npmEntry: ["@openai", "codex", "bin", "codex.js"],
    minimumVersion: "0.160.0", versionPattern: /^codex-cli (\d+\.\d+\.\d+)$/ },
} satisfies Record<VivaryCodeEngine, {
  command: string; args: string[]; npmEntry: string[]; minimumVersion: string; versionPattern: RegExp;
}>;

export function vivaryRuntimeStatusFromProbe(
  engine: VivaryCodeEngine,
  result: ProbeResult,
  checkedAt = new Date().toISOString(),
): VivaryRuntimeStatus {
  const label = CLI_REGISTRY[commands[engine].command].label;
  const unavailable: VivaryRuntimeStatus = {
    status: "unavailable",
    message: `${label} could not report its sign-in status. Check the CLI in your terminal, then refresh.`,
    checkedAt,
  };
  if (result.kind === "not-installed") {
    return { status: "not-installed", message: `Install ${label} on this computer, then refresh.`, checkedAt };
  }
  // An unknown or malformed version leaves the result to the sign-in check, as before the floors existed.
  const { minimumVersion } = commands[engine];
  if (result.version && (compareReleaseVersions(result.version, minimumVersion) ?? 0) < 0) {
    return { status: "update-required", checkedAt, version: result.version,
      message: `Update ${label} to ${minimumVersion} or later, then refresh. Installed: ${result.version}.` };
  }
  if (result.kind === "unavailable") return unavailable;

  let signedIn: boolean;
  if (engine === "claude-cli") {
    let data: unknown;
    try { data = JSON.parse(result.stdout); } catch { return unavailable; }
    if (!data || typeof data !== "object" || !("loggedIn" in data) || typeof data.loggedIn !== "boolean") {
      return unavailable;
    }
    if (result.exitCode !== 0 && !(result.exitCode === 1 && !data.loggedIn)) return unavailable;
    if (data.loggedIn && (!("authMethod" in data) || data.authMethod !== "claude.ai"
      || !("apiProvider" in data) || data.apiProvider !== "firstParty"
      || !("subscriptionType" in data) || typeof data.subscriptionType !== "string" || !data.subscriptionType.trim())) {
      return { ...unavailable, message: "Sign in to Claude Code with your Claude subscription to use it in Vivary. API-key and cloud-provider access are separate from this integration." };
    }
    signedIn = data.loggedIn;
  } else if (result.exitCode === 0 && /Logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`)) {
    signedIn = true;
  } else if (result.exitCode === 0) {
    return { ...unavailable, message: "Sign in to Codex with ChatGPT to use your subscription in Vivary. API-key access is not enabled for this integration." };
  } else if (result.exitCode === 1 && /\bnot logged in\b/i.test(`${result.stdout}\n${result.stderr}`)) {
    signedIn = false;
  } else {
    return unavailable;
  }
  return signedIn
    ? { status: "ready", message: `${label} is signed in.`, checkedAt,
        ...(result.version ? { version: result.version } : {}) }
    : { status: "sign-in-required", message: `Sign in to ${label} in your terminal, then refresh.`, checkedAt,
        ...(result.version ? { version: result.version } : {}) };
}

export function getVivaryRuntimeStatus(
  engine: VivaryCodeEngine,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<VivaryRuntimeStatus> {
  // guard:allow-env-credential - Deployment mode gates access to local CLI status, not a credential.
  const mode = process.env.VIVARY_ACCESS_MODE;
  if (mode !== "local" && mode !== "private-proxy") {
    return Promise.resolve({
      status: "unavailable",
      message: "Local coding runtimes are available in the self-hosted app.",
      checkedAt: new Date().toISOString(),
    });
  }
  const active = pending.get(engine);
  if (active) return active;
  const previous = cached.get(engine);
  if (!refresh && previous && previous.expiresAt > Date.now()) return Promise.resolve(previous.value);

  const check = probeRuntime(engine)
    .then(result => vivaryRuntimeStatusFromProbe(engine, result))
    .catch(() => vivaryRuntimeStatusFromProbe(engine, { kind: "unavailable" }))
    .then(value => {
      cached.set(engine, { expiresAt: Date.now() + STATUS_TTL_MS, value });
      return value;
    })
    .finally(() => { pending.delete(engine); });
  pending.set(engine, check);
  return check;
}

async function probeRuntime(engine: VivaryCodeEngine): Promise<ProbeResult> {
  const launch = await resolveVivaryRuntimeCommand(engine);
  if (!launch) return { kind: "not-installed" };
  const version = await runtimeInstallationVersion(launch, engine) ?? await probeCliVersion(launch, engine);
  return new Promise(resolve => {
    const child = execFile(launch.executable, [...launch.prefix, ...commands[engine].args], {
      cwd: homedir(),
      env: launch.env,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") { resolve({ kind: "not-installed" }); return; }
        if (error.killed || typeof error.code !== "number") { resolve({ kind: "unavailable", version }); return; }
        resolve({ kind: "exited", exitCode: error.code, stdout, stderr, version });
        return;
      }
      resolve({ kind: "exited", exitCode: 0, stdout, stderr, version });
    });
    child.stdin?.end();
  });
}

// Native Claude Code and Codex installations have no npm manifest. Query the same resolved launch
// without opening a model session, and accept only the CLI's complete version response.
async function probeCliVersion(launch: CommandLaunch, engine: VivaryCodeEngine): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = execFile(launch.executable, [...launch.prefix, "--version"], {
      cwd: homedir(),
      env: launch.env,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(error ? undefined : commands[engine].versionPattern.exec(stdout.trim())?.[1]);
    });
    child.stdin?.end();
  });
}

export function resolveVivaryRuntimeCommand(engine: VivaryCodeEngine): Promise<CommandLaunch | null> {
  return resolveRuntimeCommandIn(engine, process.platform, {
    // guard:allow-env-credential - OS executable search paths locate the fixed CLI allowlist.
    executablePath: process.env.PATH ?? process.env.Path,
    // guard:allow-env-credential - Package-manager installation directory, not a credential.
    pnpmHome: process.env.PNPM_HOME,
    // guard:allow-env-credential - Windows user application directory locates installed CLI packages.
    appData: process.env.APPDATA,
    // guard:allow-env-credential - Windows local application directory locates installed CLI executables.
    localAppData: process.env.LOCALAPPDATA,
  }, process.env);
}

export type RuntimeSearchLocations = { executablePath?: string; pnpmHome?: string; appData?: string; localAppData?: string };

// Tests call this with another platform and locations to reach the Windows branches on any host.
export async function resolveRuntimeCommandIn(engine: VivaryCodeEngine, platform: NodeJS.Platform,
  { executablePath = "", pnpmHome, appData, localAppData }: RuntimeSearchLocations,
  source: NodeJS.ProcessEnv): Promise<CommandLaunch | null> {
  const spec = commands[engine];
  if (!isAllowedCommand(spec.command)) return null;
  const windows = platform === "win32";
  const home = homedir();
  const directories = [
    ...executablePath.split(path.delimiter),
    pnpmHome,
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    ...(windows
      ? [
          appData && path.join(appData, "npm"),
          localAppData && path.join(localAppData, "Microsoft", "WinGet", "Links"),
        ]
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
  ];
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = await readdir(nvmRoot, { withFileTypes: true });
    directories.push(...versions.filter(entry => entry.isDirectory()).slice(0, 32).map(entry => path.join(nvmRoot, entry.name, "bin")));
  } catch {
    // NVM is optional. The other standard installation locations still apply.
  }
  const searchDirectories = [...new Set(directories
    .filter((directory): directory is string => typeof directory === "string" && path.isAbsolute(directory)))];
  const env = codingRuntimeEnvironment(source);
  delete env.Path;
  env.PATH = searchDirectories.join(path.delimiter);

  if (!windows) {
    for (const directory of searchDirectories) {
      const executable = path.join(directory, spec.command);
      if (await isExecutable(executable)) return { executable, prefix: [], env };
    }
    return null;
  }
  // A Windows terminal runs the first `<command>.exe` or `<command>.cmd` on PATH, so follow that
  // order first. npm keeps its global `.cmd` launcher beside `node_modules`, so a directory with a
  // launcher this lookup cannot read still offers the npm entry beside it.
  for (const directory of searchDirectories) {
    const executable = path.join(directory, `${spec.command}.exe`);
    if (await isExecutable(executable)) return { executable, prefix: [], env };
    const shim = await readWindowsShim(directory, spec.command);
    if (shim === null) continue;
    const entry = await windowsShimEntry(directory, shim, engine) ?? await npmEntryIn(directory, engine);
    if (entry) return { executable: process.execPath, prefix: [entry], env };
  }
  // A package with no launcher beside it is one the terminal does not run, such as a copy left in a
  // Node version manager's directory. Use one only when no launcher matched, as earlier versions did.
  for (const directory of searchDirectories) {
    const entry = await npmEntryIn(directory, engine);
    if (entry) return { executable: process.execPath, prefix: [entry], env };
  }
  return null;
}

async function npmEntryIn(directory: string, engine: VivaryCodeEngine): Promise<string | null> {
  const entry = path.join(directory, "node_modules", ...commands[engine].npmEntry);
  return await isFile(entry) ? entry : null;
}

const SHIM_READ_BYTES = 8 * 1024;

// Read the start of `<command>.cmd`. NTFS matches names regardless of case, so the first name finds
// `codex.CMD` there. The second name covers a case-sensitive directory.
async function readWindowsShim(directory: string, command: string): Promise<string | null> {
  for (const name of [`${command}.cmd`, `${command}.CMD`]) {
    try {
      const handle = await open(path.join(directory, name), "r");
      try {
        const buffer = Buffer.alloc(SHIM_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SHIM_READ_BYTES, 0);
        return buffer.toString("utf8", 0, bytesRead);
      } finally { await handle.close(); }
    } catch {
      // Try the next name.
    }
  }
  return null;
}

// pnpm installs a global CLI on Windows as `<command>.cmd` beside a `..\global\<version>\<hash>`
// package store. Take the first quoted `%~dp0` argument outside a comment line that ends in the
// entry's file name, such as `codex.js`. A later argument is never tried. Accept it only when
// nothing in it needs cmd.exe to expand, its last segments are `node_modules` and the entry, the
// file exists, and the package manifest carries the expected name. `..` before those segments
// resolves against the shim's directory as cmd.exe resolves it, so it reaches only a package that
// passes the same checks. The shim is never run.
async function windowsShimEntry(directory: string, text: string, engine: VivaryCodeEngine): Promise<string | null> {
  const spec = commands[engine];
  const expected = ["node_modules", ...spec.npmEntry];
  const segments = text.split(/\r?\n/)
    .filter(line => !/^\s*@?\s*(?:rem(?:\s|$)|::)/i.test(line))
    .flatMap(line => [...line.matchAll(/"%~dp0([^"]*)"/gi)].map(match => match[1].split(/[\\/]+/).filter(Boolean)))
    .find(argument => argument.at(-1) === expected.at(-1));
  // A variable, escape, or drive in the path would make cmd.exe read it differently.
  if (!segments || segments.some(segment => /[%!^:]/.test(segment))
    || segments.slice(-expected.length).join("/") !== expected.join("/")) return null;
  const entry = path.resolve(directory, ...segments);
  if (!entry.endsWith(path.sep + path.join(...expected)) || !await isFile(entry)) return null;
  const packageRoot = path.resolve(entry, ...spec.npmEntry.slice(2).map(() => ".."));
  return await readRuntimeManifest(packageRoot, engine).catch(() => null) ? entry : null;
}

// Return the manifest in a directory when it names the engine's package, with its version when valid.
async function readRuntimeManifest(directory: string, engine: VivaryCodeEngine): Promise<{ version?: string } | null> {
  const text = await readFile(path.join(directory, "package.json"), "utf8").catch(() => null);
  if (!text) return null;
  const manifest: unknown = JSON.parse(text);
  if (!manifest || typeof manifest !== "object" || !("name" in manifest)
    || manifest.name !== commands[engine].npmEntry.slice(0, 2).join("/")) return null;
  return "version" in manifest && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version)
    ? { version: manifest.version } : {};
}

// Read installation metadata without running the CLI or consulting an account.
export async function runtimeInstallationVersion(launch: Pick<CommandLaunch, "executable" | "prefix">,
  engine: VivaryCodeEngine): Promise<string | undefined> {
  try {
    const entry = await realpath(launch.prefix[0] ?? launch.executable);
    for (const directory of [path.dirname(entry), path.dirname(path.dirname(entry))]) {
      const version = (await readRuntimeManifest(directory, engine))?.version;
      if (version) return version;
    }
  } catch {
    // Missing or malformed metadata leaves version discovery to the caller.
  }
  return undefined;
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function isExecutable(file: string): Promise<boolean> {
  if (!await isFile(file)) return false;
  try { await access(file, constants.X_OK); return true; } catch { return false; }
}
