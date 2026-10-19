import { createContext, useContext, useSyncExternalStore } from "react";
import type { HandoffFreshness } from "../../../shared/handoff";

/** What the conversation's handoff control knows: the freshness it read and the last refused Save. */
export type HandoffDisplayState = {
  status: HandoffFreshness | null;
  refusal: { requestId: string; problems: string[] } | null;
};
export type HandoffStatusHub = {
  get: () => HandoffDisplayState | null;
  set: (state: HandoffDisplayState | null) => void;
  subscribe: (listener: () => void) => () => void;
};

/** One per conversation view. HandoffControl publishes to it, and each reply preview reads it. */
export function createHandoffStatusHub(): HandoffStatusHub {
  let state: HandoffDisplayState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: next => { state = next; for (const listener of listeners) listener(); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const HandoffStatusContext = createContext<HandoffStatusHub | null>(null);
const unpublished = () => () => {};
const nothing = () => null;

export function useHandoffDisplayState(): HandoffDisplayState | null {
  const hub = useContext(HandoffStatusContext);
  return useSyncExternalStore(hub?.subscribe ?? unpublished, hub?.get ?? nothing, hub?.get ?? nothing);
}

/** The save status of the reply for requestId, in the words the owner acts on. null when no control reports one. */
export function handoffSaveStatus(state: HandoffDisplayState | null, requestId: string | null): { text: string; problems?: string[] } | null {
  if (!state?.status || state.status.status === "unavailable") return null;
  const status = state.status;
  if (requestId === null) return { text: "Not saved. The block does not name its request." };
  if (state.refusal?.requestId === requestId)
    return { text: "Refused. Vivary did not save this reply.", problems: state.refusal.problems };
  if (status.status === "pending" && status.requestId === requestId)
    return { text: "Not saved yet. Click Save handoff to write it to the state document." };
  if (status.status === "failed" && status.requestId === requestId) return { text: `Not saved. ${status.message}` };
  const covered = "covered" in status ? status.covered : null;
  if (covered?.requestId === requestId) {
    const file = covered.facts.path;
    if (status.status === "fresh") return { text: `Saved to ${file}. Fresh.` };
    if (status.status === "out-of-date") return { text: `Saved to ${file}. Out of date.` };
    if (status.status === "unverifiable") return { text: `Saved to ${file}. Freshness could not be verified.` };
    return { text: `Saved to ${file}. A newer handoff request is pending.` };
  }
  return { text: "Not saved. This reply does not answer the latest handoff request." };
}
