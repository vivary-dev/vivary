import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'vivary-pairing-'));
Object.assign(process.env, { APP_NAME: 'VivaryPairingTest', DATABASE_URL: `file:${directory}/test.sqlite`, DATABASE_URL_UNPOOLED: `file:${directory}/test.sqlite` });
const { withMigrationRuntime, getDbExec, closeDbExec } = await import('@agent-native/core/db');
const { createBrowserAccess } = await import('../server/browser-access.mjs');
const { deviceResponse, createBrowserIngress, createBrowserListener } = await import('../server/browser-ingress.mjs');

test('pairing lifecycle survives restart and fails closed under partial writes', async t => {
  t.after(async () => { await closeDbExec(); await rm(directory, { recursive: true, force: true }); });
  const native = new Map(); let cleanupFails = false; let createFails = false; let failRevoke = false; let clock = Date.now();
  let lookupPause = null; let createPause = null; let queryPause = null;
  const sessions = {
    async addSession(token, email) { if (createPause) { const pause = createPause; createPause = null; pause.entered.resolve(); await pause.resume.promise; } native.set(token, email); if (createFails) throw new Error('Simulated uncertain Native write'); },
    async getSessionEmail(token) { if (lookupPause) { const pause = lookupPause; lookupPause = null; pause.entered.resolve(); await pause.resume.promise; } return native.get(token) ?? null; },
    async removeSession(token) { if (cleanupFails) throw new Error('Simulated cleanup failure'); native.delete(token); },
  };
  const realDatabase = getDbExec();
  const database = { async execute(query) { if (queryPause && query.sql.startsWith(queryPause.prefix)) { const pause = queryPause; queryPause = null; pause.entered.resolve(); await pause.resume.promise; } if (failRevoke && query.sql.startsWith("UPDATE vivary_browser_grants SET status='revoked'")) throw new Error('Simulated disk failure'); return realDatabase.execute(query); } };
  const open = () => withMigrationRuntime(() => createBrowserAccess({ database, sessions, now: () => clock }));
  let owner = await open();
  assert.equal(owner.configuration().enabled, false);
  assert.throws(() => owner.requestPairing('Phone'), /disabled/);
  await owner.configure({ origin: 'https://fixture.vivary.test', port: 42202, label: 'Laptop' });
  const pair = async label => { const request = owner.requestPairing(label); await owner.approve(request.id); return { request, result: await owner.completePairing(request.credential) }; };
  const first = await pair('Phone'); const second = await pair('Tablet');
  await assert.rejects(owner.completePairing(first.request.credential), /expired/);
  const pending = owner.requestPairing('Unfinished'); const identity = owner.configuration().instanceId;
  owner.close(); owner = await open();
  assert.equal(owner.configuration().instanceId, identity); assert.equal(owner.configuration().enabled, true);
  await assert.rejects(owner.completePairing(pending.credential), /expired/);
  const controller = new AbortController(); const admission = await owner.admit(first.result.credential, controller);
  assert.ok(admission);
  const held = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('event: ready\n\n')); } });
  const response = deviceResponse(new Response(held), controller, admission.release);
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.length);
  const waiting = reader.read(); cleanupFails = true;
  await owner.revoke(admission.id);
  await assert.rejects(waiting, /access ended/);
  assert.equal(await owner.admit(first.result.credential, new AbortController()), null);
  const tablet = await owner.admit(second.result.credential, new AbortController()); assert.ok(tablet); tablet.release();
  owner.close(); cleanupFails = false; owner = await open();
  assert.equal(await owner.admit(first.result.credential, new AbortController()), null);
  const surviving = await owner.admit(second.result.credential, new AbortController()); assert.ok(surviving); surviving.release();
  createFails = true; const uncertain = owner.requestPairing('Uncertain'); await owner.approve(uncertain.id);
  await assert.rejects(owner.completePairing(uncertain.credential), /could not finish/);
  await assert.rejects(owner.completePairing(uncertain.credential), /expired/); createFails = false;
  const expired = owner.requestPairing('Expired'); clock += 300001;
  await assert.rejects(owner.approve(expired.id), /expired/);
  for (let i = 0; i < 10; i++) owner.requestPairing('Limited');
  assert.throws(() => owner.requestPairing('Excess'), /Too many/);
  failRevoke = true;
  await assert.rejects(owner.revoke(surviving.id), /not saved/);
  assert.equal(owner.configuration().enabled, false);
  assert.equal(await owner.admit(second.result.credential, new AbortController()), null);
  failRevoke = false; await owner.revoke(surviving.id);
  await owner.disable(); owner.close(); owner = await open();
  assert.equal(owner.configuration().enabled, false);
  owner.close();
  const pause = () => ({ entered: Promise.withResolvers(), resume: Promise.withResolvers() });
  await t.test('close while Native identity lookup is pending refuses admission', async () => {
    owner = await open(); await owner.configure({ origin: 'https://fixture.vivary.test', port: 42202, label: 'Laptop' });
    const paired = await pair('Closing');
    const gate = pause(); lookupPause = gate;
    const admission = owner.admit(paired.result.credential, new AbortController());
    await gate.entered.promise; owner.close(); gate.resume.resolve(); assert.equal(await admission, null);
  });
  for (const phase of ['insert', 'native', 'activate']) await t.test(`close during pairing ${phase} cannot activate a partial grant`, async () => {
    owner = await open(); const request = owner.requestPairing('Interrupted'); await owner.approve(request.id);
    const gate = pause();
    if (phase === 'native') createPause = gate;
    else queryPause = { ...gate, prefix: phase === 'insert' ? 'INSERT INTO vivary_browser_grants' : "UPDATE vivary_browser_grants SET status='active'" };
    const completion = owner.completePairing(request.credential);
    await gate.entered.promise; owner.close(); gate.resume.resolve(); await assert.rejects(completion, /could not finish/);
    const rows = await realDatabase.execute({ sql: "SELECT status FROM vivary_browser_grants WHERE label='Interrupted'", args: [] });
    assert.equal(rows.rows.some(row => row.status === 'active'), false);
  });
  await t.test('old response cleanup cannot erase a newly admitted stream', async () => {
    owner = await open(); const paired = await pair('Re-enabled');
    const old = await owner.admit(paired.result.credential, new AbortController());
    await owner.disable(); await owner.configure({ origin: 'https://fixture.vivary.test', port: 42202, label: 'Laptop' });
    const currentController = new AbortController(); const current = await owner.admit(paired.result.credential, currentController);
    old.release(); await owner.revoke(current.id); assert.equal(currentController.signal.aborted, true); current.release(); owner.close();
  });
  await t.test('grant expiry closes an existing stream', async () => {
    owner = await open(); const paired = await pair('Expiring');
    await realDatabase.execute({ sql: "UPDATE vivary_browser_grants SET expires_at=? WHERE label='Expiring'", args: [clock + 20] });
    const controller = new AbortController(); const admission = await owner.admit(paired.result.credential, controller);
    clock += 21; await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(controller.signal.aborted, true); admission.release(); owner.close();
  });
});

