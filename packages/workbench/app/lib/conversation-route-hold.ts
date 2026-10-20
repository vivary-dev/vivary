import { useEffect, useSyncExternalStore } from "react";
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

// One hold for the page, outside any component. The view that asks for an open in another project can unmount while
// the project changes, as the Code conversation does, so the hold cannot live in that view's state.
let held: HeldRoute | undefined;
let newest = 0;
let currentRoute = "";
const listeners = new Set<() => void>();
function setHeld(update: (current: HeldRoute | undefined) => HeldRoute | undefined): void {
  const next = update(held);
  if (next === held) return;
  held = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Opens a conversation route in another project and keeps it there. `Workspace.tsx` clears the old conversation route
 * when the project changes, and the new project then restores its saved conversation or Native chat onto the bare
 * route. Either can land after a plain navigation, which would open the restored conversation instead of the clicked
 * one. A held route is applied once the target project is selected and the old route is gone, applied again with
 * replace if a restore replaces it, and released after it holds for CONVERSATION_ROUTE_SETTLE_MS or when the owner
 * presses a key or the pointer.
 *
 * Call it before `selectProject`. It returns a release for that hold only: when the selection fails, the release ends
 * the hold if no newer hold replaced it, and returns whether it was still the newest. A slow, failed open therefore never
 * releases a later click's hold. `useConversationRouteHold` applies the hold, so a component that stays mounted across
 * project changes must run it. `CodeRunControl` in the layout does.
 */
export function holdConversationRoute(projectId: string | null, href: string): () => boolean {
  const id = ++newest;
  setHeld(() => ({ id, projectId, href, from: currentRoute, landed: false }));
  return () => {
    if (newest !== id) return false;
    setHeld(current => current?.id === id ? undefined : current);
    return true;
  };
}

/**
 * Applies the page's route hold. Mount it once, in a component that stays mounted while the project changes.
 * `activeProjectId` and `checking` come from `useProjects()`. It returns `hold` for callers that mount it.
 */
export function useConversationRouteHold({ activeProjectId, checking }: {
  activeProjectId: string | null; checking: boolean;
}): { hold: typeof holdConversationRoute } {
  const location = useLocation();
  const navigate = useNavigate();
  const current = useSyncExternalStore(subscribe, () => held, () => held);
  const route = location.pathname + location.search;
  currentRoute = route;
  useEffect(() => {
    if (!current || checking || activeProjectId !== current.projectId) return;
    if (route === current.href) {
      if (!current.landed) { setHeld(value => value === current ? { ...current, landed: true } : value); return; }
      const release = setTimeout(() => setHeld(value => value === current ? undefined : value),
        CONVERSATION_ROUTE_SETTLE_MS);
      return () => clearTimeout(release);
    }
    // Workspace would clear a target that lands before the old route, so wait for the old route to go.
    if (!current.landed && route === current.from && hasWorkspaceRoute(location.pathname, location.search)) return;
    navigate(current.href, { replace: current.landed });
  }, [current, checking, activeProjectId, route, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!current) return;
    const ownerActed = () => setHeld(() => undefined);
    document.addEventListener("keydown", ownerActed, true);
    document.addEventListener("pointerdown", ownerActed, true);
    return () => {
      document.removeEventListener("keydown", ownerActed, true);
      document.removeEventListener("pointerdown", ownerActed, true);
    };
  }, [current !== undefined]);
  return { hold: holdConversationRoute };
}
