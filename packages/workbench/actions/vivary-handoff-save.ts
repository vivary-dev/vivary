import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { handoffs } from "../server/handoff";
import { conversationReferenceSchema } from "../server/linked-conversations";

export default defineAction({
  description: "Validate the agent's completed handoff reply and write it to the designated state document through the conflict-aware file owner.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), conversation: conversationReferenceSchema,
    requestId: z.string().uuid() }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: (input, ctx?: ActionRunContext) => handoffs.save(ctx, input),
});
