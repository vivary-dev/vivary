import { isDesktopRequest, browserRequestIdentity } from "./browser-request-context.mjs";
import {
  createVivaryOwnerSignIn,
  VIVARY_OWNER_SIGN_IN_HEADER,
  VIVARY_OWNER_SIGN_IN_HTML,
  type VivaryOwnerSignIn,
} from "./owner-sign-in.ts";
import { VIVARY_OWNER_ACTIONS } from "../shared/owner-actions.ts";
import { isValidSessionToken, VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session.ts";

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import type { AuthOptions, AuthSession } from "@agent-native/core/server";
import {
  addSession,
  COOKIE_NAME,
  getFrameworkSessionCookieValues,
  getSessionEmail,
  setFrameworkSessionCookie,
} from "@agent-native/core/server";
import { getHeader, getMethod, getRequestIP, type H3Event } from "h3";

const FORBIDDEN_PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-server",
  "x-original-host",
] as const;
const LOCAL_BIND_HOSTS = new Set(["127.0.0.1", "::1"]);
const SESSION_BOOTSTRAP_METHODS = new Set(["GET", "HEAD"]);
const TRUSTED_FETCH_SITES = new Set(["none", "same-origin"]);
const SELF_HOSTED_AUTH_REDIRECT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=/">
  <title>Vivary</title>
</head>
<body>
  <script>window.location.replace("/")</script>
  <a href="/">Open Vivary</a>
</body>
</html>`;

export type VivaryLocalAccessConfig = {
  mode: "local" | "private-proxy";
  host: "127.0.0.1" | "::1";
  origin: string;
  ownerEmail: typeof VIVARY_LOCAL_OWNER_EMAIL;
  port: number;
  desktop?: boolean;
};

export type VivaryLocalAccessRequest = {
  forwardedProxyHeader?: string;
  forwardedFor?: string;
  forwardedHost?: string;
  forwardedPort?: string;
  forwardedProto?: string;
  host?: string;
  method: string;
  origin?: string;
  ownerSignIn?: string;
  peerAddress?: string;
  realIp?: string;
  secFetchSite?: string;
};

export type VivaryLocalAccessSessionDependencies = {
  addSession: (token: string, email: string) => Promise<void>;
  createToken: () => string;
  getSessionEmail: (token: string) => Promise<string | null>;
  readRequest: (event: H3Event) => VivaryLocalAccessRequest;
  readSessionTokens: (event: H3Event, config: VivaryLocalAccessConfig) => string[];
  setSessionCookie: (event: H3Event, token: string) => void;
};

type AccessEnvironment = Record<string, string | undefined>;

function requiredValue(env: AccessEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`[vivary-local-access] ${name} is required in local access mode.`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("[vivary-local-access] PORT must be an integer from 1 to 65535.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("[vivary-local-access] PORT must be an integer from 1 to 65535.");
  }
  return port;
}

export function resolveVivaryLocalAccessConfig(
  env: AccessEnvironment,
): VivaryLocalAccessConfig | null {
  const mode = env.VIVARY_ACCESS_MODE?.trim();
  if (!mode || mode === "hosted") return null;
  if (mode !== "local" && mode !== "private-proxy") {
    throw new Error(
      "[vivary-local-access] VIVARY_ACCESS_MODE must be unset, 'hosted', 'local', or 'private-proxy'.",
    );
  }
  if (env.NODE_ENV !== "production") {
    throw new Error("[vivary-local-access] Local access mode requires NODE_ENV=production.");
  }

  const host = requiredValue(env, "HOST");
  if (!LOCAL_BIND_HOSTS.has(host)) {
    throw new Error("[vivary-local-access] HOST must be the numeric loopback address 127.0.0.1 or ::1.");
  }
  const port = parsePort(requiredValue(env, "PORT"));
  const expectedHostname = host === "::1" ? "[::1]" : host;
  const configuredAppUrl = env.APP_URL?.trim() || undefined;
  const rawAppUrl = configuredAppUrl ?? (mode === "local"
    ? new URL(`http://${expectedHostname}:${port}`).origin
    : requiredValue(env, "APP_URL"));
  let appUrl: URL;
  try {
    appUrl = new URL(rawAppUrl);
  } catch {
    throw new Error("[vivary-local-access] APP_URL must be a canonical loopback HTTP origin.");
  }

  if (appUrl.username || appUrl.password || appUrl.pathname !== "/" ||
      appUrl.search || appUrl.hash || rawAppUrl !== appUrl.origin) {
    throw new Error(
      "[vivary-local-access] APP_URL must be a canonical origin without credentials, path, query, or fragment.",
    );
  }

  if (mode === "local") {
    if (
      appUrl.protocol !== "http:" ||
      appUrl.hostname !== expectedHostname ||
      effectivePort(appUrl) !== port
    ) {
      throw new Error(
        "[vivary-local-access] APP_URL must exactly match the configured numeric loopback HOST and PORT.",
      );
    }
  } else {
    if (env.VIVARY_TRUSTED_PROXY?.trim() !== "zo-owner-only") {
      throw new Error(
        "[vivary-local-access] Private proxy access requires VIVARY_TRUSTED_PROXY='zo-owner-only'.",
      );
    }
    if (
      host !== "127.0.0.1" ||
      appUrl.protocol !== "https:" ||
      appUrl.hostname === "localhost" ||
      isIpHostname(appUrl.hostname)
    ) {
      throw new Error(
        "[vivary-local-access] Private proxy access requires HOST=127.0.0.1 and APP_URL set to the canonical external HTTPS origin.",
      );
    }
  }

  return {
    mode,
    host: host as VivaryLocalAccessConfig["host"],
    origin: appUrl.origin,
    ownerEmail: VIVARY_LOCAL_OWNER_EMAIL,
    port,
    ...(env.VIVARY_DESKTOP_HOST === "1" ? { desktop: true } : {}),
  };
}

