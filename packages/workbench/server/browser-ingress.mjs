import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from 'h3/node';
import { z } from 'zod';
import { createBrowserAccess, browserConfiguration } from './browser-access.mjs';
import { createPreviewGateway, installPreviewGateway } from './preview-ingress.mjs';
import { browserPairingPage } from './browser-pairing-page.mjs';
import { admitBrowserContext, runWithBrowserIdentity } from './browser-request-context.mjs';

const DEVICE_COOKIE = '__Host-vivary-device';
const PAIR_COOKIE = '__Host-vivary-pair';
const ROOT = '/_vivary/browser';
const json = (body, status = 200, headers = {}) => Response.json(body, { status,
  headers: { 'cache-control': 'no-store', ...headers } });
const denied = () => json({ error: 'Remote access is unavailable. Pair or reconnect from the selected host.' }, 401);
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
function readCookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return '';
  const value = matches[0].slice(name.length + 1);
  return /^[\w-]{43}$/.test(value) ? value : '';
}
function sameSecret(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Use JSON for remote access changes.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request.');
  let bytes = 0; const chunks = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 4096) throw new Error('Request too large.'); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('configure'), configuration: browserConfiguration }).strict(),
  z.object({ operation: z.literal('approve'), id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('revoke'), id: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('disable') }).strict(),
]);

export function confirmDesktopAccess(detail) {
  if (!process.connected || !process.send) return Promise.reject(new Error('Open the desktop app to change remote access.'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, approved = false) => {
      clearTimeout(timer); process.off('message', receive); process.off('disconnect', disconnected);
      if (error) reject(error); else resolve(approved);
    };
    const disconnected = () => finish(new Error('Desktop connection closed.'));
    const receive = message => {
      if (message?.type === 'vivary:browser-access:confirmed' && message.requestId === requestId
        && typeof message.approved === 'boolean') finish(null, message.approved);
    };
    const timer = setTimeout(() => finish(new Error('Desktop confirmation expired.')), 120_000); timer.unref();
    process.on('message', receive); process.once('disconnect', disconnected);
    process.send({ type: 'vivary:browser-access:confirm', requestId, detail }, error => { if (error) finish(new Error('Desktop connection closed.')); });
  });
}

