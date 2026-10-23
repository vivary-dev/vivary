import { createElement, useState } from "react";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { folderConnectionErrorMessage, useNativeActionCaller } from "@/lib/native-actions";
import { useQueryClient } from "@tanstack/react-query";
import { CATALOG_QUERY_KEY, openedFolderNeedsKind, type CatalogResult, type RegistrationResult } from "@/lib/project-catalog-schema";
import { WorkspaceKindDialog, useSaveProjectKind } from "./WorkspaceKindDialog";
import { useProjects } from "./ProjectContext";

export function registrationMessage(code: RegistrationResult["code"]) {
  if (code === "denied") return "Your folder access changed. Refresh the project list.";
  if (["root-unavailable", "not-directory", "identity-unverified", "binding-unavailable"].includes(code)) {
    return "This folder is unavailable. Reconnect it from Projects.";
  }
  if (["stale-policy", "retry-state"].includes(code)) return "The project list changed. Review the refreshed list and try again.";
  return "This folder could not be registered. Review the project name and folder, then try again.";
}

/**
 * Open folder: the desktop folder picker registers a folder as a project and selects it. The Code shared-folder
 * warning offers it too, for a separate folder or a Git worktree the owner made.
 */
export function useOpenProjectFolder() {
  const { refresh, selectProject } = useProjects();
  const { call } = useNativeActionCaller();
  const queryClient = useQueryClient();
  const saveProjectKind = useSaveProjectKind();
  const [kindPrompt, setKindPrompt] = useState<{ projectId: string; displayName: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();
  const desktop = useActionQuery<{ folderPicker: boolean }>("vivary-desktop-status", {}, {
    retry: false, staleTime: Infinity,
  });
  async function selectOpenedFolder(projectId: string) {
    if (!await selectProject(projectId)) setError("Folder connected. Select it from Projects.");
  }
  async function openFolder() {
    if (choosing || kindPrompt) return;
    setChoosing(true);
    setError(undefined);
    try {
      const result = await call<(RegistrationResult & { displayName?: string }) | { code: "cancelled" }>(
        "vivary-connect-project-folder", {},
      );
      if (result.code === "cancelled") return;
      await refresh();
      if (result.code === "registered" || result.code === "already-registered") {
        const catalog = queryClient.getQueryData<CatalogResult>(CATALOG_QUERY_KEY);
        if (openedFolderNeedsKind(result.code, result.projectId, catalog)) {
          setKindPrompt({ projectId: result.projectId, displayName: result.displayName ?? "This folder" });
        } else await selectOpenedFolder(result.projectId);
      } else {
        setError(registrationMessage(result.code));
      }
    } catch (failure) {
      setError(folderConnectionErrorMessage(failure));
    } finally {
      setChoosing(false);
    }
  }
  // Registration already succeeded. A failed kind save keeps this prompt open; Cancel keeps the registered project
  // with its unset kind. Render this at the hook owner, so removing a cancelled queue row cannot lose the prompt.
  const kindDialog = createElement(WorkspaceKindDialog, {
    open: kindPrompt !== null,
    description: `${kindPrompt?.displayName ?? "This folder"} is registered. Your choice is saved in Vivary. No files in the folder change.`,
    onChoose: async kind => {
      if (!kindPrompt) return;
      await saveProjectKind(kindPrompt.projectId, kind);
      setKindPrompt(null);
      await selectOpenedFolder(kindPrompt.projectId);
    },
    onCancel: () => {
      if (!kindPrompt) return;
      setKindPrompt(null);
      void selectOpenedFolder(kindPrompt.projectId);
    },
  });
  return { available: desktop.data?.folderPicker === true, choosing, error, openFolder, kindDialog };
}
