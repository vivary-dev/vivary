import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
const roadmap = readFileSync(new URL('../src/pages/roadmap.astro', import.meta.url), 'utf8');
const astroConfig = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
const syncScript = readFileSync(new URL('../scripts/sync-docs.mjs', import.meta.url), 'utf8');
const whitePaper = readFileSync(new URL('../../docs/WHITE-PAPER.md', import.meta.url), 'utf8');
const guideIndex = readFileSync(new URL('../../docs/LEARN-BY-DOING.md', import.meta.url), 'utf8');
const guideSources = [
  'create-workspace',
  'connect-agent',
  'get-context',
  'write-record',
  'adopt-project',
  'verify-recover',
].map((slug) => ({
  slug,
  source: readFileSync(new URL(`../../docs/guides/${slug}.md`, import.meta.url), 'utf8'),
}));

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

test('guide and release docs are canonical-generated routes with deliberate navigation', () => {
  const canonicalRoutes = [
    ['LEARN-BY-DOING', 'learn-by-doing', 'Guide library'],
    ['MIGRATION-STATUS', 'migration-status', 'Migration status'],
    ['DECISIONS', 'decisions', 'Decisions'],
  ];

  for (const [source, slug, label] of canonicalRoutes) {
    assert.match(syncScript, new RegExp(`\\['${source}',\\s*'${slug}'`));
    assert.equal(
      existsSync(new URL(`../../docs/${source}.md`, import.meta.url)),
      true,
      `docs/${source}.md must remain the canonical source for /${slug}/`,
    );
    assert.match(astroConfig, new RegExp(`label:\\s*'${label}',\\s*slug:\\s*'${slug}'`));
  }

  for (const { slug } of guideSources) {
    assert.match(syncScript, new RegExp(`\\['guides/${slug}',\\s*'guides/${slug}'`));
    assert.match(astroConfig, new RegExp(`slug:\\s*'guides/${slug}'`));
  }

  assert.match(syncScript, /const coreDocsList = pages/);
  assert.match(syncScript, /for \(const \[src, slug, title\] of pages\)/);
  assert.match(syncScript, /replaceAll\('\]\(LEARN-BY-DOING\.md\)', '\]\(\/learn-by-doing\/\)'\)/);
  assert.match(syncScript, /replaceAll\('\]\(MIGRATION-STATUS\.md\)', '\]\(\/migration-status\/\)'\)/);
  assert.match(syncScript, /replaceAll\('\]\(DECISIONS\.md\)', '\]\(\/decisions\/\)'\)/);
});

test('public and agent guides share one concise STE100 style source', () => {
  assert.match(guideIndex, /The guides use STE100 style\./);
  assert.doesNotMatch(guideIndex, /inspired/i);
  assert.match(guideIndex, /Humans and agents use the same canonical guide\./);

  for (const { slug, source } of guideSources) {
    assert.match(source, /^# /);
    assert.match(source, /## Result/);
    assert.match(source, /## Agent contract/);
    assert.doesNotMatch(source, /inspired/i, `${slug} must use the STE100 style label`);
  }
});

test('guide prose keeps the STE100 procedure sentence limit', () => {
  const files = [
    { slug: 'guide-library', source: guideIndex },
    ...guideSources,
  ];

  for (const { slug, source } of files) {
    const prose = source.replace(/```[\s\S]*?```/g, '');
    const lines = prose.split(/\r?\n/);

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) return;

      const plain = trimmed
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_]/g, '');

      for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
        const words = sentence.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
        assert.ok(
          words.length <= 20,
          `${slug}:${index + 1} has ${words.length} words: ${sentence}`,
        );
      }
    });
  }
});


test('generated docs edit their canonical repo sources rather than generated copies', () => {
  assert.match(syncScript, /edit\/dev\/docs\/\$\{src\}\.md/);
  assert.match(syncScript, /edit\/dev\/CHANGELOG\.md/);
  assert.match(syncScript, /readCanonicalMarkdown\(docsDir, `\$\{src\}\.md`, `docs\/\$\{src\}\.md`\)/);
  assert.match(syncScript, /const output = path\.join\(outDir, `\$\{slug\}\.md`\)/);
  assert.match(syncScript, /fs\.writeFileSync\(output, render\(raw, title, desc, editUrl\)\)/);
  assert.doesNotMatch(syncScript, /readCanonicalMarkdown\(outDir,/);
});
