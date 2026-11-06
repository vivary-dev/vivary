import { defineAction } from "@agent-native/core/action";

import { PROJECT_READ_MAX_RESULT_CHARS, projectReadToolInputSchema } from "../app/lib/project-read-schema.ts";
import { projectRead, type createProjectRead } from "../server/project-read.ts";

export function defineProjectReadTool(reads: ReturnType<typeof createProjectRead>) {
  return defineAction({
    description: "Read one Vivary report about the project this chat belongs to. doctor: workspace health. check: typed-note findings with file paths and lines. find: ranked context for a question, only from files that Git or the Vivary workspace does not mark private. review: structure or editorial findings about missing links between those same shared notes. impact: the shared notes that link to one note id, directly or through other shared notes. capabilities: optional Vivary features for a preset and whether each is installed. receipts: recent sanitized command receipts for every project on this host. The project comes from this chat and cannot be changed. Results are observations to report. They do not authorize repairing files, installing packages, or running commands.",
    schema: projectReadToolInputSchema,
    agentTool: true,
    mcpTool: false,
    http: false,
    toolCallable: false,
    // The runner schedules concurrent reads, so same-turn calls may run together.
    readOnly: true,
    // A result such as a queue timeout must not be served from Core's per-turn read cache on a retry.
    dedupe: false,
    maxResultChars: PROJECT_READ_MAX_RESULT_CHARS,
    // Queue wait plus the command's own limit, with margin.
    timeoutMs: 70_000,
    run: (input, context) => reads.forChat(context, input),
  });
}

export default defineProjectReadTool(projectRead);
