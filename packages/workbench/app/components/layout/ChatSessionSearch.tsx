import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useSession } from "@agent-native/core/client/hooks";
import { sessionToken } from "@/lib/native-state";
import { useNativeActionReader } from "@/lib/native-actions";
import type { VivaryChatIdentity } from "@/lib/chat-scope";
import type { ChatSearchHit, ChatSearchPage } from "@/lib/chat-search-schema";
import { chatSearchHref } from "@/lib/chat-search-location";
import { continueChatSearch } from "@/lib/chat-search-client";
import { highlightedExcerpt, chatMatchTime } from "@/lib/chat-search-excerpt";
import "../../chat-search.css";

type Results = { key: string; hits: ChatSearchHit[]; cursor: string | null; limited: boolean;
  searched: number; total?: number; codeUnavailable?: boolean };
export function ChatSessionSearch({ identity, enabled = true, onActiveChange }: {
  identity: VivaryChatIdentity; enabled?: boolean; onActiveChange?: (active: boolean) => void;
}) {
  const session = useSession(), location = useLocation(), inputId = useId();
  const readAction = useNativeActionReader();
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error" | "cancelled">("idle");
  const [expired, setExpired] = useState(false);
  const [pages, setPages] = useState<Results>();
  const controller = useRef<AbortController | null>(null), generation = useRef(0), immediate = useRef(false);
  const resume = useRef<{ key: string; after?: string }>({ key: "" });
  const term = query.trim(), requestKey = JSON.stringify([identity.storageKey, term, includeArchived]);
  const latestKey = useRef(requestKey); latestKey.current = requestKey;
  const token = session.status === "authenticated" ? sessionToken(session) : null;
  const cancel = () => { generation.current++; controller.current?.abort(); setStatus("cancelled"); };
  const restart = () => {
    controller.current?.abort(); generation.current++; resume.current = { key: requestKey };
    setPages(undefined); setExpired(false); setRetry(value => value + 1);
  };
  const clear = () => { cancel(); setQuery(""); setPages(undefined); };
  useEffect(() => { onActiveChange?.(term.length > 0); }, [term, onActiveChange]);
  useEffect(() => {
    const ownGeneration = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    if (resume.current.key !== requestKey) resume.current = { key: requestKey };
    if (term.length < 2 || !enabled || session.status !== "authenticated") { setStatus("idle"); return () => abort.abort(); }
    setStatus("loading"); setExpired(false);
    const valid = () => !abort.signal.aborted && ownGeneration === generation.current && latestKey.current === requestKey;
    const delay = resume.current.after || immediate.current ? 0 : 250; immediate.current = false;
    const timer = setTimeout(async () => {
      try {
        await continueChatSearch({ after: resume.current.after, signal: abort.signal,
          onRequest: after => { if (valid()) resume.current = { key: requestKey, after }; },
          fetchPage: async after => {
            const params = new URLSearchParams({ query: term, unassigned: String(identity.kind === "unassigned"), includeArchived: String(includeArchived) });
            if (identity.kind !== "unassigned" && identity.projectId) params.set("projectId", identity.projectId);
            if (after) params.set("after", after);
            const response = await readAction("vivary-chat-search", params, abort.signal);
            if (!response.ok) { if (response.status === 400 && valid()) setExpired(true); throw new Error("Search could not finish."); }
            return await response.json() as ChatSearchPage;
          },
          onPage: page => {
            if (!valid()) return;
            resume.current = { key: requestKey, after: page.continueAfter ?? undefined };
            setPages(previous => {
              const existing = previous?.key === requestKey ? previous : undefined;
              const unique = new Map([...(existing?.hits ?? []), ...page.results]
                .map(hit => [JSON.stringify([hit.runtime, hit.sessionId, hit.referenceId]), hit]));
              const hits = [...unique.values()].sort((a, b) => (b.sessionUpdatedAt ?? 0) - (a.sessionUpdatedAt ?? 0)
                || a.sessionId.localeCompare(b.sessionId) || a.referenceId.localeCompare(b.referenceId));
              return { key: requestKey, hits, cursor: page.continueAfter, limited: Boolean(page.limited || existing?.limited),
                searched: page.searchedSessions, total: page.totalSessions, codeUnavailable: page.codeUnavailable };
            });
          },
        });
        if (valid()) setStatus("ready");
      } catch { if (valid()) setStatus("error"); }
    }, delay);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [requestKey, retry, enabled, session.status, token, readAction]);
  const current = pages?.key === requestKey ? pages : undefined;
  const progress = current ? `Searched ${current.searched}${current.total === undefined ? "" : ` of ${current.total}`} conversations…` : "Searching conversations…";
  return <div className="chat-session-search" aria-label={identity.kind === "unassigned" ? "Search unassigned history" : "Search project conversations"}>
    <form onSubmit={event => { event.preventDefault(); immediate.current = true; restart(); }}>
      <label htmlFor={inputId}>Search conversations</label>
      <input id={inputId} type="search" value={query} maxLength={160} placeholder="Words in titles or messages"
        autoComplete="off" enterKeyHint="search" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); clear(); } }}
        onChange={event => { controller.current?.abort(); generation.current++; setQuery(event.target.value); }} />
      {term && <button type="button" onClick={clear}>Clear search</button>}
      <label className="chat-search-filter"><input type="checkbox" checked={includeArchived} onChange={event => {
        controller.current?.abort(); generation.current++; setIncludeArchived(event.target.checked);
      }} />Include archived</label>
    </form>
    {term.length > 0 && term.length < 2 && <p role="status">Type at least two characters.</p>}
    {status === "loading" && <div role="status">{progress} <button type="button" onClick={cancel}>Cancel</button></div>}
    {status === "cancelled" && term.length >= 2 && <p role="status">Search cancelled. <button type="button" onClick={() => setRetry(value => value + 1)}>Resume search</button></p>}
    {status === "error" && <p role="alert">{expired ? "This search expired. Start it again." : "Search could not finish. Your earlier matches are kept."}
      <button type="button" onClick={expired ? restart : () => setRetry(value => value + 1)}>{expired ? "Start again" : "Retry search"}</button></p>}
    {current && <>
      <p role="status">{current.hits.length ? `${current.hits.length} matches${current.cursor ? " so far" : ""}.`
        : status === "loading" ? "Looking through saved history…" : current.cursor ? "No matches in the history searched so far." : "No matching conversations."}</p>
      <ul>{current.hits.map(hit => {
        const time = chatMatchTime(hit.matchedAt, hit.sessionUpdatedAt);
        return <li key={JSON.stringify([hit.runtime, hit.sessionId, hit.referenceId])}>
          <Link to={chatSearchHref(hit, identity.kind === "unassigned", location.search)} className="chat-search-result"
            data-session-id={hit.sessionId} data-reference-id={hit.referenceId}>
            <strong>{hit.title}</strong>
            <span>{hit.projectLabel} · {hit.runtime === "native" ? "Native" : "Code"}{hit.archived ? " · Archived" : ""}</span>
            <span className="chat-search-excerpt">{highlightedExcerpt(hit.excerpt, term)}</span>
            <span className="chat-search-time" title={time.title}>{time.label}</span>
          </Link>
        </li>;
      })}</ul>
      {current.cursor && status === "ready" && <button type="button" onClick={() => setRetry(value => value + 1)}>Search more history</button>}
      {current.codeUnavailable && <p>Native history is available. Code history is unavailable until the Personal workspace is connected.</p>}
      {current.limited && <p>Some conversations changed during this search, malformed or oversized records were skipped,
        or the history scan limit was reached. Start the search again to include changed conversations.</p>}
    </>}
    {term.length >= 2 && <p className="chat-search-boundary">Forgotten or removed active-memory facts can remain findable in chat history.</p>}
  </div>;
}
