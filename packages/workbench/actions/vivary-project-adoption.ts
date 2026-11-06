import { defineAction } from "@agent-native/core/action";
import { adoptionInput } from "../shared/project-adoption";
import { projectAdoptionService } from "../server/project-adoption";

export default defineAction({
  description: "Review existing-folder setup and explicitly approve the exact saved plan or recovery.",
  schema: adoptionInput,
  readOnly: false,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: (input, context) => projectAdoptionService(input, context),
});
