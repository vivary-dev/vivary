import { useCallback, useMemo, useRef } from "react";
import {
  notifySessionInvalidated,
  useSession,
  writeClientAppState,
  type ClientAppStateWriteOptions,
} from "@agent-native/core/client/hooks";
import { agentNativePath } from "@agent-native/core/client/api-path";

import { isRejectedSessionToken, rejectSessionToken } from "./native-session-rejections";
import { isValidSessionToken } from "../../shared/owner-session";

const APP_STATE_KEY_PATTERN = /^[a-zA-Z0-9_:-]+$/;

type SessionSnapshot = ReturnType<typeof useSession>;
export type AppStateWriter = <T = unknown>(
  key: string,
  value: T,
  options?: ClientAppStateWriteOptions,
) => Promise<T>;

type WriterDependencies = {
  getSession: () => Pick<SessionSnapshot, "session" | "status">;
  cookieWriter: AppStateWriter;
  fetch: typeof fetch;
  invalidateSession: () => void;
  isRejectedToken: (token: string) => boolean;
  rejectToken: (token: string) => void;
  locationHref: () => string;
  nativePath: (path: string) => string;
};

export type AppStateWriterHandle = {
  ready: boolean;
  retrySession: () => void;
  sessionStatus: SessionSnapshot["status"];
  writeAppState: AppStateWriter;
};

export function sessionToken(snapshot: Pick<SessionSnapshot, "session" | "status">) {
  if (snapshot.status !== "authenticated") {
    const message = snapshot.status === "loading"
      ? "The Native session is still loading."
      : snapshot.status === "signing-out"
        ? "Wait until signing out finishes before making changes."
        : snapshot.status === "unauthenticated"
          ? "Sign in before making changes."
          : "The Native session could not be verified. Retry the session, then save again.";
    throw new Error(message);
  }
  const token = snapshot.session?.token;
  if (token === undefined) return null;
  if (!isValidSessionToken(token)) {
    throw new Error("The Native session did not provide a valid session token.");
  }
  return token;
}
function appStateUrl(
  key: string,
  locationHref: () => string,
  nativePath: (path: string) => string,
) {
  if (!APP_STATE_KEY_PATTERN.test(key)) {
    throw new TypeError(
      "Application state keys may only contain letters, numbers, underscores, hyphens, and colons.",
    );
  }

  const location = new URL(locationHref());
  const root = new URL(nativePath("/_agent-native"), location);
  const target = new URL(
    nativePath(`/_agent-native/application-state/${key}`),
    location,
  );
  const rootPath = root.pathname.replace(/\/$/, "");
  const expectedPath = `${rootPath}/application-state/${key}`;

  if (
    root.origin !== location.origin
    || target.origin !== location.origin
    || !rootPath.endsWith("/_agent-native")
    || target.pathname !== expectedPath
    || root.search
    || root.hash
    || target.search
    || target.hash
  ) {
    throw new Error("The Native application-state endpoint must be a same-origin Native API path.");
  }
  return target.href;
}

function jsonBody(value: unknown) {
  const body = JSON.stringify(value);
  if (body === undefined) {
    throw new TypeError(
      "Application state values must be JSON-serializable. Use the Native delete helper to clear a key.",
    );
  }
  return body;
}

async function parseResponse<T>(response: Response, key: string): Promise<T> {
  const raw = await response.text();
  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (response.ok) {
        throw Object.assign(
          new Error(`Write application state "${key}" returned a non-JSON ${response.status} response.`),
          { status: response.status },
        );
      }
    }
  }
  if (!response.ok) {
    let detail = raw.slice(0, 200) || response.statusText || `HTTP ${response.status}`;
    if (data && typeof data === "object") {
      if ("error" in data) detail = String(data.error);
      else if ("message" in data) detail = String(data.message);
    }
    throw Object.assign(
      new Error(`Write application state "${key}" failed: ${detail}`),
      { status: response.status },
    );
  }
  return data as T;
}

export function createAppStateWriter(dependencies: WriterDependencies): AppStateWriter {
  return async <T>(
    key: string,
    value: T,
    options: ClientAppStateWriteOptions = {},
  ) => {
    const url = appStateUrl(key, dependencies.locationHref, dependencies.nativePath);
    const body = jsonBody(value);
    const token = sessionToken(dependencies.getSession());
    if (token === null) {
      try {
        return await dependencies.cookieWriter(key, value, options);
      } catch (error) {
        if (
          error && typeof error === "object"
          && "status" in error && error.status === 401
        ) dependencies.invalidateSession();
        throw error;
      }
    }
    if (dependencies.isRejectedToken(token)) {
      throw new Error("The Native session token was rejected. Retry after the session refreshes.");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Vivary-Session": token,
    };
    if (options.requestSource) headers["X-Request-Source"] = options.requestSource;

    const response = await dependencies.fetch(url, {
      method: "PUT",
      credentials: "same-origin",
      redirect: "error",
      headers,
      body,
      keepalive: options.keepalive,
      signal: options.signal,
    });
    if (response.status === 401) {
      dependencies.rejectToken(token);
      dependencies.invalidateSession();
    }
    return parseResponse<T>(response, key);
  };
}

export function useAppStateWriter(): AppStateWriterHandle {
  const nativeSession = useSession();
  const latestSession = useRef(nativeSession);
  latestSession.current = nativeSession;

  const writeAppState = useCallback(
    createAppStateWriter({
      getSession: () => latestSession.current,
      cookieWriter: writeClientAppState,
      fetch: (input, init) => fetch(input, init),
      invalidateSession: notifySessionInvalidated,
      isRejectedToken: isRejectedSessionToken,
      rejectToken: rejectSessionToken,
      locationHref: () => window.location.href,
      nativePath: agentNativePath,
    }),
    [],
  );

  return useMemo(() => ({
    ready: nativeSession.status === "authenticated"
      && (nativeSession.session?.token === undefined
        || (isValidSessionToken(nativeSession.session.token)
          && !isRejectedSessionToken(nativeSession.session.token))),
    retrySession: nativeSession.retry,
    sessionStatus: nativeSession.status,
    writeAppState,
  }), [nativeSession.retry, nativeSession.session?.token, nativeSession.status, writeAppState]);
}
