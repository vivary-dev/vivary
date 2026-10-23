#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertCurrentNode } from "./runtime-security.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function startupOptions(args, environment = process.env) {
  const { values } = parseArgs({ args, options: {
    hosted: { type: "boolean", default: false },
    "private-proxy": { type: "boolean", default: false },
    port: { type: "string" },
    "data-dir": { type: "string" },
    workspace: { type: "string" },
    url: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) return { help: true };
  const portText = values.port ?? environment.PORT ?? "5173";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error("Choose a port from 1 to 65535.");
  }
  const port = Number(portText);
  if (values.hosted && values["private-proxy"]) {
    throw new Error("Choose --hosted or --private-proxy, not both.");
  }
  const mode = values["private-proxy"] ? "private-proxy" : values.hosted ? "hosted" : "local";
  if (mode === "private-proxy" && environment.VIVARY_TRUSTED_PROXY !== "zo-owner-only") {
    throw new Error("Private proxy mode requires VIVARY_TRUSTED_PROXY=zo-owner-only.");
  }
  const configuredData = values["data-dir"] ?? environment.VIVARY_DATA_DIR;
  if (mode !== "local" && !configuredData) {
    throw new Error("Remote service mode requires --data-dir or VIVARY_DATA_DIR.");
  }
  const dataDir = path.resolve(configuredData ?? path.join(homedir(), ".vivary", "workbench"));
  let appUrl = new URL(`http://127.0.0.1:${port}`).origin;
  if (mode !== "local") {
    const configuredUrl = values.url ?? environment.APP_URL;
    if (!configuredUrl) throw new Error("Remote service mode requires --url or APP_URL.");
    const url = new URL(configuredUrl);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Remote service mode requires an exact external HTTPS origin.");
    }
    if (mode === "private-proxy" && (isIP(url.hostname) !== 0 || url.hostname.startsWith("["))) {
      throw new Error("Private proxy mode requires an external DNS hostname.");
    }
    appUrl = url.origin;
  } else if (values.url) {
    throw new Error("--url is only used with --hosted or --private-proxy. Local mode stays on this computer.");
  }
  return {
    help: false, port, mode, dataDir, appUrl,
    workspace: path.resolve(values.workspace ?? path.join(dataDir, "workspace")),
    createWelcome: !values.workspace,
  };
}

async function checkPort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is already in use. Stop that instance or choose --port.`)));
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}

async function authSecret(dataDir) {
  const secretFile = path.join(dataDir, "auth-secret");
  try {
    await writeFile(secretFile, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const secret = (await readFile(secretFile, "utf8")).trim();
  if (secret.length < 32) throw new Error("The saved authentication secret is invalid. Restore the original secret.");
  if (process.platform !== "win32") await chmod(secretFile, 0o600);
  return secret;
}

export async function startVivary(options) {
  await assertCurrentNode();
  const serverEntry = path.join(packageRoot, ".output", "server", "index.mjs");
  try { await access(serverEntry); }
  catch { throw new Error("Build Vivary first: pnpm --dir packages/workbench build"); }
  await checkPort(options.port);
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(options.dataDir, 0o700);
  await mkdir(options.workspace, { recursive: true });
  const workspace = await realpath(options.workspace);
  const secret = await authSecret(options.dataDir);
  if (options.createWelcome) {
    try {
      await writeFile(path.join(workspace, "README.md"),
        "# Vivary workspace\n\nAsk the agent to read, write, or edit files here.\n", { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  const databaseUrl = `file:${path.join(options.dataDir, "auth.sqlite")}`;
  // These are process startup settings. User model credentials remain in the CLI's own store.
  Object.assign(process.env, {
    NODE_ENV: "production",
    APP_NAME: "Vivary",
    ...(options.mode !== "hosted" ? { COOKIE_DOMAIN: "" } : {}),
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: String(options.port),
    NITRO_PORT: String(options.port),
    NITRO_SSL_CERT: "",
    NITRO_SSL_KEY: "",
    APP_URL: options.mode === "local" ? "" : options.appUrl,
    BETTER_AUTH_URL: options.mode === "local" ? "" : options.appUrl,
    VIVARY_ACCESS_MODE: options.mode,
    VIVARY_DATA_DIR: options.dataDir,
    VIVARY_LOCAL_AGENT_WORKSPACE: workspace,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    VIVARY_DATABASE_URL: databaseUrl,
    VIVARY_DATABASE_URL_UNPOOLED: databaseUrl,
    AGENT_NATIVE_CODE_AGENTS_HOME: path.join(options.dataDir, "code-runs"),
    BETTER_AUTH_SECRET: secret,
    AUTH_DISABLED: "false",
    AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT: "1",
    AGENT_NATIVE_SSR_CACHE: "off",
    AGENT_NATIVE_DISABLED_PLUGINS: "terminal",
    AUTH_MAGIC_LINK: "0",
  });
  process.chdir(packageRoot);
  console.log(`Vivary: ${options.appUrl}/`);
  console.log(options.mode === "hosted"
    ? "Hosted access: Native authentication is enabled."
    : "Self-hosted access: no Vivary account or signup. Model access uses your existing CLI login.");
  await import(pathToFileURL(serverEntry).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = startupOptions(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: vivary-gui [--port 5173] [--data-dir DIR] [--workspace DIR]\n       vivary-gui --private-proxy --url https://your-host --data-dir DIR [--port PORT]\n\nLocal mode listens only on this computer.\nPrivate proxy mode requires the configured private Zo access boundary.\nBoth modes sign in through a one-time address saved in owner-sign-in.txt in the data folder. Each address works once.\nUse --hosted only for a deployment that requires Native authentication.");
    } else {
      // guard:allow-env-credential - Nonsecret CLI process marker, set before loading the server.
      process.env.VIVARY_STANDALONE_HOST = "1"; // guard:allow-env-mutation - Direct process startup only; never a request handler.
      await startVivary(options);
      // The desktop server reuses startVivary and signs in through its own capability, so only this entry prints.
      if (options.mode !== "hosted") {
        console.log(`Owner sign-in file: ${path.join(options.dataDir, "owner-sign-in.txt")}`);
        console.log("Open the address in that file to sign in. Each address works once.");
      }
    }
  } catch (error) {
    console.error(`Vivary could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
