import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { changeCodeConversation, MAX_TITLE_LENGTH } from "../server/conversation-inbox";
import { requireVivaryCodeUser, resolveWorkspace } from "../server/local-code-agent";

const target = {
  runId: z.string().trim().min(1).max(128),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
};

export default defineAction({
  description: "Rename, archive, restore, pin or unpin one of the owner's Code conversations without changing its run.",
  schema: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("rename"), ...target,
      title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) }).strict(),
    z.object({ operation: z.enum(["archive", "restore", "pin", "unpin"]), ...target }).strict(),
  ]),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    // The project's current grant and binding decide, as they do when the conversation opens. A project whose history
    // cannot resolve refuses, and Personal workspace needs its configured folder.
    const scope = input.projectId === null ? await resolveWorkspace()
      : (await resolveVivaryCodeProjectHistory(ctx, input.projectId))!;
    return changeCodeConversation({ ownerEmail, orgId: ctx?.orgId ?? undefined, runId: input.runId,
      projectId: input.projectId, scope,
      change: input.operation === "rename" ? { operation: "rename", title: input.title } : { operation: input.operation } });
  },
});
