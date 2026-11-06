import { defineAction } from "@agent-native/core/action";

import { projectReadOwnerInputSchema } from "../app/lib/project-read-schema.ts";
import { projectRead } from "../server/project-read.ts";

export default defineAction({
  description: "Read one Vivary report about a selected registered project for the Details panel.",
  schema: projectReadOwnerInputSchema,
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: (input, context) => projectRead.forOwner(context, input),
});
