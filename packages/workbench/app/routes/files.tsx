import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient, useIsMutating } from "@tanstack/react-query";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { SharedRichEditor } from "@agent-native/toolkit/editor";
import { Button, Skeleton } from "@agent-native/toolkit/ui";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useProjects } from "@/components/projects/ProjectContext";
import { fileDraftKey, useFileDraft } from "@/components/projects/FileDrafts";
import { restoreFileLineEndings } from "@/lib/file-draft-state";
import { requestedLine } from "@/lib/project-file-location";
import { focusFootnote } from "@/lib/footnote-links";
import { useNativeActionCaller } from "@/lib/native-actions";
import type { ProjectFile, ProjectFilesResult, ProjectFileSaveResult, ProjectFileRenameResult } from "@/lib/project-file-schema";
import "@agent-native/toolkit/editor.css";
import "../project-files.css";

export function meta() { return [{ title: "Files | Vivary" }]; }
const errorText = (error: unknown) => error instanceof Error ? error.message : "The file action could not finish. Retry.";
const readonlyFeatures = { image: false, tables: true, tasks: true, link: true, footnotes: true };

export default function FilesRoute() {
  const { activeProject, catalog, workspaceAvailable, checking, refresh } = useProjects();
  const [params] = useSearchParams();
  const path = params.get("project") === activeProject?.projectId ? params.get("path") : null;
  const line = path ? requestedLine(params.get("line")) : null;
  if (checking) return <FileSkeleton />;
  if (!workspaceAvailable) return <div className="file-page-empty" role="alert"><h2>Project folder unavailable</h2><p>Your files and drafts stay with this project.</p><Button onClick={() => void refresh()}>Refresh projects</Button></div>;
  if (!activeProject || !catalog) return <div className="file-page-empty"><h2>Open a project to see its files</h2><p>Choose or create a project from the sidebar.</p></div>;
  if (!path) return <div className="file-page-empty"><h2>{activeProject.displayName}</h2><p>Choose a file from the file list to read it here.</p><p className="text-sm text-muted-foreground">Use Show file list if the list is closed.</p></div>;
  return <OpenFile key={catalog.scopeKey + ":" + activeProject.projectId + ":" + path}
    scope={catalog.scopeKey} projectId={activeProject.projectId} projectLabel={activeProject.displayName} path={path} line={line} />;
}

function FileSkeleton() {
  return <div className="file-page-empty space-y-4" aria-busy="true"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-4/5" /><Skeleton className="h-64 w-full" /></div>;
}

function OpenFile({ scope, projectId, projectLabel, path, line }: { scope: string; projectId: string; projectLabel: string; path: string; line: number | null }) {
  const key = useQuery({ queryKey: ["file-draft-key", scope, projectId, path], queryFn: () => fileDraftKey(scope, projectId, path), staleTime: Infinity });
  if (key.isError) return <p role="alert" className="file-page-empty">Draft storage could not be opened. <Button onClick={() => void key.refetch()}>Retry</Button></p>;
  if (!key.data) return <FileSkeleton />;
  return <FileDocument projectId={projectId} projectLabel={projectLabel} path={path} draftKey={key.data} line={line} />;
}

