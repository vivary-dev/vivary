import { defineNitroPlugin, setAutomationWebhookReach } from "@agent-native/core/server";

// Issue #113. The Automations page says who can call a webhook URL. The page origin cannot tell a
// local server from an owner-only proxy, so Vivary sets the reach from its access mode. bin/start.mjs
// sets the mode before the server loads.
const REACH_BY_ACCESS_MODE = { local: "local", "private-proxy": "owner-proxy", hosted: "public" } as const;

const accessMode = process.env.VIVARY_ACCESS_MODE; // guard:allow-env-credential - Deployment access mode, not a user credential.
setAutomationWebhookReach(REACH_BY_ACCESS_MODE[accessMode as keyof typeof REACH_BY_ACCESS_MODE]);

export default defineNitroPlugin(() => undefined);
