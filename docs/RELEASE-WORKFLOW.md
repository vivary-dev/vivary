# Vivary release workflow

Use this at the end of every Vivary update that changes behavior, packaging,
public docs, install commands, release status, or package versions.

**The rule: any update that changes what users install or read must end with
published PyPI/npm packages and updated website copy.** Merging to `dev` is not
a release. A change line is finished only when the registries and the site say
what the repo says.

## 1. Decide the release scope

Versions are independent per package — there is no single "Vivary X.Y.Z".
Work out which packages actually changed, then bump only those:

| What changed | Package to bump | Also update |
|---|---|---|
| `packages/tropo/tropo.py` or its tests | `vivary-tropo` | README release line, COMMANDS if CLI changed |
| `packages/ozone/ozone.py` | `vivary-ozone` | same |
| `packages/exo/exo.py` | `vivary-exo` | same |
| `packages/create-vivary/create_vivary.py` or `create_vivary_assets/` | `create-vivary` (PyPI) **and** `@vivary/create` (npm) — always in lockstep | same |
| `packages/strato/` templates or skills | `create-vivary` + `@vivary/create` (strato has no version — it rides the create-vivary release train; say so in the changelog entry) | same |
| `packages/memory-cognee/vivary_cognee.py` | `vivary-memory-cognee` | same |
| dependency floors in `packages/vivary/pyproject.toml` | `vivary` (meta) — bump its floors and patch version when component minimums move | README table |
| `docs/`, `site/`, root README only | **no package bump** — site redeploys from `dev` via Vercel automatically | keep docs/site sync (step 3) |
| repo CI / stats / tests only | no bump, no site work | — |

Bump rules (semver-ish, pre-1.0):

- new user-visible command, subcommand, or flag → **minor** (0.3.0 → 0.4.0);
- bug fix, hardening, docs-in-package, or template tweak → **patch**;
- `create-vivary` PyPI and `@vivary/create` npm versions are **always identical**
  (`packages/create-vivary/pyproject.toml` + `packages/create-vivary/npm/package.json`);
- never re-release an existing version number; registries are immutable.

## 2. Set release truth first

Update every surface that names versions or the command set, in the repo,
**before** publishing:

- `packages/<pkg>/pyproject.toml` — `version = "..."` **and the module's `__version__` constant** (they must match — a parity test enforces it), plus dependency floors if
  a package now needs a newer sibling (e.g. ozone requiring `vivary-tropo>=0.4.0`);
- `packages/create-vivary/npm/package.json` — lockstep version;
- root `README.md` — the release-status blockquote, the surface/version table,
  and the "Current command surface" list;
- `CHANGELOG.md` — new entry at the top, matching the existing format: package
  names + versions + date, what changed, and a **Verification** section listing
  the exact smoke commands run. Before publishing, the entry says
  "Publishing remains a manual human gate." After publishing, change that same
  entry to "Published and verified" with exact versions;
- package `README.md`s whose status lines name versions;
- `docs/COMMANDS.md` for CLI changes; `docs/FAQ.md` / `docs/PORTFOLIO.md` if
  they name versions or surfaces (grep for the old version string);
- `site/src/pages/index.astro` if the homepage names versions, commands, or
  package surfaces — `grep -nE "0\.[0-9]+\.[0-9]+|tropo |create-vivary" site/src/pages/index.astro`
  and read what it claims;
- `AGENTS.md` only when the public agent contract itself changes.

Fast completeness check — the old version string should survive nowhere except
the changelog history:

```bash
grep -rn "<old-version>" README.md docs/ packages/ site/src/pages/ --include="*.md" --include="*.toml" --include="*.json" --include="*.astro"
```

## 3. Keep docs and site in sync

Source docs live in `docs/` plus root `CHANGELOG.md`; the site mirrors them.

```bash
cd site
npm run sync-docs
npm run build
```

Commit the regenerated `site/src/content/docs/*` with the source docs — CI's
site build and the graph review gate both expect them to match. (`sync-docs`
is dependency-free; plain `node scripts/sync-docs.mjs` works without
`npm install`.) The live site redeploys from `dev` on merge via Vercel — there
is no separate site publish step, but the copy only updates if you committed it.

## 4. Make local CLI truth explicit before command smokes

