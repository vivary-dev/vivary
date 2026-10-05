import { createElement, type ReactNode } from "react";

/** Literal, case-insensitive highlighting. React escapes every text fragment, including markup. */
export function highlightedExcerpt(text: string, query: string): ReactNode[] {
  if (!query) return [text];
  const lower = text.toLowerCase(), term = query.toLowerCase();
  const nodes: ReactNode[] = [];
  let start = 0, index: number;
  while ((index = lower.indexOf(term, start)) !== -1) {
    nodes.push(text.slice(start, index), createElement("mark", { key: index }, text.slice(index, index + term.length)));
    start = index + term.length;
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