// Cancellation belongs to this HTTP response, not to a host-wide Native run.
export function deviceResponse(response, controller, release) {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.set('cache-control', 'no-store');
  if (!response.body) { release(); return new Response(null, { status: response.status, statusText: response.statusText, headers }); }
  const reader = response.body.getReader();
  let finished = false;
  let streamController;
  const finish = () => { if (finished) return; finished = true; controller.signal.removeEventListener('abort', abort); release(); };
  const abort = () => {
    if (finished) return;
    finish(); void reader.cancel().catch(() => undefined);
    streamController.error(new Error('Remote access ended.'));
  };
  const body = new ReadableStream({
    start(value) { streamController = value; controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort(); },
    async pull(value) {
      if (finished) return;
      try { const chunk = await reader.read(); if (finished) return;
        if (chunk.done) { finish(); value.close(); } else value.enqueue(chunk.value);
      } catch (error) { if (!finished) { finish(); value.error(error); } }
    },
    async cancel() { finish(); await reader.cancel().catch(() => undefined); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function createBrowserIngress({ dispatch, access, capability, localOrigin, confirm = confirmDesktopAccess, onConfiguration = async () => undefined, listenerError = () => null }) {
  let controls = Promise.resolve();
  const remote = async request => {
    const config = access.configuration();
    const url = new URL(request.url);
    let routePath;
    try { routePath = decodeURIComponent(url.pathname); } catch { return denied(); }
    if (!config.enabled || request.headers.get('host') !== new URL(config.origin).host) return denied();
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    // Block alternate Native authentication before its embed/access-token/BYOA fallback chain.
    if (request.headers.has('authorization') || request.headers.has('x-vivary-session') || request.headers.has('x-vivary-desktop')
      || (url.searchParams.has('_session') || url.searchParams.has('__an_embed_token')) || request.headers.has('upgrade')) return denied();
    if (routePath.startsWith('/_agent-native/auth') && routePath !== '/_agent-native/auth/session') return denied();
    if (/^\/_agent-native\/(embed|desktop|connect|oauth|mcp)(\/|$)/.test(routePath) || /^\/mcp(?:\/|$)/.test(routePath)
      || routePath === '/_agent-native/actions/vivary-connect-project-folder') return denied();
    // External entry is public HTML only. Strict cookies are checked after same-origin navigation.
    if (['cross-site', 'same-site'].includes(site) && request.method === 'GET'
      && ['/', '/pair'].includes(url.pathname) && request.headers.get('sec-fetch-mode') === 'navigate'
      && request.headers.get('sec-fetch-dest') === 'document'
      && request.headers.get('accept')?.split(',').some(value => value.trim().split(';')[0] === 'text/html')) return browserPairingPage();
    if ((origin && origin !== config.origin) || (site && !['none', 'same-origin'].includes(site))) return denied();
    if (!['GET', 'HEAD'].includes(request.method) && origin !== config.origin) return denied();
    try {
      if (url.pathname === '/pair' && request.method === 'GET') return browserPairingPage();
      if (url.pathname === `${ROOT}/pair` && request.method === 'POST') {
        const input = z.object({ label: z.string().trim().min(1).max(80) }).strict().parse(await readJson(request));
        const { credential, ...result } = access.requestPairing(input.label);
        return json(result, 200, { 'set-cookie': cookie(PAIR_COOKIE, credential, 300) });
      }
      if (url.pathname === `${ROOT}/complete` && request.method === 'POST') {
        await readJson(request);
        const { credential, ...result } = await access.completePairing(readCookie(request, PAIR_COOKIE));
        return json(result, 200, credential ? { 'set-cookie': cookie(DEVICE_COOKIE, credential, Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))) } : {});
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      let grant;
      let transferred = false;
      const release = () => { request.signal.removeEventListener('abort', abort); grant?.release(); };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) controller.abort();
      try {
        grant = await access.admit(readCookie(request, DEVICE_COOKIE), controller);
        if (!grant) return url.pathname === '/' && request.method === 'GET' && request.headers.get('accept')?.includes('text/html') ? browserPairingPage() : denied();
        if (url.pathname === `${ROOT}/status` && request.method === 'GET') return json({ ...config, remote: true });
        if (routePath.startsWith(ROOT)) return denied();
        const headers = new Headers(request.headers);
        headers.delete('cookie');
        for (const name of [...headers.keys()]) {
          if (/^(x-forwarded-|x-original-|x-real-|forwarded$)/i.test(name)) headers.delete(name);
        }
        headers.set('host', new URL(config.origin).host);
        const forwarded = new Request(new URL(url.pathname + url.search, config.origin), { method: request.method,
          headers, body: request.body, duplex: 'half', signal: controller.signal });
        forwarded.context = {};
        admitBrowserContext(forwarded.context, { kind: 'remote', deviceId: grant.id });
        const response = await runWithBrowserIdentity({ kind: 'remote', deviceId: grant.id }, () => dispatch(forwarded));
        if (controller.signal.aborted) { await response.body?.cancel(); return denied(); }
        const result = deviceResponse(response, controller, release);
        transferred = true;
        return result;
      } finally { if (!transferred) release(); }
    } catch { return json({ error: 'Remote access request failed. Check the desktop or start pairing again.' }, 409); }
  };
  const local = async request => {
    if (!sameSecret(request.headers.get('x-vivary-desktop'), capability)) return denied();
    const url = new URL(request.url);
    if (request.headers.get('host') !== new URL(localOrigin).host
      || (request.headers.has('origin') && request.headers.get('origin') !== localOrigin)
      || !['none', 'same-origin', null].includes(request.headers.get('sec-fetch-site'))) return denied();
    request.headers.delete('x-vivary-desktop');
    request.context ??= {};
    admitBrowserContext(request.context, { kind: 'desktop' });
    if (url.pathname === `${ROOT}/status` && request.method === 'GET') return json({ ...await access.status(), remote: false, listenerError: listenerError() });
    if (url.pathname === `${ROOT}/control` && request.method === 'POST') {
      const run = async () => {
        try {
          const command = commandSchema.parse(await readJson(request));
          const status = await access.status();
          const target = command.operation === 'approve' ? status.pending.find(item => item.id === command.id)
            : command.operation === 'revoke' ? status.devices.find(item => item.id === command.id) : null;
          if (['approve', 'revoke'].includes(command.operation) && !target) throw new Error('Request no longer exists.');
          const detail = command.operation === 'configure'
            ? `Enable access to ${command.configuration.label} at ${command.configuration.origin} through loopback port ${command.configuration.port}. ${command.configuration.preview ? `Preview: ${command.configuration.preview.origin} through loopback port ${command.configuration.preview.port}. ` : 'Remote previews off. '}Configure protected HTTPS separately. Vivary does not create it.`
            : command.operation === 'approve' ? `Pair ${target.label} with ${status.label}? Compare code ${target.code} on both screens. This browser will have access to this host's projects and tools.`
              : command.operation === 'revoke' ? `Revoke ${target.label}? Its streams and future requests will end. Host runs will continue.`
                : 'Disable remote access? All remote browser streams will end. Approved devices remain saved.';
          if (!await confirm(detail)) return json({ error: 'Desktop confirmation canceled.' }, 409);
          if (command.operation === 'configure') await access.configure(command.configuration);
          else if (command.operation === 'approve') await access.approve(command.id);
          else if (command.operation === 'revoke') await access.revoke(command.id);
          else await access.disable();
          await onConfiguration();
          return json({ ok: true });
        } catch (error) { return json({ error: error instanceof z.ZodError ? 'Invalid remote access request.' : error.message }, 409); }
      };
      const result = controls.then(run); controls = result.catch(() => undefined); return result;
    }
    if (url.pathname.startsWith(ROOT)) return denied();
    return dispatch(request);
  };
  return { local, remote };
}

export function createBrowserListener({ access, fetch, createHttpServer = createServer }) {
  let listener;
  let listenerPort;
  let stopped = false;
  let pending = Promise.resolve();
  let error = null;
  const closeServer = async server => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  const stopListener = async () => {
    const server = listener; listener = null; listenerPort = undefined;
    if (server) await closeServer(server);
  };
  return {
    error: () => error,
    // The bound server's own state, not the saved configuration.
    listening: () => listener?.listening === true && listenerPort !== undefined,
    reconcile() {
      const operation = async () => {
        const config = access.configuration();
        if (stopped || !config.enabled) { await stopListener(); return; }
        if (listener && listenerPort === config.port) return;
        await stopListener();
        if (stopped) return;
        const server = createHttpServer(toNodeHandler({ fetch }));
        listener = server;
        server.on('upgrade', (_request, socket) => socket.destroy());
        server.requestTimeout = 15_000; server.headersTimeout = 10_000;
        try {
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
          if (stopped) { await stopListener(); return; }
          listenerPort = config.port; error = null;
          // A bound server can still fail or close later. Forget it so `listening()` and the next reconcile see that.
          const lost = () => {
            if (listener !== server) return;
            listener = null; listenerPort = undefined;
            error = 'The browser ingress listener stopped. Save these settings again to restart it.';
            if (server.listening) void closeServer(server);
          };
          server.on('error', lost); server.once('close', lost);
        } catch {
          await stopListener();
          error = 'The saved browser ingress port is unavailable. Repair it here; desktop access remains available.';
        }
      };
      const result = pending.then(operation); pending = result.catch(() => undefined); return result;
    },
    async close() { stopped = true; await pending; await stopListener(); },
  };
}

export function installDesktopBrowserAccess(nitroApp, localOrigin) {
  const bootstrap = globalThis[Symbol.for('vivary.desktop.bootstrap')];
  const dispatch = nitroApp.fetch.bind(nitroApp);
  let ingress;
  let stopped = false;
  let access;
  let listener;
  let previewListener;
  let previewGateway;
  const reconcilePreview = async () => {
    previewGateway?.close(); await previewListener?.close();
    previewGateway = createPreviewGateway({ access, listening: () => previewListener?.listening() ?? false }); installPreviewGateway(previewGateway);
    previewListener = createBrowserListener({ access: { configuration: () => { const config = access.configuration(); return { enabled: config.enabled && !!config.preview, port: config.preview?.port }; } }, fetch: request => previewGateway.handle(request) });
    await previewListener.reconcile();
  };
  const close = async () => {
    stopped = true; previewGateway?.close(); await previewListener?.close(); access?.close(); await listener?.close();
  };
  process.once('disconnect', close);
  nitroApp.hooks.hook('close', close);
  const ready = (async () => {
    if (!bootstrap?.capability) throw new Error('Desktop capability unavailable.');
    access = await createBrowserAccess();
    if (stopped) { access.close(); return; }
    listener = createBrowserListener({ access, fetch: request => ingress.remote(request) });
    ingress = createBrowserIngress({ dispatch, access, capability: bootstrap.capability, localOrigin,
      onConfiguration: async () => { await listener.reconcile(); await reconcilePreview(); }, listenerError: () => listener.error() ?? previewListener?.error() });
    await listener.reconcile(); await reconcilePreview();
  })();
  // Install synchronously before Nitro captures fetch for the desktop listener.
  nitroApp.fetch = async request => {
    try { await ready; return stopped ? denied() : await ingress.local(request); }
    catch { return json({ error: 'Desktop access is unavailable.' }, 503); }
  };
  void ready.catch(() => undefined);
}
