import { defineAction } from "@agent-native/core/action";
import { originalCommandSchema, runOriginalCommand } from "../server/original-runtime";

export default defineAction({
  description: "Preview one bounded original Vivary command in an authorized registered project. Create is always a dry run, and adopt and pattern-state are previews.",
  schema: originalCommandSchema,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: (input, context) => runOriginalCommand(input, context),
});
