import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import test from 'node:test';

const workbench = fileURLToPath(new URL('../../', import.meta.url));
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, 'node_modules/@agent-native/core'); // guard:allow-env-credential - Disposable patched-Core test path, not a credential.
const client = path.join(core, 'dist/client');
const [cacheSource, messageSource, i18nSource] = await Promise.all([
  readFile(path.join(client, 'date-time-format.js'), 'utf8'),
  readFile(path.join(client, 'chat/message-components.js'), 'utf8'),
  readFile(path.join(client, 'i18n.js'), 'utf8'),
]);

// Execute the production functions without mounting the browser-only chat module.
// Reading the installed helper also makes a missing dependency patch fail CI.
const timestampSource = messageSource.slice(messageSource.indexOf('function coerceMessageDate'), messageSource.indexOf('export function MessageTimestamp('));
const formattersSource = i18nSource.slice(i18nSource.indexOf('export function useFormatters()'), i18nSource.indexOf('export function LanguagePicker('));
const now = new Date(2026, 9, 5, 12, 34, 56);
const FixedDate = new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [now.getTime()]) });
const days = [now, new Date(2026, 9, 4, 9, 8), new Date(2026, 2, 12, 9, 8), new Date(2023, 2, 12, 9, 8)];

function runtime() {
  let constructions = 0;
  const CountingIntl = { DateTimeFormat: new Proxy(Intl.DateTimeFormat, {
    construct(target, args) { constructions++; return Reflect.construct(target, args); },
  }) };
  const cache = compileFunction(cacheSource.replace('export function ', 'function ') + '\nreturn { getDateTimeFormatter, size: () => dateTimeFormatters.size };', ['Intl'])(CountingIntl);
  const timestamp = compileFunction(timestampSource.replace('export function ', 'function ') + '\nreturn formatMessageTimestamp;', ['Date', 'Intl', 'getDateTimeFormatter'])(FixedDate, CountingIntl, cache.getDateTimeFormatter);
  let currentLocale;
  const useFormatters = compileFunction(formattersSource.replace('export function ', 'function ') + '\nreturn useFormatters;', ['useContext', 'useMemo', 'LocaleContext', 'DEFAULT_LOCALE', 'getDateTimeFormatter', 'Intl'])(
    () => ({ locale: currentLocale }), factory => factory(), {}, 'en-US', cache.getDateTimeFormatter, CountingIntl);
  return { timestamp, cache, constructions: () => constructions,
    formatters(locale) { currentLocale = locale; return useFormatters(); } };
}

// Core 0.176.5's original formatting logic, with a fixed "now" for calendar cases.
// The original constructor remains separate from the counting production proxy.
function originalTimestamp(value, locale, yesterdayLabel = 'Yesterday') {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const sameDay = other => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  let short;
  if (sameDay(now)) short = time;
  else if (sameDay(yesterday)) short = `${yesterdayLabel} ${time}`;
  else if (date.getFullYear() === now.getFullYear()) short = `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)}, ${time}`;
  else short = `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)}, ${time}`;
  return { short, full: new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) };
}

test('message timestamps and locale formatDate retain the original output', () => {
  const run = runtime();
  for (const [locale, label] of [['en-US', 'Yesterday'], ['fr-FR', 'Hier']]) {
    for (const date of days) {
      for (const value of [date, date.toISOString(), date.getTime()]) {
        assert.deepEqual(run.timestamp(value, locale, label), originalTimestamp(value, locale, label));
        assert.deepEqual(run.timestamp(value, locale), originalTimestamp(value, locale));
        for (const options of [undefined, { hour: 'numeric', minute: '2-digit' }, { dateStyle: 'full', timeZone: 'UTC' }]) {
          assert.equal(run.formatters(locale).formatDate(value, options), new Intl.DateTimeFormat(locale, options).format(new Date(value)));
        }
      }
    }
    for (const value of [null, undefined, {}, 'bad date', NaN, new Date(NaN)]) assert.equal(run.timestamp(value, locale, label), null);
  }
  assert.deepEqual(run.timestamp(days[0]), originalTimestamp(days[0]));
});

test('2,000 timestamps share eight formatters and resolve the default zone once per rendering batch', async () => {
  const run = runtime();
  const expectedTimes = new Map(['en-US', 'fr-FR'].map(locale => [locale, days.map(date => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date))]));
  for (let pass = 0; pass < 2; pass++) {
    await Promise.resolve();
    for (let i = 0; i < 2000; i++) {
      const locale = i % 2 ? 'fr-FR' : 'en-US', day = Math.floor(i / 2) % days.length, date = days[day];
      assert.ok(run.timestamp(date, locale).short);
      // Reordered, freshly allocated options must share the message time formatter.
      assert.equal(run.formatters(locale).formatDate(date, { minute: '2-digit', hour: 'numeric' }), expectedTimes.get(locale)[day]);
    }
  }
  assert.equal(run.constructions(), 10, 'eight shared formatters plus one timezone resolver per batch');
  assert.equal(run.cache.size(), 8);
});

