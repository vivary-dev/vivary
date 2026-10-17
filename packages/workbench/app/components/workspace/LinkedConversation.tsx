import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@agent-native/toolkit/ui";
import { useNativeActionCaller } from "@/lib/native-actions";
import type { VivaryCodeState } from "../../../server/local-code-agent";
import type { ConversationReference, LinkedConversationResult, LinkedHistoryPage } from "../../../shared/linked-conversation";

/** A version 4 UUID. randomUUID needs a secure context, which remote browser access over plain HTTP lacks. */
function newOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

/** The Code harnesses a source can link to: configured, not the source's own, and with a model that can send. */
export function linkTargetChoices(engines: VivaryCodeState["engines"], sourceEngine: string) {
  return engines.filter(engine => engine.configured && engine.engine !== sourceEngine).map(engine => ({
    engine: engine.engine, label: engine.label,
    // Claude models carry install support, as in the Code composer. Only a supported model can ever send.
    model: engine.modelCatalog?.status === "ready" ? engine.modelCatalog.defaultModel
      : engine.models.find(model => (engine.claudeModels?.find(item => item.id === model)?.support ?? "supported") === "supported"),
  })).filter(choice => choice.model);
}

export function LinkedConversationChooser({ projectId, source, sourceEngine, engines, saveDraft }: {
  projectId: string | null; source: ConversationReference; sourceEngine: string;
  engines: VivaryCodeState["engines"]; saveDraft: () => Promise<void>;
}) {
  const { call, ready } = useNativeActionCaller(), navigate = useNavigate();
  const [busy, setBusy] = useState(false), [failedChoice, setFailedChoice] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const visit = useRef(0), inFlight = useRef(false);
  // One operation ID per choice, reused by Retry, so a server that committed before its response was lost
  // returns the same target instead of creating a second one.
  const operation = useRef<{ engine: string; id: string } | null>(null);
  useEffect(() => () => { visit.current++; }, [projectId, source.kind, source.id]);
  const choices = linkTargetChoices(engines, sourceEngine);
  async function open(engine: string) {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    const generation = visit.current;
    setBusy(true); setFailedChoice(null);
    try {
      await saveDraft();
      const choice = choices.find(choice => choice.engine === engine);
      if (engine !== "native" && !choice) throw new Error("This runtime is unavailable.");
      if (operation.current?.engine !== engine) operation.current = { engine, id: newOperationId() };
      const result = await call<LinkedConversationResult>("vivary-conversation-link", {
        projectId, source, target: engine === "native" ? { engine } : { engine, model: choice!.model },
        operationId: operation.current.id,
      });
      operation.current = null;
      if (generation !== visit.current) return;
      window.dispatchEvent(new Event("agent-chat:threads-updated"));
      navigate(result.route);
    } catch (error) {
      if (generation === visit.current) {
        setFailedChoice(engine);
        setFailure(error instanceof Error && "errorCode" in error && error.errorCode === "vivary_linked_history_unavailable"
          ? error.message : "The linked conversation could not open.");
      }
    } finally {
      inFlight.current = false;
      if (generation === visit.current) setBusy(false);
    }
  }
  return <div className="local-agent-notice">
    <label className="flex items-center gap-2 text-sm">Linked conversation
      <select aria-label="Open linked conversation in another harness" value="" disabled={busy || !ready}
        className="rounded-md border bg-background px-2 py-1 text-foreground"
        onChange={event => { if (event.target.value) void open(event.target.value); }}>
        <option value="">{busy ? "Opening…" : "Choose another harness…"}</option>
        {choices.map(choice => <option key={choice.engine} value={choice.engine}>{choice.label}</option>)}
        {source.kind === "code" && <option value="native">Native chat</option>}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">Opens an inactive conversation in this project. Your draft and approvals stay here. Nothing is sent.</p>
    {failedChoice && <div role="alert">{failure} This conversation is still selected.
      <Button size="sm" variant="outline" onClick={() => void open(failedChoice)}>Retry link</Button></div>}
  </div>;
}

