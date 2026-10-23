import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { setLocalProjectKind } from "../server/project-services.mjs";
import { workspaceKind } from "../shared/workspace-kind.ts";

export default defineAction({
  description: "Save the owner's Coding or Personal choice for a registered project.",
  schema: z.strictObject({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workspaceKind,
  }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: async (input, context) => {
    try {
      return await setLocalProjectKind(context, input.projectId, input.workspaceKind);
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown })?.statusCode;
      fail(error instanceof Error ? error.message : "The project kind could not be saved.", {
        statusCode: statusCode === 403 || statusCode === 404 ? statusCode : 409,
      });
    }
  },
});
