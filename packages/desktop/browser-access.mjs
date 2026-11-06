import { randomBytes } from 'node:crypto';

export const desktopCapability = () => randomBytes(32).toString('base64url');

export function createDesktopCapabilityHandler(getContents, origin, capability) {
  let initialNavigation = true;
  return (details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).filter(([key]) => key.toLowerCase() !== 'x-vivary-desktop'));
    try {
      const contents = getContents();
      const frame = details.frame;
      const destination = new URL(details.url);
      const owned = contents && !contents.isDestroyed() && details.webContentsId === contents.id
        && frame && frame === contents.mainFrame && !frame.detached && frame.parent === null;
      const initial = owned && initialNavigation && details.method === 'GET' && details.resourceType === 'mainFrame'
        && destination.href === `${origin}/` && ['', 'about:blank'].includes(frame.url);
      const trusted = owned && !['', 'about:blank'].includes(frame.url) && new URL(frame.url).origin === origin;
      if (destination.origin === origin && (initial || trusted)) {
        headers['x-vivary-desktop'] = capability;
        initialNavigation = false;
      }
    } catch { /* Detached frames are denied during navigation. */ }
    callback({ requestHeaders: headers });
  };
}

export function attachBrowserAccessDialogs(child, getWindow, showMessageBox) {
  let pending = false;
  let disposed = false;
  const onMessage = async message => {
    if (disposed || message?.type !== 'vivary:browser-access:confirm' || typeof message.requestId !== 'string'
      || !/^[a-f0-9-]{36}$/.test(message.requestId) || typeof message.detail !== 'string' || message.detail.length > 1200) return;
    let approved = false;
    const window = getWindow();
    if (!pending && window && !window.isDestroyed()) {
      pending = true;
      try {
        const result = await showMessageBox(window, { type: 'question', title: 'Vivary remote access',
          message: 'Confirm remote access change', detail: message.detail,
          buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0, noLink: true });
        approved = result.response === 1;
      } catch { /* A closed dialog never grants access. */ }
      finally { pending = false; }
    }
    if (!disposed && child.connected) child.send({ type: 'vivary:browser-access:confirmed', requestId: message.requestId, approved }, () => undefined);
  };
  child.on('message', onMessage);
  return () => { disposed = true; child.off('message', onMessage); };
}
