---
title: "Changelog"
description: "Release history for the Vivary packages."
---

Notable changes to Vivary. The project ships several **independently versioned**
packages, so each entry names the package(s) it affects. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the initial suite release is
the `v0.1.0` line.

**Current release line:** `create-vivary` / `@vivary/create` **0.3.1** · optional
`vivary-memory-cognee` **0.1.0** · `vivary-tropo` **0.4.1** · `vivary-ozone`
**0.2.0** · `vivary-exo` **0.2.2**. Versions are independent; there is no single
"Vivary 0.4.1" release.

## [Unreleased: local receipt log viewer] — 2026-07-05

Affects the `vivary` meta package, CLI docs, package docs, and generated website
docs. This is not published yet; the `vivary` version bump and registry publish remain
release-train gates.

### Added

- Added the dependency-free `vivary` helper CLI to the meta package.
- Added `vivary logs [PATH]` to summarize local JSONL run receipts as text or JSON.
- Added `vivary logs email [PATH] --to ...` to create a local `.eml` support draft or
  print a `mailto:` URL from whitelisted receipt fields.
- Added a dependency-free website support modal with copy-email, copy-report, prefilled
  `mailto:`, and GitHub issue fallbacks. The modal opens automatically for browser
  errors noticed by the site and omits local `file://` paths from generated reports.
- Pointed the website support flow at the bug issue form and set the form to assign
  new bug reports to the maintainer account for GitHub notifications.

### Security

- `vivary logs` copies only receipt schema/tool/version/command/flags/count/status/timing
  and runtime envelope fields. Unknown fields, stdout/stderr-like fields, file contents,
  raw query text, target ids, and local paths are not included in summaries or email
  drafts.
- `vivary logs email --out` refuses directory targets, symlink targets,
  symlink/junction ancestor directories, and Windows device names.
- Vivary still never sends telemetry or email itself; users send the local draft with
  their own mail client if they choose.
- The website support modal is static-only and does not call SendGrid, Resend, SMTP, or
  any other email provider.

### Verification

- `python packages/vivary/tests/test_vivary_cli.py`
- `cd site && npm run test:support`
- Real receipt smoke: `tropo check --root packages/tropo/examples/vault --receipt
  sandboxes/observability-proof/receipts.jsonl`, then `vivary logs ... --json` and
  `vivary logs email ... --out ... --json`.

## [Unreleased: tropo typed vector query mode] — 2026-07-05

Affects `vivary-tropo`, CLI docs, package docs, and generated website docs. This is
not published yet; the `vivary-tropo` version bump and registry publish remain
release-train gates.

### Added

- Added `tropo query --mode vector`, a dependency-free local typed-vector search mode
  over analyzed tropo graph nodes.
- Added explicit `.vivary/storage.toml` opt-in for local vectors via `[storage.embedding]
  enabled = true`, `provider = "local-hash"`, and optional `dimensions`.
- Kept vector results graph-shaped: typed node ids, paths, types, scores, provider
  markers, snippets, and type/path/edge filters are preserved.
- This is a local query-time vector slice only; it does not add stored embeddings,
  ANN search over an embedded backend, or clustering/community graph views.

### Hardened

- `--mode vector` falls back to dependency-free text graph search when no embedding
  config is present instead of failing or installing anything.
- Invalid embedding config is reported as structured `misconfigured` JSON without
  attempting provider calls, network access, or package installation.
- Malformed storage config reports relative `.vivary/storage.toml` details instead of
  absolute local paths, and `tropo migrate --to embedded` refuses to silently use the
  file backend when embedded storage is not configured.

### Verification

- `python packages/tropo/tests/test_tropo.py`

## [Unreleased: tropo semantic query mode] — 2026-07-05

Affects `vivary-tropo`, `vivary-memory-cognee`, CLI docs, package docs, and
generated website docs. This is not published yet; registry publishes remain
release-train gates.

### Added

- Added `tropo query --mode semantic`, a dependency-free bridge to an explicitly
  configured optional semantic-memory provider. The default `text` mode is unchanged.
- Semantic query returns typed Vivary node ids from the provider instead of opaque
  chunks, and reports a structured unavailable state when semantic memory is not
  configured, installed, or indexed.

### Hardened

- Scoped real Cognee runtime state/log/cache directories to the workspace
  `memory.cognee.state_path` before provider import.
