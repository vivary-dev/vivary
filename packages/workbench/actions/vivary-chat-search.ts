import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { chatSearchInputSchema } from "../app/lib/chat-search-schema";
import { createVivaryChatIdentity } from "../server/chat-identity";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { requireVivaryCodeUser, resolveWorkspace, type VivaryCodeReadScope } from "../server/local-code-agent";
import { searchChatContent } from "../server/chat-content-search";

export default defineAction({
  description: "Search this owner's retained conversation titles and messages in one project or unassigned history.",
  schema: chatSearchInputSchema,
  http: { method: "GET" }, readOnly: true, requiresAuth: true,
  agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    const history = input.unassigned ? undefined : await resolveVivaryCodeProjectHistory(ctx, input.projectId ?? undefined);
    let codeScope: VivaryCodeReadScope | undefined = history;
    if (!input.unassigned && !history) {
      try { codeScope = await resolveWorkspace(); }
      catch (error) {
        if (!(error && typeof error === "object" && "errorCode" in error && error.errorCode === "vivary_code_workspace_unavailable")) throw error;
      }
    }
    const identity = createVivaryChatIdentity(ownerEmail, orgId, input.unassigned ? { kind: "unassigned" }
      : { kind: "project", projectId: input.projectId, label: codeScope?.label ?? "Personal workspace" });
    return searchChatContent({ ownerEmail, orgId, identity, codeScope }, input, ctx?.signal);
  },
});
