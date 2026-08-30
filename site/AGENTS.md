# Vivary website instructions

## Scope

This folder owns the Astro marketing and documentation site. The repository root
`AGENTS.md` still governs shared Vivary architecture, release, and delivery.

## Sources of truth

- Canonical product documentation: `../docs/`
- Generated documentation routes: `src/content/docs/`
- Landing page and marketing routes: `src/pages/`
- Blog posts: `src/content/blog/`
- Site configuration and navigation: `astro.config.mjs`
- Current product and release status: `../README.md#release-status`

Never edit generated files under `src/content/docs/` directly. Change
`../docs/`, then run the sync command.

## Commands

```powershell
npm run sync-docs
npm run test:support
npm run test:site
npm run build
npm run test:links
```

`npm run dev` starts the local Astro server. `npm run test:links` checks built
output, so run it after `npm run build`.

## Editing rules

- Keep package, command, and feature claims aligned with canonical repository docs.
- Landing-page and roadmap summaries may be shorter than canonical docs but must not
  introduce separate product truth.
- Keep generated `dist/`, caches, and dependencies out of manual edits.
- Update or add focused site tests when behavior changes.

## Verification

For documentation-only changes, run sync, the relevant focused tests, and build.
For routes, navigation, support behavior, or crawler surfaces, run the full command
sequence above and inspect the rendered result.
