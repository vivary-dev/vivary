import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopCapabilityHandler } from '../browser-access.mjs';

test('only the trusted main frame receives the desktop capability', () => {
  const mainFrame = { url: 'http://127.0.0.1:42101/', detached: false, parent: null };
  const contents = { id: 7, mainFrame, isDestroyed: () => false };
  const handler = createDesktopCapabilityHandler(() => contents, 'http://127.0.0.1:42101', 'test-secret');
  const invoke = detail => { let result; handler({ url: 'http://127.0.0.1:42101/_agent-native/auth/session', webContentsId: 7,
    method: 'GET', resourceType: 'xhr', requestHeaders: { 'X-Vivary-Desktop': 'forged' }, ...detail }, value => { result = value; }); return result.requestHeaders; };
  assert.equal(invoke({ frame: mainFrame })['x-vivary-desktop'], 'test-secret');
  for (const detail of [{ frame: { url: 'http://127.0.0.1:9999/', parent: mainFrame } }, { frame: null },
    { frame: mainFrame, webContentsId: 8 }, { frame: mainFrame, url: 'http://127.0.0.1:9999/' },
    { frame: { url: 'http://127.0.0.1:42101/', parent: mainFrame } }]) {
    assert.equal(Object.keys(invoke(detail)).some(key => key.toLowerCase() === 'x-vivary-desktop'), false);
  }
  mainFrame.url = 'about:blank';
  assert.equal(invoke({ frame: mainFrame })['x-vivary-desktop'], undefined);
  assert.equal(invoke({ frame: mainFrame, resourceType: 'mainFrame', url: 'http://127.0.0.1:42101/' })['x-vivary-desktop'], undefined);
  const initial = createDesktopCapabilityHandler(() => contents, 'http://127.0.0.1:42101', 'initial-secret');
  let first; initial({ requestHeaders: {}, url: 'http://127.0.0.1:42101/', webContentsId: 7, frame: mainFrame, method: 'GET', resourceType: 'mainFrame' }, response => { first = response; });
  assert.equal(first.requestHeaders['x-vivary-desktop'], 'initial-secret');
  initial({ requestHeaders: {}, url: 'http://127.0.0.1:42101/', webContentsId: 7, frame: mainFrame, method: 'GET', resourceType: 'mainFrame' }, response => { first = response; });
  assert.equal(first.requestHeaders['x-vivary-desktop'], undefined);
  assert.equal(invoke({ frame: null, resourceType: 'mainFrame' })['x-vivary-desktop'], undefined);
});