test('remote admission blocks alternate routes and cleans every response or failure', async () => {
  let dispatches = 0; let released = 0; let admitFailure = false; let dispatchFailure = false;
  const access = { configuration: () => ({ enabled: true, origin: 'https://fixture.vivary.test' }),
    async admit() { if (admitFailure) throw new Error('Lookup failed'); return { id: 'fixture', release() { released++; } }; } };
  const ingress = createBrowserIngress({ access, capability: 'fixture', localOrigin: 'http://127.0.0.1:1',
    dispatch: async () => { dispatches++; if (dispatchFailure) throw new Error('Dispatch failed'); return new Response(null, { status: 204, headers: { 'set-cookie': 'an_session=fixture' } }); } });
  const request = path => new Request('https://fixture.vivary.test' + path, { headers: { host: 'fixture.vivary.test' } });
  for (const route of ['/mcp/connect/token', '/mcp/device/authorize', '/%6dcp/connect/token', '/_agent-native/%61uth/login',
    '/_agent-native/actions/vivary-connect-project-%66older', '/_agent-native/auth/session?__an_embed_token=fixture', '/_agent-native/%ZZ']) {
    assert.equal((await ingress.remote(request(route))).status, 401, route);
  }
  assert.equal(dispatches, 0);
  const allowed = await ingress.remote(request('/_agent-native/auth/session'));
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('set-cookie'), null); assert.equal(allowed.headers.get('cache-control'), 'no-store'); assert.equal(released, 1);
  dispatchFailure = true; assert.equal((await ingress.remote(request('/'))).status, 409); assert.equal(released, 2);
  admitFailure = true;
  const broken = request('/'); let listeners = 0;
  const add = broken.signal.addEventListener.bind(broken.signal), remove = broken.signal.removeEventListener.bind(broken.signal);
  broken.signal.addEventListener = (...args) => { listeners++; return add(...args); };
  broken.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
  assert.equal((await ingress.remote(broken)).status, 409); assert.equal(listeners, 0);
});

