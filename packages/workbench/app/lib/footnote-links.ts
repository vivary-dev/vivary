import type { MouseEvent } from "react";

// The read-only Markdown readers render a footnote reference as a link to `#fn-<number>`, and its
// note as the list item with that id inside the notes section. Following the link moves focus to the
// note inside the same reader, so the route and its URL stay unchanged. Any other link, including a
// heading link such as `#fn-details`, or a note link whose note is not rendered, is left alone.
// Returns whether the click was handled as a note link.
export function focusFootnote(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return false;
  const href = event.target.closest("a[href^='#fn-']")?.getAttribute("href");
  const number = href?.match(/^#fn-(\d+)$/)?.[1];
  if (!number) return false;
  const note = event.currentTarget.querySelector<HTMLElement>(`section.an-rich-md-footnotes li[id="fn-${number}"]`);
  if (!note) return false;
  event.preventDefault();
  note.tabIndex = -1;
  note.focus();
  return true;
}
