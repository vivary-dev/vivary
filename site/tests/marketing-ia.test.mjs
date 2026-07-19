import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
const roadmap = readFileSync(new URL('../src/pages/roadmap.astro', import.meta.url), 'utf8');
const astroConfig = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
const syncScript = readFileSync(new URL('../scripts/sync-docs.mjs', import.meta.url), 'utf8');
const whitePaper = readFileSync(new URL('../../docs/WHITE-PAPER.md', import.meta.url), 'utf8');

test('FAQ is a concise homepage section rather than a docs route', () => {
  assert.match(homepage, /<section class="faq band" id="faq"/);
  assert.match(homepage, /<details>/);
  assert.match(homepage, /href="#faq"/);
  assert.doesNotMatch(homepage, /href="\/faq\/"/);
  assert.doesNotMatch(astroConfig, /slug:\s*'faq'/);
  assert.doesNotMatch(syncScript, /\['FAQ',\s*'faq'/);
});

test('roadmap is a first-class marketing page rather than a guide', () => {
  assert.match(homepage, /href="\/roadmap\/"/);
  assert.match(roadmap, /<title>Vivary roadmap/);
  assert.match(roadmap, /aria-current="page"/);
  assert.match(astroConfig, /label:\s*'Roadmap',\s*link:\s*'\/roadmap\/'/);
  assert.doesNotMatch(astroConfig, /slug:\s*'product-roadmap'/);
  assert.doesNotMatch(syncScript, /\['PRODUCT-ROADMAP',\s*'product-roadmap'/);
  assert.equal(existsSync(new URL('../../docs/PRODUCT-ROADMAP.md', import.meta.url)), true);
});

test('internal brand and content planning are not generated as public docs', () => {
  assert.doesNotMatch(astroConfig, /slug:\s*'(?:brand|content-roadmap)'/);
  assert.doesNotMatch(syncScript, /\['BRAND',\s*'brand'/);
  assert.doesNotMatch(syncScript, /\['CONTENT-ROADMAP',\s*'content-roadmap'/);
  assert.doesNotMatch(homepage, /\/brand\//);
  assert.doesNotMatch(roadmap, /\/brand\//);
  assert.equal(existsSync(new URL('../../docs/CONTENT-ROADMAP.md', import.meta.url)), true);
  assert.equal(existsSync(new URL('../../docs/FAQ.md', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../docs/BRAND.md', import.meta.url)), false);
});

test('white paper has the structure and evidence boundaries of a full technical paper', () => {
  const requiredSections = [
    '## Abstract',
    '## Executive summary',
    '## 1. Problem statement',
    '## 2. Scope, terminology, and assumptions',
    '## 3. Design requirements',
    '## 4. System model and invariants',
    '## 5. Architecture',
    '## 6. Operating protocol',
    '## 7. Security, privacy, and human authority',
    '## 8. Adoption model',
    '## 9. Claims and evidence status',
    '## 10. Evaluation protocol',
    '## 11. Related work',
    '## 12. Limitations and failure modes',
    '## 13. Governance and evolution',
    '## Conclusion',
    '## References',
  ];

  for (const heading of requiredSections) assert.match(whitePaper, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(whitePaper.trim().split(/\s+/).length >= 4500, 'white paper should contain at least 4,500 words');
  assert.match(whitePaper, /Implemented and verified/);
  assert.match(whitePaper, /Proposed or not yet measured/);
  assert.match(whitePaper, /Threats to validity/);
  assert.match(whitePaper, /NIST\.AI\.600-1/);
  assert.match(whitePaper, /arxiv\.org\/abs\/2307\.03172/);
});

test('generated docs edit their canonical repo sources rather than generated copies', () => {
  assert.match(syncScript, /edit\/dev\/docs\/\$\{src\}\.md/);
  assert.match(syncScript, /edit\/dev\/CHANGELOG\.md/);
});
