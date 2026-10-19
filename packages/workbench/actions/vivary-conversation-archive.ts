import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { archiveNativeConversation } from "../server/conversation-inbox";
import { requireVivaryCodeUser } from "../server/local-code-agent";

export default defineAction({
  description: "Archive one of the owner's API chats unless a turn, queued messages or a pending send are unresolved.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
    threadId: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/),
  }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    return archiveNativeConversation({ ownerEmail, orgId, projectId: input.projectId, threadId: input.threadId });
  },
});
