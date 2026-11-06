import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@agent-native/toolkit/ui";
import { Button } from "@/components/ui/button";
import { useNativeActionCaller } from "@/lib/native-actions";
import type {
  ManagedProjectReconnectionPreview,
  ManagedProjectReconnectionResult,
} from "../../../shared/managed-project-reconnection";

type State =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "preview"; preview: ManagedProjectReconnectionPreview }
  | { kind: "confirming"; preview: ManagedProjectReconnectionPreview }
  | { kind: "uncertain"; preview: ManagedProjectReconnectionPreview; message: string }
  | { kind: "error"; message: string }
  | { kind: "complete" };

export function ReconnectProjectForm({ projectId, disabled, onReconnected }: {
  projectId: string;
  disabled: boolean;
  onReconnected: () => Promise<void>;
}) {
  const { call, ready } = useNativeActionCaller();
  const [state, setState] = useState<State>({ kind: "closed" });
  const [unreconciled, setUnreconciled] = useState<ManagedProjectReconnectionPreview[]>([]);
  const request = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => {
    if (state.kind === "preview" || state.kind === "error") heading.current?.focus();
  }, [state.kind]);

  async function review() {
    const current = ++request.current;
    const uncertain = state.kind === "uncertain" ? state : null;
    setState({ kind: "loading" });
    try {
      const preview = await call<ManagedProjectReconnectionPreview>(
        "vivary-preview-managed-project-reconnection", { projectId },
      );
      if (request.current === current) setState({ kind: "preview", preview });
    } catch (error) {
      if (request.current === current) {
        const message = error instanceof Error
          ? error.message : "The saved folder could not be checked. Try reviewing it again.";
        setState(uncertain ? { ...uncertain, message } : { kind: "error", message });
      }
    }
  }

  async function reconnect(preview: ManagedProjectReconnectionPreview) {
    const current = ++request.current;
    setState({ kind: "confirming", preview });
    try {
      await call<ManagedProjectReconnectionResult>("vivary-confirm-managed-project-reconnection", {
        projectId, operationId: preview.operationId, acceptedPlanSha256: preview.planSha256,
      });
    } catch (error) {
      if (request.current === current) {
        setUnreconciled(previous => previous.some(item => item.operationId === preview.operationId)
          ? previous : [...previous, preview]);
        setState({ kind: "uncertain", preview, message: error instanceof Error
          ? error.message : "The result is uncertain. Retry this reconnection to check it safely." });
      }
      return;
    }
    if (request.current !== current) return;
    // A successful receipt reconciliation identifies the current binding; older attempts are superseded.
    setUnreconciled([]);
    setState({ kind: "complete" });
    // Refresh availability without selecting a project the user may have left.
    await onReconnected();
  }

  function cancel() {
    request.current += 1;
    setState({ kind: "closed" });
    requestAnimationFrame(() => trigger.current?.focus());
  }

  const working = state.kind === "loading" || state.kind === "confirming";
  const unavailable = disabled || !ready || working;
  const preview = "preview" in state ? state.preview : null;
  return <div className="project-reconnection">
    {state.kind === "closed" ? <Button ref={trigger} size="sm" variant="outline"
      className="project-reconnection-trigger" disabled={disabled || !ready}
      onClick={() => void review()}>Review connection</Button> : <section
      aria-label="Review project connection" aria-busy={working}>
      <h3 ref={heading} tabIndex={-1}>Reconnect this project</h3>
      {state.kind === "loading" && <div className="project-list-skeleton" role="status">
        <span className="sr-only">Checking the saved project folder</span>
        <Skeleton className="h-4 w-full" /><Skeleton className="h-16 w-full" />
      </div>}
      {preview && <>
        <p className="project-reconnection-folder">{preview.folderName}</p>
        <p>{preview.folderKind === "managed"
          ? "In Vivary's managed Projects folder on this host."
          : "Registered folder on this host:"}</p>
        {preview.folderKind === "external" && <p><code>{preview.folderPath}</code></p>}
        {preview.recorded
          ? <p>This reconnection was recorded. Retry its exact confirmation to restore folder access.</p>
          : <p>The folder identity changed at the saved path. A changed host filesystem view or a replacement folder can cause this.
            Vivary cannot tell which occurred. Check the folder before reconnecting.</p>}
        <p>Reconnecting restores file and agent access. Your saved conversations stay with this project.
          Files stay unchanged, and no agent starts.</p>
      </>}
      {(state.kind === "error" || state.kind === "uncertain") && <p role="alert">{state.message}</p>}
      {state.kind === "uncertain" && <p>Retry checks the same request. Review again if the folder or access changed.</p>}
      {state.kind === "complete" && <p role="status">Project reconnected. Refresh the project list if it still shows unavailable.</p>}
      {unreconciled.some(item => item.operationId !== preview?.operationId) && <p>
        An earlier confirmation has an uncertain result. You can retry its exact request here.
      </p>}
      <div className="project-form-actions">
        {preview && <Button size="sm" disabled={unavailable} onClick={() => void reconnect(preview)}>
          {state.kind === "confirming" ? "Reconnecting…" : state.kind === "uncertain"
            ? "Retry reconnect" : preview.recorded ? "Finish reconnecting" : "Reconnect project"}
        </Button>}
        {unreconciled.filter(item => item.operationId !== preview?.operationId).map((item, index) =>
          <Button key={item.operationId} size="sm" variant="outline" disabled={unavailable}
            onClick={() => void reconnect(item)}>Retry earlier request {index + 1}</Button>)}
        {(state.kind === "error" || state.kind === "uncertain") && <Button size="sm" variant="outline"
          disabled={unavailable} onClick={() => void review()}>Review again</Button>}
        {state.kind === "complete" && <Button size="sm" variant="outline" disabled={disabled}
          onClick={() => void onReconnected()}>Refresh projects</Button>}
        <Button size="sm" variant="ghost" disabled={state.kind === "confirming"} onClick={cancel}>
          {state.kind === "complete" ? "Close" : "Cancel"}
        </Button>
      </div>
    </section>}
  </div>;
}
