// Generate the Starlight doc pages from the repo's canonical docs/ — docs/ is the
// single source of truth, the site is built from it. Runs automatically via the
// `predev` / `prebuild` hooks, so a deploy is never stale. To run by hand:
//   cd site && npm run sync-docs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const docsDir = path.join(repoRoot, 'docs');
const outDir = path.resolve(here, '..', 'src', 'content', 'docs');
const GH = 'https://github.com/vivary-dev/vivary/blob/dev';

const normalizeForCompare = (p) => {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

// canonical doc -> [route slug, page title, meta description]
const pages = [
  ['CONCEPTS', 'concepts', 'What is Vivary?', 'Plain-language intro: what Vivary is, the core ideas, and a glossary. Start here.'],
  ['GETTING-STARTED', 'getting-started', 'Getting started', 'Install Vivary and run your first agent workspace.'],
  ['COMMANDS', 'commands', 'Command reference', 'Every CLI across Vivary: tropo, ozone, exo, create-vivary, and optional adapters.'],
  ['SKILLS', 'skills', 'Agent skills', 'The strato, tropo, and loops skills that operate a Vivary workspace.'],
  ['ACTIVE-CONTEXT', 'active-context', 'Active context', 'Optional CocoIndex-code sidecar guidance for semantic code retrieval.'],
  ['LLM-ACTIVE-CONTEXT', 'llm-active-context', 'LLM active-context guide', 'Copyable agent instructions for graph-first CocoIndex-code retrieval.'],
  ['SEMANTIC-MEMORY', 'semantic-memory', 'Optional semantic memory', 'Architecture and adapter plan for optional semantic memory providers such as Cognee.'],
  ['PRODUCT-ROADMAP', 'product-roadmap', 'Product roadmap', 'High-leverage product backlog for context compression, maps, recall, and optional integrations.'],
  ['HOWTO', 'howto', 'How-to recipes', 'Task recipes: add a type, see blast radius, review, CI, multi-agent.'],
  ['SIGNALS', 'signals', 'Public signals', 'Public npm, PyPI, and GitHub metrics snapshots.'],
  ['RELEASE-WORKFLOW', 'release-workflow', 'Release workflow', 'End-of-update checklist for Vivary release truth, docs, publishing, and post copy.'],
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
   .replaceAll('](LLM-ACTIVE-CONTEXT.md)', '](/llm-active-context/)')
   .replaceAll('](SEMANTIC-MEMORY.md)', '](/semantic-memory/)')
   .replaceAll('](PRODUCT-ROADMAP.md)', '](/product-roadmap/)')
   .replaceAll('](HOWTO.md)', '](/howto/)')
   .replaceAll('](SIGNALS.md)', '](/signals/)')
   .replaceAll('](RELEASE-WORKFLOW.md)', '](/release-workflow/)')
   .replaceAll('](FAQ.md)', '](/faq/)')
   .replaceAll('](ARCHITECTURE.md)', '](/architecture/)')
   .replaceAll('](OBSIDIAN.md)', '](/obsidian/)')
   .replaceAll('](README.md)', '](/)')
   .replaceAll('](../stats/usage-snapshot.svg)', '](/usage-snapshot.svg)')
   .replaceAll('](../packages/tropo/SPEC.md)', `](${GH}/packages/tropo/SPEC.md)`)
   .replaceAll('](../HANDOFF.md)', `](${GH}/HANDOFF.md)`);

const assertRegularFileInside = (root, filePath, label) => {
  const rootReal = fs.realpathSync(root);
  const fileReal = fs.realpathSync(filePath);
  const rel = path.relative(rootReal, fileReal);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} resolves outside ${rootReal}: ${fileReal}`);
  }

  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
};

const assertRegularDirectory = (dirPath, label) => {
  const resolved = path.resolve(dirPath);
  const linkStat = fs.lstatSync(resolved);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${resolved}`);
  }

  const real = fs.realpathSync(resolved);
  if (normalizeForCompare(real) !== normalizeForCompare(resolved)) {
    throw new Error(`${label} must not resolve through a symlink: ${resolved} -> ${real}`);
  }
};

const readCanonicalMarkdown = (root, relativePath, label) => {
  const filePath = path.join(root, relativePath);
  assertRegularFileInside(root, filePath, label);
  return fs.readFileSync(filePath, 'utf8');
};

