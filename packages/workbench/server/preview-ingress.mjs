import { remotePreviewInput } from '../shared/remote-preview.ts';
import { randomBytes, createHash } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { fail } from '@agent-native/core/action';
import { currentBrowserIdentity } from './browser-request-context.mjs';
import { ownedProjectPreview } from './project-preview.ts';

const ROOT = '/_vivary/preview';
const COOKIE = '__Host-vivary-preview';
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
let installed;
export function installPreviewGateway(gateway) { installed = gateway; }
// Refusals use fail() because the action route shows a phone only contract errors below 500.
export function remotePreviewCommand(input, context) {
  if (!installed) fail('Remote previews are not configured on this host.', { statusCode: 409 });
  const identity = currentBrowserIdentity();
  if (identity?.kind !== 'remote') fail('Use the paired browser to open an isolated preview.', { statusCode: 403 });
  return installed.command(remotePreviewInput.parse(input), context, identity.deviceId);
}
// `listening` reports whether the preview origin's loopback listener is bound right now.
// Saved settings alone cannot tell, because a port conflict leaves them unchanged.
export function createPreviewGateway({ access, resolveTarget = ownedProjectPreview, now = Date.now, listening = () => true }) {
  const documents = new Map(), tickets = new Map(), leases = new Map();
  let closed = false;
  let queue = Promise.resolve();
  const config = () => access.configuration();
  const headers = () => ({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors ${config().origin}; sandbox allow-scripts allow-forms allow-same-origin`,
    'x-content-type-options': 'nosniff' });
  const deny = (status = 403) => new Response('Preview access is unavailable. Return to Vivary.', { status, headers: headers() });
  function retire(record) {
    if (record.retired) return;
    record.retired = true;
    record.target.signal.removeEventListener('abort', record.abort);
    record.controller.signal.removeEventListener('abort', record.abort);
    record.controller.abort(); record.release(); clearTimeout(record.timer); clearInterval(record.watch);
    for (const [key, value] of tickets) if (value === record) tickets.delete(key);
    for (const [key, value] of leases) if (value === record) leases.delete(key);
  }
  const ended = () => { throw new Error('Preview access ended.'); };
  // Open runs through the action route, which shows a phone only contract errors below 500.
  const listenerDown = () => fail('Isolated preview is unavailable because its listener on this host could not start or has stopped. On the desktop, repair the preview port in Browser access settings.',
    { statusCode: 409, errorCode: 'vivary_preview_listener_unavailable' });
  const openEnded = () => listening() ? fail('Preview access ended. Open the preview again.', { statusCode: 409 }) : listenerDown();
  async function live(record, end = ended) {
    if (closed || record.controller.signal.aborted || !config().enabled || config().preview?.origin !== record.origin
      || now() >= record.expiresAt || !listening()) end();
    await record.target.check();
    if (record.controller.signal.aborted) end();
  }
  async function command(input, context, deviceId) {
    const key = `${deviceId}:${input.documentId}`;
    const previous = documents.get(key);
    if (input.operation === 'close') { if (previous) retire(previous); return { closed: true }; }
    if (closed || !config().enabled || !config().preview) fail('Enable the separate preview origin in desktop Browser access settings.', { statusCode: 409 });
    // Refuse before any ticket. Otherwise the remote frame loads a bootstrap URL that nothing answers.
    if (!listening()) listenerDown();
    if (documents.size >= 128 && !previous) fail('Too many preview documents. Restart browser access from the desktop.', { statusCode: 409 });
    const target = await resolveTarget(context, input.projectId, input.launchId);
    const binding = `${input.projectId}:${input.launchId}:${target.generation}`;
    if (previous && previous.binding !== binding) fail('Save your work and refresh Vivary before opening a different preview.', { statusCode: 409 });
    // Keep the identity lock after close. Only a new app document may select another identity.
    if (previous) retire(previous);
    const controller = new AbortController();
    const grant = await access.admitPreviewGrant(deviceId, controller);
    if (!grant) fail('Browser access ended.', { statusCode: 409 });
    let record;
    try {
      const settings = config();
      if (closed || controller.signal.aborted || !settings.enabled || !settings.preview) openEnded();
      record = { binding, origin: settings.preview.origin, target, controller, release: grant.release, expiresAt: now() + 5 * 60_000 };
      record.abort = () => retire(record);
      documents.set(key, record);
      target.signal.addEventListener('abort', record.abort, { once: true });
      controller.signal.addEventListener('abort', record.abort, { once: true });
      if (target.signal.aborted) openEnded();
      record.timer = setTimeout(record.abort, 5 * 60_000); record.timer.unref();
      record.watch = setInterval(() => { void live(record).catch(record.abort); }, 1000); record.watch.unref();
      await live(record, openEnded);
      const ticket = secret(); tickets.set(hash(ticket), record);
      record.ticketExpires = now() + 30_000;
      return { ticket, origin: record.origin, generation: target.generation };
    } catch (error) {
      if (record) retire(record);
      else { controller.abort(); grant.release(); }
      throw error;
    }
  }
  function bootstrap() {
    // This trusted page runs before any project bytes and never inspects normal browser cookies.
    const app = JSON.stringify(config().origin);
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><p id="status">Connecting isolated preview…</p><script>
const app=${app};let accepted=false;
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==app||!window.credentialless||parent===window)return;
 const value=event.data;if(!value||typeof value.nonce!=='string')return;
 if(value.type==='vivary-preview-hello'&&!accepted){parent.postMessage({type:'vivary-preview-ready',nonce:value.nonce},app);return;}
 if(value.type!=='vivary-preview-ticket'||accepted||typeof value.ticket!=='string')return;
 accepted=true;
 try{const response=await fetch('${ROOT}/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:value.ticket})});if(!response.ok)throw Error();
 const result=await response.json();const check=await fetch('${ROOT}/check',{cache:'no-store'});if(!check.ok)throw Error();location.replace(result.path);
 }catch{document.getElementById('status').textContent='Preview access ended or this browser cannot isolate preview cookies. Return to Vivary.';}
});
if(!window.credentialless||parent===window)document.getElementById('status').textContent='Use the isolated preview inside Vivary.';
</script>`, { headers: { ...headers(), 'content-type': 'text/html; charset=utf-8' } });
  }
  async function handle(request) {
    let record;
    try {
      const settings = config(), url = new URL(request.url);
      if (closed || !settings.enabled || !settings.preview || request.headers.get('host') !== new URL(settings.preview.origin).host) return deny();
      const pathname = decodeURIComponent(url.pathname);
      if (/[\\\x00-\x1f]/.test(pathname) || request.headers.has('upgrade') || ['CONNECT','TRACE'].includes(request.method)) return deny();
      const destination = request.headers.get('sec-fetch-dest');
      if (['document','worker','sharedworker','serviceworker','object','embed'].includes(destination)) return deny();
      if (pathname === `${ROOT}/bootstrap`) return request.method === 'GET' && destination === 'iframe' && !url.search ? bootstrap() : deny();
      if (request.headers.get('sec-fetch-site') !== 'same-origin') return deny();
      if (request.headers.has('origin') && request.headers.get('origin') !== settings.preview.origin) return deny();
      if (pathname === `${ROOT}/redeem`) {
        if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json' || request.headers.get('origin') !== settings.preview.origin) return deny();
        const reader = request.body?.getReader(); if (!reader) return deny();
        const chunks = []; let length = 0;
        try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 1024) return deny(); chunks.push(Buffer.from(value)); } } finally { await reader.cancel().catch(() => undefined); }
        const body = Buffer.concat(chunks).toString('utf8');
        const { ticket } = z.object({ ticket: z.string().regex(/^[\w-]{43}$/) }).strict().parse(JSON.parse(body));
        record = tickets.get(hash(ticket)); tickets.delete(hash(ticket));
        if (!record || now() >= record.ticketExpires) return deny();
        await live(record);
        const credential = secret(); leases.set(hash(credential), record);
        return Response.json({ path: record.target.initialPath }, { headers: { ...headers(), 'set-cookie': `${COOKIE}=${credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300` } });
      }
      const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
      if (values.length !== 1) return deny();
      record = leases.get(hash(values[0].slice(COOKIE.length + 1)));
      if (!record) return deny();
      await live(record);
      if (pathname === `${ROOT}/check`) return new Response(null, { status: 204, headers: headers() });
      if (pathname.startsWith('/_vivary/') || pathname.startsWith('/_agent-native/') || pathname.startsWith('/mcp')) return deny();
      const controller = new AbortController();
      const abort = () => controller.abort();
      record.controller.signal.addEventListener('abort', abort, { once: true }); request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted || record.controller.signal.aborted) abort();
      const release = () => { record.controller.signal.removeEventListener('abort', abort); request.signal.removeEventListener('abort', abort); };
      let socket;
      try {
        socket = await record.target.connect(controller.signal);
        await live(record);
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => socket;
        const allowed = ['accept','accept-language','content-type','range','if-range'];
        const forwarded = Object.fromEntries(allowed.flatMap(name => request.headers.has(name) ? [[name, request.headers.get(name)]] : []));
        forwarded.host = new URL(record.target.upstreamOrigin).host;
        if (request.headers.has('origin')) forwarded.origin = record.target.upstreamOrigin;
        const response = await new Promise((resolve, reject) => {
          let received = false;
          const upstream = httpRequest({ hostname: '127.0.0.1', port: Number(new URL(record.target.upstreamOrigin).port), path: url.pathname + url.search,
            method: request.method, headers: forwarded, agent, signal: controller.signal }, response => { received = true; resolve(response); });
          upstream.once('error', reject);
          upstream.once('upgrade', (_response, upgraded) => { upgraded.destroy(); controller.abort(); reject(new Error('Preview upgrades are unsupported.')); });
          upstream.once('close', () => { if (!received) reject(new Error('Preview response closed before headers.')); });
          if (request.body) {
            void pipeline(Readable.fromWeb(request.body), upstream, { signal: controller.signal }).catch(error => { controller.abort(); reject(error); });
          } else upstream.end();
        });
        if (controller.signal.aborted) throw new Error('Preview access ended.');
        const outgoing = new Headers(headers());
        for (const name of ['content-type','content-encoding','content-range','accept-ranges']) if (typeof response.headers[name] === 'string') outgoing.set(name, response.headers[name]);
        if (response.headers['content-security-policy']) outgoing.append('content-security-policy', String(response.headers['content-security-policy']));
        if (response.headers['x-frame-options']) outgoing.set('x-frame-options', String(response.headers['x-frame-options']));
        if (response.headers.location) {
          const location = new URL(response.headers.location, new URL(url.pathname + url.search, record.target.upstreamOrigin));
          if (location.origin !== record.target.upstreamOrigin) throw new Error('External preview redirect refused.');
          outgoing.set('location', settings.preview.origin + location.pathname + location.search + location.hash);
        }
        response.once('close', () => { release(); agent.destroy(); });
        response.once('error', () => { release(); agent.destroy(); });
        const status = response.statusCode ?? 502;
        if (request.method === 'HEAD' || [204,205,304].includes(status)) { response.resume(); return new Response(null, { status, headers: outgoing }); }
        return new Response(Readable.toWeb(response), { status, headers: outgoing });
      } catch { socket?.destroy(); release(); return deny(502); }
    } catch { return deny(); }
  }
  return { command(input, context, deviceId) { const result = queue.then(() => command(input, context, deviceId)); queue = result.catch(() => undefined); return result; }, handle, close() { closed = true; for (const record of documents.values()) retire(record); documents.clear(); tickets.clear(); leases.clear(); } };
}
