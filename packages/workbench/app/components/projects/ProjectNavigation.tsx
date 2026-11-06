import { useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { Skeleton } from "@agent-native/toolkit/ui";
import { IconFolderPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { folderConnectionErrorMessage, useNativeActionCaller } from "@/lib/native-actions";
import { CreateProjectForm } from "./CreateProjectForm";
import { ReconnectProjectForm } from "./ReconnectProjectForm";
import { useProjects } from "./ProjectContext";
import type { ProjectCatalog, RegistrationAttempt, RegistrationResult } from "@/lib/project-catalog-schema";

function registrationMessage(code: RegistrationResult["code"]) {
  if (code === "denied") return "Your folder access changed. Refresh the project list.";
  if (["root-unavailable", "not-directory", "identity-unverified", "binding-unavailable"].includes(code)) {
    return "This folder is unavailable. Reconnect it from Projects.";
  }
  if (["stale-policy", "retry-state"].includes(code)) return "The project list changed. Review the refreshed list and try again.";
  return "This folder could not be registered. Review the project name and folder, then try again.";
}

function RegistrationForm({ catalog, disabled, onClose }: { catalog: ProjectCatalog; disabled: boolean; onClose: () => void }) {
  const { selectProject, refresh } = useProjects();
  const [displayName, setDisplayName] = useState("");
  const [locationRef, setLocationRef] = useState(catalog.locations.find(location => location.status === "available")?.locationRef ?? "");
  const [attempt, setAttempt] = useState<RegistrationAttempt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { call, ready } = useNativeActionCaller();
  const [pending, setPending] = useState(false);
  const available = catalog.locations.some(location => location.locationRef === locationRef && location.status === "available");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!displayName.trim() || Array.from(displayName).length > 200) {
      setMessage("Enter a project name of up to 200 characters.");
      return;
    }
    const request = attempt ?? { operationId: crypto.randomUUID().replaceAll("-", ""),
      expectedPolicyRevision: catalog.policyRevision, expectedRegistryRevision: catalog.registryRevision,
      locationRef, displayName, contentIdentity: null, attachProjectId: null };
    setAttempt(request);
    setMessage(null);
    setPending(true);
    try {
      const result = await call<RegistrationResult>("vivary-register-project", request);
      setAttempt(null);
      if (result.code === "registered" || result.code === "already-registered") {
        if (await selectProject(result.projectId)) onClose();
        else setMessage("Project registered. Refresh the list to select it.");
      } else {
        setMessage(registrationMessage(result.code));
        await refresh();
      }
    } catch {
      setMessage("The result is uncertain. Retry this same registration to check it safely.");
    } finally {
      setPending(false);
    }
  }

  return <form className="project-registration" onSubmit={submit} aria-label="Register project">
    <label htmlFor="project-name">Project name</label>
    <Input id="project-name" value={displayName} maxLength={400} disabled={disabled || pending}
      onChange={event => { setDisplayName(event.target.value); setAttempt(null); setMessage(null); }} autoComplete="off" />
    <label htmlFor="project-folder">Connected folder</label>
    <select id="project-folder" value={locationRef} disabled={disabled || pending}
      onChange={event => { setLocationRef(event.target.value); setAttempt(null); setMessage(null); }}>
      {catalog.locations.map(location => <option key={location.locationRef} value={location.locationRef}
        disabled={location.status !== "available"}>{location.displayName}{location.status !== "available" ? " — unavailable" : ""}</option>)}
    </select>
    <p>Registration keeps the folder's files as they are.</p>
    {message && <p role="status">{message}</p>}
    <div className="project-form-actions">
      <Button size="sm" type="submit" disabled={disabled || !ready || pending || !available}>
        {pending ? "Registering…" : attempt ? "Retry registration" : "Register"}
      </Button>
      <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={onClose}>Cancel</Button>
    </div>
  </form>;
}

