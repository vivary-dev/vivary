import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@agent-native/toolkit/ui";
import { useNativeActionCaller, type NativeActionCaller } from "@/lib/native-actions";
import {
  AGENT_CONTROL_OPERATIONS, CONTROL_OPERATIONS, type ControlOperation, type EvaluateAs, type ProjectEvaluateResult,
} from "@/lib/project-evaluate-schema";
import {
  CONTROL_FIELDS, OPERATION_LABELS, STATE_SHAPE, actorLine, controlRequest, decideRequest, decisionOf, emptyControlDraft,
  emptyDecideDraft, isRecord, isRefusalDocument, isSuccessDecision, reasonCodes, refusalTitle, returnedState, shownOutput, type Built,
  type ControlDraft, type DecideDraft,
} from "@/lib/project-evaluate-form";

type EvaluateState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: ProjectEvaluateResult }
  | { kind: "error"; message: string };

const OWNER_ONLY = "Only you can run this, because it needs execution evidence Vivary cannot verify.";
const isAgentOperation = (operation: ControlOperation) => (AGENT_CONTROL_OPERATIONS as readonly string[]).includes(operation);

// Each section owns its request, and a response for an older request is dropped.
function useProjectEvaluate(call: NativeActionCaller, projectId: string) {
  const [state, setState] = useState<EvaluateState>({ kind: "idle" });
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  async function run(evaluateAs: EvaluateAs, built: Built) {
    const current = ++request.current;
    if (!built.ok) { setState({ kind: "error", message: built.message }); return; }
    setState({ kind: "running" });
    try {
      const result = await call<ProjectEvaluateResult>("vivary-project-evaluate-owner", { projectId, evaluateAs, ...built.input });
      if (request.current !== current) return;
      setState({ kind: "done", result });
    } catch (error) {
      if (request.current === current) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "The evaluation could not run. Try again." });
      }
    }
  }
  return { state, run };
}

function Refusal({ title, children }: { title: string; children: ReactNode }) {
  return <div role="alert" data-agent-native="project-evaluate-refusal" className="border-l-[3px] border-destructive pl-3">
    <p><strong className="text-destructive">{title}</strong></p>
    {children}
  </div>;
}

