import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { workspacePatternChoices, workspacePreset } from "../shared/workspace-patterns.ts";
import { createManagedProject } from "../server/managed-projects.mjs";

export default defineAction({
  description: "Create and register the exact reviewed managed Vivary project.",
  schema: z.strictObject({
    name: z.string().trim().min(1).max(128),
    patternChoices: workspacePatternChoices.optional(),
    preset: workspacePreset.optional(),
    displayName: z.string().trim().min(1).max(200),
    acceptedPlanSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: async (input, context?: ActionRunContext) => {
    try {
      return await createManagedProject(context, input);
    } catch (error) {
      fail(error instanceof Error ? error.message : "The project could not be created.", {
        statusCode: 409,
      });
    }
  },
});