export function ProjectNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    catalog, activeProject, checking, workspaceAvailable, selecting, error,
    refresh, selectProject, retrySelection,
  } = useProjects();
  const projectHeading = useRef<HTMLHeadingElement>(null);
  const projectButtons = useRef(new Map<string, HTMLButtonElement>());
  const recoveryFocus = useRef<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!checking && catalog && recoveryFocus.current) {
      if (document.activeElement === projectHeading.current) {
        projectButtons.current.get(recoveryFocus.current)?.focus();
      }
      recoveryFocus.current = null;
    }
  }, [catalog, checking]);
  async function reconnected(projectId: string, displayName: string) {
    recoveryFocus.current = projectId;
    // The heading survives even if a session refresh temporarily hides the list.
    projectHeading.current?.focus();
    setRecoveryNotice(`${displayName} reconnected. Your saved conversations are available.`);
    await refresh();
  }
  async function chooseProject(projectId: string | null) {
    recoveryFocus.current = null;
    setRecoveryNotice(null);
    if (await selectProject(projectId) && location.pathname !== "/") navigate("/");
  }
  const [registering, setRegistering] = useState(false);
  const [creating, setCreating] = useState(false);
  const { call } = useNativeActionCaller();
  const [choosing, setChoosing] = useState(false);
  const [folderError, setFolderError] = useState<string>();
  const desktop = useActionQuery<{ folderPicker: boolean }>("vivary-desktop-status", {}, {
    retry: false, staleTime: Infinity,
  });
  async function openFolder() {
    setChoosing(true);
    setFolderError(undefined);
    try {
      const result = await call<RegistrationResult | { code: "cancelled" }>(
        "vivary-connect-project-folder", {},
      );
      if (result.code === "cancelled") return;
      await refresh();
      if (result.code === "registered" || result.code === "already-registered") {
        if (!await selectProject(result.projectId)) setFolderError("Folder connected. Select it from Projects.");
      } else {
        setFolderError(registrationMessage(result.code));
      }
    } catch (failure) {
      setFolderError(folderConnectionErrorMessage(failure));
    } finally {
      setChoosing(false);
    }
  }
  const lastCatalog = useRef<ProjectCatalog | null>(null);
  if (catalog) lastCatalog.current = catalog;
  return <section className="project-list" aria-labelledby="projects-heading">
    <div className="project-list-heading"><h2 id="projects-heading" ref={projectHeading} tabIndex={-1}>Projects</h2>
      <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={checking} aria-label="Refresh projects">Refresh</Button>
    </div>
    {desktop.data?.folderPicker && <Button size="sm" variant="outline" className="w-full"
      onClick={() => void openFolder()} disabled={choosing || checking || selecting}>
      <IconFolderPlus size={16} />{choosing ? "Choosing folder…" : "Open folder"}
    </Button>}
    {folderError && <p role="status">{folderError}</p>}
    {recoveryNotice && <p role="status">{recoveryNotice}</p>}
    {checking ? <div className="project-list-skeleton" role="status"><span className="sr-only">Checking project access</span>
      <Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : null}
    {!checking && catalog && <>
      <Button variant="ghost" className="project-choice" disabled={selecting}
        aria-pressed={workspaceAvailable && !activeProject} onClick={() => void chooseProject(null)}>Personal workspace</Button>
      {catalog.projects.length === 0 ? <p>{desktop.data?.folderPicker ? "Open a folder to start a project." : "No projects yet. Register a connected folder to begin."}</p>
        : <ul className="registered-projects">{catalog.projects.map(project => <li key={project.projectId}>
          <Button variant="ghost" className="project-choice" disabled={selecting}
            ref={button => {
              if (button) projectButtons.current.set(project.projectId, button);
              else projectButtons.current.delete(project.projectId);
            }}
            aria-pressed={activeProject?.projectId === project.projectId} onClick={() => void chooseProject(project.projectId)}>
            <span>{project.displayName}</span>{project.status !== "available" && <span className="project-unavailable-label">Unavailable</span>}
          </Button>
          {project.reconnectEligible && activeProject?.projectId === project.projectId
            && <ReconnectProjectForm key={catalog.scopeKey + ":" + project.projectId}
              projectId={project.projectId} disabled={checking || selecting}
              onReconnected={() => reconnected(project.projectId, project.displayName)} />}
          {project.status !== "available" && !project.reconnectEligible
            && activeProject?.projectId === project.projectId
            && <p role="status">This folder cannot be reconnected. Restore the original folder and refresh,
              or choose another project. Your conversations are saved.</p>}
        </li>)}</ul>}
      {!creating && <Button size="sm" className="register-project-button" onClick={() => {
        setRegistering(false);
        setCreating(true);
      }}>New project</Button>}
      {!desktop.data?.folderPicker && !registering
        && catalog.locations.some(location => location.status === "available")
        && <Button size="sm" variant="outline" className="register-project-button" onClick={() => {
          setCreating(false);
          setRegistering(true);
        }}>Register existing folder</Button>}
      {!catalog.locations.some(location => location.status === "available")
        && <p>{catalog.projects.some(project => project.reconnectEligible)
          ? "Select an unavailable project to review its connection. You can also create a project here."
          : "No connected folders are available. You can create a managed project here."}</p>}
    </>}
    {creating && <CreateProjectForm disabled={checking || selecting}
      onClose={() => setCreating(false)}
      onCreated={async projectId => {
        await refresh();
        return selectProject(projectId);
      }} />}
    {registering && lastCatalog.current && <div hidden={!catalog}>
      <RegistrationForm key={lastCatalog.current.scopeKey}
        catalog={lastCatalog.current} disabled={checking || !catalog} onClose={() => setRegistering(false)} />
    </div>}
    {error && <div className="flex items-center gap-2" role="status">
      <span className="min-w-0 flex-1">{error}</span>
      {retrySelection && <Button size="sm" variant="ghost" disabled={selecting}
        onClick={() => void retrySelection()}>Retry</Button>}
    </div>}
  </section>;
}
