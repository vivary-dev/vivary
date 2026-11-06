import { defineAction } from "@agent-native/core/action";
import { projectPreviewInput } from "../shared/project-preview";
import { projectPreviewService } from "../server/project-preview";

export default defineAction({
  description: "Review, inspect, start, check, and stop a project-owned local page preview.",
  schema: projectPreviewInput,
  readOnly: false,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: (input, context) => projectPreviewService(input, context),
});
