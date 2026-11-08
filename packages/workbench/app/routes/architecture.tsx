import { SharedRichEditor } from "@agent-native/toolkit/editor";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { Link } from "react-router";
import type { MouseEvent } from "react";
import architecture from "../../../../docs/ARCHITECTURE.md?raw";
import { documentationLink, resolveDocumentationLinks } from "@/lib/documentation-links";
import { focusFootnote } from "@/lib/footnote-links";
import "@agent-native/toolkit/editor.css";

const readOnlyFeatures = { image: false, tables: true, tasks: true, link: true, footnotes: true };
const documentWithOnlineLinks = resolveDocumentationLinks(architecture);

export function meta() {
  return [{ title: "High-level design | Vivary" }];
}

export default function ArchitectureRoute() {
  useSetPageTitle("High-level design");

  function openReference(event: MouseEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    if (focusFootnote(event)) {
      event.stopPropagation();
      return;
    }
    const anchor = event.target.closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const heading = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("h1, h2, h3, h4"))
        .find(item => item.textContent?.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-") === href.slice(1));
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
      return;
    }
    const destination = documentationLink(href);
    if (destination) window.open(destination, "_blank", "noopener,noreferrer");
  }

  return <article className="file-document" aria-label="High-level design">
    <header className="file-document-toolbar">
      <div className="min-w-0">
        <p className="file-breadcrumb">Documentation</p>
        <h2>High-level design</h2>
      </div>
      <Link className="vivary-settings-link" to="/settings">Return to settings</Link>
    </header>
    <div className="file-reading-surface" onClickCapture={openReference}
      onAuxClickCapture={event => { if (event.button === 1) openReference(event); }}>
      <SharedRichEditor value={documentWithOnlineLinks} onChange={() => {}}
        editable={false} interactive={true} dragHandle={false} dialect="gfm"
        features={readOnlyFeatures} ariaLabel="High-level design document" />
    </div>
    <footer className="file-document-footer">
      <span>References open online in your browser.</span>
      <span>This copy is available without a connection.</span>
    </footer>
  </article>;
}
