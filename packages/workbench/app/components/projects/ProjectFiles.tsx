import { useActionQuery } from "@agent-native/core/client/hooks";
import { Skeleton } from "@agent-native/toolkit/ui";
import { IconFileText, IconFolder } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router";
import { useProjects } from "./ProjectContext";
import type { ProjectFilesResult } from "@/lib/project-file-schema";

import { projectFileHref } from "@/lib/project-file-location";

export { projectFileHref };

export function ProjectFiles() {
  const { activeProject, workspaceAvailable, checking } = useProjects();
  const [params] = useSearchParams();
  const projectId = activeProject?.projectId;
  const query = useActionQuery<ProjectFilesResult>("vivary-project-files", { projectId }, {
    enabled: Boolean(projectId) && workspaceAvailable && !checking, retry: false,
    refetchOnWindowFocus: true,
  });
  if (!projectId) return <p className="project-files-empty">Choose a project to browse its files.</p>;
  if (!workspaceAvailable) return <p className="project-files-empty" role="alert">This project folder is unavailable.</p>;
  if (checking || query.isPending) return <div className="p-3 space-y-3" aria-label="Reading project files"><Skeleton className="h-6 w-4/5" /><Skeleton className="h-6 w-3/5" /><Skeleton className="h-6 w-4/5" /></div>;
  if (query.isError) return <div className="project-files-empty" role="alert">Files could not be read. <button onClick={() => void query.refetch()}>Retry</button></div>;
  if (query.data?.code !== "listing") return null;
  const groups = new Map<string, typeof query.data.files>();
  for (const file of query.data.files) {
    const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }
  const rows = (files: typeof query.data.files) => files.map(file =>
    <Link key={file.path} to={projectFileHref(projectId, file.path, params.toString())}
      className={"project-file-link" + (params.get("project") === projectId && params.get("path") === file.path ? " is-active" : "")}
      aria-current={params.get("project") === projectId && params.get("path") === file.path ? "page" : undefined}
      title={file.path}>
      <IconFileText size={15} aria-hidden /><span>{file.name}</span>
      {file.access === "blocked" && <span className="sr-only">Preview unavailable</span>}
    </Link>);
  return <section className="project-files-tree" aria-label="Project files">
    <header><h2>Files</h2><button onClick={() => void query.refetch()} aria-label="Refresh files">Refresh</button></header>
    <p className="project-files-host">{activeProject?.displayName} · connected host</p>
    {query.data.files.length === 0 && <p className="project-files-empty">No visible files in this project.</p>}
    {rows(groups.get("") ?? [])}
    {[...groups.entries()].filter(([directory]) => directory).map(([directory, files]) =>
      <details key={directory} open className="project-file-folder"><summary><IconFolder size={15} aria-hidden />{directory}</summary>{rows(files)}</details>)}
    {query.data.truncated && <p className="project-files-empty">Showing the first files. The full project is still on the host.</p>}
  </section>;
}
