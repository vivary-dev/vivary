export type ConversationSurface = "native" | "code";
export type NativeHistoryKind = "project" | "unassigned";

export function savedNativeHistoryKind(value: unknown): NativeHistoryKind {
  return value === "unassigned" ? "unassigned" : "project";
}

export function requestedConversationSurface(params: URLSearchParams): ConversationSurface | null {
  if (params.get("runtime") === "native") return "native";
  if (params.get("runtime") === "code" || params.has("run") || params.has("draft")) return "code";
  return null;
}

export function restoredConversationSurface(
  requested: ConversationSurface | null,
  saved: unknown,
): ConversationSurface | null {
  if (requested) return requested;
  return saved === "native" || saved === "code" ? saved : null;
}

export function conversationSurfaceStateKey(scopeKey: string, projectId: string | null): string {
  const bytes = new TextEncoder().encode(JSON.stringify([scopeKey, projectId]));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return "vivary-active-conversation-v1:" + encoded;
}