test('formatter retention is bounded and evicted entries are recreated correctly', () => {
  const run = runtime(), zones = Intl.supportedValuesOf('timeZone').slice(0, 100);
  assert.equal(zones.length, 100);
  for (const timeZone of zones) {
    const options = { timeZone, hour: 'numeric' };
    assert.equal(run.formatters('en-US').formatDate(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
    assert.ok(run.cache.size() <= 64);
  }
  assert.equal(run.cache.size(), 64);
  const before = run.constructions(), options = { timeZone: zones[0], hour: 'numeric' };
  assert.equal(run.formatters('en-US').formatDate(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
  assert.equal(run.constructions(), before + 1);
  assert.equal(run.cache.size(), 64);
});

test('exotic options keep Intl coercion and validation instead of unsafe cached results', () => {
  const run = runtime(), format = run.formatters('en-US').formatDate;
  for (const options of [Object.create({ year: 'numeric' }), Object.defineProperty({}, 'month', { value: 'long' })]) {
    assert.equal(format(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
  }
  let month = 'long';
  const options = { get month() { return month; } };
  assert.equal(format(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
  month = 'numeric';
  assert.equal(format(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
  assert.throws(() => format(now, null), TypeError);
  assert.throws(() => format(now, { timeZone: 'invalid' }), RangeError);
  assert.equal(run.cache.getDateTimeFormatter(['fr-FR', 'en-US'], { year: 'numeric' }).format(now), new Intl.DateTimeFormat(['fr-FR', 'en-US'], { year: 'numeric' }).format(now));
  for (const options of [Object.create(null), { minute: undefined }, { hour12: false, hour: 'numeric' }, { fractionalSecondDigits: 3, second: 'numeric' }]) {
    assert.equal(format(now, options), new Intl.DateTimeFormat('en-US', options).format(now));
  }
  let coercions = 0;
  const coercible = { month: { toString() { coercions++; return 'long'; } } };
  format(now, coercible);
  format(now, coercible);
  assert.equal(coercions, 2, 'object-valued options retain their live coercion');
  const before = run.constructions(), size = run.cache.size();
  for (let i = 0; i < 2; i++) assert.throws(() => format(now, { month: 'invalid' }), RangeError);
  assert.equal(run.constructions(), before + 2, 'failed constructors are never retained');
  assert.equal(run.cache.size(), size);
});

test('Yesterday resolves the current translation only when its label is displayed', () => {
  const run = runtime();
  let calls = 0, label = 'Hier';
  const translate = () => { calls++; return label; };
  for (const date of [days[0], days[2], days[3]]) assert.deepEqual(run.timestamp(date, 'fr-FR', translate), originalTimestamp(date, 'fr-FR', label));
  for (const value of [null, 'bad date', NaN, new Date(NaN)]) assert.equal(run.timestamp(value, 'fr-FR', translate), null);
  assert.equal(calls, 0);
  assert.deepEqual(run.timestamp(days[1], 'fr-FR', translate), originalTimestamp(days[1], 'fr-FR', label));
  label = 'Updated catalog label';
  assert.deepEqual(run.timestamp(days[1], 'fr-FR', translate), originalTimestamp(days[1], 'fr-FR', label));
  assert.equal(calls, 2, 'catalog changes are visible without a locale change');
});


test('default-zone formats follow a system timezone change on the next rendering task', async () => {
  const previous = process.env.TZ; // guard:allow-env-credential - Save the isolated test's timezone setting.
  const run = runtime();
  try {
    for (const zone of ['Etc/UTC', 'America/New_York', 'Australia/Sydney']) {
      // guard:allow-env-credential - Synthetic system timezone change; not a credential.
      process.env.TZ = zone; // guard:allow-env-mutation - Exercise a process-wide timezone change in this isolated test.
      await new Promise(setImmediate);
      const options = { dateStyle: 'full', timeStyle: 'long' };
      assert.equal(run.formatters('en-US').formatDate(now, options),
        new Intl.DateTimeFormat('en-US', options).format(now));
      assert.deepEqual(run.timestamp(days[0], 'en-US'), originalTimestamp(days[0], 'en-US'));
      const explicit = { ...options, timeZone: 'Europe/Paris' };
      assert.equal(run.formatters('en-US').formatDate(now, explicit),
        new Intl.DateTimeFormat('en-US', explicit).format(now), 'an explicit timezone remains authoritative');
    }
  } finally {
    // guard:allow-env-credential - Restore test timezone configuration.
    if (previous === undefined) delete process.env.TZ; // guard:allow-env-mutation - Restore the isolated test's timezone.
    // guard:allow-env-credential - Restore test timezone configuration.
    else process.env.TZ = previous; // guard:allow-env-mutation - Restore the isolated test's timezone.
  }
});
