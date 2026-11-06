export type BrowserRequestIdentity = { kind: 'desktop' } | { kind: 'remote'; deviceId: string };
export function admitBrowserContext(context: object, identity: BrowserRequestIdentity): void;
export function browserRequestIdentity(context: object | undefined): BrowserRequestIdentity | undefined;
export function isDesktopRequest(context: object | undefined): boolean;

export function runWithBrowserIdentity<T>(identity: BrowserRequestIdentity, run: () => T): T;
export function currentBrowserIdentity(): BrowserRequestIdentity | undefined;
