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
  ['GETTING-STARTED', 'getting-started', 'Getting started', 'Install Vivary and run your first agent workspace.'],
  ['COMMANDS', 'commands', 'Command reference', 'Every CLI across the four layers: tropo, ozone, exo, create-vivary.'],
  ['SKILLS', 'skills', 'Agent skills', 'The strato, tropo, and loops skills that operate a Vivary workspace.'],
  ['HOWTO', 'howto', 'How-to recipes', 'Task recipes: add a type, see blast radius, review, CI, multi-agent.'],
  ['FAQ', 'faq', 'FAQ', 'Common questions about Vivary.'],
  ['ARCHITECTURE', 'architecture', 'Architecture', 'The four-layer model and the principles behind Vivary.'],
  ['OBSIDIAN', 'obsidian', 'Obsidian (optional)', 'Optional Obsidian setup for fans, never required.'],
];

// rewrite relative repo-doc links to site routes; off-site files to GitHub blobs
const rewrite = (s) =>
  s.replaceAll('](GETTING-STARTED.md)', '](/getting-started/)')
   .replaceAll('](COMMANDS.md)', '](/commands/)')
   .replaceAll('](SKILLS.md)', '](/skills/)')
   .replaceAll('](HOWTO.md)', '](/howto/)')
   .replaceAll('](FAQ.md)', '](/faq/)')
   .replaceAll('](ARCHITECTURE.md)', '](/architecture/)')
   .replaceAll('](OBSIDIAN.md)', '](/obsidian/)')
   .replaceAll('](README.md)', '](/)')
   .replaceAll('](../packages/tropo/SPEC.md)', `](${GH}/packages/tropo/SPEC.md)`)
   .replaceAll('](../HANDOFF.md)', `](${GH}/HANDOFF.md)`);

fs.mkdirSync(outDir, { recursive: true });
for (const [src, slug, title, desc] of pages) {
  const raw = fs.readFileSync(path.join(docsDir, `${src}.md`), 'utf8');
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('# ')) lines.shift(); // Starlight renders the frontmatter title
  const body = rewrite(lines.join('\n')).replace(/^\n+/, '');
  // JSON.stringify gives a valid double-quoted YAML scalar (handles ':' etc.)
  const fm = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(desc)}\n---\n\n`;
  fs.writeFileSync(path.join(outDir, `${slug}.md`), fm + body);
  console.log(`  synced docs/${src}.md -> ${slug}.md`);
}
console.log('site docs synced from docs/.');
