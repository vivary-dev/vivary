import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { loadConversationInbox, type InboxProject } from "../server/conversation-inbox";
import { requireVivaryCodeUser, resolveWorkspace } from "../server/local-code-agent";
import { getLocalProjectAccess } from "../server/project-services.mjs";

function isAccessDenial(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error
    && (error.statusCode === 401 || error.statusCode === 403);
}

export default defineAction({
  description: "List the owner's Code and API chat conversations across every project and Personal workspace.",
  schema: z.object({}).strict(),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (_input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    const catalog = await getLocalProjectAccess(ctx);
    if (catalog.code !== "catalog") fail("Project access changed. Reload the app.", { statusCode: 403 });
    // A project whose registry binding cannot resolve keeps its API chats. Its Code history is reported unavailable
    // rather than failing the whole list.
    const projects: InboxProject[] = await Promise.all(catalog.projects.map(async project => {
      try {
        return { projectId: project.projectId, label: project.displayName,
          code: await resolveVivaryCodeProjectHistory(ctx, project.projectId) ?? null };
      } catch (error) {
        if (isAccessDenial(error)) throw error;
        return { projectId: project.projectId, label: project.displayName, code: null };
      }
    }));
    // Personal workspace Code history needs its configured folder. Without one, only its API chats are listed.
    const personal = await resolveWorkspace().catch(() => null);
    return loadConversationInbox({ ownerEmail, orgId, projects, personal });
  },
});