test('listener shutdown owns a server whose listen callback is still pending', async () => {
  const { EventEmitter } = await import('node:events');
  const starting = Promise.withResolvers(); let completeListen; let closed = false;
  const server = new EventEmitter(); server.closeAllConnections = () => undefined;
  server.close = callback => { closed = true; callback(); };
  server.listen = (_port, host, callback) => { assert.equal(host, '127.0.0.1'); completeListen = callback; starting.resolve(); };
  const listener = createBrowserListener({ access: { configuration: () => ({ enabled: true, port: 42300 }) }, fetch: () => new Response(''), createHttpServer: () => server });
  const opening = listener.reconcile(); await starting.promise; const closing = listener.close();
  completeListen(); await opening; await closing; assert.equal(closed, true);
});


test('external top-level entry serves only public bootstrap before any device access', async () => {
  let enabled = true;
  const calls = [];
  const access = {
    configuration: () => ({ enabled, origin: 'https://fixture.vivary.test', label: 'Private host identity' }),
    async admit() { calls.push('admit'); return { id: 'valid-device', release() {} }; },
    requestPairing() { calls.push('pair'); throw new Error('Unexpected pairing'); },
  };
  const ingress = createBrowserIngress({ access, capability: 'fixture', localOrigin: 'http://127.0.0.1:1',
    dispatch: async () => { calls.push('dispatch'); return new Response('Native'); } });
  const headers = { host: 'fixture.vivary.test', cookie: '__Host-vivary-device=' + 'a'.repeat(43), 'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml' };
  const request = (route, extra = {}, method = 'GET') => new Request('https://fixture.vivary.test' + route,
    { method, headers: { ...headers, ...extra } });
  let bootstrap;
  for (const site of ['cross-site', 'same-site']) for (const route of ['/', '/pair', '/?project=fixture&unknown=value', '/pair?path=ignored']) for (const cookie of ['', '__Host-vivary-device=' + 'a'.repeat(43)]) {
    const response = await ingress.remote(request(route, { cookie, 'sec-fetch-site': site }));
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    assert.equal(body.includes('Private host identity'), false);
    bootstrap ??= body; assert.equal(body, bootstrap);
  }
  const refused = [
    ['/_vivary/browser/status'], ['/_vivary/browser/pair', {}, 'POST'],
    ['/_vivary/browser/complete', {}, 'POST'], ['/_agent-native/auth/session'], ['/settings'],
    ['/', {}, 'POST'], ['/', {}, 'HEAD'], ['/', { 'sec-fetch-mode': 'cors' }],
    ['/', { 'sec-fetch-mode': '' }], ['/', { 'sec-fetch-dest': 'iframe' }],
    ['/', { 'sec-fetch-dest': 'empty' }], ['/', { accept: 'application/json' }],
    ['/', { host: 'localhost' }], ['/', { authorization: 'Bearer alternate' }],
    ['/', { 'x-vivary-session': 'alternate' }], ['/', { 'x-vivary-desktop': 'alternate' }],
    ['/?_session=alternate'], ['/?__an_embed_token=alternate'], ['/%70air'],
    ['/?%5Fsession=alternate'], ['/pair?%5F%5Fan_embed_token=alternate'],
    ['/?project=ok&_session=&_session=alternate'], ['/pair?__an_embed_token=&__an_embed_token=alternate'],
    ['/?%5Fsession=&_session=alternate'], ['/pair?%5F%5Fan_embed_token=&__an_embed_token=alternate'],
    ['/%6dcp/connect/token'], ['/_agent-native/%61uth/login'], ['/%ZZ'],
  ];
  for (const site of ['cross-site', 'same-site']) for (const [route, extra, method] of refused) assert.equal((await ingress.remote(request(route, { ...extra, 'sec-fetch-site': site }, method))).status, 401, route);
  enabled = false;
  for (const route of ['/', '/pair']) assert.equal((await ingress.remote(request(route))).status, 401);
  assert.deepEqual(calls, []);
});