type Probe<T> = { data?: T; isError: boolean; refetch: () => unknown };

/** The Native chooser once its source eligibility and runtime state have loaded. A failed prerequisite offers Retry. */
export function NativeLinkOptions({ projectId, threadId, source, engines, saveDraft }: {
  projectId: string | null; threadId: string; source: Probe<{ available: boolean }>; engines: Probe<VivaryCodeState>;
  saveDraft: () => Promise<void>;
}) {
  const eligible = source.data?.available === true;
  if (source.isError || (eligible && engines.isError)) return <div className="local-agent-notice" role="alert">
    Linked conversation options could not load.
    <Button size="sm" variant="outline" onClick={() => { void source.refetch(); if (eligible) void engines.refetch(); }}>
      Retry linked conversation</Button></div>;
  // A Native source can link only to Code, so with no usable harness there is nothing to choose.
  if (!eligible || !engines.data || !linkTargetChoices(engines.data.engines, "native").length) return null;
  return <LinkedConversationChooser projectId={projectId} source={{ kind: "native", id: threadId }} sourceEngine="native"
    engines={engines.data.engines} saveDraft={saveDraft} />;
}

/** Whether a Native conversation is saved, so it can be a link source. An optimistic thread is not saved yet. */
export function useLinkSourceEligibility({ projectId, storageKey, threadId, enabled }: {
  projectId: string | null; storageKey: string; threadId: string | null; enabled: boolean;
}) {
  const { call, ready } = useNativeActionCaller();
  const query = useQuery({ queryKey: ["vivary-link-source", storageKey, threadId],
    enabled: enabled && !!threadId && ready, retry: false,
    queryFn: () => call<{ available: boolean }>("vivary-linked-history", { operation: "source",
      projectId, target: { kind: "native", id: threadId! } }) });
  const saved = query.data?.available === true, active = enabled && !!threadId && ready;
  useEffect(() => {
    if (saved || !active) return;
    // The first request saves the thread. Native reports request completion with its UI tab key, not the thread ID.
    const refresh = () => { void query.refetch(); };
    const nativeRequest = (event: Event) => {
      if ((event as CustomEvent<{ isRunning?: boolean }>).detail?.isRunning === false) refresh();
    };
    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", nativeRequest);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", nativeRequest);
    };
  }, [saved, active, query.refetch]);
  return query;
}