// Render a canonical Markdown doc into a Starlight content page: drop the leading H1
// (Starlight renders the frontmatter title), rewrite links, prepend frontmatter.
// JSON.stringify gives a valid double-quoted YAML scalar (handles ':' etc.)
const render = (raw, title, desc) => {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('# ')) lines.shift();
  const body = rewrite(lines.join('\n')).replace(/^[\r\n]+/, '');
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}`;
};

assertRegularDirectory(docsDir, 'docs/');

fs.mkdirSync(outDir, { recursive: true });
for (const [src, slug, title, desc] of pages) {
  const raw = readCanonicalMarkdown(docsDir, `${src}.md`, `docs/${src}.md`);
  fs.writeFileSync(path.join(outDir, `${slug}.md`), render(raw, title, desc));
  console.log(`  synced docs/${src}.md -> ${slug}.md`);
}

// The changelog is canonical at the repo root (CHANGELOG.md), not under docs/. Surface
// it as a site page so it refreshes on every build whenever CHANGELOG.md is updated.
const changelog = readCanonicalMarkdown(repoRoot, 'CHANGELOG.md', 'CHANGELOG.md');
fs.writeFileSync(
  path.join(outDir, 'changelog.md'),
  render(changelog, 'Changelog', 'Release history for the Vivary packages.'),
);
console.log('  synced CHANGELOG.md -> changelog.md');

console.log('site docs synced from docs/ (+ CHANGELOG.md).');

// --- Generate llms.txt & llms-full.txt ---

const readPythonVersion = (packagePath) => {
  const file = path.join(repoRoot, 'packages', packagePath, 'pyproject.toml');
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Could not find version in pyproject.toml for ${packagePath}`);
  return match[1];
};

const readNpmVersion = (packagePath) => {
  const file = path.join(repoRoot, 'packages', packagePath, 'package.json');
  const content = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(content);
  return pkg.version;
};

const createVivaryPyPI = readPythonVersion('create-vivary');
const createVivaryNpm = readNpmVersion('create-vivary/npm');
const tropoVersion = readPythonVersion('tropo');
const ozoneVersion = readPythonVersion('ozone');
const exoVersion = readPythonVersion('exo');
const cogneeVersion = readPythonVersion('memory-cognee');

const coreDocsList = pages
  .map(([_, slug, title]) => `- ${title}: https://vivary.vercel.app/${slug}/`)
  .join('\n') + '\n- Changelog: https://vivary.vercel.app/changelog/';

const llmsText = `# Vivary

Vivary is a standard and scaffolder for agent-native workspaces. It gives AI agents a
small, inspectable workspace they can navigate and verify: typed project memory,
visible state, reusable skills, private boundaries, and human gates.

Website: https://vivary.vercel.app/
Repository: https://github.com/vivary-dev/vivary
License: MIT
Full Documentation: https://vivary.vercel.app/llms-full.txt

## Current package surfaces

- PyPI meta-package (installs the suite): \`vivary\`, via \`pip install vivary\`
- npm scaffolder: \`@vivary/create\` ${createVivaryNpm}
- PyPI scaffolder: \`create-vivary\` ${createVivaryPyPI}
- PyPI knowledge graph CLI: \`vivary-tropo\` ${tropoVersion}, command \`tropo\`
- PyPI review CLI: \`vivary-ozone\` ${ozoneVersion}, command \`ozone\`
- PyPI coordination CLI: \`vivary-exo\` ${exoVersion}, command \`exo\`
- \`strato\` is bundled as workspace templates and agent skills, not a separate package.
- Optional Cognee adapter: \`vivary-memory-cognee\` ${cogneeVersion}, command \`vivary-cognee\`
- Versions are independent; do not call the whole project "Vivary ${createVivaryPyPI}".

## Install

\`\`\`bash
npm create @vivary@latest my-workspace
pip install vivary
\`\`\`

## Core docs

${coreDocsList}

## Agent retrieval

Start with graph-first context:

\`\`\`bash
tropo find "<task or question>" --root . --budget 1200 --json
tropo query "<text>" --root . --type decision --explain --json
ozone review --root . --pack context-budget
\`\`\`

Optional active context:

- CocoIndex-code is an optional coding sidecar, not default behavior.
- LanceDB is explicit embedded storage, not semantic retrieval.
- The published scaffolder can write Cognee policy without installing or indexing.
- The optional Cognee adapter indexes privacy-filtered typed Tropo node packets only
  after explicit install and index approval.
- Vivary core does not install embeddings, start daemons, enable MCP, or send data
  anywhere by default.

LLM active-context guide: https://vivary.vercel.app/llm-active-context/
`;

const publicDir = path.resolve(here, '..', 'public');
fs.writeFileSync(path.join(publicDir, 'llms.txt'), llmsText);
console.log('  generated site/public/llms.txt');

// We collect the full markdown content of each page, rewriting local links to absolute
const makeAbsolute = (body) => {
  return body.replaceAll('](/', '](https://vivary.vercel.app/');
};

let llmsFullText = `# Vivary (Full Documentation)

This file contains the complete documentation suite for Vivary.

${llmsText}

`;

for (const [src, slug, title] of pages) {
  const raw = readCanonicalMarkdown(docsDir, `${src}.md`, `docs/${src}.md`);
  const body = makeAbsolute(rewrite(raw));
  llmsFullText += `\n---\n\n${body}\n`;
}

// Append the Changelog to llms-full.txt
const changelogBody = makeAbsolute(rewrite(changelog));
llmsFullText += `\n---\n\n${changelogBody}\n`;

fs.writeFileSync(path.join(publicDir, 'llms-full.txt'), llmsFullText);
console.log('  generated site/public/llms-full.txt');