test('bootstrap preserves only inert root navigation values when resuming or completing pairing', async () => {
  const { runInNewContext } = await import('node:vm');
  const { browserPairingPage } = await import('../server/browser-pairing-page.mjs');
  const html = await browserPairingPage().text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const navigation = { project: 'fixture', run: 'run', draft: 'draft', runtime: 'native', history: 'project',
    thread: 'thread', panel: 'files', path: '</script><script>globalThis.attacked=true</script>&redirect=https://outside.test/', line: '3' };
  const search = new URLSearchParams({ ...navigation, _agentNativeDesktopCode: 'internal', prompt: 'do not submit',
    redirect: 'https://outside.test/', next: '//outside.test/' });
  search.append('path', 'javascript:globalThis.attacked=true');
  for (const pathname of ['/', '/pair']) for (const paired of [true, false]) {
    const elements = new Map(); const destinations = []; const calls = [];
    const context = { URLSearchParams, AbortSignal, location: { pathname, search: '?' + search, replace: value => destinations.push(value) },
      document: { getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
      fetch: async (url, options) => { calls.push([url, options.method ?? 'GET']);
        return url.endsWith('/status') ? { ok: paired, status: paired ? 200 : 401 } : { ok: true, json: async () => ({}) }; } };
    runInNewContext(script, context);
    await new Promise(resolve => setImmediate(resolve));
    if (!paired) { assert.deepEqual(destinations, []); await elements.get('complete').onclick(); }
    assert.equal(destinations.length, 1);
    assert.ok(destinations[0].startsWith('/'));
    const destination = new URL(destinations[0], 'https://fixture.vivary.test');
    assert.equal(destination.origin, 'https://fixture.vivary.test'); assert.equal(destination.pathname, '/');
    const expected = pathname === '/' ? [...new URLSearchParams(navigation), ['path', 'javascript:globalThis.attacked=true']] : [];
    assert.deepEqual([...destination.searchParams], expected);
    assert.equal(context.attacked, undefined);
    assert.deepEqual(calls, paired ? [['/_vivary/browser/status', 'GET']] : [['/_vivary/browser/status', 'GET'], ['/_vivary/browser/complete', 'POST']]);
  }
});

test('connection gate distinguishes access denial and network failure without remounting drafts', async () => {
  const { createRequire } = await import('node:module');
  const { build, stop } = await import('esbuild');
  const { realpathSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const workbench = fileURLToPath(new URL('..', import.meta.url));
  const { parseHTML } = createRequire(realpathSync(path.join(workbench, 'node_modules/@agent-native/core/package.json')))('linkedom');
  const { window } = parseHTML('<html><body></body></html>');
  window.location = new URL('https://fixture.test/');
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'vivary-connection-component-'));
  const saved = new Map();
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  let poll;
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, MessageChannel: TrackedMessageChannel, IS_REACT_ACT_ENVIRONMENT: true,
    sessionStorage: { getItem: () => null, setItem() {} },
    setInterval: fn => { poll = fn; return 1; }, clearInterval() {} })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const oldFetch = globalThis.fetch;
  try {
    const result = await build({ stdin: { contents: `
      import { act, useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserConnection } from './app/components/layout/BrowserConnection';
      export async function run(assert, tick) {
        const host={enabled:true,remote:true,instanceId:'11111111-1111-4111-8111-111111111111',label:'Fixture',origin:'https://fixture.test',port:42300};
        let reply=()=>new Response(null,{status:401}), calls=0, mounts=0;
        globalThis.fetch=async()=>{calls++;return reply();};
        let setDenied;
        function Gate(){const [denied,update]=useState(false);setDenied=update;return <><p>{denied?'Temporary server failure':''}</p><Draft/></>;}
        function Draft(){useEffect(()=>{mounts++;},[]);return <textarea defaultValue="unsent draft"/>;}
        let root;
        async function mount(){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));await act(async()=>root.render(<BrowserConnection><Gate/></BrowserConnection>));}
        async function click(label){const button=[...document.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(button,label);await act(async()=>button.click());}
        const text=()=>document.body.textContent;
        await mount();
        assert.match(text(),/Browser access ended/);assert.equal(mounts,0);
        assert.equal(document.querySelector('a').getAttribute('href'),'/pair');
        await act(async()=>tick());assert.equal(calls,1);
        reply=()=>Response.json(host);await click('Check access again');
        const draft=document.querySelector('textarea');draft.value='dirty draft';assert.equal(mounts,1);
        reply=()=>{throw new Error('offline');};await act(async()=>tick());
        assert.match(text(),/Cannot reach Fixture/);assert.equal(document.querySelector('a'),null);
        reply=()=>Response.json(host);await click('Retry connection');
        assert.equal(document.querySelector('textarea'),draft);assert.equal(draft.value,'dirty draft');
        reply=()=>new Response(null,{status:401});await act(async()=>{const response=await fetch('/session');setDenied(response.status===401);tick();});
        assert.match(text(),/Browser access ended/);assert.doesNotMatch(text(),/revoked/i);
        assert.equal(document.querySelector('textarea'),draft);assert.equal(draft.value,'dirty draft');assert.equal(mounts,1);
        const notice=[...document.querySelectorAll('p')].find(node=>node.textContent==='Temporary server failure');
        assert.ok(notice);assert.ok(notice.closest('[hidden]'));
        assert.equal(document.querySelector('a').closest('[hidden]'),null);
        reply=()=>Response.json(host);await act(async()=>setDenied(false));await click('Check access again');
        assert.equal(draft.closest('[hidden]'),null);assert.equal(document.querySelector('textarea'),draft);assert.equal(draft.value,'dirty draft');assert.equal(mounts,1);
        await act(async()=>root.unmount());
        reply=()=>{throw new Error('offline');};await mount();
        assert.match(text(),/Cannot reach/);assert.equal(document.querySelector('textarea'),null);assert.equal(document.querySelector('a'),null);
        await act(async()=>root.unmount());
        reply=()=>Response.json({...host,remote:false,origin:null});await mount();
        assert.ok(document.querySelector('textarea'));assert.doesNotMatch(text(),/access ended|Cannot reach/);
        await act(async()=>root.unmount());
      }`, resolveDir: workbench, loader: 'tsx' }, bundle: true, write: false,
      platform: 'node', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
    const bundlePath = path.join(bundleDirectory, 'proof.mjs');
    await writeFile(bundlePath, result.outputFiles[0].text);
    const proof = await import(bundlePath);
    await proof.run(assert, () => poll());
  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    await rm(bundleDirectory, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    stop();
  }
});

test('preview gateway binds a document to one launch and strips credentials before a verified connection', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { randomUUID } = await import('node:crypto');
  const { capturePreviewProcess, connectOwnedPreview } = await import('../server/preview-socket-owner.ts');
  const { createPreviewGateway } = await import('../server/preview-ingress.mjs');
  const child = spawn(process.execPath, ['-e', `const http=require('node:http');const s=http.createServer((q,r)=>{if(q.url.startsWith('/account/start')){r.writeHead(302,{Location:q.url.includes('?')?'?next=1':'next'});r.end();return;}if(q.url==='/root-redirect'){r.writeHead(302,{Location:'/next'});r.end();return;}if(q.url==='/external'){r.writeHead(302,{Location:'https://outside.test/'});r.end();return;}if(q.url==='/upgrade'){r.writeHead(101,{Upgrade:'websocket',Connection:'Upgrade'});r.flushHeaders();return;}if(q.url==='/close'){q.socket.destroy();return;}r.setHeader('Set-Cookie','upstream=secret');r.setHeader('WWW-Authenticate','secret');r.end(JSON.stringify(q.headers));});s.listen(0,'127.0.0.1',()=>process.send(s.address().port));process.on('message',()=>s.close(()=>process.exit(0)));`], { detached: process.platform !== 'win32', stdio: ['ignore','ignore','ignore','ipc'] });
  const [port] = await once(child, 'message');
  t.after(async () => { if (child.exitCode === null) { child.send('close'); await once(child, 'exit'); } });
  const identity = await capturePreviewProcess(child); assert.ok(identity);
  const controllers = []; let released = 0;
  const origin = 'https://paired.vivary.test:9443', app = 'https://paired.vivary.test';
  const targetController = new AbortController();
  const gateway = createPreviewGateway({ access: {
    configuration: () => ({ enabled: true, origin: app, preview: { origin, port: 42203 } }),
    async admitPreviewGrant(_id, controller) { controllers.push(controller); return { release() { released++; } }; },
  }, resolveTarget: async () => ({ generation: 'generation', initialPath: '/', upstreamOrigin: `http://127.0.0.1:${port}`,
    signal: targetController.signal, check: async () => {}, connect: signal => connectOwnedPreview({ port, identity, signal }) }) });
  t.after(() => gateway.close());
  const request = (pathname, options = {}) => gateway.handle(new Request(origin + pathname, { ...options, headers: {
    host: new URL(origin).host, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty', ...options.headers,
  } }));
  const input = { operation: 'open', documentId: randomUUID(), projectId: 'alpha', launchId: randomUUID() };
  const opened = await gateway.command(input, {}, 'device');
  assert.equal((await request('/', { headers: { 'sec-fetch-dest': 'document', cookie: '__Host-vivary-device=ordinary-app-cookie' } })).status, 403);
  assert.equal((await request('/_vivary/preview/bootstrap', { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' } })).status, 200);
  const redeem = () => request('/_vivary/preview/redeem', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: opened.ticket }) });
  const response = await redeem(); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await redeem()).status, 403);
  const served = await request('/', { headers: { cookie: cookie + '; __Host-vivary-device=app-secret', authorization: 'Bearer app-secret', 'x-vivary-desktop': 'desktop-secret', 'x-forwarded-host': 'private', 'sec-fetch-dest': 'iframe' } });
  assert.equal(served.status, 200);
  const upstream = await served.json();
  for (const field of ['cookie','authorization','x-vivary-desktop','x-forwarded-host']) assert.equal(upstream[field], undefined);
  assert.equal(served.headers.get('set-cookie'), null); assert.equal(served.headers.get('www-authenticate'), null);
  assert.match(served.headers.get('content-security-policy'), /worker-src 'none'/);
  for (const [route, location] of [['/account/start', '/account/next'], ['/account/start?old=1', '/account/start?next=1'], ['/root-redirect', '/next']]) {
    const redirected = await request(route, { headers: { cookie } });
    assert.equal(redirected.headers.get('location'), origin + location);
  }
  for (const route of ['/upgrade','/close','/external']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const result = await request(route, { headers: { cookie }, signal: controller.signal });
    clearTimeout(timer); assert.equal(result.status, 502); assert.equal(controller.signal.aborted, false);
  }
  const failedBody = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); setTimeout(() => controller.error(new Error('Interrupted upload')), 50); } });
  const interrupted = await request('/upload', { method: 'POST', headers: { cookie, origin }, body: failedBody, duplex: 'half' });
  assert.ok([200,502].includes(interrupted.status)); await interrupted.text().catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await request('/', { headers: { cookie } })).status, 200);
  for (const destination of ['document','worker','serviceworker','sharedworker']) assert.equal((await request('/', { headers: { cookie, 'sec-fetch-dest': destination } })).status, 403);
  await assert.rejects(gateway.command({ ...input, projectId: 'beta', launchId: randomUUID() }, {}, 'device'), /refresh/);
  controllers[0].abort();
  assert.equal(released, 1);
  const { getEventListeners } = await import('node:events');
  assert.equal(getEventListeners(targetController.signal, 'abort').length, 0);
  assert.equal((await request('/', { headers: { cookie } })).status, 403);
  await gateway.command({ operation: 'close', documentId: input.documentId }, {}, 'device');
  assert.equal(released, 1);
  await assert.rejects(gateway.command({ ...input, launchId: randomUUID() }, {}, 'device'), /refresh/);
});

