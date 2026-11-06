import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@agent-native/toolkit/ui";
import { Link, useSearchParams } from "react-router";
import { useNativeActionCaller } from "@/lib/native-actions";
import { projectFileHref } from "@/lib/project-file-location";
import {
  conflictNotice,
  EFFECTIVE_WHEN_TEXT,
  FACT_LIMITS,
  forgetDisclosure,
  LOCATION_PROBLEM_TEXT,
  privacySentence,
  sameFactFile,
  storageSentence,
  WORKSPACE_ROLES,
  type MemoryFact,
  type ProjectMemoryView,
  type ProjectMemoryWriteInput,
  type ProjectMemoryWriteResult,
} from "@/lib/project-memory-schema";

type FactDraft = { title: string; text: string; source: string };
type Load = { kind: "loading" } | { kind: "ready"; view: ProjectMemoryView } | { kind: "error"; message: string };
// One editor at a time. A conflict keeps the owner's draft and shows the
// current file beside it, like the Files route.
type Editor =
  | { kind: "closed" }
  /** `takenTitle`: a title whose file name exists. Save waits until the title makes a different file name. */
  | { kind: "remember"; draft: FactDraft; existing: MemoryFact | null; takenTitle: string | null }
  | { kind: "correct"; fact: MemoryFact; draft: FactDraft; current: MemoryFact | null }
  | { kind: "forget"; fact: MemoryFact; current: MemoryFact | null };

const EMPTY_DRAFT: FactDraft = { title: "", text: "", source: "" };
const SKIP_REASON_TEXT = {
  linked: "a link or a file with several names", "too-large": "larger than 256 KB", binary: "not text",
  unsupported: "not a supported text file", private: "ignored by .gitignore", unreadable: "in use by another program",
  "no-permission": "Vivary does not have permission to read it",
  "not-checked": "not checked against the ignore rules",
  "unsupported-name": "Vivary cannot use this file name",
  "read-limit": "not read, because this load reached its read limit",
} as const;
const ROLE_LABELS = { law: "Law", map: "Map", record: "Record", memory: "Memory", boundary: "Boundary" } as const;

