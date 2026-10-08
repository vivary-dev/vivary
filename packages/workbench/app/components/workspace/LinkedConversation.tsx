import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@agent-native/toolkit/ui";
import { useNativeActionCaller } from "@/lib/native-actions";
import type { VivaryCodeState } from "../../../server/local-code-agent";
import type { ConversationReference, LinkedConversationResult, LinkedHistoryPage } from "../../../shared/linked-conversation";

export function LinkedConversationChooser({ projectId, source, sourceEngine, engines, saveDraft }: {
  projectId: string | null; source: ConversationReference; sourceEngine: string;
  engines: VivaryCodeState["engines"]; saveDraft: () => Promise<void>;
}) {
  const { call, ready } = useNativeActionCaller(), navigate = useNavigate();
  const [busy, setBusy] = useState(false), [failedChoice, setFailedChoice] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const visit = useRef(0), inFlight = useRef(false);
  useEffect(() => () => { visit.current++; }, [projectId, source.kind, source.id]);
  const choices = engines.filter(engine => engine.configured && engine.engine !== sourceEngine).map(engine => ({
    engine: engine.engine, label: engine.label,
    model: engine.modelCatalog?.status === "ready" ? engine.modelCatalog.defaultModel : engine.models[0],
  })).filter(choice => choice.model);
  async function open(engine: string) {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    const generation = visit.current;
    setBusy(true); setFailedChoice(null);
    try {
      await saveDraft();
      const choice = choices.find(choice => choice.engine === engine);
      if (engine !== "native" && !choice) throw new Error("This runtime is unavailable.");
      const result = await call<LinkedConversationResult>("vivary-conversation-link", {
        projectId, source, target: engine === "native" ? { engine } : { engine, model: choice!.model },
      });
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

export function LinkedHistoryNotice({ projectId, target }: { projectId: string | null; target: ConversationReference }) {
  const { call, ready } = useNativeActionCaller();
  const key = JSON.stringify([projectId, target.kind, target.id]);
  const [pages, setPages] = useState<Array<LinkedHistoryPage>>([]), [pagingError, setPagingError] = useState(false);
  const [paging, setPaging] = useState(false), [expanded, setExpanded] = useState(false);
  const visit = useRef(0);
  useEffect(() => { visit.current++; setPages([]); setExpanded(false); setPagingError(false); }, [key]);
  const query = useQuery({ queryKey: ["vivary-linked-history", key], enabled: ready, retry: false,
    staleTime: 0, queryFn: () => call<LinkedHistoryPage | null>("vivary-linked-history", { projectId, target }) });
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
    <p>Linked to <a href={route} className="underline">{page.sourceTitle || "Original conversation"}</a>.</p>
    <p>{page.availableEntries} completed-history entries available. Next send can prepare {page.suppliedEntries}{page.truncated ? " (truncated)" : ""}.</p>
    <p>{page.lastAccepted ? `Last accepted Code send: ${page.lastAccepted.entries} entries.`
      : page.lastPrepared ? `Last request prepared: ${page.lastPrepared.entries} entries.${target.kind === "code" ? " No accepted Code send recorded." : " Delivery not observed."}`
      : "No linked history prepared yet."} Separate harness session.</p>
    <Button size="sm" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? "Hide history excerpt" : "Inspect linked history"}</Button>
    {expanded && <>
      <p>Completed boundary: {page.boundaryId ?? "no completed portion"}. Later source messages are excluded.</p>
      <p>Next excerpt: {page.excerpt.length} characters. Runtime bookkeeping and private reasoning are excluded.
        {page.lastPrepared ? ` Last prepared: ${page.lastPrepared.entries} entries, ${page.lastPrepared.characters} characters${page.lastPrepared.truncated ? ", truncated" : ""}.` : ""}
        {page.lastAccepted ? ` Accepted user event: ${page.lastAccepted.userEventId}, ${page.lastAccepted.characters} characters${page.lastAccepted.truncated ? ", truncated" : ""}.` : ""}
        Preparation and Code acceptance do not confirm provider ingestion.</p>
      <p>Source-to-target native session continuity: none. This conversation uses its own harness session. The source provider session is not transferred.</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{shown.map(part => part.excerpt).join("\n\n") || "No completed source portion is available."}</pre>
      {page.truncated && <p>Only the stated excerpt is prepared for a send. Inspect the original for omitted or oversized text.</p>}
      {cursor && <Button size="sm" variant="outline" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : pagingError ? "Retry page" : "More recorded history"}</Button>}
      {pagingError && <p role="alert">The next source page could not be verified. Previously read pages are retained.</p>}</>}
  </div>;
}
