// Coordinate root replacement with the Code host's final synchronous run admission.
const key = Symbol.for("vivary.workbench.project-reconnection-admission");
const state = globalThis[key] ??= { claim: null };

export function claimProjectReconnection() {
  if (state.claim !== null) return null;
  const claim = Symbol("project-reconnection");
  state.claim = claim;
  return () => {
    if (state.claim === claim) state.claim = null;
  };
}

export function projectReconnectionPending() {
  return state.claim !== null;
}
