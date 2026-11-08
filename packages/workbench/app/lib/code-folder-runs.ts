import type { VivaryCodeActiveRun, VivaryCodeFolderRun } from "../../server/local-code-agent";

/** A conversation working in this folder, with the project its Open goes to. */
export type FolderRun = VivaryCodeFolderRun & { projectId: string | null };

/**
 * The other conversations working in this folder, without the selected one. The caller's own runs open in their own
 * project, which is null for the personal workspace. A run that matches none of the caller's active runs, such as
 * another owner's, keeps the selected project, and the warning offers it no Open.
 */
export function folderRunTargets(folderRuns: readonly VivaryCodeFolderRun[],
  activeRuns: readonly Pick<VivaryCodeActiveRun, "id" | "projectId">[], selectedRunId: string | null | undefined,
  projectId: string | null): FolderRun[] {
  return folderRuns.filter(item => item.id !== selectedRunId).map(item => {
    const active = activeRuns.find(run => run.id === item.id);
    return { ...item, projectId: active ? active.projectId : projectId };
  });
}
