import { defineAction } from "@agent-native/core/action";

import { projectEvaluateOwnerInputSchema } from "../app/lib/project-evaluate-schema.ts";
import { projectEvaluate } from "../server/project-evaluate.ts";

export default defineAction({
  description: "Evaluate one governed Vivary decide or control request in a selected registered project, as the owner or as this project's agent.",
  schema: projectEvaluateOwnerInputSchema,
  readOnly: false,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: (input, context) => projectEvaluate.forOwner(context, input),
});
