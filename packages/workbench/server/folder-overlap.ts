import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Whether two canonical folders are the same folder or one contains the other. Agents in either folder can then change
 * the same files. A Git worktree in a sibling folder does not overlap its main checkout.
 */
export function foldersOverlap(left: string, right: string): boolean {
  const key = (folder: string) => {
    const resolved = path.resolve(folder);
    // Windows and macOS default volumes compare names without case. Treating Windows that way never misses an overlap.
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const [a, b] = [key(left), key(right)];
  return a === b || contains(a, b) || contains(b, a);
}

function contains(outer: string, inner: string): boolean {
  return inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

/** The folder's real path, so a symbolic link and its target compare equal. A folder that cannot be read keeps its name. */
export async function canonicalFolder(folder: string): Promise<string> {
  try { return await realpath(folder); } catch { return path.resolve(folder); }
}

export function canonicalFolderSync(folder: string): string {
  try { return realpathSync(folder); } catch { return path.resolve(folder); }
}
