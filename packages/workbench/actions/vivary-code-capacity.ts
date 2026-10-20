import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { getVivaryCodeRunCapacity, requireVivaryCodeUser } from "../server/local-code-agent";

export default defineAction({
  description: "Read the host-wide limit on Code runs working at once, and the running and queued counts.",
  schema: z.object({}).strict(),
  http: { method: "GET" }, readOnly: true,
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (_input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    return getVivaryCodeRunCapacity({ ownerEmail, orgId: ctx?.orgId ?? undefined });
  },
});
