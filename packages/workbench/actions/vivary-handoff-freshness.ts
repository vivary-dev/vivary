import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { handoffs } from "../server/handoff";
import { conversationReferenceSchema } from "../server/linked-conversations";

export default defineAction({
  description: "Compare the saved handoff with the current state document, project version and conversation. Calls no model.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), conversation: conversationReferenceSchema }).strict(),
  readOnly: true, requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: (input, ctx?: ActionRunContext) => handoffs.freshness(ctx, input),
});
