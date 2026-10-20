import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { changeNativeConversation, MAX_TITLE_LENGTH, requireCatalogProject } from "../server/conversation-inbox";
import { requireVivaryCodeUser } from "../server/local-code-agent";
import { getLocalProjectAccess } from "../server/project-services.mjs";

const target = {
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  threadId: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/),
};

/**
 * The inbox's owner action for API chats. It carries archive, rename and pin, because a private-proxy browser can
 * authenticate a POST only to an owner action, not to Native's thread routes.
 */
export default defineAction({
  description: "Archive, rename, pin or unpin one of the owner's API chats. Archive waits for unresolved work.",
  schema: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("rename"), ...target, title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) }).strict(),
    z.object({ operation: z.enum(["archive", "pin", "unpin"]), ...target }).strict(),
  ]),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    if (input.projectId !== null) requireCatalogProject(await getLocalProjectAccess(ctx), input.projectId);
    return changeNativeConversation({ ownerEmail, orgId, projectId: input.projectId, threadId: input.threadId,
      change: input.operation === "rename" ? { operation: "rename", title: input.title } : { operation: input.operation } });
  },
});
