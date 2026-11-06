import { useState } from "react";
import type { VivaryCodePendingApproval } from "../../../server/local-code-agent";

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown) => typeof value === "string" ? value : "";
export function requestTitle(method: string) {
  if (method.includes("commandExecution")) return "Allow this command?";
  if (method.includes("fileChange")) return "Allow these file changes?";
  if (method.includes("permissions")) return "Allow additional access for this turn?";
  return "Codex needs your response";
}
export function CodexRequestFields({ request, answers, content, setAnswers, setContent }: {
  request: VivaryCodePendingApproval; answers: Record<string, string[]>; content: Record<string, unknown>;
  setAnswers: (value: Record<string, string[]>) => void; setContent: (value: Record<string, unknown>) => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const params = request.params;
  const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
  const schema = object(params.requestedSchema);
  const fields = object(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const item = object(params.item);
  const changes = Array.isArray(item.changes) ? item.changes.map(object) : [];
  const url = text(params.url);
  const safeUrl = /^https?:\/\//i.test(url) ? url : undefined;
  return <div className="space-y-3">
    {text(params.agentThreadId) && <p className="text-xs text-muted-foreground" title={text(params.agentThreadId)}>Subagent {text(params.agentThreadId).slice(0, 10)}</p>}
    {text(params.reason) && <p>{text(params.reason)}</p>}
    {text(params.message) && <p>{text(params.message)}</p>}
    {text(params.command) && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/10 p-3 text-xs">{text(params.command)}</pre>}
    {text(params.cwd) && <p className="break-all text-xs text-muted-foreground">Folder: {text(params.cwd)}</p>}
    {changes.map((change, index) => <details key={index} open><summary className="break-all">{text(change.path)}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/10 p-3 text-xs">{text(change.diff)}</pre></details>)}
    {text(params.grantRoot) && <p className="break-all">Allow access to: {text(params.grantRoot)}</p>}
    {params.networkApprovalContext != null && <p className="break-all">Network: {text(object(params.networkApprovalContext).host)} {text(object(params.networkApprovalContext).protocol)}</p>}
    {params.additionalPermissions != null && <details open><summary>Additional access requested</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(params.additionalPermissions, null, 2)}</pre></details>}
    {params.permissions != null && <details open><summary>Requested access</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(params.permissions, null, 2)}</pre></details>}
    {safeUrl && <div className="space-y-2">
      <p>Open this link in your browser to continue with {text(params.serverName) || "the connection"}, then return here.</p>
      <p className="select-all break-all text-xs">{safeUrl}</p>
      <button type="button" className="rounded-md border px-3 py-1" onClick={() => {
        void navigator.clipboard.writeText(safeUrl).then(() => setCopyStatus("Link copied.")).catch(() => setCopyStatus("Select and copy the link above."));
      }}>Copy link</button><span role="status" className="ml-2 text-xs">{copyStatus}</span>
    </div>}
    {questions.map(question => <label key={text(question.id)} className="block space-y-2">
      <span>{text(question.question)}</span>
      {Array.isArray(question.options) && <div className="flex flex-wrap gap-2">{question.options.map(object).map(option =>
        <button type="button" key={text(option.label)} className="rounded-md border px-3 py-1 text-xs" title={text(option.description)}
          onClick={() => setAnswers({ ...answers, [text(question.id)]: [text(option.label)] })}>{text(option.label)}</button>)}</div>}
      <input aria-label={text(question.question)} type={question.isSecret ? "password" : "text"} className="w-full rounded-md border bg-background px-3 py-2"
        value={answers[text(question.id)]?.[0] ?? ""} onChange={event => setAnswers({ ...answers, [text(question.id)]: [event.target.value] })} />
    </label>)}
    {Object.entries(fields).map(([key, raw]) => {
      const field = object(raw);
      const choices = Array.isArray(field.enum) ? field.enum.map(value => ({ value: text(value), label: text(value) }))
        : Array.isArray(field.oneOf) ? field.oneOf.map(object).map(choice => ({ value: text(choice.const), label: text(choice.title) || text(choice.const) })) : [];
      const itemSchema = object(field.items);
      const multiChoices = Array.isArray(itemSchema.enum) ? itemSchema.enum.map(value => ({ value: text(value), label: text(value) }))
        : Array.isArray(itemSchema.anyOf) ? itemSchema.anyOf.map(object).map(choice => ({ value: text(choice.const), label: text(choice.title) || text(choice.const) })) : [];
      return <label key={key} className="block space-y-1"><span>{text(field.title) || key}{required.includes(key) ? " *" : ""}</span>
        {text(field.description) && <span className="block text-xs text-muted-foreground">{text(field.description)}</span>}
        {field.type === "array" ? <select multiple className="w-full rounded-md border bg-background px-3 py-2"
          value={Array.isArray(content[key]) ? content[key].filter((value): value is string => typeof value === "string") : []}
          onChange={event => setContent({ ...content, [key]: Array.from(event.target.selectedOptions, option => option.value) })}>
          {multiChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
          : field.type === "boolean" ? <input type="checkbox" className="ml-2 size-4 align-middle" checked={content[key] === true} onChange={event => setContent({ ...content, [key]: event.target.checked })} />
          : choices.length ? <select className="w-full rounded-md border bg-background px-3 py-2" value={text(content[key])} onChange={event => setContent({ ...content, [key]: event.target.value })}>
            <option value="">Choose an option</option>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
          : <input className="w-full rounded-md border bg-background px-3 py-2" type={field.type === "number" || field.type === "integer" ? "number" : "text"}
            value={typeof content[key] === "number" ? content[key] : text(content[key])} onChange={event => setContent({ ...content, [key]: field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value })} />}
      </label>;
    })}
  </div>;
}
