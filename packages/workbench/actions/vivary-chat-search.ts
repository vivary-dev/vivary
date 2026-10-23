import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { chatSearchInputSchema } from "../app/lib/chat-search-schema";
import { createVivaryChatIdentity } from "../server/chat-identity";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { requireCatalogProject } from "../server/conversation-inbox";
import { requireVivaryCodeUser, resolveWorkspace, type VivaryCodeReadScope } from "../server/local-code-agent";
import { searchChatContent } from "../server/chat-content-search";
import { getLocalProjectAccess } from "../server/project-services.mjs";

const hasErrorCode = (error: unknown, code: string) =>
  !!error && typeof error === "object" && "errorCode" in error && error.errorCode === code;

type CatalogRead = { code: string; projects?: readonly { projectId: string; displayName: string }[] };

/**
 * The Code scope a search reads, or none, and the label its Native identity carries. A project whose Code history
 * cannot resolve still searches its API chats, which the page reports as Code unavailable, once the project is in the
 * owner's current catalog. Access denials still refuse the whole search.
 */
export async function chatSearchScope(input: { projectId: string | null; unassigned: boolean }, deps: {
  projectHistory: (projectId: string) => Promise<VivaryCodeReadScope | undefined>;
  workspace: () => Promise<VivaryCodeReadScope>; catalog: () => Promise<CatalogRead>;
}): Promise<{ codeScope: VivaryCodeReadScope | undefined; label: string }> {
  if (input.unassigned) return { codeScope: undefined, label: "Unassigned" };
  if (input.projectId) {
    try {
      const history = await deps.projectHistory(input.projectId);
      return { codeScope: history, label: history?.label ?? input.projectId };
    } catch (error) {
      if (!hasErrorCode(error, "vivary_code_project_history_unavailable")) throw error;
      const catalog = await deps.catalog();
      requireCatalogProject(catalog, input.projectId);
      const project = catalog.projects?.find(entry => entry.projectId === input.projectId);
      return { codeScope: undefined, label: project?.displayName ?? input.projectId };
    }
  }
  try {
    const workspace = await deps.workspace();
    return { codeScope: workspace, label: workspace.label };
  } catch (error) {
    if (!hasErrorCode(error, "vivary_code_workspace_unavailable")) throw error;
    return { codeScope: undefined, label: "Personal workspace" };
  }
}

export default defineAction({
  description: "Search this owner's retained conversation titles and messages in one project or unassigned history.",
  schema: chatSearchInputSchema,
  http: { method: "GET" }, readOnly: true, requiresAuth: true,
  agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    const { codeScope, label } = await chatSearchScope(input, {
      projectHistory: projectId => resolveVivaryCodeProjectHistory(ctx, projectId),
      workspace: () => resolveWorkspace(),
      catalog: () => getLocalProjectAccess(ctx),
    });
    const identity = createVivaryChatIdentity(ownerEmail, orgId, input.unassigned ? { kind: "unassigned" }
      : { kind: "project", projectId: input.projectId, label });
    return searchChatContent({ ownerEmail, orgId, identity, codeScope }, input, ctx?.signal);
  },
});
