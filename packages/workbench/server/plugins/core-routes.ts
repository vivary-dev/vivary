import { createCoreRoutesPlugin } from "@agent-native/core/server";

import { VIVARY_NATIVE_MCP_OPTIONS } from "../native-mcp.ts";

// Replaces Native's defaultCoreRoutesPlugin with the same options, so the MCP
// connect, OAuth, and embed routes turn off with the MCP endpoint.
export default createCoreRoutesPlugin({
  googleOAuthManagedConnection: "not_applicable",
  ...VIVARY_NATIVE_MCP_OPTIONS.coreRoutes,
});
