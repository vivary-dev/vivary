// Real built app, disposable history, no sends or provider calls. See README.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { OWNER, send, startBuiltApp } from '../built-app.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, size: { type: 'string', default: 'both' },
  repeats: { type: 'string', default: '3' }, samples: { type: 'string', default: '15' } } });
assert.ok(values.output, 'Required: --output /path/result.json');
assert.ok(['small', 'large', 'both'].includes(values.size));
const repeats = Number(values.repeats), samples = Number(values.samples);
assert.ok(Number.isInteger(repeats) && repeats >= 3, 'Use at least three fresh servers per size');
assert.ok(Number.isInteger(samples) && samples >= 15, 'Use at least 15 switches per scenario');
const sizes = values.size === 'both' ? ['small', 'large'] : [values.size];
const executablePath = process.env.VIVARY_PERF_CHROME ?? '/usr/bin/google-chrome'; // guard:allow-env-credential - Local browser path for the perf harness, not a credential.
const sha256 = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
// Bind every result to the exact source (HEAD plus any uncommitted change), harness, and build.
function sourceIdentity() {
  const top = git('rev-parse', '--show-toplevel').trim();
  const untracked = git('-C', top, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  const dirty = createHash('sha256').update(git('-C', top, 'diff', 'HEAD', '--binary'));
  for (const file of untracked) dirty.update(file + '\0').update(readFileSync(path.join(top, file)));
  return { commit: git('rev-parse', 'HEAD').trim(), dirty: Boolean(git('status', '--porcelain').trim()),
    dirtyHash: dirty.digest('hex'), untrackedFiles: untracked.length };
}
function buildIdentity() {
  // Vite names assets by content hash, so names and sizes identify the served build.
  const root = path.resolve('.output');
  const entries = readdirSync(root, { recursive: true }).map(String).sort()
    .map(file => { const stat = statSync(path.join(root, file)); return stat.isFile() ? `${file}:${stat.size}` : null; }).filter(Boolean);
  return { files: entries.length, hash: sha256(entries.join('\n')), builtAt: statSync(path.join(root, 'server', 'index.mjs')).mtime.toISOString() };
}
const report = { schema: 'vivary.responsiveness/v2', conditions: {
  ...sourceIdentity(), harnessSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), build: buildIdentity(),
  node: process.version, chromePath: executablePath, cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(),
  cpu: os.cpus()[0]?.model, loadAverage: os.loadavg(), platform: `${os.platform()} ${os.release()}`,
  seed: 188, repeats, samples, viewport: { width: 1440, height: 1000 },
  timings: 'monotonic wall time; click includes actionability; visible means rendered in viewport; no model calls',
  cold: 'First visit in a browser context; small history starts another context when distinct entries run out',
  ready: 'Code: target last event visible and composer enabled. Native: target last message visible and the provider state settled (enabled composer or the Connect AI card)',
  search: 'Enter until the expected conversation is listed, clicking "Search more history" as a user would, at most 10 times (beyond that the sample is reported not found, not timed); settled when no search is running; every hit must belong to the expected conversation',
}, runs: [] };
const tracePath = path.resolve(values.output).replace(/\.json$/, '') + '.trace.jsonl';

