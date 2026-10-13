import { codeSubscriptionFunding } from "../server/code-subscription-funding";
import { claudeCodeModelChoices } from "../shared/claude-models";
import { homedir } from "node:os";
import { getCodexModels } from "../server/codex-models";
import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { CLI_REGISTRY } from "@agent-native/core/terminal/server";
import { z } from "zod";

import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session.ts";
import { getVivaryRuntimeStatus, type VivaryRuntimeStatusResult } from "../server/local-runtime-setup.ts";

export default defineAction({
  description: "Check whether the local Claude Code and Codex runtimes are installed and signed in.",
  schema: z.object({ refresh: z.boolean().optional() }),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async ({ refresh }, ctx?: ActionRunContext): Promise<VivaryRuntimeStatusResult> => {
    if (ctx?.userEmail?.trim().toLowerCase() !== VIVARY_LOCAL_OWNER_EMAIL) {
      fail("Open Vivary on the computer where it is installed to check coding runtimes.", {
        errorCode: "vivary_runtime_owner_required",
        statusCode: 403,
      });
    }
    // guard:allow-env-credential - Deployment mode restricts local CLI status to the self-hosted owner.
    const mode = process.env.VIVARY_ACCESS_MODE;
    if (mode !== "local" && mode !== "private-proxy") {
      fail("Local coding runtimes are available in the self-hosted app.", {
        errorCode: "vivary_runtime_local_required",
        statusCode: 403,
      });
    }
    const [claude, codex] = await Promise.all([
      getVivaryRuntimeStatus("claude-cli", { refresh }),
      getVivaryRuntimeStatus("codex-cli", { refresh }),
    ]);
    const codexModels = codex.status === "ready" ? await getCodexModels(homedir(), { refresh }) : null;
    return { codexModels, claudeModels: claudeCodeModelChoices(claude.version), runtimes: [
      { engine: "claude-cli", label: CLI_REGISTRY.claude.label, ...claude, funding: codeSubscriptionFunding("claude-cli") },
      { engine: "codex-cli", label: CLI_REGISTRY.codex.label, ...codex, funding: codeSubscriptionFunding("codex-cli") },
    ] };
  },
});