// How a request proves it comes from the owner before Vivary creates a new
// owner session. Existing owner sessions need no proof.
export type VivaryOwnerProof =
  | { kind: "desktop-admission" }
  | { kind: "one-time-sign-in"; signIn: VivaryOwnerSignIn };

// The desktop parent admits its own browser, so only a desktop config gets
// desktop admission. Every other config saves sign-in addresses in its data folder.
export function createVivaryOwnerProof(
  config: VivaryLocalAccessConfig,
  env: AccessEnvironment,
): VivaryOwnerProof {
  if (config.desktop) return { kind: "desktop-admission" };
  const dataDir = env.VIVARY_DATA_DIR;
  if (!dataDir) throw new Error("[vivary-local-access] VIVARY_DATA_DIR is required for owner sign-in.");
  return { kind: "one-time-sign-in", signIn: createVivaryOwnerSignIn({ origin: config.origin, dataDir }) };
}

export function localAccessRequestRejection(
  config: VivaryLocalAccessConfig,
  request: VivaryLocalAccessRequest,
): string | null {
  if (!isLoopbackAddress(request.peerAddress)) return "non-loopback-peer";
  if (config.mode === "local") {
    if (hasAnyProxyHeader(request)) return "forwarded-proxy-header";
    if (request.host !== new URL(config.origin).host) return "unexpected-host";
  } else {
    const proxyRejection = privateProxyRequestRejection(config, request);
    if (proxyRejection) return proxyRejection;
  }
  if (request.origin !== undefined && request.origin !== config.origin) {
    return "unexpected-origin";
  }
  if (
    request.secFetchSite !== undefined &&
    !TRUSTED_FETCH_SITES.has(request.secFetchSite.toLowerCase())
  ) {
    return "cross-site-request";
  }
  return null;
}