If the change adds or changes CLI behavior that is not published yet, refresh
the local CLIs from the current checkout before testing bare commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local-clis.ps1
```

The script uninstalls existing Vivary uv tools, then installs this checkout.
This prevents stale global tools from silently testing an older package.

## 5. Build and publish (human gate, one package at a time)

Publishing is manual and deliberate — there is no CI publish automation
(moving `@vivary/create` to npm trusted publishing is tracked in issue #42).
Each publish below is its own explicit gate.

PyPI, per changed package:

```bash
cd packages/<pkg>
rm -rf dist
uv build                        # or: python -m build
uv publish                      # or: twine upload dist/*  (PyPI token)
```

npm, only when create-vivary changed (lockstep with the PyPI publish):

```bash
cd packages/create-vivary/npm
npm publish                     # publishConfig.access=public is set; expect the 2FA prompt
```

Order when multiple packages ship: dependencies first (`vivary-tropo` before
`ozone`/`exo`/`memory-cognee` that pin it), `create-vivary` PyPI before
`@vivary/create` npm (the launcher installs the PyPI package at run time).

## 6. Verify from the public registries after publish

Check the package pages and run cache-resistant install smokes for every
changed package:

```bash
uvx --no-cache --index-url https://pypi.org/simple --from vivary-tropo==<ver> tropo --version
uvx --no-cache --index-url https://pypi.org/simple --from vivary-ozone==<ver> ozone --version
uvx --no-cache --index-url https://pypi.org/simple --from vivary-exo==<ver> exo --version
uvx --no-cache --index-url https://pypi.org/simple --from create-vivary==<ver> create-vivary --version
```

If npm changed, verify both the registry version and the launcher path:

```bash
npm view @vivary/create version
npx --yes @vivary/create@<ver> capabilities --preset coding --json
```

Also confirm the wheel stays clean: `pip download <pkg>==<ver> --no-deps -d tmp/`
and list it — wheels must contain the module and nothing else (no tests; the
`py-modules` allowlists in each `pyproject.toml` enforce this — don't loosen them).

Then flip the changelog entry to "Published and verified" (step 2) and commit.

## 7. GitHub release

Create or update the GitHub release (human gate) titled after the headline
package set, e.g. "v0.2.8 — Cognee adapter + published release truth", with the
changelog entry as the body.

## 8. Announce the release

Every release gets a coordinated public announcement on **Facebook, LinkedIn,
X/Twitter, Bluesky, and Instagram** — each post with a generated image sized
for the platform, conveying what the update means for users (not a changelog
dump).

- Draft everything in `.release/private/` (ignored local storage — social
  drafts never enter the public repo): one file per release, containing
  per-platform copy plus an image prompt per platform.
- Tailor, don't broadcast: X/Bluesky short and concrete (what you can now do,
  one command example); LinkedIn value-framed for practitioners; Facebook
  conversational; Instagram image-first with a tight caption.
- Image prompts specify aspect ratio per platform (X/Facebook/LinkedIn 16:9 or
  1.91:1 link-card, Instagram 1:1, Bluesky 16:9), and keep the brand language:
  the layered-vivarium metaphor and the site's emerald-on-dark palette.
- Generate the images from the prompts, review them against the copy, and
  attach per post.
- **Posting is a human gate, per item, per platform** — no batch approval. Post
  only after the registry verification (step 6) has passed, so the announcement
  never points at an unpublished version.

## 9. After the release

- Confirm the live site (https://vivary.vercel.app/) shows the new versions and
  command surface — it deploys from `dev`, so this is a read-check, not a step.
- Stats: the daily `track-stats` workflow will pick up the new versions; make
  sure recent `chore/stats-*` snapshot PRs are being merged so
  `stats/history.csv` and the README chart stay current.
- Keep private agent communications outside the repo: handoffs, launch/social
  drafts, and private release packets stay in ignored local storage such as
  `.release/private/` — never in the public repo.
- If the update revealed a repeatable release lesson, save it in these docs.
  Do not rely on chat history as the only copy.

## Gates

These remain explicit human gates, one item at a time:

- `git push`
- opening a PR
- merging a PR
- PyPI publish
- npm publish
- GitHub release creation or update
- posting launch/social copy

Inside the work, be fast. At the edges, leave proof.
