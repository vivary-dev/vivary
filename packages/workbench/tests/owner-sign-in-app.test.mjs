import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertNoMcpSurface, OWNER, send, startBuiltApp } from './built-app.mjs';

const PROXY_ORIGIN = 'https://vivary.example.test';

const get = (port, route, headers) => send(port, 'GET', route, headers);

const modes = {
  local: {
    args: [],
    env: {},
    origin: port => `http://127.0.0.1:${port}`,
    headers: port => ({ host: `127.0.0.1:${port}` }),
    carry: signedIn => ({ cookie: signedIn.cookie }),
  },
  // The Zo private proxy drops the Cookie header, so the browser carries its
  // session token in X-Vivary-Session on same-origin reads.
  'private-proxy': {
    args: ['--private-proxy', '--url', PROXY_ORIGIN],
    env: { VIVARY_TRUSTED_PROXY: 'zo-owner-only' },
    origin: () => PROXY_ORIGIN,
    carry: signedIn => ({ 'x-vivary-session': signedIn.body.token, 'sec-fetch-site': 'same-origin' }),
    headers: port => ({
      host: `127.0.0.1:${port}`,
      'x-forwarded-host': new URL(PROXY_ORIGIN).host,
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '192.0.2.10',
      'x-real-ip': '192.0.2.10',
    }),
  },
};

const start = (mode, data) => startBuiltApp(mode.args, data, { env: mode.env, headers: mode.headers });

async function savedSecret(file, origin) {
  const address = new URL((await readFile(file, 'utf8')).trim());
  assert.equal(address.origin, origin);
  assert.equal(address.pathname, '/sign-in');
  assert.equal(address.search, '');
  const secret = address.hash.slice(1);
  assert.match(secret, /^[\w-]{43}$/);
  return secret;
}

function cookies(response) {
  return [response.headers['set-cookie'] ?? []].flat().map(value => value.split(';')[0]).join('; ');
}

async function session(server, mode, extra = {}) {
  const response = await get(server.port, '/_agent-native/auth/session', { ...mode.headers(server.port), ...extra });
  assert.equal(response.status, 200, response.body);
  return { body: JSON.parse(response.body), cookie: cookies(response) };
}

for (const [name, mode] of Object.entries(modes)) {
  test(`${name} mode mints an owner session only for the one-time sign-in address`, { timeout: 180_000 }, async t => {
    const data = await mkdtemp(path.join(tmpdir(), `vivary-owner-sign-in-${name}-`));
    const file = path.join(data, 'owner-sign-in.txt');
    let server = await start(mode, data);
    t.after(async () => { await server.stop(); await rm(data, { recursive: true, force: true }); });
    const origin = mode.origin(server.port);
    const secrets = [];

    secrets.push(await savedSecret(file, origin));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

    const anonymous = await session(server, mode);
    assert.equal(anonymous.body.email, undefined, 'a request without the secret gets no session');
    assert.equal(anonymous.cookie, '');
    await assertNoMcpSurface(server.port, { host: `127.0.0.1:${server.port}` });

    const signedIn = await session(server, mode, { 'x-vivary-owner-sign-in': secrets[0] });
    assert.equal(signedIn.body.email, OWNER);
    assert.notEqual(signedIn.cookie, '');
    secrets.push(await savedSecret(file, origin));
    assert.notEqual(secrets[1], secrets[0], 'a used address is replaced');

    const replay = await session(server, mode, { 'x-vivary-owner-sign-in': secrets[0] });
    assert.equal(replay.body.email, undefined, 'a used address cannot sign in again');
    assert.equal(replay.cookie, '');

    assert.equal((await session(server, mode, mode.carry(signedIn))).body.email, OWNER);
    const headerOnly = { 'x-vivary-session': signedIn.body.token, 'sec-fetch-site': 'same-origin' };
    assert.equal((await session(server, mode, headerOnly)).body.email, name === 'local' ? undefined : OWNER,
      'only the private proxy accepts the session header on reads');

    const servers = await get(server.port, '/_agent-native/mcp/servers', { ...mode.headers(server.port), ...mode.carry(signedIn) });
    assert.equal(servers.status, 200, 'the MCP client settings route still answers the owner');

    const page = await get(server.port, '/sign-in', mode.headers(server.port));
    assert.equal(page.status, 200);
    const scriptStart = page.body.indexOf('<script');
    const firstScript = page.body.slice(scriptStart, page.body.indexOf('</script>', scriptStart));
    assert.match(firstScript, /x-vivary-owner-sign-in/, 'the sign-in script runs before any script Native adds');

    await server.stop();
    const firstOutput = server.output();
    server = await start(mode, data);
    const restartedOrigin = mode.origin(server.port);
    secrets.push(await savedSecret(file, restartedOrigin));
    assert.notEqual(secrets[2], secrets[1], 'each launch saves a new address');
    assert.equal((await session(server, mode, { 'x-vivary-owner-sign-in': secrets[1] })).body.email, undefined);
    assert.equal((await session(server, mode, mode.carry(signedIn))).body.email, OWNER,
      'an existing owner session survives a restart');

    await server.stop();
    const output = firstOutput + server.output();
    assert.match(output, /owner-sign-in\.txt/);
    for (const secret of secrets) assert.ok(!output.includes(secret), 'the secret never reaches the console');
  });
}
