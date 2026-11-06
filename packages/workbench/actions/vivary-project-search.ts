import { defineAction, type ActionRunContext } from "@agent-native/core/action";

import { projectSearchInputSchema } from "../app/lib/project-search-schema.ts";
import { projectSearchService } from "../server/project-search.ts";

export default defineAction({
  description: "Search file names or text inside one selected registered local project within explicit limits.",
  schema: projectSearchInputSchema,
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  // Tool callers carry a request signal; browser callers do not, and rely on the caps.
  run: (input, context?: ActionRunContext) => projectSearchService.search(context, input, context?.signal),
});
