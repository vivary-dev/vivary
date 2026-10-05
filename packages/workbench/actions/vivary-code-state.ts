import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProjectHistory, resolveVivaryCodeProjectDiscoveryRoot } from "../server/code-project";

import {
  getVivaryCodeHostState,
  getVivaryCodeState,
  requireVivaryCodeUser,
} from "../server/local-code-agent.ts";

export default defineAction({
  description: "Read the local workspace owner's local Vivary code runs and transcript.",
  schema: z.union([
    z.object({ scope: z.literal("host") }).strict(),
    z.object({
      projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
      runId: z.string().trim().min(1).max(128).optional(),
    }).strict(),
  ]),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId ?? undefined;
    if ("scope" in input) return getVivaryCodeHostState(ownerEmail, orgId);
    return getVivaryCodeState(
      ownerEmail,
      input.runId,
      await resolveVivaryCodeProjectHistory(ctx, input.projectId),
      orgId,
      await resolveVivaryCodeProjectDiscoveryRoot(ctx, input.projectId),
    );
  },
});
