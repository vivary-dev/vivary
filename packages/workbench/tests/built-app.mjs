import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const OWNER = 'owner@local.vivary.test';

export async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// fetch() cannot set Host, which the private proxy boundary reads.
export function send(port, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: route, method, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    request.setTimeout(15_000, () => request.destroy(new Error(`${method} ${route} timed out`)));
    request.on('error', reject);
    request.end(body);
  });
}

export async function startBuiltApp(args, data, { env = {}, headers = port => ({ host: `127.0.0.1:${port}` }) } = {}) {
  const port = await freePort();
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, ['bin/start.mjs', '--port', String(port), '--data-dir', data, ...args], {
    cwd: root,
    detached: true,
    env: { PATH: '/usr/bin:/bin', HOME: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      process.kill(-child.pid, 'SIGTERM');
    });
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Vivary exited before readiness:\n${output}`);
    try {
      if ((await send(port, 'GET', '/_agent-native/ping', headers(port))).status === 200) break;
    } catch { /* The server may still be booting. */ }
    if (Date.now() > deadline) { await stop(); throw new Error(`Vivary readiness timed out:\n${output}`); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { port, stop, pid: child.pid, readyMs: performance.now() - spawnedAt, output: () => output };
}

// Native's MCP dev-open mode trusted a loopback caller that names the owner, with no session.
export function mcpInitialize(port, route, headers) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-local-program', version: '0' } },
  });
  return send(port, 'POST', route, {
    ...headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-agent-native-owner-email': OWNER,
  }, body);
}

export async function assertNoMcpSurface(port, headers) {
  const json = { ...headers, 'content-type': 'application/json' };
  for (const prefix of ['/mcp', '/_agent-native/mcp']) {
    const mcp = await mcpInitialize(port, prefix, headers);
    assert.equal(mcp.status, 404, `POST ${prefix} must not admit a raw local program that names the owner`);
    const device = await send(port, 'POST', `${prefix}/connect/device/start`, json, '{}');
    assert.equal(device.status, 404, `${prefix} connect is unmounted`);
    assert.doesNotMatch(device.body, /device_code|user_code/, `${prefix} must not start an MCP connect flow`);
    const client = await send(port, 'POST', `${prefix}/oauth/register`, json,
      JSON.stringify({ client_name: 'raw-local-program', redirect_uris: ['http://127.0.0.1:9/callback'] }));
    assert.equal(client.status, 404, `${prefix} OAuth is unmounted`);
    assert.doesNotMatch(client.body, /client_id/, `${prefix} must not register an MCP OAuth client`);
  }
  // Native mounts embed-error ahead of its guard, so the route answers 204 when mounted.
  const embedError = await send(port, 'POST', '/_agent-native/mcp/embed-error', json, '{}');
  assert.equal(embedError.status, 401, 'POST /_agent-native/mcp/embed-error is unmounted and reaches the guard');
  assert.deepEqual(JSON.parse(embedError.body), { error: 'Unauthorized' });
  for (const route of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/.well-known/mcp.json',
    '/_agent-native/embed/start',
  ]) {
    assert.equal((await send(port, 'GET', route, headers)).status, 404, `GET ${route} is unmounted`);
  }
  const card = await send(port, 'GET', '/.well-known/mcp.json', headers);
  assert.equal(card.headers['x-content-type-options'], 'nosniff', 'the card refusal sets nosniff');
  assert.equal(card.headers['cache-control'], 'no-store', 'the card refusal is not cached');
}
