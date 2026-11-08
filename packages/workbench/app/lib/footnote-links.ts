import type { MouseEvent } from "react";

// The read-only Markdown readers render a footnote reference as a link to `#fn-<number>`, and its
// note as the list item with that id inside the notes section. Each note ends with return links to its
// references, `#fnref-<number>` for the first and `#fnref-<number>-<k>` for the k-th, the ids the
// reference links carry. Following either kind of link moves focus inside the same reader, so the route
// and its URL stay unchanged. Only the link inside a rendered reference (`sup.an-rich-md-footnote-ref`)
// is a note link, and only a rendered return link inside the notes section is a return link. Any other
// link, including a heading link such as `#fn-details` or `#fn-1`, or a link whose target is not
// rendered, is left alone.
const NOTE_LINK = "sup.an-rich-md-footnote-ref > a[href^='#fn-']";
const RETURN_LINK = "section.an-rich-md-footnotes a.an-rich-md-footnote-backref[href^='#fnref-']";

// Returns whether the click was handled as a note link or a return link.
export function focusFootnote(event: MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return false;
  const link = event.target.closest(`${NOTE_LINK}, ${RETURN_LINK}`);
  const href = link?.getAttribute("href") ?? "";
  const number = link?.matches(NOTE_LINK) ? href.match(/^#fn-(\d+)$/)?.[1] : undefined;
  const reference = link?.matches(RETURN_LINK) ? href.match(/^#(fnref-\d+(?:-\d+)?)$/)?.[1] : undefined;
  let target: HTMLElement | null = null;
  if (number) {
    target = event.currentTarget.querySelector<HTMLElement>(`section.an-rich-md-footnotes li[id="fn-${number}"]`);
    // A list item is not focusable until it has a tab index.
    if (target) target.tabIndex = -1;
  } else if (reference) {
    // The reference link is focusable already, so it keeps its place in the tab order.
    target = event.currentTarget.querySelector<HTMLElement>(`sup.an-rich-md-footnote-ref > a[id="${reference}"]`);
  }
  if (!target) return false;
  event.preventDefault();
  target.focus();
  return true;
}
