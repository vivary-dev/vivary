import path from "node:path";
import { defineAction, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProject } from "../server/code-project";
import { requireVivaryCodeUser, resolveWorkspace } from "../server/local-code-agent";

/**
 * The selected project's folder, for the owner's own screen. The shared project catalog stays without paths, because
 * it also reaches Remote access browsers that list projects.
 */
export default defineAction({
  description: "Read the folder of the owner's selected project or Personal workspace.",
  schema: z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict(),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    requireVivaryCodeUser(ctx);
    // guard:allow-env-credential - Deployment folder absence differs from an inaccessible configured folder.
    if (!input.projectId && !process.env.VIVARY_LOCAL_AGENT_WORKSPACE?.trim()) return null;
    const root = input.projectId ? (await resolveVivaryCodeProject(ctx, input.projectId))!.root
      : (await resolveWorkspace()).root;
    return { projectId: input.projectId ?? null, folderName: path.basename(root) || root, path: root };
  },
});
