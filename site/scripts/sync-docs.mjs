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
const docsWalkthroughAssetsDir = path.join(docsDir, 'assets', 'walkthrough');
const publicWalkthroughAssetsDir = path.resolve(here, '..', 'public', 'assets', 'walkthrough');
const GH = 'https://github.com/vivary-dev/vivary/blob/dev';
const noDelete = process.env.VIVARY_SYNC_NO_DELETE === '1';

const normalizeForCompare = (p) => {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

// canonical doc -> [route slug, page title, meta description]
const pages = [
  ['CONCEPTS', 'concepts', 'What is Vivary?', 'Plain-language intro: what Vivary is, the core ideas, and a glossary. Start here.'],
  ['GETTING-STARTED', 'getting-started', 'Getting started', 'Install Vivary and run your first agent workspace.'],
  ['WALKTHROUGH', 'walkthrough', 'Getting started proof', 'A public, generic product walkthrough showing Vivary scaffold, health, review, coordination, and impact checks.'],
  ['COMMANDS', 'commands', 'Command reference', 'Every CLI across Vivary: tropo, strato, ozone, exo, create-vivary, and optional adapters.'],
  ['LEARN-BY-DOING', 'learn-by-doing', 'Vivary guides', 'Task-based Vivary guides for creating or adopting a workspace, connecting agents, retrieving context, writing records, and recovering safely.'],
  ['guides/create-workspace', 'guides/create-workspace', 'Create a Vivary workspace', 'Create and verify the five-file Vivary governed-context workspace for a new project without adding starter content.'],
  ['guides/connect-agent', 'guides/connect-agent', 'Connect an AI agent to Vivary', 'Connect an AI coding or writing agent to Vivary through the standard context route or optional read-only MCP adapter.'],
  ['guides/get-context', 'guides/get-context', 'Get bounded Vivary context', 'Retrieve privacy-filtered project evidence with Vivary or save a complete governed Task Capsule for approved work.'],
  ['guides/write-record', 'guides/write-record', 'Write a governed Vivary record', 'Plan, approve, apply, and verify one capsule-bound Vivary record after completed work earns durable project context.'],
  ['guides/adopt-project', 'guides/adopt-project', 'Adopt an existing project with Vivary', 'Add Vivary to an existing project with a bounded dry-run plan, exact approval hash, privacy checks, and no project takeover.'],
  ['guides/verify-recover', 'guides/verify-recover', 'Verify and recover a Vivary workspace', 'Run Vivary Doctor and Tropo checks, interpret health findings, and use explicit bounded recovery for interrupted adoption.'],
  ['MCP', 'mcp', 'MCP adapter', 'Optional local read-only MCP adapter contract, tools, privacy boundary, and verification.'],
  ['SKILLS', 'skills', 'Agent skills', 'The strato, tropo, and loops skills that operate a Vivary workspace.'],
  ['ACTIVE-CONTEXT', 'active-context', 'Active context', 'Optional CocoIndex-code sidecar guidance for semantic code retrieval.'],
  ['LLM-ACTIVE-CONTEXT', 'llm-active-context', 'LLM active-context guide', 'Copyable agent instructions for graph-first CocoIndex-code retrieval.'],
  ['SEMANTIC-MEMORY', 'semantic-memory', 'Optional semantic memory', 'Implemented contract for Tropo-backed semantic-memory adapters and their boundary from independent agent LTM.'],
  ['WHITE-PAPER', 'white-paper', 'White paper', 'The technical case for a minimal, portable standard for agent-native workspaces.'],
  ['HOWTO', 'howto', 'Advanced recipes', 'Focused recipes for types, review, coordination, CI, storage, and optional providers.'],
  ['SIGNALS', 'signals', 'Public signals', 'Public npm, PyPI, and GitHub metrics snapshots.'],
  ['RELEASE-WORKFLOW', 'release-workflow', 'Release workflow', 'End-of-update checklist for Vivary release truth, docs, publishing, and post copy.'],
  ['ARCHITECTURE', 'architecture', 'Architecture', 'The four-layer model and the principles behind Vivary.'],
  ['MIGRATION-STATUS', 'migration-status', 'Migration status', 'Current status of stable, optional, experimental, held, deprecated, and planned Vivary surfaces.'],
  ['DECISIONS', 'decisions', 'Decisions', 'Hard-to-reverse Vivary decisions and links to their canonical owners.'],
  ['OBSIDIAN', 'obsidian', 'Obsidian (optional)', 'Optional Obsidian setup for fans, never required.'],
];

const retiredGeneratedSlugs = ['brand', 'faq', 'product-roadmap'];

// rewrite relative repo-doc links to site routes; off-site files to GitHub blobs
const rewrite = (s) =>
  s.replaceAll('](CONCEPTS.md)', '](/concepts/)')
   .replaceAll('](GETTING-STARTED.md)', '](/getting-started/)')
   .replaceAll('](GETTING-STARTED.md#', '](/getting-started/#')
   .replaceAll('](WALKTHROUGH.md)', '](/walkthrough/)')
   .replaceAll('](WALKTHROUGH.md#', '](/walkthrough/#')
   .replaceAll('](LEARN-BY-DOING.md)', '](/learn-by-doing/)')
   .replaceAll('](LEARN-BY-DOING.md#', '](/learn-by-doing/#')
   .replaceAll('](guides/create-workspace.md)', '](/guides/create-workspace/)')
   .replaceAll('](guides/connect-agent.md)', '](/guides/connect-agent/)')
   .replaceAll('](guides/get-context.md)', '](/guides/get-context/)')
   .replaceAll('](guides/write-record.md)', '](/guides/write-record/)')
   .replaceAll('](guides/adopt-project.md)', '](/guides/adopt-project/)')
   .replaceAll('](guides/verify-recover.md)', '](/guides/verify-recover/)')
   .replaceAll('](create-workspace.md)', '](/guides/create-workspace/)')
   .replaceAll('](connect-agent.md)', '](/guides/connect-agent/)')
   .replaceAll('](get-context.md)', '](/guides/get-context/)')
   .replaceAll('](write-record.md)', '](/guides/write-record/)')
   .replaceAll('](adopt-project.md)', '](/guides/adopt-project/)')
   .replaceAll('](verify-recover.md)', '](/guides/verify-recover/)')
    .replaceAll('](../GETTING-STARTED.md)', '](/getting-started/)')
    .replaceAll('](../GETTING-STARTED.md#', '](/getting-started/#')
    .replaceAll('](../LEARN-BY-DOING.md)', '](/learn-by-doing/)')
    .replaceAll('](../LEARN-BY-DOING.md#', '](/learn-by-doing/#')
    .replaceAll('](../COMMANDS.md)', '](/commands/)')
   .replaceAll('](../COMMANDS.md#', '](/commands/#')
   .replaceAll('](../MCP.md)', '](/mcp/)')
   .replaceAll('](../MCP.md#', '](/mcp/#')
   .replaceAll('](../WALKTHROUGH.md)', '](/walkthrough/)')
   .replaceAll('](../WALKTHROUGH.md#', '](/walkthrough/#')
   .replaceAll('](COMMANDS.md#', '](/commands/#')
   .replaceAll('](COMMANDS.md)', '](/commands/)')
   .replaceAll('](MCP.md)', '](/mcp/)')
   .replaceAll('](MCP.md#', '](/mcp/#')
   .replaceAll('](SKILLS.md)', '](/skills/)')
   .replaceAll('](ACTIVE-CONTEXT.md)', '](/active-context/)')
   .replaceAll('](ACTIVE-CONTEXT.md#', '](/active-context/#')
   .replaceAll('](LLM-ACTIVE-CONTEXT.md)', '](/llm-active-context/)')
   .replaceAll('](SEMANTIC-MEMORY.md)', '](/semantic-memory/)')
   .replaceAll('](SEMANTIC-MEMORY.md#', '](/semantic-memory/#')
   .replaceAll('](WHITE-PAPER.md)', '](/white-paper/)')
   .replaceAll('](PRODUCT-ROADMAP.md)', '](/roadmap/)')
   .replaceAll('](HOWTO.md)', '](/howto/)')
   .replaceAll('](SIGNALS.md)', '](/signals/)')
   .replaceAll('](RELEASE-WORKFLOW.md)', '](/release-workflow/)')
   .replaceAll('](RELEASE-WORKFLOW.md#', '](/release-workflow/#')
   .replaceAll('](MIGRATION-STATUS.md)', '](/migration-status/)')
   .replaceAll('](MIGRATION-STATUS.md#', '](/migration-status/#')
   .replaceAll('](DECISIONS.md)', '](/decisions/)')
   .replaceAll('](DECISIONS.md#', '](/decisions/#')
   .replaceAll('](FAQ.md)', '](/#faq)')
   .replaceAll('](ARCHITECTURE.md)', '](/architecture/)')
   .replaceAll('](ARCHITECTURE.md#', '](/architecture/#')
   .replaceAll('](OBSIDIAN.md)', '](/obsidian/)')
   .replaceAll('](OBSIDIAN.md#', '](/obsidian/#')
   .replaceAll('](../CHANGELOG.md)', '](/changelog/)')
   .replaceAll('](README.md)', '](/)')
   .replaceAll('](assets/walkthrough/', '](/assets/walkthrough/')
   .replaceAll('](../stats/usage-snapshot.svg)', '](/usage-snapshot.svg)')
   .replaceAll('](../stats/latest.json)', `](${GH}/stats/latest.json)`)
   .replaceAll('](../stats/history.csv)', `](${GH}/stats/history.csv)`)
   .replaceAll('](../README.md#', `](${GH}/README.md#`)
   .replaceAll('](README.md#', `](${GH}/README.md#`)
   .replaceAll('](SPEC-data-layer.md)', `](${GH}/docs/SPEC-data-layer.md)`)
   .replaceAll('](SPEC-data-layer.md#', `](${GH}/docs/SPEC-data-layer.md#`)
   .replaceAll('](bellamente-memory/', `](${GH}/docs/bellamente-memory/`)
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

const assertInside = (root, target, label) => {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const lexicalRel = path.relative(rootAbs, targetAbs);
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) {
    throw new Error(`${label} must stay inside ${rootAbs}: ${targetAbs}`);
  }

  const rootReal = fs.realpathSync(root);
  let targetParent = fs.existsSync(target) ? target : path.dirname(target);
  while (!fs.existsSync(targetParent)) {
    const next = path.dirname(targetParent);
    if (next === targetParent) {
      throw new Error(`${label} has no existing parent: ${targetAbs}`);
    }
    targetParent = next;
  }
  const targetReal = fs.realpathSync(targetParent);
  const rel = path.relative(rootReal, targetReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} resolves outside ${rootReal}: ${targetReal}`);
  }
};

const copyRegularTree = (src, dest, label) => {
  if (!fs.existsSync(src)) return;
  assertRegularDirectory(src, label);
  assertInside(path.resolve(here, '..', 'public'), dest, `${label} output`);
  if (noDelete && fs.existsSync(dest)) {
    assertRegularDirectory(dest, `${label} output`);
    const sourceNames = new Set(fs.readdirSync(src));
    const staleNames = fs.readdirSync(dest).filter((name) => !sourceNames.has(name));
    if (staleNames.length > 0) {
      throw new Error(
        `${label} no-delete sync refuses stale outputs: ${staleNames.sort().join(', ')}`,
      );
    }
  } else if (!noDelete) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks: ${from}`);
    }
    if (entry.isDirectory()) {
      copyRegularTree(from, to, `${label}/${entry.name}`);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
};

