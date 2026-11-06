import { z } from "zod";
import type { CodexActionRequest } from "./code-execution-protocol";

export type CodexApprovalDecision = { allow: boolean; answers?: Record<string, string[]>; content?: Record<string, unknown> };
const record = z.record(z.string(), z.unknown());
const questions = z.array(z.object({ id: z.string(), question: z.string(), header: z.string().optional(),
  isSecret: z.boolean().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).nullable().optional() }));

export function codexApprovalResponse(request: CodexActionRequest, decision: CodexApprovalDecision): Record<string, unknown> {
  if (!supportsCodexRequest(request)) throw new Error("This Codex request is not supported by Vivary. The request was not approved.");
  const { method, params } = request;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: decision.allow ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: decision.allow ? record.parse(params.permissions) : {}, scope: "turn" };
  }
  if (method === "item/tool/requestUserInput") {
    const requested = questions.parse(params.questions);
    if (!decision.allow) return { answers: {} };
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of requested) {
      const values = decision.answers?.[question.id];
      if (!values?.length || values.some(value => !value.trim())) throw new Error("Answer each question before continuing.");
      answers[question.id] = { answers: values };
    }
    return { answers };
  }
  if (method === "mcpServer/elicitation/request") {
    if (!decision.allow) return { action: "decline" };
    if (params.mode === "url") return { action: "accept" };
    const schema = structuredClone(record.parse(params.requestedSchema));
    // Only values visible and submitted by the client may be returned to a tool.
    function removeDefaults(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value)) delete (value as Record<string, unknown>).default;
      Object.values(value).forEach(removeDefaults);
    }
    removeDefaults(schema);
    const content = z.fromJSONSchema(schema).parse(decision.content ?? {});
    return { action: "accept", content };
  }
  throw new Error("This Codex request is not supported. Stop the turn and check the runtime version.");
}

export function supportsCodexRequest(request: CodexActionRequest): boolean {
  if (request.method !== "mcpServer/elicitation/request") return ["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
    "item/permissions/requestApproval", "item/tool/requestUserInput"].includes(request.method);
  const { params } = request;
  if (params.mode === "url") return typeof params.url === "string" && /^https?:\/\//i.test(params.url);
  if (params.mode !== "form") return false;
  const parsed = record.safeParse(params.requestedSchema);
  if (!parsed.success || parsed.data.type !== "object") return false;
  const fields = record.safeParse(parsed.data.properties);
  if (!fields.success) return false;
  return Object.values(fields.data).every(raw => {
    const field = record.safeParse(raw);
    if (!field.success) return false;
    if (["string", "number", "integer", "boolean"].includes(String(field.data.type))) return true;
    if (field.data.type !== "array") return false;
    const items = record.safeParse(field.data.items);
    return items.success && (Array.isArray(items.data.enum) || Array.isArray(items.data.anyOf));
  });
}
