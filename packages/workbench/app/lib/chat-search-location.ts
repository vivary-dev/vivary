import type { ChatSearchHit } from "./chat-search-schema";

export function chatSearchHref(hit: ChatSearchHit, unassigned: boolean, search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["run", "draft", "runtime", "history", "thread", "message", "event", "eventOffset"]) params.delete(key);
  params.set("history", unassigned ? "unassigned" : "project");
  if (hit.runtime === "native") {
    params.set("runtime", "native"); params.set("thread", hit.sessionId); params.set("message", hit.referenceId);
  } else {
    params.set("run", hit.sessionId); params.set("event", hit.referenceId); params.set("eventOffset", String(hit.eventOffset));
  }
  return "/?" + params.toString();
}
