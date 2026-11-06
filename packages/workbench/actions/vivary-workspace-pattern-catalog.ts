import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { installedPatternCatalog } from "../server/managed-projects.mjs";
import { workspacePatternCatalog } from "../shared/workspace-patterns.ts";

export default defineAction({
  description: "List installed guidance choices for a managed Vivary project.",
  schema: z.strictObject({}),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: async (_input, context?: ActionRunContext) => {
    try {
      return workspacePatternCatalog.parse(await installedPatternCatalog(context));
    } catch (error) {
      fail(error instanceof Error ? error.message : "The installed guidance is unavailable.", {
        statusCode: 409,
      });
    }
  },
});
