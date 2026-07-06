import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
const inlineScript = page.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1] || '';

test('support modal exposes copy, mailto, and issue fallbacks', () => {
  assert.match(page, /const supportEmail = 'support@vivary\.dev'/);
  assert.match(page, /data-support-modal/);
  assert.match(page, /data-support-email/);
  assert.match(page, /data-copy-support/);
  assert.match(page, /supportMailto = `mailto:/);
  assert.match(page, /template=bug\.yml/);
  assert.match(page, /labels=bug/);
  assert.match(page, /window\.addEventListener\('error'/);
  assert.match(page, /window\.addEventListener\('unhandledrejection'/);
  assert.match(page, /local page omitted/);
  assert.match(page, /local source omitted/);
  assert.match(page, /local path omitted/);
  assert.match(page, /network path omitted/);
  assert.match(page, /setAttribute\('inert'/);
});

test('support modal remains static-site only', () => {
  assert.doesNotMatch(page, /sendgrid|resend|smtp/i);
  assert.doesNotMatch(page, /fetch\s*\(|XMLHttpRequest/i);
});

test('support modal sanitizes every auto-generated report detail', () => {
  assert.match(inlineScript, /const buildProblemReport = \([\s\S]*safeDetail\(detail\)/);
  assert.match(inlineScript, /window\.addEventListener\('error'[\s\S]*buildProblemReport/);
  assert.match(inlineScript, /window\.addEventListener\('unhandledrejection'[\s\S]*buildProblemReport/);
  assert.doesNotMatch(inlineScript, /Detail:',\s*detail\s*\|\|/);
});