export function createVivaryLocalSessionResolver(
  config: VivaryLocalAccessConfig,
  ownerProof: VivaryOwnerProof,
  dependencies: VivaryLocalAccessSessionDependencies = defaultDependencies,
): (event: H3Event) => Promise<AuthSession | null> {
  return async (event) => {
    if (ownerProof.kind === "desktop-admission" && !isDesktopRequest(event.context)) return null;
    let request: VivaryLocalAccessRequest;
    try {
      request = dependencies.readRequest(event);
    } catch {
      return null;
    }
    if (localAccessRequestRejection(config, request)) return null;

    let tokens: string[];
    try {
      tokens = dependencies.readSessionTokens(event, config);
    } catch {
      return null;
    }

    let resolvedForeignOwner = false;
    try {
      for (const token of tokens) {
        const email = (await dependencies.getSessionEmail(token))?.trim().toLowerCase();
        if (email === config.ownerEmail) {
          return { email: config.ownerEmail, name: "Local owner", token };
        }
        if (email) resolvedForeignOwner = true;
      }
    } catch {
      return null;
    }
    // The owner proof runs last so a refused request never spends a one-time secret.
    if (
      (resolvedForeignOwner && config.mode === "local") ||
      !SESSION_BOOTSTRAP_METHODS.has(request.method.toUpperCase()) ||
      !presentsOwnerProof(ownerProof, event, request)
    ) {
      return null;
    }

    try {
      const token = dependencies.createToken();
      if (token.length < 32) return null;
      await dependencies.addSession(token, config.ownerEmail);
      dependencies.setSessionCookie(event, token);
      return { email: config.ownerEmail, name: "Local owner", token };
    } catch {
      return null;
    }
  };
}

function presentsOwnerProof(
  proof: VivaryOwnerProof,
  event: H3Event,
  request: VivaryLocalAccessRequest,
): boolean {
  switch (proof.kind) {
    case "desktop-admission":
      // The resolver already returned early for a request without desktop admission.
      return true;
    case "one-time-sign-in":
      return proof.signIn.redeem(request.ownerSignIn);
  }
}

