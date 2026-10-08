import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProject } from "../server/code-project";

import {
  requireVivaryCodeUser,
  sendVivaryCodeMessage,
  VIVARY_CODE_ENGINES,
} from "../server/local-code-agent.ts";
import { projectMemory } from "../server/project-memory.ts";
import { getCodeAgentRunRecord } from "@agent-native/core/code-agents";
import { linkedConversations } from "../server/linked-conversations";

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
  }),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async ({ message, model, engine, runId, projectId, draftSubmitId, draftThreadId }, ctx?: ActionRunContext) => {
    const workspace = await resolveVivaryCodeProject(ctx, projectId);
    const loadLinkedContext = runId && getCodeAgentRunRecord(runId)?.metadata?.linkedHistoryId
      ? () => linkedConversations.context(ctx, projectId ?? null, { kind: "code", id: runId }) : undefined;
    return sendVivaryCodeMessage({
      ownerEmail: requireVivaryCodeUser(ctx),
      orgId: ctx?.orgId ?? undefined,
      workspace,
      revalidateWorkspace: projectId ? () => resolveVivaryCodeProject(ctx, projectId) : undefined,
      // Rendered before the send's final checks, so no await sits between them and the host-slot claim.
      projectContext: workspace ? await projectMemory.renderForRun(workspace, "code") : undefined,
      recordProjectContext: workspace ? load => projectMemory.recordLoad(workspace, load, "code") : undefined,
      message,
      loadLinkedContext,
      model,
      engine,
      runId,
      draftSubmitId,
      draftThreadId,
    });
  },
});
