import { defineNitroPlugin, getH3App } from "@agent-native/core/server";
import { defineEventHandler } from "h3";

import { NATIVE_MCP_DISCOVERY_PATH } from "../native-mcp.ts";

// Mounted while plugins load. Native mounts its own card after an await, so this
// refusal sits ahead of it in the middleware list. It also sits ahead of Native's
// security headers middleware, so it sets the headers that matter for a 404.
export default defineNitroPlugin(nitroApp => {
  getH3App(nitroApp).use(NATIVE_MCP_DISCOVERY_PATH,
    defineEventHandler(() => Response.json({ error: "Not found" }, {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })));
});
