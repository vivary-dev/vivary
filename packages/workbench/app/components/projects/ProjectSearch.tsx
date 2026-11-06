import { useEffect, useState } from "react";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { Button, Skeleton } from "@agent-native/toolkit/ui";
import { IconFileText } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router";
import { useProjects } from "./ProjectContext";
import { projectFileHref } from "@/lib/project-file-location";
import type { ProjectSearchMode, ProjectSearchResult } from "@/lib/project-search-schema";
import { committedQuery, incompleteCoverage, reduceSearchPages, sameRequest, summarize, type SearchPages } from "@/lib/project-search-state";
import "../../project-search.css";

const MODES: ReadonlyArray<{ mode: ProjectSearchMode; label: string }> = [
  { mode: "text", label: "Text" },
  { mode: "filename", label: "Filename" },
  { mode: "regex", label: "Regex" },
];
const DEBOUNCE_MS = 250;

// Scoped search over the active project. Typing debounces into a committed
// query; Enter commits at once. Every response is folded through the pure
// reducer, which ignores anything that does not echo the current request,
// and a project switch discards the whole panel state.
export function ProjectSearch() {
  const { activeProject, workspaceAvailable, checking } = useProjects();
  const [params] = useSearchParams();
  const projectId = activeProject?.projectId ?? null;
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ProjectSearchMode>("text");
  const [query, setQuery] = useState("");
  const [after, setAfter] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<SearchPages | null>(null);

  useEffect(() => {
    const next = committedQuery(input);
    if (next === query) return;
    const timer = setTimeout(() => { setQuery(next); setAfter(undefined); }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, query]);
  useEffect(() => { setInput(""); setQuery(""); setAfter(undefined); setPages(null); }, [projectId]);

  const enabled = Boolean(projectId && query && workspaceAvailable && !checking);
  const search = useActionQuery<ProjectSearchResult>("vivary-project-search",
    { projectId: projectId ?? "", query, mode, ...(after ? { after } : {}) },
    { enabled, retry: false, refetchOnWindowFocus: false, staleTime: 30_000 });
  const data = search.data;
  useEffect(() => {
    if (!projectId || !data) return;
    setPages(previous => {
      const next = reduceSearchPages(previous, data, { projectId, query, mode }, after);
      // A continuation the reducer refused (the project was rebound) starts over.
      if (next === null && after) setAfter(undefined);
      return next;
    });
  }, [data, projectId, query, mode, after]);

  if (!projectId || !activeProject) return <p className="project-search-empty">Choose a project to search its files.</p>;
  if (!workspaceAvailable) return <p className="project-search-empty" role="alert">This project folder is unavailable.</p>;
  const current = pages && sameRequest(pages.request, { projectId, query, mode }) ? pages : null;
  const busy = enabled && search.isFetching;
  const hits = current ? (mode === "filename" ? current.files.length : current.matches.length) : 0;
  const commit = () => { setQuery(committedQuery(input)); setAfter(undefined); };

  return <section className="project-search" aria-label="Project search">
    <form className="project-search-form" onSubmit={event => { event.preventDefault(); commit(); }}>
      <label htmlFor="project-search-query" className="sr-only">Search {activeProject.displayName}</label>
      <input id="project-search-query" type="search" value={input} placeholder="Search file names or text"
        autoComplete="off" spellCheck={false} enterKeyHint="search" onChange={event => setInput(event.target.value)} />
      <div className="project-search-modes" role="group" aria-label="Search mode">
        {MODES.map(item => <button key={item.mode} type="button" aria-pressed={mode === item.mode}
          onClick={() => { setMode(item.mode); setAfter(undefined); }}>{item.label}</button>)}
      </div>
    </form>
    <p className="project-search-status" role="status" aria-live="polite">
      {!query ? "Type at least two characters, then Enter or wait a moment."
        : current ? summarize(current) : busy ? "Searching…" : ""}
    </p>
    {search.isError && <div className="project-search-notice" role="alert">Search could not finish. Nothing was changed.
      <button type="button" onClick={() => void search.refetch()}>Retry</button></div>}
    {current?.invalidPattern && <p className="project-search-notice" role="alert">{current.invalidPattern}</p>}
    {busy && !current && <div className="project-search-loading" aria-hidden><Skeleton className="h-6 w-4/5" /><Skeleton className="h-6 w-3/5" /></div>}
    {current && !current.invalidPattern && hits === 0 && !busy && <p className="project-search-empty">
      {incompleteCoverage(current) ? "No matches in the files searched so far." : "No matches in this project."}</p>}
    {current && !current.invalidPattern && hits > 0 && <ul className="project-search-results">
      {mode === "filename"
        ? current.files.map(file => <li key={file.path}>
          <Link className="project-search-result" to={projectFileHref(projectId, file.path, params.toString())} title={file.path}>
            <IconFileText size={15} aria-hidden /><span className="project-search-path">{file.path}</span>
          </Link></li>)
        : current.matches.map(match => <li key={`${match.path}:${match.line}:${match.column}`}>
          <Link className="project-search-result" to={projectFileHref(projectId, match.path, params.toString(), match.line)}
            title={`${match.path} line ${match.line}`}>
            <span className="project-search-path">{match.path}<span className="project-search-line">:{match.line}:{match.column}</span></span>
            <span className="project-search-excerpt">{match.excerpt}</span>
            {match.more && <span className="project-search-more-in-file">More matches in this file</span>}
          </Link></li>)}
    </ul>}
    {current?.continueAfter && !current.invalidPattern && <div className="project-search-more">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAfter(current.continueAfter ?? undefined)}>
        {busy ? "Searching…" : "More results"}</Button>
    </div>}
  </section>;
}
