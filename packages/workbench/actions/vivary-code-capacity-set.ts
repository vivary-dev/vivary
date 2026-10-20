import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { codeRunCapacitySchema } from "../shared/code-run-capacity";
import { requireVivaryCodeUser, setVivaryCodeRunCapacity } from "../server/local-code-agent";

export default defineAction({
  description: "Set the host-wide limit on Code runs working at once, and whether a send beyond it queues or refuses.",
  schema: codeRunCapacitySchema,
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    requireVivaryCodeUser(ctx);
    return setVivaryCodeRunCapacity(input);
  },
});
