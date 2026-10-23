import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { codeSendInput } from "../server/code-send-input";

import {
  sendVivaryCodeMessage,
  VIVARY_CODE_ENGINES,
} from "../server/local-code-agent.ts";

export default defineAction({
  description: "Start or continue the local workspace owner's local Vivary code run.",
  schema: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    message: z.string().trim().min(1).max(8_000),
    model: z.string().trim().min(1).max(128).optional(),
    engine: z.enum(VIVARY_CODE_ENGINES).optional(),
    runId: z.string().trim().min(1).max(128).optional(),
    draftSubmitId: z.string().uuid().optional(),
    draftThreadId: z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/).optional(),
    // The sender chose Proceed on the shared-folder warning. Without it, a send beside another agent refuses.
    acknowledgeSharedFolder: z.boolean().optional(),
  }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => sendVivaryCodeMessage(await codeSendInput(ctx, input)),
});