function draftOf(fact: MemoryFact): FactDraft {
  return { title: fact.title, text: fact.text, source: fact.source ?? "" };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** `visible`: whether Project details is showing. The panel stays mounted while hidden. */
type PanelProps = { projectId: string; disabled: boolean; visible: boolean };

// Keyed by project, so another project's facts and drafts never show here.
export function ProjectMemoryPanel(props: PanelProps) {
  return <ProjectMemorySection key={props.projectId} {...props} />;
}

function ProjectMemorySection({ projectId, disabled, visible }: PanelProps) {
  const { call, ready } = useNativeActionCaller();
  const [params] = useSearchParams();
  const ids = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [editor, setEditor] = useState<Editor>({ kind: "closed" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const request = useRef(0);
  // A write can finish after the project became unavailable or the panel closed.
  const disabledRef = useRef(disabled);
  const mounted = useRef(true);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => () => { mounted.current = false; }, []);
  const list = useRef<HTMLDivElement>(null);
  const editorOpen = editor.kind !== "closed";

  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const view = await call<ProjectMemoryView>("vivary-project-memory", { projectId });
      if (request.current === current) setLoad({ kind: "ready", view });
    } catch (error) {
      if (request.current === current) setLoad({ kind: "error", message: errorText(error, "Memory could not be read. Try again.") });
    }
  }, [call, projectId]);

  // Read again each time Project details opens, since files can change while it is hidden.
  useEffect(() => { if (!disabled && ready && visible) void refresh(); }, [disabled, ready, visible, refresh]);
  // An unavailable project shows none of its earlier facts or drafts.
  useEffect(() => {
    if (!disabled) return;
    request.current += 1;
    setLoad({ kind: "loading" });
    setEditor({ kind: "closed" });
  }, [disabled]);
  useEffect(() => () => { request.current += 1; }, []);
  // Focus returns to the fact list when an editor closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !editorOpen) list.current?.focus();
    wasOpen.current = editorOpen;
  }, [editorOpen]);

  function apply(operation: ProjectMemoryWriteInput["operation"], result: ProjectMemoryWriteResult) {
    if (result.code === "unavailable") {
      setNotice({ tone: "alert", text: result.message });
      return;
    }
    if (result.code !== "conflict") {
      const path = result.code === "forgotten" ? result.path : result.fact.path;
      const verb = result.code === "remembered" ? "Saved" : result.code === "corrected" ? "Corrected" : "Forgot";
      setEditor({ kind: "closed" });
      setNotice({ tone: "status", text: `${verb} ${path}. This applies from your next message.` });
      return;
    }
    if (result.reason === "exists") {
      setEditor(current => current.kind === "remember"
        ? { ...current, existing: result.current ?? null, takenTitle: current.draft.title } : current);
    } else if (result.reason === "renamed-or-deleted") {
      // The fact's file is gone, so a correction's draft can only become a new fact.
      setEditor(current => current.kind === "correct"
        ? { kind: "remember", draft: current.draft, existing: null, takenTitle: null }
        : current.kind === "forget" ? { kind: "closed" } : current);
    } else if (result.reason === "changed") {
      setEditor(current => current.kind === "correct" || current.kind === "forget"
        ? { ...current, current: result.current ?? null } : current);
    } else {
      // Keep the owner's draft, as on a changed conflict. A forget has no draft to keep.
      setEditor(current => current.kind === "forget" ? { kind: "closed" } : current);
    }
    setNotice({ tone: "alert", text: conflictNotice(operation, result.reason, result.path) });
  }

  async function write(input: ProjectMemoryWriteInput) {
    setBusy(true);
    setNotice(null);
    const current = () => mounted.current && !disabledRef.current;
    try {
      const result = await call<ProjectMemoryWriteResult>("vivary-project-memory-write", input);
      // An unavailable project gets no view and no reopened draft.
      if (current()) apply(input.operation, result);
    } catch (error) {
      if (current()) setNotice({ tone: "alert", text: errorText(error, "Memory could not be saved. Try again.") });
    } finally {
      // Stay busy until the list shows the result, so no control acts on a stale fact.
      if (current()) await refresh();
      setBusy(false);
    }
  }

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    if (editor.kind === "remember") void write({ projectId, operation: "remember", ...editor.draft });
    if (editor.kind === "correct") {
      void write({ projectId, operation: "correct", path: editor.fact.path, expectedVersion: editor.fact.version, ...editor.draft });
    }
  }

  const blocked = disabled || !ready || busy;
  const source = (path: string, label = path) =>
    <Link to={projectFileHref(projectId, path, params.toString())}>{label}</Link>;
  const heading = `${ids}-memory`;

  if (load.kind !== "ready") {
    return <section className="project-memory" aria-labelledby={heading} data-agent-native="project-memory">
      <h4 id={heading}>Memory</h4>
      {load.kind === "loading" && <p role="status">{disabled ? "Memory is unavailable while the project folder is unavailable." : "Reading memory…"}</p>}
      {load.kind === "error" && <>
        <p role="alert">{load.message}</p>
        <Button size="sm" variant="outline" disabled={disabled || !ready} onClick={() => void refresh()}>Try again</Button>
      </>}
    </section>;
  }

  const { view } = load;
  const { settings } = view;
  const privacy = privacySentence(settings);

  return <section className="project-memory" aria-labelledby={heading} aria-busy={busy} data-agent-native="project-memory">
    <h4 id={heading}>Memory</h4>
    <p data-agent-native="project-memory-location">{storageSentence(view)}{" "}
      {settings.status === "plain"
        ? "Adopting this folder as a Vivary workspace makes the location configurable."
        : source(".vivary/workspace.toml", "Change in workspace.toml")}</p>
    <p className="project-read-muted">Files stay on this host and can be committed with the project. They are separate from
      {" "}.vivary/memory/, which holds optional semantic-search data.</p>
    {privacy && <p className="project-read-muted">{privacy}</p>}

    {settings.status === "thin" && <dl className="project-memory-roles" data-agent-native="project-memory-roles">
      {WORKSPACE_ROLES.map(role => <div key={role}>
        <dt>{ROLE_LABELS[role]}</dt>
        <dd>{settings.roles[role].length > 0 ? settings.roles[role].join(", ")
          : role === "memory" ? "(none, default applies)" : "(none)"}</dd>
      </div>)}
      <div><dt>State</dt><dd>{settings.state}</dd></div>
    </dl>}

    {view.locations.filter(location => location.status === "refused").map(location =>
      <p key={location.path} role="note" data-agent-native="project-memory-refused">
        <strong>{location.path}</strong> is not used. {location.status === "refused" && LOCATION_PROBLEM_TEXT[location.problem]}
      </p>)}

    <h5>When changes apply</h5>
    <p>{EFFECTIVE_WHEN_TEXT}</p>

    {notice && <p role={notice.tone} data-agent-native="project-memory-notice">{notice.text}</p>}

    <div ref={list} tabIndex={-1} className="project-memory-facts" aria-label="Project facts">
      {view.facts.length === 0 ? <p>No facts are saved yet.</p> : <ul data-agent-native="project-memory-facts">
        {view.facts.map(fact => <li key={fact.path} data-path={fact.path}>
          <strong>{fact.title}</strong>
          {fact.shortenedForAgents && <span className="project-read-muted" data-agent-native="project-memory-shortened">
            {" "}Shortened for agents</span>}
          <p>{fact.text}</p>
          <p className="project-read-muted">Source: {fact.source ?? "not recorded"}. Confirmed {fact.confirmed ?? "date not recorded"}.
            {" "}{source(fact.path)}</p>
          <div className="project-memory-actions">
            <Button size="sm" variant="outline" disabled={blocked || editorOpen} data-agent-native="project-memory-correct"
              onClick={() => { setNotice(null); setEditor({ kind: "correct", fact, draft: draftOf(fact), current: null }); }}>Correct</Button>
            <Button size="sm" variant="outline" disabled={blocked || editorOpen} data-agent-native="project-memory-forget"
              onClick={() => { setNotice(null); setEditor({ kind: "forget", fact, current: null }); }}>Forget</Button>
          </div>
        </li>)}
      </ul>}
      {view.truncated && <p className="project-read-muted">
        A memory folder holds more files than Vivary lists. The list shows up to 200 files per folder, sorted by file name.</p>}
      {view.skipped.length > 0 && <>
        <p className="project-read-muted">Skipped files:</p>
        <ul className="project-read-muted" data-agent-native="project-memory-skipped">
          {view.skipped.map(file => <li key={file.path}>{file.path}: {SKIP_REASON_TEXT[file.reason]}</li>)}
        </ul>
      </>}
    </div>

    {(editor.kind === "remember" || editor.kind === "correct") && <form className="project-memory-form" onSubmit={submitDraft}
      aria-label={editor.kind === "remember" ? "Remember a fact" : `Correct ${editor.fact.title}`}
      data-agent-native={`project-memory-${editor.kind}-form`}>
      <h5>{editor.kind === "remember" ? "Remember a fact" : `Correct ${editor.fact.path}`}</h5>
      <label htmlFor={`${ids}-title`}>Title</label>
      <input id={`${ids}-title`} required maxLength={FACT_LIMITS.title} value={editor.draft.title} autoFocus disabled={busy}
        onChange={event => setEditor({ ...editor, draft: { ...editor.draft, title: event.target.value } })} />
      <label htmlFor={`${ids}-text`}>Fact</label>
      <textarea id={`${ids}-text`} required maxLength={FACT_LIMITS.text} rows={4} value={editor.draft.text} disabled={busy}
        onChange={event => setEditor({ ...editor, draft: { ...editor.draft, text: event.target.value } })} />
      <label htmlFor={`${ids}-source`}>Source</label>
      <input id={`${ids}-source`} required maxLength={FACT_LIMITS.source} value={editor.draft.source} disabled={busy}
        onChange={event => setEditor({ ...editor, draft: { ...editor.draft, source: event.target.value } })} />
      {editor.kind === "remember" && editor.existing && <div className="file-conflict" role="note">
        <p>Current fact in {editor.existing.path}:</p>
        <pre>{editor.existing.text}</pre>
        <Button type="button" size="sm" variant="outline" disabled={blocked}
          onClick={() => editor.existing && setEditor({ kind: "correct", fact: editor.existing,
            draft: editor.draft, current: null })}>Correct this fact</Button>
      </div>}
      {editor.kind === "correct" && editor.current && <div className="file-conflict" role="note">
        <p>Current version in {editor.current.path}:</p>
        <pre>{editor.current.text}</pre>
        <Button type="button" size="sm" variant="outline" disabled={blocked}
          onClick={() => editor.current && setEditor({ ...editor, fact: editor.current, current: null })}>Use current version</Button>
      </div>}
      <div className="project-memory-actions">
        <Button type="submit" size="sm" disabled={blocked || (editor.kind === "correct" && editor.current !== null)
          || (editor.kind === "remember" && editor.takenTitle !== null
            && sameFactFile(editor.takenTitle, editor.draft.title))}
          data-agent-native="project-memory-save">{editor.kind === "remember" ? "Save fact" : "Save correction"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditor({ kind: "closed" })}>Cancel</Button>
      </div>
    </form>}

    {editor.kind === "forget" && <div className="project-memory-form" role="group" aria-label={`Forget ${editor.fact.title}`}
      data-agent-native="project-memory-forget-confirm">
      <p role="alert">{forgetDisclosure(editor.fact.path)}</p>
      {editor.current && <div className="file-conflict" role="note">
        <p>This fact changed after you opened it. Current version:</p>
        <pre>{editor.current.text}</pre>
        <Button type="button" size="sm" variant="outline" disabled={blocked}
          onClick={() => editor.current && setEditor({ ...editor, fact: editor.current, current: null })}>Use current version</Button>
      </div>}
      <div className="project-memory-actions">
        <Button size="sm" variant="destructive" disabled={blocked || editor.current !== null}
          data-agent-native="project-memory-forget-submit"
          onClick={() => void write({ projectId, operation: "forget", path: editor.fact.path, expectedVersion: editor.fact.version })}>
          Forget fact</Button>
        {/* Focus starts on Cancel, so Enter never forgets by accident. */}
        <Button size="sm" variant="ghost" disabled={busy} autoFocus onClick={() => setEditor({ kind: "closed" })}>Cancel</Button>
      </div>
    </div>}

    {!editorOpen && <Button size="sm" variant="outline" disabled={blocked || view.writeLocation === null}
      data-agent-native="project-memory-remember"
      onClick={() => { setNotice(null); setEditor({ kind: "remember", draft: EMPTY_DRAFT, existing: null, takenTitle: null }); }}>
      Remember a fact</Button>}
    {view.writeLocation === null && <p className="project-read-muted">No memory folder can take a new fact. Change the memory role in .vivary/workspace.toml.</p>}

    <details className="project-memory-preview" data-agent-native="project-memory-preview">
      <summary>What agents receive</summary>
      <p className="project-read-muted">This is the Code form. Full chat adds one sentence saying Native's owner-wide
        memory, resources, chat-history, and database tools are unavailable in project chats.</p>
      <p className="project-read-muted" data-agent-native="project-memory-revision">
        This preview is revision {view.previewRevision}. {view.lastLoad
        ? `Last loaded by ${view.lastLoad.surface === "code" ? "Code" : "Full chat"} at ${new Date(view.lastLoad.at).toLocaleString()}: `
          + `${view.lastLoad.factCount} fact${view.lastLoad.factCount === 1 ? "" : "s"}, revision ${view.lastLoad.revision}.`
        : "No message has loaded this project's context since Vivary started."}</p>
      <pre>{view.preview}</pre>
    </details>
  </section>;
}
