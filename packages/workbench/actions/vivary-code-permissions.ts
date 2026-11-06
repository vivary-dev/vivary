import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { requireVivaryCodeUser } from "../server/local-code-agent";
import { getCodePermissionMode } from "../server/code-permissions";

export default defineAction({
  description: "Read Codex permissions for future turns.",
  schema: z.object({}).strict(),
  http: { method: "GET" }, readOnly: true,
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (_input, ctx?: ActionRunContext) => {
    const owner = requireVivaryCodeUser(ctx);
    return { mode: await getCodePermissionMode(owner, ctx?.orgId ?? undefined) };
  },
});
