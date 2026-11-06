// Project file locations are URL state: panel, project, path, and an
// optional 1-based line the reader scrolls to. One owner for both halves.
const MAX_LINE = 10_000_000;

export function projectFileHref(projectId: string, path: string, search = "", line?: number | null): string {
  const params = new URLSearchParams(search);
  params.set("panel", "files");
  params.set("project", projectId);
  params.set("path", path);
  if (line !== undefined && line !== null && Number.isInteger(line) && line >= 1 && line <= MAX_LINE) {
    params.set("line", String(line));
  } else {
    params.delete("line");
  }
  return "/?" + params.toString();
}

export function requestedLine(value: string | null | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,7}$/.test(value)) return null;
  const line = Number(value);
  return line <= MAX_LINE ? line : null;
}
