import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";
import { resolveVivaryCodeProjectHistory, resolveVivaryCodeProjectDiscoveryRoot } from "../server/code-project";

import {
  getVivaryCodeHostState,
  getVivaryCodeState,
  requireVivaryCodeUser,
} from "../server/local-code-agent.ts";

export default defineAction({
  description: "Read the local workspace owner's local Vivary code runs and transcript.",
  schema: z.union([
    z.object({ scope: z.literal("host") }).strict(),
    z.object({
      projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
      runId: z.string().trim().min(1).max(128).optional(),
      // Core cannot infer GET coercion from this union schema. Parse only explicit boolean strings.
      unassigned: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
      eventId: z.string().min(1).max(200).optional(),
      eventOffset: z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()),
    }).strict().refine(input => (!input.unassigned || !input.projectId)
      && (input.eventId === undefined) === (input.eventOffset === undefined)
      && (!input.eventId || !!input.runId), "Choose a run and its matching event together."),
  ]),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const ownerEmail = requireVivaryCodeUser(ctx);
    const orgId = ctx?.orgId ?? undefined;
    if ("scope" in input) return getVivaryCodeHostState(ownerEmail, orgId);
    if ((input.unassigned || input.eventId) && !orgId) fail("The conversation owner could not be verified.", { statusCode: 403 });
    return getVivaryCodeState(
      ownerEmail,
      input.runId,
      input.unassigned ? { kind: "unassigned", label: "Unassigned" }
        : await resolveVivaryCodeProjectHistory(ctx, input.projectId),
      orgId,
      input.eventId || input.unassigned ? undefined : await resolveVivaryCodeProjectDiscoveryRoot(ctx, input.projectId),
      input.eventId ? { eventId: input.eventId, eventOffset: input.eventOffset! } : undefined,
    );
  },
});
