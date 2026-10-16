import type { AgentChatPluginOptions, CoreRoutesPluginOptions } from "@agent-native/core/server";

import { isDesktopRequest } from "./browser-request-context.mjs";

export const vivaryMcpOAuthAvailability: NonNullable<AgentChatPluginOptions["mcpOAuthAvailability"]> = event =>
  isDesktopRequest(event.context)
    ? { available: false, reason: "OAuth setup and signing in again are unavailable in the desktop app. Existing saved connections can still be tested or retried." }
    : { available: true };

// No Vivary launch serves Native's MCP endpoint. The MCP connect and OAuth routes
// turn off with it, because the tokens they mint also open Native's action routes.
// The MCP App embed routes turn off too, because only MCP tools mint their tickets.
export const VIVARY_NATIVE_MCP_OPTIONS = {
  agentChat: { mcp: { enabled: false }, mcpOAuthAvailability: vivaryMcpOAuthAvailability },
  coreRoutes: { mcp: { connect: false }, disableEmbedRoute: true },
} as const satisfies { agentChat: AgentChatPluginOptions; coreRoutes: CoreRoutesPluginOptions };

// Native mounts this public discovery card even with its MCP endpoint off. The card
// lists actions and points MCP clients at the endpoint, so Vivary refuses it.
export const NATIVE_MCP_DISCOVERY_PATH = "/.well-known/mcp.json";
