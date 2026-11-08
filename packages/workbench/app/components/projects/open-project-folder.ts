import { useState } from "react";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { folderConnectionErrorMessage, useNativeActionCaller } from "@/lib/native-actions";
import type { RegistrationResult } from "@/lib/project-catalog-schema";
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
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();
  const desktop = useActionQuery<{ folderPicker: boolean }>("vivary-desktop-status", {}, {
    retry: false, staleTime: Infinity,
  });
  async function openFolder() {
    setChoosing(true);
    setError(undefined);
    try {
      const result = await call<RegistrationResult | { code: "cancelled" }>(
        "vivary-connect-project-folder", {},
      );
      if (result.code === "cancelled") return;
      await refresh();
      if (result.code === "registered" || result.code === "already-registered") {
        if (!await selectProject(result.projectId)) setError("Folder connected. Select it from Projects.");
      } else {
        setError(registrationMessage(result.code));
      }
    } catch (failure) {
      setError(folderConnectionErrorMessage(failure));
    } finally {
      setChoosing(false);
    }
  }
  return { available: desktop.data?.folderPicker === true, choosing, error, openFolder };
}
