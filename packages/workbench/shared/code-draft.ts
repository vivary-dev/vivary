const DRAFT_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export function codeDraftThreadId(projectId: string | null, key: string): string {
  return "vivary-code:" + (projectId ? "project:" + projectId + ":" : "") + key;
}

export function codeDraftSelectionKey(projectId: string | null, threadId: string): string | null {
  const prefix = codeDraftThreadId(projectId, "");
  if (!threadId.startsWith(prefix)) return null;
  const key = threadId.slice(prefix.length);
  return DRAFT_KEY.test(key) ? key : null;
}