- Enforced `memory.cognee.allow_network = true` before Cognee provider runtime calls
  so generated Cognee policy cannot accidentally index or recall through embedding/LLM
  providers.
- Required either `memory.cognee.api_key_env` or explicit
  `memory.cognee.allow_without_api_key = true` before provider runtime calls.
- Forced Cognee third-party telemetry/tracing off by default with
  `memory.cognee.allow_telemetry = false`, even when inherited environment variables
  try to enable tracing, while still allowing an explicit opt-in.
- Rejected invalid semantic-memory TOML schema instead of coercing truthy strings or
  integers into safety gates.
- Refused semantic provider snapshots that resolve Markdown files outside the workspace
  through symlinks or Windows junctions, plus in-root linked or hard-linked Markdown
  files that could smuggle private content through a public path.
- Bound Cognee dataset names to the workspace path hash, even when a label is
  configured, so one workspace cannot accidentally forget another workspace's dataset.
- Made provider recall require a current manifest fingerprint, and made approved index
  replace the prior Cognee dataset before remembering current node packets.
- Made `vivary-cognee forget` request full dataset deletion instead of memory-only
  deletion, and made missing provider datasets idempotent under `--yes`.
- Refused nonexistent `vivary-cognee --root` targets instead of promoting typos to the
  nearest ancestor workspace before a mutating command.
- Refused linked or hard-linked Cognee manifest targets before writing local index
  proof, and preserved manifests when provider dataset deletion fails with permission
  or accessibility errors.
- Hardened `tropo query --mode semantic` against workspace-local `vivary_cognee.py`
  import hijacking while still allowing the repo adapter or installed adapters outside
  the workspace/current working tree.
- Bumped the unreleased `vivary-memory-cognee` adapter metadata to `0.1.1`, added an
  explicit adapter capability marker, and made `tropo query --mode semantic` refuse
  older adapters before calling provider recall.
- Honored nested `.gitignore` files and directory ignore patterns before building
  provider snapshots, so ignored private Markdown is not sent to the optional provider.
- Preflighted the local Cognee manifest path before any provider-side mutation, compared
  full manifest identity instead of fingerprint alone, and sanitized provider exception
  strings to action plus exception class.
- Capped semantic provider over-fetch for filtered queries so large `--k` values cannot
  fan out into unbounded provider requests before local filtering.
- Kept `vivary-cognee doctor` package-presence-only, avoiding Cognee import side
  effects, suppressed Cognee dotenv autoload during runtime import, and kept provider
  import/call chatter off JSON stdout for runtime commands.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- `python packages/memory-cognee/tests/test_memory_cognee.py`
- CI packaged optional semantic bridge smoke installs local `vivary-tropo` plus
  `vivary-memory-cognee` with `--no-deps`, then verifies installed `tropo query
  --mode semantic --json` reaches the explicit `allow_network` gate without provider
  calls.
- Real installed `cognee 1.2.2` smoke: `vivary-cognee doctor --json` reported the
  installed package without importing provider runtime, `vivary-cognee index --dry-run
  --json` reported packet counts, and provider runtime calls were refused while
  `allow_network = false`.

## [Unreleased: local run receipts] — 2026-07-05

Affects `create-vivary`, `vivary-tropo`, `vivary-ozone`, `vivary-exo`, CLI docs,
package docs, and generated website docs. This is not published yet; package version
bumps and registry publishes remain release-train gates.

### Added

- Added dependency-free, opt-in local JSONL run receipts to the core CLIs via
  `--receipt PATH` or `VIVARY_RECEIPT_LOG=PATH`.
- Receipts record a small debug envelope: schema version, tool/version, command,
  flag names, argument count, exit code, duration, Python version, and platform.
- Receipts deliberately avoid stdout, stderr, environment variables, file contents,
  raw query text, target ids, local paths, graph content, preset values, and agent
  handles.

### Security

- Receipt targets must be regular files; symlink targets and directory targets are
  refused so an opt-in debug log cannot silently append through a suspicious path.
- Symlink or Windows junction directory ancestors are refused for receipt paths before
  and after parent directory creation.
- Windows device names such as `NUL`, `CON`, `COM1`, and `LPT1` are refused as
  receipt targets.

### Verification

