import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { conversationReferenceSchema, linkedConversations } from "../server/linked-conversations";

export default defineAction({
  description: "Read a bounded linked history page within the target's retained completed-source boundary.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
    operation: z.enum(["target", "source"]).default("target"),
    target: conversationReferenceSchema, cursor: z.string().max(100).optional() }).strict()
    .refine(input => input.operation !== "source" || !input.cursor, "Source inspection has no page cursor."),
  readOnly: true, requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => input.operation === "source"
    ? await linkedConversations.sourceAvailable(ctx, input.projectId, input.target)
    : await linkedConversations.load(ctx, input.projectId, input.target, input.cursor),
});