// Render a canonical Markdown doc into a Starlight content page: drop the leading H1
// (Starlight renders the frontmatter title), rewrite links, prepend frontmatter.
// JSON.stringify gives a valid double-quoted YAML scalar (handles ':' etc.)
const render = (raw, title, desc, editUrl) => {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('# ')) lines.shift();
  const body = rewrite(lines.join('\n')).replace(/^[\r\n]+/, '');
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(desc)}\neditUrl: ${JSON.stringify(editUrl)}\n---\n\n${body}`;
};

assertRegularDirectory(docsDir, 'docs/');
copyRegularTree(docsWalkthroughAssetsDir, publicWalkthroughAssetsDir, 'docs/assets/walkthrough');

fs.mkdirSync(outDir, { recursive: true });
for (const slug of retiredGeneratedSlugs) {
  const stale = path.join(outDir, `${slug}.md`);
  if (fs.existsSync(stale)) {
    if (noDelete) {
      throw new Error(`no-delete sync refuses retired generated route ${slug}.md`);
    }
    fs.rmSync(stale);
    console.log(`  removed retired generated route ${slug}.md`);
  }
}
for (const [src, slug, title, desc] of pages) {
  const raw = readCanonicalMarkdown(docsDir, `${src}.md`, `docs/${src}.md`);
  const editUrl = `https://github.com/vivary-dev/vivary/edit/dev/docs/${src}.md`;
  const output = path.join(outDir, `${slug}.md`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, render(raw, title, desc, editUrl));
  console.log(`  synced docs/${src}.md -> ${slug}.md`);
}