- `python packages/tropo/tests/test_tropo.py`
- `python packages/ozone/tests/test_ozone.py`
- `python packages/exo/tests/test_exo.py`
- `python packages/create-vivary/tests/test_create_vivary.py`
- `python packages/create-vivary/tests/test_adopt.py`
- `python packages/create-vivary/tests/test_strato_integrity.py`
- `python packages/create-vivary/tests/test_assets_parity.py`
- `python packages/memory-cognee/tests/test_memory_cognee.py`
- `node packages/create-vivary/tests/test_npm_launcher.js`
- `python packages/tropo/tropo.py check --root packages/tropo/examples/vault`
- `cd site && npm run sync-docs && npm run build`
- `cd packages/create-vivary/npm && npm pack --dry-run`
- `git diff --check`

## [Unreleased: vivary-ozone editorial pack] — 2026-07-05

Affects `vivary-ozone`, CLI docs, package docs, and generated website docs. This is
not published yet; the `vivary-ozone` version bump and registry publish remain a
later release-train gate.

### Added

- Added `ozone review --pack editorial`, a deterministic writing-workspace rule pack
  that demonstrates the "code review and editorial review are the same layer with
  different rule packs" thesis.
- The pack flags missing draft/manuscript review coverage, missing edit/revision
  coverage, missing outline/structure coverage, and unlinked reviews or edits while
  staying quiet for non-writing workspaces.

### Verification

- `python packages/ozone/tests/test_ozone.py`

## [Release workflow / @vivary/create trusted publishing] — 2026-07-05

Affects GitHub Actions, release docs, and generated website docs only. No package
release, npm publish, or PyPI publish is implied.

### Added

- Added a manually dispatched, release-tag-gated GitHub Actions workflow for
  tokenless `@vivary/create` publishing through npm Trusted Publishing and the
  protected `npm-publish` environment.
- Added a CI guard that verifies the npm trusted publish workflow keeps OIDC
  permissions, package checks, dry-run behavior, and avoids token-based publishing.

### Changed

- `docs/RELEASE-WORKFLOW.md` now documents the policy-level trusted publisher setup
  for `@vivary/create` instead of public maintainer-specific npm auth steps.

### Verification

- `python scripts/check_npm_trusted_publish_workflow.py`
- `python packages/create-vivary/tests/test_assets_parity.py`
- `node packages/create-vivary/tests/test_npm_launcher.js`
- `python packages/create-vivary/tests/test_create_vivary.py`
- `cd site && npm run sync-docs && npm run build`
- `cd packages/create-vivary/npm && npm pack --dry-run` reported the expected
  three npm package files: `README.md`, `index.js`, and `package.json`.

## [Public stats snapshot] — 2026-07-05

Affects README/site public signals only. No package release, changelog-worthy
runtime change, npm publish, or PyPI publish is implied.

### Changed

- Refreshed the checked-in public signals snapshot: `@vivary/create` npm weekly
  downloads `344`, PyPI package weekly downloads `1467`, all package weekly
  downloads `1811`, GitHub stars `3`, forks `1`, and open issues `8`.
- The usage snapshot chart keeps the same fixed SVG canvas; the npm bar is shorter
  because bars are proportional to the largest package-source count in that
  snapshot, not because a badge or chart container was resized.

### Verification

- `stats/latest.json` reports `status: "ok"` with no stale-source warnings.
- `stats/history.csv` adds the `2026-07-05` row.
- `stats/usage-snapshot.svg` and `site/public/usage-snapshot.svg` match.

## [vivary 0.1.0] — 2026-07-04

Adds the `vivary` meta-package on PyPI: `pip install vivary` installs the full
CLI suite (`create-vivary`, `vivary-tropo`, `vivary-ozone`, `vivary-exo`) with
compatible minimum versions. No code of its own; the four packages stay
independently versioned and installable. Website and docs install commands
collapse to the one-liner; the homepage strip shows a single PyPI card.

### Verification

- Published and verified: `pip index versions vivary` returned `vivary (0.1.0)`
  from the public index after `twine upload`.

## [vivary-tropo 0.4.1 / create-vivary 0.3.1] — 2026-07-04

Affects `vivary-tropo`, `create-vivary` / `@vivary/create`, root docs, package docs,
generated website docs, and the homepage. The adoption-line release: Vivary now works
on existing repos and vaults, not just fresh scaffolds. Published and verified as
`vivary-tropo==0.4.1`, `create-vivary==0.3.1`, and `@vivary/create@0.3.1`:
cache-resistant `uvx --no-cache` installs from the public index self-report
`tropo 0.4.1` / `create-vivary 0.3.1`, and
`npx --yes @vivary/create@0.3.1 capabilities --preset coding --json` returns ok.

