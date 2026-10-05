import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { getDbExec } from "@agent-native/core/db";
import { listThreads } from "@agent-native/core/server";
import { createVivaryChatIdentity } from "../server/chat-identity";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { requireVivaryCodeUser } from "../server/local-code-agent";

export default defineAction({
  description: "Read an existing Native conversation match after owner, organization and project checks.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().default(null),
    unassigned: z.boolean().default(false),
    threadId: z.string().min(1).max(200), referenceId: z.string().min(1).max(200),
  }).strict().refine(input => !input.unassigned || input.projectId === null, "Unassigned history has no project."),
  http: { method: "GET" }, readOnly: true, requiresAuth: true,
  agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const owner = requireVivaryCodeUser(ctx), orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    const project = input.unassigned ? undefined : await resolveVivaryCodeProjectHistory(ctx, input.projectId ?? undefined);
    const identity = createVivaryChatIdentity(owner, orgId, input.unassigned ? { kind: "unassigned" }
      : { kind: "project", projectId: input.projectId, label: project?.label ?? "Personal workspace" });
    await listThreads(owner, { scope: identity.scope, orgId, includeExternal: false, limit: 1 });
    // Unlike Native's general thread route, this predicate checks the requested scope before returning the blob.
    const { rows } = await getDbExec().execute({ sql: `SELECT thread_data FROM chat_threads WHERE id = ?
      AND LOWER(owner_email) = ? AND (org_id = ? OR org_id IS NULL) AND scope_type = ? AND scope_id = ?
      AND source_platform IS NULL AND length(thread_data) <= ?`,
      args: [input.threadId, owner, orgId, identity.scope.type, identity.scope.id, 8 * 1024 * 1024] });
    const threadData = rows[0]?.thread_data;
    if (typeof threadData !== "string" || !JSON.parse(threadData).messages?.some((entry: { message?: { id?: string } }) =>
      entry.message?.id === input.referenceId)) fail("This matching message is no longer available. Search again.", { statusCode: 404 });
    return { threadData };
  },
});
