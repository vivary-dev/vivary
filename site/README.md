# Vivary — website

The Vivary marketing + docs site. Astro + [Starlight](https://starlight.astro.build).
The landing page is `src/pages/index.astro`. The doc pages are **generated** from the
repo's canonical [`../docs/`](../docs/) by `npm run sync-docs` (auto-run on `dev` and
`build`) — edit `../docs/`, never the generated copies under `src/content/docs/`.

## Develop

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to ./dist/
npm run preview    # serve the built site
```

## Deploy (Vercel)

Vercel auto-detects Astro. Point the project at this repo with:

- **Root Directory:** `site`
- **Framework Preset:** Astro
- **Build Command:** `npm run build` · **Output Directory:** `dist`

Then set the production domain. To enable the sitemap/canonical URLs, set
`site: 'https://<your-domain>'` in `astro.config.mjs`.

## Structure

```
src/
  content/docs/      generated docs routes; edit ../docs/ and run sync-docs
  assets/vivary-mark.png  docs-site logo
  styles/theme.css   brand colours (atmosphere greens/teals)
public/
  media/             product mark and living-strata illustrations used by the site
  llms.txt           LLM/crawler summary of current package and docs truth
  robots.txt         crawler policy and sitemap pointer
astro.config.mjs     title, sidebar, social, theme
```

Docs routes are generated from `../docs/`; edit canonical docs and run
`npm run sync-docs`. The landing page and blog posts are edited directly under
`src/pages/` and `src/content/blog/`.

The homepage FAQ and first-class roadmap page are marketing-site surfaces under
`src/pages/`; they are intentionally not generated Starlight documentation. The
canonical product and content roadmaps remain repo documents under `../docs/`, while
only the product roadmap is summarized publicly at `/roadmap/`.
