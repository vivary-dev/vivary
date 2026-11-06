import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";
import { VIVARY_NATIVE_MCP_OPTIONS } from "../native-mcp.ts";
import { vivaryNativeChatProjectOptions } from "../native-chat-project";

export default createAgentChatPlugin({
  appId: "vivary",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  ...vivaryNativeChatProjectOptions,
  ...VIVARY_NATIVE_MCP_OPTIONS.agentChat,
});
