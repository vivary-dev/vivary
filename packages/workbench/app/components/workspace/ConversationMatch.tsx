import { useEffect, useState, type RefObject } from "react";
import { useSearchParams } from "react-router";

/** Core renders stable message anchors asynchronously; settle the match after its own layout work. */
export function ConversationMatch({ container, messageId, canReturnToLatest = true, archived = false }: {
  container: RefObject<HTMLElement | null>; messageId: string | null; canReturnToLatest?: boolean; archived?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const [found, setFound] = useState(false), [waiting, setWaiting] = useState(true);
  useEffect(() => {
    setFound(false); setWaiting(true);
    if (!messageId || !container.current) {
      const timer = setTimeout(() => setWaiting(false), 10_000);
      return () => clearTimeout(timer);
    }
    const root = container.current;
    let marked: HTMLElement | undefined;
    let originalTabIndex: string | null = null, originalLabel: string | null = null;
    let frame = 0, settleTimer: ReturnType<typeof setTimeout> | undefined;
    let userMoved = false, focused = false, arrivedAt = 0;
    const restore = () => {
      if (!marked) return;
      marked.classList.remove("vivary-conversation-match");
      if (originalTabIndex === null) marked.removeAttribute("tabindex"); else marked.setAttribute("tabindex", originalTabIndex);
      if (originalLabel === null) marked.removeAttribute("aria-label"); else marked.setAttribute("aria-label", originalLabel);
    };
    const userIntent = (event: Event) => { if (event.isTrusted) userMoved = true; };
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) root.addEventListener(name, userIntent, { capture: true, passive: true });
    const center = () => {
      if (!marked || userMoved) return;
      const viewport = marked.closest<HTMLElement>(".message-scroller-viewport");
      if (viewport) {
        // The installed scroller treats wheel intent as leaving following-bottom. AssistantChat
        // exposes no auto-scroll prop; use the scroller's existing DOM interaction boundary.
        viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
        const box = marked.getBoundingClientRect(), view = viewport.getBoundingClientRect();
        viewport.scrollTop += box.top - view.top - Math.max(0, (view.height - box.height) / 2);
      } else marked.scrollIntoView({ block: "center" });
      if (!focused) { marked.focus({ preventScroll: true }); focused = true; }
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(center); });
    };
    const resize = new ResizeObserver(() => { if (Date.now() - arrivedAt < 5000) settle(); });
    const mark = () => {
      const target = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(element => element.dataset.messageId === messageId);
      if (!target) return;
      if (target !== marked) {
        restore(); marked = target; focused = false; arrivedAt = Date.now();
        originalTabIndex = target.getAttribute("tabindex"); originalLabel = target.getAttribute("aria-label");
        target.classList.add("vivary-conversation-match"); target.tabIndex = -1; target.setAttribute("aria-label", "Matching message");
        resize.disconnect(); resize.observe(target);
        const viewport = target.closest<HTMLElement>(".message-scroller-viewport");
        if (viewport) { resize.observe(viewport); if (viewport.firstElementChild) resize.observe(viewport.firstElementChild); }
        const keepInView = () => {
          if (userMoved || Date.now() - arrivedAt >= 2500) return;
          settle(); settleTimer = setTimeout(keepInView, 100);
        };
        clearTimeout(settleTimer); keepInView();
        setFound(true); setWaiting(false);
      }
      if (Date.now() - arrivedAt < 5000) settle();
    };
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true }); mark();
    const timer = setTimeout(() => setWaiting(false), 10_000);
    return () => {
      observer.disconnect(); resize.disconnect(); clearTimeout(timer); clearTimeout(settleTimer); cancelAnimationFrame(frame); restore();
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) root.removeEventListener(name, userIntent, true);
    };
  }, [container, messageId]);
  if (!params.get("message") && !params.get("event")) return null;
  return <div className="local-agent-notice" role={waiting || found ? "status" : "alert"}>
    <span>{found ? "Matching message highlighted." : waiting ? "Opening matching message…" : "This match could not be shown. It may have changed. Search again."}</span>
    {archived && <span>Restore this conversation from Archived conversations, then reopen it to continue.</span>}
    <button type="button" disabled={!canReturnToLatest} onClick={() => setParams(current => {
      const next = new URLSearchParams(current); next.delete("message"); next.delete("event"); next.delete("eventOffset"); return next;
    }, { replace: true })}>Return to latest conversation</button>
  </div>;
}
