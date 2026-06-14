# Vivary — website

The Vivary marketing + docs site. Astro + [Starlight](https://starlight.astro.build).
The landing page lives in `src/content/docs/index.mdx`; the docs are ported from the
repo's [`../docs/`](../docs/) (keep them in sync when the canonical docs change).

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
  content/docs/      one .md/.mdx per route (index = landing)
  assets/vivary.svg  logo
  styles/theme.css   brand colours (atmosphere greens/teals)
astro.config.mjs     title, sidebar, social, theme
```

Content is plain Markdown — edit a page in `src/content/docs/` and the route updates.