function FileDocument({ projectId, projectLabel, path, draftKey, line }: { projectId: string; projectLabel: string; path: string; draftKey: string; line: number | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const caller = useNativeActionCaller();
  const read = useActionQuery<ProjectFilesResult>("vivary-project-files", { projectId, path }, { retry: false, refetchOnWindowFocus: true });
  const draft = useFileDraft(draftKey);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(path.split("/").at(-1) ?? path);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<ProjectFile | null>(null);
  const [savedFile, setSavedFile] = useState<ProjectFile | null>(null);
  const source = read.data?.code === "file" ? read.data.file : null;
  const file = savedFile ?? source;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const text = draft.data?.content ?? file?.content ?? "";
  const dirty = Boolean(draft.data && draft.data.content !== draft.data.baseContent);
  const tooLarge = new TextEncoder().encode(text).length > 262144;
  const mutationKey = ["project-file-mutation", projectId, path];
  const activeMutations = useIsMutating({ mutationKey });
  const save = useMutation({
    mutationKey,
    mutationFn: () => {
      if (!draft.data) throw new Error("There is no draft to save.");
      return caller.call<ProjectFileSaveResult>("vivary-project-file-save", {
        projectId, path, content: draft.data.content, expectedVersion: draft.data.baseVersion,
      });
    },
    onSuccess: result => {
      if (result.code === "saved") {
        draft.put(null);
        void cache.invalidateQueries({ queryKey: ["action", "vivary-project-files"] });
        void cache.invalidateQueries({ queryKey: ["vivary-handoff-freshness"] });
        if (!mounted.current) return;
        setSavedFile(result.file);
        setEditing(false);
        setConflict(null);
        setNotice("File saved.");
        void read.refetch();
      } else {
        setConflict(result.current ?? null);
        setNotice(result.reason === "renamed-or-deleted"
          ? "The file was renamed or deleted. Your draft is retained."
          : "The file or project changed. Your draft is retained. Review the current file before saving again.");
      }
    },
  });
  const rename = useMutation({
    mutationKey,
    mutationFn: () => {
      if (!file) throw new Error("Refresh the file before renaming.");
      return caller.call<ProjectFileRenameResult>("vivary-project-file-rename", {
        projectId, path, name, expectedVersion: file.version,
      });
    },
    onSuccess: result => {
      if (result.code === "renamed") {
        draft.put(null);
        void cache.invalidateQueries({ queryKey: ["action", "vivary-project-files"] });
        void cache.invalidateQueries({ queryKey: ["vivary-handoff-freshness"] });
        const current = currentLocation.current;
        const params = new URLSearchParams(current.search);
        if (mounted.current && current.pathname === "/" && params.get("project") === projectId && params.get("path") === path) {
          params.set("path", result.file.path);
          navigate({ pathname: current.pathname, search: "?" + params.toString() }, { replace: true });
        }
      } else {
        setNotice(result.reason === "target-exists" ? "That filename already exists. Choose another name."
          : "The file changed before it could be renamed. Refresh and try again.");
        void read.refetch();
      }
    },
  });
  const busy = activeMutations > 0 || save.isPending || rename.isPending;

  useEffect(() => { if (editing) textarea.current?.focus(); }, [editing]);
  useEffect(() => { setSavedFile(null); }, [source]);

  function edit() {
    if (!draft.data && file) draft.put({ content: file.content, baseContent: file.content, baseVersion: file.version });
    setEditing(true);
    setNotice("");
  }
  function discard() {
    if (dirty && !window.confirm("Discard the unsaved changes to this file?")) return;
    draft.put(null);
    setEditing(false);
    setConflict(null);
    setNotice("");
    void read.refetch();
  }

  if (draft.isPending || read.isPending) return <FileSkeleton />;
  if (draft.isError) return <div className="file-page-empty" role="alert"><h2>Draft could not be loaded</h2><p>Retry before editing so a saved draft is not replaced.</p><Button onClick={() => void draft.refetch()}>Retry</Button></div>;
  return <article className="file-document" aria-label={path}>
    <header className="file-document-toolbar">
      <div className="min-w-0"><p className="file-breadcrumb">{projectLabel} · connected host</p><h2 title={path}>{path}</h2></div>
      <div className="file-document-actions">
        {editing ? <><Button disabled={busy || !dirty || tooLarge || !caller.ready} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Read</Button>
          <Button variant="ghost" disabled={busy} onClick={discard}>Discard draft</Button></>
          : <><Button disabled={busy || (!file && !draft.data) || !caller.ready} onClick={edit}>{draft.data ? "Resume edit" : "Edit"}</Button>
            <Button variant="outline" disabled={busy || !file || dirty || !caller.ready} onClick={() => setRenaming(value => !value)}>Rename</Button></>}
      </div>
    </header>
    <div className="file-document-status" role="status">
      {draft.saveStatus === "saving" ? "Saving draft to this host…" : draft.saveStatus === "error" ? "Draft could not be saved to the host. Keep this page open and retry."
        : dirty ? "Unsaved changes · draft retained on this host" : notice || (editing ? "Editing source" : line ? `Reading file · line ${line}` : "Reading file")}
      {draft.saveStatus === "error" && <Button variant="ghost" size="sm" onClick={draft.retrySave}>Retry draft</Button>}
    </div>
    {notice && dirty && <p className="file-notice" role="status">{notice}</p>}
    {(save.isError || rename.isError) && <p className="file-notice" role="alert">{errorText(save.error ?? rename.error)}</p>}
    {read.isError && <div className="file-notice" role="alert">The current file could not be read. Any draft is retained. <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry file</Button></div>}
    {read.data?.code === "blocked" && <p className="file-notice">This file cannot be opened as editable text ({read.data.reason}). It remains on the host.</p>}
    {renaming && <form className="file-rename-form" onSubmit={event => { event.preventDefault(); rename.mutate(); }}>
      <label htmlFor="file-name">Filename</label><input id="file-name" value={name} onChange={event => setName(event.target.value)} autoFocus disabled={busy} />
      <Button disabled={busy || !name.trim()} type="submit">Rename file</Button><Button variant="ghost" type="button" onClick={() => setRenaming(false)}>Cancel</Button>
      <p>Rename within this folder. Existing files are never replaced.</p>
    </form>}
    {conflict && <section className="file-conflict" aria-label="File conflict">
      <h3>Current file on the host</h3><pre>{conflict.content}</pre>
      <p>Compare this version with your draft below. Keeping your draft against this version still requires Save.</p>
      <Button variant="outline" disabled={busy || !draft.data} onClick={() => {
        if (draft.data) draft.put({ ...draft.data, baseVersion: conflict.version, baseContent: conflict.content });
        setConflict(null); setNotice("Current version acknowledged. Review your draft, then Save."); setEditing(true);
      }}>Keep draft against this version</Button>
    </section>}
    {editing ? <div className="file-source-editor">
      <label htmlFor="file-source">Source · {path}</label>
      <textarea id="file-source" ref={textarea} value={text} spellCheck={false} disabled={busy}
        onChange={event => {
          const base = draft.data ?? (file ? { content: file.content, baseContent: file.content, baseVersion: file.version } : null);
          if (base) draft.put({ ...base, content: restoreFileLineEndings(event.target.value, base.baseContent) });
        }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault(); if (!busy && dirty && !tooLarge && caller.ready) save.mutate();
          }
        }} />
      {tooLarge && <p role="alert">This draft exceeds the 256 KB text-file limit. Shorten it before saving.</p>}
    </div> : file ? <div className="file-reading-surface" onClickCapture={focusFootnote}>
      {line !== null ? <SourceLines path={path} content={file.content} line={line} navigation={location.key} />
        : file.kind === "markdown" ? <SharedRichEditor key={file.version} value={file.content} onChange={() => {}}
        editable={false} interactive={false} dragHandle={false} dialect="gfm" features={readonlyFeatures}
        ariaLabel={path} /> : <pre tabIndex={0}>{file.content}</pre>}
    </div> : draft.data ? <div className="file-page-empty"><h3>Your draft is retained</h3><p>Use Resume edit to view or copy it while the file is unavailable.</p></div> : null}
    <footer className="file-document-footer"><span>Conversation stays open beside this document.</span><span>Opening a file does not change it.</span></footer>
  </article>;
}

// A search match opens the file here: the source split into numbered lines
// with the requested line marked and scrolled into view. Markdown shows its
// source in this view too, so the line number stays exact.
function SourceLines({ path, content, line, navigation }: { path: string; content: string; line: number; navigation: string }) {
  const target = useRef<HTMLElement>(null);
  const lines = content.split("\n");
  const found = line <= lines.length;
  // Re-scroll on every navigation, including choosing the same match again
  // after scrolling away; the panel stays mounted while hidden.
  useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [line, content, navigation]);
  return <pre tabIndex={0} className="file-source-lines" aria-label={found ? `${path}, line ${line} selected` : `${path}, line ${line} is past the end`}>
    {lines.map((text, index) => {
      const number = index + 1;
      const current = number === line;
      return <span key={number} ref={current ? target : undefined} className={current ? "file-line is-target" : "file-line"}
        aria-current={current ? "location" : undefined}>
        <span className="file-line-number" aria-hidden>{number}</span>{text}{"\n"}
      </span>;
    })}
  </pre>;
}