function prng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
function stats(input) {
  const sorted = [...input].sort((a, b) => a - b);
  const q = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { n: input.length, p50: q(.5), p90: q(.9), min: sorted[0], max: sorted.at(-1), samples: input };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = output => output.split('\n').filter(line => line.startsWith('VIVARY_PERF_METRICS '))
  .map(line => JSON.parse(line.slice('VIVARY_PERF_METRICS '.length)));

async function authenticate(server, data) {
  const secret = new URL((await readFile(path.join(data, 'owner-sign-in.txt'), 'utf8')).trim()).hash.slice(1);
  const auth = await send(server.port, 'GET', '/_agent-native/auth/session', { 'x-vivary-owner-sign-in': secret });
  assert.equal(auth.status, 200, auth.body);
  assert.equal(JSON.parse(auth.body).email, OWNER);
  return [auth.headers['set-cookie'] ?? []].flat().map(value => value.split(';')[0]).join('; ');
}
async function seed(server, data, size) {
  const cookie = await authenticate(server, data), origin = `http://127.0.0.1:${server.port}`;
  const request = async (method, route, body) => {
    const response = await send(server.port, method, route, { cookie, origin, 'sec-fetch-site': 'same-origin',
      'x-agent-native-frontend': '1', 'content-type': 'application/json' }, body && JSON.stringify(body));
    assert.equal(response.status, 200, `${method} ${route}: ${response.body}`);
    return JSON.parse(response.body);
  };
  const action = (name, params = {}) => request('GET', '/_agent-native/actions/' + name + '?' + new URLSearchParams(params));
  const catalog = await action('vivary-project-catalog');
  const registration = await request('POST', '/_agent-native/actions/vivary-register-project', {
    operationId: 'perf188seed', expectedPolicyRevision: catalog.policyRevision,
    expectedRegistryRevision: catalog.registryRevision, locationRef: catalog.locations[0].locationRef,
    displayName: 'Responsiveness fixture', contentIdentity: null, attachProjectId: null,
  });
  assert.ok(['registered', 'already-registered'].includes(registration.code));
  const projectId = registration.projectId;
  const identity = await action('vivary-chat-identity', { kind: 'project', projectId });
  const unassigned = await action('vivary-chat-identity', { kind: 'unassigned' });
  const orgId = /^vivary-workbench-chat-v1:([A-Za-z0-9_-]{1,128})$/.exec(unassigned.scope?.id ?? '')?.[1];
  assert.ok(orgId);
  const random = prng(188), baseTime = 1700000000000;
  const payload = () => Array.from({ length: 12 }, () => Math.floor(random() * 1e9).toString(36)).join(' ');
  const nativeCount = size === 'small' ? 10 : 200, codeCount = size === 'small' ? 10 : 1000;
  const native = [], code = [];
  const query = '?' + new URLSearchParams({ scopeType: identity.scope.type, scopeId: identity.scope.id });
  for (let i = 0; i < nativeCount; i++) {
    const id = `perf-native-${String(i).padStart(4, '0')}`, title = `Perf Native ${String(i).padStart(4, '0')}`;
    const count = size === 'small' ? 20 : i >= nativeCount - 3 ? 2000 : 200;
    const last = `LAST NATIVE ${id}`, messages = Array.from({ length: count }, (_, j) => ({
      message: { id: `${id}-msg-${j}`, role: j % 2 ? 'assistant' : 'user',
        createdAt: new Date(baseTime + j).toISOString(), content: [{ type: 'text',
          text: j === count - 1 ? last : `perfneedle ${id} ${j} ${payload()}` }],
        ...(j % 2 ? { status: { type: 'complete', reason: 'stop' } } : {}) },
      parentId: j ? `${id}-msg-${j - 1}` : null,
    }));
    await request('POST', '/_agent-native/agent-chat/threads' + query, { id, title, scope: identity.scope });
    await request('PUT', `/_agent-native/agent-chat/threads/${id}` + query, {
      title, preview: last, messageCount: count, threadData: JSON.stringify({ headId: messages.at(-1).message.id, messages }), scope: identity.scope,
    });
    native.push({ id, title, last, count });
  }
  // Code runs are seeded after Native threads with recent activity spaced 100 ms apart (Native seeds at ~12 per second) so the
  // newest sidebar rows interleave both runtimes, as mixed real use does.
  const codeNewest = Date.now();
  const store = path.join(data, 'code-runs');
  await mkdir(path.join(store, 'runs'), { recursive: true });
  await mkdir(path.join(store, 'transcripts'), { recursive: true });
  for (let i = 0; i < codeCount; i++) {
    const id = `perf-code-${String(i).padStart(4, '0')}`, title = `Perf Code ${String(i).padStart(4, '0')}`;
    const count = size === 'small' ? 50 : i < 5 ? 5000 : 400, last = `LAST CODE ${id}`;
    const events = Array.from({ length: count }, (_, j) => ({ schemaVersion: 1, id: `${id}-evt-${j}`, runId: id,
      kind: j % 2 ? 'system' : 'user', metadata: j % 2 ? { role: 'assistant' } : {},
      message: j === count - 1 ? last : `perfneedle ${id} ${j} ${payload()}`, createdAt: new Date(baseTime + j).toISOString() }));
    await writeFile(path.join(store, 'runs', id + '.json'), JSON.stringify({ schemaVersion: 1, id, goalId: 'vivary-local-code',
      title, status: 'completed', phase: 'completed', cwd: path.join(data, 'workspace'),
      createdAt: new Date(codeNewest - i * 100 - 60_000).toISOString(), updatedAt: new Date(codeNewest - i * 100).toISOString(),
      metadata: { app: 'vivary-workbench-local-code', ownerEmail: OWNER, orgId, projectId,
        bindingId: registration.bindingId, workspaceRoot: path.join(data, 'workspace'), engine: 'claude-cli', model: 'sonnet' } }));
    await writeFile(path.join(store, 'transcripts', id + '.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    code.push({ id, title, last, count });
  }
  await request('PUT', '/_agent-native/application-state/vivary-project-selection-v1', { scopeKey: catalog.scopeKey, projectId });
  return { projectId, identity, native, code, counts: { nativeCount, codeCount } };
}
async function fakeRuntime(data) {
  const bin = path.join(data, 'bin'); await mkdir(bin);
  // Only readiness is simulated. Any accidental execution fails instead of calling a provider.
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$*" = "auth status --json" ]; then\n  printf \'{"loggedIn":true}\\n\'\nelse\n  exit 93\nfi\n', { mode: 0o700 });
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'Not logged in\\n\' >&2\nexit 1\n', { mode: 0o700 });
  return { PATH: `${bin}:/usr/bin:/bin`, VIVARY_PERF_METRICS: '1' };
}
async function openPage(browser, origin, cookie, fixture) {
  const context = await browser.newContext({ viewport: report.conditions.viewport });
  await context.addCookies(cookie.split('; ').map(part => {
    const index = part.indexOf('='); return { name: part.slice(0, index), value: part.slice(index + 1), url: origin };
  }));
  await context.addInitScript(({ identity, projectId }) => {
    window.__perfFixture = { identity, projectId };
  }, fixture);
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || /\/agent-chat\/(send|stream|run)(\/|$)|\/actions\/vivary-code-send/.test(url.pathname)) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  // Long histories can legitimately take tens of seconds; record them instead of aborting.
  page.setDefaultTimeout(180_000);
  const opened = { context, page, cdp: await context.newCDPSession(page), crashed: false };
  page.on('crash', () => { opened.crashed = true; });
  return opened;
}
async function composerUsable(page) {
  const input = page.locator('textarea:visible, [contenteditable="true"]:visible').last();
  await input.waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .some(el => el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true'));
}
async function nativeProviderSettled(page) {
  // Without a configured provider Native shows its Connect AI card; with one, an enabled composer.
  const enabled = page.locator('textarea:enabled, [contenteditable="true"]:not([aria-disabled="true"])');
  await page.getByText('Connect AI', { exact: true }).or(enabled).filter({ visible: true }).first().waitFor();
}
function rssBytes(pid) {
  try { return Number(/^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; } catch { return 0; }
}
// Heap and DOM size of the page, plus resident memory of every Chrome renderer (Linux /proc).
async function memorySample(browser, current) {
  const heap = await current.cdp.send('Runtime.getHeapUsage');
  const dom = await current.cdp.send('Memory.getDOMCounters');
  let renderers = [];
  try {
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    await session.detach();
    renderers = processInfo.filter(info => info.type === 'renderer').map(info => rssBytes(info.id));
  } catch { /* Process info is diagnostic only. */ }
  return { jsHeapUsedBytes: heap.usedSize, jsHeapTotalBytes: heap.totalSize, domNodes: dom.nodes, jsEventListeners: dom.jsEventListeners,
    rendererRssBytes: renderers.reduce((sum, value) => sum + value, 0), maxRendererRssBytes: Math.max(0, ...renderers) };
}
async function trace(entry) { await appendFile(tracePath, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); }
async function listVisible(page) {
  // The sidebar shows the newest conversations first; older Code runs sit behind "More conversations".
  await page.locator('.an-chat-history-row__button:visible').first().waitFor();
}
async function expandList(page) {
  const more = page.getByRole('button', { name: 'More conversations', exact: true });
  if (await more.isVisible()) await more.click();
  await page.locator('.an-chat-history-row__button:visible').filter({ hasText: 'Perf Code' }).first().waitFor();
}
async function clickConversation(page, item) {
  const row = page.locator('.an-chat-history-row__button:visible').filter({ hasText: item.title }).first();
  // Switching can collapse the sidebar back to its newest rows; expanding is not timed.
  if (!(await row.isVisible())) {
    const more = page.getByRole('button', { name: 'More conversations', exact: true });
    if (await more.isVisible()) await more.click();
  }
  await row.waitFor();
  const start = performance.now();
  await row.click();
  // Target marker is unique across all histories and only the active mounted view may count.
  await page.getByText(item.last, { exact: true }).filter({ visible: true }).last().waitFor();
  // Usable means the composer state is current too: Code's composer is enabled; Native's
  // fixture has no provider, so its settled state is the Connect AI card.
  if (item.title.startsWith('Perf Code')) await composerUsable(page);
  else await nativeProviderSettled(page);
  return performance.now() - start;
}
// Each sample keeps its target and history length so long and ordinary conversations stay separable.
function scenario(entries) {
  const result = { ...stats(entries.map(entry => entry.ms)), targets: entries.map(entry => entry.target) };
  const longest = Math.max(...entries.map(entry => entry.count));
  const long = entries.filter(entry => entry.count === longest), rest = entries.filter(entry => entry.count !== longest);
  if (long.length && rest.length) Object.assign(result, { longest: { messages: longest, ...stats(long.map(entry => entry.ms)) },
    others: stats(rest.map(entry => entry.ms)) });
  return result;
}
const MAX_MORE_CLICKS = 10;
async function searchFor(page, item) {
  const box = page.locator('.chat-session-search:visible').first();
  const input = box.getByRole('searchbox', { name: 'Search conversations' });
  // Fill and Enter in the same turn: Enter starts at once instead of after the 250ms typing debounce.
  await input.fill(`perfneedle ${item.id}`);
  const start = performance.now(); await input.press('Enter');
  const hit = box.locator(`.chat-search-result[data-session-id="${item.id}"]`), more = box.getByRole('button', { name: 'Search more history', exact: true });
  let moreClicks = 0, found = true;
  for (;;) {
    await hit.or(more).first().waitFor();
    if (await hit.first().isVisible()) break;
    // The automatic budget stopped before this conversation; a person would ask for more, but
    // not indefinitely. Past the cap the sample is "not found", never a time.
    if (moreClicks === MAX_MORE_CLICKS) { found = false; break; }
    await more.click(); moreClicks++;
  }
  const firstMs = performance.now() - start;
  await box.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
  const settledMs = performance.now() - start;
  const ids = await box.locator('.chat-search-result').evaluateAll(links => links.map(link => link.dataset.sessionId));
  assert.ok((!found || ids.length) && ids.every(id => id === item.id), `Search for ${item.id} listed ${[...new Set(ids)].join(', ')}`);
  await box.getByRole('button', { name: 'Clear search', exact: true }).click();
  return { found, firstMs, settledMs, moreClicks, hits: ids.length };
}
async function measure(size, repeat) {
  const data = await mkdtemp(path.join(os.tmpdir(), 'vivary-perf188-'));
  let server, browser, current, run, phase = 'setup', lastMemory = null;
  try {
    const env = await fakeRuntime(data);
    server = await startBuiltApp([], data, { env });
    const fixture = await seed(server, data, size);
    // Setup writes are outside every measurement.
    await server.stop();
    server = await startBuiltApp([], data, { env });
    const cookie = await authenticate(server, data);
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath, headless: true });
    report.conditions.chrome = browser.version();
    run = { size, repeat, status: 'running', loadAverage: os.loadavg(), fixture: fixture.counts,
      startup: { serverReadyMs: server.readyMs, pageToListMs: [], pageToComposerMs: [] }, scenarios: {}, memory: {} };
    const checkpoint = async (name, target = null, ms = null) => {
      lastMemory = { phase: name, target, ...await memorySample(browser, current) };
      await trace({ size, repeat, ms, ...lastMemory });
      return lastMemory;
    };
    // The first load meets a just-started server; later loads use fresh browser contexts.
    phase = 'startup';
    for (let i = 0; i < 5; i++) {
      await current?.context.close();
      current = await openPage(browser, origin, cookie, fixture);
      const start = performance.now();
      await current.page.goto(origin, { waitUntil: 'domcontentloaded' });
      await listVisible(current.page);
      run.startup.pageToListMs.push(performance.now() - start);
      await composerUsable(current.page);
      run.startup.pageToComposerMs.push(performance.now() - start);
    }
    await expandList(current.page);
    run.memory.afterStartup = await checkpoint('startup');
    const listed = async () => new Set((await current.page.locator('.an-chat-history-row__button:visible').allInnerTexts()).map(t => t.split('\n')[0].trim()));
    // Code first: opening a Native thread bumps its updatedAt, which would push Code runs out of the
    // bounded sidebar list before the Code loop could reach them.
    for (const runtime of ['code', 'native']) {
      phase = runtime;
      // Switch among conversations a person can see in the expanded sidebar (it lists a bounded
      // number of rows). Leave through the shortest listed conversation of the other runtime, so
      // the untimed hop neither dominates the run nor keeps another long history in memory.
      const visible = await listed();
      const leave = (runtime === 'code' ? fixture.native : fixture.code).filter(item => visible.has(item.title))
        .sort((a, b) => a.count - b.count)[0];
      assert.ok(leave, `No listed ${runtime === 'code' ? 'Native' : 'Code'} conversation to leave through`);
      const pool = (runtime === 'code' ? fixture.code : [...fixture.native].reverse())
        .filter(item => visible.has(item.title) && item.title !== leave.title).slice(0, 15);
      if (pool.length < 3) throw new Error(`Only ${pool.length} ${runtime} conversations are listed`);
      const cold = [], warm = [];
      for (let i = 0; i < samples; i++) {
        if (i && i % pool.length === 0) {
          await current.context.close(); current = await openPage(browser, origin, cookie, fixture);
          await current.page.goto(origin, { waitUntil: 'domcontentloaded' }); await listVisible(current.page); await expandList(current.page);
        }
        const item = pool[i % pool.length];
        let ms = await clickConversation(current.page, item);
        cold.push({ ms, target: item.id, count: item.count }); await checkpoint(`${runtime}-cold`, item.id, ms);
        // Leave before the revisit. Another runtime avoids accidentally warming the next cold target.
        await clickConversation(current.page, leave);
        ms = await clickConversation(current.page, item);
        warm.push({ ms, target: item.id, count: item.count }); await checkpoint(`${runtime}-warm`, item.id, ms);
      }
      run.scenarios[`${runtime}ColdMs`] = scenario(cold); run.scenarios[`${runtime}WarmMs`] = scenario(warm);
      run.memory[`after${runtime === 'code' ? 'Code' : 'Native'}`] = await checkpoint(`after-${runtime}`);
    }
    phase = 'search';
    const results = [];
    for (let i = 0; i < samples; i++) {
      // Alternate runtimes and spread targets across the whole history, newest to oldest.
      const list = i % 2 ? fixture.native : fixture.code, slots = Math.ceil(samples / 2);
      const item = list[Math.min(list.length - 1, Math.floor(((i >> 1) + 0.5) * list.length / slots))];
      results.push({ target: item.id, ...await searchFor(current.page, item) });
    }
    const found = results.filter(result => result.found);
    run.scenarios.searchFirstMs = { ...stats(found.map(result => result.firstMs)), targets: found.map(result => result.target) };
    run.scenarios.searchSettledMs = stats(found.map(result => result.settledMs));
    run.search = { notFoundWithinClicks: MAX_MORE_CLICKS, notFound: results.filter(result => !result.found).map(result => result.target),
      samples: results.map(({ target, found, moreClicks, hits, firstMs }) => ({ target, found, moreClicks, hits, ms: firstMs })) };
    // Idle on the longest Code run: its one-second polls are the steady-state cost.
    phase = 'idle';
    await clickConversation(current.page, fixture.code[1]);
    await current.cdp.send('Network.enable');
    // Include bytes transferred (CDP encodedDataLength), not inflated JSON string lengths.
    let requests = 0, bytes = 0;
    current.cdp.on('Network.requestWillBeSent', () => requests++);
    current.cdp.on('Network.loadingFinished', event => { bytes += event.encodedDataLength; });
    const idleStart = Date.now(); await sleep(30_000);
    await current.cdp.send('Network.disable');
    const idleMetrics = metrics(server.output()).filter(entry => entry.at >= idleStart);
    assert.ok(idleMetrics.length >= 25, 'Missing server perf diagnostics; build the perf plugin into the baseline too');
    run.idle = { seconds: 30, requests, bytes, projectedRequestsPerMinute: requests * 2, projectedBytesPerMinute: bytes * 2,
      eventLoopMs: { perSecondP50: stats(idleMetrics.map(entry => entry.eventLoopMs.p50)),
        perSecondP90: stats(idleMetrics.map(entry => entry.eventLoopMs.p90)), max: Math.max(...idleMetrics.map(entry => entry.eventLoopMs.max)) },
      serverRssBytes: idleMetrics.at(-1).rssBytes };
    // Memory journey last, so a renderer crash here cannot hide the other results: 30 switches
    // between the longest Native thread and a long Code run, sampling memory after each one.
    phase = 'journey';
    const journey = [];
    for (let i = 0; i < 30; i++) {
      const item = i % 2 ? fixture.code[1] : fixture.native.at(-1);
      const ms = await clickConversation(current.page, item);
      journey.push({ ms, target: item.id, count: item.count }); await checkpoint('journey', item.id, ms);
    }
    run.scenarios.journeyMs = scenario(journey);
    run.memory.afterJourney = lastMemory;
    run.memory.serverRssBytes = metrics(server.output()).at(-1)?.rssBytes ?? null;
    run.status = 'complete';
  } catch (error) {
    // A crashed renderer is a measured outcome; record where it happened and keep the other runs.
    if (!run || !(current?.crashed || /Target crashed/.test(String(error?.message)))) {
      if (run) Object.assign(run, { status: 'failed', failure: { phase, message: String(error?.message ?? error).split('\n')[0] } });
      throw error;
    }
    run.status = 'crashed';
    run.crash = { phase, message: String(error?.message ?? error).split('\n')[0], lastMemory };
  } finally {
    if (run) { report.runs.push(run); await saveReport(); }
    await current?.context.close().catch(() => {}); await browser?.close(); await server?.stop();
    await rm(data, { recursive: true, force: true });
  }
}
const mib = bytes => bytes == null ? 'n/a' : `${(bytes / 2 ** 20).toFixed(0)} MiB`;
async function saveReport() {
  const c = report.conditions;
  const lines = ['# Vivary responsiveness', '',
    `Commit ${c.commit}; dirty ${c.dirty} (${c.dirtyHash.slice(0, 12)}); harness ${c.harnessSha256.slice(0, 12)}; build ${c.build.hash.slice(0, 12)}. Node ${c.node}; Chrome ${c.chrome}; ${c.cpuCount} x ${c.cpu}.`,
    '', 'Milliseconds. Each cell lists the per-run median; the range is the spread of those medians (between-run noise).', '',
    '| Size | Scenario | n per run | Per-run p50 | Per-run p90 | Median spread (min–max) |', '| --- | --- | --- | --- | --- | --- |'];
  for (const size of sizes) {
    const runs = report.runs.filter(run => run.size === size && run.status === 'complete');
    for (const run of report.runs.filter(run => run.size === size && run.status !== 'complete'))
      lines.push(`| ${size} | run ${run.repeat} ${run.status} | | ${run.crash ? `${run.crash.phase}: ${run.crash.message}` : run.failure ? `${run.failure.phase}: ${run.failure.message}` : ''} | | |`);
    if (!runs.length) continue;
    const row = (name, per) => {
      if (per.some(entry => !entry.n)) return lines.push(`| ${size} | ${name} | ${per.map(entry => entry.n).join(', ')} | n/a | n/a | n/a |`);
      const p50 = per.map(entry => entry.p50), p90 = per.map(entry => entry.p90);
      lines.push(`| ${size} | ${name} | ${per[0].n} | ${p50.map(v => v.toFixed(0)).join(', ')} | ${p90.map(v => v.toFixed(0)).join(', ')} | ${Math.min(...p50).toFixed(0)}–${Math.max(...p50).toFixed(0)} |`);
    };
    row('serverReadyMs', runs.map(run => stats([run.startup.serverReadyMs])));
    row('pageToListMs', runs.map(run => stats(run.startup.pageToListMs)));
    row('pageToComposerMs', runs.map(run => stats(run.startup.pageToComposerMs)));
    for (const key of Object.keys(runs[0].scenarios)) {
      row(key, runs.map(run => run.scenarios[key]));
      if (runs[0].scenarios[key].longest) {
        row(`${key} (${runs[0].scenarios[key].longest.messages}-entry)`, runs.map(run => run.scenarios[key].longest));
        row(`${key} (others)`, runs.map(run => run.scenarios[key].others));
      }
    }
    lines.push('', ...runs.map(run => `${size} run ${run.repeat}: search not found within ${run.search.notFoundWithinClicks} more-clicks: ${run.search.notFound.length}/${run.search.samples.length}; idle 30s ${run.idle.requests} requests / ${run.idle.bytes} wire bytes; loop delay p90 median ${run.idle.eventLoopMs.perSecondP90.p50.toFixed(1)}ms, max ${run.idle.eventLoopMs.max.toFixed(1)}ms; server RSS ${mib(run.memory.serverRssBytes)}; after journey JS heap ${mib(run.memory.afterJourney?.jsHeapUsedBytes)}, renderer RSS ${mib(run.memory.afterJourney?.rendererRssBytes)}, DOM nodes ${run.memory.afterJourney?.domNodes}.`), '');
  }
  const target = path.resolve(values.output); await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
  await writeFile(target.replace(/\.json$/, '') + '.md', lines.join('\n') + '\n');
}
await mkdir(path.dirname(tracePath), { recursive: true });
for (const size of sizes) for (let repeat = 1; repeat <= repeats; repeat++) await measure(size, repeat);
console.log(`Wrote ${path.resolve(values.output)}, markdown summary and ${tracePath}`);
