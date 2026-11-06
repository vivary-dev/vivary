import {
  createAuthPlugin,
  defineNitroPlugin,
} from "@agent-native/core/server";

import { installDesktopBrowserAccess } from "../browser-ingress.mjs";
import { installDesktopPresencePublisher } from "../desktop-presence.ts";
import {
  createVivaryLocalAuthOptions,
  createVivaryOwnerProof,
  resolveVivaryLocalAccessConfig,
} from "../local-access.ts";

const config = resolveVivaryLocalAccessConfig(process.env);

export default defineNitroPlugin(nitroApp => {
  // guard:allow-env-credential - Nonsecret desktop process marker set by the parent launcher.
  if (process.env.VIVARY_DESKTOP_HOST === "1") {
    installDesktopBrowserAccess(nitroApp, `http://127.0.0.1:${process.env.PORT}`);
    installDesktopPresencePublisher();
  }
  if (!config) return;
  // Built here rather than at module load because a one-time sign-in proof saves its first address to disk.
  const ownerProof = createVivaryOwnerProof(config, process.env);
  return createAuthPlugin(createVivaryLocalAuthOptions(config, ownerProof))(nitroApp);
});
