import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertNoMcpSurface, startBuiltApp } from './built-app.mjs';

const HOSTED_ORIGIN = 'https://hosted.vivary.example.test';

test('a hosted launch serves no MCP endpoint, connect, OAuth, discovery, or embed route', { timeout: 180_000 }, async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'vivary-hosted-mcp-'));
  const server = await startBuiltApp(['--hosted', '--url', HOSTED_ORIGIN], data);
  t.after(async () => { await server.stop(); await rm(data, { recursive: true, force: true }); });
  await assertNoMcpSurface(server.port, { host: `127.0.0.1:${server.port}` });
});
