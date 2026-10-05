import { createElement, type ReactNode } from "react";
import { lowercaseMatches } from "./chat-search-matches";

/** Literal, case-insensitive highlighting. React escapes every text fragment, including markup. */
export function highlightedExcerpt(text: string, query: string): ReactNode[] {
  if (!query) return [text];
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const match of lowercaseMatches(text, query)) {
    if (!match.highlightable) continue;
    nodes.push(text.slice(start, match.start), createElement("mark", { key: match.start }, text.slice(match.start, match.end)));
    start = match.end;
  }
  nodes.push(text.slice(start)); return nodes;
}

export function chatMatchTime(matchedAt?: string, sessionUpdatedAt?: number, now = Date.now()) {
  const time = matchedAt ? Date.parse(matchedAt) : sessionUpdatedAt;
  if (time === undefined || !Number.isFinite(time)) return { label: "Saved conversation", title: undefined };
  const seconds = (time - now) / 1000;
  const unit = Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
  const divisor = unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
  return { label: new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / divisor), unit),
    title: new Date(time).toLocaleString() };
}
