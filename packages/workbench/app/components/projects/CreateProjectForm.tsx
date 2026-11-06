import { useEffect, useState } from "react";
import { IconFileText } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNativeActionCaller } from "@/lib/native-actions";
import type { RegistrationResult } from "@/lib/project-catalog-schema";
import { WorkspacePatternChoices } from "./WorkspacePatternChoices";
import { workspacePatternCatalog, workspacePreset, type WorkspacePatternChoice,
  type WorkspacePatternDefinition, type WorkspacePreset } from "../../../shared/workspace-patterns.ts";

type PlannedFile = {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
};
type Preview = {
  code: "preview";
  plan: {
    schema: "vivary.thin-init-plan/v1";
    target: string;
    files: PlannedFile[];
    plan_sha256: string;
  };
};
type Created = {
  code: "created" | "already-created";
  target: string;
  planSha256: string;
  registration: RegistrationResult;
};
type CreateResult = Created | { code: "plan-changed" };

export function CreateProjectForm({
  disabled,
  onClose,
  onCreated,
}: {
  disabled: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => Promise<boolean>;
}) {
  const { call, ready } = useNativeActionCaller();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<WorkspacePreset>("coding");
  const [catalog, setCatalog] = useState<WorkspacePatternDefinition[] | null>(null);
  const [patternChoices, setPatternChoices] = useState<WorkspacePatternChoice[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState<"preview" | "create" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void call<unknown>("vivary-workspace-pattern-catalog", {}).then(value => {
      if (!cancelled) setCatalog(workspacePatternCatalog.parse(value).patterns);
    }).catch(error => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "The installed guidance is unavailable.");
    });
    return () => { cancelled = true; };
  }, [call, ready]);

  async function previewProject(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setWorking("preview");
    try {
      setPreview(await call<Preview>("vivary-preview-new-project", {
        name, preset, patternChoices,
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The project preview failed.");
    } finally {
      setWorking(null);
    }
  }

  async function createProject() {
    if (!preview) return;
    setMessage(null);
    setWorking("create");
    try {
      const result = await call<CreateResult>("vivary-create-new-project", {
        name,
        preset,
        displayName: name,
        acceptedPlanSha256: preview.plan.plan_sha256,
        patternChoices,
      });
      if (result.code === "plan-changed") {
        setPreview(null);
        setMessage("The project plan changed. Preview the files again before creating it.");
        return;
      }
      const registration = result.registration;
      if (registration.code !== "registered" && registration.code !== "already-registered") {
        setMessage("The files were created, but the project could not be registered. Retry creation.");
        return;
      }
      if (await onCreated(registration.projectId)) {
        onClose();
      } else {
        setMessage("Project created. Retry selecting it from the Projects list.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The project could not be created. Retry the same plan safely.");
    } finally {
      setWorking(null);
    }
  }

  const unavailable = disabled || !ready || catalog === null || working !== null;
  return <form className="project-registration" onSubmit={previewProject} aria-label="Create project">
    <label htmlFor="new-project-name">Project name</label>
    <Input id="new-project-name" value={name} autoComplete="off" maxLength={128}
      pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" disabled={unavailable}
      aria-describedby="new-project-name-help"
      title="Use 1 to 128 ASCII letters, numbers, periods, underscores, or hyphens. Start with a letter or number. Do not end with a period. Do not use CON, PRN, AUX, NUL, COM1 through COM9, or LPT1 through LPT9."
      onChange={event => {
        setName(event.target.value);
        setPreview(null);
        setMessage(null);
      }} />
    <p id="new-project-name-help">Use 1 to 128 ASCII letters, numbers, periods, underscores, or hyphens. Start with a letter or number. Do not end with a period. Do not use CON, PRN, AUX, NUL, COM1 through COM9, or LPT1 through LPT9. Vivary creates the project in its managed Projects folder.</p>
    <label htmlFor="new-project-preset">Workspace type</label>
    <select id="new-project-preset" value={preset} disabled={unavailable}
      onChange={event => {
        setPreset(workspacePreset.parse(event.target.value));
        setPreview(null);
        setMessage(null);
      }}>
      <option value="coding">Coding</option>
      <option value="second-brain">Second brain</option>
      <option value="knowledge-work">Knowledge work</option>
      <option value="writing">Writing</option>
    </select>
    {catalog && <WorkspacePatternChoices catalog={catalog} value={patternChoices}
      disabled={unavailable} onChange={next => {
        setPatternChoices(next);
        setPreview(null);
        setMessage(null);
      }} />}
    {preview && <section aria-label="Project file preview">
      <p><strong>{preview.plan.files.length} guidance files</strong> will be created.</p>
      <p className="break-all">Folder: {preview.plan.target}</p>
      {preview.plan.files.map(file => <details key={file.path}>
        <summary><IconFileText size={14} /> {file.path} <span>{file.bytes} bytes</span></summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{file.content}</pre>
      </details>)}
    </section>}
    {message && <p role="status">{message}</p>}
    <div className="project-form-actions">
      {!preview && <Button size="sm" type="submit" disabled={unavailable || !name}>
        {working === "preview" ? "Preparing preview…" : "Preview files"}
      </Button>}
      {preview && <Button size="sm" type="button" disabled={unavailable}
        onClick={() => void createProject()}>
        {working === "create" ? "Creating…" : "Create project"}
      </Button>}
      <Button size="sm" variant="ghost" type="button" disabled={working !== null} onClick={onClose}>
        Cancel
      </Button>
    </div>
  </form>;
}