test('preview disable during pending admission releases the granted admission', async () => {
  const { createPreviewGateway } = await import('../server/preview-ingress.mjs');
  let finish, entered, released = 0;
  const pending = new Promise(resolve => { entered = resolve; });
  const settings = { enabled: true, origin: 'https://fixture.test', preview: { origin: 'https://fixture.test:9443' } };
  const gateway = createPreviewGateway({ access: {
    configuration: () => settings,
    admitPreviewGrant: () => { entered(); return new Promise(resolve => { finish = resolve; }); },
  }, resolveTarget: async () => ({ generation: 'one', signal: new AbortController().signal, check: async () => {} }) });
  try {
    const opening = gateway.command({ operation: 'open', documentId: 'document', projectId: 'alpha', launchId: 'launch' }, {}, 'device');
    await pending;
    settings.preview = null;
    finish({ release() { released++; } });
    await assert.rejects(opening);
    assert.equal(released, 1);
  } finally { gateway.close(); }
});

const unboundPreview = /Isolated preview is unavailable because its listener on this host could not start or has stopped\./;
function countingPreviewGateway(createPreviewGateway, listening) {
  const counts = { targets: 0, grants: 0 };
  const gateway = createPreviewGateway({ access: {
    configuration: () => ({ enabled: true, origin: 'https://fixture.test', preview: { origin: 'https://fixture.test:9443', port: 42301 } }),
    async admitPreviewGrant() { counts.grants++; return { release() {} }; },
  }, resolveTarget: async () => { counts.targets++; return { generation: 'one', initialPath: '/', signal: new AbortController().signal, check: async () => {} }; },
  listening });
  return { gateway, counts };
}

