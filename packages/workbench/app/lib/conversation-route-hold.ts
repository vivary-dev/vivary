import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/** How long an opened conversation's route must hold before a later restore may replace it. */
export const CONVERSATION_ROUTE_SETTLE_MS = 750;

/** The route keys `Workspace.tsx` clears when the selected project changes. Keep this list in step with it. */
export const WORKSPACE_ROUTE_KEYS = ["panel", "path", "project", "runtime", "thread", "history", "run", "draft", "line",
  "message", "event", "eventOffset"] as const;

/** Workspace renders only on the home route, so another page has no conversation route to clear. */
export function hasWorkspaceRoute(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  return pathname === "/" && WORKSPACE_ROUTE_KEYS.some(key => params.has(key));
}

type HeldRoute = { id: number; projectId: string | null; href: string; from: string; landed: boolean };

/**
 * Opens a conversation route in another project and keeps it there. `Workspace.tsx` clears the old conversation route
 * when the project changes, and the new project then restores its saved conversation or Native chat onto the bare
 * route. Either can land after a plain navigation, which would open the restored conversation instead of the clicked
 * one. A held route is applied once the target project is selected and the old route is gone, applied again with
 * replace if a restore replaces it, and released after it holds for CONVERSATION_ROUTE_SETTLE_MS or when the owner
 * presses a key or the pointer.
 *
 * Call `hold` before `selectProject`. It returns a release for that hold only: when the selection fails, the release ends
 * the hold if no newer hold replaced it, and returns whether it was still the newest. A slow, failed open therefore never
 * releases a later click's hold. `activeProjectId` and `checking` come from `useProjects()`.
 */
export function useConversationRouteHold({ activeProjectId, checking }: {
  activeProjectId: string | null; checking: boolean;
}): { hold: (projectId: string | null, href: string) => () => boolean } {
  const location = useLocation();
  const navigate = useNavigate();
  const [held, setHeld] = useState<HeldRoute>();
  const newest = useRef(0);
  const route = location.pathname + location.search;
  useEffect(() => {
    if (!held || checking || activeProjectId !== held.projectId) return;
    if (route === held.href) {
      if (!held.landed) { setHeld({ ...held, landed: true }); return; }
      const release = setTimeout(() => setHeld(current => current === held ? undefined : current),
        CONVERSATION_ROUTE_SETTLE_MS);
      return () => clearTimeout(release);
    }
    // Workspace would clear a target that lands before the old route, so wait for the old route to go.
    if (!held.landed && route === held.from && hasWorkspaceRoute(location.pathname, location.search)) return;
    navigate(held.href, { replace: held.landed });
  }, [held, checking, activeProjectId, route, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!held) return;
    const ownerActed = () => setHeld(undefined);
    document.addEventListener("keydown", ownerActed, true);
    document.addEventListener("pointerdown", ownerActed, true);
    return () => {
      document.removeEventListener("keydown", ownerActed, true);
      document.removeEventListener("pointerdown", ownerActed, true);
    };
  }, [held !== undefined]);
  const hold = useCallback((projectId: string | null, href: string) => {
    const id = ++newest.current;
    setHeld({ id, projectId, href, from: route, landed: false });
    return () => {
      if (newest.current !== id) return false;
      setHeld(current => current?.id === id ? undefined : current);
      return true;
    };
  }, [route]);
  return { hold };
}
