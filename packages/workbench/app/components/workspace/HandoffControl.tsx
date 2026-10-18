import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@agent-native/toolkit/ui";
import { useNativeActionCaller } from "@/lib/native-actions";
import type { ConversationReference } from "../../../shared/linked-conversation";
import { STALE_REASON_TEXT, type HandoffFreshness, type HandoffPrepareResult, type HandoffRecord,
  type HandoffSaveResult, type StaleReason } from "../../../shared/handoff";

/**
 * Prepare handoff and its freshness for one project conversation. Prepare
 * submits a request to this conversation through `submit`. Save handoff is a
 * separate owner click. Freshness is read on mount and after conversation
 * updates. It never submits anything.
 */
export function HandoffControl({ projectId, conversation, disabled, submit, runActive }: {
  projectId: string; conversation: ConversationReference; disabled: boolean;
  /** Sends the request as a message in this conversation. Resolves false when it was not delivered. */
  submit: (message: string) => Promise<boolean>;
  /** Native only: whether a run is active now, read on mount. Code passes its run state as `disabled`. */
  runActive?: () => Promise<boolean>;
}) {
  const { call, ready } = useNativeActionCaller();
  const key = JSON.stringify([projectId, conversation.kind, conversation.id]);
  const [busy, setBusy] = useState(false), [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ text: string; problems?: string[] } | null>(null);
  const visit = useRef(0), runEvents = useRef(0), latestRunActive = useRef(runActive);
  latestRunActive.current = runActive;
  useEffect(() => {
    visit.current++; setNotice(null); setBusy(false); setRunning(false);
    const probe = latestRunActive.current;
    if (!probe) return;
    // A run event that arrives while the read is pending is newer, so it wins.
    const seen = runEvents.current;
    let current = true;
    void probe().then(active => { if (current && runEvents.current === seen) setRunning(active); }, () => {});
    return () => { current = false; };
  }, [key]);
  const query = useQuery({ queryKey: ["vivary-handoff-freshness", key], enabled: ready, retry: false, staleTime: 0,
    queryFn: () => call<HandoffFreshness>("vivary-handoff-freshness", { projectId, conversation }) });
  useEffect(() => {
    const refresh = () => { void query.refetch(); };
    // Native reports later run changes here.
    const nativeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ isRunning?: boolean }>).detail;
      if (typeof detail?.isRunning !== "boolean") return;
      runEvents.current++;
      setRunning(detail.isRunning);
      if (!detail.isRunning) refresh();
    };
    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", nativeRequest);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", nativeRequest);
    };
  }, [key, query.refetch]);

  // Code reports its run state only through `disabled`. A run that ends is a conversation update.
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (wasDisabled.current && !disabled) void query.refetch();
    wasDisabled.current = disabled;
  }, [disabled, query.refetch]);

  async function act(work: () => Promise<void>) {
    if (busy || !ready) return;
    const generation = visit.current;
    setBusy(true); setNotice(null);
    try { await work(); } catch (error) {
      if (generation === visit.current) setNotice({ text: error instanceof Error ? error.message : "The handoff action failed." });
    } finally {
      if (generation === visit.current) { setBusy(false); void query.refetch(); }
    }
  }
  const prepare = () => act(async () => {
    const generation = visit.current;
    const result = await call<HandoffPrepareResult>("vivary-handoff-prepare", { projectId, conversation });
    // Native submits to whichever chat is open now. Another conversation must not receive this request.
    if (generation !== visit.current) return;
    if (!("code" in result)) { setNotice({ text: result.message }); return; }
    if (!await submit(result.message)) setNotice({ text: "The handoff request was not delivered to this conversation. Prepare handoff again." });
  });
  const save = (requestId: string) => act(async () => {
    const result = await call<HandoffSaveResult>("vivary-handoff-save", { projectId, conversation, requestId });
    // A conflict or failed write comes back as the Failed status on the refetch.
    if ("problems" in result) setNotice({ text: "The reply was not saved. Ask the agent to correct it, then click Save handoff.", problems: result.problems });
    else if ("status" in result) setNotice({ text: result.message });
  });

  const status = query.data;
  // A new Native conversation has no saved thread until its first reply is saved.
  // It has nothing to hand off yet. The next conversation update checks again.
  const error = query.error as (Error & { errorCode?: string }) | null;
  if (error?.errorCode === "vivary_linked_history_unavailable") return null;
  if (query.isError) return <div className="local-agent-notice" role="alert">Handoff freshness could not be checked.
    <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry check</Button></div>;
  if (!status) return null;
  if (status.status === "unavailable") return <div className="local-agent-notice text-sm" role="status">{status.message}</div>;
  const here = (other: ConversationReference) => other.kind === conversation.kind && other.id === conversation.id;
  const covered: HandoffRecord | null = "covered" in status ? status.covered : null;
  const file = covered?.facts.path ?? ("path" in status ? status.path : "STATE.md");
  const blocked = disabled || running || busy || !ready;
  const reasonText = (reason: StaleReason) => reason === "document-edited" ? `${file} was edited` : STALE_REASON_TEXT[reason];
  return <div className="local-agent-notice text-sm">
    {status.status === "none" && <p>No handoff saved for this project.</p>}
    {status.status === "fresh" && <p>Handoff in {file} is fresh. It covers the project version and conversation work recorded when it was saved.</p>}
    {status.status === "unverifiable" && <p>Handoff in {file} could not be verified. The file listing reached its limit or the Git state is unknown.</p>}
    {status.status === "out-of-date" && <p>Handoff in {file} is out of date: {status.reasons.map(reasonText).join(", ")}.</p>}
    {status.status === "pending" && (here(status.conversation)
      ? <p>Handoff requested. When the agent has replied, click Save handoff.</p>
      : <p>A handoff request is pending in another conversation. Preparing here replaces it.</p>)}
    {status.status === "failed" && <p role="alert">Handoff not saved. {status.message}</p>}
    {notice && <div role="alert"><p>{notice.text}</p>
      {notice.problems && <ul>{notice.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}</div>}
    <div className="flex flex-wrap gap-2">
      {status.status === "pending" && here(status.conversation)
        && <Button size="sm" variant="outline" disabled={busy || !ready} onClick={() => void save(status.requestId)}>Save handoff</Button>}
      {status.status === "failed" && status.retryable && here(status.conversation)
        && <Button size="sm" variant="outline" disabled={busy || !ready} onClick={() => void save(status.requestId)}>Retry</Button>}
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void prepare()}>
        {covered ? "Update handoff" : "Prepare handoff"}</Button>
    </div>
  </div>;
}
