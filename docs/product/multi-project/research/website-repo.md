# The public website lives in its own repository

Recorded 2026-09-13. Owner: outcome 25. This note exists so no agent rebuilds
the site inside this repository or starts a second one.

## Where

- Repository: `vivary-dev/vivary-site`, public since 2026-09-16, default branch `dev`.
- The existing `vivary-site` checkout is on Zo. Reuse it; do not create a second site checkout.
- The Astro site under `site/` in this repository is the old public site at
  vivary.vercel.app. It is inspiration only for the new one. Its URLs matter:
  the new site preserves or redirects every path it served when it replaces it.

## What is decided there

- The site markets the desktop app. Claims come from `src/content/facts.ts`
  in that repo, whose `product` block cites `design.md` and `release.md`
  here. The shipped library is presented as the engine underneath, with the
  only install command on the site.
- Stack: Next.js 16, TypeScript, Tailwind 4, shadcn/ui 4 on Base UI, pnpm.
  Static export, hosted on Cloudflare. Previews are never hosted on Zo.
- Jeff locked the home page on 2026-09-13 after nine candidates. Its history
  is on `feat/landing-candidates` in that repo. Tune it, do not rebuild it.
- `AGENTS.md` in that repo is the law for that work: truth rules, design bar,
  tool table (Dither Kit, icons0, shadscan, shieldcn, Umami), dependency
  gates, branch model, and how to see your work.

## What remains

Two tunes on the home page, then the site-foundations work: Cloudflare
config, CI, Umami behind environment variables, the icons0 registry, README
badges. The site does not publish until the app ships.

## 2026-09-16 update

- The home page was rebuilt to Jeff's design canvas of 2026-09-16, delivered as
  static HTML in that repository under `docs/design/2026-09-16-home/`. It
  supersedes candidate 9. Two documentation routes exist beside it:
  `/what-is-vivary/`, the product description with the six steps and the
  questions people ask, and `/commands/`, the workspace commands.
- The brand system lives in that repository under `docs/brand/system/`:
  `tokens.json`, the jar mark, wordmark, lockups, the app icon with
  `Vivary.ico` (destination: `packages/desktop/`), the vivarium hero, the
  social card, and the brand sheet. The app's interior type moves from Inter
  to Geist when that work is scheduled; the tokens and icon are ready.
- A noindex preview is at https://vivary-dev.github.io, deployed by
  `scripts/deploy-preview.sh` in the site repository. It is not a publication.
  The site still goes live only with the app, on a domain not yet chosen.
- The status ledger on the home page ("working" and "not yet") is copied from
  the acceptance register here. Update `src/content/facts.ts` in the site
  repository when the register moves.
- The site describes one product. The published packages are presented as
  the workspace commands inside Vivary, not as an earlier or separate Vivary.
