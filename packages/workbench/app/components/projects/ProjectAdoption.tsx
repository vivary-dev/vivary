import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@agent-native/toolkit/ui";
import { useNativeActionCaller } from "@/lib/native-actions";
import { adoptionResult, adoptionPreset, type AdoptionInput, type AdoptionResult,
  type AdoptionPreset } from "../../../shared/project-adoption";
import { workspacePatternState, type WorkspacePatternChoice,
  type WorkspacePatternDefinition } from "../../../shared/workspace-patterns.ts";
import { WorkspacePatternChoices } from "./WorkspacePatternChoices";

const operationLabel = { create: "Create", patch: "Append managed block", replace: "Replace reviewed file" };
const recoveryLabel = { "no-op": "Keep", restore: "Restore original", "delete-created": "Remove setup-created file" };

export function ProjectAdoption({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const { call, ready } = useNativeActionCaller();
  const [state, setState] = useState<AdoptionResult>({ code: "idle" });
  const [preset, setPreset] = useState<AdoptionPreset>("auto");
  const [working, setWorking] = useState(false);
  const [catalog, setCatalog] = useState<WorkspacePatternDefinition[] | null>(null);
  const [patternStatePending, setPatternStatePending] = useState(true);
  const [patternChoices, setPatternChoices] = useState<WorkspacePatternChoice[]>([]);
  const [message, setMessage] = useState<string>();
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    setState({ code: "idle" });
    setMessage(undefined);
    setWorking(false);
    setCatalog(null);
    setPatternChoices([]);
    setPatternStatePending(true);
    if (ready && !disabled) {
      void (async () => {
        let reviewedChoices: WorkspacePatternChoice[] | undefined;
        try {
          const value = await call<unknown>("vivary-project-adoption",
            { operation: "resume", projectId });
          if (request.current !== current) return;
          const result = adoptionResult.parse(value);
          setState(result);
          if ("preset" in result) setPreset(result.preset);
          if ("patternChoices" in result && result.patternChoices) {
            reviewedChoices = result.patternChoices;
            setPatternChoices(reviewedChoices);
          }
        } catch (error) {
          if (request.current === current) {
            setMessage(error instanceof Error ? error.message : "Setup status is unavailable.");
          }
        }
        if (request.current !== current) return;
        try {
          const output = await call<{ stdout: string; exitCode: number | null }>(
            "vivary-original-command", { projectId, command: { verb: "pattern-state" } });
          if (request.current !== current || output.exitCode !== 0) return;
          const value = workspacePatternState.parse(JSON.parse(output.stdout));
          setCatalog(value.catalog);
          if (!reviewedChoices) setPatternChoices(value.choices);
        } catch { /* A folder without a thin workspace still uses setup. */ }
        finally {
          if (request.current === current) setPatternStatePending(false);
        }
      })();
    }
    return () => { request.current += 1; };
  }, [projectId, ready, disabled, call]);

  async function perform(input: AdoptionInput) {
    const current = ++request.current;
    setWorking(true);
    setMessage(undefined);
    if (input.operation === "prepare-privacy" && state.code === "preview") {
      setState({ ...state, code: "privacy-pending", message: "Checking the reviewed ignore-file change…" });
    }
    if (input.operation === "apply" && state.code === "preview") {
      setState({ ...state, code: "pending", message: "Checking the approved setup request…" });
    }
    try {
      const result = adoptionResult.parse(await call<unknown>("vivary-project-adoption", input));
      if (request.current === current) {
        setState(result);
        if (result.code === "applied" || result.code === "recovered") {
          void call<{ stdout: string; exitCode: number | null }>("vivary-original-command",
            { projectId, command: { verb: "pattern-state" } }).then(output => {
            if (request.current !== current || output.exitCode !== 0) return;
            const value = workspacePatternState.parse(JSON.parse(output.stdout));
            setCatalog(value.catalog);
            setPatternChoices(value.choices);
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      if (request.current === current) {
        setMessage(error instanceof Error ? error.message : "The response was lost. Retry the same request to check its result.");
        try {
          const resumed = adoptionResult.parse(await call<unknown>("vivary-project-adoption", { operation: "resume", projectId }));
          if (request.current === current) setState(resumed);
        } catch { /* Keep the original request visible when its status is also unavailable. */ }
      }
    } finally {
      if (request.current === current) setWorking(false);
    }
  }

  const review = state.code === "preview" || state.code === "pending" || state.code === "privacy-pending" || state.code === "recovery-preview" ? state : null;
  const pending = state.code === "pending" || state.code === "privacy-pending" || state.code === "recovery-preview";
  const preparePrivacy = Boolean(review?.report.privacy_preparation?.required);
  const reviewedFiles = review?.report.content_plan.files.filter(file => !preparePrivacy || file.path === ".gitignore") ?? [];
  const unavailable = disabled || !ready || working;
  const approval = review ? { projectId, operationId: review.operationId, acceptedPlanHash: review.planHash } : null;

  return <section className="project-adoption" aria-label="Vivary setup" aria-busy={working}>
    <h4>Vivary setup</h4>
    <p>Review the exact guidance files before authorizing changes to this folder. Preview and Cancel change no project files.</p>
    {!pending && !patternStatePending && <>
      {!catalog && <>
      <label htmlFor="adoption-preset">Workspace type</label>
      <select id="adoption-preset" value={preset} disabled={unavailable} onChange={event => {
        request.current += 1;
        setPreset(adoptionPreset.parse(event.target.value));
        setState({ code: "idle" });
        setMessage(undefined);
      }}>
        <option value="auto">Detect from folder</option>
        <option value="coding">Coding</option>
        <option value="second-brain">Second brain</option>
        <option value="knowledge-work">Knowledge work</option>
        <option value="writing">Writing</option>
      </select>
      <Button size="sm" variant="outline" disabled={unavailable}
        onClick={() => void perform({ operation: "preview", projectId, preset })}>
        {working ? "Preparing preview…" : state.code === "privacy-prepared" ? "Review Vivary setup" : state.code === "idle" ? "Preview Vivary setup" : "Refresh preview"}
      </Button>
      </>}
      {catalog && <div className="mb-3">
        <WorkspacePatternChoices catalog={catalog} value={patternChoices}
          disabled={unavailable} onChange={next => {
            request.current += 1;
            setPatternChoices(next);
            setState({ code: "idle" });
            setMessage(undefined);
          }} />
        <Button size="sm" variant="outline" disabled={unavailable}
          onClick={() => void perform({ operation: "preview", projectId, preset: "auto",
            patternChoices })}>Review guidance change</Button>
      </div>}
    </>}
    {message && <p role="alert">{message}</p>}
    {state.code === "refused" && <p role="alert">{state.message}</p>}
    {state.code === "applied" && <div role="status">
      <p>{state.replayed ? "Setup confirmed. The previous request completed without repeating its writes." : "Vivary setup applied."}
        {" "}This project keeps its existing files and conversations.</p>
      <p><Link to="/files">Open files</Link>{" · "}<Link to="/">Open chat</Link></p>
    </div>}
    {state.code === "privacy-prepared" && <p role="status">
      Ignore-file protection is ready. Review setup again before authorizing its file changes.
      This protection stays in place if you cancel setup or later recover an incomplete setup.
    </p>}
    {state.code === "recovered" && <p role="status">Recovery finished. Review a new setup plan before applying again.</p>}
    {review && <div data-agent-native="adoption-preview">
      <p>Folder: <strong>{review.displayName}</strong><br /><code>{review.folder}</code></p>
      <p>Detected preset: <strong>{review.report.preset}</strong></p>
      {review.report.content_inventory && <p>
        {review.report.content_inventory.existing_markdown} existing Markdown files in the scanned folders remain searchable unless the saved configuration excludes them. They stay unchanged except for the reviewed changes below.
        {" "}{review.report.content_inventory.existing_non_markdown} other files in those folders stay unchanged except for the reviewed changes below. They are not included in the Markdown index.
      </p>}
      {review.report.validation_findings.length > 0 && <div>
        <h5>Expected validation findings</h5>
        <ul data-agent-native="adoption-validation-findings">{review.report.validation_findings.map(finding =>
          <li key={`${finding.path}:${finding.line}:${finding.code}`}>
            <code>{finding.path}</code>: {finding.level} {finding.code}: {finding.message}
          </li>)}</ul>
      </div>}
      {preparePrivacy && <div>
        <h5>Protect recovery records first</h5>
        <p>This step changes only <code>.gitignore</code>, preserving its existing text. It adds ignore rules before Vivary stores recovery records in this folder.</p>
        <p>Review setup separately after this step. The ignore-file change remains if you cancel setup or recover an incomplete setup. Existing tracked files stay tracked.</p>
      </div>}
      <p role="status">{review.report.conflicts.length > 0 ? "Resolve these conflicts before applying setup."
        : review.report.content_plan.files.length === 0 ? "No setup changes are needed."
        : `${reviewedFiles.length} proposed file changes.`}</p>
      {!preparePrivacy && !review.report.request_replay.ready && review.report.content_plan.files.length > 0
        && <p role="alert">{review.report.request_replay.reason}</p>}
      {preparePrivacy && !review.report.privacy_preparation?.ready && <p role="alert">{review.report.privacy_preparation?.reason}</p>}
      {review.report.conflicts.length > 0 && <div>
        <h5>Conflicts</h5>
        <ul data-agent-native="adoption-conflicts">{review.report.conflicts.map(conflict => <li key={`${conflict.path}:${conflict.reason}`}>
          <code>{conflict.path}</code>: {conflict.reason}
        </li>)}</ul>
      </div>}
      {reviewedFiles.map(file => <details key={file.path} data-agent-native="adoption-file" data-path={file.path}>
        <summary><span>{operationLabel[file.operation]} <code>{file.path}</code></span><span>{file.bytes} bytes</span></summary>
        <pre tabIndex={0} aria-label={`Proposed content for ${file.path}`}><code>{file.content}</code></pre>
      </details>)}
      {review.report.retired_kept && review.report.retired_kept.length > 0 && <div>
        <h5>Removed from active guidance, kept in this folder</h5>
        <ul>{review.report.retired_kept.map(path => <li key={path}><code>{path}</code></li>)}</ul>
      </div>}
      {review.report.content_plan.kept.length > 0 && <div>
        <h5>Kept unchanged</h5>
        <ul data-agent-native="adoption-kept">{review.report.content_plan.kept.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
      </div>}
      <details className="project-adoption-plan">
        <summary>Plan details</summary>
        <p>{review.report.preset_reason}</p>
        <code data-agent-native="adoption-plan-hash">{review.report.plan_hash}</code>
      </details>
      {approval && state.code === "preview" && <div className="adoption-controls">
        <p>{preparePrivacy ? "Confirm authorizes only the reviewed ignore-file change. Setup requires a new review and confirmation."
          : "Confirm authorizes only these reviewed changes in this folder. Changed files require another preview."}</p>
        <Button size="sm" disabled={unavailable || !(preparePrivacy ? review.report.privacy_preparation?.ready : review.report.request_replay.ready) || review.report.conflicts.length > 0}
          onClick={() => void perform({ operation: preparePrivacy ? "prepare-privacy" : "apply", ...approval })}>
          {preparePrivacy ? "Confirm privacy preparation" : "Confirm and apply"}</Button>
        <Button size="sm" variant="outline" disabled={unavailable}
          onClick={() => void perform({ operation: "cancel", ...approval })}>Cancel</Button>
      </div>}
      {approval && state.code === "privacy-pending" && <div className="adoption-controls">
        <p role="status">{state.message}</p>
        <Button size="sm" disabled={unavailable}
          onClick={() => void perform({ operation: "prepare-privacy", ...approval })}>Retry privacy preparation</Button>
      </div>}
      {approval && state.code === "pending" && <div className="adoption-controls">
        <p role="status">{state.message}</p>
        <Button size="sm" disabled={unavailable}
          onClick={() => void perform({ operation: "apply", ...approval })}>Retry approved request</Button>
        <Button size="sm" variant="outline" disabled={unavailable}
          onClick={() => void perform({ operation: "preview-recovery", ...approval })}>Review recovery</Button>
      </div>}
      {approval && state.code === "recovery-preview" && <div className="adoption-controls">
        <h5>Review recovery</h5>
        <p>Recovery restores only unchanged outputs of this incomplete request. Possible completed work cannot be rolled back.</p>
        <ul>{state.recovery.recovery_actions.map(action => <li key={action.path}>
          {recoveryLabel[action.operation]} <code>{action.path}</code>
        </li>)}</ul>
        <Button size="sm" disabled={unavailable} onClick={() => void perform({ operation: "recover", ...approval,
          acceptedRecoveryHash: state.recovery.recovery_plan_hash })}>Confirm recovery</Button>
        {!state.approved && <Button size="sm" variant="outline" disabled={unavailable}
          onClick={() => void perform({ operation: "apply", ...approval })}>Check original request</Button>}
      </div>}
    </div>}
  </section>;
}
