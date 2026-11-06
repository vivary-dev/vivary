import { defineAction, type ActionRunContext } from "@agent-native/core/action";

import { projectMemoryInputSchema } from "../app/lib/project-memory-schema.ts";
import { projectMemory } from "../server/project-memory.ts";

// Owner read for the Details panel. Full chat receives project memory through
// extraContext, so this is not an agent tool.
export default defineAction({
  description: "Show where a registered project's memory is stored, its role assignments, its facts, and the exact context the next message receives.",
  schema: projectMemoryInputSchema,
  // It may run the creator bridge once to read settings. It never writes.
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: ({ projectId }, context?: ActionRunContext) => projectMemory.view(context, projectId),
});
