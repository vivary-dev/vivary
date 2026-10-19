import type { MouseEvent } from "react";

// The read-only Markdown readers render a footnote reference as a link to `#fn-<number>`, and its
// note as the list item with that id. Following the link moves focus to the note inside the same
// reader, so the route and its URL stay unchanged. Returns whether the click was a note link.
export function focusFootnote(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return false;
  const href = event.target.closest("a[href^='#fn-']")?.getAttribute("href");
  if (!href) return false;
  event.preventDefault();
  const note = event.currentTarget.querySelector<HTMLElement>(`[id="${CSS.escape(href.slice(1))}"]`);
  if (note) {
    note.tabIndex = -1;
    note.focus();
  }
  return true;
}
