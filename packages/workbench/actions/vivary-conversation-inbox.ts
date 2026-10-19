import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { loadConversationInbox, type InboxProject } from "../server/conversation-inbox";
import { requireVivaryCodeUser, resolveWorkspace } from "../server/local-code-agent";
import { getLocalProjectAccess } from "../server/project-services.mjs";
import type { ProjectCatalog } from "../app/lib/project-catalog-schema";

function isAccessDenial(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error
    && (error.statusCode === 401 || error.statusCode === 403);
}

/**
 * Project history scopes by owner and catalog revision. The list polls every two seconds while visible, and each scope
 * costs a registry read. A catalog change (registration, rebinding, a grant change) changes the key, so a stale scope
 * is never reused. The catalog read before it still checks access on every call.
 */
const scopeCache = new Map<string, Promise<InboxProject[]>>();
const MAX_CACHED_SCOPES = 8;

function catalogKey(ownerEmail: string, orgId: string, catalog: ProjectCatalog): string {
  return JSON.stringify([ownerEmail, orgId, catalog.scopeKey, catalog.policyRevision, catalog.registryRevision,
    catalog.projects.map(project => [project.projectId, project.displayName, project.bindingRevision])]);
}

function resolveProjects(ctx: ActionRunContext | undefined, ownerEmail: string, orgId: string,
  catalog: ProjectCatalog): Promise<InboxProject[]> {
  const key = catalogKey(ownerEmail, orgId, catalog);
  const cached = scopeCache.get(key);
  if (cached) return cached;
  // A project whose registry binding cannot resolve keeps its API chats. Its Code history is reported unavailable
  // rather than failing the whole list.
  const resolved = Promise.all(catalog.projects.map(async project => {
    try {
      return { projectId: project.projectId, label: project.displayName,
        code: await resolveVivaryCodeProjectHistory(ctx, project.projectId) ?? null };
    } catch (error) {
      if (isAccessDenial(error)) throw error;
      return { projectId: project.projectId, label: project.displayName, code: null };
    }
  }));
  scopeCache.set(key, resolved);
  // A failed or partly unavailable resolution is not kept, so the next poll retries it.
  const forget = () => { if (scopeCache.get(key) === resolved) scopeCache.delete(key); };
  resolved.then(projects => { if (projects.some(project => !project.code)) forget(); }, forget);
  while (scopeCache.size > MAX_CACHED_SCOPES) scopeCache.delete(scopeCache.keys().next().value!);
  return resolved;
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
    const projects = await resolveProjects(ctx, ownerEmail, orgId, catalog);
    // Personal workspace Code history needs its configured folder. Without one, only its API chats are listed.
    const personal = await resolveWorkspace().catch(() => null);
    return loadConversationInbox({ ownerEmail, orgId, projects, personal });
  },
});