export function createVivaryLocalAuthOptions(
  config: VivaryLocalAccessConfig,
  ownerProof: VivaryOwnerProof,
): AuthOptions {
  const resolveSession = createVivaryLocalSessionResolver(config, ownerProof);
  return {
    getSession: async (event) => {
      const identity = browserRequestIdentity(event.context);
      if (identity?.kind === "remote") return { email: config.ownerEmail, name: "Paired browser" };
      return resolveSession(event);
    },
    loginHtml: ownerProof.kind === "desktop-admission"
      ? SELF_HOSTED_AUTH_REDIRECT_HTML
      : VIVARY_OWNER_SIGN_IN_HTML[config.mode],
    rootAuth: false,
  };
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function hasAnyProxyHeader(request: VivaryLocalAccessRequest): boolean {
  return Boolean(
    request.forwardedProxyHeader || request.forwardedFor ||
    request.forwardedHost || request.forwardedPort || request.forwardedProto ||
    request.realIp,
  );
}

function privateProxyRequestRejection(
  config: VivaryLocalAccessConfig,
  request: VivaryLocalAccessRequest,
): string | null {
  if (request.forwardedProxyHeader) return "unexpected-proxy-header";

  const appUrl = new URL(config.origin);
  const canonicalHost = appUrl.host;
  const backendHost = `127.0.0.1:${config.port}`;
  const usesCanonicalHost = request.host === canonicalHost;
  const usesBackendHost = request.host === backendHost;
  if (!usesCanonicalHost && !usesBackendHost) return "unexpected-host";
  if (
    request.forwardedHost !== undefined &&
    request.forwardedHost !== canonicalHost
  ) {
    return "unexpected-forwarded-host";
  }
  if (usesBackendHost && request.forwardedHost !== canonicalHost) {
    return "unexpected-forwarded-host";
  }
  if (
    request.forwardedProto !== undefined &&
    request.forwardedProto !== "https"
  ) {
    return "unexpected-forwarded-proto";
  }
  if (usesBackendHost && request.forwardedProto !== "https") {
    return "unexpected-forwarded-proto";
  }
  if (
    request.forwardedPort !== undefined &&
    request.forwardedPort !== String(effectivePort(appUrl))
  ) {
    return "unexpected-forwarded-port";
  }
  if (!isSingleProxyAddress(request.forwardedFor) || !isSingleProxyAddress(request.realIp)) {
    return "unexpected-proxy-chain";
  }
  if (
    request.forwardedFor !== undefined && request.realIp !== undefined &&
    request.forwardedFor !== request.realIp
  ) {
    return "unexpected-proxy-chain";
  }
  return null;
}

function isSingleProxyAddress(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value === value.trim() && !value.includes(",") && isIP(value) !== 0;
}

function isIpHostname(hostname: string): boolean {
  const bracketed = /^\[(.+)\]$/.exec(hostname)?.[1];
  return isIP(bracketed ?? hostname) !== 0;
}

function isLoopbackAddress(value: string | undefined): boolean {
  const address = (value ?? "").split("%")[0];
  if (address === "::1") return true;
  if (isIP(address) === 4) return address.split(".")[0] === "127";
  const mappedIpv4 = /^::ffff:(.+)$/i.exec(address)?.[1];
  return mappedIpv4 !== undefined &&
    isIP(mappedIpv4) === 4 &&
    mappedIpv4.split(".")[0] === "127";
}

function readForbiddenProxyHeader(event: H3Event): string | undefined {
  return FORBIDDEN_PROXY_HEADERS.find((name) => getHeader(event, name) !== undefined);
}

export function readVivarySessionTokens(
  event: H3Event,
  config: VivaryLocalAccessConfig,
): string[] {
  const tokens = getFrameworkSessionCookieValues(event);
  if (config.mode !== "private-proxy" || getHeader(event, "sec-fetch-site") !== "same-origin"
    || !acceptsSessionHeader(event, config)) return tokens;

  const token = getHeader(event, "x-vivary-session");
  if (isValidSessionToken(token) && !tokens.includes(token)) tokens.push(token);
  return tokens;
}

// The private proxy never returns cookies, so every read may carry the session
// header. Writes carry it only to the owner actions and application state.
function acceptsSessionHeader(event: H3Event, config: VivaryLocalAccessConfig): boolean {
  const method = getMethod(event);
  const origin = getHeader(event, "origin");
  if (method === "GET" || method === "HEAD") return origin === undefined || origin === config.origin;
  if (!["PUT", "POST"].includes(method) || origin !== config.origin) return false;

  // req.url stays absolute while Native middleware changes the mount-relative URL.
  const path = new URL(event.req.url, config.origin).pathname;
  if (method === "POST") return VIVARY_OWNER_ACTIONS.some(name => path === "/_agent-native/actions/" + name);
  const prefix = "/_agent-native/application-state/";
  if (!path.startsWith(prefix)) return false;
  let key: string;
  try { key = decodeURIComponent(path.slice(prefix.length)); } catch { return false; }
  return key !== "compose" && /^[a-zA-Z0-9_:-]+$/.test(key);
}

const defaultDependencies: VivaryLocalAccessSessionDependencies = {
  addSession,
  createToken: () => randomBytes(32).toString("base64url"),
  getSessionEmail,
  readRequest: (event) => ({
    forwardedProxyHeader: readForbiddenProxyHeader(event),
    forwardedFor: getHeader(event, "x-forwarded-for"),
    forwardedHost: getHeader(event, "x-forwarded-host"),
    forwardedPort: getHeader(event, "x-forwarded-port"),
    forwardedProto: getHeader(event, "x-forwarded-proto"),
    host: getHeader(event, "host"),
    method: getMethod(event),
    origin: getHeader(event, "origin"),
    ownerSignIn: getHeader(event, VIVARY_OWNER_SIGN_IN_HEADER),
    peerAddress: getRequestIP(event, { xForwardedFor: false }),
    realIp: getHeader(event, "x-real-ip"),
    secFetchSite: getHeader(event, "sec-fetch-site"),
  }),
  readSessionTokens: (event, config) => {
    const tokens = readVivarySessionTokens(event, config);
    if (process.env.VIVARY_SESSION_DIAGNOSTICS === "1") { // guard:allow-env-credential - Deployment diagnostic toggle, not a credential.
      const cookie = getHeader(event, "cookie");
      try {
        process.stderr.write(`${JSON.stringify({
          cookieHeaderPresent: cookie !== undefined,
          expectedCookieNamePresent: (cookie ?? "").split(";").some(
            (part) => part.includes("=") && part.slice(0, part.indexOf("=")).trim() === COOKIE_NAME,
          ),
          recognizedTokenCount: tokens.length,
        })}\n`);
      } catch {
        // Diagnostic output must not change session resolution.
      }
    }
    return tokens;
  },
  setSessionCookie: setFrameworkSessionCookie,
};
