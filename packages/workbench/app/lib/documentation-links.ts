const SOURCE_DOCUMENT = "https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md";
const CONCEPTS_PAGE = "https://vivary.vercel.app/concepts/";
const REPOSITORY_PREFIX = "https://github.com/vivary-dev/vivary/blob/dev/";

/** Resolve links in the bundled document to explicit online pages. */
export function documentationLink(href: string): string | null {
  if (href === "/concepts/") return CONCEPTS_PAGE;
  if (!href || href.startsWith("/") || href.startsWith("\\")) return null;

  try {
    const target = new URL(href, SOURCE_DOCUMENT);
    if ((target.protocol !== "https:" && target.protocol !== "http:") ||
        target.username || target.password) return null;

    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href);
    if (!absolute && !target.href.startsWith(REPOSITORY_PREFIX)) return null;
    if (href === "../packages") return "https://github.com/vivary-dev/vivary/tree/dev/packages";
    return target.href;
  } catch {
    return null;
  }
}


/** Put safe online destinations into the Markdown before the editor creates anchors. */
export function resolveDocumentationLinks(markdown: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, href: string) => {
    if (href.startsWith("#")) return link;
    return "](" + (documentationLink(href) ?? "#") + ")";
  });
}
