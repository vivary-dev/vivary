import { createHash } from "node:crypto";

export const PROJECT_CHAT_SCOPE_PREFIX = "vivary-project-chat-v2:";

/**
 * The scope id of one project's Native conversations. It excludes labels,
 * paths, and grant revisions, so renaming a project keeps its chats.
 */
export function projectChatScopeId(ownerEmail, orgId, projectId) {
  const key = createHash("sha256")
    .update(JSON.stringify([ownerEmail.trim().toLowerCase(), orgId, projectId])).digest("hex");
  return PROJECT_CHAT_SCOPE_PREFIX + key;
}
