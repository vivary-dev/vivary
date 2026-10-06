import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';

const workbench = fileURLToPath(new URL('../../', import.meta.url));
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, 'node_modules/@agent-native/core'); // guard:allow-env-credential - Disposable patched-Core test path, not a credential.
const source = await readFile(path.join(core, 'dist/client/chat/message-components.js'), 'utf8');
const start = source.indexOf('export function observeUserMessageExpandability(');
assert.ok(start >= 0, 'the installed Core includes the maintained observation helper');
const helper = source.slice(start, source.indexOf('\n}\n', start) + 3).replace('export function ', 'function ');

function runtime() {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
    // Deliberately allow queued deliveries after disconnect to test the guard.
    deliver(height, target = this.element) { this.callback([{ target, contentRect: { height } }]); }
  }
  const observe = compileFunction(`${helper}\nreturn observeUserMessageExpandability;`, ['ResizeObserver'])(FakeResizeObserver);
  let reads = 0;
  const element = Object.defineProperties({}, Object.fromEntries([
    'scrollHeight', 'clientHeight', 'offsetHeight', 'getBoundingClientRect',
  ].map(name => [name, { get() { reads++; throw new Error(`unexpected layout read: ${name}`); } }])));
  return { observe, observers, element, reads: () => reads };
}

test('subscription waits for delivery and never reads layout', () => {
  const run = runtime(), decisions = [];
  const disconnect = run.observe(run.element, value => decisions.push(value));
  assert.equal(run.observers[0].element, run.element);
  assert.equal(run.reads(), 0);
  assert.deepEqual(decisions, [], 'no measurement is invented for skipped off-screen content');
  run.observers[0].deliver(201);
  assert.deepEqual(decisions, [true], 'the first laid-out long message is expandable');
  assert.equal(run.reads(), 0, 'the delivery uses supplied geometry, too');
  disconnect();
});

test('each matching delivery re-evaluates the strict 200 px threshold', () => {
  const run = runtime(), decisions = [];
  const disconnect = run.observe(run.element, value => decisions.push(value));
  for (const height of [0, 199, 200, 201, 600, 200, 80, 300]) run.observers[0].deliver(height);
  run.observers[0].deliver(999, {});
  assert.deepEqual(decisions, [false, false, false, true, true, false, false, true]);
  assert.equal(run.reads(), 0);
  disconnect();
});

test('disconnect prevents even a queued delivery from updating state', () => {
  const run = runtime(), decisions = [];
  const disconnect = run.observe(run.element, value => decisions.push(value));
  run.observers[0].deliver(600);
  disconnect();
  assert.equal(run.observers[0].disconnected, true);
  run.observers[0].deliver(80);
  assert.deepEqual(decisions, [true]);
  let retire;
  retire = run.observe(run.element, value => { decisions.push(value); retire(); });
  run.observers[1].callback([
    { target: run.element, contentRect: { height: 80 } },
    { target: run.element, contentRect: { height: 600 } },
  ]);
  assert.deepEqual(decisions, [true, false], 'disconnect also stops the remainder of a delivery');
});
