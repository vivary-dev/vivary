import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";

import {
  requireVivaryCodeUser,
  resolveVivaryCodeCleanup,
} from "../server/local-code-agent.ts";

// Issue #121. Only a signed-in person decides, never an agent, so no run can lift the refusal its own leftovers caused.
// `version` names the list the host strip showed, so the decision acts only on what the person saw.
export default defineAction({
  description: "End the coding processes that outlived an earlier run, or continue past them on the local workspace "
    + "owner's word.",
  schema: z.object({ decision: z.enum(["end", "continue"]), version: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async ({ decision, version }, ctx?: ActionRunContext) =>
    resolveVivaryCodeCleanup({
      ownerEmail: requireVivaryCodeUser(ctx),
      orgId: ctx?.orgId ?? undefined,
      decision,
      version,
    }),
});