> Note: `vivary-tropo==0.4.0` and `create-vivary==0.3.0` exist on PyPI but
> self-report the previous version from a stale `__version__` constant; they are
> superseded by 0.4.1 / 0.3.1 (same content plus the constant fix and a
> version-parity test). `@vivary/create` skips 0.3.0 on npm entirely.

### Added

- **`tropo map`** (tropo 0.4.0) — read-only filesystem inventory of any repo, vault, or
  docs tree: directory table, extension/size summaries, largest files, existing
  index/routing surfaces, and likely-modules-without-an-index. Markdown by default,
  deterministic `--json`; workspace excludes honored (file-level and subtree-rebased),
  junction/symlink cycles pruned, no `tropo.toml` required.
- **`create-vivary adopt <path>`** (create-vivary 0.3.0) — brownfield adoption: dry-run
  by default, `--yes` write gate, only ever adds files (existing content stays
  byte-identical), candidate module routers for markdown-heavy directories, collision
  skip and report, privacy follow-ups for an existing `.gitignore`, and the 0.2.5
  symlink/out-of-root hardening. An adopted workspace passes `doctor` and `tropo check`.
- **`create-vivary doctor --trend`** (create-vivary 0.3.0) — opt-in drift tracking:
  prior-run state in `.vivary/doctor-state.json` (atomic, symlink-refusing writes),
  signed deltas for graph and routing metrics, corrupt state degrades to first-run with
  a visible `trend_warning` in `--json`. Plus a copy-paste GitHub Actions CI-gate
  recipe in `docs/HOWTO.md`.
- **Strato integrity gates** — scaffold smokes for all four presets, markdown
  cross-reference integrity, and Claude/Codex skills structural parity now run in CI.
  strato formally rides the create-vivary release train.

### Fixed

- Homepage mobile overflow (155px horizontal overflow at a 375px viewport) and a
  desktop hero width regression caught in review.
- The loops skill is runtime-honest: the Codex copy no longer claims Claude Code's
  `/loop` and `/goal`; one combined section covers both runtimes in all three copies.

### Changed

- `docs/PRODUCT-ROADMAP.md` restructured around the P1 adoption line;
  `docs/RELEASE-WORKFLOW.md` expanded into a detailed runbook (scope table, publish
  commands, verification smokes, social announcement step); `CONTRIBUTING.md`
  corrects the stale prod-branch claim.

### Verification

- tropo: 83/83 tests on Python 3.11 and 3.14 (68 pre-existing + 15 map).
- create-vivary: full suite green post-merge; init byte-parity vs 0.2.8 verified
  across five flag configurations by adversarial review; only-adds and dry-run purity
  verified against hostile fixtures.
