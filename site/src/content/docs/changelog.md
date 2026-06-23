---
title: "Changelog"
description: "Release history for the Vivary packages."
---

Notable changes to Vivary. The project ships several **independently versioned**
packages, so each entry names the package(s) it affects. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the initial suite release is
the `v0.1.0` line.

**Current versions:** `vivary-tropo` **0.2.3** · `vivary-exo` **0.2.2** · `create-vivary` / `@vivary/create` **0.2.5** · `vivary-ozone` **0.1.0**.

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
  `SECURITY.md`, `HANDOFF.md`, and the website now identify the package versions that
  carry the hardening batch.

### Changed

- `vivary-exo` now depends on `vivary-tropo>=0.2.3` so installed claim workflows use
  the hard-link-safe write behavior.
- `create-vivary` now depends on `vivary-tropo>=0.2.3`, and the npm launcher
  version `@vivary/create@0.2.5` pins the matching `create-vivary==0.2.5` PyPI
  scaffolder.
- `create-vivary init --no-wizard` now honors the documented lean default of file
  storage unless `--auto` or `--storage auto` is explicitly requested.

### Release note

PyPI `vivary-tropo==0.2.3`, `vivary-exo==0.2.2`, and `create-vivary==0.2.4`
were uploaded during release validation; `create-vivary==0.2.5` supersedes the
scaffolder upload with the `uvx` embedded-install fallback. npm publishing and
final public registry smoke verification remain the manual gate before this line
is promoted.

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