test('remote preview open refuses with a readable message before any ticket when its listener is not listening', async () => {
  const { randomUUID } = await import('node:crypto');
  const { isActionContractError } = await import('@agent-native/core/action');
  const { createPreviewGateway, installPreviewGateway } = await import('../server/preview-ingress.mjs');
  const { runWithBrowserIdentity } = await import('../server/browser-request-context.mjs');
  const { default: action } = await import('../actions/vivary-remote-preview.ts');
  let bound = false;
  const { gateway, counts } = countingPreviewGateway(createPreviewGateway, () => bound);
  installPreviewGateway(gateway);
  const open = () => runWithBrowserIdentity({ kind: 'remote', deviceId: 'device' },
    () => action.run({ operation: 'open', documentId: randomUUID(), projectId: 'alpha', launchId: randomUUID() }, {}));
  try {
    // The action route echoes only contract errors with a client status, so the phone sees this text.
    await assert.rejects(open(), error => isActionContractError(error) && error.statusCode < 500 && unboundPreview.test(error.message));
    assert.deepEqual(counts, { targets: 0, grants: 0 });
    bound = true;
    const opened = await open();
    assert.match(opened.ticket, /^[\w-]{43}$/); assert.deepEqual(counts, { targets: 1, grants: 1 });
    bound = false;
    await assert.rejects(open(), unboundPreview);
    assert.deepEqual(counts, { targets: 1, grants: 1 });
  } finally { gateway.close(); installPreviewGateway(undefined); }
});