// The changelog is canonical at the repo root (CHANGELOG.md), not under docs/. Surface
// it as a site page so it refreshes on every build whenever CHANGELOG.md is updated.
const changelog = readCanonicalMarkdown(repoRoot, 'CHANGELOG.md', 'CHANGELOG.md');
fs.writeFileSync(
  path.join(outDir, 'changelog.md'),
  render(
    changelog,
    'Changelog',
    'Release history for the Vivary packages.',
    'https://github.com/vivary-dev/vivary/edit/dev/CHANGELOG.md',
  ),
);
console.log('  synced CHANGELOG.md -> changelog.md');

console.log('site docs synced from docs/ (+ CHANGELOG.md).');

// --- Generate llms.txt & llms-full.txt ---

const rootReadme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

const readPublishedVersion = (surface) => {
  const prefix = `| \`${surface}\``;
  const row = rootReadme.split(/\r?\n/).find((line) => line.startsWith(prefix));
  const version = row?.split('|')[2]?.trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Could not find published version for ${surface} in README.md`);
  }
  return version;
};

// Every version below is registry truth read from the root release table. The manifests
// are source truth and can lead the registry between trains, so they are not the right
// input for an agent-facing install surface.
const createVivaryPyPI = readPublishedVersion('create-vivary');
const createVivaryNpm = readPublishedVersion('@vivary/create');
const coreVersion = readPublishedVersion('vivary-core');
const tropoVersion = readPublishedVersion('vivary-tropo');
const stratoVersion = readPublishedVersion('vivary-strato');
const ozoneVersion = readPublishedVersion('vivary-ozone');
const exoVersion = readPublishedVersion('vivary-exo');
const cogneeVersion = readPublishedVersion('vivary-memory-cognee');
const mcpVersion = readPublishedVersion('vivary-mcp');

const isGuidePage = ([, slug]) => slug === 'learn-by-doing' || slug.startsWith('guides/');

const taskGuidesList = pages
  .filter(isGuidePage)
  .map(([, slug, title, description]) =>
    `- ${title}: ${description} https://vivary.vercel.app/${slug}/`)
  .join('\n');

const coreDocsList = pages
  .filter((page) => !isGuidePage(page))
  .map(([_, slug, title]) => `- ${title}: https://vivary.vercel.app/${slug}/`)
  .join('\n') +
  '\n- Product roadmap: https://vivary.vercel.app/roadmap/' +
  '\n- FAQ: https://vivary.vercel.app/#faq' +
  '\n- Changelog: https://vivary.vercel.app/changelog/';

const llmsText = `# Vivary

Vivary is a lightweight, local-first governed-context standard and scaffolder. The
published ${createVivaryPyPI} scaffolder creates five operational files: one context
capsule, one visible state surface, workspace policy, startup routing, and bounded
private/runtime ignores. It seeds no starter records, template pack, or second brain.

Website: https://vivary.vercel.app/
Repository: https://github.com/vivary-dev/vivary
License: MIT
Release Status: https://github.com/vivary-dev/vivary#release-status
Full Documentation: https://vivary.vercel.app/llms-full.txt

## Published package surfaces

- PyPI meta-package (installs the published suite): \`vivary\`
- npm scaffolder: \`@vivary/create\` ${createVivaryNpm}
- PyPI scaffolder: \`create-vivary\` ${createVivaryPyPI}
- PyPI knowledge graph CLI: \`vivary-tropo\` ${tropoVersion}, command \`tropo\`
- PyPI review CLI: \`vivary-ozone\` ${ozoneVersion}, command \`ozone\`
- PyPI coordination CLI: \`vivary-exo\` ${exoVersion}, command \`exo\`
- PyPI policy facade: \`vivary-strato\` ${stratoVersion}, experimental command \`strato decide --governed\`; Core init does not copy skills or templates.
- PyPI governed-context seam: \`vivary-core\` ${coreVersion}, library only.
- Optional Cognee adapter: \`vivary-memory-cognee\` ${cogneeVersion}, command \`vivary-cognee\`
- Optional local stdio adapter: \`vivary-mcp\` ${mcpVersion}; four read-only tools, disabled by default.
- Versions are independent; do not call the whole project "Vivary ${createVivaryPyPI}".

The versions above are registry truth. The five-file behavior is the published
\`create-vivary\` and \`@vivary/create\` ${createVivaryPyPI} scaffolder.

## Run the published scaffolder

\`\`\`bash
uvx create-vivary init my-workspace --preset coding --no-wizard
uvx create-vivary doctor my-workspace
uvx --from vivary-tropo tropo check --root my-workspace
\`\`\`

Pin the previous published full-layout scaffolder only when that behavior is wanted:
\`uvx --from create-vivary==0.3.1 create-vivary ...\` or
\`npx @vivary/create@0.3.1 ...\`.

## Task guides

Use the page that matches the task. These site documents and the repository Markdown
sources are the same canonical procedures.

${taskGuidesList}

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
- Vivary Core does not install embeddings, start daemons, enable MCP, or send data
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

fs.writeFileSync(path.join(publicDir, 'llms-full.txt'), `${llmsFullText.trimEnd()}\n`);
console.log('  generated site/public/llms-full.txt');
