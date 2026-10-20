import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent-native/toolkit/ui";
import { IconCode, IconNotes } from "@tabler/icons-react";
import { useNativeActionCaller } from "@/lib/native-actions";
import { CATALOG_QUERY_KEY, type CatalogResult, withProjectKind } from "@/lib/project-catalog-schema";
import { useProjects } from "./ProjectContext";
import { workspaceKindLabel, type WorkspaceKind } from "../../../shared/workspace-kind.ts";

const CHOICES: ReadonlyArray<{ kind: WorkspaceKind; title: string; body: string; Icon: typeof IconCode }> = [
  { kind: "coding", title: "Coding", Icon: IconCode,
    body: "New conversations start with a coding agent (Claude Code or Codex). Handoff uses STATE.md." },
  { kind: "personal", title: "Personal", Icon: IconNotes,
    body: "New conversations start as API chat for notes, research and writing." },
];

/**
 * Asks Coding or Personal. The choice sets defaults and locks nothing. Each card is a native button, so Tab, Enter
 * and Space work, and the arrow keys move between the two cards. Escape, the close button and Cancel all cancel.
 * `onChoose` may save. Its rejection keeps the dialog open with the message.
 */
export function WorkspaceKindDialog({ open, description, current = null, onChoose, onCancel }: {
  open: boolean;
  description: string;
  current?: WorkspaceKind | null;
  onChoose: (kind: WorkspaceKind) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState<WorkspaceKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (open) { setSaving(null); setError(null); }
  }, [open]);

  async function choose(kind: WorkspaceKind) {
    if (saving) return;
    setSaving(kind);
    setError(null);
    try {
      await onChoose(kind);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "The project kind could not be saved. Try again.");
    } finally {
      setSaving(null);
    }
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = cards.current.findIndex(card => card === document.activeElement);
    const next = (Math.max(index, 0) + step + CHOICES.length) % CHOICES.length;
    cards.current[next]?.focus();
  }

  return <Dialog open={open} onOpenChange={next => { if (!next && !saving) onCancel(); }}>
    <DialogContent className="workspace-kind-dialog" closeLabel="Cancel"
      onOpenAutoFocus={event => {
        // Focus the current kind, else the first card, instead of the close button.
        event.preventDefault();
        cards.current[Math.max(CHOICES.findIndex(choice => choice.kind === current), 0)]?.focus();
      }}>
      <DialogHeader>
        <DialogTitle>What kind of project is this?</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="workspace-kind-choices" role="group" aria-label="Project kind" onKeyDown={moveFocus}>
        {CHOICES.map(({ kind, title, body, Icon }, index) => <button key={kind} type="button"
          ref={card => { cards.current[index] = card; }}
          className="workspace-kind-card" aria-pressed={current === kind}
          aria-describedby={`workspace-kind-${kind}-body`} disabled={saving !== null}
          onClick={() => void choose(kind)}>
          <Icon size={20} aria-hidden />
          <span className="workspace-kind-card-title">{saving === kind ? "Saving…" : title}</span>
          <span id={`workspace-kind-${kind}-body`} className="workspace-kind-card-body">{body}</span>
        </button>)}
      </div>
      <p className="workspace-kind-note">You can start either kind of conversation in any project.</p>
      {error && <p role="alert">{error}</p>}
      <DialogFooter>
        <Button size="sm" variant="ghost" type="button" disabled={saving !== null} onClick={onCancel}>Cancel</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * Saves a registered project's kind and refreshes the project list so every view reads the new value. A failed
 * refetch does not reject and keeps the cached list, so the saved kind is written into that list first. Otherwise a
 * new Personal project would open with the stale Not set and keep the Code surface.
 */
export function useSaveProjectKind() {
  const { call } = useNativeActionCaller();
  const { refresh } = useProjects();
  const queryClient = useQueryClient();
  return async (projectId: string, kind: WorkspaceKind) => {
    await call("vivary-set-project-kind", { projectId, workspaceKind: kind });
    await queryClient.cancelQueries({ queryKey: CATALOG_QUERY_KEY, exact: true });
    queryClient.setQueryData<CatalogResult>(CATALOG_QUERY_KEY, current => withProjectKind(current, projectId, kind));
    await refresh();
  };
}

/** The Project details row for the kind. Its button shows only where the host can save a kind. */
export function ProjectKindDetail({ kind, editable, onChange }: {
  kind: WorkspaceKind | null;
  editable: boolean;
  onChange: () => void;
}) {
  return <><dt>Project kind</dt><dd className="workspace-kind-detail">
    <span>{workspaceKindLabel(kind)}</span>
    {editable && <Button size="sm" variant="outline" onClick={onChange}>{kind ? "Change kind" : "Set kind"}</Button>}
  </dd></>;
}
