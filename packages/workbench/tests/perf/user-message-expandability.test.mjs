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
const user = source.slice(source.indexOf('export function UserMessage()'), source.indexOf('// ─── AssistantMessage'));
const effectStart = user.indexOf('    useEffect(() => {');
const effectEnd = user.indexOf('\n    if (hidden)', effectStart);
assert.ok(effectStart >= 0 && effectEnd > effectStart);
const effect = compileFunction(user.slice(effectStart, effectEnd), [
  'useEffect', 'contentRef', 'hasDisplayableText', 'isEditing', 'setIsExpandable', 'observeUserMessageExpandability',
]);

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

test('the UserMessage effect resets and reconnects for text and editing changes', () => {
  const run = runtime(), decisions = [];
  function mount(hasText, editing, element = run.element) {
    let cleanup;
    effect((callback, dependencies) => {
      assert.deepEqual(dependencies, [hasText, editing]);
      cleanup = callback();
    }, { current: element }, hasText, editing, value => decisions.push(value), run.observe);
    return cleanup;
  }
  const firstCleanup = mount(true, false);
  assert.deepEqual(decisions, [null]);
  run.observers[0].deliver(600);
  firstCleanup();
  assert.equal(mount(false, false), undefined);
  assert.equal(mount(true, true), undefined);
  assert.equal(mount(true, false, null), undefined);
  assert.equal(run.observers.length, 1, 'no observer for absent, hidden or edited text');
  const nextCleanup = mount(true, false);
  run.observers[0].deliver(600);
  assert.equal(decisions.at(-1), null, 'a retired element cannot replace the new unmeasured state');
  run.observers[1].deliver(80);
  assert.equal(decisions.at(-1), false, 'the replacement text decides from its own delivery');
  assert.equal(run.reads(), 0, 'the actual effect never reads layout');
  nextCleanup();
});

test('UserMessage observes unclipped text and caps it while unmeasured', () => {
  assert.match(user, /const \[isExpandable, setIsExpandable\] = useState\(null\)/);
  assert.match(user, /className: cn\("whitespace-pre-wrap break-words", !expanded && isExpandable !== false && "max-h-\[200px\] overflow-hidden"\), children: _jsx\("div", \{ ref: contentRef, children: _jsx\(MessagePrimitive\.Parts/);
  assert.match(user, /hasDisplayableText && isExpandable && \(_jsxs\("button"/);
  assert.doesNotMatch(user, /scrollHeight|clientHeight|offsetHeight|getBoundingClientRect/);
});
