import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";

import {
  requireVivaryCodeUser,
  stopVivaryCodeRun,
} from "../server/local-code-agent.ts";
import { restoreQueuedCodeDraft } from "../server/code-queue-draft";

export default defineAction({
  description: "Stop the local workspace owner's active local Vivary code run, or cancel its queued message.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    runId: z.string().trim().min(1).max(128),
  }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async ({ runId, projectId }, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId ?? undefined;
    return stopVivaryCodeRun({ ownerEmail, orgId, projectId, runId,
      onQueuedCancelled: cancelled => restoreQueuedCodeDraft(ownerEmail, orgId, cancelled) });
  },
});
