import type { ActionRunContext } from "@agent-native/core/action";
import { resolveVivaryCodeProject } from "./code-project";
import { requireVivaryCodeUser, type VivaryCodeSendInput } from "./local-code-agent.ts";
import type { VivaryCodeEngine } from "./local-runtime-setup";
import { projectMemory } from "./project-memory.ts";
import { linkedConversations } from "./linked-conversations";

/**
 * The send input for one owner request. Its closures read the project grant and the linked history again, so a queued
 * turn that starts later in the same process checks them fresh. The project context is the one loaded with the request.
 */
export async function codeSendInput(ctx: ActionRunContext | undefined, params: {
  projectId?: string; message: string; model?: string; engine?: VivaryCodeEngine; runId?: string;
  draftSubmitId?: string; draftThreadId?: string; acknowledgeSharedFolder?: boolean;
}): Promise<VivaryCodeSendInput> {
  const { projectId, runId } = params;
  const workspace = await resolveVivaryCodeProject(ctx, projectId);
  return {
    ...params,
    ownerEmail: requireVivaryCodeUser(ctx),
    orgId: ctx?.orgId ?? undefined,
    workspace,
    revalidateWorkspace: projectId ? () => resolveVivaryCodeProject(ctx, projectId) : undefined,
    // Rendered before the send's final checks, so no await sits between them and the host-slot claim.
    projectContext: workspace ? await projectMemory.renderForRun(workspace, "code") : undefined,
    recordProjectContext: workspace ? load => projectMemory.recordLoad(workspace, load, "code") : undefined,
    loadLinkedContext: linkedConversations.codeSendLinkedContext(ctx, projectId ?? null, runId),
  };
}
