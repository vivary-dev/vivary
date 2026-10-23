const pendingCreations = new Map<string, symbol>();

/**
 * One renderer-local admission claim per server-derived chat storage key, shared by Code and sidebar controls.
 * Hold it until creation and draft initialization settle, including after navigation or unmount. The returned
 * release function belongs to this token and cannot release a later claim. An occupied claim never queues work.
 */
export function claimNativeConversationCreation(storageKey: string): (() => void) | null {
  if (pendingCreations.has(storageKey)) return null;
  const token = Symbol();
  pendingCreations.set(storageKey, token);
  return () => {
    if (pendingCreations.get(storageKey) === token) pendingCreations.delete(storageKey);
  };
}
