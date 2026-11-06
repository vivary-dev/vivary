import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";

import {
  denyVivaryCodeMessage,
  requireVivaryCodeUser,
} from "../server/local-code-agent.ts";

export default defineAction({
  description: "Decline a pending native Codex action or question.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    runId: z.string().trim().min(1).max(128),
    requestId: z.string().uuid(),
  }).strict(),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: ({ runId, requestId, projectId }, ctx?: ActionRunContext) =>
    denyVivaryCodeMessage({
      ownerEmail: requireVivaryCodeUser(ctx),
      orgId: ctx?.orgId ?? undefined,
      runId,
      requestId,
      projectId,
    }),
});
