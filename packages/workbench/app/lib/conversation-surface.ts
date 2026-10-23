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

/**
 * The surface a project opens with when nothing is requested or saved. A Personal project starts as API chat.
 * A Coding project, a project whose kind is Not set, and the Personal workspace keep the Code default.
 */
export function defaultConversationSurface(kind: "coding" | "personal" | null | undefined): ConversationSurface {
  return kind === "personal" ? "native" : "code";
}

/**
 * The surface New conversation opens. A project with a chosen kind follows that kind. Not set and the Personal
 * workspace keep the earlier behavior and follow the surface already open.
 */
export function newConversationSurface(
  kind: "coding" | "personal" | null | undefined,
  current: ConversationSurface,
): ConversationSurface {
  return kind ? defaultConversationSurface(kind) : current;
}

export function conversationSurfaceStateKey(scopeKey: string, projectId: string | null): string {
  const bytes = new TextEncoder().encode(JSON.stringify([scopeKey, projectId]));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return "vivary-active-conversation-v1:" + encoded;
}
