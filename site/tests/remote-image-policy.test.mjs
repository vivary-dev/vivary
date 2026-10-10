import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const site = new URL('../', import.meta.url);
const astroRequire = createRequire(new URL('node_modules/astro/package.json', site));
const policyPath = astroRequire.resolve('http-cache-semantics');
const { default: Policy } = await import(pathToFileURL(policyPath));
const { loadRemoteImage, revalidateRemoteImage } = await import(
  new URL('node_modules/astro/dist/assets/build/remote.js', site)
);
const src = 'https://images.example.test/photo.png';
const imageConfig = { domains: ['images.example.test'], remotePatterns: [] };

test('Astro resolves the reviewed local policy and the lock contains no upstream implementation', () => {
  assert.equal(realpathSync(policyPath), fileURLToPath(new URL('vendor/astro-no-cache-policy/index.js', site)));
  const manifest = JSON.parse(readFileSync(new URL('vendor/astro-no-cache-policy/package.json', site)));
  assert.equal(manifest.name, '@vivary/astro-no-cache-policy');
  assert.equal(manifest.private, true);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', site)));
  assert.equal(lock.packages['node_modules/astro'].version, '7.3.5');
  const policies = Object.entries(lock.packages).filter(([name]) => name.endsWith('/http-cache-semantics'));
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0], ['node_modules/http-cache-semantics', {
    resolved: 'vendor/astro-no-cache-policy',
    link: true,
  }]);
});

test('request cache directives cannot make the replacement retain a response', () => {
  for (const directive of ['max-stale', 'max-stale=999999999', 'max-age=999999999']) {
    const policy = new Policy(
      { url: src, method: 'GET', headers: { 'cache-control': directive } },
      { status: 200, headers: { 'cache-control': 'public, max-age=31536000', 'set-cookie': 'session=other-user' } },
    );
    assert.equal(policy.storable(), false);
    assert.equal(policy.timeToLive(), 0);
  }
});

test('Astro loads new bytes but gives even public remote images no freshness', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url.url);
    return new Response('first image', { headers: {
      'cache-control': 'public, max-age=31536000',
      etag: '"v1"',
      'last-modified': 'Wed, 01 Oct 2025 00:00:00 GMT',
    } });
  };
  const result = await loadRemoteImage(src, fetchFn, imageConfig);
  assert.deepEqual(calls, [src]);
  assert.equal(result.data.toString(), 'first image');
  assert.equal(result.expires, now);
  assert.equal(result.etag, '"v1"');
  assert.equal(result.lastModified, 'Wed, 01 Oct 2025 00:00:00 GMT');
});

test('Astro conditional 304 retains validators without giving cached bytes freshness', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const previous = { etag: '"v1"', lastModified: 'Wed, 01 Oct 2025 00:00:00 GMT' };
  const result = await revalidateRemoteImage(src, previous, async (request) => {
    const headers = request.headers;
    assert.equal(headers.get('if-none-match'), previous.etag);
    assert.equal(headers.get('if-modified-since'), previous.lastModified);
    return new Response(null, { status: 304, headers: { 'cache-control': 'public, max-age=31536000' } });
  }, imageConfig);
  assert.equal(result.data, null);
  assert.equal(result.expires, now);
  assert.equal(result.etag, previous.etag);
  assert.equal(result.lastModified, previous.lastModified);
});

test('Astro revalidation replaces changed bytes and drops obsolete validators', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const result = await revalidateRemoteImage(src, { etag: '"v1"' }, async () => (
    new Response('second image', { headers: { 'cache-control': 'public, max-age=31536000' } })
  ), imageConfig);
  assert.equal(result.data.toString(), 'second image');
  assert.equal(result.expires, now);
  assert.equal(result.etag, undefined);
  assert.equal(result.lastModified, undefined);
});

test('Astro remote helpers still reject failed origin responses', async () => {
  const fetchFn = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(loadRemoteImage(src, fetchFn, imageConfig), /503/);
  await assert.rejects(revalidateRemoteImage(src, {}, fetchFn, imageConfig), /503/);
});
