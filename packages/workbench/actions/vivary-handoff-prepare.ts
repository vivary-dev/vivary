import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { handoffs } from "../server/handoff";
import { conversationReferenceSchema } from "../server/linked-conversations";

export default defineAction({
  description: "Record the project facts for a handoff and return the request to submit to this conversation. Writes no project file.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), conversation: conversationReferenceSchema }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: (input, ctx?: ActionRunContext) => handoffs.prepare(ctx, input),
});
