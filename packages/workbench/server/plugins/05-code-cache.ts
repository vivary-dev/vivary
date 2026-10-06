import {
  defineNitroPlugin, getConfiguredAppBasePath, getFrameworkSessionCookieValues, getSessionEmail,
} from "@agent-native/core/server";
import type { H3Event } from "h3";
import { clearCodeRunIndex } from "../code-run-index";

export default defineNitroPlugin(nitroApp => {
  const signedOut = new WeakSet<H3Event>();
  nitroApp.hooks.hook("request", async (event: H3Event) => {
    // Core mounts BYOA handlers by segment prefix, at either the root or the
    // configured application base path. Match the same logout aliases.
    const logout = "/_agent-native/auth/logout";
    const pathname = event.url.pathname;
    const mounts = [logout, `${getConfiguredAppBasePath()}${logout}`];
    if (!mounts.some(mount => pathname === mount || pathname.startsWith(mount + "/"))) return;
    // Inspect only sessions Core's BYOA logout revokes. Calling the app session
    // resolver here could redeem a one-time browser proof during sign-out.
    const tokens = getFrameworkSessionCookieValues(event);
    const bearer = /^Bearer\s+(.+)$/i.exec((event.req.headers.get("authorization") ?? "").trim())?.[1]?.trim();
    if (bearer) tokens.push(bearer);
    try {
      for (const token of tokens) {
        if (await getSessionEmail(token)) { signedOut.add(event); break; }
      }
    } catch {
      // A cache hook must not block Core revocation. If lookup fails but logout
      // succeeds, release private contents conservatively.
      signedOut.add(event);
    }
  });
  nitroApp.hooks.hook("response", (response: Response, event: H3Event) => {
    if (signedOut.delete(event) && response.ok) clearCodeRunIndex();
  });
});