test('preview open follows the real listener: bind failure refuses, a bound listener opens, a closed listener refuses', async () => {
  const { createServer } = await import('node:net');
  const { once } = await import('node:events');
  const { randomUUID } = await import('node:crypto');
  const { createPreviewGateway } = await import('../server/preview-ingress.mjs');
  const blocker = createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const { port } = blocker.address();
  const listener = createBrowserListener({ access: { configuration: () => ({ enabled: true, port }) }, fetch: () => new Response('') });
  const { gateway, counts } = countingPreviewGateway(createPreviewGateway, () => listener.listening());
  const open = () => gateway.command({ operation: 'open', documentId: randomUUID(), projectId: 'alpha', launchId: randomUUID() }, {}, 'device');
  try {
    await listener.reconcile();
    assert.equal(listener.listening(), false); assert.ok(listener.error());
    await assert.rejects(open(), unboundPreview);
    assert.deepEqual(counts, { targets: 0, grants: 0 });
    blocker.close(); await once(blocker, 'close');
    await listener.reconcile();
    assert.equal(listener.listening(), true); assert.equal(listener.error(), null);
    assert.match((await open()).ticket, /^[\w-]{43}$/);
    await listener.close();
    assert.equal(listener.listening(), false);
    await assert.rejects(open(), unboundPreview);
    assert.deepEqual(counts, { targets: 1, grants: 1 });
  } finally { gateway.close(); await listener.close(); if (blocker.listening) blocker.close(); }
});