- Adversarial review on every PR in the line (#98–#105) with findings fixed pre-merge.
- Publishing remains a manual human gate.

## [vivary-memory-cognee 0.1.0 / create-vivary 0.2.8] — 2026-06-27

Affects the optional Cognee adapter package, `create-vivary` / `@vivary/create`,
root docs, package docs, and generated website docs. Published and verified as
`vivary-memory-cognee==0.1.0`, `create-vivary==0.2.8`, and `@vivary/create@0.2.8`
after PR #93 merged to `dev`.

### Added

- **Optional Cognee memory adapter** — `packages/memory-cognee/` adds the
  `vivary-memory-cognee` package and `vivary-cognee` CLI with `doctor`, `index`,
  `recall`, and `forget`. It indexes privacy-filtered typed Tropo node packets and
  accepts only recall hits that map back to known Vivary node ids.

### Changed

- `create-vivary capabilities --json` now marks `memory:cognee` with
  `"adapter_status": "optional-package"` while keeping Cognee out of the default
  install path.
- `create-vivary` / `@vivary/create` move to 0.2.8 so the scaffolder and npm launcher
  publish the updated Cognee adapter metadata and docs together.

### Verification

- `python packages/memory-cognee/tests/test_memory_cognee.py` passed locally: 6/6.
- `python -m pip index versions create-vivary` reported `0.2.8`.
- `python -m pip index versions vivary-memory-cognee` reported `0.1.0`.
- `uvx --no-cache --index-url https://pypi.org/simple --from create-vivary==0.2.8 create-vivary --version`
  returned `create-vivary 0.2.8`.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-memory-cognee==0.1.0 vivary-cognee --version`
  returned `vivary-cognee 0.1.0`.
- `npm view @vivary/create version` returned `0.2.8`.
- `npx --yes @vivary/create@0.2.8 capabilities --preset coding --json` completed
  through the published npm launcher and reported `memory:cognee` with
  `"adapter_status": "optional-package"`.

## [vivary-tropo 0.3.0 / vivary-ozone 0.2.0 / create-vivary 0.2.7] — 2026-06-27

Affects `vivary-tropo`, `vivary-ozone`, `create-vivary` / `@vivary/create`, root
docs, package docs, and generated website docs. Published and verified as
`vivary-tropo==0.3.0`, `vivary-ozone==0.2.0`, `create-vivary==0.2.7`, and
`@vivary/create@0.2.7` after PR #91 merged to `dev`.

### Added

- **`tropo find` context packets** — a human-friendly command that returns the small
  set of typed nodes/files worth opening first, with reasons, snippets, filters, JSON
  output, and an approximate token budget.
- **Ozone `context-budget` pack** — `ozone review --pack context-budget` flags
  context-bloat risks in public routing surfaces: missing module indexes, legacy
  module files that coexist with directory indexes, oversized always-on files,
  oversized module indexes, bulk-load wording, and duplicated routing blocks.
- **Ozone pack selection** — `ozone review --pack structure|context-budget|all`
  keeps the default `structure` behavior stable while allowing opt-in context-budget
  review. `--strict` still exits non-zero only on `warn` findings.
- **Local checkout CLI refresh** — `scripts/install-local-clis.ps1` uninstalls existing
  Vivary uv tools, then installs the current branch's CLIs without `--force`, preventing
  stale global tools from silently testing older behavior during local review.
- **LLM active-context guide** — `docs/LLM-ACTIVE-CONTEXT.md` and the generated website
  page provide a compact, copyable graph-first CocoIndex-code retrieval prompt.
- **Product roadmap** — `docs/PRODUCT-ROADMAP.md` captures the high-leverage backlog
  for large filesystem maps, module index planning, structured content query, typed
  recall providers, optional integration proof, and context-budget repair workflows.

### Changed

- **`tropo query` is graph-aware** — query now searches analyzed Tropo nodes instead
  of raw Markdown files, returning real graph ids/types/paths and supporting `--type`,
  `--path`, `--edge`, `--snippet`, and `--explain`.
- **Active-context guidance is simpler and stricter about CocoIndex path filters** —
  the generated skill and docs now lead with `tropo find`, use exact
  `ccc search --path` examples, and warn that broad folder globs can miss indexed files
  in current CocoIndex-code releases.
- **LanceDB wording is storage-first** — public docs, wizard copy, and capability
  labels now describe LanceDB as explicit embedded storage, while `tropo find` and
  `tropo query` remain graph-first zero-dependency retrieval commands.
- **Package dependency floor moved with retrieval guidance** — `create-vivary` and
  `vivary-ozone` now depend on `vivary-tropo>=0.3.0` so installed scaffolds and review
  docs reference a tropo version that includes `find` and graph-aware `query`.

### Verification

- `python packages/tropo/tests/test_tropo.py` passed locally: 68/68.
- `python packages/ozone/tests/test_ozone.py` passed locally: 16/16.
- `python packages/create-vivary/tests/test_create_vivary.py` passed locally: 54/54.
- `python packages/create-vivary/tests/test_assets_parity.py` passed locally: 3/3.
- `python packages/exo/tests/test_exo.py` passed locally: 14/14.
- `cd site && npm run sync-docs && npm run build` passed locally.
- Local CLI refresh passed with `scripts/install-local-clis.ps1`, then bare `tropo`,
  `ozone`, `exo`, and `create-vivary` smokes passed.
- Disposable LanceDB, CocoIndex-code, and Cognee-policy smokes passed locally. Cognee
  remains policy-only in Vivary; the actual optional adapter is not shipped in this
  release.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-tropo==0.3.0 tropo --version`
  returned `tropo 0.3.0` from public PyPI.
- `uvx --no-cache --index-url https://pypi.org/simple --from vivary-ozone==0.2.0 ozone --version`
  returned `ozone 0.2.0` from public PyPI.
- `uvx --no-cache --index-url https://pypi.org/simple --from create-vivary==0.2.7 create-vivary --version`
  returned `create-vivary 0.2.7` from public PyPI.
- `npm view @vivary/create version` returned `0.2.7`, and
  `npx --yes @vivary/create@0.2.7 capabilities --preset coding --json` completed
  through the published npm launcher.

## [create-vivary 0.2.6] — 2026-06-26

Affects `create-vivary` / `@vivary/create`, generated workspace docs, and public docs.
Published and verified as `create-vivary==0.2.6` on PyPI and `@vivary/create@0.2.6`
on npm after PR #87 merged to `dev`.

### Added

- **`knowledge-work` preset** — a generic workbench for sources, artifacts, decisions,
  and proof, with editable `workbench` and `sources` module routers.
- **Capability discovery** — `create-vivary capabilities [--preset ...] [--json]`
  lists optional storage, semantic-memory, and preset-specific sidecar capabilities for
  human and agent setup flows.
- **Optional semantic-memory setup** — `create-vivary init` / `wizard` now accept
  `--memory none|local|cognee`. `local` writes local-only semantic-memory policy;
  `cognee` writes Cognee policy, graph docs, and verification surfaces without
  installing Cognee, indexing content, enabling network access, or using API keys.
- **Doctor memory reporting** — `create-vivary doctor` reports semantic-memory status
  as disabled, healthy/configured, unavailable, misconfigured, or privacy-failed.

### Changed

- The npm launcher recognizes the new `capabilities` subcommand instead of rewriting it
  to `init`.

### Verification

- `python -m pip index versions create-vivary` reported `LATEST: 0.2.6`.
- A fresh venv installed `create-vivary==0.2.6` from PyPI and ran
  `create-vivary capabilities --preset knowledge-work --json`.
- `npm view @vivary/create version` reported `0.2.6`.
- `npx --yes @vivary/create@0.2.6 capabilities --preset knowledge-work --json`
  ran through the published npm launcher and matching PyPI scaffolder.

## [vivary-tropo 0.2.3 / vivary-exo 0.2.2 / create-vivary 0.2.5] — 2026-06-23

Affects `vivary-tropo`, `vivary-exo`, `create-vivary` / `@vivary/create`,
`strato` workspace assets, and public docs/site release surfaces. This package set
ships the merged security-hardening batch from the June 23 security scan review.

### Security

- **`tropo view --out` output hardening** — rendered HTML writes must stay inside
  the tropo root, refuse symlink output paths, and replace the output path instead
  of truncating existing hard-linked files.
- **Heartbeat reports stay private** — scaffolded workspaces now gitignore
  `heartbeat-reports/*` (while keeping `.gitkeep`), the doctor flags missing report
  ignores, and strato's heartbeat procedure treats reports as PRIV because they may
  summarize private memory.
- **Doctor privacy ignore validation hardening** — `create-vivary doctor` now
  validates active `.gitignore` rules for `USER.md`, `MEMORY.md`, `memory/*`, and
  `heartbeat-reports/*` instead of accepting comments, negations, or unrelated
  substring matches as proof that private context files are ignored.
- **`exo claim` hard-link hardening** — claim writes now replace the workspace work
  item file instead of truncating an existing inode, so a hard-linked file outside
  the workspace is not mutated.
- **create-vivary symlink hardening** — scaffold writes, storage config writes, and
  stale generated cleanup now refuse symlinked destination parents and paths that
  resolve outside the selected workspace, including when `--force` is used.
- **create-vivary dry-run cleanup guard** — `--dry-run --force` previews the scaffold
  without removing stale generated files.
- **create-vivary embedded install fallback** — when `create-vivary` is run through
  `uvx`, embedded storage setup now falls back to `uv pip install --python ...` if
  the temporary Python environment does not include `pip`.

### Documentation

- **Security-hardening release truth** — README, FAQ, command docs, package READMEs,
  `SECURITY.md`, and the website now identify the package versions that carry the
  hardening batch.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.3` so installed claim workflows use
  the hard-link-safe write behavior.
- `create-vivary` now depends on `vivary-tropo>=0.2.3`, and the npm launcher
  version `@vivary/create@0.2.5` pins the matching `create-vivary==0.2.5` PyPI
  scaffolder.
- `create-vivary init --no-wizard` now honors the documented lean default of file
  storage unless `--auto` or `--storage auto` is explicitly requested.

### Release note

Published through the manual human gate as `vivary-tropo==0.2.3`,
`vivary-exo==0.2.2`, `create-vivary==0.2.5`, and `@vivary/create@0.2.5`.
`create-vivary==0.2.4` was uploaded during release validation, then superseded by
0.2.5 after the public `uvx` smoke exposed the embedded-install fallback bug.
Verified from public PyPI/npm registries plus fresh `uvx` and `npm exec` scaffold
smokes.

## [vivary-tropo 0.2.2 / vivary-exo 0.2.1] — 2026-06-22

Affects `vivary-tropo` and `vivary-exo` only. `create-vivary` / `@vivary/create`
remain at 0.2.3, and `vivary-ozone` remains at 0.1.0.

### Fixed

- **UTF-8 BOM hardening** — tropo now treats a single leading UTF-8 BOM as a
  file-encoding artifact in both `tropo.toml` and Markdown frontmatter, so files
  produced by Windows PowerShell `Set-Content -Encoding UTF8` load normally.
- **`exo claim` no longer duplicates BOM-prefixed frontmatter** — claims update the
  existing frontmatter block, normalize the rewritten file to plain UTF-8, and still
  reject malformed frontmatter instead of guessing.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.2` so installed claim workflows use
  the BOM-aware parser.

### Release note

Published through the manual human gate as `vivary-tropo==0.2.2` and
`vivary-exo==0.2.1`; no npm publish was needed. Verified from public PyPI pages plus
fresh `pip` and `uvx --no-cache --index-url https://pypi.org/simple` install smokes.

## [vivary-tropo 0.2.1 / vivary-exo 0.2.0] — 2026-06-22

Affects `vivary-tropo` and `vivary-exo` only. `create-vivary` / `@vivary/create`
remain at 0.2.3, and `vivary-ozone` remains at 0.1.0.

### Added

- **Graph-native work claiming** — `exo claim <id> --agent <handle>` writes a
  top-level `assignee` onto a work item under `changes/`, reports JSON with the
  previous assignee and whether the file changed, and leaves same-assignee claims as
  no-op success.
- **Opt-in coordination pack** — `packs = ["coordination"]` declares
  `assignee = "string"` as a base optional field, so exo can write claims without
  bloating every default workspace schema.
- **Embedded starter packs** — built-in tropo packs are embedded in the single-file
  engine so installed wheels can resolve `dev-project`, `repo-graph`, and
  `coordination` without relying on a repo-local `packs/` directory.
- **Pack parity tests** — tracked built-in pack TOML files are checked against the
  embedded values, and workspace-local `.tropo/packs/<name>.toml` files still take
  precedence over bundled packs.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.1` so installed users get the
  bundled `coordination` pack required by `exo claim`.

### Release note

Released through the manual human gate as `vivary-tropo==0.2.1` and
`vivary-exo==0.2.0`; no npm publish was needed for this release.

## [0.2.3] — 2026-06-22

Affects `create-vivary` (PyPI) and `@vivary/create` (npm) only.

### Fixed

- **npm launcher pins the matching PyPI scaffolder** — `npm create @vivary@latest`
  now invokes `create-vivary@0.2.3` instead of leaving `uvx create-vivary` or
  `pipx run create-vivary` to resolve an unversioned package. This prevents stale
  tool caches from serving an older CLI without the `wizard` subcommand.
- **Launch copy uses the explicit latest npm form** — public install examples now
  prefer `npm create @vivary@latest my-workspace`, with direct Python usage shown as
  `uvx create-vivary@0.2.3 ...` or `pip install create-vivary==0.2.3`.

Use 0.2.3 for new installs. Existing PyPI 0.2.2 installs already include the wizard;
the hotfix is primarily for npm launcher provenance and fresh public onboarding.

## [0.2.2] — 2026-06-21

Affects `create-vivary` (PyPI) and `@vivary/create` (npm) only.

### Fixed

- **Supersedes 0.2.1** — use 0.2.2 for new installs. PyPI 0.2.1 was installable,
  but it was replaced by a clean CI-reviewed release after generated build artifacts
  were removed from the source tree. npm 0.2.1 was not live; 0.2.2 is the npm/PyPI
  lockstep release users should install.
- **Clean release provenance** — the repository source tree no longer includes the
  generated 0.2.1 wheel/sdist artifacts, and the release was re-cut after branch
  protection and CI-gated PR flow were restored.

No runtime API changes are expected for users already on 0.2.1; this is a source
and release-hygiene hotfix.

## [0.2.1] — 2026-06-21

Affects `create-vivary` (PyPI) only; no live `@vivary/create` npm 0.2.1 release was
published.

### Fixed

- **Wizard installs LanceDB inline** — when the interactive wizard's user picks "on this
  computer" (embedded storage), LanceDB now installs immediately as part of the wizard
  conversation. Previously, a second standalone "Install lancedb? [Y/n]" prompt appeared
  after the wizard ended, which was jarring and broke the mental model (the wizard IS the
  consent step).
- **`--auto` implies `--yes` for installs** — `create-vivary init . --auto --size large`
  no longer hangs on the install prompt. `--auto` means fully unattended; it now implies
  `yes=True` for every install step, so agents don't need to pass both `--auto` and `--yes`.
- **`wizard` subcommand** has the same two fixes applied.

## [0.2.0] — 2026-06-21

Affects `vivary-tropo` and `create-vivary`. `vivary-ozone` and `vivary-exo` are unchanged at 0.1.0.

### Added

- **Storage layer in tropo** — tiered storage abstraction: `file` (default, no new deps),
  `embedded` (LanceDB on disk, `pip install vivary-tropo[embedded]`), and `cloud` adapter
  interface (0.3.x). Config lives in `.vivary/storage.toml`. Optional extras:
  `vivary-tropo[embedded]`, `vivary-tropo[cloud]`, `vivary-tropo[astra]`.
- **`tropo migrate`** — move graph nodes between backends
  (`--from file --to embedded [--dry-run] [--json] [--yes]`).
- **`tropo query`** — text search over the workspace knowledge graph
  (`tropo query "auth module" [--k N] [--json]`).
- **Agent-mode flags on `create-vivary init`** — `--json`, `--dry-run`, `--auto`,
  `--yes`, `--no-wizard`, `--storage`, `--provider`, `--size`, `--privacy`.
  Agents can now self-configure a workspace end-to-end without human interaction.
- **`create-vivary wizard` subcommand** — reconfigure storage on an existing workspace.
- **Interactive setup wizard** — `create-vivary init` now prompts interactively when
  run from a TTY (human-friendly, no database jargon). `--no-wizard` or `--auto` skips it.
- **`.vivary/data/` in scaffolded `.gitignore`** — runtime storage data is always ignored.
- **`doctor` reports `backend` field** — JSON output now includes `"backend": "file|embedded|cloud"`.
- **Spec:** `docs/SPEC-data-layer.md` — full architecture rationale and agent CLI contract.

### Changed

- `create-vivary init` with `--storage embedded` self-installs `vivary-tropo[embedded]`
  (with confirmation unless `--yes`).
- `--dry-run` on `init` simulates the full scaffold without writing any files.

## [create-vivary 0.1.1] — 2026-06-14

Affects `create-vivary` (PyPI) and its npm launcher `@vivary/create`, released in
lockstep. The other three packages are unchanged at 0.1.0.

### Fixed

- A bare target now defaults to the `init` subcommand, so the documented
  `npm create @vivary@latest <name>` and `uvx create-vivary@0.2.3 <name>` scaffold a workspace
  without an explicit `init` (previously failed with argparse `invalid choice: …`).
  Explicit `init` / `doctor` and leading flags (`-h` / `--help`) pass through unchanged.
  npm launcher: [#33](https://github.com/vivary-dev/vivary/pull/33). Python CLI parity:
  [#35](https://github.com/vivary-dev/vivary/pull/35).

## [0.1.0] — 2026-06-14

Initial public release — all four layers on PyPI, the scaffolder also on npm.

### Added

- `vivary-tropo` — typed knowledge-graph CLI (`check` / `signal` / `types` / `stats` /
  `graph` / `blast` / `view` / `plan` / `fix` / `init`); `check` is strict by default.
- `vivary-ozone` — review layer (`review` / `impact` / `packs`).
- `vivary-exo` — coordination layer (`conflicts` / `board` / `roles`).
- `create-vivary` (PyPI) / `@vivary/create` (npm) — agent-workspace scaffolder
  (`init` / `doctor`; presets: `coding` · `second-brain` · `writing`).
