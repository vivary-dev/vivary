import { defineAction, type ActionRunContext } from "@agent-native/core/action";

import { projectMemoryWriteInputSchema } from "../app/lib/project-memory-schema.ts";
import { projectMemory } from "../server/project-memory.ts";

// Owner write for remember, correct, and forget. An agent's statement is not a
// confirmed fact, so agents suggest facts in their reply and the owner saves them.
export default defineAction({
  description: "Remember, correct, or forget one sourced fact in a registered project's memory folder.",
  schema: projectMemoryWriteInputSchema,
  readOnly: false,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: (input, context?: ActionRunContext) => projectMemory.write(context, input),
});
