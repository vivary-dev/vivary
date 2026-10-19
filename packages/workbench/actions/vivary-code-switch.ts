import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProject } from "../server/code-project";

import {
  requireVivaryCodeUser,
  switchVivaryCodeRuntime,
  VIVARY_CODE_ENGINES,
} from "../server/local-code-agent.ts";

export default defineAction({
  description: "Switch an idle local Vivary code conversation to another runtime or model.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    runId: z.string().trim().min(1).max(128),
    engine: z.enum(VIVARY_CODE_ENGINES),
    model: z.string().trim().min(1).max(128),
  }).strict(),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async ({ runId, engine, model, projectId }, ctx?: ActionRunContext) => switchVivaryCodeRuntime({
    ownerEmail: requireVivaryCodeUser(ctx),
    orgId: ctx?.orgId ?? undefined,
    // Codex lists its models for the project folder, so a switch needs the folder, as a send does.
    workspace: await resolveVivaryCodeProject(ctx, projectId),
    runId,
    engine,
    model,
  }),
});
