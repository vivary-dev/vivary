// Kept apart from native-state so the client entry imports nothing heavy.
import { isValidSessionToken, VIVARY_OWNER_SESSION_STORAGE_KEY } from "../../shared/owner-session";

type OwnerSessionWindow = {
  fetch: typeof fetch;
  location: Pick<Location, "href" | "origin">;
  localStorage: Pick<Storage, "getItem">;
};

// Only the private proxy sign-in page stores a token, because that proxy never
// returns cookies. Local and desktop pages store none and keep cookie sessions.
export function installOwnerSessionFetch(target: OwnerSessionWindow = window): void {
  let stored: string | null;
  try {
    stored = target.localStorage.getItem(VIVARY_OWNER_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
  if (!isValidSessionToken(stored)) return;
  const token = stored;
  const send = target.fetch.bind(target);
  target.fetch = (input, init) => {
    if (!isSameOriginRead(input, init, target.location)) return send(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("X-Vivary-Session")) return send(input, init);
    headers.set("X-Vivary-Session", token);
    return send(input, { ...init, headers });
  };
}

function isSameOriginRead(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  location: Pick<Location, "href" | "origin">,
) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  try {
    return new URL(input instanceof Request ? input.url : input, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
