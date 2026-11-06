import { defineAction, fail, type ActionRunContext } from "@agent-native/core/action";
import {
  isPendingRunReview,
  resourceAcceptRunReviewIfCurrent,
  resourceDiscardRunReviewIfCurrent,
  resourceGet,
  resourceList,
} from "@agent-native/core/resources/store";
import { z } from "zod";

export type AutomationFile = { id: string; path: string; content: string; updatedAt: number };

// Proposed instruction and memory changes wait in Core while models keep the accepted version.
// Only the signed-in owner can accept or discard a proposal. The version identifies the text reviewed.
const reviewed = { id: z.string().min(1).max(200), updatedAt: z.number().int().nonnegative() };
export default defineAction({
  description: "List, accept, or discard proposed instruction and memory changes that automation runs wrote and that "
    + "wait for review.",
  schema: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("list") }).strict(),
    z.object({ operation: z.literal("accept"), ...reviewed }).strict(),
    z.object({ operation: z.literal("delete"), ...reviewed }).strict(),
  ]),
  requiresAuth: true, agentTool: false, mcpTool: false, toolCallable: false,
  run: async (input, ctx?: ActionRunContext) => {
    const owner = ctx?.userEmail;
    if (!owner) fail("Sign in again to review automation files.", { statusCode: 401 });
    if (input.operation === "list") {
      // Agent scratch rows too, because a run can write an instruction file as scratch.
      const waiting = (await resourceList(owner, undefined, { includeAgentScratch: true })).filter(isPendingRunReview);
      const files: AutomationFile[] = [];
      for (const row of waiting) {
        const resource = await resourceGet(row.id);
        if (resource?.owner === owner && isPendingRunReview(resource)) files.push({ id: resource.id, path: resource.path, content: resource.content, updatedAt: resource.updatedAt });
      }
      return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    }
    const resource = await resourceGet(input.id);
    if (!resource || resource.owner !== owner || !isPendingRunReview(resource)) {
      fail("This file is no longer waiting for review. Reload the list.", { statusCode: 404 });
    }
    // Both change the file only while it has the update time the list showed, so a write since then changes nothing.
    const done = input.operation === "accept"
      ? await resourceAcceptRunReviewIfCurrent({ id: resource.id, updatedAt: input.updatedAt, acceptedBy: owner })
      : await resourceDiscardRunReviewIfCurrent({ id: resource.id, owner, updatedAt: input.updatedAt });
    if (!done) fail("This file changed. Reload the list.", { statusCode: 409 });
    return input.operation === "accept" ? { accepted: true } : { deleted: true };
  },
});