test('listener stops reporting itself listening after its server errors or closes', async () => {
  const { EventEmitter } = await import('node:events');
  const servers = [];
  const createHttpServer = () => {
    const server = new EventEmitter(); server.listening = false; server.closeAllConnections = () => undefined;
    server.close = callback => { server.listening = false; callback?.(); };
    server.listen = (_port, _host, callback) => { server.listening = true; callback(); };
    servers.push(server); return server;
  };
  const listener = createBrowserListener({ access: { configuration: () => ({ enabled: true, port: 42301 }) }, fetch: () => new Response(''), createHttpServer });
  try {
    await listener.reconcile(); assert.equal(listener.listening(), true);
    servers[0].emit('error', new Error('socket failure'));
    assert.equal(listener.listening(), false); assert.ok(listener.error());
    await listener.reconcile(); assert.equal(servers.length, 2); assert.equal(listener.listening(), true); assert.equal(listener.error(), null);
    servers[1].listening = false; servers[1].emit('close');
    assert.equal(listener.listening(), false); assert.ok(listener.error());
  } finally { await listener.close(); }
});

test('remote preview shows an open refusal as text and renders no frame', async () => {
  const { createRequire } = await import('node:module');
  const { build, stop } = await import('esbuild');
  const { realpathSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const workbench = fileURLToPath(new URL('..', import.meta.url));
  const { parseHTML } = createRequire(realpathSync(path.join(workbench, 'node_modules/@agent-native/core/package.json')))('linkedom');
  const { window } = parseHTML('<html><body></body></html>');
  Object.defineProperty(Object.getPrototypeOf(window.document.createElement('iframe')), 'credentialless', { configurable: true, value: false });
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'vivary-remote-preview-component-'));
  const saved = new Map();
  // React's scheduler opens MessageChannels here. Closing them lets the test process exit.
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, MessageChannel: TrackedMessageChannel, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // Stub only the transport and refresh helpers. The component's own open flow runs unchanged.
  const stubs = { name: 'remote-preview-stubs', setup(stage) {
    stage.onResolve({ filter: /^@\/lib\/(native-actions|workbench-preview)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    stage.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ loader: 'js', contents: args.path.endsWith('native-actions')
      ? 'export function useNativeActionCaller(){return {ready:true,call:(...args)=>globalThis.previewCall(...args)};}'
      : 'export async function refreshPreviewDocument(){return true;}' }));
  } };
  try {
    const result = await build({ stdin: { contents: `
      import { act } from 'react';
      import { createRoot } from 'react-dom/client';
      import { RemoteProjectPreview } from './app/components/workbench/RemoteProjectPreview';
      export async function run(assert, refusal) {
        const launch={code:'ready',launchId:'22222222-2222-4222-8222-222222222222',staleBinding:false};
        let reply=()=>Promise.reject(new Error(refusal));
        globalThis.previewCall=(_name,input)=>input.operation==='close'?Promise.resolve({closed:true}):reply();
        document.body.innerHTML='<div id="root"></div>';
        const root=createRoot(document.getElementById('root'));
        await act(async()=>root.render(<RemoteProjectPreview projectId="alpha" launch={launch} onOpen={()=>undefined}/>));
        const click=async()=>{const button=document.querySelector('button[aria-label="Open isolated preview"],button[aria-label="Refresh preview"]');assert.ok(button);await act(async()=>button.click());};
        await click();
        assert.equal(document.querySelector('[role="alert"]')?.textContent,refusal);
        assert.equal(document.querySelector('iframe'),null);
        reply=()=>Promise.resolve({ticket:'t'.repeat(43),origin:'https://fixture.test:9443',generation:'one'});
        await click();
        assert.equal(document.querySelector('[role="alert"]'),null);
        assert.equal(document.querySelector('iframe')?.getAttribute('src'),'https://fixture.test:9443/_vivary/preview/bootstrap');
        await act(async()=>root.unmount());
      }`, resolveDir: workbench, loader: 'tsx' }, bundle: true, write: false, plugins: [stubs],
      platform: 'node', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
    const bundlePath = path.join(bundleDirectory, 'proof.mjs');
    await writeFile(bundlePath, result.outputFiles[0].text);
    const proof = await import(bundlePath);
    await proof.run(assert, 'Isolated preview is unavailable because its listener on this host could not start or has stopped. On the desktop, repair the preview port in Browser access settings.');
  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    await rm(bundleDirectory, { recursive: true, force: true });
    delete globalThis.previewCall;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    stop();
  }
});
