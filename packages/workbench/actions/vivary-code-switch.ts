import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProject } from "../server/code-project";
import { codeSwitchIdentitySchema, type CodeSwitchConsent } from "../shared/code-switch-observation";

import {
  requireVivaryCodeUser,
  switchVivaryCodeRuntime,
  VIVARY_CODE_ENGINES,
} from "../server/local-code-agent.ts";

const switchFields = {
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  runId: z.string().trim().min(1).max(128),
  engine: z.enum(VIVARY_CODE_ENGINES),
  model: z.string().trim().min(1).max(128),
  expectedSwitchGeneration: codeSwitchIdentitySchema,
};

export default defineAction({
  description: "Switch an idle local Vivary code conversation to another runtime or model.",
  schema: z.union([
    z.object({ ...switchFields, stop: z.literal(false).optional() }).strict(),
    z.object({ ...switchFields, stop: z.literal(true), expectedTurnId: codeSwitchIdentitySchema }).strict(),
  ]),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const consent: CodeSwitchConsent = input.stop === true
      ? { expectedSwitchGeneration: input.expectedSwitchGeneration, stop: true, expectedTurnId: input.expectedTurnId }
      : { expectedSwitchGeneration: input.expectedSwitchGeneration, stop: input.stop };
    return switchVivaryCodeRuntime({
      ownerEmail: requireVivaryCodeUser(ctx),
      orgId: ctx?.orgId ?? undefined,
      // Codex lists its models for the project folder, so a switch needs the folder, as a send does.
      workspace: await resolveVivaryCodeProject(ctx, input.projectId),
      revalidateWorkspace: input.projectId ? () => resolveVivaryCodeProject(ctx, input.projectId) : undefined,
      runId: input.runId,
      engine: input.engine,
      model: input.model,
      ...consent,
    });
  },
});
