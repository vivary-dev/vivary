import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { codeSendInput } from "../server/code-send-input";
import { restoreQueuedCodeDraft } from "../server/code-queue-draft";
import {
  cancelQueuedVivaryCodeTurn, getVivaryCodeHostState, readQueuedVivaryCodeTurn, requireVivaryCodeUser,
  resumeQueuedVivaryCodeTurn,
} from "../server/local-code-agent";

export default defineAction({
  description: "Cancel a queued Code message, or start one that waits for the owner.",
  schema: z.object({
    operation: z.enum(["cancel", "start", "proceed"]),
    runId: z.string().trim().min(1).max(128),
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  }).strict(),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async ({ operation, runId, projectId }, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId ?? undefined;
    if (operation === "cancel") {
      // The message leaves the queue only after it is back in the draft, so a failed draft write loses nothing.
      const { restored } = await cancelQueuedVivaryCodeTurn({ ownerEmail, orgId, runId, projectId,
        restore: cancelled => restoreQueuedCodeDraft(ownerEmail, orgId, cancelled) });
      return { ...await getVivaryCodeHostState(ownerEmail, orgId), restored };
    }
    // Start and Proceed send the stored message again from this request, so every project check runs fresh.
    const stored = await readQueuedVivaryCodeTurn({ ownerEmail, orgId, runId, projectId });
    const input = await codeSendInput(ctx, { ...stored, projectId, runId });
    return resumeQueuedVivaryCodeTurn({ ...input, runId, proceed: operation === "proceed" });
  },
});