export function LinkedHistoryNotice({ projectId, target }: { projectId: string | null; target: ConversationReference }) {
  const { call, ready } = useNativeActionCaller();
  const key = JSON.stringify([projectId, target.kind, target.id]);
  const [pages, setPages] = useState<Array<LinkedHistoryPage>>([]), [pagingError, setPagingError] = useState(false);
  const [paging, setPaging] = useState(false), [expanded, setExpanded] = useState(false);
  const visit = useRef(0);
  useEffect(() => { visit.current++; setPages([]); setExpanded(false); setPagingError(false); }, [key]);
  const query = useQuery({ queryKey: ["vivary-linked-history", key], enabled: ready, retry: false,
    staleTime: 0, queryFn: () => call<LinkedHistoryPage | null>("vivary-linked-history", { projectId, target }) });
  // Each successful first-page read replaces later pages and drops any page still loading, so current
  // redaction and authorization apply to every shown excerpt.
  useEffect(() => { visit.current++; setPages([]); setPaging(false); setPagingError(false); }, [query.dataUpdatedAt]);
  useEffect(() => {
    const refresh = () => { void query.refetch(); };
    const nativeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ isRunning?: boolean }>).detail;
      // Native reports its UI tab key, which need not equal the retained thread ID.
      if (target.kind === "native" && typeof detail?.isRunning === "boolean") refresh();
    };
    window.addEventListener("agent-chat:threads-updated", refresh);
    window.addEventListener("agentNative.chatRunning", nativeRequest);
    return () => {
      window.removeEventListener("agent-chat:threads-updated", refresh);
      window.removeEventListener("agentNative.chatRunning", nativeRequest);
    };
  }, [key, target.kind, target.id, query.refetch]);
  const page = query.data;
  if (query.isError) return <div className="local-agent-notice" role="alert">Linked history could not be verified.
    <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry history</Button></div>;
  if (!page) return null;
  if (page.sourceStatus === "unavailable") return <div className="local-agent-notice text-sm" role="status">
    <p>Linked to {page.sourceTitle || "Original conversation"}, which is unavailable. Sends continue without its history.</p>
    {page.lastAccepted ? <p>Earlier, the last accepted Code send included {page.lastAccepted.entries} linked entries.</p>
      : page.lastPrepared ? <p>Earlier, the last prepared request included {page.lastPrepared.entries} linked entries.</p> : null}
  </div>;
  const shown = [page, ...pages], cursor = shown.at(-1)?.nextCursor;
  const route = page.source.kind === "code" ? `/?run=${encodeURIComponent(page.source.id)}`
    : `/?runtime=native&history=project&thread=${encodeURIComponent(page.source.id)}`;
  async function more() {
    if (!cursor || paging) return;
    setPaging(true); setPagingError(false);
    const generation = visit.current;
    try {
      const result = await call<LinkedHistoryPage>("vivary-linked-history", { projectId, target, cursor });
      if (generation === visit.current) setPages(current => [...current, result]);
    } catch { if (generation === visit.current) setPagingError(true); }
    finally { if (generation === visit.current) setPaging(false); }
  }
  return <div className="local-agent-notice text-sm">
    {/* Router navigation keeps the mounted draft owner alive, so a pending target draft still saves. */}
    <p>Linked to <Link to={route} className="underline">{page.sourceTitle || "Original conversation"}</Link>.</p>
    <p>{page.availableEntries} completed-history entries available. {page.nextSendSupplies
      ? page.nextSend.truncated ? `Next send can prepare the latest ${page.nextSend.entries} (truncated).`
        : `Next send can prepare ${page.nextSend.entries}.`
      : "An accepted send already supplied it to this session, so later sends do not repeat it."}</p>
    <p>{page.lastAccepted ? `Last accepted Code send: ${page.lastAccepted.entries} entries.`
      : page.lastPrepared ? `Last request prepared: ${page.lastPrepared.entries} entries.${target.kind === "code" ? " No accepted Code send recorded." : " Delivery not observed."}`
      : "No linked history prepared yet."} Separate harness session.</p>
    <Button size="sm" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? "Hide history excerpt" : "Inspect linked history"}</Button>
    {expanded && <>
      <p>Completed boundary: {page.boundaryId ?? "no completed portion"}. Later source messages are excluded.</p>
      <p>Next send: {page.nextSend.characters} characters from the latest {page.nextSend.entries} entries, ending at the boundary.
        Runtime bookkeeping and private reasoning are excluded.
        {page.lastPrepared ? ` Last prepared: ${page.lastPrepared.entries} entries, ${page.lastPrepared.characters} characters${page.lastPrepared.truncated ? ", truncated" : ""}.` : ""}
        {page.lastAccepted ? ` Accepted user event: ${page.lastAccepted.userEventId}, ${page.lastAccepted.characters} characters${page.lastAccepted.truncated ? ", truncated" : ""}.` : ""}
        Preparation and Code acceptance do not confirm provider ingestion.</p>
      <p>Source-to-target native session continuity: none. This conversation uses its own harness session. The source provider session is not transferred.</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{shown.map(part => part.excerpt).join("\n\n") || "No completed source portion is available."}</pre>
      {page.nextSend.truncated && <p>A send supplies only the latest entries that fit. The pages below start from the oldest
        entry. Inspect the original for omitted or oversized text.</p>}
      {cursor && <Button size="sm" variant="outline" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : pagingError ? "Retry page" : "More recorded history"}</Button>}
      {pagingError && <p role="alert">The next source page could not be verified. Previously read pages are retained.</p>}</>}
  </div>;
}
