import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function ingressRequest(url, options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, response => resolve(new Response(
      [204, 304].includes(response.statusCode) || options.method === 'HEAD' ? null : Readable.toWeb(response),
      { status: response.statusCode, headers: Object.entries(response.headers).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : [[key, value]]) })));
    request.on('error', reject); request.end(options.body);
  });
}

const root = fileURLToPath(new URL('..', import.meta.url));
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }

test('normal desktop app admits only paired devices and preserves grants across restart', { timeout: 100_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vivary-browser-app-'));
  const desktopPort = await port(); const remotePort = await port();
  const origin = 'https://paired.vivary.test'; const local = `http://127.0.0.1:${desktopPort}`;
  let child; let output = ''; let capability; let localCookie = ''; let approve = true;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const current = child;
    await new Promise(resolve => {
      const timer = setTimeout(() => current.kill('SIGKILL'), 10_000);
      current.once('exit', () => { clearTimeout(timer); resolve(); });
      if (current.connected) current.send({ type: 'shutdown' }); else current.kill('SIGTERM');
    });
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    capability = randomBytes(32).toString('base64url');
    child = fork(path.join(root, 'bin/desktop-server.mjs'), ['--port', String(desktopPort), '--data-dir', directory], {
      cwd: root, execArgv: [], env: { PATH: '/usr/bin:/bin', HOME: directory, VIVARY_DESKTOP_HOST: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('message', message => {
      if (message.type === 'vivary:desktop:bootstrap-needed') child.send({ type: 'vivary:desktop:bootstrap', capability });
      if (message.type === 'vivary:browser-access:confirm') child.send({ type: 'vivary:browser-access:confirmed', requestId: message.requestId, approved: approve });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Normal app readiness timed out')), 30_000);
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Normal app exited before readiness')); });
    }).catch(async error => { await writeFile('/tmp/vivary-issue30-app-failure.log', output); throw error; });
  };
  const desktop = (route, options = {}) => fetch(local + route, { ...options,
    headers: { 'x-vivary-desktop': capability, cookie: localCookie, ...(options.body ? { origin: local, 'content-type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(15_000) });
  const remote = (route, credential = '', options = {}) => ingressRequest(`http://127.0.0.1:${remotePort}` + route, { ...options,
    headers: { host: new URL(origin).host, ...(credential ? { cookie: credential } : {}),
      ...(options.body ? { origin, 'content-type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(15_000) });
  const control = async command => { const response = await desktop('/_vivary/browser/control', { method: 'POST', body: JSON.stringify(command) });
    assert.equal(response.status, 200, await response.text()); };
  await start();
  assert.equal((await fetch(local + '/_agent-native/auth/session')).status, 401);
  const localSession = await desktop('/_agent-native/auth/session');
  assert.equal(localSession.status, 200);
  localCookie = localSession.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const organization = await desktop('/_agent-native/org', { method: 'POST', body: JSON.stringify({ name: 'Existing fixture workspace' }) });
  assert.equal(organization.status, 200, await organization.text());
  await control({ operation: 'configure', configuration: { origin, port: remotePort, label: 'Fixture laptop' } });
  for (const route of ['/', '/_agent-native/auth/session', '/_agent-native/application-state/probe', '/_agent-native/agent-chat/threads']) {
    assert.equal((await remote(route)).status, 401, route);
  }
  assert.equal((await remote('/', '', { headers: { host: `127.0.0.1:${desktopPort}` } })).status, 401);
  assert.equal((await remote('/', '', { headers: { 'x-vivary-desktop': capability } })).status, 401);
  const pairing = await remote('/_vivary/browser/pair', '', { method: 'POST', body: JSON.stringify({ label: 'Fixture phone' }) });
  assert.equal(pairing.status, 200);
  const pendingCookie = pairing.headers.get('set-cookie').split(';')[0]; const challenge = await pairing.json();
  approve = false;
  assert.equal((await desktop('/_vivary/browser/control', { method: 'POST', body: JSON.stringify({ operation: 'approve', id: challenge.id }) })).status, 409);
  approve = true;
  await control({ operation: 'approve', id: challenge.id });
  const completion = await remote('/_vivary/browser/complete', pendingCookie, { method: 'POST', body: '{}' });
  assert.equal(completion.status, 200);
  const deviceCookie = completion.headers.get('set-cookie').split(';')[0];
  assert.equal((await remote('/_vivary/browser/complete', pendingCookie, { method: 'POST', body: '{}' })).status, 409);
  const db = new DatabaseSync(path.join(directory, 'auth.sqlite'), { readOnly: true });
  const token = db.prepare("SELECT native_token FROM vivary_browser_grants WHERE status='active'").get().native_token; db.close();
  const session = await remote('/_agent-native/auth/session', deviceCookie);
  assert.equal(session.status, 200); const identity = await session.json();
  assert.equal(identity.email, 'owner@local.vivary.test'); assert.equal(identity.token, undefined); assert.equal(identity.orgId, (await (await desktop('/_agent-native/auth/session')).json()).orgId);
  for (const headers of [{ authorization: `Bearer ${token}` }, { authorization: `Bearer ${deviceCookie.split('=')[1]}` }, { 'x-vivary-session': token }]) {
    assert.equal((await remote('/_agent-native/auth/session', deviceCookie, { headers })).status, 401);
  }
  assert.equal((await remote('/_agent-native/auth/session?_session=' + token, deviceCookie)).status, 401);
  assert.equal((await remote('/_agent-native/auth/session?__an_embed_token=fixture', deviceCookie)).status, 401);
  for (const route of ['/mcp/connect/token', '/mcp/device/authorize', '/%6dcp/connect/token', '/_agent-native/%61uth/login', '/_agent-native/actions/vivary-connect-project-%66older', '/_agent-native/%ZZ']) assert.equal((await remote(route, deviceCookie)).status, 401, route);
  const action = await remote('/_agent-native/actions/vivary-chat-draft', deviceCookie, {
    method: 'POST', body: JSON.stringify({ operation: 'list', kind: 'code', projectId: null }) });
  assert.equal(action.status, 200, await action.text());
  for (const route of ['/', '/_agent-native/agent-chat/threads', '/_agent-native/application-state/probe']) {
    const response = await remote(route, deviceCookie); const text = await response.text();
    assert.equal(response.status, 200, route + ': ' + text.slice(0, 100));
    assert.equal(text.includes(token) || text.includes(capability), false);
    assert.equal(JSON.stringify([...response.headers]).includes(token), false);
  }
  assert.equal((await remote('/_vivary/browser/control', deviceCookie, { method: 'POST', body: JSON.stringify({ operation: 'disable' }) })).status, 401);
  const beforeEntry = await (await desktop('/_vivary/browser/status')).json();
  for (const route of ['/', '/pair']) for (const credential of ['', deviceCookie]) {
    const entry = await remote(route, credential, { headers: { 'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' } });
    assert.equal(entry.status, 200);
    const html = await entry.text();
    assert.equal(html.includes(token) || html.includes(capability) || html.includes('Fixture laptop'), false);
    assert.equal(entry.headers.get('set-cookie'), null);
  }
  const afterEntry = await (await desktop('/_vivary/browser/status')).json();
  assert.deepEqual(afterEntry.devices, beforeEntry.devices);
  assert.deepEqual(afterEntry.pending, beforeEntry.pending);
  const firstStatus = await (await remote('/_vivary/browser/status', deviceCookie)).json();
  await stop(); await start();
  const restarted = await (await remote('/_vivary/browser/status', deviceCookie)).json();
  assert.equal(restarted.instanceId, firstStatus.instanceId); assert.equal(restarted.enabled, true);
  const status = await (await desktop('/_vivary/browser/status')).json();
  const stream = await remote('/_agent-native/events', deviceCookie);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const ended = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; const text = new TextDecoder().decode(part.value); assert.equal(text.includes(token) || text.includes(capability), false); } } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; } return true; })();
  await control({ operation: 'revoke', id: status.devices[0].id });
  assert.equal(await Promise.race([ended, new Promise(resolve => setTimeout(() => resolve(false), 3000))]), true, 'device stream ends on revoke');
  assert.equal((await remote('/_agent-native/auth/session', deviceCookie)).status, 401);
  assert.equal((await remote('/', deviceCookie)).status, 401);
  assert.equal((await desktop('/_agent-native/auth/session')).status, 200);
  await stop();
  const occupied = createServer(); await new Promise(resolve => occupied.listen(remotePort, '127.0.0.1', resolve));
  try {
    await start();
    assert.equal((await desktop('/_agent-native/auth/session')).status, 200);
    const failedIngress = await (await desktop('/_vivary/browser/status')).json();
    assert.match(failedIngress.listenerError, /unavailable/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await control({ operation: 'configure', configuration: { origin, port: remotePort, label: 'Fixture laptop' } });
  assert.equal((await remote('/', deviceCookie)).status, 401);
});
