import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { conversationReferenceSchema, linkedConversations, linkedTargetSchema } from "../server/linked-conversations";

export default defineAction({
  description: "Open an inactive linked conversation in the same authorized project without sending or executing work.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
    source: conversationReferenceSchema, target: linkedTargetSchema }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: (input, ctx?: ActionRunContext) => linkedConversations.create(ctx, input),
});
