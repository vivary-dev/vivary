import { AsyncLocalStorage } from 'node:async_hooks';
const current = new AsyncLocalStorage();
export const runWithBrowserIdentity = (identity, run) => current.run(identity, run);
export const currentBrowserIdentity = () => current.getStore();
// Only the outer listener can register a context. No HTTP field conveys this authority.
const contexts = new WeakMap();
export function admitBrowserContext(context, identity) { contexts.set(context, identity); }
export function browserRequestIdentity(context) { return context && contexts.get(context); }
export function isDesktopRequest(context) { return browserRequestIdentity(context)?.kind === 'desktop'; }
