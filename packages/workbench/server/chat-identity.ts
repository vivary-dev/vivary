import type { ChatThread } from "@agent-native/core/server";
import { vivaryChatScope, type VivaryChatIdentity } from "../app/lib/chat-scope";
import { projectChatScopeId } from "./chat-project-scope.mjs";

/** Identity excludes mutable labels, paths and grant revisions. Native still owns access and messages. */
export function createVivaryChatIdentity(
  ownerEmail: string,
  orgId: string,
  target: { kind: "unassigned" } | { kind: "project"; projectId: string | null; label: string },
): VivaryChatIdentity {
  const owner = ownerEmail.trim().toLowerCase();
  const legacyScope = vivaryChatScope(orgId);
  if (!owner || !legacyScope) throw new Error("The conversation owner could not be verified.");
  if (target.kind === "unassigned") {
    return { kind: "unassigned", projectId: null, scope: legacyScope,
      storageKey: `vivary-workbench-chat-v1:${encodeURIComponent(JSON.stringify([owner, orgId]))}` };
  }
  if (target.projectId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(target.projectId)) {
    throw new Error("Choose a registered project.");
  }
  const id = projectChatScopeId(owner, orgId, target.projectId);
  return { kind: "project", projectId: target.projectId,
    scope: { type: "workspace-app", id, label: target.label }, storageKey: id };
}

export function threadBelongsToChatIdentity(identity: VivaryChatIdentity,
  thread: Pick<ChatThread, "ownerEmail" | "orgId" | "scope">, ownerEmail: string, orgId: string): boolean {
  return thread.ownerEmail.toLowerCase() === ownerEmail.toLowerCase()
    && (thread.orgId === null || thread.orgId === orgId)
    && thread.scope?.type === identity.scope.type && thread.scope.id === identity.scope.id;
}
