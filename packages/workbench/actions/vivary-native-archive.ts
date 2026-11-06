import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { createVivaryChatIdentity } from "../server/chat-identity";
import { requireVivaryCodeUser } from "../server/local-code-agent";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { listArchivedNativeChats, restoreArchivedNativeChat } from "../server/native-archive";

const threadId = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable();
export default defineAction({
  description: "List or restore this owner's archived Native conversations in one project.",
  schema: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("list"), projectId }).strict(),
    z.object({ operation: z.literal("restore"), projectId, threadId }).strict(),
  ]),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const owner = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    const label = (await resolveVivaryCodeProjectHistory(ctx, input.projectId ?? undefined))?.label ?? "Personal workspace";
    const identity = createVivaryChatIdentity(owner, orgId, { kind: "project", projectId: input.projectId, label });
    if (input.operation === "list") return { threads: await listArchivedNativeChats(identity, owner, orgId) };
    await restoreArchivedNativeChat(identity, input.threadId, owner, orgId);
    return { restored: true };
  },
});
