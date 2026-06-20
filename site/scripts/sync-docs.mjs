// Generate the Starlight doc pages from the repo's canonical docs/ — docs/ is the
// single source of truth, the site is built from it. Runs automatically via the
// `predev` / `prebuild` hooks, so a deploy is never stale. To run by hand:
//   cd site && npm run sync-docs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, '..', '..', 'docs');
const outDir = path.resolve(here, '..', 'src', 'content', 'docs');
const GH = 'https://github.com/vivary-dev/vivary/blob/dev';

// canonical doc -> [route slug, page title, meta description]
const pages = [
  ['CONCEPTS', 'concepts', 'What is Vivary?', 'Plain-language intro: what Vivary is, the core ideas, and a glossary. Start here.'],
  ['GETTING-STARTED', 'getting-started', 'Getting started', 'Install Vivary and run your first agent workspace.'],
  ['COMMANDS', 'commands', 'Command reference', 'Every CLI across the four layers: tropo, ozone, exo, create-vivary.'],
  ['SKILLS', 'skills', 'Agent skills', 'The strato, tropo, and loops skills that operate a Vivary workspace.'],
  ['ACTIVE-CONTEXT', 'active-context', 'Active context', 'Optional CocoIndex-code sidecar guidance for semantic code retrieval.'],
  ['HOWTO', 'howto', 'How-to recipes', 'Task recipes: add a type, see blast radius, review, CI, multi-agent.'],
  ['FAQ', 'faq', 'FAQ', 'Common questions about Vivary.'],
  ['ARCHITECTURE', 'architecture', 'Architecture', 'The four-layer model and the principles behind Vivary.'],
  ['OBSIDIAN', 'obsidian', 'Obsidian (optional)', 'Optional Obsidian setup for fans, never required.'],
];

// rewrite relative repo-doc links to site routes; off-site files to GitHub blobs
const rewrite = (s) =>
  s.replaceAll('](CONCEPTS.md)', '](/concepts/)')
   .replaceAll('](GETTING-STARTED.md)', '](/getting-started/)')
   .replaceAll('](COMMANDS.md)', '](/commands/)')
   .replaceAll('](SKILLS.md)', '](/skills/)')
   .replaceAll('](ACTIVE-CONTEXT.md)', '](/active-context/)')
   .replaceAll('](HOWTO.md)', '](/howto/)')
   .replaceAll('](FAQ.md)', '](/faq/)')
   .replaceAll('](ARCHITECTURE.md)', '](/architecture/)')
   .replaceAll('](OBSIDIAN.md)', '](/obsidian/)')
   .replaceAll('](README.md)', '](/)')
   .replaceAll('](../packages/tropo/SPEC.md)', `](${GH}/packages/tropo/SPEC.md)`)
   .replaceAll('](../HANDOFF.md)', `](${GH}/HANDOFF.md)`);

// Render a canonical Markdown doc into a Starlight content page: drop the leading H1
// (Starlight renders the frontmatter title), rewrite links, prepend frontmatter.
// JSON.stringify gives a valid double-quoted YAML scalar (handles ':' etc.)
const render = (raw, title, desc) => {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('# ')) lines.shift();
  const body = rewrite(lines.join('\n')).replace(/^\n+/, '');
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}`;
};

fs.mkdirSync(outDir, { recursive: true });
for (const [src, slug, title, desc] of pages) {
  const raw = fs.readFileSync(path.join(docsDir, `${src}.md`), 'utf8');
  fs.writeFileSync(path.join(outDir, `${slug}.md`), render(raw, title, desc));
  console.log(`  synced docs/${src}.md -> ${slug}.md`);
}

// The changelog is canonical at the repo root (CHANGELOG.md), not under docs/. Surface
// it as a site page so it refreshes on every build whenever CHANGELOG.md is updated.
const changelog = fs.readFileSync(path.resolve(here, '..', '..', 'CHANGELOG.md'), 'utf8');
fs.writeFileSync(
  path.join(outDir, 'changelog.md'),
  render(changelog, 'Changelog', 'Release history for the Vivary packages.'),
);
console.log('  synced CHANGELOG.md -> changelog.md');

console.log('site docs synced from docs/ (+ CHANGELOG.md).');
