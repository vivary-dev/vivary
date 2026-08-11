# Vivary release workflow

Use this at the end of every Vivary update that changes behavior, packaging,
public docs, install commands, release status, or package versions.

**The rule: merging to `dev` is not a release, and development slices do not publish
early.** For the current comprehensive update, no package publishes until core and role
integration, trustworthy brownfield setup, MCP, dogfood, the benchmark, the tutorial,
documentation, package/version truth, and release verification are complete and
separately approved. At that final gate, core and all dependent packages publish as one
coordinated train, and the website copy updates with them.

The current coordinated development train is named **Vivary Governed Context**. The name is a
planning and release label, not a suite version and not evidence that any artifact has
published. Exact current source and registry versions live in the
[root release status](../README.md#release-status); maturity lives in
[MIGRATION-STATUS.md](MIGRATION-STATUS.md).

## 1. Name the train and decide the release scope

Versions are independent per package — there is no single "Vivary X.Y.Z".
Work out which packages actually changed, then bump only those:

| What changed | Package to bump | Also update |
|---|---|---|
| `packages/tropo/tropo.py` or its tests | `vivary-tropo` | README release line, COMMANDS if CLI changed |
| `packages/ozone/ozone.py` | `vivary-ozone` | same |
| `packages/exo/exo.py` | `vivary-exo` | same |
| `packages/create-vivary/create_vivary.py` | `create-vivary` (PyPI) **and** `@vivary/create` (npm) — always in lockstep | same |
| `packages/create-vivary/create_vivary_assets/` or legacy full-workspace fixtures | No user-facing package bump by themselves; these are repository-only compatibility archives and must remain excluded from wheels and source distributions | parity/packaging proof |
| `packages/strato/` templates or skills | `vivary-strato` when its runtime/package surface changes; do not copy these assets into thin init/adopt output | same |
| `packages/strato/strato.py`, its tests, or CLI contract | `vivary-strato` — bump the version, but keep it unpublished on `dev`; publish only in the final coordinated train with core and the other role packages | ARCHITECTURE seam section, COMMANDS, README surface row |
| `packages/memory-cognee/vivary_cognee.py` | `vivary-memory-cognee` | same |
| `packages/mcp/vivary_mcp.py` or its tests | `vivary-mcp` — keep optional and unpublished until its explicit train item; preserve the exact reviewed MCP SDK pin | MCP guide, package README, Tropo floor |
| `packages/core/` modules or tests | `vivary-core` — bump the version, but keep it unpublished on `dev`; publish it only in the final coordinated train with every dependent role package | ARCHITECTURE seam section, README surface row |
| dependency floors in `packages/vivary/pyproject.toml` | `vivary` (meta) — bump its floors and patch version when component minimums move | README table |
| `docs/`, `site/`, root README only | **no package bump** — site redeploys from `dev` via Vercel automatically | keep docs/site sync (step 3) |
| repo CI / stats / tests only | no bump, no site work | — |

Bump rules (semver-ish, pre-1.0):

- new user-visible command, subcommand, or flag → **minor** (0.3.0 → 0.4.0);
- bug fix, hardening, docs-in-package, or template tweak → **patch**;
- `create-vivary` PyPI and `@vivary/create` npm versions are **always identical**
  (`packages/create-vivary/pyproject.toml` + `packages/create-vivary/npm/package.json`);
- a role package that first imports `vivary_core` adds its dependency floor in the same
  commit, as defined by the architecture's dependency direction, and takes a **patch**
  bump at minimum;
- never re-release an existing version number; registries are immutable.

### Train and version lifecycle

1. **Planned** — name the train in the approved plan and top changelog entry. Do not
   assign a suite semver.
2. **Staged** — set each changed package's independent next version, dependency floors,
   and source status. Keep `create-vivary` and `@vivary/create` identical. The README
   registry table still shows the old published versions.
3. **Publishing** — after the train-level approval, publish one exact artifact at a
   time in dependency order. If publication is partial, name each artifact that reached
   its registry and keep the train itself incomplete.
4. **Registry-complete** — every planned artifact is visible at its exact version, but
   the train is not yet verified.
5. **Verified** — cache-resistant install and CLI smokes pass for every artifact; only
   then update the root registry table and change the same changelog entry to
   "Published and verified."

The historical independent versions remain valid history. A source change after one
of its versions has published requires a new package version; it never reuses the
published number or forces unrelated packages to match it. This is the selected
versioning policy for [#149](https://github.com/vivary-dev/vivary/issues/149).

## 2. Set release truth first

Update every surface that names versions or the command set, in the repo,
**before** publishing:

- `packages/<pkg>/pyproject.toml` — update `version = "..."` and any dependency floors.
  When the package exposes a module `__version__` constant, update that too; its parity
  test must match the manifest.
- `vivary-core` has no module `__version__`; `packages/core/pyproject.toml` is its sole
  in-repo version declaration, and step 6 verifies the installed distribution version.
- `packages/create-vivary/npm/package.json` — lockstep version;
- root `README.md` — the train name/state, registry table, development-source line,
  create-only lockstep statement, and "Current command surface" list;
- `CHANGELOG.md` — new entry at the top, matching the existing format: package
  names + versions + date, what changed, and a **Verification** section listing
  only the exact smoke commands actually run. Before publishing, the entry says
  "Publishing remains a manual human gate." After publishing, change that same
  entry to "Published and verified" with exact versions;
- `docs/MIGRATION-STATUS.md` only when a surface changes classification, and
  `docs/DECISIONS.md` only when a durable decision changes;
- package `README.md`s whose status lines name versions;
- `docs/COMMANDS.md` for CLI changes; the homepage FAQ / `docs/PORTFOLIO.md` if
  they name versions or surfaces (grep for the old version string);
- `site/src/pages/index.astro` if the homepage names versions, commands, or
  package surfaces — `grep -nE "0\.[0-9]+\.[0-9]+|tropo |create-vivary" site/src/pages/index.astro`
  and read what it claims;
- `AGENTS.md` only when the public agent contract itself changes.

Before publication, old registry versions remain in the published-status table and
published install examples. Check that each source version appears only in its manifest,
runtime owner, development-status copy, generated mirror, and changelog entry. After
publication, search the same surfaces for the replaced version and keep it only where
the changelog or compatibility history owns it:

```bash
grep -rn "<old-version>" README.md docs/ packages/ site/src/pages/ --include="*.md" --include="*.toml" --include="*.json" --include="*.astro"
```

## 3. Keep docs and site in sync

Source docs live in `docs/` plus root `CHANGELOG.md`; the site mirrors them.

```bash
cd site
npm run sync-docs
npm run build
git diff --exit-code -- src/content/docs public/llms.txt public/llms-full.txt
```

Commit the regenerated `site/src/content/docs/*` with the source docs — CI's
site build and the graph review gate both expect them to match. (`sync-docs`
is dependency-free; plain `node scripts/sync-docs.mjs` works without
`npm install`.) The live site redeploys from `dev` on merge via Vercel — there
is no separate site publish step, but the copy only updates if you committed it.

## 4. Make local CLI truth explicit before command smokes

Build, smoke, tag, and publish only from a dedicated clean checkout/worktree at the
approved release commit. A clean release worktree prevents ignored build debris,
untracked files, and an unrelated developer diff from entering the artifact or changing
the command under test. Record the resulting HEAD in the release evidence.

```bash
git worktree add --detach ../vivary-release-governed-context <approved-commit>
cd ../vivary-release-governed-context
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git diff --quiet
git diff --cached --quiet
```

The status command must print nothing and both diff commands must exit `0`. Verify that
the release tag or workflow input resolves to that same HEAD before any publish gate.
Do not publish from a dirty primary checkout and do not clean or reset it to make it
look releasable; user work may be present there. Worktree cleanup is a separate
destructive action and needs its own approval.

If the change adds or changes CLI behavior that is not published yet, refresh
the local CLIs from the current checkout before testing bare commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local-clis.ps1
```

The script uninstalls existing Vivary uv tools, then installs this checkout.
This prevents stale global tools from silently testing an older package.

### Pre-PR hardening and review SOP

Before opening a PR for an optional provider, installer, filesystem, release, or
agent-execution change, run a hostile review pass and turn repeat failures into
tests or docs before pushing:

- **Direct CLI execution:** run changed Python entry files directly, not only through
  imports or mocks. A unit suite can miss script-only failures such as missing
  `importlib.util`.
- **Real optional dependency smoke:** when a feature wraps an optional package, create
  an ignored disposable environment, install the real dependency there, run package
  presence/dry-run/blocking smokes, and delete the disposable environment after
  verification. Do not commit proof sandboxes.
- **Packaged bridge smoke:** when source code imports an optional sibling package
  through the installed CLI path, add a CI smoke that installs the local packages and
  exercises the bridge. Use `--no-deps` only when the smoke is intentionally proving
  package/import boundaries without provider runtime or network calls.
- **Inspect both package formats:** inventory every wheel and source distribution. A
  clean wheel is insufficient if the sdist still carries retired templates, skills,
  starter records, credentials, or local proof artifacts.
- **No silent provider side effects:** optional providers must be explicit about
  network, API-key, telemetry, dotenv, cache, log, and state-directory behavior.
  Default to closed gates and workspace-scoped paths; add an explicit opt-in flag
  for any third-party telemetry.
- **Path and link abuse:** test symlinks, junctions, hard links, absolute paths,
  nested roots, malformed config, stale manifests, repeated runs, and out-of-root
  targets. Fail closed with a Vivary error, not a raw Python traceback.
- **Cross-platform orientation loop:** for scaffold, adopt, Doctor, map, or retrieval
  changes, run `python packages/create-vivary/tests/orientation_proof.py --receipt
  orientation-proof.json`. The disposable runner uses both Python and npm entry points,
  proves dry-run before bounded apply, re-runs adopt after apply to prove idempotence,
  preserves divergent Git state, and emits a sanitized aggregate receipt. CI runs the
  same proof on Ubuntu and Windows and retains each receipt whenever the process writes
  one, including fixture and preflight failures. A timed-out or cancelled process is
  killed before that write, so it has no receipt to upload. The real transport proof
  requires `node`, `uv` (for `uvx`), and `git` on `PATH`; a missing prerequisite fails
  closed and writes a preflight receipt.
- **Security scan shape:** scan diffs for shell execution, encoded payloads, inline
  PowerShell blobs, download-and-execute patterns, secret literals, and broad
  filesystem deletion. Keep long prompts/instructions in reviewed files and pass
  paths, not giant inline command strings.
- **Docs and site truth:** update source docs, package READMEs, changelog, and synced
  site docs in the same change. Run `cd site && npm run sync-docs && npm run build`.
- **PR evidence:** include exact local commands, real-package smokes, known deferred
  limits, and any reviewer-found issues in the PR body. If review found a real bug,
  fix it before push or add the fix as a follow-up commit before merge.

## 5. Build and publish (human gate, one package at a time)

Publishing is deliberate. Each publish below is its own explicit gate.

PyPI, per changed package:

```bash
cd packages/<pkg>
rm -rf dist
uv build                        # or: python -m build
uv publish                      # or: twine upload dist/*  (PyPI token)
```

npm, only when create-vivary changed (lockstep with the PyPI publish), uses
Trusted Publishing from GitHub Actions OIDC instead of a stored npm automation
token. Configure the trusted publisher once on npmjs.com for `@vivary/create`:

- Provider: GitHub Actions
- Organization / repository: `vivary-dev` / `vivary`
- Workflow filename: `npm-trusted-publish.yml` (filename only; the file lives in
  `.github/workflows/`)
- Environment: `npm-publish`
- Allowed action: `npm publish`

Equivalent npm CLI setup, when using npm 11.15.0+ with a maintainer account that
has package write access and account-level 2FA:

```bash
npm trust github @vivary/create --repo vivary-dev/vivary --file npm-trusted-publish.yml --env npm-publish --allow-publish
```

Keep the GitHub `npm-publish` environment protected with required reviewers.
The workflow is manually dispatched, checks out the explicit release tag, verifies
the tag/version match, verifies PyPI/npm `create-vivary` version lockstep, runs
the create-vivary release checks, and runs `npm pack --dry-run`. Leave
`publish=false` for the dry-run gate; rerun with `publish=true` only after the
npm publish gate is approved.

Order when multiple packages ship: dependencies first. Publish `vivary-core` before
every package that depends on it. Publish `vivary-tropo` next; then the eligible
`vivary-strato`, `vivary-ozone`, `vivary-exo`, `vivary-memory-cognee`, `vivary-mcp`, and
`create-vivary` artifacts after their declared floors exist. Publish the `vivary`
meta-package only after all five of its component floors are available. Publish
`create-vivary` on PyPI before the same-version `@vivary/create` npm launcher, because
the launcher installs the PyPI distribution at run time. Optional memory and MCP do not
become meta-package dependencies merely because they ride the same train. The
[package dependency map](ARCHITECTURE.md#package-dependency-map) owns the edges.

## 6. Verify from the public registries after publish

Check the package pages and run cache-resistant install smokes for every
changed package:

```bash
uv run --isolated --no-project --no-cache --index-url https://pypi.org/simple \
  --with vivary-core==<ver> python -c \
  "from importlib.metadata import version; import vivary_core; assert version('vivary-core') == '<ver>'"
uv run --isolated --no-project --no-cache --index-url https://pypi.org/simple \
  --with vivary==<vivary-ver> python -c \
  "from importlib.metadata import version; import vivary_core; assert version('vivary') == '<vivary-ver>'; assert version('vivary-core') == '<core-ver>'"
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

Create or update the GitHub release (human gate) only after the train is verified.
Title it with the train name and the exact independently versioned package set, for
example `Vivary Governed Context — vivary-core <ver>, vivary-tropo <ver>, …`; do not present
one package's version as a suite version. Use the changelog entry as the body. If the
release needs a repository tag, select and approve that tag in the release plan rather
than inventing an unowned suite semver.

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