function Codes({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <p className="project-read-muted">No reason codes.</p>;
  return <>
    <p className="project-read-heading">Reason codes</p>
    <ul data-agent-native="project-evaluate-reason-codes">{codes.map((code, index) => <li key={index}><code>{code}</code></li>)}</ul>
  </>;
}

function Outcome({ state, action }: { state: EvaluateState; action?: (result: ProjectEvaluateResult) => ReactNode }) {
  if (state.kind === "idle") return null;
  if (state.kind === "running") return <p role="status">Evaluating…</p>;
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  const { result } = state;
  if (result.status === "unavailable") return <p role="alert">{result.message}</p>;
  if (result.status === "refused") {
    return <Refusal title={refusalTitle(result.reason)}>
      <p>{result.message}</p>
      {result.field && <p className="project-read-muted">Field: <code>{result.field}</code></p>}
    </Refusal>;
  }
  const output = isRecord(result.output) ? result.output : {};
  const policy = typeof output.policy_version === "string" ? output.policy_version : null;
  const schema = typeof output.schema === "string" ? output.schema : null;
  const codes = reasonCodes(result.output);
  const decision = decisionOf(result.output);
  // Every decision but a success is styled as an error. A Core refusal is
  // already announced below, so only its decision line skips the alert role.
  const failedDecision = decision !== null && !isSuccessDecision(decision);
  return <div data-agent-native="project-evaluate-result" data-refused-by={result.refusedBy ?? "none"}>
    <p><strong>{actorLine(result.evaluatedAs)}</strong></p>
    {decision && <p role={failedDecision && !result.refusedBy ? "alert" : undefined} data-agent-native="project-evaluate-decision"
      className={failedDecision ? "text-destructive" : undefined}>
      <strong>Decision: <code>{decision}</code></strong></p>}
    {(policy || schema) && <p className="project-read-muted">
      {policy && <>Policy version <code>{policy}</code></>}{policy && schema && " · "}{schema && <>Schema <code>{schema}</code></>}
    </p>}
    <p>{result.notice}</p>
    {result.refusedBy && <Refusal title={result.refusedBy === "strato" ? "Strato refused" : "Exo refused"}>
      <Codes codes={codes} /></Refusal>}
    {/* A refused result can still carry what the owner needs, such as a claim's conflicts. */}
    {!isRefusalDocument(result.output) && <div className="project-memory-preview">
      <pre data-agent-native="project-evaluate-output">{JSON.stringify(shownOutput(result.output), null, 2)}</pre>
    </div>}
    {!result.refusedBy && <Codes codes={codes} />}
    {action?.(result)}
  </div>;
}

type PanelProps = { projectId: string; disabled: boolean };

// Keyed by project, so another project's panel starts empty.
export function ProjectEvaluatePanel(props: PanelProps) {
  return <ProjectEvaluateSections key={props.projectId} {...props} />;
}

function ProjectEvaluateSections({ projectId, disabled }: PanelProps) {
  const { call, ready } = useNativeActionCaller();
  const ids = useId();
  const [evaluateAs, setEvaluateAs] = useState<EvaluateAs>("me");
  const [decideDraft, setDecideDraft] = useState<DecideDraft>(emptyDecideDraft);
  const [controlDraft, setControlDraft] = useState<ControlDraft>(emptyControlDraft);
  const decide = useProjectEvaluate(call, projectId);
  const control = useProjectEvaluate(call, projectId);

  const asMe = evaluateAs === "me";
  const { operation } = controlDraft;
  const ownerOnly = !asMe && !isAgentOperation(operation);
  const blocked = (state: EvaluateState) => disabled || !ready || state.kind === "running";
  const shape = STATE_SHAPE[operation];
  const fields = CONTROL_FIELDS[operation];
  const setDecide = (key: keyof DecideDraft) => (value: string) => setDecideDraft(draft => ({ ...draft, [key]: value }));
  const setControl = <Key extends keyof ControlDraft>(key: Key) => (value: ControlDraft[Key]) =>
    setControlDraft(draft => ({ ...draft, [key]: value }));

  function submitDecide(event: FormEvent) {
    event.preventDefault();
    void decide.run(evaluateAs, decideRequest(decideDraft, evaluateAs));
  }
  function submitControl(event: FormEvent) {
    event.preventDefault();
    if (!ownerOnly) void control.run(evaluateAs, controlRequest(controlDraft));
  }

  const decideText = (key: keyof DecideDraft, label: string, rows: number, hint?: string) => <>
    <label htmlFor={`${ids}-decide-${key}`}>{label}</label>
    {hint && <p className="project-read-muted">{hint}</p>}
    <textarea id={`${ids}-decide-${key}`} rows={rows} value={decideDraft[key]} spellCheck={false} autoComplete="off"
      onChange={event => setDecide(key)(event.target.value)} />
  </>;
  const decideCount = (key: keyof DecideDraft, label: string) => <>
    <label htmlFor={`${ids}-decide-${key}`}>{label}</label>
    <input id={`${ids}-decide-${key}`} type="number" inputMode="numeric" min={0} step={1} value={decideDraft[key]}
      onChange={event => setDecide(key)(event.target.value)} />
  </>;
  const controlText = (key: "lease" | "receipt" | "capsule" | "paths", label: string, rows: number, hint?: string) => <>
    <label htmlFor={`${ids}-control-${key}`}>{label}</label>
    {hint && <p className="project-read-muted">{hint}</p>}
    <textarea id={`${ids}-control-${key}`} rows={rows} value={controlDraft[key]} spellCheck={false} autoComplete="off"
      onChange={event => setControl(key)(event.target.value)} />
  </>;
  const controlLine = (key: "claim_id" | "task_id" | "workspace_revision", label: string) => <>
    <label htmlFor={`${ids}-control-${key}`}>{label}</label>
    <input id={`${ids}-control-${key}`} value={controlDraft[key]} spellCheck={false} autoComplete="off"
      onChange={event => setControl(key)(event.target.value)} />
  </>;

  const returnedStateAction = (result: ProjectEvaluateResult) => {
    const returned = returnedState(result);
    if (!returned) return null;
    return <div className="project-memory-actions">
      <Button type="button" size="sm" variant="outline" data-agent-native="project-evaluate-use-state"
        onClick={() => setControlDraft(draft => ({ ...draft, states: { ...draft.states, [returned.shape]: returned.text },
          ...(returned.claimId ? { claim_id: returned.claimId } : {}) }))}>Use this state</Button>
    </div>;
  };

  return <div data-agent-native="project-evaluate">
    <section className="project-read-section" aria-labelledby={`${ids}-evaluate`}>
      <h4 id={`${ids}-evaluate`}>Evaluate</h4>
      <p className="project-read-muted">Checks a request against Vivary policy. Nothing is saved, authorized, or started.</p>
      <fieldset className="project-read-form" data-agent-native="project-evaluate-as">
        <legend>Evaluate as</legend>
        <label className="project-read-check"><input type="radio" name={`${ids}-as`} value="me" checked={asMe}
          onChange={() => setEvaluateAs("me")} /> Me</label>
        <label className="project-read-check"><input type="radio" name={`${ids}-as`} value="agent" checked={!asMe}
          onChange={() => setEvaluateAs("agent")} /> This project's agent</label>
      </fieldset>
    </section>

    <section className="project-read-section" aria-labelledby={`${ids}-decide`} aria-busy={decide.state.kind === "running"}>
      <h4 id={`${ids}-decide`}>Decide</h4>
      <form className="project-memory-form" onSubmit={submitDecide} data-agent-native="project-evaluate-decide">
        {decideText("capsule", "Task Capsule JSON", 6, "Paste the capsule exactly as it was handed over.")}
        {decideCount("turns_used", "Turns used (optional)")}
        {decideCount("actions_used", "Actions used (optional)")}
        {decideCount("max_turns", "Max turns (optional)")}
        {decideCount("max_actions", "Max actions (optional)")}
        {asMe && decideText("receipt", "Receipt JSON (optional)", 3, "Caller-provided evidence. Vivary does not verify it.")}
        {asMe && decideText("verdict", "Verdict JSON (optional)", 3)}
        <div className="project-memory-actions">
          <Button type="submit" size="sm" disabled={blocked(decide.state)} data-agent-native="project-evaluate-decide-run">Evaluate decision</Button>
        </div>
      </form>
      <Outcome state={decide.state} />
    </section>

    <section className="project-read-section" aria-labelledby={`${ids}-control`} aria-busy={control.state.kind === "running"}>
      <h4 id={`${ids}-control`}>Control</h4>
      <form className="project-memory-form" onSubmit={submitControl} data-agent-native="project-evaluate-control">
        <div className="project-read-form">
          <label htmlFor={`${ids}-operation`}>Operation</label>
          <select id={`${ids}-operation`} value={operation} data-agent-native="project-evaluate-operation"
            onChange={event => setControl("operation")(event.target.value as ControlOperation)}>
            {CONTROL_OPERATIONS.map(entry => <option key={entry} value={entry} disabled={!asMe && !isAgentOperation(entry)}>
              {OPERATION_LABELS[entry]}{!asMe && !isAgentOperation(entry) ? " (only you)" : ""}</option>)}
          </select>
        </div>
        {ownerOnly ? <p role="note" data-agent-native="project-evaluate-owner-only">{OWNER_ONLY}</p> : <>
          <label htmlFor={`${ids}-control-state`}>State JSON</label>
          <textarea id={`${ids}-control-state`} rows={4} value={controlDraft.states[shape]} spellCheck={false} autoComplete="off"
            onChange={event => setControlDraft(draft => ({ ...draft, states: { ...draft.states, [shape]: event.target.value } }))} />
          {fields.includes("paths") && controlText("paths", "Paths to claim", 3, "One project-relative path per line, such as src/api. Use . for the whole project.")}
          {fields.includes("lease") && controlText("lease", "Lease JSON (optional)", 3, "For example {\"granted_at\": \"…\", \"expires_at\": \"…\"}.")}
          {fields.includes("claim_id") && controlLine("claim_id", "Claim id")}
          {fields.includes("task_id") && controlLine("task_id", "Task id")}
          {fields.includes("receipt") && controlText("receipt", "Receipt JSON", 3, "Caller-provided evidence. Vivary does not verify it.")}
          {fields.includes("capsule") && controlText("capsule", "Task Capsule JSON", 4)}
          {fields.includes("to_actor") && <div className="project-read-form">
            <label htmlFor={`${ids}-control-to`}>Hand off to</label>
            <select id={`${ids}-control-to`} value={controlDraft.to_actor}
              onChange={event => setControl("to_actor")(event.target.value as EvaluateAs)}>
              <option value="agent">This project's agent</option>
              <option value="me">Me</option>
            </select>
          </div>}
          {fields.includes("workspace_revision") && controlLine("workspace_revision", "Workspace revision")}
        </>}
        <div className="project-memory-actions">
          <Button type="submit" size="sm" disabled={blocked(control.state) || ownerOnly} data-agent-native="project-evaluate-control-run">
            Evaluate {OPERATION_LABELS[operation].toLowerCase()}</Button>
        </div>
      </form>
      <Outcome state={control.state} action={returnedStateAction} />
    </section>
  </div>;
}
