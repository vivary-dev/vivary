import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const origin = 'https://vivary.vercel.app';

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const routeForFile = (file) => {
  const relative = path.relative(dist, file).split(path.sep).join('/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`;
  return `/${relative}`;
};

const fileForPathname = (pathname) => {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, '');
  const candidate =
    !relative || decoded.endsWith('/')
      ? path.resolve(dist, relative, 'index.html')
      : path.resolve(dist, relative);
  const rel = path.relative(dist, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Local reference resolves outside built site: ${pathname}`);
  }

  if (!relative || decoded.endsWith('/')) return candidate;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return path.join(candidate, 'index.html');
};

if (!fs.existsSync(dist)) {
  throw new Error(`Built site not found: ${dist}. Run npm run build first.`);
}

const htmlFiles = walk(dist).filter((file) => file.endsWith('.html'));
const failures = [];
let localReferences = 0;
let anchors = 0;

for (const sourceFile of htmlFiles) {
  const html = fs.readFileSync(sourceFile, 'utf8');
  const sourceRoute = routeForFile(sourceFile);
  const attributePattern = /<(?:a|img|link|script|source)\b[^>]*?\s(?:href|src)="([^"]+)"/gi;

  for (const match of html.matchAll(attributePattern)) {
    const raw = match[1];
    if (!raw || /^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(raw)) continue;

    const url = new URL(raw, `${origin}${sourceRoute}`);
    if (url.origin !== origin) continue;

    localReferences += 1;
    const targetFile = fileForPathname(url.pathname);
    if (!fs.existsSync(targetFile)) {
      failures.push(`${sourceRoute} -> ${raw} (missing ${path.relative(dist, targetFile)})`);
      continue;
    }

    if (url.hash && targetFile.endsWith('.html')) {
      anchors += 1;
      const id = decodeURIComponent(url.hash.slice(1));
      const targetHtml = fs.readFileSync(targetFile, 'utf8');
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`\\b(?:id|name)="${escaped}"`).test(targetHtml)) {
        failures.push(`${sourceRoute} -> ${raw} (missing anchor ${id})`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  throw new Error(`${failures.length} broken local site reference(s).`);
}

console.log(
  `Checked ${localReferences} local references and ${anchors} anchors across ${htmlFiles.length} HTML files; zero failures.`,
);
