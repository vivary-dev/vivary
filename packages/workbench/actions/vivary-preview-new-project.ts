import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { workspacePatternChoices, workspacePreset } from "../shared/workspace-patterns.ts";
import { previewManagedProject } from "../server/managed-projects.mjs";

export default defineAction({
  description: "Preview the exact guidance files for a new managed Vivary project.",
  schema: z.strictObject({ name: z.string().trim().min(1).max(128),
    patternChoices: workspacePatternChoices.optional(),
    preset: workspacePreset.optional() }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: async (input, context?: ActionRunContext) => {
    try {
      return await previewManagedProject(context, input);
    } catch (error) {
      fail(error instanceof Error ? error.message : "The project preview failed.", {
        statusCode: 409,
      });
    }
  },
});
