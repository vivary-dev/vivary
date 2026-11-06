import { createContext, useContext, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readClientAppState, useActionQuery } from "@agent-native/core/client/hooks";
import { useAppStateWriter } from "@/lib/native-state";
import {
  selectionSchema,
  type CatalogProject,
  type CatalogResult,
  type ProjectCatalog,
  type ProjectSelection,
} from "@/lib/project-catalog-schema";

const SELECTION_KEY = "vivary-project-selection-v1";

type ProjectContextValue = {
  catalog: ProjectCatalog | null;
  activeProject: CatalogProject | null;
  checking: boolean;
  workspaceAvailable: boolean;
  historyAvailable: boolean;
  selecting: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectProject: (projectId: string | null) => Promise<boolean>;
  retrySelection: (() => Promise<boolean>) | null;
};

type SelectionTarget = { scopeKey: string; projectId: string | null };

type SelectionIssue =
  | { kind: "unavailable"; message: string }
  | { kind: "pending"; target: SelectionTarget }
  | { kind: "requested-unavailable"; message: string; target: SelectionTarget }
  | { kind: "save"; message: string; target: SelectionTarget }
  | null;

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { ready: stateWriterReady, retrySession, sessionStatus, writeAppState } = useAppStateWriter();
  const catalogQuery = useActionQuery<CatalogResult>("vivary-project-catalog", {}, {
    retry: false, refetchOnWindowFocus: "always", refetchInterval: 30000,
  });
  const [selecting, setSelecting] = useState(false);
  const [selectionIssue, setSelectionIssue] = useState<SelectionIssue>(null);
  const latestSelection = useRef(0);
  const selectionWrites = useRef<Promise<void>>(Promise.resolve());
  const response: CatalogResult | undefined = catalogQuery.data;
  const verified = response?.code === "catalog" ? response : null;
  const catalog = verified;
  const selectionQuery = useQuery({
    queryKey: [SELECTION_KEY, verified?.scopeKey], enabled: verified !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = await readClientAppState(SELECTION_KEY, { signal });
      const parsed = selectionSchema.safeParse(value);
      if (value == null) return null;
      if (!parsed.success) throw new Error("The saved project selection is invalid. Choose a project again.");
      return parsed.data;
    },
  });
  const checking = catalogQuery.isPending || (verified !== null && selectionQuery.isPending)
    || sessionStatus === "loading";
  const issueTarget = selectionIssue && "target" in selectionIssue ? selectionIssue.target : null;
  const saved = issueTarget
    ? { scopeKey: issueTarget.scopeKey, projectId: issueTarget.projectId }
    : selectionQuery.data;
  const issueScopeMatches = issueTarget === null || issueTarget.scopeKey === catalog?.scopeKey;
  const activeProject = catalog && selectionQuery.isSuccess && issueScopeMatches
    && saved != null && saved.scopeKey === catalog.scopeKey && saved.projectId !== null
    ? catalog.projects.find(project => project.projectId === saved.projectId) ?? null
    : null;

  const workspaceAvailable = catalog !== null && catalogQuery.isSuccess && selectionQuery.isSuccess && issueScopeMatches
    && (saved == null || (saved.scopeKey === catalog.scopeKey
      && (saved.projectId === null || activeProject?.status === "available")));

  const historyAvailable = catalog !== null && selectionQuery.isSuccess && issueScopeMatches
    && (saved == null || (saved.scopeKey === catalog.scopeKey
      && (saved.projectId === null || activeProject !== null)));

  async function refresh() {
    retrySession();
    await catalogQuery.refetch();
    if (selectionQuery.isError) await selectionQuery.refetch();
  }

  async function requestSelection(target: SelectionTarget, retainRequestedSelection = false) {
    const attempt = ++latestSelection.current;
    if (!stateWriterReady) {
      setSelecting(false);
      retrySession();
      setSelectionIssue({
        kind: "save",
        message: sessionStatus === "unavailable"
          ? "Your Native session could not be verified. Retry the project selection."
          : "Project selection cannot be saved until you are signed in.",
        target,
      });
      return false;
    }
    setSelecting(true);
    if (!retainRequestedSelection) setSelectionIssue(null);
    try {
      const checked = await catalogQuery.refetch();
      if (latestSelection.current !== attempt) return false;
      if (!checked.isSuccess || checked.data?.code !== "catalog"
        || checked.data.scopeKey !== target.scopeKey
        || (target.projectId !== null && !checked.data.projects.some(project =>
          project.projectId === target.projectId))) {
        setSelectionIssue({
          kind: "requested-unavailable",
          message: "This project is no longer available. Refresh the project list.",
          target,
        });
        return false;
      }
      const next: ProjectSelection = {
        scopeKey: target.scopeKey,
        projectId: target.projectId,
      };
      setSelectionIssue({ kind: "pending", target });
      await queryClient.cancelQueries({ queryKey: [SELECTION_KEY, target.scopeKey], exact: true });
      if (latestSelection.current !== attempt) return false;
      queryClient.setQueryData([SELECTION_KEY, target.scopeKey], next);
      const queuedWrite = selectionWrites.current.then(async () => {
        if (latestSelection.current !== attempt) return false;
        await writeAppState(SELECTION_KEY, next);
        return latestSelection.current === attempt;
      });
      selectionWrites.current = queuedWrite.then(() => undefined, () => undefined);
      if (!await queuedWrite) return false;
      await queryClient.cancelQueries({ queryKey: [SELECTION_KEY, target.scopeKey], exact: true });
      if (latestSelection.current !== attempt) return false;
      queryClient.setQueryData([SELECTION_KEY, target.scopeKey], next);
      setSelectionIssue(null);
      return true;
    } catch {
      if (latestSelection.current === attempt) {
        setSelectionIssue({
          kind: "save",
          message: "Project selection could not be saved.",
          target,
        });
      }
      return false;
    } finally {
      if (latestSelection.current === attempt) setSelecting(false);
    }
  }

  async function selectProject(projectId: string | null) {
    if (!catalog) {
      setSelectionIssue({ kind: "unavailable", message: "Project folders could not be loaded. Refresh the list to retry." });
      return false;
    }
    return requestSelection({ scopeKey: catalog.scopeKey, projectId });
  }

  const selectionMessage = selectionIssue?.kind === "pending" ? null : selectionIssue?.message ?? null;
  const error = selectionMessage ?? (catalogQuery.isError || (!checking && !catalog)
    ? "Project folders could not be loaded. Refresh the list to retry."
    : selectionQuery.isError ? "The saved project selection could not be read. Choose a project again."
      : !checking && !workspaceAvailable ? activeProject?.reconnectEligible
        ? "This project is unavailable. Review its connection in the project list, or choose another project."
        : "This project is unavailable. Its saved conversations are retained. Choose another project to access files." : null);
  const retrySelection = (selectionIssue?.kind === "save" || selectionIssue?.kind === "requested-unavailable")
    ? () => requestSelection(selectionIssue.target, true)
    : null;
  const value = useMemo(() => ({ catalog, activeProject, checking, workspaceAvailable, historyAvailable, selecting, error,
    refresh, selectProject, retrySelection }),
  [catalog, activeProject, checking, workspaceAvailable, historyAvailable, selecting, error, retrySelection]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("ProjectProvider is required");
  return context;
}
