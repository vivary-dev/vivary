import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { requireVivaryCodeUser } from "../server/local-code-agent";
import { CODE_PERMISSION_MODES, getCodePermissionMode, setCodePermissionMode } from "../server/code-permissions";

export default defineAction({
  description: "Change Codex permissions for future turns.",
  schema: z.object({ mode: z.enum(CODE_PERMISSION_MODES) }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async ({ mode }, ctx?: ActionRunContext) => {
    const owner = requireVivaryCodeUser(ctx);
    if (mode) await setCodePermissionMode(owner, mode, ctx?.orgId ?? undefined);
    return { mode: await getCodePermissionMode(owner, ctx?.orgId ?? undefined) };
  },
});
