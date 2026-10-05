import { useCallback, useRef } from "react";
import { actionErrorMessage, callAction, tryCallActionKeepalive, notifySessionInvalidated, useSession } from "@agent-native/core/client/hooks";
import { agentNativePath } from "@agent-native/core/client/api-path";
import { sessionToken } from "./native-state";
import { isRejectedSessionToken, rejectSessionToken } from "./native-session-rejections";
import { VIVARY_OWNER_ACTIONS, type VivaryOwnerAction } from "../../shared/owner-actions";
import { isValidSessionToken } from "../../shared/owner-session";

export type NativeActionCaller = <T>(name: VivaryOwnerAction, params: Record<string, unknown>,
  options?: { keepalive?: boolean }) => Promise<T>;
// These reach the original runner, which may queue a command for 30 seconds before its own 30-second run.
const ORIGINAL_RUNNER_ACTIONS: readonly VivaryOwnerAction[] = ["vivary-original-command", "vivary-project-adoption",
  "vivary-project-read-owner", "vivary-project-evaluate-owner"];
const actionTimeout = (name: VivaryOwnerAction) => name === "vivary-connect-project-folder" ? 130_000
  : ORIGINAL_RUNNER_ACTIONS.includes(name) ? 70_000 : 30_000;

export function folderConnectionErrorMessage(failure: unknown): string {
  if (failure instanceof Error && (failure.name === "TimeoutError"
    || ("status" in failure && failure.status === 408)
    || ("timedOut" in failure && failure.timedOut === true))) {
    return "Folder selection timed out. Close the folder chooser and try again.";
  }
  return actionErrorMessage(failure) ?? "The folder could not be connected. Try again.";
}

type Session = Pick<ReturnType<typeof useSession>, "session" | "status">;
type Dependencies = {
  getSession: () => Session;
  fetch: typeof fetch;
  cookieAction: NativeActionCaller;
  locationHref: () => string;
  nativePath: (path: string) => string;
  invalidate: () => void;
};

export function createNativeActionCaller(dependencies: Dependencies): NativeActionCaller {
  return async <T>(name: VivaryOwnerAction, params: Record<string, unknown>,
    options?: { keepalive?: boolean }): Promise<T> => {
    if (!VIVARY_OWNER_ACTIONS.includes(name)) throw new Error("This action is not available through the owner transport.");
    const location = new URL(dependencies.locationHref());
    const root = new URL(dependencies.nativePath("/_agent-native"), location);
    const target = new URL(dependencies.nativePath("/_agent-native/actions/" + name), location);
    if (root.origin !== location.origin || target.origin !== location.origin
      || !root.pathname.endsWith("/_agent-native")
      || target.pathname !== root.pathname + "/actions/" + name
      || root.search || root.hash || target.search || target.hash) {
      throw new Error("The action endpoint must be on this Vivary instance.");
    }
    const body = JSON.stringify(params);
    if (body === undefined) throw new Error("Action inputs must be JSON.");
    // Leave room for other in-flight browser keepalive requests. Larger drafts
    // still use the ordinary transport and the beforeunload dirty-draft prompt.
    const keepalive = options?.keepalive === true && new TextEncoder().encode(body).byteLength <= 48_000;
    const token = sessionToken(dependencies.getSession());
    if (token === null) return dependencies.cookieAction<T>(name, params, { keepalive });
    if (isRejectedSessionToken(token)) throw new Error("Retry after the Native session refreshes.");
    const response = await dependencies.fetch(target.href, {
      method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json", "X-Agent-Native-Frontend": "1", "X-Vivary-Session": token },
      body, keepalive, signal: AbortSignal.timeout(actionTimeout(name)),
    });
    if (response.status === 401) {
      rejectSessionToken(token);
      dependencies.invalidate();
    }
    const raw = await response.text();
    let result: unknown;
    try { result = raw ? JSON.parse(raw) : null; } catch {
      throw Object.assign(new Error("The action returned an unreadable response. Refresh before retrying."), { status: response.status });
    }
    if (!response.ok) {
      const detail = result && typeof result === "object"
        ? ("message" in result && typeof result.message === "string" ? result.message
          : "error" in result && typeof result.error === "string" ? result.error : undefined)
        : undefined;
      const errorCode = result && typeof result === "object" && "errorCode" in result
        && typeof result.errorCode === "string" ? result.errorCode : undefined;
      throw Object.assign(new Error(detail ?? "The action could not finish. Try again."), { status: response.status, actionMessage: detail, errorCode });
    }
    // Action schemas own the response contract, as with Native's callAction<T>.
    return result as T;
  };
}

export function useNativeActionCaller() {
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  const call = useCallback(createNativeActionCaller({
    getSession: () => latest.current,
    fetch: (input, init) => fetch(input, init),
    cookieAction: <T>(name: VivaryOwnerAction, params: Record<string, unknown>, options?: { keepalive?: boolean }) => {
      if (options?.keepalive) {
        const attempt = tryCallActionKeepalive<T>(name, params, { timeoutMs: actionTimeout(name) });
        if (attempt.accepted) return attempt.completion;
      }
      return callAction<T>(name, params, { timeoutMs: actionTimeout(name) });
    },
    locationHref: () => window.location.href,
    nativePath: agentNativePath,
    invalidate: notifySessionInvalidated,
  }), []);
  return { call, retrySession: session.retry, sessionStatus: session.status,
    ready: session.status === "authenticated"
    && (session.session?.token === undefined || (isValidSessionToken(session.session.token) && !isRejectedSessionToken(session.session.token))) };
}
