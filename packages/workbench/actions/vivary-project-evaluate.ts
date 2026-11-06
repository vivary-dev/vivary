import { defineAction } from "@agent-native/core/action";

import {
  PROJECT_EVALUATE_MAX_RESULT_CHARS, projectEvaluateToolAdvertisedSchema, projectEvaluateToolBoundarySchema,
} from "../app/lib/project-evaluate-schema.ts";
import { projectEvaluate, type createProjectEvaluate } from "../server/project-evaluate.ts";

export function defineProjectEvaluateTool(evaluations: ReturnType<typeof createProjectEvaluate>) {
  return defineAction({
    description: "Evaluate one governed Vivary request for the project this chat belongs to, as this project's agent with contributor authority. decide: the next loop step for a Task Capsule the owner handed over. Vivary cannot build a capsule, so without one the decision is Strato's refusal. claim: claim project-relative paths against the active claims you pass in. release: release one of your claims. expire_leases: drop expired leases from the active claims. dependencies: whether one task's dependencies are done. Vivary sets the actor, project, scope, authority, and clocks, and refuses input that names them. Pass back the state a previous call returned to continue. Vivary saves nothing. A result is an evaluation, not permission to run, edit, or start any work.",
    // The model sees the agent's fields. Validation keeps any other named field
    // so the server can refuse a server-owned one by name.
    schema: projectEvaluateToolBoundarySchema,
    agentInputSchema: projectEvaluateToolAdvertisedSchema,
    agentTool: true,
    mcpTool: false,
    http: false,
    toolCallable: false,
    // Control takes the project's write lock, so this is not a read.
    readOnly: false,
    dedupe: false,
    maxResultChars: PROJECT_EVALUATE_MAX_RESULT_CHARS,
    // Queue wait plus the command's own limit, with margin.
    timeoutMs: 70_000,
    run: (input, context) => evaluations.forChat(context, input),
  });
}

export default defineProjectEvaluateTool(projectEvaluate);
