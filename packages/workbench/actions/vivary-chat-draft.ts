import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { withThreadAdmissionLock } from "@agent-native/core/server";
import { createVivaryChatIdentity } from "../server/chat-identity";
import { assertCodeDraftConversationOpen, linkedCodeDraftRuns, requireVivaryCodeUser } from "../server/local-code-agent";
import { withCodeConversationAdmission } from "../server/conversation-admission";
import { resolveVivaryCodeProjectHistory } from "../server/code-project";
import { assertChatDraftThread, changeIndexedChatDraft, chatDraftNextSchema, chatDraftRecordSchema,
  createCodeDraftIdentity, listChatDrafts, listNativeChatDrafts, readIndexedChatDraft, reconcileChatDraft, reconcileCodeDraft } from "../server/chat-draft";

const threadId = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable();
const scope = z.object({ kind: z.enum(["project", "unassigned", "code"]), projectId, threadId }).strict();
export default defineAction({
  description: "Read or update this owner's conversation draft in Native application state.",
  schema: z.discriminatedUnion("operation", [
    scope.omit({ threadId: true }).extend({ operation: z.literal("list") }),
    scope.extend({ operation: z.literal("read") }),
    scope.extend({ operation: z.literal("reconcile") }),
    scope.extend({ operation: z.literal("change"), expected: chatDraftRecordSchema.nullable(),
      next: chatDraftNextSchema }),
  ]),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  audit: { recordInputs: false },
  run: async (input, ctx?: ActionRunContext) => {
    const owner = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId;
    if (!orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    if (input.kind === "code") {
      const project = input.projectId
        ? await resolveVivaryCodeProjectHistory(ctx, input.projectId)
        : undefined;
      const identity = createCodeDraftIdentity(owner, orgId, project?.projectId ?? null);
      if (input.operation === "list") {
        const drafts = await listChatDrafts(identity);
        const linked = linkedCodeDraftRuns(owner, orgId, project, drafts.map(draft => draft.threadId));
        return { drafts: drafts.map(draft => ({ ...draft, run: linked.get(draft.threadId) ?? null })) };
      }
      if (input.operation === "read") return { record: await readIndexedChatDraft(identity, input.threadId) };
      if (input.operation === "reconcile") return reconcileCodeDraft(identity, input.threadId, owner, orgId, project);
      if (input.next.status === "pending") {
        return withCodeConversationAdmission(owner, orgId, project?.projectId ?? null, async () => {
          assertCodeDraftConversationOpen(owner, orgId, project, input.threadId);
          return changeIndexedChatDraft(identity, input.threadId, input.expected, input.next);
        });
      }
      return changeIndexedChatDraft(identity, input.threadId, input.expected, input.next);
    }
    const target = input.kind === "unassigned"
      ? { kind: "unassigned" as const }
      : { kind: "project" as const, projectId: input.projectId,
        label: (await resolveVivaryCodeProjectHistory(ctx, input.projectId ?? undefined))?.label ?? "Personal workspace" };
    if (input.kind === "unassigned" && input.projectId !== null) fail("The conversation scope changed.", { statusCode: 400 });
    const identity = createVivaryChatIdentity(owner, orgId, target);
    if (input.operation === "list") return { drafts: await listNativeChatDrafts(identity, owner, orgId) };
    if (input.operation === "reconcile") return reconcileChatDraft(identity, input.threadId, owner, orgId);
    if (input.operation === "change" && input.next.status === "pending") {
      return withThreadAdmissionLock(input.threadId, async () => {
        const thread = await assertChatDraftThread(identity, input.threadId, owner, orgId);
        if (thread?.archivedAt != null) fail("Restore this conversation before sending a message.", {
          errorCode: "vivary_conversation_archived", statusCode: 409,
        });
        return changeIndexedChatDraft(identity, input.threadId, input.expected, input.next);
      });
    }
    await assertChatDraftThread(identity, input.threadId, owner, orgId);
    if (input.operation === "read") return { record: await readIndexedChatDraft(identity, input.threadId) };
    return changeIndexedChatDraft(identity, input.threadId, input.expected, input.next);
  },
});
